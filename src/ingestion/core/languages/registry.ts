import type { FrameworkDiHandleKind, LanguagePlugin } from './types.js';
import { TypeScriptPlugin } from './typescript.js';
import { PHPPlugin } from './php.js';
import { PythonPlugin } from './python.js';
import { GoPlugin } from './go.js';
import { JavaPlugin } from './java.js';

// ─── Plugin Registry ─────────────────────────────────────────────────────────
//
// Instantiation is LAZY (first call), never at module-eval time: the registry
// sits at the centre of legitimate import cycles (plugin → value-resolution →
// registry → plugin), so a module-body `new PHPPlugin()` would run while the
// plugin class is still in its temporal dead zone. All lookups go through the
// lazy accessors below.

let pluginInstances: LanguagePlugin[] | null = null;
let byLanguage: Map<string, LanguagePlugin> | null = null;
let byExtension: Map<string, LanguagePlugin> | null = null;

/** All registered language plugins (lazily instantiated singletons). */
export function getAllPlugins(): LanguagePlugin[] {
    if (!pluginInstances) {
        pluginInstances = [
            new TypeScriptPlugin(),
            new PHPPlugin(),
            new PythonPlugin(),
            new GoPlugin(),
            new JavaPlugin(),
        ];
    }
    return pluginInstances;
}

function languageMap(): Map<string, LanguagePlugin> {
    if (!byLanguage) {
        byLanguage = new Map(getAllPlugins().map(p => [p.language, p]));
    }
    return byLanguage;
}

function extensionMap(): Map<string, LanguagePlugin> {
    if (!byExtension) {
        byExtension = new Map();
        for (const plugin of getAllPlugins()) {
            for (const ext of plugin.extensions) {
                byExtension.set(ext, plugin);
            }
        }
    }
    return byExtension;
}

/**
 * Get a plugin by language name (e.g. 'typescript', 'php').
 * Returns null for unknown languages.
 */
export function getLanguagePlugin(language: string): LanguagePlugin | null {
    return languageMap().get(language) ?? null;
}

/**
 * Get a plugin by file extension (e.g. '.ts', '.php').
 * Returns null for unsupported extensions.
 */
export function getPluginForExtension(ext: string): LanguagePlugin | null {
    return extensionMap().get(ext.toLowerCase()) ?? null;
}

/**
 * All supported file extensions across all registered plugins.
 */
export function getAllSupportedExtensions(): string[] {
    return [...extensionMap().keys()];
}

/**
 * All scope exclusion patterns from all registered plugins, merged together.
 */
export function getAllScopeExclusions(): string[] {
    return getAllPlugins().flatMap(p => [...p.scopeExclusions]);
}

/**
 * All manifest files across all registered plugins, in plugin registration order.
 */
export function getAllManifestFiles(): Array<{ file: string; language: string }> {
    return getAllPlugins().flatMap(p => [...(p.manifestFiles ?? [])]);
}

/**
 * Glob pattern matching all registered manifest filenames.
 * e.g. '{go.mod,package.json,composer.json,...}'
 */
export function getManifestGlob(): string {
    const files = getAllManifestFiles().map(m => m.file);
    return `{${files.join(',')}}`;
}

/**
 * All language-specific ignore patterns across all plugins, deduplicated.
 */
export function getAllIgnorePatterns(): string[] {
    return [...new Set(getAllPlugins().flatMap(p => [...(p.ignorePatterns ?? [])]))];
}

/**
 * All ecosystem-specific I/O sink packages from all plugins, deduplicated.
 * Consumed by `buildSinkRegistry` in `import-graph.ts` to seed the taint
 * propagation engine without per-ecosystem coupling in the core.
 */
export function getAllPluginSinkPackages(): string[] {
    return [...new Set(getAllPlugins().flatMap(p => [...(p.sinkPackages ?? [])]))];
}

/**
 * True when ANY registered language plugin recognises `name` as one of its
 * ecosystem's published framework DI-handle shapes. For consumers with NO
 * language context (e.g. graph-wide reconcile sweeps that only see node
 * names): the grammar stays in the plugins, the core merely aggregates.
 */
export function anyPluginRecognizesFrameworkDiHandle(name: string, kind: FrameworkDiHandleKind): boolean {
    return getAllPlugins().some(p => p.recognizesFrameworkDiHandle?.(name, kind) ?? false);
}
