export class QueryExecutor {
    async runMigration() {
        // We embed complex SQL directly to test the LLM's understanding of CTEs and multiple statements
        const sql = `
            WITH recent_users AS (
                SELECT id, name FROM users WHERE created_at > '2024-01-01'
            ),
            archived_orders AS (
                SELECT user_id, total FROM orders_archive WHERE status = 'shipped'
            )
            INSERT INTO audit_log (user_id, action)
            SELECT ru.id, 'migrated_orders'
            FROM recent_users ru
            JOIN archived_orders ao ON ru.id = ao.user_id;
        `;
        await this.db.execute(sql);
    }
}
