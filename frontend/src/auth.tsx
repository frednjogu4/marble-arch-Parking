import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { get, post, setToken, clearToken, getToken, setReauthHandler } from './api';
import type { User } from './types';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  noLogin: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => void;
  refresh: () => Promise<void>;
  has: (...codes: string[]) => boolean;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [noLogin, setNoLogin] = useState(false);
  const noLoginRef = useRef(false);

  const refresh = async () => {
    // No-login mode: grab a session automatically, no credentials needed.
    try {
      const mode: any = await get('/api/auth/mode').catch(() => null);
      if (mode && mode.noLogin) {
        noLoginRef.current = true;
        setNoLogin(true);
        const r = await post<{ token: string; user: User }>('/api/auth/auto-login');
        setToken(r.token);
        setUser(r.user);
        return;
      }
    } catch { /* fall through to normal session check */ }
    if (!getToken()) { setUser(null); return; }
    try {
      const r = await get<{ user: User }>('/api/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    }
  };

  useEffect(() => {
    (async () => {
      await refresh();
      setLoading(false);
    })();
    const h = () => {
      if (noLoginRef.current) refresh();
      else setUser(null);
    };
    window.addEventListener('ma:unauthorized', h);
    return () => window.removeEventListener('ma:unauthorized', h);
  }, []);

  const login = async (username: string, password: string) => {
    const r = await post<{ token: string; user: User }>('/api/auth/login', { username, password });
    setToken(r.token);
    setUser(r.user);
    return r.user;
  };

  const logout = () => {
    void post('/api/auth/logout').catch(() => {});
    clearToken();
    setUser(null);
  };

  const has = (...codes: string[]) => {
    const p = Array.isArray(user?.permissions) ? user.permissions : [];
    return codes.some(c => p.includes(c));
  };

  return <Ctx.Provider value={{ user, loading, noLogin, login, logout, refresh, has }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading, noLogin } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="boot"><div className="spinner" /><p>Loading…</p></div>;
  if (!user) {
    if (noLogin) {
      return (
        <div className="boot">
          <p>Could not start a session.</p>
          <button className="btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      );
    }
    return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  }
  return children;
}

export function RequirePerm({ any, children }: { any: string[]; children: JSX.Element }) {
  const { has } = useAuth();
  if (!has(...any)) {
    return (
      <div className="page">
        <div className="card denied">
          <h2>Access denied</h2>
          <p>Your role does not have permission to view this section.</p>
        </div>
      </div>
    );
  }
  return children;
}
