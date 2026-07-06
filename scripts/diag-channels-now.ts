import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

const brokers = await run(`MATCH (b:MessageBroker) WHERE b.valid_to_commit IS NULL RETURN b.id AS id, b.provider AS provider, b.host AS host, b.vhost AS vhost ORDER BY b.id`, {});
console.log("Brokers (active):", brokers.records.length);
for (const r of brokers.records) console.log("  ", r.get("provider"), "host=", r.get("host"), "vhost=", r.get("vhost"), "id=", r.get("id"));

const counts = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL RETURN ch.channelKind AS kind, ch.scope AS scope, count(ch) AS n ORDER BY n DESC`, {});
console.log("\nChannels per kind+scope:");
for (const r of counts.records) console.log("  ", r.get("kind"), "/", r.get("scope"), "=", Number(r.get("n")));

const needsReview = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL AND ch.needsReview = true RETURN ch.name AS name, ch.channelKind AS kind, ch.scope AS scope, ch.brokerUrn AS bu, ch.discoverySource AS src, ch.source AS source, coalesce(ch.evidence_extractors, []) AS ext ORDER BY ch.name`, {});
console.log("\nNeedsReview channels:", needsReview.records.length);
for (const r of needsReview.records) console.log("  ", r.get("kind"), r.get("name"), "src=", r.get("src"), "source=", r.get("source"), "broker=", r.get("bu"), "ext=", r.get("ext"));

const overlap = await run(`MATCH (n:MessageChannel) WHERE n.valid_to_commit IS NULL AND n.needsReview = true MATCH (m:MessageChannel) WHERE m.valid_to_commit IS NULL AND m.id <> n.id AND m.name = n.name RETURN n.name AS name, n.channelKind AS nKind, n.brokerUrn AS nBu, m.channelKind AS mKind, m.brokerUrn AS mBu, m.discoverySource AS mSrc LIMIT 30`, {});
console.log("\nName-overlap of needsReview:");
for (const r of overlap.records) console.log("  ", r.get("name"), "needsReview=", r.get("nKind"), "@", r.get("nBu"), "vs other=", r.get("mKind"), "@", r.get("mBu"), "src=", r.get("mSrc"));

const composite = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL AND ch.source = 'composite' RETURN ch.name AS name, ch.channelKind AS kind, ch.scope AS scope, ch.discoverySource AS src, ch.needsReview AS nr, ch.brokerUrn AS bu ORDER BY ch.name LIMIT 30`, {});
console.log("\nComposite-source channels (post cross-kind merge):", composite.records.length);
for (const r of composite.records) console.log("  ", r.get("kind"), r.get("name"), "src=", r.get("src"), "needsReview=", r.get("nr"), "broker=", r.get("bu"));

const routes = await run(`MATCH (a:MessageChannel)-[r:ROUTES_TO]->(b:MessageChannel) WHERE r.valid_to_commit IS NULL RETURN count(r) AS n`, {});
console.log("\nROUTES_TO edges active:", Number(routes.records[0].get("n")));

const carriedBy = await run(`MATCH (ds:DataStructure)-[r:CARRIED_BY]->(ch:MessageChannel) WHERE r.valid_to_commit IS NULL RETURN count(r) AS n`, {});
console.log("CARRIED_BY edges (DataStructure→MessageChannel) active:", Number(carriedBy.records[0].get("n")));

const pubListen = await run(`MATCH (f:Function)-[r:PUBLISHES_TO|LISTENS_TO]->(ch:MessageChannel) WHERE r.valid_to_commit IS NULL RETURN type(r) AS rType, count(r) AS n`, {});
console.log("\nFunction edges to channels:");
for (const r of pubListen.records) console.log("  ", r.get("rType"), "=", Number(r.get("n")));

await closeNeo4j();
