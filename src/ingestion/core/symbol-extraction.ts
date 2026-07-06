import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import ignore from 'ignore';
import { scanRepositoryTree } from '../../utils/tree-scanner.js';
import { telemetryCollector, traceCollector } from '../../telemetry/index.js';
import { getMastra } from '../../ai/mastra/index.js';
import { ConfigSymbolExtractionSchema } from '../../ai/agents/config-symbol-extractor.js';
import { loadRepoContext } from '../../config/repo-context.js';
import { logger } from '../../utils/logger.js';
import { withCongestionControl } from '../../utils/congestion-control.js';
import {
    AIMDSemaphore,
    getDefaultAIMDSemaphore,
} from '../../utils/aimd-semaphore.js';
import { getQualifiedRepoName } from '../../graph/urn.js';
import type { ResolvedRepo } from '../../graph/types.js';
import type { ProgressReporter } from './progress.js';
import { hashContent } from './merkle.js';
import { isConfigFile } from './config-file-detector.js';
import { SymbolRegistry, type SymbolCategory, type SymbolBinding, type SymbolConfidence } from './symbol-registry.js';
import {
    backfillConfigSymbolDefaults,
    loadConfigSymbols,
    loadRegistryCache,
    loadSymbolDependentsBatch,
    saveSymbolExtractionCacheState,
    softDeleteSymbols,
    type CachedRawSymbolBinding,
    type SymbolExtractionCacheState,
    type SymbolSourceFileCache,
} from '../../graph/mutations/config-symbols.js';
import type { EnvVarBinding } from '../processors/infra-manifest-resolver.js';
import { getAllIgnorePatterns, getPluginForExtension } from './languages/registry.js';

// ─── Versions ────────────────────────────────────────────────────────────────

// Bumped from v3 to v4 to force ConfigSymbol rebuild: schema gained
// physicalName / boundComponent / bindingFingerprint / viaFiles / ioTagsJson.
const SYMBOL_EXTRACTION_CACHE_VERSION = 'symbol-cache-v4';
const SYMBOL_EXTRACTOR_VERSION = 'config-symbol-extractor-v2';
// v4: the LLM scout was removed — the plan is fully deterministic (see
// buildTargetPlan). Bumped to force one plan rebuild on upgrade.
const SYMBOL_TARGET_PLANNER_VERSION = 'symbol-target-planner-v4';

const MAX_CONFIG_FILE_SIZE = 512 * 1024;

const CORE_IGNORE_PATTERNS = ['.git/**', '**/.git/**', '**/coverage/**'];
const pluginIgnoreMatcher = ignore().add([...CORE_IGNORE_PATTERNS, ...getAllIgnorePatterns()]);
const TOOL_CONFIG_BASENAME = /^(vitest|jest|mocha|ava|karma|playwright|cypress|storybook|eslint|prettier|babel|rollup|vite|webpack|tsup|tsdown|swc)(?:[.-].*)?\.config\.(ts|js|mjs|cjs)$/i;
const INFRA_RESOURCE_HINT_WORDS = new Set([
    'db', 'dbschema', 'database', 'datasource', 'amqp', 'rabbit', 'rabbitmq', 'kafka',
    'messaging', 'messagebus', 'pubsub', 'queue', 'topic', 'broker', 'bus', 'outbox',
    'cache', 'redis', 'memcached', 'mongo', 'sql', 'postgres', 'mysql', 'elastic',
    'opensearch', 'strapi', 'tracing', 'logger', 'http', 'grpc', 'soap', 'client',
]);
const WIRING_DIR = /(^|\/)(config|di|container|providers?|modules?)\//i;
const INFRA_DIR = /(^|\/)(infrastructure|infra)\//i;

// ─── Types ──────────────────────────────────────────────────────────────────

export type SymbolTargetKind = 'symbol_config' | 'env_source' | 'orm_schema' | 'regular_source' | 'ignored';
export type SymbolFileDecision = 'hit' | 'changed' | 'new' | 'deleted' | 'failed' | 'skipped';

export interface SymbolTarget {
    path: string;
    kind: SymbolTargetKind;
}

export interface SymbolTargetPlan {
    candidateInventoryHash: string;
    targetPlanHash: string;
    targets: SymbolTarget[];
}

export interface SymbolExtractionDiagnostics {
    totalTargets: number;
    cacheHits: number;
    changed: number;
    added: number;
    deleted: number;
    failed: number;
    llmCalls: number;
    envResolved: number;
    taintedFiles: number;
}

export interface SymbolRegistryBuildResult {
    registry: SymbolRegistry;
    targetPlan: SymbolTargetPlan;
    cacheState: SymbolExtractionCacheState;
    scoutedFiles: Set<string>;
    taintedFiles: Set<string>;
    diagnostics: SymbolExtractionDiagnostics;
    status: 'healthy' | 'partial';
}

