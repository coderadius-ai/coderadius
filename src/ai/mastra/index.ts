// ── Mastra Singleton ─────────────────────────────────────────────────────────
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Mastra } from '@mastra/core';
import { ConsoleLogger, noopLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter } from '@mastra/observability';

import { getFastAnalyzerAgent, getDeepAnalyzerAgent } from '../agents/unified-analyzer.js';
import { getSchemaExtractorAgent } from '../agents/schema-extractor.js';
import { getArchitectAgent } from '../agents/architect.js';
import { getDevDocAgent } from '../agents/doc-generator.js';
import { getConfigSymbolExtractorAgent } from '../agents/config-symbol-extractor.js';
import { getCrignoreAgent } from '../agents/crignore.js';
import { getAgenticMetadataExtractorAgent } from '../agents/agentic-metadata-extractor.js';
import { getTeamAliasResolverAgent } from '../agents/team-alias-resolver.js';
import { getHelmEnvExtractorAgent } from '../agents/helm-env-extractor.js';
import { semanticExtractionWorkflow } from '../workflows/semantic-extraction.js';

// ── Conditional tracing ──────────────────────────────────────────────────────
// Enabled via `RADIUS_TRACE=true` (set by the Studio entry point or shell env).
// In normal CLI usage (`cr ingest`), observability is OFF → clean terminal.
//
// MUST be read lazily inside getMastra(), never at module scope: ESM hoists
// static imports, so this module's body runs BEFORE the Studio entry's
// `process.env.RADIUS_TRACE = 'true'` assignment. A module-scope read came up
// false in `mastra dev`, silently downgraded storage to `:memory:`, and
// Studio's Traces tab queried an empty database (`no such table`).
const isTracingEnabled = () => process.env.RADIUS_TRACE === 'true';

// Absolute, CWD-independent path to the observability store. Two reasons it
// must be a fixed absolute path under ~/.coderadius (NOT a relative `.mastra/`):
//   1. The CLI (CWD = repo root) and the `mastra dev` Studio server (CWD =
//      src/mastra/public) must agree on ONE file, or the CLI writes traces
//      Studio never reads.
//   2. `mastra dev` owns and wipes the `.mastra/` directory on startup, so a
//      DB placed there is deleted every time Studio (re)launches.
const STUDIO_DB = join(homedir(), '.coderadius', 'studio.db');

let _mastra: Mastra | null = null;
export function getMastra(): Mastra {
    if (!_mastra) {
        const tracing = isTracingEnabled();
        if (tracing) mkdirSync(dirname(STUDIO_DB), { recursive: true });
        // Absolute STUDIO_DB so the CLI (CWD = repo root) and the `mastra dev`
        // Studio server (CWD = src/mastra/public) target ONE file. Uses the
        // non-deprecated MastraStorageExporter (below) for 1.42.
        const storage = new LibSQLStore({
            id: 'coderadius-storage',
            url: tracing ? `file:${STUDIO_DB}` : ':memory:',
        });
        if (tracing) {
            // Studio's UI polls list/discovery endpoints without checking store
            // capabilities, and @mastra/libsql (≤1.13) implements only the trace
            // path — every poll logged a full stack trace. Answer with empty,
            // schema-valid pages instead (domain stores are memoized, the patches
            // stick). Drop once upstream implements them or capability-gates the
            // routes; for real logs/metrics/feedback the blessed backend is the
            // DuckDB observability domain from the `mastra dev` scaffold.
            void storage.getStore('observability').then((obs) => {
                if (!obs) return;
                Object.assign(obs, {
                    listFeedback: async () => ({ feedback: [] }),
                    listLogs: async () => ({ logs: [] }),
                    listMetrics: async () => ({ metrics: [] }),
                    getEntityNames: async () => ({ names: [] }),
                    getEntityTypes: async () => ({ entityTypes: [] }),
                    getServiceNames: async () => ({ serviceNames: [] }),
                    getEnvironments: async () => ({ environments: [] }),
                    getTags: async () => ({ tags: [] }),
                    getMetricNames: async () => ({ names: [] }),
                    getMetricLabelKeys: async () => ({ keys: [] }),
                    getMetricLabelValues: async () => ({ values: [] }),
                } satisfies Partial<typeof obs>);
            });
        }
        _mastra = new Mastra({
            logger: tracing
                ? new ConsoleLogger({ name: 'CodeRadius', level: 'info' })
                : noopLogger,
            storage,
            ...(tracing && {
                observability: new Observability({
                    configs: {
                        default: {
                            serviceName: 'coderadius',
                            // MastraStorageExporter (not the deprecated DefaultExporter):
                            // persists spans to the instance storage in the schema
                            // Studio's Traces tab reads. Required for Mastra 1.42+.
                            exporters: [new MastraStorageExporter()]
                        }
                    }
                }),
            }),
            agents: {
                fastAnalyzerAgent: getFastAnalyzerAgent(),
                deepAnalyzerAgent: getDeepAnalyzerAgent(),
                schemaExtractorAgent: getSchemaExtractorAgent(),
                architectAgent: getArchitectAgent(),
                devDocAgent: getDevDocAgent(),
                configSymbolExtractorAgent: getConfigSymbolExtractorAgent(),
                crignoreAgent: getCrignoreAgent(),
                agenticMetadataExtractorAgent: getAgenticMetadataExtractorAgent(),
                teamAliasResolverAgent: getTeamAliasResolverAgent(),
                helmEnvExtractorAgent: getHelmEnvExtractorAgent(),
            },
            workflows: {
                semanticExtractionWorkflow,
            },
        });
    }
    return _mastra;
}

export const mastra = new Proxy({} as Mastra, {
    get(target, prop, receiver) {
        return Reflect.get(getMastra(), prop, receiver);
    }
});
