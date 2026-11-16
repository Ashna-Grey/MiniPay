import { pool } from './db';
import { applyMigrations } from './migrate';
import { createAdmin } from './services/admin';
// Credentials come from the environment only; nothing is hardcoded.
(async () => {
  const { ADMIN_EMAIL, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_USERNAME || !ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL, ADMIN_USERNAME and ADMIN_PASSWORD');
  await applyMigrations(pool);
  console.log((await createAdmin(pool, { email: ADMIN_EMAIL, username: ADMIN_USERNAME, password: ADMIN_PASSWORD })).created ? 'Admin created' : 'Admin already exists');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
