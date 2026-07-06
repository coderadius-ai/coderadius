import neo4j, { Driver } from 'neo4j-driver';
import 'dotenv/config';
import { logger } from '../utils/logger.js';

let driver: Driver | null = null;

/**
 * Returns a singleton Neo4j/Memgraph driver instance.
 *
 * Pool size kept intentionally small (5) to limit the number of idle TCP
 * connections managed by Bun's native `net` module.  High pool sizes (50–200)
 * trigger a deterministic use-after-free segfault in Bun/JSC on long-running
 * scans (200+ repos), likely due to a bug in Bun's internal socket table.
 */
export function getMemgraphDriver(): Driver {
    if (!driver) {
        const uri = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
        // Memgraph Community ignores auth, but the driver requires non-empty values
        const user = process.env.MEMGRAPH_USER || 'coderadius';
        const password = process.env.MEMGRAPH_PASSWORD || 'coderadius';
        // neo4j-driver v6 defaults encrypted=true. Local Memgraph (and the
        // docker-compose default deployment) speaks plain bolt; we disable
        // encryption unless the URI explicitly uses a TLS scheme (`bolt+s` /
        // `neo4j+s`) or the operator overrides via MEMGRAPH_ENCRYPTED.
        const wantsTls = /^bolt\+s|^neo4j\+s/i.test(uri) || process.env.MEMGRAPH_ENCRYPTED === '1';
        const encrypted = wantsTls ? 'ENCRYPTION_ON' : 'ENCRYPTION_OFF';

        driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
            maxConnectionPoolSize: 5,
            connectionAcquisitionTimeout: 60_000,
            encrypted,
        });
    }
    return driver;
}

/**
 * Returns a session for the configured Memgraph database.
 */
export function getMemgraphSession() {
    // Memgraph standard edition has no multi-database support.
    // Omit the 'database' parameter to use the default in-memory one.
    return getMemgraphDriver().session();
}

/**
 * Alias for {@link getMemgraphSession} — used by integration tests and any
 * callers that reference the legacy Neo4j naming convention.
 */
export const getNeo4jSession = getMemgraphSession;

/**
 * Gracefully close the driver.
 */
export async function closeNeo4j(): Promise<void> {
    if (driver) {
        await driver.close();
        driver = null;
    }
}

/**
 * Fully close and discard the driver — the next `getMemgraphDriver()` call
 * recreates it with fresh TCP connections.
 *
 * Use this periodically during long-running scans to reset Bun's internal
 * socket state and prevent the deterministic segfault at 0x6D6F632220200A7B.
 * Unlike Bun.gc(true), this does NOT trigger a GC sweep and is safe to call
 * while the event loop has pending I/O.
 */
export async function recycleDriver(): Promise<void> {
    if (driver) {
        try {
            await driver.close();
        } catch {
            // Ignore close errors — the driver may already be in a bad state
        }
        driver = null;
    }
}

/**
 * Initialize the graph schema — uniqueness constraints.
 * Safe to call multiple times (idempotent via try/catch for Memgraph).
 */
import { CONSTRAINT_MAP, SECONDARY_INDEXES } from './domain.js';

export async function assertDbConnection(): Promise<void> {
    try {
        const d = getMemgraphDriver();
        await d.verifyConnectivity();
    } catch (err: any) {
        const uri = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
        throw new Error(`Database connection failed: Memgraph is not running on ${uri}.\nPlease run 'cr start' to launch the infrastructure.`);
    }
}

export async function initSchema(opts?: { silent?: boolean }): Promise<void> {
    await assertDbConnection();
    
    const session = getMemgraphSession();
    const silent = opts?.silent ?? false;

    try {
        const constraints = Object.entries(CONSTRAINT_MAP).map(([label, prop]) => ({
            label, prop
        }));

        let failures = 0;

        for (const { label, prop } of constraints) {
            const cypher = `CREATE CONSTRAINT ON (n:${label}) ASSERT n.${prop} IS UNIQUE;`;
            try {
                await session.run(cypher);
            } catch (err: any) {
                if (!err.message.includes('already exists')) {
                    failures++;
                    if (!silent) {
                        logger.warn(`\x1b[90m(memgraph)\x1b[0m Failed to create constraint for ${label}: ${err.message}`);
                    }
                }
            }
        }

        if (failures > 0) {
            throw new Error(`${failures} constraints failed to initialize`);
        }

        // Secondary (non-unique) indexes used to accelerate matching queries.
        // CREATE INDEX is idempotent in Memgraph: re-issuing it is a no-op.
        // We swallow "already exists" errors to keep initSchema idempotent.
        let indexFailures = 0;
        for (const { label, property } of SECONDARY_INDEXES) {
            const cypher = `CREATE INDEX ON :${label}(${property});`;
            try {
                await session.run(cypher);
            } catch (err: any) {
                const msg = String(err?.message ?? '');
                if (!msg.includes('already exists') && !msg.toLowerCase().includes('exists')) {
                    indexFailures++;
                    if (!silent) {
                        logger.warn(`\x1b[90m(memgraph)\x1b[0m Failed to create index on ${label}(${property}): ${msg}`);
                    }
                }
            }
        }

        logger.debug(`\x1b[90m(memgraph)\x1b[0m Schema initialized: uniqueness constraints + ${SECONDARY_INDEXES.length - indexFailures}/${SECONDARY_INDEXES.length} secondary indexes ready.`);
    } finally {
        await session.close();
    }
}
