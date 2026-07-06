// ═══════════════════════════════════════════════════════════════════════════════
// Name Safety — Deterministic guards for infrastructure resource names
//
// Shared module used by:
//   - src/ai/workflows/sanitizer.ts (LLM-output cleanup)
//   - src/ingestion/core/value-resolution/* (static-bypass output validation)
//
// Pure name-shape predicates + canonical constants. No I/O, no AI imports.
// Anything that operates on a resource NAME (broker, table, payload identifier)
// belongs here, so both the LLM path and the static-bypass path validate
// against the same rules.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Generic Infrastructure Names ───────────────────────────────────────────

/**
 * Generic technology/vendor names that should be DROPPED entirely.
 * If the LLM can't resolve the actual resource name, we omit the node.
 */
export const GENERIC_INFRA_NAMES = new Set([
    'mongodb', 'mongo', 'postgres', 'postgresql', 'mysql', 'redis',
    'rabbitmq', 'kafka', 'elasticsearch', 'database', 'db',
    'google cloud pub/sub', 'google-cloud-pubsub', 'google-pubsub',
    'doctrine',
    'mongoose', 'prisma', 'drizzle', 'eloquent', 'typeorm',
    'mongoclient', 'prismaclient', 'documentmanager', 'entitymanager',
]);

/**
 * ADT discriminator-tag values (ts-pattern, fp-ts, Effect, Rust enums...).
 *
 * These words appear quoted in source as the `_tag` / `kind` / `type` field
 * of a tagged-union variant — never as physical table or routing-key names.
 * Without this list, the LLM hallucinates them as DataContainer or
 * MessageChannel names whenever a discriminated union appears in a
 * function body, and the generic quoted-literal fallback in
 * `isHallucinatedTable` validates them (the literal IS in source).
 *
 * RC2a from acme-platform ingestion analysis: `_tag: 'skipped'` in a ts-pattern
 * match produced a `DataContainer:skipped` node with composite/high
 * grounding, edged from `PreferredEquipmentUpdateConsumer.handleEvent`.
 */
export const DISCRIMINATOR_TAG_WORDS = new Set([
    'success', 'failure', 'pending', 'processed', 'completed', 'consumed',
    'warning', 'error', 'skipped', 'idle', 'loading', 'ready', 'failed',
    'started', 'finished', 'running', 'aborted', 'cancelled', 'canceled',
    'created', 'updated', 'deleted', 'unknown', 'none', 'some', 'left',
    'right', 'ok', 'err', 'init',
]);

/**
 * True if `name` is a single discriminator-tag word AND no strong context
 * in `sourceCode` proves it is a legitimate table/channel.
 *
 * The "strong context" check matches SQL/ORM call sites that reference
 * the bare word with a query-builder syntax. Quoted-string presence
 * (the default fallback in `isHallucinatedTable`) is NOT sufficient
 * here because every discriminator tag is, by construction, a quoted
 * literal in the source.
 */
