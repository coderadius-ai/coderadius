/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-message-registry
 *
 * End-to-end behavior pinning for the Message Registry Pattern (Steps A + B + C
 * of the broker channel attribution rework).
 *
 * Three engine guarantees this test pins:
 *
 *   1. Generic provider extraction (Step A): a CQRS class -> topic-shaped string
 *      mapping in any PHP array, any method name, any inner key. Includes:
 *      - file-context gate that rejects RBAC/audit configs
 *      - bracketed-namespace FQCN extraction
 *      - per-class FQCN + short-name fact emission
 *
 *   2. Sanitizer stem normalization (Step B): MessageChannel names containing
 *      lowercase env placeholders ({envSuffix}, {env}, ...) are stripped to
 *      canonical stems instead of being dropped. Uppercase placeholders
 *      ({ENV}, {CLUSTER}) remain dropped.
 *
 *   3. Registry discovery for the class-name bridge (Step C feeder): the
 *      workflow's discoverMessageClassRegistry walks repo PHP files and
 *      yields the short-name -> canonical-routing-key map fed to the
 *      Memgraph weld step. (The weld step itself is covered end-to-end in
 *      tests/integration/message-channel-weld-by-class.test.ts.)
 *
 * Deterministic — no LLM calls, no graph access. Pure in-memory exercises
 * over a static anonymized fixture (Acme).
 *
 * Fixture: tests/eval/patterns/php-message-registry/fixture/
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { SymfonyMessengerPhpProvider } from '../../../../src/ingestion/core/config-value-providers/symfony-messenger-php.js';
import { discoverMessageClassRegistry } from '../../../../src/graph/mutations/message-channels.js';
import { normalizeEnvPlaceholder } from '../../../../src/ingestion/processors/dynamic-infra-resolver.js';
import { isUnresolvedTemplateName } from '../../../../src/ai/workflows/sanitizer.js';
import { extractPhpCriticalInvocations } from '../../../../src/ingestion/core/languages/php/value-resolution.js';
import { patchLanguage } from '../../../../src/ingestion/processors/parser/jsc-compat.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

interface FactSummary {
    relativePath: string;
    key: string;
    value: string;
}

interface FullFact extends FactSummary {
    grounding?: import('../../../../src/graph/grounding.js').GroundingFields;
}

