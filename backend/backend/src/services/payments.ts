import type { Pool, PoolClient } from 'pg';

export class PaymentError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export interface TransferInput { senderUserId: string; receiverUserId: string; amountPaise: number; description?: string; idempotencyKey: string; }

async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
function assertAmount(n: number) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new PaymentError('INVALID_AMOUNT', 'Amount must be a positive integer in paise');
}

export async function addFunds(pool: Pool, userId: string, amountPaise: number, idempotencyKey: string) {
  assertAmount(amountPaise);
  return withTx(pool, async (c) => {
    const dup = await c.query('SELECT id FROM transactions WHERE initiator_user_id=$1 AND idempotency_key=$2', [userId, idempotencyKey]);
    if (dup.rowCount) return { transactionId: dup.rows[0].id, duplicate: true };
    const w = await c.query('SELECT id, balance_paise FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
    if (!w.rowCount) throw new PaymentError('NO_WALLET', 'Wallet not found');
    const sys = await c.query("SELECT w.id FROM wallets w JOIN users u ON u.id=w.user_id WHERE u.username='__system_funding__' FOR UPDATE");
    // System funding wallet may go negative conceptually; it is a ledger counter-party, tracked via ledger only.
    const tx = await c.query(
      `INSERT INTO transactions(type,sender_wallet_id,receiver_wallet_id,amount_paise,description,idempotency_key,initiator_user_id)
       VALUES('FUNDING',$1,$2,$3,'Simulated funds',$4,$5) RETURNING id`,
      [sys.rows[0].id, w.rows[0].id, amountPaise, idempotencyKey, userId]);
    await c.query(`INSERT INTO ledger_entries(transaction_id,wallet_id,direction,amount_paise) VALUES($1,$2,'DEBIT',$4),($1,$3,'CREDIT',$4)`,
      [tx.rows[0].id, sys.rows[0].id, w.rows[0].id, amountPaise]);
    await c.query('UPDATE wallets SET balance_paise=balance_paise+$1 WHERE id=$2', [amountPaise, w.rows[0].id]);
    return { transactionId: tx.rows[0].id, duplicate: false };
  });
}

async function transferOnce(pool: Pool, i: TransferInput) {
  assertAmount(i.amountPaise);
  if (i.senderUserId === i.receiverUserId) throw new PaymentError('SELF_TRANSFER', 'Cannot send money to yourself');
  return withTx(pool, async (c) => {
    const dup = await c.query('SELECT id FROM transactions WHERE initiator_user_id=$1 AND idempotency_key=$2', [i.senderUserId, i.idempotencyKey]);
    if (dup.rowCount) return { transactionId: dup.rows[0].id, duplicate: true };
    // Lock both wallets in a consistent (id) order to avoid deadlocks.
    const rows = (await c.query(
      `SELECT w.id, w.user_id, w.balance_paise, u.status FROM wallets w JOIN users u ON u.id=w.user_id
       WHERE w.user_id = ANY($1) ORDER BY w.id FOR UPDATE OF w`, [[i.senderUserId, i.receiverUserId]])).rows;
    const s = rows.find(r => r.user_id === i.senderUserId), r = rows.find(r => r.user_id === i.receiverUserId);
    if (!s || !r) throw new PaymentError('NO_WALLET', 'Wallet not found');
    if (s.status !== 'ACTIVE' || r.status !== 'ACTIVE') throw new PaymentError('ACCOUNT_SUSPENDED', 'Account is suspended');
    if (BigInt(s.balance_paise) < BigInt(i.amountPaise)) throw new PaymentError('INSUFFICIENT_FUNDS', 'Insufficient balance');
    const tx = await c.query(
      `INSERT INTO transactions(type,sender_wallet_id,receiver_wallet_id,amount_paise,description,idempotency_key,initiator_user_id)
       VALUES('TRANSFER',$1,$2,$3,$4,$5,$6) RETURNING id`, [s.id, r.id, i.amountPaise, i.description ?? null, i.idempotencyKey, i.senderUserId]);
    await c.query(`INSERT INTO ledger_entries(transaction_id,wallet_id,direction,amount_paise) VALUES($1,$2,'DEBIT',$4),($1,$3,'CREDIT',$4)`,
      [tx.rows[0].id, s.id, r.id, i.amountPaise]);
    await c.query('UPDATE wallets SET balance_paise=balance_paise-$1 WHERE id=$2', [i.amountPaise, s.id]);
    await c.query('UPDATE wallets SET balance_paise=balance_paise+$1 WHERE id=$2', [i.amountPaise, r.id]);
    return { transactionId: tx.rows[0].id, duplicate: false };
  });
}

/** Reconcile: stored balance must equal ledger credits - debits for every wallet. Returns mismatches. */
export async function reconcile(pool: Pool) {
  const r = await pool.query(`
    SELECT w.id, w.balance_paise::text AS stored,
      COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount_paise ELSE -l.amount_paise END),0)::text AS derived
    FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id=w.id
    JOIN users u ON u.id=w.user_id WHERE u.username <> '__system_funding__'
    GROUP BY w.id HAVING w.balance_paise <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount_paise ELSE -l.amount_paise END),0)`);
  const t = await pool.query(`SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_paise ELSE -amount_paise END),0)::text AS net FROM ledger_entries`);
  return { mismatches: r.rows, globalNet: t.rows[0].net };
}

/** Public entry: a concurrent duplicate that loses the unique-key race is reported as a duplicate, never a second charge. */
export async function transfer(pool: Pool, i: TransferInput) {
  try { return await transferOnce(pool, i); }
  catch (e: any) {
    if (e?.code === '23505') {
      const d = await pool.query('SELECT id FROM transactions WHERE initiator_user_id=$1 AND idempotency_key=$2', [i.senderUserId, i.idempotencyKey]);
      if (d.rowCount) return { transactionId: d.rows[0].id, duplicate: true };
    }
    throw e;
  }
}
