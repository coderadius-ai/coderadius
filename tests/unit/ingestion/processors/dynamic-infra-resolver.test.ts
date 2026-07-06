import { describe, it, expect } from 'vitest';
import { normalizeEnvPlaceholder } from '../../../../src/ingestion/processors/dynamic-infra-resolver.js';

describe('normalizeEnvPlaceholder', () => {
    // — envSuffix patterns —
    it('should strip {envSuffix} from broker name', () => {
        expect(normalizeEnvPlaceholder('pkg.acme_core{envSuffix}.shipment.requested')).toBe('pkg.acme_core.shipment.requested');
    });

    it('should strip {envSuffix} from another broker pattern', () => {
        expect(normalizeEnvPlaceholder('logistics.fulfillment{envSuffix}.save.ready')).toBe('logistics.fulfillment.save.ready');
    });

    // — {tipo}/{type} are business-logic partitions, NOT env placeholders —
    it('should NOT strip {tipo} (business-logic partition)', () => {
        expect(normalizeEnvPlaceholder('shipment_{tipo}')).toBeNull();
    });

    it('should NOT strip {type} (business-logic partition)', () => {
        expect(normalizeEnvPlaceholder('shipment_{type}')).toBeNull();
    });

    it('should NOT strip {tipo} from MongoDB collection pattern (quote bug)', () => {
        expect(normalizeEnvPlaceholder('quote_{tipo}')).toBeNull();
    });

    // — tablePrefix pattern —
    it('should strip {tablePrefix} from table name', () => {
        expect(normalizeEnvPlaceholder('shipment_{tablePrefix}')).toBe('shipment');
    });

    // — No placeholder —
    it('should return null when no placeholder is present', () => {
        expect(normalizeEnvPlaceholder('quotes')).toBeNull();
    });

    it('should return null for concrete broker name', () => {
        expect(normalizeEnvPlaceholder('pkg.acme_core.shipment.requested')).toBeNull();
    });

    // — Edge cases —
    it('should clean up doubled dots after stripping', () => {
        expect(normalizeEnvPlaceholder('foo.{env}.bar')).toBe('foo.bar');
    });

    it('should clean up leading dots after stripping', () => {
        expect(normalizeEnvPlaceholder('{env}.bar')).toBe('bar');
    });

    it('should strip {prefix} pattern', () => {
        expect(normalizeEnvPlaceholder('{prefix}_orders')).toBe('orders');
    });

    // — Residual placeholder guard —
    it('should return null when residual {tipo} remains after stripping {env}', () => {
        // {env} stripped but {tipo} remains → residual placeholder guard
        expect(normalizeEnvPlaceholder('{env}.{tipo}')).toBeNull();
    });

    it('should return null when non-env placeholder remains after stripping env prefix', () => {
        expect(normalizeEnvPlaceholder('{env}.{businessKey}')).toBeNull();
    });

    it('should return null when residual {type} remains after stripping {env}', () => {
        expect(normalizeEnvPlaceholder('{env}_{type}')).toBeNull();
    });

    it('should return null when residual {carrierType} remains after stripping {prefix}', () => {
        expect(normalizeEnvPlaceholder('{prefix}_shipment_{carrierType}')).toBeNull();
    });
});

import { isPurelyDynamicPlaceholder } from '../../../../src/ai/workflows/sanitizer.js';

describe('isPurelyDynamicPlaceholder', () => {
    it.each([
        '{args.ts}', '{args.output_file}', '{self.table_name}',
        '{cfg.TableName}', '{$tableName}', '{filename}', '{type}',
    ])('should return true for "%s"', (name) => {
        expect(isPurelyDynamicPlaceholder(name)).toBe(true);
    });

    it.each([
        'booking_slot_{type}', 'quote_{tipo}', '_{x}',
        'records', 'platform.order.save',
    ])('should return false for "%s"', (name) => {
        expect(isPurelyDynamicPlaceholder(name)).toBe(false);
    });
});
