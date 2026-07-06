import path from 'node:path';
import fs from 'node:fs';
import { mergeAPIDeployment, type APIDeploymentEnvironment, type APIDeploymentVisibility, type APIDeploymentSource } from '../../graph/mutations/api-deployment.js';
import { astGrounding } from '../../graph/grounding.js';
import { logger } from '../../utils/logger.js';
import { canonicalizeBaseUrl } from '../../utils/url-normalizer.js';
import { isUnbindableHost } from './physical-fingerprint.js';
import { runGenericQuery } from '../../graph/mutations/search.js';
import type { ResolvedRepo } from '../../graph/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// API Deployment Resolver
//
// Multi-source collector for `:APIDeployment` surfaces. Each `:APIInterface`
// can have N `:APIDeployment` (public ingress, internal mesh, admin panel ...).
// OAS `servers[]` is already covered by `openapi-extractor.ts`; this resolver
// fills the gap for declarative infra that customers ship in their repo:
//
//   - Helm / k8s `Ingress` manifests (`helm/templates/ingress.yaml`, etc.)
//   - `coderadius.yaml.deployments[]` (manual customer hint)
//
// The collector is intentionally narrow: each hint comes from a deterministic
// AST/YAML walk over files that ALREADY live in the repo. Snapshots fetched
// live from infra (RabbitMQ definitions.json, Kafka --describe, ...) belong
// to the deferred `cr analyze infra` command and are NOT in scope here.
// ═══════════════════════════════════════════════════════════════════════════════

const EXTRACTOR_VERSION = 'api-deployment-resolver@v1';

export interface APIDeploymentHint {
    /** baseUrl as ingested (verbatim). Canonicalised by mergeAPIDeployment. */
    baseUrl: string;
    /** Best-effort environment classification. */
    environment?: APIDeploymentEnvironment;
    /** Public vs internal vs admin. */
    visibility?: APIDeploymentVisibility;
    /** Source family — which collector produced this hint. */
    declaredBy: APIDeploymentSource;
    /** Confidence tier for the producer (drives subsequent grounding tier). */
    confidence: 'exact' | 'high' | 'medium' | 'low';
    /** Optional cluster identifier (helm release / k8s namespace). */
    cluster?: string;
    /** Repo-relative path of the file the hint came from. For logging. */
    sourceFile?: string;
}

export interface ResolveAPIDeploymentsResult {
    deploymentsCreated: number;
    errors: string[];
}

/**
 * Run the resolver over the given repos. For each repo we:
 *   - find candidate hint files in the repo
 *   - extract `APIDeploymentHint[]`
 *   - resolve which `:APIInterface` the hint belongs to (by service ownership)
 *   - call `mergeAPIDeployment` so the global resolver can L0a/L0b weld
 *     emergent caller endpoints to canonical endpoints under that interface.
 */
export async function ingestAPIDeploymentHints(
    repos: ResolvedRepo[],
    serviceRoots: Array<{ name: string; path: string }>,
    commitHash: string,
    task?: { report: (msg: string) => void },
): Promise<ResolveAPIDeploymentsResult> {
    const result: ResolveAPIDeploymentsResult = { deploymentsCreated: 0, errors: [] };

    for (const repo of repos) {
        try {
            const hints = collectAPIDeploymentHints(repo.path);
            if (hints.length === 0) continue;

            if (task) task.report(`[api-deployment-resolver] ${repo.name}: ${hints.length} hint(s)`);

            for (const { hint, ownerPath } of hints) {
                // Resolve the APIInterface this deployment belongs to.
                // Strategy: prefer the APIInterface owned by the service whose
                // directory contains the hint's source file (innermost service
                // root wins). Fall back to repo-wide if no service match.
                const targetServiceName = resolveServiceOwner(ownerPath, serviceRoots);
                const apiUrns = await runGenericQuery(
                    `MATCH (s:Service {name: $svc})-[:EXPOSES_API]->(api:APIInterface)
                     WHERE api.valid_to_commit IS NULL AND coalesce(api.apiKind, 'http') <> 'graphql'
                     RETURN api.id AS id ORDER BY api.id LIMIT 5`,
                    { svc: targetServiceName ?? repo.name },
                );

                if (!Array.isArray(apiUrns) || apiUrns.length === 0) {
                    logger.debug(`[api-deployment-resolver] no APIInterface for hint ${hint.baseUrl} (service=${targetServiceName ?? repo.name}) — skipping`);
                    continue;
                }

                for (const row of apiUrns as Array<{ id: string }>) {
                    try {
                        await mergeAPIDeployment({
                            apiUrn: row.id,
                            baseUrl: hint.baseUrl,
                            environment: hint.environment,
                            visibility: hint.visibility,
                            declaredBy: hint.declaredBy,
                            confidence: hint.confidence,
                            cluster: hint.cluster,
                            grounding: astGrounding(EXTRACTOR_VERSION),
                        }, commitHash);
                        result.deploymentsCreated++;
                    } catch (err) {
                        result.errors.push(`[api-deployment-resolver] merge failed for ${hint.baseUrl}: ${(err as Error).message}`);
                    }
                }
            }
        } catch (err) {
            const msg = `[api-deployment-resolver] ${repo.name}: ${(err as Error).message}`;
            logger.error(msg);
            result.errors.push(msg);
        }
    }

    return result;
}

// ─── Hint Collection ─────────────────────────────────────────────────────────

interface HintWithOwner {
    hint: APIDeploymentHint;
    /** Absolute path of the file the hint came from. */
    ownerPath: string;
}

