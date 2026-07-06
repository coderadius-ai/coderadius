// ═══════════════════════════════════════════════════════════════════════════════
// SymfonyServicesYamlProvider — Symfony container declarations in YAML
//
// Parses the four canonical Symfony binding shapes:
//
//   1. Explicit service:  `app.notification.publisher:
//                            class: App\Messaging\NotificationPublisher`
//   2. Alias:             `App\Messaging\NotificationPublisher: '@app.notification.publisher'`
//   3. Resource:          `App\:
//                            resource: '../src/'
//                            exclude: '../src/Tests'`
//   4. Defaults:          `_defaults: { autowire: true, autoconfigure: true }`
//
// Out of scope (resolver falls through to LLM):
//   - factory: ['@svc', 'create']        (factory pattern, dynamic)
//   - class: '%env(CLASS_NAME)%'         (env-derived class)
//   - synthetic: true                    (runtime-populated services)
//   - arguments with expression-language (runtime-bound)
// ═══════════════════════════════════════════════════════════════════════════════

import yaml from 'js-yaml';
import path from 'node:path';
import type {
    DiBindingProvider,
    DiBindingProviderContext,
    RawDiBinding,
} from './types.js';

type YamlRecord = Record<string, unknown>;

// Symfony's YAML configurator ships custom tags that js-yaml rejects by
// default. A single `!tagged_iterator` somewhere in services.yaml would
// otherwise blow the entire parse and lose every safe binding. Treat all
// known Symfony tags as opaque null values — we don't need their semantics
// for DI binding extraction, just for parse survival.
const SYMFONY_TAG_NAMES = [
    'tagged_iterator', 'tagged', 'tagged_locator',
    'service', 'service_closure', 'service_locator',
    'iterator', 'closure', 'returns_clone',
    'abstract', 'inline_service',
    'env',
];

function makeKindlessType(name: string): yaml.Type {
    return new yaml.Type(`!${name}`, {
        kind: 'scalar',
        resolve: () => true,
        construct: () => null,
        instanceOf: Object,
        represent: () => null,
    });
}

// Build schema variants for each YAML kind (scalar/sequence/mapping) — a
// tag may appear in any shape in real-world services.yaml.
const SYMFONY_TAG_TYPES = SYMFONY_TAG_NAMES.flatMap(name => [
    new yaml.Type(`!${name}`, { kind: 'scalar', resolve: () => true, construct: () => null }),
    new yaml.Type(`!${name}`, { kind: 'sequence', resolve: () => true, construct: () => [] }),
    new yaml.Type(`!${name}`, { kind: 'mapping', resolve: () => true, construct: () => ({}) }),
]);

const SYMFONY_SCHEMA = yaml.DEFAULT_SCHEMA.extend(SYMFONY_TAG_TYPES);

// Silence the unused warning when js-yaml type registration changes.
void makeKindlessType;

const MAX_BINDINGS_PER_FILE = 500;

export class SymfonyServicesYamlProvider implements DiBindingProvider {
    readonly id = 'symfony-services-yaml';

    // Content gate: must reference a `services:` block at column 0 (top-level).
    // We deliberately do NOT match other Symfony YAML blocks (framework:,
    // monolog:, doctrine:, twig:) — only files that declare services qualify.
    readonly contentSignatures = [/^services\s*:/m];

    matchFile(relativePath: string, basename: string): boolean {
        const lower = basename.toLowerCase();
        if (!/\.(ya?ml)$/i.test(lower)) return false;
        // Conventional locations:
        //   config/services.yaml, config/services_*.yaml
        //   config/packages/*.yaml (modern Symfony Flex bundles)
        const rel = relativePath.toLowerCase();
        if (/^(.*\/)?config\/services(_[\w-]+)?\.ya?ml$/.test(rel)) return true;
        if (/^(.*\/)?config\/packages\/[^/]+\.ya?ml$/.test(rel)) return true;
        // Loose: any `services.yaml` outside config/ is rare but possible
        if (/^services(_[\w-]+)?\.ya?ml$/.test(lower)) return true;
        return false;
    }

    extractDiBindings(content: string, ctx: DiBindingProviderContext): RawDiBinding[] {
        let docs: YamlRecord[];
        try {
            docs = yaml.loadAll(content, undefined, { schema: SYMFONY_SCHEMA })
                .filter(isRecord) as YamlRecord[];
        } catch {
            return [];
        }

        const out: RawDiBinding[] = [];
        const sourceHash = stableHash(content);

        for (const doc of docs) {
            const services = getRecord(doc.services);
            if (!services) continue;

            // _defaults applies to all subsequent entries in this `services:` block
            const defaults = getRecord(services._defaults) ?? {};
            const defaultAutowire = readBool(defaults.autowire, false);

            for (const [key, raw] of Object.entries(services)) {
                if (key === '_defaults' || key === '_instanceof') continue;
                if (out.length >= MAX_BINDINGS_PER_FILE) break;

                const binding = parseEntry(key, raw, defaultAutowire, ctx, sourceHash);
                if (binding) out.push(binding);
            }
        }

        return out;
    }
}

