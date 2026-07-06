import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";
const totals = await run(`MATCH (n) RETURN labels(n)[0] AS lbl, count(n) AS n ORDER BY n DESC LIMIT 15`, {});
console.log("Graph node counts:");
for (const r of totals.records) console.log("  ", r.get("lbl"), "=", Number(r.get("n")));
await closeNeo4j();
