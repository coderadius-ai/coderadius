import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { glob } from 'glob';
import { logger } from '../../../../utils/logger.js';
import type { ManifestDependency, PackageDependency } from '../types.js';

/**
 * Parse a package.json's declared dependencies (dependencies / devDependencies).
 * Returns [] for malformed JSON.
 */
export function parseNpmManifestDependencies(fileContent: string): ManifestDependency[] {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(fileContent) as Record<string, unknown>;
    } catch (err) {
        logger.warn(`(dependencies) Failed to parse package.json: ${(err as Error).message}`);
        return [];
    }

    const collect = (deps: Record<string, string>, isDev: boolean): ManifestDependency[] =>
        Object.entries(deps)
            .map(([name, requiredVersion]) => ({ ecosystem: 'npm', name, requiredVersion, isDev }));

    return [
        ...collect((parsed.dependencies ?? {}) as Record<string, string>, false),
        ...collect((parsed.devDependencies ?? {}) as Record<string, string>, true),
    ];
}

type CatalogMap = Record<string, Record<string, string>>;

const LOCKFILE_STRATEGIES: { filename: string; parse: (filePath: string, map: Map<string, string>) => void }[] = [
    { filename: 'package-lock.json', parse: parseNpmLock },
    { filename: 'yarn.lock', parse: parseYarnLock },
    { filename: 'pnpm-lock.yaml', parse: parsePnpmLock },
    { filename: 'bun.lock', parse: parseBunLock },
];

export async function extractTypeScriptDependencies(repoPath: string): Promise<PackageDependency[]> {
    const results: PackageDependency[] = [];

    const packageJsons = await glob('**/package.json', {
        cwd: repoPath,
        absolute: true,
        ignore: ['**/node_modules/**'],
        nodir: true,
    });

    const catalogs = collectWorkspaceCatalogs(repoPath);

    for (const pkgPath of packageJsons) {
        try {
            const dir = path.dirname(pkgPath);
            const content = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const lockfileMap = resolveLockfileVersions(dir, repoPath);

            const collect = (deps: Record<string, string>, isDev: boolean) => {
                for (const [name, raw] of Object.entries(deps)) {
                    const declaredRange = resolveCatalogRef(raw, name, catalogs);
                    results.push({
                        name,
                        ecosystem: 'npm',
                        declaredRange,
                        lockedVersion: lockfileMap.get(name) ?? null,
                        isDev,
                    });
                }
            };

            collect(content.dependencies ?? {}, false);
            collect(content.devDependencies ?? {}, true);
        } catch (error) {
            const isTestFixture = /\/(test|tests|fixtures|__tests__|__mocks__|e2e|system-tests)\//i.test(pkgPath);
            if (!isTestFixture) {
                logger.debug(`(lockfile) Failed to parse package.json at ${pkgPath}: ${(error as Error).message}`);
            }
        }
    }

    return results;
}

export function resolveLockfileVersions(startDir: string, repoRoot: string): Map<string, string> {
    const map = new Map<string, string>();
    const resolvedRoot = path.resolve(repoRoot);
    let dir = startDir;

    while (true) {
        for (const strategy of LOCKFILE_STRATEGIES) {
            const lockPath = path.join(dir, strategy.filename);
            if (fs.existsSync(lockPath)) {
                strategy.parse(lockPath, map);
                if (map.size > 0) return map;
            }
        }

        if (dir === resolvedRoot || path.dirname(dir) === dir) break;
        dir = path.dirname(dir);
    }

    return map;
}

export function collectWorkspaceCatalogs(repoPath: string): CatalogMap {
    const catalogs: CatalogMap = {};

    const sources: { file: string; merge: boolean }[] = [
        { file: 'pnpm-workspace.yaml', merge: false },
        { file: '.yarnrc.yml', merge: true },
    ];

    for (const { file, merge } of sources) {
        const filePath = path.join(repoPath, file);
        if (!fs.existsSync(filePath)) continue;

        try {
            const doc = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
            if (!doc || typeof doc !== 'object') continue;

            if (doc.catalog) {
                catalogs.default = merge
                    ? { ...(catalogs.default ?? {}), ...doc.catalog }
                    : doc.catalog;
            }
            if (doc.catalogs) {
                for (const [key, value] of Object.entries(doc.catalogs)) {
                    catalogs[key] = merge
                        ? { ...(catalogs[key] ?? {}), ...(value as Record<string, string>) }
                        : value as Record<string, string>;
                }
            }
        } catch (error) {
            logger.debug(`(lockfile) Failed to parse ${file}: ${(error as Error).message}`);
        }
    }

    return catalogs;
}

export function resolveCatalogRef(raw: string, name: string, catalogs: CatalogMap): string {
    if (!raw.startsWith('catalog:')) return raw;
    const catalogName = raw === 'catalog:' ? 'default' : raw.replace('catalog:', '');
    return catalogs[catalogName]?.[name] ?? raw;
}

