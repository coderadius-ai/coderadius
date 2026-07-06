// ═══════════════════════════════════════════════════════════════════════════════
// Per-repo Snapshot — fast path for the sink classifier.
//
// Why two cache layers?
//   • Per-package cache (file-backend.ts) saves LLM calls — `axios` classified
//     once on ANY repo of the tenant is never re-classified. Cross-repo benefit.
//   • Per-repo snapshot (this module) saves the classifier work entirely —
//     when the input set hash is unchanged, skip cache lookups, skip merging,
//     skip everything. Same-repo, same-deps benefit.
//
// Hash strategy: SHA-256 of the normalized (ecosystem, name) tuples in
// canonical order, plus the active model fingerprint and schema version. The
// snapshot is invalidated when:
//   - any package added/removed
//   - the LLM model behind 'ingest' changes (fingerprint differs)
//   - the schema version is bumped
//
// Storage: ~/.coderadius/cache/sink-classifier-snapshot/{tenant}/{repoSlug}.json
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../../../utils/logger.js';
import { paths } from '../../../config/paths.js';
import {
    SINK_CLASSIFIER_SCHEMA_VERSION,
    type ClassifiedPackage,
    type ClassifierInput,
} from './schema.js';

const TENANT_ENV = 'CODERADIUS_TENANT_ID';
const ROOT_ENV = 'CODERADIUS_SNAPSHOT_DIR';

export interface SnapshotFile {
    /** Hash that must match `computeInputHash` to qualify as a fast-path hit. */
    hash: string;
    modelFingerprint: string;
    schemaVersion: string;
    timestamp: string;
    /** Resolved classifications from the last full run. */
    classifications: ClassifiedPackage[];
    /** Number of inputs at snapshot time — informational. */
    inputCount: number;
}

function rootDir(): string {
    return (
        process.env[ROOT_ENV] ??
        paths.cache.sinkClassifierSnapshot
    );
}

function tenantId(): string {
    return process.env[TENANT_ENV] ?? 'default';
}

function repoSlug(repoPath: string): string {
    // sha256(repoPath) makes file names safe and stable across machines.
    return crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
}

function snapshotPath(repoPath: string): string {
    return path.join(rootDir(), tenantId(), `${repoSlug(repoPath)}.json`);
}

/**
 * Compute a stable hash over the classifier input set.
 *
 * Two runs with the same package list, same model, and same schema version
 * MUST produce the same hash. Order-independent.
 */
export function computeInputHash(
    inputs: ClassifierInput[],
    modelFingerprint: string,
): string {
    const canonical = inputs
        .map(i => `${i.ecosystem}|${i.name}`)
        .sort()
        .join('\n');
    return crypto
        .createHash('sha256')
        .update(`${canonical}|${modelFingerprint}|${SINK_CLASSIFIER_SCHEMA_VERSION}`)
        .digest('hex')
        .slice(0, 16);
}

export async function loadSnapshot(
    repoPath: string,
    expectedHash: string,
): Promise<SnapshotFile | null> {
    const filePath = snapshotPath(repoPath);
    if (!existsSync(filePath)) return null;
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as SnapshotFile;
        if (parsed.hash !== expectedHash) return null;
        if (parsed.schemaVersion !== SINK_CLASSIFIER_SCHEMA_VERSION) return null;
        return parsed;
    } catch (err) {
        logger.debug(`[SinkSnapshot] failed to read ${filePath}: ${(err as Error).message}`);
        return null;
    }
}

export async function saveSnapshot(
    repoPath: string,
    hash: string,
    modelFingerprint: string,
    classifications: ClassifiedPackage[],
    inputCount: number,
): Promise<void> {
    const filePath = snapshotPath(repoPath);
    const dir = path.dirname(filePath);
    const payload: SnapshotFile = {
        hash,
        modelFingerprint,
        schemaVersion: SINK_CLASSIFIER_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        classifications,
        inputCount,
    };
    try {
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8');
        await fs.rename(tmp, filePath);
    } catch (err) {
        logger.debug(`[SinkSnapshot] failed to save ${filePath}: ${(err as Error).message}`);
    }
}

export async function clearSnapshot(repoPath: string): Promise<void> {
    const filePath = snapshotPath(repoPath);
    try {
        if (existsSync(filePath)) await fs.unlink(filePath);
    } catch {
        /* swallow */
    }
}
