# MiniPay — Phases 1–4 (money engine, auth, REST API, admin API, CSV, OpenAPI)
Verified so far: schema, append-only double-entry ledger, atomic transfers, idempotency, concurrency tests (13 passing).
Phase 3 adds: register/login/logout/refresh (rotation + reuse detection), forgot/reset password, wallet, payments, users routes, audit log.
Phase 4 adds: admin API (users, suspend/reactivate, transactions, analytics, audit logs, security events), CSV export, OpenAPI at /api/docs and /api/openapi.json.
Not built yet: receipt PDF, email delivery, frontend, admin, E2E, Docker, OpenAPI, Prisma (see status table in chat).

## Run
1. Create a Postgres DB and user; copy `backend/.env.example` to `.env` and set `DATABASE_URL`.
2. `cd backend && npm install`
3. `DATABASE_URL=... npm test` (WARNING: tests DROP and recreate the `public` schema; use a throwaway DB.)

## Design decisions
- Money = BIGINT paise (INR). Stored wallet balance is a cache; `reconcile()` checks it against the ledger.
- Funding uses a `__system_funding__` counter-party wallet so every entry has a debit and credit; global ledger net is always 0.
- Both wallets are locked `FOR UPDATE` in id order (no deadlocks). Idempotency is unique per (initiator, key).
- DB triggers make ledger_entries immutable and block transaction deletes. CHECK blocks negative balances.
- Prisma deferred: its engine download was blocked in my sandbox, so this phase uses SQL migrations + `pg`.

## Phase 3 notes
- Set `JWT_SECRET` (32+ chars). `npm run` start: `npx tsx src/server.ts` (applies migrations on boot).
- Cookie routes (`/auth/refresh`, `/auth/logout`) need header `X-Requested-With: minipay` (CSRF defence with SameSite=Strict).
- `Idempotency-Key` header is required on `/payments/send` and `/wallet/add-funds`.
- Password reset has no email transport: the token is only returned in `NODE_ENV=test`.
- Suspension and role are read from the DB on every request, so they take effect immediately.

## Phase 4 notes
- Create an admin: `ADMIN_EMAIL=... ADMIN_USERNAME=... ADMIN_PASSWORD=... npm run seed:admin` (password policy enforced; nothing hardcoded).
- Admins can list/search users, suspend/reactivate (reason required, audited, sessions revoked), and view transactions, analytics and logs. There are intentionally NO admin routes to edit transactions or balances; DB triggers also block ledger edits.
- Admins cannot suspend other admins (or themselves).
- `GET /api/payments/export.csv` exports only the caller's rows (max 10,000); cells starting with = + - @ are neutralised.
- API docs are served before Helmet's CSP because Swagger UI needs inline scripts.
- Tests share one throwaway database and drop its schema: run them only against a disposable DB.
