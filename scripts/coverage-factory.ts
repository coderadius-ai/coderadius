#!/usr/bin/env bun
/**
 * Coverage Factory — autonomous extraction expansion loop.
 *
 * ONE COMMAND:  bun scripts/coverage-factory.ts
 *
 * For each target framework (tests/eval/extraction/_targets.json) it
 * drives a headless Claude Code agent through the proven cycle:
 *   1. AUTHOR  — write an anonymized fixture + a docs-grounded golden, plus a
 *                separate HELD-OUT fixture (generalization set the loop can't see).
 *   2. MEASURE — run the coverage harness (the DB-free precision/recall oracle).
 *   3. IMPROVE — if below gate, let the agent extend the PLUGIN (never the core,
 *                never the goldens) until the target fixture passes. Bounded iters.
 *   4. GATE    — adversarial, deterministic, no LLM:
 *                  • target fixture  ≥ gate   (vitest exit 0)
 *                  • HELD-OUT fixture ≥ gate  (catches overfitting)
 *                  • no golden was modified during improve (anti-cheat)
 *                  • no edit to src/ingestion/core/ outside languages/ (no core overfit)
 *                  • tsc clean
 *   5. COMMIT  — commits are created unsigned (sign before merging), on a clean
 *                gate only. Otherwise REVERT plugin edits, keep fixtures, FLAG.
 *
 * Resumable (_factory-state.json), quota-aware (pauses on rate-limit), and
 * branch-isolated. Re-run the same command to continue where it paused.
 *
 * Flags: --max-targets N  --gate 0.9  --max-iters 3  --target <name>  --dry-run
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const COV_DIR = path.join(REPO, 'tests/eval/extraction');
const STATE_PATH = path.join(COV_DIR, '_factory-state.json');
const LOG_DIR = path.join(COV_DIR, '_logs');
const HARNESS = ['vitest', 'run', 'tests/eval/extraction', '--config', 'vitest.eval.config.ts'];

const arg = (k: string, d?: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? (process.argv[i + 1] ?? '') : d;
};
const has = (k: string) => process.argv.includes(`--${k}`);

const GATE = Number(arg('gate', '0.9'));
const MAX_ITERS = Number(arg('max-iters', '3'));
const MAX_TARGETS = Number(arg('max-targets', '99'));
const ONLY = arg('target');
const DRY = has('dry-run');

// Scoped, non-destructive agent surface: Claude file tools + bun + read-only git.
// No rm, no push, no git write — the factory does the committing.
const ALLOWED_TOOLS = 'Read,Write,Edit,Grep,Glob,Bash(bun:*),Bash(git diff:*),Bash(git status:*),Bash(git log:*)';
const QUOTA_MARKERS = /rate limit|rate-limit|usage limit|quota|overloaded|529|too many requests|insufficient_quota/i;

type Status = 'done' | 'flagged' | 'pending';
interface TargetState { status: Status; iters: number; note: string; at: string; }
interface State { targets: Record<string, TargetState>; }

const log = (m: string) => console.log(`[factory] ${m}`);

function loadState(): State {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    return { targets: {} };
}
function saveState(s: State) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n'); }

function sh(cmd: string, args: string[], timeoutMs = 180_000): { code: number; out: string } {
    const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** Run a headless Claude Code agent. Returns quotaHit=true to trigger a clean pause. */
