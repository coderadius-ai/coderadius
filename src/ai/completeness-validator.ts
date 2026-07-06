// ═══════════════════════════════════════════════════════════════════════════════
// CompletenessValidator — AST-Driven Extraction Drift Detector
//
// Post-LLM quality gate: cross-references static source code signals
// (SQL keywords, HTTP client imports, message broker patterns) against
// the LLM's structured output.  Flags cases where the source code clearly
// contains infrastructure I/O but the LLM output has no matching entry.
//
// This is NOT an extraction mechanism — it does not replace the LLM.
// It is a second-opinion sanity check that catches silent regressions.
//
// Zero LLM calls.  Deterministic.  Pure function.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Signal Detection Rules ─────────────────────────────────────────────────

export interface ASTSignal {
    /** Human-readable signal category */
    category: 'database' | 'http-client' | 'message-broker' | 'graphql' | 'process-spawn';
    /** What triggered this signal */
    evidence: string;
    /** Source line number (1-indexed) */
    line: number;
}

export interface MissingCoverage {
    /** Signal category the LLM should have covered */
    category: ASTSignal['category'];
    /** Description of what's missing */
    description: string;
    /** Evidence from source code */
    evidence: string;
}

export interface CompletenessReport {
    /** All static signals detected in the source code */
    signals: ASTSignal[];
    /** Signals that have no corresponding LLM output */
    missingCoverage: MissingCoverage[];
    /** Completeness score: 0.0 (everything missing) to 1.0 (all signals covered) */
    score: number;
}

export interface LLMOutput {
    has_io: boolean;
    infrastructure: Array<{
        name: string;
        type: string;
    }>;
    emergent_api_calls?: Array<{
        path: string;
        method?: string;
    }>;
}

// ─── Signal Detection ────────────────────────────────────────────────────────

/**
 * Strip comments from source code to avoid false positives.
 * Handles: // single-line, /* multi-line *, # shell-style, and PHP docblocks.
 */
function stripComments(source: string, language: string): string {
    let result = source;

    // Strip multi-line comments (/* ... */) — all languages
    result = result.replace(/\/\*[\s\S]*?\*\//g, (match) => {
        // Preserve newlines so line numbers stay correct
        return match.replace(/[^\n]/g, ' ');
    });

    // Strip single-line comments (// ...) — TS, PHP, Go
    result = result.replace(/\/\/.*$/gm, '');

    // Strip shell-style comments (# ...) — PHP, Python, YAML
    if (['php', 'python'].includes(language)) {
        result = result.replace(/#.*$/gm, '');
    }

    return result;
}

/**
 * SQL keywords that indicate database I/O.
 * We require them to appear as standalone words (word boundary) to avoid
 * false positives like variable names containing "select".
 */
