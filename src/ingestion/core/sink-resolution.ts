// ═══════════════════════════════════════════════════════════════════════════════
// Sink Resolution — deterministic merge of all sink layers.
//
// Layers (precedence high → low):
//   1. user.ignore       — packages.ignore in coderadius.yaml
//   2. user.analyze      — packages.analyze in coderadius.yaml
//   3. hardcoded         — KNOWN_IO_SINKS / OBSERVABILITY_PACKAGES
//   4. llm-classified    — output of the sink classifier
//
// Output is a partition of the universe of seen package names into:
//   sinks:    packages that should propagate taint
//   ignores:  packages that must NOT propagate taint
//   audit:    explanation per package (which layer won, why)
//   drift:    where layers disagreed (informational, for ops)
// ═══════════════════════════════════════════════════════════════════════════════

import type { ClassifiedPackage } from '../../ai/agents/sink-classifier/schema.js';

export type AuditSource =
    | 'user.ignore'
    | 'user.analyze'
    | 'hardcoded.sink'
    | 'hardcoded.ignore'
    | 'llm';

export interface AuditEntry {
    package: string;
    decision: 'sink' | 'ignore';
    source: AuditSource;
    sinkType?: string;
    confidence?: number;
    reason?: string;
}

export interface DriftReport {
    /** LLM said sink, hardcoded said ignore (or vice versa). */
    llmDisagreesWithHardcoded: Array<{ name: string; hardcoded: 'sink' | 'ignore'; llm: string }>;
    /** Sinks discovered by LLM that aren't in hardcoded sets. */
    newSinksDiscoveredByLLM: string[];
    /** Confidence in the [confidenceThreshold, 0.85) band — flag for review. */
    confidenceLowConcern: string[];
}

export interface ResolvedSinkRegistry {
    sinks: Set<string>;
    ignores: Set<string>;
    audit: Map<string, AuditEntry>;
    drift: DriftReport;
}

export interface ResolveSinksArgs {
    /** All packages we observed in the repo (for completeness checks). */
    externalPackages: string[];
    hardcodedSinks: Set<string>;
    hardcodedIgnores: Set<string>;
    userAnalyze: string[];
    userIgnore: string[];
    llmClassifications: ClassifiedPackage[];
    /** Threshold below which an LLM result is flagged in drift.confidenceLowConcern. */
    confidenceLowBand?: number;
}

export function resolveSinks(args: ResolveSinksArgs): ResolvedSinkRegistry {
    const sinks = new Set<string>();
    const ignores = new Set<string>();
    const audit = new Map<string, AuditEntry>();
    const drift: DriftReport = {
        llmDisagreesWithHardcoded: [],
        newSinksDiscoveredByLLM: [],
        confidenceLowConcern: [],
    };
    const lowBand = args.confidenceLowBand ?? 0.85;

    const setIgnore = (name: string, source: AuditSource, reason?: string) => {
        sinks.delete(name);
        ignores.add(name);
        audit.set(name, { package: name, decision: 'ignore', source, reason });
    };
    const setSink = (name: string, source: AuditSource, reason?: string, sinkType?: string, confidence?: number) => {
        // Cannot override an ignore set by a higher-precedence layer.
        if (audit.get(name)?.source === 'user.ignore') return;
        ignores.delete(name);
        sinks.add(name);
        audit.set(name, { package: name, decision: 'sink', source, reason, sinkType, confidence });
    };

    // Layer 1: user.ignore (highest precedence — wins over everything)
    for (const name of args.userIgnore) {
        setIgnore(name, 'user.ignore', 'coderadius.yaml packages.ignore');
    }

    // Layer 2: user.analyze (overrides hardcoded/LLM)
    for (const name of args.userAnalyze) {
        if (audit.get(name)?.source === 'user.ignore') continue;
        setSink(name, 'user.analyze', 'coderadius.yaml packages.analyze');
    }

    // Layer 3: hardcoded
    for (const name of args.hardcodedIgnores) {
        if (audit.has(name)) continue;
        setIgnore(name, 'hardcoded.ignore', 'OBSERVABILITY_PACKAGES');
    }
    for (const name of args.hardcodedSinks) {
        if (audit.has(name)) continue;
        setSink(name, 'hardcoded.sink', 'KNOWN_IO_SINKS');
    }

    // Layer 4: LLM
    for (const c of args.llmClassifications) {
        const existing = audit.get(c.name);

        // Drift detection BEFORE applying (compare against hardcoded layer)
        const inHardcodedSinks = args.hardcodedSinks.has(c.name);
        const inHardcodedIgnores = args.hardcodedIgnores.has(c.name);
        if (inHardcodedSinks && c.sinkType === 'NotASink') {
            drift.llmDisagreesWithHardcoded.push({ name: c.name, hardcoded: 'sink', llm: c.sinkType });
        }
        if (inHardcodedIgnores && c.sinkType !== 'Observability' && c.sinkType !== 'NotASink') {
            drift.llmDisagreesWithHardcoded.push({ name: c.name, hardcoded: 'ignore', llm: c.sinkType });
        }
        if (
            !inHardcodedSinks &&
            !inHardcodedIgnores &&
            c.sinkType !== 'NotASink' &&
            c.sinkType !== 'Observability'
        ) {
            drift.newSinksDiscoveredByLLM.push(c.name);
        }
        if (c.confidence < lowBand) {
            drift.confidenceLowConcern.push(c.name);
        }

        // User layers and hardcoded layers always win — LLM only fills gaps.
        if (existing) continue;

        if (c.sinkType === 'Observability' || c.sinkType === 'NotASink') {
            setIgnore(c.name, 'llm', `llm: ${c.sinkType} (conf ${c.confidence.toFixed(2)})`);
        } else {
            setSink(
                c.name,
                'llm',
                c.evidence[0] ?? `llm: ${c.sinkType}`,
                c.sinkType,
                c.confidence,
            );
        }
    }

    return { sinks, ignores, audit, drift };
}
