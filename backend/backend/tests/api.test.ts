import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { applyMigrations, ensureSystemWallet } from '../src/migrate';
import { createApp } from '../src/app';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const app = createApp(pool, { authLimit: 100000 });
const PW = 'Str0ngPassw0rd';
const CSRF = { 'X-Requested-With': 'minipay' };
let n = 0; const k = () => `key-${Date.now()}-${n++}-${Math.random().toString(36).slice(2)}`;

async function signup(name: string) {
  await request(app).post('/api/auth/register').send({ email: `${name}@t.dev`, username: name, password: PW }).expect(201);
  const res = await request(app).post('/api/auth/login').send({ email: `${name}@t.dev`, password: PW }).expect(200);
  return { token: res.body.accessToken as string, cookie: res.headers['set-cookie'] as unknown as string[] };
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyMigrations(pool); });
beforeEach(async () => { await pool.query('TRUNCATE ledger_entries, transactions, refresh_tokens, password_reset_tokens, audit_logs, wallets, users RESTART IDENTITY CASCADE'); await ensureSystemWallet(pool); });
afterAll(() => pool.end());

describe('registration and login', () => {
  it('registers, creates a wallet, never leaks the hash, rejects duplicates and weak passwords', async () => {
    const r = await request(app).post('/api/auth/register').send({ email: 'A@T.dev', username: 'alice', password: PW }).expect(201);
    expect(JSON.stringify(r.body)).not.toMatch(/hash|argon/i);
    expect((await pool.query("SELECT w.balance_paise::int b FROM wallets w JOIN users u ON u.id=w.user_id WHERE u.username='alice'")).rows[0].b).toBe(0);
    expect((await pool.query("SELECT password_hash FROM users WHERE username='alice'")).rows[0].password_hash).toMatch(/^\$argon2id\$/);
    await request(app).post('/api/auth/register').send({ email: 'a@t.dev', username: 'alice2', password: PW }).expect(409);
    await request(app).post('/api/auth/register').send({ email: 'x@t.dev', username: 'xx1', password: 'short' }).expect(400);
    await request(app).post('/api/auth/register').send({ email: 'x@t.dev', username: '__system_funding__', password: PW }).expect(400);
  });
  it('login uses one generic error for wrong password and unknown email; cookie is httpOnly + strict', async () => {
    await signup('alice');
    const a = await request(app).post('/api/auth/login').send({ email: 'alice@t.dev', password: 'WrongPassw0rd' }).expect(401);
    const b = await request(app).post('/api/auth/login').send({ email: 'nobody@t.dev', password: 'WrongPassw0rd' }).expect(401);
    expect(a.body).toEqual(b.body);
    const ok = await request(app).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(200);
    const c = (ok.headers['set-cookie'] as unknown as string[])[0];
    expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=Strict/i); expect(JSON.stringify(ok.body)).not.toMatch(/refresh/i);
  });
  it('cannot log in as the system funding account', async () => {
    await request(app).post('/api/auth/login').send({ email: 'system@minipay.invalid', password: PW }).expect(401);
  });
});

