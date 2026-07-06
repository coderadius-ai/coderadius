// ═══════════════════════════════════════════════════════════════════════════════
// ClassifierBudget — token + USD circuit breaker for the sink classifier.
//
// Runs *separately* from the global ingestion LLM budget. A misconfigured
// classifier (e.g. mode=force-refresh on a 10K-package repo) cannot drain
// the rate-limit budget that the rest of the pipeline depends on.
// ═══════════════════════════════════════════════════════════════════════════════

export interface BudgetLimits {
    /** Hard cap on tokens consumed by the classifier this run. */
    maxTokens: number;
    /** Hard cap on USD spent by the classifier this run. */
    maxUsd: number;
}

export interface ModelPricingLite {
    inputPricePer1M: number;
    outputPricePer1M: number;
    cachedInputPricePer1M?: number;
}

export interface BudgetSnapshot {
    consumedTokens: number;
    consumedUsd: number;
    remainingTokens: number;
    remainingUsd: number;
    tripped: boolean;
    tripReason?: 'tokens' | 'usd';
}

export class ClassifierBudget {
    private consumedTokens = 0;
    private consumedUsd = 0;
    private _tripped = false;
    private _reason?: 'tokens' | 'usd';

    constructor(private readonly limits: BudgetLimits) {}

    /**
     * Optimistic guard before issuing an LLM call.
     * Pass an estimated token count; returns false if even the optimistic
     * estimate would exceed the cap.
     */
    canConsume(estimatedTokens: number): boolean {
        if (this._tripped) return false;
        return this.consumedTokens + estimatedTokens <= this.limits.maxTokens;
    }

    /**
     * Record actual consumption AFTER an LLM call. Trips the breaker if any
     * cap is exceeded.
     */
    consume(
        actualInputTokens: number,
        actualOutputTokens: number,
        pricing?: ModelPricingLite,
    ): void {
        const total = actualInputTokens + actualOutputTokens;
        this.consumedTokens += total;

        if (pricing) {
            const usd =
                (actualInputTokens / 1_000_000) * pricing.inputPricePer1M +
                (actualOutputTokens / 1_000_000) * pricing.outputPricePer1M;
            this.consumedUsd += usd;
        }

        if (this.consumedTokens > this.limits.maxTokens) {
            this._tripped = true;
            this._reason = 'tokens';
        } else if (this.consumedUsd > this.limits.maxUsd) {
            this._tripped = true;
            this._reason = 'usd';
        }
    }

    tripped(): boolean {
        return this._tripped;
    }

    snapshot(): BudgetSnapshot {
        return {
            consumedTokens: this.consumedTokens,
            consumedUsd: this.consumedUsd,
            remainingTokens: Math.max(0, this.limits.maxTokens - this.consumedTokens),
            remainingUsd: Math.max(0, this.limits.maxUsd - this.consumedUsd),
            tripped: this._tripped,
            tripReason: this._reason,
        };
    }
}
