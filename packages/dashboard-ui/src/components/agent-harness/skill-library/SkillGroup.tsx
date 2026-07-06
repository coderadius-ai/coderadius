import type { SkillStatus } from '../skill-library.model';
import { STATUS_META } from '../skill-library.model';

export function SkillGroup({ status, count, total }: { status: SkillStatus; count: number; total: number }) {
    const meta = STATUS_META[status];
    return (
        <div className={`cr-skill-lib__group-head cr-skill-lib__group-head--${status}`}>
            {meta.badge && <span className="cr-skill-lib__group-glyph" />}
            <span>{meta.label}</span>
            {meta.desc && <span className="cr-skill-lib__group-desc">{meta.desc}</span>}
            <span className="cr-skill-lib__group-count">{count} of {total}</span>
        </div>
    );
}
