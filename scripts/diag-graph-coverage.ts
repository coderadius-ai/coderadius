/**
 * Dump graph coverage by resource type for a given repo. Read-only.
 *
 * Usage:
 *   bun run scripts/diag-graph-coverage.ts [--repo <name>]
 *                                          [--quality-at-least <tier>]
 *                                          [--source <source>]
 *
 * Default repo = first DataContainer scope found. Override via --repo.
 *
 * Grounding filters narrow the result set to entities matching the trust
 * tier or origin discriminator:
 *   --quality-at-least exact|high|medium|low|speculative   (5-tier ladder)
 *   --source ast|heuristic|llm|composite|declared|infra|runtime
 *
 * Examples:
 *   # only entities the AST extractor verified directly
 *   bun run scripts/diag-graph-coverage.ts --source ast
 *
 *   # only entities the operator should trust (high tier and above)
 *   bun run scripts/diag-graph-coverage.ts --quality-at-least high
 *
 *   # weak entities still in the graph for a specific repo
 *   bun run scripts/diag-graph-coverage.ts --repo core-service --source llm
 */

import { getNeo4jSession, closeNeo4j } from '../src/graph/neo4j.js';
import { QUALITY_VALUES, SOURCE_VALUES, type Quality, type Source } from '../src/graph/grounding.js';

interface GroundingFilter {
    qualityAtLeast?: Quality;
    source?: Source;
}

function buildGroundingClause(alias: string, filter: GroundingFilter): { clause: string; params: Record<string, unknown> } {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.qualityAtLeast) {
        const idx = QUALITY_VALUES.indexOf(filter.qualityAtLeast);
        const allowed = QUALITY_VALUES.slice(0, idx + 1);
        conditions.push(`${alias}.quality IN $ground_allowed_qualities`);
        params.ground_allowed_qualities = allowed;
    }
    if (filter.source) {
        conditions.push(`${alias}.source = $ground_source`);
        params.ground_source = filter.source;
    }
    return {
        clause: conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '',
        params,
    };
}

