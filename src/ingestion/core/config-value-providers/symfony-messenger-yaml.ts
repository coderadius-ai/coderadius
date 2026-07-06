import yaml from 'js-yaml';
import type { ConfigValueProvider, ConfigValueProviderContext } from './types.js';
import type { ValueFact } from '../value-resolution/types.js';
import { astGrounding } from '../../../graph/grounding.js';

type YamlRecord = Record<string, unknown>;

const ENV_PATTERN = /^%env\((?:[a-z_]+:)*([A-Z][A-Z0-9_]*)\)%$/i;

export class SymfonyMessengerYamlProvider implements ConfigValueProvider {
    readonly id = 'symfony-messenger-yaml';
    readonly label = 'Symfony Messenger YAML';
    readonly contentSignatures = [/framework:\s*[\s\S]*messenger:/i];

    matchFile(relativePath: string, basename: string): boolean {
        return /^(messenger)\.ya?ml$/i.test(basename)
            || /(?:^|\/)config\/packages\/messenger\.ya?ml$/i.test(relativePath)
            || /(?:^|\/)messenger\.ya?ml$/i.test(relativePath);
    }

    extractValueFacts(content: string, context: ConfigValueProviderContext): ValueFact[] {
        const facts: ValueFact[] = [];
        let docs: YamlRecord[];
        try {
            docs = yaml.loadAll(content).filter(isRecord);
        } catch {
            return [];
        }

        for (const doc of docs) {
            const messenger = getRecord(getRecord(doc.framework)?.messenger);
            if (!messenger) continue;

            const transports = getRecord(messenger.transports);
            if (transports) {
                for (const [name, rawTransport] of Object.entries(transports)) {
                    const transport = extractTransportValue(rawTransport);
                    if (!transport) continue;
                    const key = `SymfonyMessenger.transport.${name}`;
                    facts.push(makeFact(context.relativePath, key, transport.expression, transport.kind, {
                        value: transport.value,
                        envKey: transport.envKey,
                        confidence: transport.confidence,
                    }));
                }
            }

            const routing = getRecord(messenger.routing);
            if (routing) {
                for (const [messageClass, rawRoute] of Object.entries(routing)) {
                    const transportName = extractRouteTransport(rawRoute);
                    if (!transportName) continue;
                    const targetKey = `SymfonyMessenger.transport.${transportName}`;
                    for (const routeKey of routeFactKeys(messageClass)) {
                        facts.push(makeFact(context.relativePath, routeKey, String(rawRoute), 'alias', {
                            targetKey,
                            confidence: 0.86,
                        }));
                    }
                }
            }
        }

        return dedupeFacts(facts).slice(0, 500);
    }
}

function extractRouteTransport(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const first = value[0];
        return typeof first === 'string' ? first : null;
    }
    return null;
}

function extractTransportValue(value: unknown): {
    kind: ValueFact['kind'];
    value?: string;
    envKey?: string;
    expression: string;
    confidence: number;
} | null {
    const dsn = typeof value === 'string'
        ? value
        : getString(getRecord(value)?.dsn);
    if (!dsn) return null;

    const env = dsn.match(ENV_PATTERN);
    if (env) {
        return {
            kind: 'env',
            envKey: env[1],
            expression: dsn,
            confidence: 0.7,
        };
    }

    return {
        kind: 'literal',
        value: dsn,
        expression: dsn,
        confidence: 0.93,
    };
}

function routeFactKeys(messageClass: string): string[] {
    const normalized = messageClass.replace(/^\\+/, '').replace(/\\/g, '.');
    const shortName = normalized.includes('.')
        ? normalized.slice(normalized.lastIndexOf('.') + 1)
        : normalized;
    return [...new Set([
        `SymfonyMessenger.routing.${normalized}`,
        `SymfonyMessenger.routing.${shortName}`,
    ])];
}

function makeFact(
    filePath: string,
    key: string,
    expression: string,
    kind: ValueFact['kind'],
    patch: Partial<ValueFact>,
): ValueFact {
    return {
        filePath,
        language: 'php',
        key,
        expression,
        kind,
        value: patch.value,
        envKey: patch.envKey,
        fallbackValue: patch.fallbackValue,
        targetKey: patch.targetKey,
        exported: true,
        exportedAs: key,
        confidence: patch.confidence ?? 0.8,
        grounding: astGrounding('symfony-messenger-yaml@v1'),
        startLine: 1,
        endLine: 1,
    };
}

function getRecord(value: unknown): YamlRecord | null {
    return isRecord(value) ? value : null;
}

function getString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is YamlRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dedupeFacts(facts: ValueFact[]): ValueFact[] {
    const seen = new Set<string>();
    const out: ValueFact[] = [];
    for (const fact of facts) {
        const signature = `${fact.filePath}:${fact.key}:${fact.kind}:${fact.value ?? fact.targetKey ?? fact.envKey ?? ''}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        out.push(fact);
    }
    return out;
}
