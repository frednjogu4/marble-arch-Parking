import React, { useEffect, useState } from 'react';
import { get, downloadCsv, todayStr, fmtMoney, fmtDT, fmtD, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, CenterSpin, statusTone, ShareFallbackModal } from '../ui';
import { buildPdf, downloadBlob, sharePdfFile, reportSections, reportSummaryText } from '../pdf';
import { PrintSheet, DocHead } from '../print';
import { useSettings } from '../components/Layout';

const REPORTS = [
  { id: 'daily', label: 'Daily parking report', fin: false },
  { id: 'weekly', label: 'Weekly parking report', fin: false },
  { id: 'monthly', label: 'Monthly parking report', fin: false },
  { id: 'revenue', label: 'Revenue report', fin: true },
  { id: 'cash', label: 'Cash report', fin: true },
  { id: 'mpesa', label: 'M-Pesa report', fin: true },
  { id: 'card', label: 'Card / PDQ report', fin: true },
  { id: 'shifts', label: 'Shift report', fin: false },
  { id: 'variance', label: 'Variance report', fin: true },
  { id: 'complimentary', label: 'Complimentary report', fin: false },
  { id: 'monthly-customers', label: 'Monthly customer report', fin: false },
  { id: 'vehicle-history', label: 'Vehicle history', fin: false, needsQ: true },
  { id: 'occupancy', label: 'Occupancy report', fin: false },
  { id: 'user-activity', label: 'User activity report', fin: false },
  { id: 'discounts', label: 'Discount report', fin: true },
  { id: 'refunds', label: 'Refund report', fin: true },
  { id: 'audit', label: 'Audit report', fin: false }
];

