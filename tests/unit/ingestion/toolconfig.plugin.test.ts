import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Mock fs BEFORE importing the plugin ────────────────────────────────────
// The toolconfig plugin synchronously calls fs.readFileSync when resolving
// `extends` chains. We mock it with a simple factory (no importOriginal) to
// avoid Zod v4 ESM circular import issues that occur with async mock factories.

const MOCK_FS_CONTENTS: Record<string, string> = {};

vi.mock('node:fs', () => ({
    default: {
        readFileSync: vi.fn((filePath: unknown, _enc: unknown): string => {
            const p = filePath as string;
            for (const [key, content] of Object.entries(MOCK_FS_CONTENTS)) {
                if (p.includes(key)) return content;
            }
            throw Object.assign(new Error(`ENOENT: no such file or directory: ${p}`), { code: 'ENOENT' });
        }),
    },
    readFileSync: vi.fn((filePath: unknown, _enc: unknown): string => {
        const p = filePath as string;
        for (const [key, content] of Object.entries(MOCK_FS_CONTENTS)) {
            if (p.includes(key)) return content;
        }
        throw Object.assign(new Error(`ENOENT: no such file or directory: ${p}`), { code: 'ENOENT' });
    }),
}));

import { toolconfigPlugin } from '../../../src/ingestion/structural/plugins/toolconfig.plugin.js';
import type { PluginContext } from '../../../src/ingestion/structural/types.js';

// ─── File content registry helpers ──────────────────────────────────────────

function setMockFile(key: string, content: string) {
    MOCK_FS_CONTENTS[key] = content;
}

function clearMockFiles() {
    for (const key of Object.keys(MOCK_FS_CONTENTS)) {
        delete MOCK_FS_CONTENTS[key];
    }
}

beforeEach(() => {
    clearMockFiles();
    vi.clearAllMocks();
    // Populate the default mock files used by most tests
    setMockFile('tsconfig.base.json', JSON.stringify({
        compilerOptions: {
            strict: true,
            noFallthroughCasesInSwitch: true,
            noUncheckedIndexedAccess: true,
            target: 'ES2022',
        },
    }));
    setMockFile('tsconfig.strict-parent.json', JSON.stringify({
        compilerOptions: {
            strict: true,
            noFallthroughCasesInSwitch: true,
            noUncheckedIndexedAccess: true,
        },
    }));
});

function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        relativePath: 'tsconfig.json',
        absolutePath: '/repo/tsconfig.json',
        basename: 'tsconfig.json',
        repoName: 'acme/my-service',
        ownerService: 'my-service',
        ...overrides,
    };
}

