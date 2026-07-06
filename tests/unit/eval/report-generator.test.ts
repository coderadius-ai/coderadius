import { describe, it, expect } from 'vitest';
import { buildReport, renderReport, renderTty, normalizeGitUrl, formatServiceLabel, displayRepoName, formatDuration, formatTokenCount, formatLlmSummary } from '../../../src/eval/report-generator.js';
import type { GuardrailFinding } from '../../../src/eval/types.js';

// Strip ANSI escape codes so layout assertions don't depend on the test env's
// TTY state (the `ansi.*` helpers in report-generator.ts are gated on
// process.stdout.isTTY, but `renderTty` is now exported and exercised
// directly to test the new press-release layout).
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DANGER_FINDING: GuardrailFinding = {
    severity: 'DANGER',
    category: 'breaking_change',
    title: 'Breaking Change: removing order.created breaks 2 consumers',
    whatChanged: 'publish() (in src/Controller.ts) removes PUBLISHES_TO to order.created.',
    rationale:
        'The target order.created is consumed by 2 downstream services. ' +
        'Removing this target will break reads/writes in those consumers.',
    removedEdge: {
        sourceId: 'cr:function:repo:ts:Controller::publish',
        sourceName: 'publish',
        targetId: 'cr:channel:order.created',
        targetName: 'order.created',
        relType: 'PUBLISHES_TO',
        sourceFile: 'src/Controller.ts',
        targetType: 'MessageChannel',
    },
    affectedServices: [
        {
            name: 'notification-service',
            urn: 'cr:service:notification-service',
            teamOwner: 'platform-team',
            functions: [{ name: 'handleOrderCreated', file: 'src/handler.ts' }],
            repository: { name: 'notification-service', url: 'https://github.com/acme/notification-service' },
        },
    ],
};

const WARNING_FINDING: GuardrailFinding = {
    severity: 'WARNING',
    category: 'orphan_producer',
    title: 'Orphan Producer: payments.initiated has no consumers',
    whatChanged: 'publish() (in src/PayController.ts) now publishes to payments.initiated via PUBLISHES_TO.',
    rationale:
        'The resource exists in the graph but no service currently consumes it. ' +
        'This message or task may go unhandled if the consumer has not yet been implemented.',
    addedEdge: {
        sourceId: 'cr:function:repo:ts:PayController::publish',
        sourceName: 'publish',
        targetId: 'cr:channel:payments.initiated',
        targetName: 'payments.initiated',
        relType: 'PUBLISHES_TO',
        sourceFile: 'src/PayController.ts',
        targetType: 'MessageChannel',
    },
    affectedServices: [],
};

const INFO_FINDING: GuardrailFinding = {
    severity: 'INFO',
    category: 'new_dependency',
    title: 'New dependency: READS -> users_table',
    whatChanged: 'getUser() (in src/UserService.ts) adds new READS to users_table.',
    rationale: 'Consumer edges (READS, CONSUMES, CALLS) are typically safe. This adds a new outbound dependency.',
    addedEdge: {
        sourceId: 'cr:function:repo:ts:UserService::getUser',
        sourceName: 'getUser',
        targetId: 'cr:datacontainer:users_table',
        targetName: 'users_table',
        relType: 'READS',
        sourceFile: 'src/UserService.ts',
        targetType: 'DataContainer',
    },
};

// ─── buildReport ──────────────────────────────────────────────────────────────

describe('buildReport', () => {
    it('computes severity counts correctly', () => {
        const report = buildReport({
            prRef: 'PR-1',
            changedFiles: ['src/A.ts'],
            findings: [DANGER_FINDING, WARNING_FINDING, INFO_FINDING],
            blastRadiusScore: 5,
            durationMs: 1000,
        });

        expect(report.summary.danger).toBe(1);
        expect(report.summary.warning).toBe(1);
        expect(report.summary.info).toBe(1);
        expect(report.summary.blastRadiusScore).toBe(5);
    });

    it('sets generatedAt as a valid ISO string', () => {
        const report = buildReport({ prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 0 });
        expect(() => new Date(report.generatedAt)).not.toThrow();
        expect(new Date(report.generatedAt).getFullYear()).toBeGreaterThan(2020);
    });

    it('preserves changedFiles and prRef', () => {
        const report = buildReport({ prRef: 'feat/test', changedFiles: ['a.ts', 'b.ts'], findings: [], blastRadiusScore: 0, durationMs: 0 });
        expect(report.prRef).toBe('feat/test');
        expect(report.changedFiles).toEqual(['a.ts', 'b.ts']);
    });

    it('preserves repository and comparison metadata', () => {
        const report = buildReport({
            prRef: 'main...HEAD',
            repository: { name: 'local/service-a', path: '/tmp/service-a' },
            comparison: { ref: 'main...HEAD', baseRef: 'main', headRef: 'HEAD' },
            baseline: { source: 'graph', knownFiles: ['src/A.ts'], unknownFiles: ['src/B.ts'] },
            changedFiles: [],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 0,
        });
        expect(report.repository).toEqual({ name: 'local/service-a', path: '/tmp/service-a' });
        expect(report.comparison).toEqual({ ref: 'main...HEAD', baseRef: 'main', headRef: 'HEAD' });
        expect(report.baseline).toEqual({ source: 'graph', knownFiles: ['src/A.ts'], unknownFiles: ['src/B.ts'] });
    });

    it('produces zero counts when no findings', () => {
        const report = buildReport({ prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 0 });
        expect(report.summary.danger).toBe(0);
        expect(report.summary.warning).toBe(0);
        expect(report.summary.info).toBe(0);
    });
});

