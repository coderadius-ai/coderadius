import { describe, it, expect } from 'vitest';
import { selectBindTarget, type BindCandidate } from '../../../src/graph/mutations/c4.js';

describe('selectBindTarget', () => {
    it('returns null for empty candidates', () => {
        expect(selectBindTarget([])).toBeNull();
    });

    it('returns the unique candidate when only one exists', () => {
        const cands: BindCandidate[] = [
            { id: 'cr:service:org/api:checkout', matchedBy: 'name' },
        ];
        expect(selectBindTarget(cands)).toBe('cr:service:org/api:checkout');
    });

    it('prefers catalogName match over name match when both exist', () => {
        const cands: BindCandidate[] = [
            { id: 'cr:service:org/legacy:foo', matchedBy: 'catalogName' },
            { id: 'cr:service:org/other:foo', matchedBy: 'name' },
        ];
        expect(selectBindTarget(cands)).toBe('cr:service:org/legacy:foo');
    });

    it('returns null on ambiguity: 2+ candidates, none unique by catalogName', () => {
        const cands: BindCandidate[] = [
            { id: 'cr:service:org/a:foo', matchedBy: 'name' },
            { id: 'cr:service:org/b:foo', matchedBy: 'name' },
        ];
        expect(selectBindTarget(cands)).toBeNull();
    });

    it('returns null when 2+ candidates ALL match by catalogName', () => {
        const cands: BindCandidate[] = [
            { id: 'cr:service:org/a:foo', matchedBy: 'catalogName' },
            { id: 'cr:service:org/b:foo', matchedBy: 'catalogName' },
        ];
        expect(selectBindTarget(cands)).toBeNull();
    });
});
