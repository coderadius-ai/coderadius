import { gravityTier, type GravityEvidence } from '../../../lib/blastTier';
import { BlastTierChip } from './BlastTierChip';
import { SimpleTooltip } from '../../Tooltip';

/** Tier badge + optional subline. Inline mode keeps descriptions in tooltip. */
export function BlastTierLabel({ rawScore, evidence, coverage, variant = 'stacked' }: {
    rawScore: number;
    evidence?: GravityEvidence | null;
    coverage?: unknown;
    variant?: 'stacked' | 'inline';
}) {
    const tier = gravityTier(rawScore, evidence);
    void coverage;

    if (variant === 'inline') {
        return (
            <div className="blast-tier-lockup blast-tier-lockup--inline">
                <SimpleTooltip content={tier.description} side="bottom">
                    <span className="blast-tier-lockup__inline-chip">
                        <BlastTierChip rawScore={rawScore} evidence={evidence} variant="badge" />
                    </span>
                </SimpleTooltip>
            </div>
        );
    }

    return (
        <div className="blast-tier-lockup">
            <BlastTierChip rawScore={rawScore} evidence={evidence} />
            <div className="blast-tier-lockup__subline">{tier.description}</div>
        </div>
    );
}
