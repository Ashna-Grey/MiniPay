import type { Pool, PoolClient } from 'pg';
import { PaymentError } from './payments';
import type { SecurityConfig } from '../security';

type Q = Pick<Pool | PoolClient, 'query'>;
export const fmt = (p: bigint | number | string) => { const a = BigInt(p); return `₹${(a / 100n).toLocaleString('en-IN')}.${(a % 100n).toString().padStart(2, '0')}`; };

async function usage(q: Q, userId: string) {
  const r = (await q.query(`
    SELECT u.daily_send_limit_paise::text AS override, EXTRACT(EPOCH FROM now() - u.created_at) / 3600 AS age_h,
      COALESCE((SELECT sum(t.amount_paise) FROM transactions t WHERE t.sender_wallet_id = w.id AND t.type='TRANSFER' AND t.status='COMPLETED' AND t.created_at > now() - interval '24 hours'), 0)::text AS used_day,
      (SELECT count(*) FROM transactions t WHERE t.sender_wallet_id = w.id AND t.type='TRANSFER' AND t.created_at > now() - interval '1 hour')::int AS count_hour,
      COALESCE((SELECT sum(t.amount_paise) FROM transactions t WHERE t.receiver_wallet_id = w.id AND t.type='FUNDING' AND t.status='COMPLETED' AND t.created_at > now() - interval '24 hours'), 0)::text AS funded_day
    FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.id = $1`, [userId])).rows[0];
  return { override: r.override === null ? null : BigInt(r.override), ageH: Number(r.age_h), usedDay: BigInt(r.used_day), countHour: r.count_hour as number, fundedDay: BigInt(r.funded_day) };
}

/** An explicit admin override wins; otherwise young accounts get the tighter cap. */
export function dailyLimit(cfg: SecurityConfig, u: { override: bigint | null; ageH: number }): bigint {
  if (u.override !== null) return u.override;
  const base = BigInt(cfg.dailySendPaise);
  return u.ageH < cfg.newAccountHours ? (BigInt(cfg.newAccountDailySendPaise) < base ? BigInt(cfg.newAccountDailySendPaise) : base) : base;
}

/**
 * Hard send limits. Call it inside the transfer transaction after the sender wallet is locked: that lock serialises
 * one user's transfers, so concurrent requests cannot each pass the check and together exceed the limit.
 */
export async function enforceSendLimits(q: Q, cfg: SecurityConfig, userId: string, amountPaise: number) {
  if (!cfg.enforce) return;
  const amount = BigInt(amountPaise);
  if (amount > BigInt(cfg.perTransferPaise)) throw new PaymentError('LIMIT_PER_TRANSFER', `A single payment can be at most ${fmt(cfg.perTransferPaise)}.`, { limit: { perTransferPaise: String(cfg.perTransferPaise) } });
  const u = await usage(q, userId), cap = dailyLimit(cfg, u);
  if (u.countHour >= cfg.hourlyTransfers) throw new PaymentError('LIMIT_VELOCITY', `You have reached ${cfg.hourlyTransfers} payments in the last hour. Try again later.`, { retryAfterSeconds: 600 });
  if (u.usedDay + amount > cap) {
    const left = cap > u.usedDay ? cap - u.usedDay : 0n;
    throw new PaymentError('LIMIT_DAILY', `This would exceed your 24-hour sending limit of ${fmt(cap)}. You can still send ${fmt(left)}.`, { limit: { dailyPaise: String(cap), usedPaise: String(u.usedDay), remainingPaise: String(left) } });
  }
}

export async function enforceFundingLimit(q: Q, cfg: SecurityConfig, userId: string, amountPaise: number) {
  if (!cfg.enforce) return;
  const u = await usage(q, userId), cap = BigInt(cfg.dailyFundingPaise);
  if (u.fundedDay + BigInt(amountPaise) > cap) {
    const left = cap > u.fundedDay ? cap - u.fundedDay : 0n;
    throw new PaymentError('LIMIT_FUNDING', `Adding this would exceed your 24-hour top-up limit of ${fmt(cap)}. You can still add ${fmt(left)}.`, { limit: { dailyPaise: String(cap), remainingPaise: String(left) } });
  }
}

/** What the UI shows: all values are strings of paise. */
export async function limitsSnapshot(q: Q, cfg: SecurityConfig, userId: string) {
  const u = await usage(q, userId), cap = dailyLimit(cfg, u), left = cap > u.usedDay ? cap - u.usedDay : 0n;
  return {
    perTransferPaise: String(cfg.perTransferPaise), dailyLimitPaise: String(cap), dailyUsedPaise: String(u.usedDay), dailyRemainingPaise: String(left),
    hourlyTransfersLeft: Math.max(0, cfg.hourlyTransfers - u.countHour), stepUpThresholdPaise: String(cfg.stepUpPaise),
    fundingDailyLimitPaise: String(cfg.dailyFundingPaise), fundingDailyUsedPaise: String(u.fundedDay),
    newAccount: u.override === null && u.ageH < cfg.newAccountHours, customLimit: u.override !== null,
  };
}
