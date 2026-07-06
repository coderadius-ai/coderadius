/**
 * GovernanceDrawer: sidebar panel for Compliance governance rows.
 *
 * Opens when an entity row is clicked in the Compliance governance table.
 * Shows the full violation detail grouped by severity, with structured
 * checklists rendered inline, matching the Registry/BlastExplorer
 * drawer design language.
 *
 * Width: 50% viewport, max 920px (same shell as RegistryDrawer).
 */

import { useState, useCallback } from 'react';
import { DetailCard, RepositoryIcon, ServiceIcon } from './Taxonomy';
import { DrawerShell } from './DrawerShell';

// ─── Data Contract ────────────────────────────────────────────────────────────

export interface GovernanceViolationDetail {
    level: 'error' | 'warning' | 'note';
    ruleId: string;
    ruleName: string;
    detail: string;
    structuredDetail: {
        checks: Array<{ label: string; status: 'pass' | 'fail' | 'warn' }>;
        found: string[];
    } | null;
}

export interface GovernancePassingRule {
    ruleId: string;
    ruleName: string;
}

export interface GovernanceEntityDrawerData {
    kind: 'governance-entity';
    _rowId: string;
    entityName: string;
    entityType: string;
    entityUrl: string | null;
    errors: number;
    warnings: number;
    notes: number;
    rulesEvaluated: number;
    rulesPassed: number;
    violations: GovernanceViolationDetail[];
    passingRules: GovernancePassingRule[];
}

export interface GovernanceRuleDrawerData {
    kind: 'governance-rule';
    id: string;
    name: string;
    description: string;
    level: 'error' | 'warning' | 'note';
    scope: string;
    query: string;
    evaluatedCount: number;
    compliantCount: number;
    violations: Array<{
        entityId: string;
        entityName: string;
        entityType: string;
        teamOwner: string | null;
        detail: string;
    }>;
    /**
     * Entities that passed this rule. Rendered as minimal rows below the
     * violating list so the drawer documents the full evaluation surface
     * without competing with the violation cards visually.
     */
    compliants: Array<{
        entityId: string;
        entityName: string;
        entityType: string;
        teamOwner: string | null;
    }>;
}

export type GovernanceDrawerData = GovernanceEntityDrawerData | GovernanceRuleDrawerData;


// ─── Requirement Config ───────────────────────────────────────────────────────

const REQ: Record<string, { color: string; bg: string; label: string; plural: string; dot: string }> = {
    error:   { color: '#f87171', bg: 'rgba(248,113,113,0.08)', label: 'ERROR', plural: 'ERRORS', dot: '#f87171' },
    warning: { color: '#fbbf24', bg: 'rgba(251,191,36,0.07)',  label: 'WARNING',     plural: 'WARNINGS',     dot: '#fbbf24' },
    note:    { color: '#22d3ee', bg: 'rgba(34,211,238,0.07)',  label: 'NOTE',  plural: 'NOTES', dot: '#22d3ee' },
};

const REQ_ORDER: Record<string, number> = { error: 0, warning: 1, note: 2 };

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <span style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            opacity: 0.9,
        }}>
            {children}
        </span>
    );
}

function DrawerSection({ children }: { children: React.ReactNode }) {
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            paddingTop: '20px',
            marginTop: '20px',
            borderTop: '1px solid rgba(255,255,255,0.09)',
            flexShrink: 0,
        }}>
            {children}
        </div>
    );
}

// ─── Checklist Item ───────────────────────────────────────────────────────────

function ChecklistItem({ label, status }: { label: string; status: 'pass' | 'fail' | 'warn' }) {
    const isPass = status === 'pass';
    const isWarn = status === 'warn';
    const color = isPass ? 'var(--color-green, #22c55e)' : isWarn ? 'var(--color-yellow, #eab308)' : 'var(--color-red, #ef4444)';
    const bg    = isPass ? 'rgba(34,197,94,0.08)' : isWarn ? 'rgba(234,179,8,0.08)' : 'rgba(239,68,68,0.08)';
    const icon  = isPass ? '✓' : isWarn ? '⚠' : '✗';

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '18px', height: '18px', borderRadius: '4px',
                background: bg, color, flexShrink: 0, fontSize: '11px',
            }}>
                {icon}
            </span>
            <span style={{
                fontSize: '12px',
                fontFamily: "'JetBrains Mono', monospace",
                color: isPass ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                textDecoration: isPass ? 'none' : 'none',
            }}>
                {label}
            </span>
        </div>
    );
}



