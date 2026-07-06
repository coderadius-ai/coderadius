import type { IPricingApiRepository } from '../infrastructure/PricingApi.interface';

/**
 * Use case: applies a discount coupon to a product using the external Pricing Engine.
 *
 * Calls IPricingApiRepository.calculateDiscount() — a Zodios alias that resolves to:
 *   POST /api/v1/pricing/discount
 *
 * The LLM will NOT extract this as an API call (wrapper rule suppression).
 * The Zodios AST resolver (zodios-context-builder) identifies this call at static
 * analysis time and injects it deterministically into emergent_api_calls post-LLM.
 */
export class DiscountCalculator {
    constructor(private readonly pricingApi: IPricingApiRepository) {}

    /**
     * Apply a discount coupon to a product and return the final price.
     */
    async applyDiscount(productId: string, couponCode: string, quantity?: number): Promise<{
        finalPrice: number;
        savings: number;
    }> {
        const result = await this.pricingApi.calculateDiscount({
            productId,
            couponCode,
            quantity,
        });

        return {
            finalPrice: result.discountedPrice,
            savings: result.savingsAmount,
        };
    }

    /**
     * Fetch the base price for a product without any discounts.
     */
    async getBasePrice(productId: string): Promise<number> {
        const pricing = await this.pricingApi.getPricing({ params: { productId } });
        return pricing.basePrice;
    }
}
