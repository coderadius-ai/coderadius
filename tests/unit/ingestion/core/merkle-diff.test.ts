import { describe, it, expect } from 'vitest';
import { diffMerkleIndexes, diffFileFunctions } from '../../../../src/ingestion/core/merkle-diff.js';
import type { MerkleIndex, MerkleFileEntry } from '../../../../src/ingestion/core/merkle.js';

describe('Merkle Diff Engine', () => {

    describe('diffMerkleIndexes', () => {
        it('should correctly identify added, modified, deleted, and unchanged files', () => {
            const oldIndex: MerkleIndex = {
                repoHash: 'oldHash',
                repoScanMode: 'full',
                files: new Map([
                    ['file1.ts', { fileHash: 'hash1', fileScanMode: 'full', functions: new Map() }],
                    ['file2.ts', { fileHash: 'hash2', fileScanMode: 'full', functions: new Map() }],
                    ['file3.ts', { fileHash: 'hash3', fileScanMode: 'full', functions: new Map() }], // Will be deleted
                ])
            };

            const newIndex: MerkleIndex = {
                repoHash: 'newHash',
                repoScanMode: 'full',
                files: new Map([
                    ['file1.ts', { fileHash: 'hash1', fileScanMode: 'full', functions: new Map() }], // Unchanged
                    ['file2.ts', { fileHash: 'hash2_MODIFIED', fileScanMode: 'full', functions: new Map() }], // Modified
                    ['file4.ts', { fileHash: 'hash4', fileScanMode: 'full', functions: new Map() }], // Added
                ])
            };

            const diff = diffMerkleIndexes(oldIndex, newIndex);

            expect(diff.unchangedFiles).toEqual(['file1.ts']);
            expect(diff.modifiedFiles).toEqual(['file2.ts']);
            expect(diff.deletedFiles).toEqual(['file3.ts']);
            expect(diff.addedFiles).toEqual(['file4.ts']);
        });

        it('should perform global VName diffing to prevent false function deletions on file moves', () => {
            // functionA moves from file1 to file2. FunctionB stays in file1. FunctionC is genuinely deleted.
            const oldIndex: MerkleIndex = {
                repoHash: 'oldHash',
                repoScanMode: 'full',
                files: new Map([
                    ['src/file1.ts', { 
                        fileHash: 'hash1', 
                        fileScanMode: 'full', 
                        functions: new Map([
                            ['cr://function/src/file1//functionA', { sourceHash: 'a-hash', hasIO: false }],
                            ['cr://function/src/file1//functionB', { sourceHash: 'b-hash', hasIO: false }],
                            ['cr://function/src/file1//functionC', { sourceHash: 'c-hash', hasIO: false }]
                        ]) 
                    }]
                ])
            };

            const newIndex: MerkleIndex = {
                repoHash: 'newHash',
                repoScanMode: 'full',
                files: new Map([
                    ['src/file1.ts', { 
                        fileHash: 'hash1_MOD', 
                        fileScanMode: 'full', 
                        functions: new Map([
                            ['cr://function/src/file1//functionB', { sourceHash: 'b-hash', hasIO: false }]
                        ]) 
                    }],
                    ['src/file2.ts', { 
                        fileHash: 'hash2', 
                        fileScanMode: 'full', 
                        functions: new Map([
                            ['cr://function/src/file1//functionA', { sourceHash: 'a-hash', hasIO: false }] // Moved here, VName intact!
                        ]) 
                    }]
                ])
            };

            const diff = diffMerkleIndexes(oldIndex, newIndex);

            // FunctionA moved. Function B stayed. Only Function C is truly deleted globally.
            expect(diff.deletedFunctions).toEqual(['cr://function/src/file1//functionC']);
        });
    });

    describe('diffFileFunctions', () => {
        it('should correctly diff functions within a single file', () => {
            const oldEntry: MerkleFileEntry = {
                fileHash: 'hash1',
                fileScanMode: 'full',
                functions: new Map([
                    ['func1', { sourceHash: 'f1-v1', hasIO: false }],
                    ['func2', { sourceHash: 'f2-v1', hasIO: true }],
                    ['func3', { sourceHash: 'f3-v1', hasIO: false }],
                ])
            };

            const newEntry: MerkleFileEntry = {
                fileHash: 'hash1_new',
                fileScanMode: 'full',
                functions: new Map([
                    ['func1', { sourceHash: 'f1-v1', hasIO: false }], // Unchanged
                    ['func2', { sourceHash: 'f2-v2', hasIO: true }], // Modified
                    ['func4', { sourceHash: 'f4-v1', hasIO: false }], // Added
                ])
            };

            const diff = diffFileFunctions(oldEntry, newEntry);

            expect(diff.added).toEqual(['func4']);
            expect(diff.modified).toEqual(['func2']);
            expect(diff.deleted).toEqual(['func3']);
        });
        
        it('should handle undefined old or new entries safely', () => {
            const entry: MerkleFileEntry = {
                fileHash: 'hash1',
                fileScanMode: 'full',
                functions: new Map([['func1', { sourceHash: 'f1-v1', hasIO: false }]])
            };
            
            const diffNewFile = diffFileFunctions(undefined as any, entry);
            expect(diffNewFile.added).toEqual(['func1']);
            expect(diffNewFile.deleted).toEqual([]);
            
            const diffDeletedFile = diffFileFunctions(entry, undefined as any);
            expect(diffDeletedFile.deleted).toEqual(['func1']);
            expect(diffDeletedFile.added).toEqual([]);
        });
    });
});
