import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/** All amounts are paise. Every value can be overridden with an environment variable (see .env.example). */
export interface SecurityConfig {
  /** false = limits, risk scoring, step-up, lockouts, rate limits and admin-MFA are all skipped. Only ever false under NODE_ENV=test. */
  enforce: boolean;
  trustProxy: boolean | number | string;
  perTransferPaise: number;
  dailySendPaise: number;
  newAccountDailySendPaise: number;
  newAccountHours: number;
  hourlyTransfers: number;
  dailyFundingPaise: number;
  /** Payments at or above this amount always need the transaction PIN. */
  stepUpPaise: number;
  riskChallenge: number;
  riskBlock: number;
  rate: { send: number; funding: number; search: number; sensitive: number };
  requireAdminMfa: boolean;
}

const num = (k: string, d: number) => { const v = process.env[k]; if (v === undefined || v === '') return d; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`); return n; };
const proxy = (): SecurityConfig['trustProxy'] => { const v = process.env.TRUST_PROXY; if (!v || v === 'false') return false; if (v === 'true') return true; return /^\d+$/.test(v) ? Number(v) : v; };

export const defaultSecurity = (): SecurityConfig => ({
  enforce: true,
  trustProxy: proxy(),
  perTransferPaise: num('LIMIT_PER_TRANSFER_PAISE', 10_000_000),          // Rs 1,00,000
  dailySendPaise: num('LIMIT_DAILY_SEND_PAISE', 20_000_000),              // Rs 2,00,000 rolling 24h
  newAccountDailySendPaise: num('LIMIT_NEW_ACCOUNT_DAILY_PAISE', 1_000_000), // Rs 10,000 for young accounts
  newAccountHours: num('NEW_ACCOUNT_HOURS', 72),
  hourlyTransfers: num('LIMIT_HOURLY_TRANSFERS', 20),
  dailyFundingPaise: num('LIMIT_DAILY_FUNDING_PAISE', 20_000_000),
  stepUpPaise: num('STEP_UP_THRESHOLD_PAISE', 500_000),                   // Rs 5,000
  riskChallenge: num('RISK_CHALLENGE_SCORE', 40),
  riskBlock: num('RISK_BLOCK_SCORE', 80),
  rate: { send: num('RATE_SEND_PER_MIN', 10), funding: num('RATE_FUNDING_PER_MIN', 10), search: num('RATE_SEARCH_PER_MIN', 30), sensitive: num('RATE_SENSITIVE_PER_15MIN', 10) },
  requireAdminMfa: process.env.REQUIRE_ADMIN_MFA === 'true',
});

/** Under NODE_ENV=test the security layer is off unless a test passes its own config (so the original suites keep their meaning). */
export function resolveSecurity(over?: Partial<SecurityConfig>): SecurityConfig {
  const base = defaultSecurity();
  if (process.env.NODE_ENV === 'test' && !over) return { ...base, enforce: false };
  return { ...base, ...over, rate: { ...base.rate, ...over?.rate }, enforce: true };
}

export const requestId = (req: Request, res: Response, next: NextFunction) => {
  const id = crypto.randomUUID(); res.locals.reqId = id; res.setHeader('X-Request-Id', id); next();
};
/** Financial data must never sit in a browser or proxy cache. */
export const noStore = (_q: Request, res: Response, next: NextFunction) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); };

export function makeLimiters(cfg: SecurityConfig) {
  const mk = (limit: number, windowMs: number) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => !cfg.enforce,
    // Authenticated routes are limited per account (so one user cannot be throttled by a neighbour); anonymous ones per IP.
    keyGenerator: (req, res) => res.locals.user?.id ? `u:${res.locals.user.id}` : ipKeyGenerator(req.ip ?? ''),
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again shortly.' } },
  });
  return { send: mk(cfg.rate.send, 60_000), funding: mk(cfg.rate.funding, 60_000), search: mk(cfg.rate.search, 60_000), sensitive: mk(cfg.rate.sensitive, 15 * 60_000) };
}
export type Limiters = ReturnType<typeof makeLimiters>;
