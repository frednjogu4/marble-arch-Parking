import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { get, post, listOutbox, onOutboxChange, syncOutbox } from '../api';
import { useToast, Modal, Field } from '../ui';
import type { HotelSettings } from '../types';

// ---------- settings context ----------
const SettingsCtx = createContext<HotelSettings>(null as any);
export const useSettings = () => useContext(SettingsCtx);

const NAV: { to: string; label: string; icon: string; perms: string[] }[] = [
  { to: '/', label: 'Dashboard', icon: '📊', perms: ['dashboard.view'] },
  { to: '/parking', label: 'Parking', icon: '🅿️', perms: ['sessions.view'] },
  { to: '/entry', label: 'Vehicle Entry', icon: '🚗', perms: ['sessions.entry'] },
  { to: '/exit', label: 'Vehicle Exit', icon: '🏁', perms: ['sessions.exit'] },
  { to: '/live', label: 'Live Parking', icon: '🗺️', perms: ['spaces.view', 'sessions.view'] },
  { to: '/customers', label: 'Customers', icon: '👥', perms: ['customers.view'] },
  { to: '/monthly', label: 'Monthly Parking', icon: '📅', perms: ['monthly.view'] },
  { to: '/payments', label: 'Payments', icon: '💳', perms: ['payments.view'] },
  { to: '/billing', label: 'Billing', icon: '🧾', perms: ['billing.view'] },
  { to: '/settlement', label: 'Settlement', icon: '🤝', perms: ['settlement.view'] },
  { to: '/access', label: 'Access Control', icon: '🛡️', perms: ['access.view'] },
  { to: '/validations', label: 'Validations', icon: '🎟️', perms: ['validations.view'] },
  { to: '/rates', label: 'Rates', icon: '💲', perms: ['settings.view'] },
  { to: '/daily', label: 'Daily Report', icon: '📰', perms: ['reports.view', 'access.view'] },
  { to: '/shifts', label: 'Shifts', icon: '⏰', perms: ['shifts.view'] },
  { to: '/reports', label: 'Reports', icon: '📈', perms: ['reports.view'] },
  { to: '/reconciliation', label: 'Reconciliation', icon: '⚖️', perms: ['recon.view'] },
  { to: '/promotions', label: 'Promotions', icon: '🏷️', perms: ['discounts.apply', 'promotions.manage'] },
  { to: '/users', label: 'Users', icon: '👤', perms: ['users.view'] },
  { to: '/audit', label: 'Audit Logs', icon: '🧾', perms: ['audit.view'] },
  { to: '/settings', label: 'Settings', icon: '⚙️', perms: ['settings.view'] }
];

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { refresh } = useAuth();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nw !== cf) { toast('New passwords do not match', 'err'); return; }
    setBusy(true);
    try {
      await post('/api/auth/change-password', { current_password: cur, new_password: nw });
      toast('Password changed', 'ok');
      await refresh();
      onClose();
    } catch (err: any) { toast(err.message, 'err'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Change password" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <Field label="Current password"><input type="password" className="input" value={cur} onChange={e => setCur(e.target.value)} required /></Field>
        <Field label="New password (min 8 characters)"><input type="password" className="input" value={nw} onChange={e => setNw(e.target.value)} required /></Field>
        <Field label="Confirm new password"><input type="password" className="input" value={cf} onChange={e => setCf(e.target.value)} required /></Field>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Modal>
  );
}