describe('Pattern Eval — php-message-registry', () => {
    let allFacts: FactSummary[];
    let allFullFacts: FullFact[];
    const provider = new SymfonyMessengerPhpProvider();

    beforeAll(() => {
        const phpFiles: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.php')) phpFiles.push(full);
            }
        };
        walk(path.join(FIXTURE_DIR, 'src'));

        allFacts = [];
        allFullFacts = [];
        for (const absPath of phpFiles) {
            const relativePath = path.relative(FIXTURE_DIR, absPath);
            const content = fs.readFileSync(absPath, 'utf-8');
            const facts = provider.extractValueFacts(content, {
                relativePath,
                repoRoot: FIXTURE_DIR,
                repoName: 'acme',
            });
            for (const f of facts) {
                if (typeof f.value === 'string') {
                    allFacts.push({ relativePath, key: f.key, value: f.value });
                    allFullFacts.push({ relativePath, key: f.key, value: f.value, grounding: f.grounding });
                }
            }
        }
    });

    // ── Step A: generic extraction ──────────────────────────────────────────

    it('extracts CQRS routing facts from a method NOT named getMessageMap', () => {
        // AmqpConfig::buildRoutingTable — extractor must not depend on method name.
        const quote = allFacts.find(f => f.key === 'SymfonyMessenger.routing.QuoteMessage');
        expect(quote?.value).toBe('acme.inventory.quote.requested');
    });

    it('extracts from a queue_name-only entry (no routing_key key required)', () => {
        // QuoteMessage entry has only `queue_name`, not `routing_key`.
        // Old extractor required `routing_key`; generic extractor returns the
        // first topic-shaped string value, regardless of inner key name.
        const quote = allFacts.find(f => f.key === 'SymfonyMessenger.routing.QuoteMessage');
        expect(quote).toBeDefined();
        expect(quote!.value).toBe('acme.inventory.quote.requested');
    });

    it('normalizes routing keys with $envSuffix concatenation to canonical literal', () => {
        // ProductQuoteMessage routing key contains `. $envSuffix .` concat;
        // provider strips the {envSuffix} placeholder to canonical form.
        const product = allFacts.find(f => f.key === 'SymfonyMessenger.routing.ProductQuoteMessage');
        expect(product?.value).toBe('acme.inventory.quote.product.requested');
    });

    it('skips entries where inner value is a class reference (DI handler map)', () => {
        // NotificationDispatcher::class => ['handler' => NotificationHandler::class]
        // No topic-shaped string inside; extractor must not emit a fact.
        const noti = allFacts.find(f => f.key === 'SymfonyMessenger.routing.NotificationDispatcher');
        expect(noti).toBeUndefined();
    });

    it('emits FQCN-keyed fact for entries from a bracketed namespace (PHP 5.3+)', () => {
        // BracketedConfig is wrapped in `namespace Acme\Inventory\Messenger { ... }`.
        const fqcn = allFacts.find(f => f.key === 'SymfonyMessenger.routing.Acme\\Inventory\\Messenger\\ShipmentDispatchedEvent');
        expect(fqcn?.value).toBe('acme.inventory.shipment.dispatched');
        const short = allFacts.find(f => f.key === 'SymfonyMessenger.routing.ShipmentDispatchedEvent');
        expect(short?.value).toBe('acme.inventory.shipment.dispatched');
    });

    it('rejects RBAC/audit configs via the file-context gate', () => {
        // RbacConfig maps CQRS classes to permission strings, but no messaging
        // signal in the file context. Must produce ZERO facts.
        const fromRbac = allFacts.filter(f => f.relativePath.includes('Security/RbacConfig'));
        expect(fromRbac).toHaveLength(0);
    });

    // ── Step B: sanitizer stem normalization ────────────────────────────────

    it('Step B: env-suffix template name is normalizable (not just unresolved)', () => {
        const sample = 'acme.inventory{envSuffix}.quote.product.requested';
        expect(isUnresolvedTemplateName(sample)).toBe(true);
        expect(normalizeEnvPlaceholder(sample)).toBe('acme.inventory.quote.product.requested');
    });

    it('Step B: uppercase placeholders are NOT auto-normalized (stay DROPPED in sanitizer)', () => {
        const sample = 'queue.{CLUSTER}.events';
        expect(isUnresolvedTemplateName(sample)).toBe(true);
        // normalizeEnvPlaceholder only handles the known lowercase env set.
        expect(normalizeEnvPlaceholder(sample)).toBeNull();
    });

    // ── Step C: registry discovery feeder ───────────────────────────────────

    it('Step C: discoverMessageClassRegistry yields short-name -> canonical map', () => {
        const registry = discoverMessageClassRegistry([FIXTURE_DIR]);
        // QuoteMessage (queue_name path), ProductQuoteMessage (envSuffix-normalized),
        // ShipmentDispatchedEvent (bracketed namespace). NotificationDispatcher
        // and the RBAC entries must be absent.
        expect(registry.get('QuoteMessage')).toBe('acme.inventory.quote.requested');
        expect(registry.get('ProductQuoteMessage')).toBe('acme.inventory.quote.product.requested');
        expect(registry.get('ShipmentDispatchedEvent')).toBe('acme.inventory.shipment.dispatched');
        expect(registry.has('NotificationDispatcher')).toBe(false);
        expect(registry.has('CreateOrderCommand')).toBe(false);
        expect(registry.has('DeleteUserCommand')).toBe(false);
    });

    // ── Fix 1: handler-param messageClass criticalInvocation ────────────────

    function parseHandler(relPath: string): { src: string; root: Parser.SyntaxNode } {
        const parser = new Parser();
        parser.setLanguage(patchLanguage(phpExport.php));
        const abs = path.join(FIXTURE_DIR, relPath);
        const src = fs.readFileSync(abs, 'utf-8');
        return { src, root: parser.parse(src).rootNode };
    }

    it('Fix 1: legacy __invoke(QuoteMessage) emits messageClass READS criticalInvocation', () => {
        const { src, root } = parseHandler('src/Inventory/Handler/QuoteHandler.php');
        const facts = extractPhpCriticalInvocations(root, src, 'src/Inventory/Handler/QuoteHandler.php');
        const handler = facts.find(f => f.resourceRole === 'messageClass' && f.operation === 'READS');
        expect(handler).toBeDefined();
        expect(handler!.resourceExpression).toBe('QuoteMessage');
    });

    it('Fix 1: modern #[AsMessageHandler] emits messageClass READS regardless of method name', () => {
        const { src, root } = parseHandler('src/Inventory/Handler/ShipmentDispatchedHandler.php');
        const facts = extractPhpCriticalInvocations(root, src, 'src/Inventory/Handler/ShipmentDispatchedHandler.php');
        const handler = facts.find(f => f.resourceRole === 'messageClass' && f.operation === 'READS');
        expect(handler).toBeDefined();
        expect(handler!.resourceExpression).toBe('ShipmentDispatchedEvent');
    });

    it('Fix 1: __invoke(DailyDigest) does NOT emit (non-CQRS param, no attribute)', () => {
        const { src, root } = parseHandler('src/Inventory/Service/Utility.php');
        const facts = extractPhpCriticalInvocations(root, src, 'src/Inventory/Service/Utility.php');
        const handler = facts.find(f => f.resourceRole === 'messageClass' && f.operation === 'READS');
        expect(handler).toBeUndefined();
    });

    // ── Grounding pinning: every emitted fact carries trust metadata ───────
    //
    // The grounding refactor moves trust scoring from a single confidence
    // float to a categorical (source, quality, evidence) triple. Every fact
    // emitted by a provider MUST stamp its identity so downstream filters
    // (cr review pending, dashboard quality dot) can attribute the value.
    // Anchor expectations on the fixture above so a regression in the
    // provider does not silently lose the grounding trace.

    it('Grounding: every fact carries source=ast; quality is exact for literal facts, high after env-stem normalization (fallback demotes one tier)', () => {
        for (const f of allFullFacts) {
            expect(f.grounding, `fact ${f.key} missing grounding`).toBeDefined();
            expect(f.grounding!.source).toBe('ast');
            const normalized = (f.grounding!.evidence.fallbacksApplied ?? []).includes('env-var-stem-normalize');
            expect(f.grounding!.quality, `fact ${f.key} quality mismatch (normalized=${normalized})`)
                .toBe(normalized ? 'high' : 'exact');
        }
    });

    it('Grounding: extractor identity is symfony-messenger-php@v1 on every fact', () => {
        for (const f of allFullFacts) {
            expect(
                f.grounding!.evidence.extractors,
                `fact ${f.key} missing extractor identity`,
            ).toContain('symfony-messenger-php@v1');
        }
    });

    it('Grounding: env-placeholder normalization flags fallbacksApplied', () => {
        // ProductQuoteMessage routing key was `acme.inventory{envSuffix}....`
        // and got stem-normalized to canonical form. The provider stamps the
        // env-var-stem-normalize fallback so the trace stays auditable.
        const normalized = allFullFacts.find(f => f.key === 'SymfonyMessenger.routing.ProductQuoteMessage');
        expect(normalized).toBeDefined();
        expect(normalized!.grounding!.evidence.fallbacksApplied)
            .toContain('env-var-stem-normalize');
    });

    it('Grounding: non-normalized facts do NOT carry the env-stem fallback', () => {
        // QuoteMessage routing key was already literal `acme.inventory.quote.requested`
        // (no placeholder), so the env-stem fallback must NOT be stamped.
        const literal = allFullFacts.find(f => f.key === 'SymfonyMessenger.routing.QuoteMessage');
        expect(literal).toBeDefined();
        // fallbacksApplied is optional; either absent or doesn't include the marker.
        expect(literal!.grounding!.evidence.fallbacksApplied ?? [])
            .not.toContain('env-var-stem-normalize');
    });
});
