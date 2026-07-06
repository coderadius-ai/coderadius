/**
 * Message channel welding by class-name bridge.
 *
 * After the file pipeline writes MessageChannel nodes, some channels may
 * still carry a CQRS class name (e.g. `ProductQuoteMessage`) instead of the
 * canonical routing key (`acme.inventory.quote.product.requested`), because:
 *   - The dispatch site was processed before the routing facts were indexed
 *     (pipeline ordering), or
 *   - The LLM emitted the class name as the channel name despite the infrDict
 *     hint.
 *
 * This pass redirects PUBLISHES_TO and LISTENS_TO edges from class-name
 * placeholder nodes to the canonical channel, using a precomputed registry
 * `Map<className, canonicalRoutingKey>` built from value facts.
 *
 * Vectorised: the entire registry ships as a single `$pairs` parameter and
 * is processed with `UNWIND` inside one Cypher transaction (Memgraph batch).
 * Per-className duplicates are intrinsically deduplicated by the `Map<,>`
 * datastructure on the caller side, avoiding row-vs-row edge conflicts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildMessageChannelUrn } from './data-contracts.js';
import { astGrounding, applyFallback } from '../grounding.js';
import { SymfonyMessengerPhpProvider } from '../../ingestion/core/config-value-providers/symfony-messenger-php.js';
import { loadRepoHints } from '../../config/repo-hints.js';

export interface MessagePublisherWeldResult {
    weldedEdges: number;
    tombstonedPlaceholders: number;
}

/**
 * Scan a repository's PHP files for message-class -> routing-key mappings and
 * build a registry. Cheap content-signature pre-check (a single regex) gates
 * the full AST parse so most PHP files are skipped without cost.
 *
 * Returns `Map<className, canonicalRoutingKey>` where className is the short
 * (bare) class name. Per-className duplicates are intrinsically deduplicated
 * by the Map; the LAST scanned value wins. Same-class-name collisions across
 * namespaces should be addressed by callers using FQCN-keyed lookups; this
 * registry is for the short-name placeholder bridge only.
 */
export function discoverMessageClassRegistry(repoRoots: ReadonlyArray<string>): Map<string, string> {
    const provider = new SymfonyMessengerPhpProvider();
    const registry = new Map<string, string>();
    const KEY_PREFIX = 'SymfonyMessenger.routing.';

    for (const repoRoot of repoRoots) {
        const phpFiles: string[] = [];
        const walk = (dir: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile() && entry.name.endsWith('.php')) phpFiles.push(full);
            }
        };
        walk(repoRoot);

        for (const absPath of phpFiles) {
            const stat = (() => { try { return fs.statSync(absPath); } catch { return null; } })();
            if (!stat || stat.size > 512 * 1024) continue;
            const content = (() => { try { return fs.readFileSync(absPath, 'utf-8'); } catch { return null; } })();
            if (!content) continue;
            const relativePath = path.relative(repoRoot, absPath);
            const facts = provider.extractValueFacts(content, {
                relativePath,
                repoRoot,
                repoName: path.basename(repoRoot),
            });
            for (const fact of facts) {
                if (!fact.key?.startsWith(KEY_PREFIX) || !fact.value) continue;
                const key = fact.key.slice(KEY_PREFIX.length);
                // Skip FQCN-keyed facts — the welder targets placeholder nodes
                // whose name is the SHORT class name (what the LLM emits at
                // dispatch sites). The FQCN facts coexist in ValueResolutionIndex
                // for namespace-disambiguated lookup paths.
                if (key.includes('\\')) continue;
                registry.set(key, fact.value);
            }
        }

        // Customer overrides from `coderadius.yaml.message_channels.class_routes`
        // applied AFTER the PHP scan so YAML wins on conflict (the user knows
        // the routing key better than any extractor heuristic).
        const hints = loadRepoHints(repoRoot);
        for (const entry of hints.message_channels.class_routes) {
            registry.set(entry.class, entry.routing_key);
        }
    }
    return registry;
}

/**
 * Class-name bridge welder. Redirects CQRS-class-named placeholder channels
 * (e.g. `ProductQuoteMessage`) to the canonical routing-key channel mined
 * from PHP messenger.yaml / AmqpConfig (`acme.inventory.quote.requested`).
 *
 * Ordering invariant: this welder MUST run as a post-processing pass, after
 * every per-file write that may populate the placeholder's `technology` /
 * `kindFamily` properties. The `coalesce(canonical.X, placeholder.X)` SET
 * statements below carry over the placeholder's tech only when canonical
 * doesn't already have it; if the welder runs BEFORE the placeholder has
 * been resolved, both nodes carry null technology and the survivor loses
 * the trace.
 *
 * Current call site: `code-ingestion.workflow.ts` → "Resolving Infrastructure"
 * stage, after "Analyzing Codebase" (the per-file pipeline that writes channel
 * tech via the provider + graph-writer combo). Do not move this earlier.
 */
