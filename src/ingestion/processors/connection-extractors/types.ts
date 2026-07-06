/**
 * Connection extractor plugin contract.
 *
 * Plugins parse framework/language-specific configuration files and emit
 * `PhysicalEndpointHint`s with template-bearing values. They MUST NOT
 * resolve environment variables themselves — env-var resolution is owned
 * by the orchestrator (see env-var-resolver.ts and registry.ts).
 *
 * This separation guarantees that every plugin participates in the same
 * resolution pipeline: chained .env files, Symfony resolve, JS templates,
 * shell expansion, sentinel/cycle handling.
 */

export type TemplateSyntax =
    | 'symfony-env'        // %env(VAR)%, %env(resolve:VAR)%, %env(default:fallback:VAR)%
    | 'js-template'        // process.env.VAR, process.env['VAR']
    | 'shell'              // ${VAR}, ${VAR:-default}, $VAR
    | 'helm'               // {{ .Values.x }}
    | 'spring-property'    // ${spring.X.Y:default}
    | 'none';              // already a literal

export interface PhysicalEndpointHint {
    /** Canonical technology name (e.g. 'mysql', 'postgres', 'mongodb'). */
    technology: string;
    /** Host — may contain a template reference until resolved. */
    host: string;
    /** Port — 0 if template; default-port applied post-resolution by the orchestrator. */
    port: number;
    /**
     * Template expression for the port (e.g. `process.env.DATABASE_PORT`).
     *
     * Used by plugins that know the env-var NAME but not the value at
     * extraction time (e.g. NestJS Zod schema configs). The orchestrator
     * resolves this template against the env map. When present and
     * resolvable, overrides `port` and `defaultPort(technology)`.
     */
    portTemplate?: string;
    /** Logical resource name (database, topic, namespace, bucket). */
    dbName: string;
    /** Postgres schema / Kafka cluster id / namespace qualifier. */
    schemaOrNs?: string;
    /** Bean / connection / data-source alias from the source framework — used by ORM bridge. */
    connectionAlias?: string;
    /** Relative source file path (for audit). */
    sourceFile: string;
    /** Confidence assigned by the plugin based on the source-file class. */
    confidence: 'high' | 'medium' | 'low';
    /** Template syntax used in `host`/`port`/`dbName` — the orchestrator dispatches on this. */
    templateSyntax: TemplateSyntax;
    /** Set by the orchestrator after the resolution pass. */
    isTemplate?: boolean;
    /** Audit trail of resolved env-var names, set by the orchestrator. */
    resolutionTrail?: string[];
    /** Optional: list of entity classes this hint binds to (used by ORM-side awareness). */
    entityBindings?: string[];
    /**
     * True when this hint came from an unambiguous datastore DSN scheme
     * (`mysql://`, `mongodb://`, `redis://`, …) — the connection string itself
     * declares it is a datastore, so it is high-confidence for standalone
     * promotion without a client-library corroboration. NOT set for host/port
     * env trios or plain `http(s)://` HTTP-API URLs (those require the client lib).
     */
    viaDsnScheme?: boolean;
}

/**
 * Hint for an HTTP base URL discovered via env-var synthesis.
 *
 * Unlike `PhysicalEndpointHint` (which models datastores), this hint targets
 * external services consumed over HTTP. The orchestrator either welds it to
 * a known `:Service` (host-label match) or materialises an
 * `:APIInterface(apiSource='env-var')` + `:APIDeployment`.
 *
 * Credentials in the source URL are stripped at synthesis time — this hint
 * never carries `user:pass@`.
 */
export interface HttpEndpointHint {
    /** Always `'http'`. Reserved for future protocol-namespaced HTTP variants. */
    technology: 'http';
    /** Fully-formed base URL with scheme + host (+ optional port + path). */
    baseUrl: string;
    /** Lowercased host extracted from `baseUrl`. */
    host: string;
    /** Explicit port if present in the source; otherwise `undefined`. */
    port?: number;
    /** Logical alias derived from the env-var name (e.g. `PAYMENT_URL` → `payment`). */
    alias: string;
    /** True when the source value retained an unresolved template placeholder. */
    isTemplate: boolean;
    /** True when the source value had no scheme and we defaulted to `https://`. */
    isInferredScheme?: boolean;
    /** Relative path of the `.env`/manifest the variable was read from. */
    sourceFile: string;
    /** Env-var key that produced the hint. */
    sourceEnvKey: string;
    /** Confidence (mirrors the env-var-resolver confidence tier). */
    confidence: 'high' | 'medium' | 'low';
}

