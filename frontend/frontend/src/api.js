let token = null, inflight = null, onExpire = () => {};
export const setToken = t => { token = t; };
export const setOnExpire = f => { onExpire = f; };
export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const toErr = async r => { let b = {}; try { b = await r.json(); } catch {} const e = b.error || {}; return new ApiError(r.status, e.code || 'ERROR', e.message || 'Request failed', e.details); };

// One shared in-flight refresh: rotation means concurrent refreshes would trip reuse detection.
export function refresh() {
  inflight ??= fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'minipay' }, credentials: 'same-origin' })
    .then(async r => { if (!r.ok) throw await toErr(r); token = (await r.json()).accessToken; return token; })
    .finally(() => { inflight = null; });
  return inflight;
}

export async function api(path, { method = 'GET', body, headers = {}, key, blob, retry = true } = {}) {
  const h = { 'X-Requested-With': 'minipay', ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (key) h['Idempotency-Key'] = key;
  const r = await fetch('/api' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401 && retry && !path.startsWith('/auth/')) {
    try { await refresh(); } catch { onExpire(); throw await toErr(r); }
    return api(path, { method, body, headers, key, blob, retry: false });
  }
  if (!r.ok) throw await toErr(r);
  if (blob) return r.blob();
  return r.status === 204 ? null : r.json();
}
export const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
export const errText = e => e instanceof ApiError ? (e.details?.length ? e.details.map(d => d.message).join(' ') : e.message) : 'Network error. Check your connection and try again.';
