import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';

const execAsync = promisify(exec);

// ─── Data Types ─────────────────────────────────────────────────────────────

import type { RadiusDashboardPayload } from '../../../dashboard/payload-types.js';

// Re-export display types for any remaining consumers
import type {
    DashboardConfig,
    DashboardSection,
    TreeNode
} from '../../../dashboard/types.js';

export type {
    DashboardConfig,
    DashboardSection,
    TreeNode
};

// ─── Main Functions ─────────────────────────────────────────────────────────

export async function writeAndOpen(payload: RadiusDashboardPayload, options: { out?: string; queryName: string; executionMs?: number }): Promise<void> {
    const html = renderHtmlTemplate(payload);

    let filePath: string;
    let isTemp = false;

    if (options.out) {
        filePath = path.resolve(options.out);
    } else {
        const tmpDir = os.tmpdir();
        const timestamp = Math.floor(Date.now() / 1000);
        filePath = path.join(tmpDir, `coderadius-${options.queryName}-${timestamp}.html`);
        isTemp = true;
    }

    // Write file
    fs.writeFileSync(filePath, html, 'utf8');

    const timing = options.executionMs ? chalk.gray(`[${options.executionMs.toFixed(0)}ms]`) : '';

    if (!isTemp) {
        console.log(`\n  ${chalk.cyan('ok')} ${chalk.white('Dashboard exported:')} ${chalk.gray(filePath)} ${timing}\n`);
        return; // Don't auto-open if explicitly writing out (like a CI step)
    }

    console.log(`\n  ${chalk.cyan('ok')} ${chalk.white('Dashboard generated')} ${timing}`);
    console.log(`    ${chalk.gray('Opening in browser: ' + options.queryName)}\n`);

    // Try to open it
    try {
        let command = '';
        switch (process.platform) {
            case 'darwin':
                command = `open "${filePath}"`;
                break;
            case 'win32':
                command = `start "" "${filePath}"`;
                break;
            default:
                command = `xdg-open "${filePath}"`;
                break;
        }
        await execAsync(command);
    } catch (err) {
        console.log(`\n  ${chalk.yellow('!')} ${chalk.gray('Could not open browser automatically.')}`);
        console.log(`    ${chalk.gray('Saved at:')} ${filePath}\n`);
    }
}

import rawTemplate from './template-react.js';

// ─── HTML Template ──────────────────────────────────────────────────────────

function renderHtmlTemplate(payload: RadiusDashboardPayload): string {
    const jsonPayload = JSON.stringify(payload).replace(/</g, '\\u003c');
    return rawTemplate.replace('__REPORT_DATA__', jsonPayload);
}
