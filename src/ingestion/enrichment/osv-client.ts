/**
 * PRIVACY CONTRACT
 *
 * This module sends (ecosystem, packageName, version) tuples to the OSV.dev
 * public API. These are PUBLIC package identifiers from open-source registries.
 *
 * The following data categories NEVER leave the machine:
 *   - Source code content
 *   - File paths or repository structure
 *   - Internal/private package names (filtered by isInternal check upstream)
 *   - Repository URLs, branch names, commit hashes
 *   - Team names, ownership information
 *   - Environment variables or credentials
 */

import { logger } from '../../utils/logger.js';
import { toOsvEcosystem } from './ecosystem-map.js';
import { computeCvssV3BaseScore } from './cvss.js';

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns';
const OSV_CHUNK_SIZE = 1000;
const HYDRATE_CONCURRENCY = 8;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OsvQuery {
    ecosystem: string;
    name: string;
    version: string;
}

export interface OsvSeverity {
    type: string;
    score: string;
}

export interface OsvAffectedRange {
    type: string;
    events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
}

export interface OsvAffected {
    package: { ecosystem: string; name: string };
    ranges?: OsvAffectedRange[];
    versions?: string[];
}

export interface OsvVulnerability {
    id: string;
    aliases?: string[];
    summary?: string;
    details?: string;
    severity?: OsvSeverity[];
    affected?: OsvAffected[];
    references?: Array<{ type: string; url: string }>;
    published?: string;
    modified?: string;
    withdrawn?: string;
    /** Advisory-database extras; GHSA records declare severity here. */
    database_specific?: { severity?: string };
}

