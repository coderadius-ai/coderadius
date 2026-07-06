import { describe, it, expect } from 'vitest';
import {
    buildAnalysisPrompt,
    PROMPT_SECTION_NAMES,
    type AnalysisPromptInputs,
} from '../../../../src/ai/agents/unified-analyzer.js';
import type { CodeChunk } from '../../../../src/graph/types.js';

function makeChunk(sourceCode: string): CodeChunk {
    return {
        name: 'reserveStock',
        filepath: 'src/inventory/InventorySync.php',
        sourceCode,
        language: 'php',
        startLine: 10,
        startColumn: 0,
        endLine: 40,
        endColumn: 1,
    } as CodeChunk;
}

const TRUNCATION_SUFFIX = '\n...[truncated]';

describe('buildAnalysisPrompt() — per-section anatomy', () => {
    it('covers every prompt block with a sectionChars key', () => {
        const { sectionChars } = buildAnalysisPrompt({
            chunk: makeChunk('function reserveStock() {}'),
            scanMode: 'semantic',
        });

        for (const name of PROMPT_SECTION_NAMES) {
            expect(sectionChars, `missing section key: ${name}`).toHaveProperty(name);
            expect(typeof sectionChars[name]).toBe('number');
        }
        // DI sub-component detail keys (pre-outer-clamp, post-inner-clamp)
        expect(sectionChars).toHaveProperty('di_imports');
        expect(sectionChars).toHaveProperty('di_constructorSource');
        expect(sectionChars).toHaveProperty('di_classProperties');
    });

    it('reports sourceCode length verbatim when under the fast cap', () => {
        const source = 'function reserveStock() { return $this->ordersRepository->save(); }';
        const { sectionChars } = buildAnalysisPrompt({
            chunk: makeChunk(source),
            scanMode: 'semantic',
        });
        expect(sectionChars.sourceCode).toBe(source.length);
    });

    it('clamps sourceCode at 20K (fast) and 30K (deep) plus truncation marker', () => {
        const bigSource = 'x'.repeat(25_000);
        const fast = buildAnalysisPrompt({ chunk: makeChunk(bigSource), scanMode: 'semantic' });
        expect(fast.sectionChars.sourceCode).toBe(20_000 + TRUNCATION_SUFFIX.length);

        const deep = buildAnalysisPrompt({ chunk: makeChunk(bigSource), scanMode: 'contracts' });
        expect(deep.sectionChars.sourceCode).toBe(25_000);
    });

    it('reports zero for absent optional sections', () => {
        const { sectionChars } = buildAnalysisPrompt({
            chunk: makeChunk('function noop() {}'),
            scanMode: 'semantic',
        });
        expect(sectionChars.customKnowledge).toBe(0);
        expect(sectionChars.taint).toBe(0);
        expect(sectionChars.diContext).toBe(0);
        expect(sectionChars.graphqlDoc).toBe(0);
    });

    it('measures the composed DI block and its sub-components', () => {
        const inputs: AnalysisPromptInputs = {
            chunk: makeChunk('function reserveStock() {}'),
            scanMode: 'semantic',
            context: {
                imports: ['use Acme\\Inventory\\OrdersRepository;', 'use Acme\\Payment\\PaymentChannel;'],
                constructorSource: 'public function __construct(private OrdersRepository $ordersRepository) {}',
                classProperties: ['private OrdersRepository $ordersRepository'],
            },
        };
        const { prompt, sectionChars } = buildAnalysisPrompt(inputs);

        expect(sectionChars.diContext).toBeGreaterThan(0);
        expect(sectionChars.di_imports).toBeGreaterThan(0);
        expect(sectionChars.di_constructorSource).toBeGreaterThan(0);
        expect(sectionChars.di_classProperties).toBeGreaterThan(0);
        // The composed DI block is what actually ships
        expect(prompt).toContain('--- DI Context');
        expect(prompt).toContain('OrdersRepository');
    });

    it('sums block sections to no more than the full prompt length', () => {
        const inputs: AnalysisPromptInputs = {
            chunk: makeChunk('function reserveStock() { /* … */ }'),
            scanMode: 'semantic',
            context: {
                imports: ['use Acme\\Inventory\\OrdersRepository;'],
                constructorSource: 'public function __construct() {}',
            },
            taintContextSummary: 'OrdersRepository->save writes to inventory_reservations',
            customKnowledge: 'acme domain knowledge',
            frameworkSignalContext: 'symfony messenger handler',
            entityTableContext: 'InventoryItem => inventory_items',
            classConstantsContext: 'TOPIC = "inventory.low_stock"',
            clientBindingContext: 'paymentClient: PaymentApi',
            graphQLDocumentContext: 'query GetOrder { order { id } }',
            resolvedInvocationContext: 'this.ordersRepository.save(...) resolved',
            resolvedTypeDefinitions: 'interface Order { id: string }',
        };
        const { prompt, sectionChars } = buildAnalysisPrompt(inputs);

        const blockSum = PROMPT_SECTION_NAMES
            .reduce((acc, name) => acc + sectionChars[name], 0);
        expect(blockSum).toBeGreaterThan(0);
        expect(blockSum).toBeLessThanOrEqual(prompt.length);
    });

    it('preserves Vertex cache ordering: shared blocks before per-function blocks', () => {
        const inputs: AnalysisPromptInputs = {
            chunk: makeChunk('function reserveStock() {}'),
            scanMode: 'semantic',
            customKnowledge: 'CUSTOM-KNOWLEDGE-MARKER',
            frameworkSignalContext: 'FRAMEWORK-SIGNAL-MARKER',
            taintContextSummary: 'TAINT-MARKER',
        };
        const { prompt } = buildAnalysisPrompt(inputs);

        const knowledgeIdx = prompt.indexOf('CUSTOM-KNOWLEDGE-MARKER');
        const frameworkIdx = prompt.indexOf('FRAMEWORK-SIGNAL-MARKER');
        const functionNameIdx = prompt.indexOf('Function name:');
        const taintIdx = prompt.indexOf('TAINT-MARKER');
        const sourceIdx = prompt.indexOf('function reserveStock() {}');

        expect(knowledgeIdx).toBeGreaterThan(-1);
        expect(knowledgeIdx).toBeLessThan(frameworkIdx);
        expect(frameworkIdx).toBeLessThan(functionNameIdx);
        expect(functionNameIdx).toBeLessThan(taintIdx);
        expect(taintIdx).toBeLessThan(sourceIdx);
    });
});
