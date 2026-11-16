// Amounts arrive as strings of paise (BigInt-safe). Never use floats for money.
export const split = p => { const n = BigInt(p), a = n < 0n ? -n : n; return { whole: (a / 100n).toLocaleString('en-IN'), paise: (a % 100n).toString().padStart(2, '0') }; };
export const inr = p => { const s = split(p); return `₹${s.whole}.${s.paise}`; };
export const toPaise = s => {
  const t = String(s).trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const n = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return n > 0 ? n : null;
};
export const when = d => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
export const day = d => new Date(d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
