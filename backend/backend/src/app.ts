import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { authenticate, errorHandler } from './middleware';
import { authRoutes } from './routes/auth';
import { walletRoutes } from './routes/wallet';
import { paymentRoutes } from './routes/payments';
import { userRoutes } from './routes/users';
import swaggerUi from 'swagger-ui-express';
import { adminRoutes } from './routes/admin';
import { openapi } from './openapi';
import { requireRole } from './middleware';
import { jwtSecret } from './services/auth';

export function createApp(pool: Pool, opts: { authLimit?: number } = {}) {
  jwtSecret(); // fail fast if the secret is missing
  const app = express();
  app.disable('x-powered-by');
  // API docs are mounted before helmet because Swagger UI needs inline scripts that the strict CSP blocks.
  app.get('/api/openapi.json', (_q, res) => res.json(openapi));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi as any));
  app.use(helmet());
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  if (process.env.NODE_ENV !== 'test') app.use((req, res, next) => { res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode}`)); next(); });
  app.get('/api/health', (_q, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes(pool, opts.authLimit ?? 20));
  const guard = authenticate(pool);
  app.use('/api/wallet', guard, walletRoutes(pool));
  app.use('/api/payments', guard, paymentRoutes(pool));
  app.use('/api/users', guard, userRoutes(pool));
  app.use('/api/admin', guard, requireRole('ADMIN'), adminRoutes(pool));
  app.use((_q, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  app.use(errorHandler);
  return app;
}
