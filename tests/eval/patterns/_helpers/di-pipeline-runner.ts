// ═════════════════════════════════════════════════════════════════════════════
// di-pipeline-runner — shared helper for DI bypass pattern tests
//
// Runs the deterministic side of the code pipeline on a fixture directory:
//
//   1. Discover every .php file under FIXTURE_DIR.
//   2. Parse each with the PHPPlugin, collect:
//        - imports / exports / implementsFiles
//        - valueFacts + criticalInvocations
//        - componentDefinitions + dependencyRequirements
//   3. Run DI_BINDING_PROVIDERS over the discovered files (PHP-DI container,
//      Symfony services yaml/php) with the contentSignatures gate.
//   4. DiBindingResolver.resolveAll → populates SymbolRegistry.
//   5. Build ValueResolutionIndex + ComponentIoIndex (the latter only needs
//      the components/file contents/VRI).
//   6. DiIoPropagator.propagateAll → stamps ioTags on bindings.
//   7. For a caller-named consumer function, resolve its invocations in
//      'full' mode and feed them to buildStaticAnalysisFromResolvedInvocations.
//
// Returns everything needed by the pattern tests to assert end-to-end behavior
// without spinning up Memgraph or the LLM-bound semantic-extractor.
// ═════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import {
    extractPhpComponentDefinitions,
    extractPhpDependencyRequirements,
} from '../../../../src/ingestion/core/languages/php/component-extraction.js';
import {
    extractPhpValueFacts,
    extractPhpCriticalInvocations,
} from '../../../../src/ingestion/core/languages/php/value-resolution.js';
import type { ImportContext } from '../../../../src/ingestion/core/languages/types.js';
import type {
    ComponentDefinition,
    DependencyRequirement,
} from '../../../../src/ingestion/core/languages/types.js';
import type { FileImportMap } from '../../../../src/ingestion/core/import-graph.js';
import { SymbolRegistry } from '../../../../src/ingestion/core/symbol-registry.js';
import {
    DI_BINDING_PROVIDERS,
    type RawDiBinding,
} from '../../../../src/ingestion/core/di-binding-providers/index.js';
import { DiBindingResolver } from '../../../../src/ingestion/core/di-binding-resolver.js';
import { ComponentIoIndex } from '../../../../src/ingestion/core/component-io-index.js';
import { DiIoPropagator } from '../../../../src/ingestion/core/di-io-propagator.js';
import {
    ValueResolutionIndex,
    buildStaticAnalysisFromResolvedInvocations,
    type ResolvedInvocationArg,
} from '../../../../src/ingestion/core/value-resolution/index.js';
import { synthesizeDiCtorScalarFacts } from '../../../../src/ingestion/core/value-resolution/di-ctor-scalar-facts.js';
import type { CriticalInvocationFact, ValueFact } from '../../../../src/ingestion/core/value-resolution/types.js';
import type { CodeChunk } from '../../../../src/graph/types.js';

export interface ParsedPhpFile {
    relPath: string;
    absPath: string;
    content: string;
    imports: ReturnType<PHPPlugin['extractImports']>;
    exportedSymbols: string[];
    implementsFiles: string[];
    valueFacts: ValueFact[];
    criticalInvocations: CriticalInvocationFact[];
    componentDefinitions: ComponentDefinition[];
    dependencyRequirements: DependencyRequirement[];
}

export interface DiPipelineResult {
    files: ParsedPhpFile[];
    rawBindings: RawDiBinding[];
    registry: SymbolRegistry;
    components: ComponentDefinition[];
    dependencyRequirements: DependencyRequirement[];
    vri: ValueResolutionIndex;
    componentIo: ComponentIoIndex;
}

function discoverPhpFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.php')) out.push(full);
        }
    };
    walk(root);
    return out;
}

/**
 * Run the deterministic static pipeline on a fixture directory. The fixture's
 * DI config files (containerBuilder.php / config/*.yaml / services.php) are
 * picked up automatically by DI_BINDING_PROVIDERS so the test fixture decides
 * which DI shape it exercises.
 */
