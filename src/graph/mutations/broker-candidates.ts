/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BrokerCandidate ledger — grounded broker discovery (late binding).
 *
 * Env-derived broker hints are persisted as `:BrokerCandidate` nodes instead of
 * minting `:MessageBroker` facts at recognition time. `bindBrokerCandidates()`
 * is a graph-only reconcile pass (replayable after ANY ingest, including
 * `analyze infra`) that materialises brokers through four grounded routes:
 *
 *   a1 — anchor: the candidate's host VALUE matches an existing broker
 *        (ambiguity rules: provider match when known, exact vhost when known,
 *        a null vhost may adopt a UNIQUE vhost-bearing broker, never blind).
 *   a2 — self-anchor: s1 candidates (URI scheme = contract) create directly.
 *   a3 — convergence: candidates from ≥2 DISTINCT repos agree on the host.
 *        Cleanliness is PER-FIELD: the host is corroborated by agreement, the
 *        provider is clean only when at least one source is contract-grade
 *        ('scheme'/'declared'); a provider known only from key-names stays a
 *        guess → broker minted with needsReview=true (a3-guess-provider).
 *   s3 — residual: legacy key-name candidates still mint (recall) but always
 *        needsReview=true; cross-service welds gate on that flag.
 *
 * Unbindable candidates REMAIN visible (needsReview ledger + telemetry): they
 * are the negative signal "broker-ish value seen, nothing grounded it" — the
 * antidote to silent recall loss. Lifecycle mirrors UnresolvedDependency
 * (c4.ts) except the unmatched-drop: candidates are only GC'd when their
 * owning Service is gone.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import { run } from './_run.js';
import { applyFallback, type GroundingFields } from '../grounding.js';
import { linkServiceConnectsToBroker, mergeMessageBroker, type MessageBrokerProvider } from './data-contracts.js';
import type {
    BrokerCandidateSource,
    BrokerProviderSource,
} from '../../ingestion/processors/connection-extractors/types.js';
import type { MessageBrokerHintProvider } from '../../ingestion/processors/connection-extractors/types.js';
import { normalizeHost } from '../../ingestion/processors/physical-fingerprint.js';
import {
    classifyBrokerFingerprintScope,
    computeBrokerFingerprint,
    makeBrokerUrn,
} from '../../ingestion/core/messaging/broker-registry.js';

/**
 * Decoupled from `BrokerCandidateHint` deliberately: env-var hints carry a
 * required `sourceEnvKey`; config-declared connections carry NONE (a fake
 * key would poison the reaper and the value-attribution semantics) plus a
 * `connectionName`. Callers map their hint type explicitly.
 */
export interface MergeBrokerCandidateInput {
    source: BrokerCandidateSource;
    provider?: MessageBrokerHintProvider;
    providerSource?: BrokerProviderSource;
    host: string;
    port?: number;
    vhost?: string;
    /** Required for env-var lanes; ABSENT for config-declared candidates. */
    sourceEnvKey?: string;
    /** Config-level connection name (s4 lane) — joined by channel binding. */
    connectionName?: string;
    sourceType: 'env-var' | 'config';
    sourceFile?: string;
    confidence: 'high' | 'medium' | 'low';
    serviceUrn: string;
    /** Qualified repo name — convergence independence is keyed on this. */
    repoUrn: string;
}

const PROVIDER_SOURCE_RANK: Record<BrokerProviderSource, number> = {
    scheme: 3,
    declared: 2,
    'key-name': 1,
};

const CONTRACT_PROVIDER_SOURCES: ReadonlySet<string> = new Set(['scheme', 'declared']);

function candidateUrn(serviceUrn: string, host: string, port: number | undefined, vhost: string | undefined): string {
    const hash = createHash('sha256')
        .update([serviceUrn, host, port ?? '', vhost ?? ''].join('|'))
        .digest('hex')
        .slice(0, 8);
    return `cr:brokercandidate:${hash}`;
}

/**
 * Persist (or enrich) a broker candidate. Identity is
 * (serviceUrn, normalizedHost, port, vhost) — provider is a mutable property
 * upgraded by source rank (scheme > declared > key-name), never identity.
 */
