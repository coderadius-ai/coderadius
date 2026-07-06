import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../../src/utils/logger.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Logger diagnostic sink', () => {
    it('routes logs to the active sink without writing to stdio', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logger = new Logger();
        logger.setDebug(true);
        const messages: Array<{ level: string; message: string }> = [];

        await logger.withDiagnosticSink(entry => messages.push(entry), async () => {
            logger.log('[CacheBuster] Symbol changed: %s', 'memcached.uri');
            logger.info('[CacheBuster] Symbol changed: %s', 'baseUrl');
            logger.debug('[Debug] %s', 'hidden');
            logger.warn('[RateLimit] 429 on attempt %d/%d', 1, 4);
            logger.error('[SemanticExtractor] Failed for %s', 'foo');
        });

        expect(messages).toEqual([
            { level: 'log', message: '[CacheBuster] Symbol changed: memcached.uri' },
            { level: 'info', message: '[CacheBuster] Symbol changed: baseUrl' },
            { level: 'debug', message: '[Debug] hidden' },
            { level: 'warn', message: '[RateLimit] 429 on attempt 1/4' },
            { level: 'error', message: '[SemanticExtractor] Failed for foo' },
        ]);
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('restores stderr logging after the sink scope exits', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const logger = new Logger();

        await logger.withDiagnosticSink(() => {}, async () => {
            logger.warn('hidden');
        });
        logger.warn('visible');

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('visible');
    });
});
