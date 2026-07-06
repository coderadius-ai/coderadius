/**
 * PHP source-evidence recognizers consumed by the global sanitizer via
 * LanguagePlugin hooks. Each predicate owns a piece of PHP/Symfony grammar
 * that previously lived inline in the (language-agnostic) sanitizer:
 *
 *   - in-process event dispatch (Symfony EventDispatcher vs Messenger/AMQP)
 *   - publish-payload construction (`->publish(new \Ns\OrderPlacedEvent(...))`)
 *   - MongoDB driver collection access (`->selectCollection(...)`)
 */

// ─── In-process event dispatch ───────────────────────────────────────────────

const EVENT_SUFFIX_RE = /Event$/;
// Case-insensitive: the type name is `EventDispatcherInterface` but the
// property is `eventDispatcher` (camelCase). Either is a strong signal that
// the dispatch target is the in-process EventDispatcher.
const EVENT_DISPATCHER_RE = /event[\s_]?dispatcher/i;
// AMQP / Messenger markers: when both coexist (Messenger + EventDispatcher),
// AMQP wins and the channel survives.
const AMQP_MARKER_RE = /\b(MessageBusInterface|AMQPMessage|AMQPChannel|AmqpStamp|RoutingKeyStamp|AmqpTransport)\b/;

/**
 * Symfony EventDispatcher (`EventDispatcherInterface::dispatch(new XxxEvent)`)
 * emits synchronous in-process notifications, not broker messages. True when
 * `name` is an `*Event` class and the source shows an event-dispatcher WITHOUT
 * any AMQP marker.
 */
export function phpRecognizesInProcessEvent(name: string, sourceCode: string): boolean {
    if (!EVENT_SUFFIX_RE.test(name)) return false;
    return EVENT_DISPATCHER_RE.test(sourceCode) && !AMQP_MARKER_RE.test(sourceCode);
}

// ─── Publish-payload construction ────────────────────────────────────────────

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * `$publisher->publish(new OrderPlacedEvent(...))` over a physical transport
 * sends the event as the message BODY; the channel is the topic the publisher
 * targets, resolved elsewhere. Verb-scoped to the physical publish family so
 * an abstract-bus `->dispatch(new OrderMessage())` (where the class IS the
 * routing contract) is NOT matched. Source-evidence required: the name must
 * appear as `->publish|produce|publishMessage|publishBatch(new [\Ns\]<Name>`.
 */
export function phpRecognizesPublishPayloadConstruction(name: string, sourceCode: string): boolean {
    const esc = name.replace(REGEX_ESCAPE_RE, '\\$&');
    const publishPayloadRe = new RegExp(
        `->\\s*(?:publish|produce|publishMessage|publishBatch)\\s*\\(\\s*new\\s+\\\\?(?:[A-Za-z_]\\w*\\\\)*${esc}\\b`,
        'i',
    );
    return publishPayloadRe.test(sourceCode);
}

// ─── MongoDB driver collection access ────────────────────────────────────────

const SELECT_COLLECTION_CALL_RE = /->\s*selectCollection\s*\([^;]{0,200}/g;
const SELECT_COLLECTION_ACCESS_RE = /->\s*selectCollection\s*\(/;

/**
 * True when `sourceCode` shows that DataContainer `name` was produced by the
 * standard MongoDB PHP driver's `selectCollection` (`$client->selectCollection(
 * $db, 'name')` / `$db->selectCollection('name')`). Container-specific: the
 * name — or, for a dynamic stub like `quote_{kind}`, its literal prefix —
 * must appear as a `selectCollection` argument. A SQL table in the same mixed
 * function appears in a SQL string (not `selectCollection`), so it is not
 * matched. `selectCollection` is a standard SDK method (not a customer
 * wrapper), so this is a general Mongo signal, not an overfit.
 */
export function phpRecognizesDocumentCollectionContainer(name: string, sourceCode: string): boolean {
    const calls = sourceCode.match(SELECT_COLLECTION_CALL_RE);
    if (!calls) return false;
    // Strip a trailing `{placeholder}` (and anything after) → the literal prefix.
    const prefix = name.replace(/\{[^}]*\}.*$/, '');
    if (prefix.length < 3) return false;
    return calls.join(' ').includes(prefix);
}

/**
 * True when the source performs ANY MongoDB driver collection access
 * (`->selectCollection(`). Used to reclassify an LLM "MessageChannel" whose
 * function actually reads/writes a Mongo collection.
 */
export function phpRecognizesDocumentCollectionAccess(sourceCode: string): boolean {
    return SELECT_COLLECTION_ACCESS_RE.test(sourceCode);
}

// ─── Broker technology inference ─────────────────────────────────────────────

/** Ordered (first match wins) PHP-ecosystem SDK markers → technology.
 *  Includes the AWS/Azure PHP SDK class names (SqsClient/SnsClient/
 *  ServiceBusClient) and the bare `nats` client marker. */
const PHP_BROKER_TECH_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
    [/Google\\Cloud\\PubSub|PubSubClient/i, 'pubsub'],
    [/PhpAmqpLib|php-amqplib|AMQPChannel|AMQPMessage/i, 'rabbitmq'],
    [/rdkafka|confluent/i, 'kafka'],
    [/SQSClient/i, 'sqs'],
    [/SNSClient/i, 'sns'],
    [/azure.*service-bus|ServiceBusClient/i, 'azure-service-bus'],
    [/symfony\/messenger|Symfony\\.*Messenger/i, 'symfony-messenger'],
    [/nats/i, 'nats'],
];

export function phpInferBrokerTechnology(sourceCode: string): string | undefined {
    for (const [pattern, tech] of PHP_BROKER_TECH_SIGNALS) {
        if (pattern.test(sourceCode)) return tech;
    }
    return undefined;
}