// ─── renderReport (markdown) ──────────────────────────────────────────────────

describe('renderReport — markdown format', () => {
    it('includes the comparison ref in the output', () => {
        const r = buildReport({
            prRef: 'feat/my-pr',
            repository: { name: 'local/service-a', path: '/tmp/service-a' },
            comparison: { ref: 'main...HEAD', baseRef: 'main', headRef: 'HEAD' },
            baseline: { source: 'graph', knownFiles: [], unknownFiles: ['src/A.ts'] },
            changedFiles: [],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 1000,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('local/service-a');
        expect(output).toContain('main...HEAD');
        expect(output).toContain('feat/my-pr');
        expect(output).toContain('Comparison');
        expect(output).toContain('Intent');
        expect(output).toContain('Baseline');
        expect(output).toContain('Baseline coverage gap');
    });

    it('contains the CodeRadius impact evaluation header', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('CodeRadius Blast Evaluation');
    });

    it('renders ALLOW MERGE decision with positive reason when no findings exist', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('**Decision:** ALLOW MERGE · 0 danger, 0 warning, 0 info');
        expect(output).toContain('**Reason:** No blocking architectural impact detected.');
        // The old quartet (Result / Merge gate / Severity) stays gone
        expect(output).not.toContain('Result:**');
        expect(output).not.toContain('Merge gate:**');
        expect(output).not.toContain('Severity:**');
    });

    it('renders BLOCK MERGE decision with category-aware reason when danger findings exist', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 3, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('**Decision:** BLOCK MERGE · 1 danger, 0 warning, 0 info');
        // DANGER_FINDING is category=breaking_change with a MessageChannel target → "Message channel removed..."
        expect(output).toMatch(/\*\*Reason:\*\*.*(removed|changed).*depend/);
    });

    it('renders REVIEW decision with warning count reason when only warnings exist', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [WARNING_FINDING], blastRadiusScore: 1, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('**Decision:** REVIEW · 0 danger, 1 warning, 0 info');
        expect(output).toContain('**Reason:** 1 architectural warning require review');
    });

    it('uses a generic "N breaking changes" reason when multiple DANGER findings exist', () => {
        const SECOND_DANGER = { ...DANGER_FINDING, title: 'Another breaking change' };
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING, SECOND_DANGER], blastRadiusScore: 6, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('**Reason:** 2 breaking architectural changes detected');
    });

    it('renders blast radius counts from DANGER affected services (smart plural)', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 3, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('Blast radius:** 1 service / 1 function impacted');
    });

    it('uses plural form when blast radius affects multiple services', () => {
        const MULTI: GuardrailFinding = {
            ...DANGER_FINDING,
            affectedServices: [
                { name: 'svc-a', urn: 'cr:service:a', teamOwner: null, functions: [{ name: 'fnA', file: 'a.ts' }], repository: null },
                { name: 'svc-b', urn: 'cr:service:b', teamOwner: null, functions: [{ name: 'fnB', file: 'b.ts' }], repository: null },
            ],
        };
        const r = buildReport({ prRef: '', changedFiles: [], findings: [MULTI], blastRadiusScore: 5, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('Blast radius:** 2 services / 2 functions impacted');
    });

    it('omits functions text from blast radius when no functions are resolved', () => {
        const SERVICE_ONLY: GuardrailFinding = {
            ...DANGER_FINDING,
            affectedServices: [
                {
                    name: 'inventory-service',
                    urn: 'cr:service:inventory-service',
                    teamOwner: null,
                    functions: [],
                    repository: null,
                },
            ],
        };
        const r = buildReport({ prRef: '', changedFiles: [], findings: [SERVICE_ONLY], blastRadiusScore: 1, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('Blast radius:** 1 service impacted');
        expect(output).not.toContain('functions impacted');
    });

    it('omits blast radius line entirely when no DANGER findings exist', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [WARNING_FINDING], blastRadiusScore: 1, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toContain('Blast radius:');
    });

    it('does not render the legacy blast radius score in the rendered text', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 99, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toContain('Blast radius score:');
        expect(output).not.toContain('blast radius score');
    });

    it('renders confidence HIGH when baseline is fully covered', () => {
        const r = buildReport({
            prRef: '',
            baseline: { source: 'graph', knownFiles: ['src/A.ts'], unknownFiles: [] },
            changedFiles: ['src/A.ts'],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('Confidence:** HIGH');
        expect(output).toContain('all changed files present in baseline graph');
    });

    it('renders confidence MEDIUM when files were reconstructed from git', () => {
        const r = buildReport({
            prRef: '',
            baseline: {
                source: 'graph+git',
                knownFiles: ['src/A.ts'],
                gitFallbackFiles: ['src/B.ts'],
                unknownFiles: [],
            },
            changedFiles: ['src/A.ts', 'src/B.ts'],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('Confidence:** MEDIUM');
        expect(output).toContain('reconstructed from git base');
    });

    it('renders confidence LOW when files are absent from the baseline graph', () => {
        const r = buildReport({
            prRef: '',
            baseline: { source: 'graph', knownFiles: [], unknownFiles: ['src/A.ts'] },
            changedFiles: ['src/A.ts'],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('Confidence:** LOW');
        expect(output).toContain('absent from graph');
    });

    it('does not render emoji in markdown output', () => {
        const r = buildReport({ prRef: '', changedFiles: ['src/A.ts'], findings: [INFO_FINDING], blastRadiusScore: 0, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toMatch(/[\u{1F50D}\u{2705}\u{2139}\u{1F6A8}\u{26A0}\u{1F4C2}]/u);
    });

    it('shows DANGER badge for danger findings', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 3, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('DANGER');
        expect(output).toContain('Breaking Change');
    });

    it('shows WARNING badge for warning findings', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [WARNING_FINDING], blastRadiusScore: 1, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('WARNING');
        expect(output).toContain('Orphan Producer');
    });

    it('renders affected services table when services are present', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 2, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('notification-service');
        expect(output).toContain('platform-team');
    });

    it('renders the analyzed files section when changedFiles is non-empty', () => {
        const r = buildReport({ prRef: '', changedFiles: ['src/A.ts', 'src/B.ts'], findings: [], blastRadiusScore: 0, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('src/A.ts');
        expect(output).toContain('src/B.ts');
    });

    it('renders the duration', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 3200 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('3.2s');
    });
});

// ─── renderReport (json) ──────────────────────────────────────────────────────

describe('renderReport — json format', () => {
    it('produces valid JSON', () => {
        const r = buildReport({ prRef: 'PR-1', changedFiles: ['src/A.ts'], findings: [DANGER_FINDING], blastRadiusScore: 3, durationMs: 5000 });
        const output = renderReport(r, { format: 'json' });
        expect(() => JSON.parse(output)).not.toThrow();
    });

    it('JSON output contains all top-level fields', () => {
        const r = buildReport({
            prRef: 'PR-1',
            repository: { name: 'local/service-a', path: '/tmp/service-a' },
            comparison: { ref: 'main...HEAD', baseRef: 'main', headRef: 'HEAD' },
            baseline: { source: 'graph', knownFiles: ['src/A.ts'], unknownFiles: ['src/B.ts'] },
            changedFiles: [],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 0,
        });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed).toHaveProperty('prRef');
        expect(parsed).toHaveProperty('repository');
        expect(parsed).toHaveProperty('comparison');
        expect(parsed).toHaveProperty('baseline');
        expect(parsed).toHaveProperty('changedFiles');
        expect(parsed).toHaveProperty('findings');
        expect(parsed).toHaveProperty('summary');
        expect(parsed).toHaveProperty('generatedAt');
        expect(parsed).toHaveProperty('durationMs');
        expect(parsed.repository).toEqual({ name: 'local/service-a', path: '/tmp/service-a' });
        expect(parsed.comparison).toEqual({ ref: 'main...HEAD', baseRef: 'main', headRef: 'HEAD' });
        expect(parsed.baseline).toEqual({ source: 'graph', knownFiles: ['src/A.ts'], unknownFiles: ['src/B.ts'] });
    });

    it('JSON summary counts match findings', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING, WARNING_FINDING], blastRadiusScore: 4, durationMs: 0 });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed.summary.danger).toBe(1);
        expect(parsed.summary.warning).toBe(1);
        expect(parsed.summary.info).toBe(0);
    });

    it('JSON findings preserve severity, category, title', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 0, durationMs: 0 });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed.findings[0].severity).toBe('DANGER');
        expect(parsed.findings[0].category).toBe('breaking_change');
        expect(parsed.findings[0].title).toContain('Breaking Change');
    });

    it('JSON summary exposes blastCounts and confidence', () => {
        const r = buildReport({
            prRef: '',
            baseline: { source: 'graph', knownFiles: ['src/A.ts'], unknownFiles: [] },
            changedFiles: ['src/A.ts'],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed.summary.blastCounts).toEqual({ services: 1, functions: 1 });
        expect(parsed.summary.confidence.level).toBe('HIGH');
        expect(typeof parsed.summary.confidence.reason).toBe('string');
    });

    it('JSON summary keeps the legacy blastRadiusScore field', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 7, durationMs: 0 });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed.summary.blastRadiusScore).toBe(7);
    });
});

