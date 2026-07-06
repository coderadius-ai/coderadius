import fs from 'node:fs';
import path from 'node:path';
import type { FileImportMap } from '../../core/import-graph.js';
import type { ValueResolutionIndexInput } from '../../core/value-resolution/index.js';
import { CONFIG_VALUE_PROVIDERS } from '../../core/config-value-providers/index.js';
import { getLanguagePlugin } from '../../core/languages/registry.js';
import { isConfigFile } from '../../core/config-file-detector.js';
import { parseFile } from '../parser/index.js';
import type { DiscoveryResult } from './types.js';
import { logger } from '../../../utils/logger.js';

const MAX_CONFIG_FILE_BYTES = 512 * 1024;
const MAX_FACTS_PER_CONFIG_FILE = 500;

export interface ConfigValueCollectionResult {
    inputs: ValueResolutionIndexInput[];
    virtualImportMaps: FileImportMap[];
}

export function collectConfigValueFacts(
    discoveryResult: DiscoveryResult,
    alreadyParsedFiles: Set<string> = new Set(),
): ConfigValueCollectionResult {
    const inputs: ValueResolutionIndexInput[] = [];
    const allPaths = [...discoveryResult.allFilePaths].sort();

    for (const relativePath of allPaths) {
        const basename = path.posix.basename(relativePath);
        const ext = path.posix.extname(relativePath).toLowerCase();
        const absolutePath = path.join(discoveryResult.repo.path, relativePath);

        // PHP files already processed by the main code pipeline get their
        // tree-sitter pass through `collectPhpConfigFacts` skipped (the main
        // pipeline already extracted their facts). However the CONFIG_VALUE_PROVIDER
        // loop below MUST still run on them, because the providers detect
        // patterns the main pipeline can't (e.g. a CQRS message-class routing
        // table embedded in a regular service class).
        const skipPhpTreeSitter = alreadyParsedFiles.has(relativePath) && ext === '.php';
        if (!skipPhpTreeSitter && !shouldInspectConfigFile(relativePath, basename, ext)) continue;
        if (skipPhpTreeSitter && !CONFIG_VALUE_PROVIDERS.some(p => p.matchFile(relativePath, basename))) continue;

        const stat = safeStat(absolutePath);
        if (!stat || stat.size > MAX_CONFIG_FILE_BYTES) continue;

        if (ext === '.php' && !skipPhpTreeSitter) {
            const input = collectPhpConfigFacts(absolutePath, relativePath);
            if (input) inputs.push(input);
        }

        if (ext === '.yaml' || ext === '.yml' || ext === '.php') {
            const content = safeReadFile(absolutePath);
            if (content === null) continue;
            for (const provider of CONFIG_VALUE_PROVIDERS) {
                if (!provider.matchFile(relativePath, basename)) continue;
                try {
                    const facts = provider.extractValueFacts(content, {
                        relativePath,
                        repoRoot: discoveryResult.repo.path,
                        repoName: discoveryResult.repo.name,
                    }).slice(0, MAX_FACTS_PER_CONFIG_FILE);
                    if (facts.length > 0) {
                        inputs.push({
                            filePath: relativePath,
                            valueFacts: facts,
                            criticalInvocations: [],
                        });
                    }
                } catch (err) {
                    logger.debug(`[ConfigValueProvider:${provider.id}] Failed for ${relativePath}: ${(err as Error).message}`);
                }
            }
        }
    }

    return { inputs, virtualImportMaps: [] };
}

function shouldInspectConfigFile(relativePath: string, basename: string, ext: string): boolean {
    if (ext === '.php') return isConfigFile(relativePath) || /(?:^|\/)config\/[^/]+\.php$/i.test(relativePath);
    if (ext !== '.yaml' && ext !== '.yml') return false;
    return CONFIG_VALUE_PROVIDERS.some(provider => provider.matchFile(relativePath, basename));
}

function collectPhpConfigFacts(absolutePath: string, relativePath: string): ValueResolutionIndexInput | null {
    try {
        const parsed = parseFile(absolutePath, relativePath);
        if (!parsed.rootNode) return null;
        const plugin = getLanguagePlugin(parsed.language);
        if (!plugin?.extractValueFacts) return null;
        const content = fs.readFileSync(absolutePath, 'utf-8');
        const facts = plugin.extractValueFacts(parsed.rootNode, content, relativePath).slice(0, MAX_FACTS_PER_CONFIG_FILE);
        if (facts.length === 0) return null;
        return {
            filePath: relativePath,
            valueFacts: facts,
            criticalInvocations: [],
        };
    } catch (err) {
        logger.debug(`[ConfigValueProvider:php-config] Failed for ${relativePath}: ${(err as Error).message}`);
        return null;
    }
}

function safeStat(absolutePath: string): fs.Stats | null {
    try {
        return fs.statSync(absolutePath);
    } catch {
        return null;
    }
}

function safeReadFile(absolutePath: string): string | null {
    try {
        return fs.readFileSync(absolutePath, 'utf-8');
    } catch {
        return null;
    }
}
