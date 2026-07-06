#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════════════════════
// eval-flywheel — Bug-to-Fixture Manifest Discovery
//
// Scans all tests/fixtures/*/ directories for expected.graph.yaml files
// and reports which fixtures have eval manifests and which don't.
//
// Usage:
//   npx tsx tests/eval/scripts/eval-flywheel.ts
//   npx tsx tests/eval/scripts/eval-flywheel.ts --json
//
// The flywheel rule: "Every bug on a client repo becomes a minimal fixture
// with its own expected.graph.yaml."
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { loadManifest } from '../types/eval-manifest.js';

const FIXTURES_ROOT = path.resolve(import.meta.dirname, '..', '..', 'fixtures');
const PATTERNS_ROOT = path.resolve(import.meta.dirname, '..', 'patterns');
const jsonMode = process.argv.includes('--json');

interface FixtureStatus {
    name: string;
    hasManifest: boolean;
    fixture?: string;
    nodeCategories?: string[];
    expectedNodeCount?: number;
    edgeCount?: number;
    symbolCount?: number;
    negativeCount?: number;
    fileCount?: number;
}

function scanFixtures(): FixtureStatus[] {
    const targets: { name: string, manifestPath: string, codeDir: string }[] = [];
    
    // 1. Integration Meta-Fixture
    targets.push({
        name: 'integration/microservices',
        manifestPath: path.join(FIXTURES_ROOT, 'microservices', 'expected.graph.yaml'),
        codeDir: path.join(FIXTURES_ROOT, 'microservices')
    });

    // 2. Pattern-Based Evals
    if (fs.existsSync(PATTERNS_ROOT)) {
        const patterns = fs.readdirSync(PATTERNS_ROOT, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();
            
        for (const p of patterns) {
            targets.push({
                name: `pattern/${p}`,
                manifestPath: path.join(PATTERNS_ROOT, p, 'expected.graph.yaml'),
                codeDir: path.join(PATTERNS_ROOT, p, 'fixture')
            });
        }
    }

    return targets.map(target => {

        // Count source files (rough)
        const countFiles = (dir: string): number => {
            let count = 0;
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                        count += countFiles(path.join(dir, entry.name));
                    } else if (entry.isFile() && !entry.name.endsWith('.yaml') && !entry.name.endsWith('.json')) {
                        count++;
                    }
                }
            } catch { /* ignore permission errors */ }
            return count;
        };

        if (!fs.existsSync(target.manifestPath)) {
            return { name: target.name, hasManifest: false, fileCount: countFiles(target.codeDir) };
        }

        try {
            const manifest = loadManifest(target.manifestPath);
            const nodeCategories = Object.keys(manifest.expected_nodes);
            const expectedNodeCount = Object.values(manifest.expected_nodes)
                .reduce((sum, arr) => sum + arr.length, 0);
            const negativeCount =
                Object.values(manifest.negative_nodes).reduce((s, a) => s + a.length, 0) +
                Object.values(manifest.negative_patterns).reduce((s, a) => s + a.length, 0);

            return {
                name: target.name,
                hasManifest: true,
                fixture: manifest.fixture,
                nodeCategories,
                expectedNodeCount,
                edgeCount: manifest.expected_edges.length,
                symbolCount: manifest.expected_symbols.length,
                negativeCount,
                fileCount: countFiles(target.codeDir),
            };
        } catch (err) {
            console.error(err);
            return { name: target.name, hasManifest: false, fileCount: countFiles(target.codeDir) };
        }
    });
}

// ─── Render ──────────────────────────────────────────────────────────────────

function printTable(statuses: FixtureStatus[]): void {
    const covered = statuses.filter(s => s.hasManifest).length;
    const total = statuses.length;
    const pct = (covered / total * 100).toFixed(0);

    // Helpers: pad raw string first, then colorize
    const rpad = (s: string, w: number) => s.padEnd(w);
    const lpad = (s: string, w: number) => s.padStart(w);

    // Calculate column widths dynamically based on content
    const maxNameLen = Math.max(...statuses.map(s => s.name.length), 'Fixture'.length);
    const NAME_W = maxNameLen + 2; // Add a little breathing room
    const NUM_W = 7;

    // Header
    const tableWidth = NAME_W + 2 + (NUM_W * 5) + 2;
    console.log('');
    console.log(`  ${chalk.cyan.bold('⬢ Eval Flywheel')}  ${chalk.dim('Fixture Coverage')}`);
    console.log(`  ${chalk.dim('─'.repeat(tableWidth))}`);
    console.log('');

    // Column headers
    console.log(
        '  ' +
        chalk.dim(rpad('Fixture', NAME_W)) + '  ' +
        chalk.dim(lpad('Nodes', NUM_W)) +
        chalk.dim(lpad('Edges', NUM_W)) +
        chalk.dim(lpad('Syms', NUM_W)) +
        chalk.dim(lpad('Neg', NUM_W)) +
        chalk.dim(lpad('Files', NUM_W)),
    );
    console.log(`  ${chalk.dim('─'.repeat(tableWidth))}`);

    for (const s of statuses) {
        const icon = s.hasManifest ? chalk.green('●') : chalk.dim('○');
        const colorize = s.hasManifest ? chalk.white : chalk.dim;

        const cell = (val: number | undefined): string => {
            const raw = val === undefined ? '—' : String(val);
            const padded = lpad(raw, NUM_W);
            if (val === undefined || val === 0) return chalk.dim(padded);
            return chalk.cyan(padded);
        };

        console.log(
            '  ' +
            colorize(rpad(s.name, NAME_W)) +
            ` ${icon}` +
            cell(s.expectedNodeCount) +
            cell(s.edgeCount) +
            cell(s.symbolCount) +
            cell(s.negativeCount) +
            cell(s.fileCount),
        );
    }

    console.log('');
    const coverageColor = covered === total ? chalk.green : chalk.yellow;
    console.log(`  ${chalk.dim('Coverage')}  ${coverageColor(`${covered}/${total}`)} ${chalk.dim(`fixtures (${pct}%)`)}`);
    console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

const statuses = scanFixtures();

if (jsonMode) {
    console.log(JSON.stringify(statuses, null, 2));
} else {
    printTable(statuses);
}
