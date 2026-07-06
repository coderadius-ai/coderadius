import { logger } from '../utils/logger.js';

export interface AutoRunPack {
    name: string;
    queryTimeoutMs?: number;
}

export interface AutoRunResult {
    pack: string;
    totalEvaluated: number;
    compliancePct: number;
    ok: boolean;
}

const BUILTIN_PACKS: AutoRunPack[] = [
    { name: 'agent-readiness', queryTimeoutMs: 5000 },
];

export function getBuiltinPacks(): readonly AutoRunPack[] {
    return BUILTIN_PACKS;
}

export interface AutoRunReporter {
    report: (msg: string) => void;
}

export async function runPostIngestionPolicies(
    packs: readonly AutoRunPack[] = BUILTIN_PACKS,
    reporter?: AutoRunReporter,
): Promise<AutoRunResult[]> {
    const { PolicyRunner } = await import('./index.js');
    const results: AutoRunResult[] = [];
    const log = reporter?.report ?? ((msg: string) => logger.info(msg));

    for (const pack of packs) {
        try {
            const runner = new PolicyRunner({
                rulesPath: pack.name,
                outputMode: 'graph',
                queryTimeoutMs: pack.queryTimeoutMs ?? 5000,
            });
            const report = await runner.run();
            const result: AutoRunResult = {
                pack: pack.name,
                totalEvaluated: report.totalEvaluated,
                compliancePct: report.compliancePct,
                ok: true,
            };
            results.push(result);
            if (report.totalEvaluated > 0) {
                log(`${pack.name}: ${report.totalEvaluated} entities, ${report.compliancePct}% compliant`);
            }
        } catch (err) {
            logger.debug(`[PolicyAutoRun] ${pack.name} skipped: ${(err as Error).message}`);
            results.push({ pack: pack.name, totalEvaluated: 0, compliancePct: 0, ok: false });
        }
    }

    return results;
}

export function getPostIngestionStep() {
    return {
        title: 'Evaluating Governance Policies',
        run: async (_ctx: unknown, reporter: AutoRunReporter) => {
            await runPostIngestionPolicies(BUILTIN_PACKS, reporter);
        },
    };
}
