# MiniPay

A payments simulation built around a **double-entry ledger** and a **layered security model**: two-factor sign-in, a transaction PIN, spending limits, an explainable risk engine and a tamper-evident audit log. The UI is a glassmorphism React app.

> **Educational project. No real money moves. Not PCI DSS compliant.**

**Stack:** Node.js · Express · TypeScript · PostgreSQL · React · Vite · Vitest

---

## Contents
1. [Features](#features)
2. [Architecture](#architecture)
3. [How a payment is processed](#how-a-payment-is-processed)
4. [Security model](#security-model)
5. [Project structure](#project-structure)
6. [Getting started](#getting-started)
7. [Configuration](#configuration)
8. [API overview](#api-overview)
9. [Testing](#testing)
10. [Deployment](#deployment)
11. [Design decisions](#design-decisions)
12. [Known limitations](#known-limitations)
13. [Roadmap](#roadmap)

---

## Features

**Wallet and payments**
- Register, sign in, and get a wallet automatically (INR, stored as integer paise)
- Send money by username or email, with an optional note
- Simulated top-ups, transaction history with filters, receipts, CSV export (formula-injection safe)
- Idempotent payments: retrying with the same `Idempotency-Key` never charges twice

**Account security**
- Argon2id password hashing, common-password blocklist, no passwords containing your username or email
- Login lockout after repeated failures (same behaviour for unknown emails, so accounts cannot be enumerated)
- Two-factor authentication (TOTP) with single-use recovery codes
- 6-digit transaction PIN for large or unusual payments
- Rotating refresh tokens with reuse detection, per-device session list, revoke one or all sessions

**Payment protection**
- Per-payment, rolling 24-hour, hourly and top-up limits, with a lower cap for brand-new accounts
- Risk scoring on every payment (0–100) with human-readable reasons
- Suspicious payments require the PIN; high-risk payments are blocked and queued for admin review

**Admin**
- User list, suspend and reactivate (reason required, audited)
- Per-user daily-limit overrides
- Risk review queue (confirm fraud or dismiss), transaction browser, analytics, security events
- One-click verification of the audit-log hash chain
- Ledger integrity indicator (every wallet balance reconciled against its ledger entries)

**Interface**
- Glassmorphism design: blurred translucent panels over an animated aurora background
- Fallbacks for browsers without `backdrop-filter`, for reduced-transparency and for reduced-motion settings
- Security page with QR enrolment, recovery codes, PIN management and device sessions
- Live limit meters on the wallet page

---

## Architecture

```
 Browser (React + Vite)
        │  HTTPS, same origin
        ▼
 Vercel  ── static files + rewrite /api/* ──►  Render (Express API)
                                                    │
                                                    ▼
                                             PostgreSQL
```

- The UI and API share an origin through the Vercel rewrite. The refresh cookie is `SameSite=Strict` and the API sends no CORS headers.
- The access token lives only in memory. A page load restores the session through `/api/auth/refresh`.
- All money logic and security decisions are on the server. The client never decides anything.

---

## How a payment is processed

`POST /api/payments/send`

1. **Replay check.** If this `Idempotency-Key` already produced a payment, return the stored result. No new checks, no second PIN prompt.
2. **Recipient lookup.** Unknown, suspended and self-payments are rejected.
3. **Hard limits (pre-check).** Per-payment, 24-hour, hourly. This stops anyone typing a PIN for a payment that cannot succeed.
4. **Risk score.** Score 80 or above: blocked, recorded, queued for review. Score 40–79, or an amount at or above the step-up threshold: the transaction PIN is required.
5. **Transfer transaction.** Both wallets are locked in id order, the balance is checked, **the limits are checked again under the lock**, then the debit and credit ledger rows and the transaction record are written atomically.
6. **Recording.** The risk decision and an audit entry are stored.

Step 5 is what makes the limits race-free: the sender's wallet lock serialises one user's transfers, so parallel requests cannot jointly exceed a limit. A test fires 12 simultaneous sends against a 6-payment limit and asserts exactly 6 succeed.

---

## Security model

| Layer | What it does | Where |
|---|---|---|
| **Login lockout** | 5 failures per account in 15 minutes locks sign-in for 15 minutes. Counters are keyed by a hash of the email, so unknown emails lock identically. A looser per-IP counter sits beside it. | `services/throttle.ts`, `services/auth.ts` |
| **Two-factor (TOTP, RFC 6238)** | Authenticator app plus 8 single-use recovery codes. Secrets are AES-256-GCM encrypted at rest and bound to the user id. A code cannot be replayed. The 2FA challenge token has `typ: mfa` and is rejected as an access token. | `services/totp.ts`, `services/mfa.ts` |
| **Transaction PIN** | argon2id-hashed 6-digit PIN. Required at or above the step-up threshold and whenever the risk engine challenges. 5 misses lock it for 30 minutes. Changing it needs the account password (plus a 2FA code if enabled). | `services/stepup.ts` |
| **Limits** | Per-payment, rolling 24 hours, hourly count, daily top-up, lower cap for accounts under 72 hours old, per-user admin override. Enforced inside the transfer transaction. | `services/limits.ts` |
| **Risk engine** | Naive-Bayes-style sum of log-likelihood ratios over signals: new recipient, amount versus history, velocity, fan-out, pass-through, balance drain, unfamiliar network, recent auth failures. Every decision stores its reasons. | `services/risk.ts` |
| **Rate limits** | Per-account limits on send, top-up, search and sensitive actions; per-IP on anonymous routes. | `security.ts` |
| **Tamper-evident audit log** | Each row stores the hash of the previous one, computed in a database trigger so every insert path is covered. An admin endpoint recomputes the chain. | `migrations/003_security.sql` |
| **Sessions** | Refresh tokens rotate on use; reuse of a rotated token revokes the whole family. | `services/auth.ts`, `routes/security.ts` |
| **Transport and headers** | Strict CSP on the API, HSTS, `Cache-Control: no-store` on every API response, request ids, CSP and clickjacking protection on the frontend. | `app.ts`, `frontend/vercel.json` |
| **Ledger integrity** | Append-only ledger enforced by database triggers; `reconcile()` compares cached balances to ledger sums. | `migrations/001_init.sql`, `services/payments.ts` |

### Default limits (all configurable, see [Configuration](#configuration))

| Control | Default |
|---|---|
| Largest single payment | ₹1,00,000 |
| Sent per rolling 24 hours | ₹2,00,000 |
| Sent per rolling 24 hours, account under 72 h old | ₹10,000 |
| Payments per hour | 20 |
| Top-ups per rolling 24 hours | ₹2,00,000 |
| PIN required at or above | ₹5,000 |
| Risk challenge (PIN) / block | score 40 / 80 |

### Risk engine in one paragraph
The score is `100 × sigmoid(prior + Σ weights)` where the prior corresponds to a 3% base rate and each signal that fires adds a weight. The weights are expert priors chosen to be explainable. They are **not trained on real fraud data**, and no accuracy is claimed. Every decision records which signals fired, so the weights can be recalibrated later from the admin review verdicts.

---

## Project structure

```
minipay/
├── backend/
│   ├── README.md
│   └── backend/
│       ├── .env.example
│       ├── package.json
│       ├── tsconfig.json
│       ├── migrations/
│       │   ├── 001_init.sql          schema, append-only ledger triggers
│       │   ├── 002_auth.sql          sessions, reset tokens, audit log
│       │   └── 003_security.sql      2FA, PIN, limits, risk events, audit hash chain
│       ├── src/
│       │   ├── app.ts                wiring, headers, trust proxy, rate limits
│       │   ├── security.ts           security config + limiter factory
│       │   ├── middleware.ts         auth guard, error handler, role / MFA guards
│       │   ├── schemas.ts            validation, password quality
│       │   ├── openapi.ts            API docs (served at /api/docs)
│       │   ├── routes/               auth, payments, wallet, users, security, admin
│       │   └── services/             payments, auth, mfa, totp, stepup, limits, risk, throttle, admin
│       └── tests/                    payments, api, admin, security
└── frontend/
    └── frontend/
        ├── vercel.json               rewrites + security headers
        └── src/
            ├── App.jsx, api.js, ui.jsx, styles.css
            └── pages/                Auth, Home, Transactions, Security, Settings, Admin
```

---

## Getting started

**Requirements:** Node.js 20.6 or newer (needed for `--env-file`) and PostgreSQL. Developed and tested on Node 22 and PostgreSQL 16.

### Backend
```bash
cd backend/backend
cp .env.example .env          # then edit DATABASE_URL and JWT_SECRET
npm install
npm start                     # applies migrations on boot, listens on :4000
```
API docs: http://localhost:4000/api/docs

Create an admin account:
```bash
ADMIN_EMAIL=you@example.com ADMIN_USERNAME=admin ADMIN_PASSWORD='A-long-Passw0rd-here' npm run seed:admin
```
(On Windows PowerShell, set the three variables with `$env:ADMIN_EMAIL="..."` first.)

### Frontend
```bash
cd frontend/frontend
npm install
npm run dev                   # http://localhost:5173, proxies /api to :4000
```
Set `API_URL` to point the dev proxy at a different backend.

---

## Configuration

All variables go in `backend/backend/.env`. Amounts are in **paise** (₹1 = 100).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | none | PostgreSQL connection string (required) |
| `JWT_SECRET` | none | 32+ characters (required) |
| `PORT` | `4000` | HTTP port |
| `DATA_ENCRYPTION_KEY` | derived from `JWT_SECRET` | Encrypts 2FA secrets. Set it; otherwise rotating `JWT_SECRET` orphans every 2FA enrolment. Generate with `openssl rand -base64 48`. |
| `TRUST_PROXY` | `false` | Number of proxies in front of the app (`2` for Vercel rewrite plus Render). Without it every client appears to share one IP. Too high a number lets clients spoof their IP. |
| `REQUIRE_ADMIN_MFA` | `false` | Administrators must enrol 2FA before `/api/admin` works |
| `LIMIT_PER_TRANSFER_PAISE` | `10000000` | Largest single payment |
| `LIMIT_DAILY_SEND_PAISE` | `20000000` | Rolling 24-hour send limit |
| `LIMIT_NEW_ACCOUNT_DAILY_PAISE` | `1000000` | Cap while an account is young |
| `NEW_ACCOUNT_HOURS` | `72` | How long an account counts as new |
| `LIMIT_HOURLY_TRANSFERS` | `20` | Payments per rolling hour |
| `LIMIT_DAILY_FUNDING_PAISE` | `20000000` | Rolling 24-hour top-up limit |
| `STEP_UP_THRESHOLD_PAISE` | `500000` | PIN required at or above this amount. `0` means the PIN is required for every payment. |
| `RISK_CHALLENGE_SCORE` / `RISK_BLOCK_SCORE` | `40` / `80` | Risk thresholds (0–100) |
| `RATE_SEND_PER_MIN`, `RATE_FUNDING_PER_MIN`, `RATE_SEARCH_PER_MIN`, `RATE_SENSITIVE_PER_15MIN` | `10`, `10`, `30`, `10` | Per-account request limits |

Never commit `.env`. Confirm with `git diff --cached --stat` before every commit.

---

## API overview

Interactive docs are served at `/api/docs`; the raw spec is at `/api/openapi.json`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/login/mfa`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password` |
| Wallet | `GET /wallet`, `/wallet/balance`, `/wallet/activity` · `POST /wallet/add-funds` |
| Payments | `POST /payments/send` · `GET /payments`, `/payments/summary`, `/payments/limits`, `/payments/export.csv`, `/payments/:id`, `/payments/:id/receipt` |
| Users | `GET /users/me`, `/users/search` · `PATCH /users/me` · `POST /users/me/password` |
| Security | `GET /security/status`, `/security/sessions` · `POST /security/2fa/setup`, `/2fa/enable`, `/2fa/disable` · `PUT /security/pin` · `DELETE /security/sessions/:id` · `POST /security/sessions/revoke-all` |
| Admin | `GET /admin/users`, `/transactions`, `/transactions/:id`, `/analytics`, `/audit-logs`, `/audit-logs/verify`, `/security-events`, `/risk-events` · `PATCH /admin/users/:id/status`, `/admin/users/:id/limits`, `/admin/risk-events/:id` |

Money-moving requests need an `Idempotency-Key` header. Error responses use `{ "error": { "code", "message", ... } }`. Notable codes: `STEP_UP_REQUIRED`, `PIN_INVALID`, `PIN_SETUP_REQUIRED`, `RISK_BLOCKED`, `LIMIT_PER_TRANSFER`, `LIMIT_DAILY`, `LIMIT_VELOCITY`, `LIMIT_FUNDING`, `TEMP_LOCKED`, `RATE_LIMITED`, `MFA_REQUIRED`.

---

## Testing

```bash
cd backend/backend
DATABASE_URL=postgres://user:pass@localhost:5432/minipay_test npm test
```
> **The tests DROP and recreate the `public` schema. Use a throwaway database, never a real one.**

**60 tests** across four files:

| File | Covers |
|---|---|
| `payments.test.ts` | Ledger, atomic transfers, idempotency, concurrency, deadlock freedom |
| `api.test.ts` | Auth, sessions, password reset, payments and receipts over HTTP |
| `admin.test.ts` | Admin API, read-only guarantees, OpenAPI validity |
| `security.test.ts` | Lockout, 2FA, PIN step-up, limits (including a race test), risk engine, audit chain, rate limits |

Under `NODE_ENV=test` the security layer is off unless a test passes its own config. That keeps the original suites meaningful and lets `security.test.ts` prove enforcement. The security tests were mutation-checked: deliberately removing the in-transaction limit check or the token-type check makes the matching tests fail.

---

## Deployment

**Frontend: Vercel.** `frontend/frontend/vercel.json` rewrites `/api/*` to the backend and sets CSP, HSTS, X-Frame-Options, Referrer-Policy and Permissions-Policy.

**Backend: Render** (or any Node host) with a managed PostgreSQL.

Checklist:
1. Set `DATABASE_URL`, `JWT_SECRET` (32+ characters), `DATA_ENCRYPTION_KEY`, `NODE_ENV=production` and `TRUST_PROXY=2`.
2. Deploy. Migrations, including the audit-chain backfill for existing rows, run on boot.
3. Create the admin with `npm run seed:admin`.
4. Sign in once and confirm that `audit_logs.ip` shows your real address, not the proxy's.
5. Optionally set `REQUIRE_ADMIN_MFA=true` after the admin has enrolled 2FA.

The first deploy of the security release signs everyone out once, because access tokens now carry a type claim.

---

## Design decisions

- **Integer paise and `BIGINT` everywhere.** No floating point touches money; the API returns amounts as strings.
- **Double-entry, append-only ledger.** Every transfer is a debit and a credit that must sum to zero; database triggers forbid updating or deleting ledger rows.
- **Locks in id order.** Both wallets are locked `FOR UPDATE` in a deterministic order, so opposite-direction transfers cannot deadlock.
- **Limits inside the transaction.** A pre-check gives good user experience; the authoritative check runs under the wallet lock.
- **Failed-attempt counters in Postgres,** not memory, so they survive restarts and work across instances.
- **Decisions never leak scoring.** A blocked payment tells the caller nothing about which signals fired, so an attacker cannot tune around them. Admins see the reasons.
- **Audit insert is the last statement** in any transaction that also locks other rows, because the hash-chain trigger holds an advisory lock until commit.
- **404 instead of 403** for resources that belong to someone else, so ids cannot be probed.
- **No ORM.** Plain SQL with parameters, which keeps locking and transactions explicit and reviewable.

---

## Known limitations

- The risk weights are expert priors, not trained on real fraud data. No precision or recall is claimed.
- A temporary account lockout can be used to annoy a victim. The 15-minute duration and the password-reset path limit the damage.
- The audit chain detects edits and mid-log deletions. Truncating the end is detectable only if the `head` hash is stored outside the database.
- Password reset has no email transport, so the reset token is exposed only in tests. The UI has no reset screens for that reason.
- The `FAILED` transaction status exists but is never written. Rejected payments are recorded in `risk_events` and `audit_logs`.
- Funding is simulated against a `__system_funding__` counter-party wallet. The system wallet is read without a row lock because its balance column is never written; locking it would have serialised every top-up.
- No social login, passkeys, email alerts or PDF receipts yet.
- Not PCI DSS compliant. Not intended for real money.

---

## Roadmap

Planned, not built:
- Google and GitHub sign-in (server-side authorization code flow with PKCE; link to existing accounts only through the Security page, never by email)
- Passkeys (WebAuthn)
- Cooling-off period after PIN, password or 2FA changes; first-payment-to-new-recipient limit
- Breached-password check (k-anonymity range lookup)
- Recent re-authentication for sensitive actions
- Risk engine that recalibrates from admin verdicts, with a shadow mode for replaying history under new weights
- Email alerts, GitHub Actions CI with security scanning, load-test results
