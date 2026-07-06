// ═══════════════════════════════════════════════════════════════════════════════
// SymfonyMessengerSymbols — deterministic DI-key → physical-channel extractor
//
// Symfony ContainerBuilder config (`config/services.php`) is the canonical
// source of truth for "DI key → physical RabbitMQ routing key / queue":
//
//   $container->register('payment.completed.publisher', PaymentEventPublisher::class)
//       ->addArgument('%amqp.connection%')
//       ->addTag('messenger.publisher', [
//           'exchange'    => 'payments_exchange',
//           'routing_key' => 'payment.completed.v2',
//       ]);
//
// This shape is fully parseable from the AST/source — no LLM needed. The
// `config-symbol-extractor` LLM agent is unreliable here (its replay cache
// drifts on every edit, and live runs have recorded zero resolved symbols),
// so the deterministic path owns it. Output mirrors the LLM agent's binding
// shape (`{ diKey, physicalName, category, technology }`) so it registers
// through the same `registerRawBinding` codepath.
//
// physicalName rule (mirrors the LLM prompt contract): prefer the `queue` name
// when present (consumers), else the `routing_key` (publishers). NEVER the
// `exchange` name.
//
// This file is PHP/Symfony-specific by design and lives in the language plugin
// layer; the language-agnostic core only sees the exported function.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Global value-fact key namespace (SymfonyMessenger.*) ────────────────────
// The Messenger routing table is a GLOBAL symbol space: a `routing` entry in
// one config file resolves message-class expressions in any other file. The
// PHP plugin claims the namespace; the language-agnostic value-resolution
// engine indexes/looks up only plugin-claimed keys.

const GLOBAL_VALUE_KEY_RE = /^SymfonyMessenger\.(?:routing|transport)\.[A-Za-z0-9_.\\-]+$/;

export function phpRecognizesGlobalValueKey(key: string): boolean {
    return GLOBAL_VALUE_KEY_RE.test(key);
}

/**
 * Candidate global keys for a message-class routing expression. Owns the
 * PHP name normalization: leading-backslash strip, backslash-namespace →
 * dotted, plus the short class name fallback.
 */
export function phpGlobalValueKeysForMessageClass(expression: string): string[] {
    const normalized = expression
        .trim()
        .replace(/^['"`]|['"`]$/g, '')
        .replace(/^\\+/, '')
        .replace(/\\/g, '.');
    const shortName = normalized.includes('.')
        ? normalized.slice(normalized.lastIndexOf('.') + 1)
        : normalized;
    return [...new Set([
        `SymfonyMessenger.routing.${normalized}`,
        `SymfonyMessenger.routing.${shortName}`,
    ])];
}

export interface SymfonyMessengerSymbol {
    /** The DI service id passed to `$container->register('...', ...)`. */
    diKey: string;
    /** Physical channel name: queue (preferred) or routing_key. */
    physicalName: string;
    /** Mirrors the config-symbol-extractor schema (no MessageChannel category). */
    category: 'di_service';
    technology: 'rabbitmq';
    /** Short class name the service binds to (DI propagator territory). */
    boundComponent?: string;
}

const MESSENGER_TAG_HINT = /->\s*addTag\s*\(\s*['"]messenger\.(?:publisher|consumer)['"]/;
const REGISTER_CALL = /->\s*register\s*\(\s*['"]([^'"]+)['"]\s*,\s*\\?([A-Za-z_][A-Za-z0-9_\\]*)\s*::\s*class\s*\)/g;
const MESSENGER_TAG = /->\s*addTag\s*\(\s*['"]messenger\.(?:publisher|consumer)['"]\s*,\s*\[([\s\S]*?)\]/;
const QUEUE_ENTRY = /['"]queue['"]\s*=>\s*['"]([^'"]+)['"]/;
const ROUTING_KEY_ENTRY = /['"]routing_key['"]\s*=>\s*['"]([^'"]+)['"]/;

function shortClassName(fqcn: string): string {
    const cleaned = fqcn.replace(/^\\+/, '');
    return cleaned.includes('\\') ? cleaned.slice(cleaned.lastIndexOf('\\') + 1) : cleaned;
}

/**
 * Parse Symfony `register(...)->addTag('messenger.publisher'|'messenger.consumer', [...])`
 * chains into deterministic DI-key → physical-channel symbol bindings.
 * Returns `[]` when the file carries no messenger tags.
 */
export function extractSymfonyMessengerSymbols(content: string): SymfonyMessengerSymbol[] {
    if (!MESSENGER_TAG_HINT.test(content)) return [];

    const out: SymfonyMessengerSymbol[] = [];
    REGISTER_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REGISTER_CALL.exec(content)) !== null) {
        const diKey = match[1];
        const boundComponent = shortClassName(match[2]);

        // A register() chain terminates at the first `;` — there is none inside
        // the argument list or the tag array, so this bounds the statement.
        const semicolon = content.indexOf(';', match.index);
        const scope = content.slice(match.index, semicolon === -1 ? content.length : semicolon);

        const tag = scope.match(MESSENGER_TAG);
        if (!tag) continue; // a plain service registration (e.g. amqp.connection)

        const tagArray = tag[1];
        const queue = tagArray.match(QUEUE_ENTRY)?.[1];
        const routingKey = tagArray.match(ROUTING_KEY_ENTRY)?.[1];
        const physicalName = queue ?? routingKey;
        if (!physicalName) continue;

        out.push({ diKey, physicalName, category: 'di_service', technology: 'rabbitmq', boundComponent });
    }
    return out;
}
