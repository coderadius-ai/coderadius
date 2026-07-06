// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-di-conditional-factory-no-bypass (recall guard)
//
// Negative test: a PHP-DI factory closure that returns DIFFERENT concrete
// classes depending on a runtime condition CANNOT be resolved statically.
// The provider must:
//   1. Reject the entry (extract 0 RawDiBindings).
//   2. Phase 4 cross-check must NOT bypass: there are TWO implementers of
//      CacheInterface in the repo (RedisCache, NullCache), so even the
//      Phase 4 single-implementer guard does not fire.
//   3. The consumer's static-bypass returns null → LLM fallback.
//
// Pins: parser stays conservative on conditional factories. Loss of recall
// here is the correct behaviour; the LLM path remains the safety net.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-di-conditional-factory-no-bypass', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('PhpDiContainerProvider rejects the conditional factory entry', () => {
        // The closure body has two `return new X()` statements; the provider
        // requires exactly one to consider the binding well-formed.
        const cacheBindings = result.rawBindings.filter(b =>
            b.key === 'Acme\\Inventory\\Cache\\CacheInterface');
        expect(cacheBindings).toHaveLength(0);
    });

    it('DiBindingResolver Phase 4 does not auto-bind ambiguous interface', () => {
        // CacheInterface has TWO implementers in the repo (Redis + Null), so
        // even the "single implementer" Phase 4 cross-check must skip it.
        const ifaceBinding = result.registry.getAll().find(b =>
            b.key === 'Acme\\Inventory\\Cache\\CacheInterface');
        expect(ifaceBinding).toBeUndefined();
    });

    it('consumer static bypass returns null (LLM fallback)', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'Acme\\Inventory\\Orders\\OrderController',
            'getOrder',
        );
        expect(staticAnalysis).toBeNull();
    });
});
