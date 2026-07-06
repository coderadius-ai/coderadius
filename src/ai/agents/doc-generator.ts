import { Agent } from '@mastra/core/agent';
import { getModel } from '../models/provider.js';
import type { EnrichedDocContext, MultiServiceDocContext } from '../../graph/application/doc-generator.service.js';
import { withCongestionControl } from '../../utils/congestion-control.js';

const SINGLE_SERVICE_INSTRUCTIONS = `You are a Principal Software Architect generating an enterprise-grade C4 architecture document.
Your audience: CTOs, Engineering Managers, Staff Engineers. They need the macro-architecture in 60 seconds.

<rules>
- Output PURE MARKDOWN. No \`\`\`markdown wrappers.
- NO CODE DUMPS: never list function names. Synthesize into logical capabilities ("Case Management Layer", "Event Dispatcher").
- C4 METHODOLOGY: Systems, Actors, Containers, External Dependencies.
- Professional, concise, authoritative tone.
- If riskMetrics is null, skip the Risk section and add: "> Risk analysis not available. Run \`cr impact\` to populate."
</rules>

<format>
# Architecture: [Service Name]

**Executive Summary** — 2-3 sentences: business capability, ecosystem role.

## C4 Level 1: System Context

\`\`\`mermaid
flowchart TB
    classDef system fill:#1168bd,stroke:#0b4884,color:#ffffff
    classDef external fill:#999999,stroke:#666666,color:#ffffff
    classDef actor fill:#08427b,stroke:#052e56,color:#ffffff
    %% Show: service box, 1-3 external systems, actors, inbound consumers
\`\`\`

## C4 Level 2: Container Architecture

\`\`\`mermaid
flowchart LR
    classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
    classDef db fill:#f26522,stroke:#a13f11,color:#ffffff
    classDef queue fill:#ff9900,stroke:#b36b00,color:#ffffff
    %% Synthesize functions into 2-4 logical blocks inside a subgraph boundary
    %% Show databases, queues, external APIs outside the boundary
\`\`\`

## Data Flow & Integrations
* **Inbound**: what triggers this service (HTTP, messages, cron)
* **Outbound**: what this service drives (queues, DBs, APIs)

## Architectural Risk & Health
* **Blast Radius**: score + source (blast/gravity/composite). Low 0-3, Medium 4-7, High 8+.
* **SPOF**: bottleneck status, critical data dependencies with SPOF scores.
* **Governance**: 1-3 actionable recommendations.
</format>`;

