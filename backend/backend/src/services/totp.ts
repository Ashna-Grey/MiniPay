import crypto from 'crypto';

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with no third-party dependency, plus AES-256-GCM encryption of the stored secret.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function b32encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
export function b32decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const i = ALPHA.indexOf(ch); if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => b32encode(crypto.randomBytes(20));

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

/** Returns the matched time step (so the caller can reject replays) or null. Accepts +/- `window` steps of clock drift. */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = b32decode(secretB32), t = Math.floor(nowMs / 1000 / STEP_SECONDS);
  let hit: number | null = null;
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(key, t + w)), given = Buffer.from(code);
    if (crypto.timingSafeEqual(expected, given) && hit === null) hit = t + w; // no early exit: constant work
  }
  return hit;
}

export const otpauthUrl = (secret: string, account: string, issuer = 'MiniPay') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// Secrets are encrypted at rest. Set DATA_ENCRYPTION_KEY; falling back to JWT_SECRET means rotating the JWT secret would orphan every 2FA secret.
const encKey = () => {
  const ikm = process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!ikm) throw new Error('DATA_ENCRYPTION_KEY or JWT_SECRET must be set');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, 'minipay', 'totp-secret-v1', 32));
};
/** The user id is bound in as AAD, so a ciphertext copied onto another user's row will not decrypt. */
export function encryptSecret(plain: string, userId: string): string {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}
export function decryptSecret(stored: string, userId: string): string {
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(userId)); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
