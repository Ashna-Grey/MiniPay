import type { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
export async function applyMigrations(pool: Pool, dir = join(__dirname, '..', 'migrations')) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY)');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if ((await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) continue;
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(readFileSync(join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await ensureSystemWallet(pool);
}
export async function ensureSystemWallet(pool: Pool) {
  // Ledger counter-party for simulated funding. Cannot log in (hash is not a valid argon2 string).
  const u = await pool.query(`INSERT INTO users(email,username,password_hash,role) VALUES('system@minipay.invalid','__system_funding__','!','USER') ON CONFLICT DO NOTHING RETURNING id`);
  if (u.rowCount) await pool.query('INSERT INTO wallets(user_id) VALUES($1)', [u.rows[0].id]);
}