// ─── Violation Card ───────────────────────────────────────────────────────────

function ViolationCard({ v, onClick }: { v: GovernanceViolationDetail; onClick?: () => void }) {
    const req = REQ[v.level] ?? REQ.error;
    const clickable = typeof onClick === 'function';
    const [hover, setHover] = useState(false);

    const cardStyle: React.CSSProperties | undefined = clickable && hover
        ? { background: 'rgba(255,255,255,0.05)', transition: 'background 0.12s ease' }
        : clickable
            ? { transition: 'background 0.12s ease' }
            : undefined;

    const card = (
        <DetailCard
            color={req.color}
            badge={v.ruleId}
            title={v.ruleName}
            style={cardStyle}
        >
            {v.structuredDetail && v.structuredDetail.checks.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                    {v.structuredDetail.checks.map((c, i) => (
                        <ChecklistItem key={i} label={c.label} status={c.status} />
                    ))}
                </div>
            ) : (
                v.detail && (
                    <p style={{
                        fontSize: 'var(--cr-type-caption)',
                        color: 'var(--text-tertiary)',
                        margin: 0,
                        marginTop: '3px',
                        lineHeight: 1.5,
                        fontFamily: 'var(--font-sans)',
                    }}>
                        {v.detail}
                    </p>
                )
            )}
        </DetailCard>
    );

    if (!clickable) return card;

    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={`Open rule detail for ${v.ruleId}`}
            style={{
                all: 'unset',
                display: 'block',
                cursor: 'pointer',
                borderRadius: '6px',
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onFocus={() => setHover(true)}
            onBlur={() => setHover(false)}
        >
            {card}
        </button>
    );
}

// ─── Drawer Content ───────────────────────────────────────────────────────────

