#!/usr/bin/env bun
/**
 * scripts/build-release.ts — CodeRadius CLI Release Builder
 *
 * Strategy: Bun --compile (fast, no Node SEA overhead) + manual tarball for
 * native addons (tree-sitter, libsql) that cannot be safely embedded in a
 * single binary. This replicates the reliability of the previous Node SEA
 * approach without the postject/polyfill complexity.
 *
 * Output layout:
 *   release/sea/
 *     radius                 ← Bun-compiled binary (JS + TS bundled)
 *     node_modules/          ← native addon packages only
 *   release/
 *     coderadius_OS_ARCH.tar.gz  ← distribution tarball
 *
 * Usage:
 *   bun run scripts/build-release.ts
 */

import { execSync } from 'child_process';
import {
    readFileSync,
    writeFileSync,
    mkdirSync,
    copyFileSync,
    existsSync,
    rmSync,
    readdirSync,
    cpSync,
} from 'fs';
import { join } from 'path';
import { platform, arch } from 'os';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, opts: { cwd?: string } = {}): void {
    console.log(`  $ ${cmd}`);
    execSync(cmd, { stdio: 'inherit', ...opts });
}

function log(msg: string): void {
    console.log(`\n${msg}`);
}

// ─── Configuration ────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const RELEASE_SEA_DIR = join(ROOT, 'release', 'sea');
const ENTRY_POINT = join(ROOT, 'src', 'cli', 'index.ts');
const BINARY_NAME = process.platform === 'win32' ? 'cr.exe' : 'cr';
const BINARY_PATH = join(RELEASE_SEA_DIR, BINARY_NAME);

/**
 * Packages containing C/C++ native addons (.node files) that CANNOT be
 * embedded inside a Bun --compile binary.  Only these are kept external
 * and shipped in the tarball's node_modules/.
 *
 * IMPORTANT: Be surgical — only list packages that contain actual .node
 * binary files.  Pure-JS wrappers (@libsql/core, @libsql/client, etc.)
 * MUST be bundled by Bun so their transitive deps (js-base64, etc.) are
 * included.  Using a broad scope like '@libsql' would externalize the
 * entire scope and cause missing-module errors at runtime.
 */

// Detect the platform-specific @libsql native package name
const LIBSQL_NATIVE = `@libsql/${process.platform}-${process.arch}`;

const NATIVE_PACKAGES = [
    'tree-sitter',
    'tree-sitter-go',
    'tree-sitter-php',
    'tree-sitter-python',
    'tree-sitter-typescript',
    LIBSQL_NATIVE,
];

// ─── Step 1: Clean + create output directory ──────────────────────────────────

log('Cleaning release/sea/ directory...');
if (existsSync(RELEASE_SEA_DIR)) {
    readdirSync(RELEASE_SEA_DIR).forEach(f =>
        rmSync(join(RELEASE_SEA_DIR, f), { recursive: true, force: true })
    );
} else {
    mkdirSync(RELEASE_SEA_DIR, { recursive: true });
}

// ─── Step 2: Compile with Bun ─────────────────────────────────────────────────

// Runtime-read assets (policy pack YAMLs) are not embedded by --compile;
// snapshot them into packs.generated.ts so they travel inside the bundle.
log('Regenerating embedded policy packs...');
run(`bun run ${join(ROOT, 'scripts', 'generate-embedded-packs.ts')}`);

log('Compiling with Bun (--compile)...');

// NOTE: We intentionally use --minify-syntax --minify-whitespace instead of
// --minify (which includes --minify-identifiers). Tree-sitter's index.js uses
// eval(`class ${name} extends SyntaxNode { ... }`) to dynamically create node
// subclasses. If identifiers are minified, `SyntaxNode` is renamed but the
// eval() string still references the original name → ReferenceError at runtime.
//
// Native packages (tree-sitter, @libsql) are NOT externalized because Bun's
// --compile resolves externals from /$bunfs/root/, which has no node_modules.
// Instead, they are bundled inline and we rely on --keep-names to preserve
// the class/function names that tree-sitter's eval() depends on.
run(
    `bun build ${ENTRY_POINT} --compile --minify-syntax --minify-whitespace --outfile ${BINARY_PATH}`
);

if (!existsSync(BINARY_PATH)) {
    console.error(`\nBinary not found at ${BINARY_PATH}. Build failed.`);
    process.exit(1);
}

// ─── Step 2.1: Fix Code Signature for macOS ──────────────────────────────────
if (process.platform === 'darwin') {
    log('Fixing macOS Code Signature for Bun binary...');
    // Bun 1.x has a regression where signature is broken on macOS after compile
    try { execSync(`codesign --remove-signature ${BINARY_PATH} 2>/dev/null`); } catch (e) {}
    run(`codesign --sign - ${BINARY_PATH}`);
}

