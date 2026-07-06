/**
 * Backstage Catalog Extractor — Pure Discovery
 *
 * Parses catalog-info.yaml files and returns DiscoveredComponent[] + AuxiliaryEntity[].
 * Does NOT write to the graph. The topology-resolver handles that.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { glob } from 'glob';
import { BackstageCatalogEntitySchema } from '../../graph/types.js';
import type { BackstageCatalogEntity } from '../../graph/types.js';
import { logger } from '../../utils/logger.js';
import { telemetryCollector } from '../../telemetry/index.js';
import type { DiscoveredComponent, AuxiliaryEntity } from '../topology-resolver.js';
import { normalizeDependencyRef } from '../topology-resolver.js';
import type { ProgressReporter } from '../core/progress.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

export interface BackstageDiscoveryResult {
    /** Discovered service/component entities */
    components: DiscoveredComponent[];
    /** System, Domain, Team entities */
    auxiliaryEntities: AuxiliaryEntity[];
    /** Total entities parsed (including skipped kinds) */
    entitiesProcessed: number;
    /** Parse errors encountered */
    errors: string[];
}

/**
 * Discover components from Backstage catalog-info.yaml files.
 *
 * Returns raw discovered data — no graph writes, no topology decisions.
 * The caller (workflow) applies topology and writes to the graph.
 */
export async function discoverBackstageComponents(
    repoPaths: Array<{ name: string; path: string; org?: string }>,
    task?: ProgressReporter,
): Promise<BackstageDiscoveryResult> {
    const components: DiscoveredComponent[] = [];
    const auxiliaryEntities: AuxiliaryEntity[] = [];
    const errors: string[] = [];
    let entitiesProcessed = 0;

    for (const repo of repoPaths) {
        const catalogFiles = await glob('**/{catalog-info,catalog,system,systems}.yaml', {
            cwd: repo.path,
            absolute: true,
            ignore: ['**/node_modules/**', '**/vendor/**'],
        });

        if (catalogFiles.length === 0) {
            if (task) task.report(`No catalog-info.yaml found in ${repo.name}`);
            continue;
        }

        // ── Parse all entities ───────────────────────────────────────────
        const parsedEntities: Array<{ entity: BackstageCatalogEntity; catalogFile: string }> = [];

        for (const catalogFile of catalogFiles) {
            try {
                const content = fs.readFileSync(catalogFile, 'utf-8');

                // Skip Scaffolder templates (Nunjucks/Jinja markers)
                if (content.includes('${{') || content.includes('{%') || content.includes('{{')) {
                    logger.debug(`[Backstage] Skipping Scaffolder template file: ${catalogFile}`);
                    continue;
                }

                const rawEntities = yaml.loadAll(content) as unknown[];

                for (const rawEntity of rawEntities) {
                    if (!rawEntity) continue;

                    const parseResult = BackstageCatalogEntitySchema.safeParse(rawEntity);
                    if (!parseResult.success) {
                        const msg = `Invalid entity in ${catalogFile}: ${parseResult.error.message}`;
                        if (task) task.report(`[Error] ${msg}`);
                        errors.push(msg);
                        telemetryCollector.incrementErrors();
                        continue;
                    }

                    parsedEntities.push({ entity: parseResult.data, catalogFile });
                }
            } catch (err) {
                const msg = `Error processing ${catalogFile}: ${(err as Error).message}`;
                if (task) task.report(`[Error] ${msg}`);
                errors.push(msg);
                telemetryCollector.incrementErrors();
            }
        }

        // ── Map entities to DiscoveredComponent / AuxiliaryEntity ────────
        for (const { entity, catalogFile } of parsedEntities) {
            entitiesProcessed++;

            switch (entity.kind) {
                case 'Component': {
                    const ns = entity.metadata.namespace ?? 'default';
                    const comp: DiscoveredComponent = {
                        name: entity.metadata.name,
                        description: entity.metadata.description ?? undefined,
                        owner: entity.spec?.owner ? normalizeDependencyRef(entity.spec.owner) : undefined,
                        system: entity.spec?.system ?? undefined,
                        dependsOn: (entity.spec?.dependsOn ?? []).map(normalizeDependencyRef),
                        type: entity.spec?.type ?? 'service',
                        language: inferLanguage(entity, repo.name),
                        catalogFile,
                        source: 'backstage',
                        links: entity.metadata.links?.map(l => ({
                            url: l.url,
                            title: l.title,
                            icon: l.icon,
                            type: l.type,
                        })),
                        catalogMeta: {
                            kind: entity.kind,
                            namespace: ns,
                            entityRef: `${entity.kind.toLowerCase()}:${ns}/${entity.metadata.name}`,
                            lifecycle: entity.spec?.lifecycle,
                            partOf: entity.spec?.partOf?.length
                                ? entity.spec.partOf.map(normalizeDependencyRef)
                                : undefined,
                            providesApis: (entity.spec?.providesApis ?? []).map(normalizeDependencyRef),
                            consumesApis: (entity.spec?.consumesApis ?? []).map(normalizeDependencyRef),
                            labels: entity.metadata.labels,
                            tags: entity.metadata.tags,
                            links: entity.metadata.links,
                            specJson: buildResidualSpecJson(entity.spec),
                        },
                    };
                    components.push(comp);
                    if (task) task.report(`Discovered Component: ${comp.name}`);
                    break;
                }

                case 'System':
                    auxiliaryEntities.push({
                        kind: 'System',
                        name: entity.metadata.name,
                        description: entity.metadata.description ?? undefined,
                        domain: entity.spec?.domain ?? undefined,
                    });
                    break;

                case 'Domain':
                    auxiliaryEntities.push({
                        kind: 'Domain',
                        name: entity.metadata.name,
                        description: entity.metadata.description ?? undefined,
                    });
                    break;

                case 'Group':
                    auxiliaryEntities.push({
                        kind: 'Team',
                        name: entity.metadata.name,
                    });
                    break;

                case 'Resource':
                    logger.debug(`[Backstage] Skipping Resource: ${entity.metadata.name} (discovered by code analysis)`);
                    break;

                default:
                    logger.debug(`[Backstage] Skipping kind: ${entity.kind}`);
            }
        }
    }

    if (task) task.report(`Backstage discovery complete: ${entitiesProcessed} entities, ${components.length} components.`);
    return { components, auxiliaryEntities, entitiesProcessed, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Infer the primary language of a component from its metadata or repo context.
 */
function inferLanguage(entity: BackstageCatalogEntity, repoName: string): string {
    const annotations = entity.metadata.annotations ?? {};
    if (annotations['coderadius.ai/language']) {
        return String(annotations['coderadius.ai/language']);
    }

    const name = entity.metadata.name.toLowerCase();
    if (name.includes('php') || repoName.toLowerCase().includes('php')) return 'php';
    if (name.includes('ts') || name.includes('node') || repoName.toLowerCase().includes('ts')) return 'typescript';

    return 'unknown';
}

const FIRST_CLASS_SPEC_KEYS = new Set([
    'type', 'lifecycle', 'owner', 'system', 'dependsOn', 'partOf',
    'providesApis', 'consumesApis',
]);

function buildResidualSpecJson(spec: BackstageCatalogEntity['spec']): string | undefined {
    if (!spec) return undefined;
    const residual: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec)) {
        if (!FIRST_CLASS_SPEC_KEYS.has(k) && v !== undefined) {
            residual[k] = v;
        }
    }
    if (Object.keys(residual).length === 0) return undefined;
    const json = JSON.stringify(residual);
    if (json.length > 4096) return JSON.stringify(residual).slice(0, 4096);
    return json;
}
