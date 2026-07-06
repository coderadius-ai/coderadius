<?php

namespace App\GraphQL;

use GraphQL\Type\Definition\ObjectType;
use GraphQL\Type\Definition\Type;
use GraphQL\Type\Schema;

class NotificationSchema
{
    /**
     * Builds and returns the GraphQL schema for the Notification Service.
     * Exposes queries for fetching notifications and mutations for marking as read.
     */
    public function buildSchema(): Schema
    {
        $notificationType = new ObjectType([
            'name' => 'Notification',
            'fields' => [
                'id' => Type::nonNull(Type::string()),
                'recipientId' => Type::nonNull(Type::string()),
                'message' => Type::string(),
                'channel' => Type::string(),
                'status' => Type::string(),
                'createdAt' => Type::string(),
            ],
        ]);

        $queryType = new ObjectType([
            'name' => 'Query',
            'fields' => [
                'notifications' => [
                    'type' => Type::listOf($notificationType),
                    'args' => [
                        'recipientId' => Type::nonNull(Type::string()),
                        'limit' => ['type' => Type::int(), 'defaultValue' => 20],
                    ],
                    'resolve' => function ($root, $args) {
                        return $this->fetchNotifications($args['recipientId'], $args['limit']);
                    },
                ],
            ],
        ]);

        $mutationType = new ObjectType([
            'name' => 'Mutation',
            'fields' => [
                'markAsRead' => [
                    'type' => $notificationType,
                    'args' => [
                        'notificationId' => Type::nonNull(Type::string()),
                    ],
                    'resolve' => function ($root, $args) {
                        return $this->markNotificationAsRead($args['notificationId']);
                    },
                ],
            ],
        ]);

        return new Schema([
            'query' => $queryType,
            'mutation' => $mutationType,
        ]);
    }

    /**
     * Fetches notifications from the database for a given recipient.
     */
    private function fetchNotifications(string $recipientId, int $limit): array
    {
        $db = new \PDO(getenv('NOTIFICATIONS_DB_DSN'));
        $stmt = $db->prepare('SELECT * FROM notifications WHERE recipient_id = :rid ORDER BY created_at DESC LIMIT :lim');
        $stmt->execute(['rid' => $recipientId, 'lim' => $limit]);
        return $stmt->fetchAll(\PDO::FETCH_ASSOC);
    }

    /**
     * Marks a notification as read in the database.
     */
    private function markNotificationAsRead(string $notificationId): array
    {
        $db = new \PDO(getenv('NOTIFICATIONS_DB_DSN'));
        $stmt = $db->prepare('UPDATE notifications SET status = :status WHERE id = :id');
        $stmt->execute(['status' => 'read', 'id' => $notificationId]);

        $result = $db->prepare('SELECT * FROM notifications WHERE id = :id');
        $result->execute(['id' => $notificationId]);
        return $result->fetch(\PDO::FETCH_ASSOC);
    }
}
