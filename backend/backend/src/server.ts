import { pool } from './db';
import { applyMigrations } from './migrate';
import { createApp } from './app';
(async () => { await applyMigrations(pool); createApp(pool).listen(Number(process.env.PORT ?? 4000), () => console.log('MiniPay API up')); })();
