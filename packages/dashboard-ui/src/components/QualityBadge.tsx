/**
 * QualityBadge: grounding marker rendered as a single composed row.
 *
 * Visual contract (Vercel / Linear / Datadog minimalism, aligned with the
 * `.blast-meta-item` token in `styles/impact.css`): the lowercase tier word
 * in primary text + a trailing 6 px colored state dot + optional `·`
 * separator + source label in tertiary text. Word-first with the dot as the
 * trailing state light, matching the Data Quality section's `tier ●` lockup
 * in the drawer and inspector modal. Reads as one statement, not two
 * stacked tokens.
 *
 * Variants:
 *   - default: tier label + dot (+ optional source after separator)
 *   - dotOnly: bare dot for space-constrained slots (graph card bottom-right)
 *
 * The component does NOT decide whether to render itself for a given node.
 * That suppression rule lives at the callsite via `isStructuralFamily()`
 * from `types/grounding.ts`, uniformly across the dashboard.
 */
import { SimpleTooltip } from './Tooltip';
import { QUALITY_META, SOURCE_META, SOURCE_VALUES, type Quality, type Source } from '../types/grounding';

export function QualityBadge({
    quality,
    source,
    extractors,
    /** When true, render only the dot (no label). Use in space-constrained slots like graph card bottom-right. */
    dotOnly = false,
}: {
    quality: Quality;
    source?: string;
    extractors?: string[];
    dotOnly?: boolean;
}) {
    const meta = QUALITY_META[quality];
    const tooltip = buildTooltip(quality, source, extractors);
    const sourceMeta = source && (SOURCE_VALUES as readonly string[]).includes(source)
        ? SOURCE_META[source as Source]
        : null;

    if (dotOnly) {
        return (
            <SimpleTooltip content={tooltip}>
                <span
                    className="cr-quality-dot"
                    style={{ background: meta.color }}
                    aria-label={`${meta.label} grounding`}
                />
            </SimpleTooltip>
        );
    }

    return (
        <SimpleTooltip content={tooltip}>
            <span className="cr-quality-marker" aria-label={`${meta.label} grounding`}>
                <span className="cr-quality-marker__primary">{meta.label}</span>
                <span className="cr-quality-dot" style={{ background: meta.color }} />
                {sourceMeta && (
                    <>
                        <span className="cr-quality-marker__sep" aria-hidden="true">·</span>
                        <span className="cr-quality-marker__secondary">{sourceMeta.label}</span>
                    </>
                )}
            </span>
        </SimpleTooltip>
    );
}

function buildTooltip(quality: Quality, source?: string, extractors?: string[]): string {
    const meta = QUALITY_META[quality];
    // Tooltip carries the descriptive tagline only. The dot colour + the
    // adjacent label already convey the tier; the source label (when shown)
    // already conveys the method. Tooltip enriches with the source detail
    // and extractor list — information not visible inline.
    const lines: string[] = [meta.tagline];
    if (source && (SOURCE_VALUES as readonly string[]).includes(source)) {
        lines.push(SOURCE_META[source as Source].detail);
    }
    if (extractors && extractors.length > 0) {
        const head = extractors.slice(0, 3).join(', ');
        const suffix = extractors.length > 3 ? `, +${extractors.length - 3} more` : '';
        lines.push(`Extractors: ${head}${suffix}`);
    }
    return lines.join('\n');
}
