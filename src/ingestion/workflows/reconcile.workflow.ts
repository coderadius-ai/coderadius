/**
 * Reconcile workflow — graph idempotent stabilisation.
 *
 * Invoked as the terminal step of ingest entry points (`cr analyze code`,
 * `cr analyze infra`, and the structure-only scan). All steps are deterministic,
 * idempotent, and LLM-free. Two consecutive runs on the same graph must be a
 * no-op on the second pass.
 *
 * Ordering rationale — each step assumes the previous ones have completed:
 *   1. class-name bridge       — redirect MessageChannel placeholders whose
 *                                 `name` is a CQRS class to the canonical
 *                                 routing key (PHP routing-config files).
 *   2. channel-aliases welder  — materialise customer-declared logical→physical
 *                                 mirrors from `coderadius.yaml.mirrors[]`.
 *   3. reclassifyConsumedAPIs  — APIs without implementing code become consumed.
 *   4. weldOpenApiAcrossSpecs  — endpoint dedup across vendored spec copies.
 *   5. weldDataContainers      — cross-service schema dedup.
 *   6. pruneIncompatibleStoredIn — drop STORED_IN that conflict with the now-
 *                                 known datastore technology (assignDatastores
 *                                 from the code workflow writes them upstream).
 *   7. bindUnresolvedDependencies + gc — DEPENDS_ON late-bind to real Services.
 *   8. linkDataContainerSchemas — DataContainer ↔ DataStructure HAS_SCHEMA.
 *   9. env-var DEPENDS_ON      — cross-repo dependencies from env-var URLs +
 *                                 :BrokerCandidate ledger emission (repo-bound).
 *   9a. bindBrokerCandidates   — graph-only late binding of the candidate
 *                                 ledger (anchor / scheme / convergence).
 *                                 Runs UNCONDITIONALLY (also for graph-only
 *                                 callers with zero repos) so candidates from
 *                                 earlier ingests bind when their anchor
 *                                 arrives in this one.
 *  10. broker consolidation    — collapse old/stale duplicate broker URNs.
 *  11. autopromote logical → physical (depends on env-var brokers being known).
 *  12. broker convergence      — move code channels onto infra broker URNs.
 *  13. routing-pattern resolver — move routing-key channels onto queues.
 *  14. suffix dedup            — consumer-side truncated channels welded into
 *                                 publisher-side fully-qualified ones.
 *  15. cross-kind dedup        — same name + different kind (topic↔queue) merge.
 *  16. technology welder       — broker.provider → channel.technology (must run
 *                                 last so it sees the consolidated channel set).
 *
 * The module deliberately does NOT call LLM-bearing steps (matchmaking,
 * datastore assignment, global emergent resolution). Those stay in the code
 * workflow because the infra and reconcile entry points are zero-LLM.
 */

import { randomUUID } from 'node:crypto';
import { discoverMessageClassRegistry, weldMessagePublishersByClass } from '../../graph/mutations/message-channels.js';
import { weldChannelAliases } from '../processors/channel-alias-welder.js';
import { bindBrokerCandidates, gcOrphanBrokerCandidates, reapStaleEnvVarBrokerBindings } from '../../graph/mutations/broker-candidates.js';
import { runChannelConnectionBinding } from '../processors/channel-connection-binding.js';
import { getQualifiedRepoName } from '../../graph/urn.js';
import { tombstoneShapeInvalidDataContainers } from '../processors/container-name-hygiene.js';
import { resolveServiceDependenciesFromEnvVars } from '../processors/service-host-to-dependency-resolver.js';
import { promoteStandaloneDatastores } from '../processors/standalone-datastore-promotion.js';
import { runChannelAutopromote } from '../processors/channel-autopromoter.js';
import { runChannelTechnologyWeld } from '../processors/channel-technology-welder.js';
import { runChannelBrokerConvergence } from '../processors/channel-broker-convergence.js';
import { runChannelRoutingPatternResolver } from '../processors/channel-routing-pattern-resolver.js';
import {
    deduplicateMessageChannelsBySuffix,
    deduplicateMessageChannelsByExactNameDifferentKind,
} from '../processors/dynamic-infra-resolver.js';
import { consolidateDuplicateBrokers } from '../processors/broker-consolidation.js';
import { telemetryCollector } from '../../telemetry/collector.js';
import { reclassifyConsumedAPIs, weldOpenApiAcrossSpecs } from '../../graph/mutations/api-contracts.js';
import { bindUnresolvedDependencies, gcOrphanUnresolvedDependencies } from '../../graph/mutations/c4.js';
import { linkDataContainerSchemas, pruneDatastoreNameEchoContainers, pruneIncompatibleStoredInEdges, weldDataContainersByEndpoint } from '../../graph/mutations/data-contracts.js';
import { collapseNestedOrganizations, linkRootOrganizationsToTenant, mergeTenant } from '../../graph/mutations/organization.js';
import { configManager } from '../../config/index.js';
import { type ProgressReporter, silentReporter } from '../core/progress.js';
import type { ResolvedRepo } from '../../graph/types.js';

