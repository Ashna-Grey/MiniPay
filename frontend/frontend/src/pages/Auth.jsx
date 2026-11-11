import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api, errText, setToken } from '../api.js';
import { useAuth } from '../App.jsx';
import { Field, Msg } from '../ui.jsx';

const Frame = ({ title, sub, children, foot }) => <div className="auth">
  <div className="auth-art"><div className="mark">MiniPay</div><p>Send rupees to friends by username. Every payment is recorded twice, once out and once in, so the books always balance.</p><small>Simulated payments. No real money moves.</small></div>
  <div className="auth-form"><h1>{title}</h1><p className="sub">{sub}</p>{children}<p className="foot">{foot}</p></div>
</div>;

export function Login() {
  const { loadMe } = useAuth(), [f, set] = useState({ email: '', password: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const notice = useLocation().state?.notice;
  const go = async e => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api('/auth/login', { method: 'POST', body: f }); setToken(r.accessToken); await loadMe(); }
    catch (x) { setErr(errText(x)); setBusy(false); }
  };
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
      <Field label="Password" type="password" autoComplete="new-password" required value={f.password} onChange={up('password')} hint="At least 10 characters with upper case, lower case and a digit." />
      <Msg>{err}</Msg>
      <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
    </form>
  </Frame>;
}
