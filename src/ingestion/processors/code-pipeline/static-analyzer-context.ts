import path from 'node:path';
import { getLanguagePlugin } from '../../core/languages/registry.js';
import type { FileImportMap, FileTaintInfo } from '../../core/import-graph.js';
import type {
    ClientBinding,
    DataStructureDefinition,
    ResolvedConstant,
} from '../../core/languages/types.js';
import type { CodeChunk } from '../../../graph/types.js';
import type { AnalysisTask, AstResolvedPayload } from './types.js';
import { buildUrn, buildFunctionSignature, getQualifiedRepoName } from '../../../graph/urn.js';

export function makeFunctionId(
    repoName: string,
    filepath: string,
    chunk: CodeChunk,
): string {
    const signature = buildFunctionSignature(chunk.name, filepath, chunk.language, {
        startLine: chunk.startLine,
        startColumn: chunk.startColumn,
        endLine: chunk.endLine,
        endColumn: chunk.endColumn,
    }, chunk.nameIsAmbiguous ?? false);
    return buildUrn('function', repoName, chunk.language, signature);
}

export function makeFunctionIdForRepo(
    repoPathOrName: { name: string; org?: string },
    filepath: string,
    chunk: CodeChunk,
): string {
    return makeFunctionId(getQualifiedRepoName(repoPathOrName), filepath, chunk);
}

export function isGeneratedFPCallback(chunkName: string): boolean {
    const methodPart = chunkName.includes('.') ? chunkName.split('.').pop()! : chunkName;
    return /^(with|when|otherwise|map|filter|fold|match|chain\w*|orElse\w*|tap\w*|flatMap\w*)_callback$/i.test(methodPart);
}

export function deriveClassName(chunkName: string): string | null {
    const dotIdx = chunkName.indexOf('.');
    if (dotIdx === -1) return null;
    // Cross-language canonicalization (same family as `canonicalKey` in
    // value-resolution): chunk names are `<ClassPath>.<method>`; the class
    // SHORT name is the last namespace segment. Backslash is the only
    // namespace separator that survives into chunk names (dots are the
    // member separator); splitting on it is an identity for ecosystems
    // without it.
    const classPath = chunkName.substring(0, dotIdx);
    const segments = classPath.split('\\');
    return segments[segments.length - 1] || null;
}

function hasSourceReference(source: string, reference: string): boolean {
    return new RegExp(`(^|[^A-Za-z0-9_$.])${escapeRegex(reference)}(?=$|[^A-Za-z0-9_$])`).test(source);
}

function constantContextKeys(
    constant: { scope: string; name: string; value: string },
    targetClassName?: string | null,
): string[] {
    if (!constant.scope) return [constant.name];

    const scopedKey = `${constant.scope}.${constant.name}`;
    const keys = [scopedKey, `${constant.scope}::${constant.name}`];
    if (constant.scope === targetClassName) {
        keys.push(constant.name);
        keys.push(`this.${constant.name}`);
        // PHP: self::CONST and static::CONST inside the same class.
        // Only emitted when the constant scope matches the analyzed class,
        // so a self::FOO reference in OtherClient cannot leak AcmePartnerClient::FOO.
        keys.push(`self::${constant.name}`);
        keys.push(`static::${constant.name}`);
    } else keys.push(`this.${scopedKey}`);
    return keys;
}

// Single source of truth for "which external imports are I/O sinks". Used both
// to build the human-readable taint summary AND to derive the STRUCTURED sink
// categories that scope the analyzer prompt/schema (no regex on the summary).
const KNOWN_SINK_PREFIXES = [
    'pg', 'mysql', 'mongodb', 'mongoose', 'redis', 'ioredis',
    'amqplib', 'kafkajs', 'bullmq', '@prisma/client', 'typeorm', 'sequelize',
    'knex', 'axios', 'node-fetch', '@google-cloud/pubsub', '@aws-sdk/',
    '@grpc/grpc-js', 'socket.io', 'neo4j-driver',
];

/** The external sink import sources for a file (used for taint summary + category scoping). */
export function extractSinkImports(fileImportMap?: FileImportMap): string[] {
    if (!fileImportMap) return [];
    return fileImportMap.imports
        .filter(i => i.isExternal && KNOWN_SINK_PREFIXES.some(prefix => i.source.startsWith(prefix)))
        .map(i => i.source);
}

