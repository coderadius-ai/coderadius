/**
 * CiPipelineDiagram — CI triggers + stages rendered as one metro-style diagram.
 *
 * Trigger pills dock at the rail origin (the entry path drops from the
 * TRIGGERS row into the first stage), stage chips sit on a continuous rail
 * whose segments are tinted by the flanking stage accents, and row wraps
 * return with a rounded path instead of a dangling connector.
 *
 * Geometry is computed in `lib/ci-rail-geometry` (pure, unit-tested); this
 * component only measures the DOM and paints the SVG overlay.
 */

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { buildRailGeometry, type RailChip, type RailGeometry, type RailSegment } from '../lib/ci-rail-geometry';

// ─── Accent vocabularies ──────────────────────────────────────────────────────

/** Map stage names to capability accent colors */
const STAGE_ACCENTS: Record<string, string> = {
    test: '#22d3ee',
    tests: '#22d3ee',
    testing: '#22d3ee',
    lint: '#22d3ee',
    validate: '#22d3ee',
    build: '#f59e0b',
    compile: '#f59e0b',
    package: '#f59e0b',
    deploy: '#a78bfa',
    release: '#a78bfa',
    publish: '#a78bfa',
    'post-deploy': '#a78bfa',
};

function getStageAccent(name: string): string | null {
    return STAGE_ACCENTS[name.trim().toLowerCase()] ?? null;
}

/** Map trigger names to accent colors */
const TRIGGER_ACCENTS: Record<string, string> = {
    push: '#22c55e',
    pull_request: '#3b82f6',
    pull_request_target: '#3b82f6',
    merge_request: '#3b82f6',
    schedule: '#f59e0b',
    workflow_dispatch: '#a78bfa',
    workflow_call: '#8b5cf6',
    workflow_run: '#8b5cf6',
    issue_comment: '#71717a',
};

/** Short display name for trigger events */
const TRIGGER_SHORT: Record<string, string> = {
    pull_request: 'PR',
    pull_request_target: 'PR target',
    merge_request: 'MR',
    workflow_dispatch: 'dispatch',
    workflow_call: 'callable',
    workflow_run: 'on-run',
    issue_comment: 'comment',
};

// ─── Layout constants ─────────────────────────────────────────────────────────

const GUTTER = 22;            // trigger row indent, aligned with the drawer icon gutter
const RAIL_INDENT = 34;       // stage chips indent; leaves room for the entry curve
const ENTRY_X = GUTTER + 4;   // x of the vertical drop from the triggers row
const NEUTRAL_STROKE = 'rgba(255,255,255,0.12)';

// ─── Measurement ──────────────────────────────────────────────────────────────

function measureRail(
    container: HTMLDivElement,
    triggerRow: HTMLDivElement | null,
    chipEls: Array<HTMLElement | null>,
    stages: string[],
): RailGeometry {
    const base = container.getBoundingClientRect();
    const chips: RailChip[] = [];
    chipEls.slice(0, stages.length).forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        chips.push({
            rect: { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height },
            accent: getStageAccent(stages[i]),
        });
    });
    const entryAnchor = triggerRow
        ? { x: ENTRY_X, bottom: triggerRow.getBoundingClientRect().bottom - base.top + 2 }
        : null;
    return buildRailGeometry({ chips, entryAnchor, bounds: { width: base.width } });
}

// ─── Sub-renderers ────────────────────────────────────────────────────────────

const hasAccent = (s: RailSegment): boolean => s.from !== null || s.to !== null;

function RailOverlay({ rail, uid }: { rail: RailGeometry; uid: string }) {
    return (
        <svg
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
        >
            <defs>
                {rail.segments.map((s, i) => hasAccent(s) && (
                    <linearGradient key={i} id={`${uid}-${i}`} gradientUnits="userSpaceOnUse" x1={s.x1} y1={s.y} x2={s.x2} y2={s.y}>
                        <stop offset="0" stopColor={s.from ?? '#ffffff'} stopOpacity={s.from ? 0.55 : 0.12} />
                        <stop offset="1" stopColor={s.to ?? '#ffffff'} stopOpacity={s.to ? 0.55 : 0.12} />
                    </linearGradient>
                ))}
            </defs>
            {rail.plumbing.map((d, i) => (
                <path key={i} d={d} fill="none" stroke={NEUTRAL_STROKE} strokeWidth={1.5} strokeLinecap="round" />
            ))}
            {rail.segments.map((s, i) => (
                <line
                    key={i}
                    x1={s.x1} y1={s.y} x2={s.x2} y2={s.y}
                    stroke={hasAccent(s) ? `url(#${uid}-${i})` : NEUTRAL_STROKE}
                    strokeWidth={1.5}
                />
            ))}
        </svg>
    );
}

