/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-doctrine-table-has-schema
 *
 * Real-world bug (orchestrator, 2026-05-16):
 *
 *   File `classes/Entity/QuoteArchive.php` declares Doctrine table
 *   `order_quotes_archive`. The pipeline correctly created a
 *   `DataStructure(database_table)` node AND the corresponding `DataContainer`
 *   used by 5 Functions in service `orchestrator` STORED_IN repo
 *   `cr:repository:unknown/orchestrator`.
 *
 *   BUT `(DataContainer)-[:HAS_SCHEMA]->(DataStructure)` was NOT created
 *   because `linkDataContainerSchemas` requires the same Repository to both:
 *     (a) CONTAINS the SourceFile that DEFINES_SCHEMA the DataStructure
 *     (b) own the Service whose Function READS/WRITES the DataContainer
 *
 *   Root cause: `persistSchemas` (graph-writer) derived `qualifiedRepoName`
 *   from `relativePath.split('/')[0]` (= "classes") instead of
 *   FileContext.repo (= "unknown/orchestrator"). The MERGE inside
 *   `mergeEmergentSchema` then created a SHADOW SourceFile node under URN
 *   `cr:sourcefile:classes:classes/Entity/QuoteArchive.php` (orphan, no
 *   Repository CONTAINS edge) instead of matching the existing
 *   `cr:sourcefile:unknown/orchestrator:...` node.
 *
 *   The DataStructure ended up DEFINES_SCHEMA-linked to the SHADOW SourceFile
 *   while the CORRECT SourceFile (the one a Repository contains) was bypassed
 *   → `linkDataContainerSchemas` join Repository-side returns NULL →
 *   `HAS_SCHEMA` never materialises.
 *
 * What this pattern pins (deterministic, NO LLM):
 *
 *   Given a fixture where the Doctrine entity lives at `src/Entity/Order.php`
 *   (first path segment "src" ≠ qualifiedRepoName "acme/orders"), the
 *   pipeline MUST carry `qualifiedRepoName` from FileContext.repo all the way
 *   through:
 *
 *       buildAnalysisTasks
 *         → StaticAnalysisResult.schemaContext.qualifiedRepoName
 *         → extractSchemas
 *         → ExtractedSchemaData.qualifiedRepoName
 *         → persistSchemas
 *         → mergeEmergentSchema({ qualifiedRepoName })
 *
 *   The SchemaContext + ExtractedSchemaData fields are the load-bearing
 *   contract: when this test fails, the bug is back.
 *
 * Fixture: tests/eval/patterns/php-doctrine-table-has-schema/fixture/
 *   src/Entity/Order.php — Doctrine entity declaring table `acme_orders`
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { buildAnalysisTasks, type ParsedFileResult } from '../../../../src/ingestion/processors/code-pipeline/static-analyzer-task-builder.js';
import { getQualifiedRepoName } from '../../../../src/graph/urn.js';
import { extractParsedFile } from '../../../../src/ingestion/processors/code-pipeline/parse-worker.js';
import type { FileContext, DiscoveryResult } from '../../../../src/ingestion/processors/code-pipeline/types.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');
const ENTITY_RELATIVE = 'src/Entity/Order.php';
const REPO = { name: 'orders', org: 'acme', path: FIXTURE_DIR, origin: 'local' as const };
const EXPECTED_QUALIFIED = getQualifiedRepoName(REPO); // 'acme/orders'

function makeFileContext(): FileContext {
    return {
        absolutePath: path.join(FIXTURE_DIR, ENTITY_RELATIVE),
        relativePath: ENTITY_RELATIVE,
        repo: REPO as any,
        routing: { type: 'repository', name: REPO.name, urn: `urn:repository:${EXPECTED_QUALIFIED}` } as any,
        fileHash: 'fixture-hash',
        ownerService: null,
        isManifest: false,
    };
}

