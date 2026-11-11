import type { Pool } from 'pg';
import argon2 from 'argon2';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { HttpError } from '../errors';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = () => crypto.randomBytes(32).toString('base64url');
const ARGON = { type: 2 as const, // argon2id
    memoryCost: 19456, timeCost: 2, parallelism: 1 };
let dummy: Promise<string> | undefined; // equalises timing for unknown emails
const dummyHash = () => (dummy ??= argon2.hash('dummy-password', ARGON));
export const hashPassword = (p: string) => argon2.hash(p, ARGON);
export const REFRESH_DAYS = 7;

export function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (>= 32 chars)');
  return s;
}
export async function audit(pool: Pool, actor: string | null, action: string, target?: string, metadata?: object, ip?: string) {
  await pool.query('INSERT INTO audit_logs(actor_user_id,action,target,metadata,ip) VALUES($1,$2,$3,$4,$5)', [actor, action, target ?? null, metadata ?? null, ip ?? null]);
}
const accessToken = (id: string, role: string) => jwt.sign({ role }, jwtSecret(), { subject: id, expiresIn: '15m', algorithm: 'HS256' });

async function issue(pool: Pool, user: { id: string; role: string }, meta: { ua?: string; ip?: string }, family?: string) {
  const refresh = rnd();
  await pool.query(`INSERT INTO refresh_tokens(user_id,token_hash,family_id,expires_at,user_agent,ip)
    VALUES($1,$2,COALESCE($3::uuid,gen_random_uuid()),now()+($4||' days')::interval,$5,$6)`, [user.id, sha(refresh), family ?? null, REFRESH_DAYS, meta.ua?.slice(0, 200), meta.ip]);
  return { accessToken: accessToken(user.id, user.role), refreshToken: refresh };
}

export async function register(pool: Pool, i: { email: string; username: string; password: string; fullName?: string }, ip?: string) {
  const hash = await argon2.hash(i.password, ARGON);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = await c.query('INSERT INTO users(email,username,password_hash,full_name) VALUES($1,$2,$3,$4) RETURNING id', [i.email, i.username, hash, i.fullName ?? null]);
    await c.query('INSERT INTO wallets(user_id) VALUES($1)', [u.rows[0].id]);
    await c.query('INSERT INTO audit_logs(actor_user_id,action,ip) VALUES($1,$2,$3)', [u.rows[0].id, 'REGISTER', ip]);
    await c.query('COMMIT');
    return { id: u.rows[0].id as string };
  } catch (e: any) {
    await c.query('ROLLBACK');
    if (e.code === '23505') throw new HttpError(409, 'ALREADY_EXISTS', 'Email or username is already registered');
    throw e;
  } finally { c.release(); }
}

export async function login(pool: Pool, email: string, password: string, meta: { ua?: string; ip?: string }) {
  const r = await pool.query('SELECT id,role,status,password_hash FROM users WHERE email=$1 AND username <> $2', [email, '__system_funding__']);
  const u = r.rows[0];
  const ok = await argon2.verify(u?.password_hash?.startsWith('$argon2') ? u.password_hash : await dummyHash(), password).catch(() => false);
  if (!u || !ok) { await audit(pool, u?.id ?? null, 'LOGIN_FAILED', undefined, { email_known: !!u }, meta.ip); throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'); }
  if (u.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
  await audit(pool, u.id, 'LOGIN_SUCCESS', undefined, undefined, meta.ip);
  return issue(pool, u, meta);
}

export async function refresh(pool: Pool, token: string, meta: { ua?: string; ip?: string }) {
  const h = sha(token);
  const r = await pool.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING user_id,family_id`, [h]);
  if (!r.rowCount) {
    // Reuse of a rotated token signals theft: kill the whole family.
    const old = await pool.query('SELECT user_id,family_id FROM refresh_tokens WHERE token_hash=$1', [h]);
    if (old.rowCount) { await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL', [old.rows[0].family_id]); await audit(pool, old.rows[0].user_id, 'REFRESH_TOKEN_REUSE', undefined, undefined, meta.ip); }
    throw new HttpError(401, 'INVALID_REFRESH', 'Invalid or expired session');
  }
  const u = (await pool.query('SELECT id,role,status FROM users WHERE id=$1', [r.rows[0].user_id])).rows[0];
  if (!u || u.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
  return issue(pool, u, meta, r.rows[0].family_id);
}
export async function logout(pool: Pool, token?: string) {
  if (token) await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [sha(token)]);
}
export async function forgotPassword(pool: Pool, email: string, ip?: string) {
  const u = (await pool.query("SELECT id FROM users WHERE email=$1 AND status='ACTIVE' AND username <> '__system_funding__'", [email])).rows[0];
  if (!u) return null;
  const t = rnd();
  await pool.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [u.id]);
  await pool.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [u.id, sha(t)]);
  await audit(pool, u.id, 'PASSWORD_RESET_REQUESTED', undefined, undefined, ip);
  return t; // Caller decides delivery. No email transport is implemented yet.
}
export async function resetPassword(pool: Pool, token: string, newPassword: string, ip?: string) {
  const hash = await argon2.hash(newPassword, ARGON);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id', [sha(token)]);
    if (!r.rowCount) throw new HttpError(400, 'INVALID_TOKEN', 'Reset link is invalid or expired');
    const id = r.rows[0].user_id;
    await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);
    await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    await c.query('INSERT INTO audit_logs(actor_user_id,action,ip) VALUES($1,$2,$3)', [id, 'PASSWORD_RESET_COMPLETED', ip]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export async function changePassword(pool: Pool, userId: string, current: string, next: string) {
  const u = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [userId])).rows[0];
  if (!(await argon2.verify(u.password_hash, current).catch(() => false))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await argon2.hash(next, ARGON), userId]);
  await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
  await audit(pool, userId, 'PASSWORD_CHANGED');
}