export function collectAPIDeploymentHints(repoPath: string): HintWithOwner[] {
    const hints: HintWithOwner[] = [];
    walkRepo(repoPath, (abs, rel) => {
        const basename = path.basename(rel);
        if (isIngressYamlPath(rel, basename)) {
            try {
                const content = fs.readFileSync(abs, 'utf-8');
                for (const h of parseIngressYaml(content, rel)) {
                    hints.push({ hint: h, ownerPath: abs });
                }
            } catch (err) {
                logger.debug(`[api-deployment-resolver] ingress parse failed for ${rel}: ${(err as Error).message}`);
            }
        }
    });
    return hints;
}

// File detection — kept narrow (declarative). New formats add a new predicate,
// never a regex in the orchestrator above. `relPath` is a forward-slash path
// rooted at the repo (no leading slash), so we anchor with `(^|/)` rather than
// requiring a leading `/`.
function isIngressYamlPath(relPath: string, basename: string): boolean {
    if (!/\.ya?ml$/i.test(basename)) return false;
    const lower = relPath.replace(/\\/g, '/').toLowerCase();
    const lowerBase = basename.toLowerCase();
    if (lowerBase.startsWith('ingress')) return true;
    return (
        /(^|\/)helm\/templates(\/|$)/.test(lower) ||
        /(^|\/)k8s(\/|$)/.test(lower) ||
        /(^|\/)kubernetes(\/|$)/.test(lower)
    );
}

// ─── Ingress YAML parser (k8s networking.k8s.io/v1) ──────────────────────────
//
// Recognises minimal Ingress shape:
//   apiVersion: networking.k8s.io/v1
//   kind: Ingress
//   metadata:
//     name: orders-api
//     annotations:
//       kubernetes.io/ingress.class: nginx
//   spec:
//     tls: [{ hosts: [api.acme.com] }]
//     rules:
//       - host: api.acme.com
//         http:
//           paths:
//             - path: /v2
//
// We do NOT use a full YAML parser to keep the dependency footprint zero;
// instead, we run a regex-driven walk that pulls `host:` and TLS context.
// This is deliberately conservative — anything we cannot recognise is left
// for the customer to declare via `coderadius.yaml.deployments[]`.

const KIND_INGRESS = /^\s*kind:\s*Ingress\s*$/m;
const HOST_LINE = /^\s+-?\s*host:\s*([^\s#]+)/gm;
const TLS_HEADER = /^\s*tls:\s*$/m;

export function parseIngressYaml(content: string, sourceFile: string): APIDeploymentHint[] {
    if (!KIND_INGRESS.test(content)) return [];
    const hasTls = TLS_HEADER.test(content);
    const scheme = hasTls ? 'https' : 'http';
    const env = inferEnvironmentFromPath(sourceFile);

    const out: APIDeploymentHint[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    HOST_LINE.lastIndex = 0;
    while ((m = HOST_LINE.exec(content)) !== null) {
        const host = m[1].replace(/['"]/g, '').trim();
        // Drop unresolved/templated hosts via the shared predicate so a Go-template
        // (`{{ .Values.host }}`), env placeholder (`${X}`/`%env`), or sentinel never
        // becomes a phantom deployment like `http://{{`. Wildcards are host-shaped
        // but not addressable, so they are excluded separately.
        if (!host || host === '*' || isUnbindableHost(host)) continue;
        const baseUrl = `${scheme}://${host}`;
        const canonical = canonicalizeBaseUrl(baseUrl);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        out.push({
            baseUrl,
            environment: env,
            visibility: classifyVisibility(host),
            declaredBy: /(^|\/)helm(\/|$)/i.test(sourceFile) ? 'helm-ingress' : 'k8s-ingress',
            confidence: 'high',
            sourceFile,
        });
    }
    return out;
}

function classifyVisibility(host: string): APIDeploymentVisibility {
    const h = host.toLowerCase();
    if (h.includes('admin.') || h.startsWith('admin-')) return 'admin';
    if (h.endsWith('.svc.cluster.local') || h.endsWith('.svc')) return 'internal';
    if (h.includes('partner.')) return 'partner';
    return 'public';
}

/**
 * Best-effort `:APIDeployment` environment from the source file path.
 *
 * Shared by the Ingress YAML parser and the env-var API synthesis
 * (service-host-to-dependency-resolver). Deliberately conservative: only
 * unambiguous tokens classify, everything else stays `unknown` (e.g. plain
 * `.env` or `.env.prod` — the latter is not matched on purpose to avoid the
 * `product`/`prod` substring false positive on arbitrary hosts).
 */
export function inferEnvironmentFromPath(sourceFile: string): APIDeploymentEnvironment {
    const p = sourceFile.toLowerCase();
    if (p.includes('production') || p.includes('values-prod')) return 'production';
    if (p.includes('staging') || p.includes('values-staging')) return 'staging';
    if (p.includes('dev') || p.includes('values-dev')) return 'dev';
    if (p.includes('local')) return 'local';
    return 'unknown';
}

// ─── Service ownership resolution ────────────────────────────────────────────

function resolveServiceOwner(
    absPath: string,
    serviceRoots: Array<{ name: string; path: string }>,
): string | undefined {
    let best: string | undefined;
    let bestLen = 0;
    for (const svc of serviceRoots) {
        const prefix = svc.path.endsWith(path.sep) ? svc.path : svc.path + path.sep;
        if (absPath.startsWith(prefix) && prefix.length > bestLen) {
            best = svc.name;
            bestLen = prefix.length;
        }
    }
    return best;
}

// ─── Cheap repo walker (respects node_modules / .git) ────────────────────────

function walkRepo(root: string, visit: (abs: string, rel: string) => void): void {
    const skip = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.nuxt', '.idea', 'coverage']);

    function recurse(dir: string) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            if (skip.has(ent.name)) continue;
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                recurse(abs);
            } else if (ent.isFile()) {
                visit(abs, path.relative(root, abs));
            }
        }
    }

    recurse(root);
}
