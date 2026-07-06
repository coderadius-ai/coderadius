/**
 * Published PHP framework DI-handle shapes (Symfony / Doctrine / Laminas).
 *
 * A dotted id whose FIRST segment is a published framework DI namespace
 * (`doctrine.entitymanager.orm_default`, `messenger.bus.command`) is a
 * container-service id, never a physical table/collection/channel. Anchored
 * on the published namespace: customer routing keys
 * (`acme.catalog.delete.request`) have domain first segments and survive;
 * underscore ids (`cache_acl`) are NOT this shape and are handled by
 * evidence-based guards instead.
 *
 * Channel-only conventions (a `*_transport` TABLE like `shipment_transport`
 * is plausible, so these never apply to containers):
 *   - Laminas RabbitMqModule service aliases (published module contract):
 *     `rabbitmq.producer.<name>` / `rabbitmq.consumer.<name>`. The alias is
 *     the DI handle; the physical exchange/queue lives in the module config.
 *   - Symfony Messenger snake-case transport ids (`email_direct_transport`):
 *     the TRANSPORT is the DI handle; the physical exchange/queue lives in
 *     its options.
 *
 * This is PHP-ecosystem grammar: it lives here, behind the
 * `LanguagePlugin.recognizesFrameworkDiHandle` hook, never in the
 * language-agnostic name-safety module. A Node.js service may legitimately
 * own a Kafka topic named `messenger.events.dispatched`.
 */

import type { FrameworkDiHandleKind } from '../types.js';

const FRAMEWORK_DI_NAMESPACES = new Set([
    'doctrine', 'messenger', 'cache', 'monolog', 'serializer', 'validator',
    'twig', 'security', 'framework', 'router', 'translator', 'form',
]);

const RABBITMQ_MODULE_ALIAS_RE = /^rabbitmq\.(producer|consumer)\./i;
const MESSENGER_TRANSPORT_SUFFIX_RE = /_transport$/i;

/**
 * Doctrine ORM/ODM accessor class tokens as the FINAL segment of a dotted DI
 * key (`archive.mongodb.documentmanager`): the key resolves the Doctrine
 * manager object, never a logical data container. Container-only: the
 * generic English handle vocabulary (client/manager/connection/...) stays in
 * the agnostic DI_HANDLE_KEY_SUFFIXES; these are ORM-brand class names.
 */
const DOCTRINE_HANDLE_FINAL_SEGMENTS = new Set(['entitymanager', 'documentmanager']);

export function phpRecognizesFrameworkDiHandle(name: string, kind: FrameworkDiHandleKind): boolean {
    const parts = name.trim().toLowerCase().split('.');
    if (parts.length >= 2 && FRAMEWORK_DI_NAMESPACES.has(parts[0])) return true;
    if (kind === 'channel') {
        if (RABBITMQ_MODULE_ALIAS_RE.test(name)) return true;
        if (MESSENGER_TRANSPORT_SUFFIX_RE.test(name)) return true;
    }
    if (kind === 'container'
        && parts.length >= 2
        && DOCTRINE_HANDLE_FINAL_SEGMENTS.has(parts[parts.length - 1])) {
        return true;
    }
    return false;
}
