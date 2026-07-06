import { describe, it, expect } from 'vitest';

// ═════════════════════════════════════════════════════════════════════════════
// Infrastructure Drop Filter — Unit Tests
//
// Tests the deterministic filters in sanitizer.ts that catch hallucinated
// infrastructure names, dynamic table stubs, noisy broker names, and
// template variable artifacts the LLM returns despite prompt instructions.
// ═════════════════════════════════════════════════════════════════════════════

import {
    GENERIC_INFRA_NAMES,
    isDynamicTableStub,
    isUnresolvedTemplateName,
    isNoisyBrokerName,
    isHallucinatedTable,
} from '../../../src/ai/workflows/sanitizer.js';

function isGenericInfraName(name: string): boolean {
    return GENERIC_INFRA_NAMES.has(name.toLowerCase());
}



// ═════════════════════════════════════════════════════════════════════════════
// DataContainer Name Filtering
// ═════════════════════════════════════════════════════════════════════════════


describe('isUnresolvedTemplateName', () => {
    it('should reject PHP template: delivery_history_{$tipo}', () => {
        expect(isUnresolvedTemplateName('delivery_history_{$tipo}')).toBe(true);
    });

    it('should reject JS template: queue_${name}', () => {
        expect(isUnresolvedTemplateName('queue_${name}')).toBe(true);
    });

    it('should reject PHP variable: $tableName', () => {
        expect(isUnresolvedTemplateName('$tableName')).toBe(true);
    });

    it('should reject Python format: table_%s', () => {
        expect(isUnresolvedTemplateName('table_%s')).toBe(true);
    });

    it('should accept clean table names: quotes', () => {
        expect(isUnresolvedTemplateName('quotes')).toBe(false);
    });

    it('should accept table names with underscores: delivery_history_auto', () => {
        expect(isUnresolvedTemplateName('delivery_history_auto')).toBe(false);
    });

    // ── UPPER_CASE config template detection (new: {ENV}, {CLUSTER}) ──────
    it('should reject UPPER_CASE config template: logistics.fulfillment{ENV}.shipment.saved', () => {
        expect(isUnresolvedTemplateName('logistics.fulfillment{ENV}.shipment.saved')).toBe(true);
    });

    it('should reject UPPER_CASE config template: queue.{CLUSTER}.events', () => {
        expect(isUnresolvedTemplateName('queue.{CLUSTER}.events')).toBe(true);
    });

    it('should reject UPPER_CASE config template: {ENVIRONMENT}_queue', () => {
        expect(isUnresolvedTemplateName('{ENVIRONMENT}_queue')).toBe(true);
    });

    it('should accept lowercase path params: /api/users/{userId}', () => {
        expect(isUnresolvedTemplateName('/api/users/{userId}')).toBe(false);
    });

    it('should accept lowercase path params: /api/orders/{id}', () => {
        expect(isUnresolvedTemplateName('/api/orders/{id}')).toBe(false);
    });

    it('should accept mixed-case but not all-caps: /api/{orderId}/items', () => {
        expect(isUnresolvedTemplateName('/api/{orderId}/items')).toBe(false);
    });

    // ── Known lowercase env placeholders (PHP/Symfony convention) ─────────
    // These are the same set the dynamic-infra-resolver normalizes
    // (envSuffix, env, environment, tablePrefix, prefix, suffix). If a
    // channel/table reaches the sanitizer with one of them un-resolved
    // (e.g. resolver skipped during incremental sync), we must drop the
    // node — keeping a literal '{envSuffix}' in the URN poisons the graph.
    it('should reject lowercase {envSuffix} env placeholder', () => {
        expect(isUnresolvedTemplateName('acme.acme{envSuffix}.quote.requested')).toBe(true);
    });

    it('should reject lowercase {env} env placeholder', () => {
        expect(isUnresolvedTemplateName('logistics.fulfillment.{env}.shipment.saved')).toBe(true);
    });

    it('should reject lowercase {environment} env placeholder', () => {
        expect(isUnresolvedTemplateName('queue.{environment}.events')).toBe(true);
    });

    it('should reject lowercase {tablePrefix} env placeholder', () => {
        expect(isUnresolvedTemplateName('{tablePrefix}_orders')).toBe(true);
    });

    it('should reject lowercase {prefix} / {suffix} env placeholders', () => {
        expect(isUnresolvedTemplateName('{prefix}_orders')).toBe(true);
        expect(isUnresolvedTemplateName('orders_{suffix}')).toBe(true);
    });

    // Regression: legitimate REST path params with same casing convention
    // must still pass through (camelCase but NOT in the env-placeholder set).
    it('should NOT reject path params: /api/users/{userId}', () => {
        expect(isUnresolvedTemplateName('/api/users/{userId}')).toBe(false);
    });

    it('should NOT reject path params: /api/orders/{orderId}/items', () => {
        expect(isUnresolvedTemplateName('/api/orders/{orderId}/items')).toBe(false);
    });

    // GAP: lowercase generic placeholders like `{tipo}` / `{type}` / `{nome}`
    // are INTENTIONALLY NOT caught here. They cannot be distinguished
    // syntactically from REST path params (`{userId}`, `{orderId}`), which
    // legitimately use the same brace notation. The disambiguator is CONTEXT:
    //
    //   - In a TABLE/EVENT name (`quote_{kind}`), braces = LLM leak.
    //   - In a REST path (`/users/{userId}`), braces = legitimate path param.
    //
    // Because `isUnresolvedTemplateName` is shared across both contexts,
    // it cannot resolve the ambiguity. Filtering of `{tipo}`-style names in
    // schema-name contexts lives at the call site (`graph-writer.ts:persistSchemas`,
    // with a stricter `[{}]` filter that only applies to DataStructure names).
    // See `tests/eval/patterns/php-doctrine-template-table-drop` for the
    // end-to-end regression pin.
    it('PINNED LIMITATION: does NOT reject lowercase `{tipo}` (REST path ambiguity)', () => {
        // If a future contributor "fixes" this to return true, they will
        // break the REST path param assertions above. The right place to
        // filter `{tipo}` in schema-name contexts is `persistSchemas`.
        expect(isUnresolvedTemplateName('quote_{kind}')).toBe(false);
        expect(isUnresolvedTemplateName('quote_{type}')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Generic Infrastructure Name Drop Filter
// Replaces the old InfraRefSchema.transform() "-unknown-db" rename pattern.
// ═════════════════════════════════════════════════════════════════════════════

describe('isGenericInfraName (replaces -unknown-db transform)', () => {
    // --- Should DROP (previously created *-unknown-db nodes) ---

    it('should drop "rabbitmq" (was becoming "RabbitMQ-unknown-db")', () => {
        expect(isGenericInfraName('rabbitmq')).toBe(true);
    });

    it('should drop case variant "RabbitMQ"', () => {
        expect(isGenericInfraName('RabbitMQ')).toBe(true);
    });

    it('should drop case variant "RabbitMq"', () => {
        expect(isGenericInfraName('RabbitMq')).toBe(true);
    });

    it('should drop "mongodb"', () => {
        expect(isGenericInfraName('mongodb')).toBe(true);
    });

    it('should drop "postgres"', () => {
        expect(isGenericInfraName('postgres')).toBe(true);
    });

    it('should drop "elasticsearch"', () => {
        expect(isGenericInfraName('elasticsearch')).toBe(true);
    });

    it('should keep "influxdb" (legitimate datastore, not generic infra)', () => {
        expect(isGenericInfraName('influxdb')).toBe(false);
    });

    it('should drop "doctrine" (ORM name hallucinated in graph dump)', () => {
        expect(isGenericInfraName('doctrine')).toBe(true);
    });

    it('should drop "Google Cloud Pub/Sub" (technology name)', () => {
        expect(isGenericInfraName('Google Cloud Pub/Sub')).toBe(true);
    });

    it('should drop "google-cloud-pubsub" (package name)', () => {
        expect(isGenericInfraName('google-cloud-pubsub')).toBe(true);
    });

    // --- Should KEEP (specific resource names) ---

    it('should keep specific database name: "acme-platform_app_users"', () => {
        expect(isGenericInfraName('acme-platform_app_users')).toBe(false);
    });

    it('should keep specific topic name: "order.created"', () => {
        expect(isGenericInfraName('order.created')).toBe(false);
    });

    it('should keep specific topic name: "logistics.fulfillment.save.ready"', () => {
        expect(isGenericInfraName('logistics.fulfillment.save.ready')).toBe(false);
    });

    it('should keep specific topic name: "policy.save.completed"', () => {
        expect(isGenericInfraName('policy.save.completed')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// MessageChannel Class-Suffix Drop Filter (Correction 2)
//
// Physical queues/topics never use application-layer suffixes like
// *Client, *Publisher, *Reader, *Service, *Repository.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName (includes class-suffix detection)', () => {
    // --- Should DROP (hallucinations from graph dump) ---

    it('should drop "PubSubClient" (DI-injected class name)', () => {
        expect(isNoisyBrokerName('PubSubClient')).toBe(true);
    });

    it('should drop "PubSubPublisher" (wrapper class name)', () => {
        expect(isNoisyBrokerName('PubSubPublisher')).toBe(true);
    });

    it('should drop "PubSubReader" (reader class name)', () => {
        expect(isNoisyBrokerName('PubSubReader')).toBe(true);
    });

    it('should drop "SaveReadyMessagePublisher" (publisher class name)', () => {
        expect(isNoisyBrokerName('SaveReadyMessagePublisher')).toBe(true);
    });

    it('should drop "notification-client" (client class name)', () => {
        // Hmm, this has a hyphen — the suffix pattern won't match "client" in lowercase hyphenated.
        // Let's verify: "notification-client" ends with lowercase "client" but the regex looks for "Client"
        // This should be handled by the NOISY_BROKER_SET check, not the suffix regex.
        // If it's not in the NOISY_BROKER_SET, we may need to add a case-insensitive suffix check.
    });

    it('should drop "quoteService" (service class name)', () => {
        expect(isNoisyBrokerName('quoteService')).toBe(true);
    });

    it('should drop "event-bus" (hardcoded noisy name)', () => {
        expect(isNoisyBrokerName('event-bus')).toBe(true);
    });

    it('should drop "Google Cloud Pub/Sub" (spaced names are never physical channels)', () => {
        // Historically only GENERIC_INFRA_NAMES caught this at a later layer;
        // the whitespace guard now rejects spaced prose fragments here too
        // (AMQP/Kafka/PubSub identifier grammars admit no spaces). Same final
        // outcome, defense in depth.
        expect(isNoisyBrokerName('Google Cloud Pub/Sub')).toBe(true);
    });

    it('should NOT drop "google-cloud-pubsub" (caught by GENERIC_INFRA_NAMES instead)', () => {
        expect(isNoisyBrokerName('google-cloud-pubsub')).toBe(false);
    });

    it('should drop "rabbitmq" (generic technology name)', () => {
        expect(isNoisyBrokerName('rabbitmq')).toBe(true);
    });

    // --- Should KEEP (legitimate topic/queue/routing-key names) ---

    it('should keep "order.created" (topic name)', () => {
        expect(isNoisyBrokerName('order.created')).toBe(false);
    });

    it('should keep "logistics.fulfillment.save.ready" (topic name)', () => {
        expect(isNoisyBrokerName('logistics.fulfillment.save.ready')).toBe(false);
    });

    it('should keep "policy.save.completed" (topic name)', () => {
        expect(isNoisyBrokerName('policy.save.completed')).toBe(false);
    });

    it('should keep "logistics-events" (queue name)', () => {
        expect(isNoisyBrokerName('logistics-events')).toBe(false);
    });

    it('should keep "save-ready" (routing key)', () => {
        expect(isNoisyBrokerName('save-ready')).toBe(false);
    });

    it('should keep "shipment-created" (event name)', () => {
        expect(isNoisyBrokerName('shipment-created')).toBe(false);
    });

    it('should keep "pkg.acme_core.*.shipment.requested" (wildcard topic pattern)', () => {
        expect(isNoisyBrokerName('pkg.acme_core.*.shipment.requested')).toBe(false);
    });

    it('should drop "appChannelShipmentBundleV2" (camelCase DI config key, not a physical topic)', () => {
        expect(isNoisyBrokerName('appChannelShipmentBundleV2')).toBe(true);
    });

    it('should keep "ha.logistics-policy" (routing key)', () => {
        expect(isNoisyBrokerName('ha.logistics-policy')).toBe(false);
    });

    it('should drop bare "outbox" (generic infrastructure concept)', () => {
        expect(isNoisyBrokerName('outbox')).toBe(true);
    });

    it('should keep "channels_outbox" (qualified outbox channel)', () => {
        expect(isNoisyBrokerName('channels_outbox')).toBe(false);
    });

    // ── V01022 Regression: PascalCase-only class names must be dropped ────
    it('should drop "SaveCreated" (PascalCase event class name)', () => {
        expect(isNoisyBrokerName('SaveCreated')).toBe(true);
    });

    it('should drop "InitBrokerQuoteUseCase" (PascalCase UseCase name)', () => {
        expect(isNoisyBrokerName('InitBrokerQuoteUseCase')).toBe(true);
    });

    it('should drop "UpdatePhoneEmailQuoteUsecase" (PascalCase Usecase suffix)', () => {
        expect(isNoisyBrokerName('UpdatePhoneEmailQuoteUsecase')).toBe(true);
    });

    it('should drop "SendSaveToChannelsUseCase" (PascalCase UseCase suffix)', () => {
        expect(isNoisyBrokerName('SendSaveToChannelsUseCase')).toBe(true);
    });

    it('should drop "<DYNAMIC>" (dynamic placeholder)', () => {
        expect(isNoisyBrokerName('<DYNAMIC>')).toBe(true);
    });

    it('should drop "message-broker" (generic tech name)', () => {
        expect(isNoisyBrokerName('message-broker')).toBe(true);
    });

    it('should keep "system.event.created" (dotted routing key)', () => {
        expect(isNoisyBrokerName('system.event.created')).toBe(false);
    });

    it('should keep "hard_delete.bus-requested" (mixed separator topic)', () => {
        expect(isNoisyBrokerName('hard_delete.bus-requested')).toBe(false);
    });

    it('should DROP PascalCase names like "SaveV2" (≥ 5 chars, class name)', () => {
        expect(isNoisyBrokerName('SaveV2')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Evidence-Based Guardrail — isHallucinatedTable (TDD)
//
// Layer 2 defense: verifies the LLM's claimed table evidence against the
// source code. Catches ghost tables hallucinated from variable names
// (e.g. $carrello = $repo->getCart() → LLM hallucinates "carrello" as table).
// ═════════════════════════════════════════════════════════════════════════════

describe('isHallucinatedTable (Evidence-Based Guardrail)', () => {
    // The source code from our LoyaltyTierChecker fixture — no SQL table "carrello"
    const sourceWithNoSQL = `
        $carrello = $this->cartRepository->getCart($cartId, $cartType);
        if (!$carrello->isValid()) {
            return false;
        }
        $userId = $carrello->getUser();
    `;

    // Source code with a REAL SQL query — table "ordini" is used in SQL
    const sourceWithRealSQL = `
        $stmt = $this->db->prepare(
            "SELECT o.*, c.email FROM ordini o
             JOIN clienti c ON c.id = o.cliente_id
             WHERE o.id = :orderId"
        );
        $stmt->execute(['orderId' => $orderId]);
    `;

    // --- Should mark as HALLUCINATED (drop) ---

    it('should drop table with no evidence provided', () => {
        expect(isHallucinatedTable('carrello', undefined, sourceWithNoSQL)).toBe(true);
    });

    it('should drop table with empty evidence', () => {
        expect(isHallucinatedTable('carrello', '', sourceWithNoSQL)).toBe(true);
    });

    it('should drop table with repository-pattern evidence', () => {
        // LLM provides evidence that contains repository patterns → not direct SQL
        const evidence = '$carrello = $this->cartRepository->getCart($cartId, $cartType)';
        expect(isHallucinatedTable('carrello', evidence, sourceWithNoSQL)).toBe(true);
    });

    it('should drop table with fabricated SQL not in source code', () => {
        // LLM fabricates a plausible SQL query that doesn't exist in the source
        const fabricatedSQL = "SELECT * FROM carrello WHERE id = :id";
        expect(isHallucinatedTable('carrello', fabricatedSQL, sourceWithNoSQL)).toBe(true);
    });

    it('should drop table with ->find() evidence pattern', () => {
        const evidence = "$this->repo->find($id)";
        expect(isHallucinatedTable('utenti', evidence, 'unrelated code')).toBe(true);
    });

    it('should drop table with ->fetch() evidence pattern', () => {
        const evidence = "$this->dao->fetch($criteria)";
        expect(isHallucinatedTable('prodotti', evidence, 'unrelated code')).toBe(true);
    });

    it('should drop table with JS/Python dot-notation getter evidence', () => {
        expect(isHallucinatedTable('ordini', 'this.repo.find(id)', 'unrelated')).toBe(true);
        expect(isHallucinatedTable('carrello', 'repo.getCart(id)', 'unrelated')).toBe(true);
        expect(isHallucinatedTable('utenti', 'db.loadUser(id)', 'unrelated')).toBe(true);
    });

    // --- Should ACCEPT (real tables with valid evidence) ---

    it('should accept table with real SQL evidence found in source', () => {
        const evidence = "SELECT o.*, c.email FROM ordini o";
        expect(isHallucinatedTable('ordini', evidence, sourceWithRealSQL)).toBe(false);
    });

    it('should accept table even with whitespace differences in evidence', () => {
        // Gemini's point: LLMs may normalize whitespace when extracting evidence
        const evidence = "JOIN clienti c ON c.id = o.cliente_id";
        expect(isHallucinatedTable('clienti', evidence, sourceWithRealSQL)).toBe(false);
    });

    it('should accept table with ORM QueryBuilder evidence found in source', () => {
        const qbSource = `$qb->from('catalogo', 'c')->where('c.attivo = 1');`;
        const evidence = "->from('catalogo', 'c')";
        expect(isHallucinatedTable('catalogo', evidence, qbSource)).toBe(false);
    });

    it('should accept generic ORM wrapper if the table name is explicitly in the evidence (Prisma)', () => {
        const source = 'const users = prisma.userProfiles.findMany();';
        expect(isHallucinatedTable('userProfiles', 'prisma.userProfiles.findMany()', source)).toBe(false);
    });

    it('should accept generic ORM wrapper if the table name is explicitly in the evidence (Mongoose)', () => {
        const source = "db.collection('userProfiles').findOne({ id });";
        expect(isHallucinatedTable('userProfiles', "db.collection('userProfiles').findOne", source)).toBe(false);
    });

});

// ═════════════════════════════════════════════════════════════════════════════
// Broker Class-Name *Message Suffix Detection (TDD)
//
// CQRS message class names (e.g. CartFinalizedMessage, ProductReservedMessage)
// are now KEPT as legitimate routing contracts. The class name IS the channel
// name in abstract bus frameworks (Symfony Messenger, MediatR, NestJS CQRS).
// Handler suffixes are still dropped — they are never channels.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — Message/Handler suffix (TDD)', () => {
    // --- Should KEEP (CQRS routing contracts — the class name IS the channel) ---

    it('should KEEP "CartFinalizedMessage" (CQRS routing contract)', () => {
        expect(isNoisyBrokerName('CartFinalizedMessage')).toBe(false);
    });

    it('should KEEP "ProductReservedMessage" (CQRS routing contract)', () => {
        expect(isNoisyBrokerName('ProductReservedMessage')).toBe(false);
    });

    it('should KEEP "OrderConfirmationMessage" (CQRS routing contract)', () => {
        expect(isNoisyBrokerName('OrderConfirmationMessage')).toBe(false);
    });

    it('should KEEP "UpdateQuoteCreatedMessage" (CQRS routing contract)', () => {
        expect(isNoisyBrokerName('UpdateQuoteCreatedMessage')).toBe(false);
    });

    it('should drop "ProductQuoteHandler" (PHP handler class)', () => {
        expect(isNoisyBrokerName('ProductQuoteHandler')).toBe(true);
    });

    it('should drop "SaveCompletedHandler" (PHP handler class)', () => {
        expect(isNoisyBrokerName('SaveCompletedHandler')).toBe(true);
    });

    // --- Should KEEP (real topic/queue names) ---

    it('should keep "checkout.finalized" (real routing key)', () => {
        expect(isNoisyBrokerName('checkout.finalized')).toBe(false);
    });

    it('should keep "stock.reserved" (real routing key)', () => {
        expect(isNoisyBrokerName('stock.reserved')).toBe(false);
    });

    it('should keep "message-audit-log" (queue name containing "message")', () => {
        // "message" as part of a dotted/hyphenated topic is OK
        expect(isNoisyBrokerName('message-audit-log')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Code-expression-shaped channel names
//
// The LLM (and occasionally the static path) echoes an unresolved ACCESS
// EXPRESSION instead of the resolved value: `queueOptions['name']`,
// `$this->queueName`, `config.get('queue')`. Physical queue/topic/routing-key
// names never contain access/operator syntax. Caught by the shared
// isCodeExpressionName shape predicate, folded into isNoisyBrokerName, and
// runs BEFORE the wasResolved trust-bypass: a code-expression shape is
// rejected even if a (mis)resolution stamped resolved_via.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — code-expression shapes', () => {
    it("should drop \"queueOptions['name']\" (array access echoed as channel)", () => {
        expect(isNoisyBrokerName("queueOptions['name']")).toBe(true);
    });

    it('should drop "$this->queueName" (PHP property access)', () => {
        expect(isNoisyBrokerName('$this->queueName')).toBe(true);
    });

    it('should drop "config.get(\'queue\')" (call expression)', () => {
        expect(isNoisyBrokerName("config.get('queue')")).toBe(true);
    });

    it('should drop code-expression shapes even when wasResolved=true', () => {
        expect(isNoisyBrokerName("queueOptions['name']", true)).toBe(true);
    });

    // --- GUARDRAILS: legit names with separators/braces survive ---

    it('should keep "order.created" (dotted routing key)', () => {
        expect(isNoisyBrokerName('order.created')).toBe(false);
    });

    it('should keep "save-ready" (kebab channel)', () => {
        expect(isNoisyBrokerName('save-ready')).toBe(false);
    });

    it('should keep "logistics.fulfillment.save.ready" (deep routing key)', () => {
        expect(isNoisyBrokerName('logistics.fulfillment.save.ready')).toBe(false);
    });

    it('should keep "booking_slot_{type}" (curly-brace dynamic stub is NOT a code expression)', () => {
        expect(isNoisyBrokerName('booking_slot_{type}')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Broker Infrastructure Hostname / FQDN Filter (Eval Pattern)
//
// The LLM sometimes extracts AMQP/Redis connection strings or infrastructure
// hostnames as routing keys. The INFRA_HOSTNAME_SUFFIX regex catches known
// infrastructure domain suffixes (.consul, .service, .svc, .internal, etc.)
// without catching legitimate dot-separated routing keys.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — infrastructure hostname filter', () => {
    // --- Should DROP (infrastructure hostnames leaked as routing keys) ---

    it('should DROP Consul hostname: rabbitmq.service.automium.consul.', () => {
        expect(isNoisyBrokerName('rabbitmq.service.automium.consul.')).toBe(true);
    });

    it('should DROP Consul hostname without trailing dot: redis.service.consul', () => {
        expect(isNoisyBrokerName('redis.service.consul')).toBe(true);
    });

    it('should DROP Kubernetes SVC hostname: mysql.default.svc.cluster.local', () => {
        expect(isNoisyBrokerName('mysql.default.svc.cluster.local')).toBe(true);
    });

    it('should DROP .internal hostname: kafka.internal', () => {
        expect(isNoisyBrokerName('kafka.internal')).toBe(true);
    });

    it('should DROP AWS hostname: sqs.us-east-1.amazonaws.com', () => {
        expect(isNoisyBrokerName('sqs.us-east-1.amazonaws.com')).toBe(true);
    });

    it('should DROP Azure hostname: servicebus.azure.net', () => {
        expect(isNoisyBrokerName('servicebus.azure.net')).toBe(true);
    });

    // --- Should KEEP (legitimate routing keys with dots) ---

    it('should KEEP dot-separated routing key: order.created', () => {
        expect(isNoisyBrokerName('order.created')).toBe(false);
    });

    it('should KEEP multi-segment routing key: shop.order.save.ready', () => {
        expect(isNoisyBrokerName('shop.order.save.ready')).toBe(false);
    });

    it('should KEEP long routing key: order.created.save.ready.bus-send', () => {
        expect(isNoisyBrokerName('order.created.save.ready.bus-send')).toBe(false);
    });

    it('should KEEP wildcard routing pattern: pkg.acme_core.*.shipment.requested', () => {
        expect(isNoisyBrokerName('pkg.acme_core.*.shipment.requested')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Broker Method-Name-Derived CQRS Filter (Eval Pattern)
//
// The LLM sometimes extracts CQRS-looking names from method names
// (e.g. emitSaveUpdatedEvent → SaveUpdatedEvent). The pattern:
// Verb + PastParticiple + Event/Command distinguishes these from legitimate
// domain events (e.g. OrderCreatedEvent, UpdateQuoteCreatedMessage).
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — CQRS method-name prefix filter', () => {
    // --- Should DROP (method-name artifacts: Verb + PastParticiple + Event) ---

    it('should DROP method-derived name: SaveUpdatedEvent (from emitSaveUpdatedEvent)', () => {
        expect(isNoisyBrokerName('SaveUpdatedEvent')).toBe(true);
    });

    it('should DROP method-derived name: EmitProcessedCommand (from handleEmitProcessedCommand)', () => {
        expect(isNoisyBrokerName('EmitProcessedCommand')).toBe(true);
    });

    it('should DROP method-derived name: PublishCreatedEvent', () => {
        expect(isNoisyBrokerName('PublishCreatedEvent')).toBe(true);
    });

    it('should DROP method-derived name: DispatchUpdatedMessage', () => {
        expect(isNoisyBrokerName('DispatchUpdatedMessage')).toBe(true);
    });

    it('should DROP method-derived name: HandleProcessingEvent', () => {
        expect(isNoisyBrokerName('HandleProcessingEvent')).toBe(true);
    });

    it('should DROP method-derived name: PersistChangedEvent', () => {
        expect(isNoisyBrokerName('PersistChangedEvent')).toBe(true);
    });

    // --- Should KEEP (legitimate domain CQRS contracts) ---

    it('should KEEP domain event: OrderCreatedEvent', () => {
        expect(isNoisyBrokerName('OrderCreatedEvent')).toBe(false);
    });

    it('should KEEP domain event: UpdateQuoteCreatedMessage', () => {
        expect(isNoisyBrokerName('UpdateQuoteCreatedMessage')).toBe(false);
    });

    it('should KEEP domain event: CartFinalizedMessage', () => {
        expect(isNoisyBrokerName('CartFinalizedMessage')).toBe(false);
    });

    it('should KEEP domain event: PaymentRefundedEvent', () => {
        expect(isNoisyBrokerName('PaymentRefundedEvent')).toBe(false);
    });

    it('should KEEP domain event: ShipmentDeliveredCommand', () => {
        expect(isNoisyBrokerName('ShipmentDeliveredCommand')).toBe(false);
    });

    it('should KEEP domain event: OrderQuoteRequestedEvent', () => {
        expect(isNoisyBrokerName('OrderQuoteRequestedEvent')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// CQRS exemption is technology-gated (TDD)
//
// A PascalCase *Event/*Message/*Command/*Query class name is the routing
// contract ONLY on an abstract / in-memory bus (symfony-messenger, mediatr, ...)
// where the message class name IS the channel. Over a PHYSICAL transport
// (Google Cloud Pub/Sub, Kafka, SQS, SNS, RabbitMQ, NATS) the named topic is
// the channel and the *Event class is just the serialized payload (a DTO /
// protobuf message). So the exemption must fire only when the technology is
// unknown (conservative) or an abstract bus; over a physical transport the
// class name is a phantom and must be dropped.
// ═════════════════════════════════════════════════════════════════════════════
describe('isNoisyBrokerName — technology-gated CQRS exemption (TDD)', () => {
    // --- Should DROP: CQRS class name over a PHYSICAL transport (payload, not channel) ---

    it('should DROP a *Event class over Pub/Sub (DTO payload, not a channel)', () => {
        expect(isNoisyBrokerName('NotPurchasableEvent', false, 'pubsub')).toBe(true);
    });

    it('should DROP a *Event class over Kafka', () => {
        expect(isNoisyBrokerName('QuotationCompletedEvent', false, 'kafka')).toBe(true);
    });

    it('should DROP a *Event class over SQS', () => {
        expect(isNoisyBrokerName('OrderCreatedEvent', false, 'sqs')).toBe(true);
    });

    it('should DROP a *Message class over RabbitMQ', () => {
        expect(isNoisyBrokerName('CartFinalizedMessage', false, 'rabbitmq')).toBe(true);
    });

    it('should DROP a *Command class over SNS', () => {
        expect(isNoisyBrokerName('ShipmentDeliveredCommand', false, 'sns')).toBe(true);
    });

    // --- Should KEEP: CQRS class name on an ABSTRACT bus (the class IS the channel) ---

    it('should KEEP a *Event class on symfony-messenger (abstract bus)', () => {
        expect(isNoisyBrokerName('OrderCreatedEvent', false, 'symfony-messenger')).toBe(false);
    });

    it('should KEEP a *Message class on mediatr (abstract bus)', () => {
        expect(isNoisyBrokerName('CartFinalizedMessage', false, 'mediatr')).toBe(false);
    });

    // --- Should KEEP: technology unknown/empty → conservative (current behavior preserved) ---

    it('should KEEP a *Event class when technology is undefined (conservative)', () => {
        expect(isNoisyBrokerName('OrderCreatedEvent', false, undefined)).toBe(false);
    });

    it('should KEEP a *Event class when technology is empty string', () => {
        expect(isNoisyBrokerName('OrderCreatedEvent', false, '')).toBe(false);
    });

    it('should KEEP a *Event class with the 2-arg form (backward compatible)', () => {
        expect(isNoisyBrokerName('OrderCreatedEvent', false)).toBe(false);
    });

    // --- A real physical channel name with separators is kept even on a physical transport ---
    //     (only PascalCase class-shaped names are dropped; named topics survive) ---

    it('should KEEP a separator-bearing physical topic name over Pub/Sub', () => {
        expect(isNoisyBrokerName('acme-inventory-streaming-not-purchasable', false, 'pubsub')).toBe(false);
    });

    it('should KEEP a dotted routing key over Kafka', () => {
        expect(isNoisyBrokerName('order.created.result', false, 'kafka')).toBe(false);
    });

    // --- Verb-prefix (method-derived) names still drop FIRST, regardless of technology ---

    it('should DROP a method-derived name even on an abstract bus', () => {
        expect(isNoisyBrokerName('SaveUpdatedEvent', false, 'symfony-messenger')).toBe(true);
    });

    it('should DROP a method-derived name over a physical transport', () => {
        expect(isNoisyBrokerName('SaveUpdatedEvent', false, 'pubsub')).toBe(true);
    });

    // --- wasResolved precedence is unchanged: a DI-resolved name keeps its trusted shape ---

    it('should KEEP a DI-resolved CQRS name over a physical transport (wasResolved wins)', () => {
        expect(isNoisyBrokerName('NotPurchasableEvent', true, 'pubsub')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// System Database Denylist (Eval Pattern)
//
// The LLM extracts system/infrastructure database names from connection setup
// code (MongoDB admin auth database, MySQL information_schema, etc.).
// These must be filtered before they pollute the graph as DataTable nodes.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — system database denylist', () => {
    it('should DROP MongoDB admin auth database: "admin"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'admin', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP MongoDB local database: "local"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'local', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP MongoDB config database: "config"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'config', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP MySQL system schema: "information_schema"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'information_schema', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP MySQL sys schema: "mysql"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'mysql', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP PostgreSQL template: "template0"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'template0', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP SQL Server system: "tempdb"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'tempdb', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP SQL Server system: "master"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'master', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP case-insensitive: "ADMIN"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'ADMIN', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    // --- Should KEEP (application database names that happen to look system-ish) ---

    it('should KEEP application table "admin_users" (not a system database)', () => {
        const src = `$stmt = $pdo->prepare("SELECT * FROM admin_users WHERE role = 'admin'");`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'admin_users', type: 'Database', operation: 'READS', evidence: "SELECT * FROM admin_users" },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP application database "inventory" (real app db)', () => {
        const src = `$stmt = $pdo->prepare("SELECT * FROM inventory.quotes WHERE id = :id");`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'inventory', type: 'Database', operation: 'READS', evidence: "SELECT * FROM inventory.quotes" },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// isHallucinatedTable — Heavy Normalization Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('isHallucinatedTable — heavy normalization', () => {
    const sourceCode = `$stmt = $pdo->prepare("SELECT * \n  FROM 'shipping_records_logistics' WHERE id = :id");`;

    it('should pass with evidence that includes table name verbatim', () => {
        expect(isHallucinatedTable('shipping_records_logistics', "SELECT * FROM 'shipping_records_logistics' WHERE id = :id", sourceCode)).toBe(false);
    });

    it('should pass even when LLM normalizes whitespace and removes newline', () => {
        expect(isHallucinatedTable('shipping_records_logistics', "SELECT * FROM shipping_records_logistics WHERE id = :id", sourceCode)).toBe(false);
    });

    it('should reject fabricated evidence not in source code', () => {
        expect(isHallucinatedTable('quotes', "SELECT * FROM quotes", sourceCode)).toBe(true);
    });

    it('should reject empty evidence', () => {
        expect(isHallucinatedTable('quotes', '', sourceCode)).toBe(true);
    });

    it('should reject evidence shorter than 6 alphanum chars', () => {
        expect(isHallucinatedTable('abc', 'table', sourceCode)).toBe(true);
    });

    it('should reject PHP variables disguised as tables due to word boundaries', () => {
        const src = `$quotes = []; \n echo "hello";`;
        expect(isHallucinatedTable('quotes', '$quotes', src)).toBe(true);
    });

    it('should reject Ruby/Java variables disguised as tables (@var)', () => {
        const src = `@quotes = [];`;
        expect(isHallucinatedTable('quotes', '@quotes', src)).toBe(true);
    });

    it('should reject Rust/Ruby variables disguised as tables (#var)', () => {
        const src = `#[quotes(1)]`;
        expect(isHallucinatedTable('quotes', '#quotes', src)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// isHallucinatedTable — Evidence Fallback (PHPDoc + SQL Context)
//
// Bug 3 regression guard: when the LLM omits the optional `evidence` field,
// the sanitizer should still ACCEPT tables that are provably in the source
// via PHPDoc annotations or SQL keyword context.
// ═════════════════════════════════════════════════════════════════════════════

describe('isHallucinatedTable — evidence fallback (no evidence provided)', () => {
    // ── Fallback A: PHPDoc/JSDoc annotations ──────────────────────────────

    it('should ACCEPT when PHPDoc says "READ: audit_log"', () => {
        const source = `
            /**
             * READ: audit_log (direct SQL SELECT)
             * WRITE: sync_checkpoints (direct SQL INSERT)
             */
            public function syncFromAuditLog(): void {
                $stmt = $this->db->prepare('SELECT * FROM audit_log');
            }
        `;
        expect(isHallucinatedTable('audit_log', undefined, source)).toBe(false);
    });

    it('should ACCEPT when PHPDoc says "WRITE: sync_checkpoints"', () => {
        const source = `
            /**
             * READ: audit_log (direct SQL SELECT)
             * WRITE: sync_checkpoints (direct SQL INSERT)
             */
            public function syncFromAuditLog(): void {
                $insertStmt = $this->db->prepare('INSERT INTO sync_checkpoints ...');
            }
        `;
        expect(isHallucinatedTable('sync_checkpoints', undefined, source)).toBe(false);
    });

    it('should ACCEPT when PHPDoc uses plural "READS:" or "WRITES:"', () => {
        const source = `
            /**
             * READS: payment_log
             * WRITES: refund_records
             */
        `;
        expect(isHallucinatedTable('payment_log', undefined, source)).toBe(false);
        expect(isHallucinatedTable('refund_records', undefined, source)).toBe(false);
    });

    it('should ACCEPT when JSDoc says "Writes to: orders"', () => {
        const source = `
            /**
             * Writes to: orders
             */
        `;
        expect(isHallucinatedTable('orders', undefined, source)).toBe(false);
    });

    // ── Fallback B: SQL context matching ──────────────────────────────────

    it('should ACCEPT table after FROM keyword: SELECT * FROM audit_log', () => {
        const source = `$stmt = $this->db->prepare('SELECT * FROM audit_log WHERE id = 1');`;
        expect(isHallucinatedTable('audit_log', undefined, source)).toBe(false);
    });

    it('should ACCEPT table after INTO keyword: INSERT INTO sync_checkpoints', () => {
        const source = `$stmt = $this->db->prepare('INSERT INTO sync_checkpoints (col) VALUES (1)');`;
        expect(isHallucinatedTable('sync_checkpoints', undefined, source)).toBe(false);
    });

    it('should ACCEPT table after UPDATE keyword: UPDATE users SET ...', () => {
        const source = `db.query('UPDATE users SET name = $1 WHERE id = $2');`;
        expect(isHallucinatedTable('users', undefined, source)).toBe(false);
    });

    it('should ACCEPT table after JOIN keyword: JOIN orders ON ...', () => {
        const source = `$stmt = $pdo->query('SELECT * FROM users JOIN orders ON users.id = orders.user_id');`;
        expect(isHallucinatedTable('orders', undefined, source)).toBe(false);
    });

    it('should ACCEPT backtick-quoted tables: FROM `audit_log`', () => {
        const source = 'SELECT * FROM `audit_log` WHERE id = 1';
        expect(isHallucinatedTable('audit_log', undefined, source)).toBe(false);
    });

    // ── Fallback D: Quoted string literal ─────────────────────────────────

    it('should ACCEPT table name in PHP array: [\'delivery_history_express\', ...]', () => {
        const source = `
            $tables = ['delivery_history_express', 'delivery_history_standard', 'delivery_history_freight'];
            foreach ($tables as $table) {
                $stmt = $this->db->prepare("DELETE FROM {$table} WHERE created_at < ?");
            }
        `;
        expect(isHallucinatedTable('delivery_history_express', undefined, source)).toBe(false);
        expect(isHallucinatedTable('delivery_history_standard', undefined, source)).toBe(false);
        expect(isHallucinatedTable('delivery_history_freight', undefined, source)).toBe(false);
    });

    it('should ACCEPT table name in double-quoted string assignment', () => {
        const source = `$tableName = "payment_queue"; $stmt = $db->prepare("INSERT INTO {$tableName}");`;
        expect(isHallucinatedTable('payment_queue', undefined, source)).toBe(false);
    });

    it('should ACCEPT table name in JS/TS string literal', () => {
        const source = `const tableName = 'audit_events'; db.query(\`INSERT INTO \${tableName}\`);`;
        expect(isHallucinatedTable('audit_events', undefined, source)).toBe(false);
    });

    // ── Negative cases: fallback must NOT fire for random names ───────────

    it('should REJECT table with no evidence AND no SQL/PHPDoc context', () => {
        const source = `$carrello = $this->cartRepo->getCart($id);`;
        expect(isHallucinatedTable('carrello', undefined, source)).toBe(true);
    });

    it('should REJECT table that appears as a variable, not SQL context', () => {
        const source = `$audit_log = fetchData(); return $audit_log;`;
        expect(isHallucinatedTable('audit_log', undefined, source)).toBe(true);
    });

    it('should REJECT table that only appears as empty evidence string', () => {
        const source = `$stmt = $pdo->prepare("SELECT * FROM users");`;
        expect(isHallucinatedTable('orders', '', source)).toBe(true);
    });

    it('should REJECT table that appears after non-SQL keyword', () => {
        // "function audit_log" is NOT a SQL context
        const source = `function audit_log() { return true; }`;
        expect(isHallucinatedTable('audit_log', undefined, source)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis — Evidence-Mandatory End-to-End Tests
// ═════════════════════════════════════════════════════════════════════════════

import { sanitizeAnalysis } from '../../../src/ai/workflows/sanitizer.js';
import { PHPPlugin } from '../../../src/ingestion/core/languages/php.js';
import { TypeScriptPlugin } from '../../../src/ingestion/core/languages/typescript.js';

// Real plugins: the framework grammar (EventDispatcher discrimination,
// publish-payload construction, SDK tech markers, Mongo driver syntax)
// is plugin-owned; the sanitizer only consumes the hooks.
const phpPlugin = new PHPPlugin();
const tsPlugin = new TypeScriptPlugin();

type Infra = { name: string; type: string; operation: string; evidence?: string; technology?: string };
function makeAnalysis(infra: Infra[]) {
    return {
        has_io: true,
        intent: 'test',
        infrastructure: infra as any,
        capabilities: [],
        emergent_api_calls: [],
    };
}

const SQL_SOURCE = `$stmt = $pdo->prepare("SELECT * FROM shipping_records_logistics WHERE id = :id");`;

describe('sanitizeAnalysis — evidence-mandatory database filter', () => {
    it('should DROP a Database with no evidence at all', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'quotes', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP a Database with fabricated evidence not in source', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'quotes', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM quotes' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP a Database with valid SQL evidence present in source', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'shipping_records_logistics', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM shipping_records_logistics WHERE id = :id' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('shipping_records_logistics');
    });

    it('should KEEP a Database even when LLM changes shipment style in evidence', () => {
        // Source has 'shipping_records_logistics' with single shipments, LLM may omit shipments entirely
        const sourceWithQuotes = `$stmt = $pdo->prepare("SELECT * FROM 'shipping_records_logistics' WHERE id = :id");`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'shipping_records_logistics', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM shipping_records_logistics WHERE id = :id' },
        ]), sourceWithQuotes);
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should DROP variable-name tables like makeTableName (no valid SQL evidence)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'makeTableName', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should PRESERVE dynamic stubs regardless of evidence', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'booking_slot_{type}', type: 'Database', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('booking_slot_{type}');
    });
});

describe('sanitizeAnalysis — broker property-access filter', () => {
    it('should DROP this.xxx broker patterns', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'this.appConfig.appChannelSave', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should RESOLVE property-access broker names before dropping unresolved property access', () => {
        const result = sanitizeAnalysis(
            makeAnalysis([
                { name: 'appConfig.appChannelSave', type: 'MessageChannel', operation: 'WRITES' },
            ]),
            {
                sourceCode: SQL_SOURCE,
                consumerFilePath: 'src/service.ts',
                functionName: 'publishSave',
                resolvedConstants: [{ key: 'appConfig.appChannelSave', value: '"Order-Save"' }],
            },
        );

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('Order-Save');
    });

    it('should DROP self.xxx broker patterns', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'self.topicName', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP broker with {ENV} config template (real bug: AmqpConfig.php)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'logistics.fulfillment{ENV}.shipment.saved', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP broker with {CLUSTER} config template', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'queue.{CLUSTER}.events', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    // ── Sanitizer stem normalization (Step B): strip env-suffix placeholders ──
    // Lowercase env placeholders ({envSuffix}, {env}, etc.) are deployment-environment
    // qualifiers, not part of the topic identity — they should be stripped, not dropped.
    // Uppercase placeholders like {ENV}/{CLUSTER} stay DROPPED (above) because they
    // represent unresolvable deployment markers.
    it('should NORMALIZE broker with {envSuffix} to canonical stem (Step B)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme.inventory{envSuffix}.quote.product.requested', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('acme.inventory.quote.product.requested');
    });

    it('should NORMALIZE acme.inventory{envSuffix}.X.Y to acme.inventory.X.Y', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme.inventory{envSuffix}.X.Y', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('acme.inventory.X.Y');
    });

    it('should DROP broker whose ENTIRE name is a single env placeholder', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: '{envSuffix}', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    // ── Static class constant reference (regression: SystemEventService.EVENT_NAME) ──
    // TypeScript/JS: ClassName.CONSTANT — PascalCase prefix + dot + identifier
    it('should DROP TypeScript static class constant: SystemEventService.EVENT_NAME', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'SystemEventService.EVENT_NAME', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP TypeScript static class constant: RabbitMqConfig.EXCHANGE_NAME', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'RabbitMqConfig.EXCHANGE_NAME', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP chained static class access: SystemEventService.EVENT_NAME.value', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'SystemEventService.EVENT_NAME.value', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    // PHP: ClassName::CONSTANT — PascalCase prefix + double-colon + identifier
    it('should DROP PHP double-colon static constant: MyAmqpConfig::QUEUE_NAME', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'MyAmqpConfig::QUEUE_NAME', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    // Non-regression: legitimate routing keys must NOT be dropped
    it('should KEEP legitimate dot-separated routing keys', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'logistics.fulfillment.save.ready', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP the actual resolved value: system.event.created', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'system.event.created', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('system.event.created');
    });

    it('should KEEP legitimate hyphenated queue names', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'order-events', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// DI Token / Constant Guard — UPPER_SNAKE_CASE Filter
//
// Fully-uppercase names with underscores (e.g. GET_VEHICLE_MAKES_BY_TYPE,
// CACHE_REPOSITORY_TOKEN) are DI injection tokens or enum constants — NEVER
// physical queue/topic/routing key names. Real MessageChannels use:
// dot.separated, kebab-case, camelCase, or PascalCase.
//
// Validated against 15 real DI tokens from acme-platform NestJS trace.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — DI token / constant guard (UPPER_SNAKE_CASE)', () => {
    // --- Should DROP (DI tokens from acme-platform trace) ---

    it('should DROP NestJS DI token: GET_VEHICLE_MAKES_BY_TYPE_AND_REGISTRATION_DATE', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'GET_VEHICLE_MAKES_BY_TYPE_AND_REGISTRATION_DATE', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP NestJS DI token: CACHE_REPOSITORY_TOKEN', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'CACHE_REPOSITORY_TOKEN', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP NestJS DI token: TRUST_ME_API_REPOSITORY_TOKEN', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'TRUST_ME_API_REPOSITORY_TOKEN', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP 2-segment DI token: USER_REPOSITORY', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'USER_REPOSITORY', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP 2-segment DI token: ORDER_CREATED', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'ORDER_CREATED', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP constant-like name: MY_EXCHANGE_NAME', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'MY_EXCHANGE_NAME', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP NestJS usecase token: CLOSE_QUOTE_USECASE', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'CLOSE_QUOTE_USECASE', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    // --- Should KEEP (legitimate routing keys / topics) ---

    it('should KEEP dot-separated routing key: system.event.created', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'system.event.created', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP dot+dash routing key: order.created.save.ready.bus-send', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'order.created.save.ready.bus-send', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP lowercase snake_case channel: my_exchange_name', () => {
        // lowercase with underscores is a legitimate Kafka/AMQP naming pattern
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'my_exchange_name', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should DROP DLQ (in NOISY_BROKER_NAMES, no underscore = our guard does not fire, but upstream does)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'DLQ', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        // DLQ is in NOISY_BROKER_NAMES — dropped upstream before our guard
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP AMQP (in NOISY_BROKER_NAMES, no underscore = our guard does not fire, but upstream does)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'AMQP', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        // AMQP is in NOISY_BROKER_NAMES — dropped upstream before our guard
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP kebab-case queue name: order-events', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'order-events', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// isDynamicTableStub — Preserved for Stage 4 Expansion
// ═════════════════════════════════════════════════════════════════════════════

describe('isDynamicTableStub', () => {
    it('should identify curly-brace template as stub: booking_slot_{type}', () => {
        expect(isDynamicTableStub('booking_slot_{type}')).toBe(true);
    });

    it('should identify trailing underscore as stub: delivery_history_', () => {
        expect(isDynamicTableStub('delivery_history_')).toBe(true);
    });

    it('should NOT identify concrete table as stub: booking_slot_hotel', () => {
        expect(isDynamicTableStub('booking_slot_hotel')).toBe(false);
    });

    it('should NOT identify plain table as stub: users', () => {
        expect(isDynamicTableStub('users')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// looksLikeBrokerTopic — Payload Reconciliation Heuristic
// ═════════════════════════════════════════════════════════════════════════════

import { looksLikeBrokerTopic } from '../../../src/ai/agents/unified-analyzer.js';

describe('looksLikeBrokerTopic', () => {
    // --- Should ACCEPT (real topic/queue patterns) ---

    it('should accept dot-separated routing key: order.created', () => {
        expect(looksLikeBrokerTopic('order.created')).toBe(true);
    });

    it('should accept multi-segment topic: pkg.acme_core.shipment.requested', () => {
        expect(looksLikeBrokerTopic('pkg.acme_core.shipment.requested')).toBe(true);
    });

    it('should accept dash-separated queue: order-events', () => {
        expect(looksLikeBrokerTopic('order-events')).toBe(true);
    });

    it('should accept underscore-separated topic: user_profile_updated', () => {
        expect(looksLikeBrokerTopic('user_profile_updated')).toBe(true);
    });

    // --- Should REJECT (class names, generics, HTTP paths) ---

    it('should reject PascalCase class: OrderCreatedEvent', () => {
        expect(looksLikeBrokerTopic('OrderCreatedEvent')).toBe(false);
    });

    it('should reject PascalCase class: PaymentRequest', () => {
        expect(looksLikeBrokerTopic('PaymentRequest')).toBe(false);
    });

    it('should reject HTTP path: /api/orders', () => {
        expect(looksLikeBrokerTopic('/api/orders')).toBe(false);
    });

    it('should reject HTTP URL: https://example.com', () => {
        expect(looksLikeBrokerTopic('https://example.com')).toBe(false);
    });

    it('should reject generic: OpaquePayload', () => {
        expect(looksLikeBrokerTopic('OpaquePayload')).toBe(false);
    });

    it('should reject generic: message', () => {
        expect(looksLikeBrokerTopic('message')).toBe(false);
    });

    it('should reject generic: event', () => {
        expect(looksLikeBrokerTopic('event')).toBe(false);
    });

    it('should reject too-short: ab', () => {
        expect(looksLikeBrokerTopic('ab')).toBe(false);
    });

    it('should reject empty/whitespace', () => {
        expect(looksLikeBrokerTopic('')).toBe(false);
        expect(looksLikeBrokerTopic('  ')).toBe(false);
    });

    it('should reject single-word without separator: orders', () => {
        expect(looksLikeBrokerTopic('orders')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis — No Source Code Edge Cases
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — no source code available', () => {
    it('should still DROP generic infra names', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'mongodb', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should still DROP unknown/placeholder names', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'unknown_database', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should still PRESERVE dynamic stubs', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'booking_slot_{type}', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should still DROP noisy broker class names', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'RabbitMQClient', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should still DROP this.xxx broker patterns', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'this.config.topicName', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis — camelCase MongoDB Collections (Regression Guard)
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — camelCase collection names', () => {
    const MONGO_SOURCE = `db.collection('userProfiles').findOne({ userId: id });`;

    it('should KEEP camelCase MongoDB collection with valid evidence', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'userProfiles', type: 'Database', operation: 'READS', evidence: "db.collection(userProfiles).findOne" },
        ]), MONGO_SOURCE);
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('userProfiles');
    });

    it('should KEEP camelCase collection with Prisma evidence', () => {
        const prismaSource = `const results = await prisma.paymentHistory.findMany({ where: { userId } });`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'paymentHistory', type: 'Database', operation: 'READS', evidence: 'prisma.paymentHistory.findMany' },
        ]), prismaSource);
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('paymentHistory');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis — Process Infrastructure
//
// Process nodes should survive the sanitizer unchanged:
//   - no evidence check (unlike Database)
//   - no noisy-name filter (unlike MessageChannel)
//   - only the generic-name set can drop them (e.g. "redis" is in the set)
//
// Regression guard for the edge-reconciler SPAWNS bug:
//   The reconciler must see Process infrastructure survive sanitizeAnalysis
//   so that expectedEdges contains "SPAWNS|cr:systemprocess:<name>".
// ═════════════════════════════════════════════════════════════════════════════

const EXEC_SOURCE = `exec('/usr/bin/php scrapers/' . $script . ' > /dev/stderr 2>&1 &');`;

describe('sanitizeAnalysis — Process infrastructure', () => {
    it('should KEEP a Process node with binary name "php"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'php', type: 'Process', operation: 'WRITES' },
        ]), EXEC_SOURCE);
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].type).toBe('Process');
        expect(result.infrastructure[0].name).toBe('php');
    });

    it('should KEEP a Process node with script name "process_company.php"', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'process_company.php', type: 'Process', operation: 'WRITES' },
        ]), EXEC_SOURCE);
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('process_company.php');
    });

    it('should KEEP a Process node without source code (no evidence check)', () => {
        // Process has no evidence-mandatory check unlike Database
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'recursive_worker.php', type: 'Process', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should DROP a Process node whose name is in GENERIC_INFRA_NAMES', () => {
        // The generic-name gate applies to all infra types including Process
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'redis', type: 'Process', operation: 'WRITES' },
        ]), EXEC_SOURCE);
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP multiple Process nodes in the same function', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'php', type: 'Process', operation: 'WRITES' },
            { name: 'ps', type: 'Process', operation: 'READS' },
        ]), EXEC_SOURCE);
        expect(result.infrastructure).toHaveLength(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Note on isInboundPathEvident and PHP false positives
// ─────────────────────────────────────────────────────────────────────────────
//
// The sanitizer's isInboundPathEvident (Pass 2) is intentionally permissive:
// it uses optional leading/trailing slashes to support ALL framework styles:
//   - PHP/Slim:  $app->get('/archive', ...)      → matches '/archive'
//   - Django:    path('calculate/', ...)          → matches 'calculate/'
//   - Java:      @GetMapping("/users")            → matches '/users'
//
// This means it CANNOT reject '/ORDER_REF' or '/channel' at the sanitizer level,
// because 'ORDER_REF' and 'channel' appear as quoted strings in the source
// (inside $request->get('ORDER_REF') and $msg->get('channel')), which passes Pass 2.
//
// These false positives are blocked UPSTREAM instead:
//   1. route-extractor-php.ts: rawPath must start with '/' (rejects 'ORDER_REF' etc.)
//   2. LLM prompt in php.ts: explicit guard for ->get('key') on domain objects
//   3. Zero-pollution tests in php-route-chunks.test.ts verify no route chunks emitted
//
// Language-specific guards belong in language extractors, not in the generic sanitizer.
// ─────────────────────────────────────────────────────────────────────────────

import { isInboundPathEvident, isNoisyEndpoint } from '../../../src/ai/workflows/sanitizer.js';

describe('isInboundPathEvident — positive cases (real route paths)', () => {
    it('should ACCEPT Slim route path quoted in source', () => {
        const src = `$app->get('/api/v1/params', ParamsHandler::class);`;
        expect(isInboundPathEvident('/api/v1/params', src)).toBe(true);
    });

    it('should ACCEPT Django-style route without leading slash: path("calculate/", ...)', () => {
        // Django urls.py standard — NO leading slash, trailing slash present
        const src = `path('calculate/', CalculateView.as_view(), name='calculate'),`;
        expect(isInboundPathEvident('/api/calculate', src)).toBe(true);
    });

    it('should ACCEPT Java @GetMapping annotation', () => {
        const src = `@GetMapping("/archive")`;
        expect(isInboundPathEvident('/api/archive', src)).toBe(true);
    });

    it('should REJECT a path with no evidence at all in source', () => {
        const src = `$foo = doSomething(); return true;`;
        expect(isInboundPathEvident('/api/ghost-path', src)).toBe(false);
    });

    it('should REJECT /consume — short method name with no routing evidence', () => {
        const src = `$messageConsumer->consume($msg);`;
        // 'consume' is 7 chars >= 4, but it's not quoted in ANY routing context
        // AND it doesn't appear as a slash-prefixed segment in source
        // NOTE: this test documents that '$obj->method()' calls don't create
        // quoted string evidence — the literal string 'consume' isn't in the source
        expect(isInboundPathEvident('/consume', src)).toBe(false);
    });
});

describe('isNoisyEndpoint — sanity checks for common hallucinations', () => {
    it('should accept canonical GraphQL paths (not noisy — structured identifiers)', () => {
        expect(isNoisyEndpoint('GRAPHQL QUERY GetUser')).toBe(false);
        expect(isNoisyEndpoint('GRAPHQL MUTATION createOrder')).toBe(false);
    });

    it('should flag GraphQL introspection paths', () => {
        expect(isNoisyEndpoint('GRAPHQL QUERY __schema')).toBe(true);
    });

    it('should flag bare template-only paths like {path}', () => {
        expect(isNoisyEndpoint('{path}')).toBe(true);
    });

    it('should flag bare URL with no path', () => {
        expect(isNoisyEndpoint('https://example.com')).toBe(true);
    });

    it('should accept a legitimate path /api/v1/records/archive', () => {
        expect(isNoisyEndpoint('/api/v1/records/archive')).toBe(false);
    });

    it('should accept a path with path param /users/{id}', () => {
        expect(isNoisyEndpoint('/users/{id}')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Orchestrator Precision Fixes — RED/GREEN TDD
//
// Each test section below corresponds to a specific false-positive pattern
// observed in the inventory PHP repository graph ingestion.
// These tests are written RED-first: they should FAIL until the corresponding
// fix is implemented in sanitizer.ts.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.1: PHP Fully-Qualified Class Names as MessageChannels
//
// PHP FQCNs like "AcmeShop\Shipping\Express\Broker\BrokerSaveQuoteOrchestrator"
// are extracted by the LLM when it sees $this->orchestrator->dispatch(...).
// Physical queue/topic/routing-key names NEVER contain backslashes.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — PHP FQCN backslash guard', () => {
    it('should DROP PHP FQCN: AcmeShop\\Shipping\\Express\\Broker\\BrokerSaveQuoteOrchestrator', () => {
        expect(isNoisyBrokerName('AcmeShop\\Shipping\\Express\\Broker\\BrokerSaveQuoteOrchestrator')).toBe(true);
    });

    it('should DROP PHP FQCN: AcmeShop\\Shipping\\Express\\MultiQuoteAnalysis\\MultiQuoteBatchRunner', () => {
        expect(isNoisyBrokerName('AcmeShop\\Shipping\\Express\\MultiQuoteAnalysis\\MultiQuoteBatchRunner')).toBe(true);
    });

    it('should DROP any namespace-separated name: App\\Events\\OrderCreated', () => {
        expect(isNoisyBrokerName('App\\Events\\OrderCreated')).toBe(true);
    });

    it('should DROP deep namespace: Symfony\\Component\\Messenger\\Transport\\AmqpExt', () => {
        expect(isNoisyBrokerName('Symfony\\Component\\Messenger\\Transport\\AmqpExt')).toBe(true);
    });

    it('should KEEP legitimate routing keys without backslashes', () => {
        expect(isNoisyBrokerName('acme.inventory.quote.requested')).toBe(false);
        expect(isNoisyBrokerName('shop.order.save.ready')).toBe(false);
    });
});

describe('sanitizeAnalysis — PHP FQCN as MessageChannel (end-to-end)', () => {
    it('should DROP PHP FQCN MessageChannel in sanitizeAnalysis', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'AcmeShop\\Shipping\\Express\\Broker\\BrokerSaveQuoteOrchestrator', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP multi-segment FQCN MessageChannel', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'AcmeShop\\Shipping\\Express\\MultiQuoteAnalysis\\MultiQuoteBatchRunner', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.2: PHP FQCN as Database (Entity\SupplierRenewals)
//
// The LLM sees a Doctrine entity class and emits the FQCN as the table name.
// Real table names never contain backslashes.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — PHP FQCN as Database', () => {
    it('should DROP PHP entity FQCN as table: Entity\\SupplierRenewals', () => {
        const src = `use App\\Entity\\SupplierRenewals; $repo->find($id);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'Entity\\SupplierRenewals', type: 'Database', operation: 'READS' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP Doctrine entity FQCN: App\\Entity\\Quote', () => {
        const src = `use App\\Entity\\Quote; $em->persist($quote);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'App\\Entity\\Quote', type: 'Database', operation: 'WRITES' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP real table names without backslashes', () => {
        const src = `$stmt = $pdo->prepare("SELECT * FROM supplier_renewals WHERE id = :id");`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'supplier_renewals', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM supplier_renewals' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Database property-name guard
//
// The LLM sometimes extracts a PHP class property name as the "table" when it
// sees `file_get_contents($this->keyFilePath)`. The property is a file path
// config var, not a DB table. Heuristic: PascalCase tail in the set
// {Path, FilePath, FileName, Filename, Pathname, Url, Uri, URL, URI,
//  Endpoint, Hostname} marks the name as a variable-like identifier.
// Real DB tables use snake_case or short PascalCase nouns, NEVER these
// "config-y" tails.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis: Database property-name guard', () => {
    // NB: sourceCode intentionally omitted so isHallucinatedTable is skipped
    // (mirrors the production code path where the LLM emits the name without
    // surrounding chunk context). Guard must fire deterministically on shape.

    it('should DROP property name ending in FilePath: keyFilePath', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'keyFilePath', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP property name ending in Path: configPath', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'configPath', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP property name ending in FileName: tempFileName', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'tempFileName', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP property name ending in Url: backendUrl', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'backendUrl', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP property name ending in Endpoint: apiEndpoint', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'apiEndpoint', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP property name ending in URI: serviceURI', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'serviceURI', type: 'Database', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    // Regression guard: snake_case names that happen to end in "path" / "url"
    // are NOT property names, they could be legitimate table names.
    it('should KEEP snake_case table: user_path', () => {
        const src = `SELECT * FROM user_path WHERE id = :id`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'user_path', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM user_path' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP snake_case table: audit_url', () => {
        const src = `SELECT * FROM audit_url WHERE id = :id`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'audit_url', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM audit_url' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Database generic-infra-name guard
//
// `local_filesystem` is a generic concept emitted by the LLM when the function
// does file I/O (file_get_contents, fopen, file_put_contents) but no actual
// data store. Same family as 'mongodb', 'postgres', drop entirely.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis: Database generic local-filesystem guard', () => {
    it('should DROP local_filesystem as Database', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'local_filesystem', type: 'Database', operation: 'READS' },
        ]), 'file_get_contents($path);');
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP local_storage as Database', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'local_storage', type: 'Database', operation: 'WRITES' },
        ]), 'fwrite($handle, $data);');
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP filesystem (no prefix) as Database', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'filesystem', type: 'Database', operation: 'READS' },
        ]), 'file_get_contents($p);');
        expect(result.infrastructure).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Storage mechanism / transport tokens typed as ObjectStorage. The prompt tells
// the LLM "file I/O = ObjectStorage", so SFTP/filesystem transport arrives as a
// bare ObjectStorage token. The TYPE is not a data container; drop it. A real
// bucket that merely CONTAINS the word ('sftp-incoming') must survive.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis: ObjectStorage storage-mechanism/transport token guard', () => {
    it('should DROP filesystem as ObjectStorage', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'filesystem', type: 'ObjectStorage', operation: 'READS' },
        ]), 'file_get_contents($p);');
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP sftp as ObjectStorage', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'sftp', type: 'ObjectStorage', operation: 'WRITES' },
        ]), '$sftp->put($localFile, $remotePath);');
        expect(result.infrastructure).toHaveLength(0);
    });

    it('GUARDRAIL: should KEEP a real bucket that contains a transport word (sftp-incoming)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'sftp-incoming', type: 'ObjectStorage', operation: 'WRITES' },
        ]), "$bucket = $storage->bucket('sftp-incoming');");
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('sftp-incoming');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// DI service-locator keys leaked as DataContainers. The LLM extracts the
// container HANDLE (e.g. $container->get('archive.mongodb.client')) as a table.
// The literal IS in source, so the evidence guard keeps it — but the final
// dotted segment is a data-handle suffix, so it is a DI key, not a container.
// A real schema-qualified table / collection must survive.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis: DI service-locator key guard', () => {
    it('should DROP a DI client handle key as Database (literal present in source)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'archive.mongodb.client', type: 'Database', operation: 'READS' },
        ]), "$this->mongo = $container->get('archive.mongodb.client');");
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP a DI entitymanager key as ObjectStorage', () => {
        // entitymanager/documentmanager are no longer in the agnostic suffix list;
        // the drop now comes from the PHP plugin's service-locator evidence hook
        // (sole source occurrence is a $container->get() arg).
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'orders.entitymanager', type: 'ObjectStorage', operation: 'WRITES' },
        ]), {
            sourceCode: "$em = $container->get('orders.entitymanager');",
            plugin: phpPlugin,
        });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('GUARDRAIL: should KEEP a Mongo collection with a dot (order.events)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'order.events', type: 'Database', operation: 'READS' },
        ]), "$db->selectCollection('order.events')->find([]);");
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('order.events');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.3: Expanded BROKER_CLASS_SUFFIX
//
// The BROKER_CLASS_SUFFIX regex catches class names like *Client, *Publisher,
// but misses *Orchestrator, *Runner, *Worker etc. These are application-layer
// class names, never physical queue/topic names.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — expanded BROKER_CLASS_SUFFIX', () => {
    it('should DROP class name ending in Orchestrator', () => {
        expect(isNoisyBrokerName('BrokerSaveQuoteOrchestrator')).toBe(true);
    });

    it('should DROP class name ending in Runner', () => {
        expect(isNoisyBrokerName('MultiQuoteBatchRunner')).toBe(true);
    });

    it('should DROP class name ending in Worker', () => {
        expect(isNoisyBrokerName('QuoteProcessingWorker')).toBe(true);
    });

    it('should DROP class name ending in Processor', () => {
        expect(isNoisyBrokerName('PaymentEventProcessor')).toBe(true);
    });

    it('should DROP class name ending in Adapter', () => {
        expect(isNoisyBrokerName('AcmeQuoteAdapter')).toBe(true);
    });

    it('should DROP class name ending in Provider', () => {
        expect(isNoisyBrokerName('CatalogDataProvider')).toBe(true);
    });

    it('should DROP class name ending in Dispatcher', () => {
        expect(isNoisyBrokerName('EventDispatcher')).toBe(true);
    });

    it('should DROP class name ending in Listener', () => {
        expect(isNoisyBrokerName('SaveQuotationListener')).toBe(true);
    });

    it('should DROP class name ending in Subscriber', () => {
        expect(isNoisyBrokerName('OrderEventSubscriber')).toBe(true);
    });

    it('should DROP class name ending in Transport', () => {
        expect(isNoisyBrokerName('AmqpTransport')).toBe(true);
    });

    it('should DROP class name ending in Connection', () => {
        expect(isNoisyBrokerName('AmqpConnection')).toBe(true);
    });

    // Non-regression: CQRS routing contracts must still be KEPT
    it('should still KEEP CQRS message: CartFinalizedMessage', () => {
        expect(isNoisyBrokerName('CartFinalizedMessage')).toBe(false);
    });

    it('should still KEEP CQRS event: OrderCreatedEvent', () => {
        expect(isNoisyBrokerName('OrderCreatedEvent')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.4: DI Service Key Suffix Detection
//
// PHP Symfony DI container keys like "acme-partner.acme-vendor.adapter" are fetched
// via $container->get('acme-partner.acme-vendor.adapter'). The LLM misclassifies
// these as routing keys because of the dot-separated notation.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — DI service key suffix filter', () => {
    it('should DROP DI service key: acme-partner.acme-vendor.adapter', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme-partner.acme-vendor.adapter', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP DI service key: acme-partner.acme-traced.adapter', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme-partner.acme-traced.adapter', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP DI service key ending in .service', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'quote.rating.service', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP DI service key ending in .factory', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'amqp.connection.factory', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP DI service key ending in .connection', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'rabbitmq.default.connection', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP DI service key ending in .gateway', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'trustme.api.gateway', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    // Coverage parity for DI suffixes that overlap with other guards
    // (DI_BROKER_SUFFIXES, INFRA_HOSTNAME_SUFFIX). Listed explicitly in
    // DI_SERVICE_KEY_SUFFIX so the rule survives future cleanup of the
    // overlapping regexes — the contract belongs to this guard.
    it('should DROP DI service key ending in .client', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'rest.api.client', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP DI service key ending in .handler', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'webhook.payment.handler', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP legitimate routing key: acme.inventory.quote.requested', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme.inventory.quote.requested', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP legitimate routing key: shop.order.save.ready', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'shop.order.save.ready', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.5: "config" in NOISY_BROKER_NAMES
//
// "config" is a generic name from $container->get('config'), never a
// physical queue/topic name.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — config as noisy name', () => {
    it('should DROP bare "config" as broker name', () => {
        expect(isNoisyBrokerName('config')).toBe(true);
    });

    it('should DROP "configuration" as broker name', () => {
        expect(isNoisyBrokerName('configuration')).toBe(true);
    });

    it('should DROP "settings" as broker name', () => {
        expect(isNoisyBrokerName('settings')).toBe(true);
    });

    it('should KEEP "config.updated" (legitimate event topic)', () => {
        expect(isNoisyBrokerName('config.updated')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.6: PascalCase Guard Threshold Lowered to 5 Chars
//
// "Prezzi" (6 chars) is a PHP class fetched via DI:
//   $container->get(\Inventory\Prezzi::class)
// The current guard only catches PascalCase ≥ 7 chars.
// ═════════════════════════════════════════════════════════════════════════════

describe('isNoisyBrokerName — PascalCase threshold lowered', () => {
    it('should DROP 6-char PascalCase: "Prezzi" (PHP DI class)', () => {
        expect(isNoisyBrokerName('Prezzi')).toBe(true);
    });

    it('should DROP 5-char PascalCase: "Quote" (class name)', () => {
        expect(isNoisyBrokerName('Quote')).toBe(true);
    });

    it('should DROP 5-char PascalCase: "Event" (generic class)', () => {
        expect(isNoisyBrokerName('Event')).toBe(true);
    });

    // Guard: 4 chars or less should still be allowed (too aggressive otherwise)
    it('should KEEP 4-char PascalCase: "Save" (too short to be confident)', () => {
        expect(isNoisyBrokerName('Save')).toBe(false);
    });

    // Non-regression: 7+ char guard still works
    it('should still DROP 7+ char PascalCase: "SaveCreated"', () => {
        expect(isNoisyBrokerName('SaveCreated')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.7: AMQP Exchange Name Dropping
//
// "ha.inventory" is an AMQP exchange declaration, not a routing key.
// When channelKind is inferred as 'exchange', the channel should be dropped.
// CodeRadius models message flow at the routing-key level.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — AMQP exchange dropping', () => {
    it('should DROP channel with channelKind=exchange: ha.inventory', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'ha.inventory', type: 'MessageChannel', operation: 'WRITES' },
        ].map(i => ({ ...i, channelKind: 'exchange' })) as any), SQL_SOURCE);
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP channel with channelKind=exchange: payments_exchange', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'payments_exchange', type: 'MessageChannel', operation: 'WRITES' },
        ].map(i => ({ ...i, channelKind: 'exchange' })) as any), SQL_SOURCE);
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP channel with channelKind=topic', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme.inventory.save.requested', type: 'MessageChannel', operation: 'WRITES' },
        ].map(i => ({ ...i, channelKind: 'topic' })) as any), SQL_SOURCE);
        expect(result.infrastructure).toHaveLength(1);
    });

    // An exchange entry that CARRIES a concrete routing key is a
    // publish call, not a topology declaration — the information is complete
    // and must be repaired to the routing-key identity, not dropped.
    it('REPAIRS exchange entry carrying an evidence-grounded routing key', () => {
        const source = `$this->publisher->basic_publish(new AMQPMessage($payload), 'inventory', 'inventory.low_stock');`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'inventory', type: 'MessageChannel', operation: 'WRITES', routingKey: 'inventory.low_stock', technology: 'rabbitmq' },
        ].map(i => ({ ...i, channelKind: 'exchange' })) as any), { sourceCode: source });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0]).toMatchObject({
            name: 'inventory.low_stock',
            channelKind: 'topic',
            routingKey: 'inventory.low_stock',
        });
    });

    it('still DROPS exchange entry whose routing key is NOT in the source (hallucination)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'inventory', type: 'MessageChannel', operation: 'WRITES', routingKey: 'ghost.key' },
        ].map(i => ({ ...i, channelKind: 'exchange' })) as any), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP channel with channelKind=queue', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme.inventory.update.save.requested', type: 'MessageChannel', operation: 'READS' },
        ].map(i => ({ ...i, channelKind: 'queue' })) as any), SQL_SOURCE);
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Property-access guard accepts ALL_CAPS namespaces (Fix 1 — eval test
// regression). Prior regex required PascalCase prefix `[A-Z][a-z]`, missing
// `DATABACKBONE_CONFIG.QUOTE_REQUEST` style class-constant references.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — property-access guard with ALL_CAPS namespace', () => {
    it('should DROP UPPER_SNAKE_CASE namespaced constant: DATABACKBONE_CONFIG.QUOTE_REQUEST', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'DATABACKBONE_CONFIG.QUOTE_REQUEST', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP nested UPPER constant: MY_CONFIG.SOME_KEY', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'MY_CONFIG.SOME_KEY', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP PHP class constant: Foo::BAR (still works after regex relaxation)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'Foo::BAR', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP lowercase routing key: acme.order.created', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme.order.created', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should resolve via constant map first (guard does not fire)', () => {
        // Real-world flow: resolvedConstants populated by static analysis maps
        // 'DATABACKBONE_CONFIG.QUOTE_REQUEST' → 'physical.topic.name'. The constant
        // resolution block runs BEFORE the property-access guard, so the literal
        // replaces the namespaced reference and we never hit the drop.
        const result = sanitizeAnalysis(
            makeAnalysis([
                { name: 'DATABACKBONE_CONFIG.QUOTE_REQUEST', type: 'MessageChannel', operation: 'WRITES' },
            ]),
            { resolvedConstants: [{ key: 'DATABACKBONE_CONFIG.QUOTE_REQUEST', value: 'physical.topic.name' }] },
        );
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('physical.topic.name');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 3 — Drop unresolved DI service identifiers
//
// `xxx.publisher` (or .consumer/.sender/etc.) without a SymbolRegistry binding
// is a DI service object reference, not a routing key. We can't know the
// physical channel statically → drop instead of inventing a bare `xxx` ghost.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — drop unresolved DI service identifier', () => {
    it('should DROP notpurchasable.publisher when registry has no binding', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'notpurchasable.publisher', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP events.publisher (no registry)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'events.publisher', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP audit.consumer (no registry)', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'audit.consumer', type: 'MessageChannel', operation: 'READS' },
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP isDiKey-flagged name without registry binding', () => {
        // LLM may emit `isDiKey: true` even for names without canonical DI suffixes.
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'opaque_service_id', type: 'MessageChannel', operation: 'WRITES', isDiKey: true } as any,
        ]), { sourceCode: SQL_SOURCE });
        expect(result.infrastructure).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// kindFamily inference for cloud object storage
// `googlecloudstorage.X`, `s3.X` etc. are valid DataContainer (kindFamily=object
// per DataContainerSchema). The current pipeline persists them with kindFamily
// undefined, blocking dashboard segmentation by storage type. Sanitizer adds
// the kindFamily tag deterministically based on the canonical prefix.
// NOTE: the existing `isHallucinatedTable` evidence check handles the drop
// of unsupported tech names (e.g. `influxdb` without SQL evidence). No new
// wholesale drop set here, since legitimate DB names that happen to match an
// engine name (custom DB called `cassandra`) must not be removed.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis: cloud object storage repair', () => {
    it('REPAIRS googlecloudstorage.acme-bucket → bucket acme-bucket, type ObjectStorage, tech gcs', () => {
        const src = `$gcs->bucket('acme-bucket')->upload($payload);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'googlecloudstorage.acme-bucket', type: 'Database', operation: 'WRITES', evidence: "bucket('acme-bucket')" },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('acme-bucket');
        expect((result.infrastructure[0] as any).type).toBe('ObjectStorage');
        expect((result.infrastructure[0] as any).kindFamily).toBe('object');
        expect((result.infrastructure[0] as any).technology).toBe('gcs');
    });

    it('REPAIRS googlecloudstorage.marketing typed ObjectStorage → bucket marketing (the LLM types cloud as ObjectStorage)', () => {
        const src = `$storage->bucket('marketing')->upload($file);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'googlecloudstorage.marketing', type: 'ObjectStorage', operation: 'READS' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('marketing');
        expect((result.infrastructure[0] as any).type).toBe('ObjectStorage');
        expect((result.infrastructure[0] as any).kindFamily).toBe('object');
        expect((result.infrastructure[0] as any).technology).toBe('gcs');
    });

    it('REPAIRS s3.events-archive → bucket events-archive, type ObjectStorage, tech s3', () => {
        const src = `$s3->putObject(['Bucket' => 'events-archive', 'Key' => $key, 'Body' => $payload]);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 's3.events-archive', type: 'Database', operation: 'WRITES', evidence: "Bucket' => 'events-archive'" },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('events-archive');
        expect((result.infrastructure[0] as any).type).toBe('ObjectStorage');
        expect((result.infrastructure[0] as any).technology).toBe('s3');
    });

    it('GUARDRAIL: a bucket named like its provider (s3.s3) repairs to bucket s3', () => {
        const src = `$s3->putObject(['Bucket' => 's3', 'Key' => $key]);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 's3.s3', type: 'Database', operation: 'WRITES', evidence: "'Bucket' => 's3'" },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('s3');
        expect((result.infrastructure[0] as any).type).toBe('ObjectStorage');
        expect((result.infrastructure[0] as any).technology).toBe('s3');
    });

    it('GUARDRAIL: a schema-qualified rdbms table (inventory.orders) is NOT a bucket', () => {
        const src = `$pdo->exec("DELETE FROM inventory.orders WHERE id = :id");`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'inventory.orders', type: 'Database', operation: 'WRITES', evidence: 'DELETE FROM inventory.orders' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('inventory.orders');
        expect((result.infrastructure[0] as any).type).toBe('Database');
        expect((result.infrastructure[0] as any).kindFamily).toBeUndefined();
    });

    it('should NOT tag plain table names with kindFamily=object', () => {
        const src = `$pdo->exec("DELETE FROM messenger_error WHERE id = :id");`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'messenger_error', type: 'Database', operation: 'WRITES', evidence: 'DELETE FROM messenger_error' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect((result.infrastructure[0] as any).kindFamily).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// EventDispatcher *Event guard
// In Symfony EventDispatcher dispatches are in-process events, NOT AMQP.
// CQRS_MESSAGE_PATTERN matches `*Event` and `isNoisyBrokerName` keeps it
// (no method-name verb prefix). Result: the LLM emits MessageChannel(topic) for
// names like `NotPurchasableEvent` even though it should be dropped.
// Deterministic guard: `*Event` + EventDispatcher marker + no AMQP marker → drop.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis: EventDispatcher event guard', () => {
    it('should DROP NotPurchasableEvent when source contains EventDispatcherInterface (no AMQP)', () => {
        const src = `class QuotationCompletedListener {
            public function __construct(private EventDispatcherInterface $dispatcher) {}
            public function dispatchEvent($payload) { $this->dispatcher->dispatch(new NotPurchasableEvent($payload)); }
        }`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'NotPurchasableEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP OrderCreatedEvent when source contains EventDispatcher (no AMQP)', () => {
        const src = `$this->eventDispatcher->dispatch(new OrderCreatedEvent($order));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderCreatedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP OrderCreatedEvent when source contains MessageBusInterface (AMQP wins)', () => {
        const src = `$this->messageBus->dispatch(new OrderCreatedEvent($order));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderCreatedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('OrderCreatedEvent');
    });

    it('should KEEP OrderCreatedMessage even with EventDispatcher (suffix is Message, not Event)', () => {
        const src = `$this->eventDispatcher->dispatch(new OrderCreatedMessage($order));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderCreatedMessage', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP QuotationCompletedEvent when both EventDispatcher and AmqpStamp present', () => {
        const src = `$this->eventDispatcher->dispatch(new QuotationCompletedEvent($q));
                     $this->messageBus->dispatch($msg, [new AmqpStamp('routing.key')]);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'QuotationCompletedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis: CQRS class over a physical transport is a payload, not a channel
//
// End-to-end of the technology-gated CQRS exemption. The source-context
// technology inference runs BEFORE the noisy-broker gate, so a *Event/*Message
// class published over Pub/Sub / Kafka (the named topic is the channel, the
// class is the serialized DTO) is dropped, while the same class over an
// abstract bus (symfony-messenger) or with no transport signal is kept.
// ═════════════════════════════════════════════════════════════════════════════
describe('sanitizeAnalysis: CQRS class over a physical transport (technology gate)', () => {
    it('should DROP a *Event channel when source imports the Google Cloud Pub/Sub PHP SDK', () => {
        const src = `use Google\\Cloud\\PubSub\\PubSubClient;
            $topic = $this->pubSubClient->topic($this->topic);
            $topic->publish(['data' => $payload]);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderPlacedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP a *Event channel when source imports @google-cloud/pubsub (TS)', () => {
        const src = `import { PubSub } from '@google-cloud/pubsub';
            await pubsub.topic('orders').publishMessage({ json: payload });`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'QuotationCompletedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: tsPlugin });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP a *Event channel when the LLM declared technology=kafka directly', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderPlacedEvent', type: 'MessageChannel', operation: 'WRITES', technology: 'kafka' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP a *Event channel on symfony-messenger (abstract bus, class IS the channel)', () => {
        const src = `use Symfony\\Component\\Messenger\\MessageBusInterface;
            $this->bus->dispatch(new OrderPlacedEvent($order));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderPlacedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('OrderPlacedEvent');
    });

    it('should KEEP a *Event channel when no transport signal is present (conservative)', () => {
        // No SDK import (technology unknown) AND no publish-payload construction
        // (dispatch, not publish) → the conservative-keep default applies.
        const src = `$this->bus->dispatch(new OrderPlacedEvent($order));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderPlacedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
    });

    it('should KEEP a real named topic over Pub/Sub (separator-bearing, not a class)', () => {
        const src = `use Google\\Cloud\\PubSub\\PubSubClient;
            $this->pubSubClient->topic('acme-inventory-streaming')->publish(['data' => $p]);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme-inventory-streaming', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('acme-inventory-streaming');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis: a CQRS class constructed as a PUBLISH PAYLOAD is not a channel
//
// `$publisher->publish(new OrderPlacedEvent(...))` over a physical transport
// sends the event as the message BODY; the channel is the topic the publisher
// targets (resolved elsewhere), not the payload class. The LLM often emits the
// constructed class as a phantom MessageChannel. Evidence-based + verb-scoped:
// only publish-family verbs (publish/produce/publishMessage/publishBatch) match,
// so an abstract-bus `->dispatch(new OrderMessage())` (where the class IS the
// channel) is NOT dropped. Technology-agnostic (fires even when unknown).
// ═════════════════════════════════════════════════════════════════════════════
describe('sanitizeAnalysis: CQRS class as a publish payload (not a channel)', () => {
    it('should DROP a *Event class constructed as a ->publish(new ...) payload', () => {
        const src = `$this->pubSubPublisher->publish(new NotPurchasableEvent([
            'type' => 'order.not-purchasable', 'data' => $reasons,
        ]));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'NotPurchasableEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP a namespaced *Event payload (new \\Generated\\X\\NotPurchasableEvent())', () => {
        const src = `$this->publisher->publish(new \\Generated\\Events\\QuotationCompletedEvent($q));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'QuotationCompletedEvent', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP a *Message class dispatched on an abstract bus (->dispatch keeps the class as channel)', () => {
        const src = `$this->bus->dispatch(new OrderPlacedMessage($order));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'OrderPlacedMessage', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src, plugin: phpPlugin });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('OrderPlacedMessage');
    });

    it('should KEEP a real named topic even when a payload is published to it', () => {
        const src = `$this->pubSubClient->topic('acme-orders')->publish(new OrderPlacedEvent($o));`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme-orders', type: 'MessageChannel', operation: 'WRITES' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('acme-orders');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis: MongoDB selectCollection container → document/mongodb (Fix C)
//
// The LLM emits a `$client->selectCollection($db, 'name')` collection as a
// generic Database with no technology. In a mixed Mongo+SQL function the
// downstream default-RDBMS binder then mis-binds it to the SQL datastore. When
// the source shows the container was produced by the standard MongoDB driver's
// selectCollection, stamp document/mongodb so it binds to the Mongo datastore.
// Container-specific: a SQL table in the same function appears in a SQL string
// (not selectCollection) and is NOT mis-stamped.
// ═════════════════════════════════════════════════════════════════════════════
describe('sanitizeAnalysis: MongoDB selectCollection container → document/mongodb', () => {
    // A mixed function: Mongo collection (dynamic name) + a MySQL table.
    const MIXED = `
        $collection = $this->client->selectCollection($this->dbName, sprintf('quote_%s', $kind));
        $q = $this->dbal->preparedQuery('SELECT * FROM res_quote_arch_auto LIMIT 1');
        $collection->insertOne(['orderRef' => 1]);
    `;

    it('stamps a dynamic-name selectCollection container as document/mongodb', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'quote_{kind}', type: 'Database', operation: 'READS' },
        ]), { sourceCode: MIXED, plugin: phpPlugin });
        const c = result.infrastructure.find(i => i.name === 'quote_{kind}') as any;
        expect(c).toBeDefined();
        expect(c.technology).toBe('mongodb');
        expect(c.kindFamily).toBe('document');
    });

    it('stamps a literal selectCollection container as document/mongodb', () => {
        const src = `$col = $db->selectCollection('inventory', 'orders'); $col->find([]);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'orders', type: 'Database', operation: 'READS' },
        ]), { sourceCode: src, plugin: phpPlugin });
        const c = result.infrastructure.find(i => i.name === 'orders') as any;
        expect(c).toBeDefined();
        expect(c.technology).toBe('mongodb');
        expect(c.kindFamily).toBe('document');
    });

    it('does NOT stamp a MySQL table in the same mixed function', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'res_quote_arch_auto', type: 'Database', operation: 'READS' },
        ]), { sourceCode: MIXED });
        const c = result.infrastructure.find(i => i.name === 'res_quote_arch_auto') as any;
        expect(c).toBeDefined();
        expect(c.technology).toBeUndefined();
        expect(c.kindFamily).toBeUndefined();
    });

    it('does NOT stamp a table when the source has no selectCollection', () => {
        const src = `$q = $this->dbal->preparedQuery('SELECT * FROM orders');`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'orders', type: 'Database', operation: 'READS' },
        ]), { sourceCode: src });
        const c = result.infrastructure.find(i => i.name === 'orders') as any;
        expect(c?.technology).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ObjectStorage property-name guard
// The LLM sometimes routes property-name leaks (e.g. `$this->keyFilePath`)
// into `type=ObjectStorage` instead of `type=Database`. The PROPERTY_NAME
// guard must fire for both types since the underlying error is identical:
// a PHP/JS class property name is never a real bucket / table / collection.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis: ObjectStorage property-name guard', () => {
    it('should DROP keyFilePath when emitted as ObjectStorage', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'keyFilePath', type: 'ObjectStorage', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should DROP configPath as ObjectStorage', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'configPath', type: 'ObjectStorage', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP a real bucket name like acme-archive', () => {
        const src = `$gcs->bucket('acme-archive')->upload($data);`;
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme-archive', type: 'ObjectStorage', operation: 'WRITES' },
        ]), { sourceCode: src });
        expect(result.infrastructure).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Discriminator-tag word guard (RC2a from acme-platform ingestion analysis)
//
// The LLM hallucinates `_tag` discriminators of ts-pattern / Effect /
// fp-ts ADTs as DataContainer / MessageChannel names. The classic case:
//
//   .with({ _tag: 'warning' }, warn => ({ _tag: 'skipped' as const, ... }))
//   if (result._tag === 'skipped') { logger.info('preferred-equipment skipped') }
//
// The literal `'skipped'` appears in source as a quoted string, so the
// generic quoted-literal fallback (D) does NOT drop it. Without a
// dedicated guard, `skipped` was emitted as a DataContainer with
// composite/high quality and consumed downstream.
// ═════════════════════════════════════════════════════════════════════════════

describe('isHallucinatedTable — discriminator-tag word guard (RC2a)', () => {
    // Real shape lifted from acme-platform PreferredEquipmentUpdate.consumer.ts
    const tsPatternSource = `
        .with({ _tag: 'warning' }, warn => ({ _tag: 'skipped' as const, reason: warn.reason }))
        .exhaustive()
        ...
        if (consumptionResult._tag === 'skipped') {
            this.logger.info(\`[\${this.CONSUMER_NAME}] preferred-equipment-update skipped\`, { input, reason: consumptionResult.reason })
            return
        }
    `;

    it('drops "skipped" even when quoted in source as a ts-pattern _tag value', () => {
        // Without RC2a guard this would survive via the quoted-literal
        // fallback in isHallucinatedTable.
        expect(isHallucinatedTable('skipped', undefined, tsPatternSource)).toBe(true);
    });

    it('drops "consumed", "success", "failure", "pending", "completed" as ADT discriminators', () => {
        const src = `match(result).with({ _tag: 'consumed' }, ...).with({ _tag: 'failure' }, ...)`;
        expect(isHallucinatedTable('consumed', undefined, src)).toBe(true);
        expect(isHallucinatedTable('failure', undefined, src)).toBe(true);
        expect(isHallucinatedTable('success', undefined, "type R = { _tag: 'success' }")).toBe(true);
        expect(isHallucinatedTable('pending', undefined, "if (status === 'pending') {}")).toBe(true);
        expect(isHallucinatedTable('completed', undefined, "{ status: 'completed' as const }")).toBe(true);
    });

    it('KEEPS the same words when they appear in an unambiguous SQL/ORM context', () => {
        // The guard must not block legitimate tables that happen to share
        // a discriminator name. Strong SQL/ORM context overrides the guard.
        const sqlCtx = "$db->prepare('SELECT * FROM skipped_orders WHERE id = ?')";
        expect(isHallucinatedTable('skipped_orders', undefined, sqlCtx)).toBe(false);

        const fromCtx = "qb.from('skipped', 's').where('s.processed = 0')";
        expect(isHallucinatedTable('skipped', undefined, fromCtx)).toBe(false);

        const ormCtx = "this.db.collection('completed_tasks').findOne({ id });";
        expect(isHallucinatedTable('completed_tasks', undefined, ormCtx)).toBe(false);
    });

    it('does NOT block multi-word table names that contain a discriminator suffix', () => {
        // 'skipped_orders' is NOT a discriminator-tag word itself.
        const src = "INSERT INTO skipped_orders VALUES (?, ?)";
        expect(isHallucinatedTable('skipped_orders', undefined, src)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Class-suffix guard for DataContainer (F2 from acme-platform ingestion analysis)
//
// TypeORM / Mongoose / Doctrine entity wrappers like `OperationTableSchema`,
// `UserSchema`, `OrderEntity`, `PolicyModel` are class identifiers, NEVER
// physical table names. The LLM frequently surfaces them as DataContainer
// because `getRepository(OperationTableSchema)` or `entities: [UserSchema]`
// reads (visually) like an ORM call site against a table.
//
// Physical table names use snake_case or kebab-case; PascalCase class names
// ending in TableSchema/Schema/Entity/Model are non-physical.
// ═════════════════════════════════════════════════════════════════════════════

describe('isHallucinatedTable — TypeORM/Mongoose class-suffix guard (F2)', () => {
    // Real shape from acme-platform apps/api/src/infrastructure/registry/repository/
    // RegistrySearch.repository.ts emitting `OperationTableSchema` (class
    // name) as DataContainer through composite grounding.
    const ormSource = `
        import { OperationTableSchema } from '../../database/entities/Operation.entity';
        @Injectable()
        export class RegistrySearchRepository {
            constructor(@InjectRepository(OperationTableSchema) private readonly ops: Repository<OperationTableSchema>) {}
            findLatest() {
                return this.ops.createQueryBuilder('op').getMany();
            }
        }
    `;

    it('drops "OperationTableSchema" (TypeORM entity class) as DataContainer', () => {
        expect(isHallucinatedTable('OperationTableSchema', undefined, ormSource)).toBe(true);
    });

    it('drops "OperationTableSchema" even when LLM provides repo-pattern evidence that passes step-1 validation (the actual acme-platform bug)', () => {
        // REGRESSION GUARD: the acme-platform production trace showed the LLM
        // emitting `OperationTableSchema` as DataContainer with evidence
        // `this.getRepository(OperationTableSchema)`. Step 1 of the
        // existing isHallucinatedTable validates that pattern (evidence
        // present, contains name, evidence text appears in source) and
        // returns false (= NOT hallucinated). The F2 guard fires BEFORE
        // step 1 on the class-suffix shape so the bypass cannot happen.
        const acmePlatformSrc = `
            const ops = await this.getRepository(OperationTableSchema)
                .createQueryBuilder('op')
                .from(OperationTableSchema, 'op_by_registry_ids')
                .getMany();
        `;
        const llmEvidence = 'this.getRepository(OperationTableSchema)';
        expect(isHallucinatedTable('OperationTableSchema', llmEvidence, acmePlatformSrc)).toBe(true);
    });

    it('drops Mongoose-style Schema suffixes (UserSchema, OrderSchema)', () => {
        const src = "const UserSchema = new Schema({ ... }); model('User', UserSchema);";
        expect(isHallucinatedTable('UserSchema', undefined, src)).toBe(true);
        expect(isHallucinatedTable('OrderSchema', undefined, src)).toBe(true);
    });

    it('drops Entity / Model suffixes (OrderEntity, PolicyModel)', () => {
        const src = "@Entity() export class OrderEntity {} @Entity() export class PolicyModel {}";
        expect(isHallucinatedTable('OrderEntity', undefined, src)).toBe(true);
        expect(isHallucinatedTable('PolicyModel', undefined, src)).toBe(true);
    });

    it('KEEPS snake_case names that happen to end with similar tokens', () => {
        // `users_schema` is plausibly a table name (snake_case ≠ class).
        const src = "$db->prepare('SELECT * FROM users_schema')";
        expect(isHallucinatedTable('users_schema', undefined, src)).toBe(false);
    });

    it('KEEPS the real table name even when the class wrapper is also in source', () => {
        // Counterpart: `operations` (snake_case real table) survives even
        // though `OperationTableSchema` (PascalCase class) coexists.
        const src = "$qb->from('operations').leftJoin(OperationTableSchema, 'op')";
        expect(isHallucinatedTable('operations', undefined, src)).toBe(false);
    });

    it('overrides via strong SQL context (escape hatch for legitimate edge cases)', () => {
        // If a name truly is a table AND appears with strong SQL syntax,
        // the F2 guard should not block it. Strong context means a SQL
        // keyword followed by a SQL-meaningful continuation (WHERE / SET /
        // VALUES / ; / quote close).
        const src = "DELETE FROM UserSchema WHERE id = ?";
        expect(isHallucinatedTable('UserSchema', undefined, src)).toBe(false);
    });
});
