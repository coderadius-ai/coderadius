/**
 * Code Graph — Repository, Library, Function, EnvVar mutations
 *
 * The AST-level code graph: repos, libraries, functions, and environment vars.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn, getQualifiedRepoName } from '../urn.js';
import { astGrounding } from '../grounding.js';
import { mergeOrganization, linkRepositoryBelongsToOrg, sanitizeOrg } from './organization.js';
import { linkWrittenIn } from './technology.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Code Graph (Cartographer + Observer)
// ═══════════════════════════════════════════════════════════════════════════════

export interface LivenessPayload {
    commits: number;
    computedAt: string;
}

export interface GitConventionsPayload {
    ticketIdRate: number;
    conventionalCommitRate: number;
    sampleSize: number;
}

export async function mergeRepository(
    name: string,
    url: string | undefined,
    commitHash: string,
    /** Org namespace: URN segment + BELONGS_TO edge only, never written to the node as r.org. */
    org: string | undefined,
    liveness?: LivenessPayload,
    branch?: string,
    defaultBranch?: string,
    coreBranches?: string[],
    hostingPlatform?: string,
    gitConventions?: GitConventionsPayload,
    lastAnalyzedAt?: string,
) {
    const rUrn = buildUrn('repository', getQualifiedRepoName({ name, org }));
    const prov = astGrounding('repository-discovery@v1');

    await run(
        `MERGE (r:Repository {id: $rUrn})
     ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null, r.name = $name, r.url = $url, r.branch = $branch, r.createdAt = timestamp(),
                   r.livenessCommits = $livenessCommits,
                   r.livenessComputedAt = $livenessComputedAt,
                   r.defaultBranch = $defaultBranch,
                   r.coreBranches = $coreBranches,
                   r.hostingPlatform = $hostingPlatform,
                   r.commitTicketIdRate = $commitTicketIdRate,
                   r.commitConventionalRate = $commitConventionalRate,
                   r.commitsScanned = $commitsScanned,
                   r.lastAnalyzedAt = coalesce($lastAnalyzedAt, r.lastAnalyzedAt)
     ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null,
                  r.url = coalesce($url, r.url),
                  r.branch = coalesce($branch, r.branch),
                  r.livenessCommits = coalesce($livenessCommits, r.livenessCommits),
                  r.livenessComputedAt = coalesce($livenessComputedAt, r.livenessComputedAt),
                  r.defaultBranch = coalesce($defaultBranch, r.defaultBranch),
                  r.coreBranches = coalesce($coreBranches, r.coreBranches),
                  r.hostingPlatform = coalesce($hostingPlatform, r.hostingPlatform),
                  r.commitTicketIdRate = coalesce($commitTicketIdRate, r.commitTicketIdRate),
                  r.commitConventionalRate = coalesce($commitConventionalRate, r.commitConventionalRate),
                  r.commitsScanned = coalesce($commitsScanned, r.commitsScanned),
                  r.lastAnalyzedAt = coalesce($lastAnalyzedAt, r.lastAnalyzedAt)
     ${groundingWriteClause('r')}`,
        {
            rUrn,
            name,
            url: url ?? null,
            commitHash,
            branch: branch ?? null,
            livenessCommits:    liveness?.commits    ?? null,
            livenessComputedAt: liveness?.computedAt ?? null,
            defaultBranch:      defaultBranch ?? null,
            coreBranches:       coreBranches ?? null,
            hostingPlatform:    hostingPlatform ?? null,
            commitTicketIdRate:      gitConventions?.ticketIdRate ?? null,
            commitConventionalRate:  gitConventions?.conventionalCommitRate ?? null,
            commitsScanned:          gitConventions?.sampleSize ?? null,
            lastAnalyzedAt:          lastAnalyzedAt ?? null,
            ...groundingParams(prov, commitHash),
        },
    );

    if (sanitizeOrg(org)) {
        await mergeOrganization(org!, commitHash);
        await linkRepositoryBelongsToOrg(rUrn, org!, commitHash);
    }
}

/**
 * Batch-merge multiple repositories in a single UNWIND transaction.
 * Reduces 300+ individual round-trips to a handful of batched writes.
 * Falls back to individual merges if UNWIND fails (e.g. Memgraph version issue).
 */
