/**
 * Data Quality section: confidence tier + provenance + last-seen commit.
 *
 * Shared between BlastDrawer and NodeInspectorModal so a node describes
 * itself identically on every surface.
 *
 * Why this design:
 *   - Confidence (`quality`) and extraction method (`source`) are distinct
 *     dimensions and stay on separate dt/dd rows of the same grid (`Quality`
 *     and `Source`), with uniform value typography. A legacy lockup that
 *     mashed them into one `[dot] tier · source` string was removed on
 *     purpose; do not reintroduce it.
 *   - The Quality row's value reads `tier ●`: lowercase tier word at the
 *     value rail, the colored dot trailing as the state light. The
 *     explanatory tagline lives in a tooltip on that lockup and, per the
 *     tooltip rule, carries only the descriptive prose, never a
 *     restatement of the tier label.
 *   - The user-facing header reads `Data quality`, not `GROUNDING` (an ML
 *     term operators were left guessing at). The backend term "grounding"
 *     stays in code, Cypher, mutations, and docs.
 *   - `lastSeenCommit` right-aligns on the Quality row: a mono hash is
 *     visually orthogonal to the tier word, so it shares the row without
 *     being misread as part of the tier. Sentinels (`SYSTEM` / `unknown`)
 *     render as plain-text labels via `classifyLastSeenCommit`.
 */

import {
    QUALITY_META, SOURCE_META, SOURCE_VALUES,
    classifyLastSeenCommit,
    type Quality, type Source,
} from '../types/grounding';
import type { TopologyNode } from '@coderadius/shared-types';
import { normaliseRepoUrl } from '../lib/git-url';
import { MetadataGrid, type MetadataGridItem } from './design-system';
import { SimpleTooltip } from './Tooltip';

export function GroundingSection({ node, repoUrl }: { node: TopologyNode; repoUrl?: string | null }) {
    const quality = node.quality as Quality | undefined;
    if (!quality || !QUALITY_META[quality]) return null;

    const meta = QUALITY_META[quality];
    const source = node.groundingSource ?? null;
    const sourceMeta = source && (SOURCE_VALUES as readonly string[]).includes(source)
        ? SOURCE_META[source as Source]
        : null;

    const extractors = node.evidence_extractors ?? [];
    const fallbacks = node.evidence_fallbacksApplied ?? [];
    const mergedFrom = node.evidence_mergedFrom ?? [];
    const llmCalls = node.evidence_llmCallCount ?? 0;
    const lastSeen = classifyLastSeenCommit(node.lastSeenCommit);

    // Tier row: a dt/dd grid row like Source, so fonts and the key rail stay
    // uniform across the section. Value reads `tier ●` (word first, state
    // dot trailing); the lockup tooltip carries the tier's tagline and the
    // last-seen commit right-aligns on the same row.
    const qualityItem: MetadataGridItem = {
        label: 'Quality',
        value: (
            <>
                <SimpleTooltip content={meta.tagline} side="bottom">
                    <span
                        className="cr-grounding__tierlock"
                        style={{ '--grounding-color': meta.color } as React.CSSProperties}
                    >
                        <span className="cr-grounding__tier">{meta.label}</span>
                        <span className="cr-grounding__dot" aria-hidden="true" />
                    </span>
                </SimpleTooltip>
                <LastSeenValue lastSeen={lastSeen} repoUrl={repoUrl} />
            </>
        ),
    };

    const metaItems = [
        qualityItem,
        ...buildMetaItems(sourceMeta, extractors, fallbacks, mergedFrom, llmCalls),
    ];

    return (
        <section className="cr-grounding">
            <header className="cr-grounding__header">
                <span className="cr-grounding__label">Data quality</span>
                {node.needsReview && (
                    <span
                        className="cr-grounding__review"
                        title="Flagged for human review. Run `cr review pending` for the full list."
                    >
                        Needs review
                    </span>
                )}
            </header>

            <MetadataGrid items={metaItems} columns="fixed" dense className="cr-meta-grid--rail" />
        </section>
    );
}

function buildMetaItems(
    sourceMeta: { label: string; detail: string } | null,
    extractors: string[],
    fallbacks: string[],
    mergedFrom: string[],
    llmCalls: number,
): MetadataGridItem[] {
    const items: MetadataGridItem[] = [];

    if (sourceMeta) {
        items.push({ label: 'Source', value: <span title={sourceMeta.detail}>{sourceMeta.label}</span> });
    }
    if (extractors.length > 0) {
        items.push({ label: 'Extractors', value: <GroundingChips values={extractors} mono /> });
    }
    if (fallbacks.length > 0) {
        items.push({ label: 'Sanitizers', value: <GroundingChips values={fallbacks} mono /> });
    }
    if (mergedFrom.length > 0) {
        items.push({ label: 'Welded from', value: <GroundingChips values={mergedFrom} mono /> });
    }
    if (llmCalls > 0) {
        items.push({ label: 'LLM calls', value: String(llmCalls) });
    }

    return items;
}

function LastSeenValue({
    lastSeen,
    repoUrl,
}: {
    lastSeen: ReturnType<typeof classifyLastSeenCommit>;
    repoUrl?: string | null;
}) {
    if (lastSeen.kind === 'sha') {
        const commitUrl = repoUrl ? buildCommitUrl(repoUrl, lastSeen.full) : null;
        return (
            <span className="cr-grounding__lastseen">
                <span className="cr-grounding__lastseen-label">commit</span>
                {commitUrl
                    ? <a href={commitUrl} target="_blank" rel="noopener noreferrer" className="cr-grounding__mono cr-grounding__commit-link" title={lastSeen.full}>{lastSeen.short}</a>
                    : <span className="cr-grounding__mono" title={lastSeen.full}>{lastSeen.short}</span>}
            </span>
        );
    }
    if (lastSeen.kind === 'catalog') {
        return (
            <span className="cr-grounding__lastseen cr-grounding__value--muted" title="This node was declared in a service catalog (e.g. Backstage); there's no source-commit to point at.">
                Catalog import
            </span>
        );
    }
    if (lastSeen.kind === 'unresolved') {
        return (
            <span className="cr-grounding__lastseen cr-grounding__value--muted" title="The repository's git HEAD could not be read at scan time (no .git, network timeout).">
                Unresolved
            </span>
        );
    }
    return null;
}

function GroundingChips({ values, mono = false }: { values: string[]; mono?: boolean }) {
    return (
        <span className="cr-grounding__chips">
            {values.map((c, i) => (
                <span key={`${c}-${i}`} className={`cr-grounding__chip${mono ? ' cr-grounding__chip--mono' : ''}`} title={c}>{c}</span>
            ))}
        </span>
    );
}

function buildCommitUrl(rawUrl: string, sha: string): string | null {
    const base = normaliseRepoUrl(rawUrl);
    if (!base) return null;
    if (base.includes('github.com') || base.includes('gitlab.com')) return `${base}/commit/${sha}`;
    if (base.includes('bitbucket.org')) return `${base}/commits/${sha}`;
    return `${base}/commit/${sha}`;
}
