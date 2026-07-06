import fs from 'node:fs';
import path from 'node:path';
import { fetchDbSnapshot } from '../../eval/db-snapshot.js';
import { loadHybridRegistry } from '../../eval/symbol-registry-loader.js';
import { extractEphemeralTopology } from '../../eval/ephemeral-extractor.js';
import { diffTopologySnapshots, isDeltaEmpty } from '../../eval/graph-differ.js';
import { resolveBlastRadius } from '../../eval/blast-radius-resolver.js';
import { buildReport, renderReport } from '../../eval/report-generator.js';
import { resolveLocalRepoOrg } from '../../ingestion/core/source-resolver.js';

export async function evaluateCodeChangeBlast(input: {
    prTitle?: string | undefined;
    changedFiles: { path: string; proposedContent: string }[];
}): Promise<string> {
    const { prTitle, changedFiles } = input;
    const repoRoot = process.cwd();
    const repoBaseName = path.basename(repoRoot);
    const org = resolveLocalRepoOrg(repoRoot);
    const qualifiedRepoName = `${org ?? 'local'}/${repoBaseName}`;
    const reportRepository = {
        name: qualifiedRepoName,
        path: repoRoot,
    };
    const startTime = Date.now();

    // 1. Setup relative paths
    const changedFilePaths = changedFiles.map((f) => f.path);

    // 2. Read-Only Snapshot (Before state)
    const snapshotResult = await fetchDbSnapshot(changedFilePaths);

    // 3. Backup existing files
    const backups = new Map<string, string | null>();

    for (const file of changedFiles) {
        const absPath = path.join(repoRoot, file.path);
        let originalContent: string | null = null;
        if (fs.existsSync(absPath)) {
            originalContent = fs.readFileSync(absPath, 'utf8');
        }
        backups.set(absPath, originalContent);

        // Ensure directory exists
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write proposed content
        fs.writeFileSync(absPath, file.proposedContent, 'utf8');
    }

    try {
        // 4. Ephemeral Extraction
        const registry = await loadHybridRegistry({
            repoName: qualifiedRepoName,
            repoRoot,
            changedFiles: changedFilePaths,
        });

        const ephemeralResult = await extractEphemeralTopology({
            repoRoot,
            repoName: qualifiedRepoName,
            changedFiles: changedFilePaths,
            symbolRegistry: registry,
        });

        const delta = diffTopologySnapshots(
            snapshotResult.snapshots,
            ephemeralResult.snapshots,
            changedFilePaths
        );

        if (isDeltaEmpty(delta)) {
            const report = buildReport({
                prRef: prTitle || 'Local Evaluation',
                repository: reportRepository,
                changedFiles: changedFilePaths,
                findings: [],
                blastRadiusScore: 0,
                durationMs: Date.now() - startTime,
            });
            return renderReport(report, { format: 'json' });
        }

        const resolution = await resolveBlastRadius(delta);

        const report = buildReport({
            prRef: prTitle || 'Local Evaluation',
            repository: reportRepository,
            changedFiles: changedFilePaths,
            findings: resolution.findings,
            blastRadiusScore: resolution.blastRadiusScore,
            durationMs: Date.now() - startTime,
        });

        return renderReport(report, { format: 'json' });
    } finally {
        // 5. Restore (CRITICAL)
        for (const [absPath, originalContent] of backups) {
            if (originalContent === null) {
                if (fs.existsSync(absPath)) {
                    fs.unlinkSync(absPath);
                }
            } else {
                fs.writeFileSync(absPath, originalContent, 'utf8');
            }
        }
    }
}
