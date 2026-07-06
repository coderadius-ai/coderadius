import { RelBadge, humanizeRel, sortRels } from '../../Taxonomy';

/**
 * Legend for the rel letter badges used in the relationships rows. Dynamic:
 * renders ONLY the rels actually present in the drawer's current path groups,
 * so a single-rel relation shows one decoder pair instead of a static
 * four-letter key. This matters because letter badges collide across rel
 * families (R = Reads/Routes, C = Calls/Consumes, ...) and the legend is the
 * at-rest decoder; tooltips on the badges remain the per-badge fallback.
 * Reuses RelBadge (variant=letter) so colors match the row badges 1:1.
 */
export function RelLegend({ rels }: { rels: string[] }) {
    const unique = sortRels([...new Set(rels)]);
    if (unique.length === 0) return null;
    return (
        <div
            aria-label="Badge legend"
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '10.5px',
                color: 'var(--text-tertiary)',
                opacity: 0.85,
            }}
        >
            {unique.map((rel, i) => (
                <span key={rel} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <RelBadge rel={rel} variant="letter" />
                    <span>{humanizeRel(rel).toLowerCase()}</span>
                    {i < unique.length - 1 && (
                        <span style={{ marginLeft: '4px', opacity: 0.4 }}>·</span>
                    )}
                </span>
            ))}
        </div>
    );
}
