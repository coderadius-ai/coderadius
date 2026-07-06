#!/usr/bin/env bun
/**
 * scripts/build-npm-packages.ts — Generate the npm distribution packages
 * from the SEA release tarballs (the esbuild/Biome pattern).
 *
 * Input: the four `coderadius_{os}_{arch}.tar.gz` produced by `make release`
 * on each platform (binary + native node_modules). Output:
 *
 *   npm-dist/platforms/cli-darwin-arm64/   ← @coderadius/cli-darwin-arm64
 *     bin/cr                               ← the SEA binary, Bun embedded
 *     native/                              ← tree-sitter/libsql .node addons
 *     package.json                         ← "os"/"cpu" gated
 *   npm-dist/coderadius/                   ← the `coderadius` wrapper
 *     bin/cr.js                            ← 30-line launcher: resolve the
 *                                            platform package, spawn bin/cr
 *
 * npm installs only the optionalDependency matching the host platform, so
 * `npm i -g coderadius` downloads one prebuilt binary and compiles nothing.
 * The addons live under `native/` (not `node_modules/`) because npm always
 * strips `node_modules` from published tarballs; NODE_PATH treats any
 * directory name the same way.
 *
 * Usage: bun run scripts/build-npm-packages.ts \
 *          --version 0.2.0 --tarballs dist --out npm-dist [--allow-missing]
 */

import { execSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Arguments ────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const version = argValue('--version');
const tarballsDir = argValue('--tarballs');
const outDir = argValue('--out') ?? 'npm-dist';
const allowMissing = process.argv.includes('--allow-missing');

if (!version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || !tarballsDir) {
    console.error('Usage: build-npm-packages.ts --version X.Y.Z --tarballs <dir> [--out <dir>] [--allow-missing]');
    process.exit(1);
}

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(outDir);

// OUT is wiped recursively below; refuse the obviously catastrophic targets.
if (OUT === ROOT || OUT === process.cwd() || OUT === process.env.HOME) {
    console.error(`Refusing --out ${OUT}: it would recursively delete that directory.`);
    process.exit(1);
}

// Tarball arch keys are Go-style (amd64); npm "cpu" uses Node's values (x64).
const TARGETS = [
    { tarball: 'coderadius_darwin_arm64.tar.gz', os: 'darwin', cpu: 'arm64' },
    { tarball: 'coderadius_darwin_amd64.tar.gz', os: 'darwin', cpu: 'x64' },
    { tarball: 'coderadius_linux_arm64.tar.gz', os: 'linux', cpu: 'arm64' },
    { tarball: 'coderadius_linux_amd64.tar.gz', os: 'linux', cpu: 'x64' },
];

const SHARED_META = {
    version,
    license: 'Apache-2.0',
    homepage: 'https://coderadius.ai',
    repository: { type: 'git', url: 'git+https://github.com/coderadius-ai/coderadius.git' },
    bugs: 'https://github.com/coderadius-ai/coderadius/issues',
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'platforms'), { recursive: true });

// ─── Platform packages ────────────────────────────────────────────────────────

const built: Array<{ name: string; os: string; cpu: string }> = [];

for (const target of TARGETS) {
    const src = join(resolve(tarballsDir), target.tarball);
    if (!existsSync(src)) {
        if (allowMissing) {
            console.warn(`  ! ${target.tarball} missing, skipped (--allow-missing)`);
            continue;
        }
        console.error(`Missing tarball: ${src}. All four platforms are required for a release.`);
        process.exit(1);
    }

    const name = `@coderadius/cli-${target.os}-${target.cpu}`;
    const pkgDir = join(OUT, 'platforms', `cli-${target.os}-${target.cpu}`);
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });

    execSync(`tar xzf "${src}" -C "${pkgDir}"`);
    renameSync(join(pkgDir, 'cr'), join(pkgDir, 'bin', 'cr'));
    renameSync(join(pkgDir, 'node_modules'), join(pkgDir, 'native'));
    chmodSync(join(pkgDir, 'bin', 'cr'), 0o755);
    copyFileSync(join(ROOT, 'LICENSE'), join(pkgDir, 'LICENSE'));

    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name,
        description: `CodeRadius CLI prebuilt binary for ${target.os} ${target.cpu}`,
        ...SHARED_META,
        os: [target.os],
        cpu: [target.cpu],
        files: ['bin/', 'native/'],
    }, null, 2) + '\n');

    built.push({ name, ...target });
    console.log(`  ✓ ${name}`);
}

