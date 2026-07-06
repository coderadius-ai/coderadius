import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

const brokers = await run(`MATCH (b:MessageBroker) WHERE b.valid_to_commit IS NULL RETURN b.id AS id, b.provider AS provider, b.vhost AS vhost, b.host AS host ORDER BY b.id`, {});
console.log("Brokers:", brokers.records.length);
for (const r of brokers.records) console.log("  ", r.get("provider"), "host=", r.get("host"), "vhost=", r.get("vhost"), "id=", r.get("id"));

const counts = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL RETURN ch.channelKind AS kind, ch.scope AS scope, count(ch) AS n ORDER BY n DESC`, {});
console.log("\nChannels per kind/scope:");
for (const r of counts.records) console.log("  ", r.get("kind"), r.get("scope"), "=", Number(r.get("n")));

const speculative = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL AND ch.quality = 'speculative' RETURN ch.name AS name, ch.channelKind AS kind ORDER BY name LIMIT 12`, {});
console.log("\nFirst 12 speculative channels (sample of 278):");
for (const r of speculative.records) console.log("  ", r.get("kind"), r.get("name"));

const overlap = await run(`MATCH (topic:MessageChannel {channelKind: 'topic'}) WHERE topic.valid_to_commit IS NULL MATCH (other:MessageChannel) WHERE other.valid_to_commit IS NULL AND other.id <> topic.id AND other.name = topic.name RETURN topic.name AS name, collect(DISTINCT other.channelKind) AS otherKinds`, {});
console.log("\nName-overlap (topic from code vs other-kind channels):");
for (const r of overlap.records) console.log("  ", r.get("name"), "matches kinds:", r.get("otherKinds"));
await closeNeo4j();
