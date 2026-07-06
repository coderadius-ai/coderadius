import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    computeInputHash,
    loadSnapshot,
    saveSnapshot,
    clearSnapshot,
} from '../../../../src/ai/agents/sink-classifier/snapshot.js';
import type { ClassifiedPackage, ClassifierInput } from '../../../../src/ai/agents/sink-classifier/schema.js';

describe('Sink Classifier — snapshot fast-path', () => {
    let rootDir: string;
    const repoPath = '/tmp/repo-X';

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sink-snapshot-'));
        process.env.CODERADIUS_SNAPSHOT_DIR = rootDir;
        process.env.CODERADIUS_TENANT_ID = 'test-tenant';
    });
    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
        delete process.env.CODERADIUS_SNAPSHOT_DIR;
        delete process.env.CODERADIUS_TENANT_ID;
    });

    const inputs: ClassifierInput[] = [
        { name: 'axios', ecosystem: 'npm' },
        { name: 'pg', ecosystem: 'npm' },
    ];
    const classifications: ClassifiedPackage[] = [
        { name: 'axios', sinkType: 'ExternalAPI', confidence: 0.99, evidence: ['t'] },
        { name: 'pg', sinkType: 'Database', confidence: 0.99, evidence: ['t'] },
    ];

    it('hash is order-independent', () => {
        const fp = 'fp1';
        const a = computeInputHash(inputs, fp);
        const b = computeInputHash([...inputs].reverse(), fp);
        expect(a).toBe(b);
    });

    it('hash differs when fingerprint changes', () => {
        expect(computeInputHash(inputs, 'fp-v1')).not.toBe(computeInputHash(inputs, 'fp-v2'));
    });

    it('save then load roundtrips when hash matches', async () => {
        const hash = computeInputHash(inputs, 'fp');
        await saveSnapshot(repoPath, hash, 'fp', classifications, inputs.length);
        const snap = await loadSnapshot(repoPath, hash);
        expect(snap?.classifications.map(c => c.name).sort()).toEqual(['axios', 'pg']);
    });

    it('returns null when expected hash differs', async () => {
        const hash = computeInputHash(inputs, 'fp');
        await saveSnapshot(repoPath, hash, 'fp', classifications, inputs.length);
        const snap = await loadSnapshot(repoPath, 'different-hash');
        expect(snap).toBeNull();
    });

    it('returns null when no snapshot exists', async () => {
        const snap = await loadSnapshot(repoPath, 'any-hash');
        expect(snap).toBeNull();
    });

    it('clearSnapshot removes the file', async () => {
        const hash = computeInputHash(inputs, 'fp');
        await saveSnapshot(repoPath, hash, 'fp', classifications, inputs.length);
        await clearSnapshot(repoPath);
        const snap = await loadSnapshot(repoPath, hash);
        expect(snap).toBeNull();
    });

    it('repo isolation: different repoPath → different snapshot file', async () => {
        const hash = computeInputHash(inputs, 'fp');
        await saveSnapshot('/tmp/repo-A', hash, 'fp', classifications, 2);
        await saveSnapshot('/tmp/repo-B', hash, 'fp', [], 0);
        const a = await loadSnapshot('/tmp/repo-A', hash);
        const b = await loadSnapshot('/tmp/repo-B', hash);
        expect(a?.classifications).toHaveLength(2);
        expect(b?.classifications).toHaveLength(0);
    });
});
