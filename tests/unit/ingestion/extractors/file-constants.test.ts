import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import phpGrammar from 'tree-sitter-php';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseTsSource(source: string): Parser.SyntaxNode {
    const parser = new Parser();
    parser.setLanguage(ts.typescript as unknown as Parser.Language);
    return parser.parse(source).rootNode;
}

function parsePhpSource(source: string): Parser.SyntaxNode {
    const parser = new Parser();
    // @ts-ignore — tree-sitter-php grammar type
    const phpLang = (phpGrammar as any).php ?? phpGrammar;
    parser.setLanguage(phpLang as unknown as Parser.Language);
    return parser.parse(source).rootNode;
}

function parsePhpTree(source: string): Parser.Tree {
    const parser = new Parser();
    // @ts-ignore — tree-sitter-php grammar type
    const phpLang = (phpGrammar as any).php ?? phpGrammar;
    parser.setLanguage(phpLang as unknown as Parser.Language);
    return parser.parse(source);
}

// ─── TypeScript Plugin ────────────────────────────────────────────────────────

describe('TypeScriptPlugin.extractFileConstants', () => {
    let plugin: TypeScriptPlugin;

    beforeAll(() => { plugin = new TypeScriptPlugin(); });

    // ── 1. Class-level static readonly string constant
    // formatValue now uses JSON.stringify → double-quoted output
    it('extracts class-level static readonly string constant', () => {
        const root = parseTsSource(`
class MyService {
    private static readonly EVENT_NAME = 'system.event.created';
}
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({
            scope: 'MyService',
            name: 'EVENT_NAME',
            value: '"system.event.created"',
        });
    });

    // ── 2. Class-level static readonly number constant (unaffected by JSON.stringify)
    it('extracts class-level static readonly number constant', () => {
        const root = parseTsSource(`
class MyService {
    private static readonly CACHE_TTL = 300;
}
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({
            scope: 'MyService',
            name: 'CACHE_TTL',
            value: '300',
        });
    });

    // ── 3. Module-level const string → JSON.stringify output
    it('extracts module-level const string', () => {
        const root = parseTsSource(`const TOPIC_NAME = 'my.topic';`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({
            scope: '',
            name: 'TOPIC_NAME',
            value: '"my.topic"',
        });
    });

    // ── 4. Non-static readonly field is included
    it('includes non-static readonly class field', () => {
        const root = parseTsSource(`
class Svc {
    readonly FOO = 'bar';
}
`);
        const result = plugin.extractFileConstants(root);
        const nonStatic = result.find(c => c.name === 'FOO');
        expect(nonStatic).toBeDefined();
        expect(nonStatic?.value).toBe('"bar"');
    });

    // ── 4b. Non-readonly field is excluded
    it('excludes non-readonly class field', () => {
        const root = parseTsSource(`
class Svc {
    FOO = 'bar';
}
`);
        const result = plugin.extractFileConstants(root);
        const mutable = result.find(c => c.name === 'FOO');
        expect(mutable).toBeUndefined();
    });

    // ── 5. Static field with reference initializer is excluded
    it('excludes static readonly with reference initializer', () => {
        const root = parseTsSource(`
class Svc {
    static readonly FOO = OtherClass.BAR;
}
`);
        const result = plugin.extractFileConstants(root);
        const ref = result.find(c => c.name === 'FOO');
        expect(ref).toBeUndefined();
    });

    // ── 6. Template literal without interpolation is accepted
    it('accepts template literal without interpolation', () => {
        const root = parseTsSource(`
class Svc {
    static readonly KEY = \`abc-def\`;
}
`);
        const result = plugin.extractFileConstants(root);
        const found = result.find(c => c.name === 'KEY');
        expect(found).toBeDefined();
        expect(found?.value).toBe('"abc-def"');
    });

    // ── 7. Template literal with interpolation is excluded
    it('excludes template literal with interpolation', () => {
        const root = parseTsSource(`
const x = 'foo';
class Svc {
    static readonly KEY = \`\${x}-abc\`;
}
`);
        const result = plugin.extractFileConstants(root);
        const found = result.find(c => c.name === 'KEY');
        expect(found).toBeUndefined();
    });

    // ── 8. Two classes in same file — each scoped correctly
    it('scopes constants to their respective classes', () => {
        const root = parseTsSource(`
class ServiceA {
    static readonly TOPIC = 'a.topic';
}
class ServiceB {
    static readonly TOPIC = 'b.topic';
}
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: 'ServiceA', name: 'TOPIC', value: '"a.topic"' });
        expect(result).toContainEqual({ scope: 'ServiceB', name: 'TOPIC', value: '"b.topic"' });
        // They must NOT be confused
        const aEntry = result.find(c => c.scope === 'ServiceA' && c.name === 'TOPIC');
        expect(aEntry?.value).toBe('"a.topic"');
    });

    // ── 9. `let` at module level is excluded (only `const` is accepted)
    it('excludes let declarations at module level', () => {
        const root = parseTsSource(`let MUTABLE = 'should-be-excluded';`);
        const result = plugin.extractFileConstants(root);
        const found = result.find(c => c.name === 'MUTABLE');
        expect(found).toBeUndefined();
    });

    // ── Bonus: Both module-level and class-level in same file
    it('extracts both module-level and class-level constants from the same file', () => {
        const root = parseTsSource(`
const EXCHANGE = 'acme';

class SystemEventService {
    private static readonly EVENT_NAME = 'system.event.created';
    private static readonly CACHE_TTL = 300;
}
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: '', name: 'EXCHANGE', value: '"acme"' });
        expect(result).toContainEqual({ scope: 'SystemEventService', name: 'EVENT_NAME', value: '"system.event.created"' });
        expect(result).toContainEqual({ scope: 'SystemEventService', name: 'CACHE_TTL', value: '300' });
    });

    // ── BUG REGRESSION: embedded single quotes in TS string (Bug 1)
    // Old code: 'L'aquila' (malformed). New code: "L'aquila" (valid JSON output).
    it('handles string value with embedded single quotes without producing malformed output', () => {
        const root = parseTsSource(`const X = "L'aquila";`);
        const result = plugin.extractFileConstants(root);
        const found = result.find(c => c.name === 'X');
        expect(found).toBeDefined();
        // JSON.stringify("L'aquila") = '"L\'aquila"' — double-quoted, no malformed nesting
        expect(found?.value).toBe('"L\'aquila"');
        // Critically: must NOT produce the old malformed 'L'aquila'
        expect(found?.value).not.toBe("'L'aquila'");
    });

    it('extracts single-depth object literal constants', () => {
        const root = parseTsSource(`
export const appConfig = {
    appChannelSave: 'Order-Save',
    ignoredNested: { deep: 'nope' },
    ignoredDynamic: buildTopic(),
};
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({
            scope: 'appConfig',
            name: 'appChannelSave',
            value: '"Order-Save"',
        });
        expect(result.find(c => c.name === 'ignoredNested')).toBeUndefined();
        expect(result.find(c => c.name === 'ignoredDynamic')).toBeUndefined();
    });

    it('extracts object literal env fallbacks for || and ?? only', () => {
        const root = parseTsSource(`
const config = {
    topicA: process.env.TOPIC_A || 'FallbackA',
    topicB: process.env.TOPIC_B ?? 'FallbackB',
    pureEnv: process.env.TOPIC_C,
};
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: 'config', name: 'topicA', value: '"FallbackA"' });
        expect(result).toContainEqual({ scope: 'config', name: 'topicB', value: '"FallbackB"' });
        expect(result.find(c => c.name === 'pureEnv')).toBeUndefined();
    });
});

