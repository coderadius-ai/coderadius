import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Flow Canvas ─────────────────────────────────────────────────────────────
// Animated bezier connections from target banner to impact cards.
// Uses an SVG overlay positioned absolutely over the entire explorer.
//
// NOTE: this component is geometry-coupled to its parent. It queries three
// DOM refs (containerRef, bannerRef, panelsRef) AND reads element positions
// via class-name selectors (`.blast-panel`, `.blast-service-card`,
// `.blast-empty-state`). The class-name coupling stays in Phase A.0 — moving
// to a prop-based geometry contract would change behaviour.

interface FlowPath {
    id: string;
    d: string;
    motionPath: string;
    active: boolean;
    direction: 'downstream' | 'upstream';
    delay: number;
}

export function FlowCanvas({
    containerRef,
    bannerRef,
    panelsRef,
    hasDownstream,
    hasUpstream,
    selectedUrn,
}: {
    containerRef: React.RefObject<HTMLDivElement | null>;
    bannerRef: React.RefObject<HTMLDivElement | null>;
    panelsRef: React.RefObject<HTMLDivElement | null>;
    hasDownstream: boolean;
    hasUpstream: boolean;
    selectedUrn: string | null;
}) {
    const svgRef = useRef<SVGSVGElement>(null);
    const [paths, setPaths] = useState<FlowPath[]>([]);
    const [origin, setOrigin] = useState<{x: number, y: number} | null>(null);
    const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

    const compute = useCallback(() => {
        const container = containerRef.current;
        const banner = bannerRef.current;
        const panels = panelsRef.current;
        if (!container || !banner || !panels) return;

        const cRect = container.getBoundingClientRect();
        const bRect = banner.getBoundingClientRect();

        // Anchor on the target banner: bottom-center
        const ox = bRect.left - cRect.left + bRect.width / 2;
        const oy = bRect.bottom - cRect.top;

        const newPaths: FlowPath[] = [];

        const panelSections = panels.querySelectorAll('.blast-panel');
        panelSections.forEach((section) => {
            const isDownstream = section.classList.contains('blast-panel--downstream');
            const direction = isDownstream ? 'downstream' : 'upstream';
            const hasItems = isDownstream ? hasDownstream : hasUpstream;

            const firstCard = section.querySelector('.blast-service-card');

            if (firstCard) {
                const cardRect = firstCard.getBoundingClientRect();
                const tx = cardRect.left - cRect.left + cardRect.width / 2;
                const ty = cardRect.top - cRect.top;
                const midY = (oy + ty) / 2;

                const d = `M ${ox} ${oy} C ${ox} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
                newPaths.push({ id: `flow-${direction}`, d, motionPath: d, active: hasItems, direction, delay: 0 });
            } else {
                const emptyBox = section.querySelector('.blast-empty-state');
                const targetRect = emptyBox ? emptyBox.getBoundingClientRect() : section.getBoundingClientRect();

                const tx = targetRect.left - cRect.left + targetRect.width / 2;
                const ty = targetRect.top - cRect.top + (emptyBox ? 0 : 40);
                const midY = (oy + ty) / 2;

                const d = `M ${ox} ${oy} C ${ox} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
                newPaths.push({ id: `flow-${direction}-empty`, d, motionPath: d, active: false, direction, delay: 0 });
            }
        });

        setSvgSize({ w: cRect.width, h: cRect.height });
        setOrigin({ x: ox, y: oy });
        setPaths(newPaths);
    }, [containerRef, bannerRef, panelsRef, hasDownstream, hasUpstream]);

    useEffect(() => {
        const t = setTimeout(compute, 80);
        return () => clearTimeout(t);
    }, [compute, selectedUrn]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const ro = new ResizeObserver(compute);
        ro.observe(container);
        return () => ro.disconnect();
    }, [compute, containerRef]);

    // origin is reserved for future origin-anchored decorations; reference it
    // here so React re-runs the effect after geometry recompute.
    void origin;

    if (!paths.length) return null;

    return (
        <svg
            ref={svgRef}
            className="blast-flow-canvas"
            width={svgSize.w}
            height={svgSize.h}
            aria-hidden="true"
        >
            <defs>
                {/* Downstream: purple */}
                <linearGradient id="flow-grad-downstream" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#C084FC" stopOpacity="1" />
                    <stop offset="100%" stopColor="#C084FC" stopOpacity="0.1" />
                </linearGradient>
                {/* Upstream: cyan */}
                <linearGradient id="flow-grad-upstream" x1="0%" y1="100%" x2="0%" y2="0%">
                    <stop offset="0%" stopColor="#2DD4BF" stopOpacity="1" />
                    <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0.1" />
                </linearGradient>
            </defs>

            {paths.map((p) => {
                const gradId = p.direction === 'downstream' ? 'flow-grad-downstream' : 'flow-grad-upstream';
                return (
                    <g key={p.id}>
                        {/* Ghost track — barely visible */}
                        <path d={p.d} fill="none" stroke="rgba(255,255,255,0.025)" strokeWidth="1" strokeLinecap="round" />
                        {p.active && (
                            <>
                                {/* Base wire (ultra clean, static) */}
                                <path
                                    d={p.d}
                                    fill="none"
                                    stroke={`url(#${gradId})`}
                                    strokeWidth="1.2"
                                    strokeLinecap="round"
                                    className="blast-flow-line"
                                />
                                {/* Micro elegant data packets */}
                                <path
                                    d={p.d}
                                    fill="none"
                                    stroke={`url(#${gradId})`}
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeDasharray="2 12"
                                    className={`blast-flow-stream blast-flow-stream--${p.direction}`}
                                />
                            </>
                        )}
                    </g>
                );
            })}


        </svg>
    );
}
