import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ah, me, idempotencyKey } from '../middleware';
import { addFunds } from '../services/payments';
import { paise, MAX_FUNDING } from '../schemas';

export function walletRoutes(pool: Pool) {
  const r = Router();
  const wallet = async (uid: string) => (await pool.query(`SELECT id, currency, balance_paise::text AS "balancePaise", created_at AS "createdAt" FROM wallets WHERE user_id=$1`, [uid])).rows[0];
  r.get('/', ah(async (_q, res) => { const w = await wallet(me(res).id); res.json({ ...w, status: 'ACTIVE' }); }));
  r.get('/balance', ah(async (_q, res) => { const w = await wallet(me(res).id); res.json({ currency: w.currency, balancePaise: w.balancePaise }); }));
  r.post('/add-funds', ah(async (req, res) => {
    const b = z.object({ amountPaise: paise(MAX_FUNDING) }).strict().parse(req.body);
    res.status(201).json(await addFunds(pool, me(res).id, b.amountPaise, idempotencyKey(req)));
  }));
  r.get('/activity', ah(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit);
    const rows = (await pool.query(`SELECT l.id, l.transaction_id AS "transactionId", l.direction, l.amount_paise::text AS "amountPaise", l.created_at AS "createdAt"
      FROM ledger_entries l JOIN wallets w ON w.id=l.wallet_id WHERE w.user_id=$1 ORDER BY l.id DESC LIMIT $2`, [me(res).id, limit])).rows;
    res.json({ items: rows });
  }));
  return r;
}
