import { useState } from 'react';
import { api, errText, qs } from '../api.js';
import { useGet } from '../hooks.js';
import { inr, when } from '../format.js';
import { Dialog, Ledger, Msg, Pager } from '../ui.jsx';

export function TxDialog({ tx, onClose }) {
  const r = useGet(`/payments/${tx.id}/receipt`), t = r.data || tx, out = t.direction === 'SENT';
  return <Dialog title="Payment receipt" onClose={onClose}>
    <p className={'receipt-amt ' + (out ? 'out' : 'in')}>{out ? '−' : '+'}{inr(t.amountPaise)}</p>
    <dl className="kv">
      <dt>{out ? 'Paid to' : 'Received from'}</dt><dd>{t.counterparty}</dd>
      <dt>Status</dt><dd>{t.status === 'COMPLETED' ? 'Completed' : 'Failed'}</dd>
      <dt>Date</dt><dd>{when(t.createdAt)}</dd>
      {t.description && <><dt>Note</dt><dd>{t.description}</dd></>}
      <dt>Reference</dt><dd className="ref">{t.id}</dd>
    </dl>
    <Msg>{r.err}</Msg>
    <p className="sub">Simulated payment. No real money moved.</p>
  </Dialog>;
}

export default function Transactions() {
  const [f, set] = useState({ direction: '', status: '', q: '', from: '', to: '' }), [page, setPage] = useState(1), [open, setOpen] = useState(null), [err, setErr] = useState('');
  const range = { from: f.from && new Date(f.from).toISOString(), to: f.to && new Date(f.to + 'T23:59:59').toISOString() };
  const filters = { direction: f.direction, status: f.status, q: f.q.trim(), ...range };
  const { data, err: loadErr, loading } = useGet('/payments?' + qs({ ...filters, page, limit: 20 }));
  const up = k => e => { set({ ...f, [k]: e.target.value }); setPage(1); };
  const exportCsv = async () => {
    setErr('');
    try {
      const b = await api('/payments/export.csv?' + qs(filters), { blob: true }), a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = 'minipay-transactions.csv'; a.click(); URL.revokeObjectURL(a.href);
    } catch (x) { setErr(errText(x)); }
  };
  return <>
    <div className="bar"><h1>Payments</h1><button className="ghost" onClick={exportCsv}>Export CSV</button></div>
    <div className="filters">
      <label>Search<input value={f.q} onChange={up('q')} placeholder="Note or reference" /></label>
      <label>Type<select value={f.direction} onChange={up('direction')}><option value="">All</option><option value="SENT">Sent</option><option value="RECEIVED">Received</option></select></label>
      <label>Status<select value={f.status} onChange={up('status')}><option value="">Any</option><option value="COMPLETED">Completed</option><option value="FAILED">Failed</option></select></label>
      <label>From<input type="date" value={f.from} onChange={up('from')} /></label>
      <label>To<input type="date" value={f.to} onChange={up('to')} /></label>
    </div>
    <Msg>{err || loadErr}</Msg>
    {data && <><Ledger items={data.items} onOpen={setOpen} /><Pager page={data.page} limit={data.limit} total={data.total} set={setPage} /></>}
    {loading && !data && <p className="sub">Loading…</p>}
    {open && <TxDialog tx={open} onClose={() => setOpen(null)} />}
  </>;
}