export interface RepositoryBatchItem {
    name: string;
    url: string | undefined;
    commitHash: string;
    /** Same contract as the mergeRepository() org param. */
    org: string | undefined;
    liveness?: LivenessPayload;
    branch?: string;
    defaultBranch?: string;
    coreBranches?: string[];
    hostingPlatform?: string;
    gitConventions?: GitConventionsPayload;
    lastAnalyzedAt?: string;
}

const REPO_BATCH_SIZE = 50;

export async function mergeRepositoriesBatch(repos: RepositoryBatchItem[]): Promise<void> {
    if (repos.length === 0) return;

    // All repos in this batch share the same grounding (repository discovery is
    // a deterministic file-system walk; ast/exact). The batch's $ground_* params
    // are applied uniformly via the same groundingWriteClause as single-merges.
    const prov = astGrounding('repository-discovery@v1');

    // Process in sub-batches to avoid oversized Cypher parameters
    for (let i = 0; i < repos.length; i += REPO_BATCH_SIZE) {
        const batch = repos.slice(i, i + REPO_BATCH_SIZE);
        const rows = batch.map(r => {
            return {
                rUrn: buildUrn('repository', getQualifiedRepoName({ name: r.name, org: r.org })),
                name: r.name,
                url: r.url ?? null,
                commitHash: r.commitHash,
                branch: r.branch ?? null,
                livenessCommits: r.liveness?.commits ?? null,
                livenessComputedAt: r.liveness?.computedAt ?? null,
                defaultBranch: r.defaultBranch ?? null,
                coreBranches: r.coreBranches ?? null,
                hostingPlatform: r.hostingPlatform ?? null,
                commitTicketIdRate: r.gitConventions?.ticketIdRate ?? null,
                commitConventionalRate: r.gitConventions?.conventionalCommitRate ?? null,
                commitsScanned: r.gitConventions?.sampleSize ?? null,
                lastAnalyzedAt: r.lastAnalyzedAt ?? null,
            };
        });

        try {
            await run(
                `UNWIND $rows AS row
                 MERGE (r:Repository {id: row.rUrn})
                 ON CREATE SET r.valid_from_commit = row.commitHash, r.valid_to_commit = null,
                               r.name = row.name, r.url = row.url, r.branch = row.branch, r.createdAt = timestamp(),
                               r.livenessCommits = row.livenessCommits,
                               r.livenessComputedAt = row.livenessComputedAt,
                               r.defaultBranch = row.defaultBranch,
                               r.coreBranches = row.coreBranches,
                               r.hostingPlatform = row.hostingPlatform,
                               r.commitTicketIdRate = row.commitTicketIdRate,
                               r.commitConventionalRate = row.commitConventionalRate,
                               r.commitsScanned = row.commitsScanned,
                               r.lastAnalyzedAt = coalesce(row.lastAnalyzedAt, r.lastAnalyzedAt)
                 ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, row.commitHash), r.valid_to_commit = null,
                              r.url = coalesce(row.url, r.url),
                              r.branch = coalesce(row.branch, r.branch),
                              r.livenessCommits = coalesce(row.livenessCommits, r.livenessCommits),
                              r.livenessComputedAt = coalesce(row.livenessComputedAt, r.livenessComputedAt),
                              r.defaultBranch = coalesce(row.defaultBranch, r.defaultBranch),
                              r.coreBranches = coalesce(row.coreBranches, r.coreBranches),
                              r.hostingPlatform = coalesce(row.hostingPlatform, r.hostingPlatform),
                              r.commitTicketIdRate = coalesce(row.commitTicketIdRate, r.commitTicketIdRate),
                              r.commitConventionalRate = coalesce(row.commitConventionalRate, r.commitConventionalRate),
                              r.commitsScanned = coalesce(row.commitsScanned, r.commitsScanned),
                              r.lastAnalyzedAt = coalesce(row.lastAnalyzedAt, r.lastAnalyzedAt)
                 ${groundingWriteClause('r')}`,
                { rows, ...groundingParams(prov, repos[0].commitHash) },
            );
        } catch {
            // Fallback: individual merges if UNWIND fails (includes org hierarchy via mergeRepository)
            for (const r of batch) {
                await mergeRepository(r.name, r.url, r.commitHash, r.org, r.liveness, r.branch, r.defaultBranch, r.coreBranches, r.hostingPlatform, r.gitConventions, r.lastAnalyzedAt);
            }
            continue;
        }

        // Wire org hierarchy for successfully batched repos
        const uniqueOrgs = new Set(batch.map(r => sanitizeOrg(r.org)).filter(Boolean) as string[]);
        for (const orgPath of uniqueOrgs) {
            await mergeOrganization(orgPath, batch[0].commitHash);
        }
        for (const r of batch) {
            const clean = sanitizeOrg(r.org);
            if (clean) {
                const rUrn = buildUrn('repository', getQualifiedRepoName({ name: r.name, org: r.org }));
                await linkRepositoryBelongsToOrg(rUrn, clean, r.commitHash);
            }
        }
    }
}

