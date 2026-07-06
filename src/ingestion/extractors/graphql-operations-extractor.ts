/**
 * GraphQL Operations Extractor (consumer-side)
 *
 * Walks `.gql` / `.graphql` files in a repo and extracts every
 * OperationDefinition (query / mutation / subscription) into a synthetic
 * index. The index is keyed by file path so call-sites that load operations
 * via `file_get_contents()` / `import './foo.gql'` can be resolved
 * deterministically without LLM involvement.
 *
 * Strict discipline (see memory: synthetic index, not full doc content):
 *   - The full operation body is NEVER persisted or pushed to the LLM.
 *   - Each entry holds only `{operationType, operationName, rootField}`.
 *   - The lookup happens at call-site context build time and injects ONE
 *     entry per task — never bulk-dumps the index.
 *
 * Coexists with the SDL extractor (`graphql-schema-extractor.ts`): a `.gql`
 * file that contains only `type X { ... }` definitions yields an empty
 * operations array here and is consumed by the SDL extractor instead.
 * Mixed files (rare) yield both — the operations win for consumer-side
 * resolution; the SDL extractor still records type defs as schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Kind, parse as parseGraphQL } from 'graphql';
import type { DocumentNode, OperationDefinitionNode } from 'graphql';
import { logger } from '../../utils/logger.js';

export interface GraphQLOperationFileEntry {
    operationType: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';
    operationName: string;
    rootField: string;
}

const GQL_EXTS = new Set(['.gql', '.graphql']);

function findOperationFiles(repoRoot: string): string[] {
    const out: string[] = [];

    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.name.startsWith('.') && e.name !== '.graphql') continue;
            if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'dist' || e.name === 'build') continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) walk(abs);
            else if (e.isFile() && GQL_EXTS.has(path.extname(e.name).toLowerCase())) out.push(abs);
        }
    }

    walk(repoRoot);
    return out;
}

function operationFromAst(opDef: OperationDefinitionNode): GraphQLOperationFileEntry | null {
    if (!opDef.name) return null; // anonymous operations cannot be addressed by name
    const opType = opDef.operation.toUpperCase() as GraphQLOperationFileEntry['operationType'];
    if (opType !== 'QUERY' && opType !== 'MUTATION' && opType !== 'SUBSCRIPTION') return null;
    const rootSelection = opDef.selectionSet.selections[0];
    if (!rootSelection || rootSelection.kind !== Kind.FIELD) return null;
    const rootField = rootSelection.name.value;
    if (!rootField || rootField.startsWith('__')) return null;
    return {
        operationType: opType,
        operationName: opDef.name.value,
        rootField,
    };
}

export function parseGraphQLOperationsFile(content: string, filePath: string): GraphQLOperationFileEntry[] {
    if (!content || content.length === 0) return [];
    let doc: DocumentNode;
    try {
        doc = parseGraphQL(content);
    } catch (err) {
        logger.debug(`[gql-operations] parse error in ${filePath}: ${(err as Error).message}`);
        return [];
    }

    const entries: GraphQLOperationFileEntry[] = [];
    for (const def of doc.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;
        const entry = operationFromAst(def);
        if (entry) entries.push(entry);
    }
    return entries;
}

/**
 * Build the operations index for a repo. Returned map is keyed by both
 * the absolute path AND the basename, so consumers can match either:
 *   - a literal absolute path baked at build time
 *   - a basename argument to `file_get_contents(__DIR__ . '/Foo.gql')`
 *
 * Files with zero OperationDefinition are omitted (they are pure SDL).
 */
export interface GraphQLOperationsIndex {
    /** absolute filesystem paths (e.g. /repo/src/Foo/Bar.gql) → operation entries */
    byAbsolutePath: Map<string, GraphQLOperationFileEntry[]>;
    /** repo-relative paths with forward slashes (e.g. src/Foo/Bar.gql) → operation entries */
    byRelativePath: Map<string, GraphQLOperationFileEntry[]>;
    /** basename without directory (e.g. Bar.gql) → operation entries; ambiguous on collision */
    byBasename: Map<string, GraphQLOperationFileEntry[]>;
}

