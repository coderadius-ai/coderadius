export interface ProgressReporter {
    /** Report general progress or status updates */
    report(message: string): void;
    /** Update the main task title */
    updateTitle?(title: string): void;
    /** Emphasize a warning */
    warn(message: string): void;
    /** Emphasize an error */
    error(message: string): void;
    /** Provide an extended description or details */
    details?(message: string): void;
    
    // ── Structured Progress ──
    /** Set the total number of work units and their label (e.g., 100, 'functions') */
    setTotal?(total: number, unitLabel?: string): void;
    /** Increment the completed work units by the given amount (default 1) */
    increment?(count?: number, tokens?: number | { in: number, out: number }): void;
    /** Specify the current phase (e.g., 'Discovering files...') */
    setPhase?(phase: string): void;
}

/**
 * Shared context passed between workflow steps.
 */
export interface IngestionContext {
    sessionId: string;
    [key: string]: any;
}

/**
 * Definition of a discrete workflow step that can be mapped to UI.
 */
export interface IngestionStep<T extends IngestionContext = IngestionContext> {
    title: string;
    run: (ctx: T, reporter: ProgressReporter) => Promise<void>;
}

/**
 * A silent reporter that does nothing, useful for tests
 * or background runs where UI is not needed.
 */
export const silentReporter: ProgressReporter = {
    report: () => { },
    updateTitle: () => { },
    warn: () => { },
    error: () => { },
    details: () => { },
};

