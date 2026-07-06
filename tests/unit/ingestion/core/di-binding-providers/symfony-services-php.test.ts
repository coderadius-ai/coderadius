import { describe, it, expect } from 'vitest';
import { SymfonyServicesPhpProvider } from '../../../../../src/ingestion/core/di-binding-providers/symfony-services-php.js';

const provider = new SymfonyServicesPhpProvider();

function extract(content: string, relativePath = 'config/services.php') {
    return provider.extractDiBindings(content, {
        relativePath,
        repoRoot: '/tmp/acme',
        repoName: 'acme',
    });
}

describe('SymfonyServicesPhpProvider', () => {
    describe('matchFile', () => {
        it('matches config/services.php', () => {
            expect(provider.matchFile('config/services.php', 'services.php')).toBe(true);
        });

        it('matches config/services_prod.php', () => {
            expect(provider.matchFile('config/services_prod.php', 'services_prod.php')).toBe(true);
        });

        it('rejects non-config php files', () => {
            expect(provider.matchFile('src/Controller/Foo.php', 'Foo.php')).toBe(false);
        });
    });

    describe('contentSignatures', () => {
        const sig = provider.contentSignatures;
        it('matches ContainerConfigurator import', () => {
            expect(sig.some(r => r.test('use Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\ContainerConfigurator;'))).toBe(true);
        });
        it('matches Symfony DI namespace', () => {
            expect(sig.some(r => r.test('use Symfony\\\\Component\\\\DependencyInjection;'))).toBe(true);
        });
    });

    describe('->set(id, Class::class)', () => {
        it('parses explicit set with two args', () => {
            const out = extract(`<?php
return function (ContainerConfigurator $container) {
  $services = $container->services();
  $services->set('acme.notification.publisher', NotificationPublisher::class);
};`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'acme.notification.publisher',
                boundComponent: 'NotificationPublisher',
                autowireEnabled: false,
            });
        });

        it('strips leading backslash from FQCN', () => {
            const out = extract(`<?php
$services->set('acme.mailer', \\Acme\\Mail\\Mailer::class);
`);
            expect(out).toHaveLength(1);
            expect(out[0].boundComponent).toBe('Acme\\Mail\\Mailer');
        });
    });

    describe('->set(Class::class) self-binding', () => {
        it('parses single-arg self-binding', () => {
            const out = extract(`<?php
$services->set(Acme\\Messaging\\NotificationPublisher::class);
`);
            expect(out).toHaveLength(1);
            expect(out[0].key).toBe('Acme\\Messaging\\NotificationPublisher');
            expect(out[0].boundComponent).toBe('Acme\\Messaging\\NotificationPublisher');
        });

        it('does not double-count when SET_WITH_CLASS already matched', () => {
            const out = extract(`<?php
$services->set('acme.pub', NotificationPublisher::class);
$services->set(MailerInterface::class);
`);
            expect(out).toHaveLength(2);
            const keys = out.map(b => b.key);
            expect(keys).toContain('acme.pub');
            expect(keys).toContain('MailerInterface');
        });
    });

    describe('->alias(...)', () => {
        it('parses alias with string key', () => {
            const out = extract(`<?php
$services->alias('PublisherInterface', 'acme.notification.publisher');
`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'PublisherInterface',
                aliasTarget: 'acme.notification.publisher',
            });
        });

        it('parses alias with FQCN::class key', () => {
            const out = extract(`<?php
$services->alias(Acme\\Messaging\\PublisherInterface::class, 'acme.notification.publisher');
`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'Acme\\Messaging\\PublisherInterface',
                aliasTarget: 'acme.notification.publisher',
            });
        });
    });

    describe('->load(prefix, glob)', () => {
        it('parses resource namespace load', () => {
            const out = extract(`<?php
$services->load('Acme\\\\', '../src/*');
`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'Acme\\\\',
                resourcePrefix: 'Acme\\\\',
                autowireEnabled: true,
            });
        });
    });

    describe('defaults()->autowire() propagation', () => {
        it('flips default autowireEnabled when present', () => {
            const out = extract(`<?php
$services = $container->services()->defaults()->autowire()->autoconfigure();
$services->set('acme.pub', NotificationPublisher::class);
`);
            expect(out).toHaveLength(1);
            expect(out[0].autowireEnabled).toBe(true);
        });
    });

    describe('out-of-scope shapes', () => {
        it('skips file when factory() is present anywhere', () => {
            const out = extract(`<?php
$services->set('acme.pub', NotificationPublisher::class);
$services->set('acme.factory', NotificationFactory::class)->factory([service('app.factory'), 'create']);
`);
            expect(out).toEqual([]);
        });

        it('skips file when synthetic() is present', () => {
            const out = extract(`<?php
$services->set('kernel', Kernel::class)->synthetic();
`);
            expect(out).toEqual([]);
        });
    });

    describe('cap on bindings per file', () => {
        it('processes up to 500 entries', () => {
            const entries = Array.from({ length: 600 }, (_, i) =>
                `$services->set('acme.svc${i}', Svc${i}::class);`,
            ).join('\n');
            const out = extract(`<?php\n${entries}`);
            expect(out.length).toBeLessThanOrEqual(500);
        });
    });
});
