// ═══════════════════════════════════════════════════════════════════════════════
// DiBindingCollector — Iterates DI_BINDING_PROVIDERS over the repo's
// discovered files, applies the (mandatory) contentSignatures gate, and
// emits `RawDiBinding[]` for the DiBindingResolver.
//
// Sibling of `collectConfigValueFacts`. Separated because:
//   - Output shape differs (RawDiBinding vs ValueFact)
//   - The contentSignatures gate is REQUIRED here (not optional)
//   - Future cross-lang providers (Laravel, NestJS) need a stable seam
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import {
    DI_BINDING_PROVIDERS,
    type RawDiBinding,
} from '../../core/di-binding-providers/index.js';
import type { DiscoveryResult } from './types.js';
import { logger } from '../../../utils/logger.js';

const MAX_DI_CONFIG_FILE_BYTES = 512 * 1024;

export interface DiBindingCollectionResult {
    bindings: RawDiBinding[];
    /** Files matched by a provider — used by Step 2 cache invalidation. */
    matchedFiles: Set<string>;
}

export function collectDiBindings(
    discoveryResult: DiscoveryResult,
): DiBindingCollectionResult {
    const bindings: RawDiBinding[] = [];
    const matchedFiles = new Set<string>();

    if (DI_BINDING_PROVIDERS.length === 0) {
        return { bindings, matchedFiles };
    }

    for (const relativePath of discoveryResult.allFilePaths) {
        const basename = path.posix.basename(relativePath);

        // Find providers that match the file path
        const candidates = DI_BINDING_PROVIDERS.filter(p =>
            p.matchFile(relativePath, basename),
        );
        if (candidates.length === 0) continue;

        const absolutePath = path.join(discoveryResult.repo.path, relativePath);
        const stat = safeStat(absolutePath);
        if (!stat || stat.size > MAX_DI_CONFIG_FILE_BYTES) continue;

        const content = safeReadFile(absolutePath);
        if (content === null) continue;

        let fileWasMatched = false;
        for (const provider of candidates) {
            // contentSignatures gate (REQUIRED for DiBindingProvider).
            // At least one signature must match the content to keep the
            // file in scope. Avoids paying parse cost on every PHP/YAML.
            const signaturePassed = provider.contentSignatures.some(sig => sig.test(content));
            if (!signaturePassed) continue;

            try {
                const out = provider.extractDiBindings(content, {
                    relativePath,
                    repoRoot: discoveryResult.repo.path,
                    repoName: discoveryResult.repo.name,
                });
                if (out.length > 0) {
                    bindings.push(...out);
                    fileWasMatched = true;
                }
            } catch (err) {
                logger.debug(
                    `[DiBindingProvider:${provider.id}] Failed for ${relativePath}: ${(err as Error).message}`,
                );
            }
        }

        if (fileWasMatched) matchedFiles.add(relativePath);
    }

    return { bindings, matchedFiles };
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