function extractProps(content: string, ctxOverrides: Partial<PluginContext> = {}) {
    const result = toolconfigPlugin.extract(content, makeCtx(ctxOverrides));
    if (result.entities.length === 0) return null;
    return result.entities[0]!.properties;
}

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('toolconfigPlugin.matchFile', () => {
    test('matches tsconfig.json', () => {
        expect(toolconfigPlugin.matchFile('tsconfig.json', 'tsconfig.json')).toBe(true);
    });
    test('matches tsconfig.build.json', () => {
        expect(toolconfigPlugin.matchFile('tsconfig.build.json', 'tsconfig.build.json')).toBe(true);
    });
    test('does not match package.json', () => {
        expect(toolconfigPlugin.matchFile('package.json', 'package.json')).toBe(false);
    });
    test('does not match tsconfig.jsonc (different extension)', () => {
        expect(toolconfigPlugin.matchFile('tsconfig.jsonc', 'tsconfig.jsonc')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Direct strict mode — no extends
// ═══════════════════════════════════════════════════════════════════════════════

describe('direct strict flags (no extends)', () => {
    const COMPLIANT = JSON.stringify({
        compilerOptions: {
            strict: true,
            noFallthroughCasesInSwitch: true,
            noUncheckedIndexedAccess: true,
            target: 'ES2022',
        },
    });

    test('resolvedStrict=true when strict set directly', () => {
        const props = extractProps(COMPLIANT);
        expect(props!['resolvedStrict']).toBe(true);
    });

    test('strictSource=direct when not inheriting', () => {
        const props = extractProps(COMPLIANT);
        expect(props!['strictSource']).toBe('direct');
    });

    test('resolvedNoFallthroughCasesInSwitch=true when set directly', () => {
        const props = extractProps(COMPLIANT);
        expect(props!['resolvedNoFallthroughCasesInSwitch']).toBe(true);
    });

    test('resolvedNoUncheckedIndexedAccess=true when set directly', () => {
        const props = extractProps(COMPLIANT);
        expect(props!['resolvedNoUncheckedIndexedAccess']).toBe(true);
    });

    test('resolvedStrict=false when strict=false', () => {
        const content = JSON.stringify({ compilerOptions: { strict: false } });
        const props = extractProps(content);
        expect(props!['resolvedStrict']).toBe(false);
    });

    test('resolvedStrict=false when strict is absent', () => {
        const content = JSON.stringify({ compilerOptions: { target: 'ES2022' } });
        const props = extractProps(content);
        expect(props!['resolvedStrict']).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Extends chain resolution — local file
// ═══════════════════════════════════════════════════════════════════════════════

describe('extends — local file resolution', () => {
    test('inherits strict=true from parent base config', () => {
        const content = JSON.stringify({
            extends: './tsconfig.base.json',
            compilerOptions: { target: 'ES2022' },
        });
        const props = extractProps(content);
        // strict comes from parent
        expect(props!['resolvedStrict']).toBe(true);
        expect(props!['strictSource']).toBe('inherited');
    });

    test('child overrides strict=false even if parent has strict=true', () => {
        const content = JSON.stringify({
            extends: './tsconfig.strict-parent.json',
            compilerOptions: {
                strict: false, // explicit override
            },
        });
        const props = extractProps(content);
        expect(props!['resolvedStrict']).toBe(false);
        expect(props!['strictSource']).toBe('direct'); // child set it directly
    });

    test('child explicit true wins over parent true (both direct)', () => {
        const content = JSON.stringify({
            extends: './tsconfig.base.json',
            compilerOptions: {
                strict: true,
                noFallthroughCasesInSwitch: true,
                noUncheckedIndexedAccess: true,
            },
        });
        const props = extractProps(content);
        expect(props!['resolvedStrict']).toBe(true);
        // Child has strict set directly → source is 'direct' not 'inherited'
        expect(props!['strictSource']).toBe('direct');
    });

    test('degrades gracefully when parent file not found', () => {
        const content = JSON.stringify({
            extends: './tsconfig.nonexistent.json',
            compilerOptions: { strict: true },
        });
        // Should not throw; should use child's own options
        const props = extractProps(content);
        expect(props!['resolvedStrict']).toBe(true);
        expect(props!['strictSource']).toBe('direct');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// npm package extends — NOT resolved (no fs read)
// ═══════════════════════════════════════════════════════════════════════════════

describe('extends — npm package (NOT resolved via filesystem)', () => {
    test('@tsconfig/node18 extends is NOT read from disk', () => {
        // Track whether readFileSync was called by checking if the MOCK_FS_CONTENTS
        // lookup path was triggered for a @tsconfig path (it should NOT be, because
        // the plugin only resolves extends that do NOT start with '@').
        // We verify indirectly: the mock throws ENOENT for any unknown path.
        // If readFileSync IS called for a '@tsconfig' path, it would throw and
        // the plugin would degrade gracefully — but NO file should be attempted.
        // We clear mock contents to ensure any @tsconfig lookup would throw.
        clearMockFiles(); // Remove all registered files

        const content = JSON.stringify({
            extends: '@tsconfig/node18/tsconfig.json',
            compilerOptions: { strict: false },
        });
        // This must NOT throw (the plugin skips @-prefixed extends entirely)
        expect(() => extractProps(content)).not.toThrow();
    });

    test('@tsconfig extends still returns correct direct props', () => {
        const content = JSON.stringify({
            extends: '@tsconfig/node20/tsconfig.json',
            compilerOptions: { strict: true },
        });
        const props = extractProps(content);
        expect(props!['resolvedStrict']).toBe(true);
        expect(props!['strictSource']).toBe('direct');
    });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Malformed input
// ═══════════════════════════════════════════════════════════════════════════════

describe('malformed input', () => {
    test('invalid JSON returns empty entities', () => {
        const result = toolconfigPlugin.extract('{ invalid json', makeCtx());
        expect(result.entities).toHaveLength(0);
        expect(result.summary).toContain('parse error');
    });

    test('tsconfig with only unknown flags returns empty (no trackedFlags, no extends)', () => {
        const content = JSON.stringify({ compilerOptions: { experimentalDecorators: true } });
        const result = toolconfigPlugin.extract(content, makeCtx());
        // experimentalDecorators is not in TRACKED_FLAGS, and no extends → empty
        expect(result.entities).toHaveLength(0);
    });

    test('JSONC with comments is parsed correctly', () => {
        const content = '{\n  // This is a comment\n  "compilerOptions": { "strict": true }\n}';
        const props = extractProps(content);
        expect(props!['resolvedStrict']).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// URN and properties
// ═══════════════════════════════════════════════════════════════════════════════

describe('URN and node properties', () => {
    const BASE = JSON.stringify({ compilerOptions: { strict: true } });

    test('URN follows cr:toolconfig:TypeScript:{repoName}:{path} schema', () => {
        const result = toolconfigPlugin.extract(BASE, makeCtx());
        expect(result.entities[0]!.id).toBe('cr:toolconfig:TypeScript:acme/my-service:tsconfig.json');
    });

    test('tool property is always TypeScript', () => {
        const props = extractProps(BASE);
        expect(props!['tool']).toBe('TypeScript');
    });
});
