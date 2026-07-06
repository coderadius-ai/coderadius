/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit Tests — Eval Mode (Hard Assertions Only)
 *
 * Tests the hardCheck / hardContains / hardThreshold enforcement helpers.
 * All assertions are unconditionally hard — no advisory mode.
 * Zero LLM, zero DB — pure logic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
    hardCheck,
    hardContains,
    hardThreshold,
    // Legacy aliases
    softCheck,
    softContains,
    softThreshold,
} from '../../eval/helpers/eval-mode.js';

describe('eval-mode (hard assertions)', () => {

    describe('hardCheck', () => {
        it('should pass silently when condition is true', () => {
            hardCheck(true, 'true assertion');
            // No throw = pass
        });

        it('should throw when condition is false', () => {
            expect(() => hardCheck(false, 'test assertion')).toThrow();
        });
    });

    describe('hardContains', () => {
        it('should pass when item exists in array', () => {
            hardContains(['a', 'b', 'c'], 'b', 'b in array');
            // No throw = pass
        });

        it('should throw when item is missing from array', () => {
            expect(() => hardContains(['a', 'b'], 'z', 'z in array')).toThrow();
        });
    });

    describe('hardThreshold', () => {
        it('should pass when value meets threshold', () => {
            hardThreshold(0.95, 0.80, 'recall');
            // No throw = pass
        });

        it('should pass when value equals threshold exactly', () => {
            hardThreshold(0.80, 0.80, 'recall');
            // No throw = pass
        });

        it('should throw when value is below threshold', () => {
            expect(() => hardThreshold(0.65, 0.80, 'recall')).toThrow();
        });
    });

    describe('legacy aliases', () => {
        it('softCheck should be an alias for hardCheck', () => {
            expect(softCheck).toBe(hardCheck);
        });

        it('softContains should be an alias for hardContains', () => {
            expect(softContains).toBe(hardContains);
        });

        it('softThreshold should be an alias for hardThreshold', () => {
            expect(softThreshold).toBe(hardThreshold);
        });
    });
});
