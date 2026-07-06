// Cache backend factory.
// HTTP backend deferred — file backend covers v1 needs.

import { FileBackend } from './file-backend.js';
import type { SinkCacheBackend } from './types.js';

export type CacheBackendKind = 'file';

export function createCacheBackend(kind: CacheBackendKind = 'file'): SinkCacheBackend {
    if (kind === 'file') return new FileBackend();
    throw new Error(`Unsupported sink cache backend: ${kind}`);
}

export type { SinkCacheBackend, CacheEntry, BackendHealth } from './types.js';
export { computeCacheKey, computeModelFingerprint } from './types.js';
export { FileBackend } from './file-backend.js';
