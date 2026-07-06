import crypto from 'node:crypto';
import fs from 'node:fs';
import type { MerkleIndexRow } from '../../graph/mutations/merkle.js';
import type { FileImportMap, ClassPropertyAlias, DependencyBinding } from './import-graph.js';

// ─── Hash Utilities ──────────────────────────────────────────────────────────

/**
 * SHA-256 hash of a string, truncated to 16 hex characters.
 */
export function hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Hash the raw content of a file on disk.
 */
export function computeFileHash(filePath: string, salt?: string): string {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return hashContent(salt ? `${salt}:${content}` : content);
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            return hashContent(""); // Dummy hash for missing/broken file
        }
        throw e;
    }
}

/**
 * Hash a function's source code.
 */
export function computeFunctionHash(sourceCode: string): string {
    return hashContent(sourceCode);
}

/**
 * Compute a repo-level hash from sorted file hashes.
 * If any file hash changes, the repo hash changes.
 */
export function computeRepoHash(fileHashes: string[]): string {
    const sorted = [...fileHashes].sort();
    return hashContent(sorted.join(':'));
}

// ─── In-Memory Merkle Index ──────────────────────────────────────────────────

export interface MerkleFileEntry {
    fileHash: string;
    fileScanMode: string | null;
    functions: Map<string, { sourceHash: string; hasIO: boolean }>; // functionId → data
    /** Import metadata for taint graph reconstruction (populated in-memory during analysis). */
    importMap?: FileImportMap;
    /** Class property → type aliases for DI taint detection (populated in-memory during analysis). */
    classAliases?: ClassPropertyAlias[];
    /** Provider token bindings for DI taint resolution (populated in-memory during analysis). */
    dependencyBindings?: DependencyBinding[];
}

export interface MerkleIndex {
    repoHash: string | null;
    repoScanMode: string | null;
    files: Map<string, MerkleFileEntry>; // filePath → file entry
}

/**
 * Build an in-memory MerkleIndex from Neo4j rows.
 */
export function buildMerkleIndex(rows: MerkleIndexRow[]): MerkleIndex {
    const index: MerkleIndex = {
        repoHash: null,
        repoScanMode: null,
        files: new Map(),
    };

    for (const row of rows) {
        // Grab repoHash from first non-null row
        if (row.repoHash && !index.repoHash) {
            index.repoHash = row.repoHash;
            index.repoScanMode = row.repoScanMode;
        }

        if (!row.filePath || !row.fileHash) continue;

        if (!index.files.has(row.filePath)) {
            index.files.set(row.filePath, {
                fileHash: row.fileHash,
                fileScanMode: row.fileScanMode,
                functions: new Map(),
            });
        }

        const fileEntry = index.files.get(row.filePath)!;
        if (row.functionId && row.sourceHash) {
            fileEntry.functions.set(row.functionId, { sourceHash: row.sourceHash, hasIO: row.hasIO ?? false });
        }
    }

    return index;
}
