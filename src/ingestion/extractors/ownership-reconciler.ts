import { getMemgraphSession } from '../../graph/neo4j.js';

export interface OwnershipDiscrepancy {
    type: 'orphan_service' | 'conflicting_ownership' | 'identity_drift';
    targetPathOrName: string;
    details: string;
}

/**
 * Calculates Levenshtein distance between two strings.
 */
function getLevenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(
                        matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1  // deletion
                    )
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Heuristics to detect if identity drift occurred:
 * - One is a substring of the other
 * - Levenshtein distance < 3
 * - Names match after stripping 'team-', 'squad-', 'guild-'
 */
export function countIdentityDrift(nameA: string, nameB: string): boolean {
    const a = nameA.toLowerCase();
    const b = nameB.toLowerCase();
    
    if (a === b) return false;

    if (a.includes(b) || b.includes(a)) return true;

    if (getLevenshteinDistance(a, b) < 3) return true;

    const stripPrefixes = (s: string) => s.replace(/^(team|squad|guild|tribe)-/, '');
    if (stripPrefixes(a) === stripPrefixes(b)) return true;

    return false;
}

export async function reconcileOwnership(): Promise<OwnershipDiscrepancy[]> {
    const session = getMemgraphSession();
    const discrepancies: OwnershipDiscrepancy[] = [];

    try {
        // 1. Find Orphan Services
        const orphanResult = await session.run(`
            MATCH (s:Service)
            WHERE NOT (:Team)-[:OWNS]->(s)
            RETURN s.name AS serviceName
        `);
        for (const record of orphanResult.records) {
            discrepancies.push({
                type: 'orphan_service',
                targetPathOrName: record.get('serviceName'),
                details: 'Service has no OWNS edge from any source.',
            });
        }

        // 2. Find Conflicting Ownership & Identity Drift
        const conflictResult = await session.run(`
            MATCH (t1:Team)-[r1:OWNS]->(s:Service)
            MATCH (t2:Team)-[r2:OWNS]->(s:Service)
            WHERE r1.source <> r2.source
            AND NOT (t1)-[:OWNS {source: r2.source}]->(s)
            RETURN s.name AS serviceName,
                   t1.name AS team1, r1.source AS source1,
                   t2.name AS team2, r2.source AS source2
        `);
        
        // Use a set to prevent duplicate conflict entries for A-B vs B-A
        const seenPairs = new Set<string>();

        for (const record of conflictResult.records) {
            const serviceName = record.get('serviceName');
            const team1 = record.get('team1');
            const source1 = record.get('source1');
            const team2 = record.get('team2');
            const source2 = record.get('source2');

            // Sorting names to have consistent set keys
            const key = [team1, team2].sort().join('-') + ':' + serviceName;
            if (seenPairs.has(key)) continue;
            seenPairs.add(key);

            if (countIdentityDrift(team1, team2)) {
                 discrepancies.push({
                     type: 'identity_drift',
                     targetPathOrName: serviceName,
                     details: `Potential identity drift detected: ${source1}: '${team1}', ${source2}: '${team2}'.`,
                 });
            } else {
                 discrepancies.push({
                     type: 'conflicting_ownership',
                     targetPathOrName: serviceName,
                     details: `Conflicting ownership claims: ${source1} claims '${team1}', ${source2} claims '${team2}'.`,
                 });
            }
        }
    } finally {
        await session.close();
    }

    return discrepancies;
}
