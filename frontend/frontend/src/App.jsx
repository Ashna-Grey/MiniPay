import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { api, refresh, setToken, setOnExpire } from './api.js';
import { Login, Register } from './pages/Auth.jsx';
import Home from './pages/Home.jsx';
import Transactions from './pages/Transactions.jsx';
import Settings from './pages/Settings.jsx';
import Admin from './pages/Admin.jsx';

const Auth = createContext(null);
export const useAuth = () => useContext(Auth);

export default function App() {
  const [user, setUser] = useState(null), [ready, setReady] = useState(false);
  const loadMe = useCallback(async () => { const u = await api('/users/me'); setUser(u); return u; }, []);
  const signOut = useCallback(async () => { try { await api('/auth/logout', { method: 'POST' }); } catch {} setToken(null); setUser(null); }, []);
  useEffect(() => {
    setOnExpire(() => { setToken(null); setUser(null); });
    refresh().then(loadMe).catch(() => {}).finally(() => setReady(true));
  }, [loadMe]);
  if (!ready) return <p className="boot">Loading…</p>;
  return <Auth.Provider value={{ user, loadMe, signOut }}>
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <Register />} />
      <Route element={user ? <Shell /> : <Navigate to="/login" replace />}>
        <Route index element={<Home />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={user?.role === 'ADMIN' ? <Admin /> : <Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </Auth.Provider>;
}

function Shell() {
  const { user, signOut } = useAuth(), nav = useNavigate();
  const out = async () => { await signOut(); nav('/login'); };
  return <div className="shell">
    <aside>
      <div className="mark">MiniPay</div>
      <nav aria-label="Main">
        <NavLink to="/" end>Wallet</NavLink>
        <NavLink to="/transactions">Payments</NavLink>
        {user.role === 'ADMIN' && <NavLink to="/admin">Admin</NavLink>}
        <NavLink to="/settings">Account</NavLink>
      </nav>
      <div className="me"><b>@{user.username}</b><button className="ghost" onClick={out}>Sign out</button></div>
    </aside>
    <main><Outlet /></main>
  </div>;
}
