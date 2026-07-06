import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

const brokers = await run(`MATCH (b:MessageBroker) WHERE b.valid_to_commit IS NULL RETURN b.provider AS provider, b.host AS host, b.vhost AS vhost, b.id AS id ORDER BY b.id`, {});
console.log("Brokers (active):", brokers.records.length);
for (const r of brokers.records) console.log("  ", r.get("provider"), "host=", r.get("host"), "vhost=", r.get("vhost"));

const counts = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL RETURN ch.channelKind AS kind, ch.scope AS scope, count(ch) AS n ORDER BY n DESC`, {});
console.log("\nChannels per kind/scope:");
for (const r of counts.records) console.log("  ", r.get("kind"), "/", r.get("scope"), "=", Number(r.get("n")));

const allCh = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL RETURN ch.name AS name, ch.channelKind AS kind, ch.scope AS scope, ch.needsReview AS nr, ch.discoverySource AS src, ch.source AS source ORDER BY ch.name`, {});
console.log("\nAll active channels:", allCh.records.length);
for (const r of allCh.records) {
  const nr = r.get("nr");
  console.log("  ", nr === true ? "⚠" : "✓", r.get("kind"), r.get("name"), "(scope=", r.get("scope"), "src=", r.get("source"), r.get("src") ? ", config" : "", ")");
}

const pub = await run(`MATCH (f:Function)-[r:PUBLISHES_TO]->(c:MessageChannel) WHERE r.valid_to_commit IS NULL RETURN c.name AS chName, count(f) AS publishers ORDER BY publishers DESC LIMIT 20`, {});
console.log("\nTop publishers (Function → channel):");
for (const r of pub.records) console.log("  ", Number(r.get("publishers")), "→", r.get("chName"));

const listen = await run(`MATCH (f:Function)-[r:LISTENS_TO]->(c:MessageChannel) WHERE r.valid_to_commit IS NULL RETURN c.name AS chName, count(f) AS listeners ORDER BY listeners DESC LIMIT 20`, {});
console.log("\nTop listeners (Function → channel):");
for (const r of listen.records) console.log("  ", Number(r.get("listeners")), "→", r.get("chName"));

await closeNeo4j();