export async function mergeBrokerCandidate(
    input: MergeBrokerCandidateInput,
    commitHash: string,
): Promise<string> {
    const host = normalizeHost(input.host);
    const urn = candidateUrn(input.serviceUrn, host, input.port, input.vhost);
    const rank = input.providerSource ? PROVIDER_SOURCE_RANK[input.providerSource] : 0;
    // Config candidates have NO env key: sourceEnvKeys stays [] (never [null]).
    const sourceEnvKeys = input.sourceEnvKey ? [input.sourceEnvKey] : [];
    await run(
        `MERGE (c:BrokerCandidate {id: $urn})
         ON CREATE SET c.valid_from_commit = $commitHash, c.valid_to_commit = null,
                       c.serviceUrn = $serviceUrn, c.repoUrn = $repoUrn,
                       c.name = CASE WHEN $vhost IS NULL THEN $host ELSE $host + '/' + $vhost END,
                       c.host = $host, c.port = $port, c.vhost = $vhost,
                       c.sourceEnvKeys = $sourceEnvKeys, c.sourceFile = $sourceFile,
                       c.confidence = $confidence,
                       c.needsReview = true, c.providerRank = 0,
                       c.source = 'heuristic', c.quality = 'speculative',
                       c.evidence_extractors = ['broker-candidate@v1']
         ON MATCH SET c.valid_to_commit = null,
                      c.sourceEnvKeys = reduce(_acc = coalesce(c.sourceEnvKeys, []),
                          _k IN $sourceEnvKeys | CASE WHEN _k IN _acc THEN _acc ELSE _acc + _k END)
         SET c.connectionName = coalesce($connectionName, c.connectionName),
             c.sourceType = CASE WHEN $sourceType = 'config' OR c.sourceType = 'config'
                                 THEN 'config' ELSE coalesce(c.sourceType, $sourceType) END,
             c.candidateSource = CASE WHEN $candidateSource = 's4-config-declared' OR c.candidateSource = 's4-config-declared'
                                      THEN 's4-config-declared' ELSE coalesce(c.candidateSource, $candidateSource) END,
             c.provider = CASE WHEN $rank > coalesce(c.providerRank, 0) THEN $provider ELSE c.provider END,
             c.providerSource = CASE WHEN $rank > coalesce(c.providerRank, 0) THEN $providerSource ELSE c.providerSource END,
             c.providerRank = CASE WHEN $rank > coalesce(c.providerRank, 0) THEN $rank ELSE c.providerRank END`,
        {
            urn, commitHash,
            serviceUrn: input.serviceUrn,
            repoUrn: input.repoUrn,
            host,
            port: input.port ?? null,
            vhost: input.vhost ?? null,
            sourceEnvKeys,
            sourceFile: input.sourceFile ?? null,
            // Runtime fallback mirrors linkServiceConnectsToBroker: 'env-var'
            // is the historical citizenship of hint-derived candidates.
            sourceType: input.sourceType ?? 'env-var',
            connectionName: input.connectionName ?? null,
            candidateSource: input.source,
            confidence: input.confidence,
            provider: input.provider ?? null,
            providerSource: input.providerSource ?? null,
            rank,
        },
    );
    await run(
        `MATCH (s:Service {id: $serviceUrn}), (c:BrokerCandidate {id: $urn})
         MERGE (s)-[r:HAS_BROKER_CANDIDATE]->(c)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null`,
        { serviceUrn: input.serviceUrn, urn, commitHash },
    );
    return urn;
}

export interface BindBrokerCandidatesResult {
    /** Candidates anchored onto a pre-existing broker (a1). */
    boundExisting: number;
    /** Brokers minted from scheme candidates (a2, clean). */
    createdSelfAnchored: number;
    /** Convergence groups minted with a contract-grade provider (a3-clean). */
    convergedClean: number;
    /** Convergence groups minted with provider only from key-names (a3-guess). */
    convergedGuess: number;
    /** s4 config-declared brokers minted with clean AST grounding. */
    createdConfigDeclared: number;
    /** s3 key-name residual brokers minted alone (guess, needsReview). */
    createdGuess: number;
    /** s2 declared residual brokers minted alone (declared provider, values uncorroborated, needsReview). */
    createdDeclaredReview: number;
    /** Residual twins suppressed because a config-declared broker already explains the host. */
    shadowedByConfig: number;
    /** Candidates left in the ledger (visible, needsReview). */
    unbound: number;
    /** CONNECTS_TO bindings landing on a needsReview broker this run. */
    guessOnlyBindings: number;
}

