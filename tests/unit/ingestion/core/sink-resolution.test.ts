import { describe, it, expect } from 'vitest';
import { resolveSinks } from '../../../../src/ingestion/core/sink-resolution.js';
import type { ClassifiedPackage } from '../../../../src/ai/agents/sink-classifier/schema.js';

const HARDCODED_SINKS = new Set(['pg', 'axios']);
const HARDCODED_IGNORES = new Set(['dd-trace', 'pino']);

function llm(name: string, sinkType: ClassifiedPackage['sinkType'], confidence = 0.9): ClassifiedPackage {
    return { name, sinkType, confidence, evidence: [`evidence-for-${name}`] };
}

describe('resolveSinks — layered precedence', () => {
    it('hardcoded sinks/ignores apply when no user/llm input', () => {
        const r = resolveSinks({
            externalPackages: ['pg', 'dd-trace', 'lodash'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: [],
            llmClassifications: [],
        });
        expect(r.sinks.has('pg')).toBe(true);
        expect(r.ignores.has('dd-trace')).toBe(true);
        expect(r.audit.get('pg')?.source).toBe('hardcoded.sink');
        expect(r.audit.get('dd-trace')?.source).toBe('hardcoded.ignore');
    });

    it('user.ignore wins over hardcoded.sink', () => {
        const r = resolveSinks({
            externalPackages: ['pg'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: ['pg'],
            llmClassifications: [],
        });
        expect(r.ignores.has('pg')).toBe(true);
        expect(r.sinks.has('pg')).toBe(false);
        expect(r.audit.get('pg')?.source).toBe('user.ignore');
    });

    it('user.analyze wins over hardcoded.ignore', () => {
        const r = resolveSinks({
            externalPackages: ['dd-trace'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: ['dd-trace'],
            userIgnore: [],
            llmClassifications: [],
        });
        expect(r.sinks.has('dd-trace')).toBe(true);
        expect(r.audit.get('dd-trace')?.source).toBe('user.analyze');
    });

    it('user.ignore wins over user.analyze (highest precedence)', () => {
        const r = resolveSinks({
            externalPackages: ['pg'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: ['pg'],
            userIgnore: ['pg'],
            llmClassifications: [],
        });
        expect(r.audit.get('pg')?.source).toBe('user.ignore');
        expect(r.ignores.has('pg')).toBe(true);
    });

    it('LLM only fills gaps when no other layer covers a package', () => {
        const r = resolveSinks({
            externalPackages: ['kafkajs', 'pg'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: [],
            llmClassifications: [
                llm('kafkajs', 'MessageChannel'),
                llm('pg', 'NotASink'), // would lose to hardcoded.sink
            ],
        });
        expect(r.audit.get('kafkajs')?.source).toBe('llm');
        expect(r.sinks.has('kafkajs')).toBe(true);
        // hardcoded says pg is sink — LLM cannot override
        expect(r.audit.get('pg')?.source).toBe('hardcoded.sink');
        expect(r.sinks.has('pg')).toBe(true);
    });

    it('LLM Observability classification → ignores', () => {
        const r = resolveSinks({
            externalPackages: ['custom-tracer'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: [],
            llmClassifications: [llm('custom-tracer', 'Observability')],
        });
        expect(r.ignores.has('custom-tracer')).toBe(true);
        expect(r.audit.get('custom-tracer')?.source).toBe('llm');
    });

    it('LLM NotASink classification → ignores (negative caching)', () => {
        const r = resolveSinks({
            externalPackages: ['lodash'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: [],
            llmClassifications: [llm('lodash', 'NotASink')],
        });
        expect(r.ignores.has('lodash')).toBe(true);
        expect(r.sinks.has('lodash')).toBe(false);
    });

    it('drift: records LLM disagreement with hardcoded.sink', () => {
        const r = resolveSinks({
            externalPackages: ['pg'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: [],
            llmClassifications: [llm('pg', 'NotASink')],
        });
        expect(r.drift.llmDisagreesWithHardcoded).toContainEqual({
            name: 'pg', hardcoded: 'sink', llm: 'NotASink',
        });
    });

    it('drift: records new sinks discovered by LLM', () => {
        const r = resolveSinks({
            externalPackages: ['my-private-broker'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: [],
            llmClassifications: [llm('my-private-broker', 'MessageChannel')],
        });
        expect(r.drift.newSinksDiscoveredByLLM).toContain('my-private-broker');
    });

    it('drift: confidence 0.7-0.85 lands in confidenceLowConcern', () => {
        const r = resolveSinks({
            externalPackages: ['fuzzy-pkg'],
            hardcodedSinks: HARDCODED_SINKS,
            hardcodedIgnores: HARDCODED_IGNORES,
            userAnalyze: [],
            userIgnore: [],
            llmClassifications: [llm('fuzzy-pkg', 'Database', 0.75)],
        });
        expect(r.drift.confidenceLowConcern).toContain('fuzzy-pkg');
    });
});
