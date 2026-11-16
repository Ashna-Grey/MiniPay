import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { authenticate, errorHandler, requireAdminMfa } from './middleware';
import { authRoutes } from './routes/auth';
import { walletRoutes } from './routes/wallet';
import { paymentRoutes } from './routes/payments';
import { userRoutes } from './routes/users';
import swaggerUi from 'swagger-ui-express';
import { adminRoutes } from './routes/admin';
import { openapi } from './openapi';
import { requireRole } from './middleware';
import { jwtSecret } from './services/auth';
import { securityRoutes } from './routes/security';
import { Throttle } from './services/throttle';
import { makeLimiters, noStore, requestId, resolveSecurity, type SecurityConfig } from './security';

export function createApp(pool: Pool, opts: { authLimit?: number; security?: Partial<SecurityConfig> } = {}) {
  jwtSecret(); // fail fast if the secret is missing
  const cfg = resolveSecurity(opts.security), lim = makeLimiters(cfg), th = new Throttle(pool, cfg.enforce);
  const app = express();
  app.disable('x-powered-by');
  // Behind Vercel/Render every request arrives from a proxy. Without this, req.ip is the proxy's address and all IP-based
  // limits and audit entries collapse onto one value. Set TRUST_PROXY to the number of proxy hops (see .env.example).
  app.set('trust proxy', cfg.trustProxy);
  app.use(requestId);
  // API docs are mounted before helmet because Swagger UI needs inline scripts that the strict CSP blocks.
  app.get('/api/openapi.json', (_q, res) => res.json(openapi));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi as any));
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } }, // this origin serves JSON only
    referrerPolicy: { policy: 'no-referrer' }, crossOriginResourcePolicy: { policy: 'same-origin' },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
  }));
  app.use('/api', noStore);
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  if (process.env.NODE_ENV !== 'test') app.use((req, res, next) => { res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode}`)); next(); });
  app.get('/api/health', (_q, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes(pool, opts.authLimit ?? 20, th));
  const guard = authenticate(pool);
  app.use('/api/wallet', guard, walletRoutes(pool, cfg, lim));
  app.use('/api/payments', guard, paymentRoutes(pool, cfg, th, lim));
  app.use('/api/users', guard, userRoutes(pool, lim));
  app.use('/api/security', guard, securityRoutes(pool, th, lim));
  app.use('/api/admin', guard, requireRole('ADMIN'), requireAdminMfa(cfg.enforce && cfg.requireAdminMfa), adminRoutes(pool));
  app.use((_q, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  app.use(errorHandler);
  return app;
}
