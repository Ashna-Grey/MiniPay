import { useState } from 'react';
import { api, errText } from '../api.js';
import { useAuth } from '../App.jsx';
import { when } from '../format.js';
import { Field, Msg } from '../ui.jsx';

export default function Settings() {
  const { user, loadMe } = useAuth();
  const [name, setName] = useState(user.fullName || ''), [pw, setPw] = useState({ currentPassword: '', newPassword: '' }), [m1, setM1] = useState(null), [m2, setM2] = useState(null);
  const saveName = async e => { e.preventDefault(); try { await api('/users/me', { method: 'PATCH', body: { fullName: name } }); await loadMe(); setM1({ k: 'ok', t: 'Name saved.' }); } catch (x) { setM1({ k: 'error', t: errText(x) }); } };
  const savePw = async e => { e.preventDefault(); try { await api('/users/me/password', { method: 'POST', body: pw }); setPw({ currentPassword: '', newPassword: '' }); setM2({ k: 'ok', t: 'Password changed.' }); } catch (x) { setM2({ k: 'error', t: errText(x) }); } };
  return <>
    <h1>Account</h1>
    <dl className="kv"><dt>Username</dt><dd>@{user.username}</dd><dt>Email</dt><dd>{user.email}</dd><dt>Member since</dt><dd>{when(user.createdAt)}</dd></dl>
    <div className="two">
      <form className="panel" onSubmit={saveName}><h2>Your name</h2>
        <Field label="Full name" maxLength={80} value={name} onChange={e => setName(e.target.value)} />
        <Msg kind={m1?.k}>{m1?.t}</Msg><button className="primary">Save name</button></form>
      <form className="panel" onSubmit={savePw}><h2>Change password</h2>
        <Field label="Current password" type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={e => setPw({ ...pw, currentPassword: e.target.value })} />
        <Field label="New password" type="password" autoComplete="new-password" required value={pw.newPassword} onChange={e => setPw({ ...pw, newPassword: e.target.value })} hint="At least 10 characters with upper case, lower case and a digit." />
        <Msg kind={m2?.k}>{m2?.t}</Msg><button className="primary">Change password</button></form>
    </div>
    <section><h2>Active sessions</h2>
      <ul className="plain">{user.sessions.map((s, i) => <li key={i}><b>{when(s.startedAt)}</b><small>{s.ip || 'Unknown IP'} · {(s.userAgent || 'Unknown device').slice(0, 70)}</small></li>)}</ul>
    </section>
  </>;
}
