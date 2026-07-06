<?php

namespace App\GraphQL\Resolvers;

/**
 * Lighthouse-style GraphQL resolver using PHP 8.1 attributes.
 * #[Query] and #[Mutation] are parsed as attributes on the method —
 * visible in the full chunk text without any chunker change.
 */
class NotificationResolver
{
    #[Query]
    public function notifications(mixed $root, array $args): array
    {
        $db = new \PDO(getenv('NOTIFICATIONS_DB_DSN'));
        $stmt = $db->prepare(
            'SELECT * FROM notifications WHERE recipient_id = :rid ORDER BY created_at DESC'
        );
        $stmt->execute(['rid' => $args['recipientId']]);
        return $stmt->fetchAll(\PDO::FETCH_ASSOC);
    }

    #[Mutation]
    public function markAsRead(mixed $root, array $args): array
    {
        $db = new \PDO(getenv('NOTIFICATIONS_DB_DSN'));
        $stmt = $db->prepare(
            'UPDATE notifications SET status = :s, updated_at = NOW() WHERE id = :id RETURNING *'
        );
        $stmt->execute(['s' => 'read', 'id' => $args['notificationId']]);
        return $stmt->fetch(\PDO::FETCH_ASSOC);
    }
}