export default function Layout() {
  const { user, has, logout, noLogin } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [settings, setSettings] = useState<HotelSettings | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [notifs, setNotifs] = useState<any>({ stored: [], alerts: [], unread: 0 });
  const [showNotifs, setShowNotifs] = useState(false);
  const [showUser, setShowUser] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [outboxCount, setOutboxCount] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [occ, setOcc] = useState<any>(null);
  const [shift, setShift] = useState<any>(null);
  const searchTimer = useRef<any>(null);

  const loadSettings = async () => {
    try { const r = await get<{ data: HotelSettings }>('/api/settings'); setSettings(r.data); }
    catch {}
  };
  const loadNotifs = async () => {
    try { setNotifs(await get('/api/notifications')); } catch {}
  };
  const loadChips = async () => {
    try {
      const s = await get<any>('/api/spaces?pageSize=1');
      setOcc(s.occupancy);
    } catch {}
    try {
      const c = await get<any>('/api/shifts/current');
      setShift(c.data);
    } catch {}
  };

  useEffect(() => {
    loadSettings();
    loadNotifs();
    loadChips();
    setOutboxCount(listOutbox().length);
    const off = onOutboxChange(() => setOutboxCount(listOutbox().length));
    const on = () => setOnline(true);
    const offn = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', offn);
    const t = setInterval(() => { loadNotifs(); loadChips(); }, 60000);
    const hs = () => loadSettings();
    window.addEventListener('ma:settings', hs);
    return () => {
      off(); window.removeEventListener('online', on); window.removeEventListener('offline', offn);
      clearInterval(t); window.removeEventListener('ma:settings', hs);
    };
  }, []);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (q.trim().length < 2) { setResults(null); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        setResults(await get('/api/search?q=' + encodeURIComponent(q.trim())));
        setShowResults(true);
      } catch {}
    }, 350);
  }, [q]);

  const doSync = async () => {
    const r = await syncOutbox();
    if (r.synced) toast(`Synced ${r.synced} record(s)`, 'ok');
    if (r.failed.length) toast(`${r.failed.length} item(s) failed - review outbox in Payments/Entry`, 'err');
    if (!r.synced && !r.failed.length) toast('Outbox is empty', 'info');
    loadChips();
  };

  const navItems = NAV.filter(n => has(...n.perms));

  return (
    <SettingsCtx.Provider value={settings as any}>
      <div className="app-shell">
        <aside className={`sidebar no-print ${sideOpen ? 'open' : ''}`}>
          <div className="brand">
            {settings?.logo_data
              ? <img src={settings.logo_data} alt="logo" className="brand-logo" />
              : <div className="brand-mark">MA</div>}
            <div>
              <div className="brand-name">{settings?.hotel_name || 'Marble Arch Hotel'}</div>
              <div className="brand-sub">Parking Management</div>
            </div>
          </div>
          <nav className="nav">
            {navItems.map(n => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')} onClick={() => setSideOpen(false)}>
                <span className="nav-icon">{n.icon}</span> {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="side-foot">
            <div>{user?.full_name}</div>
            <div className="muted">{user?.role_name}</div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar no-print">
            <button className="icon-btn hamburger" onClick={() => setSideOpen(!sideOpen)}>☰</button>
            <div className="search-wrap">
              <input
                className="input search-input" placeholder="🔍 Search reg, ticket, customer, phone, ref…"
                value={q} onChange={e => setQ(e.target.value)}
                onFocus={() => results && setShowResults(true)}
                onBlur={() => setTimeout(() => setShowResults(false), 200)}
              />
              {showResults && results && (
                <div className="search-drop">
                  {results.sessions?.map((s: any) => (
                    <div key={'s' + s.id} className="search-row" onMouseDown={() => { nav(`/parking?ticket=${s.ticket_no}`); setShowResults(false); }}>
                      <b>{s.registration}</b> <span className="muted">{s.ticket_no} · {s.status}</span>
                    </div>
                  ))}
                  {results.customers?.map((c: any) => (
                    <div key={'c' + c.id} className="search-row" onMouseDown={() => { nav(`/customers?q=${encodeURIComponent(c.name)}`); setShowResults(false); }}>
                      👤 {c.name} <span className="muted">{c.phone}</span>
                    </div>
                  ))}
                  {results.subscriptions?.map((s: any) => (
                    <div key={'m' + s.id} className="search-row" onMouseDown={() => { nav(`/monthly?q=${s.registration}`); setShowResults(false); }}>
                      📅 {s.registration} <span className="muted">{s.customer_name} · {s.status}</span>
                    </div>
                  ))}
                  {results.payments?.map((p: any) => (
                    <div key={'p' + p.id} className="search-row" onMouseDown={() => { nav(`/payments?q=${p.reference}`); setShowResults(false); }}>
                      💳 {p.reference} <span className="muted">{p.method} · {p.amount}</span>
                    </div>
                  ))}
                  {!results.sessions?.length && !results.customers?.length && !results.subscriptions?.length && !results.payments?.length && (
                    <div className="search-row muted">No matches</div>
                  )}
                </div>
              )}
            </div>
            <div className="top-chips">
              {!online && <span className="chip chip-err">Offline</span>}
              {occ && <span className="chip" title="Available bays">🅿️ {occ.available}/{occ.total}</span>}
              {has('shifts.open', 'shifts.close', 'shifts.view') && (
                <button className={`chip ${shift ? 'chip-ok' : 'chip-warn'}`} onClick={() => nav('/shifts')} title={shift ? 'Shift open' : 'No open shift'}>
                  ⏰ {shift ? `#${shift.id}` : 'No shift'}
                </button>
              )}
              {outboxCount > 0 && (
                <button className="chip chip-warn" onClick={doSync} title="Records waiting to sync - click to sync now">
                  📤 {outboxCount} pending sync
                </button>
              )}
              <div className="bell-wrap">
                <button className="icon-btn" onClick={() => { setShowNotifs(!showNotifs); setShowUser(false); }}>
                  🔔{notifs.unread > 0 && <span className="dot">{notifs.unread}</span>}
                </button>
                {showNotifs && (
                  <div className="drop">
                    <div className="drop-head"><b>Notifications</b>
                      <span>
                        <button className="link" onClick={async () => { await post('/api/notifications/read-all'); loadNotifs(); }}>Mark all read</button>
                        {' · '}<button className="link" onClick={() => { nav('/notifications'); setShowNotifs(false); }}>View all</button>
                      </span>
                    </div>
                    {[...(notifs.alerts || []), ...(notifs.stored || []).filter((n: any) => !n.read_at)].slice(0, 8).map((n: any) => (
                      <div key={n.id} className="drop-row"><b>{n.title}</b><div className="muted">{n.message}</div></div>
                    ))}
                    {notifs.unread === 0 && <div className="drop-row muted">No new notifications</div>}
                  </div>
                )}
              </div>
              <div className="bell-wrap">
                <button className="user-chip" onClick={() => { setShowUser(!showUser); setShowNotifs(false); }}>
                  {user?.full_name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                </button>
                {showUser && (
                  <div className="drop drop-right">
                    <div className="drop-row"><b>{user?.full_name}</b><div className="muted">{user?.username} · {user?.role_name}</div></div>
                    <div className="drop-row"><button className="link" onClick={() => { setShowPw(true); setShowUser(false); }}>Change password</button></div>
                    {!noLogin && <div className="drop-row"><button className="link" onClick={logout}>Logout</button></div>}
                  </div>
                )}
              </div>
            </div>
          </header>

          {!noLogin && user?.must_change_password === 1 && (
            <div className="pw-banner no-print">
              You are using a temporary password. <button className="link" onClick={() => setShowPw(true)}>Change it now</button>.
            </div>
          )}

          <main className="content">
            <Outlet />
          </main>

          <nav className="bottom-nav no-print">
            {has('sessions.entry') && <NavLink to="/entry">🚗<span>Entry</span></NavLink>}
            {has('sessions.exit') && <NavLink to="/exit">🏁<span>Exit</span></NavLink>}
            <NavLink to="/live">🗺️<span>Bays</span></NavLink>
            <NavLink to="/parking">🅿️<span>Cars</span></NavLink>
          </nav>
        </div>
      </div>
      {showPw && <ChangePassword onClose={() => setShowPw(false)} />}
    </SettingsCtx.Provider>
  );
}
