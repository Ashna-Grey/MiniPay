import type { Pool } from 'pg';
import { HttpError } from '../errors';

export interface Rule { max: number; windowMs: number; lockMs: number }
const MIN = 60_000;
/** Account keys are strict; IP keys are generous because many users can share one NAT or proxy address. */
export const RULES = {
  acct: { max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN },
  ip: { max: 50, windowMs: 15 * MIN, lockMs: 15 * MIN },
  mfa: { max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN },
  pin: { max: 5, windowMs: 15 * MIN, lockMs: 30 * MIN },
} satisfies Record<string, Rule>;

export const tooMany = (until: Date) => {
  const secs = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
  return new HttpError(429, 'TEMP_LOCKED', `Too many failed attempts. Try again in ${Math.ceil(secs / 60)} minute(s).`, { retryAfterSeconds: secs });
};

/** Failed-attempt counters in Postgres (survive restarts, shared across instances). Disabled in test mode only. */
export class Throttle {
  constructor(private pool: Pool, private enabled = true) {}

  async assertOpen(keys: string[]) {
    if (!this.enabled) return;
    const r = await this.pool.query('SELECT max(locked_until) AS until FROM auth_throttle WHERE key = ANY($1) AND locked_until > now()', [keys]);
    if (r.rows[0]?.until) throw tooMany(r.rows[0].until);
  }

  /** Records one failure. Returns whether this failure tripped the lock. */
  async fail(key: string, rule: Rule): Promise<{ locked: boolean; until?: Date }> {
    if (!this.enabled) return { locked: false };
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO auth_throttle(key, fails) VALUES($1, 0) ON CONFLICT DO NOTHING', [key]);
      const row = (await c.query('SELECT fails, first_fail_at, locked_until, now() AS now FROM auth_throttle WHERE key=$1 FOR UPDATE', [key])).rows[0];
      const now = +row.now;
      if (row.locked_until && +row.locked_until > now) { await c.query('COMMIT'); return { locked: true, until: new Date(+row.locked_until) }; } // never shorten or clear a live lock
      let fails: number = row.fails, first = +row.first_fail_at;
      const lockExpired = row.locked_until && +row.locked_until <= now;
      if (lockExpired || now - first > rule.windowMs || fails === 0) { fails = 0; first = now; }
      fails += 1;
      const until = fails >= rule.max ? new Date(now + rule.lockMs) : null;
      await c.query('UPDATE auth_throttle SET fails=$2, first_fail_at=to_timestamp($3/1000.0), locked_until=$4 WHERE key=$1', [key, until ? 0 : fails, first, until]);
      await c.query('COMMIT');
      return until ? { locked: true, until } : { locked: false };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  async clear(key: string) { if (this.enabled) await this.pool.query('DELETE FROM auth_throttle WHERE key=$1', [key]); }
}