// ─── PHP Plugin ───────────────────────────────────────────────────────────────

describe('PHPPlugin.extractFileConstants', () => {
    let plugin: PHPPlugin;

    beforeAll(() => { plugin = new PHPPlugin(); });

    // ── 10. Module-level single-quoted const → safe
    it('extracts module-level PHP const (single-quoted)', () => {
        const root = parsePhpSource(`<?php\nconst QUEUE = 'motor.result';\n`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: '', name: 'QUEUE', value: '"motor.result"' });
    });

    // ── 11. Class-level const
    it('extracts class-level PHP class const', () => {
        const root = parsePhpSource(`<?php\nclass Cfg {\n    const EXCH = 'acme';\n}\n`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: 'Cfg', name: 'EXCH', value: '"acme"' });
    });

    // ── 12. PHP class property is excluded (not a const)
    it('excludes PHP class property (not a const)', () => {
        const root = parsePhpSource(`<?php\nclass Svc {\n    public $prop = 'val';\n}\n`);
        const result = plugin.extractFileConstants(root);
        const found = result.find(c => c.name === 'prop');
        expect(found).toBeUndefined();
    });

    // ── BUG REGRESSION: PHP encapsed_string with variable interpolation (Bug 2)
    // e.g. const X = "motor.$env.result" → MUST be excluded.
    it('excludes PHP double-quoted string with variable interpolation', () => {
        const root = parsePhpSource(`<?php\nconst TOPIC = "motor.$env.result";\n`);
        const result = plugin.extractFileConstants(root);
        const found = result.find(c => c.name === 'TOPIC');
        expect(found).toBeUndefined();
    });

    // ── Safe double-quoted PHP string (no interpolation) IS accepted
    it('accepts PHP double-quoted string without interpolation', () => {
        const root = parsePhpSource(`<?php\nconst TOPIC = "motor.result";\n`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: '', name: 'TOPIC', value: '"motor.result"' });
    });

    it('extracts top-level single-depth array const values', () => {
        const root = parsePhpSource(`<?php\nconst CONFIG = ['topic' => 'Platform-SampleUser', 'nested' => ['deep' => 'no'], 'dynamic' => $topic];\n`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: 'CONFIG', name: 'topic', value: '"Platform-SampleUser"' });
        expect(result.find(c => c.name === 'nested')).toBeUndefined();
        expect(result.find(c => c.name === 'dynamic')).toBeUndefined();
    });

    it('extracts class array const values with env fallbacks', () => {
        const root = parsePhpSource(`<?php\nclass Cfg { const CONFIG = ['a' => getenv('TOPIC_A') ?: 'FallbackA', 'b' => $_ENV['TOPIC_B'] ?? 'FallbackB', 'pure' => getenv('TOPIC_C')]; }\n`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: 'Cfg.CONFIG', name: 'a', value: '"FallbackA"' });
        expect(result).toContainEqual({ scope: 'Cfg.CONFIG', name: 'b', value: '"FallbackB"' });
        expect(result.find(c => c.name === 'pure')).toBeUndefined();
    });

    it('detects Symfony Autowire message channel service keys statically', () => {
        const source = `<?php
class PublishCommand {
    public function __construct(
        #[Autowire(service: 'channels.topics.sample_user')]
        private Topic $topic,
        #[Autowire(service: 'channels.subscriptions.sample_user')]
        private SubscriptionInterface $subscription,
    ) {}

    public function publish(): void { $this->topic->publish($event); }
    public function consume(): void { foreach ($this->subscription->pull() as $event) {} }
}
`;
        const tree = parsePhpTree(source);
        const chunks = plugin.extractFunctions(tree, source, 'src/PublishCommand.php');
        const publish = chunks.find(chunk => chunk.name.endsWith('PublishCommand.publish'))!;
        const consume = chunks.find(chunk => chunk.name.endsWith('PublishCommand.consume'))!;

        expect(plugin.extractStaticInfra(tree.rootNode, publish)?.infrastructure).toEqual([{
            name: 'channels.topics.sample_user',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
        }]);
        expect(plugin.extractStaticInfra(tree.rootNode, consume)?.infrastructure).toEqual([{
            name: 'channels.subscriptions.sample_user',
            type: 'MessageChannel',
            operation: 'READS',
            channelKind: 'subscription',
        }]);
    });

    it('does not treat arbitrary Symfony Autowire senders as message channels', () => {
        const source = `<?php
class MailCommand {
    public function __construct(
        #[Autowire(service: 'mailer.client')]
        private Mailer $mailer,
    ) {}

    public function send(): void { $this->mailer->send($message); }
}
`;
        const tree = parsePhpTree(source);
        const chunks = plugin.extractFunctions(tree, source, 'src/MailCommand.php');
        const send = chunks.find(chunk => chunk.name.endsWith('MailCommand.send'))!;

        expect(plugin.extractStaticInfra(tree.rootNode, send)).toBeNull();
    });
});

