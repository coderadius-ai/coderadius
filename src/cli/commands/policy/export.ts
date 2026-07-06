import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { readBuiltinPackFiles } from '../../../policy-runner/loader.js';

const DEFAULT_POLICIES_DIR = '.coderadius/policies';

export interface ExportPackResult {
    copied: number;
    targetDir: string;
    files: string[];
}

export async function exportPack(
    packName: string,
    options: { targetPath?: string; force?: boolean } = {},
): Promise<ExportPackResult> {
    const packFiles = await readBuiltinPackFiles(packName);

    const targetDir = options.targetPath
        ? path.resolve(options.targetPath, packName)
        : path.resolve(DEFAULT_POLICIES_DIR, packName);

    if (fs.existsSync(targetDir) && !options.force) {
        throw new Error(`Local override already exists at ${targetDir}. Use --force to overwrite.`);
    }

    const copiedFiles: string[] = [];
    for (const rel of Object.keys(packFiles).sort()) {
        const dest = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, packFiles[rel]!);
        copiedFiles.push(rel);
    }

    return { copied: copiedFiles.length, targetDir, files: copiedFiles };
}

export function registerPolicyExportCommand(parentCmd: Command): void {
    parentCmd
        .command('export <pack-name>')
        .description('Export a built-in policy pack for local customization')
        .option('--force', 'Overwrite existing local rules without confirmation')
        .option('--path <dir>', `Target directory (default: ${DEFAULT_POLICIES_DIR})`)
        .action(async (packName: string, opts: { force?: boolean; path?: string }) => {
            const { CR_ICON } = await import('../../ui/logo.js');
            console.log(`\n${CR_ICON} CodeRadius Policy Export`);
            console.log(`   Pack: ${packName}\n`);

            try {
                const result = await exportPack(packName, {
                    targetPath: opts.path,
                    force: opts.force,
                });
                console.log(`Exported ${result.copied} rule(s) to ${result.targetDir}`);
                for (const f of result.files) {
                    console.log(`  ${f}`);
                }
                console.log('\nThese local rules take priority over built-in rules on next run.');
            } catch (err) {
                console.error((err as Error).message);
                process.exit(1);
            }

            process.exit(0);
        });
}