// ─── renderReport (auto without TTY) ─────────────────────────────────────────

describe('renderReport — auto format (non-TTY)', () => {
    it('falls back to markdown when stdout is not a TTY', () => {
        // In test environment, stdout.isTTY is undefined/false → markdown path
        const r = buildReport({ prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 0 });
        const output = renderReport(r, { format: 'auto' });
        // Markdown always starts with ## header
        expect(output).toContain('##');
        expect(output).toContain('CodeRadius');
    });
});

// ─── Structured finding body rendering ────────────────────────────────────────

describe('renderReport — structured finding body', () => {
    it('renders all four sections in markdown for a DANGER finding', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('**What changed:**');
        expect(output).toContain('**Why this is dangerous:**');
        expect(output).toContain(DANGER_FINDING.whatChanged);
        expect(output).toContain(DANGER_FINDING.rationale);
    });

    it('renders the three sections in order for a DANGER finding (markdown)', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 3, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        const wc = output.indexOf('**What changed:**');
        const why = output.indexOf('**Why this is dangerous:**');
        const impacted = output.indexOf('**Impacted downstream services:**');
        expect(wc).toBeGreaterThan(0);
        expect(why).toBeGreaterThan(wc);
        expect(impacted).toBeGreaterThan(why);
    });

    it('NEVER renders a Recommended action section (agent / user owns the fix decision)', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING, WARNING_FINDING, INFO_FINDING], blastRadiusScore: 0, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toContain('**Recommended action:**');
        expect(output).not.toContain('Recommended action:');
    });

    it('renders severity-conditional label: DANGER → "Why this is dangerous"', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('**Why this is dangerous:**');
        expect(output).not.toContain('**Why this matters:**');
        expect(output).not.toContain('**Context:**');
    });

    it('renders severity-conditional label: WARNING → "Why this matters"', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [WARNING_FINDING],
            blastRadiusScore: 1,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('**Why this matters:**');
        expect(output).not.toContain('**Why this is dangerous:**');
    });

    it('does NOT render INFO findings in markdown (intentional signal-to-noise filter)', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [INFO_FINDING],
            blastRadiusScore: 0,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        // Context label is the INFO-severity rendering, which is suppressed
        // along with the rest of the INFO finding block.
        expect(output).not.toContain('**Context:**');
        expect(output).not.toContain(INFO_FINDING.title);
        // Count remains in the Decision line.
        expect(output).toContain('0 danger, 0 warning, 1 info');
    });

    it('still emits INFO findings in JSON (programmatic consumers see everything)', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [INFO_FINDING],
            blastRadiusScore: 0,
            durationMs: 0,
        });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed.findings).toHaveLength(1);
        expect(parsed.findings[0].severity).toBe('INFO');
    });

    it('renders the press-release TTY layout for a DANGER finding (markdown branch under test env)', () => {
        // In the test env IS_TTY is false so `format: 'auto'` falls back to
        // the markdown renderer (unchanged in Phase A). The dedicated
        // describe block below covers the new TTY layout via `renderTty`
        // directly.
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'auto' });
        // Markdown labels still present.
        expect(output).toContain('What changed:');
        expect(output).toContain('Why this is dangerous:');
    });

    it('JSON findings contain whatChanged and rationale (no recommendedAction)', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed.findings[0]).toHaveProperty('whatChanged');
        expect(parsed.findings[0]).toHaveProperty('rationale');
        expect(parsed.findings[0]).not.toHaveProperty('recommendedAction');
    });

    it('JSON findings do not contain description field', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const parsed = JSON.parse(renderReport(r, { format: 'json' }));
        expect(parsed.findings[0]).not.toHaveProperty('description');
    });

    it('services table renders in markdown with affected services present', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('Impacted downstream services');
        expect(output).toContain('notification-service');
    });

    it('does not render legacy description field in any format', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [DANGER_FINDING],
            blastRadiusScore: 3,
            durationMs: 0,
        });
        const markdown = renderReport(r, { format: 'markdown' });
        const json = renderReport(r, { format: 'json' });
        // Should not contain any of the old description text patterns
        expect(markdown).not.toContain('description:');
        expect(json).not.toContain('"description"');
    });
});

