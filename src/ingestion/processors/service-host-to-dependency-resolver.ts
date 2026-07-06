/**
 * Service-Host → Cross-Repo DEPENDS_ON Resolver
 *
 * For each repo, scans the resolved env-var map for URL-shaped values whose
 * host can be matched to a known Service in another repo. Emits
 * (Service)-[:DEPENDS_ON {source:'env-var', package:<envKey>}]->(Service)
 * edges so the global resolver's L0-scoped GraphQL pass has cross-repo
 * candidates to weld against.
 *
 * Matching strategy (deterministic, no LLM):
 *   1. Exact match on host's leftmost label against Service.name (must be unique).
 *   2. Match on host's leftmost label against repository basename — write an
 *      edge to every service in that repo (caller chooses the right candidate
 *      via the L0-scoped query downstream).
 *   3. Otherwise skip; the matchmaker LLM remains the last-resort fallback.
 *
 * Self-loops and loopback hosts are dropped; ambiguous name matches are
 * deferred to the LLM rather than written speculatively.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import { linkServiceDependsOnService } from '../../graph/mutations/c4.js';
import { getAllServices } from '../../graph/mutations/search.js';
import { getQualifiedRepoName, buildUrn } from '../../graph/urn.js';
import {
    buildRepoEnvMap,
    resolveTemplates,
    synthesizeHttpEndpoints,
    synthesizeBrokerCandidateHints,
} from './connection-extractors/env-var-resolver.js';
import { extractAllBrokerConnectionHints, extractAllPhysicalHints } from './connection-extractors/registry.js';
import { serviceContainsCodeArtifact } from '../../graph/queries/services.js';
import { synthesizeDeclaredSinkBrokerCandidates } from './connection-extractors/declared-sink-broker-candidates.js';
import { getDeclaredBrokerClients, getEnvAccessors, loadRepoHints } from '../../config/repo-hints.js';
import { scanCodeReferencedEnvVars } from './connection-extractors/code-env-scanner.js';
import { scanCodeAccessorEnvVars } from './connection-extractors/env-accessor-scanner.js';
import {
    mergeAPIInterface,
    linkServiceConsumesAPI,
    pruneStaleEnvVarAPIs,
} from '../../graph/mutations/api-contracts.js';
import {
    mergeAPIDeployment,
} from '../../graph/mutations/api-deployment.js';
import { inferEnvironmentFromPath } from './api-deployment-resolver.js';
import { mergeBrokerCandidate } from '../../graph/mutations/broker-candidates.js';
import { astGrounding } from '../../graph/grounding.js';
import type { ResolvedRepo } from '../../graph/types.js';
import type { ProgressReporter } from '../core/progress.js';

const COMMIT_HASH = 'SYSTEM';

const UNLINKABLE_HOSTS = new Set([
    'localhost', '127.0.0.1', '0.0.0.0', '::1',
    'host.docker.internal',
]);

export function extractHostFromUrl(raw: string): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    const m = /^[a-z][a-z0-9+\-.]*:\/\/([^\/?#]+)/i.exec(trimmed);
    if (!m) return null;
    let host = m[1];
    const at = host.lastIndexOf('@');
    if (at >= 0) host = host.slice(at + 1);
    if (host.startsWith('[')) {
        const close = host.indexOf(']');
        if (close > 0) host = host.slice(1, close);
    } else {
        const colon = host.indexOf(':');
        if (colon >= 0) host = host.slice(0, colon);
    }
    return host.toLowerCase() || null;
}

export function leftmostLabel(host: string): string {
    const i = host.indexOf('.');
    return i < 0 ? host : host.slice(0, i);
}

interface ServiceRecord {
    id: string;
    name: string;
    qualifiedRepo: string;
    repoBase: string;
}

function parseServiceUrn(urn: string): { qualifiedRepo: string; name: string } | null {
    const PREFIX = 'cr:service:';
    if (!urn.startsWith(PREFIX)) return null;
    const rest = urn.slice(PREFIX.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon < 0) return null;
    return { qualifiedRepo: rest.slice(0, lastColon), name: rest.slice(lastColon + 1) };
}

function repoBasename(qualifiedRepo: string): string {
    const i = qualifiedRepo.lastIndexOf('/');
    return (i < 0 ? qualifiedRepo : qualifiedRepo.slice(i + 1)).toLowerCase();
}

function extractProtocolHint(url: string): string | undefined {
    const m = /^([a-z][a-z0-9+\-.]*):\/\//i.exec(url.trim());
    if (!m) return undefined;
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return 'https';
    return scheme;
}

export interface ServiceHostResolverResult {
    edgesWritten: number;
    matched: number;
    skippedNoMatch: number;
    skippedAmbiguous: number;
    skippedSelf: number;
    skippedNonUrl: number;
    /** Count of env-var APIInterface nodes created for unmatched hosts. */
    externalApisLinked: number;
    /**
     * Count of `:BrokerCandidate` ledger entries persisted from env vars.
     * Brokers/bindings are materialised later by `bindBrokerCandidates()`.
     */
    brokerCandidatesEmitted: number;
}

