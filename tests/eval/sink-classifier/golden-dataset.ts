// ═══════════════════════════════════════════════════════════════════════════════
// Sink Classifier — Golden Dataset
//
// Curated list of well-known packages with their expected classification.
// Covers all 7 SinkType categories + NotASink + adversarial cases (typosquats,
// ambiguous names) to validate both happy-path and anti-hallucination.
//
// Add new entries here when:
//   - the LLM mis-classifies a real-world package (regression guard)
//   - we want to lock down behavior on a category we haven't covered
// ═══════════════════════════════════════════════════════════════════════════════

import type { SinkType } from '../../../src/ai/agents/sink-classifier/schema.js';

export interface GoldenCase {
    name: string;
    ecosystem: 'npm' | 'composer' | 'pypi' | 'go';
    /** Expected sinkType. Use a Set when more than one is acceptable. */
    expected: SinkType | SinkType[];
    /** Optional: minimum confidence we expect (defaults to 0.7 — the classifier threshold). */
    minConfidence?: number;
    /** Optional category description for grouping in test output. */
    category: string;
}

export const GOLDEN_CASES: GoldenCase[] = [
    // ── HTTP / External API clients ──────────────────────────────────────────
    { name: 'axios', ecosystem: 'npm', expected: 'ExternalAPI', category: 'http-client' },
    { name: 'got', ecosystem: 'npm', expected: 'ExternalAPI', category: 'http-client' },
    { name: 'undici', ecosystem: 'npm', expected: 'ExternalAPI', category: 'http-client' },
    { name: '@apollo/client', ecosystem: 'npm', expected: 'ExternalAPI', category: 'graphql-client' },

    // ── Databases ────────────────────────────────────────────────────────────
    { name: 'pg', ecosystem: 'npm', expected: 'Database', category: 'database' },
    { name: 'mongodb', ecosystem: 'npm', expected: 'Database', category: 'database' },
    { name: 'mongoose', ecosystem: 'npm', expected: 'Database', category: 'database' },
    { name: 'prisma', ecosystem: 'npm', expected: 'Database', category: 'database' },
    { name: 'typeorm', ecosystem: 'npm', expected: 'Database', category: 'database' },
    { name: 'doctrine/orm', ecosystem: 'composer', expected: 'Database', category: 'database' },

    // ── Cache ────────────────────────────────────────────────────────────────
    { name: 'redis', ecosystem: 'npm', expected: 'Cache', category: 'cache' },
    { name: 'ioredis', ecosystem: 'npm', expected: 'Cache', category: 'cache' },
    { name: 'memcached', ecosystem: 'npm', expected: 'Cache', category: 'cache' },

    // ── Message channels ─────────────────────────────────────────────────────
    { name: 'kafkajs', ecosystem: 'npm', expected: 'MessageChannel', category: 'broker' },
    { name: 'amqplib', ecosystem: 'npm', expected: 'MessageChannel', category: 'broker' },
    { name: 'bullmq', ecosystem: 'npm', expected: 'MessageChannel', category: 'broker' },
    { name: '@google-cloud/pubsub', ecosystem: 'npm', expected: 'MessageChannel', category: 'broker' },
    { name: 'symfony/messenger', ecosystem: 'composer', expected: 'MessageChannel', category: 'broker' },

    // ── Object storage ───────────────────────────────────────────────────────
    { name: '@aws-sdk/client-s3', ecosystem: 'npm', expected: 'ObjectStorage', category: 'storage' },
    { name: '@google-cloud/storage', ecosystem: 'npm', expected: 'ObjectStorage', category: 'storage' },
    { name: '@azure/storage-blob', ecosystem: 'npm', expected: 'ObjectStorage', category: 'storage' },

    // ── Process / job orchestration ──────────────────────────────────────────
    { name: '@temporalio/client', ecosystem: 'npm', expected: 'Process', category: 'process' },
    { name: 'execa', ecosystem: 'npm', expected: 'Process', category: 'process' },

    // ── Observability (negative-taint) ───────────────────────────────────────
    { name: 'dd-trace', ecosystem: 'npm', expected: 'Observability', category: 'observability' },
    { name: '@sentry/node', ecosystem: 'npm', expected: 'Observability', category: 'observability' },
    { name: 'prom-client', ecosystem: 'npm', expected: 'Observability', category: 'observability' },
    { name: 'winston', ecosystem: 'npm', expected: 'Observability', category: 'observability' },

    // ── "Other" — clearly I/O but doesn't fit primary categories ─────────────
    { name: 'stripe', ecosystem: 'npm', expected: ['Other', 'ExternalAPI'], category: 'payment-sdk' },
    { name: 'twilio', ecosystem: 'npm', expected: ['Other', 'ExternalAPI'], category: 'sms-sdk' },

    // ── NotASink — pure utilities ────────────────────────────────────────────
    { name: 'lodash', ecosystem: 'npm', expected: 'NotASink', category: 'utility' },
    { name: 'date-fns', ecosystem: 'npm', expected: 'NotASink', category: 'utility' },
    { name: 'zod', ecosystem: 'npm', expected: 'NotASink', category: 'validation' },
    { name: 'react', ecosystem: 'npm', expected: 'NotASink', category: 'ui-framework' },
    { name: 'typescript', ecosystem: 'npm', expected: 'NotASink', category: 'tooling' },
    { name: 'vitest', ecosystem: 'npm', expected: 'NotASink', category: 'tooling' },
];

// Adversarial cases — these MUST be rejected by anti-hallucination, never
// reach the resolved sink set. They are tested separately (not as golden
// classifications) because the contract is "rejected".
export const ADVERSARIAL_TYPOSQUATS: string[] = [
    'expreess',
    'axioos',
    'reddis',
    'stripee',
];

// Ambiguous internal-looking package names that the classifier should NOT
// confidently mark as a sink (low confidence or NotASink expected).
export const AMBIGUOUS_INTERNAL: string[] = [
    '@acme-internal/legacy-db-wrapper',
    '@acme-internal/feature-x',
];