export interface ManualSymbolInput {
    key: string;
    value: string;
    category?: SymbolCategory;
}

export interface BuildSymbolRegistryOptions {
    repo: ResolvedRepo;
    progress?: ProgressReporter;
    fresh?: boolean;
    commitHash?: string;
    manualSymbols?: ManualSymbolInput[];
    persistCacheState?: boolean;
    llmConcurrency?: number;
    /** Injectable LLM extraction port — defaults to {@link extractSymbolFile}. */
    extractFile?: typeof extractSymbolFile;
}

export interface ExtractSymbolFileResult {
    relPath: string;
    contentHash: string;
    bindings: CachedRawSymbolBinding[];
    usage?: unknown;
}

// ─── Hash / Path Helpers ────────────────────────────────────────────────────

function sha16(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
}

function normalizeRelPath(relPath: string): string {
    return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function fileContentHash(absPath: string): string {
    return hashContent(fs.readFileSync(absPath, 'utf-8'));
}

function sortedUnique(paths: string[]): string[] {
    return [...new Set(paths.map(normalizeRelPath).filter(Boolean))].sort();
}

function isIgnoredByCoreOrPlugin(relPath: string): boolean {
    return pluginIgnoreMatcher.ignores(normalizeRelPath(relPath));
}

function tokenizePathForHints(relPath: string): string[] {
    return normalizeRelPath(relPath)
        .split(/[\/._-]+/)
        .flatMap(part => part
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .split(/\s+/))
        .map(token => token.toLowerCase())
        .filter(Boolean);
}

function hasInfraResourceHint(relPath: string): boolean {
    return tokenizePathForHints(relPath).some(token => INFRA_RESOURCE_HINT_WORDS.has(token));
}

// ─── Target Planning ────────────────────────────────────────────────────────

export function classifySymbolTarget(relPathInput: string): SymbolTargetKind {
    const relPath = normalizeRelPath(relPathInput);
    const lower = relPath.toLowerCase();
    const base = path.basename(lower);

    if (isIgnoredByCoreOrPlugin(relPath)) return 'ignored';
    if (/(^|\/)(__tests__|tests|test|spec|fixtures|mocks)\//.test(lower)) return 'ignored';

    if (/\.env(\.|$)/.test(base) || base.endsWith('.env') || base === '.env') {
        return 'env_source';
    }

    const looksOrmSchema =
        /(^|\/)(entities?|models?|schema)\/.+\.(ts|tsx|js|jsx|php|py|go)$/i.test(relPath)
        || /\.entity\.(ts|tsx|js|jsx)$/i.test(relPath)
        || /entity\.(ts|tsx|js|jsx|php|py)$/i.test(relPath)
        || /^schema\.prisma$/i.test(path.basename(relPath));
    if (looksOrmSchema && !/dbschema\.module\.(ts|js)$/i.test(base)) {
        return 'orm_schema';
    }

    if (TOOL_CONFIG_BASENAME.test(base)) return 'ignored';

    const isTsRuntime = /\.(ts|tsx|js|jsx)$/i.test(relPath);
    const isConfigTs = /\.config\.(ts|js)$/i.test(base);
    const isModuleTs = /\.module\.(ts|js)$/i.test(base);
    const isProviderFactory = /\.(provider|factory|container)\.(ts|js)$/i.test(base);
    const resourceHint = hasInfraResourceHint(relPath);
    const isInInfraOrWiringDir = INFRA_DIR.test(relPath) || WIRING_DIR.test(relPath);
    const isInfraTsModule =
        isTsRuntime
        && !looksOrmSchema
        && (
            (isConfigTs && isInInfraOrWiringDir)
            || (isModuleTs && resourceHint)
            || (isProviderFactory && resourceHint)
        );

    if (isConfigFile(relPath) || isInfraTsModule) return 'symbol_config';

    return 'regular_source';
}

function buildCandidateInventory(repoPath: string): { paths: string[]; inventoryHash: string } {
    const fileTree = scanRepositoryTree(repoPath);
    const paths = sortedUnique(
        fileTree
            .map(item => item.path)
            .filter(p => {
                const kind = classifySymbolTarget(p);
                return kind === 'symbol_config' || kind === 'env_source';
            }),
    );
    const inventoryHash = sha16(`${SYMBOL_TARGET_PLANNER_VERSION}:${paths.join('\n')}`);
    return { paths, inventoryHash };
}

/**
 * Build the target plan deterministically from the candidate inventory.
 *
 * History: an LLM "scout" (infra-discovery agent) used to propose targets
 * here. Characterization pins proved it could add no productive target —
 * every existing pick was already selected by the deterministic
 * `classifySymbolTarget` pass over the same inventory, and hallucinated
 * paths only polluted `targetPlanHash` before no-opping on the existence
 * guard. The scout was removed (one LLM call per repo per plan rebuild,
 * zero graph effect); the planner version bump forces one plan rebuild.
 */
function buildTargetPlan(
    repo: ResolvedRepo,
    cacheState: SymbolExtractionCacheState | null,
    fresh: boolean,
): SymbolTargetPlan {
    const { paths: candidatePaths, inventoryHash } = buildCandidateInventory(repo.path);
    const cachedCanBeUsed =
        !fresh
        && cacheState?.version === SYMBOL_EXTRACTION_CACHE_VERSION
        && cacheState.candidateInventoryHash === inventoryHash
        && cacheState.targetPlanHash;

    if (cachedCanBeUsed) {
        const targets = Object.values(cacheState.sources)
            .filter(src => fs.existsSync(path.join(repo.path, src.path)))
            .map(src => ({ path: src.path, kind: 'symbol_config' as const }))
            .sort((a, b) => a.path.localeCompare(b.path));
        traceCollector.traceResolution('CACHE_HIT', `symbol-target-plan:${getQualifiedRepoName(repo)}`, 'candidate inventory unchanged', {
            candidateInventoryHash: inventoryHash,
            targetCount: targets.length,
        });
        return {
            candidateInventoryHash: inventoryHash,
            targetPlanHash: cacheState.targetPlanHash!,
            targets,
        };
    }

    const targets = candidatePaths
        .filter(p => classifySymbolTarget(p) === 'symbol_config')
        .map(p => ({ path: p, kind: 'symbol_config' as const }));
    const targetPlanHash = sha16(`${SYMBOL_TARGET_PLANNER_VERSION}:${targets.map(t => `${t.path}:${t.kind}`).join('\n')}`);

    traceCollector.traceResolution('INFO', `symbol-target-plan:${getQualifiedRepoName(repo)}`, 'target plan built', {
        candidateInventoryHash: inventoryHash,
        targetPlanHash,
        candidateCount: candidatePaths.length,
        targetCount: targets.length,
    });

    return { candidateInventoryHash: inventoryHash, targetPlanHash, targets };
}

// ─── Extraction ──────────────────────────────────────────────────────────────

export async function extractSymbolFile(
    repo: ResolvedRepo,
    relPath: string,
    progress?: ProgressReporter,
    semaphore?: AIMDSemaphore,
): Promise<ExtractSymbolFileResult> {
    const normalized = normalizeRelPath(relPath);
    const absPath = path.join(repo.path, normalized);
    if (!fs.existsSync(absPath)) {
        throw new Error(`file not found: ${normalized}`);
    }
    const stats = fs.statSync(absPath);
    if (!stats.isFile()) throw new Error(`not a file: ${normalized}`);
    if (stats.size > MAX_CONFIG_FILE_SIZE) {
        throw new Error(`file too large (${Math.round(stats.size / 1024)}KB > 512KB)`);
    }

    const content = fs.readFileSync(absPath, 'utf-8');
    const contentHash = hashContent(content);
    const extractorAgent = getMastra().getAgent('configSymbolExtractorAgent');
    const t0 = Date.now();
    progress?.report(`[Symbol Extractor] Processing config: ${normalized} ...`);
    const response = await withCongestionControl(
        () => extractorAgent.generate(
            `File: ${normalized}\n\n${content}`,
            {
                structuredOutput: { schema: ConfigSymbolExtractionSchema },
                modelSettings: { maxRetries: 0, temperature: 0 },
                abortSignal: AbortSignal.timeout(60000),
            },
        ),
        { limiter: semaphore },
    );
    telemetryCollector.incrementLLMInvocations();
    telemetryCollector.addTokensForPhase('symbol_extraction', response.usage);
    type ExtractedBinding = Partial<z.infer<typeof ConfigSymbolExtractionSchema>['bindings'][number]> &
        Pick<z.infer<typeof ConfigSymbolExtractionSchema>['bindings'][number], 'diKey' | 'physicalName'>;
    const bindings = (response.object?.bindings ?? []).map((binding: ExtractedBinding) => ({
        diKey: binding.diKey,
        physicalName: binding.physicalName,
        category: binding.category,
        technology: binding.technology,
    }));
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    progress?.report(`[Symbol Extractor] Extracted ${bindings.length} binding(s) from ${normalized} (${elapsed}s)`);
    return { relPath: normalized, contentHash, bindings, usage: response.usage };
}

// ─── Deterministic Env Resolution ────────────────────────────────────────────

function envBindingValue(binding: EnvVarBinding | undefined): string | null {
    return binding?.value ?? null;
}

function lookupEnv(envKey: string, dict: Map<string, EnvVarBinding>): string | null {
    const direct = envBindingValue(dict.get(envKey));
    if (direct) return direct;
    const envNorm = envKey.replace(/_/g, '');
    for (const [dictKey, dictVal] of dict) {
        const segments = dictKey.split('.');
        const leafKey = segments.slice(-1)[0].replace(/_/g, '');
        if (leafKey === envNorm || dictKey.replace(/\./g, '_') === envKey) {
            return dictVal.value;
        }
    }
    return null;
}

/**
 * Diff persisted ConfigSymbol nodes against the current in-memory registry to
 * decide which keys count as `changed` (value drift) and `deleted` (gone from
 * the registry). The returned key sets drive `loadSymbolDependentsBatch` ⇒
 * consumer-file taint ⇒ forced LLM re-analysis on the next pass, so a false
 * positive here cascades into a full unchanged-code re-run.
 *
 * Two stored-symbol classes MUST be exempt from the deletion check:
 *
 *   1. Symbols whose extractor source failed mid-run (`failedSources`): the
 *      file briefly disappeared from `nextSources`, but the symbol may still
 *      exist on disk. Marking it deleted would taint consumers based on a
 *      transient failure.
 *
 *   2. Class-only DI bindings (`boundComponent` set, no `physicalName`).
 *      These are produced by the `DiBindingResolver` in `static-analyzer-pass`,
 *      which runs AFTER `buildSymbolRegistryForRepo`. At diff time the current
 *      registry has not yet seen them, so without this guard every run would
 *      report the entire DI binding set as deleted, taint every consumer file,
 *      and force a full LLM re-analysis on unchanged code (regression bug
 *      caught by the cache-invalidation pattern test).
 */
export interface SymbolDiffOptions {
    failedSources: Set<string>;
    preserveStoredDueToOpaqueFailure: boolean;
}

export interface SymbolDiffResult {
    changedKeys: string[];
    deletedKeys: string[];
}

export function computeSymbolDiff(
    storedSymbols: Array<Pick<import('../../graph/mutations/config-symbols.js').StoredConfigSymbol,
        'key' | 'value' | 'rawValue' | 'resolvedValue' | 'sourceFile' | 'physicalName' | 'boundComponent'>>,
    currentBindings: Array<Pick<SymbolBinding, 'key' | 'value'>>,
    opts: SymbolDiffOptions,
): SymbolDiffResult {
    const byKey = new Map(currentBindings.map(b => [b.key, b]));
    const changedKeys: string[] = [];
    const deletedKeys: string[] = [];

    for (const oldSym of storedSymbols) {
        const next = byKey.get(oldSym.key);
        if (!next) {
            if (oldSym.sourceFile && opts.failedSources.has(oldSym.sourceFile)) continue;
            if (opts.preserveStoredDueToOpaqueFailure) continue;
            if (oldSym.boundComponent && !oldSym.physicalName) continue;
            deletedKeys.push(oldSym.key);
            continue;
        }
        const oldResolved = oldSym.resolvedValue ?? oldSym.value;
        if (next.value !== oldResolved) {
            changedKeys.push(oldSym.key);
        }
    }
    return { changedKeys, deletedKeys };
}

export function resolveRawSymbolValue(rawValue: string, dict: Map<string, EnvVarBinding>): { value: string; resolved: boolean } {
    let resolved = false;
    let value = rawValue.replace(/%env\(([A-Z][A-Z0-9_]*)\)%/g, (match, envKey) => {
        const hit = lookupEnv(envKey, dict);
        if (!hit) return match;
        resolved = true;
        return hit;
    });
    value = value.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (match, envKey) => {
        const hit = lookupEnv(envKey, dict);
        if (!hit) return match;
        resolved = true;
        return hit;
    });
    return { value, resolved };
}

function computeEnvHash(dict: Map<string, EnvVarBinding>): string {
    const rows = [...dict.entries()]
        .map(([key, binding]) => `${key}=${binding.value}@${binding.sourceFile}:${binding.confidence}`)
        .sort();
    return sha16(rows.join('\n'));
}

// ─── Deterministic Config-Symbol Extraction ──────────────────────────────────
// Some DI config shapes are fully parseable from source — no LLM needed, and
// the LLM `config-symbol-extractor` is unreliable for them (replay cache drifts
// on every edit; live runs have recorded zero resolved symbols). When a
// deterministic extractor fully handles a file we use its bindings and skip the
// LLM entirely, making symbol resolution cache-independent.
//
// Language/framework-specific parsing lives in the plugin layer
// (LanguagePlugin.extractDeterministicConfigSymbols); this dispatcher only
// routes by file extension and returns the language-agnostic binding shape.
function extractDeterministicConfigSymbols(relPath: string, absPath: string): CachedRawSymbolBinding[] | null {
    const plugin = getPluginForExtension(path.extname(relPath));
    if (!plugin?.extractDeterministicConfigSymbols) return null;
    let content: string;
    try {
        content = fs.readFileSync(absPath, 'utf-8');
    } catch {
        return null;
    }
    const symbols = plugin.extractDeterministicConfigSymbols(content);
    if (symbols.length === 0) return null;
    return symbols.map(s => ({
        diKey: s.diKey,
        physicalName: s.physicalName,
        category: s.category,
        technology: s.technology,
        boundComponent: s.boundComponent,
    }));
}

// ─── Registry Build ─────────────────────────────────────────────────────────

function registerRawBinding(
    registry: SymbolRegistry,
    raw: CachedRawSymbolBinding,
    source: SymbolSourceFileCache,
    envDict: Map<string, EnvVarBinding>,
): boolean {
    const rawValue = raw.physicalName;
    const resolved = resolveRawSymbolValue(rawValue, envDict);
    // physicalName presence (non-empty) marks this as a binding with a real
    // canonical resource name (sanitizer will use it). Empty physicalName +
    // boundComponent means class-only binding (DI propagator territory).
    const physicalName = raw.physicalName?.trim() ? raw.physicalName : undefined;
    registry.register({
        key: raw.diKey,
        value: resolved.value,
        physicalName,
        rawValue,
        resolvedValue: resolved.value,
        category: (raw.category ?? 'di_service') as SymbolCategory,
        technology: raw.technology,
        sourceFile: source.path,
        sourceHash: source.contentHash,
        extractorVersion: source.extractorVersion,
        confidence: 'static',
        boundComponent: raw.boundComponent,
        // ioTags arrive from the propagator populated as
        // DiIoTag[]; we deserialize from raw.ioTagsJson when present.
        ioTags: deserializeIoTags(raw.ioTagsJson),
        bindingFingerprint: raw.bindingFingerprint,
        viaFiles: raw.viaFiles,
    });
    return resolved.resolved;
}

function deserializeIoTags(json: string | undefined): SymbolBinding['ioTags'] {
    if (!json || !json.trim()) return undefined;
    try {
        return JSON.parse(json) as SymbolBinding['ioTags'];
    } catch {
        return undefined;
    }
}

const SYMBOL_CONFIDENCE_VALUES: ReadonlySet<string> = new Set(['manual', 'static', 'template', 'inferred']);

function storedConfidence(value: string | undefined): SymbolConfidence {
    return value && SYMBOL_CONFIDENCE_VALUES.has(value) ? value as SymbolConfidence : 'static';
}

/**
 * Re-register symbols previously persisted to the graph. When `reResolveEnv`
 * is provided (eval path), raw values are re-resolved against the CURRENT
 * env dictionary instead of trusting the stored resolution.
 */
function registerStoredSymbols(
    registry: SymbolRegistry,
    stored: Awaited<ReturnType<typeof loadConfigSymbols>>,
    reResolveEnv?: Map<string, EnvVarBinding>,
): void {
    for (const sym of stored) {
        const rawValue = sym.rawValue ?? sym.value;
        const resolvedValue = reResolveEnv
            ? resolveRawSymbolValue(rawValue, reResolveEnv).value
            : sym.resolvedValue ?? sym.value;
        const physicalName = sym.physicalName?.trim() ? sym.physicalName : undefined;
        registry.register({
            key: sym.key,
            value: resolvedValue,
            physicalName,
            rawValue,
            resolvedValue,
            category: (sym.category ?? 'di_service') as SymbolCategory,
            technology: sym.technology || undefined,
            sourceFile: sym.sourceFile ?? 'db_cache',
            sourceHash: sym.sourceHash,
            extractorVersion: sym.extractorVersion,
            confidence: storedConfidence(sym.confidence),
            boundComponent: sym.boundComponent,
            ioTags: deserializeIoTags(sym.ioTagsJson),
            bindingFingerprint: sym.bindingFingerprint,
            viaFiles: sym.viaFiles,
        });
    }
}

function registerManualSymbols(registry: SymbolRegistry, manualSymbols: ManualSymbolInput[] | undefined): void {
    for (const sym of manualSymbols ?? []) {
        if (!sym.key || !sym.value) continue;
        registry.register({
            key: sym.key,
            value: sym.value,
            rawValue: sym.value,
            resolvedValue: sym.value,
            category: sym.category ?? 'di_service',
            sourceFile: 'coderadius.yaml',
            confidence: 'manual',
        });
    }
}

/** Per-run dependencies threaded through the target processor. */
interface TargetProcessingContext {
    repo: ResolvedRepo;
    qName: string;
    fresh: boolean;
    previousSources: Record<string, SymbolSourceFileCache>;
    nextSources: Record<string, SymbolSourceFileCache>;
    failedSources: Set<string>;
    diagnostics: SymbolExtractionDiagnostics;
    extractFile: typeof extractSymbolFile;
    progress?: ProgressReporter;
    semaphore: AIMDSemaphore;
}

/**
 * Process one target file: per-file cache hit → deterministic pre-pass →
 * LLM extraction, with failure preservation (a previously-good source
 * degrades to `partial` and keeps its bindings; a new source records
 * `failed` with none).
 */
async function processTarget(target: SymbolTarget, ctx: TargetProcessingContext): Promise<void> {
    const { repo, qName, fresh, previousSources, nextSources, failedSources, diagnostics } = ctx;
    const absPath = path.join(repo.path, target.path);
    if (!fs.existsSync(absPath)) return;
    const contentHash = fileContentHash(absPath);
    const cached = previousSources[target.path];
    if (!fresh && cached?.status === 'success' && cached.contentHash === contentHash && cached.extractorVersion === SYMBOL_EXTRACTOR_VERSION) {
        diagnostics.cacheHits++;
        nextSources[target.path] = { ...cached, targetKind: target.kind };
        traceCollector.traceResolution('CACHE_HIT', `symbol-file:${qName}:${target.path}`, 'target content unchanged', {
            contentHash,
            decision: 'hit',
        });
        return;
    }

    if (cached) diagnostics.changed++;
    else diagnostics.added++;

    // Deterministic pre-pass: fully-parseable DI config shapes skip the LLM.
    const deterministic = extractDeterministicConfigSymbols(target.path, absPath);
    if (deterministic && deterministic.length > 0) {
        nextSources[target.path] = {
            path: target.path,
            contentHash,
            extractorVersion: SYMBOL_EXTRACTOR_VERSION,
            status: 'success',
            rawBindings: deterministic,
            targetKind: target.kind,
        };
        traceCollector.traceResolution('STATIC', `symbol-file:${qName}:${target.path}`, 'deterministic config symbols (LLM skipped)', {
            contentHash,
            bindingCount: deterministic.length,
            decision: cached ? 'changed' : 'new',
        });
        return;
    }

    diagnostics.llmCalls++;
    try {
        const extracted = await ctx.extractFile(repo, target.path, ctx.progress, ctx.semaphore);
        nextSources[target.path] = {
            path: target.path,
            contentHash: extracted.contentHash,
            extractorVersion: SYMBOL_EXTRACTOR_VERSION,
            status: 'success',
            rawBindings: extracted.bindings,
            targetKind: target.kind,
        };
        traceCollector.traceResolution('INFO', `symbol-file:${qName}:${target.path}`, cached ? 'target_content_changed' : 'target_new', {
            contentHash: extracted.contentHash,
            bindingCount: extracted.bindings.length,
            decision: cached ? 'changed' : 'new',
        });
    } catch (err) {
        diagnostics.failed++;
        failedSources.add(target.path);
        if (cached) {
            nextSources[target.path] = {
                ...cached,
                status: 'partial',
                error: (err as Error).message,
                targetKind: target.kind,
            };
        } else {
            nextSources[target.path] = {
                path: target.path,
                contentHash,
                extractorVersion: SYMBOL_EXTRACTOR_VERSION,
                status: 'failed',
                rawBindings: [],
                error: (err as Error).message,
                targetKind: target.kind,
            };
        }
        ctx.progress?.warn(`[Symbol Extractor] Failed ${target.path}: ${(err as Error).message}`);
        traceCollector.traceResolution('INFO', `symbol-file:${qName}:${target.path}`, 'extract_failed_preserving_cache', {
            contentHash,
            decision: 'failed',
            error: (err as Error).message,
        });
    }
}

/**
 * Assemble the registry from processed sources. The opaque-failure guard:
 * when nothing was processed, or a failure occurred while the stored
 * symbols predate per-source attribution (legacy rows), the stored
 * symbols are preserved wholesale rather than risking a bogus diff.
 */
function buildRegistryFromSources(
    nextSources: Record<string, SymbolSourceFileCache>,
    storedSymbols: Awaited<ReturnType<typeof loadConfigSymbols>>,
    preserveStoredDueToOpaqueFailure: boolean,
    envVarDict: Map<string, EnvVarBinding>,
    manualSymbols: ManualSymbolInput[] | undefined,
    diagnostics: SymbolExtractionDiagnostics,
): SymbolRegistry {
    const registry = new SymbolRegistry();
    if ((Object.keys(nextSources).length === 0 || preserveStoredDueToOpaqueFailure) && storedSymbols.length > 0) {
        registerStoredSymbols(registry, storedSymbols);
    }
    for (const source of Object.values(nextSources)) {
        for (const raw of source.rawBindings) {
            if (registerRawBinding(registry, raw, source, envVarDict)) {
                diagnostics.envResolved++;
            }
        }
    }
    registerManualSymbols(registry, manualSymbols);
    return registry;
}

/** Diff the rebuilt registry against the stored one, taint dependents, soft-delete removals. */
async function applySymbolDiffAndTaint(
    registry: SymbolRegistry,
    storedSymbols: Awaited<ReturnType<typeof loadConfigSymbols>>,
    diffOptions: SymbolDiffOptions,
    qName: string,
    commitHash: string,
    diagnostics: SymbolExtractionDiagnostics,
): Promise<{ changedKeys: string[]; deletedKeys: string[]; taintedFiles: Set<string> }> {
    const { changedKeys, deletedKeys } = computeSymbolDiff(storedSymbols, registry.getAll(), diffOptions);

    const taintedFiles = new Set<string>();
    const taintKeys = [...new Set([...changedKeys, ...deletedKeys])];
    if (taintKeys.length > 0) {
        const dependents = await loadSymbolDependentsBatch(taintKeys, qName);
        for (const files of dependents.values()) {
            for (const filePath of files) taintedFiles.add(filePath);
        }
        diagnostics.taintedFiles = taintedFiles.size;
    }
    if (deletedKeys.length > 0) {
        await softDeleteSymbols(deletedKeys, qName, commitHash);
    }
    return { changedKeys, deletedKeys, taintedFiles };
}

export async function buildSymbolRegistryForRepo(opts: BuildSymbolRegistryOptions): Promise<SymbolRegistryBuildResult> {
    const { repo, progress, fresh = false, commitHash = repo.commit || 'SYSTEM', manualSymbols, llmConcurrency } = opts;

    // Adaptive concurrency. When the caller passes an explicit
    // `llmConcurrency`, we instantiate a local AIMDSemaphore pinned to that
    // hard cap (no AIMD growth); otherwise we share the process singleton so
    // symbol extraction and the code pipeline coordinate against the same
    // rate-limit budget.
    const semaphore: AIMDSemaphore = llmConcurrency !== undefined
        ? new AIMDSemaphore({
            initialLimit: llmConcurrency,
            softMaxLimit: llmConcurrency,
            hardMaxLimit: llmConcurrency,
        })
        : getDefaultAIMDSemaphore();

    // Outer batching dimension. The semaphore enforces the real concurrency
    // limit; this just bounds how many `processTarget` invocations are in
    // flight at once (keeps memory bounded for large target lists).
    const concurrency = llmConcurrency ?? parseInt(process.env.LLM_CONCURRENCY || '3', 10);
    const qName = getQualifiedRepoName(repo);

    await backfillConfigSymbolDefaults(qName);
    const storedSymbols = await loadConfigSymbols(qName);
    const cache = await loadRegistryCache(qName);
    const previousState = !fresh && cache.symbolCacheState?.version === SYMBOL_EXTRACTION_CACHE_VERSION
        ? cache.symbolCacheState
        : null;

    const targetPlan = buildTargetPlan(repo, previousState, fresh);
    const targetPaths = new Set(targetPlan.targets.map(t => t.path));
    const previousSources = previousState?.sources ?? {};
    const diagnostics: SymbolExtractionDiagnostics = {
        totalTargets: targetPlan.targets.length,
        cacheHits: 0,
        changed: 0,
        added: 0,
        deleted: 0,
        failed: 0,
        llmCalls: 0,
        envResolved: 0,
        taintedFiles: 0,
    };
    for (const oldPath of Object.keys(previousSources)) {
        if (!targetPaths.has(oldPath)) diagnostics.deleted++;
    }

    const processing: TargetProcessingContext = {
        repo,
        qName,
        fresh,
        previousSources,
        nextSources: {},
        failedSources: new Set<string>(),
        diagnostics,
        extractFile: opts.extractFile ?? extractSymbolFile,
        progress,
        semaphore,
    };
    for (let start = 0; start < targetPlan.targets.length; start += concurrency) {
        await Promise.all(targetPlan.targets.slice(start, start + concurrency).map(t => processTarget(t, processing)));
    }
    const { nextSources, failedSources } = processing;

    const repoCtx = loadRepoContext(repo.path);
    const preserveStoredDueToOpaqueFailure = failedSources.size > 0 && (!previousState || storedSymbols.some(sym => !sym.sourceFile || sym.sourceFile === 'legacy'));
    const registry = buildRegistryFromSources(nextSources, storedSymbols, preserveStoredDueToOpaqueFailure, repoCtx.envVarDict, manualSymbols, diagnostics);

    const { changedKeys, deletedKeys, taintedFiles } = await applySymbolDiffAndTaint(
        registry, storedSymbols, { failedSources, preserveStoredDueToOpaqueFailure }, qName, commitHash, diagnostics);

    const cacheState: SymbolExtractionCacheState = {
        version: SYMBOL_EXTRACTION_CACHE_VERSION,
        candidateInventoryHash: targetPlan.candidateInventoryHash,
        targetPlanHash: targetPlan.targetPlanHash,
        envHash: computeEnvHash(repoCtx.envVarDict),
        status: diagnostics.failed > 0 ? 'partial' : 'healthy',
        sources: nextSources,
    };
    if (opts.persistCacheState) {
        await saveSymbolExtractionCacheState(qName, cacheState);
    }

    if (changedKeys.length > 0 || deletedKeys.length > 0) {
        traceCollector.traceResolution('INFO', `symbol-registry:${qName}`, 'symbol diff applied', {
            changedKeys,
            deletedKeys,
            taintedFiles: [...taintedFiles],
        });
    }

    return {
        registry,
        targetPlan,
        cacheState,
        scoutedFiles: new Set(targetPlan.targets.map(t => t.path)),
        taintedFiles,
        diagnostics,
        status: diagnostics.failed > 0 ? 'partial' : 'healthy',
    };
}

export async function loadSymbolRegistryForEval(opts: {
    repoName: string;
    repoRoot: string;
    changedFiles: string[];
}): Promise<SymbolRegistryBuildResult> {
    const registry = new SymbolRegistry();
    await backfillConfigSymbolDefaults(opts.repoName);
    const storedSymbols = await loadConfigSymbols(opts.repoName);
    const repo = {
        name: path.basename(opts.repoRoot),
        path: opts.repoRoot,
        origin: 'local',
    } as ResolvedRepo;

    const changedSymbolFiles = sortedUnique(opts.changedFiles)
        .filter(filePath => classifySymbolTarget(filePath) === 'symbol_config');
    const changedEnvOnly = sortedUnique(opts.changedFiles)
        .some(filePath => classifySymbolTarget(filePath) === 'env_source');

    const repoCtx = loadRepoContext(opts.repoRoot);
    const envHash = computeEnvHash(repoCtx.envVarDict);

    registerStoredSymbols(registry, storedSymbols, repoCtx.envVarDict);

    const sources: Record<string, SymbolSourceFileCache> = {};
    let failed = 0;
    let llmCalls = 0;
    for (const relPath of changedSymbolFiles) {
        const absPath = path.join(opts.repoRoot, relPath);
        if (!fs.existsSync(absPath)) continue;

        // Deterministic pre-pass: fully-parseable DI config shapes skip the LLM.
        const deterministic = extractDeterministicConfigSymbols(relPath, absPath);
        if (deterministic && deterministic.length > 0) {
            const source: SymbolSourceFileCache = {
                path: relPath,
                contentHash: fileContentHash(absPath),
                extractorVersion: SYMBOL_EXTRACTOR_VERSION,
                status: 'success',
                rawBindings: deterministic,
                targetKind: 'symbol_config',
            };
            sources[relPath] = source;
            for (const raw of deterministic) {
                registerRawBinding(registry, raw, source, repoCtx.envVarDict);
            }
            continue;
        }

        llmCalls++;
        try {
            const extracted = await extractSymbolFile(repo, relPath);
            const source: SymbolSourceFileCache = {
                path: relPath,
                contentHash: extracted.contentHash,
                extractorVersion: SYMBOL_EXTRACTOR_VERSION,
                status: 'success',
                rawBindings: extracted.bindings,
                targetKind: 'symbol_config',
            };
            sources[relPath] = source;
            for (const raw of extracted.bindings) {
                registerRawBinding(registry, raw, source, repoCtx.envVarDict);
            }
        } catch (err) {
            failed++;
            logger.warn(`[SymbolLoader] Failed to re-extract from ${relPath}: ${(err as Error).message}. Using cached symbols.`);
        }
    }

    const targetPlanHash = sha16(`${SYMBOL_TARGET_PLANNER_VERSION}:${changedSymbolFiles.join('\n')}`);
    return {
        registry,
        targetPlan: {
            candidateInventoryHash: targetPlanHash,
            targetPlanHash,
            targets: changedSymbolFiles.map(p => ({ path: p, kind: 'symbol_config' as const })),
        },
        cacheState: {
            version: SYMBOL_EXTRACTION_CACHE_VERSION,
            candidateInventoryHash: targetPlanHash,
            targetPlanHash,
            envHash,
            status: failed > 0 ? 'partial' : 'healthy',
            sources,
        },
        scoutedFiles: new Set(changedSymbolFiles),
        taintedFiles: new Set(),
        diagnostics: {
            totalTargets: changedSymbolFiles.length,
            cacheHits: 0,
            changed: changedSymbolFiles.length,
            added: 0,
            deleted: 0,
            failed,
            llmCalls,
            envResolved: changedEnvOnly ? storedSymbols.length : 0,
            taintedFiles: 0,
        },
        status: failed > 0 ? 'partial' : 'healthy',
    };
}