export function buildTaintContextSummary(
    taintInfo?: FileTaintInfo,
    fileImportMap?: FileImportMap,
    extraSinkPackages?: string[],
): string | undefined {
    if (!taintInfo) return undefined;

    const sections: string[] = [];

    if (fileImportMap) {
        const sinkImports = extractSinkImports(fileImportMap);
        if (sinkImports.length > 0) {
            sections.push(`Direct I/O imports: ${sinkImports.join(', ')}`);
        }

        // ── User-configured SDK sinks (from packages.analyze) ────────────────
        // These are proprietary/internal packages the user has declared as I/O
        // sinks. Surface them explicitly so the LLM knows NOT to suppress
        // method calls on them under the generic wrapper-detection rule.
        if (extraSinkPackages && extraSinkPackages.length > 0) {
            const sdkImports = fileImportMap.imports
                .filter(i => i.isExternal && extraSinkPackages.some(
                    pkg => i.source === pkg || i.source.startsWith(pkg + '/'),
                ))
                .map(i => i.source);
            if (sdkImports.length > 0) {
                sections.push(
                    `User-configured SDK sinks (treat method calls as real I/O): ${sdkImports.join(', ')}`,
                );
            }
        }
    }

    if (taintInfo.taintedSymbols.size > 0) {
        sections.push(`Tainted symbols (trace back to I/O sinks): ${[...taintInfo.taintedSymbols].join(', ')}`);
    }

    if (taintInfo.taintedAliases.size > 0) {
        const aliases = [...taintInfo.taintedAliases.entries()]
            .map(([prop, type]) => `${prop} → ${type} (tainted)`)
            .join(', ');
        sections.push(`DI aliases: ${aliases}`);
    }

    if (sections.length === 0) return undefined;
    return `\n--- Taint Context (auto-generated from import graph) ---\n${sections.join('\n')}\n--- End Taint Context ---`;
}

export function hasActiveTaint(taintInfo?: FileTaintInfo): boolean {
    return !!taintInfo && (taintInfo.taintedSymbols.size > 0 || taintInfo.taintedAliases.size > 0);
}

export function formatFileConstantsContext(
    constants: Array<{ scope: string; name: string; value: string }>,
    targetClassName?: string | null,
    chunkSourceCode?: string,
): string | undefined {
    if (constants.length === 0) return undefined;

    const scopeFiltered = targetClassName && chunkSourceCode
        ? constants.filter(constant =>
            constant.scope === '' ||
            constant.scope === targetClassName ||
            constantContextKeys(constant, targetClassName).some(key => hasSourceReference(chunkSourceCode, key)),
        )
        : targetClassName
            ? constants.filter(constant => constant.scope === '' || constant.scope === targetClassName)
            : constants;
    if (scopeFiltered.length === 0) return undefined;

    const relevant = chunkSourceCode
        ? scopeFiltered.filter(constant =>
            constantContextKeys(constant, targetClassName).some(key => hasSourceReference(chunkSourceCode, key)),
        )
        : scopeFiltered;
    if (relevant.length === 0) return undefined;

    const maxTotal = 30;
    const lines: string[] = ['--- File Constants (resolved from AST) ---'];
    let count = 0;

    const moduleLevels = relevant.filter(constant => constant.scope === '');
    if (moduleLevels.length > 0) {
        lines.push('// Module-level');
        for (const constant of moduleLevels) {
            if (count++ >= maxTotal) break;
            lines.push(`${constant.name} = ${constant.value}`);
        }
    }

    const seen = new Set<string>();
    for (const constant of relevant.filter(entry => entry.scope !== '')) {
        if (!seen.has(constant.scope)) seen.add(constant.scope);
    }

    for (const className of seen) {
        if (count >= maxTotal) break;
        const classConstants = relevant.filter(constant => constant.scope === className);
        lines.push(`// Class ${className}`);
        for (const constant of classConstants) {
            if (count++ >= maxTotal) break;
            lines.push(`${className}.${constant.name} = ${constant.value}`);
        }
    }

    lines.push('--- End File Constants ---');
    const result = lines.join('\n');
    return result.length > 2000 ? `${result.substring(0, 2000)}\n...(truncated)` : result;
}

