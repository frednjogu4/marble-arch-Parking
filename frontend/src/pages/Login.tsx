import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { get, post } from '../api';

export default function Login() {
  const { login, refresh } = useAuth();
  const nav = useNavigate();
  const loc: any = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forcePw, setForcePw] = useState(false);
  const [nw, setNw] = useState('');
  const [cf, setCf] = useState('');
  const [openAccess, setOpenAccess] = useState(false);

  useEffect(() => {
    get<{ openAccess: boolean; noLogin?: boolean }>('/api/auth/mode')
      .then(r => {
        if (r.noLogin) nav('/', { replace: true });
        else setOpenAccess(!!r.openAccess);
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const u = await login(username.trim(), openAccess ? '' : password);
      if (!openAccess && u.must_change_password === 1) setForcePw(true);
      else nav(loc.state?.from || '/', { replace: true });
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nw !== cf) { setError('Passwords do not match'); return; }
    setBusy(true);
    try {
      await post('/api/auth/change-password', { current_password: password, new_password: nw });
      await refresh();
      nav('/', { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark brand-mark-lg">MA</div>
          <h1>Marble Arch Hotel Nairobi</h1>
          <p>Parking Management System</p>
        </div>
        {openAccess && !forcePw && (
          <div className="alert alert-warn">🔓 Temporary open access — no password needed. Enter a username to continue.</div>
        )}
        {!forcePw ? (
          <form onSubmit={submit} className="form">
            <label className="field"><span className="field-label">Username</span>
              <input className="input input-lg" value={username} onChange={e => setUsername(e.target.value)} autoFocus required placeholder="e.g. admin" />
            </label>
            {!openAccess && (
              <label className="field"><span className="field-label">Password</span>
                <input type="password" className="input input-lg" value={password} onChange={e => setPassword(e.target.value)} required />
              </label>
            )}
            {error && <div className="alert alert-err">{error}</div>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? 'Signing in…' : openAccess ? 'Enter without password' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={changePw} className="form">
            <div className="alert alert-warn">First login: please set a new password (min 8 characters).</div>
            <label className="field"><span className="field-label">New password</span>
              <input type="password" className="input input-lg" value={nw} onChange={e => setNw(e.target.value)} required />
            </label>
            <label className="field"><span className="field-label">Confirm new password</span>
              <input type="password" className="input input-lg" value={cf} onChange={e => setCf(e.target.value)} required />
            </label>
            {error && <div className="alert alert-err">{error}</div>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Saving…' : 'Set password & continue'}</button>
          </form>
        )}
        <div className="login-foot">Secure gate operations · All actions are audited</div>
      </div>
    </div>
  );
}
