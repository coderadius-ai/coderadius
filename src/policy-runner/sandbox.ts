import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Policy Runner Sandbox
//
// Provides a READ-ONLY Memgraph driver isolated from the main ingestion driver.
// This separation enforces two security properties:
//
//   1. Read-only intent: the sandbox driver connects with a dedicated
//      MEMGRAPH_POLICY_USER that has only READ privileges on the database.
//      If no policy user is configured, falls back to the main user with a
//      runtime write-rejection layer (the loader's static analysis).
//
//   2. Query timeout: every query is wrapped in a configurable timeout
//      so that pathological Cypher (e.g. cartesian products) cannot hold
//      the database open indefinitely (DoS prevention).
//
// The sandbox driver is created lazily and has a pool size of 2 (minimal),
// since policy checks are sequential by design.
// ═══════════════════════════════════════════════════════════════════════════════

let sandboxDriver: Driver | null = null;

/**
 * Returns the read-only sandbox driver for policy query execution.
 * Created lazily and reused across queries within a single `cr policy verify` run.
 */
function getSandboxDriver(): Driver {
    if (!sandboxDriver) {
        const uri = process.env.MEMGRAPH_URI ?? 'bolt://localhost:7687';
        // Use a dedicated read-only user if configured; fall back to main user.
        // In production, MEMGRAPH_POLICY_USER should be a Memgraph user with
        // only READ privileges (CREATE USER policy_runner; GRANT READ ON ... TO policy_runner).
        const user = process.env.MEMGRAPH_POLICY_USER ?? process.env.MEMGRAPH_USER ?? 'coderadius';
        const password = process.env.MEMGRAPH_POLICY_PASSWORD ?? process.env.MEMGRAPH_PASSWORD ?? 'coderadius';

        sandboxDriver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
            maxConnectionPoolSize: 2,
            connectionAcquisitionTimeout: 30_000,
        });
    }
    return sandboxDriver;
}

/**
 * Close the sandbox driver. Called once after all policy queries complete.
 */
export async function closeSandbox(): Promise<void> {
    if (sandboxDriver) {
        await sandboxDriver.close();
        sandboxDriver = null;
    }
}

// ─── Timeout-guarded Query Execution ─────────────────────────────────────────

export interface SandboxQueryOptions {
    /** Query timeout in milliseconds. Default: 5000ms. */
    timeoutMs?: number;
}

export interface SandboxQueryResult {
    rows: Array<Record<string, unknown>>;
    executionMs: number;
}

/**
 * Execute a Cypher query in the read-only sandbox with a strict timeout.
 *
 * The timeout is enforced via a `Promise.race` between the Bolt query and a
 * timer rejection. If the query exceeds the timeout, we close the session
 * immediately (which cancels the in-flight query on the server side).
 *
 * @throws {Error} if the query times out or Memgraph returns an error.
 */
export async function runSandboxQuery(
    cypher: string,
    params: Record<string, unknown> = {},
    options: SandboxQueryOptions = {},
): Promise<SandboxQueryResult> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const driver = getSandboxDriver();
    let session: Session | null = null;
    const t0 = Date.now();

    try {
        session = driver.session();

        const queryPromise = session.run(cypher, params);

        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Query timed out after ${timeoutMs}ms`)), timeoutMs),
        );

        const result = await Promise.race([queryPromise, timeoutPromise]);

        const rows = result.records.map(record => {
            const obj: Record<string, unknown> = {};
            for (const key of record.keys) {
                const val = record.get(key as string);
                // Unwrap Neo4j Integer objects to plain JS numbers
                obj[key as string] = neo4j.isInt(val) ? val.toNumber() : val;
            }
            return obj;
        });

        const executionMs = Date.now() - t0;
        return { rows, executionMs };
    } finally {
        if (session) {
            try { await session.close(); } catch { /* ignore */ }
        }
    }
}

/**
 * Quick connectivity check for the sandbox driver.
 * Used by the CLI command to fail fast before loading rules.
 */
export async function verifySandboxConnection(): Promise<void> {
    try {
        const driver = getSandboxDriver();
        await driver.verifyConnectivity();
    } catch (err: unknown) {
        const uri = process.env.MEMGRAPH_URI ?? 'bolt://localhost:7687';
        throw new Error(
            `Policy Runner: cannot connect to Memgraph at ${uri}.\n` +
            `Run 'cr start' to launch the infrastructure.\n` +
            `Original error: ${(err as Error).message}`,
        );
    }
    logger.debug('[PolicySandbox] Connection verified.');
}
