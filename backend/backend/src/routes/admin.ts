import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ah, me } from '../middleware';
import { HttpError } from '../errors';
import { reconcile } from '../services/payments';

const page = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) });
const like = (s: string) => `%${s.replace(/[%_\\]/g, '\\$&')}%`;
const SECURITY = ['LOGIN_FAILED', 'REFRESH_TOKEN_REUSE', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'PASSWORD_CHANGED', 'ADMIN_USER_SUSPENDED', 'ADMIN_USER_REACTIVATED'];
const SYS = '__system_funding__';

export function adminRoutes(pool: Pool) {
  const r = Router();
  // Deliberately NO routes that edit transactions, ledger entries or balances.

  r.get('/users', ah(async (req, res) => {
    const q = page.extend({ q: z.string().max(100).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() }).parse(req.query);
    const p: unknown[] = [SYS]; const w = ['u.username <> $1'];
    if (q.q) { p.push(like(q.q)); w.push(`(u.email ILIKE $${p.length} OR u.username ILIKE $${p.length} OR u.full_name ILIKE $${p.length})`); }
    if (q.status) { p.push(q.status); w.push(`u.status=$${p.length}`); }
    const W = w.join(' AND ');
    const total = (await pool.query(`SELECT count(*)::int c FROM users u WHERE ${W}`, p)).rows[0].c;
    p.push(q.limit, (q.page - 1) * q.limit);
    const items = (await pool.query(`SELECT u.id,u.email,u.username,u.full_name AS "fullName",u.role,u.status,u.created_at AS "createdAt",w.balance_paise::text AS "balancePaise"
      FROM users u JOIN wallets w ON w.user_id=u.id WHERE ${W} ORDER BY u.created_at DESC, u.id LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    res.json({ items, page: q.page, limit: q.limit, total });
  }));

  r.patch('/users/:id/status', ah(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    const b = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(200).regex(/^[^<>\u0000-\u001f]*$/) }).strict().parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const t = (await c.query('SELECT id,role,status FROM users WHERE id=$1 AND username <> $2 FOR UPDATE', [id.data, SYS])).rows[0];
      if (!t) throw new HttpError(404, 'NOT_FOUND', 'User not found');
      if (t.role === 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Administrator accounts cannot be changed here');
      const changed = t.status !== b.status;
      if (changed) {
        await c.query('UPDATE users SET status=$1 WHERE id=$2', [b.status, t.id]);
        if (b.status === 'SUSPENDED') await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [t.id]);
        await c.query('INSERT INTO audit_logs(actor_user_id,action,target,metadata,ip) VALUES($1,$2,$3,$4,$5)',
          [me(res).id, b.status === 'SUSPENDED' ? 'ADMIN_USER_SUSPENDED' : 'ADMIN_USER_REACTIVATED', t.id, { reason: b.reason }, req.ip]);
      }
      await c.query('COMMIT');
      res.json({ id: t.id, status: b.status, changed });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

  const TX = `SELECT t.id,t.type,t.status,t.amount_paise::text AS "amountPaise",t.description,t.created_at AS "createdAt",
    CASE WHEN su.username=$1 THEN 'MiniPay funding' ELSE su.username END AS sender, ru.username AS receiver
    FROM transactions t JOIN wallets sw ON sw.id=t.sender_wallet_id JOIN users su ON su.id=sw.user_id
    JOIN wallets rw ON rw.id=t.receiver_wallet_id JOIN users ru ON ru.id=rw.user_id`;
  r.get('/transactions', ah(async (req, res) => {
    const q = page.extend({ status: z.enum(['COMPLETED', 'FAILED']).optional(), type: z.enum(['TRANSFER', 'FUNDING']).optional(),
      from: z.coerce.date().optional(), to: z.coerce.date().optional(), q: z.string().max(100).optional() }).parse(req.query);
    const p: unknown[] = [SYS]; const w: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replaceAll('?', `$${p.length}`)); };
    if (q.status) add('t.status=?', q.status); if (q.type) add('t.type=?', q.type);
    if (q.from) add('t.created_at>=?', q.from); if (q.to) add('t.created_at<=?', q.to);
    if (q.q) add('(t.id::text ILIKE ? OR t.description ILIKE ? OR su.username ILIKE ? OR ru.username ILIKE ?)', like(q.q));
    const W = w.length ? w.join(' AND ') : 'TRUE';
    const total = (await pool.query(`SELECT count(*)::int c FROM transactions t JOIN wallets sw ON sw.id=t.sender_wallet_id JOIN users su ON su.id=sw.user_id JOIN wallets rw ON rw.id=t.receiver_wallet_id JOIN users ru ON ru.id=rw.user_id WHERE ${W} AND $1::text IS NOT NULL`, p)).rows[0].c;
    p.push(q.limit, (q.page - 1) * q.limit);
    res.json({ items: (await pool.query(`${TX} WHERE ${W} ORDER BY t.created_at DESC, t.id LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows, page: q.page, limit: q.limit, total });
  }));
  r.get('/transactions/:id', ah(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'NOT_FOUND', 'Transaction not found');
    const t = (await pool.query(`${TX} WHERE t.id=$2`, [SYS, id.data])).rows[0];
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Transaction not found');
    const ledger = (await pool.query(`SELECT l.id,l.direction,l.amount_paise::text AS "amountPaise",CASE WHEN u.username=$2 THEN 'MiniPay funding' ELSE u.username END AS wallet
      FROM ledger_entries l JOIN wallets w ON w.id=l.wallet_id JOIN users u ON u.id=w.user_id WHERE l.transaction_id=$1 ORDER BY l.id`, [id.data, SYS])).rows;
    res.json({ ...t, ledger });
  }));

  r.get('/analytics', ah(async (_q, res) => {
    const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
    const users = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='ACTIVE')::int AS active, count(*) FILTER (WHERE status='SUSPENDED')::int AS suspended FROM users WHERE username<>$1`, [SYS]);
    const tx = await one(`SELECT count(*) FILTER (WHERE type='TRANSFER')::int AS "transferCount",
      COALESCE(SUM(amount_paise) FILTER (WHERE type='TRANSFER' AND status='COMPLETED'),0)::text AS "transferVolumePaise",
      COALESCE(SUM(amount_paise) FILTER (WHERE type='FUNDING' AND status='COMPLETED'),0)::text AS "fundingVolumePaise" FROM transactions`);
    const daily = (await pool.query(`SELECT to_char(d,'YYYY-MM-DD') AS date, COALESCE(SUM(t.amount_paise),0)::text AS "volumePaise", count(t.id)::int AS count
      FROM generate_series(current_date-29, current_date, interval '1 day') d
      LEFT JOIN transactions t ON t.type='TRANSFER' AND t.status='COMPLETED' AND t.created_at>=d AND t.created_at<d+interval '1 day' GROUP BY d ORDER BY d`)).rows;
    const rec = await reconcile(pool);
    res.json({ users, ...tx, dailyTransfers: daily, ledgerBalanced: rec.mismatches.length === 0 && rec.globalNet === '0' });
  }));

  const logs = (fixed?: string[]) => ah(async (req, res) => {
    const q = page.extend({ action: z.string().max(60).optional(), actor: z.string().max(100).optional() }).parse(req.query);
    const p: unknown[] = []; const w: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replaceAll('?', `$${p.length}`)); };
    if (fixed) add('a.action = ANY(?)', fixed); if (q.action) add('a.action=?', q.action); if (q.actor) add('u.username ILIKE ?', like(q.actor));
    const W = w.length ? w.join(' AND ') : 'TRUE';
    const from = `FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE ${W}`;
    const total = (await pool.query(`SELECT count(*)::int c ${from}`, p)).rows[0].c;
    p.push(q.limit, (q.page - 1) * q.limit);
    const items = (await pool.query(`SELECT a.id,a.action,a.target,a.metadata,a.ip,a.created_at AS "createdAt",u.username AS actor ${from} ORDER BY a.id DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    res.json({ items, page: q.page, limit: q.limit, total });
  });
  r.get('/audit-logs', logs());
  r.get('/security-events', logs(SECURITY));
  return r;
}