export type MessageBrokerHintProvider =
    | 'rabbitmq' | 'kafka' | 'pubsub' | 'sqs' | 'sns'
    | 'azure-service-bus' | 'nats' | 'redis-streams' | 'pulsar';

/** Which emission lane produced a broker candidate. */
export type BrokerCandidateSource =
    | 's0-host-shape'
    | 's1-scheme'
    | 's2-declared-sink'
    | 's3-key-name'
    | 's4-config-declared';

/**
 * Where the candidate's `provider` classification came from. Cleanliness is
 * per-field: a host corroborated by cross-repo value agreement is still a
 * GUESS broker when the provider traces only to a key-name convention
 * ('key-name'). Contract-grade sources: 'scheme' (URI scheme) and 'declared'
 * (coderadius.yaml broker-client declaration).
 */
export type BrokerProviderSource = 'scheme' | 'declared' | 'key-name';

/**
 * Env-derived broker CANDIDATE — never a broker by itself. Candidates persist
 * as `:BrokerCandidate` ledger nodes and only materialise a `:MessageBroker` +
 * `CONNECTS_TO` inside `bindBrokerCandidates()` (anchor on an existing broker,
 * scheme self-anchor, or cross-repo convergence). Hints never carry credentials.
 */
export interface BrokerCandidateHint {
    source: BrokerCandidateSource;
    provider?: MessageBrokerHintProvider;
    providerSource?: BrokerProviderSource;
    /** Raw host as seen in the value; normalization happens at the mutation layer. */
    host: string;
    port?: number;
    /** `'/'` is the KNOWN AMQP default vhost; `undefined` means unknown. */
    vhost?: string;
    sourceEnvKey: string;
    sourceFile: string;
    confidence: 'high' | 'medium' | 'low';
}

/**
 * Broker CONNECTION declared by a published config-module shape
 * (oldsound/laminas `rabbitmq.connection.<name>`, messenger transport DSN).
 * Distinct from `BrokerCandidateHint`: the source is a CONFIG FILE, not an
 * env var — there is no `sourceEnvKey`, and a fake one would poison the
 * reaper and the value-attribution semantics. `connectionName` is the
 * config-level connection identity that the channel-connection binding pass
 * later joins against (same-file scope).
 *
 * vhost policy (explicit): literal → verbatim ('' normalized to '/');
 * accessor template unresolved downstream → the WHOLE hint is dropped;
 * absent → contractual AMQP default '/'. A BrokerConnectionHint therefore
 * ALWAYS carries a vhost for vhost-bearing providers.
 */
export interface BrokerConnectionHint {
    provider: MessageBrokerHintProvider;
    /** Always 'declared' — the config shape is the published module contract. */
    providerSource: 'declared';
    /** Host — may carry a template until resolved by the registry. */
    host: string;
    port?: number;
    /** Template expression for the port (accessor-wrapped values). */
    portTemplate?: string;
    vhost?: string;
    /** Config-level connection name (`default`, `notifications`, transport name). */
    connectionName: string;
    sourceType: 'config';
    templateSyntax: TemplateSyntax;
    /** Relative source file path — join key for channel-connection binding. */
    sourceFile: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface RepoCtx {
    repoPath: string;
}

export interface ConnectionExtractor {
    readonly name: string;
    readonly priority: number;
    /**
     * Discovery predicate: does a repo file with this repo-relative path /
     * lowercased basename look like a config file this extractor parses?
     * The registry's repo walk unions these predicates over all registered
     * extractors, so the agnostic walker carries ZERO framework filename
     * knowledge. Distinct from `matches()` (the extraction gate on the
     * full path): candidateFile is the cheap filename-level filter applied
     * while walking.
     */
    candidateFile(relPath: string, lowerBasename: string): boolean;
    matches(absPath: string, basename: string): boolean;
    extract(absPath: string, content: string, repoCtx: RepoCtx): PhysicalEndpointHint[];
    /**
     * Env-var keys this extractor CONSUMED for the given file — including
     * classifications that produced no hint (e.g. a typed config whose
     * technology signal is missing). The registry aggregates these into
     * `PhysicalHintsResult.claimedEnvKeys` so downstream lanes (broker s0
     * host-shape) subtract them instead of re-matching with parallel regexes.
     */
    claimEnvKeys?(absPath: string, content: string, repoCtx: RepoCtx): string[];
    /**
     * Broker connections declared by this config file (published module
     * shapes only). Consumed by `extractAllBrokerConnectionHints` — template
     * resolution stays with the registry, broker keys are NEVER claimed
     * (dedup happens via candidate identity + provider rank).
     */
    extractBrokers?(absPath: string, content: string, repoCtx: RepoCtx): BrokerConnectionHint[];
}
