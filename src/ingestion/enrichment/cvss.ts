/**
 * CVSS v3.0 / v3.1 base score computation.
 *
 * OSV severity entries carry the CVSS *vector string* only — the numeric
 * base score must be derived from the metrics per the FIRST specification
 * (https://www.first.org/cvss/v3.1/specification-document, section 7).
 */

const ATTACK_VECTOR: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const ATTACK_COMPLEXITY: Record<string, number> = { L: 0.77, H: 0.44 };
const PRIVILEGES_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PRIVILEGES_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const USER_INTERACTION: Record<string, number> = { N: 0.85, R: 0.62 };
const IMPACT: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/**
 * Compute the CVSS v3.x base score from a vector string.
 * Returns null for malformed vectors or non-v3 versions (v2, v4).
 */
export function computeCvssV3BaseScore(vector: string): number | null {
    const metrics = parseV3Vector(vector);
    if (!metrics) return null;

    const scopeChanged = metrics.S === 'C';
    const exploitability = 8.22
        * ATTACK_VECTOR[metrics.AV]
        * ATTACK_COMPLEXITY[metrics.AC]
        * (scopeChanged ? PRIVILEGES_CHANGED : PRIVILEGES_UNCHANGED)[metrics.PR]
        * USER_INTERACTION[metrics.UI];

    const iss = 1 - (1 - IMPACT[metrics.C]) * (1 - IMPACT[metrics.I]) * (1 - IMPACT[metrics.A]);
    const impact = scopeChanged
        ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
        : 6.42 * iss;

    if (impact <= 0) return 0;
    const raw = scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability;
    return roundUp(Math.min(raw, 10));
}

// ─── Internals ──────────────────────────────────────────────────────────────

type V3Metrics = { AV: string; AC: string; PR: string; UI: string; S: string; C: string; I: string; A: string };

const REQUIRED_METRICS = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'] as const;

function parseV3Vector(vector: string): V3Metrics | null {
    const segments = vector.split('/');
    if (!/^CVSS:3\.[01]$/.test(segments[0] ?? '')) return null;

    const parsed: Record<string, string> = {};
    for (const segment of segments.slice(1)) {
        const [key, value] = segment.split(':');
        if (key && value) parsed[key] = value;
    }

    const valid = REQUIRED_METRICS.every(key => (parsed[key] ?? '') in weightTable(key, parsed.S ?? 'U'));
    return valid ? (parsed as V3Metrics) : null;
}

function weightTable(metric: string, scope: string): Record<string, number> {
    switch (metric) {
        case 'AV': return ATTACK_VECTOR;
        case 'AC': return ATTACK_COMPLEXITY;
        case 'PR': return scope === 'C' ? PRIVILEGES_CHANGED : PRIVILEGES_UNCHANGED;
        case 'UI': return USER_INTERACTION;
        case 'S': return { U: 1, C: 1 };
        default: return IMPACT;
    }
}

/** Spec-defined Roundup: smallest number with one decimal >= input, FP-safe. */
function roundUp(value: number): number {
    const scaled = Math.round(value * 100_000);
    return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}