export interface ReconcileOptions {
    /** Repos in scope for repo-dependent steps (class-name bridge + env-var deps). Pass undefined for graph-only reconcile callers. */
    repos?: ReadonlyArray<ResolvedRepo>;
    /** Commit hash stamped on grounding evidence. Defaults to 'SYSTEM' (matches the historical inline behaviour). */
    commitHash?: string;
}

export interface ReconcileResult {
    classBridge: { weldedEdges: number; tombstonedPlaceholders: number };
    channelAliases: { logicalChannels: number; manifestsAsEdges: number; danglingMirrors: number; tombstonedAliases: number };
    reclassifiedConsumedApis: number;
    openApiWelder: { weldedEdges: number; tombstonedEndpoints: number; ambiguousRoutes: number };
    dataContainerWelder: { weldedPairs: number; rewiredEdges: number; tombstoned: number; skippedAmbiguous: number };
    prunedStoredIn: { pruned: number; cleared: number };
    bindDependencies: { boundEdges: number; boundUnresolvedNodes: number; ambiguous: number; gcRemoved: number };
    dataContainerSchemas: { linked: number };
    envVarDependencies: { edgesWritten: number; brokerCandidatesEmitted: number };
    standaloneDatastores: { promoted: number };
    brokerCandidateBinding: {
        boundExisting: number; createdSelfAnchored: number;
        convergedClean: number; convergedGuess: number;
        createdConfigDeclared: number;
        createdGuess: number; createdDeclaredReview: number;
        shadowedByConfig: number;
        unbound: number; guessOnlyBindings: number;
        gcRemoved: number;
    };
    envVarBindingReaper: { reaped: number };
    channelConnectionBinding: { bound: number; ambiguous: number };
    autopromote: { promoted: number; ambiguous: number; noBroker: number };
    brokerConvergence: { rewired: number; serviceLinks: number };
    brokerConsolidation: { merged: number };
    routingPatternResolver: { rewired: number; ambiguousMarked: number };
    suffixDedup: { welded: number };
    crossKindDedup: { merged: number };
    technologyWeld: { welded: number };
}

/**
 * Run the entire reconcile pipeline. Safe to call repeatedly: each step is
 * idempotent. Empty when there's nothing to reconcile (fresh DB, no repos).
 */
