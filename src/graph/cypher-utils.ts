/**
 * Shared Cypher utility functions for consistent querying across the graph.
 */

/**
 * Returns a Cypher CASE expression that resolves the team name for a Service or Repository.
 * Evaluates the formal Team node first (if present), then falls back to the Repository organization (org).
 * 
 * @param teamNodeAlias - The identifier for the Team node (e.g. 't')
 * @param repoNodeAlias - The identifier for the Repository node (e.g. 'r')
 * @param defaultToNull - If true, returns null when unresolved. If false, returns 'Unassigned'.
 */
export function teamFallbackExpr(teamNodeAlias: string, repoNodeAlias: string, defaultToNull: boolean = true): string {
    const fallback = defaultToNull ? 'null' : "'Unassigned'";
    return `CASE 
                WHEN ${teamNodeAlias} IS NOT NULL AND ${teamNodeAlias}.name IS NOT NULL THEN ${teamNodeAlias}.name 
                WHEN ${repoNodeAlias} IS NOT NULL AND ${repoNodeAlias}.org IS NOT NULL AND ${repoNodeAlias}.org <> 'unknown' THEN split(${repoNodeAlias}.org, '/')[0]
                ELSE ${fallback} 
            END`;
}

/**
 * Returns a Cypher CASE expression that resolves the team name when teams have been aggregated into a list.
 * 
 * @param teamListAlias - The identifier for the collected team names list (e.g. 'teamNames')
 * @param repoNodeAlias - The identifier for the Repository node (e.g. 'r')
 * @param defaultToNull - If true, returns null when unresolved. If false, returns 'Unassigned'.
 */
export function teamListFallbackExpr(teamListAlias: string, repoNodeAlias: string, defaultToNull: boolean = true): string {
    const fallback = defaultToNull ? 'null' : "'Unassigned'";
    return `CASE 
                WHEN size(${teamListAlias}) > 0 THEN ${teamListAlias}[0] 
                WHEN ${repoNodeAlias} IS NOT NULL AND ${repoNodeAlias}.org IS NOT NULL AND ${repoNodeAlias}.org <> 'unknown' THEN split(${repoNodeAlias}.org, '/')[0]
                ELSE ${fallback} 
            END`;
}
