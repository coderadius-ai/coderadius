import type { SkillClusterCardsSection } from '@coderadius/types';

type Member = SkillClusterCardsSection['clusters'][number]['members'][number];

export function SkillMemberChip({ member }: { member: Member }) {
    const description = member.semanticIntent && member.semanticIntent.length > 0
        ? member.semanticIntent
        : member.description;
    return (
        <div className="cr-twin-member">
            <div className="cr-twin-member-name" title={member.name}>{member.name}</div>
            <div className="cr-twin-member-desc">{description || 'No description'}</div>
            <div className="cr-twin-member-footer">
                <span className="cr-twin-member-svc" title={member.service}>{member.service}</span>
                <span className="cr-twin-member-path" title={member.filePath}>{member.filePath}</span>
            </div>
        </div>
    );
}
