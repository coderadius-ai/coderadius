// ═══════════════════════════════════════════════════════════════════════════════
// SymfonyServicesPhpProvider — Symfony Configurator API (config/services.php)
//
// Modern Symfony uses a closure-based Configurator API as the PHP alternative
// to services.yaml:
//
//   return function (ContainerConfigurator $container) {
//     $services = $container->services()
//       ->defaults()->autowire()->autoconfigure();
//
//     $services->load('App\\', '../src/*')->exclude(['../src/Tests']);
//     $services->set('acme.notification.publisher', NotificationPublisher::class);
//     $services->set(MailerInterface::class)->args([service('app.mailer')]);
//     $services->alias(PublisherInterface::class, 'acme.notification.publisher');
//   };
//
// We parse the four canonical shapes:
//   - ->set('id', Class::class)   → explicit binding
//   - ->set(Class::class)         → self-binding (FQCN as id)
//   - ->load('Prefix\\', '...')   → namespace resource
//   - ->alias(Iface::class, ...)  → alias chain
//
// Regex-based (not AST): the shapes are tightly conventional and regex
// avoids pulling tree-sitter into a pure config-parsing path. If real-world
// configs need deeper analysis we'll switch to AST.
//
// Out of scope (resolver falls back to LLM):
//   - ->factory(...) builders
//   - ->set('id')->class(\fn() => …) closures
//   - Custom container builders
// ═══════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import type {
    DiBindingProvider,
    DiBindingProviderContext,
    RawDiBinding,
} from './types.js';

const MAX_BINDINGS_PER_FILE = 500;

// ─── Patterns ───────────────────────────────────────────────────────────────

// Matches ->set('id', Class::class) and ->set("id", Class::class)
// Group 1: the service id literal; Group 2: the FQCN
const SET_WITH_CLASS = /->\s*set\s*\(\s*['"]([^'"\\]+)['"]\s*,\s*\\?([A-Za-z_][A-Za-z0-9_\\]*)\s*::\s*class\s*\)/g;

// Matches ->set(Class::class) — single-arg self-binding form
const SET_SELF = /->\s*set\s*\(\s*\\?([A-Z][A-Za-z0-9_\\]*)\s*::\s*class\s*\)/g;

// Matches ->alias('Iface', 'serviceId') OR ->alias(Iface::class, 'serviceId')
// Group 1: alias key; Group 2: target
const ALIAS = /->\s*alias\s*\(\s*(?:['"]([^'"\\]+)['"]|\\?([A-Z][A-Za-z0-9_\\]*)\s*::\s*class)\s*,\s*['"]([^'"\\]+)['"]\s*\)/g;

// Matches ->load('Prefix\\', '../path/*')
const LOAD = /->\s*load\s*\(\s*['"]([A-Z][A-Za-z0-9_\\]*\\\\?)['"]\s*,\s*['"]([^'"\\]+)['"]\s*\)/g;

// File-level: was ->defaults()->autowire() (or ->autoconfigure()) declared?
const DEFAULTS_AUTOWIRE = /->\s*defaults\s*\(\s*\)\s*(?:->\s*\w+\s*\([^)]*\)\s*)*->\s*autowire\b/;

// PHP namespace + use parsing (real Symfony configs import classes via
// `use` and reference them as `Foo::class` — without resolving these,
// lookups in the component graph miss every binding).
const NAMESPACE_DECL = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_\\]*)\s*;/m;
const USE_DECL = /^\s*use\s+\\?([A-Za-z_][A-Za-z0-9_\\]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;/gm;

interface PhpImportScope {
    namespace: string;
    aliases: Map<string, string>; // local name -> FQCN
}

function parseImportScope(content: string): PhpImportScope {
    const nsMatch = content.match(NAMESPACE_DECL);
    const namespace = nsMatch ? nsMatch[1].trim() : '';
    const aliases = new Map<string, string>();
    USE_DECL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = USE_DECL.exec(content)) !== null) {
        const full = m[1].replace(/^\\+/, '');
        const local = m[2] ?? full.slice(full.lastIndexOf('\\') + 1);
        if (local) aliases.set(local, full);
    }
    return { namespace, aliases };
}

function resolvePhpClassName(name: string, scope: PhpImportScope): string {
    const cleaned = name.replace(/^\\+/, '');
    // Already FQCN-like (has backslash and no leading single segment matching alias)
    if (cleaned.includes('\\')) {
        const head = cleaned.split('\\')[0];
        const aliasResolved = scope.aliases.get(head);
        if (aliasResolved) {
            return aliasResolved + cleaned.slice(head.length);
        }
        return cleaned;
    }
    // Bare name: prefer alias, fall back to current namespace
    if (scope.aliases.has(cleaned)) return scope.aliases.get(cleaned)!;
    return scope.namespace ? `${scope.namespace}\\${cleaned}` : cleaned;
}

