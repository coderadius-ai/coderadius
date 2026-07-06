import { BarredProgress, type BarredProgressTone } from './BarredProgress';

/**
 * Repository activity cell: 10-bar liveness gauge + score, fed by
 * trailing-12-month commit counts. Shared by System Registry, Governance
 * compliance, and Agent Readiness tables so the column reads identically
 * everywhere.
 */
export function ActivityBar({ score, commits, tone = 'neutral' }: {
    score: number;
    commits: number | null;
    tone?: BarredProgressTone;
}) {
    return (
        <BarredProgress
            value={score}
            bars={10}
            size="sm"
            tone={tone}
            showValue
            valueLabel={commits == null ? '—' : String(score)}
            tooltip={commits == null ? 'Liveness unknown' : `${commits} commits in trailing 12 months`}
            ariaLabel={commits == null ? 'Activity unknown' : `Activity ${score} from ${commits} commits`}
            className="cr-activity-bar"
        />
    );
}
