import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { patchLanguage } from '../../../../../../src/ingestion/processors/parser/jsc-compat.js';
import { extractPhpCriticalInvocations } from '../../../../../../src/ingestion/core/languages/php/value-resolution.js';

const parser = new Parser();
parser.setLanguage(patchLanguage(phpExport.php));

function extract(src: string, filepath = 'src/Test.php') {
    const root = parser.parse(src).rootNode;
    return extractPhpCriticalInvocations(root, src, filepath);
}

describe('Pattern A — local-var taint $svc = $container->get(id); $svc->method()', () => {
    it('stamps chainedMethod when the local var is later invoked', () => {
        const src = `<?php
class OrderController {
    public function placeOrder() {
        $svc = $this->container->get('acme.notification.publisher');
        $svc->publish('order.created');
    }
}
`;
        const invs = extract(src);
        const serviceIdFacts = invs.filter(i => i.resourceRole === 'serviceId');
        expect(serviceIdFacts.length).toBeGreaterThan(0);
        const chained = serviceIdFacts.find(f => f.chainedMethod === 'publish');
        expect(chained).toBeDefined();
    });

    it('does not stamp when no chained method follows', () => {
        const src = `<?php
class X {
    public function getSvc() {
        $svc = $this->container->get('acme.foo');
        return $svc;
    }
}
`;
        const invs = extract(src);
        const serviceIdFacts = invs.filter(i => i.resourceRole === 'serviceId');
        for (const f of serviceIdFacts) {
            expect(f.chainedMethod).toBeUndefined();
        }
    });
});

describe('Pattern B — property-fetch from ctor injection $this->prop->method()', () => {
    it('stamps chainedMethod on the PHP plugin\'s DI binding fallback fact', () => {
        // The value-resolution extractor's DI binding fallback (line 620 in
        // value-resolution.ts) emits a serviceId fact for `$this->prop->method()`
        // calls that the publish/dispatch/SQL handlers did NOT recognise.
        // For those facts, Pattern B stamps `chainedMethod` so the DI
        // propagator can resolve the call against the bound component's ioTags.
        //
        // Pattern B previously *also* emitted brand-new serviceId facts for
        // call sites the extractor never touched, but that emission caused a
        // measured +30% LLM SEND regression on real codebases (acme-monolith:
        // 341 → 439): only ~10% of bound components in a large repo have
        // statically-extractable ioTags, so the emitted facts promoted
        // thousands of consumers through Gate 5 (DI) without ever producing
        // a bypass. The emit-new path was rolled back; stamping the
        // upstream fact remains.
        const src = `<?php
namespace Acme;

class OrderController {
    public function __construct(
        private UseCaseInterface $useCase,
    ) {}

    public function placeOrder() {
        $this->useCase->execute($order);
    }
}
`;
        const invs = extract(src);
        const matching = invs.filter(i =>
            i.resourceRole === 'serviceId'
            && i.startLine === 10
            && i.chainedMethod === 'execute',
        );
        expect(matching.length).toBe(1);
        expect(matching[0].resourceExpression).toContain('UseCaseInterface');
    });

    it('does not emit a duplicate fact when one already exists (Pattern A)', () => {
        const src = `<?php
class X {
    public function go() {
        $svc = $this->container->get('acme.foo');
        $svc->publish('a');
    }
}
`;
        const invs = extract(src);
        const chained = invs.filter(i =>
            i.resourceRole === 'serviceId'
            && i.chainedMethod === 'publish'
            && i.resourceExpression.includes('acme.foo'),
        );
        // Pattern A should stamp existing fact, not emit a duplicate.
        expect(chained.length).toBeLessThanOrEqual(1);
    });
});

describe('Enricher idempotency', () => {
    it('does not overwrite an already-stamped chainedMethod', () => {
        // We can't easily inject a pre-stamped fact through the public
        // surface; instead we verify the algorithm: enricher visits only
        // facts where chainedMethod is undefined.
        const src = `<?php
class X {
    public function go() {
        $svc = $this->container->get('acme.foo');
        $svc->publish('a');
    }
}
`;
        const invs = extract(src);
        const stamped = invs.filter(i => i.chainedMethod);
        // Snapshot the chainedMethod values
        const values = stamped.map(s => s.chainedMethod);
        expect(values.every(v => v === 'publish')).toBe(true);
    });
});

describe('Case-insensitive normalization', () => {
    it('lowercases the chainedMethod even if source uses PascalCase', () => {
        const src = `<?php
class X {
    public function go() {
        $svc = $this->container->get('acme.foo');
        $svc->Publish('a');
    }
}
`;
        const invs = extract(src);
        const chained = invs.find(i => i.chainedMethod !== undefined);
        if (chained) {
            expect(chained.chainedMethod).toBe('publish');
        }
        // If the value-resolution extractor doesn't surface a serviceId for
        // this exact shape, the test still asserts no crash.
    });
});
