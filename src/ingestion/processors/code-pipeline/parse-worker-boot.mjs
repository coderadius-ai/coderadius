/**
 * Node-runtime bootstrap for the parse worker.
 *
 * Under Bun (production CLI) the pool spawns `parse-worker.ts` directly —
 * Bun resolves the tsc-style `.js`-suffixed TypeScript module graph natively.
 *
 * Under Node (vitest test processes run on Node, and worker_threads inherit
 * the parent runtime) two gaps must be bridged before the worker module
 * graph can load:
 *   (a) relative `./x.js` specifiers must fall back to `./x.ts` — Node's
 *       type-stripping does NOT rewrite extensions;
 *   (b) non-erasable TS syntax in the graph (e.g. the logger enum) needs
 *       --experimental-transform-types, which the pool passes via execArgv.
 *
 * Plain .mjs so any runtime loads it without transforms. No dependencies.
 */
import { registerHooks } from 'node:module';

if (!process.versions.bun) {
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
                try {
                    return nextResolve(specifier, context);
                } catch {
                    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
                }
            }
            return nextResolve(specifier, context);
        },
    });
}

await import('./parse-worker.ts');