export function formatResolvedConstantsContext(constants: ResolvedConstant[]): string | undefined {
    if (constants.length === 0) return undefined;

    const lines = ['--- File Constants (resolved from AST/import graph) ---'];
    for (const constant of constants) {
        lines.push(`${constant.key} = ${constant.value}`);
    }
    lines.push('--- End File Constants ---');
    return lines.join('\n');
}

export interface GraphQLDocumentDefinition {
    symbolName: string;
    operationType: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';
    operationName: string;
    rootField: string;
    sourceFile: string;
}

export function extractGraphQLDocumentsFromSource(source: string, filePath: string): GraphQLDocumentDefinition[] {
    const matches = [...source.matchAll(/(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:gql|graphql)\s*`([\s\S]*?)`/g)];
    const docs: GraphQLDocumentDefinition[] = [];

    for (const match of matches) {
        const symbolName = match[1];
        const document = match[2] ?? '';
        const operation = document.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (!operation) continue;

        const operationType = operation[1].toUpperCase() as GraphQLDocumentDefinition['operationType'];
        const operationName = operation[2];
        const bodyStart = document.indexOf('{');
        if (bodyStart === -1) continue;

        const body = document.slice(bodyStart + 1).replace(/#[^\n]*/g, '');
        const rootFieldMatch = body.match(/(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|\{)/);
        const rootField = rootFieldMatch?.[1];
        if (!rootField || rootField.startsWith('__')) continue;

        docs.push({ symbolName, operationType, operationName, rootField, sourceFile: filePath });
    }

    return docs;
}

export type BasenameSuffixIndex = Map<string, string[]>;

export function buildBasenameSuffixIndex(allFilePaths: Set<string>): BasenameSuffixIndex {
    const index = new Map<string, string[]>();
    for (const fp of allFilePaths) {
        const base = path.posix.basename(fp).replace(/\.(ts|tsx|js|jsx)$/, '');
        if (!index.has(base)) index.set(base, []);
        index.get(base)!.push(fp);
    }
    return index;
}

export function resolveAliasedImport(
    importSource: string,
    allFilePaths: Set<string>,
    basenameIndex: BasenameSuffixIndex,
): string | null {
    if (importSource.startsWith('.') || importSource.startsWith('/')) return null;
    
    // Strip @ scope: @apps/api/foo → apps/api/foo
    const stripped = importSource.startsWith('@') 
        ? importSource.slice(1) 
        : importSource;
    const segments = stripped.split('/');
    
    // Skip scoped npm packages: @zodios/core (2 segments) vs @apps/api/foo (3+)
    if (segments.length < 3) return null;
    
    // Fast path: try direct resolution (alias = directory layout)
    const EXTS = ['.ts', '.tsx', '.js', '.jsx'];
    for (const ext of EXTS) {
        if (allFilePaths.has(stripped + ext)) return stripped + ext;
    }
    
    // Suffix resolution via basename index
    const basename = segments[segments.length - 1];
    const candidates = basenameIndex.get(basename);
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    
    // Disambiguate: score candidates by how many import segments they contain
    let bestMatch: string | null = null;
    let bestScore = 0;
    
    for (const candidate of candidates) {
        let score = 0;
        for (const seg of segments) {
            if (candidate.includes('/' + seg + '/') || candidate.startsWith(seg + '/') || candidate.endsWith('/' + seg)) {
                score++;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
        }
    }
    
    return bestMatch;
}

export function resolveImportSourceForFile(
    importSource: string,
    fromFile: string,
    allFilePaths: Set<string>,
    basenameIndex?: BasenameSuffixIndex,
): string | null {
    // Fast path: PHP PSR-4 (and similar) language plugins return import sources
    // already resolved to a repo-relative file path with extension. Hit the set
    // directly before the relative or alias resolution branches.
    if (allFilePaths.has(importSource)) return importSource;

    if (importSource.startsWith('.')) {
        const dir = path.posix.dirname(fromFile);
        const resolved = path.posix.normalize(path.posix.join(dir, importSource));
        const candidates = [
            resolved,
            `${resolved}.ts`,
            `${resolved}.tsx`,
            `${resolved}.js`,
            `${resolved}.jsx`,
            `${resolved}/index.ts`,
            `${resolved}/index.tsx`,
            `${resolved}/index.js`,
            `${resolved}/index.jsx`,
        ];

        for (const candidate of candidates) {
            if (allFilePaths.has(candidate)) return candidate;
        }
        return null;
    }

    if (basenameIndex) {
        return resolveAliasedImport(importSource, allFilePaths, basenameIndex);
    }
    
    return null;
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildClientBindingContext(
    analysisTask: AnalysisTask,
    registry: Map<string, ClientBinding>,
): string | undefined {
    if (registry.size === 0) return undefined;

    // Delegate token-injection recognition to the language plugin. Each plugin
    // owns its own DI convention (TS @Inject, PHP type-hinted properties, …)
    // — the pipeline core stays language-agnostic.
    const plugin = getLanguagePlugin(analysisTask.chunk.language);
    if (!plugin?.recognizesInjectedToken) return undefined;

    const constructorSource = analysisTask.constructorSource ?? '';
    const classProperties = analysisTask.classProperties ?? [];
    if (!constructorSource && classProperties.length === 0) return undefined;

    const lines: string[] = [];
    for (const [token, binding] of registry.entries()) {
        if (!plugin.recognizesInjectedToken(token, constructorSource, classProperties)) continue;
        lines.push(
            `${token} -> ${binding.clientKind} ${binding.protocol}` +
            `${binding.baseUrlHint ? ` baseUrl=${binding.baseUrlHint}` : ''}`,
        );
    }

    if (lines.length === 0) return undefined;
    return `--- Client Bindings (resolved from provider factories) ---\n${lines.join('\n')}\n--- End Client Bindings ---`;
}

export function buildGraphQLDocumentContext(
    analysisTask: AnalysisTask,
    fileImportMap: FileImportMap | undefined,
    allFilePaths: Set<string>,
    docsByFile: Map<string, GraphQLDocumentDefinition[]>,
): string | undefined {
    if (!fileImportMap) return undefined;

    const lines: string[] = [];
    for (const imp of fileImportMap.imports) {
        if (imp.isExternal) continue;
        const resolvedFile = resolveImportSourceForFile(imp.source, fileImportMap.filePath, allFilePaths);
        if (!resolvedFile) continue;
        const docs = docsByFile.get(resolvedFile);
        if (!docs || docs.length === 0) continue;

        for (const specifier of imp.specifiers) {
            if (specifier === '*' || specifier === 'default') continue;
            if (!new RegExp(`\\b${escapeRegex(specifier)}\\b`).test(analysisTask.chunk.sourceCode)) continue;
            const doc = docs.find(candidate => candidate.symbolName === specifier);
            if (!doc) continue;
            lines.push(`${specifier} -> GRAPHQL ${doc.operationType} ${doc.rootField} (document=${doc.operationName})`);
        }
    }

    if (lines.length === 0) return undefined;
    return `--- Imported GraphQL Documents (resolved from local files) ---\n${lines.join('\n')}\n--- End Imported GraphQL Documents ---`;
}

export function collectResolvedConstantsForTask(
    analysisTask: AnalysisTask,
    fileImportMap: FileImportMap | undefined,
    allFilePaths: Set<string>,
    constantsByFile: Map<string, Array<{ scope: string; name: string; value: string }>>,
    basenameIndex?: BasenameSuffixIndex,
): ResolvedConstant[] {
    const out: ResolvedConstant[] = [];
    const seen = new Set<string>();

    const pushConstant = (constant: ResolvedConstant) => {
        if (seen.has(constant.key)) return;
        seen.add(constant.key);
        out.push(constant);
    };

    const localConstants = constantsByFile.get(analysisTask.fileContext.relativePath) ?? [];
    for (const constant of localConstants) {
        const scopedKey = constant.scope ? `${constant.scope}.${constant.name}` : constant.name;
        if (!constant.scope && hasSourceReference(analysisTask.chunk.sourceCode, constant.name)) {
            pushConstant({
                key: scopedKey,
                value: constant.value,
                source: 'local',
                sourceFile: analysisTask.fileContext.relativePath,
            });
            continue;
        }

        for (const key of constantContextKeys(constant, deriveClassName(analysisTask.chunk.name))) {
            if (!hasSourceReference(analysisTask.chunk.sourceCode, key)) continue;
            pushConstant({
                key: key === constant.name ? scopedKey : key,
                value: constant.value,
                source: 'local',
                sourceFile: analysisTask.fileContext.relativePath,
            });
        }
    }

    if (!fileImportMap) return out;

    for (const imp of fileImportMap.imports) {
        if (imp.isExternal) continue;
        const resolvedFile = resolveImportSourceForFile(imp.source, fileImportMap.filePath, allFilePaths, basenameIndex);
        if (!resolvedFile) continue;
        const importedConstants = constantsByFile.get(resolvedFile) ?? [];
        if (importedConstants.length === 0) continue;

        const bindings = imp.specifierBindings && imp.specifierBindings.length > 0
            ? imp.specifierBindings
            : imp.specifiers.map(specifier => ({
                imported: specifier,
                local: specifier,
                kind: 'named' as const,
            }));

        for (const binding of bindings) {
            // ── Default imports ──────────────────────────────────────────
            // import Config from './MessageBus.config'
            // → Match ALL scoped constants from the file via Config.prop / this.config.prop
            if (binding.kind === 'default') {
                const scopedConstants = importedConstants.filter(c => c.scope !== '');
                for (const constant of scopedConstants) {
                    for (const key of [`${binding.local}.${constant.name}`, `this.${binding.local}.${constant.name}`]) {
                        if (!hasSourceReference(analysisTask.chunk.sourceCode, key)) continue;
                        pushConstant({
                            key,
                            value: constant.value,
                            source: 'imported',
                            sourceFile: resolvedFile,
                        });
                    }
                }
                continue;
            }

            if (binding.kind !== 'named') continue;

            const directConstant = importedConstants.find(candidate =>
                candidate.scope === '' && candidate.name === binding.imported,
            );
            if (directConstant && hasSourceReference(analysisTask.chunk.sourceCode, binding.local)) {
                pushConstant({
                    key: binding.local,
                    value: directConstant.value,
                    source: 'imported',
                    sourceFile: resolvedFile,
                });
            }

            const scopedConstants = importedConstants.filter(candidate => candidate.scope === binding.imported);
            for (const constant of scopedConstants) {
                // PHP cross-class const reference uses `::`. The other two forms
                // cover TS/JS imports (X.Y) and method-property access (this.X.Y).
                for (const key of [
                    `${binding.local}.${constant.name}`,
                    `this.${binding.local}.${constant.name}`,
                    `${binding.local}::${constant.name}`,
                ]) {
                    if (!hasSourceReference(analysisTask.chunk.sourceCode, key)) continue;
                    pushConstant({
                        key,
                        value: constant.value,
                        source: 'imported',
                        sourceFile: resolvedFile,
                    });
                }
            }
        }
    }

    return out;
}

export type TypeDefinitionIndex = Map<string, DataStructureDefinition>;
export type FuncTypeRefsMap = Map<string, Map<string, string[]>>;

/**
 * Phase 1 (Fix #1) — per-file, per-chunk AST-resolved payload candidates.
 * Outer key: file relative path. Inner key: chunk name.
 */
export type FuncPayloadRefsMap = Map<string, Map<string, AstResolvedPayload[]>>;

const MAX_TYPE_INJECTIONS_PER_CHUNK = 3;
const MAX_PROPERTIES_PER_TYPE = 20;

export function formatTypeDefinitions(
    chunkName: string,
    typeDefIndex: TypeDefinitionIndex,
    funcTypeRefs: FuncTypeRefsMap,
    filePath: string,
): string | undefined {
    const fileRefs = funcTypeRefs.get(filePath);
    if (!fileRefs) return undefined;

    const referencedTypes = fileRefs.get(chunkName);
    if (!referencedTypes || referencedTypes.length === 0) return undefined;

    const resolved: string[] = [];
    for (const typeName of referencedTypes) {
        if (resolved.length >= MAX_TYPE_INJECTIONS_PER_CHUNK) break;

        const definition = typeDefIndex.get(typeName);
        if (!definition) continue;

        const properties = definition.properties.slice(0, MAX_PROPERTIES_PER_TYPE);
        const propertyLines = properties.map(property => `    ${property.name}: ${property.type};`).join('\n');
        const truncated = definition.properties.length > MAX_PROPERTIES_PER_TYPE
            ? `\n    // ... ${definition.properties.length - MAX_PROPERTIES_PER_TYPE} more properties`
            : '';
        resolved.push(`${definition.kind} ${definition.name} {\n${propertyLines}${truncated}\n}`);
    }

    if (resolved.length === 0) return undefined;
    return `\n--- Associated Data Structures (cross-file resolution) ---\n${resolved.join('\n\n')}\n--- End Data Structures ---`;
}