export function runStaticPipelineOnFixture(fixtureDir: string, repoName = 'acme/inventory-service'): DiPipelineResult {
    const plugin = new PHPPlugin();
    const parser = plugin.createParser();
    const dependencyMappings = plugin.loadDependencyMappings(fixtureDir);

    const allAbs = discoverPhpFiles(fixtureDir);
    const allRel = new Set(allAbs.map(f => path.posix.relative(fixtureDir, f)));
    const ctx: ImportContext = {
        allFilePaths: allRel,
        dependencyMappings,
        allowAbsolute: false,
    };

    const files: ParsedPhpFile[] = [];
    for (const absPath of allAbs) {
        const relPath = path.posix.relative(fixtureDir, absPath);
        const content = fs.readFileSync(absPath, 'utf-8');
        const tree = parser.parse(content);
        const imports = plugin.extractImports(tree.rootNode, ctx);
        const exportedSymbols = plugin.extractExports(tree.rootNode);
        const implementsFiles = plugin.extractImplementsFiles?.(tree.rootNode, ctx) ?? [];
        const valueFacts = extractPhpValueFacts(tree.rootNode, content, relPath);
        const criticalInvocations = extractPhpCriticalInvocations(tree.rootNode, content, relPath);
        const componentDefinitions = extractPhpComponentDefinitions(tree.rootNode, relPath);
        const dependencyRequirements = extractPhpDependencyRequirements(tree.rootNode, relPath);

        files.push({
            relPath,
            absPath,
            content,
            imports,
            exportedSymbols,
            implementsFiles,
            valueFacts,
            criticalInvocations,
            componentDefinitions,
            dependencyRequirements,
        });
    }

    // ── Step 2: collect DI bindings ─────────────────────────────────────────
    const allRepoFiles = new Set<string>();
    for (const f of files) allRepoFiles.add(f.relPath);
    // Also include non-PHP DI config files (services.yaml etc.) so that
    // SymfonyServicesYamlProvider can pick them up.
    const walkAll = (dir: string, rootDir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walkAll(full, rootDir);
            else allRepoFiles.add(path.posix.relative(rootDir, full));
        }
    };
    walkAll(fixtureDir, fixtureDir);

    const rawBindings: RawDiBinding[] = [];
    for (const relativePath of allRepoFiles) {
        const basename = path.posix.basename(relativePath);
        const candidates = DI_BINDING_PROVIDERS.filter(p => p.matchFile(relativePath, basename));
        if (candidates.length === 0) continue;
        const abs = path.join(fixtureDir, relativePath);
        let content: string;
        try {
            content = fs.readFileSync(abs, 'utf-8');
        } catch {
            continue;
        }
        for (const provider of candidates) {
            const signaturePassed = provider.contentSignatures.some(sig => sig.test(content));
            if (!signaturePassed) continue;
            const out = provider.extractDiBindings(content, {
                relativePath,
                repoRoot: fixtureDir,
                repoName,
            });
            if (out.length > 0) rawBindings.push(...out);
        }
    }

    // ── Step 3: DiBindingResolver ───────────────────────────────────────────
    const registry = new SymbolRegistry();
    const components = files.flatMap(f => f.componentDefinitions);
    const dependencyRequirements = files.flatMap(f => f.dependencyRequirements);

    new DiBindingResolver().resolveAll({
        rawBindings,
        componentDefinitions: components,
        dependencyRequirements,
        symbolRegistry: registry,
    });

    // ── Step 4: ValueResolutionIndex (full pipeline, with DI registry) ──────
    const fileImportMaps: FileImportMap[] = files.map(f => ({
        filePath: f.relPath,
        imports: f.imports,
        exportedSymbols: f.exportedSymbols,
        implementsFiles: f.implementsFiles,
    }));
    // Merge DI-ctor-scalar value facts (e.g. a wrapper's $this->topic resolved
    // from a positional DI literal) into the bound component's valueFacts
    // before the VRI is built, so its $this->prop accessors resolve.
    const ctorScalarFactsByFile = new Map<string, typeof files[number]['valueFacts']>();
    for (const fact of synthesizeDiCtorScalarFacts(rawBindings, components)) {
        const list = ctorScalarFactsByFile.get(fact.filePath) ?? [];
        list.push(fact);
        ctorScalarFactsByFile.set(fact.filePath, list);
    }
    const vri = new ValueResolutionIndex(
        files.map(f => ({
            filePath: f.relPath,
            valueFacts: [...f.valueFacts, ...(ctorScalarFactsByFile.get(f.relPath) ?? [])],
            criticalInvocations: f.criticalInvocations,
        })),
        fileImportMaps,
        registry,
    );

    // ── Step 5: ComponentIoIndex (value-only mode internally) ───────────────
    const fileContents = new Map<string, string>();
    for (const f of files) fileContents.set(f.relPath, f.content);
    const componentIo = new ComponentIoIndex(components, fileContents, vri);

    // ── Step 6: DiIoPropagator ──────────────────────────────────────────────
    new DiIoPropagator(registry, componentIo).propagateAll();

    return {
        files,
        rawBindings,
        registry,
        components,
        dependencyRequirements,
        vri,
        componentIo,
    };
}

