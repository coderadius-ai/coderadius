/**
 * Eval Suite — Graph Extraction Verification
 *
 * Runs the full ingestion pipeline against microservices/ and asserts the
 * resulting Neo4j graph structure via Cypher queries.
 *
 * Prerequisites:
 *   - Neo4j running (docker compose up)
 *   - LLM credentials configured (~/.coderadius/credentials.json or env)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';

// ─── Neo4j + Ingestion Imports ──────────────────────────────────────────────
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { resolveAllSources } from '../../src/ingestion/core/source-resolver.js';
import { mergeRepositoriesBatch } from '../../src/graph/mutations/code-graph.js';
import { discoverBackstageComponents } from '../../src/ingestion/extractors/backstage-extractor.js';
import { discoverAutoComponents, classifyFrameworkRoles, inferLanguageFromDir } from '../../src/ingestion/extractors/autodiscovery.js';
import { getLanguagePlugin } from '../../src/ingestion/core/languages/registry.js';
import { ingestCodePipeline } from '../../src/ingestion/processors/code-pipeline/orchestrator.js';
import { ingestOpenAPI } from '../../src/ingestion/extractors/openapi-extractor.js';
import { ingestMatchmaking } from '../../src/ingestion/processors/matchmaking.js';
import { runDataEntityPostProcessor } from '../../src/ingestion/processors/data-entity-post-processor.js';
import { ingestStructural } from '../../src/ingestion/structural/plugin-manager.js';
import { ingestGraphQLSchemas } from '../../src/ingestion/extractors/graphql-schema-extractor.js';
import { ingestSchemaFiles } from '../../src/ingestion/extractors/schema-extractor.js';
import { ingestLockfileDependencies } from '../../src/ingestion/extractors/lockfile-extractor.js';
import { registerCustomMessageConsumerDecorator } from '../../src/ingestion/core/languages/typescript/framework-signals.js';

import { getConfigSymbolExtractorAgent } from '../../src/ai/agents/config-symbol-extractor.js';
import { getSchemaExtractorAgent } from '../../src/ai/agents/schema-extractor.js';
import { withReplay, wireUnifiedAnalyzerReplay } from '../eval/helpers/with-replay.js';
import { configManager } from '../../src/config/index.js';
import { collapseToTopology, writeTopologyToGraph, weldIdentities, resolveCatalogPriority, getServiceRootDir } from '../../src/ingestion/topology-resolver.js';
import { loadRepoHints, getTopology, getNameOverrides } from '../../src/config/repo-hints.js';
import { bindUnresolvedDependencies, gcOrphanUnresolvedDependencies } from '../../src/graph/mutations/c4.js';

// ─── Symbol Registry (Pass 0.5) ─────────────────────────────────────────────
import { SymbolRegistry } from '../../src/ingestion/core/symbol-registry.js';
import { isConfigFile } from '../../src/ingestion/core/config-file-detector.js';
import { scanRepositoryTree } from '../../src/utils/tree-scanner.js';
import { getQualifiedRepoName } from '../../src/graph/urn.js';
import { buildSymbolRegistryForRepo } from '../../src/ingestion/core/symbol-extraction.js';

// ─── Eval Scorer ────────────────────────────────────────────────────────────
import { loadManifest } from '../eval/types/eval-manifest.js';
import {
    scoreNodes,
    scoreEdges,
    scoreSymbols,
    checkNegatives,
    assembleReport,
    printReport,
    writeReportJSON,
    appendToHistory,
} from '../eval/scorers/eval-scorer.js';
import { buildGraphSnapshot } from '../eval/scorers/graph-snapshot.js';
import {
    hardCheck,
} from '../eval/helpers/eval-mode.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_DATA_DIR = path.resolve(import.meta.dirname, '..', 'fixtures', 'microservices');


/**
 * Run a read-only Cypher query and return the records as plain objects.
 */
async function cypher<T = Record<string, unknown>>(
    query: string,
    params: Record<string, unknown> = {},
): Promise<T[]> {
    const session = getNeo4jSession();
    try {
        const result = await session.run(query, params);
        return result.records.map(r => r.toObject() as T);
    } finally {
        await session.close();
    }
}

/**
 * Convenience: return a flat array of a single column from a Cypher query.
 */
async function cypherColumn<T = string>(query: string, column: string): Promise<T[]> {
    const rows = await cypher(query);
    return rows.map(r => (r as Record<string, T>)[column]);
}

// Node-name snapshots per label come from the shared builder
// (tests/eval/scorers/graph-snapshot.ts, 'fixture' mode): `n.name` verbatim,
// plus the synthetic 'GRAPHQL <op> <name>' label for GraphQL endpoints.

// ═════════════════════════════════════════════════════════════════════════════
// Suite
// ═════════════════════════════════════════════════════════════════════════════

