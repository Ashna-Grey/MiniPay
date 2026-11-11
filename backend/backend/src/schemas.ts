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
