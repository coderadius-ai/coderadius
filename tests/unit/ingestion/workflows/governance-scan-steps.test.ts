import { describe, it, expect } from 'vitest';
import { getGovernanceScanSteps } from '../../../../src/ingestion/workflows/governance-scan.workflow.js';

describe('getGovernanceScanSteps', () => {
    it('always schedules vulnerability enrichment', () => {
        const titles = getGovernanceScanSteps({ sourcePaths: ['.'] }).map(s => s.title);
        expect(titles).toContain('Enriching Vulnerability Data');
    });
});
