import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractEphemeralTopology } from '../../../src/eval/ephemeral-extractor.js';
import { buildUrn } from '../../../src/graph/urn.js';
import { SymbolRegistry } from '../../../src/ingestion/core/symbol-registry.js';

describe('extractEphemeralTopology', () => {
    it('translates inbound PHP route chunks into IMPLEMENTS_ENDPOINT edges', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-eval-routes-'));
        const relPath = 'www/index.php';
        const filePath = path.join(repoRoot, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `<?php $app->post('/quote', C::class);`, 'utf-8');

        const result = await extractEphemeralTopology({
            repoRoot,
            repoName: 'unknown/acme-shop',
            changedFiles: [relPath],
            symbolRegistry: new SymbolRegistry(),
        });

        const snapshot = result.snapshots.get(relPath)!;
        const endpointUrn = buildUrn('endpoint', 'code', 'POST', '/quote');

        expect(snapshot.nodes).toContainEqual(expect.objectContaining({
            id: endpointUrn,
            type: 'APIEndpoint',
            name: 'POST /quote',
        }));
        expect(snapshot.edges).toContainEqual(expect.objectContaining({
            targetId: endpointUrn,
            targetName: 'POST /quote',
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
        }));
    });

    it('keeps only the synthetic ::__route_handler IMPLEMENTS_ENDPOINT when both route handler and a controller cover the same endpoint', async () => {
        // Both the synthetic ::__route_handler chunk (from route-extractor-php)
        // AND a real controller method can produce IMPLEMENTS_ENDPOINT for the
        // same (method, path) pair. Without symmetric pruning on the ephemeral
        // side, the diff vs a DB snapshot (which IS pruned) would emit a
        // phantom delta on every PR.
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-eval-routes-dual-'));
        const relPath = 'www/index.php';
        const filePath = path.join(repoRoot, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
            filePath,
            `<?php
$app->post('/quote', QuoteController::class . '::handle');

class QuoteController {
    public function handle($req) {
        // INBOUND controller — same endpoint as the route above
        return $req->getBody();
    }
}`,
            'utf-8',
        );

        const result = await extractEphemeralTopology({
            repoRoot,
            repoName: 'unknown/acme-shop',
            changedFiles: [relPath],
            symbolRegistry: new SymbolRegistry(),
        });

        const snapshot = result.snapshots.get(relPath)!;
        const implementsEdges = snapshot.edges.filter(e =>
            e.relType === 'IMPLEMENTS_ENDPOINT' && e.targetType === 'APIEndpoint',
        );

        // After pruning: at most one IMPLEMENTS_ENDPOINT survives, and if any
        // does, it must be the synthetic ::__route_handler one (controller
        // edges with the same method+path are pruned away).
        for (const edge of implementsEdges) {
            expect(edge.sourceName.endsWith('::__route_handler')).toBe(true);
        }
    });
});
