import { describe, test, expect } from 'vitest';
import {
    sanitizeImageRef,
    isResolvableImageRef,
    deduplicateByUrn,
    inferScopeFromFilename,
    buildImageEntity,
} from '../../../src/ingestion/structural/plugins/container-image-utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeImageRef — TG-1: URN-safe image reference normalization
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeImageRef', () => {
    test('simple image:tag', () => {
        expect(sanitizeImageRef('postgres:15')).toEqual({ name: 'postgres', tag: '15' });
    });

    test('image without tag defaults to latest', () => {
        expect(sanitizeImageRef('nginx')).toEqual({ name: 'nginx', tag: 'latest' });
    });

    test('registry with port (myregistry.com:5000/app:v1)', () => {
        const ref = sanitizeImageRef('myregistry.com:5000/app:v1');
        expect(ref).toEqual({ name: 'myregistry.com:5000/app', tag: 'v1' });
    });

    test('registry with port but no tag', () => {
        const ref = sanitizeImageRef('myregistry.com:5000/app');
        expect(ref).toEqual({ name: 'myregistry.com:5000/app', tag: 'latest' });
    });

    test('@sha256: digest format', () => {
        const ref = sanitizeImageRef('nginx@sha256:abc123def');
        expect(ref).toEqual({ name: 'nginx', tag: 'sha256:abc123def' });
    });

    test('trims whitespace', () => {
        expect(sanitizeImageRef('  redis:7-alpine  ')).toEqual({ name: 'redis', tag: '7-alpine' });
    });

    test('trims newlines', () => {
        expect(sanitizeImageRef('node:20\n')).toEqual({ name: 'node', tag: '20' });
    });

    test('empty string returns null', () => {
        expect(sanitizeImageRef('')).toBeNull();
    });

    test('whitespace-only returns null', () => {
        expect(sanitizeImageRef('   ')).toBeNull();
    });

    test('complex registry path: gcr.io/my-project/my-app:sha-abc123', () => {
        const ref = sanitizeImageRef('gcr.io/my-project/my-app:sha-abc123');
        expect(ref).toEqual({ name: 'gcr.io/my-project/my-app', tag: 'sha-abc123' });
    });

    test('image with empty tag after colon defaults to latest', () => {
        const ref = sanitizeImageRef('node:');
        expect(ref).toEqual({ name: 'node', tag: 'latest' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isResolvableImageRef — TG-3: Fail-closed on dynamic variables
// ═══════════════════════════════════════════════════════════════════════════════

describe('isResolvableImageRef', () => {
    test('concrete image → true', () => {
        expect(isResolvableImageRef('postgres:15')).toBe(true);
    });

    test('shell variable $VAR → false', () => {
        expect(isResolvableImageRef('postgres:$POSTGRES_VERSION')).toBe(false);
    });

    test('shell variable ${VAR} → false', () => {
        expect(isResolvableImageRef('${REGISTRY}/app:${TAG}')).toBe(false);
    });

    test('Go template {{ .Values.x }} → false', () => {
        expect(isResolvableImageRef('{{ .Values.image.repository }}:{{ .Values.image.tag }}')).toBe(false);
    });

    test('CodeRadius placeholder __CR_VAL_x__ → false', () => {
        expect(isResolvableImageRef('__CR_VAL_image|repository__:__CR_VAL_image|tag__')).toBe(false);
    });

    test('GHA expression ${{ env.IMAGE }} → false', () => {
        expect(isResolvableImageRef('${{ env.IMAGE }}')).toBe(false);
    });

    test('Ruby ERB %{ } → false', () => {
        expect(isResolvableImageRef('postgres:%{version}')).toBe(false);
    });

    test('partial variable postgres:15-$SUFFIX → false', () => {
        expect(isResolvableImageRef('postgres:15-$SUFFIX')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// deduplicateByUrn — TG-2: Per-file dedup
// ═══════════════════════════════════════════════════════════════════════════════

describe('deduplicateByUrn', () => {
    test('removes duplicates, first occurrence wins', () => {
        const entities = [
            { id: 'cr:dockerimage:redis:7', labels: ['DockerImage'], properties: {}, relationshipType: 'USES_IMAGE' },
            { id: 'cr:dockerimage:redis:7', labels: ['DockerImage'], properties: {}, relationshipType: 'USES_IMAGE' },
            { id: 'cr:dockerimage:postgres:15', labels: ['DockerImage'], properties: {}, relationshipType: 'USES_IMAGE' },
        ];
        const result = deduplicateByUrn(entities);
        expect(result).toHaveLength(2);
        expect(result[0]!.id).toBe('cr:dockerimage:redis:7');
        expect(result[1]!.id).toBe('cr:dockerimage:postgres:15');
    });

    test('empty array returns empty', () => {
        expect(deduplicateByUrn([])).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// inferScopeFromFilename
// ═══════════════════════════════════════════════════════════════════════════════

describe('inferScopeFromFilename', () => {
    test('docker-compose.prod.yml → production', () => {
        expect(inferScopeFromFilename('docker-compose.prod.yml')).toBe('production');
    });

    test('docker-compose.production.yml → production', () => {
        expect(inferScopeFromFilename('docker-compose.production.yml')).toBe('production');
    });

    test('values-production.yaml → production', () => {
        expect(inferScopeFromFilename('charts/values-production.yaml')).toBe('production');
    });

    test('docker-compose.override.yml → development', () => {
        expect(inferScopeFromFilename('docker-compose.override.yml')).toBe('development');
    });

    test('docker-compose.dev.yml → development', () => {
        expect(inferScopeFromFilename('docker-compose.dev.yml')).toBe('development');
    });

    test('docker-compose.local.yml → development', () => {
        expect(inferScopeFromFilename('docker-compose.local.yml')).toBe('development');
    });

    test('docker-compose.staging.yml → staging', () => {
        expect(inferScopeFromFilename('docker-compose.staging.yml')).toBe('staging');
    });

    test('docker-compose.yml → unknown', () => {
        expect(inferScopeFromFilename('docker-compose.yml')).toBe('unknown');
    });

    test('values.yaml → unknown', () => {
        expect(inferScopeFromFilename('helm/values.yaml')).toBe('unknown');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildImageEntity — Integration of all guards
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildImageEntity', () => {
    test('builds correct entity for concrete image', () => {
        const entity = buildImageEntity('postgres:15', 'infrastructure', 'production', 'docker-compose.prod.yml', 'my-service');
        expect(entity).not.toBeNull();
        expect(entity!.id).toBe('cr:dockerimage:postgres:15');
        expect(entity!.labels).toEqual(['DockerImage']);
        expect(entity!.properties.name).toBe('postgres');
        expect(entity!.properties.tag).toBe('15');
        expect(entity!.relationshipType).toBe('USES_IMAGE');
        expect(entity!.relationshipProperties).toEqual({ context: 'infrastructure', scope: 'production' });
    });

    test('returns null for unresolvable image', () => {
        expect(buildImageEntity('$IMAGE', 'ci_runner', 'unknown', '.gitlab-ci.yml')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(buildImageEntity('', 'infrastructure', 'unknown', 'docker-compose.yml')).toBeNull();
    });

    test('image without tag gets latest', () => {
        const entity = buildImageEntity('ubuntu', 'ci_runner', 'unknown', '.gitlab-ci.yml');
        expect(entity!.properties.tag).toBe('latest');
    });
});
