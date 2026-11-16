import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { addFunds, transfer, reconcile, PaymentError } from '../src/services/payments';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 30 });
let sys: string, A: string, B: string;

async function mkUser(name: string) {
  const u = await pool.query(`INSERT INTO users(email,username,password_hash) VALUES($1,$2,'x') RETURNING id`, [`${name}@t.dev`, name]);
  await pool.query('INSERT INTO wallets(user_id) VALUES($1)', [u.rows[0].id]);
  return u.rows[0].id as string;
}
const bal = async (id: string) => BigInt((await pool.query('SELECT balance_paise FROM wallets WHERE user_id=$1', [id])).rows[0].balance_paise);
const k = () => Math.random().toString(36).slice(2);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(readFileSync('migrations/001_init.sql', 'utf8'));
});
beforeEach(async () => {
  // Test-only reset: triggers block DELETE, so truncate (bypasses row triggers).
  await pool.query('TRUNCATE ledger_entries, transactions, wallets, users RESTART IDENTITY CASCADE');
  sys = await mkUser('__system_funding__'); A = await mkUser('alice'); B = await mkUser('bob');
});
afterAll(() => pool.end());

describe('E2E money journey', () => {
  it('A adds 5000, sends 1000 to B; balances, ledger and receipts line up', async () => {
    await addFunds(pool, A, 500000, k());
    const t = await transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 100000, idempotencyKey: k(), description: 'lunch' });
    expect(await bal(A)).toBe(400000n); expect(await bal(B)).toBe(100000n);
    const l = await pool.query('SELECT direction, amount_paise::int FROM ledger_entries WHERE transaction_id=$1 ORDER BY direction', [t.transactionId]);
    expect(l.rows).toEqual([{ direction: 'CREDIT', amount_paise: 100000 }, { direction: 'DEBIT', amount_paise: 100000 }]);
    const r = await reconcile(pool); expect(r.mismatches).toEqual([]); expect(r.globalNet).toBe('0');
  });
});

describe('validation and failure', () => {
  it.each([0, -5, 1.5, NaN, Number.MAX_SAFE_INTEGER + 10])('rejects invalid amount %s', async (n) => {
    await expect(transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: n, idempotencyKey: k() })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });
  it('rejects insufficient funds with no side effects (rollback)', async () => {
    await addFunds(pool, A, 1000, k());
    await expect(transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 1001, idempotencyKey: k() })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await bal(A)).toBe(1000n); expect(await bal(B)).toBe(0n);
    expect((await pool.query("SELECT count(*)::int c FROM transactions WHERE type='TRANSFER'")).rows[0].c).toBe(0);
  });
  it('rejects self transfer and suspended accounts', async () => {
    await addFunds(pool, A, 1000, k());
    await expect(transfer(pool, { senderUserId: A, receiverUserId: A, amountPaise: 1, idempotencyKey: k() })).rejects.toBeInstanceOf(PaymentError);
    await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [B]);
    await expect(transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 1, idempotencyKey: k() })).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });
});

describe('integrity guarantees at the database level', () => {
  it('forbids negative balances, ledger edits and transaction deletes', async () => {
    await expect(pool.query('UPDATE wallets SET balance_paise=-1 WHERE user_id=$1', [A])).rejects.toThrow();
    await addFunds(pool, A, 500, k());
    await expect(pool.query("UPDATE ledger_entries SET amount_paise=1")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM transactions')).rejects.toThrow(/append-only/);
  });
});

describe('idempotency and concurrency', () => {
  it('sequential duplicate key moves money once', async () => {
    await addFunds(pool, A, 10000, k()); const key = k();
    const a = await transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 2500, idempotencyKey: key });
    const b = await transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 2500, idempotencyKey: key });
    expect(b.duplicate).toBe(true); expect(b.transactionId).toBe(a.transactionId);
    expect(await bal(A)).toBe(7500n);
  });
  it('10 simultaneous requests with the same key move money once', async () => {
    await addFunds(pool, A, 10000, k()); const key = k();
    const res = await Promise.all(Array.from({ length: 10 }, () => transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 1000, idempotencyKey: key })));
    expect(new Set(res.map(r => r.transactionId)).size).toBe(1);
    expect(await bal(A)).toBe(9000n); expect(await bal(B)).toBe(1000n);
  });
  it('20 simultaneous distinct spends against 10 affordable: exactly 10 succeed, never negative', async () => {
    await addFunds(pool, A, 1000, k());
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 100, idempotencyKey: k() })));
    expect(res.filter(r => r.status === 'fulfilled').length).toBe(10);
    expect(await bal(A)).toBe(0n); expect(await bal(B)).toBe(1000n);
    const r = await reconcile(pool); expect(r.mismatches).toEqual([]); expect(r.globalNet).toBe('0');
  });
  it('opposite-direction simultaneous transfers do not deadlock', async () => {
    await addFunds(pool, A, 50000, k()); await addFunds(pool, B, 50000, k());
    const jobs = Array.from({ length: 20 }, (_, n) => n % 2
      ? transfer(pool, { senderUserId: A, receiverUserId: B, amountPaise: 100, idempotencyKey: k() })
      : transfer(pool, { senderUserId: B, receiverUserId: A, amountPaise: 100, idempotencyKey: k() }));
    await expect(Promise.all(jobs)).resolves.toBeDefined();
    expect((await bal(A)) + (await bal(B))).toBe(100000n);
    expect((await reconcile(pool)).mismatches).toEqual([]);
  });
});
