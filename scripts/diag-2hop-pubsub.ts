import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

// 1. Repos & services
const svcs = await run(`MATCH (s:Service) WHERE s.valid_to_commit IS NULL
  OPTIONAL MATCH (r:Repository)-[:CONTAINS]->(s)
  RETURN s.name AS svc, r.name AS repo ORDER BY repo, svc`, {});
console.log("=== Services (active) ===");
for (const r of svcs.records) console.log("  ", r.get("repo"), "→", r.get("svc"));

// 2. PUBLISHES_TO / LISTENS_TO grouped by source repo
const pub = await run(`MATCH (n)-[r:PUBLISHES_TO]->(ch:MessageChannel)
  WHERE r.valid_to_commit IS NULL AND ch.valid_to_commit IS NULL
  OPTIONAL MATCH (sf:SourceFile)-[:DECLARES*0..2]->(n)
  RETURN labels(n)[0] AS lbl, coalesce(n.repository, n.repo, sf.repository, '?') AS repo,
         ch.name AS ch, ch.channelKind AS kind, ch.discoverySource AS src, ch.id AS chId
  ORDER BY repo, ch`, {});
console.log("\n=== PUBLISHES_TO ===", pub.records.length);
for (const r of pub.records) console.log("  ", r.get("repo"), `[${r.get("lbl")}]`, "→", r.get("kind"), r.get("ch"), "src=", r.get("src"), "id=", r.get("chId"));

const lis = await run(`MATCH (n)-[r:LISTENS_TO]->(ch:MessageChannel)
  WHERE r.valid_to_commit IS NULL AND ch.valid_to_commit IS NULL
  OPTIONAL MATCH (sf:SourceFile)-[:DECLARES*0..2]->(n)
  RETURN labels(n)[0] AS lbl, coalesce(n.repository, n.repo, sf.repository, '?') AS repo,
         ch.name AS ch, ch.channelKind AS kind, ch.discoverySource AS src, ch.id AS chId
  ORDER BY repo, ch`, {});
console.log("\n=== LISTENS_TO ===", lis.records.length);
for (const r of lis.records) console.log("  ", r.get("repo"), `[${r.get("lbl")}]`, "→", r.get("kind"), r.get("ch"), "src=", r.get("src"), "id=", r.get("chId"));

// 3. Channels with BOTH publisher and listener (the 2-hop the user expects)
const both = await run(`MATCH (p)-[rp:PUBLISHES_TO]->(ch:MessageChannel)<-[rl:LISTENS_TO]-(l)
  WHERE rp.valid_to_commit IS NULL AND rl.valid_to_commit IS NULL AND ch.valid_to_commit IS NULL
  RETURN ch.name AS ch, ch.id AS id, count(DISTINCT p) AS pubs, count(DISTINCT l) AS lis`, {});
console.log("\n=== Channels with pub+listen (2-hop candidates) ===", both.records.length);
for (const r of both.records) console.log("  ", r.get("ch"), "pubs=", Number(r.get("pubs")), "lis=", Number(r.get("lis")), "id=", r.get("id"));

// 4. Name-overlap: channels with same/similar name but distinct nodes (weld misses)
const dup = await run(`MATCH (a:MessageChannel), (b:MessageChannel)
  WHERE a.valid_to_commit IS NULL AND b.valid_to_commit IS NULL AND a.id < b.id
    AND (a.name = b.name OR toLower(a.name) = toLower(b.name))
  RETURN a.name AS an, a.channelKind AS ak, a.discoverySource AS asrc, a.id AS aid,
         b.name AS bn, b.channelKind AS bk, b.discoverySource AS bsrc, b.id AS bid LIMIT 40`, {});
console.log("\n=== Same-name distinct channel nodes (weld misses) ===", dup.records.length);
for (const r of dup.records) console.log("  ", r.get("an"), `(${r.get("ak")}/${r.get("asrc")})`, r.get("aid"), " VS ", `(${r.get("bk")}/${r.get("bsrc")})`, r.get("bid"));

// 5. Channel inventory by discoverySource
const inv = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL
  RETURN ch.discoverySource AS src, ch.channelKind AS kind, count(ch) AS n ORDER BY src, kind`, {});
console.log("\n=== Channel inventory by discoverySource/kind ===");
for (const r of inv.records) console.log("  ", r.get("src"), "/", r.get("kind"), "=", Number(r.get("n")));

// 6. Brokers
const br = await run(`MATCH (b:MessageBroker) WHERE b.valid_to_commit IS NULL
  RETURN b.id AS id, b.provider AS p, b.host AS h, b.vhost AS v`, {});
console.log("\n=== Brokers ===", br.records.length);
for (const r of br.records) console.log("  ", r.get("p"), "host=", r.get("h"), "vhost=", r.get("v"), "id=", r.get("id"));

// 7. Service-level CONNECTS_TO / DEPENDS_ON between the two repos
const dep = await run(`MATCH (a:Service)-[r]->(b:Service)
  WHERE r.valid_to_commit IS NULL AND a.valid_to_commit IS NULL AND b.valid_to_commit IS NULL
  RETURN a.name AS a, type(r) AS t, b.name AS b LIMIT 50`, {});
console.log("\n=== Service→Service edges ===", dep.records.length);
for (const r of dep.records) console.log("  ", r.get("a"), `-[${r.get("t")}]->`, r.get("b"));

await closeNeo4j();