/**
 * Heuristically resolve a service's workspace directory inside the repo.
 * Tries common monorepo layouts (apps/, packages/, libs/, services/) and
 * falls back to the repo root for monoliths.
 */
function resolveServiceDir(repoPath: string, serviceName: string): string {
    for (const prefix of ['apps', 'packages', 'libs', 'services']) {
        const candidate = path.join(repoPath, prefix, serviceName);
        try { if (fs.statSync(candidate).isDirectory()) return candidate; }
        catch { /* not found, fall through */ }
    }
    // Monolith / unconventional layout — service IS the repo.
    return repoPath;
}

export async function resolveServiceDependenciesFromEnvVars(
    repos: ResolvedRepo[],
    task?: ProgressReporter,
): Promise<ServiceHostResolverResult> {
    const result: ServiceHostResolverResult = {
        edgesWritten: 0, matched: 0,
        skippedNoMatch: 0, skippedAmbiguous: 0,
        skippedSelf: 0, skippedNonUrl: 0,
        externalApisLinked: 0,
        brokerCandidatesEmitted: 0,
    };

    const allServices = await getAllServices();
    if (allServices.length === 0) {
        if (task) task.report('No services in graph — env-var dependency resolver idle');
        return result;
    }

    const records: ServiceRecord[] = [];
    for (const s of allServices) {
        const parsed = parseServiceUrn(s.id);
        if (!parsed) continue;
        records.push({
            id: s.id, name: s.name,
            qualifiedRepo: parsed.qualifiedRepo,
            repoBase: repoBasename(parsed.qualifiedRepo),
        });
    }

    const byServiceName = new Map<string, ServiceRecord[]>();
    const byRepoBase = new Map<string, ServiceRecord[]>();
    for (const r of records) {
        const lcName = r.name.toLowerCase();
        const arr1 = byServiceName.get(lcName);
        if (arr1) arr1.push(r); else byServiceName.set(lcName, [r]);
        const arr2 = byRepoBase.get(r.repoBase);
        if (arr2) arr2.push(r); else byRepoBase.set(r.repoBase, [r]);
    }

    // Attribution gate, cached per run: repo-global default sources (helm,
    // accessor defaults, config-declared broker connections) only reach
    // services that contain code artifacts — an infra-only compose service
    // (nginx/sftp/assets) must not inherit the app's broker env.
    const hasCodeCache = new Map<string, boolean>();
    const hasCode = async (serviceUrn: string): Promise<boolean> => {
        const cached = hasCodeCache.get(serviceUrn);
        if (cached !== undefined) return cached;
        const value = await serviceContainsCodeArtifact(serviceUrn);
        hasCodeCache.set(serviceUrn, value);
        return value;
    };

    for (const repo of repos) {
        const fromQualifiedRepo = getQualifiedRepoName(repo);
        const callerServices = records.filter(r => r.qualifiedRepo === fromQualifiedRepo);
        if (callerServices.length === 0) continue;

        // Keys consumed by the datastore extraction (plugins incl. hint-less
        // classifications, DSN patterns, trios, hint templates) — collected
        // ONCE per repo from the extractors' own matchers. Subtracted from
        // the broker s0 lane below; over-claiming across the repo's services
        // is deliberate (conservative).
        const repoClaimedEnvKeys = extractAllPhysicalHints(repo.path).claimedEnvKeys;

        // Declared env-accessor wrappers, hoisted per repo: keys read through
        // a wrapper are code-referenced (visibility gate), their literal
        // defaults are the weakest env source. Deliberately NOT claimed —
        // wrapper-read broker hosts must reach the candidate lanes.
        const repoAccessors = getEnvAccessors(loadRepoHints(repo.path));
        const accessorDefaults = scanCodeAccessorEnvVars(repo.path, repoAccessors).defaults;

        // Per-service attribution: each service has its own env-map scope so
        // a URL read by `apps/orders-api/.env` is NOT attributed to whichever
        // service happens to be first in the records list. See Fix #1 in the
        // approved plan: this replaces the legacy primary-per-repo logic.
        for (const callerSvc of callerServices) {
            const callerSvcUrn = buildUrn('service', fromQualifiedRepo, callerSvc.name);
            const svcHasCode = await hasCode(callerSvcUrn);
            const serviceDir = resolveServiceDir(repo.path, callerSvc.name);
            const codeReferenced = scanCodeReferencedEnvVars(serviceDir, repoAccessors);
            const envMap = buildRepoEnvMap(repo.path, {
                serviceRoot: serviceDir,
                // Filter only kicks in when we actually scanned code (size > 0);
                // when scan returns empty (e.g. binary repo), the resolver falls
                // back to repo-root behavior — same trade-off as registry.ts:267.
                codeReferencedFilter: codeReferenced.size > 0 ? codeReferenced : undefined,
                accessorDefaults,
                // Per-source attribution (C2): compose env is scoped to THIS
                // service's block (Service.name, fallback dir-basename; exact
                // lowercase, never fuzzy); helm values + accessor defaults
                // describe app processes → codeless services skip them.
                composeServiceNames: [callerSvc.name, path.basename(serviceDir)],
                includeRepoGlobalDefaults: svcHasCode,
            });

            // ─── Broker CONNECTIONS from config files (s4 lane, B4) ──────
            // Gated on code presence AND scoped to config files under the
            // service's own dir (monolith → repo root): a config broker is
            // never spread repo-wide across every code service. Runs before
            // the env-map emptiness guard — literal config connections need
            // no env vars at all.
            if (svcHasCode) {
                const relServiceDir = path.relative(repo.path, serviceDir).replace(/\\/g, '/');
                for (const hint of extractAllBrokerConnectionHints(repo.path, envMap)) {
                    const sourceFile = hint.sourceFile.replace(/\\/g, '/');
                    if (relServiceDir && !sourceFile.startsWith(relServiceDir + '/')) continue;
                    try {
                        await mergeBrokerCandidate({
                            source: 's4-config-declared',
                            provider: hint.provider,
                            providerSource: hint.providerSource,
                            host: hint.host,
                            port: hint.port,
                            vhost: hint.vhost,
                            connectionName: hint.connectionName,
                            sourceType: 'config',
                            sourceFile: hint.sourceFile,
                            confidence: hint.confidence,
                            serviceUrn: callerSvcUrn,
                            repoUrn: fromQualifiedRepo,
                        }, COMMIT_HASH);
                        result.brokerCandidatesEmitted++;
                    } catch (e) {
                        logger.warn(`[service-host-deps] failed to persist config broker candidate ${hint.host} for ${callerSvc.id}: ${(e as Error).message}`);
                    }
                }
            }

            if (envMap.vars.size === 0) continue;

            for (const [key, entry] of envMap.vars.entries()) {
                const resolved = resolveTemplates(entry.value, 'shell', envMap, { maxDepth: 5 });
                if (!resolved.resolved) continue;
                const host = extractHostFromUrl(resolved.value);
                if (!host) { result.skippedNonUrl++; continue; }
                if (UNLINKABLE_HOSTS.has(host)) { result.skippedNonUrl++; continue; }

                const label = leftmostLabel(host);
                const candidatesByName = (byServiceName.get(label) ?? []).filter(s => s.qualifiedRepo !== fromQualifiedRepo);
                const candidatesByRepo = (byRepoBase.get(label) ?? []).filter(s => s.qualifiedRepo !== fromQualifiedRepo);

                let targets: ServiceRecord[] = [];
                if (candidatesByName.length === 1) {
                    targets = candidatesByName;
                } else if (candidatesByName.length > 1) {
                    result.skippedAmbiguous++;
                    logger.debug(
                        `[service-host-deps] ambiguous service name "${label}" matches ${candidatesByName.length} services across repos — deferred to LLM`,
                    );
                    continue;
                } else if (candidatesByRepo.length > 0) {
                    targets = candidatesByRepo;
                }

                if (targets.length === 0) {
                    result.skippedNoMatch++;
                    continue;
                }

                for (const target of targets) {
                    if (target.qualifiedRepo === fromQualifiedRepo) { result.skippedSelf++; continue; }
                    try {
                        await linkServiceDependsOnService(
                            fromQualifiedRepo, callerSvc.name,
                            target.qualifiedRepo, target.name,
                            COMMIT_HASH,
                            { source: 'env-var', package: key, protocol: extractProtocolHint(resolved.value) },
                        );
                        result.edgesWritten++;
                        result.matched++;
                    } catch (e) {
                        logger.warn(`[service-host-deps] failed to write edge ${callerSvc.id} → ${target.id}: ${(e as Error).message}`);
                    }
                }
            }

            // ─── APIInterface (env-var) synthesis ───────────────────────
            // Walk the same env-map for HTTP base-URL shapes. For each hint
            // whose host doesn't match a known Service, materialise an
            // :APIInterface (env-var) and a CONSUMES_API edge from the caller. This
            // surfaces 3rd-party SaaS / partner endpoints that have no
            // first-party counterpart in the graph.
            // ─── MessageBroker CANDIDATE emission ───────────────────────
            // Env-derived broker hints (declared-sink typed configs, scheme
            // DSN, legacy key-name, bare host-shaped values) are persisted as
            // :BrokerCandidate ledger nodes. NO broker / CONNECTS_TO is
            // written here: materialisation happens in the graph-only
            // `bindBrokerCandidates()` reconcile pass (anchor / self-anchor /
            // cross-repo convergence), so a candidate emitted today still
            // binds when its anchor arrives in a later ingest.
            // Datastore-claimed keys are subtracted via the extractors' own
            // matchers (no parallel regex); s2-claimed keys likewise.
            const claimedEnvKeys = new Set(repoClaimedEnvKeys);
            const declaredSink = synthesizeDeclaredSinkBrokerCandidates(
                serviceDir, envMap, getDeclaredBrokerClients(loadRepoHints(repo.path)),
            );
            for (const key of declaredSink.claimedEnvKeys) claimedEnvKeys.add(key);
            const candidateHints = [
                ...declaredSink.hints,
                ...synthesizeBrokerCandidateHints(envMap, { claimedEnvKeys }),
            ];
            for (const hint of candidateHints) {
                try {
                    await mergeBrokerCandidate({
                        ...hint,
                        sourceType: 'env-var',
                        serviceUrn: callerSvcUrn,
                        repoUrn: fromQualifiedRepo,
                    }, COMMIT_HASH);
                    result.brokerCandidatesEmitted++;
                } catch (e) {
                    logger.warn(`[service-host-deps] failed to persist broker candidate ${hint.host} for ${callerSvc.id}: ${(e as Error).message}`);
                }
            }

            const httpHints = synthesizeHttpEndpoints(envMap);
            for (const hint of httpHints) {
                if (UNLINKABLE_HOSTS.has(hint.host)) continue;
                const label = leftmostLabel(hint.host);
                const internalMatch = (byServiceName.get(label) ?? []).find(s => s.qualifiedRepo !== fromQualifiedRepo)
                    ?? (byRepoBase.get(label) ?? []).find(s => s.qualifiedRepo !== fromQualifiedRepo);
                if (internalMatch) continue; // already covered by the DEPENDS_ON pass above
                try {
                    const apiUrn = buildUrn('api', 'env-var', hint.host);
                    const grounding = astGrounding('env-var-http-synth@v1');
                    await mergeAPIInterface(apiUrn, hint.alias, 'inferred', COMMIT_HASH, 'env-var', 'OUTBOUND', grounding);
                    // Label the deployment's environment from the env-file it was read
                    // from (.env.production → production, ...). The logical APIInterface
                    // stays one node; the environment lives on the physical deployment.
                    await mergeAPIDeployment({ apiUrn, baseUrl: hint.baseUrl, environment: inferEnvironmentFromPath(hint.sourceFile), declaredBy: 'inferred', confidence: 'medium', grounding }, COMMIT_HASH);
                    await linkServiceConsumesAPI(callerSvcUrn, apiUrn, hint.sourceEnvKey, COMMIT_HASH);
                    result.externalApisLinked++;
                } catch (e) {
                    logger.warn(`[service-host-deps] failed to link env-var API ${hint.host} for ${callerSvc.id}: ${(e as Error).message}`);
                }
            }
        }
    }

    if (task) {
        task.report(
            `Wrote ${result.edgesWritten} cross-repo DEPENDS_ON edges from env-var URLs ` +
            `(${result.matched} matched, ${result.skippedAmbiguous} ambiguous, ${result.skippedNoMatch} no-match, ` +
            `${result.externalApisLinked} :APIInterface(env-var) created, ` +
            `${result.brokerCandidatesEmitted} :BrokerCandidate emitted)`,
        );
    }

    const pruned = await pruneStaleEnvVarAPIs(COMMIT_HASH);
    if (pruned > 0) logger.info(`[service-host-deps] pruned ${pruned} stale env-var APIInterface nodes`);

    return result;
}
