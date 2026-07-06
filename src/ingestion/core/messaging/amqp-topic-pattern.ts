/**
 * AMQP topic binding-key → anchored regex compile.
 *
 * Single canonical implementation: previously lived in
 * graph/mutations/data-contracts.ts with a duplicated local mirror in the
 * rabbitmq structural plugin (kept there to avoid pulling the mutation layer
 * into plugins). Messaging-domain logic belongs here, where both the plugin
 * and any resolver can import it without layering violations.
 */
export function compileAmqpTopicPattern(bindingKey: string): { regex: string; isPattern: boolean } {
    const isPattern = bindingKey.includes('#') || bindingKey.includes('*');
    // Escape regex metacharacters first, then replace AMQP wildcards.
    const escaped = bindingKey.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // CRITICAL ORDER: substitute `*` BEFORE `#`, because the replacement of `#`
    // introduces literal `.*` regex tokens whose `*` would otherwise be consumed
    // by the `*` replacement step.
    let pattern = escaped.replace(/\*/g, '[^.]+');
    // `\.#` → optional `.<anything>` so `acme.order.#` matches both
    // `acme.order` (zero segments) and `acme.order.foo.bar` (N segments).
    pattern = pattern.replace(/\\\.#/g, '(\\..*)?');
    // Bare leading `#` (e.g. `#.foo`) matches "zero or more leading segments".
    pattern = pattern.replace(/^#\\\./g, '(.*\\.)?');
    // Any remaining `#` is treated as match-anything.
    pattern = pattern.replace(/#/g, '.*');
    return { regex: `^${pattern}$`, isPattern };
}
