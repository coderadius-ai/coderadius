import { describe, it, expect } from 'vitest';
import {
    phpInferBrokerTechnology,
    phpRecognizesDocumentCollectionAccess,
    phpRecognizesDocumentCollectionContainer,
    phpRecognizesInProcessEvent,
    phpRecognizesPublishPayloadConstruction,
} from '../../../../../../src/ingestion/core/languages/php/sanitizer-evidence.js';

// Parity pins for the PHP grammar moved out of the global sanitizer: each
// predicate must behave EXACTLY like its former inline counterpart.

describe('phpRecognizesInProcessEvent', () => {
    const DISPATCH_SRC = '$this->eventDispatcher->dispatch(new OrderPlacedEvent($id));';

    it('recognizes *Event dispatched via EventDispatcher with no AMQP marker', () => {
        expect(phpRecognizesInProcessEvent('OrderPlacedEvent', DISPATCH_SRC)).toBe(true);
    });

    it('matches the interface type name too (EventDispatcherInterface)', () => {
        const src = 'public function __construct(private EventDispatcherInterface $d) {} $this->d->dispatch(new OrderPlacedEvent());';
        expect(phpRecognizesInProcessEvent('OrderPlacedEvent', src)).toBe(true);
    });

    it('AMQP marker wins: Messenger + EventDispatcher coexisting keeps the channel', () => {
        const src = `${DISPATCH_SRC}\n$this->bus = $messageBus; // MessageBusInterface`;
        expect(phpRecognizesInProcessEvent('OrderPlacedEvent', src)).toBe(false);
    });

    it('non-*Event names never match', () => {
        expect(phpRecognizesInProcessEvent('order.created', DISPATCH_SRC)).toBe(false);
    });

    it('no dispatcher evidence → no match', () => {
        expect(phpRecognizesInProcessEvent('OrderPlacedEvent', '$x = 1;')).toBe(false);
    });
});

describe('phpRecognizesPublishPayloadConstruction', () => {
    it('recognizes ->publish(new <Name>) including namespaced and batch variants', () => {
        expect(phpRecognizesPublishPayloadConstruction(
            'OrderPlacedEvent', '$this->publisher->publish(new OrderPlacedEvent($id));',
        )).toBe(true);
        expect(phpRecognizesPublishPayloadConstruction(
            'OrderPlacedEvent', '$p->publishMessage(new \\Acme\\Orders\\OrderPlacedEvent($id));',
        )).toBe(true);
    });

    it('abstract-bus ->dispatch(new X) is NOT matched (class IS the routing contract there)', () => {
        expect(phpRecognizesPublishPayloadConstruction(
            'OrderMessage', '$bus->dispatch(new OrderMessage($id));',
        )).toBe(false);
    });

    it('name absent from the publish call → no match', () => {
        expect(phpRecognizesPublishPayloadConstruction(
            'ShipmentEvent', '$this->publisher->publish(new OrderPlacedEvent($id));',
        )).toBe(false);
    });
});

describe('phpRecognizesDocumentCollectionContainer / Access', () => {
    const SRC = "$col = $client->selectCollection('archive', 'order_events');";

    it('recognizes a container named as a selectCollection argument', () => {
        expect(phpRecognizesDocumentCollectionContainer('order_events', SRC)).toBe(true);
    });

    it('dynamic stub matches by literal prefix', () => {
        const src = `$client->selectCollection('archive', 'quote_' . $kind);`;
        expect(phpRecognizesDocumentCollectionContainer('quote_{kind}', src)).toBe(true);
    });

    it('a SQL table in the same mixed function is NOT matched', () => {
        const mixed = `${SRC}\n$pdo->query('INSERT INTO order_lines VALUES (1)');`;
        expect(phpRecognizesDocumentCollectionContainer('order_lines', mixed)).toBe(false);
    });

    it('short prefixes (<3 chars) never match', () => {
        expect(phpRecognizesDocumentCollectionContainer('ab{kind}', SRC)).toBe(false);
    });

    it('access predicate fires on any ->selectCollection( call', () => {
        expect(phpRecognizesDocumentCollectionAccess(SRC)).toBe(true);
        expect(phpRecognizesDocumentCollectionAccess('$pdo->query("SELECT 1");')).toBe(false);
    });
});

describe('phpInferBrokerTechnology', () => {
    it.each([
        ['use PhpAmqpLib\\Channel\\AMQPChannel;', 'rabbitmq'],
        ['use Google\\Cloud\\PubSub\\PubSubClient;', 'pubsub'],
        ['composer require symfony/messenger', 'symfony-messenger'],
        ['$producer = new \\RdKafka\\Producer();', 'kafka'],
    ])('infers from %s → %s', (src, tech) => {
        expect(phpInferBrokerTechnology(src)).toBe(tech);
    });

    it('returns undefined with no marker', () => {
        expect(phpInferBrokerTechnology('$pdo->query("SELECT 1");')).toBeUndefined();
    });

    it('first match wins on mixed sources (pubsub before rabbitmq)', () => {
        const src = 'use Google\\Cloud\\PubSub\\PubSubClient; use PhpAmqpLib\\Channel\\AMQPChannel;';
        expect(phpInferBrokerTechnology(src)).toBe('pubsub');
    });
});