interface OsvBatchResponse {
    results: Array<{ vulns?: OsvVulnerability[] }>;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function makeCacheKey(ecosystem: string, name: string, version: string): string {
    return `${ecosystem}:${name}:${version}`;
}

export async function queryOsvBatch(
    queries: OsvQuery[],
): Promise<Map<string, OsvVulnerability[]>> {
    if (queries.length === 0) return new Map();

    const results = new Map<string, OsvVulnerability[]>();
    const chunks = chunkArray(queries, OSV_CHUNK_SIZE);

    logger.debug(`[osv] Querying ${queries.length} packages in ${chunks.length} batch(es)`);

    for (const chunk of chunks) {
        const batchResults = await fetchChunk(chunk);
        for (const [key, vulns] of batchResults) {
            results.set(key, vulns);
        }
    }

    return results;
}

/**
 * Severity resolution order:
 *   1. advisory-declared severity (`database_specific.severity`, present on GHSA records)
 *   2. base score computed from the CVSS_V3 vector
 *   3. UNKNOWN
 *
 * OSV vector strings carry metrics only (no numeric score), so the score is
 * always derived, never parsed out of the vector.
 */
export function extractSeverity(vuln: OsvVulnerability): { severity: string; cvssScore?: number; cvssVector?: string } {
    const entry = vuln.severity?.find(s => s.type === 'CVSS_V3') ?? vuln.severity?.find(s => s.type === 'CVSS_V4');
    const cvssVector = entry?.score;
    const cvssScore = cvssVector ? computeCvssV3BaseScore(cvssVector) ?? undefined : undefined;

    const declared = normalizeDeclaredSeverity(vuln.database_specific?.severity);
    return { severity: declared ?? cvssScoreToSeverity(cvssScore), cvssScore, cvssVector };
}

const DECLARED_SEVERITY_MAP: Record<string, string> = {
    CRITICAL: 'CRITICAL',
    HIGH: 'HIGH',
    MODERATE: 'MEDIUM',
    MEDIUM: 'MEDIUM',
    LOW: 'LOW',
};

function normalizeDeclaredSeverity(declared: string | undefined): string | null {
    if (!declared) return null;
    return DECLARED_SEVERITY_MAP[declared.toUpperCase()] ?? null;
}

/**
 * Fetch full vulnerability records by OSV id.
 *
 * The querybatch endpoint returns skeleton records (`id` + `modified` only);
 * severity, summary, aliases, and affected ranges require a per-id lookup.
 */
export async function fetchVulnDetails(ids: string[]): Promise<Map<string, OsvVulnerability>> {
    const unique = [...new Set(ids)];
    const details = new Map<string, OsvVulnerability>();
    if (unique.length === 0) return details;

    logger.debug(`[osv] Hydrating ${unique.length} vulnerability records`);
    for (const chunk of chunkArray(unique, HYDRATE_CONCURRENCY)) {
        const records = await Promise.all(chunk.map(id =>
            fetchJsonWithRetry<OsvVulnerability>(`${OSV_VULN_URL}/${encodeURIComponent(id)}`),
        ));
        for (const record of records) {
            if (record) details.set(record.id, record);
        }
    }
    return details;
}

/** Replace querybatch skeletons with hydrated records; keep the skeleton on hydration miss. */
export function hydrateResults(
    results: Map<string, OsvVulnerability[]>,
    details: Map<string, OsvVulnerability>,
): Map<string, OsvVulnerability[]> {
    const hydrated = new Map<string, OsvVulnerability[]>();
    for (const [key, vulns] of results) {
        hydrated.set(key, vulns.map(vuln => details.get(vuln.id) ?? vuln));
    }
    return hydrated;
}

export function extractFixedVersion(vuln: OsvVulnerability): string | null {
    return findFirstEvent(vuln, 'fixed');
}

export function extractIntroducedVersion(vuln: OsvVulnerability): string | null {
    return findFirstEvent(vuln, 'introduced');
}

// ─── Pure helpers (exported for testing) ────────────────────────────────────

export function cvssScoreToSeverity(score: number | undefined): string {
    if (score === undefined) return 'UNKNOWN';
    if (score >= 9.0) return 'CRITICAL';
    if (score >= 7.0) return 'HIGH';
    if (score >= 4.0) return 'MEDIUM';
    if (score > 0) return 'LOW';
    return 'UNKNOWN';
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

// ─── Internals ──────────────────────────────────────────────────────────────

function findFirstEvent(vuln: OsvVulnerability, field: 'fixed' | 'introduced'): string | null {
    for (const affected of vuln.affected ?? []) {
        for (const range of affected.ranges ?? []) {
            for (const event of range.events) {
                const value = event[field];
                if (value && (field !== 'introduced' || value !== '0')) return value;
            }
        }
    }
    return null;
}

async function fetchChunk(chunk: OsvQuery[]): Promise<Map<string, OsvVulnerability[]>> {
    const results = new Map<string, OsvVulnerability[]>();
    const payload = {
        queries: chunk.flatMap(q => {
            const osvEcosystem = toOsvEcosystem(q.ecosystem);
            if (!osvEcosystem) return [];
            return [{ package: { name: q.name, ecosystem: osvEcosystem }, version: q.version }];
        }),
    };

    const response = await fetchJsonWithRetry<OsvBatchResponse>(OSV_BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response) return results;

    for (let i = 0; i < chunk.length; i++) {
        const q = chunk[i];
        results.set(makeCacheKey(q.ecosystem, q.name, q.version), response.results[i]?.vulns ?? []);
    }
    return results;
}

async function fetchJsonWithRetry<T>(url: string, init: RequestInit = {}): Promise<T | null> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            const response = await fetch(url, { ...init, signal: controller.signal });

            clearTimeout(timeoutId);

            if (response.status === 429) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
                logger.debug(`[osv] Rate limited (429), retrying in ${Math.round(delay)}ms`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            if (!response.ok) {
                logger.warn(`[osv] API returned ${response.status}: ${response.statusText}`);
                return null;
            }

            return (await response.json()) as T;
        } catch (err: any) {
            const isTimeout = err.name === 'AbortError';
            logger.warn(`[osv] ${isTimeout ? 'Request timed out' : `Network error: ${err.message}`}`);

            if (attempt < MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
                continue;
            }
            return null;
        }
    }
    return null;
}
