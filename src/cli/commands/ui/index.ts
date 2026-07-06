import { Command } from 'commander';









import type { RadiusDashboardPayload } from '../../../dashboard/payload-types.js';
import pkg from '../../../../package.json';

export function registerUiCommand(parentCmd: Command): void {
    parentCmd
        .command('ui')
        .description('Open the architecture dashboard')
        .option('--json', 'Output pure JSON (headless mode)')
        .option('--out <file>', 'Write report to a specific HTML file instead of auto-opening')
        .option('--focus <domains>', 'Focus the dashboard on one or more architectural domains (comma-separated). Allowed values: agentic-radar, deps, gravity, blast, inventory, governance. Examples: --focus governance | --focus governance,inventory')
        .action(async (opts: { json?: boolean; out?: string; focus?: string }) => {
            const { getAgentHarnessReport } = await import('../../../graph/mutations/agentic.js');
            const { getPackageDepsReport } = await import('../../../graph/queries/deps.js');
            const { analyzeGravity } = await import('../../../graph/application/gravity.service.js');
            const { getTopologyMap } = await import('../../../graph/queries/topology.js');
            const { getInventoryReport } = await import('../../../graph/queries/inventory.js');
            const { getGovernanceReport } = await import('../../../graph/queries/governance.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const { writeAndOpen } = await import('./html-dashboard.js');
            const { CR_ICON } = await import('../../ui/logo.js');
            const isHeadless = opts.json;
            const startMs = performance.now();

            const ALLOWED_FOCUS = ['agentic-radar', 'deps', 'gravity', 'blast', 'inventory', 'governance'];

            // Parse comma-separated focus into a Set. Empty Set means "no
            // focus filter — fetch everything". Trims whitespace so users can
            // write `--focus governance, inventory` with spaces too.
            const focusSet = new Set(
                (opts.focus ?? '')
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean),
            );

            try {
                const invalid = [...focusSet].filter(d => !ALLOWED_FOCUS.includes(d));
                if (invalid.length > 0) {
                    console.error(`\nInvalid focus domain(s): ${invalid.join(', ')}. Allowed values: ${ALLOWED_FOCUS.join(', ')}`);
                    process.exit(1);
                }

                // `wants(d)` short-circuits when no focus filter is set — we
                // fetch every domain by default.
                const wants = (d: string) => focusSet.size === 0 || focusSet.has(d);

                if (!isHeadless) {
                    console.log(`\n${CR_ICON} CodeRadius — Architecture Dashboard`);
                    const focusLabel = focusSet.size > 0 ? ` (Focus: ${[...focusSet].join(', ')})` : '';
                    console.log(`  Scanning ecosystem and generating insights${focusLabel}...`);
                }

                // Fetch data concurrently, only fetching what's needed
                const [radar, deps, gravity, topology, inventory, governance] = await Promise.all([
                    wants('agentic-radar') ? getAgentHarnessReport()       : Promise.resolve(null),
                    wants('deps')          ? getPackageDepsReport()        : Promise.resolve(null),
                    wants('gravity')       ? analyzeGravity({ limit: 10 }) : Promise.resolve(null),
                    wants('blast')         ? getTopologyMap()              : Promise.resolve(null),
                    wants('inventory')     ? getInventoryReport()          : Promise.resolve(null),
                    (wants('governance') || wants('agentic-radar')) ? getGovernanceReport() : Promise.resolve(null),
                ]);

                // Build the pure domain payload — zero presentation logic
                const payload: RadiusDashboardPayload = {
                    generatedAt: new Date().toISOString(),
                    cliVersion: pkg.version,
                    focus: opts.focus,
                    radar,
                    deps,
                    gravity,
                    topology,
                    inventory,
                    governance,
                };

                // Output handling
                if (isHeadless) {
                    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
                } else {
                    await writeAndOpen(payload, {
                        out: opts.out,
                        queryName: 'architectural-insights',
                        executionMs: performance.now() - startMs,
                    });
                }
            } catch (err) {
                if (isHeadless) {
                    process.stderr.write(JSON.stringify({ error: (err as Error).message }, null, 2) + '\n');
                } else {
                    console.error('\nDashboard generation failed:', (err as Error).message);
                }
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
