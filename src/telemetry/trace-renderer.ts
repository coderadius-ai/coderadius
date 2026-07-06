// ═══════════════════════════════════════════════════════════════════════════════
// Trace Renderer — Streaming JSONL → Lightweight Markdown Summary
//
// Reads a .trace.jsonl file in a single streaming pass using readline.
// Accumulates only short summaries; never embeds full prompts/responses.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import readline from 'node:readline';
import type { TraceAction, TraceEvent } from './trace-collector.js';

interface StageCounts {
    discovery: { included: number; excluded: number; cacheHit: number };
    filter: { passed: number; dropped: number; cacheHit: number };
    llm: { sent: number; received: number; rejected: number; failed: number; retried: number };
    sanitizer: { passed: number; dropped: number; transformed: number };
    persist: { written: number; deleted: number; failed: number };
}

interface FunctionSummary {
    functionId: string;
    functionName: string;
    filePath: string;
    locationLabel?: string;
    filterResult?: { action: TraceAction; gate?: number; gateName?: string; reason: string };
    llmResult?: { action: TraceAction; latencyMs?: number; tokens?: { in: number; out: number }; reason: string };
    sanitizerEvents: { action: TraceAction; target: string; reason: string }[];
    persistResult?: { action: TraceAction; reason: string };
}

interface FileSummary {
    filePath: string;
    functionsDiscovered: number;
    functions: Map<string, FunctionSummary>;
}

interface AttentionItem {
    functionName: string;
    filePath: string;
    stage: string;
    reason: string;
}