interface CandidateRow {
    id: string;
    serviceUrn: string;
    repoUrn: string;
    host: string;
    port?: number;
    vhost?: string;
    provider?: MessageBrokerProvider;
    providerSource?: BrokerProviderSource;
    candidateSource: string;
    sourceEnvKeys: string[];
    /** Drives the CONNECTS_TO edge `source` on EVERY bind path (a1/a2/a3/s4/residual). */
    sourceType: 'env-var' | 'config';
    connectionName?: string;
    sourceFile?: string;
    confidence?: 'high' | 'medium' | 'low';
}

interface BrokerRow {
    id: string;
    provider: string;
    host?: string;
    port?: number;
    vhost?: string;
    needsReview: boolean;
    declaredVia?: string;
}

async function fetchLiveCandidates(): Promise<CandidateRow[]> {
    const result = await run(
        `MATCH (c:BrokerCandidate) WHERE c.valid_to_commit IS NULL
         RETURN c.id AS id, c.serviceUrn AS serviceUrn, c.repoUrn AS repoUrn,
                c.host AS host, c.port AS port, c.vhost AS vhost,
                c.provider AS provider, c.providerSource AS providerSource,
                c.candidateSource AS candidateSource,
                coalesce(c.sourceEnvKeys, []) AS sourceEnvKeys,
                coalesce(c.sourceType, 'env-var') AS sourceType,
                c.connectionName AS connectionName,
                c.sourceFile AS sourceFile,
                c.confidence AS confidence
         ORDER BY c.id`,
    );
    return result.records.map(r => ({
        id: r.get('id') as string,
        serviceUrn: r.get('serviceUrn') as string,
        repoUrn: r.get('repoUrn') as string,
        host: r.get('host') as string,
        port: toOptionalNumber(r.get('port')),
        vhost: (r.get('vhost') as string | null) ?? undefined,
        provider: (r.get('provider') as MessageBrokerProvider | null) ?? undefined,
        providerSource: (r.get('providerSource') as BrokerProviderSource | null) ?? undefined,
        candidateSource: r.get('candidateSource') as string,
        sourceEnvKeys: r.get('sourceEnvKeys') as string[],
        sourceType: r.get('sourceType') as 'env-var' | 'config',
        connectionName: (r.get('connectionName') as string | null) ?? undefined,
        sourceFile: (r.get('sourceFile') as string | null) ?? undefined,
        confidence: (r.get('confidence') as 'high' | 'medium' | 'low' | null) ?? undefined,
    }));
}

function toOptionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object' && 'toNumber' in value) {
        return (value as { toNumber: () => number }).toNumber();
    }
    return undefined;
}

async function fetchBrokersByHost(host: string): Promise<BrokerRow[]> {
    const result = await run(
        `MATCH (b:MessageBroker) WHERE b.valid_to_commit IS NULL AND b.host = $host
         RETURN b.id AS id, b.provider AS provider, b.host AS host, b.port AS port,
                b.vhost AS vhost,
                coalesce(b.needsReview, false) AS needsReview,
                b.declaredVia AS declaredVia
         ORDER BY b.id`,
        { host },
    );
    return result.records.map(r => ({
        id: r.get('id') as string,
        provider: r.get('provider') as string,
        host: (r.get('host') as string | null) ?? undefined,
        port: toOptionalNumber(r.get('port')),
        vhost: (r.get('vhost') as string | null) ?? undefined,
        needsReview: Boolean(r.get('needsReview')),
        declaredVia: (r.get('declaredVia') as string | null) ?? undefined,
    }));
}

