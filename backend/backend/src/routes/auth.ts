import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import rateLimit from 'express-rate-limit';
import * as auth from '../services/auth';
import { ah, csrfHeader } from '../middleware';
import { email, password, username } from '../schemas';
import { HttpError } from '../errors';

export function authRoutes(pool: Pool, authLimit: number) {
  const r = Router();
  r.use(rateLimit({ windowMs: 15 * 60_000, limit: authLimit, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try later' } } }));
  const meta = (req: any) => ({ ua: req.headers['user-agent'], ip: req.ip });
  const cookie = (res: any, t: string) => res.cookie('refresh_token', t, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api/auth', maxAge: auth.REFRESH_DAYS * 86_400_000 });

  r.post('/register', ah(async (req, res) => {
    const b = z.object({ email, username, password, fullName: z.string().trim().max(80).regex(/^[^<>]*$/).optional() }).strict().parse(req.body);
    res.status(201).json(await auth.register(pool, b, req.ip));
  }));
  r.post('/login', ah(async (req, res) => {
    const b = z.object({ email, password: z.string().max(128) }).strict().parse(req.body);
    const s = await auth.login(pool, b.email, b.password, meta(req));
    cookie(res, s.refreshToken); res.json({ accessToken: s.accessToken });
  }));
  r.post('/refresh', csrfHeader, ah(async (req, res) => {
    const t = req.cookies?.refresh_token; if (!t) throw new HttpError(401, 'INVALID_REFRESH', 'Invalid or expired session');
    const s = await auth.refresh(pool, t, meta(req)); cookie(res, s.refreshToken); res.json({ accessToken: s.accessToken });
  }));
  r.post('/logout', csrfHeader, ah(async (req, res) => {
    await auth.logout(pool, req.cookies?.refresh_token); res.clearCookie('refresh_token', { path: '/api/auth' }); res.status(204).end();
  }));
  r.post('/forgot-password', ah(async (req, res) => {
    const b = z.object({ email }).strict().parse(req.body);
    const t = await auth.forgotPassword(pool, b.email, req.ip);
    // Same response whether or not the account exists. Token is exposed only in tests; real delivery needs an email transport.
    res.status(202).json({ message: 'If that account exists, a reset link has been sent', ...(process.env.NODE_ENV === 'test' && t ? { devToken: t } : {}) });
  }));
  r.post('/reset-password', ah(async (req, res) => {
    const b = z.object({ token: z.string().min(20).max(100), password }).strict().parse(req.body);
    await auth.resetPassword(pool, b.token, b.password, req.ip); res.status(204).end();
  }));
  return r;
}