export async function renderTraceSummary(jsonlPath: string, mdPath: string): Promise<void> {
    const counts: StageCounts = {
        discovery: { included: 0, excluded: 0, cacheHit: 0 },
        filter: { passed: 0, dropped: 0, cacheHit: 0 },
        llm: { sent: 0, received: 0, rejected: 0, failed: 0, retried: 0 },
        sanitizer: { passed: 0, dropped: 0, transformed: 0 },
        persist: { written: 0, deleted: 0, failed: 0 },
    };

    const files = new Map<string, FileSummary>();
    const attentionItems: AttentionItem[] = [];
    let firstTimestamp = '';
    let lastTimestamp = '';
    let eventCount = 0;

    const fileStream = fs.createReadStream(jsonlPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (!line.trim()) continue;

        let event: TraceEvent;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        eventCount++;
        if (!firstTimestamp) firstTimestamp = event.ts;
        lastTimestamp = event.ts;

        const filePath = getEventFilePath(event);
        const functionId = getEventFunctionId(event);
        const functionName = getEventFunctionName(event, functionId);

        switch (event.stage) {
            case 'discovery':
                if (event.action === 'INCLUDE') counts.discovery.included++;
                else if (event.action === 'EXCLUDE') counts.discovery.excluded++;
                else if (event.action === 'CACHE_HIT') counts.discovery.cacheHit++;
                break;

            case 'analysis':
                if (event.action === 'CACHE_HIT') {
                    counts.filter.cacheHit++;
                } else if (event.action === 'INFO' && filePath) {
                    const funcCount = event.data?.functionsFound as number | undefined;
                    if (funcCount !== undefined) {
                        getOrCreateFile(files, filePath).functionsDiscovered = funcCount;
                    }
                }
                break;

            case 'filter':
                if (event.action === 'PASS') {
                    counts.filter.passed++;
                    if (filePath && functionId) {
                        const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                        summary.filterResult = {
                            action: 'PASS',
                            gate: event.data?.gate as number | undefined,
                            gateName: event.data?.gateName as string | undefined,
                            reason: event.reason,
                        };
                    }
                } else if (event.action === 'DROP') {
                    counts.filter.dropped++;
                    if (filePath && functionId) {
                        const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                        summary.filterResult = { action: 'DROP', reason: event.reason };
                    }
                } else if (event.action === 'CACHE_HIT') {
                    counts.filter.cacheHit++;
                }
                break;

            case 'llm':
                if (event.action === 'SEND') {
                    counts.llm.sent++;
                } else if (event.action === 'RECEIVE') {
                    counts.llm.received++;
                    if (filePath && functionId) {
                        const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                        summary.llmResult = {
                            action: 'RECEIVE',
                            latencyMs: event.data?.latencyMs as number | undefined,
                            tokens: event.data?.tokens as { in: number; out: number } | undefined,
                            reason: event.data?.intent as string || 'has_io=true',
                        };
                    }
                } else if (event.action === 'REJECT') {
                    counts.llm.rejected++;
                    if (filePath && functionId) {
                        const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                        summary.llmResult = {
                            action: 'REJECT',
                            reason: 'has_io=false',
                            latencyMs: event.data?.latencyMs as number | undefined,
                            tokens: event.data?.tokens as { in: number; out: number } | undefined,
                        };
                    }
                } else if (event.action === 'FAIL') {
                    counts.llm.failed++;
                    if (filePath) {
                        attentionItems.push({ functionName, filePath, stage: 'LLM', reason: event.reason });
                        if (functionId) {
                            const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                            summary.llmResult = { action: 'FAIL', reason: event.reason };
                        }
                    }
                } else if (event.action === 'RETRY') {
                    counts.llm.retried++;
                }
                break;

            case 'sanitizer':
                if (event.action === 'DROP') {
                    counts.sanitizer.dropped++;
                    if (filePath) {
                        attentionItems.push({ functionName, filePath, stage: 'Sanitizer', reason: event.reason });
                    }
                    if (filePath && functionId) {
                        const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                        summary.sanitizerEvents.push({
                            action: 'DROP',
                            target: getResourceTarget(event),
                            reason: event.reason,
                        });
                    }
                } else if (event.action === 'TRANSFORM') {
                    counts.sanitizer.transformed++;
                    if (filePath && functionId) {
                        const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                        summary.sanitizerEvents.push({
                            action: 'TRANSFORM',
                            target: getResourceTarget(event),
                            reason: event.reason,
                        });
                    }
                } else if (event.action === 'PASS') {
                    counts.sanitizer.passed++;
                }
                break;

            case 'persist':
            case 'contract':
                if (event.action === 'WRITE') {
                    counts.persist.written++;
                    if (filePath && functionId) {
                        const summary = getOrCreateFunction(files, filePath, functionId, functionName);
                        summary.persistResult = { action: 'WRITE', reason: 'written to graph' };
                    }
                } else if (event.action === 'DELETE') {
                    counts.persist.deleted++;
                } else if (event.action === 'FAIL') {
                    counts.persist.failed++;
                    if (filePath) {
                        attentionItems.push({ functionName, filePath, stage: 'Graph Write', reason: event.reason });
                    }
                }
                break;
        }
    }

    const md = buildMarkdown(counts, files, attentionItems, firstTimestamp, lastTimestamp, eventCount, jsonlPath);
    fs.writeFileSync(mdPath, md, 'utf-8');
}

