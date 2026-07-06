import { describe, it, expect } from 'vitest';
import { scrubDecoratorSecrets } from '../../../../../src/ingestion/core/decorator-scrubber.js';

describe('scrubDecoratorSecrets (Gotcha #2)', () => {
    it('redacts quoted password assignment', () => {
        const out = scrubDecoratorSecrets(
            `@Consumer({ queue: 'orders', password: 'super_secret_dev_pass' })`,
        );
        expect(out).toContain(`password: '[REDACTED]'`);
        expect(out).not.toContain('super_secret_dev_pass');
        // Innocuous fields untouched.
        expect(out).toContain(`queue: 'orders'`);
    });

    it('redacts double-quoted password', () => {
        const out = scrubDecoratorSecrets(`@C({ password: "abc123" })`);
        expect(out).toBe(`@C({ password: "[REDACTED]" })`);
    });

    it('redacts JS assignment (= operator)', () => {
        const out = scrubDecoratorSecrets(`@Auth({ token = "ghp_xxx" })`);
        expect(out).toContain('token = "[REDACTED]"');
    });

    it('redacts unquoted token-like values', () => {
        const out = scrubDecoratorSecrets(`@H(apikey=AKIA0123)`);
        expect(out).toContain('apikey=[REDACTED]');
        expect(out).not.toContain('AKIA0123');
    });

    it('handles multiple secrets in the same string', () => {
        const out = scrubDecoratorSecrets(
            `@C({ apiKey: 'k1', clientSecret: 'k2', name: 'normal' })`,
        );
        expect(out).not.toContain('k1');
        expect(out).not.toContain('k2');
        expect(out).toContain(`name: 'normal'`);
    });

    it('is case-insensitive on the key name', () => {
        const out = scrubDecoratorSecrets(`@C({ PASSWORD: 'p', Bearer: 't' })`);
        expect(out).toContain(`PASSWORD: '[REDACTED]'`);
        expect(out).toContain(`Bearer: '[REDACTED]'`);
    });

    it('does NOT scrub innocuous identifiers that just contain the keyword', () => {
        // `passwordPolicy` is not a sensitive key (no `:` / `=` after `password`).
        const out = scrubDecoratorSecrets(`@Inject('passwordPolicy')`);
        expect(out).toBe(`@Inject('passwordPolicy')`);
    });

    it('does NOT scrub literal path segments like /api/secret', () => {
        const out = scrubDecoratorSecrets(`@Get('/api/secret/{id}')`);
        expect(out).toBe(`@Get('/api/secret/{id}')`);
    });

    it('preserves non-sensitive prefix and suffix around the redacted value', () => {
        const out = scrubDecoratorSecrets(
            `@QueueConsumer({ queueName: 'orders', password: 'secret', concurrency: 4 })`,
        );
        expect(out).toContain(`queueName: 'orders'`);
        expect(out).toContain(`concurrency: 4`);
        expect(out).toContain(`password: '[REDACTED]'`);
    });

    it('returns the input unchanged when no sensitive key is present', () => {
        const input = `@QueueConsumer({ queueName: 'orders.created', concurrency: 4 })`;
        expect(scrubDecoratorSecrets(input)).toBe(input);
    });

    it('handles the empty string', () => {
        expect(scrubDecoratorSecrets('')).toBe('');
    });

    it('recognises snake_case sensitive keys (api_key, client_secret)', () => {
        const out = scrubDecoratorSecrets(`@C({ api_key: 'a', client_secret: 'b' })`);
        expect(out).not.toContain(`'a'`);
        expect(out).not.toContain(`'b'`);
    });
});
