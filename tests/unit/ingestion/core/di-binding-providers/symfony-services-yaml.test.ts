import { describe, it, expect } from 'vitest';
import { SymfonyServicesYamlProvider } from '../../../../../src/ingestion/core/di-binding-providers/symfony-services-yaml.js';

const provider = new SymfonyServicesYamlProvider();

function extract(content: string, relativePath = 'config/services.yaml') {
    return provider.extractDiBindings(content, {
        relativePath,
        repoRoot: '/tmp/acme',
        repoName: 'acme',
    });
}

describe('SymfonyServicesYamlProvider', () => {
    describe('matchFile', () => {
        it('matches config/services.yaml', () => {
            expect(provider.matchFile('config/services.yaml', 'services.yaml')).toBe(true);
            expect(provider.matchFile('config/services.yml', 'services.yml')).toBe(true);
        });

        it('matches env-specific config/services_prod.yaml', () => {
            expect(provider.matchFile('config/services_prod.yaml', 'services_prod.yaml')).toBe(true);
        });

        it('matches config/packages/*.yaml', () => {
            expect(provider.matchFile('config/packages/framework.yaml', 'framework.yaml')).toBe(true);
        });

        it('rejects unrelated YAML files', () => {
            expect(provider.matchFile('docker-compose.yml', 'docker-compose.yml')).toBe(false);
            expect(provider.matchFile('.github/workflows/ci.yml', 'ci.yml')).toBe(false);
        });
    });

    describe('contentSignatures', () => {
        it('matches `services:` at column 0', () => {
            const sig = provider.contentSignatures[0];
            expect(sig.test('services:\n  app.foo: ...\n')).toBe(true);
            expect(sig.test('framework:\n  messenger:\n')).toBe(false);
        });
    });

    describe('explicit service entries', () => {
        it('parses serviceId with explicit class', () => {
            const out = extract(`
services:
  acme.notification.publisher:
    class: Acme\\Messaging\\NotificationPublisher
`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'acme.notification.publisher',
                boundComponent: 'Acme\\Messaging\\NotificationPublisher',
                autowireEnabled: false,
                sourceFile: 'config/services.yaml',
            });
        });

        it('infers self-binding for FQCN key without explicit class', () => {
            const out = extract(`
services:
  Acme\\Messaging\\NotificationPublisher: ~
`);
            expect(out).toHaveLength(1);
            expect(out[0].key).toBe('Acme\\Messaging\\NotificationPublisher');
            expect(out[0].boundComponent).toBe('Acme\\Messaging\\NotificationPublisher');
        });
    });

    describe('alias entries', () => {
        it('parses interface → serviceId alias', () => {
            const out = extract(`
services:
  Acme\\Messaging\\PublisherInterface: '@acme.notification.publisher'
`);
            expect(out).toHaveLength(1);
            expect(out[0].key).toBe('Acme\\Messaging\\PublisherInterface');
            expect(out[0].aliasTarget).toBe('acme.notification.publisher');
            expect(out[0].boundComponent).toBeUndefined();
        });
    });

    describe('resource: namespace registration', () => {
        it('parses `App\\: { resource: ../src/ }`', () => {
            const out = extract(`
services:
  Acme\\:
    resource: '../src/'
    exclude: '../src/Tests'
`);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                key: 'Acme\\',
                resourcePrefix: 'Acme\\',
                exclude: ['../src/Tests'],
            });
        });

        it('handles list-form exclude', () => {
            const out = extract(`
services:
  Acme\\:
    resource: '../src/'
    exclude:
      - '../src/Tests'
      - '../src/Migrations'
`);
            expect(out[0].exclude).toEqual(['../src/Tests', '../src/Migrations']);
        });
    });

    describe('_defaults autowiring propagation', () => {
        it('applies autowire: true from _defaults to all entries', () => {
            const out = extract(`
services:
  _defaults:
    autowire: true
    autoconfigure: true
  acme.publisher:
    class: Acme\\Publisher
  acme.consumer:
    class: Acme\\Consumer
`);
            expect(out).toHaveLength(2);
            expect(out.every(b => b.autowireEnabled === true)).toBe(true);
        });

        it('allows per-entry autowire override', () => {
            const out = extract(`
services:
  _defaults:
    autowire: false
  acme.consumer:
    class: Acme\\Consumer
    autowire: true
`);
            expect(out[0].autowireEnabled).toBe(true);
        });
    });

    describe('out-of-scope shapes', () => {
        it('skips factory: declarations (fall back to LLM)', () => {
            const out = extract(`
services:
  acme.dynamic.publisher:
    class: Acme\\Publisher
    factory: ['@acme.publisher_factory', 'create']
`);
            expect(out).toHaveLength(0);
        });

        it('skips synthetic: true services', () => {
            const out = extract(`
services:
  kernel:
    class: Acme\\Kernel
    synthetic: true
`);
            expect(out).toHaveLength(0);
        });

        it('skips class with env-derived template', () => {
            const out = extract(`
services:
  acme.adapter:
    class: '%env(ADAPTER_CLASS)%'
`);
            expect(out).toHaveLength(0);
        });
    });

    describe('malformed input', () => {
        it('returns [] on invalid YAML', () => {
            const out = extract('services:\n  : bad\n  - mixed\n   indent');
            expect(out).toEqual([]);
        });

        it('returns [] when services: block missing', () => {
            const out = extract(`
framework:
  messenger:
    routing:
      App\\Order: orders
`);
            expect(out).toEqual([]);
        });
    });

    describe('cap on bindings per file', () => {
        it('processes up to 500 entries (DoS guard)', () => {
            const entries = Array.from({ length: 600 }, (_, i) =>
                `  acme.svc${i}:\n    class: Acme\\Svc${i}`,
            ).join('\n');
            const out = extract(`services:\n${entries}`);
            expect(out.length).toBeLessThanOrEqual(500);
        });
    });

    describe('Symfony custom YAML tags', () => {
        it('does not crash on !tagged_iterator (parses other bindings)', () => {
            const out = extract(`
services:
  acme.publisher:
    class: Acme\\Publisher
  acme.handler_registry:
    class: Acme\\HandlerRegistry
    arguments:
      - !tagged_iterator acme.handler
`);
            expect(out.length).toBeGreaterThanOrEqual(1);
            expect(out.some(b => b.key === 'acme.publisher')).toBe(true);
        });

        it('survives !service_locator and !tagged forms', () => {
            const out = extract(`
services:
  acme.locator:
    class: Acme\\Locator
    arguments:
      - !service_locator
          acme.foo: '@acme.foo'
  acme.foo:
    class: Acme\\Foo
`);
            expect(out.length).toBeGreaterThanOrEqual(1);
            expect(out.some(b => b.key === 'acme.foo')).toBe(true);
        });
    });

    describe('resource: path resolution', () => {
        it('resolves relative path against the yaml file location', () => {
            const out = extract(`
services:
  Acme\\:
    resource: '../src/'
`, 'config/services.yaml');
            expect(out).toHaveLength(1);
            expect(out[0].resourcePath).toBe('src/');
        });

        it('strips trailing glob', () => {
            const out = extract(`
services:
  Acme\\:
    resource: '../src/*'
`, 'config/services.yaml');
            expect(out[0].resourcePath).toBe('src/');
        });

        it('handles subdirectory paths', () => {
            const out = extract(`
services:
  Acme\\Domain\\:
    resource: '../src/Domain'
`, 'config/services.yaml');
            expect(out[0].resourcePath).toBe('src/Domain/');
        });

        it('skips absolute paths (non-portable)', () => {
            const out = extract(`
services:
  Acme\\:
    resource: '/abs/path'
`, 'config/services.yaml');
            expect(out[0].resourcePath).toBeUndefined();
        });
    });
});
