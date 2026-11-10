import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { fmtMoney } from './api';
import { downloadBlob, whatsappShareUrl, emailShareUrl, copyText, printPdfBlob } from './pdf';

// ---------- toasts ----------
interface Toast { id: number; msg: string; kind: 'ok' | 'err' | 'info' | 'warn' }
const ToastCtx = createContext<(msg: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t.slice(-4), { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toasts no-print">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- modal ----------
export function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="modal-overlay no-print" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- share fallback (browsers without file sharing) ----------
export function ShareFallbackModal({ title, filename, summary, blob, onClose }: {
  title: string; filename: string; summary: string; blob: Blob; onClose: () => void;
}) {
  const [pdfUrl] = useState(() => URL.createObjectURL(blob));
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [printing, setPrinting] = useState(false);
  useEffect(() => () => URL.revokeObjectURL(pdfUrl), [pdfUrl]);

  const doCopy = async () => {
    const ok = await copyText(summary);
    setCopied(ok ? 'ok' : 'fail');
    if (ok) setTimeout(() => setCopied('idle'), 2500);
  };
  const doPrint = async () => {
    setPrinting(true);
    const ok = await printPdfBlob(blob);
    setPrinting(false);
    if (!ok) {
      // Last resort: print the page behind the modal instead.
      onClose();
      setTimeout(() => window.print(), 200);
    }
  };

  return (
    <Modal title={`Share: ${title}`} onClose={onClose} wide>
      <div className="share-grid">
        <div className="share-preview">
          <div className="field-label">PDF preview</div>
          <iframe src={pdfUrl} title={`${title} PDF preview`} className="pdf-preview" />
        </div>
        <div className="share-actions">
          <button className="btn btn-primary btn-block" onClick={() => downloadBlob(blob, filename)}>⬇ Download PDF</button>
          <button className="btn btn-block" onClick={doPrint} disabled={printing}>{printing ? 'Opening print…' : '🖨 Print / Save as PDF'}</button>
          <a className="btn btn-block share-link" href={whatsappShareUrl(summary)} target="_blank" rel="noreferrer">💬 WhatsApp summary</a>
          <a className="btn btn-block share-link" href={emailShareUrl(title, summary + '\n\n(Full PDF downloaded separately — attach it to this message.)')}>✉️ Email summary</a>
          <button className="btn btn-block" onClick={doCopy}>
            {copied === 'ok' ? '✓ Copied to clipboard!' : copied === 'fail' ? '⚠ Copy failed — select the text below' : '📋 Copy summary'}
          </button>
          <textarea className="input summary-box" readOnly rows={6} value={summary} onFocus={e => e.target.select()} aria-label="Report summary — select and copy" />
          <p className="muted">If Download or the WhatsApp / Email buttons do nothing in this embedded preview, use <b>Print → Save as PDF</b> for the file, or <b>Copy summary</b> and paste it into WhatsApp / Email yourself. On phones, the 📤 Share button sends the actual PDF file straight into WhatsApp, Gmail and other apps.</p>
        </div>
      </div>
    </Modal>
  );
}

// ---------- small atoms ----------
export const Spinner = () => <div className="spinner" />;
export const CenterSpin = () => <div className="center-spin"><Spinner /></div>;

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return <div className="empty"><div className="empty-title">{title}</div>{hint && <div className="empty-hint">{hint}</div>}</div>;
}

export function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge badge-${tone || 'muted'}`}>{children}</span>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ? 'stat-' + tone : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub != null && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Pagination({ page, totalPages, onPage, total }: {
  page: number; totalPages: number; onPage: (p: number) => void; total?: number;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination no-print">
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
      <span className="page-info">Page {page} of {totalPages}{total != null ? ` · ${total} records` : ''}</span>
      <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next ›</button>
    </div>
  );
}

export function Money({ value, cur }: { value: number | string | null | undefined; cur?: string }) {
  return <span className="money">{fmtMoney(value, cur)}</span>;
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs no-print">
      {tabs.map(t => (
        <button key={t.id} className={`tab ${t.id === active ? 'tab-active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function statusTone(s: string): string {
  const m: Record<string, string> = {
    active: 'ok', available: 'ok', paid: 'ok', verified: 'ok', approved: 'ok', applied: 'ok',
    finalized: 'ok', exited: 'muted', occupied: 'warn', partial: 'warn', pending: 'warn',
    manual: 'warn', reserved: 'info', complimentary: 'info', monthly: 'info',
    expired: 'err', failed: 'err', rejected: 'err', cancelled: 'err', reversed: 'err',
    out_of_service: 'err', voided: 'err', suspended: 'err', draft: 'muted',
    unpaid: 'warn', due: 'warn', overdue: 'err', AUTHORIZED: 'ok', DENIED: 'err', sent: 'info'
  };
  return m[s] || 'muted';
}

// ---------- v3: dependency-free SVG charts ----------
export function BarChart({ data, goldLast }: { data: { label: string; value: number }[]; goldLast?: boolean }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="bar-chart" role="img" aria-label="Bar chart">
      {data.map((d, i) => (
        <div key={i} className={'bar-col' + (goldLast && i === data.length - 1 ? ' gold' : '')}>
          <div className="bar-rect" style={{ height: `${Math.max(3, (d.value / max) * 130)}px` }} title={`${d.label}: ${d.value}`} />
          <div className="bar-x">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

const PIE_COLORS = ['#1a365d', '#c9943e', '#2b5f92', '#2f9e5f', '#7b4fc9', '#d0534b', '#5b6672'];
export function PieChart({ data, center }: { data: { label: string; value: number }[]; center?: string }) {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  let acc = 0;
  const segs = data.map((d, i) => {
    const frac = d.value / total;
    const s = { ...d, color: PIE_COLORS[i % PIE_COLORS.length], dash: frac * 100, off: 25 - acc * 100 };
    acc += frac;
    return s;
  });
  return (
    <div className="pie-wrap">
      <svg className="pie-svg" viewBox="0 0 42 42" role="img" aria-label="Pie chart">
        <circle cx="21" cy="21" r="15.9" fill="none" stroke="#e8edf5" strokeWidth="8" />
        {segs.filter(s => s.value > 0).map((s, i) => (
          <circle key={i} cx="21" cy="21" r="15.9" fill="none" stroke={s.color} strokeWidth="8"
            strokeDasharray={`${s.dash} ${100 - s.dash}`} strokeDashoffset={s.off}>
            <title>{`${s.label}: ${s.value}`}</title>
          </circle>
        ))}
        {center ? <text x="21" y="22" textAnchor="middle" className="pie-center" transform="rotate(90 21 21)">{center}</text> : null}
      </svg>
      <div className="pie-legend">
        {segs.map((s, i) => (
          <div key={i}><span className="sw" style={{ background: s.color }} />{s.label} — {s.value}</div>
        ))}
      </div>
    </div>
  );
}