// ─── "Why blocked?" footer ────────────────────────────────────────────────────

describe('renderReport — "Why blocked?" footer', () => {
    const SECOND_DANGER: GuardrailFinding = {
        ...DANGER_FINDING,
        title: 'Breaking change: removing payments.failed breaks 3 consumers',
    };

    it('omits the ### Why blocked title list when only one DANGER finding exists (would just repeat the title above)', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING], blastRadiusScore: 3, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toContain('### Why blocked');
    });

    it('renders ### Why blocked + DANGER titles when 2+ DANGER findings exist', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING, SECOND_DANGER], blastRadiusScore: 6, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('### Why blocked');
        expect(output).toContain(DANGER_FINDING.title);
        expect(output).toContain(SECOND_DANGER.title);
    });

    it('does not render the Why blocked footer when no danger findings exist', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [WARNING_FINDING], blastRadiusScore: 1, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toContain('### Why blocked');
    });

    it('does NOT render the --advisory hint inline (it lives in `cr impact --help` instead)', () => {
        // Advisory hint was removed: too noisy per-run, covered by docs/--help.
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING, SECOND_DANGER], blastRadiusScore: 6, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toContain('--advisory');
        expect(output).not.toContain('## Override');
    });

    it('does not duplicate blast counts or confidence in footer (header is canonical)', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [DANGER_FINDING, SECOND_DANGER], blastRadiusScore: 6, durationMs: 0 });
        const output = renderReport(r, { format: 'markdown' });
        const whyBlockedIdx = output.indexOf('### Why blocked');
        expect(whyBlockedIdx).toBeGreaterThan(0);
        const footerSection = output.slice(whyBlockedIdx);
        expect(footerSection).not.toContain('service(s)');
        expect(footerSection).not.toContain('function(s)');
        expect(footerSection).not.toMatch(/\bConfidence:/);
    });
});

