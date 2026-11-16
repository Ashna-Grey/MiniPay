import type { Pool } from 'pg';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { HttpError } from '../errors';
import { audit, issue, jwtSecret, verifyUserPassword } from './auth';
import { RULES, Throttle, tooMany } from './throttle';
import { decryptSecret, encryptSecret, newSecret, otpauthUrl, verifyTotp } from './totp';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const B32L = 'abcdefghijklmnopqrstuvwxyz234567';
const newRecoveryCode = () => { const b = crypto.randomBytes(16); const c = [...b].map(x => B32L[x & 31]).join(''); return c.match(/.{4}/g)!.join('-'); }; // 80 bits
const normalizeRecovery = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');

export async function beginSetup(pool: Pool, userId: string) {
  const u = (await pool.query('SELECT email, totp_enabled FROM users WHERE id=$1', [userId])).rows[0];
  if (u.totp_enabled) throw new HttpError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already on');
  const secret = newSecret();
  await pool.query('UPDATE users SET totp_secret_enc=$1 WHERE id=$2', [encryptSecret(secret, userId), userId]);
  return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
}

/** Atomically claims a TOTP step so one code can never be used twice (replay protection). */
async function claimStep(pool: Pool, userId: string, step: number) {
  return !!(await pool.query('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [userId, step])).rowCount;
}

export async function enable(pool: Pool, userId: string, code: string, th: Throttle, ip?: string) {
  const key = 'mfa:' + userId;
  await th.assertOpen([key]);
  const u = (await pool.query('SELECT totp_secret_enc, totp_enabled FROM users WHERE id=$1', [userId])).rows[0];
  if (u.totp_enabled) throw new HttpError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already on');
  if (!u.totp_secret_enc) throw new HttpError(400, 'MFA_NOT_STARTED', 'Start setup first');
  const step = verifyTotp(decryptSecret(u.totp_secret_enc, userId), code);
  if (step === null) { const f = await th.fail(key, RULES.mfa); if (f.locked) throw tooMany(f.until!); throw new HttpError(400, 'INVALID_CODE', 'That code is not right. Check your authenticator app and try again.'); }
  const codes = Array.from({ length: 8 }, newRecoveryCode);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE users SET totp_enabled=true, totp_last_step=$2 WHERE id=$1', [userId, step]);
    await c.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId]);
    for (const x of codes) await c.query('INSERT INTO recovery_codes(user_id, code_hash) VALUES($1,$2)', [userId, sha(x)]);
    await c.query('INSERT INTO audit_logs(actor_user_id,action,ip) VALUES($1,$2,$3)', [userId, 'MFA_ENABLED', ip]); // audit insert last: see 003 migration
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  await th.clear(key);
  return { recoveryCodes: codes };
}

/** Accepts a current authenticator code or an unused recovery code. Throttled per user. */
export async function verifySecondFactor(pool: Pool, userId: string, code: string, th: Throttle, ip?: string): Promise<boolean> {
  const key = 'mfa:' + userId;
  await th.assertOpen([key]);
  const u = (await pool.query('SELECT totp_secret_enc, totp_enabled FROM users WHERE id=$1', [userId])).rows[0];
  let ok = false;
  if (u?.totp_enabled && u.totp_secret_enc) {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) { const step = verifyTotp(decryptSecret(u.totp_secret_enc, userId), trimmed); ok = step !== null && await claimStep(pool, userId, step); }
    else ok = !!(await pool.query('UPDATE recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id', [userId, sha(normalizeRecovery(code))])).rowCount;
  }
  if (ok) { await th.clear(key); return true; }
  const f = await th.fail(key, RULES.mfa);
  await audit(pool, userId, 'MFA_FAILED', undefined, undefined, ip);
  if (f.locked) throw tooMany(f.until!);
  return false;
}

export async function loginMfa(pool: Pool, mfaToken: string, code: string, meta: { ua?: string; ip?: string }, th: Throttle) {
  let sub: string;
  try {
    const p = jwt.verify(mfaToken, jwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (p.typ !== 'mfa' || !p.sub) throw new Error('wrong token type');
    sub = p.sub;
  } catch { throw new HttpError(401, 'INVALID_MFA_TOKEN', 'Your sign-in expired. Start again.'); }
  const u = (await pool.query('SELECT id, role, status FROM users WHERE id=$1', [sub])).rows[0];
  if (!u) throw new HttpError(401, 'INVALID_MFA_TOKEN', 'Your sign-in expired. Start again.');
  if (u.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
  if (!(await verifySecondFactor(pool, u.id, code, th, meta.ip))) throw new HttpError(401, 'INVALID_CODE', 'That code is not right.');
  await audit(pool, u.id, 'LOGIN_SUCCESS', undefined, { mfa: true }, meta.ip);
  return issue(pool, u, meta);
}

export async function disable(pool: Pool, userId: string, password: string, code: string, th: Throttle, ip?: string) {
  if (!(await verifyUserPassword(pool, userId, password))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
  if (!(await verifySecondFactor(pool, userId, code, th, ip))) throw new HttpError(400, 'INVALID_CODE', 'That code is not right.');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE users SET totp_enabled=false, totp_secret_enc=NULL, totp_last_step=NULL WHERE id=$1', [userId]);
    await c.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId]);
    await c.query('INSERT INTO audit_logs(actor_user_id,action,ip) VALUES($1,$2,$3)', [userId, 'MFA_DISABLED', ip]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
