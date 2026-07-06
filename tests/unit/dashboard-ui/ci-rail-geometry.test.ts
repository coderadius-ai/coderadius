import { describe, expect, it } from 'vitest';
import {
    buildRailGeometry,
    groupIntoRows,
    roundedPath,
    type RailChip,
    type RailRect,
} from '../../../packages/dashboard-ui/src/lib/ci-rail-geometry';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function rect(left: number, top: number, width = 60, height = 26): RailRect {
    return { left, top, width, height };
}

function chip(left: number, top: number, accent: string | null = null, width = 60): RailChip {
    return { rect: rect(left, top, width), accent };
}

/** Single wrapped layout used across tests: two chips on row 1, one on row 2. */
function wrappedChips(): RailChip[] {
    return [
        chip(34, 0, '#22d3ee'),   // row 1, cy = 13
        chip(112, 0, '#f59e0b'),  // row 1
        chip(34, 40, null),       // row 2, cy = 53
    ];
}

// ─── groupIntoRows ────────────────────────────────────────────────────────────

describe('groupIntoRows', () => {
    it('splits chips into rows by vertical position', () => {
        const rows = groupIntoRows(wrappedChips());
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveLength(2);
        expect(rows[1]).toHaveLength(1);
    });

    it('keeps chips with sub-tolerance jitter in the same row', () => {
        const rows = groupIntoRows([chip(0, 0), chip(70, 2)]);
        expect(rows).toHaveLength(1);
    });

    it('returns no rows for no chips', () => {
        expect(groupIntoRows([])).toHaveLength(0);
    });
});

// ─── roundedPath ──────────────────────────────────────────────────────────────

describe('roundedPath', () => {
    it('renders a straight two-point polyline without curve commands', () => {
        const d = roundedPath([[0, 10], [100, 10]], 6);
        expect(d).toBe('M 0 10 L 100 10');
    });

    it('rounds interior corners with quadratic curves', () => {
        const d = roundedPath([[0, 0], [50, 0], [50, 50]], 6);
        expect(d).toContain('Q 50 0');
        // The curve enters the corner 6px early and leaves 6px after.
        expect(d).toContain('L 44 0');
        expect(d).toContain('Q 50 0 50 6');
    });

    it('clamps the radius to half the shortest adjacent segment', () => {
        const d = roundedPath([[0, 0], [6, 0], [6, 50]], 6);
        expect(d).toContain('L 3 0');
        expect(d).toContain('Q 6 0 6 3');
    });
});

// ─── buildRailGeometry ────────────────────────────────────────────────────────

describe('buildRailGeometry', () => {
    it('draws a tinted segment between consecutive chips in the same row', () => {
        const { segments } = buildRailGeometry({ chips: wrappedChips() });
        expect(segments).toHaveLength(1);
        expect(segments[0]).toEqual({
            x1: 94,            // right edge of chip 1
            x2: 112,           // left edge of chip 2
            y: 13,             // vertical center of row 1
            from: '#22d3ee',
            to: '#f59e0b',
        });
    });

    it('draws a return path from the end of a row to the start of the next', () => {
        const { plumbing } = buildRailGeometry({ chips: wrappedChips() });
        expect(plumbing).toHaveLength(1);
        // Starts at the right edge of the last chip of row 1 (x=172, cy=13)...
        expect(plumbing[0]).toMatch(/^M 172 13 /);
        // ...and ends entering the first chip of row 2 from the left (x=34, cy=53).
        expect(plumbing[0]).toMatch(/L 34 53$/);
    });

    it('clamps the return extension to the container bounds', () => {
        const { plumbing } = buildRailGeometry({
            chips: wrappedChips(),
            bounds: { width: 176 },
            extension: 10,
        });
        // Extension would reach x=182; clamped inside width 176.
        expect(plumbing[0]).not.toContain('182');
    });

    it('draws an entry path from the trigger anchor into the first chip', () => {
        const { plumbing } = buildRailGeometry({
            chips: wrappedChips(),
            entryAnchor: { x: 26, bottom: -18 },
        });
        const entry = plumbing[0];
        // Drops from under the triggers row (x=26)...
        expect(entry).toMatch(/^M 26 -18 /);
        // ...and joins the rail at the first chip's left center.
        expect(entry).toMatch(/L 34 13$/);
    });

    it('produces no segments or plumbing for a single row without triggers', () => {
        const geometry = buildRailGeometry({ chips: [chip(34, 0), chip(112, 0)] });
        expect(geometry.plumbing).toHaveLength(0);
        expect(geometry.segments).toHaveLength(1);
        expect(geometry.segments[0].from).toBeNull();
    });

    it('returns empty geometry for no chips', () => {
        const geometry = buildRailGeometry({ chips: [], entryAnchor: { x: 26, bottom: 0 } });
        expect(geometry.segments).toHaveLength(0);
        expect(geometry.plumbing).toHaveLength(0);
    });
});
