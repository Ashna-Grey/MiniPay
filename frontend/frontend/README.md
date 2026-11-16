# MiniPay frontend

React + Vite client for the MiniPay backend (phases 1–4).

## Run
1. Start the backend (`cd backend && npm start`, default port 4000).
2. `cd frontend && npm install && npm run dev` → http://localhost:5173
   Vite proxies `/api` to `http://localhost:4000` (override with `API_URL`).

## Why same-origin
The refresh cookie is `SameSite=Strict` on `/api/auth`, and the backend sends no CORS headers. The UI and API must share an origin, so in production serve `dist/` and `/api` behind one reverse proxy, over HTTPS (the cookie is `Secure` when `NODE_ENV=production`).

## Notes
- Access token lives in memory only; a page load restores the session through `/api/auth/refresh`.
- Refresh calls are de-duplicated, and `<StrictMode>` is off, because the backend treats a reused refresh token as theft and revokes the session family.
- Payments and top-ups send one `Idempotency-Key` per intended payment, reused on retry.
- Money is handled as paise strings/integers; no floats.
- Not included: forgot/reset password screens (the backend has no email transport, so users could never receive the token), PDF receipts.
