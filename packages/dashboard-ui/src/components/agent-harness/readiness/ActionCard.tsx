import type { ReadinessAction } from '../readiness.model';
import { CopyCmd } from '../../CopyCmd';

export function ActionCard({ actions }: { actions: ReadinessAction[] }) {
    if (actions.length === 0) return null;

    // Every action fixes a failing check, so applying them all reaches 100.
    return (
        <div>
            <div className="cr-readiness__section-head">
                <span>Actions</span>
            </div>
            <div className="cr-readiness__actions-card">
                <div className="cr-readiness__actions-headline">
                    <span className="cr-readiness__actions-promise cr-readiness__actions-promise--ok">
                        Apply all to reach 100/100
                    </span>
                </div>
                <div className="cr-readiness__actions-list">
                    {actions.map((action, i) => (
                        <div key={i} className="cr-readiness__action-item">
                            <span className="cr-readiness__action-num">{i + 1}</span>
                            <div className="cr-readiness__action-body">
                                <span className="cr-readiness__action-text">{action.text}</span>
                                {action.command && <CopyCmd text={action.command} />}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
