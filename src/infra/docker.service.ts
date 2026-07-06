/**
 * Docker Service — Infrastructure layer for managing the Memgraph container.
 *
 * Uses `docker run` directly (not docker compose) so the CLI binary is
 * fully portable without needing a compose file shipped alongside it.
 */
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { paths } from '../config/paths.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const CONTAINER_NAME = 'coderadius-memgraph';
const IMAGE = 'memgraph/memgraph-mage:latest';
const BOLT_PORT = 7687;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ContainerState = 'running' | 'stopped' | 'missing';

export interface PreflightResult {
    dockerInstalled: boolean;
    dockerRunning: boolean;
    initDone: boolean;
    containerState: ContainerState;
    portAvailable: boolean;
}

// ─── Shell Helpers ───────────────────────────────────────────────────────────

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
};

function sh(cmd: string): string {
    return execSync(cmd, EXEC_OPTS).trim();
}

function shSafe(cmd: string): string | null {
    try {
        return sh(cmd);
    } catch {
        return null;
    }
}

// ─── Preflight Checks ───────────────────────────────────────────────────────

export function isDockerInstalled(): boolean {
    return shSafe('docker --version') !== null;
}

export function isDockerRunning(): boolean {
    return shSafe('docker info') !== null;
}

export function isInitDone(): boolean {
    return fs.existsSync(paths.config.settings);
}

export function getContainerState(): ContainerState {
    const result = shSafe(
        `docker inspect --format='{{.State.Running}}' ${CONTAINER_NAME}`
    );
    if (result === null) return 'missing';
    return result === 'true' ? 'running' : 'stopped';
}

export function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
    });
}

export async function runPreflight(): Promise<PreflightResult> {
    const dockerInstalled = isDockerInstalled();
    const dockerRunning = dockerInstalled ? isDockerRunning() : false;
    const initDone = isInitDone();
    const containerState = dockerRunning ? getContainerState() : 'missing';
    const portAvailable = containerState === 'running'
        ? true  // Our container owns the port
        : await isPortAvailable(BOLT_PORT);

    return { dockerInstalled, dockerRunning, initDone, containerState, portAvailable };
}

// ─── Container Lifecycle ─────────────────────────────────────────────────────

export function startExistingContainer(): void {
    sh(`docker start ${CONTAINER_NAME}`);
}

export function createAndStartContainer(): void {
    const user = process.env.MEMGRAPH_USER || 'coderadius';
    const pass = process.env.MEMGRAPH_PASSWORD || 'coderadius';

    fs.mkdirSync(paths.data.memgraph, { recursive: true });
    fs.mkdirSync(paths.data.memgraphLogs, { recursive: true });

    sh([
        'docker run -d',
        `--name ${CONTAINER_NAME}`,
        `-p ${BOLT_PORT}:7687`,
        `-e MEMGRAPH_USER=${user}`,
        `-e MEMGRAPH_PASSWORD=${pass}`,
        `-v ${paths.data.memgraph}:/var/lib/memgraph`,
        `-v ${paths.data.memgraphLogs}:/var/log/memgraph`,
        IMAGE
    ].join(' '));
}

export function stopContainer(): void {
    sh(`docker stop ${CONTAINER_NAME}`);
}

export function removeContainer(): void {
    shSafe(`docker rm ${CONTAINER_NAME}`);
}

export function removeVolumes(): void {
    fs.rmSync(paths.data.dir, { recursive: true, force: true });
}

// ─── State Dump / Restore ────────────────────────────────────────────────────

/**
 * Runs `DUMP DATABASE` inside the Memgraph container via mgconsole.
 * Returns the full CYPHERL dump as a string (every line is a Cypher statement).
 *
 * Requires the container to be in 'running' state.
 * Uses `--output_format=cypherl` to get a re-importable text dump that
 * includes nodes, relationships, constraints, indexes, and triggers.
 *
 * Note: mgconsole does NOT have a `-c` flag — commands must be piped via stdin.
 * The flag uses an underscore (`output_format`), not a hyphen.
 */
export function dumpDatabase(): string {
    const user = process.env.MEMGRAPH_USER || 'coderadius';
    const pass = process.env.MEMGRAPH_PASSWORD || 'coderadius';

    return execSync(
        `echo "DUMP DATABASE;" | docker exec -i ${CONTAINER_NAME} mgconsole --output_format=cypherl --username=${user} --password=${pass}`,
        { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
}

/**
 * Pipes a CYPHERL dump into mgconsole inside the running container.
 * Each line of the input is executed as a Cypher statement.
 *
 * @param cypherl — The full CYPHERL text content (e.g. from a previous `dumpDatabase()` call).
 */
export function loadDatabase(cypherl: string): void {
    const user = process.env.MEMGRAPH_USER || 'coderadius';
    const pass = process.env.MEMGRAPH_PASSWORD || 'coderadius';

    execSync(
        `docker exec -i ${CONTAINER_NAME} mgconsole --username=${user} --password=${pass}`,
        { input: cypherl, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
    );
}

// ─── Readiness Probe ─────────────────────────────────────────────────────────

/**
 * Wait for Memgraph to accept Bolt connections.
 * Retries TCP connect on the Bolt port up to `maxRetries` times.
 */
export function waitForBolt(maxRetries = 30, intervalMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        const tryConnect = () => {
            attempts++;
            const socket = net.createConnection({ host: '127.0.0.1', port: BOLT_PORT });

            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });

            socket.once('error', () => {
                socket.destroy();
                if (attempts >= maxRetries) {
                    reject(new Error(`Memgraph did not become ready after ${maxRetries} attempts`));
                } else {
                    setTimeout(tryConnect, intervalMs);
                }
            });
        };

        tryConnect();
    });
}