export function buildGraphQLOperationsIndex(repoRoot: string): GraphQLOperationsIndex {
    const byAbsolutePath = new Map<string, GraphQLOperationFileEntry[]>();
    const byRelativePath = new Map<string, GraphQLOperationFileEntry[]>();
    const byBasename = new Map<string, GraphQLOperationFileEntry[]>();
    const basenameCollisions = new Set<string>();

    for (const abs of findOperationFiles(repoRoot)) {
        let content: string;
        try {
            content = fs.readFileSync(abs, 'utf8');
        } catch (e) {
            logger.debug(`[gql-operations] could not read ${abs}: ${(e as Error).message}`);
            continue;
        }

        const ops = parseGraphQLOperationsFile(content, abs);
        if (ops.length === 0) continue;

        byAbsolutePath.set(abs, ops);
        const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
        byRelativePath.set(rel, ops);
        const base = path.basename(abs);
        const existing = byBasename.get(base);
        if (existing) {
            // mark this basename ambiguous; the resolver must not use it as a sole match
            basenameCollisions.add(base);
            existing.push(...ops);
        } else {
            byBasename.set(base, [...ops]);
        }
    }

    // Drop colliding basenames so the resolver fails closed rather than
    // injecting wrong context for ambiguous filenames.
    for (const base of basenameCollisions) byBasename.delete(base);

    return { byAbsolutePath, byRelativePath, byBasename };
}

/**
 * Resolve a single GraphQL operation entry referenced by a string literal in
 * source code. Tries, in order:
 *   1. exact relative-path match (e.g. 'src/Inventory/Mutation/InitSave.gql')
 *   2. basename-only match (e.g. 'InitSave.gql') — only if unambiguous
 *
 * Returns at most one entry — caller-side disambiguation. If the literal
 * file path holds multiple OperationDefinitions (unusual but legal), the
 * first is returned. The literal in source MUST end in `.gql` / `.graphql`.
 */
export function resolveGqlLiteralReference(
    literal: string,
    index: GraphQLOperationsIndex,
): GraphQLOperationFileEntry | null {
    if (!literal) return null;
    const normalized = literal.replace(/\\/g, '/').trim();
    const ext = path.extname(normalized).toLowerCase();
    if (!GQL_EXTS.has(ext)) return null;

    // Exact relative match (some builds inline an absolute path; try both)
    const relMatch = index.byRelativePath.get(normalized);
    if (relMatch && relMatch.length > 0) return relMatch[0];

    // Strip leading './' or any directory prefix
    const stripped = normalized.replace(/^\.?\/*/, '');
    const stripMatch = index.byRelativePath.get(stripped);
    if (stripMatch && stripMatch.length > 0) return stripMatch[0];

    // Basename
    const base = path.basename(normalized);
    const baseMatch = index.byBasename.get(base);
    if (baseMatch && baseMatch.length > 0) return baseMatch[0];

    return null;
}

/**
 * Find every `.gql` / `.graphql` string literal in a source code chunk and
 * resolve it to an operation entry. Used by the static-analyzer enrichment
 * pass to inject deterministic GraphQL context for call sites that load
 * operations from disk (e.g. `file_get_contents(__DIR__ . '/InitSave.gql')`).
 *
 * Returns at most a few entries per chunk; never iterates the full index.
 */
export function findGqlLiteralReferencesInSource(
    source: string,
    index: GraphQLOperationsIndex,
): GraphQLOperationFileEntry[] {
    if (!source) return [];
    // Capture quoted string literals ending in .gql or .graphql.
    const RE = /['"`]([^'"`]+\.(?:gql|graphql))['"`]/gi;
    const seen = new Set<string>();
    const out: GraphQLOperationFileEntry[] = [];
    let m: RegExpExecArray | null;
    while ((m = RE.exec(source)) !== null) {
        const literal = m[1];
        if (seen.has(literal)) continue;
        seen.add(literal);
        const entry = resolveGqlLiteralReference(literal, index);
        if (entry) out.push(entry);
    }
    return out;
}

/**
 * Format a one-line GraphQL document context block (call-site scoped).
 * Mirrors `buildGraphQLDocumentContext`'s output shape so the LLM prompt
 * stays consistent regardless of the source (TS gql-tagged literal or
 * standalone .gql file).
 */
export function formatGqlOperationContext(entries: GraphQLOperationFileEntry[]): string | undefined {
    if (entries.length === 0) return undefined;
    const lines = entries.map(e =>
        `${e.operationName} -> GRAPHQL ${e.operationType} ${e.rootField} (document=${e.operationName})`,
    );
    return `--- Loaded GraphQL Operation Files (resolved from .gql/.graphql) ---\n${lines.join('\n')}\n--- End Loaded GraphQL Operation Files ---`;
}
