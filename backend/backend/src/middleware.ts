import type { Pool } from 'pg';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import { HttpError } from './errors';
import { PaymentError } from './services/payments';
import { jwtSecret } from './services/auth';

export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler => (req, res, next) => { fn(req, res, next).catch(next); };
export const me = (res: Response) => res.locals.user as { id: string; role: string };

export const authenticate = (pool: Pool) => ah(async (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
  let sub: string;
  try { sub = (jwt.verify(m[1], jwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload).sub!; }
  catch { throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token'); }
  // Role and status come from the DB on every request so suspension and demotion apply immediately.
  const u = (await pool.query('SELECT id,role,status FROM users WHERE id=$1', [sub])).rows[0];
  if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
  if (u.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
  res.locals.user = { id: u.id, role: u.role };
  next();
});
export const requireRole = (role: string): RequestHandler => (_req, res, next) =>
  me(res).role === role ? next() : next(new HttpError(403, 'FORBIDDEN', 'Insufficient permissions'));
// CSRF defence for cookie-authenticated routes: SameSite=Strict cookie plus a custom header that cross-site forms cannot send.
export const csrfHeader: RequestHandler = (req, _res, next) =>
  req.header('x-requested-with') === 'minipay' ? next() : next(new HttpError(403, 'CSRF', 'Missing required header'));

export const idempotencyKey = (req: Request) => {
  const k = req.header('idempotency-key');
  if (!k || !/^[A-Za-z0-9_-]{8,100}$/.test(k)) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-100 chars) is required');
  return k;
};
const PAY_STATUS: Record<string, number> = { INVALID_AMOUNT: 400, SELF_TRANSFER: 400, INSUFFICIENT_FUNDS: 422, ACCOUNT_SUSPENDED: 403, NO_WALLET: 404 };
export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err instanceof PaymentError) return res.status(PAY_STATUS[err.code] ?? 400).json({ error: { code: err.code, message: err.message } });
  if (err instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid request', details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } });
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: { code: 'BAD_BODY', message: 'Malformed request body' } });
  console.error(`[error] ${req.method} ${req.path}: ${err?.message ?? 'unknown'}`); // message only: never bodies, headers or tokens
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