export default function Reports() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [sel, setSel] = useState(REPORTS[0]);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [userId, setUserId] = useState('');
  const [method, setMethod] = useState('');
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [out, setOut] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [share, setShare] = useState<{ blob: Blob; filename: string; summary: string } | null>(null);

  const visible = REPORTS.filter(r => !r.fin || has('reports.financial'));

  useEffect(() => {
    if (has('users.view')) get<any>('/api/users?pageSize=100').then(r => setUsers(r.data)).catch(() => {});
  }, []);

  useEffect(() => { setOut(null); }, [sel]);

  const run = async (page = 1) => {
    setLoading(true);
    try {
      const r = await get<any>(`/api/reports/${sel.id}?from=${from}&to=${to}&user_id=${userId}&method=${method}&q=${encodeURIComponent(q)}&page=${page}&pageSize=100`);
      setOut(r);
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setLoading(false); }
  };

  const mainRows = (): Record<string, any>[] => {
    if (!out) return [];
    if (out.rows) return out.rows;
    if (out.revenue_by_day_method) return out.revenue_by_day_method;
    if (out.data) return out.data;
    return [];
  };

  const doCsv = () => {
    const rows = mainRows();
    if (!rows.length) { toast('Nothing to export', 'info'); return; }
    downloadCsv(`${sel.id}_${from}_${to}.csv`, rows);
    toast('CSV exported (opens in Excel)', 'ok');
  };

  const meta = `Period: ${fmtD(from)} → ${fmtD(to)}${userId ? ` · User: ${users.find(u => String(u.id) === userId)?.username || userId}` : ''}${method ? ` · ${method}` : ''}${q ? ` · "${q}"` : ''}`;
  const filename = `${sel.id}_${from}_${to}.pdf`;

  const doPdf = async () => {
    if (!out) { toast('Run the report first', 'info'); return; }
    setPdfBusy(true);
    try {
      const { stats, sections } = reportSections(sel.id, out, cur);
      const blob = await buildPdf({ settings, title: sel.label, meta, stats, sections });
      downloadBlob(blob, filename);
      toast('PDF downloaded', 'ok');
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setPdfBusy(false); }
  };

  const doShare = async () => {
    if (!out) { toast('Run the report first', 'info'); return; }
    setPdfBusy(true);
    try {
      const { stats, sections } = reportSections(sel.id, out, cur);
      const blob = await buildPdf({ settings, title: sel.label, meta, stats, sections });
      const summary = reportSummaryText(sel.label, meta, stats, mainRows().length, settings?.hotel_name);
      const r = await sharePdfFile(blob, filename, sel.label, summary);
      if (r === 'shared') toast('Shared', 'ok');
      else if (r === 'unsupported') setShare({ blob, filename, summary });
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setPdfBusy(false); }
  };

  const renderOut = () => {
    if (!out) return <Empty title="Choose filters and run the report" />;
    if (loading) return <CenterSpin />;
    const R = sel.id;
    if (['daily', 'weekly', 'monthly'].includes(R)) {
      const byDay: Record<string, any> = {};
      for (const r of out.revenue_by_day_method) {
        byDay[r.d] = byDay[r.d] || { d: r.d, cash: 0, mpesa: 0, card: 0 };
        byDay[r.d][r.method] = Number(r.t);
      }
      const traffic: Record<string, any> = {};
      for (const t of out.traffic) traffic[t.d] = t;
      return <>
        <h4>Revenue by day</h4>
        <table className="table table-sm"><thead><tr><th>Day</th><th>Cash</th><th>M-Pesa</th><th>Card</th><th>Total</th><th>Entries</th><th>Exits</th></tr></thead>
          <tbody>{Object.values(byDay).map((d: any) => (
            <tr key={d.d}><td>{fmtD(d.d)}</td><td>{fmtMoney(d.cash, cur)}</td><td>{fmtMoney(d.mpesa, cur)}</td><td>{fmtMoney(d.card, cur)}</td>
              <td><b>{fmtMoney(d.cash + d.mpesa + d.card, cur)}</b></td><td>{traffic[d.d]?.entries || 0}</td><td>{traffic[d.d]?.exits || 0}</td></tr>
          ))}</tbody></table>
        {out.complimentary?.length > 0 && <>
          <h4>Complimentary by day</h4>
          <table className="table table-sm"><thead><tr><th>Day</th><th>Vehicles</th></tr></thead>
            <tbody>{out.complimentary.map((c: any) => <tr key={c.d}><td>{fmtD(c.d)}</td><td>{c.n}</td></tr>)}</tbody></table>
        </>}
      </>;
    }
    if (['revenue', 'cash', 'mpesa', 'card'].includes(R)) {
      const gross = out.totals.filter((t: any) => ['verified', 'manual'].includes(t.verification_status)).reduce((a: number, t: any) => a + Number(t.t), 0);
      return <>
        <div className="stat-grid stat-grid-sm">
          {out.totals.map((t: any) => <div key={t.method + t.verification_status} className="stat"><div className="stat-label">{t.method} · {t.verification_status}</div><div className="stat-value" style={{ fontSize: 18 }}>{fmtMoney(t.t, cur)}</div></div>)}
          <div className="stat"><div className="stat-label">Refunds (processed)</div><div className="stat-value" style={{ fontSize: 18 }}>{fmtMoney(out.refunds_total, cur)}</div></div>
          <div className="stat stat-ok"><div className="stat-label">Net revenue</div><div className="stat-value" style={{ fontSize: 18 }}>{fmtMoney(gross - out.refunds_total, cur)}</div></div>
        </div>
        <table className="table table-sm"><thead><tr><th>Time</th><th>Ticket</th><th>Method</th><th>Amount</th><th>Ref</th><th>Verification</th><th>By</th></tr></thead>
          <tbody>{out.rows.map((p: any) => <tr key={p.id}><td>{fmtDT(p.paid_at)}</td><td>{p.ticket_no || '-'}</td><td>{p.method}</td><td>{fmtMoney(p.amount, cur)}</td><td>{p.reference}</td><td><Badge tone={statusTone(p.verification_status)}>{p.verification_status}</Badge></td><td>{p.received_by_name}</td></tr>)}</tbody></table>
        {R === 'mpesa' && out.transactions?.length > 0 && <>
          <h4>STK transactions</h4>
          <table className="table table-sm"><thead><tr><th>ID</th><th>Ticket</th><th>Phone</th><th>Amount</th><th>Receipt</th><th>Status</th></tr></thead>
            <tbody>{out.transactions.map((t: any) => <tr key={t.id}><td>#{t.id}</td><td>{t.ticket_no}</td><td>{t.phone}</td><td>{fmtMoney(t.amount, cur)}</td><td>{t.mpesa_receipt}</td><td><Badge tone={statusTone(t.status)}>{t.status}</Badge></td></tr>)}</tbody></table>
        </>}
      </>;
    }
    if (R === 'shifts') {
      return <table className="table table-sm"><thead><tr><th>ID</th><th>User</th><th>Station</th><th>Opened</th><th>Closed</th><th>Exp Cash</th><th>Act Cash</th><th>Exp M-Pesa</th><th>Act M-Pesa</th><th>Exp Card</th><th>Act Card</th></tr></thead>
        <tbody>{out.rows.map((s: any) => <tr key={s.id}><td>#{s.id}</td><td>{s.username}</td><td>{s.station}</td><td>{fmtDT(s.opened_at)}</td><td>{fmtDT(s.closed_at)}</td><td>{fmtMoney(s.expected_cash, cur)}</td><td>{fmtMoney(s.actual_cash, cur)}</td><td>{fmtMoney(s.expected_mpesa, cur)}</td><td>{fmtMoney(s.actual_mpesa, cur)}</td><td>{fmtMoney(s.expected_card, cur)}</td><td>{fmtMoney(s.actual_card, cur)}</td></tr>)}</tbody></table>;
    }
    if (R === 'variance') {
      return out.rows.length === 0 ? <Empty title="No variances in this period" /> :
        <table className="table table-sm"><thead><tr><th>Shift</th><th>User</th><th>Closed</th><th>Variance</th><th>Explanation</th></tr></thead>
          <tbody>{out.rows.map((s: any) => <tr key={s.id}><td>#{s.id}</td><td>{s.username}</td><td>{fmtDT(s.closed_at)}</td><td><b>{fmtMoney(s.variance, cur)}</b></td><td>{s.variance_note}</td></tr>)}</tbody></table>;
    }
    if (R === 'complimentary') {
      return <>
        <div className="stat-grid stat-grid-sm">{out.by_category.map((c: any) => <div key={c.comp_category} className="stat"><div className="stat-label">{c.comp_category}</div><div className="stat-value">{c.n}</div></div>)}</div>
        <table className="table table-sm"><thead><tr><th>Time</th><th>Ticket</th><th>Reg</th><th>Category</th><th>Authorized by</th><th>Recorded by</th></tr></thead>
          <tbody>{out.rows.map((r: any) => <tr key={r.id}><td>{fmtDT(r.created_at)}</td><td>{r.ticket_no}</td><td>{r.registration}</td><td>{r.comp_category}</td><td>{r.authorized_by}</td><td>{r.recorded_by_name}</td></tr>)}</tbody></table>
      </>;
    }
    if (R === 'monthly-customers') {
      return <>
        <div className="stat"><div className="stat-label">Subscription revenue in period</div><div className="stat-value">{fmtMoney(out.revenue, cur)}</div></div>
        <table className="table table-sm"><thead><tr><th>Customer</th><th>Reg</th><th>Package</th><th>Period</th><th>Days left</th><th>Status</th></tr></thead>
          <tbody>{out.rows.map((s: any) => <tr key={s.id}><td>{s.customer_name}</td><td>{s.registration}</td><td>{s.package_name}</td><td>{s.start_date} → {s.expiry_date}</td><td>{s.days_remaining}</td><td><Badge tone={statusTone(s.status)}>{s.status}</Badge></td></tr>)}</tbody></table>
      </>;
    }
    if (R === 'vehicle-history') {
      return <>
        <div className="stat-grid stat-grid-sm">
          <div className="stat"><div className="stat-label">Registration</div><div className="stat-value" style={{ fontSize: 18 }}>{out.registration}</div></div>
          <div className="stat"><div className="stat-label">Visits</div><div className="stat-value">{out.visits}</div></div>
          <div className="stat"><div className="stat-label">Total paid</div><div className="stat-value" style={{ fontSize: 18 }}>{fmtMoney(out.total_paid, cur)}</div></div>
        </div>
        <table className="table table-sm"><thead><tr><th>Ticket</th><th>Entry</th><th>Exit</th><th>Category</th><th>Paid</th></tr></thead>
          <tbody>{out.rows.map((s: any) => <tr key={s.id}><td>{s.ticket_no}</td><td>{fmtDT(s.entry_time)}</td><td>{fmtDT(s.exit_time)}</td><td>{s.category_name}</td><td>{fmtMoney(s.amount_paid, cur)}</td></tr>)}</tbody></table>
      </>;
    }
    if (R === 'occupancy') {
      const o = out.snapshot;
      return <>
        <div className="stat-grid stat-grid-sm">
          <div className="stat"><div className="stat-label">Total</div><div className="stat-value">{o.total}</div></div>
          <div className="stat"><div className="stat-label">Occupied</div><div className="stat-value">{o.occupied}</div></div>
          <div className="stat"><div className="stat-label">Available</div><div className="stat-value">{o.available}</div></div>
          <div className="stat"><div className="stat-label">Paid / Comp / Monthly</div><div className="stat-value" style={{ fontSize: 18 }}>{o.paid} / {o.complimentary} / {o.monthly}</div></div>
        </div>
        <h4>Entries by hour</h4>
        <table className="table table-sm"><thead><tr><th>Hour</th><th>Entries</th></tr></thead>
          <tbody>{out.entries_by_hour.map((r: any) => <tr key={r.h}><td>{r.h}:00</td><td>{r.entries}</td></tr>)}</tbody></table>
      </>;
    }
    if (R === 'user-activity') {
      return <>
        <h4>Actions by user</h4>
        <table className="table table-sm"><thead><tr><th>User</th><th>Role</th><th>Action</th><th>Count</th><th>Last</th></tr></thead>
          <tbody>{out.rows.map((r: any, i: number) => <tr key={i}><td>{r.username}</td><td>{r.role}</td><td>{r.action}</td><td>{r.n}</td><td>{fmtDT(r.last_at)}</td></tr>)}</tbody></table>
        <h4>Logins</h4>
        <table className="table table-sm"><thead><tr><th>Time</th><th>User</th><th>Action</th></tr></thead>
          <tbody>{out.logins.map((r: any) => <tr key={r.id}><td>{fmtDT(r.created_at)}</td><td>{r.username}</td><td>{r.action}</td></tr>)}</tbody></table>
      </>;
    }
    if (R === 'discounts') {
      return <table className="table table-sm"><thead><tr><th>Time</th><th>Ticket</th><th>Original</th><th>Discount</th><th>Reason</th><th>By</th><th>Status</th></tr></thead>
        <tbody>{out.rows.map((r: any) => <tr key={r.id}><td>{fmtDT(r.created_at)}</td><td>{r.ticket_no}</td><td>{fmtMoney(r.original_amount, cur)}</td><td>{fmtMoney(r.discount_amount, cur)}</td><td>{r.reason}</td><td>{r.applied_by_name}</td><td><Badge tone={statusTone(r.status)}>{r.status}</Badge></td></tr>)}</tbody></table>;
    }
    if (R === 'refunds') {
      return <table className="table table-sm"><thead><tr><th>Time</th><th>Ticket</th><th>Amount</th><th>Reason</th><th>By</th><th>Status</th></tr></thead>
        <tbody>{out.rows.map((r: any) => <tr key={r.id}><td>{fmtDT(r.created_at)}</td><td>{r.ticket_no}</td><td>{fmtMoney(r.amount, cur)}</td><td>{r.reason}</td><td>{r.requested_by_name}</td><td><Badge tone={statusTone(r.status)}>{r.status}</Badge></td></tr>)}</tbody></table>;
    }
    if (R === 'audit') {
      return <>
        <table className="table table-sm"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Module</th><th>Record</th></tr></thead>
          <tbody>{(out.data || []).map((r: any) => <tr key={r.id}><td>{fmtDT(r.created_at)}</td><td>{r.username}</td><td>{r.action}</td><td>{r.module}</td><td>{r.record_id}</td></tr>)}</tbody></table>
        {out.totalPages > 1 && <p className="muted">Page {out.page} of {out.totalPages} ({out.total} records) - refine filters to narrow.</p>}
      </>;
    }
    return null;
  };

  return (
    <div className="page">
      <div className="page-head"><h2>Reports</h2></div>
      <div className="reports-layout">
        <div className="card report-list no-print">
          {visible.map(r => (
            <button key={r.id} className={`report-link ${r.id === sel.id ? 'on' : ''}`} onClick={() => setSel(r)}>
              {r.label} {r.fin && <span className="muted">· fin</span>}
            </button>
          ))}
        </div>
        <div className="card report-main">
          <h3>{sel.label}</h3>
          <div className="filters no-print">
            <Field label="From"><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></Field>
            {users.length > 0 && <Field label="User"><select className="input" value={userId} onChange={e => setUserId(e.target.value)}><option value="">All</option>{users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}</select></Field>}
            {['revenue'].includes(sel.id) && <Field label="Method"><select className="input" value={method} onChange={e => setMethod(e.target.value)}><option value="">All</option><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option></select></Field>}
            <Field label={sel.needsQ ? 'Registration *' : 'Search'}><input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={sel.needsQ ? 'KAA 123A' : 'Optional'} /></Field>
            <div className="btn-row" style={{ alignSelf: 'end' }}>
              <button className="btn btn-primary btn-sm" onClick={() => run()} disabled={loading}>{loading ? '…' : 'Run'}</button>
              {has('reports.export') && <button className="btn btn-sm" onClick={doCsv}>⬇ CSV</button>}
              {has('reports.export') && <button className="btn btn-sm" onClick={doPdf} disabled={pdfBusy}>📄 PDF</button>}
              {has('reports.export') && <button className="btn btn-sm" onClick={doShare} disabled={pdfBusy}>📤 Share</button>}
              {has('reports.export') && <button className="btn btn-sm" onClick={() => setPrinting(true)}>🖨 Print</button>}
            </div>
          </div>
          <div className="report-out">{renderOut()}</div>
        </div>
      </div>

      {printing && settings && (
        <PrintSheet title={sel.label} onClose={() => setPrinting(false)}>
          <DocHead settings={settings} title={sel.label.toUpperCase()} meta={meta} />
          {renderOut()}
          <div className="doc-foot">Generated {fmtDT(new Date().toISOString())} · {settings.receipt_footer}</div>
        </PrintSheet>
      )}

      {share && (
        <ShareFallbackModal title={sel.label} filename={share.filename} summary={share.summary} blob={share.blob} onClose={() => setShare(null)} />
      )}
    </div>
  );
}
