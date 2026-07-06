import { describe, it, expect, vi } from 'vitest';
import { parsePhpReturnConfig, type PhpConfigParseOptions } from '../../../../../src/ingestion/core/languages/php/config-array.js';

describe('parsePhpReturnConfig', () => {
    it('converts a key => value map of literals to a plain object', () => {
        const php = `<?php
return [
    'host' => 'rabbit.example.com',
    'port' => 5672,
    'enabled' => true,
];
`;
        const result = parsePhpReturnConfig(php) as Record<string, unknown>;
        expect(result).toEqual({
            host: 'rabbit.example.com',
            port: 5672,
            enabled: true,
        });
    });

    it('converts nested arrays to nested objects', () => {
        const php = `<?php
return [
    'rabbitmq' => [
        'producer' => [
            'order_events' => [
                'exchange' => ['type' => 'fanout', 'name' => 'acme.order-events-exchange'],
            ],
        ],
    ],
];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.rabbitmq.producer.order_events.exchange).toEqual({
            type: 'fanout',
            name: 'acme.order-events-exchange',
        });
    });

    it('maps non-literal scalar values (Secret::read / getenv) to null', () => {
        const php = `<?php
return [
    'connection' => [
        'default' => [
            'host' => Secret::read('RABBITMQ_HOST', 'rabbitmq'),
            'port' => getenv('RABBITMQ_PORT'),
            'vhost' => '/',
        ],
    ],
];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.connection.default.host).toBeNull();
        expect(result.connection.default.port).toBeNull();
        expect(result.connection.default.vhost).toBe('/');
    });

    it('converts list-style arrays (no keys) to JS arrays', () => {
        const php = `<?php
return [
    'queue' => [
        'name' => 'acme.renewals-import',
        'routing_keys' => ['acme.renewal.created', 'acme.renewal.updated'],
    ],
];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.queue.routing_keys).toEqual([
            'acme.renewal.created',
            'acme.renewal.updated',
        ]);
    });

    it('returns null when there is no top-level return', () => {
        const php = `<?php
$config = ['host' => 'x'];
`;
        expect(parsePhpReturnConfig(php)).toBeNull();
    });

    it('returns null when the return value is not an array', () => {
        const php = `<?php
return 42;
`;
        expect(parsePhpReturnConfig(php)).toBeNull();
    });

    it('returns null for malformed PHP', () => {
        expect(parsePhpReturnConfig('this is not php at all <<<')).toBeNull();
    });

    it('supports float and null literals', () => {
        const php = `<?php
return [
    'ratio' => 1.5,
    'missing' => null,
];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.ratio).toBe(1.5);
        expect(result.missing).toBeNull();
    });
});

