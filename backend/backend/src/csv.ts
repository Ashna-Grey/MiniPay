// Cells starting with = + - @ (or tab/CR) are prefixed with ' so spreadsheets never evaluate them as formulas.
const cell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const inr = (paise: string) => { const a = BigInt(paise); return `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`; };
export const toCsv = (rows: unknown[][]) => rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
