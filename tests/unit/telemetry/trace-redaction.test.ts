import { describe, it, expect } from 'vitest';
import { redactValue } from '../../../src/telemetry/trace-collector.js';

// ═════════════════════════════════════════════════════════════════════════════
// Trace Value Redaction
// ═════════════════════════════════════════════════════════════════════════════

describe('redactValue — key-based redaction', () => {
    it('should redact values for keys containing password', () => {
        expect(redactValue('db_password', 'secret123')).toBe('[REDACTED:key]');
        expect(redactValue('PASSWORD', 'secret123')).toBe('[REDACTED:key]');
    });

    it('should redact values for keys containing token', () => {
        expect(redactValue('api_token', 'abc-def-ghi')).toBe('[REDACTED:key]');
        expect(redactValue('authToken', 'abc-def-ghi')).toBe('[REDACTED:key]');
    });

    it('should redact values for keys containing secret', () => {
        expect(redactValue('client_secret', 'xyzzy')).toBe('[REDACTED:key]');
    });

    it('should NOT redact safe keys', () => {
        expect(redactValue('tableName', 'users')).toBe('users');
        expect(redactValue('filePath', '/app/index.ts')).toBe('/app/index.ts');
    });
});

describe('redactValue — value-based DSN redaction', () => {
    it('should redact a bare postgres DSN', () => {
        expect(redactValue('envValue', 'postgres://user:password@host/db')).toBe('[REDACTED:dsn]');
    });

    it('should redact a DSN embedded in whitespace', () => {
        // No ^ anchor — works even with leading whitespace
        expect(redactValue('envValue', '  postgres://user:super_secret@host/db ')).toBe('[REDACTED:dsn]');
    });

    it('should redact a DSN embedded in quotes', () => {
        expect(redactValue('envValue', '"postgres://user:pass@host/db"')).toBe('[REDACTED:dsn]');
    });

    it('should redact a DSN in a JSON array context', () => {
        expect(redactValue('envValue', '["postgres://user:pass@host/db"]')).toBe('[REDACTED:dsn]');
    });

    it('should redact redis, mysql, mongodb, amqp DSNs', () => {
        expect(redactValue('envValue', 'redis://admin:pw@cache:6379')).toBe('[REDACTED:dsn]');
        expect(redactValue('envValue', 'mysql://root:pass@db:3306/app')).toBe('[REDACTED:dsn]');
        expect(redactValue('envValue', 'mongodb://user:pass@mongo:27017/db')).toBe('[REDACTED:dsn]');
        expect(redactValue('envValue', 'amqps://user:pass@broker/vhost')).toBe('[REDACTED:dsn]');
    });

    it('should NOT redact a safe URL without credentials', () => {
        expect(redactValue('envValue', 'http://example.com')).toBe('http://example.com');
        expect(redactValue('envValue', 'postgres://host/db')).toBe('postgres://host/db');
    });
});

describe('redactValue — length truncation', () => {
    it('should truncate non-sensitive values longer than 4096 characters', () => {
        const longValue = 'x'.repeat(5000);
        const result = redactValue('tableName', longValue);
        expect(result).toBe('x'.repeat(4096) + '…');
    });

    it('should NOT truncate values at or under 4096 characters', () => {
        const value4096 = 'x'.repeat(4096);
        expect(redactValue('tableName', value4096)).toBe(value4096);
    });
});
