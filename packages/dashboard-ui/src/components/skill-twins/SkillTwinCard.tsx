import type { SkillClusterCardsSection } from '@coderadius/types';
import { SkillMemberChip } from './SkillMemberChip';
import { CLUSTER_PALETTE } from './palette';

type Cluster = SkillClusterCardsSection['clusters'][number];

export function SkillTwinCard({ cluster, clusterIdx }: { cluster: Cluster; clusterIdx: number }) {
    const accent = CLUSTER_PALETTE[clusterIdx % CLUSTER_PALETTE.length];
    const meta = `${cluster.size} skills, ${cluster.similarity.avg.toFixed(2)} avg`;
    const repos = `${cluster.services.length} ${cluster.services.length === 1 ? 'repo' : 'repos'}`;
    const topics = cluster.topics.slice(0, 3).join(', ');

    return (
        <article id={`cluster-${cluster.id}`} className="cr-twin-card">
            <span className="cr-twin-card-accent" style={{ background: accent }} aria-hidden="true" />

            <header className="cr-twin-card-header">
                <h3 className="cr-twin-card-title">{cluster.label}</h3>
                <span className="cr-twin-card-meta">{meta}</span>
            </header>

            <div className="cr-twin-card-sub">
                <span>{repos}</span>
                {topics ? <span>{topics}</span> : null}
            </div>

            <div className="cr-twin-card-grid">
                {cluster.members.map(member => (
                    <SkillMemberChip key={member.configId} member={member} />
                ))}
            </div>
        </article>
    );
}
