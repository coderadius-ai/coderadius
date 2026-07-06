import { describe, it, expect } from 'vitest';
import { matchTagToPublisher, type PublisherInfo } from '../../../../src/ingestion/structural/git-tag-scanner.js';

// ═════════════════════════════════════════════════════════════════════════════
// Git Tag Scanner — Unit Tests
//
// Tests the multi-strategy tag matching logic in isolation.
// No git operations, no filesystem, no side effects.
// ═════════════════════════════════════════════════════════════════════════════

describe('Git Tag Scanner — Tag Matching', () => {
    // ── Scoped npm packages ─────────────────────────────────────────────────

    describe('Strategy 1: Scoped exact match', () => {
        const publishers: PublisherInfo[] = [
            { packageName: '@acme/auth', ecosystem: 'npm' },
            { packageName: '@acme/ui-core', ecosystem: 'npm' },
        ];

        it('should match @scope/name@version', () => {
            const result = matchTagToPublisher('@acme/auth@1.2.3', publishers);
            expect(result).not.toBeNull();
            expect(result!.publisher.packageName).toBe('@acme/auth');
            expect(result!.version).toBe('1.2.3');
        });

        it('should match @scope/name/vVersion', () => {
            const result = matchTagToPublisher('@acme/ui-core/v2.0.0', publishers);
            expect(result).not.toBeNull();
            expect(result!.publisher.packageName).toBe('@acme/ui-core');
            expect(result!.version).toBe('2.0.0');
        });

        it('should match @scope/name/version (no v prefix)', () => {
            const result = matchTagToPublisher('@acme/auth/0.9.1', publishers);
            expect(result).not.toBeNull();
            expect(result!.version).toBe('0.9.1');
        });

        it('should match short name: auth@1.2.3', () => {
            const result = matchTagToPublisher('auth@1.2.3', publishers);
            expect(result).not.toBeNull();
            expect(result!.publisher.packageName).toBe('@acme/auth');
            expect(result!.version).toBe('1.2.3');
        });
    });

    // ── Unscoped packages (composer/npm) ────────────────────────────────────

    describe('Strategy 2: Unscoped package match', () => {
        const publishers: PublisherInfo[] = [
            { packageName: 'acme-corp/logger-php', ecosystem: 'composer' },
        ];

        it('should match name@version for composer packages', () => {
            const result = matchTagToPublisher('acme-corp/logger-php@1.3.0', publishers);
            expect(result).not.toBeNull();
            expect(result!.publisher.packageName).toBe('acme-corp/logger-php');
            expect(result!.version).toBe('1.3.0');
        });

        it('should match short name: logger-php@1.0.0', () => {
            const result = matchTagToPublisher('logger-php@1.0.0', publishers);
            expect(result).not.toBeNull();
            expect(result!.version).toBe('1.0.0');
        });
    });

    // ── Simple tags (single publisher) ──────────────────────────────────────

    describe('Strategy 3: Simple tags (single publisher fallback)', () => {
        const singlePublisher: PublisherInfo[] = [
            { packageName: '@acme/auth', ecosystem: 'npm' },
        ];

        it('should match v1.2.3 when single publisher', () => {
            const result = matchTagToPublisher('v1.2.3', singlePublisher);
            expect(result).not.toBeNull();
            expect(result!.publisher.packageName).toBe('@acme/auth');
            expect(result!.version).toBe('1.2.3');
        });

        it('should match bare 1.2.3 when single publisher', () => {
            const result = matchTagToPublisher('1.2.3', singlePublisher);
            expect(result).not.toBeNull();
            expect(result!.version).toBe('1.2.3');
        });

        it('should NOT match simple tags when multiple publishers', () => {
            const multi: PublisherInfo[] = [
                { packageName: '@acme/auth', ecosystem: 'npm' },
                { packageName: '@acme/ui-core', ecosystem: 'npm' },
            ];
            const result = matchTagToPublisher('v1.2.3', multi);
            expect(result).toBeNull();
        });
    });

    // ── Non-semver rejection ────────────────────────────────────────────────

    describe('Non-semver tag rejection', () => {
        const publishers: PublisherInfo[] = [
            { packageName: '@acme/auth', ecosystem: 'npm' },
        ];

        it('should reject non-semver tags', () => {
            expect(matchTagToPublisher('latest', publishers)).toBeNull();
            expect(matchTagToPublisher('stable', publishers)).toBeNull();
            expect(matchTagToPublisher('release-candidate', publishers)).toBeNull();
            expect(matchTagToPublisher('deploy-2024-01-15', publishers)).toBeNull();
        });

        it('should reject incomplete semver', () => {
            expect(matchTagToPublisher('v1', publishers)).toBeNull();
            expect(matchTagToPublisher('v1.2', publishers)).toBeNull();
        });
    });

    // ── Pre-release / build metadata ────────────────────────────────────────

    describe('Pre-release and build metadata', () => {
        const publishers: PublisherInfo[] = [
            { packageName: '@acme/auth', ecosystem: 'npm' },
        ];

        it('should accept pre-release tags', () => {
            const result = matchTagToPublisher('@acme/auth@1.0.0-alpha.1', publishers);
            expect(result).not.toBeNull();
            expect(result!.version).toBe('1.0.0-alpha.1');
        });

        it('should accept build metadata tags', () => {
            const result = matchTagToPublisher('@acme/auth@1.0.0+build.123', publishers);
            expect(result).not.toBeNull();
            // semver.clean strips build metadata
            expect(result!.version).toBe('1.0.0');
        });
    });

    // ── Edge: no publishers ─────────────────────────────────────────────────

    describe('Edge cases', () => {
        it('should return null for empty publisher list', () => {
            expect(matchTagToPublisher('v1.0.0', [])).toBeNull();
        });

        it('should not match tags for wrong package', () => {
            const publishers: PublisherInfo[] = [
                { packageName: '@acme/auth', ecosystem: 'npm' },
            ];
            expect(matchTagToPublisher('@acme/billing@1.0.0', publishers)).toBeNull();
        });
    });
});
