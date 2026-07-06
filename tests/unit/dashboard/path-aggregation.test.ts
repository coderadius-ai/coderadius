import { describe, it, expect } from 'vitest';
import { groupPaths } from '../../../packages/dashboard-ui/src/components/blast-radius/utils/path-aggregation';
import type { RelationshipPath } from '../../../packages/dashboard-ui/src/lib/topology';

// The drawer auto-selects groups[0] (BlastDrawer.tsx). The "direct" (1-hop)
// group is the least informative to land on — selecting an endpoint/via group
// reveals the functions+schema UI. getAllPaths emits 1-hop paths first, so the
// __direct__ group must be pushed LAST by groupPaths so groups[0] is a via.

const directPath: RelationshipPath = { rels: ['DEPENDS_ON'], relsReversed: [false] };
const viaPath: RelationshipPath = {
    rels: ['IMPLEMENTS_ENDPOINT', 'CALLS'],
    relsReversed: [false, true],
    via: { urn: 'cr:endpoint:acme/checkout:POST:/api/quote', node: { name: 'POST /api/quote', type: 'APIEndpoint' } },
};

describe('groupPaths — direct group ordering', () => {
    it('puts the __direct__ group last when a via group exists', () => {
        const groups = groupPaths([directPath, viaPath]); // getAllPaths order: direct first
        expect(groups).toHaveLength(2);
        expect(groups[groups.length - 1].key).toBe('__direct__');
        expect(groups[0].key).not.toBe('__direct__');
    });

    it('still returns the direct group when it is the only one', () => {
        const groups = groupPaths([directPath]);
        expect(groups).toHaveLength(1);
        expect(groups[0].key).toBe('__direct__');
    });
});