/**
 * a1 ambiguity rules — never a blind host-only pick:
 *  - candidate provider known → only same-provider brokers qualify;
 *  - ≥2 distinct providers on the host with no candidate provider → ambiguous;
 *  - candidate vhost KNOWN (incl. '/') → exact vhost match required;
 *  - candidate vhost null → may adopt only when exactly ONE broker remains.
 */
function pickAnchorBroker(cand: CandidateRow, brokers: BrokerRow[]): BrokerRow | null {
    let pool = brokers;
    if (cand.provider) {
        pool = pool.filter(b => b.provider === cand.provider);
    } else if (new Set(pool.map(b => b.provider)).size > 1) {
        return null;
    }
    if (cand.vhost !== undefined) {
        pool = pool.filter(b => (b.vhost ?? null) === cand.vhost);
    }
    // Port mirrors the vhost strictness: two KNOWN different ports may be two
    // different brokers on one host; an unknown side stays compatible.
    if (cand.port !== undefined) {
        pool = pool.filter(b => b.port === undefined || b.port === cand.port);
    }
    return pool.length === 1 ? pool[0] : null;
}

async function consumeCandidate(candId: string): Promise<void> {
    await run('MATCH (c:BrokerCandidate {id: $id}) DETACH DELETE c', { id: candId });
}

async function bindToBroker(
    cand: CandidateRow,
    broker: BrokerRow,
    commitHash: string,
    via: string,
    opts: { skipCorroboration?: boolean; runMarker?: string } = {},
): Promise<void> {
    // The candidate's sourceType drives the edge `source` on EVERY bind path
    // (a1 anchor included): a config-declared candidate anchoring onto an
    // existing broker must NOT write an env-var edge — the env-var reaper
    // would tombstone it on the next run.
    await linkServiceConnectsToBroker(
        cand.serviceUrn, broker.id, cand.sourceEnvKeys[0] ?? null, commitHash,
        { via, sourceType: cand.sourceType, runMarker: opts.runMarker },
    );
    // A candidate can never corroborate the broker minted FROM ITSELF —
    // cleaning requires an INDEPENDENT contract-grade observer (a1 path).
    if (!opts.skipCorroboration) await maybeCleanGuessBroker(cand, broker);
    await consumeCandidate(cand.id);
}

/**
 * Contract-grade corroboration arriving late: a candidate whose provider is
 * 'scheme'/'declared' agreeing (provider + host) with a guess-born broker
 * clears its needsReview — the same per-field rule as a3, applied at anchor
 * time. A key-name or shapeless candidate never cleans anything.
 */
