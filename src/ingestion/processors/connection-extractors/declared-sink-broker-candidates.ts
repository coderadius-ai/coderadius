/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * s2 — declared-sink broker candidates (typed config + co-import gate).
 *
 * The customer DECLARES their broker SDK wrapper in coderadius.yaml
 * (`packages.analyze[kind=broker-client, provider=...]`) — contract-grade
 * provider. The association config↔sink is proven STRUCTURALLY, never by key
 * names: a source file in the service must import BOTH the declared package
 * AND the typed-config module (the NestJS provider/module wiring shape).
 * Without the co-import, a same-repo DB config never becomes a broker
 * candidate.
 *
 * What stays a guess: which zod key carries the host/vhost (name-classified
 * inside the typed schema). That is why s2 candidates bind `needsReview=true`
 * until an anchor/convergence corroborates the VALUES — the provider is clean,
 * the value attribution is not.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractZodSchemaKeys } from './plugins/nestjs-config.js';
import type { RepoEnvMap } from './env-var-resolver.js';
import type { BrokerCandidateHint, MessageBrokerHintProvider } from './types.js';

export interface DeclaredBrokerClient {
    name: string;
    provider: MessageBrokerHintProvider;
}

export interface DeclaredSinkSynthesisResult {
    hints: BrokerCandidateHint[];
    /** Env keys consumed by this lane (host/vhost/port), claimed for s0. */
    claimedEnvKeys: Set<string>;
}

const HOST_KEY_RE = /^(?:.*_)?HOST(?:NAME)?$/i;
const VHOST_KEY_RE = /^(?:.*_)?VHOST$/i;
const PORT_KEY_RE = /^(?:.*_)?PORT$/i;
const TEMPLATE_RE = /\$\{|%env\(|process\.env|\{\{/;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', '.git']);
const MAX_FILE_BYTES = 512 * 1024;

interface BrokerConfigShape {
    file: string;
    hostKey: string;
    vhostKey?: string;
    portKey?: string;
}

function* walkSourceFiles(root: string, maxDepth = 6): Generator<string> {
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
        const { dir, depth } = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) stack.push({ dir: abs, depth: depth + 1 });
            } else if (/\.(?:ts|js|mts|mjs)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
                yield abs;
            }
        }
    }
}

function readBounded(absPath: string): string | null {
    try {
        if (fs.statSync(absPath).size > MAX_FILE_BYTES) return null;
        return fs.readFileSync(absPath, 'utf8');
    } catch {
        return null;
    }
}

/** A typed-config file whose zod schema carries a host(+vhost) key pair. */
function classifyBrokerConfigShape(absPath: string, content: string): BrokerConfigShape | null {
    if (!content.includes('registerAs') || !/z\.(?:object|strictObject)/.test(content)) return null;
    for (const block of extractZodSchemaKeys(content)) {
        const hostKey = block.keys.find(k => HOST_KEY_RE.test(k));
        if (!hostKey) continue;
        return {
            file: absPath,
            hostKey,
            vhostKey: block.keys.find(k => VHOST_KEY_RE.test(k)),
            portKey: block.keys.find(k => PORT_KEY_RE.test(k)),
        };
    }
    return null;
}

/** Does `content` import the given module specifier (ES import or require)? */
function importsSpecifier(content: string, specifier: string): boolean {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:from\\s*|require\\s*\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`).test(content);
}

/** Relative-import check: does `content` import `configAbsPath` from `fromFile`? */
function importsConfigModule(content: string, fromFile: string, configAbsPath: string): boolean {
    const configNoExt = configAbsPath.replace(/\.(?:ts|js|mts|mjs)$/, '');
    const re = /(?:from\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const resolved = path.resolve(path.dirname(fromFile), m[1]).replace(/\.(?:ts|js|mts|mjs)$/, '');
        if (resolved === configNoExt) return true;
    }
    return false;
}

function resolvedValueOf(env: RepoEnvMap, key: string | undefined): { value: string; sourceFile: string; confidence: 'high' | 'medium' | 'low' } | null {
    if (!key) return null;
    const entry = env.vars.get(key);
    if (!entry || !entry.value.trim() || TEMPLATE_RE.test(entry.value)) return null;
    return { value: entry.value.trim(), sourceFile: entry.sourceFile, confidence: entry.confidence };
}

/**
 * Emit s2 candidates for one service dir. Pure filesystem + env-map logic; the
 * caller persists hints via `mergeBrokerCandidate` and feeds `claimedEnvKeys`
 * into the s0 lane so the same keys never double-emit.
 */
export function synthesizeDeclaredSinkBrokerCandidates(
    serviceDir: string,
    env: RepoEnvMap,
    brokerClients: ReadonlyArray<DeclaredBrokerClient>,
): DeclaredSinkSynthesisResult {
    const result: DeclaredSinkSynthesisResult = { hints: [], claimedEnvKeys: new Set() };
    if (brokerClients.length === 0) return result;

    const sources: Array<{ file: string; content: string }> = [];
    for (const file of walkSourceFiles(serviceDir)) {
        const content = readBounded(file);
        if (content !== null) sources.push({ file, content });
    }

    const configShapes = sources
        .map(({ file, content }) => classifyBrokerConfigShape(file, content))
        .filter((shape): shape is BrokerConfigShape => shape !== null);

    for (const shape of configShapes) {
        const client = brokerClients.find(bc => sources.some(({ file, content }) =>
            file !== shape.file
            && importsSpecifier(content, bc.name)
            && importsConfigModule(content, file, shape.file)));
        if (!client) continue; // no co-import: the config is not provably the sink's

        // Keys consumed by this lane are claimed even when values are
        // unresolved — the SHAPE association is established either way.
        result.claimedEnvKeys.add(shape.hostKey);
        if (shape.vhostKey) result.claimedEnvKeys.add(shape.vhostKey);
        if (shape.portKey) result.claimedEnvKeys.add(shape.portKey);

        const host = resolvedValueOf(env, shape.hostKey);
        if (!host) continue;
        const vhost = resolvedValueOf(env, shape.vhostKey);
        const portRaw = resolvedValueOf(env, shape.portKey);
        const port = portRaw ? parseInt(portRaw.value, 10) || undefined : undefined;

        result.hints.push({
            source: 's2-declared-sink',
            provider: client.provider,
            providerSource: 'declared',
            host: host.value,
            port,
            vhost: vhost?.value,
            sourceEnvKey: shape.hostKey,
            sourceFile: host.sourceFile,
            confidence: host.confidence,
        });
    }

    return result;
}
