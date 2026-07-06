import { Check, X, AlertTriangle, Info } from 'lucide-react';
import { SimpleTooltip } from '../../Tooltip';
import type { ReadinessCheck } from '../readiness.model';

const STATUS_ICON = {
    pass: { Icon: Check, cls: 'pass' },
    warn: { Icon: AlertTriangle, cls: 'warn' },
    fail: { Icon: X, cls: 'fail' },
} as const;

const LEVEL_LABELS: Record<string, string> = {
    error: 'Error',
    warning: 'Warning',
    note: 'Note',
};

export function ReadinessChecks({ checks }: { checks: ReadinessCheck[] }) {
    return (
        <div>
            <div className="cr-readiness__section-head">
                <span>Readiness checks</span>
                <span className="meta">{checks.length} dimensions</span>
            </div>
            <div className="cr-readiness__checks">
                {checks.map(check => {
                    const statusKey = check.status === 'pass' ? 'pass' : 'fail';
                    const { Icon, cls } = STATUS_ICON[statusKey];
                    const pointsCls = check.status === 'pass' ? 'pass' : 'fail';
                    return (
                        <div key={check.ruleId} className="cr-readiness__check">
                            <div className={`cr-readiness__check-icon cr-readiness__check-icon--${cls}`}>
                                <Icon size={11} />
                            </div>
                            <div>
                                <div className="cr-readiness__check-name">
                                    <a
                                        href={`#nav:governance?policy=${check.ruleId}`}
                                        className="cr-readiness__check-link"
                                        onClick={e => e.stopPropagation()}
                                    >
                                        {check.label}
                                    </a>
                                    <span className={`cr-readiness__check-requirement cr-readiness__check-requirement--${check.status === 'fail' ? check.level : 'muted'}`}>
                                        {LEVEL_LABELS[check.level] || check.level}
                                    </span>
                                    {check.infoTooltip && (
                                        <SimpleTooltip content={check.infoTooltip}>
                                            <span className="cr-readiness__check-info"><Info size={12} /></span>
                                        </SimpleTooltip>
                                    )}
                                </div>
                                <div className="cr-readiness__check-desc">{check.description}</div>
                            </div>
                            <span className={`cr-readiness__check-points cr-readiness__check-points--${pointsCls}`}>
                                {check.earned != null ? `${check.earned}/${check.total ?? check.earned}` : (check.status === 'pass' ? 'PASS' : 'FAIL')}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
