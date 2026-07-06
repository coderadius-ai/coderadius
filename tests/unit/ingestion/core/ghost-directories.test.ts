import { describe, it, expect } from 'vitest';
import { ghostDirectoriesPlugin } from '../../../../src/ingestion/structural/plugins/ghost-directories.plugin.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Ghost Directories Plugin - Unit Tests', () => {
    it('should scan directories and categorize them correctly', () => {
        // Create a temporary directory structure for testing
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'coderadius-test-'));
        const scopeManager = new ScopeManager(tempBase);
        try {
            fs.mkdirSync(path.join(tempBase, 'tests'));
            fs.mkdirSync(path.join(tempBase, 'docs'));
            fs.mkdirSync(path.join(tempBase, 'e2e'));
            fs.mkdirSync(path.join(tempBase, 'src'));
            fs.mkdirSync(path.join(tempBase, 'src/api'));
            // Note: Ghost directory scan goes 1 level deep inside service dirs (src/*, apps/*)
            // but does NOT recurse into sub-paths like src/api/tests

            const result = ghostDirectoriesPlugin.scan(tempBase, 'test-repo', 'cr://repo/test', scopeManager);
            
            const categories = result.entities.map(e => e.properties.category);
            const paths = result.entities.map(e => e.properties.path);

            expect(categories).toContain('Tests');
            expect(categories).toContain('Documentation');
            expect(categories).toContain('E2ETests');
            
            expect(paths).toContain('tests');
            expect(paths).toContain('docs');
            expect(paths).toContain('e2e');
            
            // Should not include normal src directories
            expect(paths).not.toContain('src');
            expect(paths).not.toContain('src/api');

        } finally {
            // Cleanup
            fs.rmSync(tempBase, { recursive: true, force: true });
        }
    });
});
