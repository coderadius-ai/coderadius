import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

const r = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL AND ch.needsReview = true RETURN ch.name AS name, ch.source AS source, ch.discoverySource AS discoverySource, coalesce(ch.evidence_mergedFrom, []) AS mergedFrom ORDER BY ch.name`, {});
console.log("NeedsReview channels — source + discoverySource:");
for (const rec of r.records) console.log("  ", rec.get("name"), "source=", rec.get("source"), "discoverySource=", rec.get("discoverySource"), "mergedFrom=", rec.get("mergedFrom").length);
await closeNeo4j();