function makeParsed(): ParsedFileResult {
    const absolutePath = path.join(FIXTURE_DIR, ENTITY_RELATIVE);
    const fileContent = fs.readFileSync(absolutePath, 'utf-8');
    // Production extraction path (same per-file work the parse worker runs),
    // executed in-process; the test then strips optional context to keep the
    // original minimal-context setup.
    const extracted = extractParsedFile(
        { taskId: 0, absolutePath, relativePath: ENTITY_RELATIVE, mode: 'fresh', needsImportMap: false },
        { allFilePaths: new Set([ENTITY_RELATIVE]), dependencyMappings: [], scanMode: 'semantic' },
    );
    if (extracted.language === 'unknown') {
        throw new Error('Failed to parse PHP fixture: tree-sitter returned no AST');
    }
    return {
        fileContext: makeFileContext(),
        chunks: extracted.chunks,
        language: extracted.language,
        frameworkSignals: [],
        fileContent,
        fileConstants: [],
        valueFacts: [],
        criticalInvocations: [],
        componentDefinitions: [],
        dependencyRequirements: [],
        chunkStaticData: extracted.chunkStaticData,
        importStatements: extracted.importStatements,
        constructorSources: extracted.constructorSources,
        mayContainSchemas: extracted.mayContainSchemas,
        typeDefinitions: null,
        referencedTypes: null,
        payloadHints: null,
        isCacheHit: false,
        unchangedFunctions: [],
        unchangedFunctionCount: 0,
    };
}

function makeDiscovery(fc: FileContext): DiscoveryResult {
    return {
        repo: fc.repo,
        files: [fc],
        merkleIndex: {
            repoHash: 'repo-hash',
            repoScanMode: 'semantic',
            files: new Map(),
        },
        repoHash: 'repo-hash',
        skippedCount: 0,
        allFilePaths: new Set([fc.relativePath]),
        dependencyMappings: [],
    } as any;
}

describe('Pattern Eval — php-doctrine-table-has-schema', () => {
    let result: ReturnType<typeof buildAnalysisTasks>;

    beforeAll(() => {
        const parsed = makeParsed();
        const discovery = makeDiscovery(parsed.fileContext);
        result = buildAnalysisTasks(parsed, discovery);
    });

    it('first path segment of relativePath is NOT the qualifiedRepoName (mirrors the orchestrator bug)', () => {
        // Pre-condition: the fixture deliberately picks a path whose first
        // segment ("src") is NOT the qualifiedRepoName ("acme/orders"). The
        // `split('/')[0]` fallback would produce "src", not "acme/orders" —
        // exactly the regression we are pinning.
        const firstSegment = ENTITY_RELATIVE.split('/')[0];
        expect(firstSegment).toBe('src');
        expect(firstSegment).not.toBe(EXPECTED_QUALIFIED);
    });

    it('produces a SchemaContext for the Doctrine entity file', () => {
        // Doctrine entity files match `mayContainSchemas` (declares a class
        // with ORM\Entity / ORM\Table annotations). The task builder must
        // emit a SchemaContext for them.
        expect(result.schemaContext).not.toBeNull();
        expect(result.schemaContext!.relativePath).toBe(ENTITY_RELATIVE);
        expect(result.schemaContext!.filePath).toBe(path.join(FIXTURE_DIR, ENTITY_RELATIVE));
    });

    it('SchemaContext.qualifiedRepoName is the canonical repo qualifier, not relativePath.split[0]', () => {
        // The load-bearing contract: SchemaContext carries the qualifiedRepoName
        // so persistSchemas / mergeEmergentSchema construct the SourceFile URN
        // consistently with merkle's `Repository -[:CONTAINS]-> SourceFile`
        // link (same URN scheme).
        const ctx = result.schemaContext;
        expect(ctx, 'SchemaContext must be present for a Doctrine entity').not.toBeNull();
        expect(ctx!.qualifiedRepoName).toBe(EXPECTED_QUALIFIED);
        expect(ctx!.qualifiedRepoName).not.toBe('src');
    });
});
