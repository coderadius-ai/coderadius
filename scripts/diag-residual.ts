import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

const brokers = await run(`MATCH (b:MessageBroker) WHERE b.valid_to_commit IS NULL RETURN b.id AS id, b.provider AS provider, b.host AS host, b.vhost AS vhost ORDER BY b.id`, {});
console.log("Brokers (active):");
for (const r of brokers.records) console.log("  ", r.get("provider"), "host=", r.get("host"), "vhost=", r.get("vhost"), "id=", r.get("id"));

const review = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL AND ch.needsReview = true RETURN ch.id AS id, ch.name AS name, ch.channelKind AS kind, ch.scope AS scope, ch.brokerUrn AS bu, ch.discoverySource AS src ORDER BY ch.name`, {});
console.log("\nNeedsReview channels:");
for (const r of review.records) console.log("  ", r.get("kind"), r.get("name"), "scope=", r.get("scope"), "brokerUrn=", r.get("bu"), "src=", r.get("src"));

const overlap = await run(`MATCH (n:MessageChannel) WHERE n.valid_to_commit IS NULL AND n.needsReview = true MATCH (m:MessageChannel) WHERE m.valid_to_commit IS NULL AND m.id <> n.id AND m.name = n.name RETURN n.name AS name, n.channelKind AS nKind, n.brokerUrn AS nBu, m.channelKind AS mKind, m.brokerUrn AS mBu, m.discoverySource AS mSrc LIMIT 30`, {});
console.log("\nName-overlap of needsReview with other channels:");
for (const r of overlap.records) console.log("  ", r.get("name"), "needsReview=", r.get("nKind"), "@", r.get("nBu"), "vs other=", r.get("mKind"), "@", r.get("mBu"), "src=", r.get("mSrc"));

await closeNeo4j();