export async function mergeLibrary(name: string, commitHash: string) {
    const lUrn = buildUrn('library', name);
    const prov = astGrounding('library-discovery@v1');
    await run(
        `MERGE (l:Library {id: $lUrn})
     ON CREATE SET l.valid_from_commit = $commitHash, l.valid_to_commit = null, l.name = $name, l.createdAt = timestamp()
     ON MATCH SET l.valid_from_commit = coalesce(l.valid_from_commit, $commitHash), l.valid_to_commit = null
     ${groundingWriteClause('l')}`,
        { lUrn, name, commitHash, ...groundingParams(prov, commitHash) },
    );
}

export async function linkServiceStoredIn(qualifiedRepoName: string, serviceName: string, repoQualifiedName: string, path: string, commitHash: string) {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    const rUrn = buildUrn('repository', repoQualifiedName);
    await run(
        `MATCH (s:Service {id: $sUrn})
     MATCH (r:Repository {id: $rUrn})
     MERGE (s)-[rel:STORED_IN]->(r)
     ON CREATE SET rel.path = $path, rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.path = CASE WHEN $path <> '' THEN $path ELSE rel.path END, rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { sUrn, rUrn, path , commitHash },
    );
}

export async function linkLibraryStoredIn(libraryName: string, qualifiedRepoName: string, path: string, commitHash: string) {
    const lUrn = buildUrn('library', libraryName);
    const rUrn = buildUrn('repository', qualifiedRepoName);
    await run(
        `MATCH (l:Library {id: $lUrn})
     MATCH (r:Repository {id: $rUrn})
     MERGE (l)-[rel:STORED_IN]->(r)
     ON CREATE SET rel.path = $path, rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.path = CASE WHEN $path <> '' THEN $path ELSE rel.path END, rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { lUrn, rUrn, path , commitHash },
    );
}

