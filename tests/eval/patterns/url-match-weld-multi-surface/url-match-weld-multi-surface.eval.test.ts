/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — url-match-weld-multi-surface
 *
 * Pins Fix #5: a provider exposes the same API on THREE surfaces (public
 * ingress, internal mesh, admin subdomain). A caller in a separate workspace
 * resolves its base URL from `.env.production` (the public surface) and POSTs
 * /orders to it.
 *
 * The pipeline parts under test here are deterministic (no LLM, no graph DB):
 *
 *   1. `parseIngressYaml` extracts one APIDeploymentHint per ingress file,
 *      with the right `(scheme, host, environment, visibility, declaredBy)`.
 *   2. `canonicalizeBaseUrl` produces the same canonical form for the
 *      caller-observed URL and the provider-declared URL, so the L0a query
 *      `MATCH (d:APIDeployment {canonicalUrl})` is symmetric.
 *   3. `joinBaseUrlAndPath` collapses `caller.observedBaseUrl + emergent.path`
 *      to the same fully-qualified URL as `provider.canonicalUrl +
 *      canonical.path` — this is the exact comparison the welder makes.
 *   4. `resolveCallerBaseUrl` reads the caller's `.env.production` and emits
 *      `(canonicalUrl, environment='production')`.
 *
 * Zero LLM, zero graph DB. Deterministic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseIngressYaml,
    collectAPIDeploymentHints,
} from '../../../../src/ingestion/processors/api-deployment-resolver.js';
import {
    canonicalizeBaseUrl,
    joinBaseUrlAndPath,
} from '../../../../src/utils/url-normalizer.js';
import { resolveCallerBaseUrl } from '../../../../src/ingestion/processors/caller-base-url-resolver.js';
import { buildRepoEnvMap } from '../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — url-match-weld-multi-surface', () => {
    let stagedProvider: string;
    let stagedCaller: string;

    beforeAll(() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-url-weld-eval-'));
        stagedProvider = path.join(tmp, 'orders-api');
        stagedCaller = path.join(tmp, 'orders-client');
        fs.cpSync(path.join(FIXTURE_DIR, 'provider'), stagedProvider, { recursive: true });
        fs.cpSync(path.join(FIXTURE_DIR, 'caller'), stagedCaller, { recursive: true });
    });

    afterAll(() => {
        if (stagedProvider) {
            const tmp = path.dirname(stagedProvider);
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('parseIngressYaml picks up public, admin, and internal surfaces with correct visibility tags', () => {
        const publicYaml = fs.readFileSync(path.join(stagedProvider, 'helm/templates/ingress-public.yaml'), 'utf-8');
        const adminYaml = fs.readFileSync(path.join(stagedProvider, 'helm/templates/ingress-admin.yaml'), 'utf-8');
        const internalYaml = fs.readFileSync(path.join(stagedProvider, 'k8s/internal-ingress.yaml'), 'utf-8');

        const pub = parseIngressYaml(publicYaml, 'helm/templates/ingress-public.yaml');
        const adm = parseIngressYaml(adminYaml, 'helm/templates/ingress-admin.yaml');
        const intl = parseIngressYaml(internalYaml, 'k8s/internal-ingress.yaml');

        expect(pub).toHaveLength(1);
        expect(pub[0]).toMatchObject({
            baseUrl: 'https://api.acme.example.com',
            visibility: 'public',
            declaredBy: 'helm-ingress',
        });

        expect(adm).toHaveLength(1);
        expect(adm[0].visibility).toBe('admin');
        expect(adm[0].baseUrl).toBe('https://admin.acme.example.com');

        expect(intl).toHaveLength(1);
        expect(intl[0].visibility).toBe('internal');
        expect(intl[0].baseUrl).toBe('http://orders-api.svc.cluster.local');
        expect(intl[0].declaredBy).toBe('k8s-ingress');
    });

    it('collectAPIDeploymentHints walks the provider repo and returns all 3 surfaces', () => {
        const hits = collectAPIDeploymentHints(stagedProvider);
        const urls = hits.map(h => h.hint.baseUrl).sort();
        expect(urls).toEqual([
            'http://orders-api.svc.cluster.local',
            'https://admin.acme.example.com',
            'https://api.acme.example.com',
        ]);
    });

    it('canonicalizeBaseUrl produces a single deterministic form on both caller and provider sides', () => {
        // Provider declares the URL in helm with explicit https and no trailing slash.
        // Caller declares the same URL in .env.production with a basePath suffix.
        const providerCanonical = canonicalizeBaseUrl('https://api.acme.example.com');
        const callerCanonical = canonicalizeBaseUrl('https://api.acme.example.com/v2');
        // Same host → matches at L0b (host); basePath separates them for L0a.
        expect(providerCanonical).toBe('https://api.acme.example.com');
        expect(callerCanonical).toBe('https://api.acme.example.com/v2');
    });

    it('joinBaseUrlAndPath is symmetric across caller-observed and provider-declared compositions', () => {
        const callerObserved = 'https://api.acme.example.com/v2';
        const emergentRelativePath = '/orders';

        // Provider OAS declares server `https://api.acme.example.com/v2` and
        // endpoint `/orders`. The welder composes both sides:
        const callerFull = joinBaseUrlAndPath(callerObserved, emergentRelativePath);
        const providerFull = joinBaseUrlAndPath('https://api.acme.example.com/v2', '/orders');
        expect(callerFull.toLowerCase()).toBe(providerFull.toLowerCase());
        expect(callerFull).toBe('https://api.acme.example.com/v2/orders');

        // Edge case: the path already includes the basePath verbatim (no double join).
        const idempotent = joinBaseUrlAndPath('https://api.acme.example.com/v2', '/v2/orders');
        expect(idempotent).toBe('https://api.acme.example.com/v2/orders');
    });

    it('resolveCallerBaseUrl reads .env.production and emits production environment', () => {
        const envMap = buildRepoEnvMap(stagedCaller);
        const sourceCode = fs.readFileSync(path.join(stagedCaller, 'src/orders-client.ts'), 'utf-8');
        const result = resolveCallerBaseUrl(sourceCode, envMap);
        expect(result).not.toBeNull();
        expect(result!.canonicalUrl).toBe('https://api.acme.example.com/v2');
        expect(result!.environment).toBe('production');
    });

    it('weld symmetry: composed caller URL matches composed provider URL byte-for-byte', () => {
        // This is the exact comparison `findUniqueUrlMatch` performs in global-resolver.ts:
        //   joinBaseUrlAndPath(observedBaseUrl, emergent.path) ===
        //   joinBaseUrlAndPath(deployment.canonicalUrl, canonical.path)
        //
        // For multi-surface providers, a caller observing the public URL must
        // ONLY match the public deployment, not the internal/admin ones.
        const publicCanonical = canonicalizeBaseUrl('https://api.acme.example.com/v2');
        const internalCanonical = canonicalizeBaseUrl('http://orders-api.svc.cluster.local');
        const adminCanonical = canonicalizeBaseUrl('https://admin.acme.example.com');

        const callerObserved = 'https://api.acme.example.com/v2';
        const path = '/orders';

        const callerComposed = joinBaseUrlAndPath(callerObserved, path).toLowerCase();
        expect(joinBaseUrlAndPath(publicCanonical, path).toLowerCase()).toBe(callerComposed);
        expect(joinBaseUrlAndPath(internalCanonical, path).toLowerCase()).not.toBe(callerComposed);
        expect(joinBaseUrlAndPath(adminCanonical, path).toLowerCase()).not.toBe(callerComposed);
    });
});
