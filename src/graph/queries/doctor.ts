/**
 * `cr doctor` — cross-repo shared-database suggester.
 *
 * Detects the "shared database" antipattern the welder cannot resolve on its
 * own: two repos each own a DataContainer with the same table name, stored in
 * per-repo Datastores whose endpoints resolve the same database name. When
 * the physical fingerprint is unavailable (compose service hosts, localhost),
 * `weldDataContainersByEndpoint` has no match key — so instead of guessing,
 * doctor proposes the authoritative fix: a `databases[]` declaration with
 * `shared: true` in each repo's coderadius.yaml.
 *
 * Corroboration gate: the endpoint dbName modulo env suffix, NOT the table
 * name. Two repos both having a `users` table is noise; two repos whose
 * endpoints resolve the same database name is signal. The human ratifies.
 */
import { run } from '../mutations/_run.js';
import { stripEnvSuffix } from '../../ingestion/processors/connection-extractors/canonicalizer.js';

/** One candidate pair as returned by the Cypher scan (pre-corroboration). */
export interface SharedDbCandidateRow {
    tableName: string;
    repoA: string;
    repoB: string;
    namespaceA: string;
    namespaceB: string;
    technologyA: string | null;
    technologyB: string | null;
    dbNameA: string;
    dbNameB: string;
}

/** A proposed `databases[]` entry, valid for every repo in `repos`. */
export interface SharedDbSuggestion {
    /** Suggested `databases[].id` — the shared dbName root, lowercased. */
    id: string;
    technology: string | null;
    /** Qualified repo names whose coderadius.yaml should declare this database. */
    repos: string[];
    /** Table names observed on both sides (become `databases[].tables`). */
    tables: string[];
}

/**
 * Scan for same-named DataContainers in different scopes whose datastores
 * both resolve a dbName. Cheap read-only pass; the dbName corroboration
 * happens in `groupSharedDbSuggestions` (Cypher can't strip env suffixes).
 */
export async function findSharedDbCandidates(): Promise<SharedDbCandidateRow[]> {
    const r = await run(
        `MATCH (a:DataContainer)-[:STORED_IN]->(dsA:Datastore)-[:SERVED_BY]->(epA:DatabaseEndpoint)
         MATCH (b:DataContainer)-[:STORED_IN]->(dsB:Datastore)-[:SERVED_BY]->(epB:DatabaseEndpoint)
         WHERE a.id < b.id
           AND toLower(a.name) = toLower(b.name)
           AND a.scope <> b.scope
           AND dsA.id <> dsB.id
           AND epA.dbName IS NOT NULL AND epB.dbName IS NOT NULL
           AND a.valid_to_commit IS NULL AND b.valid_to_commit IS NULL
           AND dsA.valid_to_commit IS NULL AND dsB.valid_to_commit IS NULL
         RETURN DISTINCT a.name AS tableName,
                a.sourceRepo AS repoA, b.sourceRepo AS repoB,
                dsA.namespace AS namespaceA, dsB.namespace AS namespaceB,
                dsA.technology AS technologyA, dsB.technology AS technologyB,
                epA.dbName AS dbNameA, epB.dbName AS dbNameB`,
        {},
    );
    return r.records.map(rec => ({
        tableName: rec.get('tableName') as string,
        repoA: rec.get('repoA') as string,
        repoB: rec.get('repoB') as string,
        namespaceA: rec.get('namespaceA') as string,
        namespaceB: rec.get('namespaceB') as string,
        technologyA: (rec.get('technologyA') as string) ?? null,
        technologyB: (rec.get('technologyB') as string) ?? null,
        dbNameA: rec.get('dbNameA') as string,
        dbNameB: rec.get('dbNameB') as string,
    }));
}

/**
 * Corroborate and group candidate pairs into per-database suggestions.
 * Pure function — unit-tested without a DB.
 *
 * Gates:
 *   - dbName roots must match modulo env suffix (`commerce` ≡ `commerce-dev`).
 *   - pairs already declared shared (namespace = 'shared') are done, skip.
 *   - technologies that disagree across sides drop the whole database
 *     (conflicting evidence beats a wrong suggestion).
 */
export function groupSharedDbSuggestions(rows: readonly SharedDbCandidateRow[]): SharedDbSuggestion[] {
    interface Acc { technologies: Set<string>; repos: Set<string>; tables: Set<string> }
    const byRoot = new Map<string, Acc>();
    for (const r of rows) {
        if (r.namespaceA === 'shared' || r.namespaceB === 'shared') continue;
        const rootA = stripEnvSuffix(r.dbNameA).toLowerCase();
        const rootB = stripEnvSuffix(r.dbNameB).toLowerCase();
        if (rootA !== rootB || rootA === '') continue;
        const acc = byRoot.get(rootA) ?? { technologies: new Set(), repos: new Set(), tables: new Set() };
        for (const t of [r.technologyA, r.technologyB]) if (t) acc.technologies.add(t);
        acc.repos.add(r.repoA);
        acc.repos.add(r.repoB);
        acc.tables.add(r.tableName);
        byRoot.set(rootA, acc);
    }
    const suggestions: SharedDbSuggestion[] = [];
    for (const [id, acc] of byRoot) {
        if (acc.technologies.size > 1) continue; // sides disagree — not our call
        suggestions.push({
            id,
            technology: [...acc.technologies][0] ?? null,
            repos: [...acc.repos].sort(),
            tables: [...acc.tables].sort(),
        });
    }
    return suggestions.sort((x, y) => x.id.localeCompare(y.id));
}