const SQL_PATTERNS: RegExp[] = [
    /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i,
    /\b(?:\.query|\.execute|\.prepare|\.run)\s*\(/i,
    /\b(?:QueryBuilder|createQueryBuilder|getRepository)\b/i,
    /\b(?:DB::table|DB::select|DB::insert|DB::raw)\b/i,
];

/**
 * HTTP client patterns indicating outbound API calls.
 */
const HTTP_CLIENT_PATTERNS: RegExp[] = [
    /\b(?:axios|fetch|got|request|superagent)\s*[\.(]/i,
    /\bnew\s+(?:HttpClient|Http|Client)\s*\(/i,
    /\b(?:http\.(?:get|post|put|patch|delete)|this\.http\.)\s*\(/i,
    /\b(?:curl_exec|curl_init|Guzzle|GuzzleHttp)\b/i,
    /\b(?:\.get|\.post|\.put|\.delete)\s*\(\s*['"`]/i,
];

/**
 * Message broker patterns indicating pub/sub or queue I/O.
 */
const BROKER_PATTERNS: RegExp[] = [
    /\b(?:publish|subscribe|consume|sendToQueue|assertQueue)\s*\(/i,
    /\b(?:channel\.(?:publish|sendToQueue|consume|assertQueue))\s*\(/i,
    /\b(?:MessageBus|EventBus|messageBus|eventBus)\b/,
    /\b(?:pubsub|PubSub|kafkaProducer|kafkaConsumer)\b/i,
    /\b(?:amqp|rabbitmq|AMQP)\b/i,
    /\$this->(?:messageBus|eventBus|publisher|dispatcher)->/i,
];

/**
 * GraphQL operation patterns.
 */
const GRAPHQL_PATTERNS: RegExp[] = [
    /(?:^|\s)@(?:Query|Mutation|Subscription|Resolver)\b/m,
    /\b(?:gql|graphql)\s*`/i,
    /\b(?:useQuery|useMutation|useSubscription)\s*\(/i,
];

/**
 * Process spawn patterns.
 */
const SPAWN_PATTERNS: RegExp[] = [
    /\b(?:exec|shell_exec|passthru|system|proc_open)\s*\(/i,
    /\b(?:spawn|execFile|execSync|spawnSync)\s*\(/i,
    /\b(?:subprocess|Popen|os\.system)\s*\(/i,
];

interface SignalRule {
    category: ASTSignal['category'];
    patterns: RegExp[];
}

const SIGNAL_RULES: SignalRule[] = [
    { category: 'database', patterns: SQL_PATTERNS },
    { category: 'http-client', patterns: HTTP_CLIENT_PATTERNS },
    { category: 'message-broker', patterns: BROKER_PATTERNS },
    { category: 'graphql', patterns: GRAPHQL_PATTERNS },
    { category: 'process-spawn', patterns: SPAWN_PATTERNS },
];

/**
 * Detect static AST signals in source code.
 */
function detectSignals(sourceCode: string, language: string): ASTSignal[] {
    const clean = stripComments(sourceCode, language);
    const lines = clean.split('\n');
    const signals: ASTSignal[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip empty lines and import/use statements (they're declarations, not I/O)
        if (!line.trim()) continue;
        if (/^\s*(?:import\s|use\s|require\s*\(|from\s|const\s+\w+\s*=\s*require)/.test(line)) continue;

        for (const rule of SIGNAL_RULES) {
            for (const pattern of rule.patterns) {
                if (pattern.test(line)) {
                    signals.push({
                        category: rule.category,
                        evidence: line.trim().slice(0, 120),
                        line: i + 1,
                    });
                    break; // Only one signal per rule per line
                }
            }
        }
    }

    return signals;
}

// ─── Coverage Validation ─────────────────────────────────────────────────────

/** Maps signal categories to expected LLM output types. */
const CATEGORY_TO_INFRA_TYPE: Record<ASTSignal['category'], string[]> = {
    'database': ['Database', 'DataContainer'],
    'http-client': [],  // Covered by emergent_api_calls, not infrastructure
    'message-broker': ['MessageChannel'],
    'graphql': [],      // Covered by emergent_api_calls with GRAPHQL prefix
    'process-spawn': ['SystemProcess'],
};

function hasInfraForCategory(output: LLMOutput, category: ASTSignal['category']): boolean {
    const expectedTypes = CATEGORY_TO_INFRA_TYPE[category];

    // HTTP clients are covered by emergent_api_calls
    if (category === 'http-client') {
        return (output.emergent_api_calls?.length ?? 0) > 0;
    }

    // GraphQL is covered by emergent_api_calls with GRAPHQL prefix
    if (category === 'graphql') {
        return (output.emergent_api_calls?.some(c =>
            c.path?.toUpperCase().includes('GRAPHQL'),
        ) ?? false);
    }

    // For infra-based categories, check that at least one matching type exists
    if (expectedTypes.length === 0) return true;

    return output.infrastructure.some(i =>
        expectedTypes.some(t => i.type.toLowerCase().includes(t.toLowerCase())),
    );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate LLM output completeness against source code static signals.
 *
 * @param sourceCode - The raw source code that was analyzed
 * @param language   - Language identifier (typescript, php, go, python)
 * @param llmOutput  - The structured LLM analysis output
 * @returns          - CompletenessReport with signals, missing coverage, and score
 */
export function validateCompleteness(
    sourceCode: string,
    language: string,
    llmOutput: LLMOutput,
): CompletenessReport {
    const signals = detectSignals(sourceCode, language);

    // Dedupe by category — we only need to verify coverage per category, not per signal
    const signalCategories = new Set(signals.map(s => s.category));

    const missingCoverage: MissingCoverage[] = [];

    for (const category of signalCategories) {
        if (!hasInfraForCategory(llmOutput, category)) {
            const relevantSignals = signals.filter(s => s.category === category);
            missingCoverage.push({
                category,
                description: `Source contains ${category} signals but LLM output has no matching entries`,
                evidence: relevantSignals[0]?.evidence ?? '',
            });
        }
    }

    const coveredCount = signalCategories.size - missingCoverage.length;
    const score = signalCategories.size > 0
        ? coveredCount / signalCategories.size
        : 1.0;

    return {
        signals,
        missingCoverage,
        score,
    };
}
