import { gravityTier, type GravityEvidence, type TierKey } from '../../../lib/blastTier';
import { TierGlyphBadge, type TierGlyphShape, type TierGlyphTone } from '../../TierGlyphBadge';

/** Compact tier chip: grade pill + label, no description, no native title.
 *  Reused by BlastTierLabel (banner, default size) and NodePopover (graph
 *  click-card, `size="sm"`). When `evidence` is provided and reports no
 *  observed dependent, the chip demotes to "T? Unverified" (muted/dash). */
export function BlastTierChip({ rawScore, evidence, size = 'md', variant = 'badge' }: {
    rawScore: number;
    evidence?: GravityEvidence | null;
    size?: 'sm' | 'md';
    variant?: 'badge' | 'minimal';
}) {
    const tier = gravityTier(rawScore, evidence);
    return (
        <TierGlyphBadge
            grade={tier.grade}
            label={tier.label}
            description={tier.description}
            tone={getTierTone(tier.key)}
            shape={getTierShape(tier.key)}
            size={size}
            variant={variant}
        />
    );
}

function getTierTone(key: TierKey): TierGlyphTone {
    switch (key) {
        case 'seismic': return 'danger';
        case 'critical': return 'warn';
        case 'high': return 'neutral';
        case 'moderate': return 'muted';
        case 'contained': return 'ok';
        case 'unverified': return 'muted';
    }
}

function getTierShape(key: TierKey): TierGlyphShape {
    switch (key) {
        case 'seismic': return 'triangle';
        case 'critical': return 'square';
        case 'high': return 'dot';
        case 'moderate': return 'dash';
        case 'contained': return 'dot';
        case 'unverified': return 'dash';
    }
}
