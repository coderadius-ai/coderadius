/**
 * interpretPayloads — pure interpreter for the produced/consumed payload and
 * ORM entity-schema sections of persistFunction.
 *
 * Like interpretApiCalls it returns write INTENTS, not a GraphDelta: schema
 * persistence goes through mergeEmergentSchema, whose output (schemaUrn +
 * fieldUrns) feeds the field-level lineage links — the write must stay on
 * that mutation.
 *
 * Decision parity preserved from the inline sections:
 *   - AST-resolved payloads pre-merge on top of LLM ones (AST wins on field
 *     conflict; AST-only entries added; convergence tagged composite);
 *   - telemetry tags count ALL merged payloads, including those later
 *     skipped by the guards (inline behaviour, preserved);
 *   - opaque payloads warn (governance) and opaque-only ones persist as
 *     stubs with no fields and no lineage;
 *   - templated names and fingerprint duplicates of already-written request
 *     bodies are skipped with debug logs;
 *   - fast scans persist stubs; deep scans materialise required typed fields
 *     and enable field-level lineage.
 */
import {
    astGrounding,
    compositeGrounding,
    llmGrounding,
    type GroundingFields,
} from '../../../../graph/grounding.js';
import { isTemplatedPayloadName } from '../../../../ai/workflows/sanitizer.js';
import type { AstResolvedPayload } from '../types.js';
import { payloadFieldFingerprint } from './api-calls.js';
import type { InterpretLog } from './types.js';

export interface LlmPayloadItem {
    name: string;
    fields: Array<{ name: string; type: string }>;
}

export interface EntitySchemaItem {
    name: string;
    fields: Array<{ name: string; type: string; required?: boolean }>;
}

export interface PayloadsInterpretInput {
    produced?: LlmPayloadItem[];
    consumed?: LlmPayloadItem[];
    entitySchemas?: EntitySchemaItem[];
    astResolved?: AstResolvedPayload[];
}

export interface PayloadsInterpretContext {
    functionName: string;
    relativePath: string;
    isDeepScan: boolean;
    /** Fingerprints of bodies already persisted via emergent_api_calls. */
    writtenFingerprints: ReadonlySet<string>;
}

export type SchemaWriteIntent =
    | {
        kind: 'payload';
        schemaName: string;
        fields: Array<{ name: string; type: string; required: boolean }>;
        link: 'produces' | 'consumes';
        isOpaque: boolean;
        withFieldLineage: boolean;
        grounding: GroundingFields;
    }
    | {
        kind: 'entity-table';
        schemaName: string;
        fields: Array<{ name: string; type: string; required?: boolean }>;
        grounding: GroundingFields;
    };

export interface PayloadsInterpretOutcome {
    schemas: SchemaWriteIntent[];
    logs: InterpretLog[];
    telemetry: { astResolved: number; astLlmConverged: number; llmOnly: number };
}

// Phase 1 (Fix #1) — merge AST-resolved payloads with LLM-emitted payloads
// using basename equality. AST wins on field conflict (override, never
// concat). LLM-only entries pass through. AST-only entries are added so
// the function produces a DataStructure even when the LLM missed it.
type MergedPayload = {
    name: string;
    fields: Array<{ name: string; type: string }>;
    sourceTag: 'ast' | 'composite' | 'llm';
    isOpaque: boolean;
};

function normalizeLlmFields(fields: Array<{ name: string; type: string }> | undefined): Array<{ name: string; type: string }> {
    return (fields ?? []).map(f => ({ name: f.name, type: f.type }));
}

export function mergeAstWithLlm(
    llmPayloads: Array<{ name: string; fields: Array<{ name: string; type: string }> }> | undefined,
    astPayloads: AstResolvedPayload[] | undefined,
    direction: 'produced' | 'consumed',
): MergedPayload[] {
    const result: MergedPayload[] = [];
    const matchedAstBasenames = new Set<string>();
    const directionalAst = (astPayloads ?? []).filter(p => p.direction === direction);

    for (const llm of llmPayloads ?? []) {
        const isOpaque = llm.fields.some(f => f.name === '_opaque_reference');
        const astMatch = directionalAst.find(a => a.basename === llm.name);
        if (astMatch) {
            matchedAstBasenames.add(astMatch.basename);
            result.push({
                name: llm.name,
                fields: astMatch.fields.map(f => ({ name: f.name, type: f.type })),
                sourceTag: 'composite',
                isOpaque: false,
            });
        } else {
            result.push({
                name: llm.name,
                fields: normalizeLlmFields(llm.fields),
                sourceTag: 'llm',
                isOpaque,
            });
        }
    }
    for (const ast of directionalAst) {
        if (matchedAstBasenames.has(ast.basename)) continue;
        result.push({
            name: ast.basename,
            fields: ast.fields.map(f => ({ name: f.name, type: f.type })),
            sourceTag: 'ast',
            isOpaque: false,
        });
    }
    return result;
}

