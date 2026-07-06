import { buildUrn } from '../../../graph/urn.js';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../types.js';
import semver from 'semver';

export class PackagePublisherPlugin implements StructuralPlugin {
    readonly name = 'package-publisher';
    readonly label = 'Package Publisher';
    // We declare 'Release' as a managed label so that stale releases (if a library drops a version, which is rare but possible, or if the repo is deleted/un-published) can be reconciled if needed. 
    // However, we want to accumulate history, so we might NOT want to manage 'Release' to avoid sweeping old releases from other commits.
    // Wait, since we are doing Mark & Sweep, if we mark 'Release' as managed, any Release NOT found in the current files will be SWEPT (deleted).
    // This goes against the "Version Timeline Accumulation" philosophy. We want to KEEP old releases. 
    // So we should NOT include 'Release' in managedLabels.
    // Actually, maybe we shouldn't manage anything and rely only on additive MERGE.
    readonly managedLabels: string[] = []; 

    matchFile(relativePath: string, basename: string): boolean {
        return basename === 'package.json' || basename === 'composer.json';
    }

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        let parsed: any;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            return { entities: [], summary: 'Invalid JSON' };
        }

        // Q1 rules: Must not be private
        if (parsed.private === true) {
            return { entities: [], summary: 'Private package, skipped' };
        }

        const name = parsed.name;
        const version = parsed.version;

        if (!name || typeof name !== 'string') {
            return { entities: [], summary: 'No package name found' };
        }

        if (!version || typeof version !== 'string') {
            return { entities: [], summary: 'No package version found' };
        }

        // Q1 rules: Valid Semver, ignore 0.0.0, workspace:*, *, empty strings
        if (version === '0.0.0' || version === '*' || version.startsWith('workspace:')) {
            return { entities: [], summary: `Placeholder version ${version}, skipped` };
        }

        if (!semver.valid(version)) {
            return { entities: [], summary: `Invalid semver ${version}, skipped` };
        }

        // ── Publishability heuristic ─────────────────────────────────────────
        // Filter out application manifests that are NOT actual publishable packages.
        // Without this, any repo with a non-private package.json (e.g. "shark-fe")
        // would erroneously be treated as an internal published package.
        const isComposer = context.relativePath.endsWith('composer.json');

        if (isComposer) {
            // Composer: a publishable library has autoload or type=library/symfony-bundle
            const hasAutoload = parsed.autoload && typeof parsed.autoload === 'object' && Object.keys(parsed.autoload).length > 0;
            const libTypes = ['library', 'symfony-bundle', 'composer-plugin', 'metapackage'];
            const isLibType = typeof parsed.type === 'string' && libTypes.includes(parsed.type);
            if (!hasAutoload && !isLibType) {
                return { entities: [], summary: `Not a publishable Composer package (no autoload/library type), skipped` };
            }
        } else {
            // npm: a publishable package has:
            //  - an entry-point field (main/module/exports/types/bin), OR
            //  - an explicit publishConfig (strongest signal — declares a registry target)
            const hasEntryPoint = parsed.main || parsed.module || parsed.exports || parsed.types || parsed.typings || parsed.bin;
            const hasPublishConfig = parsed.publishConfig && typeof parsed.publishConfig === 'object';
            if (!hasEntryPoint && !hasPublishConfig) {
                return { entities: [], summary: `Not a publishable npm package (no main/module/exports/types/bin/publishConfig), skipped` };
            }
        }

        const ecosystem = context.relativePath.endsWith('composer.json') ? 'composer' : 'npm';
        const registryUrl = parsed.publishConfig?.registry ?? null;

        // Since we decided not to sweep 'Release' to keep history, we just emit the Release entity.
        // Wait, plugin-manager expects entities. We will emit a 'Release' entity.
        // We'll also pass down the registryUrl and name so plugin-manager can call `linkRepositoryPublishesPackage`.

        const releaseUrn = buildUrn('release', ecosystem, name, version);

        const entity: StructuralEntity = {
            id: releaseUrn,
            labels: ['Release'],
            properties: {
                _packageName: name,
                _ecosystem: ecosystem,
                _version: version,
                _registryUrl: registryUrl,
                // plugin-manager uses _sourcePath to track provenance
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'HAS_RELEASE',
        };

        return {
            entities: [entity],
            summary: `Published: ${name}@${version}`,
        };
    }
}

export const packagePublisherPlugin = new PackagePublisherPlugin();
