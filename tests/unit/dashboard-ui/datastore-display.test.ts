import { describe, expect, it } from 'vitest';
import {
    datastoresOf,
    primaryDatastore,
    isAmbiguousDatastore,
    datastoreTooltip,
} from '../../../packages/dashboard-ui/src/components/blast-radius/lib/datastore-display';

const ds = (...names: string[]) => names.map(name => ({ name, host: null }));

describe('datastore-display helpers', () => {
    it('datastoresOf returns [] for a node with no datastore', () => {
        expect(datastoresOf({ datastore: null, needsReview: null })).toEqual([]);
        expect(datastoresOf({ datastore: undefined, needsReview: null })).toEqual([]);
    });

    it('primaryDatastore is the first STORED_IN store, or null', () => {
        expect(primaryDatastore({ datastore: ds('a', 'b'), needsReview: true })?.name).toBe('a');
        expect(primaryDatastore({ datastore: null, needsReview: null })).toBeNull();
    });

    it('isAmbiguousDatastore requires BOTH needsReview AND more than one store', () => {
        expect(isAmbiguousDatastore({ datastore: ds('a', 'b'), needsReview: true })).toBe(true);
        // single store, flagged → not ambiguous (nothing to disambiguate)
        expect(isAmbiguousDatastore({ datastore: ds('a'), needsReview: true })).toBe(false);
        // two stores but not flagged → not the conservative ambiguous bind
        expect(isAmbiguousDatastore({ datastore: ds('a', 'b'), needsReview: false })).toBe(false);
    });

    it('datastoreTooltip reads as a single store when there is one', () => {
        expect(datastoreTooltip({ datastore: [{ name: 'archive', host: 'db.internal' }], needsReview: null }))
            .toBe('Datastore: archive @ db.internal');
    });

    it('datastoreTooltip prefixes an ambiguity note and lists every candidate', () => {
        expect(datastoreTooltip({ datastore: ds('integration-hub', 'archive'), needsReview: true }))
            .toBe('Ambiguous bind, 2 candidate stores:\nintegration-hub\narchive');
    });

    it('datastoreTooltip lists multiple stores without the ambiguity note when not flagged', () => {
        expect(datastoreTooltip({ datastore: ds('a', 'b'), needsReview: false }))
            .toBe('Datastores (2):\na\nb');
    });
});
