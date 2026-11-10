import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, fmtMoney, fmtDT, fmtDur, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Tabs, Pagination, CenterSpin, statusTone } from '../ui';
import { PrintSheet, TicketPrint } from '../print';
import { useSettings } from '../components/Layout';
import type { Session, Category, Page } from '../types';

export function SessionModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [d, setD] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  const [spaces, setSpaces] = useState<any[]>([]);
  const [moveTo, setMoveTo] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const [ticket, setTicket] = useState<any>(null);

  const load = async () => {
    try {
      const r = await get<any>(`/api/sessions/${id}`);
      setD(r.data);
      setQuote(r.quote);
    } catch (e: any) { toast(errMsg(e), 'err'); onClose(); }
  };
  useEffect(() => { load(); }, [id]);

  const loadSpaces = async () => {
    const r = await get<any>('/api/spaces');
    setSpaces(r.data.filter((s: any) => s.status === 'available'));
  };

  const doMove = async () => {
    try {
      await post(`/api/sessions/${id}/move`, { space_id: Number(moveTo) });
      toast('Vehicle moved', 'ok');
      setMoveTo('');
      load(); onChanged?.();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const doVoid = async () => {
    try {
      await post(`/api/sessions/${id}/void`, { reason: voidReason });
      toast('Session voided', 'ok');
      onClose(); onChanged?.();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  if (!d) return <Modal title="Session" onClose={onClose}><CenterSpin /></Modal>;
  return (
    <Modal title={`${d.registration} · ${d.ticket_no}`} onClose={onClose} wide>
      <table className="kv"><tbody>
        <tr><td>Status</td><td><Badge tone={statusTone(d.status)}>{d.status}</Badge> <Badge tone={statusTone(d.payment_status)}>{d.payment_status}</Badge></td></tr>
        <tr><td>Customer</td><td>{d.customer_name || '-'} {d.phone}</td></tr>
        <tr><td>Category</td><td>{d.category_name}</td></tr>
        <tr><td>Bay</td><td>{d.space_code || '-'}</td></tr>
        <tr><td>Entry</td><td>{fmtDT(d.entry_time)}</td></tr>
        {d.exit_time && <tr><td>Exit</td><td>{fmtDT(d.exit_time)}</td></tr>}
        {quote && <tr><td>Duration</td><td>{fmtDur(quote.minutes)}</td></tr>}
        {quote && <tr><td>Fee / Disc / Paid / Due</td><td>{fmtMoney(quote.base, cur)} / {fmtMoney(quote.discount, cur)} / {fmtMoney(quote.paid, cur)} / <b>{fmtMoney(quote.due, cur)}</b></td></tr>}
        {!quote && <tr><td>Fee / Disc / Paid</td><td>{fmtMoney(d.base_amount, cur)} / {fmtMoney(d.discount_amount, cur)} / {fmtMoney(d.amount_paid, cur)}</td></tr>}
        {d.notes && <tr><td>Notes</td><td>{d.notes}</td></tr>}
      </tbody></table>
      <h4>Payments</h4>
      {(d.payments || []).length === 0 && <p className="muted">None.</p>}
      {(d.payments || []).map((p: any) => (
        <div key={p.id} className="pay-row"><span>{p.method.toUpperCase()} {fmtMoney(p.amount, cur)}</span>
          <span className="muted">{p.reference} · <Badge tone={statusTone(p.verification_status)}>{p.verification_status}</Badge> · {p.received_by_name}</span></div>
      ))}
      <h4>Discounts</h4>
      {(d.discounts || []).length === 0 && <p className="muted">None.</p>}
      {(d.discounts || []).map((x: any) => (
        <div key={x.id} className="pay-row"><span>{fmtMoney(x.discount_amount, cur)} <span className="muted">{x.reason}</span></span>
          <Badge tone={statusTone(x.status)}>{x.status}</Badge></div>
      ))}
      {(d.complimentary || []).length > 0 && (
        <><h4>Complimentary</h4>
          {d.complimentary.map((c: any) => <div key={c.id} className="pay-row"><span>{c.comp_category}</span><span className="muted">by {c.authorized_by} · {c.reason}</span></div>)}
        </>
      )}
      <div className="btn-row">
        <button className="btn" onClick={() => setTicket(d)}>🖨 Ticket</button>
        {d.status === 'active' && has('sessions.move') && (
          <span className="row-inline">
            <button className="btn" onClick={loadSpaces}>Move…</button>
            {spaces.length > 0 && <>
              <select className="input" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
                <option value="">To bay…</option>
                {spaces.map(s => <option key={s.id} value={s.id}>{s.code}</option>)}
              </select>
              <button className="btn" disabled={!moveTo} onClick={doMove}>Go</button>
            </>}
          </span>
        )}
        {d.status === 'active' && has('sessions.void') && <button className="btn btn-danger" onClick={() => setShowVoid(true)}>Void</button>}
      </div>
      {showVoid && (
        <div className="row-inline">
          <input className="input" placeholder="Void reason *" value={voidReason} onChange={e => setVoidReason(e.target.value)} />
          <button className="btn btn-danger" onClick={doVoid}>Confirm</button>
        </div>
      )}
      {ticket && settings && (
        <PrintSheet title={`Ticket ${ticket.ticket_no}`} onClose={() => setTicket(null)}>
          <TicketPrint s={ticket} settings={settings} />
        </PrintSheet>
      )}
    </Modal>
  );
}

export default function Parking() {
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('active');
  const [active, setActive] = useState<Page<Session> | null>(null);
  const [hist, setHist] = useState<Page<Session> | null>(null);
  const [q, setQ] = useState('');
  const [hq, setHq] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cats, setCats] = useState<Category[]>([]);
  const [catId, setCatId] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const [vhReg, setVhReg] = useState('');
  const [vh, setVh] = useState<any>(null);

  const loadActive = async (page = 1) => {
    try {
      setActive(await get(`/api/sessions/active?q=${encodeURIComponent(q)}&page=${page}`));
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const loadHist = async (page = 1) => {
    try {
      setHist(await get(`/api/sessions?status=${status}&from=${from}&to=${to}&category_id=${catId}&q=${encodeURIComponent(hq)}&page=${page}`));
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  useEffect(() => {
    get<{ data: Category[] }>('/api/categories').then(r => setCats(r.data)).catch(() => {});
    loadActive();
  }, []);

  useEffect(() => {
    const t = params.get('ticket');
    if (t) {
      get<{ data: Session[] }>(`/api/exit/lookup?q=${encodeURIComponent(t)}`).then(r => {
        if (r.data[0]) setSel(r.data[0].id);
        setParams({});
      }).catch(() => {});
    }
  }, []);

  const vehicleHistory = async () => {
    if (!vhReg.trim()) return;
    try {
      const r = await get<any>(`/api/vehicles/history?registration=${encodeURIComponent(vhReg.trim())}`);
      setVh(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const row = (s: Session) => (
    <tr key={s.id} onClick={() => setSel(s.id)} style={{ cursor: 'pointer' }}>
      <td data-l="Vehicle"><b>{s.registration}</b><div className="muted">{s.ticket_no}</div></td>
      <td data-l="Customer">{s.customer_name || '-'}<div className="muted">{s.phone}</div></td>
      <td data-l="Category">{s.category_name}</td>
      <td data-l="Bay">{s.space_code || '-'}</td>
      <td data-l="Entry">{fmtDT(s.entry_time)}{s.exit_time && <div className="muted">out {fmtDT(s.exit_time)}</div>}</td>
      <td data-l="Status"><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
    </tr>
  );

  return (
    <div className="page">
      <div className="page-head"><h2>Parking</h2></div>
      <Tabs tabs={[
        { id: 'active', label: 'Currently parked' },
        { id: 'history', label: 'Session history' },
        { id: 'vehicle', label: 'Vehicle history' }
      ]} active={tab} onChange={t => { setTab(t); if (t === 'history' && !hist) loadHist(); }} />

      {tab === 'active' && (
        <div className="card">
          <div className="row-inline">
            <input className="input" placeholder="Search reg / ticket / phone…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadActive()} />
            <button className="btn btn-sm" onClick={() => loadActive()}>Search</button>
          </div>
          {!active && <CenterSpin />}
          {active && active.data.length === 0 && <Empty title="No vehicles parked" />}
          {active && active.data.length > 0 && (
            <><table className="table table-cards"><thead><tr><th>Vehicle</th><th>Customer</th><th>Category</th><th>Bay</th><th>Entry</th><th>Status</th></tr></thead>
              <tbody>{active.data.map(row)}</tbody></table>
              <Pagination page={active.page} totalPages={active.totalPages} total={active.total} onPage={loadActive} /></>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="card">
          <div className="filters">
            <input className="input" placeholder="Search…" value={hq} onChange={e => setHq(e.target.value)} />
            <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All statuses</option><option value="active">Active</option><option value="exited">Exited</option><option value="voided">Voided</option>
            </select>
            <select className="input" value={catId} onChange={e => setCatId(e.target.value)}>
              <option value="">All categories</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
            <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
            <button className="btn btn-sm" onClick={() => loadHist()}>Apply</button>
          </div>
          {!hist && <CenterSpin />}
          {hist && hist.data.length === 0 && <Empty title="No sessions found" />}
          {hist && hist.data.length > 0 && (
            <><table className="table table-cards"><thead><tr><th>Vehicle</th><th>Customer</th><th>Category</th><th>Bay</th><th>Entry</th><th>Status</th></tr></thead>
              <tbody>{hist.data.map(row)}</tbody></table>
              <Pagination page={hist.page} totalPages={hist.totalPages} total={hist.total} onPage={loadHist} /></>
          )}
        </div>
      )}

      {tab === 'vehicle' && (
        <div className="card">
          <div className="row-inline">
            <input className="input input-lg reg-input" placeholder="Registration e.g. KAA 123A" value={vhReg}
              onChange={e => setVhReg(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && vehicleHistory()} />
            <button className="btn btn-primary" onClick={vehicleHistory}>Look up</button>
          </div>
          {vh && (
            <div style={{ marginTop: 16 }}>
              <div className="stat-grid">
                <div className="stat"><div className="stat-label">Visits</div><div className="stat-value">{vh.stats.visits}</div></div>
                <div className="stat"><div className="stat-label">Total paid</div><div className="stat-value">{fmtMoney(vh.stats.total_paid, cur)}</div></div>
                <div className="stat"><div className="stat-label">Complimentary</div><div className="stat-value">{vh.stats.complimentary}</div></div>
                <div className="stat"><div className="stat-label">Discounts</div><div className="stat-value">{fmtMoney(vh.stats.discounts, cur)}</div></div>
                <div className="stat"><div className="stat-label">Last visit</div><div className="stat-value" style={{ fontSize: 16 }}>{fmtDT(vh.stats.last_visit)}</div></div>
              </div>
              {vh.subscriptions.length > 0 && <>
                <h4>Monthly subscriptions</h4>
                <table className="table table-sm"><thead><tr><th>Package</th><th>Period</th><th>Status</th></tr></thead>
                  <tbody>{vh.subscriptions.map((s: any) => <tr key={s.id}><td>{s.package_name}</td><td>{s.start_date} → {s.expiry_date}</td><td data-l="Status"><Badge tone={statusTone(s.status)}>{s.status}</Badge></td></tr>)}</tbody></table>
              </>}
              <h4>Visits</h4>
              <table className="table table-sm"><thead><tr><th>Ticket</th><th>Entry</th><th>Exit</th><th>Category</th><th>Paid</th></tr></thead>
                <tbody>{vh.sessions.map((s: any) => (
                  <tr key={s.id} onClick={() => setSel(s.id)} style={{ cursor: 'pointer' }}>
                    <td>{s.ticket_no}</td><td data-l="Entry">{fmtDT(s.entry_time)}</td><td>{fmtDT(s.exit_time)}</td>
                    <td data-l="Category">{s.category_name}</td><td>{fmtMoney(s.amount_paid, cur)}</td>
                  </tr>
                ))}</tbody></table>
            </div>
          )}
        </div>
      )}

      {sel && <SessionModal id={sel} onClose={() => setSel(null)} onChanged={() => { loadActive(); if (hist) loadHist(); }} />}
    </div>
  );
}
