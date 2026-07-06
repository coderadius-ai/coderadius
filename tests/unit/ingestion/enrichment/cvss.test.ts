import { describe, expect, it } from 'vitest';
import { computeCvssV3BaseScore } from '../../../../src/ingestion/enrichment/cvss.js';

// Expected scores cross-checked against the FIRST CVSS v3.1 calculator.

describe('computeCvssV3BaseScore', () => {
    it.each([
        ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
        ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H', 8.8],
        ['CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H', 8.1],
        ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10.0],
        ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H', 9.9],
        ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5],
        ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', 5.3],
        ['CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ])('scores %s as %d', (vector, expected) => {
        expect(computeCvssV3BaseScore(vector)).toBe(expected);
    });

    it('returns 0 when there is no impact', () => {
        expect(computeCvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
    });

    it('returns null for malformed vectors', () => {
        expect(computeCvssV3BaseScore('not-a-vector')).toBeNull();
        expect(computeCvssV3BaseScore('CVSS:3.1/AV:N/AC:L')).toBeNull();
    });

    it('returns null for CVSS v4 vectors', () => {
        expect(computeCvssV3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull();
    });
});
