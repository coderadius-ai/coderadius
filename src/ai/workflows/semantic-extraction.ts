// ═══════════════════════════════════════════════════════════════════════════════
// Semantic Extraction Workflow — Mastra Workflow Orchestration
//
// This workflow wraps the Semantic Extraction layer (Stage 4) in a Mastra
// Workflow with typed steps and Studio visibility.
//
// Steps:
//   Step 1: Enrich   — deterministic taint context → 0 tokens, <1ms
//   Step 2: Analyze  — unified-analyzer LLM call   → 1 LLM call
//   Step 3: Sanitize — deterministic post-LLM filter → 0 tokens, <1ms
//
// The actual pipeline in semantic-extractor.ts calls analyzeFunction() and
// sanitizeAnalysis() directly (for performance), but the workflow definition
// is registered in Mastra for Studio UI visibility and manual testing.
// ═══════════════════════════════════════════════════════════════════════════════

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { analyzeFunction } from '../agents/unified-analyzer.js';
import { sanitizeAnalysis } from './sanitizer.js';
import { CodeChunkSchema, type CodeChunk } from '../../graph/types.js';
import { getLanguagePlugin } from '../../ingestion/core/languages/registry.js';
import { SCAN_MODES } from '../../graph/scan-mode.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const WorkflowInputSchema = z.object({
    functionName: z.string(),
    filePath: z.string(),
    sourceCode: z.string(),
    language: CodeChunkSchema.shape.language,
    scanMode: z.enum(SCAN_MODES),
    imports: z.array(z.string()).default([]),
    constructorSource: z.string().optional(),
    classProperties: z.array(z.string()).default([]),
    // Taint data from the import graph engine
    taintedSymbols: z.array(z.string()).default([]),
    taintedAliases: z.record(z.string(), z.string()).default({}),
    directSinkImports: z.array(z.string()).default([]),
});

const EnrichedSchema = WorkflowInputSchema.extend({
    taintContextSummary: z.string(),
});

const AnalysisOutputSchema = z.object({
    hasIo: z.boolean(),
    intent: z.string(),
    infrastructureNames: z.array(z.string()),
    capabilities: z.array(z.string()),
    droppedCount: z.number(),
    latencyMs: z.number(),
});

// ─── Step 1: Enrich (deterministic) ──────────────────────────────────────────

const enrichStep = createStep({
    id: 'enrich',
    description: 'Build taint context summary from import graph data',
    inputSchema: WorkflowInputSchema,
    outputSchema: EnrichedSchema,
    execute: async ({ inputData }) => {
        const sections: string[] = [];

        if (inputData.directSinkImports.length > 0) {
            sections.push(`Direct I/O imports: ${inputData.directSinkImports.join(', ')}`);
        }
        if (inputData.taintedSymbols.length > 0) {
            sections.push(`Tainted symbols (trace back to I/O sinks): ${inputData.taintedSymbols.join(', ')}`);
        }
        if (Object.keys(inputData.taintedAliases).length > 0) {
            const aliases = Object.entries(inputData.taintedAliases)
                .map(([prop, type]) => `${prop} → ${type} (tainted)`)
                .join(', ');
            sections.push(`DI aliases: ${aliases}`);
        }

        const taintContextSummary = sections.length > 0
            ? `\n--- Taint Context (auto-generated) ---\n${sections.join('\n')}\n--- End Taint Context ---`
            : '';

        return {
            ...inputData,
            taintContextSummary,
        };
    },
});

// ─── Step 2: Analyze (LLM call) ─────────────────────────────────────────────

const analyzeStep = createStep({
    id: 'analyze',
    description: 'Call unified-analyzer agent for semantic extraction',
    inputSchema: EnrichedSchema,
    outputSchema: AnalysisOutputSchema,
    execute: async ({ inputData }) => {
        const chunk: CodeChunk = {
            name: inputData.functionName,
            filepath: inputData.filePath,
            sourceCode: inputData.sourceCode,
            language: inputData.language,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
        };
        const context = {
            imports: inputData.imports.length > 0 ? inputData.imports : undefined,
            constructorSource: inputData.constructorSource,
            classProperties: inputData.classProperties.length > 0 ? inputData.classProperties : undefined,
        };

        const startMs = Date.now();
        const result = await analyzeFunction(chunk, inputData.scanMode, context, inputData.taintContextSummary);
        const latencyMs = Date.now() - startMs;

        if (!result || !result.analysis.has_io) {
            return {
                hasIo: false,
                intent: '',
                infrastructureNames: [],
                capabilities: [],
                droppedCount: 0,
                latencyMs,
            };
        }

        // Apply sanitization (Step 3 logic inlined for workflow compactness)
        const plugin = getLanguagePlugin(inputData.language) ?? undefined;
        const clean = sanitizeAnalysis(result.analysis, { sourceCode: inputData.sourceCode, plugin });
        const droppedCount = (result.analysis.infrastructure?.length || 0) - (clean.infrastructure?.length || 0);

        return {
            hasIo: true,
            intent: clean.intent || '',
            infrastructureNames: clean.infrastructure?.map(i => `${i.type}:${i.name}`) || [],
            capabilities: clean.capabilities || [],
            droppedCount,
            latencyMs,
        };
    },
});

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const semanticExtractionWorkflow = createWorkflow({
    id: 'semantic-extraction',
    inputSchema: WorkflowInputSchema,
    outputSchema: AnalysisOutputSchema,
})
    .then(enrichStep)
    .then(analyzeStep)
    .commit();