// ─── Step 3: Copy native addon folders from root node_modules ─────────────────

log('Copying native addon folders from root node_modules...');

const RELEASE_NODE_MODULES = join(RELEASE_SEA_DIR, 'node_modules');
if (!existsSync(RELEASE_NODE_MODULES)) {
    mkdirSync(RELEASE_NODE_MODULES, { recursive: true });
}

// Copy each identified native/external package from the root node_modules
for (const pkg of NATIVE_PACKAGES) {
    // Find matching directories in root node_modules
    const rootNM = join(ROOT, 'node_modules');
    const sourcePath = join(rootNM, pkg);

    if (existsSync(sourcePath)) {
        const destPath = join(RELEASE_NODE_MODULES, pkg);
        console.log(`  ↳ Copying ${pkg}...`);
        
        // Use cpSync for recursive copy (available in Node 16.7+ and Bun)
        cpSync(sourcePath, destPath, { 
            recursive: true, 
            dereference: true,
            filter: (src) => !src.includes('.cache') // Skip caches
        });
    } else if (pkg.startsWith('@')) {
        // Handle scoped packages by checking the scope directory
        const scope = pkg.split('/')[0];
        const scopePath = join(rootNM, scope);
        if (existsSync(scopePath)) {
            // If the whole scope wasn't copied yet, we might want to be selective
            // but for simplicity, if a scope is requested, we can copy the whole thing
            // or better, just the specific package if it exists
            const destScope = join(RELEASE_NODE_MODULES, scope);
            if (!existsSync(destScope)) mkdirSync(destScope, { recursive: true });
            
            // Try to find subpackages within the scope
            readdirSync(scopePath).forEach(entry => {
                const fullPkgName = `${scope}/${entry}`;
                if (fullPkgName.startsWith(pkg)) {
                    const src = join(scopePath, entry);
                    const dest = join(destScope, entry);
                    console.log(`  ↳ Copying ${fullPkgName}...`);
                    cpSync(src, dest, { recursive: true, dereference: true });
                }
            });
        }
    }
}

// ─── Step 3.1: Fix tree-sitter native binding path ────────────────────────────
// Tree-sitter's index.js often expects prebuilds in a specific folder but 
// on local installs it might be in build/Release. We fix it for the bundle.
const TS_ROOT = join(RELEASE_NODE_MODULES, 'tree-sitter');
if (existsSync(TS_ROOT)) {
    const PREBUILDS_DIR = join(TS_ROOT, 'prebuilds', `${process.platform}-${process.arch}`);
    const LOCAL_BINDING = join(TS_ROOT, 'build', 'Release', 'tree_sitter_runtime_binding.node');
    
    if (!existsSync(join(PREBUILDS_DIR, 'tree-sitter.node')) && existsSync(LOCAL_BINDING)) {
        log('Fixing tree-sitter native binding path for standalone distribution...');
        mkdirSync(PREBUILDS_DIR, { recursive: true });
        copyFileSync(LOCAL_BINDING, join(PREBUILDS_DIR, 'tree-sitter.node'));
        console.log(`  ✓ Linked ${process.platform}-${process.arch}/tree-sitter.node`);
    }
}

// ─── Step 4: Copy config files ────────────────────────────────────────────────

log('Copying configuration files...');
for (const file of ['docker-compose.yml', '.env.example']) {
    const src = join(ROOT, file);
    if (existsSync(src)) {
        copyFileSync(src, join(RELEASE_SEA_DIR, file));
        console.log(`  ✓ ${file}`);
    }
}

// ─── Step 5: Package into distribution tarball ───────────────────────────────

log('Packaging distribution tarball...');

const OS_KEY = platform() === 'darwin' ? 'darwin' : 'linux';
const ARCH_MAP: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
const ARCH_KEY = ARCH_MAP[arch()] ?? arch();
const tarballName = `coderadius_${OS_KEY}_${ARCH_KEY}.tar.gz`;
const tarballPath = join(ROOT, 'release', tarballName);

// Include binary + node_modules containing native addon binaries
run(`tar czf "${tarballPath}" -C "${RELEASE_SEA_DIR}" ${BINARY_NAME} node_modules`);

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log(`\nRelease build complete.`);
console.log(`   Binary:  ./release/sea/${BINARY_NAME}`);
console.log(`   Tarball: ./release/${tarballName}`);
console.log(`   Install locally: make install-local (publishing is CI-driven, see release.yml)`);