function agent(prompt: string, logFile: string, timeoutMs = 1_500_000): { code: number; quotaHit: boolean } {
    if (DRY) { log(`DRY-RUN agent (${prompt.length} chars) → ${path.basename(logFile)}`); return { code: 0, quotaHit: false }; }
    const r = spawnSync('claude', [
        '-p', prompt,
        '--permission-mode', 'bypassPermissions',
        '--allowedTools', ALLOWED_TOOLS,
        '--output-format', 'text',
    ], { cwd: REPO, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    fs.appendFileSync(logFile, out + '\n');
    const code = r.status ?? 1;
    const quotaHit = code !== 0 && QUOTA_MARKERS.test(out);
    return { code, quotaHit };
}

/** Gate a single fixture by name via the harness exit code. */
function fixturePasses(name: string): boolean {
    return sh('bun', [...HARNESS, '-t', `${name} meets`]).code === 0;
}
function tscClean(): boolean { return sh('bun', ['run', 'build']).code === 0; }

/** Anti-gaming: no golden touched, no core (non-plugin) edits since ref. */
function antiGamingViolations(sinceRef: string): string[] {
    const v: string[] = [];
    const changed = sh('git', ['diff', '--name-only', sinceRef]).out.split('\n').map(s => s.trim()).filter(Boolean);
    const goldensTouched = changed.filter(f => /extraction\/.*\.graph\.yaml$/.test(f) && sh('git', ['diff', sinceRef, '--', f]).out.includes('\n-'));
    if (goldensTouched.length) v.push(`golden(s) modified during improve: ${goldensTouched.join(', ')}`);
    const coreEdits = changed.filter(f => f.startsWith('src/ingestion/core/') && !f.includes('/languages/'));
    if (coreEdits.length) v.push(`core (non-plugin) edited: ${coreEdits.join(', ')}`);
    return v;
}

function revertSrc() { sh('git', ['checkout', '--', 'src/']); }
function commit(name: string, msg: string) {
    sh('git', ['add', 'tests/eval/extraction', 'src/ingestion']);
    sh('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg]);
}

const authorPrompt = (t: { name: string; language: string; hint: string }) => `
You extend CodeRadius framework coverage for: ${t.name} (${t.language}). ${t.hint}

Create a deterministic coverage fixture + a docs-grounded golden so the harness can score it.
Do EXACTLY this:
1. tests/eval/extraction/${t.name}/fixture/ — a MINIMAL (3-5 file) anonymized
   micro-repo, idiomatic ${t.name}, using ONLY the 'acme' vocabulary (acme/orders,
   acme/inventory, acme/payment, acme/shipping, acme/notification). Include the language
   manifest. NEVER copy real-world code. Keep HTTP handlers sink-free where possible
   (return objects) so routing is measured without LLM calls.
2. tests/eval/extraction/${t.name}/expected.graph.yaml — the golden, grounded in
   what ${t.name} ACTUALLY exposes (its real route/resource semantics), NOT in any tool's
   output. Schema + conventions: study tests/eval/extraction/fastify/expected.graph.yaml
   and tests/eval/types/eval-manifest.ts. APIEndpoint names are "METHOD /path"; path params
   use the LOSSLESS canonical form (:id -> {id}, preserve the name).
3. tests/eval/extraction/${t.name}__heldout/ — a SECOND fixture+golden with DIFFERENT
   routes/resources, same framework. Generalization set.
4. Run: bun vitest run tests/eval/extraction --config vitest.eval.config.ts -t "${t.name} meets"
DO NOT edit any plugin/src code in this step. Output ONLY: baseline precision/recall for
${t.name} and ${t.name}__heldout.
`.trim();

const improvePrompt = (t: { name: string; language: string }) => `
The coverage harness reports gaps for ${t.name} (${t.language}). Make the target fixture pass.
Run to see false negatives/positives:
  bun vitest run tests/eval/extraction --config vitest.eval.config.ts -t "${t.name} meets"
Extend the RIGHT plugin so extraction matches the golden. HARD RULES (violating any wastes the run):
- Edit ONLY: src/ingestion/core/languages/${t.language}/** or src/ingestion/processors/route-extractor*.
  NEVER src/ingestion/core/*.ts orchestration files.
- NEVER edit any *.graph.yaml — goldens are frozen; changing them is cheating.
- NEVER read or run the ${t.name}__heldout fixture — it is the held-out generalization set.
- Mirror existing extractors: route-extractor-php.ts, route-extractor-ts-programmatic.ts.
- Keep "bun run build" (tsc) clean. Don't break other tests.
Iterate until "${t.name} meets" passes, then STOP. Output a short status.
`.trim();

async function main() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const targets: Array<{ name: string; language: string; hint: string }> =
        JSON.parse(fs.readFileSync(path.join(COV_DIR, '_targets.json'), 'utf-8')).targets;
    const state = loadState();

    let processed = 0;
    for (const t of targets) {
        if (ONLY && t.name !== ONLY) continue;
        if (state.targets[t.name]?.status === 'done') { log(`skip ${t.name} (done)`); continue; }
        if (processed >= MAX_TARGETS) { log(`reached --max-targets ${MAX_TARGETS}`); break; }
        processed++;

        const logFile = path.join(LOG_DIR, `${t.name}.log`);
        const startRef = sh('git', ['rev-parse', 'HEAD']).out.trim();
        log(`▶ ${t.name} (${t.language}) — author`);

        const a = agent(authorPrompt(t), logFile);
        if (a.quotaHit) return pause(state, t.name, 'quota during author');

        let iters = 0;
        while (!DRY && !fixturePasses(t.name) && iters < MAX_ITERS) {
            iters++;
            log(`  ${t.name} below gate — improve ${iters}/${MAX_ITERS}`);
            const im = agent(improvePrompt(t), logFile);
            if (im.quotaHit) return pause(state, t.name, `quota during improve ${iters}`);
        }

        // ── Adversarial gate (real even in dry-run; only the agent+commit are skipped) ──
        const targetOk = fixturePasses(t.name);
        const heldoutOk = fixturePasses(`${t.name}__heldout`);
        const violations = antiGamingViolations(startRef);
        const tsOk = tscClean();
        const clean = targetOk && heldoutOk && violations.length === 0 && tsOk;

        if (clean && !DRY) {
            commit(t.name, `feat(coverage): ${t.name} (${t.language}) framework fixture + extraction\n\n` +
                `Coverage factory: ${t.name} passes the ${GATE * 100}% precision/recall gate on both the\n` +
                `target and held-out fixtures after ${iters} plugin iteration(s). No core/golden edits.\n\n` +
                `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`);
            state.targets[t.name] = { status: 'done', iters, note: 'gate clean', at: new Date().toISOString() };
            log(`  ✓ ${t.name} DONE (committed)`);
        } else if (DRY) {
            log(`  DRY ${t.name}: target=${targetOk} heldout=${heldoutOk} tsc=${tsOk} violations=[${violations.join('; ')}] (no agent, no commit)`);
            continue;
        } else {
            const why = [
                !targetOk && 'target<gate',
                !heldoutOk && 'heldout<gate (overfit?)',
                !tsOk && 'tsc errors',
                ...violations,
            ].filter(Boolean).join('; ');
            revertSrc(); // keep fixtures for review, drop unproven plugin edits
            state.targets[t.name] = { status: 'flagged', iters, note: why, at: new Date().toISOString() };
            log(`  ⚠ ${t.name} FLAGGED: ${why}`);
        }
        saveState(state);
    }

    log('— run complete —');
    report(state);
}

function pause(state: State, name: string, why: string): void {
    state.targets[name] = { ...(state.targets[name] ?? { iters: 0 }), status: 'pending', note: `PAUSED: ${why}`, at: new Date().toISOString() } as TargetState;
    saveState(state);
    log(`⏸ PAUSED on ${name}: ${why}. Re-run 'bun scripts/coverage-factory.ts' to continue.`);
    report(state);
}

function report(state: State) {
    const by = (s: Status) => Object.entries(state.targets).filter(([, v]) => v.status === s).map(([k]) => k);
    log(`done: [${by('done').join(', ')}]`);
    log(`flagged: [${by('flagged').join(', ')}]`);
    log(`pending: [${by('pending').join(', ')}]`);
}

main();
