import React, { useEffect, useState } from 'react';
import { get, mutate, listOutbox, onOutboxChange, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, CenterSpin, statusTone } from '../ui';
import { PrintSheet, TicketPrint } from '../print';
import { useSettings } from '../components/Layout';
import type { Category, Space, Session } from '../types';

const VTYPES = ['Saloon', 'SUV', 'Pickup', 'Van', 'Truck', 'Motorcycle', 'Other'];
const COMP_CATS = ['accommodation', 'restaurant', 'bar', 'conference', 'staff', 'management', 'vip', 'authorized', 'official'];

export default function Entry() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const [cats, setCats] = useState<Category[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [occ, setOcc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [printed, setPrinted] = useState<Session | null>(null);
  const [active, setActive] = useState<Session[]>([]);
  const [q, setQ] = useState('');
  const [regInfo, setRegInfo] = useState<any>(null);
  const [pending, setPending] = useState(listOutbox().filter(i => i.path === '/api/sessions/entry'));

  const [ticket, setTicket] = useState<Session | null>(null);
  const [f, setF] = useState({
    registration: '', vehicle_type: 'Saloon', vehicle_make: '', vehicle_model: '', vehicle_color: '',
    customer_name: '', phone: '',
    category_id: '', space_id: '', notes: '', override: false, entry_time: '',
    comp_category: 'restaurant', comp_authorized_by: '', comp_reason: '', comp_reference: ''
  });
  const set = (k: string, v: any) => setF(s => ({ ...s, [k]: v }));

  const load = async () => {
    try {
      const [c, sp, a] = await Promise.all([
        get<{ data: Category[] }>('/api/categories'),
        get<{ data: Space[]; occupancy: any }>('/api/spaces'),
        get<{ data: Session[] }>('/api/sessions/active?pageSize=15')
      ]);
      setCats(c.data.filter(x => x.active === 1));
      setSpaces(sp.data);
      setOcc(sp.occupancy);
      setActive(a.data);
      if (!f.category_id) {
        const d = c.data.find(x => x.code === 'daily');
        if (d) setF(s => ({ ...s, category_id: String(d.id) }));
      }
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    return onOutboxChange(() => setPending(listOutbox().filter(i => i.path === '/api/sessions/entry')));
  }, []);

  const selCat = cats.find(c => String(c.id) === f.category_id);
  const isComp = selCat?.kind === 'complimentary';
  const canComp = has('complimentary.authorize');
  const canOverride = has('sessions.override');

  const checkReg = async (reg: string) => {
    const clean = reg.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length < 2) { setRegInfo(null); return; }
    try {
      const r = await get<any>(`/api/vehicles/history?registration=${clean}`);
      const activeNow = r.data.sessions.find((s: any) => s.status === 'active');
      const sub = r.data.subscriptions.find((s: any) => s.status === 'active');
      setRegInfo({ activeNow, sub, stats: r.data.stats });
    } catch { setRegInfo(null); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isComp && !canComp) { toast('Complimentary parking needs a supervisor/manager to authorize', 'err'); return; }
    setBusy(true);
    try {
      const body: any = {
        registration: f.registration, vehicle_type: f.vehicle_type,
        vehicle_make: f.vehicle_make, vehicle_model: f.vehicle_model, vehicle_color: f.vehicle_color,
        customer_name: f.customer_name, phone: f.phone,
        category_id: Number(f.category_id), notes: f.notes,
        space_id: f.space_id ? Number(f.space_id) : null,
        override: canOverride && f.override
      };
      if (isComp) body.comp = {
        comp_category: f.comp_category, authorized_by: f.comp_authorized_by,
        reason: f.comp_reason, reference: f.comp_reference
      };
      if (canOverride && f.override && f.entry_time) body.entry_time = new Date(f.entry_time).toISOString();
      const r: any = await mutate('POST', '/api/sessions/entry', body, `Entry ${f.registration}`);
      if (r._queued) {
        toast('Offline - entry saved to outbox (pending sync)', 'warn');
      } else {
        toast(`Ticket ${r.data.ticket_no} issued`, 'ok');
        setTicket(r.data);
        setF(s => ({ ...s, registration: '', vehicle_make: '', vehicle_model: '', vehicle_color: '', customer_name: '', phone: '', notes: '', space_id: '', override: false, entry_time: '' }));
        setRegInfo(null);
      }
      load();
    } catch (err: any) { toast(errMsg(err), 'err'); }
    finally { setBusy(false); }
  };

  const searchActive = async () => {
    try {
      const r = await get<{ data: Session[] }>(`/api/sessions/active?q=${encodeURIComponent(q)}&pageSize=15`);
      setActive(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  if (loading) return <CenterSpin />;

  return (
    <div className="page gate">
      <div className="page-head">
        <h2>Vehicle Entry</h2>
        {occ && <span className="chip chip-ok">🅿️ {occ.available} bays free of {occ.total}</span>}
      </div>

      <div className="grid-entry">
        <form onSubmit={submit} className="card form-card">
          <div className="form-grid">
            <Field label="Registration number *">
              <input className="input input-lg reg-input" value={f.registration}
                onChange={e => set('registration', e.target.value.toUpperCase())}
                onBlur={e => checkReg(e.target.value)} placeholder="KAA 123A" required autoFocus />
            </Field>
            <Field label="Vehicle type">
              <select className="input input-lg" value={f.vehicle_type} onChange={e => set('vehicle_type', e.target.value)}>
                {VTYPES.map(v => <option key={v}>{v}</option>)}
              </select>
            </Field>
          </div>

          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            <Field label="Make"><input className="input" value={f.vehicle_make} onChange={e => set('vehicle_make', e.target.value)} placeholder="e.g. Toyota" /></Field>
            <Field label="Model"><input className="input" value={f.vehicle_model} onChange={e => set('vehicle_model', e.target.value)} placeholder="e.g. Corolla" /></Field>
            <Field label="Color"><input className="input" value={f.vehicle_color} onChange={e => set('vehicle_color', e.target.value)} placeholder="e.g. Silver" /></Field>
          </div>

          {regInfo?.activeNow && (
            <div className="alert alert-err">⚠️ Already parked: ticket {regInfo.activeNow.ticket_no} (bay {regInfo.activeNow.space_code || '-'}). Override required.</div>
          )}
          {regInfo?.sub && (
            <div className="alert alert-ok">📅 Monthly active: {regInfo.sub.package_name}, expires {regInfo.sub.expiry_date}. No daily charge.</div>
          )}

          <div className="form-grid">
            <Field label="Driver / customer name">
              <input className="input input-lg" value={f.customer_name} onChange={e => set('customer_name', e.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Phone">
              <input className="input input-lg" value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="07xx…" />
            </Field>
          </div>

          <div className="form-grid">
            <Field label="Parking category *">
              <select className="input input-lg" value={f.category_id} onChange={e => set('category_id', e.target.value)} required>
                <option value="">Select…</option>
                <optgroup label="Paid">
                  {cats.filter(c => c.kind === 'paid').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
                <optgroup label="Complimentary">
                  {cats.filter(c => c.kind === 'complimentary').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              </select>
            </Field>
            <Field label="Bay (auto-assign recommended)">
              <select className="input input-lg" value={f.space_id} onChange={e => set('space_id', e.target.value)}>
                <option value="">Auto-assign</option>
                {spaces.filter(s => s.status === 'available').map(s => (
                  <option key={s.id} value={s.id}>{s.code} · Zone {s.zone} · {s.space_type}</option>
                ))}
                {spaces.filter(s => s.status === 'reserved').map(s => (
                  <option key={s.id} value={s.id}>{s.code} · RESERVED ⚠️</option>
                ))}
              </select>
            </Field>
          </div>

          {isComp && (
            <div className="comp-box">
              <h4>Complimentary authorization {!canComp && <Badge tone="err">NOT AUTHORIZED</Badge>}</h4>
              {!canComp && <div className="alert alert-err">Your role cannot authorize complimentary parking. Ask a supervisor/manager.</div>}
              <div className="form-grid">
                <Field label="Comp category *">
                  <select className="input" value={f.comp_category} onChange={e => set('comp_category', e.target.value)}>
                    {COMP_CATS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Authorized by *">
                  <input className="input" value={f.comp_authorized_by} onChange={e => set('comp_authorized_by', e.target.value)} placeholder="e.g. Duty Manager" />
                </Field>
              </div>
              <div className="form-grid">
                <Field label="Reason / reference">
                  <input className="input" value={f.comp_reason} onChange={e => set('comp_reason', e.target.value)} placeholder="Reason" />
                </Field>
                <Field label="Reference (room/bill no.)">
                  <input className="input" value={f.comp_reference} onChange={e => set('comp_reference', e.target.value)} />
                </Field>
              </div>
            </div>
          )}

          <Field label="Notes">
            <input className="input" value={f.notes} onChange={e => set('notes', e.target.value)} placeholder="Optional notes" />
          </Field>

          {canOverride && (
            <div className="override-box">
              <label className="check"><input type="checkbox" checked={f.override} onChange={e => set('override', e.target.checked)} /> Supervisor override (duplicate / no bay / backdate)</label>
              {f.override && (
                <Field label="Entry time (backdate, optional)" hint="Leave blank for now">
                  <input type="datetime-local" className="input" value={f.entry_time} onChange={e => set('entry_time', e.target.value)} />
                </Field>
              )}
            </div>
          )}

          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? 'Issuing…' : '🎫 Issue ticket'}
          </button>
        </form>

        <div>
          {pending.length > 0 && (
            <div className="card">
              <h3>📤 Pending sync ({pending.length})</h3>
              {pending.map(p => (
                <div key={p.id} className="pending-row">
                  <span>{p.label}</span>
                  <Badge tone="warn">Pending sync</Badge>
                </div>
              ))}
              <p className="muted">These entries are NOT yet stored. Sync from the top bar when online.</p>
            </div>
          )}
          <div className="card">
            <h3>Currently parked</h3>
            <div className="row-inline">
              <input className="input" placeholder="Search reg / ticket…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchActive()} />
              <button className="btn btn-sm" onClick={searchActive}>Search</button>
            </div>
            {active.length === 0 && <Empty title="No vehicles parked" />}
            <table className="table table-sm">
              <tbody>
                {active.map(s => (
                  <tr key={s.id}>
                    <td><b>{s.registration}</b><div className="muted">{s.ticket_no}</div></td>
                    <td>{s.space_code || '-'}<div className="muted">{fmtDT(s.entry_time)}</div></td>
                    <td><Badge tone={statusTone(s.category_code === 'monthly' ? 'monthly' : s.category_kind || '')}>{s.category_name}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {ticket && (
        <Modal title="Ticket created" onClose={() => setTicket(null)}>
          <div className="ticket-no">{ticket.ticket_no}</div>
          <table className="kv"><tbody>
            <tr><td>Registration</td><td><b>{ticket.registration}</b></td></tr>
            <tr><td>Category</td><td>{(ticket as any).category_name || ''}</td></tr>
            <tr><td>Bay</td><td>{(ticket as any).space_code ? `${(ticket as any).space_code} · Zone ${(ticket as any).space_zone || ''}` : 'Auto-assigned at gate'}</td></tr>
            <tr><td>Entry time</td><td>{fmtDT(ticket.entry_time)}</td></tr>
          </tbody></table>
          <div className="btn-row">
            {settings && <button className="btn btn-primary" onClick={() => { setPrinted(ticket); }}>🖨️ Print ticket</button>}
            <button className="btn" onClick={() => setTicket(null)}>New entry</button>
          </div>
        </Modal>
      )}

      {printed && settings && (
        <PrintSheet title={`Ticket ${printed.ticket_no}`} onClose={() => setPrinted(null)}>
          <TicketPrint s={printed} settings={settings} />
        </PrintSheet>
      )}
    </div>
  );
}
