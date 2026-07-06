import { describe, it, expect } from 'vitest';
import { buildUrn, normalizeResourceName, buildFunctionSignature, CR_SCHEME, urnPrefix } from '../../../src/graph/urn.js';

const LOC = { startLine: 1, startColumn: 1, endLine: 10, endColumn: 1 } as const;

describe('URN Module (cr: scheme)', () => {

    // ─── CR_SCHEME constant ──────────────────────────────────────────────

    describe('CR_SCHEME', () => {
        it('should be the canonical cr: prefix', () => {
            expect(CR_SCHEME).toBe('cr:');
        });
    });

    // ─── urnPrefix ───────────────────────────────────────────────────────

    describe('urnPrefix', () => {
        it('should produce a prefix with trailing colon for Cypher STARTS WITH', () => {
            expect(urnPrefix('endpoint')).toBe('cr:endpoint:');
        });

        it('should support sub-segment prefixes', () => {
            expect(urnPrefix('endpoint', 'emergent')).toBe('cr:endpoint:emergent:');
        });

        it('should pass through special characters verbatim', () => {
            expect(urnPrefix('sourcefile', 'my/repo')).toBe('cr:sourcefile:my/repo:');
        });
    });

    // ─── buildUrn ────────────────────────────────────────────────────────

    describe('buildUrn', () => {

        it('should produce cr: prefixed URNs with : separators', () => {
            expect(buildUrn('service', 'order-service')).toBe('cr:service:order-service');
        });

        it('should lowercase datacontainer names (SQL is case-insensitive)', () => {
            expect(buildUrn('datacontainer', 'Operations')).toBe('cr:datacontainer:operations');
            expect(buildUrn('datacontainer', 'OPERATIONS')).toBe('cr:datacontainer:operations');
            expect(buildUrn('datacontainer', 'operations')).toBe('cr:datacontainer:operations');
        });

        it('should lowercase datastore names', () => {
            expect(buildUrn('datastore', 'Postgres')).toBe('cr:datastore:postgres');
        });

        it('should lowercase systemprocess names', () => {
            expect(buildUrn('systemprocess', 'CronJob')).toBe('cr:systemprocess:cronjob');
        });

        it('should lowercase domain, system, and team names', () => {
            expect(buildUrn('domain', 'Logistics')).toBe('cr:domain:logistics');
            expect(buildUrn('system', 'CorePlatform')).toBe('cr:system:coreplatform');
            expect(buildUrn('team', 'BackendTeam')).toBe('cr:team:backendteam');
        });

        it('should preserve case for service names (directory-derived)', () => {
            expect(buildUrn('service', 'OrderService')).toBe('cr:service:OrderService');
        });

        it('should preserve case for envvar (POSIX case-sensitive)', () => {
            expect(buildUrn('envvar', 'DB_HOST')).toBe('cr:envvar:DB_HOST');
            expect(buildUrn('envvar', 'db_host')).toBe('cr:envvar:db_host');
        });

        it('should preserve case for channel (Kafka/RabbitMQ case-sensitive)', () => {
            expect(buildUrn('channel', 'Order.Created')).toBe('cr:channel:Order.Created');
        });

        it('should pass through segments containing / verbatim (no encoding)', () => {
            expect(buildUrn('sourcefile', 'acme-repo', 'src/Controller.ts'))
                .toBe('cr:sourcefile:acme-repo:src/Controller.ts');
        });

        it('should pass through segments containing :: and / verbatim', () => {
            expect(buildUrn('function', 'acme-repo', 'typescript', 'src/utils/math::calculateTotal'))
                .toBe('cr:function:acme-repo:typescript:src/utils/math::calculateTotal');
        });

        it('should handle multi-segment URNs for normalised types', () => {
            expect(buildUrn('datacontainer', 'Schema', 'Orders')).toBe('cr:datacontainer:schema:orders');
        });

        it('should handle endpoint URNs with method and path', () => {
            expect(buildUrn('endpoint', 'emergent', 'GET', '/api/users'))
                .toBe('cr:endpoint:emergent:GET:/api/users');
        });

        it('should handle schema field URNs', () => {
            expect(buildUrn('schema', 'database_table', 'orders', 'field', 'id'))
                .toBe('cr:schema:database_table:orders:field:id');
        });

        it('should handle package URNs with scoped names', () => {
            expect(buildUrn('package', 'npm', '@acme/utils'))
                .toBe('cr:package:npm:@acme/utils');
        });
    });

    // ─── normalizeResourceName ────────────────────────────────────────────

    describe('normalizeResourceName', () => {

        it('should lowercase names for case-insensitive types', () => {
            expect(normalizeResourceName('datacontainer', 'Operations')).toBe('operations');
            expect(normalizeResourceName('datastore', 'MySQL')).toBe('mysql');
            expect(normalizeResourceName('systemprocess', 'Worker')).toBe('worker');
        });

        it('should preserve names for case-sensitive types', () => {
            expect(normalizeResourceName('service', 'OrderService')).toBe('OrderService');
            expect(normalizeResourceName('envvar', 'DB_HOST')).toBe('DB_HOST');
            expect(normalizeResourceName('channel', 'Order.Created')).toBe('Order.Created');
        });
    });

    // ─── buildFunctionSignature ───────────────────────────────────────────
    //
    // DESIGN INVARIANT: Position-free URNs for unambiguous names
    //
    // Source positions are NOT part of the identity when nameIsAmbiguous=false.
    // The language plugin owns the decision — urn.ts is language-agnostic.
    // This eliminates two classes of false tombstones:
    //   1. "Body growth" bug: endLine → function grows/shrinks
    //   2. "Import shift" bug: startLine → lines added before the function
    //
    // When nameIsAmbiguous=true, @L{start}:C{col} is appended as a tiebreaker.

    describe('buildFunctionSignature', () => {
        describe('TypeScript / JavaScript', () => {
            it('produces position-free URN for named top-level functions', () => {
                const sig = buildFunctionSignature('calculateTotal', 'src/utils/math.ts', 'typescript', LOC);
                expect(sig).toBe('src/utils/math::calculateTotal');
            });

            it('produces position-free URN for named class methods', () => {
                const sig = buildFunctionSignature('process', 'src/services/OrderService.ts', 'typescript', LOC);
                expect(sig).toBe('src/services/OrderService::process');
            });

            it('handles index.ts files by retaining the directory path', () => {
                const sig = buildFunctionSignature('render', 'src/components/Button/index.tsx', 'javascript', LOC);
                expect(sig).toBe('src/components/Button/index::render');
            });

            it('works without a directory', () => {
                const sig = buildFunctionSignature('init', 'main.ts', 'typescript', LOC);
                expect(sig).toBe('main::init');
            });

            // ── nameIsAmbiguous=true: position suffix as tiebreaker ────────
            // The language plugin sets this when the name may not be unique
            // (anonymous callbacks, call-arg derived names like forEach_callback,
            //  it_does X, etc.). urn.ts uses the flag as-is — no name inspection.
            it('nameIsAmbiguous=true: retains position for anonymous fallback', () => {
                const first = buildFunctionSignature('anonymous', 'src/service.ts', 'typescript',
                    { startLine: 10, startColumn: 5, endLine: 12, endColumn: 2 }, true);
                const second = buildFunctionSignature('anonymous', 'src/service.ts', 'typescript',
                    { startLine: 20, startColumn: 5, endLine: 22, endColumn: 2 }, true);
                expect(first).not.toBe(second);
                expect(first).toBe('src/service::anonymous@L10:C5');
                expect(second).toBe('src/service::anonymous@L20:C5');
            });

            it('nameIsAmbiguous=true: retains position for forEach_callback (two forEach in same file)', () => {
                // arr.forEach(fn) AND results.forEach(fn) → both "forEach_callback"
                const first = buildFunctionSignature('forEach_callback', 'src/processor.ts', 'typescript',
                    { startLine: 15, startColumn: 4, endLine: 18, endColumn: 2 }, true);
                const second = buildFunctionSignature('forEach_callback', 'src/processor.ts', 'typescript',
                    { startLine: 30, startColumn: 4, endLine: 33, endColumn: 2 }, true);
                expect(first).not.toBe(second);
                expect(first).toBe('src/processor::forEach_callback@L15:C4');
            });

            it('nameIsAmbiguous=true: retains position for it_does X (two describe blocks, same it label)', () => {
                const a = buildFunctionSignature('it_does X', 'tests/suite.ts', 'typescript',
                    { startLine: 5, startColumn: 8, endLine: 7, endColumn: 4 }, true);
                const b = buildFunctionSignature('it_does X', 'tests/suite.ts', 'typescript',
                    { startLine: 15, startColumn: 8, endLine: 17, endColumn: 4 }, true);
                expect(a).not.toBe(b);
                expect(a).toBe('tests/suite::it_does X@L5:C8');
            });

            it('nameIsAmbiguous=false (default): class methods are position-free and stable across import shifts', () => {
                const before = buildFunctionSignature('OrderService.process', 'src/OrderService.ts', 'typescript',
                    { startLine: 10, startColumn: 4, endLine: 20, endColumn: 5 });
                const shifted = buildFunctionSignature('OrderService.process', 'src/OrderService.ts', 'typescript',
                    { startLine: 12, startColumn: 4, endLine: 22, endColumn: 5 });
                expect(before).toBe(shifted);
                expect(before).toBe('src/OrderService::OrderService.process');
            });

            // ── REGRESSION 1: body growth (endLine change) ────────────────
            it('REGRESSION body-growth: same URN when function body grows (endLine changes)', () => {
                const stub = buildFunctionSignature(
                    'SystemEventService.emit',
                    'src/SystemEventService.ts',
                    'typescript',
                    { startLine: 21, startColumn: 5, endLine: 24, endColumn: 6 },
                );
                const full = buildFunctionSignature(
                    'SystemEventService.emit',
                    'src/SystemEventService.ts',
                    'typescript',
                    { startLine: 21, startColumn: 5, endLine: 39, endColumn: 6 },
                );
                expect(stub).toBe(full);
                expect(stub).toBe('src/SystemEventService::SystemEventService.emit');
            });

            // ── REGRESSION 2: import shift (startLine change) ─────────────
            // If a dev adds 2 imports before the class, startLine shifts.
            // The function must retain its identity.
            it('REGRESSION import-shift: same URN when lines are added before the function', () => {
                const before = buildFunctionSignature(
                    'OrderService.process',
                    'src/services/OrderService.ts',
                    'typescript',
                    { startLine: 10, startColumn: 4, endLine: 20, endColumn: 5 },
                );
                const afterImportAdded = buildFunctionSignature(
                    'OrderService.process',
                    'src/services/OrderService.ts',
                    'typescript',
                    { startLine: 12, startColumn: 4, endLine: 22, endColumn: 5 },  // shifted by 2 import lines
                );
                expect(before).toBe(afterImportAdded);
                expect(before).toBe('src/services/OrderService::OrderService.process');
            });
        });

        describe('PHP', () => {
            it('passes through fully qualified names — position-free', () => {
                const sig = buildFunctionSignature('App\\Http\\Controllers\\UserController::store', 'app/Http/Controllers/UserController.php', 'php', LOC);
                expect(sig).toBe('App\\Http\\Controllers\\UserController::store');
            });

            it('passes through namespaced functions — position-free', () => {
                const sig = buildFunctionSignature('App\\Helpers\\calculate', 'src/Calculator.php', 'php', LOC);
                expect(sig).toBe('App\\Helpers\\calculate');
            });

            it('formats standalone PHP functions with basename prefix — position-free by default', () => {
                // With the explicit nameIsAmbiguous parameter design, urn.ts does
                // NOT inspect the name. helper_function is position-free unless
                // the PHP plugin explicitly sets nameIsAmbiguous=true on the chunk.
                const sig = buildFunctionSignature('helper_function', 'src/helpers.php', 'php', LOC);
                expect(sig).toBe('helpers::helper_function');
            });

            it('formats standalone PHP functions with position when nameIsAmbiguous=true', () => {
                const sig = buildFunctionSignature('helper_function', 'src/helpers.php', 'php', LOC, true);
                expect(sig).toBe('helpers::helper_function@L1:C1');
            });
        });

        describe('Other Languages (Fallback)', () => {
            it('formats Python methods with basename — position-free', () => {
                const sig = buildFunctionSignature('Start', 'cmd/server/main.py', 'python', LOC);
                expect(sig).toBe('main::Start');
            });

            it('formats Go functions with basename — position-free', () => {
                const sig = buildFunctionSignature('main', 'cmd/server/main.go', 'go', LOC);
                expect(sig).toBe('main::main');
            });
        });
    });
});
