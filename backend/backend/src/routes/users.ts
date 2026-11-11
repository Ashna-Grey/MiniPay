import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ah, me } from '../middleware';
import { changePassword } from '../services/auth';
import { password } from '../schemas';

export function userRoutes(pool: Pool) {
  const r = Router();
  r.get('/me', ah(async (_q, res) => {
    const u = (await pool.query(`SELECT u.id,u.email,u.username,u.full_name AS "fullName",u.role,u.status,u.created_at AS "createdAt",w.id AS "walletId" FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=$1`, [me(res).id])).rows[0];
    const sessions = (await pool.query(`SELECT created_at AS "startedAt", ip, user_agent AS "userAgent" FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 10`, [me(res).id])).rows;
    res.json({ ...u, sessions });
  }));
  r.patch('/me', ah(async (req, res) => {
    const b = z.object({ fullName: z.string().trim().max(80).regex(/^[^<>]*$/) }).strict().parse(req.body);
    await pool.query('UPDATE users SET full_name=$1 WHERE id=$2', [b.fullName, me(res).id]); res.status(204).end();
  }));
  r.post('/me/password', ah(async (req, res) => {
    const b = z.object({ currentPassword: z.string().max(128), newPassword: password }).strict().parse(req.body);
    await changePassword(pool, me(res).id, b.currentPassword, b.newPassword); res.status(204).end();
  }));
  // Exact-match lookup only (username or email) to prevent directory scraping; email is never echoed back.
  r.get('/search', ah(async (req, res) => {
    const q = z.string().trim().toLowerCase().min(3).max(254).parse(req.query.q);
    const rows = (await pool.query(`SELECT username, full_name AS "fullName" FROM users WHERE (username=$1 OR email=$1) AND status='ACTIVE' AND username <> '__system_funding__' AND id <> $2 LIMIT 1`, [q, me(res).id])).rows;
    res.json({ items: rows });
  }));
  return r;
}
