import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

const review = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL AND ch.needsReview = true RETURN ch.name AS name, ch.channelKind AS kind, ch.scope AS scope, ch.brokerUrn AS bu, ch.source AS source, coalesce(ch.evidence_extractors, []) AS ext ORDER BY ch.name`, {});
console.log("NeedsReview channels:");
for (const r of review.records) console.log("  ", r.get("kind"), r.get("name"), "src=", r.get("source"), "broker=", r.get("bu"), "ext=", r.get("ext"));

console.log("\nROUTES_TO bindings (count):");
const bindings = await run(`MATCH ()-[r:ROUTES_TO]->() WHERE r.valid_to_commit IS NULL RETURN count(r) AS n`, {});
console.log("  Total active:", Number(bindings.records[0].get("n")));

console.log("\nBindings matching shop.order.*:");
const motorBindings = await run(`MATCH (e:MessageChannel)-[r:ROUTES_TO]->(q:MessageChannel) WHERE r.valid_to_commit IS NULL AND ('shop.order.save.ready' =~ r.patternRegex OR r.bindingKey = 'shop.order.save.ready') RETURN e.name AS exch, q.name AS queue, r.bindingKey AS bk, r.patternSyntax AS ps, r.patternRegex AS pr LIMIT 5`, {});
for (const r of motorBindings.records) console.log("  ", r.get("exch"), "→", r.get("queue"), "bind=", r.get("bk"), "syntax=", r.get("ps"));

console.log("\nBindings matching inventory.save:");
const salvBindings = await run(`MATCH (e:MessageChannel)-[r:ROUTES_TO]->(q:MessageChannel) WHERE r.valid_to_commit IS NULL AND ('inventory.save' =~ r.patternRegex OR r.bindingKey = 'inventory.save') RETURN e.name AS exch, q.name AS queue, r.bindingKey AS bk, r.patternSyntax AS ps LIMIT 5`, {});
for (const r of salvBindings.records) console.log("  ", r.get("exch"), "→", r.get("queue"), "bind=", r.get("bk"), "syntax=", r.get("ps"));

console.log("\nClass NotPurchasable channels:");
const np = await run(`MATCH (ch:MessageChannel) WHERE ch.name CONTAINS 'NotPurchasable' OR ch.name CONTAINS 'notPurchasable' RETURN ch.id AS id, ch.name AS name, ch.scope AS scope LIMIT 10`, {});
for (const r of np.records) console.log("  ", r.get("scope"), r.get("name"), "id=", r.get("id"));

await closeNeo4j();
