// Hand-written OpenAPI 3.0 spec. tests/admin.test.ts validates it and checks every documented route exists.
const s = { type: 'string' }, int = { type: 'integer' }, bool = { type: 'boolean' };
const obj = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const ref = (n: string) => ({ $ref: `#/components/parameters/${n}` });
const qp = (name: string, schema: object = s) => ({ name, in: 'query', schema });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const paging = [qp('page', int), qp('limit', int)];
const txFilters = [qp('status'), qp('from', { type: 'string', format: 'date-time' }), qp('to', { type: 'string', format: 'date-time' }), qp('q')];
const err = (d: string) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
type Op = { tag: string; summary: string; auth?: 'bearer' | 'cookie'; admin?: boolean; body?: object; params?: object[]; idem?: boolean; ok?: string; csv?: boolean };
const op = (o: Op) => ({
  tags: [o.tag], summary: o.summary,
  ...(o.auth === 'bearer' ? { security: [{ bearerAuth: [] }] } : o.auth === 'cookie' ? { security: [{ cookieAuth: [] }] } : {}),
  parameters: [...(o.idem ? [ref('IdempotencyKey')] : []), ...(o.params ?? [])],
  ...(o.body ? { requestBody: { required: true, content: { 'application/json': { schema: o.body } } } } : {}),
  responses: { [o.ok ?? '200']: o.csv ? { description: 'CSV file', content: { 'text/csv': { schema: s } } } : { description: 'Success' },
    '400': err('Validation error'), ...(o.auth ? { '401': err('Unauthenticated') } : {}), ...(o.admin ? { '403': err('Forbidden') } : {}) },
});
const B = 'bearer' as const, A = { auth: B, admin: true };
export const openapi = {
  openapi: '3.0.3',
  info: { title: 'MiniPay API', version: '0.4.0', description: 'Educational payment simulation. No real money moves. Amounts are integer paise (INR). Not production-ready or PCI DSS compliant.' },
  servers: [{ url: '/api' }],
  tags: ['Auth', 'Wallet', 'Payments', 'Users', 'Security', 'Admin', 'System'].map(name => ({ name })),
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, cookieAuth: { type: 'apiKey', in: 'cookie', name: 'refresh_token' } },
    parameters: { IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 }, description: 'Repeating a key never moves money twice.' } },
    schemas: { Error: obj({ error: obj({ code: s, message: s }, ['code', 'message']) }, ['error']) },
  },
  paths: {
    '/health': { get: op({ tag: 'System', summary: 'Liveness check' }) },
    '/auth/register': { post: op({ tag: 'Auth', summary: 'Register (wallet created automatically)', ok: '201', body: obj({ email: s, username: s, password: s, fullName: s }, ['email', 'username', 'password']) }) },
    '/auth/login': { post: op({ tag: 'Auth', summary: 'Log in; sets httpOnly refresh cookie, returns access token (or {mfaRequired, mfaToken} when 2FA is on). Locks for 15 min after 5 failures (429 TEMP_LOCKED)', body: obj({ email: s, password: s }, ['email', 'password']) }) },
    '/auth/login/mfa': { post: op({ tag: 'Auth', summary: 'Second step of login: authenticator code or one-time recovery code', body: obj({ mfaToken: s, code: s }, ['mfaToken', 'code']) }) },
    '/auth/refresh': { post: op({ tag: 'Auth', summary: 'Rotate refresh token (requires X-Requested-With: minipay)', auth: 'cookie' }) },
    '/auth/logout': { post: op({ tag: 'Auth', summary: 'Revoke refresh token (requires X-Requested-With: minipay)', ok: '204' }) },
    '/auth/forgot-password': { post: op({ tag: 'Auth', summary: 'Request password reset', ok: '202', body: obj({ email: s }, ['email']) }) },
    '/auth/reset-password': { post: op({ tag: 'Auth', summary: 'Complete password reset', ok: '204', body: obj({ token: s, password: s }, ['token', 'password']) }) },
    '/wallet': { get: op({ tag: 'Wallet', summary: 'Wallet details', auth: B }) },
    '/wallet/balance': { get: op({ tag: 'Wallet', summary: 'Balance in paise', auth: B }) },
    '/wallet/add-funds': { post: op({ tag: 'Wallet', summary: 'Add simulated funds (max 10,000,000 paise)', auth: B, idem: true, ok: '201', body: obj({ amountPaise: int }, ['amountPaise']) }) },
    '/wallet/activity': { get: op({ tag: 'Wallet', summary: 'Ledger entries for this wallet', auth: B, params: [qp('limit', int)] }) },
    '/payments/send': { post: op({ tag: 'Payments', summary: 'Send money (atomic, idempotent). Limits and risk scoring apply; large or unusual payments need the transaction PIN in `pin` (403 STEP_UP_REQUIRED / PIN_INVALID / PIN_SETUP_REQUIRED, 403 RISK_BLOCKED, 422 LIMIT_*)', auth: B, idem: true, ok: '201', body: obj({ recipient: s, amountPaise: int, description: s, pin: s }, ['recipient', 'amountPaise']) }) },
    '/payments/limits': { get: op({ tag: 'Payments', summary: 'Your send and top-up limits and how much of them is used', auth: B }) },
    '/payments': { get: op({ tag: 'Payments', summary: 'Transaction history with filters and pagination', auth: B, params: [...paging, ...txFilters, qp('direction')] }) },
    '/payments/summary': { get: op({ tag: 'Payments', summary: 'Totals sent, received, funded, spent this month', auth: B }) },
    '/payments/export.csv': { get: op({ tag: 'Payments', summary: 'Download history as CSV (formula-injection safe)', auth: B, params: [...txFilters, qp('direction')], csv: true }) },
    '/payments/{id}': { get: op({ tag: 'Payments', summary: 'Transaction detail (participants only)', auth: B, params: [idParam] }) },
    '/payments/{id}/receipt': { get: op({ tag: 'Payments', summary: 'Receipt (JSON)', auth: B, params: [idParam] }) },
    '/users/me': { get: op({ tag: 'Users', summary: 'Profile and active sessions', auth: B }), patch: op({ tag: 'Users', summary: 'Update name', auth: B, ok: '204', body: obj({ fullName: s }, ['fullName']) }) },
    '/users/me/password': { post: op({ tag: 'Users', summary: 'Change password (ends other sessions)', auth: B, ok: '204', body: obj({ currentPassword: s, newPassword: s }, ['currentPassword', 'newPassword']) }) },
    '/users/search': { get: op({ tag: 'Users', summary: 'Exact username/email lookup', auth: B, params: [qp('q')] }) },
    '/security/status': { get: op({ tag: 'Security', summary: '2FA, PIN and session status', auth: B }) },
    '/security/2fa/setup': { post: op({ tag: 'Security', summary: 'Start 2FA enrolment (returns the secret and otpauth URL once)', auth: B, ok: '201' }) },
    '/security/2fa/enable': { post: op({ tag: 'Security', summary: 'Confirm enrolment with a code; returns 8 one-time recovery codes', auth: B, body: obj({ code: s }, ['code']) }) },
    '/security/2fa/disable': { post: op({ tag: 'Security', summary: 'Turn 2FA off (password and a code required)', auth: B, ok: '204', body: obj({ password: s, code: s }, ['password', 'code']) }) },
    '/security/pin': { put: op({ tag: 'Security', summary: 'Set or change the 6-digit transaction PIN (password, plus a 2FA code if enabled)', auth: B, ok: '204', body: obj({ pin: s, password: s, code: s }, ['pin', 'password']) }) },
    '/security/sessions': { get: op({ tag: 'Security', summary: 'Active sessions', auth: B }) },
    '/security/sessions/revoke-all': { post: op({ tag: 'Security', summary: 'Sign out everywhere', auth: B, ok: '204' }) },
    '/security/sessions/{id}': { delete: op({ tag: 'Security', summary: 'Revoke one session', auth: B, ok: '204', params: [idParam] }) },
    '/admin/users': { get: op({ tag: 'Admin', summary: 'List/search users', ...A, params: [...paging, qp('q'), qp('status')] }) },
    '/admin/users/{id}/status': { patch: op({ tag: 'Admin', summary: 'Suspend or reactivate a user (reason required, audited)', ...A, params: [idParam], body: obj({ status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] }, reason: s }, ['status', 'reason']) }) },
    '/admin/transactions': { get: op({ tag: 'Admin', summary: 'All transactions (read-only)', ...A, params: [...paging, ...txFilters, qp('type')] }) },
    '/admin/transactions/{id}': { get: op({ tag: 'Admin', summary: 'Transaction detail with ledger entries (read-only)', ...A, params: [idParam] }) },
    '/admin/analytics': { get: op({ tag: 'Admin', summary: 'Users, volume, 30-day series, ledger integrity flag', ...A }) },
    '/admin/users/{id}/limits': { patch: op({ tag: 'Admin', summary: 'Override a user\'s daily send limit (null resets; reason required, audited)', ...A, params: [idParam], body: obj({ dailySendLimitPaise: int, reason: s }, ['dailySendLimitPaise', 'reason']) }) },
    '/admin/risk-events': { get: op({ tag: 'Admin', summary: 'Risk decisions and the review queue', ...A, params: [...paging, qp('decision'), qp('review')] }) },
    '/admin/risk-events/{id}': { patch: op({ tag: 'Admin', summary: 'Review a blocked payment (dismiss or confirm fraud)', ...A, params: [idParam], body: obj({ review: s, note: s }, ['review']) }) },
    '/admin/audit-logs/verify': { get: op({ tag: 'Admin', summary: 'Verify the audit-log hash chain', ...A }) },
    '/admin/audit-logs': { get: op({ tag: 'Admin', summary: 'Administrative and system audit log', ...A, params: [...paging, qp('action'), qp('actor')] }) },
    '/admin/security-events': { get: op({ tag: 'Admin', summary: 'Security-relevant audit events', ...A, params: [...paging, qp('action'), qp('actor')] }) },
  },
};
