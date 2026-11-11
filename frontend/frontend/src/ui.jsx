import { useEffect, useRef } from 'react';
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
