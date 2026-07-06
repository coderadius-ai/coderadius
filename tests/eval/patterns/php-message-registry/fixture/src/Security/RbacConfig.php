<?php
namespace Acme\Security;

/**
 * Negative control: this file maps CQRS classes to dot-delimited strings, but
 * the strings are permission paths, NOT message topics. The extractor's
 * file-context gate (`isLikelyMessagingConfig`) must reject this file:
 *   - No Symfony Messenger / AMQP / Enqueue use statement
 *   - Namespace is `Acme\Security` (no messaging-related token)
 *   - Class name is `RbacConfig` (no messaging-related token)
 */
class RbacConfig
{
    public function permissions(): array
    {
        return [
            CreateOrderCommand::class => 'security.permission.admin',
            DeleteUserCommand::class  => 'audit.event.user_deleted',
        ];
    }
}
