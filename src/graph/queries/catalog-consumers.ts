/**
 * Pure consumer-deduplication for the capability catalog.
 *
 * Memgraph does NOT dedupe map literals under `collect(DISTINCT ...)` (same
 * quirk as array `+`), so a skill installed in N harness dirs of one repo
 * returns N identical `{repo, url}` rows — inflating adoption counts and
 * rendering duplicate consumer rows. The query therefore collects RAW rows and
 * dedupes here, by service: a service that has the capability is ONE consumer,
 * regardless of how many harness dirs (`.agents` / `.claude` / `.cursor`) hold a
 * copy. Kept dependency-free so it is trivially unit-testable.
 */

import type { CatalogConsumer, CatalogProvenance } from '@coderadius/shared-types';

/** A raw consumer row as collected by the catalog Cypher query. */
export interface RawCatalogConsumer {
    service: string;
    repo: string;
    url: string | null;
    team: string;
}

/**
 * Collapse raw rows to one consumer per service. A later row may carry a team
 * the first lacked (OPTIONAL MATCH ordering), so backfill an empty team.
 * Sorted by service for deterministic output.
 */
export function dedupeCatalogConsumers(rows: RawCatalogConsumer[]): CatalogConsumer[] {
    const byService = new Map<string, CatalogConsumer>();
    for (const row of rows) {
        if (!row || !row.service) continue;
        const existing = byService.get(row.service);
        if (!existing) {
            byService.set(row.service, {
                service: row.service,
                repo: row.repo,
                repoUrl: row.url ?? null,
                team: row.team || '',
            });
        } else if (!existing.team && row.team) {
            existing.team = row.team;
        }
    }
    return [...byService.values()].sort((a, b) => a.service.localeCompare(b.service));
}

/** Distinct repos behind a consumer set, first url wins. Drives repo links. */
export function reposFromConsumers(consumers: CatalogConsumer[]): { name: string; url: string | null }[] {
    const byName = new Map<string, string | null>();
    for (const c of consumers) {
        if (!byName.has(c.repo)) byName.set(c.repo, c.repoUrl);
    }
    return [...byName.entries()].map(([name, url]) => ({ name, url }));
}

/** Distinct owning teams across the consumer set. */
export function teamsFromConsumers(consumers: CatalogConsumer[]): string[] {
    return [...new Set(consumers.map(c => c.team).filter(Boolean))];
}

/** A raw provenance row as collected per capability node. */
export interface RawCatalogProvenance {
    source: string | null;
    url: string | null;
    type: string | null;
    installedAt: string | null;
    updatedAt: string | null;
}

/** First row with a real source wins (provenance lives on the skills.lock-installed
 *  copy, not every harness copy). Undefined when no copy carries provenance. */
export function pickCatalogProvenance(rows: RawCatalogProvenance[]): CatalogProvenance | undefined {
    const hit = rows.find(r => r && r.source);
    if (!hit) return undefined;
    return {
        source: hit.source!,
        url: hit.url ?? null,
        type: hit.type ?? null,
        installedAt: hit.installedAt ?? null,
        updatedAt: hit.updatedAt ?? null,
    };
}