export async function weldMessagePublishersByClass(
    registry: Map<string, string>,
    commitHash: string,
): Promise<MessagePublisherWeldResult> {
    if (registry.size === 0) {
        return { weldedEdges: 0, tombstonedPlaceholders: 0 };
    }

    const pairs = [...registry.entries()].map(([className, canonicalName]) => ({
        className,
        canonicalName,
        // Default to topic kind for the canonical URN — the YAML/PHP routing
        // configs we mine encode logical topics; if a publisher already wrote
        // the canonical as a queue/subscription, MERGE on the URN reuses that
        // node and the canonical kind is preserved.
        canonicalId: buildMessageChannelUrn(canonicalName, 'topic'),
    }));

    // Step 1: upsert canonical channels, copy distinguishing properties from
    // any placeholder of the same name (technology, kindFamily inferred earlier
    // in the pipeline must not be lost when the placeholder is tombstoned).
    // Grounding: ast/exact + 'class-name-bridge@v1' fallback marker.
    const bridgeProv = applyFallback(
        astGrounding('class-name-bridge@v1'),
        'class-name-bridge',
        'symfony-routing-lookup@v1',
    );
    await run(
        `UNWIND $pairs AS pair
         MATCH (placeholder:MessageChannel {name: pair.className})
         MERGE (canonical:MessageChannel {id: pair.canonicalId})
         ON CREATE SET canonical.name = pair.canonicalName,
                       canonical.channelKind = 'topic',
                       canonical.valid_from_commit = $commitHash,
                       canonical.valid_to_commit = null
         ON MATCH SET canonical.valid_to_commit = null
         // The class-name bridge is the Symfony Messenger weld: when neither the
         // placeholder nor an earlier write carries a technology, default to
         // 'symfony-messenger' so the canonical channel is never tech=null after
         // the welder runs (Section 6 visibility regression otherwise).
         SET canonical.technology  = coalesce(canonical.technology,
                                              placeholder.technology,
                                              'symfony-messenger'),
             canonical.kindFamily  = coalesce(canonical.kindFamily,  placeholder.kindFamily),
             canonical.scope       = coalesce(canonical.scope, 'logical')
         ${groundingWriteClause('canonical')}`,
        { pairs, commitHash, ...groundingParams(bridgeProv, commitHash) },
    );

    // Step 2: redirect PUBLISHES_TO edges from placeholder to canonical.
    const pubResult = await run(
        `UNWIND $pairs AS pair
         MATCH (placeholder:MessageChannel {name: pair.className})
         MATCH (canonical:MessageChannel {id: pair.canonicalId})
         MATCH (fn)-[r:PUBLISHES_TO]->(placeholder)
         MERGE (fn)-[newR:PUBLISHES_TO]->(canonical)
         ON CREATE SET newR.valid_from_commit = $commitHash, newR.valid_to_commit = null
         ON MATCH SET newR.valid_from_commit = coalesce(newR.valid_from_commit, $commitHash),
                      newR.valid_to_commit = null
         DELETE r
         RETURN count(r) AS welded`,
        { pairs, commitHash },
    );

    // Step 3: redirect LISTENS_TO edges (same shape).
    const lisResult = await run(
        `UNWIND $pairs AS pair
         MATCH (placeholder:MessageChannel {name: pair.className})
         MATCH (canonical:MessageChannel {id: pair.canonicalId})
         MATCH (fn)-[r:LISTENS_TO]->(placeholder)
         MERGE (fn)-[newR:LISTENS_TO]->(canonical)
         ON CREATE SET newR.valid_from_commit = $commitHash, newR.valid_to_commit = null
         ON MATCH SET newR.valid_from_commit = coalesce(newR.valid_from_commit, $commitHash),
                      newR.valid_to_commit = null
         DELETE r
         RETURN count(r) AS welded`,
        { pairs, commitHash },
    );

    // Step 4: tombstone placeholder nodes that have no remaining edges.
    const tombResult = await run(
        `UNWIND $pairs AS pair
         MATCH (placeholder:MessageChannel {name: pair.className})
         OPTIONAL MATCH (placeholder)-[any]-()
         WITH placeholder, count(any) AS edges
         WHERE edges = 0
         DETACH DELETE placeholder
         RETURN count(placeholder) AS tombstoned`,
        { pairs },
    );

    const weldedPub = Number(pubResult?.records[0]?.get('welded') ?? 0);
    const weldedLis = Number(lisResult?.records[0]?.get('welded') ?? 0);
    const tombstoned = Number(tombResult?.records[0]?.get('tombstoned') ?? 0);
    return {
        weldedEdges: weldedPub + weldedLis,
        tombstonedPlaceholders: tombstoned,
    };
}