/**
 * Look up a parsed file by suffix (e.g. `'OrderController.php'`).
 */
export function findFileBySuffix(result: DiPipelineResult, suffix: string): ParsedPhpFile {
    const f = result.files.find(x => x.relPath.endsWith(suffix));
    if (!f) {
        const seen = result.files.map(x => x.relPath).join(', ');
        throw new Error(`fixture file ending in '${suffix}' not found among: ${seen}`);
    }
    return f;
}

/**
 * Build a CodeChunk for a named method in a parsed file. Looks up the
 * `method_declaration` range via the component definitions extracted by the
 * pipeline (we already have those — no need to re-parse).
 *
 * @param fqcn full FQCN of the owning class (e.g. 'Acme\\Inventory\\OrderController')
 * @param method lowercased method name (PHP is case-insensitive)
 */
export function buildMethodChunk(
    result: DiPipelineResult,
    fqcn: string,
    method: string,
): CodeChunk {
    const lowerMethod = method.toLowerCase();
    for (const file of result.files) {
        const comp = file.componentDefinitions.find(c => c.fqcn === fqcn);
        if (!comp) continue;
        const op = comp.operations.find(o => o.name === lowerMethod);
        if (!op) continue;
        const lines = file.content.split('\n');
        const sourceCode = lines.slice(op.range.startLine - 1, op.range.endLine).join('\n');
        return {
            name: `${fqcn}.${method}`,
            filepath: file.relPath,
            language: 'php',
            startLine: op.range.startLine,
            startColumn: 1,
            endLine: op.range.endLine,
            endColumn: 1,
            sourceCode,
        };
    }
    const known = result.components.map(c => c.fqcn).join(', ');
    throw new Error(`Component ${fqcn}.${method} not found. Known FQCNs: ${known}`);
}

/**
 * End-to-end: resolve invocations for `fqcn::method` in full mode and run
 * the static-bypass builder. Returns:
 *   - `null` when the bypass abstained (LLM fallback path);
 *   - `{ resolved, staticAnalysis }` when the bypass produced infrastructure.
 */
export function runStaticBypassForMethod(
    result: DiPipelineResult,
    fqcn: string,
    method: string,
): {
    resolved: ResolvedInvocationArg[];
    staticAnalysis: ReturnType<typeof buildStaticAnalysisFromResolvedInvocations>;
} {
    const chunk = buildMethodChunk(result, fqcn, method);
    const resolved = result.vri.resolveInvocationsForChunk(chunk.filepath, chunk, { mode: 'full' });
    const staticAnalysis = buildStaticAnalysisFromResolvedInvocations(resolved, chunk.sourceCode);
    return { resolved, staticAnalysis };
}
