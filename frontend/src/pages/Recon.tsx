import React, { useEffect, useState } from 'react';
import { get, post, todayStr, fmtMoney, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, CenterSpin, statusTone, ShareFallbackModal } from '../ui';
import { buildPdf, downloadBlob, sharePdfFile, reconPdfData, reconSummary } from '../pdf';
import { PrintSheet, DocHead } from '../print';
import { useSettings } from '../components/Layout';

export default function Recon() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<any>(null);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [share, setShare] = useState<{ blob: Blob; filename: string; summary: string } | null>(null);

  const load = async (d = date) => {
    try {
      const r = await get<any>(`/api/reconciliation?date=${d}`);
      setData(r);
      setNotes(r.saved?.notes || '');
      const h = await get<any>('/api/reconciliation/list');
      setHistory(h.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true);
    try {
      await post('/api/reconciliation', { date, notes });
      toast('Draft saved', 'ok');
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const review = async (stage: string) => {
    setBusy(true);
    try {
      await post(`/api/reconciliation/${date}/review`, { stage });
      toast(`${stage} review recorded`, 'ok');
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const finalize = async () => {
    if (!confirm(`Finalize ${date}? Finalized days cannot be modified.`)) return;
    setBusy(true);
    try {
      await post(`/api/reconciliation/${date}/finalize`);
      toast('Day finalized', 'ok');
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const doPdf = async () => {
    if (!data) return;
    setPdfBusy(true);
    try {
      const { stats, sections } = reconPdfData(data.computed, data.saved, cur);
      const meta = `Date: ${date} · Status: ${String(data.saved?.status || 'not saved').replace(/_/g, ' ')}`;
      const blob = await buildPdf({ settings, title: 'Daily Reconciliation', meta, stats, sections });
      downloadBlob(blob, `reconciliation_${date}.pdf`);
      toast('PDF downloaded', 'ok');
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setPdfBusy(false); }
  };

  const doShare = async () => {
    if (!data) return;
    setPdfBusy(true);
    try {
      const { stats, sections } = reconPdfData(data.computed, data.saved, cur);
      const meta = `Date: ${date} · Status: ${String(data.saved?.status || 'not saved').replace(/_/g, ' ')}`;
      const blob = await buildPdf({ settings, title: 'Daily Reconciliation', meta, stats, sections });
      const summary = reconSummary(date, data.computed, data.saved, cur, settings?.hotel_name);
      const r = await sharePdfFile(blob, `reconciliation_${date}.pdf`, 'Daily Reconciliation', summary);
      if (r === 'shared') toast('Shared', 'ok');
      else if (r === 'unsupported') setShare({ blob, filename: `reconciliation_${date}.pdf`, summary });
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setPdfBusy(false); }
  };

  if (!data) return <CenterSpin />;
  const c = data.computed;
  const s = data.saved;

  const fig = (label: string, v: React.ReactNode) => <tr><td>{label}</td><td style={{ textAlign: 'right' }}>{v}</td></tr>;

  return (
    <div className="page">
      <div className="page-head">
        <h2>Daily Reconciliation</h2>
        <div className="row-inline" style={{ marginBottom: 0 }}>
          <input type="date" className="input" value={date} onChange={e => { setDate(e.target.value); load(e.target.value); }} />
          <button className="btn btn-sm" onClick={doPdf} disabled={pdfBusy}>📄 PDF</button>
          <button className="btn btn-sm" onClick={doShare} disabled={pdfBusy}>📤 Share</button>
          {s && <button className="btn btn-sm" onClick={() => setPrinting(true)}>🖨 Print</button>}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Computed from transactions - {date}</h3>
          <table className="table table-sm"><tbody>
            {fig('Cash', fmtMoney(c.total_cash, cur))}
            {fig('M-Pesa (verified ' + fmtMoney(c.mpesa_verified, cur) + ' · manual ' + fmtMoney(c.mpesa_manual, cur) + ')', fmtMoney(c.total_mpesa, cur))}
            {fig('Card', fmtMoney(c.total_card, cur))}
            {fig(<b>Total revenue</b> as any, <b>{fmtMoney(c.total_revenue, cur)}</b> as any)}
            {fig('Refunds (processed)', '-' + fmtMoney(c.refunds_total, cur))}
            {fig(<b>Net revenue</b> as any, <b>{fmtMoney(c.net_revenue, cur)}</b> as any)}
            {fig('Discounts', `${fmtMoney(c.discounts_total, cur)} (${c.discounts_count})`)}
            {fig('Paid vehicles', c.paid_vehicles)}
            {fig('Complimentary vehicles', c.complimentary_vehicles)}
            {fig('Monthly vehicles', c.monthly_vehicles)}
            {fig('Entered / exited', `${c.entered_vehicles} / ${c.exited_vehicles}`)}
            {fig('Shift variance', fmtMoney(c.variance, cur))}
            {fig('Shifts closed', c.shifts_closed)}
          </tbody></table>
        </div>

        <div className="card">
          <h3>Control & approval</h3>
          {!s && <p className="muted">No saved record for this day yet. Save a draft to start the approval chain.</p>}
          {s && (
            <table className="kv"><tbody>
              <tr><td>Status</td><td><Badge tone={statusTone(s.status)}>{s.status.replace(/_/g, ' ')}</Badge></td></tr>
              <tr><td>Saved revenue</td><td>{fmtMoney(s.total_revenue, cur)} (cash {fmtMoney(s.total_cash, cur)} · mpesa {fmtMoney(s.total_mpesa, cur)} · card {fmtMoney(s.total_card, cur)})</td></tr>
              <tr><td>Supervisor</td><td>{s.supervisor_name || '-'} {s.supervisor_at ? fmtDT(s.supervisor_at) : ''}</td></tr>
              <tr><td>Controller</td><td>{s.controller_name || '-'} {s.controller_at ? fmtDT(s.controller_at) : ''}</td></tr>
              <tr><td>Manager</td><td>{s.manager_name || '-'} {s.manager_at ? fmtDT(s.manager_at) : ''}</td></tr>
            </tbody></table>
          )}
          {(!s || s.status !== 'finalized') && has('recon.edit') && (
            <Field label="Notes"><input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Control notes…" /></Field>
          )}
          <div className="btn-row">
            {(!s || s.status !== 'finalized') && has('recon.edit') && <button className="btn" onClick={save} disabled={busy}>💾 Save draft</button>}
            {s?.status === 'draft' && has('recon.review.supervisor') && <button className="btn" onClick={() => review('supervisor')} disabled={busy}>✓ Supervisor review</button>}
            {s?.status === 'supervisor_reviewed' && has('recon.review.controller') && <button className="btn" onClick={() => review('controller')} disabled={busy}>✓ Controller review</button>}
            {s?.status === 'controller_reviewed' && has('recon.finalize') && <button className="btn btn-primary" onClick={finalize} disabled={busy}>🔒 Finalize day</button>}
          </div>
          {s?.status === 'finalized' && <div className="alert alert-ok">🔒 Finalized - figures are locked.</div>}
          {s?.notes && <p className="muted">Notes: {s.notes}</p>}
        </div>
      </div>

      <div className="card">
        <h3>Saved days</h3>
        <table className="table table-sm"><thead><tr><th>Date</th><th>Revenue</th><th>Paid/Comp/Monthly</th><th>Variance</th><th>Status</th></tr></thead>
          <tbody>{history.map(h => (
            <tr key={h.recon_date} onClick={() => { setDate(h.recon_date); load(h.recon_date); }} style={{ cursor: 'pointer' }}>
              <td>{h.recon_date}</td><td>{fmtMoney(h.total_revenue, cur)}</td>
              <td>{h.paid_vehicles}/{h.complimentary_vehicles}/{h.monthly_vehicles}</td>
              <td>{fmtMoney(h.variance, cur)}</td>
              <td><Badge tone={statusTone(h.status)}>{h.status.replace(/_/g, ' ')}</Badge></td>
            </tr>
          ))}</tbody></table>
      </div>

      {printing && settings && s && (
        <PrintSheet title={`Reconciliation ${date}`} onClose={() => setPrinting(false)}>
          <DocHead settings={settings} title="DAILY RECONCILIATION" meta={`Date: ${date} · Status: ${s.status}`} />
          <table className="kv"><tbody>
            <tr><td>Cash</td><td>{fmtMoney(s.total_cash, cur)}</td></tr>
            <tr><td>M-Pesa</td><td>{fmtMoney(s.total_mpesa, cur)}</td></tr>
            <tr><td>Card</td><td>{fmtMoney(s.total_card, cur)}</td></tr>
            <tr className="total"><td>Total revenue</td><td><b>{fmtMoney(s.total_revenue, cur)}</b></td></tr>
            <tr><td>Paid / Comp / Monthly vehicles</td><td>{s.paid_vehicles} / {s.complimentary_vehicles} / {s.monthly_vehicles}</td></tr>
            <tr><td>Discounts / Refunds</td><td>{fmtMoney(s.discounts_total, cur)} / {fmtMoney(s.refunds_total, cur)}</td></tr>
            <tr><td>Variance</td><td>{fmtMoney(s.variance, cur)}</td></tr>
          </tbody></table>
          <table className="kv"><tbody>
            <tr><td>Supervisor</td><td>{s.supervisor_name || ''} {s.supervisor_at ? fmtDT(s.supervisor_at) : ''}</td></tr>
            <tr><td>Controller</td><td>{s.controller_name || ''} {s.controller_at ? fmtDT(s.controller_at) : ''}</td></tr>
            <tr><td>Manager</td><td>{s.manager_name || ''} {s.manager_at ? fmtDT(s.manager_at) : ''}</td></tr>
          </tbody></table>
          <div className="doc-foot">{settings.receipt_footer}</div>
        </PrintSheet>
      )}

      {share && (
        <ShareFallbackModal title="Daily Reconciliation" filename={share.filename} summary={share.summary} blob={share.blob} onClose={() => setShare(null)} />
      )}
    </div>
  );
}
