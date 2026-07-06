import { describe, it, expect } from 'vitest';
import { RepoHintsSchema, RepoHintsStrictSchema } from '../../../src/config/repo-hints.js';

describe('RepoHintsStrictSchema (validation twin)', () => {
    it('rejects unknown top-level keys (typos) with an unrecognized-keys issue', () => {
        const result = RepoHintsStrictSchema.safeParse({ decoratorss: [] });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = result.error.issues.map((i) => i.code);
            expect(messages).toContain('unrecognized_keys');
        }
    });

    it('accepts the same valid document the runtime schema accepts', () => {
        const doc = {
            decorators: [{ name: 'AcmeConsumer', kind: 'message-consumer' }],
            hints: [{ patterns: ['AcmeSdk'], description: 'internal wrapper' }],
        };
        expect(RepoHintsStrictSchema.safeParse(doc).success).toBe(true);
        expect(RepoHintsSchema.safeParse(doc).success).toBe(true);
    });

    it('pins the runtime leniency: the same typo passes the runtime schema silently', () => {
        // This is WHY the strict twin exists: loadRepoHints must never throw,
        // so authoring-time validation needs its own schema.
        const result = RepoHintsSchema.safeParse({ decoratorss: [] });
        expect(result.success).toBe(true);
    });

    it('rejects nested TYPE errors inside known sections (wrong enum value)', () => {
        // Nested UNKNOWN keys are deliberately tolerated (runtime sections are
        // non-strict and the twin shares the same field definitions); nested
        // typos are caught downstream by the semantic dry-run ("declared but
        // matches nothing"). Type/enum errors are caught here.
        const result = RepoHintsStrictSchema.safeParse({
            decorators: [{ name: 'X', kind: 'not-a-kind' }],
        });
        expect(result.success).toBe(false);
    });
});