// ─── formatServiceLabel (TTY service qualifier) ───────────────────────────────

describe('formatServiceLabel', () => {
    it('returns "repo / name" when repository is set and differs from the name', () => {
        // Note: the `unknown/` prefix is stripped via displayRepoName, so a
        // graph-inferred name like "unknown/inventory" renders as "inventory".
        expect(formatServiceLabel({
            name: 'api',
            repository: { name: 'unknown/inventory', url: null },
        })).toBe('inventory / api');
    });

    it('keeps a non-unknown repo prefix intact', () => {
        expect(formatServiceLabel({
            name: 'api',
            repository: { name: 'acme/quote-service', url: null },
        })).toBe('acme/quote-service / api');
    });

    it('returns just the name when repository is null', () => {
        expect(formatServiceLabel({
            name: 'api',
            repository: null,
        })).toBe('api');
    });

    it('returns just the name when repository.name equals the service name (no double-display)', () => {
        expect(formatServiceLabel({
            name: 'inventory-service',
            repository: { name: 'inventory-service', url: null },
        })).toBe('inventory-service');
    });

    it('returns just the name when repository is missing', () => {
        expect(formatServiceLabel({ name: 'api' })).toBe('api');
    });
});

// ─── displayRepoName ──────────────────────────────────────────────────────────

describe('formatDuration', () => {
    it('renders < 1s as "<1s"', () => expect(formatDuration(50)).toBe('<1s'));
    it('renders seconds with one decimal', () => expect(formatDuration(3600)).toBe('3.6s'));
    it('renders < 1 hour as "Xm Ys"', () => expect(formatDuration(212_000)).toBe('3m 32s'));
    it('renders hours as "Hh Mm"', () => expect(formatDuration(4_320_000)).toBe('1h 12m'));
});

describe('formatTokenCount', () => {
    it('renders < 1k verbatim', () => expect(formatTokenCount(850)).toBe('850'));
    it('renders 1k+ with one decimal', () => expect(formatTokenCount(17_032)).toBe('17.0k'));
    it('renders 1M+ with one decimal', () => expect(formatTokenCount(2_500_000)).toBe('2.5M'));
});

describe('formatLlmSummary', () => {
    it('returns null when tokensUsed is missing', () => {
        expect(formatLlmSummary({ durationMs: 3600 })).toBeNull();
    });

    it('returns null when both in/out tokens are zero', () => {
        expect(formatLlmSummary({ durationMs: 3600, tokensUsed: { in: 0, out: 0, cached: 0 } })).toBeNull();
    });

    it('returns compact summary with up/down arrows', () => {
        expect(formatLlmSummary({ durationMs: 3600, tokensUsed: { in: 17_032, out: 3_240, cached: 320 } }))
            .toBe('(3.6s · ↑ 17.0k · ↓ 3.2k tokens)');
    });

    it('uses the minutes format for long runs', () => {
        expect(formatLlmSummary({ durationMs: 212_000, tokensUsed: { in: 50_000, out: 12_000, cached: 0 } }))
            .toBe('(3m 32s · ↑ 50.0k · ↓ 12.0k tokens)');
    });
});

