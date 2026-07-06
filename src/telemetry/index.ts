// ── Telemetry Module ─────────────────────────────────────────────────────────
// Canonical home for pipeline observability.
// Re-exports the singleton and all types.

export {
    telemetryCollector,
    type TokenUsage,
    type TokenPhase,
    type PhaseTokens,
    type IngestionMetrics,
    type FunnelCounters,
    type CostEstimate,
    type TelemetryReport,
} from './collector.js';

export {
    traceCollector,
    type TraceEvent,
    type TraceStage,
    type TraceAction,
} from './trace-collector.js';
