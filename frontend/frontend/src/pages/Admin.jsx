import { useState } from 'react';
import { api, errText, qs } from '../api.js';
import { useGet } from '../hooks.js';
import { inr, when } from '../format.js';
import { Dialog, Msg, Pager } from '../ui.jsx';

const TABS = ['Overview', 'Users', 'Transactions', 'Logs'];
export default function Admin() {
  const [tab, setTab] = useState('Overview');
  return <>
    <h1>Admin</h1>
    <div className="tabs" role="tablist">{TABS.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === 'Overview' && <Overview />}{tab === 'Users' && <Users />}{tab === 'Transactions' && <Txs />}{tab === 'Logs' && <Logs />}
  </>;
}

const Table = ({ cols, rows, onRow }) => <div className="scroll"><table>
  <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
  <tbody>{rows.map((r, i) => <tr key={i} onClick={onRow && (() => onRow(i))} className={onRow ? 'click' : ''}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
</table>{!rows.length && <p className="empty">Nothing here yet.</p>}</div>;

function Overview() {
  const { data: a, err } = useGet('/admin/analytics');
  if (err) return <Msg>{err}</Msg>; if (!a) return <p className="sub">Loading…</p>;
  const max = Math.max(1, ...a.dailyTransfers.map(d => Number(d.volumePaise)));
  return <>
    <p className={'ledger-state ' + (a.ledgerBalanced ? 'ok' : 'bad')}>{a.ledgerBalanced ? 'Ledger balanced: every wallet matches its entries and the global net is zero.' : 'Ledger mismatch: a wallet balance differs from its entries. Investigate now.'}</p>
    <dl className="stats">
      <div><dt>Users</dt><dd>{a.users.total}<small>{a.users.active} active · {a.users.suspended} suspended</small></dd></div>
      <div><dt>Transfers</dt><dd>{a.transferCount.toLocaleString('en-IN')}<small>{inr(a.transferVolumePaise)} moved</small></dd></div>
      <div><dt>Funding</dt><dd>{inr(a.fundingVolumePaise)}<small>simulated top-ups</small></dd></div>
    </dl>
    <h2>Transfer volume, last 30 days</h2>
    <svg className="chart" viewBox="0 0 300 80" role="img" aria-label="Daily transfer volume for the last 30 days">
      {a.dailyTransfers.map((d, i) => { const h = Math.max(Number(d.volumePaise) / max * 72, d.count ? 2 : 0.8); return <rect key={d.date} x={i * 10 + 1} y={76 - h} width="8" height={h}><title>{d.date}: {inr(d.volumePaise)} in {d.count} transfers</title></rect>; })}
    </svg>
  </>;
}

function Users() {
  const [f, set] = useState({ q: '', status: '' }), [page, setPage] = useState(1), [target, setTarget] = useState(null), [n, setN] = useState(0);
  const { data, err } = useGet('/admin/users?' + qs({ ...f, q: f.q.trim(), page, limit: 20 }), [n]);
  const up = k => e => { set({ ...f, [k]: e.target.value }); setPage(1); };
  return <>
    <div className="filters"><label>Search<input value={f.q} onChange={up('q')} placeholder="Name, username or email" /></label>
      <label>Status<select value={f.status} onChange={up('status')}><option value="">Any</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select></label></div>
    <Msg>{err}</Msg>
    {data && <><Table cols={['User', 'Email', 'Role', 'Status', 'Balance', 'Joined', '']}
      rows={data.items.map(u => [<><b>@{u.username}</b>{u.fullName && <small className="blk">{u.fullName}</small>}</>, u.email, u.role, <span className={'tag ' + u.status}>{u.status === 'ACTIVE' ? 'Active' : 'Suspended'}</span>, inr(u.balancePaise), when(u.createdAt),
        u.role === 'ADMIN' ? '' : <button className="ghost" onClick={() => setTarget(u)}>{u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}</button>])} />
      <Pager page={data.page} limit={data.limit} total={data.total} set={setPage} /></>}
    {target && <StatusDialog u={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); setN(n + 1); }} />}
  </>;
}

