import { run, runInTransaction } from '../../graph/mutations/_run.js';
import { computeBrokerFingerprint, makeBrokerUrn } from '../core/messaging/broker-registry.js';
import { normalizeHost } from './physical-fingerprint.js';

type BrokerRow = {
    id: string;
    provider: string;
    host: string;
    port?: number;
    vhost?: string;
    fingerprint?: string;
    fingerprintScope?: 'global' | 'repo';
    repoScope?: string;
    relCount: number;
    evidenceExtractors: string[];
};

type Tx = { run: (cypher: string, params?: Record<string, unknown>) => Promise<unknown> };

export interface BrokerConsolidationResult {
    merged: number;
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object' && 'toNumber' in value) {
        return (value as { toNumber: () => number }).toNumber();
    }
    return undefined;
}

function safeGroupKey(b: BrokerRow): string | null {
    if (!b.provider || !b.host) return null;
    const host = normalizeHost(b.host);
    if (!host) return null;
    const scope = b.fingerprintScope === 'repo' ? 'repo' : 'global';
    if (scope === 'repo' && !b.repoScope) return null;
    return JSON.stringify([
        b.provider,
        host,
        b.port ?? '',
        b.vhost ?? '',
        scope,
        scope === 'repo' ? b.repoScope : '',
    ]);
}

function canonicalBrokerUrn(b: BrokerRow): string {
    const fingerprint = computeBrokerFingerprint({
        provider: b.provider,
        host: b.host,
        port: b.port,
        vhost: b.vhost,
        repoUrn: b.fingerprintScope === 'repo' ? b.repoScope : undefined,
    });
    return makeBrokerUrn(b.provider, fingerprint, b.vhost);
}

function richnessScore(b: BrokerRow): number {
    return (b.relCount * 10)
        + (b.evidenceExtractors.length * 2)
        + (b.host ? 1 : 0)
        + (b.port ? 1 : 0)
        + (b.vhost ? 1 : 0)
        + (b.fingerprint ? 1 : 0);
}

function choosePrimary(group: BrokerRow[]): BrokerRow {
    const canonical = canonicalBrokerUrn(group[0]);
    const canonicalMatch = group.find(b => b.id === canonical);
    if (canonicalMatch) return canonicalMatch;
    return [...group].sort((a, b) => richnessScore(b) - richnessScore(a) || a.id.localeCompare(b.id))[0];
}

async function fetchLiveBrokers(): Promise<BrokerRow[]> {
    const result = await run(
        `MATCH (b:MessageBroker)
         WHERE b.valid_to_commit IS NULL
           AND b.provider IS NOT NULL
           AND b.host IS NOT NULL
           AND b.host <> ''
         OPTIONAL MATCH (b)-[rel]-()
         WITH b, count(CASE WHEN rel.valid_to_commit IS NULL THEN rel ELSE null END) AS relCount
         RETURN b.id AS id,
                b.provider AS provider,
                b.host AS host,
                b.port AS port,
                b.vhost AS vhost,
                b.fingerprint AS fingerprint,
                b.fingerprintScope AS fingerprintScope,
                b.repoScope AS repoScope,
                coalesce(b.evidence_extractors, []) AS evidenceExtractors,
                relCount AS relCount`,
    );
    return result.records.map(rec => ({
        id: rec.get('id') as string,
        provider: rec.get('provider') as string,
        host: rec.get('host') as string,
        port: toNumber(rec.get('port')),
        vhost: (rec.get('vhost') as string | null) ?? undefined,
        fingerprint: (rec.get('fingerprint') as string | null) ?? undefined,
        fingerprintScope: ((rec.get('fingerprintScope') as string | null) ?? 'global') as 'global' | 'repo',
        repoScope: (rec.get('repoScope') as string | null) ?? undefined,
        evidenceExtractors: (rec.get('evidenceExtractors') as string[]) ?? [],
        relCount: toNumber(rec.get('relCount')) ?? 0,
    }));
}

