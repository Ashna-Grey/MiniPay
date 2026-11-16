import { z } from 'zod';
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(10).max(128)
  .refine(p => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Password needs upper, lower case letters and a digit');
export const username = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,19}$/, '3-20 chars: letters, digits, underscore; must start with a letter');
// Defence in depth: descriptions may not carry markup. (The UI must still escape output.)
export const description = z.string().trim().max(140).regex(/^[^<>\u0000-\u001f]*$/, 'Markup and control characters are not allowed');
export const paise = (max: number) => z.number().int().positive().max(max);
export const MAX_TRANSFER = 100_000_000; // Rs 10,00,000
export const MAX_FUNDING = 10_000_000;   // Rs 1,00,000

// Exact-match blocklist of passwords that satisfy the composition rule yet sit at the top of every cracking dictionary.
const COMMON = new Set(['password123', 'password1234', 'password12345', 'passw0rd123', 'welcome123', 'welcome1234', 'qwerty12345', 'qwerty123456', 'admin12345', 'admin123456',
  'iloveyou123', 'letmein1234', 'changeme123', 'abc1234567', 'abcd123456', 'abcd1234567', 'test123456', 'india123456', 'monkey12345', 'dragon12345', 'football123', 'princess123', '1q2w3e4r5t', '1qaz2wsx3e', 'q1w2e3r4t5']);
/** Rejects common passwords and passwords built from the person's own email or username. */
export function passwordQuality(pw: string, who: { email?: string; username?: string } = {}): string | null {
  const l = pw.toLowerCase();
  if (COMMON.has(l)) return 'That password is too common. Choose something harder to guess.';
  const parts = [who.username, who.email?.split('@')[0]].filter((x): x is string => !!x && x.length >= 4);
  if (parts.some(x => l.includes(x.toLowerCase()))) return 'Your password must not contain your username or email name.';
  return null;
}
