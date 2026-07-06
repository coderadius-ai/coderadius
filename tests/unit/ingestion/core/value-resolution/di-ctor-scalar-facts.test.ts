import { describe, it, expect } from 'vitest';
import { synthesizeDiCtorScalarFacts } from '../../../../../src/ingestion/core/value-resolution/di-ctor-scalar-facts.js';
import type { RawDiBinding } from '../../../../../src/ingestion/core/di-binding-providers/types.js';
import type { ComponentDefinition } from '../../../../../src/ingestion/core/languages/types.js';

const WRAPPER = 'Acme\\Streaming\\StreamingPublisher';

function binding(over: Partial<RawDiBinding>): RawDiBinding {
    return {
        key: 'notpurchasable.publisher',
        boundComponent: WRAPPER,
        autowireEnabled: false,
        sourceFile: 'config/containerBuilder.php',
        sourceHash: 'h',
        ...over,
    };
}

function component(over: Partial<ComponentDefinition>): ComponentDefinition {
    return {
        fqcn: WRAPPER,
        file: 'src/Streaming/StreamingPublisher.php',
        operations: [],
        declaredInterfaces: [],
        constructorParameterNames: ['pubSubClient', 'topic', 'logger'],
        ...over,
    };
}

describe('synthesizeDiCtorScalarFacts', () => {
    it('maps a positional ctor scalar to the param name and emits a literal fact in the component file', () => {
        const facts = synthesizeDiCtorScalarFacts(
            [binding({ ctorScalars: [{ position: 1, value: 'acme-inventory-streaming' }] })],
            [component({})],
        );
        expect(facts).toHaveLength(1);
        expect(facts[0]).toMatchObject({
            filePath: 'src/Streaming/StreamingPublisher.php',
            key: 'topic',
            kind: 'literal',
            value: 'acme-inventory-streaming',
        });
        expect(facts[0].confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('abstains when a component is constructed by MORE THAN ONE binding with scalars (ambiguous)', () => {
        const facts = synthesizeDiCtorScalarFacts(
            [
                binding({ key: 'a.publisher', ctorScalars: [{ position: 1, value: 'topic-a' }] }),
                binding({ key: 'b.publisher', ctorScalars: [{ position: 1, value: 'topic-b' }] }),
            ],
            [component({})],
        );
        expect(facts).toHaveLength(0);
    });

    it('emits nothing when there is no matching component definition', () => {
        const facts = synthesizeDiCtorScalarFacts(
            [binding({ ctorScalars: [{ position: 1, value: 'x' }] })],
            [],
        );
        expect(facts).toHaveLength(0);
    });

    it('skips a scalar whose position is out of the ctor param range', () => {
        const facts = synthesizeDiCtorScalarFacts(
            [binding({ ctorScalars: [{ position: 9, value: 'x' }] })],
            [component({})],
        );
        expect(facts).toHaveLength(0);
    });

    it('emits nothing for bindings without ctorScalars', () => {
        const facts = synthesizeDiCtorScalarFacts([binding({})], [component({})]);
        expect(facts).toHaveLength(0);
    });
});