function StatusDialog({ u, onClose, onDone }) {
  const next = u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE', [reason, setReason] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const go = async e => { e.preventDefault(); setBusy(true); try { await api(`/admin/users/${u.id}/status`, { method: 'PATCH', body: { status: next, reason } }); onDone(); } catch (x) { setErr(errText(x)); setBusy(false); } };
  return <Dialog title={`${next === 'SUSPENDED' ? 'Suspend' : 'Reactivate'} @${u.username}`} onClose={onClose}>
    <form onSubmit={go}>
      <p className="sub">{next === 'SUSPENDED' ? 'They are signed out everywhere and cannot send or receive money.' : 'They can sign in and use their wallet again.'} The reason is saved in the audit log.</p>
      <label className="field"><span>Reason</span><input required minLength={3} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <Msg>{err}</Msg><button className={next === 'SUSPENDED' ? 'danger' : 'primary'} disabled={busy}>{next === 'SUSPENDED' ? 'Suspend user' : 'Reactivate user'}</button>
    </form>
  </Dialog>;
}

function Txs() {
  const [f, set] = useState({ q: '', status: '', type: '' }), [page, setPage] = useState(1), [open, setOpen] = useState(null);
  const { data, err } = useGet('/admin/transactions?' + qs({ ...f, q: f.q.trim(), page, limit: 20 }));
  const up = k => e => { set({ ...f, [k]: e.target.value }); setPage(1); };
  return <>
    <div className="filters"><label>Search<input value={f.q} onChange={up('q')} placeholder="Reference, note or username" /></label>
      <label>Type<select value={f.type} onChange={up('type')}><option value="">All</option><option value="TRANSFER">Transfer</option><option value="FUNDING">Funding</option></select></label>
      <label>Status<select value={f.status} onChange={up('status')}><option value="">Any</option><option value="COMPLETED">Completed</option><option value="FAILED">Failed</option></select></label></div>
    <Msg>{err}</Msg>
    {data && <><Table cols={['When', 'From', 'To', 'Amount', 'Type', 'Status']} onRow={i => setOpen(data.items[i].id)}
      rows={data.items.map(t => [when(t.createdAt), t.sender, t.receiver, inr(t.amountPaise), t.type === 'FUNDING' ? 'Funding' : 'Transfer', t.status === 'COMPLETED' ? 'Completed' : 'Failed'])} />
      <Pager page={data.page} limit={data.limit} total={data.total} set={setPage} /></>}
    {open && <AdminTx id={open} onClose={() => setOpen(null)} />}
  </>;
}

function AdminTx({ id, onClose }) {
  const { data: t, err } = useGet('/admin/transactions/' + id);
  return <Dialog title="Transaction" onClose={onClose}><Msg>{err}</Msg>{t && <>
    <dl className="kv"><dt>Reference</dt><dd className="ref">{t.id}</dd><dt>Amount</dt><dd>{inr(t.amountPaise)}</dd><dt>From</dt><dd>{t.sender}</dd><dt>To</dt><dd>{t.receiver}</dd><dt>Note</dt><dd>{t.description || 'None'}</dd></dl>
    <h3>Ledger entries</h3><Table cols={['Wallet', 'Direction', 'Amount']} rows={t.ledger.map(l => [l.wallet, l.direction === 'DEBIT' ? 'Debit' : 'Credit', inr(l.amountPaise)])} /></>}</Dialog>;
}

function Logs() {
  const [kind, setKind] = useState('security-events'), [page, setPage] = useState(1), [actor, setActor] = useState('');
  const { data, err } = useGet(`/admin/${kind === 'audit' ? 'audit-logs' : 'security-events'}?` + qs({ actor: actor.trim(), page, limit: 25 }));
  return <>
    <div className="filters">
      <label>Log<select value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="security-events">Security events</option><option value="audit">All audit entries</option></select></label>
      <label>Actor<input value={actor} onChange={e => { setActor(e.target.value); setPage(1); }} placeholder="Username" /></label></div>
    <Msg>{err}</Msg>
    {data && <><Table cols={['When', 'Action', 'Actor', 'IP', 'Details']}
      rows={data.items.map(l => [when(l.createdAt), l.action.replaceAll('_', ' ').toLowerCase(), l.actor || 'Unknown', l.ip || '', l.metadata ? JSON.stringify(l.metadata) : ''])} />
      <Pager page={data.page} limit={data.limit} total={data.total} set={setPage} /></>}
  </>;
}
