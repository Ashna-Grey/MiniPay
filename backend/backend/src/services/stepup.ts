import type { Pool } from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import { HttpError } from '../errors';
import { audit } from './auth';
import { RULES, Throttle, tooMany } from './throttle';

const ARGON = { type: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const WEAK = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123123', '121212', '112233', '696969']);
const sequential = (p: string) => '0123456789'.includes(p) || '9876543210'.includes(p);
/** A 6-digit PIN has only a million values, so the lockout (5 tries, 30 minutes) is what really protects it. Trivial PINs are refused. */
export const pinSchema = z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits').refine(p => !WEAK.has(p) && !sequential(p), 'That PIN is too easy to guess');

export async function setPin(pool: Pool, userId: string, pin: string, ip?: string) {
  await pool.query('UPDATE users SET pin_hash=$1 WHERE id=$2', [await argon2.hash(pin, ARGON), userId]);
  await audit(pool, userId, 'PIN_SET', undefined, undefined, ip);
}

/** Verifies the transaction PIN for a step-up. Throws a specific code so the UI knows what to ask for. */
export async function requirePin(pool: Pool, th: Throttle, userId: string, pin: string | undefined, ip?: string) {
  const u = (await pool.query('SELECT pin_hash FROM users WHERE id=$1', [userId])).rows[0];
  if (!u?.pin_hash) throw new HttpError(403, 'PIN_SETUP_REQUIRED', 'Set a transaction PIN in Security before sending money.');
  if (!pin) throw new HttpError(403, 'STEP_UP_REQUIRED', 'Confirm this payment with your transaction PIN.', { stepUp: 'PIN' });
  const key = 'pin:' + userId;
  await th.assertOpen([key]);
  if (await argon2.verify(u.pin_hash, pin).catch(() => false)) { await th.clear(key); return; }
  const f = await th.fail(key, RULES.pin);
  await audit(pool, userId, 'PIN_FAILED', undefined, undefined, ip);
  if (f.locked) { await audit(pool, userId, 'PIN_LOCKED', undefined, undefined, ip); throw tooMany(f.until!); }
  throw new HttpError(403, 'PIN_INVALID', 'That PIN is not right.');
}
