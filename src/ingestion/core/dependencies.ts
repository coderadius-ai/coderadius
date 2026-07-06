import path from 'node:path';
import { getAllPlugins } from './languages/registry.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DependencyEntry {
    ecosystem: string;
    name: string;
    requiredVersion: string;
    isDev: boolean;
    isInternal: boolean;
}

// ─── Internal Package Detection ──────────────────────────────────────────────

/**
 * Derives npm scopes (@org/) and composer vendor prefixes (vendor/) from
 * known internal names, then checks if the target package matches either
 * by exact name or by sharing a scope/vendor prefix.
 *
 * This makes internal detection entirely emergent — no static configuration required.
 */
export function isInternalPackage(
    packageName: string,
    knownInternalNames: Set<string>,
): boolean {
    // Exact match: package name IS a known service/library
    if (knownInternalNames.has(packageName)) {
        return true;
    }

    // Emergent prefix match: derive scopes/vendors from known internals
    for (const known of knownInternalNames) {
        // npm scope: @scope/pkg → prefix = @scope/
        if (known.startsWith('@')) {
            const scopeEnd = known.indexOf('/');
            if (scopeEnd !== -1) {
                const scope = known.substring(0, scopeEnd + 1);
                if (packageName.startsWith(scope)) {
                    return true;
                }
            }
        }

        // Composer vendor: vendor/pkg → prefix = vendor/
        if (known.includes('/') && !known.startsWith('@')) {
            const vendorEnd = known.indexOf('/');
            const vendor = known.substring(0, vendorEnd + 1);
            if (packageName.startsWith(vendor)) {
                return true;
            }
        }
    }

    return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a dependency manifest and return a structured list of dependencies.
 *
 * Manifest recognition and parsing are delegated to the language plugins
 * (`parseManifestDependencies`); this layer only stamps the language-neutral
 * internal-package flag.
 *
 * @param filepath     Absolute or relative path to the file (basename routes to the owning plugin).
 * @param fileContent  Raw file content as a string.
 * @param knownInternalNames  Set of package names already known to be internal
 *                            (e.g. names of Services / Libraries in the graph).
 */
export function extractDependencies(
    filepath: string,
    fileContent: string,
    knownInternalNames: Set<string>,
): DependencyEntry[] {
    const fileName = path.basename(filepath);

    for (const plugin of getAllPlugins()) {
        const entries = plugin.parseManifestDependencies?.(fileName, fileContent);
        if (entries) {
            return entries.map(entry => ({
                ...entry,
                isInternal: isInternalPackage(entry.name, knownInternalNames),
            }));
        }
    }

    return [];
}
