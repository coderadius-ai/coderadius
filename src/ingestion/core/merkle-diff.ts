import type { MerkleIndex, MerkleFileEntry } from './merkle.js';

export interface MerkleDiffResult {
    addedFiles: string[];
    modifiedFiles: string[];
    deletedFiles: string[];
    unchangedFiles: string[];
    deletedFunctions: string[]; // Global list of missing VNames
}

export interface FunctionDiffResult {
    added: string[];
    modified: string[];
    deleted: string[];
}

/**
 * Compare an old graph index state against the new disk state.
 * Employs a global VName diff to determine truly deleted functions,
 * preventing ghost nodes when functions simply move files.
 */
export function diffMerkleIndexes(oldIndex: MerkleIndex, newIndex: MerkleIndex): MerkleDiffResult {
    const result: MerkleDiffResult = {
        addedFiles: [],
        modifiedFiles: [],
        deletedFiles: [],
        unchangedFiles: [],
        deletedFunctions: [],
    };

    const globalOldFunctions = new Set<string>();
    const globalNewFunctions = new Set<string>();

    // 1. Collect all old global function IDs and check for deleted/modified files
    for (const [filePath, oldEntry] of oldIndex.files) {
        // Collect old functions
        for (const funcId of oldEntry.functions.keys()) {
            globalOldFunctions.add(funcId);
        }

        const newEntry = newIndex.files.get(filePath);

        if (!newEntry) {
            result.deletedFiles.push(filePath);
        } else if (newEntry.fileHash !== oldEntry.fileHash || newEntry.fileScanMode !== oldEntry.fileScanMode) {
            result.modifiedFiles.push(filePath);
        } else {
            result.unchangedFiles.push(filePath);
        }
    }

    // 2. Collect all new global function IDs and check for added files
    for (const [filePath, newEntry] of newIndex.files) {
        // Collect new functions
        for (const funcId of newEntry.functions.keys()) {
            globalNewFunctions.add(funcId);
        }

        if (!oldIndex.files.has(filePath)) {
            result.addedFiles.push(filePath);
        }
    }

    // 3. Compute truly deleted functions (in old graph, missing globally from new disk state)
    for (const oldFuncId of globalOldFunctions) {
        if (!globalNewFunctions.has(oldFuncId)) {
            result.deletedFunctions.push(oldFuncId);
        }
    }

    return result;
}

/**
 * Compare functions within a single modified file.
 * Useful for Edge Reconciliation (Component 5).
 */
export function diffFileFunctions(oldEntry: MerkleFileEntry, newEntry: MerkleFileEntry): FunctionDiffResult {
    const result: FunctionDiffResult = {
        added: [],
        modified: [],
        deleted: [],
    };

    // Note: oldEntry or newEntry might be undefined in the caller, handle safely
    const oldFuncs = oldEntry?.functions || new Map();
    const newFuncs = newEntry?.functions || new Map();

    for (const [funcId, oldData] of oldFuncs) {
        const newData = newFuncs.get(funcId);
        if (!newData) {
            result.deleted.push(funcId);
        } else if (newData.sourceHash !== oldData.sourceHash) {
            result.modified.push(funcId);
        }
    }

    for (const funcId of newFuncs.keys()) {
        if (!oldFuncs.has(funcId)) {
            result.added.push(funcId);
        }
    }

    return result;
}
