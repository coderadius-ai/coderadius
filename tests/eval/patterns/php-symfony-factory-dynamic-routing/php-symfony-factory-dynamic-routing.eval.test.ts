import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { symfonyMessengerPlugin } from '../../../../src/ingestion/structural/plugins/messaging/symfony-messenger.plugin.js';
import type { PluginContext, StructuralEntity } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';
import { clearMessageBrokerRegistry } from '../../../../src/ingestion/core/messaging/broker-registry.js';

// ═════════════════════════════════════════════════════════════════════════════
// Pattern test (deterministic, no LLM) — php-symfony-factory-dynamic-routing
//
// G7 edge case: a messaging factory file where the routing map is constructed
// at runtime (loop, external loader, config service). The static extractor
// cannot recover MessageClass → routing-key pairs, but the file IS clearly
// messaging-shaped. The plugin MUST:
//   - NOT emit MessageChannel / MessageBroker (would be a wrong / partial graph)
//   - Stamp `needsReview=true` on the SourceFile entity so the user sees the
//     file in `cr doctor`
// ═════════════════════════════════════════════════════════════════════════════

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');
const REPO_NAME = 'acme/orders-service';

function makeContext(relativePath: string, absolutePath: string): PluginContext {
    return {
        relativePath,
        absolutePath,
        repoName: REPO_NAME,
        repoUrn: `cr:repository:${REPO_NAME}`,
        scopeManager: new ScopeManager(path.dirname(absolutePath)),
    };
}

describe('Pattern Eval — php-symfony-factory-dynamic-routing (G7)', () => {
    let allEntities: StructuralEntity[] = [];

    beforeAll(() => {
        clearMessageBrokerRegistry();

        const phpRel = 'src/Messaging/MessageMap.php';
        const phpAbs = path.join(FIXTURE_DIR, phpRel);
        const phpContent = fs.readFileSync(phpAbs, 'utf-8');

        expect(symfonyMessengerPlugin.matchFile(phpRel, 'MessageMap.php')).toBe(true);

        const result = symfonyMessengerPlugin.extract(
            phpContent,
            makeContext(phpRel, phpAbs),
        );
        allEntities = result.entities;
    });

    afterAll(() => {
        clearMessageBrokerRegistry();
        allEntities = [];
    });

    it('emits no MessageBroker (dynamic routing cannot be resolved statically)', () => {
        const brokers = allEntities.filter(e => e.labels.includes('MessageBroker'));
        expect(brokers).toHaveLength(0);
    });

    it('emits no MessageChannel (avoids partial / wrong graph)', () => {
        const channels = allEntities.filter(e => e.labels.includes('MessageChannel'));
        expect(channels).toHaveLength(0);
    });

    it('stamps needsReview=true on the SourceFile entity', () => {
        const sourceFiles = allEntities.filter(e => e.labels.includes('SourceFile'));
        expect(sourceFiles).toHaveLength(1);
        const sf = sourceFiles[0];
        expect(sf.properties.needsReview).toBe(true);
        expect(sf.properties.evidence_extractors).toContain('symfony-messenger-dynamic-routing@v1');
        // URN follows the canonical SourceFile convention (case-sensitive segments
        // for filesystem paths — see graph/urn.ts CASE_INSENSITIVE_TYPES).
        expect(sf.id).toBe('cr:sourcefile:acme/orders-service:src/Messaging/MessageMap.php');
        expect(sf.properties.path).toBe('src/Messaging/MessageMap.php');
    });
});