function TriggerPill({ trigger }: { trigger: string }) {
    const accent = TRIGGER_ACCENTS[trigger] ?? '#52525b';
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '1px 8px',
            borderRadius: '999px',
            background: `${accent}10`,
            border: `1px solid ${accent}22`,
            fontSize: '10px',
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 500,
            color: accent,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
        }}>
            <span style={{
                width: '4px',
                height: '4px',
                borderRadius: '50%',
                background: accent,
                boxShadow: `0 0 4px ${accent}50`,
                flexShrink: 0,
            }} />
            {TRIGGER_SHORT[trigger] ?? trigger}
        </span>
    );
}

/** Compact pill row without the TRIGGERS label, for dense grouped lists. */
export function CiTriggerPills({ triggers }: { triggers: string[] }) {
    if (triggers.length === 0) return null;
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', justifyContent: 'flex-end' }}>
            {triggers.map(t => <TriggerPill key={t} trigger={t} />)}
        </div>
    );
}

// ─── Diagram ──────────────────────────────────────────────────────────────────

export function CiPipelineDiagram({ triggers, stages }: { triggers: string[]; stages: string[] }) {
    const uid = useId();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const triggerRowRef = useRef<HTMLDivElement | null>(null);
    const chipRefs = useRef<Array<HTMLElement | null>>([]);
    const [rail, setRail] = useState<RailGeometry>({ segments: [], plumbing: [] });

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const measure = () => setRail(measureRail(container, triggerRowRef.current, chipRefs.current, stages));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stages.join(','), triggers.join(',')]);

    if (triggers.length === 0 && stages.length === 0) return null;

    return (
        <div ref={containerRef} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <RailOverlay rail={rail} uid={uid} />
            {triggers.length > 0 && (
                <div
                    ref={triggerRowRef}
                    style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', paddingLeft: `${GUTTER}px` }}
                >
                    <span style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--text-tertiary)',
                        opacity: 0.7,
                        marginRight: '4px',
                    }}>
                        triggers
                    </span>
                    {triggers.map(t => <TriggerPill key={t} trigger={t} />)}
                </div>
            )}
            {stages.length > 0 && (
                <div style={{
                    position: 'relative',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '14px 18px',
                    // The deeper indent only exists to make room for the entry curve.
                    paddingLeft: `${triggers.length > 0 ? RAIL_INDENT : GUTTER}px`,
                }}>
                    {stages.map((stage, i) => {
                        const accent = getStageAccent(stage);
                        return (
                            <div
                                key={i}
                                ref={el => { chipRefs.current[i] = el; }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '4px 10px',
                                    borderRadius: '6px',
                                    background: accent ? `${accent}08` : 'rgba(255,255,255,0.025)',
                                    border: `1px solid ${accent ? `${accent}20` : 'rgba(255,255,255,0.06)'}`,
                                }}
                            >
                                <span style={{
                                    width: '5px',
                                    height: '5px',
                                    borderRadius: '50%',
                                    background: accent ?? 'rgba(255,255,255,0.2)',
                                    boxShadow: accent ? `0 0 6px ${accent}60` : 'none',
                                    flexShrink: 0,
                                }} />
                                <span style={{
                                    fontSize: 'var(--cr-type-caption)',
                                    fontWeight: 500,
                                    color: accent ?? 'var(--text-secondary)',
                                    fontFamily: 'var(--font-sans)',
                                    letterSpacing: 0,
                                    whiteSpace: 'nowrap',
                                }}>
                                    {stage}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
