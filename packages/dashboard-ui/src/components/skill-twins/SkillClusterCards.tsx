import type { SkillClusterCardsSection } from '@coderadius/types';
import { SkillTwinCard } from './SkillTwinCard';

export function SkillClusterCards({ section }: { section: SkillClusterCardsSection }) {
    return (
        <section className="cr-cluster-cards">
            {section.clusters.map((cluster, idx) => (
                <SkillTwinCard key={cluster.id} cluster={cluster} clusterIdx={idx} />
            ))}
        </section>
    );
}
