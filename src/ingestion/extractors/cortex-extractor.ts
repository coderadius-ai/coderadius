/**
 * Cortex Catalog Extractor — Pure Discovery
 *
 * Parses cortex.yaml files (OpenAPI 3.0.0 with x-cortex-* extensions)
 * and returns DiscoveredComponent[].
 *
 * Does NOT write to the graph. The topology-resolver handles that.
 *
 * @see https://docs.cortex.io/docs/reference/basics/entities
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import { glob } from 'glob';
import { logger } from '../../utils/logger.js';
import type { DiscoveredComponent, AuxiliaryEntity } from '../topology-resolver.js';
import type { ProgressReporter } from '../core/progress.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Cortex YAML shape (subset we care about)
// ═══════════════════════════════════════════════════════════════════════════════

interface CortexInfo {
    title?: string;
    description?: string;
    'x-cortex-tag'?: string;
    'x-cortex-type'?: string;
    'x-cortex-owners'?: Array<{
        type?: string;
        name?: string;
        provider?: string;
    }>;
    'x-cortex-parents'?: Array<{ tag: string }>;
    'x-cortex-children'?: Array<{ tag: string }>;
    'x-cortex-dependencies'?: Array<{
        tag: string;
        method?: string;
        path?: string;
    }>;
    'x-cortex-custom-metadata'?: Record<string, unknown>;
}

interface CortexDocument {
    openapi?: string;
    info?: CortexInfo;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

export interface CortexDiscoveryResult {
    components: DiscoveredComponent[];
    auxiliaryEntities: AuxiliaryEntity[];
    entitiesProcessed: number;
    errors: string[];
}

/**
 * Discover components from Cortex cortex.yaml files.
 *
 * Returns raw discovered data — no graph writes, no topology decisions.
 */
export async function discoverCortexComponents(
    repoPaths: Array<{ name: string; path: string; org?: string }>,
    task?: ProgressReporter,
): Promise<CortexDiscoveryResult> {
    const components: DiscoveredComponent[] = [];
    const auxiliaryEntities: AuxiliaryEntity[] = [];
    const errors: string[] = [];
    let entitiesProcessed = 0;

    for (const repo of repoPaths) {
        const cortexFiles = await glob('**/cortex.yaml', {
            cwd: repo.path,
            absolute: true,
            ignore: ['**/node_modules/**', '**/vendor/**'],
        });

        if (cortexFiles.length === 0) continue;

        for (const cortexFile of cortexFiles) {
            try {
                const content = fs.readFileSync(cortexFile, 'utf-8');
                const doc = yaml.load(content) as CortexDocument | null;

                if (!doc?.info?.['x-cortex-tag']) {
                    logger.debug(`[Cortex] Skipping ${cortexFile}: missing x-cortex-tag`);
                    continue;
                }

                const info = doc.info;
                const tag = info['x-cortex-tag']!;
                const cortexType = info['x-cortex-type'] ?? 'service';

                entitiesProcessed++;

                // ── Owner resolution ─────────────────────────────────────
                const ownerEntry = info['x-cortex-owners']?.[0];
                const owner = ownerEntry?.name ?? undefined;

                // ── Parent/System resolution ─────────────────────────────
                // In Cortex, x-cortex-parents can reference a Domain, System,
                // or another Service. We treat the first parent as the System.
                // The graph writer should verify the parent node type exists.
                const parentTag = info['x-cortex-parents']?.[0]?.tag ?? undefined;

                // ── Dependencies ─────────────────────────────────────────
                const dependencies = (info['x-cortex-dependencies'] ?? []).map(d => d.tag);

                // ── Language from custom metadata ────────────────────────
                const customMeta = info['x-cortex-custom-metadata'] ?? {};
                const language = typeof customMeta.language === 'string'
                    ? customMeta.language.toLowerCase()
                    : undefined;

                const comp: DiscoveredComponent = {
                    name: tag,
                    title: info.title ?? undefined,
                    description: info.description ?? undefined,
                    owner,
                    system: parentTag,
                    dependsOn: dependencies,
                    type: cortexType,
                    language,
                    catalogFile: cortexFile,
                    source: 'cortex',
                };

                components.push(comp);
                if (task) task.report(`Discovered Cortex entity: ${tag} (${cortexType})`);

                // ── Create System auxiliary entity from parent if declared ─
                if (parentTag) {
                    auxiliaryEntities.push({
                        kind: 'System',
                        name: parentTag,
                        description: undefined,
                    });
                }

                // ── Create Team auxiliary entity from owner ──────────────
                if (owner) {
                    auxiliaryEntities.push({
                        kind: 'Team',
                        name: owner,
                    });
                }

            } catch (err) {
                const msg = `Error processing ${cortexFile}: ${(err as Error).message}`;
                if (task) task.report(`[Error] ${msg}`);
                errors.push(msg);
            }
        }
    }

    if (components.length > 0 && task) {
        task.report(`Cortex discovery complete: ${entitiesProcessed} entities, ${components.length} components.`);
    }

    return { components, auxiliaryEntities, entitiesProcessed, errors };
}
