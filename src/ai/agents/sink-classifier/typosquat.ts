// ═══════════════════════════════════════════════════════════════════════════════
// Typosquat detector — flag names that are 1-edit close to well-known sinks.
//
// Defends against malicious LLM hallucinations and against actual typosquats
// in dependency graphs (e.g. `expreess`, `axioos`, `lodahs`).
// ═══════════════════════════════════════════════════════════════════════════════

const WELL_KNOWN = [
    'axios', 'fetch', 'got', 'undici', 'superagent', 'ky',
    'express', 'fastify', 'koa', 'hapi',
    'lodash', 'underscore', 'ramda',
    'react', 'vue', 'angular', 'svelte',
    'pg', 'mysql', 'mongodb', 'mongoose', 'redis', 'ioredis',
    'prisma', 'typeorm', 'sequelize', 'knex',
    'kafkajs', 'amqplib', 'bullmq',
    'stripe', 'twilio',
];

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1).fill(0);
    let curr = new Array(n + 1).fill(0);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

/**
 * Returns the well-known package name `name` is 1 edit away from, or null.
 *
 * Skips identical matches (those are the well-known package itself, not a
 * typosquat). Names ≤ 3 chars are skipped — too noisy.
 */
export function detectTyposquat(name: string): string | null {
    if (name.length <= 3) return null;
    const lower = name.toLowerCase();
    for (const known of WELL_KNOWN) {
        if (lower === known) return null; // exact match, not a squat
        if (Math.abs(lower.length - known.length) > 1) continue;
        if (levenshtein(lower, known) === 1) return known;
    }
    return null;
}
