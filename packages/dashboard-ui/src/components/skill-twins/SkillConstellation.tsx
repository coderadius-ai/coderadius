import { useMemo, useRef, useState } from 'react';
import type { SkillConstellationSection } from '@coderadius/types';
import { CLUSTER_PALETTE } from './palette';
// shortenUrn intentionally removed: tooltips now use inline name/service from the section payload.

interface HoverPoint {
    pageX: number;
    pageY: number;
    label: string;
    service: string;
}

export function SkillConstellation({ section }: { section: SkillConstellationSection }) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [hover, setHover] = useState<HoverPoint | null>(null);
    const [focusedCluster, setFocusedCluster] = useState<string | null>(null);

    // Build cluster-id -> palette colour mapping in stable order.
    const clusterColours = useMemo(() => {
        const map = new Map<string, string>();
        section.clusterMeta.forEach((c, i) => {
            map.set(c.id, CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]);
        });
        return map;
    }, [section.clusterMeta]);

    const SVG_PADDING = 24;

    // Map normalised [0,1] coords into the SVG viewBox with padding so points
    // never clip at the edges.
    const project = (x: number, y: number) => {
        const W = 1000;
        const H = 280;
        const px = SVG_PADDING + x * (W - SVG_PADDING * 2);
        const py = SVG_PADDING + (1 - y) * (H - SVG_PADDING * 2);
        return [px, py];
    };

    return (
        <section className="cr-constellation">
            <div className="cr-constellation-header">
                <strong>Cross-repo skill constellation</strong>
                <span>cosine similarity ≥ {section.threshold.toFixed(2)}</span>
            </div>

            <div ref={wrapRef} className="cr-constellation-svg-wrap">
                <svg
                    className="cr-constellation-svg"
                    viewBox="0 0 1000 280"
                    preserveAspectRatio="none"
                    aria-label="Skill duplicates 2D projection"
                >
                    {section.points.map(p => {
                        const [cx, cy] = project(p.x, p.y);
                        const colour = p.clusterId
                            ? clusterColours.get(p.clusterId) ?? 'var(--text-tertiary)'
                            : 'var(--text-tertiary)';
                        const focused = focusedCluster === null || focusedCluster === p.clusterId;
                        const radius = p.clusterId ? 6 : 4;
                        return (
                            <circle
                                key={p.configId}
                                className={`cr-constellation-point ${p.clusterId ? '' : 'is-unclustered'} ${focused ? '' : 'is-dim'}`}
                                cx={cx}
                                cy={cy}
                                r={radius}
                                fill={colour}
                                opacity={focused ? 0.9 : 0.18}
                                onMouseEnter={e => {
                                    setHover({
                                        pageX: e.clientX,
                                        pageY: e.clientY,
                                        label: p.name,
                                        service: p.service,
                                    });
                                }}
                                onMouseLeave={() => setHover(null)}
                                onClick={() => {
                                    if (!p.clusterId) return;
                                    document.getElementById(`cluster-${p.clusterId}`)?.scrollIntoView({
                                        behavior: 'smooth',
                                        block: 'start',
                                    });
                                }}
                            />
                        );
                    })}
                </svg>

                {hover && wrapRef.current ? (
                    <div
                        className="cr-constellation-tooltip"
                        style={{
                            left: hover.pageX - wrapRef.current.getBoundingClientRect().left + 12,
                            top: hover.pageY - wrapRef.current.getBoundingClientRect().top - 8,
                        }}
                    >
                        <div>{hover.label}</div>
                        {hover.service ? <div className="cr-constellation-tooltip-svc">{hover.service}</div> : null}
                    </div>
                ) : null}
            </div>

            {section.clusterMeta.length > 0 ? (
                <div className="cr-constellation-legend">
                    {section.clusterMeta.map((c, i) => {
                        const dimmed = focusedCluster !== null && focusedCluster !== c.id;
                        const colour = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
                        return (
                            <span
                                key={c.id}
                                className={`cr-constellation-legend-item ${dimmed ? 'is-dimmed' : ''}`}
                                onClick={() => setFocusedCluster(focusedCluster === c.id ? null : c.id)}
                            >
                                <span className="cr-constellation-legend-dot" style={{ background: colour }} />
                                <span>{c.label}</span>
                                <span style={{ color: 'var(--cr-ink-2)', fontFamily: 'var(--font-mono)' }}>
                                    {c.size}
                                </span>
                            </span>
                        );
                    })}
                </div>
            ) : null}
        </section>
    );
}