function buildMarkdown(
    counts: StageCounts,
    files: Map<string, FileSummary>,
    attentionItems: AttentionItem[],
    firstTs: string,
    lastTs: string,
    eventCount: number,
    jsonlPath: string,
): string {
    const lines: string[] = [];
    const sessionName = jsonlPath.split('/').pop()?.replace('.trace.jsonl', '') ?? 'unknown';
    let durationMs = 0;
    try {
        durationMs = firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : 0;
    } catch {
        durationMs = 0;
    }
    const durationStr = durationMs > 60000 ? `${(durationMs / 60000).toFixed(1)}m` : `${(durationMs / 1000).toFixed(1)}s`;

    lines.push(`# Execution Trace — ${sessionName}`);
    const dateLabel = firstTs
        ? (() => {
            try {
                return new Date(firstTs).toISOString().split('T')[0];
            } catch {
                return 'unknown';
            }
        })()
        : 'unknown';
    lines.push(`> ${dateLabel} | Duration: ${durationStr} | ${eventCount} events`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Stage | In | Out | Dropped/Rejected |');
    lines.push('|-------|-----|-----|-----------------|');
    lines.push(`| Discovery | ${counts.discovery.included + counts.discovery.excluded + counts.discovery.cacheHit} files | ${counts.discovery.included} included | ${counts.discovery.excluded} excluded, ${counts.discovery.cacheHit} cache hit |`);
    lines.push(`| Heuristic Filter | ${counts.filter.passed + counts.filter.dropped + counts.filter.cacheHit} functions | ${counts.filter.passed} passed | ${counts.filter.dropped} dropped, ${counts.filter.cacheHit} cache hit |`);
    lines.push(`| LLM Extraction | ${counts.llm.sent} sent | ${counts.llm.received} confirmed | ${counts.llm.rejected} rejected, ${counts.llm.failed} failed, ${counts.llm.retried} retried |`);
    lines.push(`| Sanitizer | ${counts.sanitizer.passed + counts.sanitizer.dropped + counts.sanitizer.transformed} items | ${counts.sanitizer.passed} passed | ${counts.sanitizer.dropped} dropped, ${counts.sanitizer.transformed} transformed |`);
    lines.push(`| Graph Persist | ${counts.persist.written + counts.persist.deleted} ops | ${counts.persist.written} written | ${counts.persist.deleted} deleted, ${counts.persist.failed} failed |`);
    lines.push('');

    if (attentionItems.length > 0) {
        lines.push('## 🔴 Attention Required');
        lines.push('');
        lines.push('Functions dropped or failed at non-obvious stages (Sanitizer, LLM Failure, Graph Write):');
        lines.push('');
        lines.push('| Function | File | Stage | Reason |');
        lines.push('|----------|------|-------|--------|');
        for (const item of attentionItems) {
            lines.push(`| ${item.functionName ? `\`${item.functionName}\`` : '—'} | ${item.filePath} | ${item.stage} | ${item.reason} |`);
        }
        lines.push('');
    }

    lines.push('> **💡 Deep Debugging**: For raw LLM prompts/responses, query the JSONL directly:');
    lines.push(`> \`cat ${jsonlPath} | grep '"stage":"llm"' | grep '"action":"SEND"' | head -1 | jq .\``);
    lines.push('');
    lines.push('## File Details');
    lines.push('');

    const sortedFiles = [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [filePath, fileSummary] of sortedFiles) {
        const sortedFunctions = [...fileSummary.functions.values()].sort((a, b) =>
            getDisplayFunctionName(a, fileSummary).localeCompare(getDisplayFunctionName(b, fileSummary)),
        );
        const ingestedCount = sortedFunctions.filter(func => func.persistResult?.action === 'WRITE').length;

        lines.push('<details>');
        lines.push(`<summary>📄 ${filePath} — ${fileSummary.functionsDiscovered || sortedFunctions.length} found → ${ingestedCount} ingested</summary>`);
        lines.push('');
        lines.push('| Function | Filter | LLM | Sanitizer | Graph |');
        lines.push('|----------|--------|-----|-----------|-------|');

        for (const func of sortedFunctions) {
            const filterCol = formatFilterColumn(func.filterResult);
            const llmCol = formatLLMColumn(func.llmResult);
            const sanitizerCol = formatSanitizerColumn(func.sanitizerEvents);
            const persistCol = func.persistResult?.action === 'WRITE'
                ? '✅ written'
                : (func.persistResult ? `❌ ${func.persistResult.reason}` : '—');
            lines.push(`| \`${getDisplayFunctionName(func, fileSummary)}\` | ${filterCol} | ${llmCol} | ${sanitizerCol} | ${persistCol} |`);
        }
        lines.push('');

        const sanitizerEvents = sortedFunctions.flatMap(func =>
            func.sanitizerEvents.map(event => ({ ...event, functionDisplay: getDisplayFunctionName(func, fileSummary) })),
        );
        if (sanitizerEvents.length > 0) {
            lines.push('**Sanitizer events:**');
            for (const event of sanitizerEvents) {
                const icon = event.action === 'DROP' ? '🗑️' : '🔄';
                lines.push(`- ${icon} \`${event.functionDisplay}\` → ${event.target} — ${event.reason}`);
            }
            lines.push('');
        }

        lines.push('</details>');
        lines.push('');
    }

    return lines.join('\n');
}

function formatFilterColumn(result?: FunctionSummary['filterResult']): string {
    if (!result) return '—';
    if (result.action === 'PASS') {
        const gatePart = result.gate ? ` Gate ${result.gate}` : '';
        const namePart = result.gateName ? ` (${result.gateName})` : '';
        return `✅${gatePart}${namePart}`;
    }
    return `❌ ${result.reason}`;
}

function formatLLMColumn(result?: FunctionSummary['llmResult']): string {
    if (!result) return '—';
    const tokenInfo = result.tokens || result.latencyMs
        ? ` [${result.tokens?.in ?? 0}/${result.tokens?.out ?? 0}tk${result.latencyMs ? `, ${result.latencyMs}ms` : ''}]`
        : '';
    if (result.action === 'RECEIVE') return `✅ has_io${tokenInfo}`;
    if (result.action === 'REJECT') return `⬜ no_io${tokenInfo}`;
    if (result.action === 'FAIL') return `❌ ${result.reason}`;
    return '—';
}

function formatSanitizerColumn(events: FunctionSummary['sanitizerEvents']): string {
    if (events.length === 0) return '✅ clean';
    const drops = events.filter(event => event.action === 'DROP').length;
    const transforms = events.filter(event => event.action === 'TRANSFORM').length;
    const parts: string[] = [];
    if (drops > 0) parts.push(`${drops} drop`);
    if (transforms > 0) parts.push(`${transforms} transform`);
    return parts.join(', ');
}

function getEventFilePath(event: TraceEvent): string | undefined {
    const dataFilePath = event.data?.filePath;
    if (typeof dataFilePath === 'string' && dataFilePath.length > 0) return dataFilePath;

    if (event.stage === 'analysis' && typeof event.target === 'string' && !isFunctionUrn(event.target)) {
        return event.target;
    }

    return undefined;
}

function getEventFunctionId(event: TraceEvent): string | undefined {
    const explicit = event.data?.functionId;
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    if (isFunctionUrn(event.target)) return event.target;
    return undefined;
}

function getEventFunctionName(event: TraceEvent, functionId?: string): string {
    const explicit = event.data?.functionName;
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    if (functionId) return extractFunctionName(functionId);
    return '';
}

function getResourceTarget(event: TraceEvent): string {
    const explicit = event.data?.resourceTarget;
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    return event.target;
}

function isFunctionUrn(target: string): boolean {
    return target.startsWith('cr:function:');
}

function extractFunctionName(functionId: string): string {
    const locationIndex = functionId.lastIndexOf('@L');
    const withoutLocation = locationIndex >= 0 ? functionId.slice(0, locationIndex) : functionId;
    const signatureIndex = withoutLocation.lastIndexOf('::');
    if (signatureIndex === -1) return functionId;
    return withoutLocation.slice(signatureIndex + 2);
}

function extractLocationLabel(functionId: string): string | undefined {
    const match = functionId.match(/(@L\d+:C\d+-L\d+:C\d+)$/);
    return match?.[1];
}

function getOrCreateFile(files: Map<string, FileSummary>, filePath: string): FileSummary {
    let file = files.get(filePath);
    if (!file) {
        file = { filePath, functionsDiscovered: 0, functions: new Map() };
        files.set(filePath, file);
    }
    return file;
}

function getOrCreateFunction(
    files: Map<string, FileSummary>,
    filePath: string,
    functionId: string,
    functionName: string,
): FunctionSummary {
    const file = getOrCreateFile(files, filePath);
    let func = file.functions.get(functionId);
    if (!func) {
        func = {
            functionId,
            functionName: functionName || extractFunctionName(functionId),
            filePath,
            locationLabel: extractLocationLabel(functionId),
            sanitizerEvents: [],
        };
        file.functions.set(functionId, func);
    } else if (functionName && !func.functionName) {
        func.functionName = functionName;
    }
    return func;
}

function getDisplayFunctionName(func: FunctionSummary, fileSummary: FileSummary): string {
    const duplicateCount = [...fileSummary.functions.values()].filter(candidate => candidate.functionName === func.functionName).length;
    if (duplicateCount > 1 && func.locationLabel) {
        return `${func.functionName} ${func.locationLabel}`;
    }
    return func.functionName;
}