export async function runReconcile(opts: ReconcileOptions = {}, reporter: ProgressReporter = silentReporter): Promise<ReconcileResult> {
    const r = reporter;
    const commitHash = opts.commitHash ?? 'SYSTEM';
    const repos = opts.repos ?? [];
    // Per-run marker for edge staleness: every reconcile caller passes
    // commitHash='SYSTEM', so commits cannot distinguish runs. The marker is
    // stamped on env-var CONNECTS_TO bindings (rel.lastSeenRun) and compared
    // by the reaper below.
    const runMarker = randomUUID();

    const result: ReconcileResult = {
        classBridge: { weldedEdges: 0, tombstonedPlaceholders: 0 },
        channelAliases: { logicalChannels: 0, manifestsAsEdges: 0, danglingMirrors: 0, tombstonedAliases: 0 },
        reclassifiedConsumedApis: 0,
        openApiWelder: { weldedEdges: 0, tombstonedEndpoints: 0, ambiguousRoutes: 0 },
        dataContainerWelder: { weldedPairs: 0, rewiredEdges: 0, tombstoned: 0, skippedAmbiguous: 0 },
        prunedStoredIn: { pruned: 0, cleared: 0 },
        bindDependencies: { boundEdges: 0, boundUnresolvedNodes: 0, ambiguous: 0, gcRemoved: 0 },
        dataContainerSchemas: { linked: 0 },
        envVarDependencies: { edgesWritten: 0, brokerCandidatesEmitted: 0 },
        standaloneDatastores: { promoted: 0 },
        brokerCandidateBinding: {
            boundExisting: 0, createdSelfAnchored: 0,
            convergedClean: 0, convergedGuess: 0,
            createdConfigDeclared: 0,
            createdGuess: 0, createdDeclaredReview: 0,
            shadowedByConfig: 0,
            unbound: 0, guessOnlyBindings: 0,
            gcRemoved: 0,
        },
        envVarBindingReaper: { reaped: 0 },
        channelConnectionBinding: { bound: 0, ambiguous: 0 },
        autopromote: { promoted: 0, ambiguous: 0, noBroker: 0 },
        brokerConvergence: { rewired: 0, serviceLinks: 0 },
        brokerConsolidation: { merged: 0 },
        routingPatternResolver: { rewired: 0, ambiguousMarked: 0 },
        suffixDedup: { welded: 0 },
        crossKindDedup: { merged: 0 },
        technologyWeld: { welded: 0 },
    };

    // 0. Tenant hierarchy — collapse any legacy nested Organization nodes
    //    (single-level model), then create the configured Tenant node and link
    //    every Organization to it. Organizations already exist (built during
    //    repo merge); this is a deterministic, idempotent config application.
    await collapseNestedOrganizations(commitHash);
    const tenantConfig = configManager.getRawConfig().tenant;
    if (tenantConfig) {
        await mergeTenant(tenantConfig.slug, tenantConfig.name, tenantConfig.description, commitHash);
        await linkRootOrganizationsToTenant(tenantConfig.slug, commitHash);
    }

    // 1. Class-name bridge — requires repo paths to mine PHP routing configs.
    //    Graph-only callers with no repos skip this; the bridge is a
    //    code-extraction step, not a graph-only pass.
    if (repos.length > 0) {
        const registry = discoverMessageClassRegistry(repos.map(repo => repo.path));
        if (registry.size > 0) {
            const bridgeResult = await weldMessagePublishersByClass(registry, commitHash);
            result.classBridge = {
                weldedEdges: bridgeResult.weldedEdges,
                tombstonedPlaceholders: bridgeResult.tombstonedPlaceholders,
            };
            if (bridgeResult.weldedEdges > 0 || bridgeResult.tombstonedPlaceholders > 0) {
                r.report(`Class-name bridge: welded ${bridgeResult.weldedEdges} edge(s); tombstoned ${bridgeResult.tombstonedPlaceholders} placeholder(s)`);
            }
        }
    }

    // 2. Channel-aliases welder.
    const aliasResult = await weldChannelAliases(commitHash);
    result.channelAliases = aliasResult;
    if (aliasResult.manifestsAsEdges > 0 || aliasResult.danglingMirrors > 0) {
        r.report(
            `Channel alias welder: ${aliasResult.logicalChannels} logical channel(s), ` +
            `${aliasResult.manifestsAsEdges} MANIFESTS_AS edge(s)` +
            (aliasResult.danglingMirrors > 0 ? `, ${aliasResult.danglingMirrors} dangling mirror(s) skipped` : ''),
        );
    }

    // 3. reclassifyConsumedAPIs — APIs without implementing code become consumed.
    const reclassified = await reclassifyConsumedAPIs(commitHash);
    result.reclassifiedConsumedApis = reclassified.length;
    if (reclassified.length > 0) {
        r.report(`Reclassified ${reclassified.length} API spec(s) as consumed (no implementing code found)`);
    }

    // 4. weldOpenApiAcrossSpecs — dedup vendored spec copies.
    const openApiResult = await weldOpenApiAcrossSpecs(commitHash);
    result.openApiWelder = {
        weldedEdges: openApiResult.weldedEdges,
        tombstonedEndpoints: openApiResult.tombstonedEndpoints,
        ambiguousRoutes: openApiResult.ambiguousRoutes.length,
    };
    if (openApiResult.weldedEdges > 0 || openApiResult.tombstonedEndpoints > 0) {
        r.report(`Welded ${openApiResult.weldedEdges} CALLS edge(s); tombstoned ${openApiResult.tombstonedEndpoints} duplicate endpoint(s)`);
    }
    if (openApiResult.ambiguousRoutes.length > 0) {
        r.warn(`${openApiResult.ambiguousRoutes.length} ambiguous route(s) skipped (multiple authoritative providers): ${openApiResult.ambiguousRoutes.slice(0, 3).map(a => `${a.method} ${a.path}`).join(', ')}${openApiResult.ambiguousRoutes.length > 3 ? ', …' : ''}`);
    }

    // 5. weldDataContainersByEndpoint — cross-service schema match.
    const dcResult = await weldDataContainersByEndpoint(commitHash);
    result.dataContainerWelder = {
        weldedPairs: dcResult.weldedPairs,
        rewiredEdges: dcResult.rewiredEdges,
        tombstoned: dcResult.tombstoned,
        skippedAmbiguous: dcResult.skippedAmbiguous.length,
    };
    if (dcResult.weldedPairs > 0) {
        r.report(`Welded ${dcResult.weldedPairs} DataContainer pair(s); rewired ${dcResult.rewiredEdges} edge(s); tombstoned ${dcResult.tombstoned}`);
    }
    if (dcResult.skippedAmbiguous.length > 0) {
        r.warn(`Skipped ${dcResult.skippedAmbiguous.length} ambiguous DataContainer group(s)`);
    }

    // 6. Prune incompatible STORED_IN — depends on `assignDatastoresForScope`
    //    from the code workflow having written the STORED_IN edges upstream.
    //    For infra-only runs this step is a no-op when no STORED_IN exist.
    const pruneResult = await pruneIncompatibleStoredInEdges(commitHash);
    result.prunedStoredIn = pruneResult;
    if (pruneResult.pruned > 0 || pruneResult.cleared > 0) {
        r.report(`Pruned ${pruneResult.pruned} incompatible STORED_IN edge(s); cleared ${pruneResult.cleared} stale technology field(s)`);
    }

    // 6b. Drop datastore-name echo DataContainers — the LLM extracts a database
    //     SELECTION (selectDatabase('x') in DI/config) as a collection, yielding
    //     a (:DataContainer{name:'x'})-[:STORED_IN]->(:Datastore{name:'x'}) self
    //     -echo. Structural, runs here where both sides exist.
    const echoRemoved = await pruneDatastoreNameEchoContainers();
    if (echoRemoved > 0) {
        r.report(`Removed ${echoRemoved} datastore-name-echo DataContainer(s)`);
    }

    // 7. Bind cross-repo Service dependencies (catalog `dependsOn`).
    const bindResult = await bindUnresolvedDependencies(commitHash);
    result.bindDependencies.boundEdges = bindResult.boundEdges;
    result.bindDependencies.boundUnresolvedNodes = bindResult.boundUnresolvedNodes;
    result.bindDependencies.ambiguous = bindResult.ambiguous.length;
    if (bindResult.boundEdges > 0 || bindResult.boundUnresolvedNodes > 0) {
        r.report(
            `Bound ${bindResult.boundEdges} dependency edge(s); removed ${bindResult.boundUnresolvedNodes} placeholder node(s) (bound or unbindable)`,
        );
    }
    if (bindResult.ambiguous.length > 0) {
        const sample = bindResult.ambiguous.slice(0, 3).map(a => `${a.name} (${a.candidates} candidates)`).join(', ');
        r.warn(
            `${bindResult.ambiguous.length} ambiguous dependency name(s) not bound: ${sample}${bindResult.ambiguous.length > 3 ? ', …' : ''}`,
        );
    }
    const gcRemoved = await gcOrphanUnresolvedDependencies();
    result.bindDependencies.gcRemoved = gcRemoved;
    if (gcRemoved > 0) {
        r.report(`Garbage-collected ${gcRemoved} orphan dependency placeholder(s)`);
    }

    // 8. linkDataContainerSchemas — DataContainer ↔ DataStructure HAS_SCHEMA.
    const dcSchemaResult = await linkDataContainerSchemas(commitHash);
    result.dataContainerSchemas = dcSchemaResult;
    if (dcSchemaResult.linked > 0) {
        r.report(`Linked ${dcSchemaResult.linked} DataContainer↔DataStructure HAS_SCHEMA edge(s)`);
    }

    // 9. Env-var DEPENDS_ON / :BrokerCandidate emission — requires repos for
    //    .env scanning. Graph-only callers with no repos skip this.
    if (repos.length > 0) {
        const envVarResult = await resolveServiceDependenciesFromEnvVars([...repos], r);
        result.envVarDependencies = {
            edgesWritten: envVarResult.edgesWritten,
            brokerCandidatesEmitted: envVarResult.brokerCandidatesEmitted,
        };
        if (envVarResult.brokerCandidatesEmitted > 0) {
            r.report(`Persisted ${envVarResult.brokerCandidatesEmitted} :BrokerCandidate ledger entries`);
        }

        // 9b. Standalone datastore promotion — recall for datastores whose only
        //     I/O function was dropped by the taint gate (high-confidence gate:
        //     declared client library OR unambiguous DSN scheme). Additive and
        //     idempotent vs the per-function binding loop.
        const promoResult = await promoteStandaloneDatastores([...repos], r);
        result.standaloneDatastores = { promoted: promoResult.promoted };
    }

    // 9pre. Container name hygiene — graph-only sweep applying the same
    //       identifier-shape contract the sanitizer enforces at emission time.
    //       Cleans shape-invalid names persisted by Merkle-cached producers
    //       that predate a guard. Idempotent.
    const hygieneCount = await tombstoneShapeInvalidDataContainers(commitHash);
    if (hygieneCount > 0) {
        r.report(`Container name hygiene: tombstoned ${hygieneCount} shape-invalid container(s)`);
    }

    // 9a. Broker candidate late binding — graph-only, deliberately OUTSIDE the
    //     repos guard: an `analyze infra` run with zero repos must still
    //     replay the ledger against the brokers it just ingested.
    const candidateBinding = await bindBrokerCandidates(commitHash, { runMarker });
    const candidateGc = await gcOrphanBrokerCandidates();
    result.brokerCandidateBinding = { ...candidateBinding, gcRemoved: candidateGc };
    telemetryCollector.addBrokerCandidatesUnbound(candidateBinding.unbound);
    telemetryCollector.addBrokerGuessOnlyBindings(candidateBinding.guessOnlyBindings);
    {
        const created = candidateBinding.createdSelfAnchored
            + candidateBinding.convergedClean + candidateBinding.convergedGuess
            + candidateBinding.createdConfigDeclared
            + candidateBinding.createdGuess + candidateBinding.createdDeclaredReview;
        if (candidateBinding.boundExisting > 0 || created > 0) {
            r.report(
                `Bound ${candidateBinding.boundExisting} broker candidate(s) to existing brokers, `
                + `minted ${created} broker(s) (${candidateBinding.guessOnlyBindings} guess-only binding(s), `
                + `${candidateBinding.unbound} left unbound)`,
            );
        }
    }

    // 9a-ter. Env-var binding reaper — ONLY when repos were analyzed in THIS
    //     run: pass 9 re-emitted every candidate derivable from their current
    //     env and pass 9a re-bound them (stamping rel.lastSeenRun). An edge
    //     of an analyzed repo's service NOT re-stamped is no longer derivable
    //     → stale → tombstoned. Graph-only runs MUST skip (candidates are
    //     consumed at bind time; nothing is re-stamped on replay).
    if (repos.length > 0) {
        const reaped = await reapStaleEnvVarBrokerBindings(
            runMarker, repos.map(repo => getQualifiedRepoName(repo)), commitHash,
        );
        result.envVarBindingReaper = { reaped };
        if (reaped > 0) {
            r.report(`Reaped ${reaped} stale env-var broker binding(s)`);
        }
    }

    // 9b. Broker consolidation — one-shot cleanup for pre-stability duplicate
    //     broker URNs that describe the same safe identity tuple.
    const brokerConsolidation = await consolidateDuplicateBrokers(commitHash);
    result.brokerConsolidation = brokerConsolidation;
    if (brokerConsolidation.merged > 0) {
        r.report(`Consolidated ${brokerConsolidation.merged} duplicate broker node(s)`);
    }

    // 9c. Channel ↔ connection binding (same-file join) — after consolidation
    //     so the stamped brokerUrn survives the merge sweep, BEFORE the
    //     autopromoter whose Tier 1 reads the physical channel's brokerUrn.
    const channelBinding = await runChannelConnectionBinding(commitHash);
    result.channelConnectionBinding = channelBinding;
    if (channelBinding.bound > 0 || channelBinding.ambiguous > 0) {
        r.report(
            `Channel-connection binding: bound ${channelBinding.bound} channel(s) to their connection's broker`
            + (channelBinding.ambiguous > 0 ? `, ${channelBinding.ambiguous} ambiguous skipped` : ''),
        );
    }

    // 10. Autopromote logical → physical channels. Must precede the dedups
    //     so the cross-kind/suffix passes see the consolidated physical set.
    const promoteResult = await runChannelAutopromote(commitHash);
    result.autopromote = promoteResult;
    if (promoteResult.promoted > 0) {
        r.report(`Promoted ${promoteResult.promoted} logical channels to physical (${promoteResult.ambiguous} ambiguous, ${promoteResult.noBroker} without broker)`);
    }

    // 10b. Channel-to-infra-broker convergence: rewire code-side channels
    //      (host-only broker) onto their infra-derived counterpart's broker
    //      when the channel name uniquely identifies the target. Required
    //      BEFORE cross-kind dedup so the brokerUrn-parity guard passes.
    const convergenceResult = await runChannelBrokerConvergence(commitHash);
    result.brokerConvergence = convergenceResult;
    if (convergenceResult.rewired > 0) {
        r.report(`Rewired ${convergenceResult.rewired} channel(s) onto their infra-derived broker (name-unique match)`);
    }

    // 10c. Routing-key → infra-queue welder: when a code-side channel name has
    //      NO exact infra counterpart but matches an AMQP binding (regex for
    //      topic exchanges, literal for direct), MOVE all live edges onto the
    //      queue and DETACH the code channel. Complete welder (does not delegate
    //      to cross-kind dedup, which requires name parity that this case lacks).
    const routingResolverResult = await runChannelRoutingPatternResolver(commitHash);
    result.routingPatternResolver = routingResolverResult;
    if (routingResolverResult.rewired > 0) {
        r.report(`Rewired ${routingResolverResult.rewired} routing-key channel(s) onto their infra queue`);
    }
    if (routingResolverResult.ambiguousMarked > 0) {
        r.warn(`${routingResolverResult.ambiguousMarked} routing-key channel(s) match multiple bindings; marked needsReview (pin via coderadius.yaml)`);
    }

    // 11. Suffix dedup — consumer-side truncated channels into publisher-side
    //     fully-qualified ones. Moved here from `resolveDynamicInfrastructure`
    //     so it fires on EVERY reconcile pass, not only when dynamic stubs exist.
    const suffixWelded = await deduplicateMessageChannelsBySuffix();
    result.suffixDedup.welded = suffixWelded;
    if (suffixWelded > 0) {
        r.report(`Channel suffix dedup: welded ${suffixWelded} consumer-side channel(s)`);
    }

    // 12. Cross-kind dedup — topic ↔ queue with the same name and broker.
    //     Same move rationale as suffix dedup.
    const crossKindResult = await deduplicateMessageChannelsByExactNameDifferentKind();
    result.crossKindDedup = crossKindResult;
    if (crossKindResult.merged > 0) {
        r.report(`Channel cross-kind dedup: welded ${crossKindResult.merged} duplicate(s)`);
    }

    // 13. Technology welder — broker.provider → channel.technology. Last
    //     because it must see the consolidated channel set + the freshly
    //     promoted physical channels with their `brokerUrn` populated.
    const techWeldResult = await runChannelTechnologyWeld(commitHash);
    result.technologyWeld = techWeldResult;
    if (techWeldResult.welded > 0) {
        r.report(`Stamped technology on ${techWeldResult.welded} channels from broker.provider`);
    }

    // 14. needsReview cleanup — clear the flag on any channel whose structural
    //     corroboration is now in the graph. Two signals count as proof:
    //       (a) `discoverySource = 'config'`: stamped directly by an infra
    //           plugin (rabbitmq-config, symfony-messenger).
    //       (b) `cross-kind-weld@v1` extractor on a composite-source node:
    //           the channel was merged with an infra-derived sibling. The
    //           dedup itself is the corroboration; the merged sub was
    //           already deleted so we cannot read its discoverySource here.
    //     Idempotent: subsequent runs are a no-op once the flag is cleared.
    const { run: graphRun } = await import('../../graph/mutations/_run.js');
    const cleanupResult = await graphRun(
        `MATCH (ch:MessageChannel)
         WHERE ch.valid_to_commit IS NULL
           AND ch.needsReview = true
           AND (
                ch.discoverySource = 'config'
                OR (ch.source = 'composite'
                    AND ch.evidence_extractors IS NOT NULL
                    AND 'cross-kind-weld@v1' IN ch.evidence_extractors)
           )
         SET ch.needsReview = false
         RETURN count(ch) AS cleared`,
        {},
    );
    const cleared = Number(cleanupResult.records[0]?.get('cleared') ?? 0);
    if (cleared > 0) {
        r.report(`Cleared needsReview on ${cleared} channel(s) with structural corroboration`);
    }

    return result;
}
