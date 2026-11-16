# MiniPay (backend)

A payments simulation built around a **double-entry ledger** and a layered **security model**. No real money moves.

## Run
1. Create a Postgres DB; copy `backend/.env.example` to `.env` and fill it in.
2. `cd backend && npm install`
3. `npm start` (applies migrations on boot) · `npm run seed:admin` to create an admin.
4. `DATABASE_URL=... npm test`. **The tests DROP and recreate the `public` schema: use a throwaway database.**

## Money engine
- Money is `BIGINT` paise. Every transfer writes two ledger rows (debit and credit) in one transaction; the ledger is append-only (DB triggers) and `reconcile()` checks cached balances against it.
- Both wallets are locked `FOR UPDATE` in id order (no deadlocks). Idempotency is unique per (initiator, key); a replay returns the stored result.
- Funding uses a `__system_funding__` counter-party wallet. It is read without a row lock, because its balance column is never written; locking it would have serialised every top-up on the platform.

## Security layer
| Layer | What it does | Where |
|---|---|---|
| Login lockout | 5 failures per account in 15 min locks it for 15 min. Counters are keyed by a hash of the email, so unknown emails behave identically (no enumeration). A looser per-IP counter sits beside it. | `services/throttle.ts`, `services/auth.ts` |
| 2FA (TOTP, RFC 6238) | Authenticator app + 8 single-use recovery codes. Secrets are AES-256-GCM encrypted at rest, bound to the user id. A used code cannot be replayed. The challenge token has `typ: mfa` and is rejected as an access token. | `services/totp.ts`, `services/mfa.ts` |
| Transaction PIN | 6-digit PIN (argon2id). Required for payments of Rs 5,000+ and for any payment the risk engine challenges. 5 misses lock it for 30 min. Changing it needs the password (and a 2FA code if enabled). | `services/stepup.ts` |
| Limits | Per-payment, rolling-24h, hourly velocity, daily top-up, tighter cap for accounts under 72 h, per-user admin override. **Enforced inside the transfer transaction under the sender's wallet lock**, so parallel requests cannot jointly exceed a limit (tested with 12 concurrent sends). | `services/limits.ts` |
| Risk engine | Each payment gets a 0-100 score from a naive-Bayes-style sum of log-likelihood ratios (new recipient, amount vs history, velocity, fan-out, pass-through, balance drain, unfamiliar network, recent auth failures). Under 40 allow, 40-79 PIN challenge, 80+ block and queue for admin review. Every decision stores its reasons. | `services/risk.ts` |
| Rate limits | Per-account limits on send, top-up, search and sensitive actions; per-IP on anonymous routes. | `security.ts` |
| Tamper-evident audit log | Each audit row stores a hash of the previous one (computed in a DB trigger, so every insert path is covered). `GET /api/admin/audit-logs/verify` recomputes the chain. | `migrations/003_security.sql` |
| Sessions | Rotating refresh tokens with reuse detection; list and revoke individual sessions or sign out everywhere. | `routes/security.ts` |
| Hardening | Strict CSP on the API, HSTS, `no-store` on every API response, request ids, common-password blocklist, 2FA-for-admins switch. | `app.ts`, `middleware.ts` |

## Honest limitations
- The risk weights are **expert priors, not trained on real fraud data**, and no precision/recall is claimed. The value is that decisions are explainable and every one is recorded for later calibration.
- A temporary account lockout can be used to annoy a victim (a known trade-off); the 15-minute duration and the password-reset path limit the damage.
- The audit chain detects edits and deletions in the middle of the log. Truncating the tail is only detectable if you store the `head` hash somewhere outside the database.
- Password reset still has no email transport, so the token is only exposed in tests.
- `FAILED` exists as a transaction status but is never written: rejected payments are recorded in `risk_events` and `audit_logs` instead.
- Not PCI DSS compliant; amounts are simulated.

## Deployment checklist
1. Set `TRUST_PROXY` (2 for Vercel rewrite -> Render), `DATA_ENCRYPTION_KEY`, and optionally `REQUIRE_ADMIN_MFA=true`.
2. Redeploy: migration `003_security.sql` runs on boot and backfills the audit chain for existing rows.
3. Log in once and check that `audit_logs.ip` is the real client address, not the proxy's.

## Tests
`tests/payments.test.ts` (ledger, concurrency), `tests/api.test.ts` (auth and payments over HTTP), `tests/admin.test.ts` (admin API and OpenAPI), `tests/security.test.ts` (lockout, 2FA, PIN, limits, risk, audit chain). Under `NODE_ENV=test` the security layer is off unless a test passes its own config, so the original suites keep their meaning and `security.test.ts` proves enforcement.
