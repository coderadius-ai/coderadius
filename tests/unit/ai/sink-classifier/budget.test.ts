import { describe, it, expect } from 'vitest';
import { ClassifierBudget } from '../../../../src/ai/agents/sink-classifier/budget.js';

describe('ClassifierBudget — circuit breaker', () => {
    it('starts un-tripped with full remaining budget', () => {
        const b = new ClassifierBudget({ maxTokens: 1000, maxUsd: 0.5 });
        const s = b.snapshot();
        expect(s.tripped).toBe(false);
        expect(s.remainingTokens).toBe(1000);
        expect(s.remainingUsd).toBe(0.5);
    });

    it('canConsume rejects requests larger than remaining', () => {
        const b = new ClassifierBudget({ maxTokens: 100, maxUsd: 1 });
        expect(b.canConsume(50)).toBe(true);
        b.consume(60, 0);
        expect(b.canConsume(50)).toBe(false);
        expect(b.canConsume(40)).toBe(true);
    });

    it('trips on token cap', () => {
        const b = new ClassifierBudget({ maxTokens: 100, maxUsd: 1 });
        b.consume(60, 50);
        expect(b.tripped()).toBe(true);
        expect(b.snapshot().tripReason).toBe('tokens');
        // Once tripped, canConsume always returns false
        expect(b.canConsume(1)).toBe(false);
    });

    it('trips on USD cap given pricing (with token cap large enough not to trip first)', () => {
        const b = new ClassifierBudget({ maxTokens: 100_000_000, maxUsd: 0.01 });
        b.consume(500_000, 500_000, { inputPricePer1M: 0.10, outputPricePer1M: 0.10 });
        expect(b.tripped()).toBe(true);
        expect(b.snapshot().tripReason).toBe('usd');
    });

    it('snapshot reports incremental consumption', () => {
        const b = new ClassifierBudget({ maxTokens: 1000, maxUsd: 1 });
        b.consume(100, 50);
        b.consume(50, 25);
        const s = b.snapshot();
        expect(s.consumedTokens).toBe(225);
        expect(s.remainingTokens).toBe(775);
    });
});
