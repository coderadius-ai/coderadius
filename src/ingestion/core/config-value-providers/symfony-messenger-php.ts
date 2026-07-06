/**
 * PHP message-class routing config provider.
 *
 * Detects PHP files that map CQRS message classes to topic-shaped routing keys
 * (Symfony Messenger PHP form, AMQP wrappers, custom message bus configs, etc.),
 * regardless of method name or inner array key name. The pairing
 *
 *   <CQRSClass>::class => '<dot.separated.topic>'
 *
 * is the universal signal — customers free-name the enclosing method
 * (`getMessageMap`, `buildRoutes`, etc.) and the inner key (`routing_key`,
 * `queue_name`, `topic`, ...), so the detector ignores those and looks for the
 * AST shape instead.
 *
 * A secondary file-context gate (`isLikelyMessagingConfig`) prevents collision
 * with RBAC/audit configs that also map Command/Event classes to dot-delimited
 * strings (e.g. `permission.write.admin`): the file must reference at least one
 * messaging contract (Symfony Messenger / AMQP / a bus abstraction) or live in
 * a messaging-named namespace.
 *
 * Emits both FQCN-keyed and short-name-keyed facts. The FQCN key disambiguates
 * same-named classes in different namespaces; the short-name key keeps the
 * existing `symfonyRoutingKeys` lookup behavior at dispatch sites.
 */

import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import type { ConfigValueProvider, ConfigValueProviderContext } from './types.js';
import type { ValueFact } from '../value-resolution/types.js';
import { extractMessageClassRoutingTable } from '../languages/php/message-class-routing-extractor.js';
import { patchLanguage } from '../../processors/parser/jsc-compat.js';
import { astGrounding, applyFallback } from '../../../graph/grounding.js';

let _parser: Parser | null = null;
function parser(): Parser {
    if (!_parser) {
        _parser = new Parser();
        _parser.setLanguage(patchLanguage(phpExport.php));
    }
    return _parser;
}

// CQRS class in an array key position is the cheap content signature.
// Cheaper than parsing; saves a full AST walk on every PHP file.
const CQRS_CLASS_ROUTING = /\b\w+(?:Message|Event|Command|Query)::class\s*=>/;

// File-context gate: the file must look like a messaging configuration,
// not RBAC/audit/permission config. Lightweight string-level checks; the
// file SHOULD reference a messaging contract or live in a messaging-named
// namespace. This is a FILE-level whitelist, not a method/key whitelist,
// so it survives customer renames of methods or array keys.
export const MESSAGING_FILE_SIGNALS = [
    /use\s+Symfony\\Component\\Messenger/,
    /use\s+PhpAmqpLib/,
    /use\s+Enqueue\\/,
    /namespace\s+[^;{]*(?:Amqp|Messenger|Message|EventBus|Broker|Transport|Routing|Queue)/i,
    /\bclass\s+\w*(?:Amqp|Messenger|Routing|Transport|MessageBus|EventBus|MessageMap|MessageRegistry|RoutingTable)\w*/i,
    /function\s+\w*(?:MessageMap|RoutingMap|MessageRegistry|QueueMap)\w*\s*\(/i,
    /\binterface\s+MessageBusInterface\b/,
];
export function isLikelyMessagingConfig(content: string): boolean {
    return MESSAGING_FILE_SIGNALS.some(re => re.test(content));
}

/**
 * Shared tree-sitter PHP parser. Reused by structural plugins that scan PHP
 * files for messaging configuration (see symfony-messenger.plugin.ts).
 */
export function getPhpParser(): Parser {
    return parser();
}

/**
 * Strip env-var placeholders (e.g. `{environment}`) from a routing-key
 * template and collapse the resulting double dots, yielding the canonical
 * routing key identity. Exported so structural plugins can normalise the
 * same way as the value-provider facts.
 */
export function stripTemplatePlaceholders(value: string): string {
    return value
        .replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+|\.+$/g, '');
}

// Accepts BOTH semicolon-terminated and bracketed namespace syntax (PHP 5.3+).
// Leading whitespace tolerated for code embedded inside heredocs/templates.
const NAMESPACE_DECLARATION = /^\s*namespace\s+([\w\\]+)\s*[;{]/m;

export class SymfonyMessengerPhpProvider implements ConfigValueProvider {
    readonly id = 'symfony-messenger-php';
    readonly label = 'PHP message-class routing config';

    readonly contentSignatures = [CQRS_CLASS_ROUTING];

    matchFile(_relativePath: string, basename: string): boolean {
        return basename.endsWith('.php');
    }

    extractValueFacts(content: string, context: ConfigValueProviderContext): ValueFact[] {
        if (!CQRS_CLASS_ROUTING.test(content)) return [];
        if (!isLikelyMessagingConfig(content)) return [];

        let tree: ReturnType<Parser['parse']>;
        try {
            tree = parser().parse(content);
        } catch {
            return [];
        }
        if (!tree?.rootNode) return [];

        const map = extractMessageClassRoutingTable(tree.rootNode);
        if (map.size === 0) return [];

        const nsMatch = NAMESPACE_DECLARATION.exec(content);
        const fileNamespace = nsMatch?.[1] ?? '';

        const facts: ValueFact[] = [];
        for (const [shortName, routingKey] of map) {
            const normalised = stripTemplatePlaceholders(routingKey);
            if (!normalised) continue;

            if (fileNamespace) {
                facts.push(makeFact(
                    context.relativePath,
                    `SymfonyMessenger.routing.${fileNamespace}\\${shortName}`,
                    routingKey,
                    normalised,
                ));
            }
            facts.push(makeFact(
                context.relativePath,
                `SymfonyMessenger.routing.${shortName}`,
                routingKey,
                normalised,
            ));
        }
        return facts;
    }
}

function makeFact(
    filePath: string,
    key: string,
    expression: string,
    value: string,
): ValueFact {
    // Grounding: ast/exact (Tree-sitter walk over AmqpConfig). If template
    // placeholders had to be stripped to canonicalise the routing key, mark
    // the fact with the env-var-stem-normalize fallback to keep the trace.
    const hadPlaceholders = expression.includes('{') || /\{[\w]+\}/.test(expression);
    const baseProv = astGrounding('symfony-messenger-php@v1');
    const prov = hadPlaceholders
        ? applyFallback(baseProv, 'env-var-stem-normalize', 'message-class-routing-extractor@v1')
        : baseProv;
    return {
        filePath,
        language: 'php',
        key,
        expression,
        kind: 'literal',
        value,
        exported: true,
        exportedAs: key,
        confidence: 0.9,    // @deprecated — will be removed when consumers migrate to grounding.quality
        grounding: prov,
        startLine: 1,
        endLine: 1,
    };
}
