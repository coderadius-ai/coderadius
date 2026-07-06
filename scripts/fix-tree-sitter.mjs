#!/usr/bin/env node
/**
 * scripts/fix-tree-sitter.mjs
 *
 * Bun sometimes has trouble resolving tree-sitter's internal dynamic
 * loading logic when it is built from source locally (build/Release)
 * instead of downloaded as a prebuilt (prebuilds/).
 *
 * Runs as a postinstall hook under plain Node. Copies the locally built
 * binding into the prebuilds layout when needed; always exits 0 so an
 * install never fails because of this fix-up.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const tsRoot = join(root, 'node_modules', 'tree-sitter');
    const localBinding = join(tsRoot, 'build', 'Release', 'tree_sitter_runtime_binding.node');

    if (existsSync(localBinding)) {
        const prebuildsDir = join(tsRoot, 'prebuilds', `${platform()}-${arch()}`);
        const dest = join(prebuildsDir, 'tree-sitter.node');
        if (!existsSync(dest)) {
            console.log(`[fix-tree-sitter] Linking native binding to ${platform()}-${arch()}/tree-sitter.node...`);
            mkdirSync(prebuildsDir, { recursive: true });
            copyFileSync(localBinding, dest);
        }
    }
} catch (err) {
    console.warn(`[fix-tree-sitter] Skipped: ${err instanceof Error ? err.message : String(err)}`);
}