export async function linkLibraryContainsFunction(libraryName: string, functionId: string, commitHash: string) {
    const lUrn = buildUrn('library', libraryName);
    await run(
        `MATCH (l:Library {id: $lUrn})
     MATCH (f:Function {id: $functionId})
     MERGE (l)-[rel:CONTAINS]->(f)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { lUrn, functionId , commitHash },
    );
}

export async function mergeFunction(id: string,
    name: string,
    filepath: string,
    intent: string | null,
    capabilities: string[] | null,
    embedding: number[] | null,
    language: string,
    startLine: number,
    endLine: number,
    sourceHash: string | undefined, commitHash: string) {
    // Function existence + position is pure AST; intent/capabilities/embedding
    // come from LLM but are stored on the same node. Grounding reflects the
    // hybrid: composite (ast for the existence facts + llm for the inferred ones).
    // When this mutation is called fresh from the file pipeline, we mark composite.
    const prov = intent !== null || (capabilities && capabilities.length > 0)
        ? { source: 'composite' as const, quality: 'high' as const,
            evidence: { extractors: ['ast-function-walk@v1', 'unified-analyzer@v1'] } }
        : astGrounding('ast-function-walk@v1');
    await run(
        `MERGE (f:Function {id: $id})
     ON CREATE SET f.valid_from_commit = $commitHash, f.valid_to_commit = null, f.name = $name,
                   f.filepath = $filepath,
                   f.intent = $intent,
                   f.capabilities = coalesce($capabilities, []),
                   f.embedding = $embedding,
                   f.startLine = $startLine,
                   f.endLine = $endLine,
                   f.sourceHash = $sourceHash,
                   f.createdAt = timestamp()
     ON MATCH SET f.valid_from_commit = coalesce(f.valid_from_commit, $commitHash), f.valid_to_commit = null,
                   f.intent = coalesce($intent, f.intent),
                   f.capabilities = coalesce($capabilities, f.capabilities, []),
                   f.embedding = coalesce($embedding, f.embedding),
                   f.startLine = $startLine,
                   f.endLine = $endLine,
                   f.sourceHash = coalesce($sourceHash, f.sourceHash)
     ${groundingWriteClause('f')}`,
        { id, name, filepath, intent, capabilities: capabilities ?? [], embedding, startLine, endLine, sourceHash: sourceHash ?? null, commitHash, ...groundingParams(prov, commitHash) },
    );

    if (language && language !== 'unknown') {
        await linkWrittenIn(id, language, commitHash);
    }
}

// ─── EnvVar Nodes ─────────────────────────────────────────────────────────────



export async function linkServiceContainsFunction(qualifiedRepoName: string, serviceName: string, functionId: string, commitHash: string) {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    await run(
        `MATCH (s:Service {id: $sUrn})
     MATCH (f:Function {id: $functionId})
     MERGE (s)-[rel:CONTAINS]->(f)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { sUrn, functionId , commitHash },
    );
}

export async function linkFunctionCallsFunction(callerId: string, calleeId: string, commitHash: string) {
    await run(
        `MATCH (a:Function {id: $callerId})
     MATCH (b:Function {id: $calleeId})
     MERGE (a)-[rel:CALLS]->(b)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { callerId, calleeId , commitHash },
    );
}

// ─── Traces ──────────────────────────────────────────────────────────────────

export async function mergeTraceSpan(spanId: string,
    operationName: string,
    serviceName: string,
    latencyMs: number,
    status: string,
    attributes: Record<string, unknown> | undefined, commitHash: string) {
    // TraceSpan is recorded from an observed runtime trace — eventually source='runtime'
    // when telemetry ingestion lands. For now: ast/exact stamp keeps consistency.
    const prov = astGrounding('trace-span-ingestor@v1');
    await run(
        `MERGE (t:TraceSpan {spanId: $spanId})
     ON CREATE SET t.valid_from_commit = $commitHash, t.valid_to_commit = null, t.name = $operationName,
                   t.operationName = $operationName,
                   t.serviceName = $serviceName,
                   t.latency_ms = $latencyMs,
                   t.status = $status,
                   t.attributes = $attributes,
                   t.createdAt = timestamp()
     ON MATCH SET t.valid_from_commit = coalesce(t.valid_from_commit, $commitHash), t.valid_to_commit = null
     ${groundingWriteClause('t')}`,
        { spanId, operationName, serviceName, latencyMs, status, attributes: JSON.stringify(attributes ?? {}), commitHash, ...groundingParams(prov, commitHash) }
    );
}

export async function linkTraceObservedInFunction(spanId: string, functionId: string, commitHash: string) {
    await run(
        `MATCH (t:TraceSpan {spanId: $spanId})
     MATCH (f:Function {id: $functionId})
     MERGE (t)-[rel:OBSERVED_IN]->(f)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { spanId, functionId , commitHash },
    );
}

/**
 * Tombstone all outgoing relationships from a function.
 * Used before re-persisting a function's analysis results to ensure
 * that stale edges (e.g. to renamed tables or old API endpoints) are
 * marked as invalid. The subsequent MERGE calls in the write phase
 * will "revive" (set valid_to_commit = null) only the edges that still exist.
 */
export async function tombstoneFunctionRelationships(functionId: string, commitHash: string) {
    await run(
        `MATCH (f:Function {id: $functionId})-[rel]->(target)
         WHERE rel.valid_to_commit IS NULL
         SET rel.valid_to_commit = $commitHash`,
        { functionId, commitHash },
    );
}
