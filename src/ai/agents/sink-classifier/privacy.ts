// ═══════════════════════════════════════════════════════════════════════════════
// Privacy filter — package names that must NEVER reach the LLM.
//
// Enterprise repos contain internal packages (`@acme-internal/*`) whose mere
// existence is confidential. This filter excises them BEFORE the prompt is
// constructed and applies a deterministic policy in their place.
//
// ─── Operational guidance ────────────────────────────────────────────────────
// The classifier sees ONLY package names — there is no per-package source
// context in the prompt. For monorepos with many proprietary packages whose
// name alone is ambiguous (e.g. `@acme/legacy-db-wrapper`), the LLM cannot
// reliably decide. Two options:
//
// 1. Pin: list each ambiguous package in `coderadius.yaml` `packages.analyze`
//    or `packages.ignore` so the user-overrides layer wins deterministically.
// 2. Bulk-deny: add a glob to `privacy.deny_patterns` (e.g. `@acme/*`) so the
//    classifier never even sees them; choose `on_denied: classify_as_sink`
//    to preserve blast-radius coverage.
//
// `allow_patterns` is the most restrictive setting: when non-empty, ONLY
// matches reach the LLM. Use it in air-gapped/regulated tenants to allow-list
// open-source packages and silently treat everything else as private.
// ═══════════════════════════════════════════════════════════════════════════════

import type { ClassifierInput, ClassifiedPackage } from './schema.js';

export type OnDeniedPolicy = 'classify_as_sink' | 'classify_as_ignore' | 'hardcoded_only';

export interface PrivacyConfig {
    /** Glob-like patterns. If a package matches ANY, it is denied. */
    denyPatterns: string[];
    /** If non-empty, ONLY packages matching at least one pattern reach the LLM. */
    allowPatterns: string[];
    /** Default fate of denied packages. */
    onDenied: OnDeniedPolicy;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
    denyPatterns: [],
    allowPatterns: [],
    onDenied: 'classify_as_sink',
};

export interface FilterResult {
    /** Packages that may safely be sent to the LLM. */
    sentToLLM: ClassifierInput[];
    /** Pre-computed decisions for denied packages. */
    deniedDecisions: ClassifiedPackage[];
    /** Names that were filtered (for telemetry). */
    deniedNames: string[];
}

function compilePattern(pattern: string): RegExp {
    // Glob → regex. Supports * and **; anchored.
    const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
}

function matchesAny(name: string, patterns: RegExp[]): boolean {
    return patterns.some(re => re.test(name));
}

export function filterForLLM(
    packages: ClassifierInput[],
    cfg: PrivacyConfig = DEFAULT_PRIVACY_CONFIG,
): FilterResult {
    const denyRegexes = cfg.denyPatterns.map(compilePattern);
    const allowRegexes = cfg.allowPatterns.map(compilePattern);

    const sentToLLM: ClassifierInput[] = [];
    const deniedDecisions: ClassifiedPackage[] = [];
    const deniedNames: string[] = [];

    for (const pkg of packages) {
        const denied = denyRegexes.length > 0 && matchesAny(pkg.name, denyRegexes);
        const allowedExplicitly = allowRegexes.length === 0 || matchesAny(pkg.name, allowRegexes);

        if (denied || !allowedExplicitly) {
            deniedNames.push(pkg.name);
            const decision = decisionForDenied(pkg.name, cfg.onDenied);
            if (decision) deniedDecisions.push(decision);
            continue;
        }

        sentToLLM.push(pkg);
    }

    return { sentToLLM, deniedDecisions, deniedNames };
}

function decisionForDenied(name: string, policy: OnDeniedPolicy): ClassifiedPackage | null {
    switch (policy) {
        case 'classify_as_sink':
            return {
                name,
                sinkType: 'Other',
                confidence: 1.0,
                evidence: ['privacy-filtered: classified as sink to preserve blast-radius coverage'],
                otherLabel: 'privacy-internal',
            };
        case 'classify_as_ignore':
            return {
                name,
                sinkType: 'NotASink',
                confidence: 1.0,
                evidence: ['privacy-filtered: excluded from sink registry by config'],
            };
        case 'hardcoded_only':
            // Skip it entirely — falls back to whatever Layer 2 (hardcoded) says.
            return null;
    }
}
