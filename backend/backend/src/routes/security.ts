import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ah, me } from '../middleware';
import { HttpError } from '../errors';
import { audit, verifyUserPassword } from '../services/auth';
import * as mfa from '../services/mfa';
import { pinSchema, setPin } from '../services/stepup';
import type { Throttle } from '../services/throttle';
import type { Limiters } from '../security';

/** Account security center: 2FA, transaction PIN and device sessions. Mounted behind the auth guard. */
export function securityRoutes(pool: Pool, th: Throttle, lim: Limiters) {
  const r = Router();

  r.get('/status', ah(async (_q, res) => {
    const id = me(res).id;
    const u = (await pool.query('SELECT totp_enabled AS "totpEnabled", (pin_hash IS NOT NULL) AS "hasPin" FROM users WHERE id=$1', [id])).rows[0];
    const codes = (await pool.query('SELECT count(*)::int AS n FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL', [id])).rows[0].n;
    const sessions = (await pool.query('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()', [id])).rows[0].n;
    res.json({ ...u, recoveryCodesLeft: codes, activeSessions: sessions });
  }));

  r.post('/2fa/setup', lim.sensitive, ah(async (_q, res) => { res.status(201).json(await mfa.beginSetup(pool, me(res).id)); }));
  r.post('/2fa/enable', lim.sensitive, ah(async (req, res) => {
    const b = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict().parse(req.body);
    res.json(await mfa.enable(pool, me(res).id, b.code, th, req.ip));
  }));
  r.post('/2fa/disable', lim.sensitive, ah(async (req, res) => {
    const b = z.object({ password: z.string().max(128), code: z.string().trim().min(6).max(40) }).strict().parse(req.body);
    await mfa.disable(pool, me(res).id, b.password, b.code, th, req.ip); res.status(204).end();
  }));

  // Setting or changing the PIN needs the password, plus a 2FA code when 2FA is on, so a stolen session alone cannot replace it.
  r.put('/pin', lim.sensitive, ah(async (req, res) => {
    const b = z.object({ pin: pinSchema, password: z.string().max(128), code: z.string().trim().min(6).max(40).optional() }).strict().parse(req.body);
    const id = me(res).id;
    if (!(await verifyUserPassword(pool, id, b.password))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
    if (me(res).mfa) {
      if (!b.code) throw new HttpError(400, 'CODE_REQUIRED', 'Enter your authenticator code to change the PIN.');
      if (!(await mfa.verifySecondFactor(pool, id, b.code, th, req.ip))) throw new HttpError(400, 'INVALID_CODE', 'That code is not right.');
    }
    await setPin(pool, id, b.pin, req.ip); res.status(204).end();
  }));

  // Active refresh tokens are one per session family, so family_id is a stable session id.
  r.get('/sessions', ah(async (_q, res) => {
    const items = (await pool.query(`SELECT family_id AS id, created_at AS "startedAt", ip, user_agent AS "userAgent" FROM refresh_tokens
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 20`, [me(res).id])).rows;
    res.json({ items });
  }));
  r.delete('/sessions/:id', ah(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    const n = (await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND family_id=$2 AND revoked_at IS NULL', [me(res).id, id.data])).rowCount;
    if (!n) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    await audit(pool, me(res).id, 'SESSION_REVOKED', id.data, undefined, req.ip); res.status(204).end();
  }));
  r.post('/sessions/revoke-all', ah(async (req, res) => {
    const n = (await pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [me(res).id])).rowCount;
    await audit(pool, me(res).id, 'SESSIONS_REVOKED_ALL', undefined, { count: n }, req.ip); res.status(204).end();
  }));
  return r;
}