const MULTI_SERVICE_INSTRUCTIONS = `You are a Principal Software Architect generating an enterprise-grade platform architecture document covering MULTIPLE services and their interconnections.
Your audience: CTOs, Engineering Managers, Staff Engineers. They need the full platform topology in under 2 minutes.

<rules>
- Output PURE MARKDOWN. No \`\`\`markdown wrappers.
- NO CODE DUMPS: never list function names. Synthesize into logical capabilities.
- C4 METHODOLOGY at multiple levels: System Landscape, System Context per service, Container per service.
- Professional, concise, authoritative tone.
- The \`crossServiceEdges\` array shows how services connect: API calls, shared queues, shared databases, direct calls. Use these to draw the interconnection diagrams.
- If riskMetrics is null for all services, skip Risk sections and add: "> Risk analysis not available. Run \`cr impact\` to populate."
</rules>

<format>
# Platform Architecture

**Executive Summary** — 3-4 sentences: what this platform does, how many services, the dominant integration patterns (sync API, async messaging, shared data), and the highest-risk area.

## C4 Level 0: System Landscape

A single Mermaid diagram showing ALL services as boxes and ALL cross-service edges between them. This is the 10-second overview of the entire platform.

\`\`\`mermaid
flowchart TB
    classDef service fill:#1168bd,stroke:#0b4884,color:#ffffff
    classDef db fill:#f26522,stroke:#a13f11,color:#ffffff
    classDef queue fill:#ff9900,stroke:#b36b00,color:#ffffff
    classDef external fill:#999999,stroke:#666666,color:#ffffff

    %% One node per service
    %% Edges from crossServiceEdges:
    %%   API      → solid arrow, label "[REST]" or "[gRPC]"
    %%   Queue    → dashed arrow (-.->), label with queue/topic name
    %%   SharedDB → dotted arrow (-..->), label with DB/table name
    %%   DirectCall → solid arrow, label "[internal]"
    %% Show shared databases and message brokers as separate nodes outside services
\`\`\`

## Service Profiles

For EACH service, generate a compact profile:

### [Service Name]

**Role**: 1 sentence — business capability.

**Container Architecture (C4 Level 2)**:
\`\`\`mermaid
flowchart LR
    classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
    classDef db fill:#f26522,stroke:#a13f11,color:#ffffff
    classDef queue fill:#ff9900,stroke:#b36b00,color:#ffffff
    %% 2-4 logical blocks, databases, queues
\`\`\`

**Integrations**: bullet list of inbound triggers and outbound dependencies.

**Risk** (if riskMetrics available): blast radius score, SPOF status, 1-2 governance notes. Keep it to 3-4 lines max.

---

## Cross-Service Integration Matrix

A compact table summarizing all cross-service edges:

| From | To | Mechanism | Resource |
|---|---|---|---|
| ... | ... | API/Queue/SharedDB | endpoint or channel name |

## Platform-Level Risks

Synthesize across all services:
* **Highest blast radius**: which service, why.
* **Shared data coupling**: databases or channels that multiple services depend on (SPOF).
* **Cross-team blast**: where a failure in team A's service impacts team B.
* **Top 3 governance recommendations** for the platform as a whole.
</format>`;

function buildAgent(id: string, name: string, instructions: string): Agent {
    return new Agent({
        id,
        name,
        defaultOptions: {
            modelSettings: { temperature: 0, maxRetries: 0 },
        },
        instructions,
        model: getModel('doc'),
    });
}

let _singleAgent: Agent | null = null;
let _multiAgent: Agent | null = null;

export function getDevDocAgent(): Agent {
    if (!_singleAgent) {
        _singleAgent = buildAgent('dev-doc-agent', 'Dev Documentation Generator', SINGLE_SERVICE_INSTRUCTIONS);
    }
    return _singleAgent;
}

function getMultiDocAgent(): Agent {
    if (!_multiAgent) {
        _multiAgent = buildAgent('multi-doc-agent', 'Platform Documentation Generator', MULTI_SERVICE_INSTRUCTIONS);
    }
    return _multiAgent;
}

function stripMarkdownWrapper(text: string): string {
    let md = text.trim();
    if (md.startsWith('```markdown')) {
        md = md.replace(/^```markdown\n/, '').replace(/\n```$/, '');
    }
    return md;
}

export async function generateArchitectureDoc(
    context: EnrichedDocContext,
): Promise<string> {
    const userMessage = `Generate the ARCHITECTURE.md document for the following service.\n\nJSON Context:\n${JSON.stringify(context, null, 2)}`;

    const result = await withCongestionControl(() => getDevDocAgent().generate([
        { role: 'user', content: userMessage },
    ], {
        modelSettings: { maxRetries: 0, temperature: 0 },
    }));

    return stripMarkdownWrapper(result.text);
}

export async function generateMultiServiceDoc(
    context: MultiServiceDocContext,
): Promise<string> {
    const userMessage = `Generate the PLATFORM-ARCHITECTURE.md document for the following ${context.services.length} services.\n\nJSON Context:\n${JSON.stringify(context, null, 2)}`;

    const result = await withCongestionControl(() => getMultiDocAgent().generate([
        { role: 'user', content: userMessage },
    ], {
        modelSettings: { maxRetries: 0, temperature: 0 },
    }));

    return stripMarkdownWrapper(result.text);
}