describe('authentication and token handling', () => {
  it('rejects missing, garbage, tampered and alg=none tokens', async () => {
    const { token } = await signup('alice');
    await request(app).get('/api/wallet').expect(401);
    await request(app).get('/api/wallet').set(auth('garbage')).expect(401);
    const [h, p, s] = token.split('.');
    await request(app).get('/api/wallet').set(auth(`${h}.${p}.${s.slice(0, -2)}xx`)).expect(401);
    const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + p + '.';
    await request(app).get('/api/wallet').set(auth(none)).expect(401);
    await request(app).get('/api/wallet').set(auth(token)).expect(200);
  });
  it('rotates refresh tokens, and reuse of an old one revokes the whole family', async () => {
    const { cookie } = await signup('alice');
    const r1 = await request(app).post('/api/auth/refresh').set(CSRF).set('Cookie', cookie).expect(200);
    const c2 = r1.headers['set-cookie'] as unknown as string[];
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(403); // missing CSRF header
    await request(app).post('/api/auth/refresh').set(CSRF).set('Cookie', cookie).expect(401); // reuse of rotated token
    await request(app).post('/api/auth/refresh').set(CSRF).set('Cookie', c2).expect(401); // family revoked
  });
  it('logout revokes the refresh token', async () => {
    const { cookie } = await signup('alice');
    await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', cookie).expect(204);
    await request(app).post('/api/auth/refresh').set(CSRF).set('Cookie', cookie).expect(401);
  });
  it('a suspended user is locked out immediately, even with a valid token', async () => {
    const { token } = await signup('alice');
    await pool.query("UPDATE users SET status='SUSPENDED' WHERE username='alice'");
    await request(app).get('/api/wallet').set(auth(token)).expect(403);
  });
  it('rate-limits auth attempts', async () => {
    const limited = createApp(pool, { authLimit: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(limited).post('/api/auth/login').send({ email: 'z@t.dev', password: 'WrongPassw0rd' })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('password reset and change', () => {
  it('reset token is single-use, ends old sessions and old password; unknown email gives the same reply', async () => {
    const { cookie } = await signup('alice');
    const known = await request(app).post('/api/auth/forgot-password').send({ email: 'alice@t.dev' }).expect(202);
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@t.dev' }).expect(202);
    expect(unknown.body.devToken).toBeUndefined(); expect(known.body.message).toBe(unknown.body.message);
    const NEW = 'Brand9NewPassword';
    await request(app).post('/api/auth/reset-password').send({ token: known.body.devToken, password: NEW }).expect(204);
    await request(app).post('/api/auth/reset-password').send({ token: known.body.devToken, password: NEW }).expect(400);
    await request(app).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'alice@t.dev', password: NEW }).expect(200);
    await request(app).post('/api/auth/refresh').set(CSRF).set('Cookie', cookie).expect(401);
  });
  it('change password requires the current password', async () => {
    const { token } = await signup('alice');
    await request(app).post('/api/users/me/password').set(auth(token)).send({ currentPassword: 'Nope12345678', newPassword: 'Another1Password' }).expect(401);
    await request(app).post('/api/users/me/password').set(auth(token)).send({ currentPassword: PW, newPassword: 'Another1Password' }).expect(204);
  });
});

describe('end-to-end payment journey over the API', () => {
  it('A adds 5000, sends 1000 to B; both see history; receipts are participant-only; ledger balanced', async () => {
    const A = await signup('alice'), B = await signup('bob'), C = await signup('carol');
    await request(app).post('/api/wallet/add-funds').set(auth(A.token)).set('Idempotency-Key', k()).send({ amountPaise: 500000 }).expect(201);
    const key = k();
    const send = await request(app).post('/api/payments/send').set(auth(A.token)).set('Idempotency-Key', key).send({ recipient: 'bob', amountPaise: 100000, description: 'lunch' }).expect(201);
    const dup = await request(app).post('/api/payments/send').set(auth(A.token)).set('Idempotency-Key', key).send({ recipient: 'bob', amountPaise: 100000, description: 'lunch' }).expect(200);
    expect(dup.body.transactionId).toBe(send.body.transactionId);
    expect((await request(app).get('/api/wallet/balance').set(auth(A.token))).body.balancePaise).toBe('400000');
    expect((await request(app).get('/api/wallet/balance').set(auth(B.token))).body.balancePaise).toBe('100000');
    const ha = (await request(app).get('/api/payments?direction=SENT').set(auth(A.token)).expect(200)).body;
    expect(ha.total).toBe(1); expect(ha.items[0]).toMatchObject({ direction: 'SENT', counterparty: 'bob', amountPaise: '100000', status: 'COMPLETED' });
    const hb = (await request(app).get('/api/payments?direction=RECEIVED&q=lunch').set(auth(B.token)).expect(200)).body;
    expect(hb.items[0]).toMatchObject({ direction: 'RECEIVED', counterparty: 'alice' });
    await request(app).get(`/api/payments/${send.body.transactionId}/receipt`).set(auth(B.token)).expect(200);
    await request(app).get(`/api/payments/${send.body.transactionId}`).set(auth(C.token)).expect(404); // not a participant
    const sum = (await request(app).get('/api/payments/summary').set(auth(A.token))).body;
    expect(sum).toMatchObject({ totalSentPaise: '100000', totalFundedPaise: '500000', spentThisMonthPaise: '100000' });
    const net = await pool.query("SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_paise ELSE -amount_paise END),0)::int n FROM ledger_entries");
    expect(net.rows[0].n).toBe(0);
  });
  it('rejects bad amounts, missing idempotency key, unknown/self recipient, insufficient funds', async () => {
    const A = await signup('alice'); await signup('bob');
    const send = (body: object, key: string | null = k()) => { const r = request(app).post('/api/payments/send').set(auth(A.token)); if (key) r.set('Idempotency-Key', key); return r.send(body); };
    for (const amountPaise of [-100, 0, 1.5, '100', null]) await send({ recipient: 'bob', amountPaise }).expect(400);
    await send({ recipient: 'bob', amountPaise: 100 }, null).expect(400);
    await send({ recipient: 'nobody', amountPaise: 100 }).expect(404);
    await send({ recipient: 'alice', amountPaise: 100 }).expect(400);
    await send({ recipient: 'bob', amountPaise: 100 }).expect(422);
    await send({ recipient: '__system_funding__', amountPaise: 100 }).expect(404);
  });
  it('simultaneous API sends never overspend', async () => {
    const A = await signup('alice'); await signup('bob');
    await request(app).post('/api/wallet/add-funds').set(auth(A.token)).set('Idempotency-Key', k()).send({ amountPaise: 1000 }).expect(201);
    const rs = await Promise.all(Array.from({ length: 15 }, () => request(app).post('/api/payments/send').set(auth(A.token)).set('Idempotency-Key', k()).send({ recipient: 'bob', amountPaise: 100 })));
    expect(rs.filter(r => r.status === 201).length).toBe(10); expect(rs.filter(r => r.status === 422).length).toBe(5);
    expect((await request(app).get('/api/wallet/balance').set(auth(A.token))).body.balancePaise).toBe('0');
  });
});

describe('injection, XSS and information exposure', () => {
  it('treats SQL injection strings as data', async () => {
    const A = await signup('alice'); await signup('bob');
    await request(app).post('/api/auth/login').send({ email: "' OR '1'='1", password: PW }).expect(400);
    await request(app).post('/api/auth/login').send({ email: "alice@t.dev' --", password: PW }).expect(400);
    const s = await request(app).get('/api/users/search').query({ q: "bob' OR '1'='1" }).set(auth(A.token)).expect(200);
    expect(s.body.items).toEqual([]);
    const l = await request(app).get('/api/payments').query({ q: "'; DROP TABLE users;--" }).set(auth(A.token)).expect(200);
    expect(l.body.items).toEqual([]);
    expect((await pool.query('SELECT count(*)::int c FROM users')).rows[0].c).toBeGreaterThan(1);
  });
  it('rejects markup in descriptions and names', async () => {
    const A = await signup('alice'); await signup('bob');
    await request(app).post('/api/wallet/add-funds').set(auth(A.token)).set('Idempotency-Key', k()).send({ amountPaise: 1000 });
    await request(app).post('/api/payments/send').set(auth(A.token)).set('Idempotency-Key', k()).send({ recipient: 'bob', amountPaise: 100, description: '<script>alert(1)</script>' }).expect(400);
    await request(app).patch('/api/users/me').set(auth(A.token)).send({ fullName: '<img src=x onerror=alert(1)>' }).expect(400);
  });
  it('search is exact-match only, hides email and self', async () => {
    const A = await signup('alice'); await signup('bob');
    expect((await request(app).get('/api/users/search').query({ q: 'bo' }).set(auth(A.token))).status).toBe(400);
    const f = await request(app).get('/api/users/search').query({ q: 'bob@t.dev' }).set(auth(A.token)).expect(200);
    expect(f.body.items).toEqual([{ username: 'bob', fullName: null }]);
    expect((await request(app).get('/api/users/search').query({ q: 'alice' }).set(auth(A.token))).body.items).toEqual([]);
  });
  it('sends hardening headers, hides the stack, handles malformed JSON, no secrets in /me', async () => {
    const A = await signup('alice');
    const h = await request(app).get('/api/health');
    expect(h.headers['x-content-type-options']).toBe('nosniff'); expect(h.headers['x-powered-by']).toBeUndefined();
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{not json').expect(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.(ts|js)/);
    const me = (await request(app).get('/api/users/me').set(auth(A.token)).expect(200)).body;
    expect(JSON.stringify(me)).not.toMatch(/password|hash|token/i);
  });
});
