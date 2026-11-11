import type { Pool } from 'pg';
import { z } from 'zod';
import { email, password, username } from '../schemas';
import { hashPassword } from './auth';

/** Creates an admin account (with wallet). Idempotent on email/username. Password policy is enforced. */
export async function createAdmin(pool: Pool, i: { email: string; username: string; password: string }) {
  const v = z.object({ email, username, password }).parse(i);
  const hash = await hashPassword(v.password);
  const u = await pool.query(`INSERT INTO users(email,username,password_hash,role) VALUES($1,$2,$3,'ADMIN') ON CONFLICT DO NOTHING RETURNING id`, [v.email, v.username, hash]);
  if (!u.rowCount) return { created: false };
  await pool.query('INSERT INTO wallets(user_id) VALUES($1)', [u.rows[0].id]);
  await pool.query(`INSERT INTO audit_logs(actor_user_id,action) VALUES($1,'ADMIN_CREATED')`, [u.rows[0].id]);
  return { created: true };
}
