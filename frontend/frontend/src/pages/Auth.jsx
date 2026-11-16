import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api, errText, setToken } from '../api.js';
import { useAuth } from '../App.jsx';
import { Field, Msg, Strength } from '../ui.jsx';

const Frame = ({ title, sub, children, foot }) => <div className="auth">
  <div className="auth-art"><div className="mark">MiniPay</div>
    <div><p>Send rupees to friends by username. Every payment is recorded twice, so the books always balance.</p>
      <ul className="trust" style={{ marginTop: '1.5rem' }}><li>Two-factor sign-in and a transaction PIN</li><li>Live risk checks on every payment</li><li>Daily limits and a tamper-evident audit trail</li></ul></div>
    <small>Simulated payments. No real money moves.</small></div>
  <div className="auth-form"><h1>{title}</h1><p className="sub">{sub}</p>{children}<p className="foot">{foot}</p></div>
</div>;

export function Login() {
  const { loadMe } = useAuth(), [f, set] = useState({ email: '', password: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(null), [code, setCode] = useState(''), notice = useLocation().state?.notice;
  const done = async r => { setToken(r.accessToken); await loadMe(); };
  const go = async e => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api('/auth/login', { method: 'POST', body: f }); if (r.mfaRequired) { setMfa(r.mfaToken); setBusy(false); } else await done(r); }
    catch (x) { setErr(errText(x)); setBusy(false); }
  };
  const verify = async e => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await done(await api('/auth/login/mfa', { method: 'POST', body: { mfaToken: mfa, code: code.trim() } })); }
    catch (x) { setErr(errText(x)); setBusy(false); if (x.code === 'INVALID_MFA_TOKEN') { setMfa(null); setCode(''); } }
  };
  if (mfa) return <Frame title="Two-factor check" sub="Enter the 6-digit code from your authenticator app, or one of your recovery codes." foot={<button className="ghost" onClick={() => { setMfa(null); setCode(''); setErr(''); }}>Back to sign in</button>}>
    <form onSubmit={verify}>
      <Field label="Authentication code" autoComplete="one-time-code" autoFocus required value={code} onChange={e => setCode(e.target.value)} placeholder="123456" />
      <Msg>{err}</Msg><button className="primary" disabled={busy || code.trim().length < 6}>{busy ? 'Verifying…' : 'Verify and sign in'}</button>
    </form>
  </Frame>;
  return <Frame title="Sign in" sub="Welcome back." foot={<>New here? <Link to="/register">Create an account</Link></>}>
    <form onSubmit={go}>
      <Msg kind="ok">{notice}</Msg>
      <Field label="Email" type="email" autoComplete="email" required value={f.email} onChange={e => set({ ...f, email: e.target.value })} />
      <Field label="Password" type="password" autoComplete="current-password" required value={f.password} onChange={e => set({ ...f, password: e.target.value })} />
      <Msg>{err}</Msg>
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </Frame>;
}

export function Register() {
  const nav = useNavigate(), [f, set] = useState({ fullName: '', email: '', username: '', password: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const up = k => e => set({ ...f, [k]: e.target.value });
  const go = async e => {
    e.preventDefault(); setBusy(true); setErr('');
    const body = { ...f }; if (!body.fullName.trim()) delete body.fullName;
    try { await api('/auth/register', { method: 'POST', body }); nav('/login', { state: { notice: 'Account created. Sign in to open your wallet.' } }); }
    catch (x) { setErr(errText(x)); setBusy(false); }
  };
  return <Frame title="Create your account" sub="Your wallet is ready as soon as you sign in." foot={<>Have an account? <Link to="/login">Sign in</Link></>}>
    <form onSubmit={go}>
      <Field label="Full name (optional)" autoComplete="name" value={f.fullName} onChange={up('fullName')} />
      <Field label="Email" type="email" autoComplete="email" required value={f.email} onChange={up('email')} />
      <Field label="Username" autoComplete="username" required value={f.username} onChange={up('username')} hint="3–20 characters. Letters, digits, underscore. Starts with a letter. Friends pay you with this." />
      <Field label="Password" type="password" autoComplete="new-password" required value={f.password} onChange={up('password')} hint="At least 10 characters with upper case, lower case and a digit. Common passwords are refused." />
      <Strength value={f.password} />
      <Msg>{err}</Msg>
      <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
    </form>
  </Frame>;
}
