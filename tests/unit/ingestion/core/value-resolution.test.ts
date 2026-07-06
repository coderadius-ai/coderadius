import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import phpGrammar from 'tree-sitter-php';
import pythonLang from 'tree-sitter-python';
import goLang from 'tree-sitter-go';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { PythonPlugin } from '../../../../src/ingestion/core/languages/python.js';
import { GoPlugin } from '../../../../src/ingestion/core/languages/go.js';
import { SymfonyMessengerYamlProvider } from '../../../../src/ingestion/core/config-value-providers/symfony-messenger-yaml.js';
import {
    buildStaticAnalysisFromResolvedInvocations,
    buildValueResolutionIndex,
    formatResolvedInvocationContext,
} from '../../../../src/ingestion/core/value-resolution/index.js';
import type { FileImportMap } from '../../../../src/ingestion/core/import-graph.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import type { CriticalInvocationFact, ValueFact } from '../../../../src/ingestion/core/value-resolution/types.js';

function parse(source: string, language: Parser.Language): Parser.SyntaxNode {
    const parser = new Parser();
    parser.setLanguage(language);
    return parser.parse(source).rootNode;
}

function chunk(source: string, filepath: string, language: CodeChunk['language']): CodeChunk {
    return {
        name: 'fn',
        filepath,
        sourceCode: source,
        language,
        startLine: 1,
        startColumn: 1,
        endLine: source.split('\n').length,
        endColumn: 1,
    };
}