if (built.length === 0) {
    console.error('No tarballs found, nothing to build.');
    process.exit(1);
}

// ─── Wrapper package ──────────────────────────────────────────────────────────

const wrapperDir = join(OUT, 'coderadius');
mkdirSync(join(wrapperDir, 'bin'), { recursive: true });
copyFileSync(join(ROOT, 'LICENSE'), join(wrapperDir, 'LICENSE'));

const LAUNCHER = `#!/usr/bin/env node
// Thin launcher: resolve the platform package (installed as the matching
// optionalDependency) and exec the self-contained SEA binary inside it.
// The CLI itself runs on its embedded Bun runtime, never on this process.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, delimiter } from 'node:path';

const require = createRequire(import.meta.url);
const pkgName = \`@coderadius/cli-\${process.platform}-\${process.arch}\`;

let pkgDir;
try {
    pkgDir = dirname(require.resolve(\`\${pkgName}/package.json\`));
} catch {
    console.error(\`coderadius: no prebuilt binary for \${process.platform}-\${process.arch}.\`);
    console.error('Supported platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64.');
    console.error('If yours is listed, reinstall without --omit=optional.');
    console.error('Otherwise install from source: https://github.com/coderadius-ai/coderadius');
    process.exit(1);
}

// Native addons ship under native/ (npm strips node_modules); the SEA
// resolves them through NODE_PATH, same trick as the curl installer.
const nodePath = join(pkgDir, 'native')
    + (process.env.NODE_PATH ? delimiter + process.env.NODE_PATH : '');

const child = spawn(join(pkgDir, 'bin', 'cr'), process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: nodePath },
});

// Ctrl+C: the terminal delivers SIGINT to the whole foreground process
// group, so the child gets its own copy and runs its graceful shutdown
// (first ^C graceful, second forced). The launcher must NOT die early
// (that returns the prompt while the child still cleans up) and must NOT
// forward (the child would count two signals and force-exit): just wait.
// SIGTERM is different: docker/supervisors send it to the launcher pid
// alone, so it is forwarded.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));

child.on('error', (err) => {
    console.error(\`coderadius: failed to start binary: \${err.message}\`);
    process.exit(1);
});
child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
});
`;

writeFileSync(join(wrapperDir, 'bin', 'cr.js'), LAUNCHER, { mode: 0o755 });

writeFileSync(join(wrapperDir, 'package.json'), JSON.stringify({
    name: 'coderadius',
    description: 'Architecture knowledge graph and blast-radius analysis for polyglot codebases. Self-contained CLI, prebuilt per platform.',
    ...SHARED_META,
    type: 'module',
    bin: { cr: 'bin/cr.js', coderadius: 'bin/cr.js' },
    files: ['bin/'],
    keywords: [
        'architecture', 'knowledge-graph', 'blast-radius', 'impact-analysis',
        'mcp', 'static-analysis', 'governance', 'cli',
    ],
    optionalDependencies: Object.fromEntries(built.map((b) => [b.name, version])),
}, null, 2) + '\n');

writeFileSync(join(wrapperDir, 'README.md'), `# CodeRadius

Prevent cross-repo architectural breakage before merge.

\`\`\`bash
npm i -g coderadius   # or: bun add -g coderadius
cr init
\`\`\`

This package installs a self-contained prebuilt binary for your platform
(no compilation, no runtime dependencies). Full documentation:
https://github.com/coderadius-ai/coderadius
`);

console.log(`  ✓ coderadius (wrapper, ${built.length} platform deps)`);
console.log(`\nPackages ready in ${OUT}. Publish platforms/ first, then coderadius/.`);
