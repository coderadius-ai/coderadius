/**
 * Tests for AgenticMetadataExtractionSchema
 *
 * These validate the defense-in-depth Zod strategy for the topics field:
 * - Vertex AI ignores `maxItems` in JSON Schema, so the schema uses a loose .max(12)
 * - A .transform() truncates silently to 4 at the application layer
 * - The prompt includes a CRITICAL rule as the primary defense
 */

import { describe, it, expect } from 'vitest';
import { AgenticMetadataExtractionSchema } from '../../../../src/ai/agents/agentic-metadata-extractor.js';

describe('AgenticMetadataExtractionSchema', () => {
    describe('topics field — Zod defense-in-depth', () => {
        it('should accept exactly 1 topic', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Enforces commit message format.',
                topics: ['workflow'],
                technologies: [],
            });
            expect(result.success).toBe(true);
            expect(result.data!.topics).toEqual(['workflow']);
        });

        it('should accept exactly 3 topics', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Full-stack config.',
                topics: ['testing', 'coding-standards', 'architecture'],
                technologies: ['typescript', 'jest'],
            });
            expect(result.success).toBe(true);
            expect(result.data!.topics).toHaveLength(3);
        });

        it('should accept exactly 4 topics', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'A config touching four domains.',
                topics: ['testing', 'coding-standards', 'architecture', 'cross-repo-architecture'],
                technologies: [],
            });
            expect(result.success).toBe(true);
            expect(result.data!.topics).toHaveLength(4);
        });

        it('should accept the cross-repo-architecture topic', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Documents how this service depends on upstream payment and shipping services.',
                topics: ['cross-repo-architecture'],
                technologies: [],
            });
            expect(result.success).toBe(true);
            expect(result.data!.topics).toEqual(['cross-repo-architecture']);
        });

        it('should silently truncate to 4 when Vertex returns 5+ topics', () => {
            // This is the core regression test — Vertex AI ignores maxItems in JSON Schema
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'A rich config touching many domains.',
                topics: ['testing', 'coding-standards', 'architecture', 'security', 'ci-cd'],
                technologies: [],
            });
            expect(result.success).toBe(true);
            // .transform(arr => arr.slice(0, 4)) must have fired
            expect(result.data!.topics).toHaveLength(4);
            expect(result.data!.topics).toEqual(['testing', 'coding-standards', 'architecture', 'security']);
        });

        it('should fail when topics array is empty', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Some config.',
                topics: [],
                technologies: [],
            });
            expect(result.success).toBe(false);
        });

        it('should fail when a topic value is outside the allowed enum', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Some config.',
                topics: ['devops'],   // not a valid GovernanceTopic
                technologies: [],
            });
            expect(result.success).toBe(false);
        });
    });

    describe('technologies field', () => {
        it('should accept an empty technologies array', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Generic instructions config.',
                topics: ['developer-experience'],
                technologies: [],
            });
            expect(result.success).toBe(true);
        });

        it('should accept technologies when provided', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Enforces React component style.',
                topics: ['coding-standards'],
                technologies: ['react', 'typescript', 'eslint'],
            });
            expect(result.success).toBe(true);
            expect(result.data!.technologies).toEqual(['react', 'typescript', 'eslint']);
        });

        it('should require technologies (it is not optional)', () => {
            // technologies is z.array(z.string()) — required, not optional
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: 'Config with no tech list.',
                topics: ['workflow'],
                // technologies omitted — should fail
            });
            expect(result.success).toBe(false);
        });
    });

    describe('intent field', () => {
        it('should fail when intent is missing', () => {
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                topics: ['testing'],
                technologies: [],
            });
            expect(result.success).toBe(false);
        });

        it('should accept an empty string for intent (schema uses z.string() without .min(1))', () => {
            // NOTE: ideally intent should reject empty strings (.min(1)) but the
            // current schema doesn't enforce this — accepting is the current behavior.
            // If you add .min(1) to the schema, flip this expectation to toBe(false).
            const result = AgenticMetadataExtractionSchema.safeParse({
                isAgenticContent: true,
                intent: '',
                topics: ['testing'],
                technologies: [],
            });
            expect(result.success).toBe(true);
        });
    });
});
