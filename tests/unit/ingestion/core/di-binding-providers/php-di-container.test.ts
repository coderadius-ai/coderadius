import { describe, it, expect } from 'vitest';
import { PhpDiContainerProvider } from '../../../../../src/ingestion/core/di-binding-providers/php-di-container.js';

const provider = new PhpDiContainerProvider();

function extract(content: string, relativePath = 'config/containerBuilder.php') {
    return provider.extractDiBindings(content, {
        relativePath,
        repoRoot: '/tmp/acme',
        repoName: 'acme',
    });
}

describe('PhpDiContainerProvider', () => {
    describe('matchFile', () => {
        it('matches containerBuilder.php', () => {
            expect(provider.matchFile('config/containerBuilder.php', 'containerBuilder.php')).toBe(true);
        });

        it('matches container.php', () => {
            expect(provider.matchFile('config/container.php', 'container.php')).toBe(true);
        });

        it('matches dependencies.php (Slim convention)', () => {
            expect(provider.matchFile('config/dependencies.php', 'dependencies.php')).toBe(true);
        });

        it('matches any *.php under config/ (content gate filters)', () => {
            expect(provider.matchFile('config/services.php', 'services.php')).toBe(true);
            expect(provider.matchFile('config/monolog.php', 'monolog.php')).toBe(true);
        });

        it('rejects non-config PHP', () => {
            expect(provider.matchFile('src/Controller/Foo.php', 'Foo.php')).toBe(false);
        });
    });

    describe('contentSignatures', () => {
        it('matches ->addDefinitions(', () => {
            expect(provider.contentSignatures.some(r => r.test('$container->addDefinitions([])'))).toBe(true);
        });
        it('matches DI\\ContainerBuilder reference', () => {
            expect(provider.contentSignatures.some(r => r.test('new \\DI\\ContainerBuilder()'))).toBe(true);
        });
    });

    describe('direct binding: return new ConcreteClass(...)', () => {
        it('extracts self-binding with new expression', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    \\Acme\\Foo::class => static function ($c) {
        return new \\Acme\\Foo($c->get(\\Acme\\Bar::class));
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'Acme\\Foo',
                boundComponent: 'Acme\\Foo',
            });
        });

        it('extracts factory-style binding (different concrete)', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    \\Acme\\FooInterface::class => static function ($c) {
        return new \\Acme\\Impl\\ConcreteFoo();
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0].key).toBe('Acme\\FooInterface');
            expect(out[0].boundComponent).toBe('Acme\\Impl\\ConcreteFoo');
        });

        it('resolves bare names via use imports', () => {
            const out = extract(`<?php
namespace App\\Config;

use Acme\\Mail\\Mailer;
use Acme\\Mail\\MailerInterface;

$builder->addDefinitions([
    MailerInterface::class => static function ($c) {
        return new Mailer();
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0].key).toBe('Acme\\Mail\\MailerInterface');
            expect(out[0].boundComponent).toBe('Acme\\Mail\\Mailer');
        });
    });

    describe('alias chain: return $c->get(\\Foo::class)', () => {
        it('extracts class alias', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    \\Acme\\FooInterface::class => static function ($c) {
        return $c->get(\\Acme\\ConcreteFoo::class);
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'Acme\\FooInterface',
                boundComponent: 'Acme\\ConcreteFoo',
            });
        });

        it('extracts string-id alias', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    \\Acme\\LegacyAlias::class => static function ($c) {
        return $c->get('acme.legacy.service');
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0].key).toBe('Acme\\LegacyAlias');
            expect(out[0].aliasTarget).toBe('acme.legacy.service');
            expect(out[0].boundComponent).toBeUndefined();
        });
    });

    describe('out-of-scope shapes (LLM fallback)', () => {
        it('skips entry with multiple distinct `return new X` (conditional)', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    \\Acme\\Cache::class => static function ($c) {
        if ($c->get('config')['cache']['enabled']) {
            return new \\Acme\\RealCache();
        }
        return new \\Acme\\NullCache();
    },
]);`);
            expect(out).toHaveLength(0);
        });

        it('skips entry with no recognisable return shape', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    \\Acme\\Logger::class => static function ($c) {
        $logger = new \\Monolog\\Logger();
        $logger->pushHandler(new \\Monolog\\Handler\\StreamHandler());
        return $logger;
    },
]);`);
            // Pattern A matches new \Monolog\Logger() as the only top-level `return new`
            // — but we have 2 new expressions. The `return new` regex anchors on
            // `return\s+new`, so only the actual return statement matches.
            // Verify: 1 binding extracted (Acme\Logger → Monolog\Logger).
            // Actually — there's no `return new \Monolog\Logger()` literal; the
            // logger is returned as a $variable. The direct path won't match.
            // Result: 0 bindings (closure too complex).
            expect(out).toHaveLength(0);
        });
    });

    describe('useAutowiring detection', () => {
        it('marks autowireEnabled=true when ->useAutowiring(true) is present', () => {
            const out = extract(`<?php
