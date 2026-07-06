/**
 * Unit test — `isTemplatedPayloadName` MUST drop any name containing curly
 * braces, INDEPENDENTLY of the case-sensitivity whitelist used by
 * `isUnresolvedTemplateName`.
 *
 * Bug Y v2 (orchestrator re-ingest 2026-05-16):
 *   - `persistSchemas` (structural extractor) drops `{tipo}` thanks to the
 *     defense-in-depth `[{}]` filter (Bug Y v1).
 *   - `persistFunction` for `produced_payloads` / `consumed_payloads` (LLM
 *     analyzer output) STILL uses only `isUnresolvedTemplateName`, which
 *     by design ignores lowercase placeholders (`{tipo}` lowercase, `{type}`)
 *     because they collide syntactically with REST path params (`{userId}`).
 *   - Result: `quote_{tipo}` and `quote_{type}` leak through and become
 *     DataStructure nodes that no welder can ever bind.
 *
 * Why the filter is safe here:
 *   `produced_payloads[].name` and `consumed_payloads[].name` are payload
 *   identifiers (event/table/class names). They are NEVER URL paths —
 *   REST path params travel through a different field
 *   (`emergent_api_calls[].path`) and a different write path
 *   (`graph-writer.ts:843`). So the `[{}]` filter cannot accidentally drop
 *   a legitimate REST `{userId}` placeholder.
 *
 * Why a dedicated predicate (not just `isUnresolvedTemplateName`):
 *   `isUnresolvedTemplateName` is shared across multiple contexts where
 *   `{userId}` is legitimate. We cannot loosen its regex without breaking
 *   the REST path callers. The new `isTemplatedPayloadName` is a
 *   payload-name-specific predicate: any brace = unresolved template,
 *   no exceptions.
 */

import { describe, it, expect } from 'vitest';
import { isTemplatedPayloadName } from '../../../../src/ai/workflows/sanitizer.js';

describe('isTemplatedPayloadName', () => {
    it('drops lowercase `{tipo}` placeholder (Italian, not in env whitelist)', () => {
        expect(isTemplatedPayloadName('quote_{tipo}')).toBe(true);
    });

    it('drops lowercase `{type}` placeholder (English, not in env whitelist)', () => {
        expect(isTemplatedPayloadName('quote_{type}')).toBe(true);
    });

    it('drops uppercase placeholders (already caught by isUnresolvedTemplateName, but redundancy is fine)', () => {
        expect(isTemplatedPayloadName('quote_{KIND}')).toBe(true);
    });

    it('drops names with dollar-prefixed templates (PHP variable interpolation)', () => {
        expect(isTemplatedPayloadName('queue_${name}')).toBe(true);
    });

    it('drops names with bare opening brace (malformed template)', () => {
        expect(isTemplatedPayloadName('quote_{kind')).toBe(true);
    });

    it('preserves clean snake_case names', () => {
        expect(isTemplatedPayloadName('order_created')).toBe(false);
        expect(isTemplatedPayloadName('fax_suppliers')).toBe(false);
    });

    it('preserves PascalCase class names', () => {
        expect(isTemplatedPayloadName('OrderCreatedEvent')).toBe(false);
        expect(isTemplatedPayloadName('PaymentReceived')).toBe(false);
    });

    it('preserves dotted event names (broker convention)', () => {
        // These are legitimate event names in dotted notation
        // (`domain.service.event` format used by Symfony Messenger,
        // Spring Cloud Stream, etc.).
        expect(isTemplatedPayloadName('domain.orchestrator.quote.requested')).toBe(false);
        expect(isTemplatedPayloadName('shop.order.save.updated')).toBe(false);
    });
});