async function main() {
    const args = process.argv.slice(2);
    const get = (k: string) => {
        const i = args.findIndex((a) => a === `--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const repoFilter = get('repo');

    // Parse + validate grounding flags. Unknown values fail fast rather than
    // silently producing empty results.
    const qualityArg = get('quality-at-least');
    if (qualityArg && !(QUALITY_VALUES as readonly string[]).includes(qualityArg)) {
        console.error(`Unknown quality tier: ${qualityArg}. Pick one of: ${QUALITY_VALUES.join(', ')}`);
        process.exit(1);
    }
    const sourceArg = get('source');
    if (sourceArg && !(SOURCE_VALUES as readonly string[]).includes(sourceArg)) {
        console.error(`Unknown source: ${sourceArg}. Pick one of: ${SOURCE_VALUES.join(', ')}`);
        process.exit(1);
    }
    const groundingFilter: GroundingFilter = {
        qualityAtLeast: qualityArg as Quality | undefined,
        source: sourceArg as Source | undefined,
    };
    const provLabel = [
        qualityArg ? `quality>=${qualityArg}` : null,
        sourceArg ? `source=${sourceArg}` : null,
    ].filter(Boolean).join(', ');
    if (provLabel) console.log(`# Grounding filter: ${provLabel}\n`);

    const s = getNeo4jSession();
    try {
        // DataContainer (MySQL tables + Mongo collections)
        const dcFilter = buildGroundingClause('d', groundingFilter);
        const dcRepoCond = repoFilter ? '(d.scope = $repo OR d.id CONTAINS $repo)' : 'true';
        const dc = await s.run(
            `MATCH (d:DataContainer)
             WHERE ${dcRepoCond} ${dcFilter.clause}
             RETURN d.name AS name, d.scope AS scope, d.subtype AS subtype, d.technology AS tech,
                    d.source AS ground_source, d.quality AS ground_quality, d.id AS id
             ORDER BY d.subtype, d.name`,
            { repo: repoFilter ?? '', ...dcFilter.params },
        );
        console.log('# DataContainer (tables, collections)');
        console.log(`# count: ${dc.records.length}`);
        for (const r of dc.records) {
            console.log(`  [${(r.get('subtype') ?? '?').padEnd(12)}] ${(r.get('tech') ?? '?').padEnd(8)}  ${(r.get('ground_quality') ?? '?').padEnd(11)} ${r.get('name')}  (scope=${r.get('scope')}, src=${r.get('ground_source') ?? '?'})`);
        }
        console.log();

        // MessageChannel (queues, topics, exchanges, subs)
        const mcFilter = buildGroundingClause('m', groundingFilter);
        const mc = await s.run(
            `MATCH (m:MessageChannel)
             WHERE true ${mcFilter.clause}
             RETURN m.name AS name, m.channelKind AS kind, m.technology AS tech,
                    m.source AS ground_source, m.quality AS ground_quality, m.id AS id
             ORDER BY m.channelKind, m.name`,
            mcFilter.params,
        );
        console.log('# MessageChannel');
        console.log(`# count: ${mc.records.length}`);
        for (const r of mc.records) {
            console.log(`  [${(r.get('kind') ?? '?').padEnd(12)}] ${(r.get('tech') ?? '?').padEnd(10)}  ${(r.get('ground_quality') ?? '?').padEnd(11)} ${r.get('name')}  (src=${r.get('ground_source') ?? '?'})`);
        }
        console.log();

        // APIEndpoint (split by direction via APIInterface)
        const epFilter = buildGroundingClause('e', groundingFilter);
        const ep = await s.run(
            `MATCH (i:APIInterface)-[:HAS_ENDPOINT]->(e:APIEndpoint)
             WHERE true ${epFilter.clause}
             RETURN e.method AS method, e.path AS path, e.id AS id,
                    i.direction AS direction, e.apiKind AS kind, i.apiSource AS apiSource,
                    e.source AS ground_source, e.quality AS ground_quality
             ORDER BY i.direction, e.path, e.method`,
            epFilter.params,
        );
        const inbound: any[] = [];
        const outbound: any[] = [];
        for (const r of ep.records) {
            const item = {
                method: r.get('method'),
                path: r.get('path'),
                kind: r.get('kind'),
                apiSource: r.get('apiSource'),
                ground_source: r.get('ground_source'),
                ground_quality: r.get('ground_quality'),
            };
            if (r.get('direction') === 'INBOUND') inbound.push(item);
            else outbound.push(item);
        }
        console.log(`# APIEndpoint INBOUND: ${inbound.length}`);
        for (const e of inbound) console.log(`  [${(e.kind ?? 'http').padEnd(8)}] ${(e.apiSource ?? '?').padEnd(8)}  ${(e.ground_quality ?? '?').padEnd(11)} ${(e.method ?? '?').padEnd(6)}  ${e.path}  (src=${e.ground_source ?? '?'})`);
        console.log();
        console.log(`# APIEndpoint OUTBOUND: ${outbound.length}`);
        for (const e of outbound) console.log(`  [${(e.kind ?? 'http').padEnd(8)}] ${(e.apiSource ?? '?').padEnd(8)}  ${(e.ground_quality ?? '?').padEnd(11)} ${(e.method ?? '?').padEnd(6)}  ${e.path}  (src=${e.ground_source ?? '?'})`);
        console.log();

        // APIInterface (env-var): external APIs discovered from env vars
        const extFilter = buildGroundingClause('x', groundingFilter);
        const ext = await s.run(
            `MATCH (x:APIInterface)
             WHERE x.apiSource = 'env-var' AND x.valid_to_commit IS NULL ${extFilter.clause}
             RETURN x.title AS name, x.source AS ground_source, x.quality AS ground_quality, x.id AS id
             ORDER BY x.title`,
            extFilter.params,
        );
        console.log(`# APIInterface (env-var): ${ext.records.length}`);
        for (const r of ext.records) console.log(`  ${(r.get('name') ?? '?').padEnd(40)}  ${(r.get('ground_quality') ?? '?').padEnd(11)} (src=${r.get('ground_source') ?? '?'})`);
        console.log();

        // Datastore (DB engines / brokers / cache servers)
        const dsFilter = buildGroundingClause('d', groundingFilter);
        const ds = await s.run(
            `MATCH (d:Datastore)
             WHERE true ${dsFilter.clause}
             RETURN d.name AS name, d.technology AS tech, d.kind AS kind,
                    d.source AS ground_source, d.quality AS ground_quality, d.id AS id
             ORDER BY d.kind, d.name`,
            dsFilter.params,
        );
        console.log(`# Datastore: ${ds.records.length}`);
        for (const r of ds.records) console.log(`  [${(r.get('kind') ?? '?').padEnd(10)}] ${(r.get('tech') ?? '?').padEnd(10)}  ${(r.get('ground_quality') ?? '?').padEnd(11)} ${r.get('name')}  (src=${r.get('ground_source') ?? '?'})`);
    } finally {
        await s.close();
        await closeNeo4j();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