// Out-of-scope shapes; presence on a line disqualifies just that line.
// We don't need fancy line tracking — we look for these IN ADDITION to a set()
// match. If the source contains `factory(` near a `set(` we err on the side
// of caution and skip via per-match position checks below.
const FACTORY_HINT = /->\s*factory\s*\(/;
const SYNTHETIC_HINT = /->\s*synthetic\s*\(\s*\)/;

export class SymfonyServicesPhpProvider implements DiBindingProvider {
    readonly id = 'symfony-services-php';

    // Three signals; need any one. The Configurator/ContainerConfigurator
    // hint is the strongest. ->set/->alias/->load on a $services-ish var
    // is the operational hint.
    readonly contentSignatures = [
        /ContainerConfigurator|ServicesConfigurator/,
        /\bServiceConfigurator\b/,
        /Symfony\\\\Component\\\\DependencyInjection/,
    ];

    matchFile(relativePath: string, basename: string): boolean {
        if (!/\.php$/i.test(basename)) return false;
        const rel = relativePath.toLowerCase();
        // Canonical locations
        if (/^(.*\/)?config\/services(_[\w-]+)?\.php$/.test(rel)) return true;
        if (/^(.*\/)?config\/packages\/[^/]+\.php$/.test(rel)) return true;
        // Loose: top-level services.php
        if (/^services(_[\w-]+)?\.php$/.test(rel)) return true;
        return false;
    }

    extractDiBindings(content: string, ctx: DiBindingProviderContext): RawDiBinding[] {
        // Hard guard: never emit any binding from a file that declares
        // factory(...) anywhere — too risky to attribute the `->set` to the
        // wrong shape. Resolver falls back to LLM for the whole file.
        // (Conservative; we can relax with position tracking later.)
        if (FACTORY_HINT.test(content) || SYNTHETIC_HINT.test(content)) {
            // Keep going only if we have evidence the factory/synthetic is on
            // a different chain than our set(). Cheap heuristic: if there is
            // ONLY one set() in the file, skip. Otherwise per-match resilience.
            // For POC we err on the side of skipping the file when factory()
            // appears, matching the YAML provider behavior.
            return [];
        }

        const out: RawDiBinding[] = [];
        const sourceHash = stableHash(content);
        const defaultAutowire = DEFAULTS_AUTOWIRE.test(content);
        const importScope = parseImportScope(content);

        SET_WITH_CLASS.lastIndex = 0;
        SET_SELF.lastIndex = 0;
        ALIAS.lastIndex = 0;
        LOAD.lastIndex = 0;

        // ── Explicit set('id', Class::class) ────────────────────────────
        let m: RegExpExecArray | null;
        while ((m = SET_WITH_CLASS.exec(content)) !== null) {
            if (out.length >= MAX_BINDINGS_PER_FILE) break;
            out.push({
                key: m[1],
                boundComponent: resolvePhpClassName(m[2], importScope),
                autowireEnabled: defaultAutowire,
                sourceFile: ctx.relativePath,
                sourceHash,
            });
        }

        // ── Self-binding set(Class::class) ──────────────────────────────
        const explicitKeys = new Set(out.map(b => b.key));
        while ((m = SET_SELF.exec(content)) !== null) {
            if (out.length >= MAX_BINDINGS_PER_FILE) break;
            const fqcn = resolvePhpClassName(m[1], importScope);
            if (explicitKeys.has(fqcn)) continue;
            // Heuristic: SET_WITH_CLASS already consumed `set('id', X::class)`.
            // Skip if the match position is the 2nd arg of a SET_WITH_CLASS.
            const prev = content.slice(Math.max(0, m.index - 8), m.index);
            if (/['"]\s*,\s*$/.test(prev)) continue;
            out.push({
                key: fqcn,
                boundComponent: fqcn,
                autowireEnabled: defaultAutowire,
                sourceFile: ctx.relativePath,
                sourceHash,
            });
        }

        // ── Aliases ──────────────────────────────────────────────────────
        while ((m = ALIAS.exec(content)) !== null) {
            if (out.length >= MAX_BINDINGS_PER_FILE) break;
            const key = m[1] ? m[1] : resolvePhpClassName(m[2], importScope);
            const aliasTarget = m[3];
            out.push({
                key,
                aliasTarget,
                autowireEnabled: defaultAutowire,
                sourceFile: ctx.relativePath,
                sourceHash,
            });
        }

        // ── Resource load('Prefix\\', '../src/*') ───────────────────────
        while ((m = LOAD.exec(content)) !== null) {
            if (out.length >= MAX_BINDINGS_PER_FILE) break;
            const prefix = m[1].endsWith('\\') ? m[1] : `${m[1]}\\`;
            const resourcePath = resolveResourcePathPhp(m[2], ctx.relativePath);
            out.push({
                key: prefix,
                resourcePrefix: prefix,
                resourcePath,
                autowireEnabled: true, // ->load() implies autowire in Symfony
                sourceFile: ctx.relativePath,
                sourceHash,
            });
        }

        return out;
    }
}

function normalizeFqcn(name: string): string {
    return name.trim().replace(/^\\+/, '');
}

function resolveResourcePathPhp(resource: string, phpFile: string): string | undefined {
    const trimmed = resource.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('/')) return undefined;
    const dir = path.posix.dirname(phpFile);
    let joined = path.posix.normalize(path.posix.join(dir, trimmed));
    joined = joined.replace(/\/?\*+$/, '').replace(/\/+$/, '');
    if (!joined || joined === '.' || joined.startsWith('..')) return undefined;
    return joined + '/';
}

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