async function moveConnectsToEdges(tx: Tx, secondaryId: string, primaryId: string, commitHash: string): Promise<void> {
    const result = await tx.run(
        `MATCH (svc:Service)-[oldR:CONNECTS_TO]->(:MessageBroker {id: $secondaryId})
         WHERE oldR.valid_to_commit IS NULL
         RETURN svc.id AS serviceId, properties(oldR) AS props, id(oldR) AS oldEdgeId`,
        { secondaryId },
    ) as { records: Array<{ get(k: string): unknown }> };

    for (const rec of result.records) {
        const serviceId = rec.get('serviceId') as string;
        const props = { ...(rec.get('props') as Record<string, unknown>) };
        const source = typeof props.source === 'string' && props.source.length > 0 ? props.source : 'env-var';
        props.source = source;
        await tx.run(
            `MATCH (svc:Service {id: $serviceId}), (broker:MessageBroker {id: $primaryId})
             MERGE (svc)-[newR:CONNECTS_TO {source: $source}]->(broker)
             ON CREATE SET newR = $props,
                           newR.valid_from_commit = $commitHash,
                           newR.valid_to_commit = null
             ON MATCH SET newR += $props,
                          newR.valid_to_commit = null`,
            { serviceId, primaryId, source, props, commitHash },
        );
        await tx.run(
            `MATCH ()-[oldR]->() WHERE id(oldR) = $oldEdgeId SET oldR.valid_to_commit = $commitHash`,
            { oldEdgeId: rec.get('oldEdgeId'), commitHash },
        );
    }
}

async function mergeSecondaryIntoPrimary(primaryId: string, secondaryId: string, commitHash: string): Promise<void> {
    await runInTransaction([
        tx => tx.run(
            `MATCH (primary:MessageBroker {id: $primaryId}), (secondary:MessageBroker {id: $secondaryId})
             SET primary.evidence_extractors = reduce(_acc = [], _x IN coalesce(primary.evidence_extractors, []) + coalesce(secondary.evidence_extractors, []) |
                    CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END),
                 primary.evidence_fallbacksApplied = reduce(_acc = [], _x IN coalesce(primary.evidence_fallbacksApplied, []) + coalesce(secondary.evidence_fallbacksApplied, []) |
                    CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END),
                 primary.evidence_mergedFrom = reduce(_acc = [], _x IN coalesce(primary.evidence_mergedFrom, []) + coalesce(secondary.evidence_mergedFrom, []) + [$secondaryId] |
                    CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END),
                 primary.alternateHostsSeen = reduce(_acc = [], _x IN coalesce(primary.alternateHostsSeen, []) + coalesce(secondary.alternateHostsSeen, []) |
                    CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END),
                 primary.displayHost = coalesce(primary.displayHost, secondary.displayHost),
                 primary.displayVhost = coalesce(primary.displayVhost, secondary.displayVhost),
                 primary.cluster = coalesce(primary.cluster, secondary.cluster),
                 primary.region = coalesce(primary.region, secondary.region),
                 primary.env = coalesce(primary.env, secondary.env),
                 primary.declaredVia = coalesce(primary.declaredVia, secondary.declaredVia),
                 primary.confidence = coalesce(primary.confidence, secondary.confidence)`,
            { primaryId, secondaryId },
        ),
        tx => tx.run(
            `MATCH (ch:MessageChannel)
             WHERE ch.brokerUrn = $secondaryId
             SET ch.brokerUrn = $primaryId`,
            { primaryId, secondaryId },
        ),
        tx => tx.run(
            `MATCH (ch:MessageChannel)-[oldR:HOSTED_ON]->(:MessageBroker {id: $secondaryId})
             WHERE oldR.valid_to_commit IS NULL
             MATCH (primary:MessageBroker {id: $primaryId})
             MERGE (ch)-[newR:HOSTED_ON]->(primary)
             ON CREATE SET newR = properties(oldR),
                           newR.valid_from_commit = $commitHash,
                           newR.valid_to_commit = null
             ON MATCH SET newR += properties(oldR),
                          newR.valid_to_commit = null
             SET oldR.valid_to_commit = $commitHash`,
            { primaryId, secondaryId, commitHash },
        ),
        tx => moveConnectsToEdges(tx, secondaryId, primaryId, commitHash),
        tx => tx.run(
            `MATCH (secondary:MessageBroker {id: $secondaryId})
             DETACH DELETE secondary`,
            { secondaryId },
        ),
    ]);
}

