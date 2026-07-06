import { describe, it, expect } from 'vitest';

// ═════════════════════════════════════════════════════════════════════════════
// normalizeInfraOperation — Unit Tests
//
// Verifies the Record<string, InfraOperation> lookup table that maps LLM output
// tokens to canonical InfraOperations. This is the single source of truth for
// deciding if an infrastructure interaction is READS, WRITES, or MAPS_TO.
//
// CRITICAL REGRESSION GUARD: Before this test existed, the function silently
// defaulted 'PUBLISH' to 'READS', causing publishers to appear as consumers
// in the Blast Explorer dashboard (LISTENS_TO instead of PUBLISHES_TO).
// ═════════════════════════════════════════════════════════════════════════════

import { normalizeInfraOperation } from '../../../src/ai/agents/unified-analyzer.js';

// ─── DB Operations ───────────────────────────────────────────────────────────

describe('normalizeInfraOperation — DB operations', () => {
    it.each([
        ['WRITES', 'WRITES'],
        ['WRITE', 'WRITES'],
        ['INSERT', 'WRITES'],
        ['UPDATE', 'WRITES'],
        ['DELETE', 'WRITES'],
        ['UPSERT', 'WRITES'],
    ])('should map %s → %s', (input, expected) => {
        expect(normalizeInfraOperation(input)).toBe(expected);
    });

    it.each([
        ['READS', 'READS'],
        ['READ', 'READS'],
    ])('should map %s → %s', (input, expected) => {
        expect(normalizeInfraOperation(input)).toBe(expected);
    });
});

// ─── Broker Operations (THE REGRESSION TARGET) ──────────────────────────────

describe('normalizeInfraOperation — Broker operations', () => {
    it.each([
        ['PUBLISH', 'WRITES'],
        ['PUBLISHES', 'WRITES'],
        ['PUBLISHES_TO', 'WRITES'],
        ['SEND', 'WRITES'],
        ['EMIT', 'WRITES'],
    ])('should map %s → WRITES (publisher, not consumer)', (input, expected) => {
        expect(normalizeInfraOperation(input)).toBe(expected);
    });
});

// ─── Case Insensitivity ──────────────────────────────────────────────────────

describe('normalizeInfraOperation — case insensitivity', () => {
    it.each([
        ['publish', 'WRITES'],
        ['Publish', 'WRITES'],
        ['reads', 'READS'],
        ['Reads', 'READS'],
        ['writes', 'WRITES'],
        ['insert', 'WRITES'],
        ['emit', 'WRITES'],
        ['send', 'WRITES'],
    ])('should be case-insensitive: %s → %s', (input, expected) => {
        expect(normalizeInfraOperation(input)).toBe(expected);
    });
});

// ─── Whitespace Tolerance ────────────────────────────────────────────────────

describe('normalizeInfraOperation — whitespace tolerance', () => {
    it.each([
        ['  PUBLISH  ', 'WRITES'],
        [' READS ', 'READS'],
        ['WRITES ', 'WRITES'],
    ])('should trim whitespace: %s → %s', (input, expected) => {
        expect(normalizeInfraOperation(input)).toBe(expected);
    });
});

// ─── MAPS_TO ────────────────────────────────────────────────────────────────

describe('normalizeInfraOperation — MAPS_TO', () => {
    it('should map MAPS_TO → MAPS_TO', () => {
        expect(normalizeInfraOperation('MAPS_TO')).toBe('MAPS_TO');
    });
});

// ─── Unknown Tokens → Default READS ─────────────────────────────────────────

describe('normalizeInfraOperation — unknown tokens default to READS', () => {
    it.each([
        ['UNKNOWN_OP', 'READS'],
        ['PROCESS', 'READS'],
        ['CONNECT', 'READS'],
        ['', 'READS'],
        ['   ', 'READS'],
    ])('should default %s → READS', (input, expected) => {
        expect(normalizeInfraOperation(input)).toBe(expected);
    });
});
