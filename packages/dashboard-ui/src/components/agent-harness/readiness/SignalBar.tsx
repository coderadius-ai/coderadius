import type { ReadinessCheck } from '../readiness.model';

export function SignalBar({ checks }: { checks: ReadinessCheck[] }) {
    const passCount = checks.filter(c => c.status === 'pass').length;
    const failCount = checks.filter(c => c.status === 'fail').length;

    return (
        <div className="cr-readiness__signals">
            <div className="cr-readiness__signal-pair">
                <div className="cr-readiness__signal-track">
                    {checks.map((c, i) => (
                        <div
                            key={i}
                            className={`cr-readiness__signal-seg cr-readiness__signal-seg--${c.status}`}
                            title={`${c.label}: ${c.status}`}
                        />
                    ))}
                </div>
                <span className="cr-readiness__signal-summary">
                    <span className="pass">{passCount} pass</span>
                    {failCount > 0 && <>{' '}<span className="fail">{failCount} fail</span></>}
                </span>
            </div>
        </div>
    );
}
