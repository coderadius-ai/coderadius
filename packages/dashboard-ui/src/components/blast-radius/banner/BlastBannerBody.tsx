import { BarredProgress } from '../../BarredProgress';
import { normaliseToBar, type GravityEvidence } from '../../../lib/blastTier';

/**
 * Full-width body strip under the banner header: stat-block row,
 * stacked horizontal bar (downstream/transitive/upstream), risk-factors caption.
 *
 * Metrics (no overlap — every node counted exactly once):
 *   - downstream:  Tier 1 downstream dependencies (breaks if this node changes)
 *   - transitive:  Tier 2 impact through passthrough resources (both directions)
 *   - upstream:    All upstream providers (things this node depends on)
 *   - teams:       Unique team owners across all impacted nodes
 *
 * `rawScore` drives the blast gauge through the tier-anchored map
 * (normaliseToBar): each tier owns a fifth of the bar, so the colour zones
 * flip exactly where the tier chip does (warn at T2, danger at T0).
 * With `evidence` reporting no observed dependent, the gauge renders muted:
 * the score is the node's own write/publish footprint, not observed blast.
 */
export function BlastBannerBody({
    downstream, transitive, upstream, teams, rawScore, evidence,
}: {
    downstream: number; transitive: number; upstream: number; teams: number;
    rawScore: number; evidence?: GravityEvidence | null;
}) {
    const total = downstream + transitive + upstream;
    if (total === 0) return null;

    const parts = [
        { val: downstream, lbl: 'Direct' },
        { val: transitive, lbl: 'Transitive' },
        { val: upstream, lbl: 'Upstream' },
        { val: teams, lbl: 'Team' + (teams !== 1 ? 's' : '') },
    ];
    const blastScore = normaliseToBar(rawScore);
    const blastLabel = blastScore.toFixed(2);
    const unverified = evidence ? !evidence.observed : false;
    const tooltip = unverified
        ? `Blast score ${blastLabel} (unverified)\nNo observed dependents in the scanned graph: the score reflects this node's own write/publish footprint.\n${downstream} direct downstream\n${transitive} transitive through shared resources\n${upstream} upstream providers`
        : `Blast score ${blastLabel}\n${downstream} direct downstream\n${transitive} transitive through shared resources\n${upstream} upstream providers`;

    return (
        <div className="blast-banner-body">
            {/* Stats line above bar */}
            <div className="blast-banner-body__stats">
                {parts.map((p, i) => (
                    <div key={i} className={`blast-banner-body__stat-block ${Number(p.val) === 0 ? 'blast-banner-body__stat-block--zero' : ''}`}>
                        <span className="blast-banner-body__stat-label">{p.lbl}</span>
                        <span className="blast-banner-body__stat-num">{p.val}</span>
                    </div>
                ))}
            </div>
            <div className="blast-banner-body__bar-row">
                <BarredProgress
                    className="blast-banner-body__bar"
                    size="sm"
                    bars={40}
                    value={blastScore}
                    max={1}
                    tone={unverified ? 'muted' : undefined}
                    zones={unverified ? undefined : [
                        // Tier-anchored colour zones: ok through T3, warn from
                        // T2 (single-team impact), danger from T0 (seismic).
                        { until: 0.4, tone: 'ok' },
                        { until: 0.8, tone: 'warn' },
                        { until: 1, tone: 'danger' },
                    ]}
                    ariaLabel={`Blast score ${blastLabel}${unverified ? ' (unverified)' : ''}. ${parts.map(p => `${p.val} ${p.lbl}`).join(', ')}`}
                    tooltip={tooltip}
                />
                <div className="blast-banner-body__blast-score" aria-hidden="true">
                    <span className="blast-banner-body__blast-value">{blastLabel}</span>
                    <span className="blast-banner-body__blast-label">{unverified ? 'Blast?' : 'Blast'}</span>
                </div>
            </div>
        </div>
    );
}
