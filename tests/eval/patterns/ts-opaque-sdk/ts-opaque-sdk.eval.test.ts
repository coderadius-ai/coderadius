/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-opaque-sdk
 *
 * Reproduces the bug where opaque SDK wrappers listed in packages.analyze
 * with typed metadata do NOT automatically generate LLM hints.
 *
 * Architecture under test:
 *   repo-hints.ts → buildCustomKnowledgePrompt()
 *
 * Root cause:
 *   packages.analyze only accepts string entries (package names).
 *   There is no way to attach semantics (kind, label, baseUrl) to a package,
 *   so buildCustomKnowledgePrompt() cannot generate hints from it.
 *
 * Fix:
 *   Extend PackagesSchema.analyze to accept typed entries:
 *     { name, kind, label?, baseUrl? }
 *   buildCustomKnowledgePrompt() generates auto-hints for typed entries,
 *   using the same mechanism already used by manual hints[].
 *
 * Expected (after fix):
 *   ✓ loadRepoHints() parses typed analyze entry without error
 *   ✓ buildCustomKnowledgePrompt() includes "Notification API" in output
 *   ✓ Plain string entries in analyze do NOT generate spurious hints
 *
 * Before fix (RED state):
 *   ✗ loadRepoHints() may fail schema validation for typed entry (or silently ignore it)
 *   ✗ buildCustomKnowledgePrompt() produces undefined (no hints)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
    loadRepoHints,
    clearRepoHintsCache,
    buildCustomKnowledgePrompt,
} from '../../../../src/config/repo-hints.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Pattern Eval — ts-opaque-sdk (typed packages.analyze auto-hints)', () => {

    it('should load coderadius.yaml with a typed analyze entry without schema errors', () => {
        clearRepoHintsCache(FIXTURE_DIR);
        // Should NOT throw or return empty defaults
        const hints = loadRepoHints(FIXTURE_DIR);
        expect(hints).toBeDefined();
        expect(hints.packages).toBeDefined();
        expect(hints.packages!.analyze.length).toBeGreaterThan(0);
    });

    it('should retain the typed entry in packages.analyze [BUG REPRODUCTION]', () => {
        clearRepoHintsCache(FIXTURE_DIR);
        const hints = loadRepoHints(FIXTURE_DIR);

        // Before fix: the typed entry `{ name, kind, label, baseUrl }` either fails
        // schema validation (returning default empty hints) or is silently dropped.
        // After fix: it is retained and accessible.
        const analyzeEntries = hints.packages!.analyze;

        const typedEntry = analyzeEntries.find(
            (e): e is { name: string; kind: string; label?: string; baseUrl?: string } =>
                typeof e === 'object' && e !== null && 'name' in e,
        );

        expect(
            typedEntry,
            'A typed entry { name, kind, label, baseUrl } must be retained in packages.analyze. ' +
            'Plain strings and typed objects must coexist in the array.',
        ).toBeDefined();

        expect(typedEntry!.name).toBe('@acme/notification-client');
        expect(typedEntry!.kind).toBe('http-client');
        expect(typedEntry!.label).toBe('Notification API');
    });

    it('should generate an LLM hint for the typed entry via buildCustomKnowledgePrompt [BUG REPRODUCTION]', () => {
        clearRepoHintsCache(FIXTURE_DIR);
        const hints = loadRepoHints(FIXTURE_DIR);
        const prompt = buildCustomKnowledgePrompt(hints);

        // Before fix: buildCustomKnowledgePrompt returns undefined (no hints configured)
        // After fix: it generates a hint from the typed analyze entry
        expect(
            prompt,
            'buildCustomKnowledgePrompt must return a non-empty string when typed packages.analyze entries are present. ' +
            'The prompt must include the label "Notification API".',
        ).toBeDefined();

        expect(prompt!).toContain('Notification API');
    });

    it('should include the SDK class name or package in the generated hint', () => {
        clearRepoHintsCache(FIXTURE_DIR);
        const hints = loadRepoHints(FIXTURE_DIR);
        const prompt = buildCustomKnowledgePrompt(hints);

        expect(prompt).toBeDefined();
        // The hint must reference either the package name or the class name
        // so the LLM can match it against the code
        expect(
            prompt!.includes('notification-client') || prompt!.includes('NotificationClient'),
            'Generated hint must reference the SDK package or class name',
        ).toBe(true);
    });

    it('should NOT generate a hint for plain string entries in packages.analyze [negative]', () => {
        clearRepoHintsCache(FIXTURE_DIR);
        const hints = loadRepoHints(FIXTURE_DIR);

        // Add a plain string entry to verify it doesn't generate a hint
        // (we test this by ensuring 'urql' or similar plain packages don't appear as custom knowledge)
        const prompt = buildCustomKnowledgePrompt(hints);

        // A plain string like 'urql' must NOT generate auto-hints
        // (it was only used for taint propagation, not LLM context)
        if (prompt) {
            // If a prompt IS generated, it must be from typed entries only
            expect(prompt).not.toMatch(/urql.*is an HTTP API call/i);
            expect(prompt).not.toMatch(/plain-package-no-hint/i);
        }
    });
});