// ─── Reference-Guard Semantics ────────────────────────────────────────────────
// Tests the critical invariant: extractFileConstants() produces the raw constants,
// but formatFileConstantsContext (in static-analyzer) must filter them to ONLY
// those referenced in the chunk's source code.
//
// We simulate this filter inline to lock down the contract at the unit level.
// ROOT CAUSE REGRESSION: ts-rabbitmq-event produced a false PUBLISHES_TO edge when
// `emit()` had no body referencing EVENT_NAME but the constant was still injected
// into the prompt, causing the LLM to hallucinate a broker call.

function simulateReferenceGuard(
    constants: Array<{ scope: string; name: string; value: string }>,
    chunkSourceCode: string,
): Array<{ scope: string; name: string; value: string }> {
    return constants.filter(c => {
        const barePattern = new RegExp(`\\b${c.name}\\b`);
        return barePattern.test(chunkSourceCode);
    });
}

describe('reference-guard semantics (formatFileConstantsContext pre-filter)', () => {
    let tsPlugin: TypeScriptPlugin;

    beforeAll(() => { tsPlugin = new TypeScriptPlugin(); });

    it('returns empty when function body does NOT reference the constant — prevents hallucination', () => {
        // This is the exact scenario that caused the false PUBLISHES_TO in ts-rabbitmq-event.
        // The class has EVENT_NAME defined, but this simplified emit() body never uses it.
        const root = parseTsSource(`
class SystemEventService {
    private static readonly EVENT_NAME = 'system.event.created2';
}
`);
        const constants = tsPlugin.extractFileConstants(root);
        expect(constants.length).toBeGreaterThan(0); // extractor sees the constant

        const emitBodyWithoutReference = `
emit(quoteId, productId, coverSlugs) {
    const eventId = "some-id";
    const eventData = { quoteId, productId, coverSlugs };
}`.trim();

        // After reference-guard: nothing should reach the LLM
        const filtered = simulateReferenceGuard(constants, emitBodyWithoutReference);
        expect(filtered).toHaveLength(0); // ← no constants injected → no hallucination
    });

    it('returns the constant when function body DOES reference it — enables resolution', () => {
        const root = parseTsSource(`
class SystemEventService {
    private static readonly EVENT_NAME = 'system.event.created';
}
`);
        const constants = tsPlugin.extractFileConstants(root);

        const realEmitBody = `
emitPreferredResultEvent(quoteId, productId, coverSlugs) {
    return this.messageEmitterService.emitEvent({
        eventName: SystemEventService.EVENT_NAME,
        routingKey: [SystemEventService.EVENT_NAME],
    });
}`.trim();

        // After reference-guard: EVENT_NAME should be included (body references it)
        const filtered = simulateReferenceGuard(constants, realEmitBody);
        expect(filtered).toHaveLength(1);
        expect(filtered[0]).toMatchObject({ name: 'EVENT_NAME', value: '"system.event.created"' });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Factory Pattern Extraction (registerAs, defineConfig)
// ═════════════════════════════════════════════════════════════════════════════

describe('TypeScriptPlugin.extractFileConstants — factory patterns', () => {
    let plugin: TypeScriptPlugin;

    beforeAll(() => { plugin = new TypeScriptPlugin(); });

    it('extracts object constants from registerAs factory pattern', () => {
        const root = parseTsSource(`
import { registerAs } from '@nestjs/config';
export default registerAs('channels', () => ({
    appChannelSave: process.env.APP_CHANNEL_SAVE || 'Order-Save',
    appChannelShipmentBundleV2: process.env.APP_CHANNEL_SHIPMENT_BUNDLE_V2 || 'Order-ShipmentBundleV2',
}));
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({
            scope: 'channels',
            name: 'appChannelSave',
            value: '"Order-Save"',
        });
        expect(result).toContainEqual({
            scope: 'channels',
            name: 'appChannelShipmentBundleV2',
            value: '"Order-ShipmentBundleV2"',
        });
    });

    it('extracts object constants from defineConfig factory pattern', () => {
        const root = parseTsSource(`
export default defineConfig(() => ({
    topicName: 'my-service.events.v1',
    maxRetries: 3,
}));
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({
            scope: 'defineConfig',
            name: 'topicName',
            value: '"my-service.events.v1"',
        });
        expect(result).toContainEqual({
            scope: 'defineConfig',
            name: 'maxRetries',
            value: '3',
        });
    });

    it('extracts constants from factory with block body arrow function', () => {
        const root = parseTsSource(`
export default registerAs('broker', () => {
    return {
        replyQueue: process.env.REPLY_QUEUE || 'order.reply',
    };
});
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({
            scope: 'broker',
            name: 'replyQueue',
            value: '"order.reply"',
        });
    });

    it('ignores factory calls without object return', () => {
        const root = parseTsSource(`
export default registerAs('cache', () => 42);
`);
        const result = plugin.extractFileConstants(root);
        // No object properties to extract
        expect(result.filter(c => c.scope === 'cache')).toHaveLength(0);
    });

    it('coexists with named const exports in the same file', () => {
        const root = parseTsSource(`
const TIMEOUT = 30000;

export const CONFIG_NAME = 'event-broker';

export default registerAs('eventBroker', () => ({
    topicSave: 'Platform-OrderSave',
}));
`);
        const result = plugin.extractFileConstants(root);
        expect(result).toContainEqual({ scope: '', name: 'TIMEOUT', value: '30000' });
        expect(result).toContainEqual({ scope: '', name: 'CONFIG_NAME', value: '"event-broker"' });
        expect(result).toContainEqual({ scope: 'eventBroker', name: 'topicSave', value: '"Platform-OrderSave"' });
    });
});
