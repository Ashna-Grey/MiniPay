import { useEffect, useRef, useState } from 'react';
import { split, inr, when, day } from './format.js';

export const Money = ({ p, big }) => { const s = split(p); return <span className={'money' + (big ? ' big' : '')}>₹{s.whole}<span className="paise">.{s.paise}</span></span>; };
export const Msg = ({ kind = 'error', children }) => children ? <p className={'msg ' + kind} role={kind === 'error' ? 'alert' : 'status'}>{children}</p> : null;
export const Field = ({ label, hint, ...p }) => <label className="field"><span>{label}</span><input {...p} />{hint && <small>{hint}</small>}</label>;

export function Dialog({ title, onClose, children }) {
  const ref = useRef();
  useEffect(() => { const d = ref.current; d.showModal(); return () => d.open && d.close(); }, []);
  return <dialog ref={ref} onClose={onClose} onClick={e => e.target === ref.current && onClose()}>
    <header><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">Close</button></header>{children}
  </dialog>;
}

export const Pager = ({ page, limit, total, set }) => {
  const pages = Math.max(1, Math.ceil(total / limit));
  return <nav className="pager" aria-label="Pagination">
    <button className="ghost" disabled={page <= 1} onClick={() => set(page - 1)}>Previous</button>
    <span>Page {page} of {pages} · {total.toLocaleString('en-IN')} total</span>
    <button className="ghost" disabled={page >= pages} onClick={() => set(page + 1)}>Next</button>
  </nav>;
};

/** Progress bar for limits. `hot` turns amber/rose past 80% so "nearly out" reads without colour alone (the numbers are always printed). */
export const Meter = ({ label, used, max, format = inr }) => {
  const m = Number(max) || 1, u = Number(used), pct = Math.min(100, Math.round((u / m) * 100));
  return <div className={'meter' + (pct >= 80 ? ' hot' : '')}>
    <div className="top"><span>{label}</span><span>{format(String(used))} of {format(String(max))}</span></div>
    <div className="track" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="fill" style={{ width: pct + '%' }} /></div>
  </div>;
};

export const Pill = ({ v }) => <span className={'pill ' + v}>{{ ALLOW: 'Allowed', CHALLENGE: 'PIN required', BLOCK: 'Blocked', OPEN: 'Needs review', NONE: '—', DISMISSED: 'Dismissed', CONFIRMED_FRAUD: 'Fraud confirmed' }[v] || v}</span>;

/** Rough client-side hint only; the server is the authority on password rules. */
export function Strength({ value }) {
  const s = [value.length >= 10, /[a-z]/.test(value) && /[A-Z]/.test(value), /\d/.test(value), value.length >= 14 || /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
  return <div className="strength" aria-hidden="true">{[0, 1, 2, 3].map(i => <i key={i} className={i < s ? 'on ' + (s <= 1 ? 'weak' : s <= 2 ? 'mid' : '') : ''} />)}</div>;
}

/** Asks for the 6-digit transaction PIN. The PIN lives only in this component's state and is cleared on close. */
export function PinDialog({ title = 'Confirm with your PIN', note, onSubmit, onClose, error, busy }) {
  const [pin, setPin] = useState('');
  return <Dialog title={title} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); onSubmit(pin); }}>
      <p className="sub">{note || 'This payment needs your 6-digit transaction PIN.'}</p>
      <label className="field"><span>Transaction PIN</span>
        <input className="pin-input" type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={6} pattern="\d{6}" required value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} /></label>
      <Msg>{error}</Msg>
      <button className="primary" disabled={busy || pin.length !== 6}>{busy ? 'Checking…' : 'Confirm and send'}</button>
    </form>
  </Dialog>;
}

// Ledger-style list: grouped by day, money out on the left rule in red, money in in green.
export function Ledger({ items, onOpen }) {
  if (!items.length) return <p className="empty">No payments match. Send or add money and it shows up here.</p>;
  const groups = []; items.forEach(t => { const k = day(t.createdAt); (groups.at(-1)?.k === k ? groups.at(-1).rows : groups[groups.push({ k, rows: [] }) - 1].rows).push(t); });
  return <div className="ledger">{groups.map(g => <section key={g.k}><h3>{g.k}</h3>
    {g.rows.map(t => { const out = t.direction === 'SENT'; return <button key={t.id} className={'row ' + (out ? 'out' : 'in') + (t.status === 'FAILED' ? ' failed' : '')} onClick={() => onOpen(t)}>
      <span className="who">{t.counterparty}<small>{t.description || (t.type === 'FUNDING' ? 'Added to wallet' : 'Payment')}{t.status === 'FAILED' && ' · Failed'}</small></span>
      <span className="amt">{out ? '−' : '+'}{inr(t.amountPaise)}<small>{when(t.createdAt)}</small></span>
    </button>; })}
  </section>)}</div>;
}
