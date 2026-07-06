/**
 * Shared contracts for the per-kind infra interpreters.
 *
 * Interpreters are pure: side effects travel OUT as data. Trace events and
 * log lines are returned to the caller (graph-writer), which forwards them
 * to the trace collector / logger.
 */
export interface PersistTrace {
    action: 'WRITE' | 'DROP';
    target: string;
    reason: string;
    meta?: Record<string, unknown>;
}

export interface InterpretLog {
    level: 'info' | 'debug' | 'warn';
    message: string;
}
