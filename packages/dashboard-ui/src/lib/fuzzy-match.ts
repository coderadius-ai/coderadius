/**
 * fuzzy-match — Non-contiguous subsequence matching engine
 *
 * IDE-style fuzzy text matching (VSCode / PHPStorm class search).
 * Query characters are matched left-to-right through the target —
 * they don't need to be adjacent. "ad" matches "acd" (a...d).
 *
 * When the query contains whitespace, each whitespace-separated token
 * is matched independently and all must hit.
 *
 * Scoring rewards:
 *   - Consecutive character runs (contiguous matches score higher)
 *   - Word-boundary starts (after _, -, ., /, :, or camelCase)
 *   - Prefix position (matching at the start of the target)
 *   - Tighter matches (shorter targets preferred)
 *
 * Pure functions — no React dependency in the core matcher.
 */

import { createElement } from 'react';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A matched character range [start, end) in the target string. */
export type MatchRange = [start: number, end: number];

export interface FuzzyMatchResult {
    /** Higher = better match. Always > 0 when matched. */
    score: number;
    /** Character ranges in the original target that matched. */
    ranges: MatchRange[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const WORD_BOUNDARY_CHARS = new Set(['_', '-', '.', '/', ':', ' ']);

// ─── Core Matcher ──────────────────────────────────────────────────────────────

/**
 * Match a query against a target string using non-contiguous subsequence.
 *
 * Each character of the query must appear in order in the target, but
 * not necessarily adjacent. When the query contains spaces, each
 * whitespace-separated token is matched independently.
 *
 * @example
 *   fuzzyMatch('ad', 'acd')        // → match (a...d)
 *   fuzzyMatch('filia', 'filiali_lead')  // → match (contiguous)
 *   fuzzyMatch('ana cont', 'anagrafica_contraente') // → match (two tokens)
 *   fuzzyMatch('xyz', 'anything')   // → null
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
    if (!query) return null;
    if (!target) return null;

    const queryLower = query.toLowerCase();
    const targetLower = target.toLowerCase();

    // Split query into tokens by whitespace
    const tokens = queryLower.split(/[\s]+/).filter(Boolean);
    if (tokens.length === 0) return null;

    const allRanges: MatchRange[] = [];
    let totalScore = 0;

    for (const token of tokens) {
        const result = subsequenceMatch(token, targetLower, target);
        if (!result) return null; // All tokens must match
        allRanges.push(...result.ranges);
        totalScore += result.score;
    }

    // Merge overlapping/adjacent ranges and sort
    const merged = mergeRanges(allRanges);

    // Normalize: shorter targets get a bonus (tighter matches preferred)
    const lengthPenalty = Math.max(0.3, 1 - (target.length - query.length) * 0.004);
    const finalScore = totalScore * lengthPenalty;

    return { score: finalScore, ranges: merged };
}

/**
 * Non-contiguous subsequence match for a single token.
 * Each character of the token must appear in order in the target.
 * Uses a greedy algorithm that prefers word-boundary and consecutive positions.
 */
function subsequenceMatch(
    token: string,
    targetLower: string,
    targetOriginal: string,
): { ranges: MatchRange[]; score: number } | null {
    if (token.length === 0) return null;
    if (token.length > targetLower.length) return null;

    // Fast path: try contiguous substring match first (scores highest)
    const contiguous = findBestContiguousMatch(token, targetLower, targetOriginal);
    if (contiguous) return contiguous;

    // Slow path: non-contiguous character-by-character subsequence
    const positions = findBestSubsequence(token, targetLower, targetOriginal);
    if (!positions) return null;

    // Build ranges (each matched char = [i, i+1))
    const ranges: MatchRange[] = positions.map(p => [p, p + 1] as MatchRange);

    // Score the match
    let score = 5; // Base score for non-contiguous (lower than contiguous)

    // Consecutive character bonus — runs of adjacent matches score higher
    let consecutiveRuns = 0;
    for (let i = 1; i < positions.length; i++) {
        if (positions[i] === positions[i - 1] + 1) {
            consecutiveRuns++;
        }
    }
    score += consecutiveRuns * 6;

    // Prefix bonus
    if (positions[0] === 0) score += 15;

    // Word-boundary bonus for first character
    if (positions[0] > 0 && isWordBoundary(positions[0], targetOriginal)) {
        score += 12;
    }

    // Token length bonus (longer matches are more meaningful)
    score += token.length * 2;

    return { ranges: mergeRanges(ranges), score };
}

/**
 * Greedy subsequence finder that prefers word-boundary and consecutive positions.
 * Returns the array of matched character indices, or null if no full match.
 */
function findBestSubsequence(
    token: string,
    targetLower: string,
    targetOriginal: string,
): number[] | null {
    // Try two strategies and pick the one with the best score:
    // 1. Greedy-first: match each char at the earliest position
    // 2. Boundary-preferred: prefer word boundary positions

    const greedy = greedySubsequence(token, targetLower, 0);
    const boundary = boundaryPreferredSubsequence(token, targetLower, targetOriginal);

    if (!greedy && !boundary) return null;
    if (!greedy) return boundary;
    if (!boundary) return greedy;

    // Pick the one with more consecutive runs (tighter match)
    const greedyConsec = countConsecutive(greedy);
    const boundaryConsec = countConsecutive(boundary);
    return boundaryConsec >= greedyConsec ? boundary : greedy;
}

/** Simple greedy: match each query char at its earliest possible position. */
function greedySubsequence(token: string, targetLower: string, startFrom: number): number[] | null {
    const positions: number[] = [];
    let ti = startFrom;
    for (const ch of token) {
        const idx = targetLower.indexOf(ch, ti);
        if (idx === -1) return null;
        positions.push(idx);
        ti = idx + 1;
    }
    return positions;
}

/** Boundary-preferred: when multiple positions are possible, prefer word boundaries. */
function boundaryPreferredSubsequence(
    token: string,
    targetLower: string,
    targetOriginal: string,
): number[] | null {
    const positions: number[] = [];
    let ti = 0;
    for (const ch of token) {
        // Find the earliest match
        const earliest = targetLower.indexOf(ch, ti);
        if (earliest === -1) return null;

        // Look for a word-boundary match within a reasonable window
        let best = earliest;
        const windowEnd = Math.min(targetLower.length, earliest + 12);
        for (let j = earliest + 1; j < windowEnd; j++) {
            if (targetLower[j] === ch && isWordBoundary(j, targetOriginal)) {
                best = j;
                break;
            }
        }

        // But prefer consecutive with previous if possible
        if (positions.length > 0 && positions[positions.length - 1] + 1 < windowEnd) {
            const consec = positions[positions.length - 1] + 1;
            if (targetLower[consec] === ch) {
                best = consec;
            }
        }

        positions.push(best);
        ti = best + 1;
    }
    return positions;
}

function isWordBoundary(idx: number, original: string): boolean {
    if (idx === 0) return true;
    if (WORD_BOUNDARY_CHARS.has(original[idx - 1])) return true;
    // camelCase boundary
    if (original[idx] >= 'A' && original[idx] <= 'Z' &&
        original[idx - 1] >= 'a' && original[idx - 1] <= 'z') return true;
    return false;
}

function countConsecutive(positions: number[]): number {
    let count = 0;
    for (let i = 1; i < positions.length; i++) {
        if (positions[i] === positions[i - 1] + 1) count++;
    }
    return count;
}

/**
 * Find the best contiguous substring match for a single token in the target.
 * Tries all occurrences and picks the one with the highest score.
 */
function findBestContiguousMatch(
    token: string,
    targetLower: string,
    targetOriginal: string,
): { ranges: MatchRange[]; score: number } | null {
    let bestScore = -1;
    let bestRange: MatchRange | null = null;
    let searchFrom = 0;

    while (searchFrom <= targetLower.length - token.length) {
        const idx = targetLower.indexOf(token, searchFrom);
        if (idx === -1) break;

        let score = 10; // Base score for contiguous match (higher than non-contiguous)

        // Prefix bonus
        if (idx === 0) score += 25;

        // Word-boundary bonus
        if (idx > 0 && isWordBoundary(idx, targetOriginal)) score += 20;

        // Longer token = stronger signal
        score += token.length * 3;

        if (score > bestScore) {
            bestScore = score;
            bestRange = [idx, idx + token.length];
        }

        searchFrom = idx + 1;
    }

    if (bestRange === null) return null;
    return { ranges: [bestRange], score: bestScore };
}

/**
 * Merge overlapping or adjacent ranges into a minimal sorted set.
 */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
    if (ranges.length <= 1) return ranges;

    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged: MatchRange[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        const curr = sorted[i];
        if (curr[0] <= last[1]) {
            // Overlapping or adjacent — extend
            last[1] = Math.max(last[1], curr[1]);
        } else {
            merged.push(curr);
        }
    }

    return merged;
}

// ─── React Highlight Helper ────────────────────────────────────────────────────

/**
 * Render text with matched ranges highlighted using `<mark>` elements.
 *
 * @param text    The original display text
 * @param ranges  Matched [start, end) ranges from fuzzyMatch()
 * @returns       React nodes with matched spans wrapped in <mark className="cr-fuzzy-hl">
 *
 * @example
 *   highlightMatches('anagrafica_contraente', [[0,3], [11,15]])
 *   // → [<mark>ana</mark>, 'grafica_', <mark>cont</mark>, 'raente']
 */
export function highlightMatches(
    text: string,
    ranges: MatchRange[] | undefined,
): React.ReactNode {
    if (!ranges || ranges.length === 0) return text;

    const parts: React.ReactNode[] = [];
    let cursor = 0;

    for (let i = 0; i < ranges.length; i++) {
        const [start, end] = ranges[i];

        // Clamp to text bounds
        const s = Math.max(0, Math.min(start, text.length));
        const e = Math.max(s, Math.min(end, text.length));

        // Text before this match
        if (cursor < s) {
            parts.push(text.slice(cursor, s));
        }

        // Highlighted match
        if (s < e) {
            parts.push(
                createElement('mark', { key: `hl-${i}`, className: 'cr-fuzzy-hl' }, text.slice(s, e)),
            );
        }

        cursor = e;
    }

    // Trailing text after last match
    if (cursor < text.length) {
        parts.push(text.slice(cursor));
    }

    return parts.length === 1 ? parts[0] : parts;
}
