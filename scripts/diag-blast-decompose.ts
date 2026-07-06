/**
 * Decompose a node's Downstream Gravity Score into its contributors. Read-only.
 *
 * Replicates the EXACT direction + weighting logic of `computeGravityScores`
 * (src/graph/queries/topology.ts) but, instead of summing to a single number,
 * it groups the Tier-1 downstream set by (nodeType, rel), reports each
 * contributor's degree + gravity contribution, and checks Tier-2 transitive
 * fan-out. Answers: "is this 0.99 driven by real consumers, or by low-degree
 * write-target resources that dead-end?"
 *
 * Usage:
 *   bun run scripts/diag-blast-decompose.ts --match <substring> [--type Service]
 */

import { getTopologyMap, gravityWeight } from '../src/graph/queries/topology.js';
import { closeNeo4j } from '../src/graph/neo4j.js';
import {
    EMISSION_DIRECTION_RELS as EMISSION_RELS,
    PASSTHROUGH_TYPES,
    IMPL_EP_DISCOUNT,
    normaliseToBar,
} from '@coderadius/shared-types';

function get(flag: string): string | undefined {
    const i = process.argv.findIndex(a => a === `--${flag}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

type Contrib = { urn: string; type: string; rel: string; deg: number; coeff: number; contrib: number };
type Nodes = Awaited<ReturnType<typeof getTopologyMap>>['nodes'];
type Edges = Awaited<ReturnType<typeof getTopologyMap>>['out'];

/** Engine-faithful Tier-1 downstream + Tier-2 transitive classification for one node. */
function classify(urn: string, nodes: Nodes, out: Edges, inMap: Edges, degree: Record<string, number>) {
    const seen = new Set<string>([urn]);
    const t1: Contrib[] = [];
    for (const e of (out[urn] ?? [])) {
        const t = nodes[e.target]; if (!t || t.type === 'Package') continue;
        if (EMISSION_RELS.has(e.rel) && !seen.has(e.target)) {
            seen.add(e.target);
            let coeff = 2.0;
            if (e.rel === 'IMPLEMENTS_ENDPOINT') {
                const hasConsumers = (inMap[e.target] ?? []).some(x => !EMISSION_RELS.has(x.rel) && x.source !== urn);
                if (!hasConsumers) coeff = IMPL_EP_DISCOUNT;
            }
            const deg = degree[e.target] ?? 0;
            t1.push({ urn: e.target, type: t.type, rel: e.rel, deg, coeff, contrib: coeff * gravityWeight(deg) });
        }
    }
    for (const e of (inMap[urn] ?? [])) {
        const s = nodes[e.source]; if (!s || s.type === 'Package') continue;
        if (!EMISSION_RELS.has(e.rel) && !seen.has(e.source)) {
            seen.add(e.source);
            const deg = degree[e.source] ?? 0;
            t1.push({ urn: e.source, type: s.type, rel: e.rel, deg, coeff: 2.0, contrib: 2.0 * gravityWeight(deg) });
        }
    }
    let t2count = 0, t2contrib = 0;
    for (const c of t1) {
        if (!PASSTHROUGH_TYPES.has(c.type)) continue;
        for (const e of (out[c.urn] ?? [])) {
            const t = nodes[e.target]; if (!t || t.type === 'Package') continue;
            if (EMISSION_RELS.has(e.rel) && !seen.has(e.target)) { seen.add(e.target); t2count++; t2contrib += 1.5 * gravityWeight(degree[e.target] ?? 0); }
        }
        for (const e of (inMap[c.urn] ?? [])) {
            const s = nodes[e.source]; if (!s || s.type === 'Package') continue;
            if (!EMISSION_RELS.has(e.rel) && !seen.has(e.source)) { seen.add(e.source); t2count++; t2contrib += 1.5 * gravityWeight(degree[e.source] ?? 0); }
        }
    }
    const consumerT1 = t1.filter(c => !PASSTHROUGH_TYPES.has(c.type)).length;
    const resourceT1 = t1.length - consumerT1;
    return { t1, t2count, t2contrib, consumerT1, resourceT1 };
}

async function scan(n: number, nodes: Nodes, out: Edges, inMap: Edges, degree: Record<string, number>) {
    // Tier histogram across the whole graph.
    const tier = (g: number) => g >= 100 ? 'T0 Seismic' : g >= 50 ? 'T1 Critical' : g >= 15 ? 'T2 High' : g >= 6 ? 'T3 Standard' : 'T4 Contained';
    const hist: Record<string, number> = {};
    for (const u of Object.keys(nodes)) hist[tier(nodes[u].gravityScore ?? 0)] = (hist[tier(nodes[u].gravityScore ?? 0)] ?? 0) + 1;
    console.log(`\n# TIER HISTOGRAM  (${Object.keys(nodes).length} nodes total)`);
    for (const t of ['T0 Seismic', 'T1 Critical', 'T2 High', 'T3 Standard', 'T4 Contained'])
        console.log(`#   ${t.padEnd(14)} ${String(hist[t] ?? 0).padStart(5)}`);

    const minG = Number(get('min')) || 1;
    const rows = Object.keys(nodes)
        .filter(u => (nodes[u].gravityScore ?? 0) >= minG)
        .map(u => {
            const c = classify(u, nodes, out, inMap, degree);
            const inDeg = inMap[u]?.length ?? 0;
            // "earned" is a STRICTER exploration lens than the production
            // `observed` gate: it additionally requires in-degree on the node
            // itself and consumer-type T1. `obs` is the engine-stamped gate
            // that drives the UI demotion to "T? Unverified".
            const earned = inDeg > 0 && c.t2count > 0 && c.consumerT1 > 0;
            const obs = nodes[u].gravityEvidence?.observed ?? false;
            return { u, g: nodes[u].gravityScore ?? 0, type: nodes[u].type, inDeg, outDeg: out[u]?.length ?? 0,
                     consumerT1: c.consumerT1, resourceT1: c.resourceT1, t2: c.t2count, earned, obs };
        })
        .sort((a, b) => b.g - a.g)
        .slice(0, n);

    console.log(`\n# TOP ${rows.length} BY gravityScore  (✓ = earned: in>0 AND transitive>0 AND consumer-dependents>0; obs = engine gravityEvidence.observed)\n`);
    console.log(`#  ${'✓'.padEnd(2)} ${'obs'.padEnd(4)} ${'G'.padStart(4)}  ${'type'.padEnd(15)} ${'in'.padStart(4)} ${'out'.padStart(4)} ${'cons'.padStart(5)} ${'res'.padStart(4)} ${'t2'.padStart(4)}  name`);
    for (const r of rows) {
        console.log(`   ${(r.earned ? '✓' : '·').padEnd(2)} ${(r.obs ? 'yes' : 'NO').padEnd(4)} ${String(r.g).padStart(4)}  ${r.type.padEnd(15)} ${String(r.inDeg).padStart(4)} ${String(r.outDeg).padStart(4)} ${String(r.consumerT1).padStart(5)} ${String(r.resourceT1).padStart(4)} ${String(r.t2).padStart(4)}  ${nodes[r.u].name}`);
    }
    const earnedCount = rows.filter(r => r.earned).length;
    const unverifiedCount = rows.filter(r => !r.obs).length;
    console.log(`\n# ${earnedCount}/${rows.length} of the top nodes have an EARNED high blast (real dependents + onward cascade).`);
    console.log(`# ${unverifiedCount}/${rows.length} render as "T? Unverified" in the UI (no observed dependent: write-footprint score only).`);
}

async function main() {
    const topo = await getTopologyMap();
    const { nodes, out, in: inMap } = topo;
    const degree: Record<string, number> = {};
    for (const u of Object.keys(nodes)) degree[u] = (out[u]?.length ?? 0) + (inMap[u]?.length ?? 0);

    const scanN = get('scan');
    if (scanN) { await scan(Number(scanN) || 25, nodes, out, inMap, degree); await closeNeo4j(); return; }

    const match = get('match');
    const typeFilter = get('type');
    if (!match) { console.error('Pass --match <substring> or --scan <N>'); process.exit(1); }

    const candidates = Object.keys(nodes).filter(u =>
        u.toLowerCase().includes(match.toLowerCase()) &&
        (!typeFilter || nodes[u].type === typeFilter));
    if (candidates.length === 0) { console.error(`No node matches "${match}"`); process.exit(1); }
    // Prefer a Service if several match.
    const urn = candidates.sort((a, b) =>
        (nodes[a].type === 'Service' ? -1 : 0) - (nodes[b].type === 'Service' ? -1 : 0))[0];
    const node = nodes[urn];

    console.log(`\n# NODE  ${node.name}  [${node.type}]`);
    console.log(`# urn         ${urn}`);
    console.log(`# team        ${node.teamOwner ?? '(none)'}`);
    console.log(`# degree      ${degree[urn]}  (out=${out[urn]?.length ?? 0}, in=${inMap[urn]?.length ?? 0})`);
    console.log(`# gravityScore ${node.gravityScore}   → bar ${normaliseToBar(node.gravityScore ?? 0).toFixed(2)}   observed=${node.gravityEvidence?.observed ?? 'n/a'}\n`);

    const { t1, t2count, t2contrib } = classify(urn, nodes, out, inMap, degree);

    // ── Group Tier-1 by (type, rel) ─────────────────────────────────────────
    const groups: Record<string, { n: number; contrib: number; deg1: number; degHi: number }> = {};
    for (const c of t1) {
        const k = `${c.type.padEnd(16)} ${c.rel}`;
        groups[k] ??= { n: 0, contrib: 0, deg1: 0, degHi: 0 };
        groups[k].n++; groups[k].contrib += c.contrib;
        if (c.deg <= 1) groups[k].deg1++; else groups[k].degHi++;
    }

    const t1total = t1.reduce((a, c) => a + c.contrib, 0);
    console.log(`# TIER-1 DOWNSTREAM  (${t1.length} nodes, Σcontrib ${t1total.toFixed(1)})`);
    console.log(`#   ${'type / rel'.padEnd(40)}  count   Σcontrib   deg=1   deg>1`);
    for (const [k, g] of Object.entries(groups).sort((a, b) => b[1].contrib - a[1].contrib))
        console.log(`    ${k.padEnd(40)}  ${String(g.n).padStart(4)}   ${g.contrib.toFixed(1).padStart(7)}   ${String(g.deg1).padStart(4)}   ${String(g.degHi).padStart(4)}`);

    const passthroughT1 = t1.filter(c => PASSTHROUGH_TYPES.has(c.type)).length;
    const consumerT1 = t1.filter(c => !PASSTHROUGH_TYPES.has(c.type)).length;
    console.log(`\n# SHAPE`);
    console.log(`#   consumer-type T1   ${consumerT1}   (Service/Function/Library = real dependents)`);
    console.log(`#   resource-type T1   ${passthroughT1}   (DataContainer/MessageChannel/Datastore/APIEndpoint = write/publish targets)`);
    console.log(`#   T1 with degree=1   ${t1.filter(c => c.deg <= 1).length} / ${t1.length}   (degree 1 = connected ONLY to this node, a leaf)`);
    console.log(`#   TIER-2 transitive  ${t2count}  (Σcontrib ${t2contrib.toFixed(1)})   ← onward cascade through resources`);
    console.log(`#   recomputed G       ${Math.round(t1total + t2contrib)}   (engine stored ${node.gravityScore})\n`);

    await closeNeo4j();
}

main().catch(e => { console.error(e); process.exit(1); });
