import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ah, me, idempotencyKey } from '../middleware';
import { transfer, PaymentError } from '../services/payments';
import { audit } from '../services/auth';
import { paise, description, MAX_TRANSFER } from '../schemas';
import { HttpError } from '../errors';
import { toCsv, inr } from '../csv';

const SELECT = `SELECT t.id, t.type, t.status, t.amount_paise::text AS "amountPaise", t.description, t.created_at AS "createdAt",
  CASE WHEN t.sender_wallet_id=$1 THEN 'SENT' ELSE 'RECEIVED' END AS direction,
  CASE WHEN su.username='__system_funding__' OR ru.username='__system_funding__' THEN 'MiniPay funding'
       WHEN t.sender_wallet_id=$1 THEN ru.username ELSE su.username END AS counterparty
  FROM transactions t JOIN wallets sw ON sw.id=t.sender_wallet_id JOIN users su ON su.id=sw.user_id
  JOIN wallets rw ON rw.id=t.receiver_wallet_id JOIN users ru ON ru.id=rw.user_id`;

export function paymentRoutes(pool: Pool) {
  const r = Router();
  const walletId = async (uid: string) => (await pool.query('SELECT id FROM wallets WHERE user_id=$1', [uid])).rows[0].id as string;

  r.post('/send', ah(async (req, res) => {
    const b = z.object({ recipient: z.string().trim().toLowerCase().min(3).max(254), amountPaise: paise(MAX_TRANSFER), description: description.optional() }).strict().parse(req.body);
    const rec = (await pool.query(`SELECT id FROM users WHERE (username=$1 OR email=$1) AND status='ACTIVE' AND username <> '__system_funding__'`, [b.recipient])).rows[0];
    if (!rec) throw new HttpError(404, 'RECIPIENT_NOT_FOUND', 'Recipient not found');
    const out = await transfer(pool, { senderUserId: me(res).id, receiverUserId: rec.id, amountPaise: b.amountPaise, description: b.description, idempotencyKey: idempotencyKey(req) });
    if (!out.duplicate) await audit(pool, me(res).id, 'TRANSFER', out.transactionId, undefined, req.ip);
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  r.get('/summary', ah(async (_q, res) => {
    const w = await walletId(me(res).id);
    const s = (await pool.query(`SELECT
      COALESCE(SUM(amount_paise) FILTER (WHERE type='TRANSFER' AND sender_wallet_id=$1),0)::text AS "totalSentPaise",
      COALESCE(SUM(amount_paise) FILTER (WHERE type='TRANSFER' AND receiver_wallet_id=$1),0)::text AS "totalReceivedPaise",
      COALESCE(SUM(amount_paise) FILTER (WHERE type='FUNDING' AND receiver_wallet_id=$1),0)::text AS "totalFundedPaise",
      COALESCE(SUM(amount_paise) FILTER (WHERE type='TRANSFER' AND sender_wallet_id=$1 AND created_at>=date_trunc('month',now())),0)::text AS "spentThisMonthPaise"
      FROM transactions WHERE status='COMPLETED' AND (sender_wallet_id=$1 OR receiver_wallet_id=$1)`, [w])).rows[0];
    res.json(s);
  }));

  const filters = z.object({
    direction: z.enum(['SENT', 'RECEIVED']).optional(), status: z.enum(['COMPLETED', 'FAILED']).optional(),
    from: z.coerce.date().optional(), to: z.coerce.date().optional(), q: z.string().max(100).optional(),
  });
  const buildWhere = (q: z.infer<typeof filters>, w: string) => {
    const where = ['(t.sender_wallet_id=$1 OR t.receiver_wallet_id=$1)']; const p: unknown[] = [w];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replaceAll('?', `$${p.length}`)); };
    if (q.direction === 'SENT') where.push('t.sender_wallet_id=$1'); if (q.direction === 'RECEIVED') where.push('t.receiver_wallet_id=$1');
    if (q.status) add('t.status=?', q.status); if (q.from) add('t.created_at>=?', q.from); if (q.to) add('t.created_at<=?', q.to);
    if (q.q) add('(t.description ILIKE ? OR t.id::text ILIKE ?)', `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    return { W: where.join(' AND '), p };
  };

  r.get('/export.csv', ah(async (req, res) => {
    const q = filters.parse(req.query);
    const { W, p } = buildWhere(q, await walletId(me(res).id));
    const rows = (await pool.query(`${SELECT} WHERE ${W} ORDER BY t.created_at DESC, t.id LIMIT 10000`, p)).rows;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="minipay-transactions.csv"');
    res.send(toCsv([['Transaction ID', 'Date (UTC)', 'Direction', 'Counterparty', 'Amount (INR)', 'Status', 'Description'],
      ...rows.map(t => [t.id, new Date(t.createdAt).toISOString(), t.direction, t.counterparty, inr(t.amountPaise), t.status, t.description])]));
  }));

  r.get('/', ah(async (req, res) => {
    const q = filters.extend({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    const { W, p } = buildWhere(q, await walletId(me(res).id));
    const total = (await pool.query(`SELECT count(*)::int AS c FROM transactions t WHERE ${W}`, p)).rows[0].c;
    p.push(q.limit, (q.page - 1) * q.limit);
    const items = (await pool.query(`${SELECT} WHERE ${W} ORDER BY t.created_at DESC, t.id LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    res.json({ items, page: q.page, limit: q.limit, total });
  }));

  const one = async (id: string, uid: string) => {
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'NOT_FOUND', 'Transaction not found');
    const w = await walletId(uid);
    const row = (await pool.query(`${SELECT} WHERE t.id=$2 AND (t.sender_wallet_id=$1 OR t.receiver_wallet_id=$1)`, [w, id])).rows[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Transaction not found'); // 404, not 403: do not reveal existence
    return row;
  };
  r.get('/:id', ah(async (req, res) => { res.json(await one(req.params.id, me(res).id)); }));
  r.get('/:id/receipt', ah(async (req, res) => {
    const t = await one(req.params.id, me(res).id);
    res.json({ receiptFor: t.id, issuedAt: new Date().toISOString(), currency: 'INR', ...t, note: 'Simulated payment. No real money moved.' });
  }));
  return r;
}
