/**
 * Dev server for the dashboard UI with live reload.
 *
 * Uses Bun's native bundler + HTTP server + WebSocket. Zero external deps.
 * On startup, queries the live graph via `bun run dev -- ui --json` to get
 * a real payload. The payload is fetched once; UI changes trigger re-bundle
 * + browser reload against the same data.
 *
 * Usage:
 *   bun run scripts/dev-dashboard.ts                    # fetch live data from graph
 *   bun run scripts/dev-dashboard.ts --data payload.json # use a saved payload file
 *   bun run scripts/dev-dashboard.ts --port 4000         # custom port
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const UI_DIR = path.join(ROOT, 'packages/dashboard-ui');
const ENTRY = path.join(UI_DIR, 'src/main.tsx');
const CSS_ENTRY = path.join(UI_DIR, 'src/styles/index.css');
const WATCH_DIR = path.join(UI_DIR, 'src');
const CLI_ENTRY = path.join(ROOT, 'src/cli/index.ts');

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    let port = 3456;
    let dataFile: string | null = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1], 10);
        if (args[i] === '--data' && args[i + 1]) dataFile = path.resolve(args[i + 1]);
    }

    return { port, dataFile };
}

const { port, dataFile } = parseArgs();

// ── Fetch payload ───────────────────────────────────────────────────────────

let payloadJson = '';

async function fetchPayload(): Promise<void> {
    if (dataFile) {
        console.log(`  Loading payload from ${dataFile}...`);
        const raw = fs.readFileSync(dataFile, 'utf8');
        JSON.parse(raw);
        payloadJson = raw.replace(/</g, '\\u003c');
        return;
    }

    console.log('  Fetching live data from graph (bun run dev -- ui --json)...');
    const proc = Bun.spawn(['bun', 'run', CLI_ENTRY, 'ui', '--json'], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        console.error(`  Failed to fetch payload (exit ${exitCode}):`);
        if (stderr.trim()) console.error(`  ${stderr.trim()}`);
        console.error('  Make sure Memgraph is running (make start) and the graph has data.');
        process.exit(1);
    }

    JSON.parse(stdout);
    payloadJson = stdout.replace(/</g, '\\u003c');
    console.log(`  Payload fetched (${(stdout.length / 1024).toFixed(0)} KB)`);
}

await fetchPayload();

// ── Bundle ──────────────────────────────────────────────────────────────────

let cachedHtml = '';
let buildCount = 0;

async function bundle(): Promise<string> {
    const t0 = performance.now();

    const [jsResult, cssResult] = await Promise.all([
        Bun.build({
            entrypoints: [ENTRY],
            target: 'browser',
            format: 'esm',
            minify: false,
            tsconfig: path.join(UI_DIR, 'tsconfig.json'),
            define: { 'process.env.NODE_ENV': '"development"' },
        }),
        Bun.build({
            entrypoints: [CSS_ENTRY],
            target: 'browser',
            minify: false,
        }),
    ]);

    if (!jsResult.success) {
        const errors = jsResult.logs.map(l => String(l)).join('\n');
        console.error(`  Build error:\n${errors}`);
        return cachedHtml || `<pre style="color:red;padding:2em">${errors}</pre>`;
    }

    let jsCode = '';
    for (const o of jsResult.outputs) {
        if (o.kind === 'entry-point' || o.kind === 'chunk') jsCode += await o.text();
    }

    let cssCode = '';
    if (cssResult.success) {
        for (const o of cssResult.outputs) cssCode += await o.text();
    }
    for (const o of jsResult.outputs) {
        if (o.path.endsWith('.css')) cssCode += await o.text();
    }

    const elapsed = (performance.now() - t0).toFixed(0);
    buildCount++;

    cachedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — CodeRadius (dev)</title>
  <style>${cssCode}</style>
</head>
<body>
  <div id="root"></div>
  <script>window.__RADIUS_DATA__ = ${payloadJson};</script>
  <script type="module">${jsCode.replace(/<\/script>/gi, '<\\/script>')}</script>
  <script>
    (function() {
      var ws = new WebSocket('ws://' + location.host + '/__ws');
      ws.onmessage = function(e) { if (e.data === 'reload') location.reload(); };
      ws.onclose = function() { setTimeout(function() { location.reload(); }, 1000); };
    })();
  </script>
</body>
</html>`;

    console.log(`  [${buildCount}] Rebuilt in ${elapsed}ms`);
    return cachedHtml;
}

// ── WebSocket clients ───────────────────────────────────────────────────────

const wsClients = new Set<{ send(msg: string): void; close(): void }>();

function notifyReload() {
    for (const ws of wsClients) {
        try { ws.send('reload'); } catch { wsClients.delete(ws); }
    }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

await bundle();

const server = Bun.serve({
    port,
    async fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === '/__ws') {
            const ok = server.upgrade(req);
            return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
        }

        return new Response(cachedHtml, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    },
    websocket: {
        open(ws) { wsClients.add(ws); },
        close(ws) { wsClients.delete(ws); },
        message() {},
    },
});

const url = `http://localhost:${server.port}`;
console.log(`\n  Dashboard dev server running at ${url}`);
console.log(`  Watching ${path.relative(ROOT, WATCH_DIR)} for changes...`);
console.log('');

const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
exec(`${openCmd} ${url}`);

// ── File watcher ────────────────────────────────────────────────────────────

let debounce: ReturnType<typeof setTimeout> | null = null;

fs.watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
        debounce = null;
        await bundle();
        notifyReload();
    }, 150);
});

const sharedTypesDir = path.join(ROOT, 'packages/shared-types');
if (fs.existsSync(sharedTypesDir)) {
    fs.watch(sharedTypesDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(async () => {
            debounce = null;
            await bundle();
            notifyReload();
        }, 150);
    });
}