$builder = new \\DI\\ContainerBuilder();
$builder->useAutowiring(true);
$builder->addDefinitions([
    \\Acme\\Foo::class => static function ($c) {
        return new \\Acme\\Foo();
    },
]);`);
            expect(out[0].autowireEnabled).toBe(true);
        });

        it('marks autowireEnabled=false otherwise', () => {
            const out = extract(`<?php
$builder = new \\DI\\ContainerBuilder();
$builder->addDefinitions([
    \\Acme\\Foo::class => static function ($c) {
        return new \\Acme\\Foo();
    },
]);`);
            expect(out[0].autowireEnabled).toBe(false);
        });
    });

    describe('cap on bindings per file', () => {
        it('processes up to 500 entries (DoS guard)', () => {
            const entries = Array.from({ length: 600 }, (_, i) =>
                `\\Acme\\Svc${i}::class => static function ($c) { return new \\Acme\\Svc${i}(); },`,
            ).join('\n');
            const out = extract(`<?php\n$builder->addDefinitions([\n${entries}\n]);`);
            expect(out.length).toBeLessThanOrEqual(500);
        });
    });

    describe('smoke: real acme-monolith shape', () => {
        it('handles cascading alias entries (EntityManagerInterface → EntityManager → ...)', () => {
            const out = extract(`<?php
return static function (array $config): \\DI\\ContainerBuilder {
    $containerBuilder = new \\DI\\ContainerBuilder();
    $containerBuilder->useAutowiring(true);

    $containerBuilder->addDefinitions([
        \\Doctrine\\ORM\\EntityManagerInterface::class => static function ($c) {
            return $c->get(\\Acme\\Doctrine\\EntityManager::class);
        },

        \\Doctrine\\ORM\\EntityManager::class => static function ($c) {
            return $c->get(\\Doctrine\\ORM\\EntityManagerInterface::class);
        },

        \\Acme\\Doctrine\\EntityManager::class => static function ($c) {
            return new \\Acme\\Doctrine\\EntityManager($c->get('config'));
        },
    ]);

    return $containerBuilder;
};`);
            expect(out).toHaveLength(3);
            const byKey = new Map(out.map(b => [b.key, b]));
            // Interface aliases to concrete via $c->get chain
            expect(byKey.get('Doctrine\\ORM\\EntityManagerInterface')?.boundComponent)
                .toBe('Acme\\Doctrine\\EntityManager');
            // EntityManager aliases to the Interface (acme-monolith shape)
            expect(byKey.get('Doctrine\\ORM\\EntityManager')?.boundComponent)
                .toBe('Doctrine\\ORM\\EntityManagerInterface');
            // The concrete is a self-binding
            expect(byKey.get('Acme\\Doctrine\\EntityManager')?.boundComponent)
                .toBe('Acme\\Doctrine\\EntityManager');
        });
    });

    // ─── String-keyed entries + positional ctor scalars (Stage 2) ──────────────
    // PHP-DI also supports STRING service ids (`'topic.publisher' => fn`), and the
    // factory often injects a config literal positionally
    // (`new Publisher($client, 'acme.payment.received', $logger)`). We capture the
    // string key verbatim (NOT FQCN-resolved) and the positional STRING-literal
    // ctor args, skipping object args (`new X()`, `$c->get(...)`).
    describe('string-keyed entries', () => {
        it('captures a string service-id key verbatim (no FQCN resolution)', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    'notpurchasable.publisher' => static function ($c) {
        return new \\Acme\\Streaming\\StreamingPublisher();
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0].key).toBe('notpurchasable.publisher');
            expect(out[0].boundComponent).toBe('Acme\\Streaming\\StreamingPublisher');
        });
    });

    describe('positional ctor scalars', () => {
        it('captures a string literal at its arg position, skipping object args', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    'notpurchasable.publisher' => static function ($c) {
        return new \\Acme\\Streaming\\StreamingPublisher(
            new \\Google\\Cloud\\PubSub\\PubSubClient(['projectId' => 'p']),
            'acme-inventory-streaming-not-purchasable',
            $c->get(\\Psr\\Log\\LoggerInterface::class)
        );
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0].ctorScalars).toEqual([
                { position: 1, value: 'acme-inventory-streaming-not-purchasable' },
            ]);
        });

        it('omits ctorScalars when the new expression has only object args', () => {
            const out = extract(`<?php
$builder->addDefinitions([
    \\Acme\\Foo::class => static function ($c) {
        return new \\Acme\\Foo($c->get(\\Acme\\Bar::class));
    },
]);`);
            expect(out).toHaveLength(1);
            expect(out[0].ctorScalars ?? []).toEqual([]);
        });
    });
});
