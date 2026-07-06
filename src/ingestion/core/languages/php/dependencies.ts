import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { logger } from '../../../../utils/logger.js';
import type { DependencyMapping, ManifestDependency, PackageDependency } from '../types.js';

/**
 * Composer "platform packages" (php, hhvm, ext-*, lib-*, composer-*-api) are
 * runtime constraints, not registry packages — they have no publisher, no
 * releases, and no OSV entries. Pattern per Composer's PlatformRepository.
 */
const COMPOSER_PLATFORM_PACKAGE = /^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|(?:ext|lib)-[a-z0-9](?:[_.-]?[a-z0-9]+)*|composer(?:-(?:plugin|runtime)-api)?)$/i;

export function isComposerPlatformPackage(packageName: string): boolean {
    return COMPOSER_PLATFORM_PACKAGE.test(packageName);
}

/**
 * Parse a composer.json's declared dependencies (require / require-dev),
 * excluding platform packages. Returns [] for malformed JSON.
 */
export function parseComposerManifestDependencies(fileContent: string): ManifestDependency[] {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(fileContent) as Record<string, unknown>;
    } catch (err) {
        logger.warn(`(dependencies) Failed to parse composer.json: ${(err as Error).message}`);
        return [];
    }

    const collect = (deps: Record<string, string>, isDev: boolean): ManifestDependency[] =>
        Object.entries(deps)
            .filter(([name]) => !isComposerPlatformPackage(name))
            .map(([name, requiredVersion]) => ({ ecosystem: 'composer', name, requiredVersion, isDev }));

    return [
        ...collect((parsed.require ?? {}) as Record<string, string>, false),
        ...collect((parsed['require-dev'] ?? {}) as Record<string, string>, true),
    ];
}

export function loadPhpDependencyMappings(repoRoot: string): DependencyMapping[] {
    const composerPath = path.join(repoRoot, 'composer.json');
    if (!fs.existsSync(composerPath)) return [];

    try {
        const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
        const psr4: Record<string, unknown> = composer?.autoload?.['psr-4'] ?? {};

        // Composer allows a prefix to map to one directory OR an ordered list
        // of directories ("Acme\\": ["lib/Acme/", "src/Acme/"]). Expand to one
        // mapping per directory; resolution probes them in declaration order.
        return Object.entries(psr4)
            .flatMap(([prefix, value]) => {
                const directories = Array.isArray(value) ? value : [value];
                return directories
                    .filter((dir): dir is string => typeof dir === 'string')
                    .map(directory => ({ prefix, directory }));
            })
            .sort((left, right) => right.prefix.length - left.prefix.length);
    } catch {
        return [];
    }
}

/**
 * Relative directory paths this composer.json declares as local path
 * dependencies (`repositories: [{type: "path", url: "..."}]`). Composer
 * supports both the array and the object form of `repositories`, and glob
 * urls (`contexts/*`) — globs are returned verbatim for the caller to match.
 *
 * A root manifest vendoring its own sub-workspaces this way is the Composer
 * idiom for "monolith with internal libraries"; autodiscovery consumes this
 * signal to rescue such roots from child-wins pruning.
 */
export function loadPhpLocalPathDependencies(manifestDir: string): string[] {
    const composerPath = path.join(manifestDir, 'composer.json');
    if (!fs.existsSync(composerPath)) return [];

    try {
        const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
        const repositories = composer?.repositories;
        const entries = Array.isArray(repositories)
            ? repositories
            : repositories && typeof repositories === 'object'
                ? Object.values(repositories)
                : [];

        return entries
            .filter((r): r is { type: string; url: string } =>
                !!r && typeof r === 'object'
                && (r as { type?: unknown }).type === 'path'
                && typeof (r as { url?: unknown }).url === 'string')
            .map(r => r.url.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
            .filter(url => url.length > 0);
    } catch {
        return [];
    }
}

export function parseComposerLock(lockPath: string, map: Map<string, string>): void {
    try {
        const lockContent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

        if (lockContent.packages) {
            for (const pkg of lockContent.packages) {
                if (pkg.name && pkg.version) {
                    map.set(pkg.name, pkg.version);
                }
            }
        }

        if (lockContent['packages-dev']) {
            for (const pkg of lockContent['packages-dev']) {
                if (pkg.name && pkg.version) {
                    map.set(pkg.name, pkg.version);
                }
            }
        }
    } catch (error) {
        logger.debug(`(lockfile) Failed to parse composer.lock at ${lockPath}: ${(error as Error).message}`);
    }
}

export async function extractPhpDependencies(repoPath: string): Promise<PackageDependency[]> {
    const results: PackageDependency[] = [];

    const composerJsons = await glob('**/composer.json', {
        cwd: repoPath,
        absolute: true,
        ignore: ['**/vendor/**'],
    });

    for (const composerJsonPath of composerJsons) {
        try {
            const directory = path.dirname(composerJsonPath);
            const content = JSON.parse(fs.readFileSync(composerJsonPath, 'utf8'));
            const dependencies: Record<string, string> = content.require || {};
            const devDependencies: Record<string, string> = content['require-dev'] || {};

            const lockfileMap = new Map<string, string>();
            const composerLockPath = path.join(directory, 'composer.lock');
            if (fs.existsSync(composerLockPath)) {
                parseComposerLock(composerLockPath, lockfileMap);
            }

            for (const [name, declaredRange] of Object.entries(dependencies)) {
                if (isComposerPlatformPackage(name)) continue;
                results.push({
                    name,
                    ecosystem: 'composer',
                    declaredRange,
                    lockedVersion: lockfileMap.get(name) || null,
                    isDev: false,
                });
            }

            for (const [name, declaredRange] of Object.entries(devDependencies)) {
                if (isComposerPlatformPackage(name)) continue;
                results.push({
                    name,
                    ecosystem: 'composer',
                    declaredRange,
                    lockedVersion: lockfileMap.get(name) || null,
                    isDev: true,
                });
            }
        } catch (error) {
            logger.debug(`(lockfile) Failed to parse composer.json at ${composerJsonPath}: ${(error as Error).message}`);
        }
    }

    return results;
}
