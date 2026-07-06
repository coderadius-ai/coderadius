import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { ingestOpenAPI } from '../../../../src/ingestion/extractors/openapi-extractor.js';
import type { ResolvedRepo } from '../../../../src/graph/types.js';

// ── Mock the graph queries module ────────────────────────────────────────────
vi.mock('../../../../src/graph/mutations/api-contracts.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeAPIInterface: vi.fn(),
    linkServiceExposesAPI: vi.fn(),
    mergeAPIEndpoint: vi.fn(),
    getExistingEndpointIds: vi.fn().mockResolvedValue([]),
    deleteStaleAPINodes: vi.fn(),
}));
vi.mock('../../../../src/graph/mutations/merkle.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeSourceFile: vi.fn(),
    linkRepositoryContainsSourceFile: vi.fn(),
    linkSourceFileDefinesAPI: vi.fn(),
    linkServiceOwnsSourceFile: vi.fn(),
}));
vi.mock('../../../../src/graph/mutations/api-deployment.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeAPIDeployment: vi.fn().mockImplementation((input: { baseUrl: string }) =>
        Promise.resolve(`cr:apideployment:${input.baseUrl.toLowerCase()}`)
    ),
    getExistingAPIDeploymentIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../src/graph/mutations/data-contracts.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeEmergentSchema: vi.fn().mockResolvedValue({ schemaUrn: 'cr:schema:test', fieldUrns: [] }),
    linkApiEndpointHasRequestSchema: vi.fn(),
    linkApiEndpointHasResponseSchema: vi.fn(),
}));

// ── Mock the source-resolver (discoverSpecFiles) ─────────────────────────────
vi.mock('../../../../src/ingestion/core/source-resolver.js', () => ({
    discoverSpecFiles: vi.fn(),
}));

// ── Mock the AI embeddings module ───────────────────────────────────────────
vi.mock('../../../../src/ai/embeddings.js', () => ({
    generateEmbeddingsBatch: vi.fn().mockImplementation(async (texts: string[]) => {
        // Return a mock embedding array of [0.1, 0.2] for each input text
        return texts.map(() => [0.1, 0.2]);
    }),
    flushEmbeddingCache: vi.fn(),
}));

import { mergeAPIInterface, linkServiceExposesAPI, mergeAPIEndpoint, getExistingEndpointIds, deleteStaleAPINodes } from '../../../../src/graph/mutations/api-contracts.js';
import { mergeSourceFile, linkRepositoryContainsSourceFile, linkSourceFileDefinesAPI, linkServiceOwnsSourceFile } from '../../../../src/graph/mutations/merkle.js';
import { mergeAPIDeployment, getExistingAPIDeploymentIds } from '../../../../src/graph/mutations/api-deployment.js';
import { mergeEmergentSchema, linkApiEndpointHasRequestSchema, linkApiEndpointHasResponseSchema } from '../../../../src/graph/mutations/data-contracts.js';
import { discoverSpecFiles } from '../../../../src/ingestion/core/source-resolver.js';
import { buildUrn, getQualifiedRepoName } from '../../../../src/graph/urn.js';

const FIXTURES_OAS = path.resolve(__dirname, '../../../fixtures/oas');

const mockRepo: ResolvedRepo = {
    name: 'test-oas-repo',
    path: FIXTURES_OAS,
    origin: 'local',
    branch: 'main',
    commit: 'abc123',
};

const qualifiedRepoName = getQualifiedRepoName(mockRepo);

