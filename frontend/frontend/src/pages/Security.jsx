import { useState } from 'react';
import { api, errText } from '../api.js';
import { useGet } from '../hooks.js';
import { when } from '../format.js';
import { Dialog, Field, Msg } from '../ui.jsx';
import { useAuth } from '../App.jsx';

export default function Security() {
  const { signOut } = useAuth();
  const st = useGet('/security/status'), sess = useGet('/security/sessions');
  const [dlg, setDlg] = useState(null), [msg, setMsg] = useState(null);
  const s = st.data;
  const reload = () => { st.reload(); sess.reload(); };
  const revoke = async id => { try { await api('/security/sessions/' + id, { method: 'DELETE' }); reload(); } catch (x) { setMsg({ k: 'error', t: errText(x) }); } };
  const revokeAll = async () => { try { await api('/security/sessions/revoke-all', { method: 'POST' }); await signOut(); } catch (x) { setMsg({ k: 'error', t: errText(x) }); } };
  return <>
    <h1>Security</h1>
    <Msg>{st.err}</Msg><Msg kind={msg?.k}>{msg?.t}</Msg>
    {s && <div className="secgrid">
      <div className="stat-card"><h3>Two-factor sign-in</h3><b><span className={'dot' + (s.totpEnabled ? ' on' : '')} />{s.totpEnabled ? 'On' : 'Off'}</b>
        <small className="blk">{s.totpEnabled ? `${s.recoveryCodesLeft} recovery codes left` : 'Protects your account if your password leaks.'}</small></div>
      <div className="stat-card"><h3>Transaction PIN</h3><b><span className={'dot' + (s.hasPin ? ' on' : '')} />{s.hasPin ? 'Set' : 'Not set'}</b>
        <small className="blk">{s.hasPin ? 'Confirms large or unusual payments.' : 'Needed for payments of ₹5,000 or more.'}</small></div>
      <div className="stat-card"><h3>Signed-in devices</h3><b>{s.activeSessions}</b><small className="blk">Review them below.</small></div>
    </div>}
    {s && <div className="two">
      <section className="panel"><h2>Two-factor authentication</h2>
        <p className="sub">{s.totpEnabled ? 'Each sign-in asks for a code from your authenticator app.' : 'Use an authenticator app such as Google Authenticator, Authy or 1Password.'}</p>
        {s.totpEnabled ? <button className="ghost" onClick={() => setDlg('off')}>Turn off</button> : <button className="primary" onClick={() => setDlg('on')}>Set up</button>}
      </section>
      <section className="panel"><h2>Transaction PIN</h2>
        <p className="sub">A 6-digit PIN that confirms large or unusual payments. After 5 wrong tries it locks for 30 minutes.</p>
        <button className={s.hasPin ? 'ghost' : 'primary'} onClick={() => setDlg('pin')}>{s.hasPin ? 'Change PIN' : 'Set PIN'}</button>
      </section>
    </div>}
    <section className="panel"><div className="bar"><h2>Signed-in devices</h2><button className="ghost" onClick={revokeAll}>Sign out everywhere</button></div>
      <Msg>{sess.err}</Msg>
      <ul className="plain">{sess.data?.items.map(x => <li key={x.id}><span><b>{when(x.startedAt)}</b><small>{x.ip || 'Unknown IP'} · {(x.userAgent || 'Unknown device').slice(0, 70)}</small></span><button className="ghost" onClick={() => revoke(x.id)}>Revoke</button></li>)}</ul>
    </section>
    {dlg === 'on' && <Enroll onClose={() => { setDlg(null); reload(); }} />}
    {dlg === 'off' && <TurnOff onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); setMsg({ k: 'ok', t: 'Two-factor authentication is off.' }); }} />}
    {dlg === 'pin' && <PinForm needCode={s?.totpEnabled} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); setMsg({ k: 'ok', t: 'Transaction PIN saved.' }); }} />}
  </>;
}