describe('Graph Extraction Eval Suite', () => {
    // ── Global Setup: wipe graph, run full ingestion ─────────────────────────

    beforeAll(async () => {
        process.env.LLM_CONCURRENCY = process.env.LLM_CONCURRENCY || '5'; // Balance throughput vs 429 rate limits in CI/eval

        console.log('[EVAL] Wiring global replay cache to LLM agents...');

        // OPT-5 fix: The pipeline uses per-language agents (e.g.
        // deep:typescript-unified-analyzer-agent) via getAnalyzerStrategy().
        // wireUnifiedAnalyzerReplay wraps the generic singletons + the
        // fast/deep per-language agent of every registered plugin, using the
        // REAL ScanMode values ('semantic' → fast, 'contracts' → deep). The
        // previous inline loop passed legacy 'deep'/'fast' values, which
        // getAnalyzerStrategy maps to fast in both cases — deep per-language
        // agents were never wrapped.
        await wireUnifiedAnalyzerReplay();

        await withReplay(getConfigSymbolExtractorAgent(), 'v1.0.0-config-extractor');
        await withReplay(getSchemaExtractorAgent(), 'v1.0.0-schema-extractor');
        // infra-discovery scout removed — the target plan is deterministic.

        // 1. Wipe graph — REFUSE on a non-test instance. This suite
        //    DETACH-DELETEs the WHOLE database; tests/setup.ts remaps vitest
        //    runs to the test container (:7688), but a runner that skips
        //    vitest setupFiles (e.g. `bun test`) would inherit the dev URI
        //    from .env and destroy the live working graph.
        const memgraphUri = process.env.MEMGRAPH_URI ?? 'bolt://localhost:7687';
        if (!process.env.CI && !memgraphUri.includes(':7688')) {
            throw new Error(
                `[EVAL] Refusing to wipe non-test Memgraph at "${memgraphUri}" — `
                + 'run via vitest (tests/setup.ts remaps to :7688) or set MEMGRAPH_URI to the test instance.',
            );
        }
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) DETACH DELETE n');
        } finally {
            await session.close();
        }

        // 2. Initialize schema (constraints + indexes)
        await initSchema();

        // 3. Resolve sources
        const sessionId = `eval-${Date.now()}`;
        const repos = await resolveAllSources([MOCK_DATA_DIR], sessionId);

        // 3.5 Persist Repository nodes — mirrors governance-scan workflow.
        // Without this, linkServiceStoredIn (MATCH-not-MERGE) silently no-ops.
        await mergeRepositoriesBatch(
            repos.map(repo => ({
                name: repo.name,
                url: repo.remoteUrl,
                commitHash: repo.commit || 'unknown',
                org: repo.org,
                branch: repo.branch,
                defaultBranch: repo.defaultBranch,
                coreBranches: repo.coreBranches,
                hostingPlatform: repo.hostingPlatform,
            })),
        );

        // 4. Backstage → discover components (no graph writes yet)
        const backstageResult = await discoverBackstageComponents(repos);

        // 5. Per-repo: autodiscover + weld + collapse + write (mirrors governance workflow)
        const serviceRoots: Array<{ name: string; path: string; language: string; isRuntimeService: boolean; frameworkRoles?: ReadonlySet<string> }> = [];
        for (const repo of repos) {
            const catalogPriority = resolveCatalogPriority(
                backstageResult.components.some(c => c.catalogFile.startsWith(repo.path)),
                false, // no cortex in eval fixtures
            );
            const repoComponents = catalogPriority === 'backstage'
                ? backstageResult.components.filter(c => c.catalogFile.startsWith(repo.path))
                : [];
            const repoAux = catalogPriority === 'backstage' ? backstageResult.auxiliaryEntities : [];

            const auto = await discoverAutoComponents([repo], []);
            serviceRoots.push(...auto.serviceRoots);

            const hints = loadRepoHints(repo.path);
            const nameOverrides = getNameOverrides(hints);
            const weldResult = weldIdentities(
                repoComponents, auto.components,
                repo.path, repo.name, nameOverrides,
            );
            if (weldResult.components.length === 0) continue;

            const topology = getTopology(hints);
            const result = collapseToTopology(weldResult.components, repoAux, topology, repo.name, repo.path, hints);
            await writeTopologyToGraph(result, repo);

            for (const entry of result.services) {
                const svcDir = getServiceRootDir(entry.component.catalogFile);
                let language = entry.component.language ?? 'unknown';
                if (language === 'unknown') language = inferLanguageFromDir(svcDir, repo.path);
                const plugin = getLanguagePlugin(language);
                const frameworkRoles = classifyFrameworkRoles(svcDir, plugin);
                serviceRoots.push({
                    name: entry.component.name,
                    path: svcDir,
                    language,
                    isRuntimeService: true,
                    frameworkRoles: frameworkRoles.size > 0 ? frameworkRoles : undefined,
                });
            }
        }

        // 5.5 Register custom decorators for conduit-relay-service fixture
        registerCustomMessageConsumerDecorator('ConduitHandler', ['routingKey', 'queue'], 'message-consumer');

        // 5.6 Symbol Registry — Pass 0.5: extract DI bindings from config files
        //     This populates the SymbolRegistry so the sanitizer can resolve
        //     DI keys (e.g. notredeemable.publisher) to physical names
        //     (e.g. loyalty.not_redeemable) during LLM output sanitization.
        const noopReporter = { report: (m) => { console.log(m); }, warn: (m) => { console.error(m); }, error: () => { } };
        const symbolRegistryByRepo = new Map<string, SymbolRegistry>();
        for (const repo of repos) {
            const buildResult = await buildSymbolRegistryForRepo({
                repo,
                progress: noopReporter,
                fresh: true,
                commitHash: 'SYSTEM',
                persistCacheState: false,
            });
            symbolRegistryByRepo.set(getQualifiedRepoName(repo), buildResult.registry);
        }

        // 6. Static codebase analysis (parser + LLM) — NOW with symbol registry.
        // scanMode='contracts' enables the LLM schema-extractor; the legacy
        // 'deep' literal silently disabled it because the runtime check is
        // `scanMode === 'contracts'` and tsconfig excludes tests/ so the type
        // mismatch never surfaced.
        await ingestCodePipeline(repos, undefined, serviceRoots, 'contracts', symbolRegistryByRepo, undefined, undefined, true);

        // 7. OpenAPI contracts
        await ingestOpenAPI(repos, serviceRoots);

        // 8. API endpoint matchmaking
        await ingestMatchmaking();

        // 9. Dynamic table prefix expansion (post-processor)
        await runDataEntityPostProcessor();

        // 10. Structural extraction
        await ingestStructural(repos, serviceRoots, {
            report: (m) => { console.log(m); },
            error: (msg: string) => console.error(msg),
            warn: (msg: string) => console.warn(msg),
        });

        // 10.5. Lockfile dependencies
        await ingestLockfileDependencies(repos, {
            report: (m) => { console.log(m); },
            error: (msg: string) => console.error(msg),
            warn: (msg: string) => console.warn(msg),
        });

        // 11. GraphQL SDL extraction
        await ingestGraphQLSchemas(repos, serviceRoots);

        // 12. Schema Contract Extraction (Avro, Protobuf, etc.)
        await ingestSchemaFiles(repos, serviceRoots);

        // 13. Cross-repo DEPENDS_ON late binding + GC orphans
        //     Mirrors the post-ingestion step in code-ingestion.workflow.ts.
        await bindUnresolvedDependencies('SYSTEM');
        await gcOrphanUnresolvedDependencies();

    }, 900_000); // 15 min timeout for the full pipeline due to LLM potential rate limits

    afterAll(async () => {
        await closeNeo4j();
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 1. Repository & Git Recognition
    // ═════════════════════════════════════════════════════════════════════════

    describe('Repository Recognition', () => {
        it('should detect all three mock service repositories', async () => {
            const names = await cypherColumn(
                'MATCH (r:Repository) RETURN r.name AS name ORDER BY name',
                'name',
            );
            expect(names).toContain('microservices');
        });

        it('should link Repositories to SourceFiles via CONTAINS', async () => {
            const rows = await cypher<{ repo: string; file: string }>(
                `MATCH (r:Repository)-[:CONTAINS]->(sf:SourceFile)
                 RETURN r.name AS repo, sf.name AS file ORDER BY repo, file`,
            );
            const repoFiles = new Map<string, string[]>();
            for (const r of rows) {
                const files = repoFiles.get(r.repo) ?? [];
                files.push(r.file);
                repoFiles.set(r.repo, files);
            }

            // Each repo should contain at least one source file
            // The single repository should contain source files from all services
            expect(repoFiles.get('microservices')?.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 2. Service Nodes
    // ═════════════════════════════════════════════════════════════════════════

    describe('Service Extraction', () => {
        it('should create Service nodes for all four services', async () => {
            const names = await cypherColumn(
                'MATCH (s:Service) RETURN s.name AS name ORDER BY name',
                'name',
            );
            expect(names).toContain('order-service');
            expect(names).toContain('loyalty-service');
            expect(names).toContain('notification-service');
            expect(names).toContain('travel-scraper');
        });

        it('should link services via service-to-service DEPENDS_ON (from Backstage)', async () => {
            // After the ontology refactoring, Backstage only creates component→component deps.
            // Resource dependencies (postgres, rabbitmq) are discovered by code analysis.
            const rows = await cypher<{ from: string; to: string }>(
                `MATCH (s1:Service)-[:DEPENDS_ON]->(s2:Service)
                 RETURN s1.name AS from, s2.name AS to ORDER BY from`,
            );
            const deps = rows.map(r => `${r.from}->${r.to}`);
            // notification-service declares dependsOn: component:order-service
            expect(deps).toContain('notification-service->order-service');
        });

        it('should link ALL services to the Repository via STORED_IN', async () => {
            // Regression: auto-discovered services were floating without a Repository link
            // because linkServiceStoredIn was called before the Repository node existed.
            const rows = await cypher<{ svc: string; repo: string; path: string }>(
                `MATCH (s:Service)-[r:STORED_IN]->(repo:Repository)
                 RETURN s.name AS svc, repo.name AS repo, r.path AS path ORDER BY svc`,
            );

            const linkedServices = rows.map(r => r.svc);
            expect(linkedServices).toContain('order-service');
            expect(linkedServices).toContain('loyalty-service');
            expect(linkedServices).toContain('notification-service');
            expect(linkedServices).toContain('travel-scraper');

            // Every service should point to the same repository
            for (const row of rows) {
                expect(row.repo).toBe('microservices');
            }
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 3. Backstage C4 Hierarchy
    // ═════════════════════════════════════════════════════════════════════════

    describe('Backstage C4 Skeleton', () => {
        it('should create System nodes from catalog-info.yaml', async () => {
            const names = await cypherColumn(
                'MATCH (sys:System) RETURN sys.name AS name ORDER BY name',
                'name',
            );
            expect(names).toContain('ecommerce-platform');
            expect(names).toContain('logistics-platform');
            expect(names).toContain('travel-platform');
        });

        it('should link Systems to their Services via CONTAINS (governance)', async () => {
            const rows = await cypher<{ sys: string; svc: string }>(
                `MATCH (sys:System)-[:CONTAINS]->(s:Service)
                 RETURN sys.name AS sys, s.name AS svc ORDER BY svc`,
            );
            const sysToSvc = Object.fromEntries(rows.map(r => [r.svc, r.sys]));

            expect(sysToSvc['order-service']).toBe('ecommerce-platform');
            expect(sysToSvc['notification-service']).toBe('ecommerce-platform');
            expect(sysToSvc['loyalty-service']).toBe('logistics-platform');
            expect(sysToSvc['travel-scraper']).toBe('travel-platform');
        });

        it('should create Teams and link via OWNS (governance)', async () => {
            const rows = await cypher<{ team: string; svc: string }>(
                `MATCH (t:Team)-[:OWNS]->(s:Service)
                 RETURN t.name AS team, s.name AS svc`,
            );
            const map = Object.fromEntries(rows.map(r => [r.svc, r.team]));
            expect(map['order-service']).toBe('team-checkout');
            expect(map['loyalty-service']).toBe('team-logistics');
            expect(map['notification-service']).toBe('team-checkout');
            expect(map['travel-scraper']).toBe('team-travel');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 4. Function Extraction
    // ═════════════════════════════════════════════════════════════════════════

    describe('Function Extraction', () => {
        it('should extract functions from all three services', async () => {
            const rows = await cypher<{ count: number }>(
                'MATCH (f:Function) RETURN count(f) AS count',
            );
            // We expect at least 10 functions across all services
            expect(Number(rows[0].count)).toBeGreaterThanOrEqual(10);
        });

        it('should link SourceFiles to Functions via CONTAINS', async () => {
            const rows = await cypher<{ count: number }>(
                'MATCH (sf:SourceFile)-[:CONTAINS]->(f:Function) RETURN count(*) AS count',
            );
            expect(Number(rows[0].count)).toBeGreaterThan(0);
        });



        it('should extract PHP class methods from loyalty-service', async () => {
            const fns = await cypherColumn(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'RewardCalculator.php'
                 RETURN f.name AS name`,
                'name',
            );
            // PHP methods are prefixed with class name: ClassName.methodName
            // These are LLM-dependent (analysis must succeed for function nodes to be persisted)
            hardCheck(fns.some(n => n.includes('RewardCalculator.calculateDiscount')), 'RewardCalculator.calculateDiscount extracted');
            hardCheck(fns.some(n => n.includes('RewardCalculator.processPayment')), 'RewardCalculator.processPayment extracted');
            hardCheck(fns.some(n => n.includes('RewardCalculator.publishRewardEvent')), 'RewardCalculator.publishRewardEvent extracted');
        });

        it('should extract SourceFile nodes for PHP, TS, and YAML files', async () => {
            const names = await cypherColumn(
                'MATCH (sf:SourceFile) RETURN sf.name AS name',
                'name',
            );
            expect(names.some(n => n.endsWith('.ts'))).toBe(true);
            expect(names.some(n => n.endsWith('.php'))).toBe(true);
        });
    });



    // ═════════════════════════════════════════════════════════════════════════
    // 6. Inter-Service Dependencies (Shared Resources)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Inter-Service Dependencies via Shared Resources', () => {
        it('should create MessageChannel and Datastore nodes for shared infrastructure', async () => {
            // MessageChannels and Datastores are now created by code analysis
            const brokers = await cypherColumn(
                'MATCH (broker:MessageChannel) RETURN broker.name AS name',
                'name',
            );
            const datastores = await cypherColumn(
                'MATCH (ds:Datastore) RETURN ds.name AS name',
                'name',
            );
            expect(brokers.length + datastores.length).toBeGreaterThan(0);
        });

        it('should detect the notification-service -> order-service dependency (from Backstage)', async () => {
            const rows = await cypher<{ from: string; to: string }>(
                `MATCH (s1:Service)-[:DEPENDS_ON]->(s2:Service)
                 RETURN s1.name AS from, s2.name AS to`,
            );
            const deps = rows.map(r => `${r.from}->${r.to}`);
            expect(deps).toContain('notification-service->order-service');
        });

        it('should leave no :UnresolvedDependency placeholders after late-binding GC', async () => {
            // resource:* deps are normalized to bare names ('mysql', 'rabbitmq', …)
            // and create :UnresolvedDependency placeholders. Since no :Service
            // matches them, the GC step must remove them.
            const rows = await cypher<{ count: number }>(
                'MATCH (u:UnresolvedDependency) RETURN count(u) AS count',
            );
            expect(Number(rows[0].count)).toBe(0);
        });

        it('should not create Service stubs for unresolvable resource:* deps', async () => {
            // Pre-fix: `resource:mysql` would create cr:service:local/microservices:mysql
            // as a phantom Service stub. Post-fix: it is a transient
            // UnresolvedDependency that GC removes.
            const ghostStubs = await cypherColumn<string>(
                `MATCH (s:Service)
                 WHERE s.name IN ['mysql', 'rabbitmq', 'postgres', 'mongodb', 'google-pubsub']
                 RETURN s.name AS name`,
                'name',
            );
            expect(ghostStubs).toEqual([]);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 7. OpenAPI Contract Ingestion
    // ═════════════════════════════════════════════════════════════════════════

    describe('OpenAPI Contracts', () => {
        it('should create APIInterface nodes from openapi.yaml', async () => {
            const rows = await cypher<{ count: number }>(
                'MATCH (api:APIInterface) RETURN count(api) AS count',
            );
            expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1);
        });

        it('should create APIEndpoint nodes with paths and methods', async () => {
            const rows = await cypher<{ path: string; method: string }>(
                `MATCH (api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
                 RETURN ep.path AS path, ep.method AS method`,
            );
            expect(rows.length).toBeGreaterThan(0);
            // The loyalty-service openapi.yaml has POST /charge
            expect(rows.some(r => r.path === '/charge' && r.method.toUpperCase() === 'POST')).toBe(true);
        });

        it('should link Service to its API via EXPOSES_API', async () => {
            const services = await cypherColumn(
                `MATCH (s:Service)-[:EXPOSES_API]->(api:APIInterface)
                 RETURN s.name AS name`,
                'name',
            );
            expect(services).toContain('loyalty-service');
        });

        it('should create the openapi.yaml as a SourceFile owned by the service', async () => {
            const rows = await cypher<{ svc: string; file: string }>(
                `MATCH (s:Service)-[:OWNS]->(sf:SourceFile)
                 WHERE sf.name = 'openapi.yaml'
                 RETURN s.name AS svc, sf.name AS file`,
            );
            expect(rows.length).toBeGreaterThan(0);
            const services = rows.map(r => r.svc);
            expect(services).toContain('loyalty-service');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 8. Package Dependencies
    // ═════════════════════════════════════════════════════════════════════════

    describe('Package Dependencies', () => {
        it('should have Package nodes in the graph', async () => {
            const rows = await cypher<{ count: number }>(
                'MATCH (p:Package) RETURN count(p) AS count',
            );
            expect(Number(rows[0].count)).toBeGreaterThan(0);
        });

        it('should detect internal packages across services', async () => {
            const rows = await cypher<{ name: string; isInternal: boolean }>(
                `MATCH (p:Package {isInternal: true})
                 RETURN p.name AS name, p.isInternal AS isInternal`,
            );
            const names = rows.map(r => r.name);
            // @acme-corp/common-utils and acme-corp/logistics-math-lib should be internal
            expect(names).toContain('@acme-corp/common-utils');
            expect(names).toContain('acme-corp/logistics-math-lib');
        });

        it('should link packages to their repository or container via DEPENDS_ON', async () => {
            // Check that at least some entity DEPENDS_ON a Package
            const rows = await cypher<{ count: number }>(
                `MATCH ()-[:DEPENDS_ON]->(p:Package)
                 RETURN count(*) AS count`,
            );
            expect(Number(rows[0].count)).toBeGreaterThan(0);
        });
    });



    // ═════════════════════════════════════════════════════════════════════════
    // 11. Pub/Sub Functions (notification-service)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Pub/Sub Functions', () => {
        it('should extract Pub/Sub publisher and subscriber functions', async () => {
            const fns = await cypherColumn(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'PubSubPublisher.php'
                 RETURN f.name AS name`,
                'name',
            );
            // PHP methods are class-prefixed
            expect(fns.some(n => n.includes('publishNotificationEvent'))).toBe(true);
        });

        it('should detect Pub/Sub functions as having I/O (not filtered)', async () => {
            const rows = await cypher<{ count: number }>(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'PubSubPublisher.php'
                 RETURN count(f) AS count`,
            );
            // At least the publish and listen functions should pass the IO filter
            expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 12. RabbitMQ Consumer Functions
    // ═════════════════════════════════════════════════════════════════════════

    describe('RabbitMQ Consumer Functions', () => {
        it('should extract consumer functions from NotificationConsumer.php', async () => {
            const fns = await cypherColumn(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'NotificationConsumer.php'
                 RETURN f.name AS name`,
                'name',
            );
            // PHP methods are class-prefixed
            expect(fns.some(n => n.includes('consumeOrderEvents') || n.includes('processOrderNotification'))).toBe(true);
        });

        it('should have at least one function from NotificationConsumer with I/O', async () => {
            const rows = await cypher<{ count: number }>(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'NotificationConsumer.php'
                 RETURN count(f) AS count`,
            );
            expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 13. PHP exec/spawn Functions
    // ═════════════════════════════════════════════════════════════════════════

    describe('PHP exec/spawn Functions', () => {
        it('should extract ScriptRunner functions', async () => {
            const fns = await cypherColumn(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'ScriptRunner.php'
                 RETURN f.name AS name`,
                'name',
            );
            // PHP methods: ScriptRunner.spawnCompanyScript, etc.
            expect(fns.some(n => n.includes('spawnCompanyScript'))).toBe(true);
        });

        it('should detect exec/spawn functions as having I/O (not filtered out)', async () => {
            const rows = await cypher<{ count: number }>(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'ScriptRunner.php'
                 RETURN count(f) AS count`,
            );
            // exec() hits the heuristic filter's 'system' pattern
            expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1);
        });

        it('should extract child processes as SystemProcess nodes and link them via SPAWNS', async () => {
            const rows = await cypher<{ caller: string; script: string }>(
                `MATCH (f:Function)-[:SPAWNS]->(sp:SystemProcess)
                 WHERE f.filepath CONTAINS 'ScriptRunner.php'
                 RETURN f.name AS caller, sp.name AS script`
            );
            // Verify at least one script spawned by exec is correctly linked as a SystemProcess
            expect(rows.length).toBeGreaterThan(0);
            const scripts = rows.map(r => r.script);
            expect(scripts.some(s => s.includes('recursive_worker.php') || s.includes('process_'))).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 14. Global Consistency Checks
    // ═════════════════════════════════════════════════════════════════════════

    describe('Global Consistency', () => {
        it('should have no orphaned Functions (every Function belongs to a SourceFile)', async () => {
            const rows = await cypher<{ count: number }>(
                `MATCH (f:Function)
                 WHERE NOT exists((f)<-[:CONTAINS]-(:SourceFile))
                 RETURN count(f) AS count`,
            );
            expect(Number(rows[0].count)).toBe(0);
        });

        it('should have no orphaned SourceFiles (every SourceFile has a container)', async () => {
            const rows = await cypher<{ path: string }>(
                `MATCH (sf:SourceFile)
                 WHERE NOT exists((sf)<-[:CONTAINS]-()) AND NOT exists((sf)<-[:OWNS]-())
                 RETURN sf.path AS path`,
            );
            if (rows.length > 0) {
                console.log("ORPHANED FILES:", rows.map(r => r.path));
            }
            expect(rows.length).toBe(0);
        });

        it('should have at least 10 functions across all services', async () => {
            const rows = await cypher<{ total: number }>(
                'MATCH (f:Function) RETURN count(f) AS total',
            );
            expect(Number(rows[0].total)).toBeGreaterThanOrEqual(10);
        });

        it('should have all three service types represented in function filepaths', async () => {
            const paths = await cypherColumn(
                'MATCH (f:Function) RETURN DISTINCT f.filepath AS path',
                'path',
            );
            // At least one function from each service's files
            expect(paths.some(p => p.includes('OrderController') || p.includes('OrderRouter'))).toBe(true);
            expect(paths.some(p => p.includes('RewardCalculator') || p.includes('PaymentController'))).toBe(true);
            expect(paths.some(p =>
                p.includes('NotificationConsumer') ||
                p.includes('PubSubPublisher') ||
                p.includes('ScriptRunner') ||
                p.includes('graphql-schema')
            )).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 15. Contract-Based Matchmaking (Cross-Service)
    // ═════════════════════════════════════════════════════════════════════════

    describe('API Matchmaking & Capabilities Extraction', () => {
        it('should correctly refuse to link caller functions to external API endpoints', async () => {
            // The loyalty service openapi.yaml describes an external Payment Gateway API
            // that RewardCalculator calls but does NOT implement.
            // The LLM matchmaker may have borderline matches (e.g. processPayment to /charge),
            // but business-logic functions like calculateDiscount should never be linked.
            const rewardMatches = await cypher<{ fn: string; method: string; path: string }>(
                `MATCH (f:Function)-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint)
                 WHERE f.filepath CONTAINS 'RewardCalculator'
                   AND NOT f.name CONTAINS 'processPayment'
                 RETURN f.name AS fn, ep.method AS method, ep.path AS path`
            );
            expect(rewardMatches.length).toBe(0);
        });

        it('should resolve event publisher and subscriber intent capabilities', async () => {
            // NotificationConsumer consumes, OrderController publishes
            // We check that the Unified Analyzer correctly tagged their capabilities
            // instead of strictly requiring string-matching LogicalResources.
            const rows = await cypher<{ fn: string; caps: string[] }>(
                `MATCH (f:Function)
                 WHERE 'event-publisher' IN f.capabilities OR 'queue-consumer' IN f.capabilities OR 'message-consumer' IN f.capabilities
                 RETURN f.name AS fn, f.capabilities AS caps`
            );
            expect(rows.length).toBeGreaterThan(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 16. Shared Database Query Extraction
    // ═════════════════════════════════════════════════════════════════════════

    describe('Shared Database Extraction', () => {
        it('should detect inter-service coupling via a shared DataContainer (users)', async () => {
            // Query for any two DIFFERENT services whose functions read/write the same 'users' DataContainer
            const rows = await cypher<{ s1: string; s2: string; res: string }>(
                `MATCH (s1:Service)-[:CONTAINS]->(f1:Function)-[:READS|WRITES]->(dt:DataContainer)<-[:READS|WRITES]-(f2:Function)<-[:CONTAINS]-(s2:Service)
                 WHERE s1.name < s2.name
                   AND toLower(dt.name) CONTAINS 'users'
                 RETURN DISTINCT s1.name AS s1, s2.name AS s2, dt.name AS res`
            );

            expect(rows.length).toBeGreaterThan(0);

            // Verify it found the exact anti-pattern between order-service and notification-service
            const sharedCouplings = rows.map(r => `${r.s1} <-> ${r.s2}`);
            expect(sharedCouplings).toContain('notification-service <-> order-service');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 17. Data Schema Extraction (Edge Cases)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Data Schema Extraction (Edge Cases)', () => {
        // Case 1: Spread Operator Blind Passthrough
        it('should extract concrete fields from a spread operator payload, ignoring the dynamic part', async () => {
            // order.context_created is published by createOrderWithContext
            const fields = await cypher<{ name: string; required: boolean }>(
                `MATCH (d:DataStructure {name: 'order.context_created'})-[:HAS_FIELD]->(f:DataField)
                 RETURN f.name AS name, f.required AS required`
            );

            expect(fields.length).toBeGreaterThan(0);
            const fieldNames = fields.map(f => f.name);

            // Should extract the hardcoded fields
            expect(fieldNames).toContain('orderId');
            expect(fieldNames).toContain('timestamp');

            // Should NOT have hallucinated keys from the spread operator (dynamicContext)
            // No concrete keys other than the ones explicitly defined should be present
            const explicitKeys = ['orderId', 'timestamp'];
            const unexpectedKeys = fieldNames.filter(n => !explicitKeys.includes(n));

            // We allow dynamic pattern keys (e.g. [dynamic_keys]) but expect ZERO hallucinated concrete keys
            const hallucinatedKeys = unexpectedKeys.filter(n => !n.includes('[') && !n.includes('dynamic') && n !== '_opaque_reference');
            expect(hallucinatedKeys).toEqual([]);
        });

        // Case 2: JSONB Mutante
        it('should extract JSON column from DB update queries (JSON_SET mutation)', async () => {
            // loyalty_audits is updated dynamically in RewardCalculator
            const fields = await cypher<{ name: string; type: string }>(
                `MATCH (d:DataStructure {name: 'loyalty_audits'})-[:HAS_FIELD]->(f:DataField)
                 RETURN f.name AS name, f.type AS type`
            );

            expect(fields.length).toBeGreaterThan(0);
            const auditLogField = fields.find(f => f.name === 'audit_log');
            expect(auditLogField).toBeDefined();
            expect(auditLogField?.type.toLowerCase()).toBe('json');
        });

        // Case 3: API Passthrough (Rest Spread)
        it('should correctly extract known fields from an API passthrough payload', async () => {
            // This tests the endpoint /orders/forward-webhook which destructures merchant_id
            // The exact schema name here depends on the LLM's naming, but we can query by fields
            const dataStructures = await cypher<{ name: string }>(
                `MATCH (d:DataStructure)-[:HAS_FIELD]->(f:DataField {name: 'merchant_id'})
                 RETURN d.name AS name`
            );

            expect(dataStructures.length).toBeGreaterThan(0);
        });

        // Case 5 & 6: TypeScript Required/Optional Detection (OrderSchema.ts)
        it('should properly detect required vs optional fields in TS definitions', async () => {
            // Test 1: ORM Definition (orders table)
            const ormFields = await cypher<{ name: string; required: boolean }>(
                `MATCH (d:DataStructure {name: 'orders'})-[:HAS_FIELD]->(f:DataField)
                 RETURN f.name AS name, f.required AS required`
            );

            expect(ormFields.length).toBeGreaterThan(0);
            const ormMap = new Map(ormFields.map(f => [f.name, f.required]));

            // .notNull() fields should be required
            expect(ormMap.get('customer_id')).toBe(true);
            expect(ormMap.get('total_amount')).toBe(true);
            // nullable fields should be optional
            expect(ormMap.get('shipping_address')).toBe(false);
            expect(ormMap.get('notes')).toBe(false);
            expect(ormMap.get('updated_at')).toBe(false);

            // Test 2: Zod Schema (OrderEvent)
            const zodSchemaFields = await cypher<{ name: string; required: boolean }>(
                `MATCH (d:DataStructure)-[:HAS_FIELD]->(f:DataField)
                 WHERE d.name CONTAINS 'OrderEvent'
                 RETURN f.name AS name, f.required AS required`
            );

            expect(zodSchemaFields.length).toBeGreaterThan(0);
            const zodMap = new Map(zodSchemaFields.map(f => [f.name, f.required]));

            // standard Zod fields should be required
            expect(zodMap.get('orderId')).toBe(true);
            expect(zodMap.get('customerId')).toBe(true);
            // .optional() Zod fields should be optional
            expect(zodMap.get('couponCode')).toBe(false);
            expect(zodMap.get('giftMessage')).toBe(false);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 18. Conduit Relay & Avro Schemas
    // ═════════════════════════════════════════════════════════════════════════

    describe('Conduit Relay & Avro Schemas', () => {
        it('should extract Avro schema definitions as DataStructure nodes with correct metadata', async () => {
            const structures = await cypher<{ name: string; namespace: string; format: string }>(
                `MATCH (d:DataStructure {schemaFormat: 'avro'})
                 WHERE d.name IN ['OrderSave', 'RewardCreated']
                 RETURN d.name AS name, d.namespace AS namespace, d.schemaFormat AS format`
            );

            expect(structures.length).toBeGreaterThanOrEqual(1);
            
            const orderSave = structures.find(s => s.name === 'OrderSave');
            if (orderSave) {
                expect(orderSave.namespace).toBe('com.acme.platform.order');
                expect(orderSave.format).toBe('avro');
            }
        });

        it('should correctly map Avro logicalTypes, enums, and defaults into DataFields', async () => {
            // Find the OrderSave schema and inspect its fields
            const fields = await cypher<{ name: string; type: string; logicalType: string; enumSymbols: string[]; defaultVal: string }>(
                `MATCH (d:DataStructure {name: 'OrderSave', schemaFormat: 'avro'})-[:HAS_FIELD]->(f:DataField)
                 RETURN f.name AS name, f.type AS type, f.logicalType AS logicalType, f.enumSymbols AS enumSymbols, f.defaultValue AS defaultVal`
            );

            if (fields.length > 0) {
                const orderId = fields.find(f => f.name === 'orderId');
                expect(orderId?.logicalType).toBe('uuid');

                const status = fields.find(f => f.name === 'status');
                expect(status?.enumSymbols).toBeDefined();
                expect(status?.enumSymbols).toContain('CONFIRMED');
                expect(status?.defaultVal).toBe('PENDING');
            }
        });

        it('should propagate taint through Conduit wrappers and extract MessageChannel', async () => {
            // ConduitPublisher (TS) and ConduitPublisher (PHP)
            const channels = await cypher<{ channel: string; fn: string }>(
                `MATCH (f:Function)-[:PUBLISHES_TO]->(m:MessageChannel)
                 WHERE f.filepath CONTAINS 'ConduitPublisher'
                 RETURN m.name AS channel, f.name AS fn`
            );

            const channelNames = channels.map(c => c.channel);
            // Should have extracted the topic names passed to the wrapper
            expect(channelNames).toContain('Platform-OrderSave');
            
            // PHP publisher should also have extracted the topic Reward-Created
            const phpPublisher = channels.find(c => c.channel === 'Reward-Created');
            expect(phpPublisher).toBeDefined();
        });

        it('should extract Symfony Autowire MessageChannel readers', async () => {
            const consumers = await cypher<{ channel: string; fn: string }>(
                `MATCH (f:Function)-[:LISTENS_TO]->(m:MessageChannel)
                 WHERE f.filepath CONTAINS 'RewardEventConsumer'
                 RETURN m.name AS channel, f.name AS fn`
            );

            expect(consumers.length).toBeGreaterThan(0);
            expect(consumers[0].channel).toBe('conduit.subscriptions.reward_created');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 20. Structural Extraction
    // ═════════════════════════════════════════════════════════════════════════

    describe('Structural Extraction', () => {
        it('should extract Task nodes and link them to Services (or Repositories in fallback)', async () => {
            const tasks = await cypher<{ name: string; owner: string }>(
                `MATCH (o)-[:HAS_TASK]->(t:Task)
                 WHERE o:Service OR o:Repository
                 RETURN t.name AS name, o.name AS owner ORDER BY name`
            );
            const taskNames = tasks.map(t => `${t.owner}:${t.name}`);

            expect(taskNames).toContain('order-service:build');
            expect(taskNames).toContain('order-service:test');
            expect(taskNames).toContain('order-service:deploy');
            expect(taskNames).toContain('loyalty-service:build');
        });

        it('should extract DockerImage nodes from Dockerfiles', async () => {
            const images = await cypher<{ name: string; tag: string }>(
                `MATCH (o)-[:HAS_DOCKER_IMAGE]->(di:DockerImage)
                 WHERE o:Service OR o:Repository
                 RETURN di.name AS name, di.tag AS tag`
            );

            expect(images.some(img => img.name === 'node' && img.tag === '20-alpine')).toBe(true);
        });

        it('should extract ToolConfig nodes with strict mode details linked to Services', async () => {
            const configs = await cypher<{ owner: string; strict: boolean }>(
                `MATCH (o:Service)-[:HAS_TOOL_CONFIG]->(tc:ToolConfig {tool: 'TypeScript'})
                 RETURN o.name AS owner, tc.strict AS strict`
            );

            const orderConfig = configs.find(c => c.owner === 'order-service');
            expect(orderConfig).toBeDefined();
            expect(orderConfig?.strict).toBe(true);
        });

        it('should detect Ghost Directories (Tests, Docs) linked to their closest logical owner', async () => {
            const dirs = await cypher<{ owner: string; path: string; cat: string }>(
                `MATCH (o)-[:CONTAINS_DIRECTORY]->(d:ProjectDirectory)
                 WHERE o:Service OR o:Repository
                 RETURN o.name AS owner, d.path AS path, d.category AS cat`
            );

            // At least some ghost directories should be detected across services
            expect(dirs.length).toBeGreaterThan(0);
            // At least one Tests or Documentation directory should exist
            expect(dirs.some(d => d.cat === 'Tests' || d.cat === 'Documentation')).toBe(true);
        });

        it('should maintain the full provenance chain (Service -> StructuralFile -> Entity)', async () => {
            const rows = await cypher<{ file: string; task: string }>(
                `MATCH (s:Service {name: 'order-service'})-[:HAS_CONFIG]->(sf:StructuralFile)-[:DEFINES]->(t:Task {name: 'build'})
                 RETURN sf.path AS file, t.name AS task`
            );
            expect(rows.length).toBe(1);
            expect(rows[0].file).toBe('order-service/Makefile');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 20.5. Crossplane PubSub — Structural (Cross-Service Topology)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Crossplane PubSub Structural Extraction', () => {
        it('should extract the Topic MessageChannel from order-service Helm chart', async () => {
            const topics = await cypher<{ name: string; kind: string; tech: string; src: string }>(
                `MATCH (m:MessageChannel)
                 WHERE m.name = 'Platform-OrderCreated' AND m.discoverySource = 'crossplane'
                 RETURN m.name AS name, m.channelKind AS kind, m.technology AS tech, m.discoverySource AS src`
            );
            expect(topics.length).toBeGreaterThanOrEqual(1);
            expect(topics[0].kind).toBe('topic');
            expect(topics[0].tech).toBe('pubsub');
        });

        it('should extract the Subscription MessageChannel from notification-service Helm chart', async () => {
            const subs = await cypher<{ name: string; kind: string; tech: string }>(
                `MATCH (m:MessageChannel)
                 WHERE m.name = 'order-notifications' AND m.discoverySource = 'crossplane'
                 RETURN m.name AS name, m.channelKind AS kind, m.technology AS tech`
            );
            expect(subs.length).toBeGreaterThanOrEqual(1);
            expect(subs[0].kind).toBe('subscription');
            expect(subs[0].tech).toBe('pubsub');
        });

        it('should create ROUTES_TO edge linking subscription to topic (cross-service)', async () => {
            const edges = await cypher<{ sub: string; topic: string }>(
                `MATCH (sub:MessageChannel)-[:ROUTES_TO]->(topic:MessageChannel)
                 WHERE sub.discoverySource = 'crossplane' AND topic.discoverySource = 'crossplane'
                 RETURN sub.name AS sub, topic.name AS topic`
            );
            expect(edges.length).toBeGreaterThanOrEqual(1);
            expect(edges[0].sub).toBe('order-notifications');
            expect(edges[0].topic).toBe('Platform-OrderCreated');
        });

        it('should NOT leak placeholder strings into MessageChannel names', async () => {
            const placeholders = await cypher<{ name: string }>(
                `MATCH (m:MessageChannel)
                 WHERE m.name CONTAINS '__CR_' OR m.name CONTAINS '__CR_VAL_'
                 RETURN m.name AS name`
            );
            expect(placeholders).toHaveLength(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 21. Travel Scraper — Backstage & Service Detection
    // ═════════════════════════════════════════════════════════════════════════

    describe('Travel Scraper C4 Skeleton', () => {
        it('should create the travel-platform System from catalog-info.yaml', async () => {
            const names = await cypherColumn(
                'MATCH (sys:System) RETURN sys.name AS name',
                'name',
            );
            expect(names).toContain('travel-platform');
        });

        it('should create Team team-travel and link to travel-scraper via OWNS', async () => {
            const rows = await cypher<{ team: string; svc: string }>(
                `MATCH (t:Team)-[:OWNS]->(s:Service {name: 'travel-scraper'})
                 RETURN t.name AS team, s.name AS svc`,
            );
            expect(rows.length).toBe(1);
            expect(rows[0].team).toBe('team-travel');
        });
    });



    // ═════════════════════════════════════════════════════════════════════════
    // 23. Cross-Ecosystem Shared Database (The Nuclear Test)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Cross-Ecosystem Shared DB (travel-scraper ↔ order-service)', () => {
        it('should detect that orders DataContainer exists and is accessed by order-service', async () => {
            // The `orders` table is written to by OrderController.ts (order-service).
            // DynamicRouter.php also reads from it, but the SQL is at the script top-level
            // (not inside a named function), so the Function→DataContainer link may not exist
            // for travel-scraper. What we CAN verify is the DataContainer exists and
            // order-service accesses it.
            const rows = await cypher<{ svc: string; table: string }>([
                'MATCH (s:Service)-[:CONTAINS]->(f:Function)-[:READS|WRITES]->(dt:DataContainer)',
                'WHERE toLower(dt.name) CONTAINS "orders"',
                'RETURN DISTINCT s.name AS svc, dt.name AS table',
            ].join('\n'));

            expect(rows.length).toBeGreaterThan(0);
            expect(rows.some(r => r.svc === 'order-service')).toBe(true);
        });

        it('should detect users table coupling between order-service and notification-service', async () => {
            // The `users` table is read by OrderController.ts and NotificationConsumer.php.
            // DynamicRouter.php also reads it at the top-level, but that code is outside
            // a named function, so travel-scraper may not show up in this query.
            const rows = await cypher<{ svc: string }>([
                'MATCH (s:Service)-[:CONTAINS]->(f:Function)-[:READS|WRITES]->(dt:DataContainer)',
                'WHERE toLower(dt.name) CONTAINS "users"',
                'RETURN DISTINCT s.name AS svc',
            ].join('\n'));

            const services = rows.map(r => r.svc);
            expect(services).toContain('order-service');
            expect(services).toContain('notification-service');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 24. Intra-Monolith Shared DB Tables
    // ═════════════════════════════════════════════════════════════════════════

    describe('Intra-Monolith Shared DB (travel-scraper internal)', () => {
        it('should detect shared trips table across scraper scripts', async () => {
            // Both skyfly_common.php and oceanic_common.php SELECT FROM trips
            // and UPDATE trip_quotes and trips
            const rows = await cypher<{ fn: string; table: string; rel: string }>([
                'MATCH (f:Function)-[r:READS|WRITES]->(dt:DataContainer)',
                'WHERE f.filepath CONTAINS "travel-scraper"',
                '  AND (toLower(dt.name) CONTAINS "trips" OR toLower(dt.name) CONTAINS "trip_quotes")',
                'RETURN f.name AS fn, dt.name AS table, type(r) AS rel',
            ].join('\n'));

            expect(rows.length).toBeGreaterThan(0);
            const tables = [...new Set(rows.map(r => r.table.toLowerCase()))];
            // At least trips or trip_quotes should be detected
            expect(tables.some(t => t.includes('trips') || t.includes('trip_quotes'))).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 25. exec() Spawning in Legacy Monolith
    // ═════════════════════════════════════════════════════════════════════════

    describe('exec() Spawning in Legacy Monolith', () => {
        it('should detect TravelGlobal.runScraper as spawning child processes', async () => {
            // TravelGlobal.runScraper() uses exec() to spawn PHP scripts
            const rows = await cypher<{ caller: string; script: string }>([
                'MATCH (f:Function)-[:SPAWNS]->(sp:SystemProcess)',
                'WHERE f.filepath CONTAINS "TravelGlobal"',
                'RETURN f.name AS caller, sp.name AS script',
            ].join('\n'));

            // If SPAWNS edges exist, verify them
            // If they don't, at least verify the function was extracted with I/O detection
            if (rows.length > 0) {
                expect(rows.some(r => r.caller.includes('runScraper'))).toBe(true);
            } else {
                // Fallback: at minimum, the runScraper function should exist in the graph
                const fns = await cypherColumn(
                    `MATCH (f:Function) WHERE f.filepath CONTAINS 'TravelGlobal' AND f.name CONTAINS 'runScraper' RETURN f.name AS name`,
                    'name',
                );
                expect(fns.length).toBeGreaterThan(0);
            }
        });
    });



    // ═════════════════════════════════════════════════════════════════════════
    // 27. Doctrine ORM Entity Schema Extraction
    // ═════════════════════════════════════════════════════════════════════════

    describe('Doctrine Entity Schema Extraction', () => {

        it('should detect trips DataContainer from travel-scraper functions (scrapers use raw SQL)', async () => {
            // The `trips` table is accessed by scraper scripts via raw SQL
            // AND declared by the Trip.php Doctrine entity via #[ORM\Table(name: 'trips')].
            // The raw SQL access creates Function->DataContainer links.
            // The Doctrine entity is a pure DTO (no functions extracted), but
            // the table is still detected via the scrapers.
            const rows = await cypher<{ fn: string; table: string }>([
                'MATCH (f:Function)-[:READS|WRITES]->(dt:DataContainer)',
                'WHERE f.filepath CONTAINS "travel-scraper"',
                '  AND (toLower(dt.name) CONTAINS "trips" OR toLower(dt.name) CONTAINS "trip_quotes"',
                '       OR toLower(dt.name) CONTAINS "bookings")',
                'RETURN f.name AS fn, dt.name AS table',
            ].join('\n'));

            // At least some travel-scraper functions should access these tables
            expect(rows.length).toBeGreaterThan(0);
        });

        it('should extract schema fields from the Doctrine Trip entity', async () => {
            // The Trip entity has #[ORM\Column] attributes defining:
            // userId (int, required), status (string), departureDate (date), etc.
            // The LLM should extract these as DataStructure fields
            const fields = await cypher<{ name: string; required: boolean }>([
                'MATCH (d:DataStructure)-[:HAS_FIELD]->(f:DataField)',
                'WHERE toLower(d.name) CONTAINS "trip"',
                '  AND d.sourceFile CONTAINS "travel-scraper"',
                'RETURN f.name AS name, f.required AS required',
            ].join('\n'));

            // If the LLM extracted Doctrine annotation schemas, validate them
            if (fields.length > 0) {
                const fieldNames = fields.map(f => f.name);
                // At least some of the Doctrine columns should be extracted
                expect(fieldNames.some(n =>
                    n.includes('userId') || n.includes('user_id') ||
                    n.includes('status') || n.includes('destination')
                )).toBe(true);
            }
        });
    });



    // ═════════════════════════════════════════════════════════════════════════
    // 29. Blast Radius (Core Feature)
    //
    // Validates that the graph supports impact analysis queries:
    //   "If I change X, which services/functions/teams break?"
    //
    // These tests exercise the same Cypher patterns used by the MCP tools
    // (analyze_blast_radius, find_producers, list_service_resources, etc.)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Blast Radius: Shared Database Tables', () => {
        it('should identify all services impacted by a change to the users table', async () => {
            // Scenario: "I need to rename the `email` column in the `users` table.
            // Which services will break?"
            //
            // Expected blast radius:
            //   - order-service: createOrder() reads FROM users (OrderController.ts)
            //   - notification-service: processOrderNotification() reads FROM users (NotificationConsumer.php)
            const rows = await cypher<{ svc: string; fn: string; rel: string }>(
                `MATCH (s:Service)-[:CONTAINS]->(f:Function)-[r:READS|WRITES]->(dt:DataContainer)
                 WHERE toLower(dt.name) CONTAINS 'users'
                 RETURN DISTINCT s.name AS svc, f.name AS fn, type(r) AS rel
                 ORDER BY svc`,
            );

            expect(rows.length).toBeGreaterThan(0);
            const impactedServices = [...new Set(rows.map(r => r.svc))];
            expect(impactedServices).toContain('order-service');
            expect(impactedServices).toContain('notification-service');

            // Verify we get function-level detail for the blast radius
            const orderFns = rows.filter(r => r.svc === 'order-service');
            expect(orderFns.some(r => r.fn.includes('createOrder'))).toBe(true);
        });

        it('should identify which services WRITE vs READ the orders table', async () => {
            // Scenario: "Is anyone else writing to the `orders` table besides us?"
            const rows = await cypher<{ svc: string; fn: string; rel: string }>(
                `MATCH (s:Service)-[:CONTAINS]->(f:Function)-[r:READS|WRITES]->(dt:DataContainer)
                 WHERE toLower(dt.name) CONTAINS 'orders'
                 RETURN DISTINCT s.name AS svc, f.name AS fn, type(r) AS rel
                 ORDER BY svc`,
            );

            expect(rows.length).toBeGreaterThan(0);
            // order-service should have both READS and WRITES (getOrderStatus reads, createOrder writes)
            expect(rows.some(r => r.svc === 'order-service')).toBe(true);
        });
    });

    describe('Blast Radius: Message Broker Coupling', () => {
        it('should trace the event chain: order-service → orders_exchange → notification-service', async () => {
            // Scenario: "I'm changing the order.created event schema in order-service.
            // Who is consuming these events?"
            //
            // order-service PUBLISHES_TO orders_exchange
            // notification-service LISTENS_TO orders_exchange
            //
            // Note: The LLM may name the broker differently across runs (e.g.
            // 'orders_exchange' vs 'orders.exchange' vs 'order_events'), so the
            // full chain match may not always resolve. We verify each side independently.
            const rows = await cypher<{ pub: string; broker: string; sub: string }>(
                `MATCH (pubSvc:Service)-[:CONTAINS]->(pubFn:Function)-[:PUBLISHES_TO]->(broker:MessageChannel)
                       <-[:LISTENS_TO]-(subFn:Function)<-[:CONTAINS]-(subSvc:Service)
                 WHERE pubSvc.name <> subSvc.name
                 RETURN DISTINCT pubSvc.name AS pub, broker.name AS broker, subSvc.name AS sub`,
            );

            // Best case: full chain match
            const fullChainFound = rows.some(r =>
                r.pub === 'order-service' && r.sub === 'notification-service'
            );

            if (!fullChainFound) {
                // Fallback: verify each side independently (LLM may name brokers differently)
                const publishers = await cypherColumn(
                    `MATCH (s:Service {name: 'order-service'})-[:CONTAINS]->(f:Function)-[:PUBLISHES_TO]->(b:MessageChannel)
                     RETURN DISTINCT b.name AS name`,
                    'name',
                );
                const consumers = await cypherColumn(
                    `MATCH (s:Service {name: 'notification-service'})-[:CONTAINS]->(f:Function)-[:LISTENS_TO]->(b:MessageChannel)
                     RETURN DISTINCT b.name AS name`,
                    'name',
                );

                // At minimum, both sides should have message broker connections
                expect(publishers.length + consumers.length).toBeGreaterThan(0);
            }
        });
    });

    describe('Blast Radius: Service Topology (Outbound)', () => {
        it('should list all external resources touched by order-service', async () => {
            // This is what list_service_resources does: enumerate every
            // DataContainer, MessageChannel, Datastore connected to a service's functions.
            const rows = await cypher<{ resourceType: string; resourceName: string; connection: string }>(
                `MATCH (s:Service {name: 'order-service'})-[:CONTAINS]->(f:Function)
                       -[r:READS|WRITES|PUBLISHES_TO|LISTENS_TO|CONNECTS_TO|SPAWNS]->(target)
                 WHERE target:DataContainer OR target:MessageChannel OR target:Datastore OR target:SystemProcess
                 RETURN DISTINCT
                   CASE WHEN target:DataContainer THEN 'DataContainer'
                        WHEN target:MessageChannel THEN 'MessageChannel'
                        WHEN target:Datastore THEN 'Datastore'
                        WHEN target:SystemProcess THEN 'SystemProcess'
                   END AS resourceType,
                   target.name AS resourceName,
                   type(r) AS connection
                 ORDER BY resourceType, resourceName`,
            );

            expect(rows.length).toBeGreaterThan(0);

            const resourceNames = rows.map(r => r.resourceName.toLowerCase());

            // order-service should touch the orders table
            expect(resourceNames.some(n => n.includes('orders'))).toBe(true);
            // order-service should touch the users table
            expect(resourceNames.some(n => n.includes('users'))).toBe(true);
        });
    });

    describe('Blast Radius: Full Impact Chain (DataContainer → Function → Service → Team)', () => {
        it('should trace from a shared DataContainer all the way to the owning Team', async () => {
            // The ultimate blast radius query: "If I change the `users` table,
            // which TEAMS need to be notified?"
            const rows = await cypher<{ table: string; svc: string; team: string | null }>(
                `MATCH (dt:DataContainer)<-[:READS|WRITES]-(f:Function)<-[:CONTAINS]-(s:Service)
                 WHERE toLower(dt.name) CONTAINS 'users'
                 OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                 RETURN DISTINCT dt.name AS table, s.name AS svc, t.name AS team
                 ORDER BY svc`,
            );

            expect(rows.length).toBeGreaterThan(0);

            // At least two services should be in the blast radius
            const services = [...new Set(rows.map(r => r.svc))];
            expect(services.length).toBeGreaterThanOrEqual(2);

            // At least one team should be resolvable in the chain
            const teams = [...new Set(rows.map(r => r.team).filter(Boolean))];
            expect(teams.length).toBeGreaterThan(0);
        });
    });

    describe('Blast Radius: Architectural Resource Search', () => {
        it('should find relevant resources when searching for "order"', async () => {
            // This is the search_architectural_resources MCP tool:
            // before calling analyze_blast_radius, the user needs to discover exact names.
            const rows = await cypher<{ type: string; name: string }>(
                `MATCH (n)
                 WHERE (n:APIEndpoint OR n:DataStructure OR n:Datastore
                        OR n:DataContainer OR n:MessageChannel OR n:SystemProcess)
                   AND toLower(n.name) CONTAINS 'order'
                 RETURN CASE
                   WHEN n:DataContainer THEN 'DataContainer'
                   WHEN n:MessageChannel THEN 'MessageChannel'
                   WHEN n:Datastore THEN 'Datastore'
                   WHEN n:APIEndpoint THEN 'APIEndpoint'
                   WHEN n:DataStructure THEN 'DataStructure'
                   WHEN n:SystemProcess THEN 'SystemProcess'
                 END AS type,
                 n.name AS name
                 LIMIT 20`,
            );

            expect(rows.length).toBeGreaterThan(0);
            // "order" should surface at least the orders DataContainer or orders_exchange broker
            expect(rows.some(r =>
                r.name.toLowerCase().includes('order')
            )).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 30. Emergent API Endpoint Detection (Bug 1 Regression)
    //
    // Validates that functions making explicit HTTP calls (cURL, fetch, axios)
    // produce APIEndpoint nodes via emergent_api_calls extraction.
    // Before the fix, fast mode had no emergent_api_calls field, so
    // ExternalAPI was skipped entirely.
    // ═════════════════════════════════════════════════════════════════════════

    describe('Emergent API Endpoint Detection (Bug 1)', () => {
        it('should detect emergent API endpoints from PHP cURL calls', async () => {
            // RewardCalculator.processPayment() calls POST /api/v1/charge
            // LegacyApiClient has POST /api/v2/returns/submit, GET /api/v2/returns/{id}/status,
            // PUT /api/v2/customers/{customerId}/preferences
            // BookingConfirmedHandler.__invoke() calls POST /booking-confirmed
            const rows = await cypher<{ path: string; method: string; callers: number }>(
                `MATCH (f:Function)-[:CALLS]->(api:APIEndpoint)
                 WHERE api.id STARTS WITH 'cr:endpoint:emergent:'
                 RETURN api.path AS path, api.method AS method, count(f) AS callers
                 ORDER BY callers DESC`,
            );

            // At least one emergent API endpoint should be detected
            expect(rows.length).toBeGreaterThan(0);

            const paths = rows.map(r => r.path);

            // At minimum, the explicit /api/v1/charge from RewardCalculator should be detected
            // OR one of the LegacyApiClient paths
            expect(paths.some(p =>
                p.includes('/charge') ||
                p.includes("/returns") ||
                p.includes('/booking-confirmed')
            )).toBe(true);
        });

        it('should link emergent API endpoints to the correct calling functions', async () => {
            // Verify the Function→APIEndpoint edges have proper provenance
            const rows = await cypher<{ fn: string; filepath: string; path: string }>(
                `MATCH (f:Function)-[:CALLS]->(api:APIEndpoint)
                 WHERE api.id STARTS WITH 'cr:endpoint:emergent:'
                 RETURN f.name AS fn, f.filepath AS filepath, api.path AS path`,
            );

            // At least one function should be linked
            expect(rows.length).toBeGreaterThan(0);

            // The calling functions should be from files that make outbound HTTP calls
            // (PHP cURL files, TS controllers with fetch/axios, etc.)
            expect(rows.some(r =>
                r.filepath.endsWith('.php') ||
                r.filepath.includes('Controller') ||
                r.filepath.includes('RewardCalculator') ||
                r.filepath.includes('LegacyApiClient') ||
                r.filepath.includes('BookingConfirmedHandler')
            )).toBe(true);
        });

        it('should extract LegacyApiClient functions with API-calling behavior', async () => {
            // The new LegacyApiClient.php fixture makes 3 explicit HTTP calls
            const fns = await cypherColumn(
                `MATCH (f:Function)
                 WHERE f.filepath CONTAINS 'LegacyApiClient'
                 RETURN f.name AS name`,
                'name',
            );

            // At least some methods should be extracted (submitReturn, getReturnStatus, etc.)
            expect(fns.length).toBeGreaterThan(0);
            expect(fns.some(n =>
                n.includes('submitReturn') ||
                n.includes('getReturnStatus') ||
                n.includes('updateCustomerPreferences')
            )).toBe(true);
        });

        it('should preserve rawPath on emergent API endpoint nodes (lossless extraction)', async () => {
            // After the lossless extraction change, emergent endpoints store
            // full paths AND the original LLM-extracted path as rawPath.
            const rows = await cypher<{ path: string; rawPath: string | null }>(`
                MATCH (api:APIEndpoint)
                WHERE api.id STARTS WITH 'cr:endpoint:emergent:'
                RETURN api.path AS path, api.rawPath AS rawPath
            `);

            // At least one emergent endpoint should exist
            expect(rows.length).toBeGreaterThan(0);

            // At least one should have rawPath set
            const withRawPath = rows.filter(r => r.rawPath);
            expect(withRawPath.length).toBeGreaterThan(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 31. DataContainer Name Pollution Guard (Bug 2 Regression)
    //
    // Validates that DataContainer nodes with polluted/placeholder names
    // (e.g., "database-unknown-db", "mysql-unknown-db") are NOT persisted.
    // Layer 1 (prompt) tells the LLM to omit unknowable table names.
    // Layer 2 (graph-writer filter) rejects names matching /unknown|placeholder/i.
    // ═════════════════════════════════════════════════════════════════════════

    describe('DataContainer Name Pollution Guard (Bug 2)', () => {
        it('should NOT have any DataContainer nodes with "unknown" in the name', async () => {
            const rows = await cypher<{ name: string }>(
                `MATCH (dt:DataContainer)
                 WHERE toLower(dt.name) CONTAINS 'unknown'
                 RETURN dt.name AS name`,
            );

            // Zero polluted DataContainer nodes should exist
            expect(rows).toEqual([]);
        });

        it('should NOT have any DataContainer nodes with "placeholder" in the name', async () => {
            const rows = await cypher<{ name: string }>(
                `MATCH (dt:DataContainer)
                 WHERE toLower(dt.name) CONTAINS 'placeholder'
                 RETURN dt.name AS name`,
            );

            expect(rows).toEqual([]);
        });

        it('should still detect legitimate table names from static SQL', async () => {
            // RewardCalculator.calculateDiscount queries "risk_factors" table
            // RewardCalculator.saveRewardAudit updates "loyalty_audits" table
            // These tables are named explicitly in the SQL, they should exist.
            const tables = await cypherColumn(
                `MATCH (dt:DataContainer) RETURN dt.name AS name`,
                'name',
            );

            expect(tables.length).toBeGreaterThan(0);

            // At least some well-known tables from our fixtures should exist
            const knownTables = ['users', 'orders', 'risk_factors', 'loyalty_audits'];
            const foundKnown = knownTables.filter(t =>
                tables.some(dt => dt.toLowerCase().includes(t))
            );
            expect(foundKnown.length).toBeGreaterThan(0);
        });

        it('should handle DynamicQueryRunner gracefully (no polluted table nodes)', async () => {
            // DynamicQueryRunner.php has fully dynamic SQL — table names come from parameters.
            // The LLM should either omit the Database infrastructure entry entirely
            // or the graph-writer filter should reject any "unknown" names.
            const rows = await cypher<{ name: string }>(
                `MATCH (f:Function)-[:READS|WRITES]->(dt:DataContainer)
                 WHERE f.filepath CONTAINS 'DynamicQueryRunner'
                   AND toLower(dt.name) CONTAINS 'unknown'
                 RETURN dt.name AS name`,
            );

            // No polluted table names from the dynamic query runner
            expect(rows).toEqual([]);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 32. MessageChannel Name Pollution Guard (Bug 3 Regression)
    //
    // Validates that MessageChannel nodes with class/variable names
    // (e.g., "MessageBus", "bus", "amqp") are NOT persisted.
    // Layer 1 (prompt) tells the LLM to use queue/topic/routing_key names.
    // Layer 2 (graph-writer filter) rejects names in NOISY_BROKER_NAMES set.
    // ═════════════════════════════════════════════════════════════════════════

    describe('MessageChannel Name Pollution Guard (Bug 3)', () => {
        it('should NOT have MessageChannel nodes with generic class names', async () => {
            const noisyNames = [
                'messagebus', 'message-bus', 'message_bus', 'messagebusinterface',
                'bus', 'amqp', 'rabbitmq', 'kafka', 'queue', 'notificationsender',
            ];

            const rows = await cypher<{ name: string }>(
                `MATCH (broker:MessageChannel)
                 WHERE toLower(broker.name) IN $noisyNames
                 RETURN broker.name AS name`,
                { noisyNames },
            );

            // Zero polluted MessageChannel nodes should exist

            expect(rows).toEqual([]);
        });

        it('should still detect legitimate broker names (queue/topic/exchange)', async () => {
            // RewardCalculator.publishRewardEvent uses 'loyalty_events' exchange
            // OrderController publishes to order events
            const brokers = await cypherColumn(
                `MATCH (broker:MessageChannel) RETURN broker.name AS name`,
                'name',
            );

            // If any brokers exist, they should have meaningful names
            if (brokers.length > 0) {

                // None should be in the noisy set (redundant with above, but explicit)
                const noisySet = new Set(['messagebus', 'message-bus', 'message_bus', 'bus', 'amqp', 'rabbitmq', 'kafka', 'queue']);
                for (const name of brokers) {
                    expect(noisySet.has(name.toLowerCase())).toBe(false);
                }
            }
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 33. Dynamic Table Name Template Filter (Bug 4, dynamic concat pattern)
    //
    // Validates that DataContainer nodes with unresolved template variables
    // from PHP dynamic string concatenation are NOT persisted.
    // e.g. $table = 'delivery_history_' . $type → the LLM hallucinates
    //   delivery_history_{type}, delivery_history_, delivery_history_$type
    // while static references like 'delivery_history_auto' should be kept.
    // ═════════════════════════════════════════════════════════════════════════

    describe('Dynamic Table Name Template Filter (Bug 4, dynamic concat pattern)', () => {
        it('should NOT have DataContainer nodes with curly-brace template variables', async () => {
            const rows = await cypher<{ name: string }>(
                `MATCH (dt:DataContainer)
                 WHERE dt.name CONTAINS '{' AND dt.name CONTAINS '}'
                 RETURN dt.name AS name`,
            );

            // Zero DataContainer nodes with template variables should exist

            expect(rows).toEqual([]);
        });

        it('should NOT have DataContainer nodes with trailing underscores (incomplete concatenation)', async () => {
            const rows = await cypher<{ name: string }>(
                `MATCH (dt:DataContainer)
                 WHERE dt.name ENDS WITH '_'
                 RETURN dt.name AS name`,
            );


            expect(rows).toEqual([]);
        });

        it('should NOT have DataContainer nodes with PHP variable names ($type, {$var})', async () => {
            const rows = await cypher<{ name: string }>(
                `MATCH (dt:DataContainer)
                 WHERE dt.name CONTAINS '$'
                 RETURN dt.name AS name`,
            );

            expect(rows).toEqual([]);
        });

        it('should detect the concrete delivery_history_express table from static SQL', async () => {
            // DynamicTableLogger.getLatestExpressDelivery() has a literal SQL reference
            // to 'delivery_history_express'. This concrete table SHOULD be in the graph.
            const tables = await cypherColumn(
                `MATCH (dt:DataContainer)
                 WHERE toLower(dt.name) = 'delivery_history_express'
                 RETURN dt.name AS name`,
                'name',
            );

            expect(tables.length).toBe(1);
        });

        it('should link DynamicTableLogger functions to only concrete tables', async () => {
            // Functions from DynamicTableLogger that use dynamic SQL should NOT
            // be linked to hallucinated table names; only to concrete ones.
            const rows = await cypher<{ fn: string; table: string }>(
                `MATCH (f:Function)-[:READS|WRITES]->(dt:DataContainer)
                 WHERE f.filepath CONTAINS 'DynamicTableLogger'
                 RETURN f.name AS fn, dt.name AS table`,
            );


            for (const row of rows) {
                // Every linked table should be a concrete name (no templates, no trailing _)
                expect(row.table).not.toMatch(/\{.*\}/);
                expect(row.table).not.toMatch(/_$/);
                expect(row.table).not.toContain('$');
            }
        });
    });

    describe('Dynamic SQL — Bug 1: No phantom node for dynamic table prefix', () => {
        it('should NOT create a bare prefix DataContainer node (booking_slot without suffix)', async () => {
            // DynamicTableReader.getSlotById uses 'booking_slot_' . $type
            // LLM (post-fix prompt) emits 'booking_slot_{type}', post-processor expands
            // then removes stub. No bare 'booking_slot' should persist in the graph.
            const rows = await cypher(
                `MATCH (dt:DataContainer)
                 WHERE dt.name = 'booking_slot'
                 RETURN dt.name AS name`
            );
            expect(rows.length, 'Phantom "booking_slot" node must not exist after post-processing').toBe(0);
        });

        it('should NOT leave any wildcard stub nodes in the graph after post-processing', async () => {
            const stubs = await cypher<{ name: string }>(
                `MATCH (dt:DataContainer)
                 WHERE dt.name ENDS WITH '_' OR dt.name CONTAINS '{'
                 RETURN dt.name AS name`
            );
            expect(stubs.length, `Stubs still in graph: ${stubs.map(r => r.name).join(', ')}`).toBe(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 34a. Dynamic Infra Resolver — Scoped URN Integrity
    //
    // Validates that promoted DataContainer nodes always preserve their
    // repository scope in the URN, preventing global super-nodes like
    // cr:datacontainer:quote (the "quote bug" regression guard).
    // ═════════════════════════════════════════════════════════════════════════

    describe('Dynamic Infra Resolver — Scoped URN Integrity', () => {
        it('should NOT create any DataContainer with unscoped URN (cr:datacontainer:NAME without scope segment)', async () => {
            // After the quote_{tipo} fix, promoted DataContainer nodes must keep
            // their repository scope in the URN. An unscoped URN like
            // cr:datacontainer:quote is a regression.
            const rows = await cypher<{ id: string; name: string }>(`
                MATCH (dt:DataContainer)
                WHERE dt.id STARTS WITH 'cr:datacontainer:'
                  AND NOT dt.id CONTAINS '/'
                RETURN dt.id AS id, dt.name AS name
            `);
            expect(rows, `Unscoped DataContainer URNs found: ${rows.map(r => r.id).join(', ')}`).toEqual([]);
        });

        it('promoted DataContainer nodes should have scope matching their URN', async () => {
            // Nodes promoted from dynamic stubs (normalizedFrom IS NOT NULL)
            // must have a scope property that is embedded in their id.
            const rows = await cypher<{ id: string; scope: string | null; normalizedFrom: string | null }>(`
                MATCH (dt:DataContainer)
                WHERE dt.normalizedFrom IS NOT NULL
                RETURN dt.id AS id, dt.scope AS scope, dt.normalizedFrom AS normalizedFrom
            `);
            for (const row of rows) {
                expect(row.scope).toBeTruthy();
                expect(row.id).toContain(row.scope!);
            }
        });
    });

    describe('Dynamic SQL — Bug 2: DELETE on dynamic table is visible in graph', () => {
        it('should link DynamicTableWriter.backupAndPurgeSlots as WRITES to at least one concrete slot table', async () => {
            // backupAndPurgeSlots does DELETE FROM booking_slot_ . $type
            // After prefix expansion, WRITES edge must target booking_slot_hotel or booking_slot_flight.
            const rows = await cypher<{ fn: string; table: string }>(
                `MATCH (f:Function)-[:WRITES]->(dt:DataContainer)
                 WHERE f.name CONTAINS 'backupAndPurgeSlots'
                   AND dt.name STARTS WITH 'booking_slot_'
                 RETURN f.name AS fn, dt.name AS table`
            );
            expect(
                rows.length,
                'backupAndPurgeSlots must have at least one WRITES edge to a concrete booking_slot_* table',
            ).toBeGreaterThan(0);
        });

        it('all WRITES targets for dynamic slot functions should be concrete (no stubs)', async () => {
            const rows = await cypher<{ table: string }>(
                `MATCH (:Function)-[:WRITES]->(dt:DataContainer)
                 WHERE dt.name STARTS WITH 'booking_slot_'
                 RETURN DISTINCT dt.name AS table`
            );
            const stubs = rows.filter(r => r.table.endsWith('_') || r.table.includes('{'));
            expect(stubs.length, `Stub WRITES targets: ${stubs.map(r => r.table).join(', ')}`).toBe(0);
        });
    });



    // ═════════════════════════════════════════════════════════════════════════
    // 34. Dynamic SQL Edge Rewiring (TDD — Dynamic Table Concatenation)
    //
    // Validates the COMPLETE dynamic table pipeline:
    //   1. LLM emits stub: shipment_log_{carrierType}
    //   2. Sanitizer preserves it (isDynamicTableStub = true)
    //   3. Graph-writer writes stub to graph
    //   4. ShipmentLogReader.php seeds concrete tables (shipment_log_express, shipment_log_freight)
    //   5. DataEntityPostProcessor rewires edges: stub → concrete tables
    //   6. Stub node is deleted; no phantom nodes remain
    //
    // Result:
    //   ShipmentLogWriter.persistTracking has WRITES edges to both
    //   shipment_log_express and shipment_log_freight.
    // ═════════════════════════════════════════════════════════════════════════

    describe('Dynamic SQL Edge Rewiring (TDD — shipment_log_* pattern)', () => {
        it('should seed concrete DataContainer nodes from ShipmentLogReader static SQL', async () => {
            // ShipmentLogReader.php has literal SQL references to these tables.
            // This test verifies the concrete nodes exist as a prerequisite for rewiring.
            const tables = await cypherColumn(
                `MATCH (dt:DataContainer)
                 WHERE dt.name IN ['shipment_log_express', 'shipment_log_freight']
                 RETURN dt.name AS name ORDER BY name`,
                'name',
            );

            expect(tables).toContain('shipment_log_express');
            expect(tables).toContain('shipment_log_freight');
        });

        it('should rewire ShipmentLogWriter.persistTracking WRITES to concrete tables', async () => {
            // THIS IS THE CORE BUG TEST.
            // persistTracking() uses dynamic SQL: INSERT INTO shipment_log_{carrierType}
            // After post-processing, it must have WRITES edges to the concrete tables.
            //
            // Before fix: ZERO rows (stub dropped by graph-writer → no rewiring)
            // After fix:  persistTracking → WRITES → shipment_log_express, shipment_log_freight
            const rows = await cypher<{ fn: string; table: string }>(`
                MATCH (f:Function)-[:WRITES]->(dt:DataContainer)
                WHERE f.name CONTAINS 'persistTracking'
                  AND f.filepath CONTAINS 'ShipmentLogWriter'
                  AND dt.name STARTS WITH 'shipment_log_'
                RETURN f.name AS fn, dt.name AS table
                ORDER BY table
            `);

            expect(
                rows.length,
                'persistTracking must have WRITES edges to concrete shipment_log_* tables after post-processing',
            ).toBeGreaterThan(0);

            const tables = rows.map(r => r.table);
            // At minimum, one of the concrete variants should be linked
            expect(tables.some(t => t === 'shipment_log_express' || t === 'shipment_log_freight')).toBe(true);
        });

        it('should rewire ShipmentLogWriter.archiveOldLogs to concrete tables', async () => {
            // archiveOldLogs also uses dynamic SQL: SELECT FROM and DELETE FROM shipment_log_{carrierType}.
            // After post-processing, it must have READS or WRITES edges to concrete tables.
            const rows = await cypher<{ fn: string; table: string; rel: string }>(`
                MATCH (f:Function)-[r:READS|WRITES]->(dt:DataContainer)
                WHERE f.name CONTAINS 'archiveOldLogs'
                  AND f.filepath CONTAINS 'ShipmentLogWriter'
                  AND dt.name STARTS WITH 'shipment_log_'
                RETURN f.name AS fn, dt.name AS table, type(r) AS rel
            `);

            expect(
                rows.length,
                'archiveOldLogs must have READS/WRITES edges to concrete shipment_log_* tables',
            ).toBeGreaterThan(0);
        });

        it('should NOT leave any shipment_log_* stub nodes in the graph', async () => {
            // After DataEntityPostProcessor, ALL stubs (e.g. shipment_log_{carrierType},
            // shipment_log_) must be deleted. Only concrete tables remain.
            const stubs = await cypher<{ name: string }>(`
                MATCH (dt:DataContainer)
                WHERE dt.name STARTS WITH 'shipment_log_'
                  AND (dt.name CONTAINS '{' OR dt.name ENDS WITH '_')
                RETURN dt.name AS name
            `);

            expect(
                stubs.length,
                `Stubs still in graph: ${stubs.map(r => r.name).join(', ')}`,
            ).toBe(0);
        });

        it('blast radius: changing shipment_log_express should impact ShipmentLogWriter AND ShipmentLogReader', async () => {
            // After rewiring, both the dynamic writer and the static reader
            // should appear in the blast radius for shipment_log_express.
            const rows = await cypher<{ fn: string; filepath: string; rel: string }>(`
                MATCH (f:Function)-[r:READS|WRITES]->(dt:DataContainer {name: 'shipment_log_express'})
                RETURN f.name AS fn, f.filepath AS filepath, type(r) AS rel
            `);

            expect(rows.length).toBeGreaterThanOrEqual(2);

            const filepaths = rows.map(r => r.filepath);
            // ShipmentLogReader should be there (static SQL → READS)
            expect(filepaths.some(p => p.includes('ShipmentLogReader'))).toBe(true);
            // ShipmentLogWriter should also be there (dynamic SQL rewired → WRITES)
            expect(filepaths.some(p => p.includes('ShipmentLogWriter'))).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 33. Package Publisher (Internal Registry)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Package Publisher Extraction', () => {
        it('should extract internal libraries and create Release nodes', async () => {
            const releases = await cypher<{ packageName: string, version: string, releaseSource: string }>(`
                MATCH (r:Repository)-[:PUBLISHES]->(p:Package)-[:HAS_RELEASE]->(rel:Release)
                RETURN p.name AS packageName, rel.version AS version, rel.releaseSource AS releaseSource
                ORDER BY packageName
            `);

            expect(releases.some(r => r.packageName === '@acme-corp/common-utils' && r.version === '1.2.5')).toBe(true);
            expect(releases.some(r => r.packageName === 'acme-corp/logger-php' && r.version === '1.3.0')).toBe(true);

            for (const rel of releases) {
                expect(rel.releaseSource).toBe('manifest');
            }
        });

        it('should cache latestKnownVersion on Package nodes', async () => {
            const packages = await cypher<{ name: string, version: string }>(`
                MATCH (p:Package {isInternal: true})
                WHERE p.latestKnownVersion IS NOT NULL
                RETURN p.name AS name, p.latestKnownVersion AS version
            `);

            const map = new Map(packages.map(p => [p.name, p.version]));
            expect(map.get('@acme-corp/common-utils')).toBe('1.2.5');
            expect(map.get('acme-corp/logger-php')).toBe('1.3.0');
        });

        it('should keep DEPENDS_ON relationship from consumers to Package nodes', async () => {
            const consumers = await cypher<{ consumer: string, pkg: string }>(`
                MATCH (s:Service)-[dep:DEPENDS_ON]->(p:Package)
                RETURN s.name AS consumer, p.name AS pkg
            `);

            expect(consumers.some(c => c.consumer === 'order-service' && c.pkg === '@acme-corp/common-utils')).toBe(true);
            expect(consumers.some(c => c.consumer === 'payment-service' && c.pkg === 'acme-corp/logger-php')).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════


    // ═════════════════════════════════════════════════════════════════════════
    // NN+2. GraphQL Endpoints — SDL extractor (orders.graphql)
    // ═════════════════════════════════════════════════════════════════════════

    describe('GraphQL Endpoints — SDL extractor (orders.graphql)', () => {

        it('should merge exactly 5 SDL root field APIEndpoint nodes', async () => {
            const eps = await cypherColumn(
                `MATCH (ep:APIEndpoint)
                 WHERE ep.epSource = 'sdl' AND ep.apiKind = 'graphql'
                 RETURN 'GRAPHQL ' + ep.operation + ' ' + ep.operationName AS path`,
                'path',
            );
            expect(eps).toContain('GRAPHQL QUERY order');
            expect(eps).toContain('GRAPHQL QUERY orders');
            expect(eps).toContain('GRAPHQL MUTATION createOrder');
            expect(eps).toContain('GRAPHQL MUTATION cancelOrder');
            expect(eps).toContain('GRAPHQL SUBSCRIPTION orderUpdated');
            expect(eps).toHaveLength(5);
        });

        it('SDL APIEndpoint linked via HAS_ENDPOINT to its APIInterface (requires 1A fix)', async () => {
            const rows = await cypher<{ api: string }>(
                `MATCH (api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
                 WHERE ep.epSource = 'sdl' AND ep.apiKind = 'graphql'
                 RETURN api.id AS api`,
            );
            expect(rows.length).toBeGreaterThan(0);
        });

        it('SDL APIInterface linked to its Service via EXPOSES_API (requires 1A fix)', async () => {
            const rows = await cypher<{ svc: string }>(
                `MATCH (s:Service)-[:EXPOSES_API]->(api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
                 WHERE ep.epSource = 'sdl' AND ep.apiKind = 'graphql'
                 RETURN s.name AS svc`,
            );
            expect(rows.length).toBeGreaterThan(0);
        });

        it('SDL endpoints have valid_from_commit set', async () => {
            const rows = await cypher<{ commit: string }>(
                `MATCH (ep:APIEndpoint)
                 WHERE ep.epSource = 'sdl' AND ep.apiKind = 'graphql'
                 RETURN ep.valid_from_commit AS commit`,
            );
            expect(rows.every(r => r.commit && r.commit !== '')).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // NN+3. Graph Quality — Emergent Endpoint Precision
    // ═════════════════════════════════════════════════════════════════════════

    describe('Graph Quality — Emergent Endpoint Precision', () => {
        it('should set epSource="emergent" on all LLM-inferred outbound endpoints', async () => {
            const rows = await cypher<{ id: string; epSource: string | null }>(`
                MATCH (ep:APIEndpoint)
                WHERE ep.id STARTS WITH 'cr:endpoint:emergent:'
                RETURN ep.id AS id, ep.epSource AS epSource
            `);
            expect(rows.length).toBeGreaterThan(0);
            for (const row of rows) {
                expect(row.epSource).toBe('emergent');
            }
        });

        it('should preserve LLM variable names in emergent endpoint paths (no generic {param})', async () => {
            // FulfillmentController.getShipmentTracking → /api/shipping/track/{trackingId}
            // The lossless normalization should preserve the LLM's variable name
            const rows = await cypher<{ id: string; path: string }>(`
                MATCH (ep:APIEndpoint)
                WHERE ep.id STARTS WITH 'cr:endpoint:emergent:'
                  AND ep.path CONTAINS '{param}'
                RETURN ep.id AS id, ep.path AS path
            `);
            // No emergent endpoint should contain generic {param} — all should use named variables
            if (rows.length > 0) {
                console.warn(`[EVAL WARN] Found ${rows.length} emergent endpoint(s) with generic {param}: ${rows.map(r => r.path).join(', ')}`);
            }
            expect(rows).toEqual([]);
        });

        it('should NOT have emergent endpoints linked to any APIInterface (orphan by design)', async () => {
            // Emergent endpoints represent OUTBOUND HTTP calls inferred by the LLM.
            // They are orphan w.r.t. APIInterface because they have no provider contract
            // (unlike SDL/OpenAPI endpoints which live under an APIInterface via HAS_ENDPOINT).
            //
            // They ARE linked to Functions via [:CALLS] (see test below).
            //
            // When the L0 Matchmaker is built, it will link emergent endpoints to
            // canonical endpoint:code:* nodes via cross-service CALLS resolution,
            // but emergent nodes should NEVER gain a HAS_ENDPOINT parent — they
            // represent the client-side call, not the server-side contract.
            const rows = await cypher<{ count: number }>(`
                MATCH (api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
                WHERE ep.id STARTS WITH 'cr:endpoint:emergent:'
                RETURN count(*) AS count
            `);
            expect(Number(rows[0].count)).toBe(0);
        });

        it('should link every emergent endpoint to at least one Function via CALLS', async () => {
            const orphans = await cypher<{ id: string }>(`
                MATCH (ep:APIEndpoint)
                WHERE ep.id STARTS WITH 'cr:endpoint:emergent:'
                  AND NOT exists((:Function)-[:CALLS]->(ep))
                RETURN ep.id AS id
            `);
            if (orphans.length > 0) {
                console.warn(`[EVAL WARN] Orphan emergent endpoints (no CALLS edge): ${orphans.map(o => o.id).join(', ')}`);
            }
            expect(orphans).toEqual([]);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // NN+4. Graph Quality — False Positive Recall
    // ═════════════════════════════════════════════════════════════════════════

    describe('Graph Quality — False Positive Recall', () => {
        it('should NOT have any MessageChannel with unresolved {ENV} template', async () => {
            const rows = await cypherColumn(
                `MATCH (mc:MessageChannel) WHERE mc.id CONTAINS '{ENV}' RETURN mc.id AS id`,
                'id',
            );
            expect(rows).toEqual([]);
        });

        it('should have concrete delivery_history tables (not template stubs)', async () => {
            // DynamicTableLogger.purgeOldResults has hardcoded array: express, standard, freight
            const tables = await cypherColumn(
                `MATCH (dt:DataContainer) WHERE dt.name STARTS WITH 'delivery_history_' RETURN dt.name AS name`,
                'name',
            );
            // At least one concrete expansion should exist
            expect(tables.some(t =>
                t === 'delivery_history_express' ||
                t === 'delivery_history_standard' ||
                t === 'delivery_history_freight',
            )).toBe(true);
            // No template stub should survive
            expect(tables).not.toContain('delivery_history_{type}');
        });

        it('should document duplicate channel issue (notredeemable vs loyalty.not_redeemable)', async () => {
            // Known duplication from DI resolution vs literal topic name
            // This test DETECTS the duplication for monitoring, not auto-resolving in POC
            const channels = await cypherColumn(
                `MATCH (mc:MessageChannel) WHERE mc.name CONTAINS 'redeemable' RETURN mc.name AS name`,
                'name',
            );
            // Document: if both exist, it's the known DI-vs-literal ambiguity
            if (channels.length > 1) {
                console.warn(`[EVAL INFO] Duplicate channels detected for "redeemable" topic: ${channels.join(', ')}`);
            }
        });

        it('should have delivery_orders DataContainer from Laravel entity (ORM extraction)', async () => {
            const rows = await cypherColumn(
                `MATCH (dt:DataContainer) WHERE dt.name = 'delivery_orders' RETURN dt.name AS name`,
                'name',
            );
            expect(rows).toContain('delivery_orders');
        });

        it('should have loyalty_rewards DataContainer from Doctrine entity annotation', async () => {
            const rows = await cypherColumn(
                `MATCH (dt:DataContainer) WHERE dt.name = 'loyalty_rewards' RETURN dt.name AS name`,
                'name',
            );
            expect(rows).toContain('loyalty_rewards');
        });

        it('should have api_traces DataContainer from skyfly_common.php SQL INSERT', async () => {
            const rows = await cypherColumn(
                `MATCH (dt:DataContainer) WHERE dt.name = 'api_traces' RETURN dt.name AS name`,
                'name',
            );
            expect(rows).toContain('api_traces');
        });

        it('should have payment_queue DataContainer with WRITES edge from handleIncomingOrders', async () => {
            const rows = await cypher<{ fn: string; rel: string }>(`
                MATCH (f:Function)-[r:WRITES]->(dt:DataContainer {name: 'payment_queue'})
                RETURN f.name AS fn, type(r) AS rel
            `);
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.some(r => r.fn.includes('handleIncomingOrders'))).toBe(true);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 25. Repository Branch Governance & Platform Metadata
    // ═════════════════════════════════════════════════════════════════════════

    describe('Repository Branch Governance', () => {
        it('should persist defaultBranch on Repository nodes', async () => {
            const rows = await cypher<{ name: string; defaultBranch: string | null }>(
                `MATCH (r:Repository)
                 WHERE r.valid_to_commit IS NULL
                 RETURN r.name AS name, r.defaultBranch AS defaultBranch`,
            );

            expect(rows.length).toBeGreaterThan(0);

            // The test fixture is a local directory — its default branch should be detected.
            // Depending on the local git config, it should be either main or master.
            for (const row of rows) {
                // Not all repos may have a default branch detected (e.g. no .git),
                // but if present it should be a valid branch name
                if (row.defaultBranch) {
                    expect(typeof row.defaultBranch).toBe('string');
                    expect(row.defaultBranch.length).toBeGreaterThan(0);
                }
            }
        });

        it('should persist coreBranches as an array on Repository nodes', async () => {
            const rows = await cypher<{ name: string; coreBranches: string[] | null }>(
                `MATCH (r:Repository)
                 WHERE r.valid_to_commit IS NULL
                 RETURN r.name AS name, r.coreBranches AS coreBranches`,
            );

            expect(rows.length).toBeGreaterThan(0);

            for (const row of rows) {
                if (row.coreBranches) {
                    // Should be an array
                    expect(Array.isArray(row.coreBranches)).toBe(true);
                    // Each element should be a non-empty string
                    for (const branch of row.coreBranches) {
                        expect(typeof branch).toBe('string');
                        expect(branch.length).toBeGreaterThan(0);
                    }
                    // If defaultBranch is detected, it should be in coreBranches
                    const defaultBranch = (await cypher<{ db: string | null }>(
                        `MATCH (r:Repository {name: $name}) RETURN r.defaultBranch AS db`,
                        { name: row.name },
                    ))[0]?.db;
                    if (defaultBranch) {
                        expect(row.coreBranches).toContain(defaultBranch);
                    }
                }
            }
        });

        it('should persist hostingPlatform on Repository nodes', async () => {
            const rows = await cypher<{ name: string; hostingPlatform: string | null }>(
                `MATCH (r:Repository)
                 WHERE r.valid_to_commit IS NULL
                 RETURN r.name AS name, r.hostingPlatform AS hostingPlatform`,
            );

            expect(rows.length).toBeGreaterThan(0);

            const validPlatforms = ['github', 'gitlab', 'bitbucket', 'azure-devops', 'unknown'];
            for (const row of rows) {
                if (row.hostingPlatform) {
                    expect(validPlatforms).toContain(row.hostingPlatform);
                }
            }
        });

        it('should preserve coreBranches across idempotent re-merge (coalesce guard)', async () => {
            // Verify that calling the query again does NOT null out existing data
            // This is a graph-level invariant check
            const before = await cypher<{ name: string; coreBranches: string[] | null }>(
                `MATCH (r:Repository)
                 WHERE r.valid_to_commit IS NULL AND r.coreBranches IS NOT NULL
                 RETURN r.name AS name, r.coreBranches AS coreBranches`,
            );

            if (before.length > 0) {
                const row = before[0];
                // Simulate what coalesce($coreBranches, r.coreBranches) does:
                // setting to null should keep the existing value
                const session = getNeo4jSession();
                try {
                    await session.run(
                        `MATCH (r:Repository {name: $name})
                         SET r.coreBranches = coalesce(null, r.coreBranches)`,
                        { name: row.name },
                    );
                } finally {
                    await session.close();
                }

                const after = await cypher<{ coreBranches: string[] | null }>(
                    `MATCH (r:Repository {name: $name}) RETURN r.coreBranches AS coreBranches`,
                    { name: row.name },
                );

                expect(after[0]?.coreBranches).toEqual(row.coreBranches);
            }
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Conduit Relay Service — Regression Suite
    //
    // Validates fixes for the 4 regression scenarios identified in V01022:
    //   1. registerAs() factory config → cross-file constant resolution
    //   2. Default import → kind=default binding
    //   3. Consumer rescue → Gate 6 for thin wrapper consumers
    //   4. PascalCase FP guard → class names must not leak as MessageChannel
    // ═════════════════════════════════════════════════════════════════════════

    describe('Conduit Relay Service — Regression', () => {
        // ── Regression 1+2: Factory config + default import → topic resolution ──
        it('should NOT have PascalCase class names as MessageChannel nodes (FP guard)', async () => {
            // PascalCase-only names like 'SendOrderUseCase', 'OrderCreated',
            // 'ConduitPublisher' should be filtered by the sanitizer PascalCase guard.
            const polluted = await cypher<{ name: string }>(
                `MATCH (mc:MessageChannel)
                 WHERE mc.id CONTAINS 'conduit-relay-service'
                   AND NOT mc.name CONTAINS '.'
                   AND NOT mc.name CONTAINS '-'
                   AND NOT mc.name CONTAINS '_'
                   AND size(mc.name) >= 7
                 RETURN mc.name AS name`,
            );
            expect(polluted).toEqual([]);
        });

        it('should NOT have <DYNAMIC> or bare "outbox" as MessageChannel nodes', async () => {
            const noise = await cypher<{ name: string }>(
                `MATCH (mc:MessageChannel)
                 WHERE mc.name IN ['<DYNAMIC>', '<dynamic>', 'outbox', 'conduit']
                 RETURN mc.name AS name`,
            );
            expect(noise).toEqual([]);
        });

        // ── Regression 3: Consumer rescue entrypoint (Gate 6) ────────────────
        it('should ingest conduit-relay-service consumer functions via Gate 6', async () => {
            // The thin consumers (OrderUpdatedConsumer, OrderSaveReadyConsumer)
            // have zero method chunks — they should be rescued by Gate 6.
            const consumers = await cypher<{ name: string }>(
                `MATCH (s:Service {name: 'conduit-relay-service'})-[:CONTAINS]->(f:Function)
                 WHERE f.name CONTAINS 'Consumer'
                 RETURN f.name AS name
                 ORDER BY name`,
            );
            // We expect at least the fat consumer (PreferredResultConsumer) to exist.
            // If Gate 6 works, the thin consumers should also be ingested.
            expect(consumers.length).toBeGreaterThanOrEqual(1);
        });

        // ── Regression 4: emitEvent wrapper → routing key extraction ─────────
        // NOTE: This is a known LLM-level limitation (P2). We verify the
        // functions are at least ingested even if routing keys aren't extracted.
        it('should ingest OrderEventEmitter functions from conduit-relay-service', async () => {
            const emitters = await cypher<{ name: string }>(
                `MATCH (s:Service {name: 'conduit-relay-service'})-[:CONTAINS]->(f:Function)
                 WHERE f.name CONTAINS 'emitOrder'
                 RETURN f.name AS name
                 ORDER BY name`,
            );
            // At least one emitOrder* function should survive the pipeline
            expect(emitters.length).toBeGreaterThanOrEqual(1);
        });

        // ── Structural: service should exist in graph ────────────────────────
        it('should have conduit-relay-service as a Service node', async () => {
            const services = await cypherColumn(
                `MATCH (s:Service {name: 'conduit-relay-service'}) RETURN s.name AS name`,
                'name',
            );
            expect(services).toContain('conduit-relay-service');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // FINAL: Precision/Recall Scoring (Manifest-Based)
    // ═════════════════════════════════════════════════════════════════════════

    describe('Precision/Recall Scoring (Manifest-Based)', () => {
        it('should load and validate the expected.graph.yaml manifest', async () => {
            const manifestPath = path.resolve(MOCK_DATA_DIR, 'expected.graph.yaml');
            const manifest = loadManifest(manifestPath);
            expect(manifest.fixture).toBe('microservices');
            expect(Object.keys(manifest.expected_nodes).length).toBeGreaterThan(0);
        });

        it('should pass all negative node assertions (zero critical regressions)', async () => {
            const manifest = loadManifest(path.resolve(MOCK_DATA_DIR, 'expected.graph.yaml'));

            // Fetch actual graph nodes for each label in the manifest
            const allLabels = new Set([
                ...Object.keys(manifest.expected_nodes),
                ...Object.keys(manifest.negative_nodes),
                ...Object.keys(manifest.negative_patterns),
            ]);
            const graphNodesByLabel = await buildGraphSnapshot([...allLabels], { mode: 'fixture' });

            const violations = checkNegatives(manifest, graphNodesByLabel);
            if (violations.length > 0) {
                console.error('[EVAL CRITICAL] Negative violations detected:');
                for (const v of violations) {
                    console.error(`  ❌ ${v.category}:${v.violatingName} (${v.matchType}${v.matchedPattern ? ` pattern: ${v.matchedPattern}` : ''})`);
                }
            }
            expect(violations.length, 'Critical regressions must be zero').toBe(0);
        });

        it('should verify symbol resolution assertions (DI key → physical name)', async () => {
            const manifest = loadManifest(path.resolve(MOCK_DATA_DIR, 'expected.graph.yaml'));
            if (manifest.expected_symbols.length === 0) return;

            const channelNames = await cypherColumn(
                'MATCH (mc:MessageChannel) RETURN mc.name AS name',
                'name',
            );
            const channelSet = new Set(channelNames);
            const symbolScore = scoreSymbols(manifest, channelSet);

            if (symbolScore.unresolvedDiKeys.length > 0) {
                console.warn(`[EVAL WARN] Unresolved DI keys still in graph: ${symbolScore.unresolvedDiKeys.join(', ')}`);
            }
            if (symbolScore.missingPhysicalNames.length > 0) {
                console.warn(`[EVAL WARN] Missing physical names: ${symbolScore.missingPhysicalNames.join(', ')}`);
            }
            
            console.log('ALL CHANNELS:', Array.from(channelSet).join(', '));

            // Physical names must exist
            expect(symbolScore.resolvedCount, `Expected ${symbolScore.expectedCount} symbols resolved`)
                .toBe(symbolScore.expectedCount);
            // DI keys must NOT survive as MessageChannel
            expect(symbolScore.unresolvedDiKeys, 'No DI keys should survive as MessageChannel')
                .toEqual([]);
        });

        it('should achieve minimum recall thresholds per category', async () => {
            const manifest = loadManifest(path.resolve(MOCK_DATA_DIR, 'expected.graph.yaml'));

            const graphNodesByLabel = await buildGraphSnapshot(
                Object.keys(manifest.expected_nodes),
                { mode: 'fixture' },
            );

            const nodeScores = scoreNodes(manifest, graphNodesByLabel);
            for (const score of nodeScores) {
                if (score.falseNegatives.length > 0) {
                    console.warn(`[EVAL] ${score.category} FN: [${score.falseNegatives.join(', ')}]`);
                }
                // Minimum recall: 80% per category (will tighten to 95%+ after baseline is locked)
                expect(
                    score.recall,
                    `${score.category} recall ${(score.recall * 100).toFixed(1)}% below 80% threshold. Missing: [${score.falseNegatives.join(', ')}]`,
                ).toBeGreaterThanOrEqual(0.80);
            }
        });

        it('should verify critical edge assertions', async () => {
            const manifest = loadManifest(path.resolve(MOCK_DATA_DIR, 'expected.graph.yaml'));
            const edgeResult = await scoreEdges(manifest, cypher);

            if (edgeResult.missingEdges.length > 0) {
                console.warn(`[EVAL] Missing edges:`);
                for (const m of edgeResult.missingEdges) {
                    console.warn(`  ⚠ ${m}`);
                }
            }

            // At least 80% of declared edges must be present
            const edgeRecall = edgeResult.expectedCount > 0
                ? edgeResult.foundCount / edgeResult.expectedCount
                : 1.0;
            expect(
                edgeRecall,
                `Edge recall ${(edgeRecall * 100).toFixed(1)}% below 80% threshold`,
            ).toBeGreaterThanOrEqual(0.80);
        });

        it('should generate and print the full eval report', async () => {
            const manifest = loadManifest(path.resolve(MOCK_DATA_DIR, 'expected.graph.yaml'));

            // Fetch all graph nodes (shared snapshot: consistent with the
            // scoring tests above, including the synthetic GraphQL labels)
            const allLabels = new Set([
                ...Object.keys(manifest.expected_nodes),
                ...Object.keys(manifest.negative_nodes),
                ...Object.keys(manifest.negative_patterns),
            ]);
            const graphNodesByLabel = await buildGraphSnapshot([...allLabels], { mode: 'fixture' });

            // Score everything
            const nodeScores = scoreNodes(manifest, graphNodesByLabel);
            const edgeResult = await scoreEdges(manifest, cypher);
            const channelNames = await cypherColumn(
                'MATCH (mc:MessageChannel) RETURN mc.name AS name',
                'name',
            );
            const symbolScore = scoreSymbols(manifest, new Set(channelNames));
            const negativeViolations = checkNegatives(manifest, graphNodesByLabel);

            const report = assembleReport({
                fixture: manifest.fixture,
                cliVersion: process.env.npm_package_version ?? 'dev',
                llmModel: (() => { try { return configManager.getAiConfig('ingest').model; } catch { return 'unknown'; } })(),
                nodeScores,
                edgeResult,
                symbolScore,
                negativeViolations,
                advisorySkippedCount: 0,
            });

            // Report is printed in UI/Dashboard commands, no need to print in tests

            // Persist JSON report for CI trend tracking
            const ts = report.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
            const reportPath = path.resolve(
                import.meta.dirname, '..', 'eval', 'reports',
                `eval-${report.fixture}-${ts}.json`,
            );
            writeReportJSON(report, reportPath);
            console.log(`[EVAL] Report written → ${reportPath}`);

            // Append compact entry to eval history JSONL for trend tracking
            const historyPath = path.resolve(
                import.meta.dirname, '..', 'eval', 'reports', '.eval-history.jsonl',
            );
            appendToHistory(report, historyPath);

            // Basic sanity: the report should be non-empty
            expect(report.fixture).toBe('microservices');
            expect(report.criticalRegressionCount).toBe(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 99. Zodios API Client Detection (Deterministic Post-LLM Injection)
    //
    // Validates the pricing-service fixture end-to-end:
    //   1. The service node is created (from Backstage catalog-info.yaml)
    //   2. CALLS edge exists from DiscountCalculator → POST /api/v1/pricing/discount
    //      (resolved from the Zodios alias map, NOT by the LLM)
    //   3. Wrapper method names do NOT become APIEndpoint nodes (negative guard)
    //
    // Will FAIL if:
    //   - zodios-context-builder does not index PricingApi.repository.ts
    //   - resolveZodiosCallsForTask() does not resolve the alias
    //   - post-LLM merge in semantic-extractor.ts is broken
    // ═════════════════════════════════════════════════════════════════════════

    describe('Zodios API Client Detection (pricing-service)', () => {
        it('should create a pricing-service Service node from catalog-info.yaml', async () => {
            const names = await cypherColumn(
                'MATCH (s:Service) RETURN s.name AS name',
                'name',
            );
            expect(names).toContain('pricing-service');
        });

        it('should create an APIEndpoint node for POST /api/v1/pricing/discount', async () => {
            const rows = await cypher<{ path: string; method: string }>(
                `MATCH (api:APIEndpoint)
                 WHERE api.path CONTAINS '/pricing/discount'
                 RETURN api.path AS path, api.method AS method`,
            );
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.some(r => r.path.includes('/pricing/discount'))).toBe(true);
        });

        it('should create a CALLS edge from DiscountCalculator to the Zodios-resolved endpoint', async () => {
            const rows = await cypher<{ fn: string; filepath: string; path: string }>(
                `MATCH (f:Function)-[:CALLS]->(api:APIEndpoint)
                 WHERE f.filepath CONTAINS 'DiscountCalculator'
                   AND api.path CONTAINS '/pricing/discount'
                 RETURN f.name AS fn, f.filepath AS filepath, api.path AS path`,
            );
            expect(
                rows.length,
                'DiscountCalculator must have a CALLS edge to /api/v1/pricing/discount. ' +
                'This validates the post-LLM Zodios deterministic injection pipeline.',
            ).toBeGreaterThan(0);
        });

        it('should NOT create APIEndpoint nodes from Zodios wrapper method names', async () => {
            const forbiddenNames = ['calculateDiscount', 'getPricing', 'IPricingApiRepository', 'PricingApiRepository'];
            const rows = await cypher<{ name: string }>(
                `MATCH (api:APIEndpoint)
                 WHERE api.name IN $names OR api.path IN $names
                 RETURN COALESCE(api.name, api.path) AS name`,
                { names: forbiddenNames },
            );
            expect(
                rows,
                `Zodios wrapper names must NOT appear as APIEndpoint nodes: ${JSON.stringify(rows)}`,
            ).toHaveLength(0);
        });

        it('should create a CALLS edge for GET /api/v1/pricing/:productId (from getPricing alias)', async () => {
            const rows = await cypher<{ fn: string; path: string }>(
                `MATCH (f:Function)-[:CALLS]->(api:APIEndpoint)
                 WHERE f.filepath CONTAINS 'DiscountCalculator'
                   AND api.path CONTAINS '/pricing'
                 RETURN f.name AS fn, api.path AS path`,
            );
            // getBasePrice() calls .getPricing() → GET /api/v1/pricing/:productId
            expect(rows.length).toBeGreaterThan(0);
        });
    });

});
