import { pool } from './db';
import { applyMigrations } from './migrate';
import { createApp } from './app';
import { defaultSecurity } from './security';
(async () => {
  await applyMigrations(pool);
  const cfg = defaultSecurity();
  if (process.env.NODE_ENV === 'production' && cfg.trustProxy === false) console.warn('[security] TRUST_PROXY is not set: every client will look like the proxy. Set it to the number of proxy hops in front of this app.');
  if (process.env.NODE_ENV === 'production' && !process.env.DATA_ENCRYPTION_KEY) console.warn('[security] DATA_ENCRYPTION_KEY is not set: 2FA secrets are encrypted with a key derived from JWT_SECRET.');
  // Housekeeping: drop expired throttle counters.
  setInterval(() => { pool.query("DELETE FROM auth_throttle WHERE COALESCE(locked_until, first_fail_at) < now() - interval '1 day'").catch(() => {}); }, 3_600_000).unref();
  createApp(pool).listen(Number(process.env.PORT ?? 4000), () => console.log('MiniPay API up'));
})();
