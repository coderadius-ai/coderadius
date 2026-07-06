import { run } from "../src/graph/mutations/_run.js";
import { closeNeo4j } from "../src/graph/neo4j.js";

console.log("Functions named sendNotification / inviaNotificationEmployees:");
const fns = await run(`MATCH (f:Function) WHERE f.valid_to_commit IS NULL AND (f.name = 'sendNotification' OR f.name = 'inviaNotificationEmployees' OR f.name CONTAINS 'NotificationEmployees') RETURN f.id AS id, f.name AS name LIMIT 10`, {});
for (const r of fns.records) console.log("  ", r.get("name"), "id=", r.get("id"));

console.log("\nChannels published by sendNotification:");
const pubBy = await run(`MATCH (f:Function {name: 'sendNotification'})-[r:PUBLISHES_TO]->(ch:MessageChannel) WHERE r.valid_to_commit IS NULL RETURN ch.name AS ch, ch.channelKind AS kind, ch.scope AS scope, r.routingKey AS rk LIMIT 10`, {});
for (const r of pubBy.records) console.log("  ", r.get("kind"), r.get("ch"), "(scope=", r.get("scope"), "routingKey=", r.get("rk"), ")");

console.log("\nDirect publishers of channel 'domain.orchestrator.notification.send':");
const directPub = await run(`MATCH (f:Function)-[r:PUBLISHES_TO]->(ch:MessageChannel {name: 'domain.orchestrator.notification.send'}) WHERE r.valid_to_commit IS NULL RETURN f.name AS fn, r.routingKey AS rk LIMIT 10`, {});
for (const r of directPub.records) console.log("  ", r.get("fn"), "routingKey=", r.get("rk"));

console.log("\nAny channel named 'inventory.save' or NotificationMessage:");
const any = await run(`MATCH (ch:MessageChannel) WHERE ch.valid_to_commit IS NULL AND (ch.name = 'inventory.save' OR ch.name = 'NotificationMessage' OR ch.name CONTAINS 'employees') RETURN ch.name AS name, ch.channelKind AS kind, ch.scope AS scope LIMIT 10`, {});
console.log("Rows:", any.records.length);
for (const r of any.records) console.log("  ", r.get("kind"), r.get("name"), "scope=", r.get("scope"));

console.log("\nFunction → channel edges with routing key 'inventory.save' or starting with 'employees':");
const rk = await run(`MATCH (f:Function)-[r:PUBLISHES_TO]->(ch:MessageChannel) WHERE r.valid_to_commit IS NULL AND (r.routingKey = 'inventory.save' OR r.routingKey STARTS WITH 'employees') RETURN f.name AS fn, ch.name AS ch, r.routingKey AS rk LIMIT 10`, {});
for (const r of rk.records) console.log("  ", r.get("fn"), "→", r.get("ch"), "rk=", r.get("rk"));

await closeNeo4j();
