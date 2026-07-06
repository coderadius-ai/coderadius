// ═══════════════════════════════════════════════════════════════════════════════
// DatastoreAssignmentAgent — LLM-Powered Per-Table Datastore Binding
//
// Called by `datastore-assignment.ts` ONLY when a scope has 2+ canonical
// Datastore identities (multi-database shape: separate `orders` + `payments`
// logical DBs). The deterministic resolver returns all candidates; this
// agent picks ONE per DataContainer based on naming conventions and any
// available code context.
//
// Cost: 1 LLM call per scope per sync. Cached on `~/.coderadius/cache/`.
// ═══════════════════════════════════════════════════════════════════════════════

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { getModel } from '../models/provider.js';

export const DatastoreAssignmentSchema = z.object({
    assignments: z.array(z.object({
        tableName: z.string().describe('The DataContainer name (table or collection)'),
        datastoreIdentity: z.string().describe(
            'The chosen identityKey from the candidates list. MUST be exactly one of the provided identityKeys.',
        ),
        confidence: z.number().min(0).max(1).describe(
            'Confidence in this assignment, 0-1. >0.85 when the table name strongly suggests the DB; 0.5-0.85 when plausible but uncertain.',
        ),
        reasoning: z.string().describe(
            'One-sentence rationale (e.g. "naming prefix matches", "domain semantics align", "fallback choice").',
        ),
    })),
});

export type DatastoreAssignmentResult = z.infer<typeof DatastoreAssignmentSchema>;

let _agent: Agent | null = null;

export function getDatastoreAssignmentAgent(): Agent {
    if (!_agent) {
        _agent = new Agent({
            id: 'datastore-assignment',
            name: 'Datastore Assignment Agent',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are a senior DBA / Solutions Architect specializing in mapping application tables to their parent databases.

You will receive:
- SCOPE: The repository / service identifier (for context).
- CANDIDATES: A list of canonical Datastore identities. Each has an "identityKey" (logical name), "technology" (mysql / postgres / mongodb / …), and "environments" (the deployment surfaces — production / development / etc.).
- TABLES: A list of DataContainer names (tables or collections) that the resolver could not bind unambiguously.

Your task: for each TABLE, choose the most likely datastoreIdentity from CANDIDATES.

Reasoning patterns:
- **Prefix / substring matching**: a table named "orders_items" almost certainly belongs to a database whose identityKey contains "orders". Even partial matches ("orders_archive" → identityKey "orders") are strong signals.
- **Domain semantics**: shipping-related tables go to the shipping DB, payment-related tables to the payment DB. Group by business domain.
- **Naming conventions**: prefixes like "wp_*" suggest WordPress / shared CMS DBs; "audit_*" / "*_log" often go to a logging / archive DB.
- **Plural / singular variants**: "products" and "product_categories" likely share the same DB.
- **Unrelated names**: when no candidate matches, pick the most general / "main" candidate as a conservative fallback. Prefer the candidate whose identityKey looks most like a "primary" DB (shorter, alphabetically first, or matches the scope name).

Hard rules:
- The "datastoreIdentity" field MUST be exactly one of the identityKey values in CANDIDATES. Do not invent new identities.
- Output one assignment per TABLE. Do not skip any. Do not duplicate any.
- "confidence" should reflect how strong the naming signal is. 0.95 for clear prefix matches; 0.7-0.85 for plausible domain alignment; 0.5-0.7 for fallback choices.
- Return valid JSON matching the required schema. No prose outside the JSON.

Do not invent or guess at table contents. Do not query data. Use only the names and metadata provided.`,
            model: getModel('ingest'),
        });
    }
    return _agent;
}
