// ═══════════════════════════════════════════════════════════════════════════════
// synthesizeDiCtorScalarFacts — DI ctor-scalar → wrapper-property value facts
//
// A DI factory often injects a config literal positionally into a wrapper:
//
//   'notpurchasable.publisher' => fn() => new PubSubPublisher(
//       new PubSubClient([...]), 'acme.dwh.not-purchasable', $logger)
//
// and the wrapper stores it (`$this->topic = $topic`) and uses it
// (`$this->pubSubClient->topic($this->topic)->publish(...)`). The publish
// accessor is already recognized, but `$this->topic` is unresolvable from the
// wrapper file alone (its value lives in the DI config). This joins the
// captured ctor scalar (position) to the bound component's ordered ctor params
// (name) and emits a literal ValueFact keyed by the PARAM NAME in the
// component's file. The existing `$this->topic = $topic` alias fact then
// resolves `$this->topic` to the literal, so the accessor yields a grounded
// channel with NO LLM call.
//
// SCOPE GUARD (avoids the rolled-back "Pattern B" +30% LLM regression): this
// only ADDS resolution data for an already-emitted I/O invocation inside the
// bound component; it never emits a serviceId fact on a consumer. And it
// abstains when a component is constructed by more than one scalar-bearing
// binding (per-instance topic is ambiguous), so it cannot fabricate a value.
// ═══════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import type { RawDiBinding } from '../di-binding-providers/types.js';
import type { ComponentDefinition } from '../languages/types.js';
import type { ValueFact } from './types.js';
import type { CodeChunk } from '../../../graph/types.js';
import { getPluginForExtension } from '../languages/registry.js';
import { declaredGrounding } from '../../../graph/grounding.js';

export function synthesizeDiCtorScalarFacts(
    rawBindings: RawDiBinding[],
    componentDefinitions: ComponentDefinition[],
): ValueFact[] {
    // Group scalar-bearing bindings by the component they construct.
    const bindingsByComponent = new Map<string, RawDiBinding[]>();
    for (const b of rawBindings) {
        if (!b.boundComponent || !b.ctorScalars || b.ctorScalars.length === 0) continue;
        const list = bindingsByComponent.get(b.boundComponent) ?? [];
        list.push(b);
        bindingsByComponent.set(b.boundComponent, list);
    }
    if (bindingsByComponent.size === 0) return [];

    const componentByFqcn = new Map<string, ComponentDefinition>();
    for (const c of componentDefinitions) {
        if (!componentByFqcn.has(c.fqcn)) componentByFqcn.set(c.fqcn, c);
    }

    const facts: ValueFact[] = [];
    for (const [fqcn, bindings] of bindingsByComponent) {
        // Ambiguous: the same wrapper class built by N scalar-bearing bindings
        // has a per-instance value, so no single class-level literal is safe.
        if (bindings.length !== 1) continue;
        const def = componentByFqcn.get(fqcn);
        if (!def?.constructorParameterNames) continue;
        const params = def.constructorParameterNames;
        const language = languageForFile(def.file);

        for (const { position, value } of bindings[0].ctorScalars!) {
            const paramName = params[position];
            if (!paramName) continue;
            facts.push({
                filePath: def.file,
                language,
                key: paramName,
                expression: JSON.stringify(value),
                kind: 'literal',
                value,
                confidence: 1,
                grounding: declaredGrounding('di-ctor-arg-bind@v1'),
                startLine: 1,
                endLine: 1,
            });
        }
    }
    return facts;
}

function languageForFile(file: string): CodeChunk['language'] {
    const plugin = getPluginForExtension(path.extname(file));
    return (plugin?.language as CodeChunk['language']) ?? 'php';
}
