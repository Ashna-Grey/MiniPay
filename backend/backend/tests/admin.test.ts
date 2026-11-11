import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import SwaggerParser from '@apidevtools/swagger-parser';
import { applyMigrations, ensureSystemWallet } from '../src/migrate';
import { createApp } from '../src/app';
import { createAdmin } from '../src/services/admin';
import { openapi } from '../src/openapi';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const app = createApp(pool, { authLimit: 100000 });
const PW = 'Str0ngPassw0rd';
let n = 0; const k = () => `key-${Date.now()}-${n++}-${Math.random().toString(36).slice(2)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const UUID = '00000000-0000-4000-8000-000000000000';

async function signup(name: string) {
  const r = await request(app).post('/api/auth/register').send({ email: `${name}@t.dev`, username: name, password: PW }).expect(201);
  const l = await request(app).post('/api/auth/login').send({ email: `${name}@t.dev`, password: PW }).expect(200);
  return { id: r.body.id as string, token: l.body.accessToken as string, cookie: l.headers['set-cookie'] as unknown as string[] };
}
async function admin() {
  await createAdmin(pool, { email: 'root@t.dev', username: 'rootadmin', password: PW });
  return (await request(app).post('/api/auth/login').send({ email: 'root@t.dev', password: PW }).expect(200)).body.accessToken as string;
}
const fund = (t: string, amountPaise: number) => request(app).post('/api/wallet/add-funds').set(auth(t)).set('Idempotency-Key', k()).send({ amountPaise }).expect(201);
const send = (t: string, recipient: string, amountPaise: number, description?: string) =>
  request(app).post('/api/payments/send').set(auth(t)).set('Idempotency-Key', k()).send({ recipient, amountPaise, description }).expect(201);

beforeAll(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyMigrations(pool); });
beforeEach(async () => { await pool.query('TRUNCATE ledger_entries, transactions, refresh_tokens, password_reset_tokens, audit_logs, wallets, users RESTART IDENTITY CASCADE'); await ensureSystemWallet(pool); });
afterAll(() => pool.end());

const ADMIN_ROUTES: [string, string][] = [['get', '/users'], ['patch', `/users/${UUID}/status`], ['get', '/transactions'], ['get', `/transactions/${UUID}`], ['get', '/analytics'], ['get', '/audit-logs'], ['get', '/security-events']];

describe('admin access control', () => {
  it('401 without a token, 403 for normal users, 200 for admins', async () => {
    const u = await signup('alice'); const a = await admin();
    for (const [m, p] of ADMIN_ROUTES) {
      await (request(app) as any)[m](`/api/admin${p}`).expect(401);
      await (request(app) as any)[m](`/api/admin${p}`).set(auth(u.token)).expect(403);
    }
    for (const p of ['/users', '/transactions', '/analytics', '/audit-logs', '/security-events']) await request(app).get(`/api/admin${p}`).set(auth(a)).expect(200);
  });
  it('a normal user cannot make themselves admin through any profile route', async () => {
    const u = await signup('alice');
    await request(app).patch('/api/users/me').set(auth(u.token)).send({ fullName: 'x', role: 'ADMIN' }).expect(400);
    expect((await pool.query("SELECT role FROM users WHERE username='alice'")).rows[0].role).toBe('USER');
  });
  it('admin seed enforces the password policy and is idempotent', async () => {
    await expect(createAdmin(pool, { email: 'a@t.dev', username: 'adm', password: 'weak' })).rejects.toThrow();
    expect((await createAdmin(pool, { email: 'a@t.dev', username: 'adm', password: PW })).created).toBe(true);
    expect((await createAdmin(pool, { email: 'a@t.dev', username: 'adm', password: PW })).created).toBe(false);
  });
});

describe('user management', () => {
  it('lists and searches users without exposing secrets or the system account', async () => {
    await signup('alice'); await signup('bob'); const a = await admin();
    const all = (await request(app).get('/api/admin/users').set(auth(a)).expect(200)).body;
    expect(all.total).toBe(3); expect(JSON.stringify(all)).not.toMatch(/password|hash|__system/i);
    const f = (await request(app).get('/api/admin/users?q=ali').set(auth(a))).body;
    expect(f.items.map((i: any) => i.username)).toEqual(['alice']);
    expect((await request(app).get("/api/admin/users?q=%27%3B%20DROP%20TABLE%20users%3B--").set(auth(a)).expect(200)).body.total).toBe(0);
  });
  it('suspend locks the user out at once, revokes sessions, writes an audit entry; reactivate restores', async () => {
    const u = await signup('alice'); const a = await admin();
    await request(app).patch(`/api/admin/users/${u.id}/status`).set(auth(a)).send({ status: 'SUSPENDED', reason: 'Fraud review' }).expect(200);
    await request(app).get('/api/wallet').set(auth(u.token)).expect(403);
    await request(app).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(403);
    await request(app).post('/api/auth/refresh').set('X-Requested-With', 'minipay').set('Cookie', u.cookie).expect(401);
    const log = (await request(app).get('/api/admin/audit-logs?action=ADMIN_USER_SUSPENDED').set(auth(a))).body.items[0];
    expect(log).toMatchObject({ actor: 'rootadmin', target: u.id, metadata: { reason: 'Fraud review' } });
    await request(app).patch(`/api/admin/users/${u.id}/status`).set(auth(a)).send({ status: 'ACTIVE', reason: 'Cleared' }).expect(200);
    await request(app).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(200);
  });
  it('validates input, hides unknown ids, and protects admins and the system account', async () => {
    const u = await signup('alice'); const a = await admin();
    const adminId = (await pool.query("SELECT id FROM users WHERE username='rootadmin'")).rows[0].id;
    const sysId = (await pool.query("SELECT id FROM users WHERE username='__system_funding__'")).rows[0].id;
    const patch = (id: string, body: object) => request(app).patch(`/api/admin/users/${id}/status`).set(auth(a)).send(body);
    await patch(u.id, { status: 'BANNED', reason: 'abc' }).expect(400);
    await patch(u.id, { status: 'SUSPENDED' }).expect(400);
    await patch(u.id, { status: 'SUSPENDED', reason: '<script>' }).expect(400);
    await patch('not-a-uuid', { status: 'SUSPENDED', reason: 'abc' }).expect(404);
    await patch(UUID, { status: 'SUSPENDED', reason: 'abc' }).expect(404);
    await patch(adminId, { status: 'SUSPENDED', reason: 'self lockout' }).expect(403);
    await patch(sysId, { status: 'SUSPENDED', reason: 'abc' }).expect(404);
  });
});

describe('transactions, analytics and read-only guarantees', () => {
  it('admin sees all transactions and a balanced ledger; analytics are correct', async () => {
    const A = await signup('alice'); await signup('bob'); const a = await admin();
    await fund(A.token, 500000); const t = (await send(A.token, 'bob', 100000, 'lunch')).body.transactionId;
    const list = (await request(app).get('/api/admin/transactions?type=TRANSFER&q=lunch').set(auth(a)).expect(200)).body;
    expect(list.total).toBe(1); expect(list.items[0]).toMatchObject({ sender: 'alice', receiver: 'bob', amountPaise: '100000' });
    const d = (await request(app).get(`/api/admin/transactions/${t}`).set(auth(a)).expect(200)).body;
    expect(d.ledger).toHaveLength(2);
    expect(d.ledger.map((l: any) => l.direction).sort()).toEqual(['CREDIT', 'DEBIT']); expect(d.ledger[0].amountPaise).toBe(d.ledger[1].amountPaise);
    expect((await request(app).get('/api/admin/transactions').set(auth(a))).body.total).toBe(2); // funding + transfer
    const an = (await request(app).get('/api/admin/analytics').set(auth(a)).expect(200)).body;
    expect(an).toMatchObject({ users: { total: 3, active: 3, suspended: 0 }, transferCount: 1, transferVolumePaise: '100000', fundingVolumePaise: '500000', ledgerBalanced: true });
    expect(an.dailyTransfers).toHaveLength(30); expect(an.dailyTransfers.at(-1)).toMatchObject({ volumePaise: '100000', count: 1 });
  });
  it('admins cannot edit or delete transactions or change balances', async () => {
    const A = await signup('alice'); await signup('bob'); const a = await admin();
    await fund(A.token, 5000); const t = (await send(A.token, 'bob', 1000)).body.transactionId;
    for (const m of ['patch', 'put', 'delete', 'post']) await (request(app) as any)[m](`/api/admin/transactions/${t}`).set(auth(a)).send({ amountPaise: 1 }).expect(404);
    await request(app).post('/api/admin/wallet/add-funds').set(auth(a)).set('Idempotency-Key', k()).send({ amountPaise: 1 }).expect(404);
    await request(app).patch('/api/admin/users/' + A.id + '/status').set(auth(a)).send({ status: 'ACTIVE', reason: 'abc', balancePaise: 999999 }).expect(400);
    expect((await pool.query("SELECT balance_paise::int b FROM wallets w JOIN users u ON u.id=w.user_id WHERE username='alice'")).rows[0].b).toBe(4000);
  });
  it('failed logins show up as security events; filters and pagination work', async () => {
    await signup('alice'); const a = await admin();
    for (let i = 0; i < 3; i++) await request(app).post('/api/auth/login').send({ email: 'alice@t.dev', password: 'WrongPassw0rd' }).expect(401);
    const ev = (await request(app).get('/api/admin/security-events?action=LOGIN_FAILED&limit=2').set(auth(a)).expect(200)).body;
    expect(ev.total).toBe(3); expect(ev.items).toHaveLength(2); expect(ev.items[0].actor).toBe('alice');
    expect(JSON.stringify(ev)).not.toMatch(/WrongPassw0rd/);
    expect((await request(app).get('/api/admin/security-events?action=REGISTER').set(auth(a))).body.total).toBe(0); // REGISTER is audit-only
    expect((await request(app).get('/api/admin/audit-logs?action=REGISTER').set(auth(a))).body.total).toBe(1);
    expect((await request(app).get('/api/admin/audit-logs?action=ADMIN_CREATED').set(auth(a))).body.total).toBe(1);
  });
});

describe('CSV export', () => {
  it('exports only the caller\'s rows, with correct amounts, headers and formula-injection protection', async () => {
    const A = await signup('alice'); const B = await signup('bob'); const C = await signup('carol');
    await fund(A.token, 500000); await send(A.token, 'bob', 123456, '=HYPERLINK("http://evil","x"), hi');
    const res = await request(app).get('/api/payments/export.csv?direction=SENT').set(auth(A.token)).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/); expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('Transaction ID,Date (UTC),Direction,Counterparty,Amount (INR),Status,Description');
    expect(lines).toHaveLength(2); expect(lines[1]).toContain(',SENT,bob,1234.56,COMPLETED,');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""x""), hi"`);
    expect((await request(app).get('/api/payments/export.csv').set(auth(B.token))).text).toContain(',RECEIVED,alice,1234.56,');
    expect((await request(app).get('/api/payments/export.csv').set(auth(C.token))).text.trim().split('\r\n')).toHaveLength(1);
    await request(app).get('/api/payments/export.csv').expect(401);
  });
  it('history still paginates and filters after the refactor', async () => {
    const A = await signup('alice'); await signup('bob'); await fund(A.token, 500000);
    for (let i = 0; i < 5; i++) await send(A.token, 'bob', 100 + i, `note ${i}`);
    const p = (await request(app).get('/api/payments?direction=SENT&limit=2&page=3').set(auth(A.token)).expect(200)).body;
    expect(p).toMatchObject({ total: 5, page: 3 }); expect(p.items).toHaveLength(1);
    expect((await request(app).get('/api/payments?q=note%204').set(auth(A.token))).body.total).toBe(1);
  });
});

describe('OpenAPI spec', () => {
  it('is a valid OpenAPI document and is served with a docs page', async () => {
    await SwaggerParser.validate(JSON.parse(JSON.stringify(openapi)));
    expect((await request(app).get('/api/openapi.json').expect(200)).body.info.title).toBe('MiniPay API');
    await request(app).get('/api/docs/').expect(200);
  });
  it('every documented route exists in the server (never 404/500 when called unauthenticated)', async () => {
    const bad: string[] = [];
    for (const [path, ops] of Object.entries(openapi.paths)) for (const m of Object.keys(ops)) {
      const res = await (request(app) as any)[m](`/api${path.replace('{id}', UUID)}`);
      if (res.status === 404 || res.status >= 500) bad.push(`${m.toUpperCase()} ${path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
});
