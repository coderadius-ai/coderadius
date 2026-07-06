import { describe, it, expect } from 'vitest';
import { filterForLLM, type PrivacyConfig } from '../../../../src/ai/agents/sink-classifier/privacy.js';

const cfg = (over: Partial<PrivacyConfig> = {}): PrivacyConfig => ({
    denyPatterns: [],
    allowPatterns: [],
    onDenied: 'classify_as_sink',
    ...over,
});

describe('Sink Classifier — privacy filter', () => {
    it('lets everything through when no patterns are configured', () => {
        const res = filterForLLM(
            [
                { name: 'axios', ecosystem: 'npm' },
                { name: '@acme-internal/secret-db', ecosystem: 'npm' },
            ],
            cfg(),
        );
        expect(res.sentToLLM.map(p => p.name).sort()).toEqual(['@acme-internal/secret-db', 'axios']);
        expect(res.deniedDecisions).toEqual([]);
        expect(res.deniedNames).toEqual([]);
    });

    it('drops packages matching deny_patterns and emits classify_as_sink decisions by default', () => {
        const res = filterForLLM(
            [
                { name: 'axios', ecosystem: 'npm' },
                { name: '@acme-internal/db', ecosystem: 'npm' },
                { name: '@acme-internal/auth', ecosystem: 'npm' },
            ],
            cfg({ denyPatterns: ['@acme-internal/*'] }),
        );
        expect(res.sentToLLM.map(p => p.name)).toEqual(['axios']);
        expect(res.deniedNames.sort()).toEqual(['@acme-internal/auth', '@acme-internal/db']);
        expect(res.deniedDecisions).toHaveLength(2);
        expect(res.deniedDecisions[0]).toMatchObject({
            sinkType: 'Other',
            otherLabel: 'privacy-internal',
        });
    });

    it('classify_as_ignore policy yields NotASink decisions', () => {
        const res = filterForLLM(
            [{ name: '@acme-internal/db', ecosystem: 'npm' }],
            cfg({ denyPatterns: ['@acme-internal/*'], onDenied: 'classify_as_ignore' }),
        );
        expect(res.deniedDecisions[0]).toMatchObject({ sinkType: 'NotASink' });
    });

    it('hardcoded_only policy emits NO decision (resolver falls back to layer 2)', () => {
        const res = filterForLLM(
            [{ name: '@acme-internal/db', ecosystem: 'npm' }],
            cfg({ denyPatterns: ['@acme-internal/*'], onDenied: 'hardcoded_only' }),
        );
        expect(res.deniedDecisions).toEqual([]);
        expect(res.deniedNames).toEqual(['@acme-internal/db']);
    });

    it('allow_patterns: when non-empty, only matching packages reach the LLM', () => {
        const res = filterForLLM(
            [
                { name: 'axios', ecosystem: 'npm' },
                { name: 'lodash', ecosystem: 'npm' },
                { name: '@acme/public', ecosystem: 'npm' },
            ],
            cfg({ allowPatterns: ['axios', '@acme/*'] }),
        );
        expect(res.sentToLLM.map(p => p.name).sort()).toEqual(['@acme/public', 'axios']);
        expect(res.deniedNames).toEqual(['lodash']);
    });

    it('deny vs allow: deny wins', () => {
        const res = filterForLLM(
            [
                { name: 'axios', ecosystem: 'npm' },
                { name: '@acme/foo', ecosystem: 'npm' },
            ],
            cfg({ denyPatterns: ['@acme/*'], allowPatterns: ['@acme/*', 'axios'] }),
        );
        expect(res.sentToLLM.map(p => p.name)).toEqual(['axios']);
        expect(res.deniedNames).toEqual(['@acme/foo']);
    });
});
