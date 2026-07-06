/**
 * Diagnose why taint propagation produces `untainted` for files that import
 * a tainted local file. Loads a repo, runs the full taint pass, and prints
 * the FileTaintInfo for each requested file.
 *
 * Usage: bun run scripts/diag-taint-di-adapter.ts <repo-path> <file-pattern...>
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from '../src/ingestion/processors/parser/index.js';
import { getLanguagePlugin, getPluginForExtension } from '../src/ingestion/core/languages/registry.js';
import {
    buildImportGraph,
    propagateTaints,
    buildSinkRegistry,
    type FileImportMap,
} from '../src/ingestion/core/import-graph.js';
import type { ImportContext } from '../src/ingestion/core/languages/types.js';

const repoRoot = process.argv[2];
const patterns = process.argv.slice(3);
if (!repoRoot || patterns.length === 0) {
    console.error('usage: bun run scripts/diag-taint-di-adapter.ts <repo-path> <file-substring...>');
    process.exit(2);
}

// Discover all PHP files under repoRoot/src and classes
function walk(dir: string, accum: string[]): void {
    if (!fs.existsSync(dir)) return;
    try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'vendor' || entry.name === 'node_modules' || entry.name === 'tests') continue;
            walk(full, accum);
        } else if (entry.name.endsWith('.php')) {
            accum.push(full);
        }
    }
}

const absRoots = ['src', 'classes', 'console', 'cron', 'workers', 'www'].map(d => path.posix.join(repoRoot, d));
const allFilesAbs: string[] = [];
for (const root of absRoots) walk(root, allFilesAbs);
const allFilesRel = new Set(allFilesAbs.map(f => path.posix.relative(repoRoot, f)));
console.log(`# discovered ${allFilesRel.size} PHP files`);

// Load PHP dependency mappings
const phpPlugin = getLanguagePlugin('php')!;
const dependencyMappings = phpPlugin.loadDependencyMappings(repoRoot);
console.log(`# psr-4: ${JSON.stringify(dependencyMappings.map(d => `${d.prefix} -> ${d.directory}`))}`);

// Extract imports per file
const fileImportMaps: FileImportMap[] = [];
const ctx: ImportContext = { allFilePaths: allFilesRel, dependencyMappings, allowAbsolute: false };
let extractedCount = 0;
for (const absPath of allFilesAbs) {
    const relPath = path.posix.relative(repoRoot, absPath);
    try {
        const tree = parseFile(absPath, fs.readFileSync(absPath, 'utf-8'), 'php');
        if (!tree?.rootNode) continue;
        const imports = phpPlugin.extractImports(tree.rootNode, ctx);
        const exportedSymbols = phpPlugin.extractExports(tree.rootNode);
        const implementsFiles = phpPlugin.extractImplementsFiles?.(tree.rootNode, ctx) ?? [];
        fileImportMaps.push({ filePath: relPath, imports, exportedSymbols, implementsFiles });
        extractedCount++;
    } catch (err) {
        // ignore parse errors
    }
}
console.log(`# extracted imports for ${extractedCount} files`);

// Run taint propagation
const sinkRegistry = buildSinkRegistry(repoRoot);
const graph = buildImportGraph(fileImportMaps, allFilesRel);
const taintMap = propagateTaints(fileImportMaps, new Map(), [], graph, sinkRegistry);

// Print info for requested file patterns
for (const pattern of patterns) {
    console.log();
    console.log(`# === files matching "${pattern}" ===`);
    for (const fm of fileImportMaps) {
        if (!fm.filePath.includes(pattern)) continue;
        const taint = taintMap.get(fm.filePath);
        const tainted = !!taint && taint.taintedSymbols.size > 0;
        const externalImports = fm.imports.filter(i => i.isExternal).map(i => i.source);
        const localImports = fm.imports.filter(i => !i.isExternal).map(i => i.source);
        console.log(`  ${fm.filePath}`);
        console.log(`    exports: [${fm.exportedSymbols.join(', ')}]`);
        console.log(`    external imports: [${externalImports.slice(0, 6).join(', ')}${externalImports.length > 6 ? '…' : ''}]`);
        console.log(`    local imports: [${localImports.slice(0, 6).join(', ')}${localImports.length > 6 ? '…' : ''}]`);
        console.log(`    tainted? ${tainted ? 'YES' : 'no'}  symbols=[${[...taint?.taintedSymbols ?? []].join(', ')}]`);
    }
}