export function parseNpmLock(lockPath: string, map: Map<string, string>): void {
    try {
        const lockContent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

        if (lockContent.packages) {
            for (const [key, value] of Object.entries(lockContent.packages as Record<string, any>)) {
                if (!key || key.length === 0) continue;
                if (key.includes('node_modules/')) {
                    const name = key.replace(/.*node_modules\//, '');
                    if (value && (value as any).version) map.set(name, (value as any).version);
                }
            }
        } else if (lockContent.dependencies) {
            for (const [name, value] of Object.entries(lockContent.dependencies as Record<string, any>)) {
                if (value && (value as any).version) map.set(name, (value as any).version);
            }
        }
    } catch (error) {
        logger.debug(`(lockfile) Failed to parse npm lockfile ${lockPath}: ${(error as Error).message}`);
    }
}

export function parseYarnLock(lockPath: string, map: Map<string, string>): void {
    try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const isBerry = content.includes('__metadata:');

        if (isBerry) {
            let currentPackage: string | null = null;
            for (const line of content.split('\n')) {
                if (!line.startsWith(' ') && line.includes('@') && line.endsWith(':')) {
                    const headerMatch = line.match(/^"?(@?[^@\s]+)@/);
                    currentPackage = headerMatch ? headerMatch[1] : null;
                } else if (currentPackage && line.match(/^\s+version:\s/)) {
                    const versionMatch = line.match(/^\s+version:\s+"?([^"\n]+)"?/);
                    if (versionMatch) {
                        map.set(currentPackage, versionMatch[1]);
                        currentPackage = null;
                    }
                }
            }
        } else {
            const classicRegex = /"?(@?[^\s@]+)@[^"]+?"?:\n\s{2}version "?([^"\n]+)"?/g;
            let match: RegExpExecArray | null;
            while ((match = classicRegex.exec(content)) !== null) {
                map.set(match[1], match[2]);
            }
        }
    } catch (error) {
        logger.debug(`(lockfile) Failed to parse yarn.lock at ${lockPath}: ${(error as Error).message}`);
    }
}

export function parsePnpmLock(lockPath: string, map: Map<string, string>): void {
    try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const lines = content.split('\n');

        const headerSlice = lines.slice(0, 5).join('\n');
        const isV9 = headerSlice.includes("lockfileVersion: '9") || headerSlice.includes('lockfileVersion: 9');

        let inPackagesSection = false;

        for (const line of lines) {
            const trimmed = line.trim();

            if (/^packages:/.test(line)) {
                inPackagesSection = true;
                continue;
            }
            if (inPackagesSection && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.length > 0) {
                if (!trimmed.startsWith('/') && !trimmed.startsWith("'") && !trimmed.includes('@')) {
                    inPackagesSection = false;
                    continue;
                }
            }

            if (!inPackagesSection) continue;

            if (isV9) {
                const match = trimmed.match(/^'?(@?[^@'\s]+)@([^':\s]+)'?:/);
                if (match) map.set(match[1], match[2]);
            } else {
                const match = trimmed.match(/^\/?(@?[^/\s]+(?:\/[^/\s]+)?)\/([^:/\s]+):/);
                if (match) map.set(match[1], match[2]);
            }
        }
    } catch (error) {
        logger.debug(`(lockfile) Failed to parse pnpm-lock.yaml at ${lockPath}: ${(error as Error).message}`);
    }
}

export function parseBunLock(lockPath: string, map: Map<string, string>): void {
    try {
        const content = fs.readFileSync(lockPath, 'utf8');

        // Bun text lockfile (v1.2+) is JSONC with trailing commas.
        // Structure: { ..., "packages": { "<name>": ["<name>@<version>", ...], ... } }
        // Strip JS-style comments (// and /* */) and trailing commas before JSON.parse.
        const stripped = content
            .replace(/\/\/.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/,\s*([}\]])/g, '$1');

        const parsed = JSON.parse(stripped);
        const packages = parsed?.packages;
        if (!packages || typeof packages !== 'object') return;

        for (const [key, value] of Object.entries(packages)) {
            // key = package name or scoped name (e.g. "react", "@types/node")
            // value = tuple: ["<name>@<version>", ...] or nested object for workspaces
            if (!Array.isArray(value) || value.length === 0) continue;
            const descriptor = value[0];
            if (typeof descriptor !== 'string') continue;

            // Extract version from "react@18.3.0" or "@types/node@22.0.0"
            const lastAt = descriptor.lastIndexOf('@');
            if (lastAt > 0) {
                const name = descriptor.substring(0, lastAt);
                const version = descriptor.substring(lastAt + 1);
                if (version && !version.startsWith('workspace:')) {
                    map.set(name, version);
                }
            }
        }
    } catch (error) {
        logger.debug(`(lockfile) Failed to parse bun.lock at ${lockPath}: ${(error as Error).message}`);
    }
}
