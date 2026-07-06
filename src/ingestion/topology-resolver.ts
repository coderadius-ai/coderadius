/**
 * Topology Resolver — Catalog-Agnostic Service Identity
 *
 * This module decouples TWO orthogonal concerns:
 *   1. Catalog Source: WHERE services are discovered (Backstage, Cortex, autodiscovery)
 *   2. Repository Topology: HOW discovered components map to graph nodes
 *
 * Additionally, it performs Identity Welding — merging catalog metadata
 * with autodiscovery technical identity by path overlap.
 *
 * Every extractor (Backstage, Cortex, auto) produces DiscoveredComponent[].
 * This module welds, collapses, and writes them to the graph.
 *
 * The workflow is the single graph writer — extractors never touch the graph.
 */
import path from 'node:path';
import { linkCatalogEntityToRepository, linkCatalogEntityToService, linkServiceDependsOnService, linkServiceDependsOnUnresolved, linkServiceHasLink, linkSystemContainsService, linkSystemPartOfDomain, linkTeamOwnsService, mergeCatalogEntity, mergeDomain, mergeLink, mergeService, mergeSystem, mergeTeam } from '../graph/mutations/c4.js';
import { linkLibraryStoredIn, linkServiceStoredIn, mergeLibrary } from '../graph/mutations/code-graph.js';
import { linkServiceDeployedAs, linkSystemContainsDeploymentUnit, mergeDeploymentUnit } from '../graph/mutations/deployment.js';
import { getQualifiedRepoName } from '../graph/urn.js';
import { astGrounding, declaredGrounding } from '../graph/grounding.js';
import { logger } from '../utils/logger.js';
import { loadRepoHints, getTopology, getComponentRoleOverride, type RepoHints } from '../config/repo-hints.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A service/component discovered by ANY catalog source.
 * This is the universal exchange format between extractors and the topology resolver.
 */
export interface CatalogMetadata {
    kind: string;
    namespace: string;
    entityRef: string;
    lifecycle?: string;
    /** Normalized refs of the entities this one declares containment in (spec.partOf) */
    partOf?: string[];
    providesApis?: string[];
    consumesApis?: string[];
    labels?: Record<string, string>;
    tags?: string[];
    links?: Array<{ url: string; title?: string; icon?: string; type?: string }>;
    specJson?: string;
}

export interface DiscoveredComponent {
    /** The "useful" name — used as URN segment and display name */
    name: string;
    /** Original name from the catalog source (preserved for traceability) */
    catalogName?: string;
    /** Which catalog source provided the metadata ('backstage' | 'cortex') */
    catalogSource?: 'backstage' | 'cortex';
    /** Human-readable display name (Cortex: info.title) */
    title?: string;
    /** Component description */
    description?: string;
    /** Normalized team/owner name (stripped of kind/namespace prefixes) */
    owner?: string;
    /** Parent system or domain name */
    system?: string;
    /** Raw dependency references (already normalized — no `component:` prefix) */
    dependsOn?: string[];
    /** Component type (service, library, resource) */
    type?: string;
    /** Detected or declared language */
    language?: string;
    /** Source file path (catalog-info.yaml, cortex.yaml, or manifest dir) */
    catalogFile: string;
    /** Which extractor discovered this component */
    source: 'backstage' | 'cortex' | 'autodiscovery' | 'autodiscovery-synthetic' | 'manual';
    /** Free-form links declared in catalog metadata.links[] */
    links?: Array<{ url: string; title?: string; icon?: string; type?: string }>;
    /** Enriched catalog metadata for CatalogEntity declared truth layer */
    catalogMeta?: CatalogMetadata;
}

/**
 * Result of applying topology to a set of discovered components.
 */
export interface TopologyResult {
    /** Primary services to create (1 for monolith, N for monorepo) */
    services: ServiceEntry[];
    /**
     * Workspaces classified as libraries (catalog `type: 'library'` OR plugin
     * signals that all failed). Persisted as `:Library` nodes, NOT `:Service`.
     */
    libraries?: LibraryEntry[];
    /**
     * Workspaces with no decisive classification: no catalog `type` and the
     * plugin has no `runtimeServiceSignals` (or no plugin for the detected
     * language). Persisted as `:Library` with `needsReview=true`.
     */
    pendingTriage?: DiscoveredComponent[];
    /** Non-Component entities (System, Domain, Team) to upsert */
    auxiliaryEntities: AuxiliaryEntity[];
    /** Paths claimed by catalog sources (autodiscovery should skip these) */
    claimedPaths: string[];
    /** The topology that was actually applied (useful when input was 'auto') */
    effectiveTopology: 'monolith' | 'monorepo';
    /** ALL raw catalog entities discovered (for pure observability) */
    catalogEntities?: DiscoveredComponent[];
}