function GovernanceEntityContent({
    data,
    onRuleClick,
}: {
    data: GovernanceEntityDrawerData;
    onRuleClick?: (ruleId: string) => void;
}) {
    // Group violations by requirement in canonical order
    const grouped = data.violations.reduce<Record<string, GovernanceViolationDetail[]>>(
        (acc, v) => {
            const key = v.level;
            if (!acc[key]) acc[key] = [];
            acc[key].push(v);
            return acc;
        },
        {},
    );
    const orderedRequirements = Object.keys(grouped).sort(
        (a, b) => (REQ_ORDER[a] ?? 99) - (REQ_ORDER[b] ?? 99),
    );

    // Entity type color
    const typeColor =
        data.entityType === 'repository' ? '#60a5fa' :
        data.entityType === 'service'    ? '#22d3ee' :
        'rgba(255,255,255,0.35)';

    return (
        <>
            {/* ── Header ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingRight: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ flexShrink: 0, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {data.entityType === 'repository' ? <RepositoryIcon /> : data.entityType === 'service' ? <ServiceIcon /> : (
                            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                                <path d="M10 2L3 5v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V5l-7-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                            </svg>
                        )}
                    </div>
                    <h3 style={{
                        fontSize: 'var(--cr-type-h2)', fontWeight: 600, color: 'var(--text-primary)',
                        letterSpacing: 0, margin: 0, lineHeight: 1.2,
                        wordBreak: 'break-word',
                    }}>
                        {data.entityName}
                    </h3>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {/* Type badge */}
                    <span style={{
                        fontSize: 'var(--cr-type-micro)', fontWeight: 500,
                        padding: '2px 8px', borderRadius: '5px',
                        background: `${typeColor}14`,
                        border: `1px solid ${typeColor}25`,
                        color: typeColor,
                        fontFamily: 'var(--font-sans)',
                    }}>
                        {data.entityType}
                    </span>
                    {/* External link */}
                    {data.entityUrl && (
                        <a href={data.entityUrl} target="_blank" rel="noopener noreferrer"
                           className="drawer-link"
                           style={{ fontSize: 'var(--cr-type-micro)', fontFamily: 'var(--font-mono)' }}>
                            {data.entityUrl.replace(/^https?:\/\//, '')}
                            <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                                style={{ display: 'inline', marginLeft: '4px', opacity: 0.5 }}>
                                <path d="M5 2H2a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V7M8 1h3m0 0v3m0-3L5 7"
                                    stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </a>
                    )}
                </div>
            </div>
            {/* ── Violations grouped by requirement ── */}
            {orderedRequirements.map(reqKey => {
                const viols = grouped[reqKey];
                const meta = REQ[reqKey] ?? REQ.error;
                return (
                    <DrawerSection key={reqKey}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{
                                display: 'inline-block',
                                width: '6px', height: '6px', borderRadius: '50%',
                                background: meta.dot,
                                boxShadow: `0 0 6px ${meta.dot}80`,
                                flexShrink: 0,
                            }} />
                            <SectionLabel>{meta.plural} ({viols.length})</SectionLabel>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {viols.map((v, i) => (
                                <ViolationCard
                                    key={i}
                                    v={v}
                                    onClick={onRuleClick ? () => onRuleClick(v.ruleId) : undefined}
                                />
                            ))}
                        </div>
                    </DrawerSection>
                );
            })}

            {/* ── Passing rules ── */}
            {data.passingRules.length > 0 && (
                <DrawerSection>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                            display: 'inline-block',
                            width: '6px', height: '6px', borderRadius: '50%',
                            background: 'var(--color-green, #22c55e)',
                            boxShadow: '0 0 6px rgba(34,197,94,0.5)',
                            flexShrink: 0,
                        }} />
                        <SectionLabel>PASSING ({data.passingRules.length})</SectionLabel>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {data.passingRules.map((r, i) => {
                            const clickable = typeof onRuleClick === 'function';
                            const inner = (
                                <>
                                    <span style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        width: '18px', height: '18px', borderRadius: '4px',
                                        background: 'rgba(34,197,94,0.08)',
                                        color: 'var(--color-green, #22c55e)',
                                        flexShrink: 0, fontSize: '11px',
                                    }}>✓</span>
                                    <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'JetBrains Mono', monospace" }}>
                                        {r.ruleId}
                                    </span>
                                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                                        {r.ruleName}
                                    </span>
                                </>
                            );
                            if (!clickable) {
                                return (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        {inner}
                                    </div>
                                );
                            }
                            return (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => onRuleClick!(r.ruleId)}
                                    aria-label={`Open rule detail for ${r.ruleId}`}
                                    style={{
                                        all: 'unset',
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                        cursor: 'pointer',
                                        padding: '2px 4px',
                                        margin: '-2px -4px',
                                        borderRadius: '4px',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                                    onFocus={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                                    onBlur={e => { e.currentTarget.style.background = 'none'; }}
                                >
                                    {inner}
                                </button>
                            );
                        })}
                    </div>
                </DrawerSection>
            )}
        </>
    );
}

// ─── Rule Content ─────────────────────────────────────────────────────────────

