#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * CodeRadius CLI Wrapper
 *
 * This script allows running the CLI directly using `tsx` from the source code,
 * enabling a "cr ..." command without needing to build to `dist/` first.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const entryPoint = join(projectRoot, 'src', 'cli', 'index.ts');

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const child = spawn(process.execPath, [tsxCli, entryPoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd()
});

child.on('exit', (code) => {
    process.exit(code ?? 0);
});