describe('accessorValue hook (declared env-accessor wrappers → shell templates)', () => {
    /** Hook che traduce Secret::read('K', 'd') → ${K:-d} / Secret::read('K') → ${K}. */
    const secretReadHook: PhpConfigParseOptions = {
        accessorValue: (calleeText, argTexts) => {
            if (!/(^|\\)Secret::read$/.test(calleeText)) return null;
            const key = argTexts[0];
            if (!key) return null;
            const def = argTexts[1];
            return def !== null && def !== undefined ? `\${${key}:-${def}}` : `\${${key}}`;
        },
    };

    it('maps an accessor call to the shell template returned by the hook', () => {
        const php = `<?php
return [
    'connection' => [
        'default' => [
            'host' => Secret::read('RABBITMQ_HOST', 'rabbitmq'),
            'vhost' => '/',
        ],
    ],
];
`;
        const result = parsePhpReturnConfig(php, secretReadHook) as any;
        expect(result.connection.default.host).toBe('${RABBITMQ_HOST:-rabbitmq}');
        expect(result.connection.default.vhost).toBe('/');
    });

    it('single-arg accessor (no default) maps to ${KEY}', () => {
        const php = `<?php
return ['port' => Secret::read('RABBITMQ_PORT')];
`;
        const result = parsePhpReturnConfig(php, secretReadHook) as any;
        expect(result.port).toBe('${RABBITMQ_PORT}');
    });

    it('hook returning null leaves the value UNRESOLVED (null)', () => {
        const php = `<?php
return ['host' => SomeFactory::build('x')];
`;
        const result = parsePhpReturnConfig(php, secretReadHook) as any;
        expect(result.host).toBeNull();
    });

    it('integer literal arguments surface as their text (port defaults)', () => {
        const hook = vi.fn().mockReturnValue(null);
        const php = `<?php
return ['port' => Secret::read('DB_PORT', 3306)];
`;
        parsePhpReturnConfig(php, { accessorValue: hook });
        expect(hook.mock.calls[0][1]).toEqual(['DB_PORT', '3306']);
    });

    it('non-literal arguments surface as null entries in argTexts', () => {
        const hook = vi.fn().mockReturnValue(null);
        const php = `<?php
return ['host' => Secret::read(SELF::KEY, 'fallback')];
`;
        parsePhpReturnConfig(php, { accessorValue: hook });
        expect(hook).toHaveBeenCalledTimes(1);
        const [callee, argTexts] = hook.mock.calls[0];
        expect(callee).toBe('Secret::read');
        expect(argTexts[0]).toBeNull();
        expect(argTexts[1]).toBe('fallback');
    });

    it('function_call form (getenv) reaches the hook with the bare callee', () => {
        const hook = vi.fn((callee: string, args: Array<string | null>) =>
            callee === 'getenv' && args[0] ? `\${${args[0]}}` : null);
        const php = `<?php
return ['port' => getenv('APP_PORT')];
`;
        const result = parsePhpReturnConfig(php, { accessorValue: hook }) as any;
        expect(result.port).toBe('${APP_PORT}');
    });

    it('namespaced accessor callee text is passed verbatim (tail-match is the caller concern)', () => {
        const hook = vi.fn().mockReturnValue(null);
        const php = `<?php
return ['host' => \\Acme\\Platform\\Secret::read('DB_HOST', 'db')];
`;
        parsePhpReturnConfig(php, { accessorValue: hook });
        expect(hook.mock.calls[0][0]).toBe('\\Acme\\Platform\\Secret::read');
    });

    it('hook applies inside nested arrays', () => {
        const php = `<?php
return [
    'doctrine' => [
        'connection' => [
            'orm_default' => [
                'params' => ['host' => Secret::read('DB_HOST', 'mysql')],
            ],
        ],
    ],
];
`;
        const result = parsePhpReturnConfig(php, secretReadHook) as any;
        expect(result.doctrine.connection.orm_default.params.host).toBe('${DB_HOST:-mysql}');
    });

    it('PIN: without opts the behavior is unchanged (accessor calls stay null)', () => {
        const php = `<?php
return ['host' => Secret::read('RABBITMQ_HOST', 'rabbitmq')];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.host).toBeNull();
    });
});

describe('::class constants (driverClass => Foo\\Driver::class)', () => {
    it('resolves Foo\\Driver::class to the FQCN string', () => {
        const php = `<?php
return ['driverClass' => Acme\\Persistence\\Driver\\MySqlDriver::class];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.driverClass).toBe('Acme\\Persistence\\Driver\\MySqlDriver');
    });

    it('strips the leading backslash from a fully-qualified ::class', () => {
        const php = `<?php
return ['driverClass' => \\Acme\\Driver::class];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.driverClass).toBe('Acme\\Driver');
    });

    it('any other class constant stays UNRESOLVED (null)', () => {
        const php = `<?php
return ['mode' => Acme\\Config::DEFAULT_MODE];
`;
        const result = parsePhpReturnConfig(php) as any;
        expect(result.mode).toBeNull();
    });
});

describe('Laminas merge-idiom returns (published laminas-stdlib / PHP API)', () => {
    it('return ArrayUtils::merge($a, $b) resolves top-level variable assignments and deep-merges', async () => {
        const { parsePhpReturnConfig } = await import('../../../../../src/ingestion/core/languages/php/config-array.js');
        const php = `<?php
namespace Acme;
use Laminas\\Stdlib\\ArrayUtils;

$config = [
    'rabbitmq' => [
        'consumer' => [
            'orders_import' => ['exchange' => ['name' => 'acme.orders-import']],
        ],
    ],
];

$extra = [
    'rabbitmq' => [
        'consumer' => [
            'renewals_import' => ['exchange' => ['name' => 'acme.renewals-import']],
        ],
    ],
];

return \\Laminas\\Stdlib\\ArrayUtils::merge($config, $extra);
`;
        const cfg = parsePhpReturnConfig(php) as Record<string, never>;
        expect(cfg).not.toBeNull();
        const consumer = (cfg as never as { rabbitmq: { consumer: Record<string, { exchange: { name: string } }> } }).rabbitmq.consumer;
        expect(consumer.orders_import.exchange.name).toBe('acme.orders-import');
        expect(consumer.renewals_import.exchange.name).toBe('acme.renewals-import');
    });

    it('array_merge with a literal and an unresolvable variable keeps the literal part', async () => {
        const { parsePhpReturnConfig } = await import('../../../../../src/ingestion/core/languages/php/config-array.js');
        const php = `<?php
return array_merge(['a' => 1], $unknownFromInclude);
`;
        const cfg = parsePhpReturnConfig(php) as { a?: number };
        expect(cfg?.a).toBe(1);
    });

    it('non-merge call returns stay null', async () => {
        const { parsePhpReturnConfig } = await import('../../../../../src/ingestion/core/languages/php/config-array.js');
        expect(parsePhpReturnConfig(`<?php return SomeFactory::build($x);`)).toBeNull();
    });
});