describe('value resolution', () => {
    it('resolves TypeScript private readonly this.field in a critical publish call', () => {
        const source = `
class Publisher {
    private readonly topic = 'acme.save.created';
    publish(payload: unknown) {
        this.bus.publish(this.topic, payload);
    }
}`;
        const plugin = new TypeScriptPlugin();
        const root = parse(source, ts.typescript as unknown as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/publisher.ts',
            valueFacts: plugin.extractValueFacts(root, source, 'src/publisher.ts'),
            criticalInvocations: plugin.extractCriticalInvocations(root, source, 'src/publisher.ts'),
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/publisher.ts', chunk(source, 'src/publisher.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({
            resolvedValue: 'acme.save.created',
            complete: true,
        });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)?.infrastructure).toContainEqual(
            expect.objectContaining({ name: 'acme.save.created', type: 'MessageChannel', operation: 'WRITES' }),
        );
    });

    it('RC3a: extracts routing key from NestJS-style emitEvent({eventConfiguration: {routingKey: [this.X]}})', () => {
        // Real shape lifted from acme-platform apps/api/src/infrastructure/quote/Quote.service.ts.
        // Before RC3a the LLM was the only path and routinely hallucinated the
        // exchange (`ha.inventory`) as MessageChannel because:
        //   1. `extractTypeScriptCriticalInvocations` only inspected top-level
        //      pairs of the first object arg, never the nested
        //      `eventConfiguration.routingKey` array.
        //   2. `isCriticalObjectCallee` did not include `emitEvent` /
        //      `dispatch` (only `emit` / `send` / `publish`).
        // Result: zero serviceId fact for the routing key, sanitizer dropped
        // the LLM-emitted exchange, infrastructure ended up empty,
        // `acme.order.created` never reached the graph.
        const source = `
class QuoteService {
    private readonly QUOTE_CREATED_EVENT = 'acme.order.created'

    constructor(
        private readonly messageEmitterService: any,
        private readonly rabbitMqConfig: any,
    ) {}

    emitQuoteCreatedEvent = (quoteId: any) => {
        return this.messageEmitterService.emitEvent({
            eventName: this.QUOTE_CREATED_EVENT,
            eventConfiguration: {
                routingKey: [this.QUOTE_CREATED_EVENT],
                exchange: this.rabbitMqConfig.exchange,
            },
            message: JSON.stringify({ quoteId }),
        }, quoteId);
    };
}`;
        const plugin = new TypeScriptPlugin();
        const root = parse(source, ts.typescript as unknown as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/Quote.service.ts',
            valueFacts: plugin.extractValueFacts(root, source, 'src/Quote.service.ts'),
            criticalInvocations: plugin.extractCriticalInvocations(root, source, 'src/Quote.service.ts'),
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/Quote.service.ts', chunk(source, 'src/Quote.service.ts', 'typescript'));
        const channel = resolved.find(r => r.resolvedValue === 'acme.order.created');
        expect(channel).toBeDefined();
        expect(channel!.invocation.resourceType).toBe('MessageChannel');
        expect(channel!.invocation.operation).toBe('WRITES');
        expect(channel!.complete).toBe(true);

        // End-to-end: the bypass produces the MessageChannel with the
        // resolved routing key value, not the exchange.
        const infra = buildStaticAnalysisFromResolvedInvocations(resolved)?.infrastructure ?? [];
        expect(infra).toContainEqual(
            expect.objectContaining({ name: 'acme.order.created', type: 'MessageChannel', operation: 'WRITES' }),
        );
    });

    it('resolves TypeScript imported Zod defaults through parse(process.env)', () => {
        const configSource = `
import { z } from 'zod';
export const evtConfigSchema = z.object({
    EVT_TOPIC_SAVE: z.string().default('acme.save.created'),
});
export const config = evtConfigSchema.parse(process.env);
`;
        const serviceSource = `
import { config } from './EventBus.config';
export function createDependencies(db: unknown) {
    return createAdapter({ topicName: config.EVT_TOPIC_SAVE });
}
`;
        const plugin = new TypeScriptPlugin();
        const configRoot = parse(configSource, ts.typescript as unknown as Parser.Language);
        const serviceRoot = parse(serviceSource, ts.typescript as unknown as Parser.Language);
        const imports: FileImportMap[] = [{
            filePath: 'src/service.ts',
            imports: plugin.extractImports(serviceRoot, {
                filePath: 'src/service.ts',
                allFilePaths: new Set(['src/service.ts', 'src/EventBus.config.ts']),
                dependencyMappings: [],
            }),
            exportedSymbols: [],
        }];

        const index = buildValueResolutionIndex([
            {
                filePath: 'src/EventBus.config.ts',
                valueFacts: plugin.extractValueFacts(configRoot, configSource, 'src/EventBus.config.ts'),
                criticalInvocations: [],
            },
            {
                filePath: 'src/service.ts',
                valueFacts: plugin.extractValueFacts(serviceRoot, serviceSource, 'src/service.ts'),
                criticalInvocations: plugin.extractCriticalInvocations(serviceRoot, serviceSource, 'src/service.ts'),
            },
        ], imports);

        const resolved = index.resolveInvocationsForChunk('src/service.ts', chunk(serviceSource, 'src/service.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({
            resolvedValue: 'acme.save.created',
            fallbackValue: 'acme.save.created',
            envKey: 'EVT_TOPIC_SAVE',
            complete: true,
        });
    });

    it('resolves NestJS registerAs() cross-file config through an @Inject(X.KEY)-injected property', () => {
        // Real shape: a registerAs() factory config file + a wrapper-service
        // consumer whose constructor injects the config via @Inject(X.KEY),
        // typed ConfigType<typeof X>. Before this fix extractTypeScriptValueFacts
        // never parsed `export default registerAs(...)` and there was no alias
        // bridging `this.relayConfig` back to the imported `OutboxConfig`
        // module, so `this.relayConfig.channelSave` always fell through to
        // `unresolved` and the topic name was lost.
        const configSource = `
import { registerAs } from '@nestjs/config';
export default registerAs('outbox', () => ({
    channelSave: process.env.OUTBOX_CHANNEL_SAVE || 'acme.order.save',
}));
`;
        const publisherSource = `
import OutboxConfig from './Outbox.config';
class OutboxPublisher {
    constructor(
        @Inject(OutboxConfig.KEY)
        private readonly relayConfig: ConfigType<typeof OutboxConfig>,
    ) {}

    async publishOrderSave(): Promise<void> {
        await this.outboxService.publish({ topic: this.relayConfig.channelSave });
    }
}
`;
        const plugin = new TypeScriptPlugin();
        const configRoot = parse(configSource, ts.typescript as unknown as Parser.Language);
        const publisherRoot = parse(publisherSource, ts.typescript as unknown as Parser.Language);
        const imports: FileImportMap[] = [{
            filePath: 'src/OutboxPublisher.ts',
            imports: plugin.extractImports(publisherRoot, {
                filePath: 'src/OutboxPublisher.ts',
                allFilePaths: new Set(['src/OutboxPublisher.ts', 'src/Outbox.config.ts']),
                dependencyMappings: [],
            }),
            exportedSymbols: [],
        }];

        const index = buildValueResolutionIndex([
            {
                filePath: 'src/Outbox.config.ts',
                valueFacts: plugin.extractValueFacts(configRoot, configSource, 'src/Outbox.config.ts'),
                criticalInvocations: [],
            },
            {
                filePath: 'src/OutboxPublisher.ts',
                valueFacts: plugin.extractValueFacts(publisherRoot, publisherSource, 'src/OutboxPublisher.ts'),
                criticalInvocations: plugin.extractCriticalInvocations(publisherRoot, publisherSource, 'src/OutboxPublisher.ts'),
            },
        ], imports);

        // Cross-file DI-alias chains stack discounted confidence (alias hop x
        // import hop x fallback-value hop) below the static-bypass floor, same
        // as the Zod cross-file case above — so this asserts the resolved
        // value/completeness that reaches the LLM prompt as enrichment
        // context, not eligibility for the deterministic-only fast path.
        const resolved = index.resolveInvocationsForChunk('src/OutboxPublisher.ts', chunk(publisherSource, 'src/OutboxPublisher.ts', 'typescript'));
        const channel = resolved.find(r => r.resolvedValue === 'acme.order.save');
        expect(channel).toBeDefined();
        expect(channel!.complete).toBe(true);
        expect(channel!.invocation.resourceType).toBe('MessageChannel');
    });

    it('keeps env-only values incomplete so they enrich prompts but do not static-first', () => {
        const source = `
const topic = process.env.TOPIC_NAME;
export function publishPayment(bus: any) {
    bus.publish(topic, {});
}
`;
        const plugin = new TypeScriptPlugin();
        const root = parse(source, ts.typescript as unknown as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/payment.ts',
            valueFacts: plugin.extractValueFacts(root, source, 'src/payment.ts'),
            criticalInvocations: plugin.extractCriticalInvocations(root, source, 'src/payment.ts'),
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/payment.ts', chunk(source, 'src/payment.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({ envKey: 'TOPIC_NAME', complete: false });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('extracts polyglot fallback facts without crashing unsupported syntax', () => {
        const php = new PHPPlugin();
        const py = new PythonPlugin();
        const go = new GoPlugin();
        const phpRoot = parse(`<?php $topic = getenv('TOPIC') ?: 'php.topic'; $bus->publish($topic);`, (phpGrammar as any).php as Parser.Language);
        const pyRoot = parse(`topic = os.getenv("TOPIC", "py.topic")\nbus.publish(topic)`, pythonLang as unknown as Parser.Language);
        const goRoot = parse(`package main\nconst Topic = "go.topic"\nfunc f(){ bus.Publish(Topic) }`, goLang as unknown as Parser.Language);

        expect(php.extractValueFacts(phpRoot, phpRoot.text, 'a.php').some(f => f.fallbackValue === 'php.topic')).toBe(true);
        expect(py.extractValueFacts(pyRoot, pyRoot.text, 'a.py').some(f => f.fallbackValue === 'py.topic')).toBe(true);
        expect(go.extractValueFacts(goRoot, goRoot.text, 'a.go').some(f => f.value === 'go.topic')).toBe(true);
    });

    it('detects local alias cycles and disables static-first', () => {
        const facts: ValueFact[] = [
            valueFact('src/cycle.ts', 'a', { targetKey: 'b', startLine: 1 }),
            valueFact('src/cycle.ts', 'b', { targetKey: 'a', startLine: 2 }),
        ];
        const invocation = invocationFact('src/cycle.ts', 'bus.publish', 'a', 3);
        const index = buildValueResolutionIndex([{
            filePath: 'src/cycle.ts',
            valueFacts: facts,
            criticalInvocations: [invocation],
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/cycle.ts', chunk('a\nb\nbus.publish(a)', 'src/cycle.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({
            complete: false,
            failureReason: 'cycle_detected',
        });
        expect(resolved[0].trace.join('\n')).toContain('cycle_detected');
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('stops recursive alias resolution at the cross-file depth limit', () => {
        const inputs = Array.from({ length: 10 }, (_, idx) => {
            const filePath = `src/f${idx}.ts`;
            const nextPath = `src/f${idx + 1}.ts`;
            return {
                filePath,
                valueFacts: [
                    idx === 9
                        ? valueFact(filePath, 'value', { value: 'too.deep', startLine: 1 })
                        : valueFact(filePath, 'value', { targetKey: `v${idx + 1}.value`, startLine: 1 }),
                ],
                criticalInvocations: idx === 0 ? [invocationFact(filePath, 'bus.publish', 'value', 2)] : [],
                nextPath,
            };
        });
        const importMaps: FileImportMap[] = inputs.slice(0, 9).map((input, idx) => ({
            filePath: input.filePath,
            imports: [{
                source: `./f${idx + 1}`,
                specifiers: ['*'],
                isExternal: false,
                specifierBindings: [{ imported: '*', local: `v${idx + 1}`, kind: 'namespace' }],
            }],
            exportedSymbols: ['value'],
        }));

        const index = buildValueResolutionIndex(inputs.map(({ filePath, valueFacts, criticalInvocations }) => ({
            filePath,
            valueFacts,
            criticalInvocations,
        })), importMaps);
        const resolved = index.resolveInvocationsForChunk('src/f0.ts', chunk('value\nbus.publish(value)', 'src/f0.ts', 'typescript'));

        expect(resolved[0]).toMatchObject({
            complete: false,
            failureReason: 'depth_exceeded',
        });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('marks unresolved imports incomplete instead of guessing values', () => {
        const source = `
import { topic } from './missing-config';
export function f(bus: any) {
    bus.publish(topic, {});
}
`;
        const plugin = new TypeScriptPlugin();
        const root = parse(source, ts.typescript as unknown as Parser.Language);
        const imports: FileImportMap[] = [{
            filePath: 'src/service.ts',
            imports: plugin.extractImports(root, {
                filePath: 'src/service.ts',
                allFilePaths: new Set(['src/service.ts']),
                dependencyMappings: [],
            }),
            exportedSymbols: [],
        }];
        const index = buildValueResolutionIndex([{
            filePath: 'src/service.ts',
            valueFacts: plugin.extractValueFacts(root, source, 'src/service.ts'),
            criticalInvocations: plugin.extractCriticalInvocations(root, source, 'src/service.ts'),
        }], imports);

        const resolved = index.resolveInvocationsForChunk('src/service.ts', chunk(source, 'src/service.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({
            complete: false,
            failureReason: 'unresolved_import',
        });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('does not static-first generic local emit calls even when the event name is literal', () => {
        const source = `
const eventName = 'local.ready';
export function f(emitter: any) {
    emitter.emit(eventName);
}
`;
        const plugin = new TypeScriptPlugin();
        const root = parse(source, ts.typescript as unknown as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/local.ts',
            valueFacts: plugin.extractValueFacts(root, source, 'src/local.ts'),
            criticalInvocations: plugin.extractCriticalInvocations(root, source, 'src/local.ts'),
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/local.ts', chunk(source, 'src/local.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({ resolvedValue: 'local.ready', complete: true });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('degrades computed dynamic properties without static-first', () => {
        const source = `
const config = { topic: 'known.topic' };
export function f(bus: any, key: string) {
    bus.publish(config[key], {});
}
`;
        const plugin = new TypeScriptPlugin();
        const root = parse(source, ts.typescript as unknown as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/dynamic.ts',
            valueFacts: plugin.extractValueFacts(root, source, 'src/dynamic.ts'),
            criticalInvocations: plugin.extractCriticalInvocations(root, source, 'src/dynamic.ts'),
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/dynamic.ts', chunk(source, 'src/dynamic.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({
            complete: false,
            failureReason: 'unknown',
        });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('applies scope shadowing so inner aliases win over module constants', () => {
        const source = `
const topic = 'module.topic';
export function f(bus: any) {
    const topic = 'local.topic';
    bus.publish(topic, {});
}
`;
        const plugin = new TypeScriptPlugin();
        const root = parse(source, ts.typescript as unknown as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/shadow.ts',
            valueFacts: plugin.extractValueFacts(root, source, 'src/shadow.ts'),
            criticalInvocations: plugin.extractCriticalInvocations(root, source, 'src/shadow.ts'),
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/shadow.ts', chunk(source, 'src/shadow.ts', 'typescript'));
        expect(resolved[0]).toMatchObject({
            resolvedValue: 'local.topic',
            complete: true,
        });
    });

    it('caps resolved invocation context output for large chunks', () => {
        const resolved = Array.from({ length: 40 }, (_, idx) => ({
            originalExpression: `topic${idx}`,
            resolvedValue: `topic.${idx}`,
            trace: Array.from({ length: 4 }, (__, traceIdx) => `step ${idx}.${traceIdx}`),
            confidence: 0.95,
            complete: true,
            invocation: invocationFact('src/many.ts', 'bus.publish', `topic${idx}`, idx + 1),
        }));

        const context = formatResolvedInvocationContext(resolved);
        expect(context).toBeDefined();
        expect(context!.length).toBeLessThanOrEqual(3020);
        expect((context!.match(/bus\.publish/g) ?? []).length).toBeLessThanOrEqual(20);
        expect((context!.match(/trace:/g) ?? []).length).toBeLessThanOrEqual(30);
    });

    it('extracts Python and Go local import maps for cross-file resolution', () => {
        const py = new PythonPlugin();
        const pyRoot = parse(`from config import TOPIC\nbus.publish(TOPIC)`, pythonLang as unknown as Parser.Language);
        const pyImports = py.extractImports(pyRoot, {
            filePath: 'app/service.py',
            allFilePaths: new Set(['app/service.py', 'app/config.py']),
            dependencyMappings: [],
        });
        expect(pyImports[0]).toMatchObject({
            source: 'app/config.py',
            isExternal: false,
            specifierBindings: [expect.objectContaining({ imported: 'TOPIC', local: 'TOPIC', kind: 'named' })],
        });

        const go = new GoPlugin();
        const goRoot = parse(`package service\nimport cfg "app/config"\nfunc f(){ bus.Publish(cfg.Topic) }`, goLang as unknown as Parser.Language);
        const goImports = go.extractImports(goRoot, {
            filePath: 'service/service.go',
            allFilePaths: new Set(['service/service.go', 'config/config.go']),
            dependencyMappings: [],
        });
        expect(goImports[0]).toMatchObject({
            source: 'config/config.go',
            isExternal: false,
            specifierBindings: [expect.objectContaining({ local: 'cfg', kind: 'namespace' })],
        });
    });

    it('resolves PHP assigned require config arrays through recursive subscripts', () => {
        const php = new PHPPlugin();
        const configSource = `<?php
return ['messaging' => ['topic' => env('TOPIC_NAME', 'fallback.topic')]];
`;
        const serviceSource = `<?php
$config = require __DIR__ . '/config.php';
$bus->publish($config['messaging']['topic'], []);
`;
        const configRoot = parse(configSource, (phpGrammar as any).php as Parser.Language);
        const serviceRoot = parse(serviceSource, (phpGrammar as any).php as Parser.Language);
        const imports: FileImportMap[] = [{
            filePath: 'src/service.php',
            imports: php.extractImports(serviceRoot, {
                filePath: 'src/service.php',
                allFilePaths: new Set(['src/service.php', 'src/config.php']),
                dependencyMappings: [],
            }),
            exportedSymbols: [],
        }];

        const index = buildValueResolutionIndex([
            {
                filePath: 'src/config.php',
                valueFacts: php.extractValueFacts(configRoot, configSource, 'src/config.php'),
                criticalInvocations: [],
            },
            {
                filePath: 'src/service.php',
                valueFacts: php.extractValueFacts(serviceRoot, serviceSource, 'src/service.php'),
                criticalInvocations: php.extractCriticalInvocations(serviceRoot, serviceSource, 'src/service.php'),
            },
        ], imports);

        expect(imports[0].imports[0].source).toBe('src/config.php');
        expect(imports[0].imports[0].specifiers).toEqual(['default']);
        expect(imports[0].imports[0].specifierBindings?.[0]).toEqual({
            imported: 'default',
            local: 'config',
            kind: 'default',
        });

        const resolved = index.resolveInvocationsForChunk('src/service.php', chunk(serviceSource, 'src/service.php', 'php'));
        expect(resolved[0]).toMatchObject({
            resolvedValue: 'fallback.topic',
            fallbackValue: 'fallback.topic',
            envKey: 'TOPIC_NAME',
            complete: true,
        });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)?.infrastructure).toContainEqual(
            expect.objectContaining({ name: 'fallback.topic', type: 'MessageChannel', operation: 'WRITES' }),
        );
    });

    it('registers PHP service-locator calls as critical invocations with prompt-only role', () => {
        // Regression: $container->get('di.key') previously bypassed the LLM,
        // losing DI-bound channels like 'orders.events.consumer'. The plugin
        // must now emit a prompt-only-role critical invocation so the static-
        // bypass guard routes the function through the LLM + DI registry.
        const php = new PHPPlugin();
        const source = `<?php
class OrderEventsHandler {
    private $container;
    private \\PDO $db;
    public function handleIncomingOrders(): void {
        $consumer = $this->container->get('orders.events.consumer');
        $consumer->receive();
        $this->db->prepare("INSERT INTO payment_queue (id) VALUES (:id)");
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invocations = php.extractCriticalInvocations(root, source, 'src/Handler.php');

        const serviceLocator = invocations.find(i => i.resourceRole === 'serviceId');
        expect(serviceLocator).toBeDefined();
        expect(serviceLocator!.resourceExpression).toBe('"orders.events.consumer"');

        // The static-bypass guard MUST treat this as prompt-only so the
        // function falls through to the LLM (where DI registry resolves the key).
        const index = buildValueResolutionIndex([{
            filePath: 'src/Handler.php',
            valueFacts: php.extractValueFacts(root, source, 'src/Handler.php'),
            criticalInvocations: invocations,
        }], []);
        const resolved = index.resolveInvocationsForChunk('src/Handler.php', chunk(source, 'src/Handler.php', 'php'));
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it.each([
        { builtin: 'exec', arg: '"/usr/bin/php worker.php"' },
        { builtin: 'passthru', arg: '"/usr/bin/tar -xzf archive.tar.gz"' },
        { builtin: 'system', arg: '"/bin/sh deploy.sh"' },
        { builtin: 'shell_exec', arg: '"git pull"' },
        { builtin: 'proc_open', arg: '"/usr/bin/python script.py"' },
        { builtin: 'popen', arg: '"tail -f /var/log/app.log"' },
        { builtin: 'pcntl_exec', arg: '"/usr/bin/php"' },
    ])('registers PHP builtin $builtin as Process WRITES critical invocation', ({ builtin, arg }) => {
        // Regression for eval-graph TravelGlobal.runScraper: legacy PHP monoliths
        // use exec/system/etc. as their I/O boundary. These are language builtins
        // (no import), so the import-based taint registry can't see them. They
        // must be emitted as CriticalInvocationFact so heuristic-filter Gate 5
        // / static-resolution schedules the host function for analysis even
        // when the class lacks a Runner/Scraper suffix.
        const php = new PHPPlugin();
        const source = `<?php
class LegacyJobs {
    public function spawn() {
        ${builtin}(${arg});
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invocations = php.extractCriticalInvocations(root, source, 'src/Jobs.php');

        const processFact = invocations.find(i => i.resourceType === 'Process' && i.callee === builtin);
        expect(processFact, `Expected Process CriticalInvocationFact for ${builtin}`).toBeDefined();
        expect(processFact!.operation).toBe('WRITES');
        expect(processFact!.resourceExpression).toContain(arg.replace(/['"]/g, ''));
    });

    it('does NOT register $container->get on non-container receivers', () => {
        // Guard against false-positive registration on unrelated receivers.
        const php = new PHPPlugin();
        const source = `<?php
class OrderRepo {
    public function findById($id) {
        return $this->orders->get($id);  // DTO accessor, NOT a service locator
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invocations = php.extractCriticalInvocations(root, source, 'src/Repo.php');
        const hasServiceId = invocations.some(i => i.resourceRole === 'serviceId');
        expect(hasServiceId).toBe(false);
    });

    it('resolves PHP PSR-4 use aliases to class constants across files', () => {
        const php = new PHPPlugin();
        const configSource = `<?php
namespace App\\Config;
final class TopicConfig {
    public const PAYMENT_COMPLETED = 'payment.completed';
}
`;
        const serviceSource = `<?php
namespace App\\Service;
use App\\Config\\TopicConfig as Topics;

class Publisher {
    public function publish(array $event): void {
        $bus->publish(Topics::PAYMENT_COMPLETED, $event);
    }
}
`;
        const configRoot = parse(configSource, (phpGrammar as any).php as Parser.Language);
        const serviceRoot = parse(serviceSource, (phpGrammar as any).php as Parser.Language);
        const imports: FileImportMap[] = [{
            filePath: 'src/Service/Publisher.php',
            imports: php.extractImports(serviceRoot, {
                filePath: 'src/Service/Publisher.php',
                allFilePaths: new Set(['src/Service/Publisher.php', 'src/Config/TopicConfig.php']),
                dependencyMappings: [{ prefix: 'App\\', directory: 'src' }],
            }),
            exportedSymbols: [],
        }];
        expect(imports[0].imports[0].specifierBindings).toContainEqual(
            expect.objectContaining({ imported: 'TopicConfig', local: 'Topics', kind: 'named' }),
        );

        const index = buildValueResolutionIndex([
            {
                filePath: 'src/Config/TopicConfig.php',
                valueFacts: php.extractValueFacts(configRoot, configSource, 'src/Config/TopicConfig.php'),
                criticalInvocations: [],
            },
            {
                filePath: 'src/Service/Publisher.php',
                valueFacts: php.extractValueFacts(serviceRoot, serviceSource, 'src/Service/Publisher.php'),
                criticalInvocations: php.extractCriticalInvocations(serviceRoot, serviceSource, 'src/Service/Publisher.php'),
            },
        ], imports);

        const resolved = index.resolveInvocationsForChunk('src/Service/Publisher.php', chunk(serviceSource, 'src/Service/Publisher.php', 'php'));
        expect(resolved[0]).toMatchObject({
            resolvedValue: 'payment.completed',
            complete: true,
        });
    });

    it('resolves PHP promoted Autowire properties used as publish receivers', () => {
        const php = new PHPPlugin();
        const source = `<?php
use Symfony\\Component\\DependencyInjection\\Attribute\\Autowire;

class PaymentController {
    public function __construct(
        #[Autowire(service: 'data_backbone.topics.payment_completed')]
        private Topic $topic,
    ) {}

    public function publish(array $event): void {
        $this->topic->publish($event);
    }
}
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invocations = php.extractCriticalInvocations(root, source, 'src/PaymentController.php');
        expect(invocations[0]).toMatchObject({
            resourceExpression: '$this->topic',
            resourceRole: 'topic',
        });

        const index = buildValueResolutionIndex([{
            filePath: 'src/PaymentController.php',
            valueFacts: php.extractValueFacts(root, source, 'src/PaymentController.php'),
            criticalInvocations: invocations,
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/PaymentController.php', chunk(source, 'src/PaymentController.php', 'php'));
        expect(resolved[0]).toMatchObject({
            resolvedValue: 'data_backbone.topics.payment_completed',
            complete: true,
        });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)?.infrastructure).toContainEqual(
            expect.objectContaining({ name: 'data_backbone.topics.payment_completed', type: 'MessageChannel' }),
        );
    });

    it('keeps PHP Messenger dispatch message classes prompt-only', () => {
        const php = new PHPPlugin();
        const source = `<?php
class Publisher {
    public function publish(array $data): void {
        $this->messageBus->dispatch(new OrderCreatedMessage($data));
    }
}
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invocations = php.extractCriticalInvocations(root, source, 'src/Publisher.php');
        expect(invocations[0]).toMatchObject({
            resourceExpression: 'OrderCreatedMessage',
            resourceRole: 'messageClass',
            confidence: 0.72,
        });

        const index = buildValueResolutionIndex([{
            filePath: 'src/Publisher.php',
            valueFacts: php.extractValueFacts(root, source, 'src/Publisher.php'),
            criticalInvocations: invocations,
        }], []);
        const resolved = index.resolveInvocationsForChunk('src/Publisher.php', chunk(source, 'src/Publisher.php', 'php'));
        expect(resolved[0]).toMatchObject({ complete: false });
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('resolves PHP Messenger message classes through Symfony YAML routing facts for prompt enrichment only', () => {
        const php = new PHPPlugin();
        const provider = new SymfonyMessengerYamlProvider();
        const yamlSource = `
framework:
  messenger:
    routing:
      App\\Message\\OrderCreatedMessage: [async, audit_log]
    transports:
      async: '%env(MESSENGER_TRANSPORT_DSN)%'
      audit_log: 'sync://'
`;
        const serviceSource = `<?php
use App\\Message\\OrderCreatedMessage;

class Publisher {
    public function publish(array $data): void {
        $this->messageBus->dispatch(new OrderCreatedMessage($data));
    }
}
`;
        const serviceRoot = parse(serviceSource, (phpGrammar as any).php as Parser.Language);
        const index = buildValueResolutionIndex([
            {
                filePath: 'config/packages/messenger.yaml',
                valueFacts: provider.extractValueFacts(yamlSource, {
                    relativePath: 'config/packages/messenger.yaml',
                    repoRoot: '/repo',
                    repoName: 'repo',
                }),
                criticalInvocations: [],
            },
            {
                filePath: 'src/Publisher.php',
                valueFacts: php.extractValueFacts(serviceRoot, serviceSource, 'src/Publisher.php'),
                criticalInvocations: php.extractCriticalInvocations(serviceRoot, serviceSource, 'src/Publisher.php'),
            },
        ], []);

        const resolved = index.resolveInvocationsForChunk('src/Publisher.php', chunk(serviceSource, 'src/Publisher.php', 'php'));
        expect(resolved[0]).toMatchObject({
            envKey: 'MESSENGER_TRANSPORT_DSN',
            complete: false,
        });
        expect(resolved[0].trace.join('\n')).toContain('OrderCreatedMessage -> SymfonyMessenger.routing.OrderCreatedMessage');
        expect(resolved[0].trace.join('\n')).toContain('SymfonyMessenger.transport.async');
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('extracts Symfony Messenger YAML routing and transport facts conservatively', () => {
        const provider = new SymfonyMessengerYamlProvider();
        const facts = provider.extractValueFacts(`
framework:
  messenger:
    routing:
      App\\Message\\OrderCreatedMessage: [async, audit_log]
      App\\Message\\InvoiceCreatedMessage: sync
      App\\Message\\SkippedMessage: [123, async]
    transports:
      async:
        dsn: '%env(resolve:MESSENGER_TRANSPORT_DSN)%'
      sync: 'sync://'
`, {
            relativePath: 'config/packages/messenger.yaml',
            repoRoot: '/repo',
            repoName: 'repo',
        });

        expect(facts).toContainEqual(expect.objectContaining({
            key: 'SymfonyMessenger.routing.App.Message.OrderCreatedMessage',
            targetKey: 'SymfonyMessenger.transport.async',
        }));
        expect(facts).toContainEqual(expect.objectContaining({
            key: 'SymfonyMessenger.routing.OrderCreatedMessage',
            targetKey: 'SymfonyMessenger.transport.async',
        }));
        expect(facts).toContainEqual(expect.objectContaining({
            key: 'SymfonyMessenger.transport.async',
            envKey: 'MESSENGER_TRANSPORT_DSN',
        }));
        expect(facts).toContainEqual(expect.objectContaining({
            key: 'SymfonyMessenger.transport.sync',
            value: 'sync://',
        }));
        expect(facts.some(fact => fact.key.includes('SkippedMessage'))).toBe(false);
        expect(provider.extractValueFacts('framework: [broken', {
            relativePath: 'messenger.yaml',
            repoRoot: '/repo',
            repoName: 'repo',
        })).toEqual([]);
    });

    it('resolves Laravel config helper calls through existing PHP config pseudo-export facts without static-first', () => {
        const php = new PHPPlugin();
        const configSource = `<?php
return ['connections' => ['sqs' => ['queue' => 'orders.created']]];
`;
        const serviceSource = `<?php
class Publisher {
    public function publish($bus, array $event): void {
        $bus->publish(config('queue.connections.sqs.queue'), $event);
    }
}
`;
        const configRoot = parse(configSource, (phpGrammar as any).php as Parser.Language);
        const serviceRoot = parse(serviceSource, (phpGrammar as any).php as Parser.Language);
        const imports: FileImportMap[] = [{
            filePath: 'app/Publisher.php',
            imports: php.extractImports(serviceRoot, {
                filePath: 'app/Publisher.php',
                allFilePaths: new Set(['app/Publisher.php', 'config/queue.php']),
                dependencyMappings: [],
            }),
            exportedSymbols: [],
        }];

        const index = buildValueResolutionIndex([
            {
                filePath: 'config/queue.php',
                valueFacts: php.extractValueFacts(configRoot, configSource, 'config/queue.php'),
                criticalInvocations: [],
            },
            {
                filePath: 'app/Publisher.php',
                valueFacts: php.extractValueFacts(serviceRoot, serviceSource, 'app/Publisher.php'),
                criticalInvocations: php.extractCriticalInvocations(serviceRoot, serviceSource, 'app/Publisher.php'),
            },
        ], imports);

        const laravelImport = imports[0].imports.find(imp => imp.source === 'config/queue.php');
        expect(laravelImport?.specifierBindings?.[0]).toEqual({
            imported: 'default',
            local: '__laravel_config_queue',
            kind: 'default',
        });

        const resolved = index.resolveInvocationsForChunk('app/Publisher.php', chunk(serviceSource, 'app/Publisher.php', 'php'));
        expect(resolved[0]).toMatchObject({
            originalExpression: '__laravel_config_queue.connections.sqs.queue',
            resolvedValue: 'orders.created',
            complete: true,
        });
        expect(resolved[0].confidence).toBeLessThan(0.9);
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('only emits Laravel virtual imports for single literal config keys and existing files', () => {
        const php = new PHPPlugin();
        const source = `<?php
$queue = config('queue.connections.sqs.queue');
$database = config('database.default');
config(['queue.connections.sqs.queue' => 'runtime']);
$dynamic = config($key);
config();
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const imports = php.extractImports(root, {
            filePath: 'app/Publisher.php',
            allFilePaths: new Set(['app/Publisher.php', 'config/queue.php', 'config/database.php']),
            dependencyMappings: [],
        });

        expect(imports).toHaveLength(2);
        expect(imports.map(imp => imp.source).sort()).toEqual(['config/database.php', 'config/queue.php']);
        expect(imports.map(imp => imp.specifierBindings?.[0]?.local).sort()).toEqual([
            '__laravel_config_database',
            '__laravel_config_queue',
        ]);

        const missingImports = php.extractImports(root, {
            filePath: 'app/Publisher.php',
            allFilePaths: new Set(['app/Publisher.php']),
            dependencyMappings: [],
        });
        expect(missingImports).toEqual([]);
    });

    it('keeps PHP service locator publishes prompt-only across literal, constant, and dynamic ids', () => {
        const php = new PHPPlugin();
        const source = `<?php
class Services { public const PUBLISHER = 'publisher.service'; }

function run($container, $services, $service, $event): void {
    $container->get('publisher')->publish($event);
    $services->get(Services::PUBLISHER)->publish($event);
    $container->get($service)->publish($event);
}
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invocations = php.extractCriticalInvocations(root, source, 'src/service-locator.php');
        // After the plugin started registering bare `$container->get(...)` calls
        // as critical invocations, every line emits TWO entries: one for the
        // `->get(...)` lookup itself and one for the wrapping `->publish(...)`.
        // Both carry the prompt-only `serviceId` role, which is what the
        // static-bypass guard checks.
        expect(invocations.map(i => i.resourceRole)).toEqual(
            new Array(invocations.length).fill('serviceId'),
        );
        expect(invocations.length).toBeGreaterThanOrEqual(3);

        const expressions = invocations.map(i => i.resourceExpression);
        expect(expressions).toContain('"publisher"');
        expect(expressions).toContain('Services.PUBLISHER');

        // Confidence semantics preserved across literal / constant / dynamic.
        expect(invocations.find(i => i.resourceExpression === '"publisher"')!.confidence).toBe(0.75);
        expect(invocations.find(i => i.resourceExpression === 'Services.PUBLISHER')!.confidence).toBe(0.7);
        const dynamic = invocations.filter(i =>
            i.resourceExpression !== '"publisher"' && i.resourceExpression !== 'Services.PUBLISHER',
        );
        expect(dynamic.length).toBeGreaterThan(0);
        expect(dynamic.every(i => i.confidence < 0.5)).toBe(true);

        const index = buildValueResolutionIndex([{
            filePath: 'src/service-locator.php',
            valueFacts: php.extractValueFacts(root, source, 'src/service-locator.php'),
            criticalInvocations: invocations,
        }], []);
        const resolved = index.resolveInvocationsForChunk('src/service-locator.php', chunk(source, 'src/service-locator.php', 'php'));
        // The static-bypass guard MUST return null whenever any prompt-only
        // role is present — that's the only behaviour the orchestrator depends on.
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('blocks PHP static-first when a resolved publish is mixed with Messenger routing', () => {
        const php = new PHPPlugin();
        const source = `<?php
class Publisher {
    public function __construct(
        #[Autowire(service: 'data_backbone.topics.payment_completed')]
        private Topic $topic,
    ) {}

    public function publish(array $event): void {
        $this->topic->publish($event);
        $this->messageBus->dispatch(new OrderCreatedMessage($event));
    }
}
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/Publisher.php',
            valueFacts: php.extractValueFacts(root, source, 'src/Publisher.php'),
            criticalInvocations: php.extractCriticalInvocations(root, source, 'src/Publisher.php'),
        }], []);
        const resolved = index.resolveInvocationsForChunk('src/Publisher.php', chunk(source, 'src/Publisher.php', 'php'));
        expect(resolved.some(item => item.resolvedValue === 'data_backbone.topics.payment_completed')).toBe(true);
        expect(resolved.some(item => item.invocation.resourceRole === 'messageClass')).toBe(true);
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('resolves PHP static:: constants with low confidence so static-first stays disabled', () => {
        const php = new PHPPlugin();
        const source = `<?php
class Publisher {
    private const TOPIC = 'base.topic';
    public function publish(array $event): void {
        $topic = static::TOPIC;
        $bus->publish($topic, $event);
    }
}
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'src/Publisher.php',
            valueFacts: php.extractValueFacts(root, source, 'src/Publisher.php'),
            criticalInvocations: php.extractCriticalInvocations(root, source, 'src/Publisher.php'),
        }], []);

        const resolved = index.resolveInvocationsForChunk('src/Publisher.php', chunk(source, 'src/Publisher.php', 'php'));
        expect(resolved[0].resolvedValue).toBe('base.topic');
        expect(resolved[0].confidence).toBeLessThan(0.9);
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('extracts PHP legacy array() config properties', () => {
        const php = new PHPPlugin();
        const source = `<?php
$config = array('topic' => 'legacy.topic');
$bus->publish($config['topic'], []);
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const facts = php.extractValueFacts(root, source, 'legacy.php');
        expect(facts).toContainEqual(expect.objectContaining({
            key: 'config.topic',
            value: 'legacy.topic',
        }));

        const index = buildValueResolutionIndex([{
            filePath: 'legacy.php',
            valueFacts: facts,
            criticalInvocations: php.extractCriticalInvocations(root, source, 'legacy.php'),
        }], []);
        const resolved = index.resolveInvocationsForChunk('legacy.php', chunk(source, 'legacy.php', 'php'));
        expect(resolved[0]).toMatchObject({ resolvedValue: 'legacy.topic', complete: true });
    });

    it('does not static-first PHP dynamic array dimensions', () => {
        const php = new PHPPlugin();
        const source = `<?php
$topicMap = ['topic' => 'known.topic'];
$bus->publish($topicMap[$key], []);
`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const index = buildValueResolutionIndex([{
            filePath: 'dynamic.php',
            valueFacts: php.extractValueFacts(root, source, 'dynamic.php'),
            criticalInvocations: php.extractCriticalInvocations(root, source, 'dynamic.php'),
        }], []);
        const resolved = index.resolveInvocationsForChunk('dynamic.php', chunk(source, 'dynamic.php', 'php'));
        expect(resolved[0].complete).toBe(false);
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('ignores comment-only critical invocation matches in line-based polyglot extractors', () => {
        const php = new PHPPlugin();
        const py = new PythonPlugin();
        const go = new GoPlugin();

        const phpSource = `<?php
// publish('fake.php.topic');
/*
basic_publish('fake.php.block');
*/
$bus->publish('real.php.topic');`;
        const pySource = `
# publish("fake.py.topic")
bus.publish("real.py.topic")
`;
        const goSource = `package main
// Publish("fake.go.topic")
/*
Publish("fake.go.block")
*/
func f(){ bus.Publish("real.go.topic") }`;

        const phpRoot = parse(phpSource, (phpGrammar as any).php as Parser.Language);
        const pyRoot = parse(pySource, pythonLang as unknown as Parser.Language);
        const goRoot = parse(goSource, goLang as unknown as Parser.Language);

        const phpInvocations = php.extractCriticalInvocations(phpRoot, phpSource, 'a.php');
        const pyInvocations = py.extractCriticalInvocations(pyRoot, pySource, 'a.py');
        const goInvocations = go.extractCriticalInvocations(goRoot, goSource, 'a.go');

        expect(phpInvocations.map(i => i.resourceExpression)).toEqual(["'real.php.topic'"]);
        expect(pyInvocations.map(i => i.resourceExpression)).toEqual(['"real.py.topic"']);
        expect(goInvocations.map(i => i.resourceExpression)).toEqual(['"real.go.topic"']);
    });

    it('ignores common multiline string blocks in line-based polyglot extractors', () => {
        const php = new PHPPlugin();
        const py = new PythonPlugin();
        const go = new GoPlugin();

        const phpSource = `<?php
$doc = <<<TXT
publish('fake.php.heredoc');
TXT;
$bus->publish('real.php.topic');`;
        const pySource = `
"""
publish("fake.py.docstring")
"""
bus.publish("real.py.topic")
`;
        const goSource = `package main
const doc = \`
Publish("fake.go.raw")
\`
func f(){ bus.Publish("real.go.topic") }`;

        const phpRoot = parse(phpSource, (phpGrammar as any).php as Parser.Language);
        const pyRoot = parse(pySource, pythonLang as unknown as Parser.Language);
        const goRoot = parse(goSource, goLang as unknown as Parser.Language);

        expect(php.extractCriticalInvocations(phpRoot, phpSource, 'a.php').map(i => i.resourceExpression)).toEqual(["'real.php.topic'"]);
        expect(py.extractCriticalInvocations(pyRoot, pySource, 'a.py').map(i => i.resourceExpression)).toEqual(['"real.py.topic"']);
        expect(go.extractCriticalInvocations(goRoot, goSource, 'a.go').map(i => i.resourceExpression)).toEqual(['"real.go.topic"']);
    });

    // ─── PHP DI binding tracker (Symfony 4.3+ autowire-by-type) ────────────
    //
    // The tests below validate that promoted properties bound via
    // `#[Autowire]` (priority 1) or via type-hint FQCN resolution
    // (priority 2 — Symfony default) cause arbitrary method calls on the
    // property to register a prompt-only `serviceId` critical invocation.
    // This forces the static-bypass guard to route the function to the LLM
    // for DI-registry resolution.

    it('registers Autowire-bound property with explicit service ID (priority 1)', () => {
        const php = new PHPPlugin();
        // `process` is outside the broker method list — exercises the
        // binding fallback rather than the publish/send short-circuit.
        const source = `<?php
namespace Acme\\Order;
use Acme\\Bus\\BusInterface;
use Symfony\\Component\\DependencyInjection\\Attribute\\Autowire;
class OrderHandler {
    public function __construct(
        #[Autowire(service: 'acme.message_bus.payment')]
        private BusInterface $bus,
    ) {}
    public function customMethod(array $payload): void {
        $this->bus->process($payload);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/OrderHandler.php');
        const binding = invs.find(i => i.resourceRole === 'serviceId');
        expect(binding).toBeDefined();
        expect(binding!.resourceExpression).toBe('"acme.message_bus.payment"');
        expect(binding!.confidence).toBeGreaterThanOrEqual(0.82);
    });

    it('registers type-hint FQCN binding (priority 2 — Symfony default, no Autowire)', () => {
        const php = new PHPPlugin();
        // Real-world dominant case: no #[Autowire], just a type-hint that
        // Symfony resolves via services.yaml autowire-by-type. Method
        // `commit` is outside the broker list to exercise the fallback.
        const source = `<?php
namespace Acme\\Order;
use Symfony\\Component\\Messenger\\MessageBusInterface;
class OrderController {
    public function __construct(private MessageBusInterface $messageBus) {}
    public function flushBatch(): void {
        $this->messageBus->commit();
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/OrderController.php');
        const binding = invs.find(i => i.resourceRole === 'serviceId');
        expect(binding).toBeDefined();
        expect(binding!.resourceExpression).toBe('"Symfony\\\\Component\\\\Messenger\\\\MessageBusInterface"');
        expect(binding!.confidence).toBe(0.78);
    });

    it('mixed DB+autowired bus blocks static-first bypass (regression test)', () => {
        const php = new PHPPlugin();
        // Function with complete SQL static analysis + DI-bound bus call
        // (method outside broker list). Must NOT bypass the LLM — DI
        // resolution requires registry lookup post-LLM.
        const source = `<?php
namespace Acme\\Order;
use Acme\\Bus\\OrderBus;
class OrderRepository {
    public function __construct(
        private \\PDO $db,
        private OrderBus $bus,
    ) {}
    public function persist(array $row): void {
        $this->db->prepare("INSERT INTO orders (id) VALUES (:id)")->execute($row);
        $this->bus->trigger($row);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/OrderRepository.php');
        const index = buildValueResolutionIndex([{
            filePath: 'src/OrderRepository.php',
            valueFacts: php.extractValueFacts(root, source, 'src/OrderRepository.php'),
            criticalInvocations: invs,
        }], []);
        const resolved = index.resolveInvocationsForChunk(
            'src/OrderRepository.php',
            chunk(source, 'src/OrderRepository.php', 'php'),
        );
        // The presence of any prompt-only role (serviceId from autowired bus)
        // forces the orchestrator to fall through to the LLM.
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });

    it('resolves type-hint relative to current namespace when no use-statement exists', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Order;
class Handler {
    public function __construct(private OrderEventBus $bus) {}    // no use, same namespace
    public function consume(): void {
        $this->bus->run();
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/Handler.php');
        const binding = invs.find(i => i.resourceRole === 'serviceId');
        expect(binding).toBeDefined();
        expect(binding!.resourceExpression).toBe('"Acme\\\\Order\\\\OrderEventBus"');
    });

    it('resolves nullable type-hint to its underlying class FQCN', () => {
        const php = new PHPPlugin();
        // Method `acknowledge` is intentionally NOT in the broker list
        // (publish/send/emit/produce/dispatch/...), so the binding fallback
        // is the path that captures it. This isolates the nullable-type
        // handling from the broker-method short-circuit.
        const source = `<?php
namespace Acme\\Order;
use Acme\\Bus\\OrderBus;
class Handler {
    public function __construct(private ?OrderBus $bus = null) {}
    public function ack(): void {
        $this->bus->acknowledge();
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/Handler.php');
        const binding = invs.find(i => i.resourceRole === 'serviceId');
        expect(binding).toBeDefined();
        expect(binding!.resourceExpression).toBe('"Acme\\\\Bus\\\\OrderBus"');
    });

    it('does NOT register scalar-typed promoted properties as DI bindings', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Order;
class ApiClient {
    public function __construct(
        private string $apiKey,         // scalar — no DI binding
        private int $timeout,           // scalar — no DI binding
        private array $config,          // scalar — no DI binding
    ) {}
    public function send(): void {
        // accessing primitive props — must not produce serviceId invocations
        echo $this->apiKey;
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/ApiClient.php');
        const serviceIdHits = invs.filter(i => i.resourceRole === 'serviceId');
        expect(serviceIdHits).toEqual([]);
    });

    it('does NOT register DTO-style accessor calls as DI bindings or ExternalAPI', () => {
        const php = new PHPPlugin();
        // `$user->orders` is a Doctrine ArrayCollection (or similar) — NOT
        // an autowired service AND NOT an HTTP client. The previous version
        // of the plugin misclassified `->get($id)` as an ExternalAPI URL
        // because ANY method named `get/post/put/patch/delete` was treated
        // as an HTTP call. The looksLikeHttpUrlArg() guard now requires
        // args[0] to carry URL-shaped evidence (scheme, leading `/`, query
        // string, or URL-suggestive variable name).
        const source = `<?php
namespace Acme\\Order;
class OrderQuery {
    public function fetchByUser($user, $id) {
        return $user->orders->get($id);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/OrderQuery.php');
        // No DI binding (no promoted property in OrderQuery).
        expect(invs.filter(i => i.resourceRole === 'serviceId')).toEqual([]);
        // No false ExternalAPI: `$id` is a bare ID, not a URL.
        expect(invs.filter(i => i.resourceType === 'ExternalAPI')).toEqual([]);
    });

    it('does NOT misclassify Doctrine ArrayCollection.get() as ExternalAPI', () => {
        const php = new PHPPlugin();
        // Symfony / Doctrine ArrayCollection has a `get($key)` method to
        // fetch elements by index/key. This is the most common false-positive
        // source for the previous unguarded HTTP-verb branch.
        const source = `<?php
namespace Acme\\Catalog;
class ProductLister {
    public function selectFirst(\\Doctrine\\Common\\Collections\\ArrayCollection $items) {
        $first = $items->get(0);
        $byKey = $items->get('default');
        return [$first, $byKey];
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/ProductLister.php');
        expect(invs.filter(i => i.resourceType === 'ExternalAPI')).toEqual([]);
    });

    it('still classifies HTTP client calls as ExternalAPI when args[0] is URL-shaped', () => {
        const php = new PHPPlugin();
        // Real HTTP calls with URL-literal evidence MUST keep their
        // ExternalAPI classification. This pins the regression boundary
        // for the looksLikeHttpUrlArg guard.
        const source = `<?php
namespace Acme\\Notification;
class WebhookSender {
    public function send(\\GuzzleHttp\\Client $client, $payload) {
        $client->get('https://hooks.acme.example/v1/notify');
        $client->post('/internal/orders', $payload);
        $client->get('users?since=2024-01-01');
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/WebhookSender.php');
        const apis = invs.filter(i => i.resourceType === 'ExternalAPI');
        expect(apis.length).toBeGreaterThanOrEqual(3);
    });

    it('classifies HTTP client calls with URL-shaped variable names as ExternalAPI', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Hub;
class HubClient {
    public function fetch(\\GuzzleHttp\\Client $client, string $endpoint, string $url) {
        $client->get($endpoint);
        $client->post($url, []);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/HubClient.php');
        const apis = invs.filter(i => i.resourceType === 'ExternalAPI');
        expect(apis.length).toBeGreaterThanOrEqual(2);
    });

    // ─── PHP MongoDB driver — selectCollection / createCollection ───────────────
    //
    // Regression: the PHP MongoDB driver's `Client::selectCollection($db, $collection)`
    // takes the *database* as args[0] and the *collection* as args[1]. The
    // generic regex extractor would unconditionally take args[0] (the database)
    // as the resource, creating a bogus DataContainer named after the Mongo
    // database instead of the actual collection. The PHP plugin now handles
    // these methods explicitly with the correct arg index and emits
    // `role: 'collection'` so kindFamily='document' propagates.

    it('selectCollection 2-arg form picks the COLLECTION (args[1]) and stamps role=collection', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Repository;
use MongoDB\\Client;
class ArchiveRepo {
    public function __construct(private Client $client) {}
    public function findOne(): void {
        $col = $this->client->selectCollection('logs', 'audit_events');
        $col->findOne(['type' => 'login']);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/ArchiveRepo.php');
        const dbInv = invs.find(i => i.resourceType === 'Database');
        expect(dbInv).toBeDefined();
        // args[1] (the collection) — NOT args[0] (the database 'logs')
        expect(dbInv!.resourceExpression).toBe(`'audit_events'`);
        expect(dbInv!.resourceRole).toBe('collection');
    });

    it('selectCollection 1-arg form (called on a Database object) picks args[0]', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Repository;
use MongoDB\\Database;
class EventsRepo {
    public function __construct(private Database $db) {}
    public function get(): void {
        $col = $this->db->selectCollection('events');
        $col->find([]);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/EventsRepo.php');
        const dbInv = invs.find(i => i.resourceType === 'Database');
        expect(dbInv).toBeDefined();
        expect(dbInv!.resourceExpression).toBe(`'events'`);
        expect(dbInv!.resourceRole).toBe('collection');
    });

    it('createCollection emits a WRITES Database resource for the collection name', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Bootstrap;
use MongoDB\\Database;
class Setup {
    public function __construct(private Database $db) {}
    public function init(): void {
        $this->db->createCollection('inbox', ['capped' => true]);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/Setup.php');
        const dbInv = invs.find(i => i.resourceType === 'Database');
        expect(dbInv).toBeDefined();
        expect(dbInv!.resourceExpression).toBe(`'inbox'`);
        expect(dbInv!.resourceRole).toBe('collection');
        expect(dbInv!.operation).toBe('WRITES');
    });

    it('selectDatabase does NOT register a DataContainer (the database is the Datastore)', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Repository;
use MongoDB\\Client;
class ArchiveRepo {
    public function __construct(private Client $client) {}
    public function getDatabase(): void {
        $db = $this->client->selectDatabase('logs');
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/ArchiveRepo.php');
        // The Mongo database itself is not a DataContainer — no static
        // resource should be registered for selectDatabase.
        expect(invs.find(i => i.resourceType === 'Database')).toBeUndefined();
    });

    it('selectCollection role=collection produces kindFamily=document via static analysis', () => {
        const php = new PHPPlugin();
        const source = `<?php
namespace Acme\\Repository;
use MongoDB\\Client;
class Repo {
    public function __construct(private Client $client) {}
    public function load(): void {
        $col = $this->client->selectCollection('logs', 'audit_events');
        $col->findOne([]);
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/Repo.php');
        const index = buildValueResolutionIndex([{
            filePath: 'src/Repo.php',
            valueFacts: php.extractValueFacts(root, source, 'src/Repo.php'),
            criticalInvocations: invs,
        }], []);
        const resolved = index.resolveInvocationsForChunk(
            'src/Repo.php',
            chunk(source, 'src/Repo.php', 'php'),
        );
        const analysis = buildStaticAnalysisFromResolvedInvocations(resolved);
        expect(analysis).not.toBeNull();
        const dbEntry = analysis!.infrastructure.find(i => i.type === 'Database');
        expect(dbEntry).toBeDefined();
        expect(dbEntry!.name).toBe('audit_events');
        expect(dbEntry!.kindFamily).toBe('document');
    });

    it('does NOT register access to a logger property as something that overrides existing classification', () => {
        const php = new PHPPlugin();
        // Logger property IS a DI-bound service (Psr\Log\LoggerInterface),
        // so the binding tracker correctly registers it. The downstream
        // sanitizer/LLM is responsible for classifying it as non-broker.
        // What we verify here: the registration uses prompt-only role and
        // does not produce a static MessageChannel infrastructure entry.
        const source = `<?php
namespace Acme\\Order;
use Psr\\Log\\LoggerInterface;
class Service {
    public function __construct(private LoggerInterface $logger) {}
    public function run(): void {
        $this->logger->info('processing');
    }
}`;
        const root = parse(source, (phpGrammar as any).php as Parser.Language);
        const invs = php.extractCriticalInvocations(root, source, 'src/Service.php');
        const index = buildValueResolutionIndex([{
            filePath: 'src/Service.php',
            valueFacts: php.extractValueFacts(root, source, 'src/Service.php'),
            criticalInvocations: invs,
        }], []);
        const resolved = index.resolveInvocationsForChunk(
            'src/Service.php',
            chunk(source, 'src/Service.php', 'php'),
        );
        // Static path bails → LLM/sanitizer decides whether to keep this
        // as a MessageChannel (it should NOT). No static infra emitted.
        expect(buildStaticAnalysisFromResolvedInvocations(resolved)).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Google Cloud Pub/Sub PHP recognizer (Stage 1: inline-literal name)
//
// Canonical SDK usage assigns the topic/subscription handle to a local var
// before the I/O call:
//   $topic = $this->pubSub->topic('acme-inventory-streaming');
//   $topic->publish(['data' => $json]);
//   $sub   = $this->pubSub->subscription('acme-inventory-updates-sub');
//   $sub->pull(['maxMessages' => 10]);
// The NAME lives in the topic()/subscription() accessor, so the recognizer must
// fire there (like writePoints for InfluxDB), not on the terminal publish()/pull().
// Gated on a literal/resolvable name arg to avoid matching a bare ->topic() on an
// unrelated object.
// ═════════════════════════════════════════════════════════════════════════════
describe('PHP Google Cloud Pub/Sub recognizer (Stage 1: inline literal)', () => {
    const php = new PHPPlugin();
    const PHP = (phpGrammar as any).php as Parser.Language;

    function invocationsFor(source: string): CriticalInvocationFact[] {
        const root = parse(source, PHP);
        return php.extractCriticalInvocations(root, source, 'src/StreamingPublisher.php');
    }

    it('emits a WRITES topic MessageChannel from $client->topic("name")', () => {
        const invocations = invocationsFor(`<?php
class StreamingPublisher {
    private \\Google\\Cloud\\PubSub\\PubSubClient $pubSub;
    public function publish(array $payload): void {
        $topic = $this->pubSub->topic('acme-inventory-streaming');
        $topic->publish(['data' => json_encode($payload)]);
    }
}`);
        const topic = invocations.find(i =>
            i.resourceType === 'MessageChannel' && i.resourceExpression.includes('acme-inventory-streaming'));
        expect(topic).toBeDefined();
        expect(topic!.operation).toBe('WRITES');
        expect(topic!.resourceRole).toBe('topic');
    });

    it('emits a READS subscription MessageChannel from $client->subscription("name")', () => {
        const invocations = invocationsFor(`<?php
class StreamingReader {
    private \\Google\\Cloud\\PubSub\\PubSubClient $pubSub;
    public function read(): void {
        $sub = $this->pubSub->subscription('acme-inventory-updates-sub');
        $messages = $sub->pull(['maxMessages' => 10]);
    }
}`);
        const sub = invocations.find(i =>
            i.resourceType === 'MessageChannel' && i.resourceExpression.includes('acme-inventory-updates-sub'));
        expect(sub).toBeDefined();
        expect(sub!.operation).toBe('READS');
        expect(sub!.resourceRole).toBe('subscription');
    });

    it('end-to-end: static analysis yields the clean topic name (not the $var or expression)', () => {
        const source = `<?php
class StreamingPublisher {
    private \\Google\\Cloud\\PubSub\\PubSubClient $pubSub;
    public function publish(array $payload): void {
        $topic = $this->pubSub->topic('acme-inventory-streaming');
        $topic->publish(['data' => json_encode($payload)]);
    }
}`;
        const root = parse(source, PHP);
        const index = buildValueResolutionIndex([{
            filePath: 'src/StreamingPublisher.php',
            valueFacts: php.extractValueFacts(root, source, 'src/StreamingPublisher.php'),
            criticalInvocations: php.extractCriticalInvocations(root, source, 'src/StreamingPublisher.php'),
        }], []);
        const resolved = index.resolveInvocationsForChunk(
            'src/StreamingPublisher.php',
            chunk(source, 'src/StreamingPublisher.php', 'php'),
        );
        const analysis = buildStaticAnalysisFromResolvedInvocations(resolved);
        expect(analysis).not.toBeNull();
        const channel = analysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && i.name === 'acme-inventory-streaming');
        expect(channel).toBeDefined();
        expect(channel!.operation).toBe('WRITES');
        // No noise channel named after the local var or the accessor expression.
        const noise = analysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && /\$|->|topic\(/.test(i.name));
        expect(noise).toBeUndefined();
    });

    it('does NOT match a bare ->topic($id) whose arg is not a literal/resource', () => {
        const invocations = invocationsFor(`<?php
class ForumThread {
    public function open(\\App\\Forum\\Board $board, int $id): void {
        $board->topic($id);
    }
}`);
        const phantom = invocations.find(i => i.resourceType === 'MessageChannel');
        expect(phantom).toBeUndefined();
    });

    function analyzeMongo(body: string): ReturnType<typeof buildStaticAnalysisFromResolvedInvocations> {
        const php = new PHPPlugin();
        const source = `<?php
class ArchiveReader {
    private \\MongoDB\\Client $client;
    public function read(string $tipo, $coll): void {
        ${body}
    }
}`;
        const root = parse(source, PHP);
        const index = buildValueResolutionIndex([{
            filePath: 'src/ArchiveReader.php',
            valueFacts: php.extractValueFacts(root, source, 'src/ArchiveReader.php'),
            criticalInvocations: php.extractCriticalInvocations(root, source, 'src/ArchiveReader.php'),
        }], []);
        const resolved = index.resolveInvocationsForChunk('src/ArchiveReader.php', chunk(source, 'src/ArchiveReader.php', 'php'));
        return buildStaticAnalysisFromResolvedInvocations(resolved);
    }

    it('resolves a dynamic collection name to a NAMED document stub with a NEUTRAL placeholder', () => {
        // `selectCollection($db, sprintf('quote_%s', $tipo))` → named 'quote_{var}'
        // document container (the SQL dynamic-table stub precedent), NOT <DYNAMIC>:
        // a Mongo collection has a meaningful name and must stay visible. The
        // placeholder is NEUTRAL ('{var}', not the local var name) so the SAME
        // collection at different call sites collapses to ONE node.
        const analysis = analyzeMongo(`$col = $this->client->selectCollection('archive', sprintf('quote_%s', $tipo)); $col->find([]);`);
        expect(analysis).not.toBeNull();
        const c = analysis!.infrastructure.find(i =>
            i.type === 'Database' && (i as any).kindFamily === 'document');
        expect(c).toBeDefined();
        expect(c!.name).toBe('quote_{var}');
    });

    it('uses the same neutral name regardless of the source variable (dedup)', () => {
        // sprintf with $tipo and sprintf with a getTypes() call must produce the
        // identical node name, so the same collection is not split in two.
        const a = analyzeMongo(`$col = $this->client->selectCollection('archive', sprintf('quote_%s', $tipo)); $col->find([]);`);
        const b = analyzeMongo(`$col = $this->client->selectCollection('archive', sprintf('quote_%s', getType($x))); $col->find([]);`);
        const c = analyzeMongo(`$col = $this->client->selectCollection('archive', 'quote_' . $tipo); $col->find([]);`);
        const nameOf = (an: typeof a) => an!.infrastructure.find(i => i.type === 'Database' && (i as any).kindFamily === 'document')?.name;
        expect(nameOf(a)).toBe('quote_{var}');
        expect(nameOf(b)).toBe('quote_{var}');
        expect(nameOf(c)).toBe('quote_{var}');
    });

    it('falls back to a <DYNAMIC> document item when no name prefix is recoverable', () => {
        // `selectCollection($db, $coll)` — opaque variable, no literal prefix →
        // name-less <DYNAMIC> document so the function still binds to Mongo.
        const analysis = analyzeMongo(`$col = $this->client->selectCollection('archive', $coll); $col->find([]);`);
        expect(analysis).not.toBeNull();
        const dyn = analysis!.infrastructure.find(i =>
            i.type === 'Database' && (i as any).kindFamily === 'document');
        expect(dyn).toBeDefined();
        expect(dyn!.name).toBe('<DYNAMIC>');
    });

    it('does NOT extract a new XEvent() payload argument as a channel', () => {
        // `$wrapper->publish(new SomeEvent([...]))` — the constructed object is
        // the message PAYLOAD, not the channel name. The channel is the topic
        // the wrapper publishes to (resolved elsewhere), never the payload class.
        const invocations = invocationsFor(`<?php
class DwhForwarder {
    private \\Acme\\Inventory\\Dwh\\StreamingPublisher $publisher;
    public function forward(array $reasons): void {
        $this->publisher->publish(new \\Acme\\Inventory\\Event\\OrderNotPurchasableEvent([
            'type' => 'order.not-purchasable',
            'data' => $reasons,
        ]));
    }
}`);
        const phantom = invocations.find(i => i.resourceType === 'MessageChannel');
        expect(phantom).toBeUndefined();
    });
});

function valueFact(
    filePath: string,
    key: string,
    patch: Partial<ValueFact>,
): ValueFact {
    return {
        filePath,
        language: 'typescript',
        key,
        expression: patch.expression ?? patch.value ?? patch.targetKey ?? key,
        kind: patch.kind ?? (patch.value ? 'literal' : patch.targetKey ? 'alias' : 'dynamic'),
        value: patch.value,
        envKey: patch.envKey,
        fallbackValue: patch.fallbackValue,
        targetKey: patch.targetKey,
        exported: patch.exported,
        exportedAs: patch.exportedAs,
        confidence: patch.confidence ?? 0.95,
        startLine: patch.startLine ?? 1,
        endLine: patch.endLine ?? patch.startLine ?? 1,
    };
}

function invocationFact(
    filePath: string,
    callee: string,
    resourceExpression: string,
    line: number,
): CriticalInvocationFact {
    return {
        filePath,
        language: 'typescript',
        callee,
        resourceExpression,
        resourceRole: 'topic',
        resourceType: 'MessageChannel',
        operation: 'WRITES',
        confidence: 0.95,
        startLine: line,
        endLine: line,
    };
}