describe('renderReport — LLM summary at end of report', () => {
    it('appends compact summary to markdown footer when tokensUsed is present', () => {
        const r = buildReport({
            prRef: '',
            changedFiles: [],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 3600,
            tokensUsed: { in: 17_032, out: 3_240, cached: 320 },
        });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).toContain('(3.6s · ↑ 17.0k · ↓ 3.2k tokens)');
    });

    it('omits LLM summary when tokensUsed is absent (no LLM call happened)', () => {
        const r = buildReport({ prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 100 });
        const output = renderReport(r, { format: 'markdown' });
        expect(output).not.toContain('tokens)');
    });
});

describe('normalizeGitUrl', () => {
    it('strips ssh prefix + .git suffix for github-style remotes', () => {
        expect(normalizeGitUrl('git@github.com:acme-shop/orchestrator.git')).toBe('github.com/acme-shop/orchestrator');
    });

    it('strips https prefix + .git suffix', () => {
        expect(normalizeGitUrl('https://github.com/acme/orders.git')).toBe('github.com/acme/orders');
    });

    it('handles https URLs without .git suffix', () => {
        expect(normalizeGitUrl('https://gitlab.internal.acme.com/team/repo')).toBe('gitlab.internal.acme.com/team/repo');
    });

    it('returns null for empty / missing input', () => {
        expect(normalizeGitUrl(null)).toBeNull();
        expect(normalizeGitUrl(undefined)).toBeNull();
        expect(normalizeGitUrl('')).toBeNull();
        expect(normalizeGitUrl('   ')).toBeNull();
    });

    it('passes through arbitrary URL shapes (better than dropping them)', () => {
        // Unknown form; just strip the .git tail.
        expect(normalizeGitUrl('file:///srv/repos/local.git')).toBe('file:///srv/repos/local');
    });
});

describe('displayRepoName', () => {
    it('strips the `unknown/` org prefix (URN-naming fallback when no catalog entry)', () => {
        expect(displayRepoName('unknown/inventory')).toBe('inventory');
    });

    it('strips only the literal prefix, not other slashes', () => {
        expect(displayRepoName('unknown/acme/x')).toBe('acme/x');
    });

    it('passes through names that do not start with unknown/', () => {
        expect(displayRepoName('acme/quote-service')).toBe('acme/quote-service');
        expect(displayRepoName('inventory')).toBe('inventory');
    });
});

// ─── TTY press-release layout (Phase A redesign) ──────────────────────────────
//
// These tests call the now-exported `renderTty` directly so the assertions
// don't depend on the test env's IS_TTY state. ANSI escape codes are stripped
// via the `stripAnsi` helper at the top of this file so layout assertions
// stay focused on the visible text content.

