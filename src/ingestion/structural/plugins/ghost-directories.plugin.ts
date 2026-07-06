import fs from 'node:fs';
import path from 'node:path';
import type { DirectoryPlugin, StructuralExtractionResult } from '../types.js';
import type { DiscoveredService } from '../../extractors/autodiscovery.js';
import type { ScopeManager } from '../../core/scope-manager.js';
import { buildUrn } from '../../../graph/urn.js';
import { logger } from '../../../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Ghost Directories Plugin — Register excluded directories in the graph
//
// Scans the repository for directories that are excluded from LLM analysis
// (tests, docs, e2e) and registers them as ProjectDirectory nodes.
// This allows querying the graph for compliance checks like
// "does this repo have a tests/ directory?" without analyzing content.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ghost directory patterns and their categories.
 * Categories are aligned with the user's compliance requirements.
 */
const GHOST_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
    // Tests
    { pattern: /^tests?$/i,         category: 'Tests' },
    { pattern: /^__tests__$/i,      category: 'Tests' },
    { pattern: /^spec$/i,           category: 'Tests' },

    // E2E Tests
    { pattern: /^e2e$/i,            category: 'E2ETests' },
    { pattern: /^cypress$/i,        category: 'E2ETests' },
    { pattern: /^playwright$/i,     category: 'E2ETests' },

    // Documentation
    { pattern: /^docs?$/i,          category: 'Documentation' },
    { pattern: /^adr$/i,            category: 'Documentation' },
    { pattern: /^architecture$/i,   category: 'Documentation' },
];

/** Directories to ignore during scanning. */
const SKIP_DIRS = new Set([
    'node_modules', 'vendor', '.git', 'dist', 'build',
    '.next', '.nuxt', 'out', 'coverage', '__pycache__',
    '.venv', 'venv', 'target', '.gradle', '.idea', '.vscode',
]);

export const ghostDirectoriesPlugin: DirectoryPlugin = {
    name: 'ghost-directories',
    label: 'Ghost Directories',
    managedLabels: ['ProjectDirectory'],

    scan(
        repoPath: string,
        repoName: string,
        repoUrn: string,
        scopeManager: ScopeManager,
        serviceRoots: DiscoveredService[] = []
    ): StructuralExtractionResult {
        const entities: StructuralExtractionResult['entities'] = [];
        const found: string[] = [];

        // Scan top-level directories (these belong to the Repository)
        scanLevel(repoPath, '', repoName, entities, found, scopeManager, repoPath, undefined);

        // Scan known service roots (handles monoliths and standard monorepos)
        for (const svc of serviceRoots) {
            if (svc.path === repoPath) continue; // Already scanned root
            
            const relPrefix = path.relative(repoPath, svc.path);
            
            // Skip services that don't belong to the current repository
            if (relPrefix.startsWith('..') || path.isAbsolute(relPrefix)) continue;
            
            if (scopeManager.isOmitted(svc.path, repoPath)) continue;

            scanLevel(svc.path, relPrefix, repoName, entities, found, scopeManager, repoPath, svc.name);
        }

        // Scan standard monorepo patterns as fallback
        const SERVICE_DIRS = ['apps', 'packages', 'services'];
        for (const serviceParent of SERVICE_DIRS) {
            const parentPath = path.join(repoPath, serviceParent);
            if (!isDirectory(parentPath)) continue;

            // If the service parent itself is ignored (e.g., /apps in .crignore), skip
            if (scopeManager.isOmitted(parentPath, repoPath)) continue;

            try {
                const serviceEntries = fs.readdirSync(parentPath, { withFileTypes: true });
                for (const entry of serviceEntries) {
                    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
                    const servicePath = path.join(parentPath, entry.name);
                    const serviceRelPrefix = path.join(serviceParent, entry.name);
                    
                    // Skip if this specific service/package is ignored
                    if (scopeManager.isOmitted(servicePath, repoPath)) continue;

                    const serviceName = entry.name;
                    scanLevel(servicePath, serviceRelPrefix, repoName, entities, found, scopeManager, repoPath, serviceName);
                }
            } catch {
                // Skip unreadable directories
            }
        }

        if (entities.length === 0) {
            return { entities: [], summary: 'No ghost directories found' };
        }

        // Group by category for a concise summary
        const byCategory = new Map<string, string[]>();
        for (const e of entities) {
            const cat = e.properties.category as string;
            if (!byCategory.has(cat)) byCategory.set(cat, []);
            byCategory.get(cat)!.push(e.properties.path as string);
        }

        const isDebug = logger.isDebugEnabled();
        const parts = Array.from(byCategory.entries())
            .map(([cat, paths]) => {
                if (!isDebug && paths.length > 5) {
                    const shown = paths.slice(0, 5).join(', ');
                    return `${cat}: ${shown} (+ ${paths.length - 5} more)`;
                }
                return `${cat}: ${paths.join(', ')}`;
            })
            .join(' | ');

        return {
            entities,
            summary: `${entities.length} ghost dir(s) — ${parts}`,
        };
    },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scanLevel(
    dirPath: string,
    relPrefix: string,
    repoName: string,
    entities: StructuralExtractionResult['entities'],
    found: string[],
    scopeManager: ScopeManager,
    repoPath: string,
    ownerService?: string,
): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return; // Unreadable directory
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;

        const absolutePath = path.join(dirPath, entry.name);
        const relPath = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
        const normalizedRelPath = relPath.replace(/\\/g, '/');

        // Logic: Should we report this?
        // 1. Check if it matches a Ghost pattern (tests, docs)
        const match = GHOST_PATTERNS.find(p => p.pattern.test(entry.name));
        if (!match) continue;

        // Deduplicate
        const urn = buildUrn('directory', repoName, normalizedRelPath);
        if (found.includes(urn)) continue;
        found.push(urn);

        entities.push({
            id: urn,
            labels: ['ProjectDirectory'],
            properties: {
                name: entry.name,
                path: normalizedRelPath,
                category: match.category,
                isIgnored: scopeManager.isOmitted(absolutePath, repoPath),
                _ownerService: ownerService,
            },
            relationshipType: 'CONTAINS_DIRECTORY',
        });
    }
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}
