import { describe, it, expect } from 'vitest';
import { SymfonyMessengerPhpProvider } from '../../../../../src/ingestion/core/config-value-providers/symfony-messenger-php.js';

const ctx = { relativePath: 'src/Inventory/AmqpConfig.php', repoRoot: '/tmp/repo', repoName: 'repo' };

describe('SymfonyMessengerPhpProvider', () => {
    const provider = new SymfonyMessengerPhpProvider();

    it('extracts routing keys from a PHP class with a routing table (method name irrelevant)', () => {
        const src = `<?php
        namespace Acme\\Inventory;
        use Symfony\\Component\\Messenger\\MessageBusInterface;
        class AmqpConfig {
            public function getMessageMap(): array {
                return [
                    QuoteMessage::class => [
                        'queue_name' => 'acme.inventory.quote.requested',
                        'routing_key' => 'acme.inventory.quote.requested',
                        'handle' => true,
                    ],
                    SaveMessage::class => [
                        'routing_key' => 'acme.inventory.save.requested',
                    ],
                ];
            }
        }`;
        const facts = provider.extractValueFacts(src, ctx);
        // FQCN + short-name variants for each entry, so 4 facts total.
        const byKey = new Map(facts.map(f => [f.key, f]));
        expect(byKey.get('SymfonyMessenger.routing.QuoteMessage')?.value).toBe('acme.inventory.quote.requested');
        expect(byKey.get('SymfonyMessenger.routing.SaveMessage')?.value).toBe('acme.inventory.save.requested');
        expect(byKey.get('SymfonyMessenger.routing.Acme\\Inventory\\QuoteMessage')?.value).toBe('acme.inventory.quote.requested');
        expect(byKey.get('SymfonyMessenger.routing.Acme\\Inventory\\SaveMessage')?.value).toBe('acme.inventory.save.requested');
    });

    it('strips {envSuffix}-style template placeholders to produce a canonical literal', () => {
        const src = `<?php
        namespace Acme\\Messenger;
        use Symfony\\Component\\Messenger\\MessageBusInterface;
        class AmqpConfig {
            public function getMessageMap(): array {
                $envSuffix = $this->getEnvSuffix();
                return [
                    ProductQuoteMessage::class => [
                        'routing_key' => 'acme.inventory' . $envSuffix . '.quote.product.requested',
                    ],
                ];
            }
        }`;
        const facts = provider.extractValueFacts(src, ctx);
        const short = facts.find(f => f.key === 'SymfonyMessenger.routing.ProductQuoteMessage');
        expect(short?.value).toBe('acme.inventory.quote.product.requested');
    });

    it('extracts from an array using queue_name only (no routing_key required)', () => {
        const src = `<?php
        namespace Acme\\Messenger;
        use Symfony\\Component\\Messenger\\MessageBusInterface;
        class AmqpConfig {
            public function buildRoutes(): array {
                return [
                    NotificationMessage::class => [
                        'queue_name' => 'acme.inventory.notification.send',
                    ],
                ];
            }
        }`;
        const facts = provider.extractValueFacts(src, ctx);
        expect(facts.some(f =>
            f.key === 'SymfonyMessenger.routing.NotificationMessage'
            && f.value === 'acme.inventory.notification.send'
        )).toBe(true);
    });

    it('extracts CQRS routing facts regardless of the method name', () => {
        const src = `<?php
        namespace Acme\\Messenger;
        use Symfony\\Component\\Messenger\\MessageBusInterface;
        class AmqpConfig {
            public function whateverCustomerCallsIt(): array {
                return [
                    OrderPlacedEvent::class => [
                        'routing_key' => 'acme.orders.placed',
                    ],
                ];
            }
        }`;
        const facts = provider.extractValueFacts(src, ctx);
        expect(facts.some(f =>
            f.key === 'SymfonyMessenger.routing.OrderPlacedEvent'
            && f.value === 'acme.orders.placed'
        )).toBe(true);
    });

    it('ignores entries whose inner value is a class reference, not a topic string', () => {
        const src = `<?php
        namespace Acme\\Messenger;
        use Symfony\\Component\\Messenger\\MessageBusInterface;
        class HandlerMap {
            public function map(): array {
                return [
                    QuoteMessage::class => [
                        'handler' => QuoteMessageHandler::class,
                    ],
                ];
            }
        }`;
        const facts = provider.extractValueFacts(src, ctx);
        expect(facts).toEqual([]);
    });

    it('returns [] for RBAC/audit-style configs (no messaging signal in file context)', () => {
        const src = `<?php
        namespace Acme\\Security;
        class RbacConfig {
            public function permissions(): array {
                return [
                    CreateOrderCommand::class => 'security.permission.admin',
                    DeleteUserCommand::class => 'audit.event.user_deleted',
                ];
            }
        }`;
        const facts = provider.extractValueFacts(src, ctx);
        expect(facts).toEqual([]);
    });

    it('emits FQCN fact when namespace is bracketed (PHP 5.3+ syntax)', () => {
        const src = `<?php
        namespace Acme\\B2B\\Message {
            class AmqpConfig {
                public function map(): array {
                    return [
                        UpdateCustomerCommand::class => [
                            'routing_key' => 'b2b.customer.update',
                        ],
                    ];
                }
            }
            class MessengerBus {}
        }`;
        const facts = provider.extractValueFacts(src, ctx);
        expect(facts.some(f => f.key === 'SymfonyMessenger.routing.Acme\\B2B\\Message\\UpdateCustomerCommand')).toBe(true);
        expect(facts.some(f => f.key === 'SymfonyMessenger.routing.UpdateCustomerCommand')).toBe(true);
    });

    it('returns [] for files without CQRS class-to-topic mapping (cheap content-signature filter)', () => {
        const facts = provider.extractValueFacts(
            '<?php class Foo { public function bar(): void {} }',
            ctx,
        );
        expect(facts).toEqual([]);
    });
});