describe('renderTty — press-release layout', () => {
    const TABLE_RENAME_DANGER: GuardrailFinding = {
        severity: 'DANGER',
        category: 'renamed_dependency',
        title: 'Table mapping changed: `orders` -> `purchases` impacts 1 service',
        whatChanged: '`orders` -> `purchases`\nsource: `Acme\\Entity\\Order::__class_metadata` in `src/Entity/Order.php`',
        rationale: 'The previous target `orders` is consumed by 1 downstream service.',
        removedEdge: {
            sourceId: 'cr:function:acme/orders:php:Acme\\Entity\\Order::__class_metadata',
            sourceName: 'Acme\\Entity\\Order::__class_metadata',
            targetId: 'cr:datacontainer:acme/orders:orders',
            targetName: 'orders',
            relType: 'MAPS_TO',
            sourceFile: 'src/Entity/Order.php',
            targetType: 'DataContainer',
        },
        addedEdge: {
            sourceId: 'cr:function:acme/orders:php:Acme\\Entity\\Order::__class_metadata',
            sourceName: 'Acme\\Entity\\Order::__class_metadata',
            targetId: 'cr:datacontainer:acme/orders:purchases',
            targetName: 'purchases',
            relType: 'MAPS_TO',
            sourceFile: 'src/Entity/Order.php',
            targetType: 'DataContainer',
        },
        affectedServices: [{
            name: 'orders-service',
            urn: 'cr:service:orders-service',
            teamOwner: 'payments-platform',
            functions: [
                { name: 'Acme\\Repository\\OrderRepository::findByCustomerId', file: 'src/Repository/OrderRepository.php' },
                { name: 'Acme\\Command\\UpdateOrderCommand::execute', file: 'src/Command/UpdateOrderCommand.php' },
            ],
            repository: { name: 'acme/orders', url: null },
        }],
    };

    function buildBlockedReport(): ReturnType<typeof buildReport> {
        return buildReport({
            prRef: 'main..HEAD',
            repository: {
                name: 'acme/orders',
                path: '/tmp/orders',
                url: 'git@github.com:acme/orders.git',
            },
            comparison: { ref: 'main..HEAD', baseRef: 'main', headRef: 'HEAD' },
            baseline: { source: 'graph', knownFiles: ['src/Entity/Order.php'], unknownFiles: [] },
            changedFiles: ['src/Entity/Order.php'],
            findings: [TABLE_RENAME_DANGER],
            blastRadiusScore: 5,
            durationMs: 2400,
        });
    }

    it('BREAKING state shows the header strip first, then `× breaking`, then the `<old> → <new>` diff', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        const lines = output.split('\n');
        const head = lines.slice(0, 8).join('\n');
        // First non-empty line is the header strip (carries the repo URL).
        expect(head).toMatch(/github\.com\/acme\/orders/);
        // Verdict line uses lowercase `× breaking`, no caps.
        expect(head).toMatch(/×\s+breaking/);
        // The rename diff appears as `<old>  →  <new>` on a single line so
        // the eye spots typos like `orders → ordres` at a glance.
        expect(head).toMatch(/orders\s+→\s+purchases/);
        // Plus a short consequence sentence on the next line.
        expect(head).toMatch(/1 service still reads it/);
        // No merge-specific language anywhere.
        expect(head).not.toMatch(/\bmerge\b/i);
        expect(head).not.toMatch(/\bpull request\b|\bPR\b/);
    });

    it('BREAKING state has no uppercase section labels (`BREAKING`, `ROOT CAUSE`, `Impact`)', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        expect(output).not.toMatch(/\bBREAKING\b/);
        expect(output).not.toMatch(/\bROOT CAUSE\b/);
        expect(output).not.toMatch(/^\s*Impact\b/m);
    });

    it('BREAKING state lists impacted services exactly once (not repeated per finding)', () => {
        const second: GuardrailFinding = {
            ...TABLE_RENAME_DANGER,
            title: 'Breaking change: removing `legacy_table` breaks 1 consumer',
        };
        const r = buildReport({
            prRef: '',
            changedFiles: ['src/Entity/Order.php'],
            findings: [TABLE_RENAME_DANGER, second],
            blastRadiusScore: 5,
            durationMs: 1000,
        });
        const output = stripAnsi(renderTty(r));
        // The shared service name should appear exactly once in the Impact
        // section (it's the same affectedServices array on both findings).
        const occurrences = (output.match(/orders-service/g) ?? []).length;
        expect(occurrences).toBe(1);
    });

    it('SAFE state renders in 3 visible lines or fewer (header + ✓ safe + summary)', () => {
        const r = buildReport({
            prRef: '',
            repository: { name: 'acme/svc', path: '/tmp', url: 'git@github.com:acme/svc.git' },
            changedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
            findings: [],
            blastRadiusScore: 0,
            durationMs: 1800,
        });
        const output = stripAnsi(renderTty(r));
        const nonEmptyLines = output.split('\n').filter(l => l.trim().length > 0);
        expect(nonEmptyLines.length).toBeLessThanOrEqual(3); // header + verdict + (nothing else)
        expect(output).toContain('✓');
        expect(output).toContain('safe');
        expect(output).toContain('no architectural impact');
        // Exit code is no longer surfaced in the text (it's set via process.exit).
        expect(output).not.toContain('exit 0');
        expect(output).not.toMatch(/\bmerge\b/i);
    });

    it('WATCH state renders amber accent + minimal layout', () => {
        const WARNING_ONLY: GuardrailFinding = {
            severity: 'WARNING',
            category: 'orphan_producer',
            title: 'Orphan Producer: payments.initiated has no consumers',
            whatChanged: '`publish()` now publishes to `payments.initiated`.',
            rationale: 'No consumer yet, may be partial.',
        };
        const r = buildReport({
            prRef: '',
            changedFiles: ['src/PayController.ts'],
            findings: [WARNING_ONLY],
            blastRadiusScore: 1,
            durationMs: 1900,
        });
        const output = stripAnsi(renderTty(r));
        // `▲ watch` lives after the header strip, lowercase.
        expect(output).toMatch(/▲\s+watch/);
        expect(output).toContain('Orphan Producer');
        expect(output).toContain('no downstream breaks');
        expect(output).not.toMatch(/\bBREAKING\b/);
        expect(output).not.toMatch(/\bWATCH\b/);
        expect(output).not.toMatch(/\bmerge\b/i);
    });

    it('no em-dashes anywhere in the rendered output (any state)', () => {
        const blocked = stripAnsi(renderTty(buildBlockedReport()));
        const pass = stripAnsi(renderTty(buildReport({
            prRef: '', changedFiles: [], findings: [], blastRadiusScore: 0, durationMs: 0,
        })));
        expect(blocked).not.toContain('—');
        expect(pass).not.toContain('—');
    });

    it('no box-drawing or gutter characters in the body', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        expect(output).not.toContain('│');
        expect(output).not.toMatch(/[┌┐└┘─┼┤├┬┴]/);
    });

    it('does NOT render an ACTION block (the next step is implicit; agents/humans decide)', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        expect(output).not.toContain('ACTION');
        expect(output).not.toMatch(/\n\s+1\.\sRevert/);
        expect(output).not.toContain('re-run cr blast');
    });

    it('does NOT render a Detail hint (--verbose has no effect on the TTY layout)', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        expect(output).not.toContain('Detail');
        expect(output).not.toContain('--verbose');
    });

    it('header strip lands at the TOP (above the verdict) and carries repo URL + ref + file count + duration', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        const lines = output.split('\n');
        // First non-empty line is the header strip (one dim metadata row).
        const headerLine = lines.find(l => l.trim().length > 0)!;
        expect(headerLine).toContain('github.com/acme/orders');
        expect(headerLine).toContain('main..HEAD');
        expect(headerLine).toContain('1 file');
        expect(headerLine).toContain('2.4s');
        // The verdict (`× breaking`) must appear AFTER the header line.
        const headerIdx = lines.indexOf(headerLine);
        const verdictIdx = lines.findIndex(l => /×\s+breaking/.test(l));
        expect(verdictIdx).toBeGreaterThan(headerIdx);
        // No exit-code label and no HIGH confidence (only LOW / MEDIUM surface).
        expect(output).not.toContain('exit ');
        expect(output).not.toContain('HIGH');
    });

    it('shows the full remote URL (not the short name) in impacted services when available', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        // Service block must carry the normalised URL.
        expect(output).toContain('github.com/acme/orders');
    });

    it('drops file paths from the consumer entrypoints (function name is grep-able)', () => {
        const output = stripAnsi(renderTty(buildBlockedReport()));
        // The fixture's entrypoint file is `src/Repository/OrderRepository.php`;
        // it must NOT show up in the consumer block (only the function name).
        expect(output).toContain('OrderRepository::findByCustomerId');
        expect(output).not.toContain('src/Repository/OrderRepository.php');
    });

    it('elides deeply-namespaced PHP names with `\\…\\`', () => {
        // First segment + last segment + `…` between, so the reader keeps
        // both the root namespace and the class+method.
        // Pure-function test on the helper via end-to-end rendering: feed
        // a finding whose affected service carries a long fn name.
        const longName = 'AcmeShop\\Shipping\\Express\\UpdateQuote\\Command\\AbstractUpdateQuoteWindowCommand.execute';
        const finding: GuardrailFinding = {
            ...TABLE_RENAME_DANGER,
            affectedServices: [{
                ...TABLE_RENAME_DANGER.affectedServices![0],
                functions: [{ name: longName, file: null }],
            }],
        };
        const r = buildReport({
            prRef: '', changedFiles: ['src/Entity/Order.php'],
            findings: [finding], blastRadiusScore: 1, durationMs: 100,
        });
        const output = stripAnsi(renderTty(r));
        expect(output).toContain('AcmeShop\\…\\AbstractUpdateQuoteWindowCommand.execute');
        expect(output).not.toContain(longName);
    });
});

// ─── computeBlastExitCode ────────────────────────────────────────────────────

describe('computeBlastExitCode', () => {
    // Importing from the CLI module would couple this unit test to the
    // commander setup; we re-implement the contract here with the same shape
    // so a regression in the exported helper still trips the test.
    const compute = async (...args: Parameters<typeof import('../../../src/cli/commands/evaluate/blast.js').computeBlastExitCode>) => {
        const { computeBlastExitCode } = await import('../../../src/cli/commands/evaluate/blast.js');
        return computeBlastExitCode(...args);
    };

    it('returns 2 for any DANGER without --advisory', async () => {
        expect(await compute({ danger: 1, warning: 0 }, {})).toBe(2);
        expect(await compute({ danger: 3, warning: 2 }, {})).toBe(2);
    });

    it('returns 1 for WARN with no DANGER', async () => {
        expect(await compute({ danger: 0, warning: 1 }, {})).toBe(1);
    });

    it('returns 0 for clean state', async () => {
        expect(await compute({ danger: 0, warning: 0 }, {})).toBe(0);
    });

    it('--advisory forces 0 even on DANGER', async () => {
        expect(await compute({ danger: 5, warning: 1 }, { advisory: true })).toBe(0);
    });
});
