import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errText } from '../api.js';
import { useGet } from '../hooks.js';
import { inr, toPaise } from '../format.js';
import { Money, Msg, Field, Ledger } from '../ui.jsx';
import { useAuth } from '../App.jsx';
import { TxDialog } from './Transactions.jsx';

export default function Home() {
  const { user } = useAuth();
  const bal = useGet('/wallet/balance'), sum = useGet('/payments/summary'), recent = useGet('/payments?limit=6');
  const [open, setOpen] = useState(null);
  const refreshAll = () => { bal.reload(); sum.reload(); recent.reload(); };
  const first = (user.fullName || user.username).split(' ')[0];
  return <>
    <section className="hero">
      <p>{first}, your balance</p>
      {bal.data ? <Money p={bal.data.balancePaise} big /> : <span className="money big">{bal.err || '…'}</span>}
      {sum.data && <dl>
        <div><dt>Spent this month</dt><dd>{inr(sum.data.spentThisMonthPaise)}</dd></div>
        <div><dt>Received, all time</dt><dd>{inr(sum.data.totalReceivedPaise)}</dd></div>
        <div><dt>Added, all time</dt><dd>{inr(sum.data.totalFundedPaise)}</dd></div>
      </dl>}
    </section>
    <div className="two">
      <Send onDone={refreshAll} />
      <AddMoney onDone={refreshAll} />
    </div>
    <section>
      <div className="bar"><h2>Recent payments</h2><Link to="/transactions">See all</Link></div>
      {recent.err && <Msg>{recent.err}</Msg>}
      {recent.data && <Ledger items={recent.data.items} onOpen={setOpen} />}
    </section>
    {open && <TxDialog tx={open} onClose={() => setOpen(null)} />}
  </>;
}

// A fresh Idempotency-Key per intended payment; reused on retry so a dropped response can never double-send.
const useKey = () => { const k = useRef(crypto.randomUUID()); return [() => k.current, () => { k.current = crypto.randomUUID(); }]; };

function Send({ onDone }) {
  const [f, set] = useState({ to: '', amount: '', note: '' }), [found, setFound] = useState(null), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false);
  const [key, rekey] = useKey();
  const up = k => e => { set({ ...f, [k]: e.target.value }); rekey(); setMsg(null); };
  useEffect(() => {
    setFound(null); const q = f.to.trim();
    if (q.length < 3) return;
    const t = setTimeout(() => api('/users/search?q=' + encodeURIComponent(q)).then(r => setFound(r.items[0] || false)).catch(() => {}), 350);
    return () => clearTimeout(t);
  }, [f.to]);
  const paise = toPaise(f.amount);
  const go = async e => {
    e.preventDefault(); if (!paise) return setMsg({ k: 'error', t: 'Enter an amount like 250 or 250.50.' });
    setBusy(true);
    try {
      const body = { recipient: f.to, amountPaise: paise, ...(f.note.trim() && { description: f.note.trim() }) };
      await api('/payments/send', { method: 'POST', body, key: key() });
      setMsg({ k: 'ok', t: `Sent ${inr(paise)} to ${found?.username ? '@' + found.username : f.to}.` }); set({ to: '', amount: '', note: '' }); rekey(); onDone();
    } catch (x) { setMsg({ k: 'error', t: errText(x) }); } finally { setBusy(false); }
  };
  return <form className="panel" onSubmit={go}>
    <h2>Send money</h2>
    <Field label="To (username or email)" required value={f.to} onChange={up('to')} autoComplete="off" />
    {found && <p className="found">{found.fullName ? `${found.fullName} · ` : ''}@{found.username}</p>}
    {found === false && <p className="found no">No active account with that exact username or email.</p>}
    <Field label="Amount (₹)" inputMode="decimal" required value={f.amount} onChange={up('amount')} placeholder="0.00" />
    <Field label="Note (optional)" maxLength={140} value={f.note} onChange={up('note')} />
    <Msg kind={msg?.k}>{msg?.t}</Msg>
    <button className="primary" disabled={busy || found === false}>{busy ? 'Sending…' : paise ? `Send ${inr(paise)}` : 'Send'}</button>
  </form>;
}

function AddMoney({ onDone }) {
  const [amount, setAmount] = useState(''), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false), [key, rekey] = useKey();
  const paise = toPaise(amount);
  const pick = v => { setAmount(String(v)); rekey(); setMsg(null); };
  const go = async e => {
    e.preventDefault(); if (!paise) return setMsg({ k: 'error', t: 'Enter an amount like 500 or 500.50.' });
    setBusy(true);
    try { await api('/wallet/add-funds', { method: 'POST', body: { amountPaise: paise }, key: key() }); setMsg({ k: 'ok', t: `Added ${inr(paise)} to your wallet.` }); setAmount(''); rekey(); onDone(); }
    catch (x) { setMsg({ k: 'error', t: errText(x) }); } finally { setBusy(false); }
  };
  return <form className="panel" onSubmit={go}>
    <h2>Add money</h2>
    <p className="sub">Simulated top-up, up to ₹1,00,000 at a time.</p>
    <div className="chips">{[500, 1000, 5000].map(v => <button type="button" key={v} className="chip" onClick={() => pick(v)}>₹{v.toLocaleString('en-IN')}</button>)}</div>
    <Field label="Amount (₹)" inputMode="decimal" required value={amount} onChange={e => pick(e.target.value)} placeholder="0.00" />
    <Msg kind={msg?.k}>{msg?.t}</Msg>
    <button className="primary" disabled={busy}>{busy ? 'Adding…' : paise ? `Add ${inr(paise)}` : 'Add money'}</button>
  </form>;
}