function GovernanceRuleContent({ data }: { data: GovernanceRuleDrawerData }) {
    const req = REQ[data.level] ?? REQ.error;
    const violationCount = data.violations.length;

    return (
        <>
            {/* Header */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingRight: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ flexShrink: 0, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                            <path d="M10 2L3 5v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V5l-7-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                        </svg>
                    </div>
                    <h3 style={{
                        fontSize: 'var(--cr-type-h2)', fontWeight: 600, color: 'var(--text-primary)',
                        letterSpacing: 0, margin: 0, lineHeight: 1.2,
                        wordBreak: 'break-word',
                    }}>
                        {data.name}
                    </h3>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '2px' }}>
                    <span style={{
                        fontSize: '11px',
                        fontFamily: "'JetBrains Mono', monospace",
                        color: 'var(--text-tertiary)',
                        background: 'rgba(255,255,255,0.05)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                    }}>
                        {data.id}
                    </span>
                    <span style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        color: req.color,
                        background: req.bg,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        letterSpacing: '0.05em',
                    }}>
                        {data.level.toUpperCase()}
                    </span>
                    <span style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        color: 'var(--text-tertiary)',
                        background: 'rgba(255,255,255,0.04)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        textTransform: 'uppercase',
                    }}>
                        {data.scope}
                    </span>
                </div>
                {data.description && (
                    <p style={{
                        fontSize: '13px',
                        color: 'var(--text-secondary)',
                        lineHeight: 1.5,
                        margin: '6px 0 0 0',
                        maxWidth: '95%',
                    }}>
                        {data.description}
                    </p>
                )}
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: '24px', marginTop: '24px' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <SectionLabel>Compliance</SectionLabel>
                    <div style={{ fontSize: '18px', fontWeight: 500, color: 'var(--text-primary)', marginTop: '4px' }}>
                        {data.compliantCount} / {data.evaluatedCount}
                    </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <SectionLabel>Status</SectionLabel>
                    <div style={{
                        fontSize: '18px',
                        fontWeight: 500,
                        color: violationCount === 0 ? 'var(--color-green)' : 'var(--color-red)',
                        marginTop: '4px',
                    }}>
                        {violationCount === 0 ? 'Compliant' : `${violationCount} Violations`}
                    </div>
                </div>
            </div>

            {/* Cypher Query: "Figo" code block */}
            <DrawerSection>
                <SectionLabel>Cypher Definition</SectionLabel>
                <div style={{
                    position: 'relative',
                    marginTop: '4px',
                    background: '#0d0d0e',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '8px',
                    padding: '16px',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '13px',
                    lineHeight: 1.6,
                    color: '#e4e4e7',
                    overflowX: 'auto',
                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.3)',
                }}>
                    {/* Basic syntax coloring for "figo" effect */}
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {data.query.split('\n').map((line, i) => {
                            // Highlighting keywords (MATCH, WHERE, RETURN, etc)
                            const highlighted = line.replace(
                                /\b(MATCH|WHERE|RETURN|WITH|OPTIONAL|MERGE|SET|UNWIND|AS|CASE|WHEN|THEN|ELSE|END|OR|AND|NOT|IN)\b/g,
                                '<span style="color: #c084fc; font-weight: 600;">$1</span>'
                            ).replace(
                                /(:[a-zA-Z0-9_]+)/g,
                                '<span style="color: #60a5fa;">$1</span>'
                            ).replace(
                                /(-[\[:]|[:\]]->)/g,
                                '<span style="color: #94a3b8;">$1</span>'
                            );

                            return (
                                <div key={i} style={{ display: 'flex', gap: '16px' }}>
                                    <span style={{ color: 'rgba(255,255,255,0.15)', userSelect: 'none', width: '20px', textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                                    <span dangerouslySetInnerHTML={{ __html: highlighted }} />
                                </div>
                            );
                        })}
                    </pre>
                </div>
            </DrawerSection>

            {/* Violating Entities */}
            {violationCount > 0 && (
                <DrawerSection>
                    <SectionLabel>{violationCount === 1 ? 'Violating Entity' : 'Violating Entities'}</SectionLabel>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                        {data.violations.map((v, i) => (
                            <DetailCard
                                key={i}
                                color={req.color}
                                badge={v.entityType.toUpperCase()}
                                title={v.entityName}
                                trailing={v.teamOwner ? (
                                    <span style={{
                                        fontSize: '10.5px',
                                        fontFamily: "'JetBrains Mono', monospace",
                                        color: 'var(--text-tertiary)',
                                        background: 'rgba(255,255,255,0.04)',
                                        border: '1px solid rgba(255,255,255,0.06)',
                                        padding: '2px 7px',
                                        borderRadius: '4px',
                                        letterSpacing: '0.01em',
                                    }}>
                                        {v.teamOwner}
                                    </span>
                                ) : undefined}
                            >
                                {v.detail && (
                                    <p style={{
                                        fontSize: 'var(--cr-type-caption)',
                                        color: 'var(--text-tertiary)',
                                        margin: 0,
                                        marginTop: '3px',
                                        lineHeight: 1.5,
                                        fontFamily: 'var(--font-sans)',
                                    }}>
                                        {v.detail}
                                    </p>
                                )}
                            </DetailCard>
                        ))}
                    </div>
                </DrawerSection>
            )}

            {/* Compliant Entities (minimal rows, mirrors entity-drawer passing-rules) */}
            {data.compliants.length > 0 && (
                <DrawerSection>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                            display: 'inline-block',
                            width: '6px', height: '6px', borderRadius: '50%',
                            background: 'var(--color-green, #22c55e)',
                            boxShadow: '0 0 6px rgba(34,197,94,0.5)',
                            flexShrink: 0,
                        }} />
                        <SectionLabel>COMPLIANT ({data.compliants.length})</SectionLabel>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {data.compliants.map((c, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    width: '18px', height: '18px', borderRadius: '4px',
                                    background: 'rgba(34,197,94,0.08)',
                                    color: 'var(--color-green, #22c55e)',
                                    flexShrink: 0, fontSize: '11px',
                                }}>✓</span>
                                <span style={{
                                    fontSize: '10.5px',
                                    fontFamily: "'JetBrains Mono', monospace",
                                    color: 'var(--text-tertiary)',
                                    opacity: 0.55,
                                    flexShrink: 0,
                                }}>
                                    {c.entityType.toUpperCase()}
                                </span>
                                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                                    {c.entityName}
                                </span>
                                {c.teamOwner && (
                                    <span style={{
                                        marginLeft: 'auto',
                                        fontSize: '10.5px',
                                        fontFamily: "'JetBrains Mono', monospace",
                                        color: 'var(--text-tertiary)',
                                        background: 'rgba(255,255,255,0.04)',
                                        border: '1px solid rgba(255,255,255,0.06)',
                                        padding: '2px 7px',
                                        borderRadius: '4px',
                                        letterSpacing: '0.01em',
                                        flexShrink: 0,
                                    }}>
                                        {c.teamOwner}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </DrawerSection>
            )}
        </>
    );
}

// ─── Drawer Shell ─────────────────────────────────────────────────────────────

export function GovernanceDrawer({
    data,
    ruleDrawerById,
    onClose,
}: {
    data: GovernanceDrawerData;
    /**
     * Map ruleId → GovernanceRuleDrawerData. When set, clicking a violation or
     * passing-rule row in an entity drawer opens a second drawer with the rule
     * detail (same payload the Policies tab uses).
     */
    ruleDrawerById?: Record<string, unknown>;
    onClose: () => void;
}) {
    const [secondaryRule, setSecondaryRule] = useState<GovernanceRuleDrawerData | null>(null);

    // Open the secondary rule drawer when a card is clicked.
    const handleRuleClick = useCallback((ruleId: string) => {
        const ruleData = ruleDrawerById?.[ruleId] as GovernanceRuleDrawerData | undefined;
        if (ruleData) setSecondaryRule(ruleData);
    }, [ruleDrawerById]);

    // Wrap the primary close: when a secondary drawer is open, ESC and
    // backdrop click should dismiss only the secondary, leaving the primary
    // entity drawer in place. Without this, both DrawerShells would close at
    // once (each instance registers its own document-level Escape listener).
    const handlePrimaryClose = useCallback(() => {
        if (secondaryRule) {
            setSecondaryRule(null);
            return;
        }
        onClose();
    }, [secondaryRule, onClose]);

    const handleSecondaryClose = useCallback(() => {
        setSecondaryRule(null);
    }, []);

    const showRuleClicks =
        data.kind === 'governance-entity' && Boolean(ruleDrawerById);

    return (
        <>
            <DrawerShell
                ariaLabel={`Governance violations: ${data.kind === 'governance-entity' ? data.entityName : data.name}`}
                onClose={handlePrimaryClose}
                maxWidth="920px"
            >
                {data.kind === 'governance-entity' ? (
                    <GovernanceEntityContent
                        data={data}
                        onRuleClick={showRuleClicks ? handleRuleClick : undefined}
                    />
                ) : (
                    <GovernanceRuleContent data={data} />
                )}
            </DrawerShell>

            {secondaryRule && (
                <DrawerShell
                    ariaLabel={`Rule detail: ${secondaryRule.name}`}
                    onClose={handleSecondaryClose}
                    maxWidth="920px"
                >
                    <GovernanceRuleContent data={secondaryRule} />
                </DrawerShell>
            )}
        </>
    );
}
