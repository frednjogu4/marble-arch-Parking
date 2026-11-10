// API client: auth headers, 401 handling, offline outbox, CSV export, formatters.
export class ApiError extends Error {
  status: number; code: string; details?: any;
  constructor(code: string, message: string, status = 0, details?: any) {
    super(message);
    this.code = code; this.status = status; this.details = details;
  }
}

const TOKEN_KEY = 'ma_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// ---- resilient auth ----
// Some proxies / browsers drop the `authorization` header, so we also send
// the token as `x-auth-token` (accepted by the backend). On a 401 the
// registered reauth handler can silently mint a fresh session (no-login
// mode) and the failed request is retried once before any error surfaces.
type ReauthFn = () => Promise<void>;
let reauthFn: ReauthFn | null = null;
let reauthFlight: Promise<void> | null = null;
export const setReauthHandler = (fn: ReauthFn | null) => { reauthFn = fn; };

async function silentReauth(): Promise<boolean> {
  if (!reauthFn) return false;
  try {
    if (!reauthFlight) {
      reauthFlight = reauthFn().finally(() => { reauthFlight = null; });
    }
    await reauthFlight;
    return !!getToken();
  } catch {
    return false;
  }
}

const authHeaders = () => {
  const t = getToken();
  return t ? { authorization: 'Bearer ' + t, 'x-auth-token': t } : {};
};

export async function api<T = any>(method: string, path: string, body?: any, _retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError('NETWORK', 'Network unavailable. Please check your connection.', 0);
  }
  const json: any = await res.json().catch(() => ({}));
  if (res.status === 401 && !_retried && !path.startsWith('/api/auth/')) {
    if (await silentReauth()) return api<T>(method, path, body, true);
  }
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('ma:unauthorized'));
  }
  if (!res.ok) {
    throw new ApiError(
      json?.error?.code || 'REQUEST_FAILED',
      json?.error?.message || `Request failed (${res.status})`,
      res.status,
      json?.error?.details
    );
  }
  return json as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: any) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b?: any) => api<T>('PUT', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

// ---------------- Offline outbox ----------------
// Mutations that fail with a NETWORK error are queued here and replayed later.
// Queued items are ALWAYS shown as "Pending sync" - never as stored records.
export interface OutboxItem {
  id: string; ts: number; method: string; path: string; body: any; label: string; error?: string;
}
const OUTBOX_KEY = 'ma_outbox';
type Listener = () => void;
const listeners = new Set<Listener>();
export const onOutboxChange = (cb: Listener) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};
const emit = () => listeners.forEach(l => l());

export function listOutbox(): OutboxItem[] {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function saveOutbox(items: OutboxItem[]) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  emit();
}
export function queueOffline(method: string, path: string, body: any, label: string): OutboxItem {
  const items = listOutbox();
  const item: OutboxItem = {
    id: 'ob-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    ts: Date.now(), method, path, body, label
  };
  items.push(item);
  saveOutbox(items);
  return item;
}
export function removeOutbox(id: string) {
  saveOutbox(listOutbox().filter(i => i.id !== id));
}
export async function syncOutbox(): Promise<{ synced: number; failed: { item: OutboxItem; error: string }[] }> {
  const items = listOutbox();
  let synced = 0;
  const failed: { item: OutboxItem; error: string }[] = [];
  const remaining: OutboxItem[] = [];
  for (const item of items) {
    try {
      await api(item.method, item.path, item.body);
      synced++;
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'NETWORK') {
        remaining.push(item); // keep everything else too
        const idx = items.indexOf(item);
        for (const rest of items.slice(idx + 1)) if (!remaining.includes(rest)) remaining.push(rest);
        break;
      }
      failed.push({ item, error: e?.message || 'Sync failed' });
      remaining.push({ ...item, error: e?.message || 'Sync failed' });
    }
  }
  saveOutbox(remaining);
  return { synced, failed };
}

// POST/PUT/DELETE with automatic offline queuing. Returns {queued:true} when stored offline.
export async function mutate<T = any>(method: string, path: string, body: any, label: string): Promise<T & { _queued?: boolean }> {
  try {
    return await api<T>(method, path, body);
  } catch (e: any) {
    if (e instanceof ApiError && e.code === 'NETWORK') {
      queueOffline(method, path, body, label);
      return { _queued: true } as any;
    }
    throw e;
  }
}

// ---------------- CSV export ----------------
export function downloadCsv(filename: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- formatters ----------------
export const fmtMoney = (n: number | string | null | undefined, cur = 'KES') => {
  const v = Number(n) || 0;
  return `${cur} ${v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
export const fmtNum = (n: number | string | null | undefined) => (Number(n) || 0).toLocaleString('en-KE');
export function fmtDT(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtD(iso: string | null | undefined): string {
  if (!iso) return '-';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDur(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes || 0));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}
export const todayStr = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const errMsg = (e: any) => (e instanceof ApiError ? e.message : (e?.message || 'Unexpected error'));