async function maybeCleanGuessBroker(cand: CandidateRow, broker: BrokerRow): Promise<void> {
    if (!broker.needsReview) return;
    if (!cand.providerSource || !CONTRACT_PROVIDER_SOURCES.has(cand.providerSource)) return;
    if (cand.provider !== broker.provider) return;
    await run(
        `MATCH (b:MessageBroker {id: $id})
         SET b.needsReview = false, b.source = 'composite',
             b.evidence_extractors = reduce(_acc = coalesce(b.evidence_extractors, []),
                 _x IN ['broker-candidate-corroboration@v1'] | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
        { id: broker.id },
    );
}

function brokerUrnFor(cand: { provider: MessageBrokerProvider; host: string; port?: number; vhost?: string; repoUrn: string }): string {
    const scope = classifyBrokerFingerprintScope(cand.host);
    const fingerprint = computeBrokerFingerprint({
        provider: cand.provider,
        host: cand.host,
        port: cand.port,
        vhost: cand.vhost,
        repoUrn: scope === 'repo' ? cand.repoUrn : undefined,
    });
    return makeBrokerUrn(cand.provider, fingerprint, cand.vhost);
}

interface MintBrokerInput {
    provider: MessageBrokerProvider;
    host: string;
    port?: number;
    vhost?: string;
    repoUrn: string;
    /** s4 config-declared lane: stamped on the broker for channel binding. */
    connectionName?: string;
    sourceFile?: string;
    declaredVia?: 'config' | 'inferred';
}

async function mintBroker(
    cand: MintBrokerInput,
    commitHash: string,
    grounding: GroundingFields,
): Promise<BrokerRow> {
    const scope = classifyBrokerFingerprintScope(cand.host);
    const urn = brokerUrnFor(cand);
    await mergeMessageBroker({
        urn,
        provider: cand.provider,
        fingerprint: urn.split(':')[3]!,
        declaredVia: cand.declaredVia ?? 'inferred',
        host: cand.host,
        port: cand.port,
        vhost: cand.vhost,
        fingerprintScope: scope,
        repoScope: scope === 'repo' ? cand.repoUrn : undefined,
        connectionName: cand.connectionName,
        sourceFile: cand.sourceFile,
        sourceRepoUrn: cand.connectionName ? cand.repoUrn : undefined,
        grounding,
    }, commitHash);
    return {
        id: urn, provider: cand.provider, host: cand.host, vhost: cand.vhost,
        needsReview: grounding.needsReview ?? false,
        declaredVia: cand.declaredVia ?? 'inferred',
    };
}

/** Convergence groups: distinct-repo agreement on the same normalized host. */
function convergenceGroups(candidates: CandidateRow[]): Map<string, CandidateRow[]> {
    const byHost = new Map<string, CandidateRow[]>();
    for (const cand of candidates) {
        const group = byHost.get(cand.host);
        if (group) group.push(cand); else byHost.set(cand.host, [cand]);
    }
    return byHost;
}

function vhostChoiceOf(group: CandidateRow[]): { ok: boolean; vhost?: string } {
    const known = [...new Set(group.filter(c => c.vhost !== undefined).map(c => c.vhost!))];
    if (known.length > 1) return { ok: false };
    return { ok: true, vhost: known[0] };
}

/**
 * Port compatibility mirrors the vhost rule: null adopts the unique known
 * port; two distinct KNOWN ports on the same host may be two different
 * brokers — no convergence, the candidates stay in their residual lanes.
 */
function portChoiceOf(group: CandidateRow[]): { ok: boolean; port?: number } {
    const known = [...new Set(group.filter(c => c.port !== undefined).map(c => c.port!))];
    if (known.length > 1) return { ok: false };
    return { ok: true, port: known[0] };
}

function providerChoiceOf(group: CandidateRow[]): { provider?: MessageBrokerProvider; clean: boolean } | null {
    const providers = [...new Set(group.filter(c => c.provider).map(c => c.provider!))];
    if (providers.length !== 1) return providers.length === 0 ? { provider: undefined, clean: false } : null;
    const clean = group.some(c =>
        c.provider === providers[0] && c.providerSource && CONTRACT_PROVIDER_SOURCES.has(c.providerSource));
    return { provider: providers[0], clean };
}

const GUESS_GROUNDING: GroundingFields = {
    source: 'heuristic',
    quality: 'low',
    evidence: { extractors: ['broker-key-name@guess'] },
    needsReview: true,
};

function convergenceGrounding(group: CandidateRow[], clean: boolean): GroundingFields {
    const extractors = ['broker-candidate-convergence@v1'];
    if (group.some(c => c.providerSource === 'scheme')) extractors.push('broker-candidate-scheme@v1');
    if (group.some(c => c.providerSource === 'declared')) extractors.push('broker-candidate-declared@v1');
    if (group.some(c => c.providerSource === 'key-name')) extractors.push('broker-key-name@guess');
    return {
        source: 'composite',
        quality: clean ? 'high' : 'low',
        evidence: { extractors },
        needsReview: !clean,
    };
}

export interface BindBrokerCandidatesOptions {
    /** Per-reconcile-run marker stamped on bound edges (see reaper). */
    runMarker?: string;
}

/**
 * Graph-only late-binding pass. MUST run unconditioned in the reconcile
 * workflow (outside any `repos.length > 0` guard): an `analyze infra` run with
 * zero repos still replays the ledger against freshly ingested brokers.
 */
export async function bindBrokerCandidates(
    commitHash: string,
    opts: BindBrokerCandidatesOptions = {},
): Promise<BindBrokerCandidatesResult> {
    const result: BindBrokerCandidatesResult = {
        boundExisting: 0, createdSelfAnchored: 0,
        convergedClean: 0, convergedGuess: 0,
        createdConfigDeclared: 0,
        createdGuess: 0, createdDeclaredReview: 0,
        shadowedByConfig: 0,
        unbound: 0, guessOnlyBindings: 0,
    };
    const runMarker = opts.runMarker;

    // Phase A — anchor sweep over pre-existing brokers.
    let remaining = await anchorSweep(await fetchLiveCandidates(), commitHash, result, runMarker);

    // Phase B — scheme candidates self-anchor (contract).
    remaining = await selfAnchorSchemes(remaining, commitHash, result, runMarker);

    // Phase C — cross-repo convergence (per-field cleanliness). s4
    // config-declared candidates are EXCLUDED: convergence mints carry no
    // connectionName/sourceFile (the channel-binding join keys) and their
    // grounding is already clean by construction — the dedicated mint pass
    // below is their route.
    const configCands = remaining.filter(c => c.candidateSource === 's4-config-declared');
    remaining = await convergeGroups(remaining.filter(c => c.candidateSource !== 's4-config-declared'), commitHash, result, runMarker);

    // Phase C2 — s4 config-declared mint: clean AST grounding, BEFORE the
    // residuals (a residual minting first would leave only a dirty anchor).
    remaining = [
        ...await mintConfigDeclaredBrokers(configCands, commitHash, result, runMarker),
        ...remaining,
    ];

    // Phase D0 — anchor re-sweep BEFORE the residuals: brokers minted in
    // B/C/C2 THIS run must absorb their same-identity candidates from other
    // services. Without this, a residual-lane twin would re-MERGE the same
    // broker URN with guess grounding — and groundingWriteClause OVERWRITES
    // scalars on match, silently downgrading the clean config broker.
    remaining = await anchorSweep(remaining, commitHash, result, runMarker);

    // Phase D — residuals: mint visible needsReview brokers for candidates
    // that carry a provider (s3 key-name guess, s2 declared-sink whose VALUES
    // lack corroboration). Recall preserved, weld-gated until corroborated.
    remaining = await mintResidualBrokers(remaining, commitHash, result, runMarker);

    // Phase E — re-sweep: brokers minted in B-D may anchor leftover candidates.
    remaining = await anchorSweep(remaining, commitHash, result, runMarker);

    result.unbound = remaining.length;
    return result;
}

async function anchorSweep(
    candidates: CandidateRow[],
    commitHash: string,
    result: BindBrokerCandidatesResult,
    runMarker?: string,
): Promise<CandidateRow[]> {
    const remaining: CandidateRow[] = [];
    for (const cand of candidates) {
        const broker = pickAnchorBroker(cand, await fetchBrokersByHost(cand.host));
        if (!broker) { remaining.push(cand); continue; }
        await bindToBroker(cand, broker, commitHash, 'broker-candidate:a1', { runMarker });
        result.boundExisting++;
        const cleaned = broker.needsReview
            && cand.providerSource !== undefined
            && CONTRACT_PROVIDER_SOURCES.has(cand.providerSource)
            && cand.provider === broker.provider;
        if (broker.needsReview && !cleaned) result.guessOnlyBindings++;
    }
    return remaining;
}

async function selfAnchorSchemes(
    candidates: CandidateRow[],
    commitHash: string,
    result: BindBrokerCandidatesResult,
    runMarker?: string,
): Promise<CandidateRow[]> {
    const remaining: CandidateRow[] = [];
    for (const cand of candidates) {
        if (cand.providerSource !== 'scheme' || !cand.provider) { remaining.push(cand); continue; }
        const broker = await mintBroker(
            { provider: cand.provider, host: cand.host, port: cand.port, vhost: cand.vhost, repoUrn: cand.repoUrn },
            commitHash,
            { source: 'ast', quality: 'high', evidence: { extractors: ['broker-candidate-scheme@v1'] } },
        );
        await bindToBroker(cand, broker, commitHash, 'broker-candidate:a2', { skipCorroboration: true, runMarker });
        result.createdSelfAnchored++;
    }
    return remaining;
}

/**
 * s4 config-declared mint: the connection is a published config-module shape
 * read by a deterministic AST walk — grounding is CLEAN (`ast`, no
 * needsReview), demoted one tier when the host/vhost resolution leaned on an
 * accessor default. `connectionName`/`sourceFile` land on the broker node:
 * they are the join keys of the channel-connection binding pass.
 */
async function mintConfigDeclaredBrokers(
    candidates: CandidateRow[],
    commitHash: string,
    result: BindBrokerCandidatesResult,
    runMarker?: string,
): Promise<CandidateRow[]> {
    const remaining: CandidateRow[] = [];
    for (const cand of candidates) {
        if (!cand.provider) { remaining.push(cand); continue; }
        const broker = await mintBroker(
            {
                provider: cand.provider, host: cand.host, port: cand.port, vhost: cand.vhost,
                repoUrn: cand.repoUrn,
                connectionName: cand.connectionName, sourceFile: cand.sourceFile,
                declaredVia: 'config',
            },
            commitHash,
            configDeclaredGrounding(cand),
        );
        await bindToBroker(cand, broker, commitHash, 'broker-candidate:s4-config-declared', { skipCorroboration: true, runMarker });
        result.createdConfigDeclared++;
    }
    return remaining;
}

function configDeclaredGrounding(cand: CandidateRow): GroundingFields {
    const base: GroundingFields = {
        source: 'ast',
        quality: 'high',
        evidence: { extractors: ['php-config-array@v1'] },
        needsReview: false,
    };
    // 'high' confidence = literal config values; anything lower means the
    // host/vhost resolution leaned on an accessor default → one-tier demote.
    return cand.confidence === 'high'
        ? base
        : applyFallback(base, 'accessor-default-resolution');
}

async function convergeGroups(
    candidates: CandidateRow[],
    commitHash: string,
    result: BindBrokerCandidatesResult,
    runMarker?: string,
): Promise<CandidateRow[]> {
    const remaining: CandidateRow[] = [];
    for (const group of convergenceGroups(candidates).values()) {
        const independent = new Set(group.map(c => c.repoUrn)).size >= 2;
        const vhost = vhostChoiceOf(group);
        const port = portChoiceOf(group);
        const choice = independent && vhost.ok && port.ok ? providerChoiceOf(group) : null;
        if (!choice || !choice.provider) { remaining.push(...group); continue; }

        const broker = await mintBroker(
            { provider: choice.provider, host: group[0].host, port: port.port, vhost: vhost.vhost, repoUrn: group[0].repoUrn },
            commitHash,
            convergenceGrounding(group, choice.clean),
        );
        for (const cand of group) {
            await bindToBroker(cand, broker, commitHash, 'broker-candidate:a3', { skipCorroboration: true, runMarker });
            if (!choice.clean) result.guessOnlyBindings++;
        }
        if (choice.clean) result.convergedClean++; else result.convergedGuess++;
    }
    return remaining;
}

/**
 * s2 residual grounding: the provider is DECLARED (contract) but the host
 * value came from a name-classified zod key — the value attribution is the
 * remaining guess, so the broker still needs corroboration before any
 * cross-service weld may lean on it.
 */
const DECLARED_RESIDUAL_GROUNDING: GroundingFields = {
    source: 'declared',
    quality: 'medium',
    evidence: { extractors: ['broker-candidate-declared@v1'] },
    needsReview: true,
};

async function mintResidualBrokers(
    candidates: CandidateRow[],
    commitHash: string,
    result: BindBrokerCandidatesResult,
    runMarker?: string,
): Promise<CandidateRow[]> {
    const remaining: CandidateRow[] = [];
    for (const cand of candidates) {
        const residual = cand.providerSource === 'key-name' || cand.providerSource === 'declared';
        if (!residual || !cand.provider) { remaining.push(cand); continue; }
        // Config-shadow: a vhost-LESS residual on a host already explained by
        // a same-provider config-declared broker would mint a noise twin (the
        // per-vhost brokers are the grounded identities). The candidate stays
        // in the ledger, visible. A vhost-BEARING residual is a genuinely
        // distinct identity and still mints.
        if (cand.vhost === undefined && await hasConfigDeclaredBrokerOnHost(cand)) {
            result.shadowedByConfig++;
            remaining.push(cand);
            continue;
        }
        const broker = await mintBroker(
            { provider: cand.provider, host: cand.host, port: cand.port, vhost: cand.vhost, repoUrn: cand.repoUrn },
            commitHash,
            cand.providerSource === 'declared' ? DECLARED_RESIDUAL_GROUNDING : GUESS_GROUNDING,
        );
        await bindToBroker(cand, broker, commitHash, `broker-candidate:${cand.candidateSource}-residual`, { skipCorroboration: true, runMarker });
        if (cand.providerSource === 'declared') result.createdDeclaredReview++;
        else result.createdGuess++;
        result.guessOnlyBindings++;
    }
    return remaining;
}

async function hasConfigDeclaredBrokerOnHost(cand: CandidateRow): Promise<boolean> {
    const brokers = await fetchBrokersByHost(cand.host);
    return brokers.some(b => b.declaredVia === 'config' && b.provider === cand.provider);
}

/**
 * Reap stale env-var CONNECTS_TO bindings (C3). Triple guard:
 *
 *  1. `source = 'env-var'` ONLY — convergence/config/declared edges carry
 *     their own lifecycle and are never touched.
 *  2. Scoped to Services of the repos analyzed in THIS run: pass 9 re-emits
 *     every candidate derivable from their current env and pass 9a re-binds
 *     them, stamping `rel.lastSeenRun = runMarker`. An edge NOT re-stamped
 *     is no longer derivable → stale → tombstoned (auto-repair on re-sync).
 *  3. Callers MUST skip graph-only runs (`repos.length === 0`): bound
 *     candidates are CONSUMED, so a replay run re-stamps nothing and an
 *     ungated reaper would tombstone every binding.
 *
 * `runMarker` is a per-reconcile-run UUID, NOT a commit hash — every
 * reconcile caller passes commitHash='SYSTEM', so commits cannot mark runs.
 */
export async function reapStaleEnvVarBrokerBindings(
    runMarker: string,
    analyzedQualifiedRepos: ReadonlyArray<string>,
    commitHash: string,
): Promise<number> {
    if (analyzedQualifiedRepos.length === 0) return 0;
    // Prefixes precomputed in TS: Memgraph binds STARTS WITH tighter than
    // string `+`, so an inline concatenation would type-error (bool + string).
    const prefixes = analyzedQualifiedRepos.map(repo => `cr:service:${repo}:`);
    const result = await run(
        `MATCH (s:Service)-[rel:CONNECTS_TO {source: 'env-var'}]->(b:MessageBroker)
         WHERE rel.valid_to_commit IS NULL
           AND any(prefix IN $prefixes WHERE s.id STARTS WITH prefix)
           AND (rel.lastSeenRun IS NULL OR rel.lastSeenRun <> $runMarker)
         SET rel.valid_to_commit = $commitHash,
             rel.tombstoned_by = 'env-var-binding-reaper'
         RETURN count(rel) AS reaped`,
        { prefixes, runMarker, commitHash },
    );
    const reaped = result.records[0]?.get('reaped');
    return typeof reaped === 'number' ? reaped : (reaped?.toNumber?.() ?? 0);
}

/**
 * GC: a candidate dies ONLY with its owning Service (tombstoned or detached).
 * Unbound candidates with a live owner stay — they are the visible ledger.
 */
export async function gcOrphanBrokerCandidates(): Promise<number> {
    const result = await run(
        `MATCH (c:BrokerCandidate)
         OPTIONAL MATCH (s:Service)-[:HAS_BROKER_CANDIDATE]->(c)
         WHERE s.valid_to_commit IS NULL
         WITH c, count(s) AS liveOwners
         WHERE liveOwners = 0
         DETACH DELETE c
         RETURN count(*) AS removed`,
    );
    const removed = result.records[0]?.get('removed');
    return typeof removed === 'number' ? removed : (removed?.toNumber?.() ?? 0);
}
