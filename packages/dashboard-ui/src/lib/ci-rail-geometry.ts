/**
 * ci-rail-geometry — pure layout math for the CI pipeline "metro rail".
 *
 * Stage chips are stations; this module computes the connecting rail:
 * tinted segments between chips in the same row, rounded return paths
 * where the row wraps, and the entry path that drops from the triggers
 * row into the first stage. Consumed by CiPipelineDiagram, unit-tested
 * in isolation (no DOM).
 */

export interface RailRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface RailChip {
    rect: RailRect;
    accent: string | null;
}

/** Straight tinted run between two stations on the same row. */
export interface RailSegment {
    x1: number;
    x2: number;
    y: number;
    from: string | null;
    to: string | null;
}

export interface RailGeometry {
    segments: RailSegment[];
    /** SVG path `d` strings for neutral plumbing: wrap returns and the trigger entry. */
    plumbing: string[];
}

export interface RailOptions {
    chips: RailChip[];
    /** Drop point under the triggers row; omitted when there are no triggers. */
    entryAnchor?: { x: number; bottom: number } | null;
    /** Container width; the wrap return is clamped inside it. */
    bounds?: { width: number };
    cornerRadius?: number;
    extension?: number;
}

const ROW_TOLERANCE = 4;

const round1 = (n: number): number => Math.round(n * 10) / 10;

const centerY = (r: RailRect): number => r.top + r.height / 2;
const rightOf = (r: RailRect): number => r.left + r.width;
const bottomOf = (r: RailRect): number => r.top + r.height;

/** Group chips (in DOM order) into visual rows by vertical center. */
export function groupIntoRows(chips: RailChip[], tolerance: number = ROW_TOLERANCE): RailChip[][] {
    const rows: RailChip[][] = [];
    for (const chip of chips) {
        const current = rows[rows.length - 1];
        const sameRow = current && Math.abs(centerY(chip.rect) - centerY(current[0].rect)) <= tolerance;
        if (sameRow) current.push(chip);
        else rows.push([chip]);
    }
    return rows;
}

/** Polyline with rounded interior corners (quadratic), radius clamped per corner. */
export function roundedPath(points: Array<[number, number]>, radius: number): string {
    if (points.length < 2) return '';
    const parts = [`M ${round1(points[0][0])} ${round1(points[0][1])}`];
    for (let i = 1; i < points.length - 1; i++) {
        parts.push(cornerCommands(points[i - 1], points[i], points[i + 1], radius));
    }
    const [lx, ly] = points[points.length - 1];
    parts.push(`L ${round1(lx)} ${round1(ly)}`);
    return parts.join(' ');
}

function cornerCommands(
    prev: [number, number],
    corner: [number, number],
    next: [number, number],
    radius: number,
): string {
    const [px, py] = prev;
    const [cx, cy] = corner;
    const [nx, ny] = next;
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const inX = cx - ((cx - px) / inLen) * r;
    const inY = cy - ((cy - py) / inLen) * r;
    const outX = cx + ((nx - cx) / outLen) * r;
    const outY = cy + ((ny - cy) / outLen) * r;
    return `L ${round1(inX)} ${round1(inY)} Q ${round1(cx)} ${round1(cy)} ${round1(outX)} ${round1(outY)}`;
}

export function buildRailGeometry(opts: RailOptions): RailGeometry {
    const { chips, entryAnchor, bounds, cornerRadius = 6, extension = 10 } = opts;
    if (chips.length === 0) return { segments: [], plumbing: [] };

    const rows = groupIntoRows(chips);
    const plumbing: string[] = [];

    if (entryAnchor) plumbing.push(entryPath(entryAnchor, rows[0][0], cornerRadius));
    for (let i = 1; i < rows.length; i++) {
        plumbing.push(returnPath(rows[i - 1], rows[i], { bounds, cornerRadius, extension }));
    }

    return { segments: rows.flatMap(rowSegments), plumbing };
}

function rowSegments(row: RailChip[]): RailSegment[] {
    const segments: RailSegment[] = [];
    for (let i = 1; i < row.length; i++) {
        const a = row[i - 1];
        const b = row[i];
        segments.push({
            x1: round1(rightOf(a.rect)),
            x2: round1(b.rect.left),
            y: round1((centerY(a.rect) + centerY(b.rect)) / 2),
            from: a.accent,
            to: b.accent,
        });
    }
    return segments;
}

function entryPath(anchor: { x: number; bottom: number }, first: RailChip, radius: number): string {
    const cy = centerY(first.rect);
    return roundedPath(
        [
            [anchor.x, anchor.bottom],
            [anchor.x, cy],
            [first.rect.left, cy],
        ],
        radius,
    );
}

function returnPath(
    rowA: RailChip[],
    rowB: RailChip[],
    opts: { bounds?: { width: number }; cornerRadius: number; extension: number },
): string {
    const last = rowA[rowA.length - 1].rect;
    const first = rowB[0].rect;
    const cyA = centerY(last);
    const cyB = centerY(first);
    const gapY = (Math.max(...rowA.map(c => bottomOf(c.rect))) + Math.min(...rowB.map(c => c.rect.top))) / 2;
    const outX = Math.min(rightOf(last) + opts.extension, opts.bounds ? opts.bounds.width - 1 : Infinity);
    const backX = Math.max(first.left - opts.extension, 1);
    return roundedPath(
        [
            [rightOf(last), cyA],
            [outX, cyA],
            [outX, gapY],
            [backX, gapY],
            [backX, cyB],
            [first.left, cyB],
        ],
        opts.cornerRadius,
    );
}