export interface ServiceEntry {
    component: DiscoveredComponent;
    /** DeploymentUnits attached to this service (non-empty only in monolith mode) */
    deploymentUnits: DiscoveredComponent[];
    /** Dependencies classified as intra-repo packages */
    internalDeps: string[];
    /** Dependencies classified as external service stubs */
    externalDeps: string[];
}

export interface LibraryEntry {
    component: DiscoveredComponent;
}

export interface AuxiliaryEntity {
    kind: 'System' | 'Domain' | 'Team';
    name: string;
    description?: string;
    /** For System: the parent domain name */
    domain?: string;
}

/**
 * Result of identity welding — separates code-backed components from
 * catalog-only components that had no autodiscovery match.
 */
export interface WeldResult {
    /** Components that will become Service nodes (code-backed) */
    components: DiscoveredComponent[];
    /** All original catalog components */
    allCatalogComponents: DiscoveredComponent[];
    /** Catalog components that had no code match (for observability, NOT Service nodes) */
    unmatchedCatalogComponents: DiscoveredComponent[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dependency Normalization
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the on-disk service-root **directory** for a component.
 *
 * `catalogFile` carries different shapes depending on the source:
 *   - autodiscovery → already a directory (e.g. `/repo/order-service`)
 *   - backstage    → `/repo/order-service/catalog-info.yaml`
 *   - cortex       → `/repo/order-service/cortex.yaml`
 *
 * Downstream extractors (OpenAPI, structural, schema) need the directory
 * so they can scan files starting from the service root.
 */
export function getServiceRootDir(catalogFile: string): string {
    if (/\.(ya?ml)$/i.test(catalogFile)) {
        return path.dirname(catalogFile);
    }
    return catalogFile;
}

/**
 * Normalize a dependency reference to a bare name.
 *
 * Handles both Backstage format (`component:default/loyalty-service`)
 * and Cortex format (`loyalty-service`, already bare).
 */
export function normalizeDependencyRef(rawRef: string): string {
    let normalized = rawRef;

    // Strip kind prefix: "component:default/name" → "default/name"
    const colonIdx = normalized.indexOf(':');
    if (colonIdx !== -1) {
        normalized = normalized.substring(colonIdx + 1);
    }

    // Strip namespace prefix: "default/name" → "name"
    const slashIdx = normalized.indexOf('/');
    if (slashIdx !== -1) {
        normalized = normalized.substring(slashIdx + 1);
    }

    return normalized.trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Primary Component Selection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Select the primary component from a set.
 *
 * Priority:
 *   1. Name matches repo name
 *   2. type === 'service' preferred over 'library'
 *   3. Shallowest catalog file path (closest to root)
 *   4. Alphabetical tie-breaker for determinism
 */
export function selectPrimaryComponent(
    components: DiscoveredComponent[],
    repoName: string,
): DiscoveredComponent {
    const nameMatch = components.find(c => c.name === repoName);
    if (nameMatch) return nameMatch;

    const sorted = [...components].sort((a, b) => {
        // Prefer type: 'service' over 'library' or other types
        const typeA = a.type === 'service' ? 0 : 1;
        const typeB = b.type === 'service' ? 0 : 1;
        if (typeA !== typeB) return typeA - typeB;

        const depthDiff = a.catalogFile.split(path.sep).length - b.catalogFile.split(path.sep).length;
        if (depthDiff !== 0) return depthDiff;
        return a.name.localeCompare(b.name);
    });
    return sorted[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Catalog Source Resolution
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine which catalog source wins for a repo when both exist.
 *
 * Rule: per-repo exclusive. If Cortex files exist, ignore Backstage entirely
 * for that repo (mixing is almost always a half-finished migration).
 * Autodiscovery always runs as fallback for unclaimed paths.
 */
export function resolveCatalogPriority(
    hasBackstage: boolean,
    hasCortex: boolean,
): 'backstage' | 'cortex' | 'autodiscovery' {
    if (hasCortex) return 'cortex';
    if (hasBackstage) return 'backstage';
    return 'autodiscovery';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Identity Welding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Directory names that should never be used as a service identity.
 * When matched, the name falls back to the repo name.
 */
const GENERIC_DIR_NAMES = new Set([
    'src', 'app', 'backend', 'frontend', 'main', 'server', 'client',
    'lib', 'core', 'common', 'shared', 'pkg', 'cmd', 'internal',
    'web', 'service', 'services', 'application',
]);

/**
 * Derive the "useful" name from an autodiscovery path.
 *
 * Strategy (walks UP the directory tree):
 *   1. If the path IS the repo root → use repo name
 *   2. Check the basename — if it's a real name, use it
 *   3. If it's generic (src, app, etc.) → walk up to the parent
 *   4. Repeat until a non-generic name is found
 *   5. If ALL segments are generic → fall back to repo name
 *
 * This prevents name collisions in multi-service repos like:
 *   /repo/order-service/src → "order-service" (not "my-repo")
 *   /repo/payment-service/src → "payment-service" (not "my-repo")
 */
export function deriveUsefulName(autoPath: string, repoPath: string, repoName: string): string {
    const normalized = autoPath.replace(/\\/g, '/');
    const normalizedRepo = repoPath.replace(/\\/g, '/');

    // Path is the repo root itself
    if (normalized === normalizedRepo || normalized === normalizedRepo + '/') {
        return repoName;
    }

    // Walk UP the directory tree looking for a non-generic name
    let currentDir = normalized;
    while (currentDir.length > normalizedRepo.length) {
        const basename = path.basename(currentDir);
        if (!GENERIC_DIR_NAMES.has(basename.toLowerCase())) {
            return basename;
        }
        currentDir = path.dirname(currentDir).replace(/\\/g, '/');
    }

    // All path segments were generic (e.g. /repo/src/app) → repo name
    return repoName;
}

/**
 * Weld catalog components with autodiscovery components by path overlap.
 *
 * CODE-FIRST PRINCIPLE:
 *   Autodiscovery decides WHAT exists (the node list).
 *   Catalog only enriches those nodes with metadata (owner, system, deps).
 *   Catalog-only components (no code match) do NOT create Service nodes
 *   — UNLESS their directory has zero autodiscovery coverage (per-directory
 *   safety net for legacy services without recognizable manifests).
 *
 * Per-Directory Safety Net:
 *   If a catalog component's directory has no autodiscovery match, the catalog
 *   component is promoted as a "catalog-verified" Service. This covers mixed
 *   monorepos where some services have manifests and others don't (e.g. a React
 *   frontend alongside a legacy Ant-based Java backend and bash cron scripts).
 *
 * Rules:
 * - Autodiscovery components are the PRIMARY list
 * - For each auto component, find a catalog match by directory
 * - Only the PRIMARY catalog component for each directory is welded
 * - Catalog provides metadata (owner, system, deps)
 * - Autodiscovery provides technical identity (name, language)
 * - catalogName preserves the original catalog identifier for traceability
 * - Unmatched catalog components with no auto coverage are promoted (safety net)
 * - Truly unmatched secondary components are returned for observability
 */
export function weldIdentities(
    catalogComponents: DiscoveredComponent[],
    autoComponents: DiscoveredComponent[],
    repoPath: string,
    repoName: string,
    nameOverrides: Record<string, string>,
): WeldResult {
    const welded: DiscoveredComponent[] = [];
    const unmatchedCatalogComponents: DiscoveredComponent[] = [];

    // ── Group catalog components by the directory of their catalog file ───
    const catalogByDir = new Map<string, DiscoveredComponent[]>();
    for (const cat of catalogComponents) {
        const dir = path.dirname(cat.catalogFile).replace(/\\/g, '/');
        const group = catalogByDir.get(dir) ?? [];
        group.push(cat);
        catalogByDir.set(dir, group);
    }

    // Track which catalog directories have been consumed by welding
    const consumedCatalogDirs = new Set<string>();

    const sortedCatalogDirs = [...catalogByDir.keys()].sort((a, b) => b.length - a.length);

    // ── CODE-FIRST: iterate auto components, find catalog enrichment ─────
    for (const auto of autoComponents) {
        const autoDir = auto.catalogFile.replace(/\\/g, '/');
        const catComponents = catalogByDir.get(autoDir);

        if (catComponents && catComponents.length > 0) {
            // ── WELD: merge catalog metadata with autodiscovery identity ─────
            consumedCatalogDirs.add(autoDir);

            // Select the primary catalog component for this directory
            // (multi-doc YAML: prefer type:service over library, use depth/alpha tie-break)
            const primary = catComponents.length === 1
                ? catComponents[0]
                : selectPrimaryComponent(catComponents, repoName);

            // Derive the "useful" name
            const overrideName = nameOverrides[primary.name];
            const usefulName = overrideName ?? deriveUsefulName(auto.catalogFile, repoPath, repoName);

            // Create the welded component
            welded.push({
                name: usefulName,
                catalogName: primary.name !== usefulName ? primary.name : undefined,
                catalogSource: primary.source as 'backstage' | 'cortex',
                title: primary.title,
                description: primary.description,
                owner: primary.owner,
                system: primary.system,
                dependsOn: primary.dependsOn,
                type: primary.type,
                language: auto.language ?? primary.language, // auto wins for language
                catalogFile: primary.catalogFile,
                source: primary.source,
            });

            logger.info(
                `[Identity] Welded "${primary.name}" (${primary.source}) + "${auto.name}" (auto) → "${usefulName}"`,
            );

            // Secondary catalog components in the same directory are unmatched
            // (they don't have their own code root — not promoted to Service)
            for (const secondary of catComponents) {
                if (secondary === primary) continue;
                unmatchedCatalogComponents.push(secondary);
            }
        } else {
            // ── CASCADING: Find the closest parent umbrella catalog ─────
            const parentDir = sortedCatalogDirs.find(d => autoDir.startsWith(d + '/') || autoDir === d);
            if (parentDir) {
                const parentComponents = catalogByDir.get(parentDir);
                if (parentComponents && parentComponents.length > 0) {
                    const primary = parentComponents.length === 1
                        ? parentComponents[0]
                        : selectPrimaryComponent(parentComponents, repoName);

                    welded.push({
                        ...auto,
                        owner: auto.owner ?? primary.owner,
                        system: auto.system ?? primary.system,
                    });

                    logger.info(
                        `[Identity] Cascaded owner "${primary.owner ?? 'none'}" and system "${primary.system ?? 'none'}" from umbrella catalog at ${parentDir} to "${auto.name}"`,
                    );
                    continue;
                }
            }

            // ── No catalog match: auto component flows through unchanged ─────
            welded.push(auto);
        }
    }

    // ── Per-directory safety net ──────────────────────────────────────────
    // Catalog directories that had NO auto match: promote the PRIMARY catalog
    // component as a "catalog-verified" Service. This covers legacy services
    // (bash scripts, Ant builds, custom frameworks) that lack manifest files.
    //
    // This fires PER DIRECTORY, not per repository — so a mixed monorepo
    // (React frontend + legacy Java backend) correctly promotes the legacy
    // backend even though autodiscovery found the frontend.
    //
    // EXCEPTION: an "umbrella" catalog whose directory contains nested auto
    // components (e.g. /platform/catalog-info.yaml with autodiscovery hits in
    // /platform/api, /platform/console, …) is NOT promoted. The autodiscovered
    // sub-services already represent the codebase; the umbrella catalog
    // should at most contribute system/owner metadata (handled elsewhere),
    // not appear as a phantom Service with an admin-style name.
    const autoDirs = new Set(autoComponents.map(a => a.catalogFile.replace(/\\/g, '/')));
    for (const [dir, catComponents] of catalogByDir) {
        if (consumedCatalogDirs.has(dir)) continue;

        const prefix = dir.endsWith('/') ? dir : dir + '/';
        const hasNestedAuto = [...autoDirs].some(autoDir => autoDir.startsWith(prefix));
        if (hasNestedAuto) {
            const sample = catComponents.map(c => c.name).join(', ');
            logger.info(
                `[Identity] Skipping umbrella catalog at ${dir} — covered by nested autodiscovery components [${sample}]`,
            );
            for (const c of catComponents) unmatchedCatalogComponents.push(c);
            continue;
        }

        // Select the primary component to promote
        const primary = catComponents.length === 1
            ? catComponents[0]
            : selectPrimaryComponent(catComponents, repoName);

        const overrideName = nameOverrides[primary.name];
        welded.push({
            ...primary,
            name: overrideName ?? primary.name,
            catalogName: overrideName ? primary.name : undefined,
            catalogSource: primary.source as 'backstage' | 'cortex',
        });

        logger.warn(
            `[Identity] Safety net: promoting catalog-only "${primary.name}" (no code detected in ${dir}). ` +
            `Consider adding a manifest file or configuring .coderadius.yaml.`,
        );

        // Secondary components in the same catalog-only directory remain unmatched
        for (const secondary of catComponents) {
            if (secondary === primary) continue;
            unmatchedCatalogComponents.push(secondary);
        }
    }

    if (unmatchedCatalogComponents.length > 0) {
        logger.info(
            `[Identity] ${unmatchedCatalogComponents.length} catalog secondary component(s) not promoted: ` +
            `[${unmatchedCatalogComponents.map(c => c.name).join(', ')}]`,
        );
    }

    return { components: welded, allCatalogComponents: catalogComponents, unmatchedCatalogComponents };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Topology Collapse
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply the repository topology to a set of discovered components.
 *
 * - monorepo: every component becomes a Service (pass-through)
 * - monolith: primary → Service, rest → DeploymentUnits (unless overridden)
 *
 * Dependencies are classified:
 * - Intra-repo (target name is a local component) → internal Package
 * - External (target not found locally) → Service stub
 */
/**
 * Infer the effective topology from the component layout.
 *
 * Heuristic: if ALL catalog-sourced components (Backstage/Cortex)
 * share the same catalog-info.yaml directory, they are co-located
 * in the same codebase and should be treated as a monolith.
 *
 * Edge cases:
 *   - 0 or 1 components → monorepo (nothing to collapse)
 *   - Only autodiscovery (no catalog) → monorepo
 *   - All catalog components in same directory → monolith
 *   - Catalog components in different directories → monorepo
 */
export function resolveAutoTopology(
    components: DiscoveredComponent[],
): 'monolith' | 'monorepo' {
    // Need 2+ components to even consider monolith
    if (components.length <= 1) return 'monorepo';

    const autoComponents = components.filter(c => c.source === 'autodiscovery' || c.source === 'autodiscovery-synthetic');
    const catalogComponents = components.filter(c => c.source !== 'autodiscovery' && c.source !== 'autodiscovery-synthetic');

    // ── SMART MONOLITH HEURISTIC ──────────────────────────────────────────
    // If there is EXACTLY ONE physical codebase (1 autodiscovery root),
    // and we have at least one catalog component, and ALL catalog components
    // are strictly nested within that codebase's directory, then the repository
    // is physically a monolith. The scattered catalog components are logical facets.
    if (autoComponents.length === 1 && catalogComponents.length > 0) {
        const rootDir = autoComponents[0].catalogFile.replace(/\\/g, '/');
        const prefix = rootDir.endsWith('/') ? rootDir : rootDir + '/';

        const allNested = catalogComponents.every(c => {
            const cDir = path.dirname(c.catalogFile).replace(/\\/g, '/');
            return cDir === rootDir || cDir.startsWith(prefix);
        });

        if (allNested) return 'monolith';
    }

    // ── ORIGINAL HEURISTIC (for true monorepos) ───────────────────────────
    // If fewer than 2 catalog components, there's no multi-doc signal → monorepo
    if (catalogComponents.length <= 1) return 'monorepo';

    // Check if all catalog components share the same directory
    const dirs = new Set(
        catalogComponents.map(c => path.dirname(c.catalogFile).replace(/\\/g, '/')),
    );

    // Same directory = monolith (multi-doc YAML sharing a single codebase).
    // Note: The old multi-system heuristic is no longer needed because
    // code-first welding ensures that catalog-only components from different
    // repos/systems never reach the topology resolver in the first place.
    return dirs.size === 1 ? 'monolith' : 'monorepo';
}

export function collapseToTopology(
    components: DiscoveredComponent[],
    auxiliaryEntities: AuxiliaryEntity[],
    topology: 'monolith' | 'monorepo' | 'auto',
    repoName: string,
    repoPath: string,
    hints: RepoHints,
    catalogEntities: DiscoveredComponent[] = [],
): TopologyResult {
    // Resolve 'auto' to a concrete topology
    const effectiveTopology = topology === 'auto'
        ? resolveAutoTopology(components)
        : topology;

    const localNames = new Set(components.map(c => c.name));
    const claimedPaths = components.map(c => path.dirname(c.catalogFile));

    if (effectiveTopology === 'monolith' && components.length > 1) {
        return collapseMonolith(components, auxiliaryEntities, localNames, repoName, hints, claimedPaths, effectiveTopology, catalogEntities);
    }

    // ── Monorepo path ────────────────────────────────────────────────────
    //
    // Bucket components by their classification:
    //   - type === 'service'  → :Service entry
    //   - type === 'library'  → :Library entry (no Service node)
    //   - type === undefined  → pending triage (no decisive signal)
    //
    // Library and pending-triage components are persisted by the writer below
    // but do NOT receive EXPOSES_API/HAS_TASK/CONSUMES_API edges.
    const services: ServiceEntry[] = [];
    const libraries: LibraryEntry[] = [];
    const pendingTriage: DiscoveredComponent[] = [];

    for (const comp of components) {
        const roleOverride = getComponentRoleOverride(hints, comp.name);

        if (roleOverride === 'deployment-facet') {
            logger.warn(`[Topology] Component "${comp.name}" is marked as deployment-facet in monorepo mode. Consider using topology: monolith.`);
        }

        if (comp.type === 'library') {
            libraries.push({ component: comp });
            continue;
        }
        // Bucketing rule for `type === undefined`:
        //   - autodiscovery source: we asked the plugin and the signals were
        //     inconclusive AND no decisive library inference. Stash for triage.
        //   - backstage/cortex source: catalog Components conventionally default
        //     to service when spec.type is unset; keep legacy behavior so we
        //     don't silently downgrade existing catalogs.
        if (comp.type === undefined && comp.source === 'autodiscovery') {
            pendingTriage.push(comp);
            continue;
        }

        const { internal, external } = classifyDependencies(comp.dependsOn ?? [], localNames);
        services.push({
            component: comp,
            deploymentUnits: [],
            internalDeps: internal,
            externalDeps: external,
        });
    }

    // Synthetic repo-as-Service fallback. The customer's monolithic codebase
    // still needs a :Service node so the impact dashboard has something to
    // hang Function ownership and READS/WRITES/CALLS edges on. Eligible when:
    //   - the user explicitly picked 'monolith', OR
    //   - 'auto' was passed AND there is exactly one component (auto resolves
    //     single-workspace as 'monorepo' for historical reasons, but a single
    //     workspace IS a monolith from an impact-mapping perspective).
    // Explicit 'monorepo' is NOT eligible: the user expressed multi-workspace
    // intent, so library-only repos stay as library-only.
    const eligibleMonolith =
        topology === 'monolith' ||
        (topology === 'auto' && components.length === 1);
    if (services.length === 0 && eligibleMonolith && components.length >= 1) {
        const sampleLanguage = components.find(c => c.language && c.language !== 'unknown')?.language ?? 'unknown';
        const syntheticComponent: DiscoveredComponent = {
            name: repoName,
            type: 'service',
            catalogFile: repoPath,
            source: 'autodiscovery-synthetic',
            language: sampleLanguage,
        };
        services.push({
            component: syntheticComponent,
            deploymentUnits: [],
            internalDeps: [],
            externalDeps: [],
        });
        logger.info(
            `[Topology] No runtime workspace detected for monolith "${repoName}" — promoting repo to synthetic :Service (extractor=topology-autodiscovery-synthetic@v1).`,
        );
    }

    return { services, libraries, pendingTriage, auxiliaryEntities, claimedPaths, effectiveTopology, catalogEntities };
}

function collapseMonolith(
    components: DiscoveredComponent[],
    auxiliaryEntities: AuxiliaryEntity[],
    localNames: Set<string>,
    repoName: string,
    hints: RepoHints,
    claimedPaths: string[],
    effectiveTopology: 'monolith' | 'monorepo',
    catalogEntities: DiscoveredComponent[],
): TopologyResult {
    const primary = selectPrimaryComponent(components, repoName);
    const services: ServiceEntry[] = [];
    const deploymentUnits: DiscoveredComponent[] = [];

    for (const comp of components) {
        const roleOverride = getComponentRoleOverride(hints, comp.name);

        if (roleOverride === 'independent-service') {
            const { internal, external } = classifyDependencies(comp.dependsOn ?? [], localNames);
            services.push({
                component: comp,
                deploymentUnits: [],
                internalDeps: internal,
                externalDeps: external,
            });
        } else if (comp.name !== primary.name) {
            deploymentUnits.push(comp);
        }
    }

    const { internal, external } = classifyDependencies(
        components.flatMap(c => c.dependsOn ?? []),
        localNames,
    );

    services.unshift({
        component: primary,
        deploymentUnits,
        internalDeps: internal,
        externalDeps: external,
    });

    logger.info(
        `[Topology] Monolith collapse: "${primary.name}" (Service) + ${deploymentUnits.length} DeploymentUnit(s) ` +
        `[${deploymentUnits.map(d => d.name).join(', ')}]`,
    );

    return { services, auxiliaryEntities, claimedPaths, effectiveTopology, catalogEntities };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dependency Classification
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify dependencies as internal (intra-repo) or external.
 *
 * All refs are normalized before comparison — `component:default/helper-lib`
 * and `helper-lib` both match against the same localNames set.
 */
function classifyDependencies(
    deps: string[],
    localComponentNames: Set<string>,
): { internal: string[]; external: string[] } {
    const internal: string[] = [];
    const external: string[] = [];
    const seen = new Set<string>();

    for (const dep of deps) {
        const normalized = normalizeDependencyRef(dep);
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        if (localComponentNames.has(normalized)) {
            internal.push(normalized);
        } else {
            external.push(normalized);
        }
    }

    return { internal, external };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Catalog → Service Resolution
// ═══════════════════════════════════════════════════════════════════════════════

export interface CatalogServiceTarget {
    serviceName: string;
    matchedBy: 'identity' | 'partOf';
}

/**
 * Resolve which local :Service a CatalogEntity DESCRIBES.
 *
 * ONE resolution chain applied uniformly to every catalog entity — a primary
 * Component and its partOf siblings go through the same function; what differs
 * is which step resolves, driven by what the catalog declares:
 *   1. identity — a Service was welded from this entity (catalogName) or shares its name
 *   2. partOf   — the entity declares containment in a sibling; the sibling's Service anchors it
 *   3. null     — no grounded key; the caller anchors to the Repository instead
 *
 * partOf is one-hop and exact (grounded identity, never fuzzy): each ref is
 * identity-matched against the welded services. All resolving refs must agree
 * on a single Service; none or conflicting → null.
 */
export function resolveCatalogServiceTarget(
    cat: DiscoveredComponent,
    services: ServiceEntry[],
): CatalogServiceTarget | null {
    const identity = findServiceByRef(services, cat.name);
    if (identity) return { serviceName: identity, matchedBy: 'identity' };

    const parents = new Set<string>();
    for (const ref of cat.catalogMeta?.partOf ?? []) {
        const parent = findServiceByRef(services, ref);
        if (parent) parents.add(parent);
    }
    if (parents.size === 1) return { serviceName: [...parents][0], matchedBy: 'partOf' };
    return null;
}

/** Identity match of a catalog ref against the welded services (catalogName first, then name). */
function findServiceByRef(services: ServiceEntry[], ref: string): string | null {
    const hit = services.find(s => s.component.catalogName === ref || s.component.name === ref);
    return hit ? hit.component.name : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Graph Writer
// ═══════════════════════════════════════════════════════════════════════════════

const COMMIT_HASH = 'SYSTEM';

/**
 * Write a TopologyResult to the graph.
 *
 * This is the ONLY place that calls graph mutation queries for service topology.
 * Extractors never write to the graph directly.
 */
export async function writeTopologyToGraph(
    result: TopologyResult,
    repo: { name: string; path: string; org?: string },
): Promise<{ servicesCreated: string[] }> {
    const qRepo = getQualifiedRepoName(repo);
    const servicesCreated: string[] = [];

    // ── Auxiliary entities (System, Domain, Team) ─────────────────────────
    for (const aux of result.auxiliaryEntities) {
        switch (aux.kind) {
            case 'System':
                await mergeSystem(aux.name, aux.description, COMMIT_HASH);
                if (aux.domain) {
                    await mergeDomain(aux.domain, undefined, COMMIT_HASH);
                    await linkSystemPartOfDomain(aux.name, aux.domain, COMMIT_HASH);
                }
                break;
            case 'Domain':
                await mergeDomain(aux.name, aux.description, COMMIT_HASH);
                break;
            case 'Team':
                await mergeTeam(aux.name, COMMIT_HASH);
                break;
        }
    }

    // ── Catalog Entities (Declared Truth Layer) ────────────────────────────
    if (result.catalogEntities) {
        for (const cat of result.catalogEntities) {
            const meta = cat.catalogMeta;
            const catSource = cat.catalogSource ?? cat.source;
            const catKind = meta?.kind ?? 'Component';
            const catNs = meta?.namespace ?? 'default';

            await mergeCatalogEntity({
                qualifiedRepoName: qRepo,
                name: cat.name,
                catalogSource: catSource,
                kind: catKind,
                namespace: catNs,
                entityRef: meta?.entityRef ?? `${catKind.toLowerCase()}:${catNs}/${cat.name}`,
                type: cat.type,
                owner: cat.owner,
                system: cat.system,
                description: cat.description,
                lifecycle: meta?.lifecycle,
                dependsOnJson: cat.dependsOn?.length ? JSON.stringify(cat.dependsOn) : undefined,
                partOfJson: meta?.partOf?.length ? JSON.stringify(meta.partOf) : undefined,
                providesApisJson: meta?.providesApis?.length ? JSON.stringify(meta.providesApis) : undefined,
                consumesApisJson: meta?.consumesApis?.length ? JSON.stringify(meta.consumesApis) : undefined,
                labelsJson: meta?.labels && Object.keys(meta.labels).length ? JSON.stringify(meta.labels) : undefined,
                tagsJson: meta?.tags?.length ? JSON.stringify(meta.tags) : undefined,
                linksJson: meta?.links?.length ? JSON.stringify(meta.links) : undefined,
                specJson: meta?.specJson,
                commitHash: COMMIT_HASH,
            });
        }
    }

    // ── Local Service Index (for eager intra-repo dependency bind) ──────
    // Maps every "addressable name" of a Service in this repo to its
    // canonical name. A dep that hits this map becomes a direct edge to
    // the local :Service; everything else becomes :UnresolvedDependency.
    const localByName = new Map<string, string>();
    for (const entry of result.services) {
        localByName.set(entry.component.name, entry.component.name);
        if (entry.component.catalogName) {
            localByName.set(entry.component.catalogName, entry.component.name);
        }
    }

    // ── Services ─────────────────────────────────────────────────────────
    for (const entry of result.services) {
        const comp = entry.component;
        const lang = comp.language ?? 'unknown';

        // Service from topology resolver: backstage catalog or autodiscovery heuristic.
        // The original `comp.source` discriminator is now encoded as the extractor name.
        await mergeService(
            qRepo, comp.name, lang, comp.description,
            comp.catalogName, comp.catalogSource,  // Identity welding metadata
            undefined, undefined, COMMIT_HASH,
            astGrounding(`topology-${comp.source ?? 'autodiscovery'}@v1`),
        );
        await linkServiceStoredIn(qRepo, comp.name, qRepo, '', COMMIT_HASH);
        servicesCreated.push(comp.name);

        // Owner → Team
        if (comp.owner) {
            await mergeTeam(comp.owner, COMMIT_HASH);
            await linkTeamOwnsService(comp.owner, qRepo, comp.name, COMMIT_HASH, comp.source);
        }

        // System membership
        if (comp.system) {
            await mergeSystem(comp.system, undefined, COMMIT_HASH);
            await linkSystemContainsService(comp.system, qRepo, comp.name, COMMIT_HASH, comp.source);
        }

        // Catalog metadata.links → Link nodes + HAS_LINK edges
        if (comp.links && comp.links.length > 0) {
            for (const link of comp.links) {
                if (!link.url) continue;
                const linkId = await mergeLink(
                    qRepo, link.url, link.title, link.icon, link.type, COMMIT_HASH,
                );
                await linkServiceHasLink(qRepo, comp.name, linkId, COMMIT_HASH);
            }
        }

        // DeploymentUnits
        for (const du of entry.deploymentUnits) {
            await mergeDeploymentUnit(qRepo, du.name, du.description, COMMIT_HASH);
            await linkServiceDeployedAs(qRepo, comp.name, du.name, COMMIT_HASH);

            if (du.system) {
                await mergeSystem(du.system, undefined, COMMIT_HASH);
                await linkSystemContainsDeploymentUnit(du.system, qRepo, du.name, COMMIT_HASH);
            }

            logger.info(`[Topology] "${du.name}" → DeploymentUnit (facet of "${comp.name}")`);
        }

        // Catalog `dependsOn` references are Service-to-Service — never npm/composer
        // packages. Bind to a local :Service when possible (intra-repo or
        // intra-monorepo), otherwise materialise as :UnresolvedDependency for
        // cross-repo late binding.
        const allDeps = [...entry.internalDeps, ...entry.externalDeps];
        // A catalog dependsOn is a customer-declared fact; stamp `declared`
        // grounding so the edge is distinguishable from a code-inferred DEPENDS_ON.
        const depGrounding = declaredGrounding('catalog-dependson@v1');
        for (const dep of allDeps) {
            const localTarget = localByName.get(dep);
            if (localTarget) {
                await linkServiceDependsOnService(
                    qRepo, comp.name, qRepo, localTarget, COMMIT_HASH,
                    { source: comp.source }, depGrounding,
                );
            } else {
                await linkServiceDependsOnUnresolved(
                    qRepo, comp.name, dep, COMMIT_HASH,
                    { source: comp.source }, depGrounding,
                );
            }
        }
    }

    // ── Catalog → code links (after services exist) ───────────────────────
    // Must run after the service merge above: linkCatalogEntityToService MATCHes
    // an existing :Service node. In the catalog loop (before mergeService) the
    // MATCH bound nothing → no edge, and the if/else swallowed the repo fallback
    // for entities matched to a service by name (the acme-monolith-service ghost).
    if (result.catalogEntities) {
        for (const cat of result.catalogEntities) {
            const meta = cat.catalogMeta;
            const catSource = cat.catalogSource ?? cat.source;
            const catKind = meta?.kind ?? 'Component';
            const catNs = meta?.namespace ?? 'default';
            const target = resolveCatalogServiceTarget(cat, result.services);
            if (target) {
                await linkCatalogEntityToService(qRepo, catSource, catKind, catNs, cat.name, target.serviceName, COMMIT_HASH, target.matchedBy);
            } else {
                await linkCatalogEntityToRepository(qRepo, catSource, catKind, catNs, cat.name, COMMIT_HASH);
            }
        }
    }

    // ── Libraries ────────────────────────────────────────────────────────
    // Workspaces classified as libraries (catalog type=library OR plugin
    // signals declared but none fired). Persisted as :Library nodes; they
    // do NOT receive EXPOSES_API/HAS_TASK/CONSUMES_API edges.
    for (const entry of result.libraries ?? []) {
        const comp = entry.component;
        await mergeLibrary(comp.name, COMMIT_HASH);
        await linkLibraryStoredIn(comp.name, qRepo, '', COMMIT_HASH);
        logger.info(`[Topology] "${comp.name}" → :Library (source=${comp.source})`);
    }

    // ── Pending Triage ───────────────────────────────────────────────────
    // Autodiscovery components without a decisive runtime classification AND
    // without a catalog hint. Persisted as :Library with the rationale that
    // libraries are the safer default for cards and rollups; flagged for
    // human review.
    for (const comp of result.pendingTriage ?? []) {
        await mergeLibrary(comp.name, COMMIT_HASH);
        await linkLibraryStoredIn(comp.name, qRepo, '', COMMIT_HASH);
        logger.warn(
            `[Topology] "${comp.name}" → :Library (pendingTriage, no decisive signal). ` +
            `Add coderadius.yaml componentRoleOverride or extend the language plugin's runtimeServiceSignals.`,
        );
    }

    return { servicesCreated };
}