describe('OpenAPI Extractor — OAS Reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should delete stale endpoints that are no longer in the spec', async () => {
        // Setup: the spec has one endpoint (GET /s1/status)
        const specFile = path.join(FIXTURES_OAS, 's1/openapi.yaml');
        vi.mocked(discoverSpecFiles).mockResolvedValue([specFile]);

        // Simulate DB already has an old endpoint that no longer exists in spec
        const apiUrn = buildUrn('api', qualifiedRepoName, 'test-oas-repo', 's1/openapi.yaml');
        const freshEndpointUrn = buildUrn('endpoint', qualifiedRepoName, 's1/openapi.yaml', 'GET', '/s1/status');
        const staleEndpointUrn = buildUrn('endpoint', qualifiedRepoName, 's1/openapi.yaml', 'DELETE', '/s1/old-route');

        vi.mocked(getExistingEndpointIds).mockResolvedValue([
            freshEndpointUrn,
            staleEndpointUrn,
        ]);
        vi.mocked(getExistingAPIDeploymentIds).mockResolvedValue([]);

        const result = await ingestOpenAPI([mockRepo]);

        // Should have called delete with only the stale endpoint
        expect(deleteStaleAPINodes).toHaveBeenCalledWith([staleEndpointUrn]);
        expect(result.specsProcessed).toBe(1);
        expect(result.endpointsCreated).toBe(1);
    });

    it('should delete stale server URLs that are no longer in the spec', async () => {
        // Setup: the spec has one server (http://s1-service:8080)
        const specFile = path.join(FIXTURES_OAS, 's1/openapi.yaml');
        vi.mocked(discoverSpecFiles).mockResolvedValue([specFile]);

        // The fresh deployment URN is what mergeAPIDeployment returns (mock above).
        const freshDeploymentUrn = 'cr:apideployment:http://s1-service:8080';
        const staleDeploymentUrn = 'cr:apideployment:http://old-server:9090';

        vi.mocked(getExistingEndpointIds).mockResolvedValue([]);
        vi.mocked(getExistingAPIDeploymentIds).mockResolvedValue([
            freshDeploymentUrn,
            staleDeploymentUrn,
        ]);

        await ingestOpenAPI([mockRepo]);

        // Should have called delete with only the stale deployment URN
        expect(deleteStaleAPINodes).toHaveBeenCalledWith([staleDeploymentUrn]);
    });

    it('should not call delete when no stale nodes exist', async () => {
        const specFile = path.join(FIXTURES_OAS, 's1/openapi.yaml');
        vi.mocked(discoverSpecFiles).mockResolvedValue([specFile]);

        const apiUrn = buildUrn('api', qualifiedRepoName, 'test-oas-repo', 's1/openapi.yaml');
        const freshEndpointUrn = buildUrn('endpoint', qualifiedRepoName, 's1/openapi.yaml', 'GET', '/s1/status');
        const freshDeploymentUrn = 'cr:apideployment:http://s1-service:8080';

        // DB has exactly the same set as the spec
        vi.mocked(getExistingEndpointIds).mockResolvedValue([freshEndpointUrn]);
        vi.mocked(getExistingAPIDeploymentIds).mockResolvedValue([freshDeploymentUrn]);

        await ingestOpenAPI([mockRepo]);

        // deleteStaleAPINodes should NOT have been called
        expect(deleteStaleAPINodes).not.toHaveBeenCalled();
    });

    it('should reconcile endpoints and servers independently across two specs', async () => {
        // Both s1 and s2 specs
        const specFileS1 = path.join(FIXTURES_OAS, 's1/openapi.yaml');
        const specFileS2 = path.join(FIXTURES_OAS, 's2/openapi.yaml');
        vi.mocked(discoverSpecFiles).mockResolvedValue([specFileS1, specFileS2]);

        const apiUrnS1 = buildUrn('api', qualifiedRepoName, 'test-oas-repo', 's1/openapi.yaml');
        const apiUrnS2 = buildUrn('api', qualifiedRepoName, 'test-oas-repo', 's2/openapi.yaml');

        // S1 has a stale endpoint, S2 is clean
        vi.mocked(getExistingEndpointIds)
            .mockResolvedValueOnce([
                buildUrn('endpoint', qualifiedRepoName, 's1/openapi.yaml', 'GET', '/s1/status'),
                buildUrn('endpoint', qualifiedRepoName, 's1/openapi.yaml', 'POST', '/s1/old'),
            ])
            .mockResolvedValueOnce([
                buildUrn('endpoint', qualifiedRepoName, 's2/openapi.yaml', 'GET', '/s2/hello'),
            ]);

        vi.mocked(getExistingAPIDeploymentIds)
            .mockResolvedValue([]);

        await ingestOpenAPI([mockRepo]);

        // Only the stale S1 endpoint should be deleted, S2 untouched
        expect(deleteStaleAPINodes).toHaveBeenCalledTimes(1);
        expect(deleteStaleAPINodes).toHaveBeenCalledWith([
            buildUrn('endpoint', qualifiedRepoName, 's1/openapi.yaml', 'POST', '/s1/old'),
        ]);
    });
});