export function isDiscriminatorTagWord(name: string, sourceCode: string): boolean {
    if (!DISCRIMINATOR_TAG_WORDS.has(name.toLowerCase())) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Strict SQL context: require uppercase keyword (typical SQL formatting,
    // distinguishes from kebab-case identifiers like
    // `preferred-equipment-update`) and end with a SQL-meaningful token
    // (SET / VALUES / WHERE / ; / quote). The default isHallucinatedTable
    // SQL context is broader; the guard for discriminator words must be
    // narrower to avoid false negatives on common log messages.
    const sqlStrictRe = new RegExp(
        `\\b(?:FROM|INTO|JOIN|TABLE)\\s+(?:\`)?${escaped}(?:\`)?(?:\\s+(?:WHERE|SET|VALUES|ON|AS|LIMIT|ORDER|GROUP)|\\s*[;)'"\`])`,
    );
    if (sqlStrictRe.test(sourceCode)) return false;
    const updateRe = new RegExp(
        `\\bUPDATE\\s+(?:\`)?${escaped}(?:\`)?\\s+SET\\b`,
    );
    if (updateRe.test(sourceCode)) return false;
    const builderContext = new RegExp(
        `(?:createQueryBuilder|\\.from|collection|getRepository|model)\\s*\\(\\s*['"\`]${escaped}['"\`]`,
        'i',
    );
    if (builderContext.test(sourceCode)) return false;
    return true;
}

// ─── Code-Expression Shape Guard ─────────────────────────────────────────────

/**
 * True when `name` is CODE-EXPRESSION-shaped rather than a physical resource
 * name. Physical table / queue / topic / routing-key names are plain
 * identifiers (snake_case, kebab-case, dot.separated, camelCase, PascalCase,
 * optionally with a `{var}` stub) — they NEVER contain runtime access /
 * operator syntax. Catches the producer echoing an unresolved access
 * expression instead of the resolved value:
 *
 *   queueOptions['name']   →  bracket access (the RabbitMQ-wrapper FP)
 *   $this->queueName       →  PHP arrow + sigil
 *   config.get('queue')    →  call parens
 *   opts["topic"]          →  bracket access (double-quote)
 *
 * Curly braces are DELIBERATELY excluded: `booking_slot_{type}` /
 * `{providerId}` are legitimate dynamic-stub / REST-param shapes handled by
 * the template predicates (`isDynamicTableStub`, `isUnresolvedTemplateName`).
 *
 * Shared by BOTH provenances via `isNoisyBrokerName` (MessageChannel) and
 * `isUnsafeContainerName` (DataContainer) — shape-based, no name lists.
 */
export function isCodeExpressionName(name: string): boolean {
    const n = name.trim();
    if (!n) return false;
    // Square-bracket access: x['k']  x["k"]  x[`k`]  x[0]  x[idx]
    if (/\[\s*(['"`]|\d|[a-zA-Z_$])/.test(n) || /['"`\d]\s*\]/.test(n)) return true;
    // Member arrow access (PHP / C / Go pointer syntax)
    if (n.includes('->')) return true;
    // Variable sigil ($var, ${var})
    if (/\$\w|\$\{/.test(n)) return true;
    // Call expression: foo(...) — requires a word char before the paren so a
    // pathological-but-parenthesised label does not fire on a leading '('.
    if (/\w\s*\([^)]*\)/.test(n)) return true;
    return false;
}

// ─── SQL Shape Guards (shared by container + channel paths) ─────────────────

/**
 * Published SQL reserved words (SQL-92 ∪ MySQL 8 core set). A bare reserved
 * word can never be an UNQUOTED table identifier, so a "table" named exactly
 * `from`/`and`/`limit` is a query-fragment echo, not a container. EXACT
 * full-token match only: `order_limit`, `from_address` are different tokens
 * and survive. Deliberately NOT included: plausible identifiers that are
 * merely keywords-adjacent (`now`, `operations`, `storage`, `users`).
 */
const SQL_RESERVED_TOKENS = new Set([
    'select', 'from', 'where', 'join', 'inner', 'outer', 'left', 'right',
    'cross', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between',
    'exists', 'union', 'all', 'distinct', 'order', 'group', 'by', 'having',
    'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete',
    'create', 'alter', 'drop', 'table', 'index', 'primary', 'foreign', 'key',
    'references', 'constraint', 'default', 'as', 'asc', 'desc', 'case',
    'when', 'then', 'else', 'end', 'to', 'with',
]);

/** True iff `name` (trimmed, lowercased) is exactly a SQL reserved word. */
export function isSqlReservedTokenName(name: string): boolean {
    return SQL_RESERVED_TOKENS.has(name.trim().toLowerCase());
}

// NOTE: framework DI-handle shapes (Symfony `doctrine.*` namespaces, Laminas
// RabbitMqModule aliases, Messenger `*_transport` ids) are ecosystem grammar,
// NOT cross-language shape rules. They live in the language plugins behind
// `LanguagePlugin.recognizesFrameworkDiHandle` (see
// `core/languages/php/framework-di-handles.ts`); callers compose that hook
// with the agnostic predicates in this module.

// ─── Broker / MessageChannel Name Guards ────────────────────────────────────

/**
 * Noisy MessageChannel names that should be DROPPED.
 * These are class names, variable names, or generic tech names — NOT actual
 * queue/topic/routing_key names.
 */
export const NOISY_BROKER_NAMES = new Set([
    'messagebus', 'message-bus', 'message_bus', 'messagebusinterface',
    'bus', 'amqp', 'rabbitmq', 'kafka', 'queue', 'notificationsender',
    'message_bus.sender', 'cmbnotificationsender', 'event-bus',
    // Placeholder names from wrapper functions the LLM couldn't resolve
    '_opaque_reference', 'unknown', 'dynamic', 'placeholder',
    '<dynamic>', '<DYNAMIC>',
    // Generic tech concepts that are not physical queue/topic names
    'subscription', 'pubsub-subscription', 'pubsub-topic', 'pubsub',
    'dead-letter-queue', 'dlq', 'topic', 'exchange', 'connection',
    // Generic infrastructure concepts that leak from SDK wrappers
    'outbox', 'message-broker', 'event_bus',
    // Generic DI container keys that leak as channel names
    'config', 'configuration', 'settings',
    // Generic tech words the LLM emits when it names the MECHANISM instead of
    // the channel (mail send → "email", websocket client → "websocket", ...).
    // English tech vocabulary only — never customer domain words.
    'email', 'message', 'mailer', 'producer', 'consumer', 'websocket',
    'websocket-channel', 'message-queue', 'email-service', 'docs',
]);

/** Class-suffix detection: physical queues/topics never use app-layer suffixes.
 *  NOTE: Message and Event are EXCLUDED, they are legitimate CQRS routing class suffixes. */
export const BROKER_CLASS_SUFFIX = /(Client|Publisher|Reader|Service|Repository|Sender|Bus|Interface|Handler|UseCase|Usecase|Consumer|Resolver|Manager|Controller|Facade|Orchestrator|Runner|Worker|Processor|Factory|Mapper|Proxy|Decorator|Invoker|Adapter|Provider|Dispatcher|Emitter|Listener|Subscriber|Connection|Transport)$/;

/**
 * Class-suffix detection for ORM/data-layer entity wrappers. Physical table
 * names use snake_case or kebab-case; PascalCase identifiers ending in
 * `TableSchema`, `Schema`, `Entity`, or `Model` are class identifiers
 * (TypeORM entities, Mongoose schemas, Doctrine models), never tables.
 *
 * F2 from acme-platform ingestion analysis: the LLM extracted
 * `OperationTableSchema` as a DataContainer and the existing
 * evidence-validation path in `isHallucinatedTable` accepted it because the
 * LLM provided `this.getRepository(OperationTableSchema)` as evidence and
 * the same text appears verbatim in the consumer source. This guard fires
 * BEFORE the evidence-validation step so a class identifier cannot
 * masquerade as a table even with cooperating LLM evidence.
 */
export const DATA_CLASS_SUFFIX = /^[A-Z][A-Za-z0-9]*(TableSchema|Schema|Entity|Model)$/;

/** OOP message class pattern: PascalCase ending in Command, Event, Message, or Query.
 *  These are CQRS/EventBus routing contracts where the class name IS the channel name. */
export const CQRS_MESSAGE_PATTERN = /^[A-Z][a-zA-Z0-9]+(Command|Event|Message|Query)$/;

/** Infrastructure hostname suffixes, broker hostnames leak when the LLM
 *  extracts AMQP/Redis connection strings as routing keys. */
export const INFRA_HOSTNAME_SUFFIX = /\.(consul|service|local|internal|svc|cluster|amazonaws|azure|gserviceaccount)\b/i;

/** Action-verb prefixes that indicate a CQRS-pattern name was derived from a
 *  method name (e.g. `SaveUpdatedEvent` from `emitSaveUpdatedEvent()`).
 *  Physical routing contracts use domain nouns (OrderCreatedEvent), not action verbs.
 *  Pattern: Verb + PastParticiple (SaveUpdated, EmitCreated, SendProcessed). */
export const CQRS_METHOD_NAME_PREFIX = /^(Emit|Publish|Send|Dispatch|Handle|Process|Execute|Save|Persist|Store|Flush|Sync)[A-Z][a-z]+(ed|ing)[A-Z]/;

/** Technologies where message class names are the routing contract (in-memory / abstract buses) */
export const ABSTRACT_BUS_TECHNOLOGIES = new Set([
    'symfony-messenger', 'mediatr', 'nestjs-cqrs', 'wolverine',
    'masstransit', 'rebus', 'brighter', 'ecotone',
]);

/** Deterministic isDiKey backup: DI service keys typically end with these suffixes */
export const DI_BROKER_SUFFIXES = /\.(publisher|consumer|sender|receiver|producer|subscriber|handler|client|writer|reader|emitter|listener)$/i;

/**
 * Returns true if a broker name is noisy (class name, variable name, or tech name).
 *
 * Pure PascalCase names WITHOUT separators (dots, dashes, underscores) are always
 * class/event names, physical channels ALWAYS contain separators.
 * Examples caught: SaveCreated, InitBrokerQuoteUseCase, UpdatePhoneEmailQuoteUsecase
 * Examples allowed: order.created.result.preferred, hard_delete.user-requested
 */
export function isNoisyBrokerName(name: string, wasResolved = false, technology?: string): boolean {
    // Code-expression shapes (array access, ->, $sigil, call parens) are never
    // physical channels. Checked FIRST — before the wasResolved trust-bypass —
    // so an echoed access expression is rejected even when a (mis)resolution
    // stamped resolved_via on the item.
    if (isCodeExpressionName(name)) return true;
    if (NOISY_BROKER_NAMES.has(name.toLowerCase())) return true;
    if (BROKER_CLASS_SUFFIX.test(name)) return true;

    // Physical channel names never contain whitespace (AMQP/Kafka/PubSub
    // identifier grammars): a spaced name is a prose fragment.
    if (/\s/.test(name.trim())) return true;

    // NOTE: framework DI-handle shapes (`doctrine.*`, `rabbitmq.producer.*`,
    // `*_transport`) are plugin-owned: callers compose this predicate with
    // `plugin.recognizesFrameworkDiHandle(name, 'channel')`, applied BEFORE
    // any resolved-trust bypass (a name still shaped like a DI handle was
    // not resolved to a physical name).

    // Backslash guard: no physical queue/topic/routing-key grammar admits
    // backslashes (Kafka forbids them; AMQP names never use them in
    // practice). Catches namespace-qualified class identifiers
    // ("Acme\Inventory\OrderOrchestrator") and escape artifacts.
    if (name.includes('\\')) return true;

    // Reject infrastructure hostnames/FQDNs that the LLM extracted as routing keys.
    // Physical routing keys use domain-style separators (order.created) but
    // NOT infrastructure suffixes (.consul, .service, .local, .internal, .svc).
    if (INFRA_HOSTNAME_SUFFIX.test(name)) return true;

    // If the name was successfully resolved via a DI registry or config cross-check,
    // we trust its shape. Bus topics are often pure PascalCase (QuoteRequest).
    if (wasResolved) return false;

    // CQRS message classes: PascalCase ending in Command/Event/Message/Query are legitimate
    // routing contracts, not noise. Exempt them from the generic PascalCase rejection below.
    // BUT reject method-name-derived names: the LLM sometimes extracts "SaveUpdatedEvent"
    // from `this.service.emitSaveUpdatedEvent()` instead of the actual routing key.
    // Physical CQRS routing contracts don't start with action verbs.
    if (CQRS_MESSAGE_PATTERN.test(name)) {
        if (CQRS_METHOD_NAME_PREFIX.test(name)) return true;
        // The class name is the channel ONLY on an abstract / in-memory bus
        // (symfony-messenger, mediatr, ...). Over a PHYSICAL transport (Pub/Sub,
        // Kafka, SQS, SNS, RabbitMQ, NATS) the named topic is the channel and the
        // *Event/*Message class is the serialized payload (a DTO / protobuf
        // message), so it is a phantom and must be dropped. When the technology
        // is unknown we stay conservative and keep the name (current behavior).
        const tech = (technology ?? '').toLowerCase();
        if (!tech || ABSTRACT_BUS_TECHNOLOGIES.has(tech)) return false;
        return true;
    }

    const hasSeparators = name.includes('.') || name.includes('-') || name.includes('_');

    // Pure PascalCase without separators = class/event name, never a physical channel.
    // Guard: minimum 5 chars to catch short class names like "Prezzi", "Quote", "Event".
    // 4 chars or less (e.g. "Save") are too ambiguous to drop confidently.
    const isPurePascalCase = /^[A-Z][a-zA-Z0-9]+$/.test(name) && name.length >= 5 && !hasSeparators;
    if (isPurePascalCase) return true;

    // Pure camelCase without separators = variable/config key name (e.g. appChannelSave,
    // topicShipmentBundleV2). Physical channels ALWAYS contain separators.
    // Guard: must have at least one uppercase letter inside (to distinguish from
    // single-word routing keys like "notifications") and minimum 7 chars.
    const isPureCamelCase = /^[a-z][a-zA-Z0-9]+$/.test(name) && name.length >= 7
        && /[A-Z]/.test(name) && !hasSeparators;
    if (isPureCamelCase) return true;

    return false;
}

/**
 * Normalize a MessageChannel name that came from a DI container key.
 * Strips the technology suffix (e.g., '.publisher') to extract the logical channel.
 *
 * Examples:
 *   'notpurchasable.publisher'  -> 'notpurchasable'
 *   'billing.sender'            -> 'billing'
 *   'order.events'              -> 'order.events' (no known suffix, unchanged)
 */
export function normalizeBrokerName(name: string): string {
    return name.replace(DI_BROKER_SUFFIXES, '');
}

// ─── Database Name Guards ───────────────────────────────────────────────────

/** System/infrastructure database names that should never appear as application data nodes.
 *  The LLM extracts these from connection setup code (e.g. MongoDB auth database). */
export const SYSTEM_DATABASE_NAMES = new Set([
    // MongoDB
    'admin', 'local', 'config',
    // MySQL / MariaDB
    'information_schema', 'mysql', 'sys', 'performance_schema',
    // PostgreSQL
    'postgres', 'template0', 'template1',
    // SQL Server
    'master', 'msdb', 'tempdb', 'model',
]);

/** Generic local-IO concepts the LLM occasionally emits as Database when a
 *  function does file/disk I/O (file_get_contents, fopen, fwrite) without
 *  any actual data store. Not C4 DataContainers, drop. */
export const LOCAL_IO_DATABASE_NAMES = new Set([
    'local_filesystem', 'local-filesystem', 'localfilesystem',
    'local_storage', 'local-storage', 'localstorage',
    'filesystem', 'file_system', 'file-system',
    'disk', 'tmpfs', 'tmp_storage',
]);

/** Storage MECHANISM / TRANSPORT tokens that are never a data-container name.
 *  A path/bucket/measurement IS a container; the transport itself ('sftp',
 *  'ftp') or the mechanism word ('filesystem') is the storage TYPE, which the
 *  LLM/static path occasionally echoes as a DataContainer name. Complements
 *  LOCAL_IO_DATABASE_NAMES (which carries the filesystem variants);
 *  `isStorageTypeOrTransportToken` checks both. */
export const STORAGE_TYPE_TRANSPORT_TOKENS = new Set([
    'sftp', 'ftp', 'ftps', 'scp', 'smb', 'nfs', 'webdav', 's3fs', 'sshfs',
    'objectstorage', 'object_storage', 'object-storage',
    // Bare cloud-storage technology tokens: the prompt no longer
    // enumerates them; the deterministic layer is the single source of truth.
    // EXACT full-token match only, so real containers like 's3-uploads' survive.
    's3', 'gcs', 'bucket',
]);

/** True iff `name`, as a full token (trim+lowercase), is a bare storage
 *  mechanism / transport word. EXACT full-token match, never substring, so a
 *  real container that merely contains the word ('sftp-incoming',
 *  'file_imports', 'user_files') is a different token and survives. */
export function isStorageTypeOrTransportToken(name: string): boolean {
    const n = name.trim().toLowerCase();
    return LOCAL_IO_DATABASE_NAMES.has(n) || STORAGE_TYPE_TRANSPORT_TOKENS.has(n);
}

/** Final-segment suffixes of DI service-locator keys that resolve a data
 *  HANDLE (client/manager/connection/...), never a logical data container.
 *  e.g. `$container->get('archive.mongodb.client')` returns the mongo CLIENT,
 *  not a collection. The data-store analogue of DI_BROKER_SUFFIXES.
 *  Generic English handle vocabulary ONLY — ORM-brand class tokens
 *  (entitymanager/documentmanager) are ecosystem grammar and live in the
 *  language plugin's `recognizesFrameworkDiHandle`. */
export const DI_HANDLE_KEY_SUFFIXES = new Set([
    'client', 'manager', 'connection',
    'registry', 'factory', 'provider', 'locator', 'handle', 'handler',
    'dbal', 'adapter', 'pool', 'driver',
]);

/** True iff `name` is a dotted service-locator key whose FINAL segment is a
 *  data-handle suffix. 'archive.mongodb.client' -> true; a schema-qualified
 *  table 'inventory.orders' or a Mongo collection 'order.events' -> false
 *  (their final segment is a domain noun, not a handle word). */
export function isDiServiceLocatorKey(name: string): boolean {
    const parts = name.trim().toLowerCase().split('.');
    if (parts.length < 2) return false;
    if (parts.some(p => !/^[a-z0-9_-]+$/.test(p))) return false; // reject whitespace/SQL/paths
    return DI_HANDLE_KEY_SUFFIXES.has(parts[parts.length - 1]);
}

/** Cloud object-storage prefixed name (s3.bucket, gcs.bucket, ...). Shared so
 *  the sanitizer and the container gate both recognise a bucket as a valid
 *  object container (NEVER dropped). Group 2 is the bare bucket. */
export const CLOUD_OBJECT_PREFIX_RE = /^(s3|gcs|googlecloudstorage|azureblob|cloudflarer2|r2)\.([a-zA-Z0-9_\-]+)$/i;

/** Provider prefix → canonical object technology. */
const CLOUD_OBJECT_TECH: Record<string, string> = {
    s3: 's3', gcs: 'gcs', googlecloudstorage: 'gcs',
    azureblob: 'azureblob', cloudflarer2: 'r2', r2: 'r2',
};

/**
 * Split a `<provider>.<bucket>` cloud-object name into its bare bucket + the
 * canonical object technology. `gcs.acme-invoices` → `{ bucket: 'acme-invoices',
 * technology: 'gcs' }`. Returns null when the name is not that shape, so a
 * schema-qualified table (`inventory.orders`) or a DI key never matches. Shared
 * by the sanitizer (LLM path) and any future static-path repair. Pure.
 */
export function splitCloudObjectName(name: string): { bucket: string; technology: string } | null {
    const m = CLOUD_OBJECT_PREFIX_RE.exec(name.trim());
    if (!m) return null;
    const prefix = m[1].toLowerCase();
    return { bucket: m[2], technology: CLOUD_OBJECT_TECH[prefix] ?? prefix };
}

/** PascalCase tails that mark a name as a property/variable identifier rather
 *  than a database table. Example: LLM extracts `$this->keyFilePath` as a
 *  "table" when it sees `file_get_contents($this->keyFilePath)`. Real tables
 *  never end in `*Path`, `*FilePath`, `*FileName`, `*Url`, `*Uri`,
 *  `*Endpoint`, `*Hostname`. Anchored to require a leading lowercase letter
 *  (camelCase): snake_case names like `user_path` are intentionally NOT
 *  matched (they could be real tables). */
export const PROPERTY_NAME_DATABASE_SUFFIX = /^[a-z][a-zA-Z0-9]*(Path|FilePath|Pathname|FileName|Filename|Url|Uri|URL|URI|Endpoint|Hostname)$/;

/**
 * Evidence-Based Guardrail: verifies that the LLM's (or static-bypass's)
 * claimed Database evidence actually exists in the source code.
 *
 * Catches ghost table hallucinations where the producer:
 * 1. Provides no evidence at all (variable name confusion)
 * 2. Provides repository/ORM wrapper calls as evidence (not direct SQL)
 * 3. Fabricates plausible SQL that doesn't exist in the source code
 *
 * Returns true if the table name is likely hallucinated.
 *
 * IMPORTANT: pass the sourceCode of the file/method where the table evidence
 * SHOULD live. For LLM output, that is the consumer chunk. For DI static
 * bypass, that is the bound method's source slice (the consumer doesn't
 * contain the table literal, the bound class does).
 */
export function isHallucinatedTable(
    name: string,
    evidence: string | undefined,
    sourceCode: string,
): boolean {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 0. RC2a guard: drop ADT discriminator-tag words (`_tag: 'skipped'`,
    //    `kind: 'success'`, ...). These pass the quoted-literal fallback
    //    trivially but are never physical tables. Strong SQL/ORM context
    //    short-circuits the guard so legitimate `FROM skipped` is kept.
    if (isDiscriminatorTagWord(name, sourceCode)) return true;

    // 0b. F2 guard: drop PascalCase ORM/data-layer class identifiers
    //     (`UserSchema`, `OperationTableSchema`, `OrderEntity`, `PolicyModel`).
    //     Strong UPPER-CASE SQL context overrides the guard so a legitimate
    //     `DELETE FROM UserSchema WHERE ...` is kept; the override stays
    //     case-sensitive on the SQL keyword to avoid matching log messages
    //     that contain the lowercase word `from`.
    if (DATA_CLASS_SUFFIX.test(name)) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sqlOverrideRe = new RegExp(
            `\\b(?:FROM|INTO|JOIN|TABLE|UPDATE)\\s+(?:\`)?${escaped}(?:\`)?(?:\\s+(?:WHERE|SET|VALUES|ON|AS|LIMIT|ORDER|GROUP)|\\s*[;)'"\`])`,
        );
        if (!sqlOverrideRe.test(sourceCode)) return true;
    }

    // 1. If evidence is provided, validate it against source code
    if (evidence && evidence.trim().length > 0) {
        // Evidence contains repository/ORM wrapper patterns, not direct SQL
        // EXCEPTION: Allow explicit PHPDoc documentation like "READ: audit_log (via Repository)"
        const isPhpDoc = /READ|WRITE|Writes to/i.test(evidence);
        const hasGenericWrapper = /repository|(?:->|\.)(?:get|find|fetch|load)[a-z0-9_]*\b/i.test(evidence);

        let isValidEvidence = true;

        if (!isPhpDoc && hasGenericWrapper) {
            // If the evidence explicitly contains the table/collection name, it is a valid modern ORM call
            if (!new RegExp(`\\b${escapedName}\\b`, 'i').test(evidence)) {
                isValidEvidence = false;
            }
        }

        if (isValidEvidence) {
            const normalize = (s: string) => s
                .replace(/['"`]/g, '')    // strip quotes
                .replace(/\s+/g, ' ')     // collapse whitespace
                .trim();
            const normSource = normalize(sourceCode);
            const normEvidence = normalize(evidence);

            // Evidence must be long enough and present in source
            if (normEvidence.length >= 6 && normSource.includes(normEvidence)) {
                // The table name itself must also appear with word boundaries
                const nameBoundaryRegex = new RegExp(`(?<![\\w$@#])${escapedName}(?![\\w_])`, 'i');
                if (nameBoundaryRegex.test(sourceCode)) {
                    return false; // Validated via evidence
                }
            }
        }
    }

    // 2. FALLBACKS: If evidence failed or was missing, check deterministic patterns
    // Fallback A: PHPDoc/JSDoc annotations, developer-authored ground truth
    const phpDocPattern = new RegExp(`\\b(?:READS?|WRITES?|Writes to):\\s*${escapedName}\\b`, 'i');
    if (phpDocPattern.test(sourceCode)) return false;

    // Fallback B: SQL context (FROM table, JOIN table, etc.)
    const sqlContextPattern = new RegExp(
        `\\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\\s+(?:\`)?${escapedName}(?:\`)?(?![\\w_])`,
        'i',
    );
    if (sqlContextPattern.test(sourceCode)) return false;

    // Fallback C: ORM QueryBuilder / Mongo collection context
    // Catches: createQueryBuilder('users'), .from('users'), .collection('outbox'),
    //          getRepository('users'), model('users')
    const builderContextPattern = new RegExp(
        `(?:createQueryBuilder|from|collection|getRepository|model)\\s*\\(\\s*['"\`]${escapedName}['"\`]`,
        'i',
    );
    if (builderContextPattern.test(sourceCode)) return false;

    // Fallback D: Quoted string literal, table name appears as a string in source
    // Catches: PHP arrays ($tables = ['delivery_history_express', ...]),
    //          variable assignments ($table = 'orders'), and string concatenations.
    // Guard: requires word boundaries inside the quotes to avoid partial matches.
    const quotedLiteralPattern = new RegExp(
        `['"\`]${escapedName}['"\`]`,
    );
    if (quotedLiteralPattern.test(sourceCode)) return false;

    return true;
}

/**
 * Shared DataContainer name-safety gate, enforced on BOTH provenances: the LLM
 * sanitizer AND the static-bypass validator (the static path skips the
 * sanitizer entirely, so without a shared gate its DataContainer names go
 * unchecked). A name is unsafe when it is a leaked storage mechanism/transport
 * token, a DI service-locator key, a system/generic/local-IO name, a
 * property identifier, an unresolved template, or a path leak. Evidence-based
 * hallucination is checked only when `sourceCode` is supplied (the static
 * literal branch has no source slice at hand; the DI branch does).
 *
 * Cloud object-storage names (s3.x, gcs.x, ...) are EXEMPT: a bucket is a valid
 * non-table container. A malformed prefix is repaired elsewhere, never by
 * deleting the node here.
 */
export function isUnsafeContainerName(
    name: string,
    opts?: { sourceCode?: string },
): boolean {
    const n = name.trim();
    if (!n) return true;
    if (CLOUD_OBJECT_PREFIX_RE.test(n)) return false; // valid object bucket — preserve
    if (isCodeExpressionName(n)) return true; // array access / -> / $sigil / call parens
    const lower = n.toLowerCase();
    if (GENERIC_INFRA_NAMES.has(lower)) return true;
    if (SYSTEM_DATABASE_NAMES.has(lower)) return true;
    if (isSqlReservedTokenName(n)) return true;        // bare SQL keyword = query-fragment echo
    if (/\s/.test(n)) return true;                     // unquoted identifiers cannot contain spaces
    // Framework DI ids (doctrine.* / messenger.*) are plugin-owned: callers
    // compose with plugin.recognizesFrameworkDiHandle(name, 'container').
    if (isStorageTypeOrTransportToken(n)) return true;
    if (isDiServiceLocatorKey(n)) return true;
    if (PROPERTY_NAME_DATABASE_SUFFIX.test(n)) return true;
    if (isUnresolvedTemplateName(n)) return true;
    if (n.includes('/')) return true; // path leak (file extensions handled by isHallucinatedTable)
    if (opts?.sourceCode && isHallucinatedTable(n, undefined, opts.sourceCode)) return true;
    return false;
}

// ─── Template / Placeholder Guards ──────────────────────────────────────────

/**
 * Returns true if `name` contains an unresolved template variable.
 *
 * Catches:
 * - PHP `${name}` / `{$name}`, JS `${name}`, Python `%s/%d` interpolation
 * - UPPER_CASE config placeholders (`{ENV}`, `{CLUSTER}`, `{ENVIRONMENT}`)
 * - The known lowercase env placeholder set used by Symfony/PHP and matched by
 *   `dynamic-infra-resolver.normalizeEnvPlaceholder`: `{envSuffix}`, `{env}`,
 *   `{environment}`, `{tablePrefix}`, `{prefix}`, `{suffix}`. If the resolver
 *   skips a node (e.g. on incremental sync) these would otherwise reach the
 *   graph as literal substrings. Listed explicitly so legitimate REST path
 *   params (`{userId}`, `{orderId}`) are not caught.
 */
export function isUnresolvedTemplateName(name: string): boolean {
    return /\$\w|\{\$|\$\{|%[sd]/.test(name)
        || /\{[A-Z_][A-Z0-9_]*\}/.test(name)
        || /\{(envSuffix|env|environment|tablePrefix|prefix|suffix)\}/.test(name);
}

/**
 * Stricter sibling of `isUnresolvedTemplateName`, specialised for
 * payload / event / table identifiers (NOT URL paths).
 *
 * `isUnresolvedTemplateName` is intentionally conservative: it must
 * preserve REST path params (`/api/users/{userId}`) that legitimately
 * use curly-brace notation. As a consequence it does NOT catch
 * lowercase placeholders like `{tipo}` / `{type}` / `{nome}`, which
 * are syntactically indistinguishable from REST path params.
 *
 * `isTemplatedPayloadName` applies to contexts where braces are NEVER
 * legitimate: a payload / event / class / table identifier cannot
 * contain `{` or `}` in any data model (SQL identifiers, broker topic
 * names, JS/PHP class names, Avro/Protobuf schema names). Any brace
 * in such a context is an unresolved template that leaked from the
 * LLM or static extractor.
 */
export function isTemplatedPayloadName(name: string): boolean {
    return isUnresolvedTemplateName(name) || /[{}]/.test(name);
}

/**
 * Returns true if this Database name is a dynamic stub that should be
 * preserved for post-ingestion expansion by DataEntityPostProcessor.
 * These are NOT dropped, they survive to Stage 4 as wildcard nodes.
 *
 * Examples that return true:
 *   "booking_slot_{type}"   (curly-brace template from LLM)
 *   "res_archive_"          (trailing underscore stub)
 */
export function isDynamicTableStub(name: string): boolean {
    return /_$/.test(name) || /\{[a-zA-Z_]\w*\}/.test(name);
}

/**
 * Returns true if the infrastructure name is entirely wrapped in braces
 * with no static prefix or suffix, indicating raw variable interpolation
 * that leaked from the producer (LLM or static extractor).
 *
 * Cross-language guard:
 *   TS:     {args.ts}, {config.dbName}     -> true
 *   Python: {args.output_file}, {self.x}   -> true
 *   Go:     {args.OutputFile}, {cfg.Name}  -> true
 *   PHP:    {$this->tableName}             -> true
 *
 * Legitimate dynamic stubs always have a static prefix:
 *   booking_slot_{type}                    -> false
 *   fulfillment.shipment{envSuffix}.save   -> false
 */
export function isPurelyDynamicPlaceholder(name: string): boolean {
    return /^\{[^}]+\}$/.test(name);
}

/**
 * If `name` is a dynamic table stub (trailing `_` or `{var}` suffix),
 * return the static prefix string used for STARTS WITH matching.
 * Otherwise return null.
 *
 * Examples:
 *   "res_archive_"        -> "res_archive_"   (trailing _ kept for STARTS WITH)
 *   "booking_slot_{type}" -> "booking_slot_"  (split on '{', take [0])
 *   "booking_slot_hotel"  -> null
 */
export function extractDynamicPrefix(name: string): string | null {
    if (/_$/.test(name)) return name; // keep trailing _ as prefix
    const m = name.match(/^(.+_)\{[a-zA-Z_]\w*\}$/);
    return m ? m[1] : null;
}