function Enroll({ onClose }) {
  const [step, setStep] = useState('start'), [data, setData] = useState(null), [qr, setQr] = useState(''), [code, setCode] = useState(''), [codes, setCodes] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setErr('');
    try {
      const d = await api('/security/2fa/setup', { method: 'POST' }); setData(d);
      const QR = (await import('qrcode')).default; setQr(await QR.toDataURL(d.otpauthUrl, { margin: 1, width: 300 })); setStep('scan');
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const confirm = async e => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api('/security/2fa/enable', { method: 'POST', body: { code } }); setCodes(r.recoveryCodes); setStep('codes'); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const save = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain' })); a.download = 'minipay-recovery-codes.txt'; a.click(); URL.revokeObjectURL(a.href); };
  return <Dialog title="Set up two-factor sign-in" onClose={onClose}>
    {step === 'start' && <><p className="sub">You will scan a QR code with your authenticator app, then confirm with a 6-digit code.</p><Msg>{err}</Msg><button className="primary" onClick={start} disabled={busy}>{busy ? 'Preparing…' : 'Begin'}</button></>}
    {step === 'scan' && <form onSubmit={confirm}>
      <p className="sub">Scan this code, or type the key by hand.</p>
      <img className="qr" src={qr} alt="QR code for your authenticator app" /><div className="secret">{data.secret}</div>
      <Field label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
      <Msg>{err}</Msg><button className="primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Turn on'}</button></form>}
    {step === 'codes' && <><Msg kind="warn">Save these recovery codes now. Each works once if you lose your phone, and they will not be shown again.</Msg>
      <ul className="codes">{codes.map(c => <li key={c}>{c}</li>)}</ul>
      <div className="chips"><button className="ghost" onClick={save}>Download</button><button className="ghost" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy</button></div>
      <button className="primary" onClick={onClose}>I have saved them</button></>}
  </Dialog>;
}

function TurnOff({ onClose, onDone }) {
  const [f, set] = useState({ password: '', code: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const go = async e => { e.preventDefault(); setBusy(true); setErr(''); try { await api('/security/2fa/disable', { method: 'POST', body: f }); onDone(); } catch (x) { setErr(errText(x)); setBusy(false); } };
  return <Dialog title="Turn off two-factor" onClose={onClose}><form onSubmit={go}>
    <p className="sub">Enter your password and a current code or a recovery code.</p>
    <Field label="Password" type="password" autoComplete="current-password" required value={f.password} onChange={e => set({ ...f, password: e.target.value })} />
    <Field label="Code" autoComplete="one-time-code" required value={f.code} onChange={e => set({ ...f, code: e.target.value })} />
    <Msg>{err}</Msg><button className="danger" disabled={busy}>{busy ? 'Turning off…' : 'Turn off'}</button></form></Dialog>;
}

function PinForm({ needCode, onClose, onDone }) {
  const [f, set] = useState({ pin: '', password: '', code: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const go = async e => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/security/pin', { method: 'PUT', body: { pin: f.pin, password: f.password, ...(needCode && { code: f.code }) } }); onDone(); } catch (x) { setErr(errText(x)); setBusy(false); }
  };
  return <Dialog title="Transaction PIN" onClose={onClose}><form onSubmit={go}>
    <Field label="New 6-digit PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={6} required value={f.pin} onChange={e => set({ ...f, pin: e.target.value.replace(/\D/g, '') })} hint="Avoid repeats like 111111 and runs like 123456." />
    <Field label="Account password" type="password" autoComplete="current-password" required value={f.password} onChange={e => set({ ...f, password: e.target.value })} />
    {needCode && <Field label="Authenticator code" autoComplete="one-time-code" required value={f.code} onChange={e => set({ ...f, code: e.target.value })} />}
    <Msg>{err}</Msg><button className="primary" disabled={busy || f.pin.length !== 6}>{busy ? 'Saving…' : 'Save PIN'}</button></form></Dialog>;
}