function parseEntry(
    key: string,
    raw: unknown,
    defaultAutowire: boolean,
    ctx: DiBindingProviderContext,
    sourceHash: string,
): RawDiBinding | null {
    // Shape 1: alias to another service — value is a string like '@other.svc'
    if (typeof raw === 'string') {
        const aliasTarget = parseAlias(raw);
        if (aliasTarget) {
            return {
                key,
                aliasTarget,
                autowireEnabled: defaultAutowire,
                sourceFile: ctx.relativePath,
                sourceHash,
            };
        }
        // Some configs use the shorthand `App\Service\Foo: ~` (null) for
        // auto-wired self-bindings. We ignore the literal value here.
        return null;
    }

    // Shape 2: structured entry — { class?, factory?, arguments?, synthetic?, ... }
    if (!isRecord(raw)) {
        // `App\Service\Foo: ~` (null shorthand). Treat as self-binding when
        // the key looks like an FQCN.
        if (looksLikeFqcn(key)) {
            return {
                key: normalizeFqcn(key),
                boundComponent: normalizeFqcn(key),
                autowireEnabled: defaultAutowire,
                sourceFile: ctx.relativePath,
                sourceHash,
            };
        }
        return null;
    }

    const entry = raw as YamlRecord;

    // Out-of-scope shapes: skip (resolver falls back to LLM for these serviceIds)
    if (entry.factory !== undefined) return null;
    if (entry.synthetic === true) return null;

    // Shape 3: namespace resource declaration —
    //   `App\:
    //      resource: '../src/'`
    if (looksLikeNamespacePrefix(key) && entry.resource !== undefined) {
        const excludeRaw = entry.exclude;
        const exclude = Array.isArray(excludeRaw)
            ? excludeRaw.filter((x): x is string => typeof x === 'string')
            : typeof excludeRaw === 'string' ? [excludeRaw] : undefined;
        const resourcePath = typeof entry.resource === 'string'
            ? resolveResourcePath(entry.resource, ctx.relativePath)
            : undefined;
        return {
            key: normalizeNamespacePrefix(key),
            resourcePrefix: normalizeNamespacePrefix(key),
            resourcePath,
            autowireEnabled: readBool(entry.autowire, defaultAutowire),
            exclude,
            sourceFile: ctx.relativePath,
            sourceHash,
        };
    }

    const classValue = typeof entry.class === 'string' ? entry.class.trim() : undefined;
    if (classValue && containsTemplate(classValue)) {
        // class derived from env or expression — out of scope
        return null;
    }

    // Inferred class: when no explicit `class:` is given but the key is an FQCN,
    // Symfony's autoconfigure binds `key → key` (self-binding).
    const boundComponent = classValue
        ? normalizeFqcn(classValue)
        : (looksLikeFqcn(key) ? normalizeFqcn(key) : undefined);

    if (!boundComponent) return null;

    return {
        key: looksLikeFqcn(key) ? normalizeFqcn(key) : key,
        boundComponent,
        autowireEnabled: readBool(entry.autowire, defaultAutowire),
        sourceFile: ctx.relativePath,
        sourceHash,
    };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is YamlRecord {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getRecord(v: unknown): YamlRecord | null {
    return isRecord(v) ? v : null;
}

function readBool(v: unknown, fallback: boolean): boolean {
    if (typeof v === 'boolean') return v;
    return fallback;
}

function parseAlias(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('@')) return null;
    return trimmed.slice(1);
}

function looksLikeNamespacePrefix(key: string): boolean {
    // Symfony resource syntax: namespace keys end with `\` and start uppercase.
    return /^[A-Z][A-Za-z0-9_]*(\\[A-Z][A-Za-z0-9_]*)*\\$/.test(key);
}

function normalizeNamespacePrefix(key: string): string {
    // Keep the trailing backslash for unambiguous prefix matching.
    return key.trim();
}

function looksLikeFqcn(key: string): boolean {
    // FQCN: starts uppercase, contains at least one backslash.
    return /^[A-Z][A-Za-z0-9_]*(\\[A-Z][A-Za-z0-9_]*)+$/.test(key);
}

function normalizeFqcn(name: string): string {
    return name.trim().replace(/^\\+/, '');
}

function containsTemplate(value: string): boolean {
    return /%env\(|%[a-z_][\w.]*%/i.test(value);
}

/**
 * Resolve a Symfony `resource:` path (relative to the YAML file's location)
 * to a repo-relative directory prefix. Strips trailing slashes and glob
 * suffixes. Examples (yaml file at `config/services.yaml`):
 *   '../src/'        → 'src/'
 *   '../src/*'       → 'src/'
 *   '../src/Domain'  → 'src/Domain'
 *   '/abs/path'      → undefined  (absolute paths skipped, not portable)
 */
function resolveResourcePath(resource: string, yamlFile: string): string | undefined {
    const trimmed = resource.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('/')) return undefined; // absolute path: skip
    const yamlDir = path.posix.dirname(yamlFile);
    let joined = path.posix.normalize(path.posix.join(yamlDir, trimmed));
    // Strip trailing glob and slashes
    joined = joined.replace(/\/?\*+$/, '').replace(/\/+$/, '');
    if (!joined || joined === '.' || joined.startsWith('..')) return undefined;
    return joined + '/';
}

// Cheap, deterministic, stable hash for cache fingerprints.
// Uses Bun's hash if available, falls back to FNV-1a otherwise.
function stableHash(input: string): string {
    if (typeof (globalThis as { Bun?: { hash: (s: string) => bigint } }).Bun?.hash === 'function') {
        return (globalThis as { Bun: { hash: (s: string) => bigint } }).Bun.hash(input).toString(16);
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

// path imported above; used by resolveResourcePath().
