import { Pool } from 'pg';

// Contrast: a classic RDBMS via a DSN URL. Proves the influx URL recognition is
// selective and does not poison the standard postgres:// path.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function countOrders(): Promise<number> {
    const res = await pool.query('SELECT count(*) AS c FROM orders');
    return Number(res.rows[0].c);
}