function payloadGroundingFor(sourceTag: 'ast' | 'composite' | 'llm'): GroundingFields {
    if (sourceTag === 'ast') return astGrounding('ast-payload-resolver@v1');
    if (sourceTag === 'composite') {
        return compositeGrounding(
            astGrounding('ast-payload-resolver@v1'),
            llmGrounding('unified-analyzer', 'graph-writer@v1'),
        );
    }
    return llmGrounding('unified-analyzer', 'graph-writer@v1');
}

export function interpretPayloads(
    input: PayloadsInterpretInput,
    ctx: PayloadsInterpretContext,
): PayloadsInterpretOutcome {
    const out: PayloadsInterpretOutcome = {
        schemas: [],
        logs: [],
        telemetry: { astResolved: 0, astLlmConverged: 0, llmOnly: 0 },
    };

    interpretPayloadDirection(mergeAstWithLlm(input.produced, input.astResolved, 'produced'), 'produces', ctx, out);
    appendEntitySchemas(input.entitySchemas, out);
    interpretPayloadDirection(mergeAstWithLlm(input.consumed, input.astResolved, 'consumed'), 'consumes', ctx, out);

    return out;
}

function interpretPayloadDirection(
    merged: MergedPayload[],
    link: 'produces' | 'consumes',
    ctx: PayloadsInterpretContext,
    out: PayloadsInterpretOutcome,
): void {
    const directionWord = link === 'produces' ? 'produced' : 'consumed';
    for (const m of merged) {
        if (m.sourceTag === 'ast') out.telemetry.astResolved++;
        else if (m.sourceTag === 'composite') out.telemetry.astLlmConverged++;
        else out.telemetry.llmOnly++;
    }
    for (const payload of merged) {
        const isOpaque = payload.isOpaque;
        // Opaque-only schemas (single _opaque_reference field) carry no
        // useful field info — persisted as stubs.
        const isOpaqueOnly = isOpaque && payload.fields.length === 1;
        if (isOpaqueOnly) {
            out.logs.push({ level: 'info', message: `Persisting opaque-only ${directionWord} payload: ${payload.name}` });
        }
        if (isOpaque) {
            out.logs.push({
                level: 'warn',
                message: `[Governance] Opaque I/O Payload detected in function "${ctx.functionName}" (${ctx.relativePath}). Cannot statically determine ${link === 'consumes' ? 'consumed ' : ''}data contract — payload is a passthrough parameter.`,
            });
        }
        if (isTemplatedPayloadName(payload.name)) {
            out.logs.push({ level: 'debug', message: `Skipping ${directionWord} payload with unresolved template name: "${payload.name}"` });
            continue;
        }
        const fingerprint = payloadFieldFingerprint(payload.fields);
        if (fingerprint && ctx.writtenFingerprints.has(fingerprint)) {
            out.logs.push({ level: 'debug', message: `Skipping ${directionWord} payload "${payload.name}" (duplicate of payload_schema, fingerprint=${fingerprint})` });
            continue;
        }
        const materialiseFields = ctx.isDeepScan && !isOpaqueOnly;
        out.schemas.push({
            kind: 'payload',
            schemaName: payload.name,
            fields: materialiseFields
                ? payload.fields.map(f => ({ name: f.name, type: f.type, required: true }))
                : [],
            link,
            isOpaque,
            withFieldLineage: materialiseFields,
            grounding: payloadGroundingFor(payload.sourceTag),
        });
    }
}

function appendEntitySchemas(entitySchemas: EntitySchemaItem[] | undefined, out: PayloadsInterpretOutcome): void {
    for (const schema of entitySchemas ?? []) {
        out.schemas.push({
            kind: 'entity-table',
            schemaName: schema.name,
            fields: schema.fields,
            grounding: astGrounding('orm-static@v1'),
        });
    }
}
