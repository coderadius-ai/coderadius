import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

// 1. Full broker dumps (active + tombstoned) with provenance
const br = await run(`MATCH (b:MessageBroker)
  RETURN b.id AS id, b.provider AS provider, b.host AS host, b.vhost AS vhost,
         b.valid_to_commit AS tombstoned, b.source AS source, b.quality AS quality,
         b.evidence_extractors AS ext, b.discoverySource AS dsrc, properties(b) AS props`, {});
console.log("=== MessageBroker nodes (ALL, incl. tombstoned) ===", br.records.length);
for (const r of br.records) {
  console.log(JSON.stringify({
    id: r.get("id"), provider: r.get("provider"), host: r.get("host"), vhost: r.get("vhost"),
    tombstoned: r.get("tombstoned"), source: r.get("source"), ext: r.get("ext"),
  }));
}

// 2. Who CONNECTS_TO each broker (service-level bindings) + edge provenance
const conn = await run(`MATCH (s)-[r:CONNECTS_TO]->(b:MessageBroker)
  RETURN labels(s)[0] AS lbl, s.name AS name, b.id AS broker,
         r.valid_to_commit AS tomb, r.source AS rsource, r.evidence_extractors AS rext`, {});
console.log("\n=== CONNECTS_TO -> MessageBroker ===", conn.records.length);
for (const r of conn.records) console.log("  ", r.get("lbl"), r.get("name"), "->", r.get("broker"), "tomb=", r.get("tomb"), "ext=", r.get("rext"));

// 3. HOSTED_ON: how many channels per broker
const host = await run(`MATCH (ch:MessageChannel)-[r:HOSTED_ON]->(b:MessageBroker)
  WHERE r.valid_to_commit IS NULL AND ch.valid_to_commit IS NULL
  RETURN b.id AS broker, count(ch) AS n`, {});
console.log("\n=== HOSTED_ON channel counts per broker ===");
for (const r of host.records) console.log("  ", r.get("broker"), "=", Number(r.get("n")));

// 4. Any other node referencing broker URLs / amqp (Datastore? env-derived?)
const amqp = await run(`MATCH (n) WHERE n.valid_to_commit IS NULL AND
  (toLower(coalesce(n.connectionUrl,'')) CONTAINS 'amqp' OR toLower(coalesce(n.host,'')) CONTAINS 'rabbit'
   OR toLower(coalesce(n.name,'')) CONTAINS 'rabbit')
  RETURN labels(n) AS lbls, n.id AS id, n.name AS name, n.host AS host, n.connectionUrl AS url LIMIT 20`, {});
console.log("\n=== Nodes referencing amqp/rabbit ===", amqp.records.length);
for (const r of amqp.records) console.log("  ", r.get("lbls"), r.get("id"), "host=", r.get("host"), "url=", r.get("url"));

await closeNeo4j();
