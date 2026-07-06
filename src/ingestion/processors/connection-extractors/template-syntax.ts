import type { TemplateSyntax } from './types.js';

/**
 * Classify which template grammar (if any) a raw config value carries, so the
 * orchestrator's `applyResolution` pass knows which resolver to apply.
 * Shared by config-file extractors — value-shape detection only, no key names.
 */
export function classifyTemplate(value: string | undefined): TemplateSyntax {
    if (!value || typeof value !== 'string') return 'none';
    if (/%env\([^)]+\)%/.test(value)) return 'symfony-env';
    if (/process\.env\b/.test(value)) return 'js-template';
    if (/\$\{[^}]+\}/.test(value)) return 'shell';
    if (/\{\{[^}]+\}\}/.test(value)) return 'helm';
    return 'none';
}

/** First non-`none` syntax across a hint's fields wins (hints are single-syntax). */
export function aggregateSyntaxes(values: Array<string | number | undefined>): TemplateSyntax {
    for (const v of values) {
        if (typeof v !== 'string') continue;
        const c = classifyTemplate(v);
        if (c !== 'none') return c;
    }
    return 'none';
}
