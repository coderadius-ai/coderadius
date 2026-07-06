import { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from '../../../config/paths.js';
import { CONSTRAINT_MAP, SECONDARY_INDEXES } from '../../../graph/domain.js';
import { VECTOR_INDEX } from '../../../graph/vector-indexes.js';

const execFileAsync = promisify(execFile);

function estimateDirSize(dirPath: string): number {
    let size = 0;
    try {
        if (!fs.existsSync(dirPath)) return 0;
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
            try { size += fs.statSync(path.join(dirPath, entry.name)).size; } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return size;
}

async function deleteFile(filePath: string): Promise<number> {
    if (!fs.existsSync(filePath)) return 0;
    const size = fs.statSync(filePath).size;
    await fsp.unlink(filePath);
    return size;
}

async function deleteDir(dirPath: string): Promise<number> {
    if (!fs.existsSync(dirPath)) return 0;
    const size = estimateDirSize(dirPath);
    await execFileAsync('rm', ['-rf', dirPath]);
    return size;
}

async function confirm(message: string, force: boolean): Promise<boolean> {
    if (force) return true;
    const confirmed = await p.confirm({ message: chalk.red.bold(message), initialValue: false });
    if (p.isCancel(confirmed) || !confirmed) {
        p.cancel('Cancelled. No changes were made.');
        process.exit(0);
    }
    return true;
}

async function pruneGraph(force: boolean): Promise<void> {
    const { closeNeo4j, getMemgraphSession } = await import('../../../graph/neo4j.js');
    const { showVectorIndexInfo } = await import('../../../graph/vector-indexes.js');

    if (!force) {
        p.log.warn(
            chalk.yellow.bold('This will permanently delete all nodes, relationships, and indexes.\n') +
            chalk.dim('Run ') + chalk.whiteBright('cr analyze code') + chalk.dim(' to repopulate.'),
        );
    }
    await confirm('Wipe the entire architecture graph?', force);

    const spinner = p.spinner();
    spinner.start('Connecting to Memgraph...');
    const session = getMemgraphSession();

    try {
        const countResult = await session.run(
            'MATCH (n) OPTIONAL MATCH (n)-[r]-() RETURN count(DISTINCT n) AS nodes, count(DISTINCT r) AS rels',
        );
        const row = countResult.records[0];
        const nodeCount: number = row?.get('nodes')?.toNumber?.() ?? row?.get('nodes') ?? 0;
        const relCount: number = row?.get('rels')?.toNumber?.() ?? row?.get('rels') ?? 0;

        spinner.message(`Deleting ${nodeCount} nodes and ${relCount} relationships...`);
        await session.run('MATCH (n) DETACH DELETE n');

        spinner.message('Dropping indexes...');

        for (const { label, property } of SECONDARY_INDEXES) {
            try { await session.run(`DROP INDEX ON :${label}(${property})`); } catch { /* ignore */ }
        }
        for (const label of Object.keys(CONSTRAINT_MAP)) {
            try { await session.run(`DROP CONSTRAINT ON (n:${label}) ASSERT n.${CONSTRAINT_MAP[label as keyof typeof CONSTRAINT_MAP]} IS UNIQUE`); } catch { /* ignore */ }
        }

        const vectorIndexes = await showVectorIndexInfo();
        for (const idx of vectorIndexes) {
            try { await session.run(`DROP VECTOR INDEX ${idx.indexName}`); } catch { /* ignore */ }
        }
        for (const name of Object.values(VECTOR_INDEX)) {
            try { await session.run(`DROP VECTOR INDEX ${name}`); } catch { /* ignore */ }
        }

        spinner.stop(
            chalk.green('Graph wiped') +
            chalk.dim(` — ${nodeCount} nodes, ${relCount} relationships, indexes dropped`),
        );
    } finally {
        await session.close();
        await closeNeo4j();
    }
}

async function pruneCache(force: boolean): Promise<void> {
    const targets = [
        paths.cache.embeddings,
        paths.cache.updateCheck,
        paths.cache.datastoreAssignments,
        paths.cache.osv,
        paths.cache.sinkClassifier,
        paths.cache.sinkClassifierSnapshot,
        paths.sandbox,
    ];

    if (!targets.some(t => fs.existsSync(t))) {
        p.log.success('Cache is already clean.');
        return;
    }

    if (!force) {
        p.log.warn(
            chalk.yellow.bold('This will delete all local caches AND downloaded repositories.\n') +
            chalk.dim('Next ingestion will re-fetch embeddings and re-clone repositories.'),
        );
    }
    await confirm('Delete all caches?', force);

    const spinner = p.spinner();
    spinner.start('Deleting caches...');

    let totalBytes = 0;
    totalBytes += await deleteFile(paths.cache.embeddings);
    totalBytes += await deleteFile(paths.cache.updateCheck);
    totalBytes += await deleteFile(paths.cache.datastoreAssignments);
    totalBytes += await deleteDir(paths.cache.osv);
    totalBytes += await deleteDir(paths.cache.sinkClassifier);
    totalBytes += await deleteDir(paths.cache.sinkClassifierSnapshot);
    totalBytes += await deleteDir(paths.sandbox);

    spinner.stop(
        chalk.green('Cache deleted') +
        chalk.dim(` — freed ~${(totalBytes / 1024 / 1024).toFixed(1)} MB`),
    );
}

export function registerPruneCommand(program: Command): void {
    const prune = program
        .command('prune')
        .description('Remove data, caches, or both');

    prune
        .command('graph')
        .description('Wipe all nodes, relationships, and indexes from the database')
        .option('--force', 'Skip confirmation')
        .action(async (opts: { force?: boolean }) => {
            console.log();
            if (!opts.force) p.intro(chalk.bgRed.white.bold(' PRUNE GRAPH '));
            try {
                await pruneGraph(!!opts.force);
                if (!opts.force) p.outro(chalk.dim('Run ') + chalk.whiteBright('cr analyze code') + chalk.dim(' to repopulate.'));
            } catch (err: any) {
                p.log.error(`Database error: ${err.message}`);
                process.exit(1);
            }
        });

    prune
        .command('cache')
        .description('Clear local caches (embeddings, classifiers, cloned repos)')
        .option('--force', 'Skip confirmation')
        .action(async (opts: { force?: boolean }) => {
            console.log();
            if (!opts.force) p.intro(chalk.bgRed.white.bold(' PRUNE CACHE '));
            try {
                await pruneCache(!!opts.force);
                if (!opts.force) p.outro(chalk.dim('Run ') + chalk.whiteBright('cr analyze code') + chalk.dim(' to regenerate.'));
            } catch (err: any) {
                p.log.error(`Error: ${err.message}`);
                process.exit(1);
            }
        });

    prune
        .command('all')
        .description('Wipe graph AND clear caches (full reset)')
        .option('--force', 'Skip confirmation')
        .action(async (opts: { force?: boolean }) => {
            console.log();
            if (!opts.force) {
                p.intro(chalk.bgRed.white.bold(' PRUNE ALL '));
                p.log.warn(
                    chalk.yellow.bold('This will wipe the graph database AND delete all local caches.\n') +
                    chalk.dim('Everything will be rebuilt from scratch on next ingestion.'),
                );
                await confirm('Wipe graph and delete all caches?', false);
            }
            try {
                await pruneGraph(true);
                await pruneCache(true);
                if (!opts.force) p.outro(chalk.dim('Run ') + chalk.whiteBright('cr analyze code') + chalk.dim(' to start fresh.'));
            } catch (err: any) {
                p.log.error(`Error: ${err.message}`);
                process.exit(1);
            }
        });
}
