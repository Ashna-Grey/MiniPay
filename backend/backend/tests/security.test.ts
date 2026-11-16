import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { applyMigrations, ensureSystemWallet } from '../src/migrate';
import { createApp } from '../src/app';
import { createAdmin } from '../src/services/admin';
import { transfer } from '../src/services/payments';
import { b32decode, decryptSecret, encryptSecret, hotp, verifyTotp } from '../src/services/totp';
import { scoreTransfer, type Features } from '../src/services/risk';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 25 });
const PW = 'Str0ngPassw0rd', ADMIN_PW = 'Adm1nStrongPass99';
let n = 0; const k = () => `key-${Date.now()}-${n++}-${Math.random().toString(36).slice(2)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
// Each test isolates one control: risk scoring is off (thresholds 101) unless the test turns it on.
const base = { stepUpPaise: 500_000, riskChallenge: 101, riskBlock: 101, newAccountHours: 0, hourlyTransfers: 1000, rate: { send: 1000, funding: 1000, search: 1000, sensitive: 1000 } };
const mk = (over: object = {}) => createApp(pool, { authLimit: 100000, security: { ...base, ...over } });
const app = mk();

async function signup(a: any, name: string) {
  await request(a).post('/api/auth/register').send({ email: `${name}@t.dev`, username: name, password: PW }).expect(201);
  const res = await request(a).post('/api/auth/login').send({ email: `${name}@t.dev`, password: PW }).expect(200);
  return { token: res.body.accessToken as string, cookie: res.headers['set-cookie'] as unknown as string[] };
}
const uid = async (name: string) => (await pool.query('SELECT id FROM users WHERE username=$1', [name])).rows[0].id as string;
const fund = (a: any, t: string, amountPaise: number) => request(a).post('/api/wallet/add-funds').set(auth(t)).set('Idempotency-Key', k()).send({ amountPaise });
const send = (a: any, t: string, body: object, key = k()) => request(a).post('/api/payments/send').set(auth(t)).set('Idempotency-Key', key).send(body);
const totpNow = (secret: string, offset = 0) => hotp(b32decode(secret), Math.floor(Date.now() / 1000 / 30) + offset);
async function enable2fa(a: any, t: string) {
  const s = (await request(a).post('/api/security/2fa/setup').set(auth(t)).expect(201)).body;
  const e = (await request(a).post('/api/security/2fa/enable').set(auth(t)).send({ code: totpNow(s.secret) }).expect(200)).body;
  return { secret: s.secret as string, recoveryCodes: e.recoveryCodes as string[] };
}
async function adminToken(a: any) {
  await createAdmin(pool, { email: 'admin@t.dev', username: 'admin', password: ADMIN_PW });
  return (await request(a).post('/api/auth/login').send({ email: 'admin@t.dev', password: ADMIN_PW }).expect(200)).body.accessToken as string;
}

beforeAll(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyMigrations(pool); });
beforeEach(async () => { await pool.query('TRUNCATE ledger_entries, transactions, refresh_tokens, password_reset_tokens, audit_logs, wallets, users, auth_throttle, risk_events, recovery_codes RESTART IDENTITY CASCADE'); await ensureSystemWallet(pool); });
afterAll(() => pool.end());

describe('TOTP and secret storage', () => {
  it('matches the RFC 6238 test vector and tolerates one step of clock drift only', () => {
    const key = Buffer.from('12345678901234567890');
    expect(hotp(key, 1, 8)).toBe('94287082'); // T = 59 s
    const secret = Buffer.from('12345678901234567890').toString('base64'); void secret;
    const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = 1_700_000_000_000, step = Math.floor(now / 30000);
    const code = hotp(b32decode(b32), step);
    expect(verifyTotp(b32, code, now)).toBe(step);
    expect(verifyTotp(b32, code, now + 30_000)).toBe(step);       // one step late: accepted
    expect(verifyTotp(b32, code, now + 90_000)).toBeNull();       // three steps late: rejected
    expect(verifyTotp(b32, '12345', now)).toBeNull();
  });
  it('encrypts secrets at rest and binds them to the owning user', () => {
    const c = encryptSecret('JBSWY3DPEHPK3PXP', 'user-1');
    expect(c).not.toContain('JBSWY3DP');
    expect(decryptSecret(c, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(c, 'user-2')).toThrow();
  });
});

describe('risk scoring', () => {
  const f = (o: Partial<Features> = {}): Features => ({ amountPaise: 20_000, balancePaise: 5_000_000, senderAgeH: 2000, recipientAgeH: 2000, recipientIsNew: false, historyCount: 10, historyAvgPaise: 20_000,
    sent10m: 0, distinctRecipients24h: 1, receivedLastHourPaise: 0, ipKnown: true, ipSeenBefore: true, recentAuthFailures: 0, ...o });
  const th = { challenge: 40, block: 80 };
  it('allows ordinary payments, challenges suspicious ones, blocks stacked signals, and explains itself', () => {
    expect(scoreTransfer(f(), th)).toMatchObject({ decision: 'ALLOW', reasons: [] });
    expect(scoreTransfer(f({ recipientIsNew: true }), th).decision).toBe('ALLOW');
    const mid = scoreTransfer(f({ recipientIsNew: true, amountPaise: 400_000, ipSeenBefore: false }), th);
    expect(mid.decision).toBe('CHALLENGE'); expect(mid.reasons.map(r => r.code)).toEqual(expect.arrayContaining(['NEW_RECIPIENT', 'AMOUNT_SPIKE', 'UNFAMILIAR_NETWORK']));
    const bad = scoreTransfer(f({ recipientIsNew: true, recipientAgeH: 1, senderAgeH: 1, amountPaise: 400_000, sent10m: 6, recentAuthFailures: 4 }), th);
    expect(bad.decision).toBe('BLOCK'); expect(bad.score).toBeGreaterThanOrEqual(80);
  });
});

describe('login protection', () => {
  it('locks after 5 failures, blocks even the right password, and treats unknown emails identically', async () => {
    const a = mk();
    await signup(a, 'alice');
    const run = async (email: string, pw: string) => { const r: number[] = []; for (let i = 0; i < 6; i++) r.push((await request(a).post('/api/auth/login').send({ email, password: pw })).status); return r; };
    const real = await run('alice@t.dev', 'WrongPassw0rd'), ghost = await run('ghost@t.dev', 'WrongPassw0rd');
    expect(real).toEqual([401, 401, 401, 401, 429, 429]);
    expect(ghost).toEqual(real); // no account enumeration through lockout behaviour
    const locked = await request(a).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(429);
    expect(locked.body.error.code).toBe('TEMP_LOCKED'); expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await pool.query("SELECT count(*)::int c FROM audit_logs WHERE action='LOGIN_LOCKED'")).rows[0].c).toBeGreaterThanOrEqual(1);
  });
  it('rejects common and self-referential passwords', async () => {
    const r1 = await request(app).post('/api/auth/register').send({ email: 'x@t.dev', username: 'xavier', password: 'Password123' }).expect(400);
    expect(r1.body.error.code).toBe('WEAK_PASSWORD');
    await request(app).post('/api/auth/register').send({ email: 'y@t.dev', username: 'alicewonder', password: 'Alicewonder99Z' }).expect(400);
  });
});

describe('two-factor authentication', () => {
  it('enrol, challenge at login, reject replay, accept each recovery code once, and never accept the challenge as an access token', async () => {
    const a = mk();
    const { token } = await signup(a, 'alice');
    const { secret, recoveryCodes } = await enable2fa(a, token);
    expect(recoveryCodes).toHaveLength(8);
    expect((await pool.query("SELECT totp_secret_enc FROM users WHERE username='alice'")).rows[0].totp_secret_enc).not.toContain(secret);

    const step1 = await request(a).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(200);
    expect(step1.body.mfaRequired).toBe(true); expect(step1.body.accessToken).toBeUndefined(); expect(step1.headers['set-cookie']).toBeUndefined();
    await request(a).get('/api/wallet').set(auth(step1.body.mfaToken)).expect(401); // challenge token is not an access token

    await request(a).post('/api/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(401);
    const good = totpNow(secret, 1); // enrolment consumed the current step, so use the next one (inside the drift window)
    const ok = await request(a).post('/api/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code: good }).expect(200);
    await request(a).get('/api/wallet').set(auth(ok.body.accessToken)).expect(200);
    await request(a).post('/api/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code: good }).expect(401); // same code twice

    const rc = recoveryCodes[0];
    await request(a).post('/api/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code: rc }).expect(200);
    await request(a).post('/api/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code: rc }).expect(401); // single use
  });
  it('locks the second factor after 5 wrong codes and needs password + code to turn 2FA off', async () => {
    const a = mk();
    const { token } = await signup(a, 'alice');
    const { secret } = await enable2fa(a, token);
    const s1 = await request(a).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(200);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await request(a).post('/api/auth/login/mfa').send({ mfaToken: s1.body.mfaToken, code: '000001' })).status);
    expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
    await pool.query('DELETE FROM auth_throttle');
    await request(a).post('/api/security/2fa/disable').set(auth(token)).send({ password: 'WrongPassw0rd', code: totpNow(secret, 1) }).expect(401);
    await request(a).post('/api/security/2fa/disable').set(auth(token)).send({ password: PW, code: totpNow(secret, 1) }).expect(204);
    expect((await pool.query("SELECT totp_enabled, totp_secret_enc FROM users WHERE username='alice'")).rows[0]).toEqual({ totp_enabled: false, totp_secret_enc: null });
  });
});

describe('transaction PIN step-up', () => {
  it('demands a PIN for large payments, never accepts weak PINs, locks after 5 misses, and does not re-ask on a replay', async () => {
    const a = mk();
    const { token } = await signup(a, 'alice'); await signup(a, 'bob');
    await fund(a, token, 5_000_000).expect(201);
    const big = { recipient: 'bob', amountPaise: 600_000 };
    expect((await send(a, token, big).expect(403)).body.error.code).toBe('PIN_SETUP_REQUIRED');
    await send(a, token, { recipient: 'bob', amountPaise: 100 }).expect(201); // below the threshold: no PIN

    await request(a).put('/api/security/pin').set(auth(token)).send({ pin: '123456', password: PW }).expect(400);
    await request(a).put('/api/security/pin').set(auth(token)).send({ pin: '482913', password: 'WrongPassw0rd' }).expect(401);
    await request(a).put('/api/security/pin').set(auth(token)).send({ pin: '482913', password: PW }).expect(204);
    expect((await pool.query("SELECT pin_hash FROM users WHERE username='alice'")).rows[0].pin_hash).toMatch(/^\$argon2id\$/);

    const key = k();
    expect((await send(a, token, big, key).expect(403)).body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await send(a, token, { ...big, pin: '111222' }, key).expect(403)).body.error.code).toBe('PIN_INVALID');
    await send(a, token, { ...big, pin: '482913' }, key).expect(201);
    await send(a, token, big, key).expect(200); // replay of a finished payment: stored result, no PIN prompt, no second charge
    expect((await pool.query("SELECT balance_paise::int b FROM wallets w JOIN users u ON u.id=w.user_id WHERE username='bob'")).rows[0].b).toBe(600_100);

    const miss: number[] = [];
    for (let i = 0; i < 6; i++) miss.push((await send(a, token, { ...big, pin: '999000' })).status);
    expect(miss).toEqual([403, 403, 403, 403, 429, 429]); // PIN_INVALID x4, then locked
    await send(a, token, { ...big, pin: '482913' }).expect(429); // even the right PIN is refused while locked
  });
});

describe('limits', () => {
  it('enforces per-transfer, rolling-24h, hourly-velocity and funding limits with precise messages', async () => {
    const a = mk({ perTransferPaise: 1_000_000, dailySendPaise: 2_500_000, dailyFundingPaise: 3_000_000, stepUpPaise: 1e12 });
    const { token } = await signup(a, 'alice'); await signup(a, 'bob');
    await fund(a, token, 3_000_000).expect(201);
    expect((await fund(a, token, 100).expect(422)).body.error.code).toBe('LIMIT_FUNDING');
    expect((await send(a, token, { recipient: 'bob', amountPaise: 1_000_001 }).expect(422)).body.error.code).toBe('LIMIT_PER_TRANSFER');
    await send(a, token, { recipient: 'bob', amountPaise: 1_000_000 }).expect(201);
    await send(a, token, { recipient: 'bob', amountPaise: 1_000_000 }).expect(201);
    const over = (await send(a, token, { recipient: 'bob', amountPaise: 1_000_000 }).expect(422)).body.error;
    expect(over.code).toBe('LIMIT_DAILY'); expect(over.limit.remainingPaise).toBe('500000'); expect(over.message).toContain('₹5,000.00');
    const snap = (await request(a).get('/api/payments/limits').set(auth(token)).expect(200)).body;
    expect(snap).toMatchObject({ dailyLimitPaise: '2500000', dailyUsedPaise: '2000000', dailyRemainingPaise: '500000' });

    const v = mk({ hourlyTransfers: 3, stepUpPaise: 1e12 });
    const c = await signup(v, 'carol'); await signup(v, 'dave'); await fund(v, c.token, 100_000).expect(201);
    for (let i = 0; i < 3; i++) await send(v, c.token, { recipient: 'dave', amountPaise: 100 }).expect(201);
    const r = await send(v, c.token, { recipient: 'dave', amountPaise: 100 }).expect(429);
    expect(r.body.error.code).toBe('LIMIT_VELOCITY'); expect(r.headers['retry-after']).toBeDefined();
  });
  it('is race-free: parallel sends can never push the 24h total past the limit', async () => {
    const a = mk({ dailySendPaise: 2_500_000, stepUpPaise: 1e12 });
    const { token } = await signup(a, 'alice'); await signup(a, 'bob');
    await fund(a, token, 6_000_000).expect(201);
    const rs = await Promise.all(Array.from({ length: 12 }, () => send(a, token, { recipient: 'bob', amountPaise: 400_000 })));
    const ok = rs.filter(r => r.status === 201).length;
    expect(ok).toBe(6); expect(rs.filter(r => r.status === 422).length).toBe(6); // 6 x 4,00,000 = 24,00,000 <= 25,00,000 < 28,00,000
    expect((await pool.query("SELECT COALESCE(SUM(amount_paise),0)::int s FROM transactions WHERE type='TRANSFER'")).rows[0].s).toBe(2_400_000);
  });
  it('tightens the cap for brand-new accounts and honours an admin override', async () => {
    const a = mk({ newAccountHours: 72, newAccountDailySendPaise: 300_000, dailySendPaise: 10_000_000, stepUpPaise: 1e12 });
    const { token } = await signup(a, 'alice'); await signup(a, 'bob'); await fund(a, token, 2_000_000).expect(201);
    expect((await send(a, token, { recipient: 'bob', amountPaise: 400_000 }).expect(422)).body.error.code).toBe('LIMIT_DAILY');
    const admin = await adminToken(a);
    await request(a).patch(`/api/admin/users/${await uid('alice')}/limits`).set(auth(admin)).send({ dailySendLimitPaise: 900_000, reason: 'verified customer' }).expect(200);
    await send(a, token, { recipient: 'bob', amountPaise: 400_000 }).expect(201);
    expect((await pool.query("SELECT action FROM audit_logs WHERE action='ADMIN_LIMIT_CHANGED'")).rowCount).toBe(1);
    await request(a).patch(`/api/admin/users/${await uid('alice')}/limits`).set(auth(admin)).send({ dailySendLimitPaise: 1, reason: '' }).expect(400);
  });
});

describe('risk engine end to end', () => {
  const setup = async (a: any) => {
    const al = await signup(a, 'alice'); await signup(a, 'bob'); await signup(a, 'carol');
    await pool.query("UPDATE users SET created_at = now() - interval '30 days' WHERE username IN ('alice','bob')");
    await fund(a, al.token, 5_000_000).expect(201);
    return { al, ids: { alice: await uid('alice'), bob: await uid('bob'), carol: await uid('carol') } };
  };
  const history = async (alice: string, bob: string, count: number, ageSql: string) => {
    for (let i = 0; i < count; i++) await transfer(pool, { senderUserId: alice, receiverUserId: bob, amountPaise: 10_000, idempotencyKey: k() });
    await pool.query(`UPDATE transactions SET created_at = ${ageSql} WHERE type='TRANSFER'`);
  };
  it('challenges an out-of-pattern payment (PIN required below the amount threshold) and records the decision', async () => {
    const a = mk({ riskChallenge: 40, riskBlock: 80, stepUpPaise: 1e12 });
    const { al, ids } = await setup(a);
    await history(ids.alice, ids.bob, 3, "now() - interval '2 days'");
    await request(a).put('/api/security/pin').set(auth(al.token)).send({ pin: '482913', password: PW }).expect(204);
    const body = { recipient: 'carol', amountPaise: 300_000 }, key = k();
    expect((await send(a, al.token, body, key).expect(403)).body.error.code).toBe('STEP_UP_REQUIRED');
    await send(a, al.token, { ...body, pin: '482913' }, key).expect(201);
    const e = (await pool.query("SELECT decision, score, transaction_id, review_status, reasons FROM risk_events WHERE amount_paise=300000")).rows[0];
    expect(e).toMatchObject({ decision: 'CHALLENGE', review_status: 'NONE' }); expect(e.transaction_id).toBeTruthy();
    expect(e.reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(['AMOUNT_SPIKE', 'NEW_RECIPIENT_ACCOUNT']));
  });
  it('blocks stacked signals, moves no money, queues the event, and lets an admin review it', async () => {
    const a = mk({ riskChallenge: 40, riskBlock: 80, stepUpPaise: 1e12 });
    const { al, ids } = await setup(a);
    await pool.query("UPDATE users SET created_at = now() - interval '1 hour' WHERE username='alice'");
    await history(ids.alice, ids.bob, 6, "now() - interval '1 minute'");
    const before = (await pool.query("SELECT balance_paise::int b FROM wallets WHERE user_id=$1", [ids.alice])).rows[0].b;
    const r = await send(a, al.token, { recipient: 'carol', amountPaise: 2_000_000 }).expect(403);
    expect(r.body.error.code).toBe('RISK_BLOCKED'); expect(r.body.error.reference).toBeDefined();
    expect(JSON.stringify(r.body)).not.toMatch(/score|VELOCITY|AMOUNT_SPIKE/); // the caller learns nothing about how to tune an attack
    expect((await pool.query("SELECT balance_paise::int b FROM wallets WHERE user_id=$1", [ids.alice])).rows[0].b).toBe(before);
    expect((await pool.query("SELECT review_status, decision FROM risk_events WHERE decision='BLOCK'")).rows).toEqual([{ review_status: 'OPEN', decision: 'BLOCK' }]);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='RISK_BLOCKED'")).rowCount).toBe(1);

    const admin = await adminToken(a);
    const q = (await request(a).get('/api/admin/risk-events?review=OPEN').set(auth(admin)).expect(200)).body;
    expect(q.total).toBe(1); expect(q.items[0]).toMatchObject({ sender: 'alice', recipient: 'carol', decision: 'BLOCK' });
    await request(a).patch(`/api/admin/risk-events/${q.items[0].id}`).set(auth(admin)).send({ review: 'CONFIRMED_FRAUD', note: 'drained new account' }).expect(200);
    await request(a).patch(`/api/admin/risk-events/${q.items[0].id}`).set(auth(admin)).send({ review: 'DISMISSED' }).expect(409);
    const an = (await request(a).get('/api/admin/analytics').set(auth(admin)).expect(200)).body;
    expect(an.risk).toMatchObject({ block: 1, openReviews: 0 });
  });
});

describe('request-level protection', () => {
  it('rate-limits money endpoints per account and sets hardening headers', async () => {
    const a = mk({ rate: { send: 3, funding: 1000, search: 1000, sensitive: 1000 }, stepUpPaise: 1e12 });
    const { token } = await signup(a, 'alice'); await signup(a, 'bob'); await fund(a, token, 100_000).expect(201);
    const codes: number[] = []; for (let i = 0; i < 5; i++) codes.push((await send(a, token, { recipient: 'bob', amountPaise: 100 })).status);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
    const h = await request(a).get('/api/health').expect(200);
    expect(h.headers['cache-control']).toBe('no-store'); expect(h.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.headers['content-security-policy']).toContain("default-src 'none'"); expect(h.headers['strict-transport-security']).toContain('max-age=');
  });
  it('can require 2FA for administrators', async () => {
    const a = mk({ requireAdminMfa: true });
    const admin = await adminToken(a);
    expect((await request(a).get('/api/admin/analytics').set(auth(admin)).expect(403)).body.error.code).toBe('MFA_REQUIRED');
    await pool.query("UPDATE users SET totp_enabled=true WHERE username='admin'");
    await request(a).get('/api/admin/analytics').set(auth(admin)).expect(200);
  });
  it('lists and revokes individual sessions', async () => {
    const a = mk();
    const one = await signup(a, 'alice');
    await request(a).post('/api/auth/login').send({ email: 'alice@t.dev', password: PW }).expect(200);
    const s = (await request(a).get('/api/security/sessions').set(auth(one.token)).expect(200)).body.items;
    expect(s).toHaveLength(2);
    await request(a).delete(`/api/security/sessions/${s[0].id}`).set(auth(one.token)).expect(204);
    await request(a).delete(`/api/security/sessions/${s[0].id}`).set(auth(one.token)).expect(404);
    expect((await request(a).get('/api/security/sessions').set(auth(one.token)).expect(200)).body.items).toHaveLength(1);
    await request(a).post('/api/security/sessions/revoke-all').set(auth(one.token)).expect(204);
    expect((await request(a).get('/api/security/status').set(auth(one.token)).expect(200)).body.activeSessions).toBe(0);
  });
});

describe('tamper-evident audit log', () => {
  it('stays valid under concurrent writers and detects an edited row', async () => {
    const a = mk();
    const { token } = await signup(a, 'alice');
    await Promise.all(Array.from({ length: 30 }, (_, i) => request(a).post('/api/auth/login').send({ email: `ghost${i}@t.dev`, password: 'WrongPassw0rd' })));
    const admin = await adminToken(a);
    const v = (await request(a).get('/api/admin/audit-logs/verify').set(auth(admin)).expect(200)).body;
    expect(v.ok).toBe(true); expect(v.checked).toBeGreaterThanOrEqual(33); expect(v.head).toMatch(/^[0-9a-f]{64}$/);
    void token;
    const c = await pool.connect();
    try { await c.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable'); await c.query("UPDATE audit_logs SET ip='6.6.6.6' WHERE seq=5"); await c.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable'); } finally { c.release(); }
    const t = (await request(a).get('/api/admin/audit-logs/verify').set(auth(admin)).expect(200)).body;
    expect(t).toMatchObject({ ok: false, brokenAtSeq: 5 });
  });
});
