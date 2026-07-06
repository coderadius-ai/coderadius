import { describe, it, expect } from 'vitest';
import { collectStructuralGlobPatterns } from '../../../../src/ingestion/structural/plugin-manager.js';
import type { StructuralPlugin } from '../../../../src/ingestion/structural/types.js';

const stubPlugin = (name: string, discoveryGlobs?: string[]): StructuralPlugin => ({
    name,
    label: name,
    managedLabels: [],
    discoveryGlobs,
    matchFile: () => false,
    extract: () => ({ entities: [], summary: '' }),
});

describe('collectStructuralGlobPatterns (Fix 8)', () => {
    it('returns base STRUCTURAL_GLOB_PATTERNS when no plugins contribute globs', () => {
        const patterns = collectStructuralGlobPatterns([]);
        expect(patterns.length).toBeGreaterThan(0);
        expect(patterns).toContain('**/Makefile');
    });

    it('unions plugin discoveryGlobs into the patterns list', () => {
        const patterns = collectStructuralGlobPatterns([
            stubPlugin('plugin-a', ['**/AcmeOnly.php']),
        ]);
        expect(patterns).toContain('**/AcmeOnly.php');
    });

    it('deduplicates patterns when 2 plugins declare the same glob', () => {
        const patterns = collectStructuralGlobPatterns([
            stubPlugin('plugin-a', ['**/DupeGlob.php']),
            stubPlugin('plugin-b', ['**/DupeGlob.php']),
        ]);
        const occurrences = patterns.filter(p => p === '**/DupeGlob.php').length;
        expect(occurrences).toBe(1);
    });

    it('plugins without discoveryGlobs are no-op', () => {
        const baselinePatterns = collectStructuralGlobPatterns([]);
        const withNullPlugin = collectStructuralGlobPatterns([
            stubPlugin('plugin-a'),
            stubPlugin('plugin-b'),
        ]);
        expect(withNullPlugin.length).toBe(baselinePatterns.length);
    });
});