/**
 * Vhost-blind group key: same identity tuple EXCEPT vhost. Used by the
 * complementary-halves policy (host-only broker melting into the unique
 * vhost-bearing sibling).
 */
function vhostBlindGroupKey(b: BrokerRow): string | null {
    if (!b.provider || !b.host) return null;
    const host = normalizeHost(b.host);
    if (!host) return null;
    const scope = b.fingerprintScope === 'repo' ? 'repo' : 'global';
    if (scope === 'repo' && !b.repoScope) return null;
    return JSON.stringify([
        b.provider,
        host,
        b.port ?? '',
        scope,
        scope === 'repo' ? b.repoScope : '',
    ]);
}

/**
 * Complementary-halves vhost policy. Code-side env discovery often yields a
 * host WITHOUT vhost (the vhost lives mid-DSN or in another config file)
 * while infra yields host+vhost — same provider/host/port, fingerprints
 * diverge only on vhost, so the exact-key consolidation above never sees them.
 *
 * Rules (per group with identical vhost-blind key):
 *   - exactly ONE distinct KNOWN vhost → every vhost-NULL sibling melts into
 *     the vhost-bearing broker (richer identity wins);
 *   - `'/'` is a KNOWN vhost (the AMQP default), never adoptable into a named
 *     one — two known vhosts are two legitimate logical brokers, NO review noise;
 *   - ≥2 distinct known vhosts + a vhost-NULL sibling → the NULL broker is
 *     ambiguous: no melt, `needsReview=true` on the NULL broker ONLY
 *     (queryable via listNeedsReview / cr doctor).
 */
async function meltVhostNullSiblings(brokers: BrokerRow[], commitHash: string): Promise<number> {
    const groups = new Map<string, BrokerRow[]>();
    for (const broker of brokers) {
        const key = vhostBlindGroupKey(broker);
        if (!key) continue;
        const group = groups.get(key) ?? [];
        group.push(broker);
        groups.set(key, group);
    }

    let merged = 0;
    for (const group of groups.values()) {
        const nullVhost = group.filter(b => b.vhost === undefined || b.vhost === null);
        if (nullVhost.length === 0) continue;
        const knownVhosts = [...new Set(
            group.filter(b => b.vhost !== undefined && b.vhost !== null).map(b => b.vhost as string),
        )];
        if (knownVhosts.length === 1) {
            const primary = group.find(b => b.vhost === knownVhosts[0])!;
            for (const secondary of nullVhost) {
                await mergeSecondaryIntoPrimary(primary.id, secondary.id, commitHash);
                merged++;
            }
        } else if (knownVhosts.length >= 2) {
            for (const ambiguous of nullVhost) {
                await run(
                    `MATCH (b:MessageBroker {id: $id}) SET b.needsReview = true`,
                    { id: ambiguous.id },
                );
            }
        }
    }
    return merged;
}

export async function consolidateDuplicateBrokers(commitHash: string): Promise<BrokerConsolidationResult> {
    const brokers = await fetchLiveBrokers();
    const groups = new Map<string, BrokerRow[]>();
    for (const broker of brokers) {
        const key = safeGroupKey(broker);
        if (!key) continue;
        const group = groups.get(key) ?? [];
        group.push(broker);
        groups.set(key, group);
    }

    let merged = 0;
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const primary = choosePrimary(group);
        for (const secondary of group) {
            if (secondary.id === primary.id) continue;
            await mergeSecondaryIntoPrimary(primary.id, secondary.id, commitHash);
            merged++;
        }
    }

    // Second pass — vhost-blind complementary halves (re-fetch: the exact-key
    // pass above may have already removed rows).
    merged += await meltVhostNullSiblings(await fetchLiveBrokers(), commitHash);

    return { merged };
}
