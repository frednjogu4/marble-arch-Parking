import React, { useEffect, useState } from 'react';
import { get, post, fmtDT, todayStr, errMsg, downloadCsv } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Tabs, Pagination, CenterSpin, statusTone } from '../ui';
import type { Page } from '../types';

export default function Access() {
  const toast = useToast();
  const { has } = useAuth();
  const [tab, setTab] = useState('check');
  const [reg, setReg] = useState('');
  const [verdict, setVerdict] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [log, setLog] = useState<Page<any> | null>(null);
  const [date, setDate] = useState(todayStr());
  const [fv, setFv] = useState('');
  const [q, setQ] = useState('');
  const [glog, setGlog] = useState<Page<any> | null>(null);
  const [gdate, setGdate] = useState(todayStr());
  const [gq, setGq] = useState('');
  const [gateReason, setGateReason] = useState('');
  const [gateBusy, setGateBusy] = useState(false);

  const check = async () => {
    if (!reg.trim()) return;
    setChecking(true);
    try {
      const r = await post<{ data: any }>('/api/access/check', { registration: reg });
      setVerdict(r.data);
      if (tab === 'log') loadLog();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    setChecking(false);
  };
  const loadLog = async (page = 1) => {
    try { setLog(await get(`/api/access/log?date=${date}&verdict=${fv}&q=${encodeURIComponent(q)}&page=${page}`)); }
    catch (e: any) { toast(errMsg(e), 'err'); }
  };
  useEffect(() => { if (tab === 'log') loadLog(); }, [tab, date, fv]);
  const loadGate = async (page = 1) => {
    try { setGlog(await get(`/api/gate/log?date=${gdate}&q=${encodeURIComponent(gq)}&page=${page}`)); }
    catch (e: any) { toast(errMsg(e), 'err'); }
  };
  useEffect(() => { if (tab === 'gate') loadGate(); }, [tab, gdate]);
  const openGate = async () => {
    if (!gateReason.trim()) { toast('A reason is required to open the gate', 'err'); return; }
    if (!confirm('Open the gate? This is logged.')) return;
    setGateBusy(true);
    try {
      await post('/api/gate/open', { reason: gateReason });
      toast('Gate open logged', 'ok');
      setGateReason('');
      loadGate();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setGateBusy(false); }
  };

  return (
    <div>
      <div className="page-head"><h2>Access Control</h2></div>
      <Tabs tabs={[{ id: 'check', label: 'Verify vehicle' }, { id: 'log', label: 'Access log' }, { id: 'gate', label: 'Gate log' }]} active={tab} onChange={setTab} />
      {tab === 'check' ? (
        <div className="card" style={{ maxWidth: 640 }}>
          <Field label="Vehicle registration" hint="Guard scans or types the plate of the arriving vehicle.">
            <div className="row-inline" style={{ margin: 0 }}>
              <input className="input input-lg reg-input" placeholder="e.g. KDA 123A" value={reg} onChange={e => setReg(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') check(); }} style={{ flex: 1 }} />
              <button className="btn btn-primary btn-lg" onClick={check} disabled={checking || !reg.trim()}>{checking ? '…' : 'Verify'}</button>
            </div>
          </Field>
          {verdict && (
            <div className={'verdict ' + (verdict.verdict === 'AUTHORIZED' ? 'verdict-ok' : 'verdict-deny')}>
              <div className="verdict-mark">{verdict.verdict === 'AUTHORIZED' ? '✓' : '✕'}</div>
              <div className="verdict-word">{verdict.verdict}</div>
              <div className="verdict-reason">{verdict.reason}</div>
              <div className="verdict-sub">{verdict.registration}{verdict.suggested_category ? ` · admit as ${verdict.suggested_category}` : ''}</div>
              {verdict.subscription && <div className="verdict-sub">{verdict.subscription.customer_name} · {verdict.subscription.package_id ? '' : ''}expires {verdict.subscription.expiry_date}</div>}
            </div>
          )}
        </div>
      ) : tab === 'log' ? (
        <div className="card">
          <div className="filters">
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
            <select className="input" value={fv} onChange={e => setFv(e.target.value)}>
              <option value="">All verdicts</option><option value="AUTHORIZED">Authorized</option><option value="DENIED">Denied</option>
            </select>
            <input className="input" placeholder="Plate…" value={q} onChange={e => setQ(e.target.value.toUpperCase())} />
            <button className="btn btn-sm" onClick={() => loadLog()}>Filter</button>
            {log && <button className="btn btn-sm" onClick={() => downloadCsv('access-log.csv', log.data.map((r: any) => ({ time: r.created_at, plate: r.registration, verdict: r.verdict, reason: r.reason, by: r.checked_by_name })))}>CSV</button>}
          </div>
          {!log ? <CenterSpin /> : log.data.length === 0 ? <Empty title="No checks" hint="No access checks match." /> : (<>
            <table className="table table-cards"><thead><tr><th>Time</th><th>Plate</th><th>Verdict</th><th>Reason</th><th>By</th></tr></thead>
              <tbody>{log.data.map((r: any) => <tr key={r.id}><td data-l="Time">{fmtDT(r.created_at)}</td><td data-l="Plate"><b>{r.registration}</b></td><td data-l="Verdict"><Badge tone={statusTone(r.verdict)}>{r.verdict}</Badge></td><td data-l="Reason">{r.reason}</td><td data-l="By">{r.checked_by_name || '—'}</td></tr>)}</tbody>
            </table>
            <Pagination page={log.page} totalPages={log.totalPages} total={log.total} onPage={p => loadLog(p)} />
          </>)}
        </div>
      ) : (
        <div className="card">
          {has('sessions.exit') && (
            <Field label="Open gate manually" hint="Every opening is logged with your name. Paid exits log automatically.">
              <div className="row-inline" style={{ margin: 0 }}>
                <input className="input" placeholder="Reason - e.g. VIP escort, barrier fault…" value={gateReason}
                  onChange={e => setGateReason(e.target.value)} style={{ flex: 1 }} />
                <button className="btn btn-primary" onClick={openGate} disabled={gateBusy || !gateReason.trim()}>Open gate</button>
              </div>
            </Field>
          )}
          <div className="filters">
            <input type="date" className="input" value={gdate} onChange={e => setGdate(e.target.value)} />
            <input className="input" placeholder="Ticket or reason…" value={gq} onChange={e => setGq(e.target.value)} />
            <button className="btn btn-sm" onClick={() => loadGate()}>Filter</button>
            {glog && <button className="btn btn-sm" onClick={() => downloadCsv('gate-log.csv', glog.data.map((r: any) => ({ time: r.created_at, action: r.action, ticket: r.ticket_no, reason: r.reason, by: r.opened_by_name })))}>CSV</button>}
          </div>
          {!glog ? <CenterSpin /> : glog.data.length === 0 ? <Empty title="No gate events" hint="No gate openings match." /> : (<>
            <table className="table table-cards"><thead><tr><th>Time</th><th>Ticket</th><th>Action</th><th>Reason</th><th>By</th></tr></thead>
              <tbody>{glog.data.map((r: any) => <tr key={r.id}><td data-l="Time">{fmtDT(r.created_at)}</td><td data-l="Ticket">{r.ticket_no ? <b>{r.ticket_no}</b> : <span className="muted">-</span>}</td><td data-l="Action"><Badge tone={r.action === 'override' ? 'warn' : 'ok'}>{r.action}</Badge></td><td data-l="Reason">{r.reason}</td><td data-l="By">{r.opened_by_name || '-'}</td></tr>)}</tbody>
            </table>
            <Pagination page={glog.page} totalPages={glog.totalPages} total={glog.total} onPage={p => loadGate(p)} />
          </>)}
        </div>
      )}
    </div>
  );
}
