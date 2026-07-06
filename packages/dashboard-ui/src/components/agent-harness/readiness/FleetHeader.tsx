import type { FleetReadiness } from '../readiness.model';
import { SimpleTooltip } from '../../Tooltip';

function scoreTone(score: number): string {
    if (score >= 80) return 'ok';
    if (score >= 50) return 'warn';
    return 'danger';
}

function FleetMetric({ tone, label, count }: { tone: 'ok' | 'warn' | 'danger'; label: string; count: number }) {
    return (
        <div className={`cr-readiness__fmetric${count === 0 ? ' cr-readiness__fmetric--empty' : ''}`}>
            <span className={`cr-readiness__fmetric-dot cr-readiness__fmetric-dot--${tone}`} />
            <span className="cr-readiness__fmetric-label">{label}</span>
            <span className="cr-readiness__fmetric-num">{count}</span>
        </div>
    );
}

export function FleetHeader({ fleet }: { fleet: FleetReadiness }) {
    const { distribution, score, trend } = fleet;

    return (
        <div className="cr-readiness__fleet">
            <div className="cr-readiness__fleet-head">
                <span className="cr-radar__eyebrow">Fleet readiness</span>
                <span className="cr-readiness__fleet-caption">
                    {trend
                        ? <><span className="cr-readiness__fleet-delta">{trend}</span>vs 30 days ago</>
                        : 'First scan, sets the baseline'}
                </span>
            </div>
            <div className="cr-readiness__fleet-band">
                <div className={`cr-readiness__fleet-score cr-readiness__fleet-score--${scoreTone(score)}`}>
                    {score}<span className="denom">/100</span>
                </div>
                <span className="cr-page-kpi-sep" aria-hidden="true" />
                <div className="cr-readiness__fleet-module">
                    <div className="cr-readiness__fleet-metrics">
                        <FleetMetric tone="ok" label="Autonomous" count={distribution.autonomous} />
                        <FleetMetric tone="warn" label="Supervised" count={distribution.supervised} />
                        <FleetMetric tone="danger" label="Off-limits" count={distribution.offLimits} />
                    </div>
                    <SimpleTooltip side="bottom" content="Threshold: ≥80 autonomous · 50-79 supervised · <50 off-limits">
                        <div className="cr-readiness__dist-bar-wrap" aria-label="Fleet readiness distribution">
                            <div className="cr-readiness__dist-bar">
                                {distribution.autonomous > 0 && <span className="auto" style={{ flex: distribution.autonomous }} />}
                                {distribution.supervised > 0 && <span className="sup" style={{ flex: distribution.supervised }} />}
                                {distribution.offLimits > 0 && <span className="off" style={{ flex: distribution.offLimits }} />}
                            </div>
                        </div>
                    </SimpleTooltip>
                </div>
            </div>
        </div>
    );
}
