import React, { useEffect, useState } from 'react';
import { get, post, put, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Modal, CenterSpin } from '../ui';
import { TicketPrint, ThermalReceipt } from '../print';
import type { HotelSettings } from '../types';

export default function Settings() {
  const { has } = useAuth();
  const toast = useToast();
  const [s, setS] = useState<HotelSettings | null>(null);
  const [f, setF] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [cats, setCats] = useState<any[]>([]);
  const [showCat, setShowCat] = useState(false);
  const [cf, setCf] = useState({ code: '', name: '', kind: 'paid', description: '' });

  const load = async () => {
    try {
      const r = await get<{ data: HotelSettings }>('/api/settings');
      setS(r.data);
      setF({ ...r.data });
      const c = await get<any>('/api/categories');
      setCats(c.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  useEffect(() => { load(); }, []);

  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));

  const onLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { toast('Logo must be under 500KB', 'err'); return; }
    const rd = new FileReader();
    rd.onload = () => set('logo_data', rd.result as string);
    rd.readAsDataURL(file);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (Number(f.total_spaces) !== Number(s?.total_spaces) && !confirm(`Change bays from ${s?.total_spaces} to ${f.total_spaces}? Shrinking removes free bays permanently.`)) return;
    setBusy(true);
    try {
      const r = await put<{ data: HotelSettings }>('/api/settings', {
        ...f,
        daily_rate: Number(f.daily_rate), hourly_rate: Number(f.hourly_rate),
        hourly_enabled: f.hourly_enabled ? 1 : 0,
        grace_period_minutes: Number(f.grace_period_minutes),
        lost_ticket_fee: Number((f as any).lost_ticket_fee),
        total_spaces: Number(f.total_spaces)
      });
      setS(r.data);
      setF({ ...r.data });
      window.dispatchEvent(new Event('ma:settings'));
      toast('Settings saved', 'ok');
    } catch (err: any) { toast(errMsg(err), 'err'); }
    finally { setBusy(false); }
  };

  const saveCat = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/categories', cf);
      toast('Category created', 'ok');
      setShowCat(false);
      setCf({ code: '', name: '', kind: 'paid', description: '' });
      load();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const toggleCat = async (c: any) => {
    try {
      await put(`/api/categories/${c.id}`, { active: c.active ? 0 : 1 });
      load();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  if (!s) return <CenterSpin />;
  const canEdit = has('settings.manage');
  const ro = !canEdit;

  return (
    <div className="page">
      <div className="page-head"><h2>Hotel Settings</h2></div>
      {!canEdit && <div className="alert alert-warn">Read-only - you need administrator permission to change settings.</div>}
      <div className="grid-2">
        <form onSubmit={save} className="card form">
          <h3>Hotel identity</h3>
          <Field label="Hotel name"><input className="input" value={f.hotel_name || ''} onChange={e => set('hotel_name', e.target.value)} disabled={ro} /></Field>
          <Field label="Logo (PNG/JPG, max 500KB)">
            <input type="file" accept="image/*" onChange={onLogo} disabled={ro} />
            {f.logo_data && <img src={f.logo_data} alt="logo" className="logo-preview" />}
          </Field>
          <Field label="Address"><input className="input" value={f.address || ''} onChange={e => set('address', e.target.value)} disabled={ro} /></Field>
          <div className="form-grid">
            <Field label="Phone(s)"><input className="input" value={f.phones || ''} onChange={e => set('phones', e.target.value)} disabled={ro} /></Field>
            <Field label="Email"><input className="input" value={f.email || ''} onChange={e => set('email', e.target.value)} disabled={ro} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Website"><input className="input" value={f.website || ''} onChange={e => set('website', e.target.value)} disabled={ro} /></Field>
            <Field label="Registration / company details"><input className="input" value={f.registration_details || ''} onChange={e => set('registration_details', e.target.value)} disabled={ro} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Facebook"><input className="input" value={f.social_facebook || ''} onChange={e => set('social_facebook', e.target.value)} disabled={ro} /></Field>
            <Field label="Twitter / X"><input className="input" value={f.social_twitter || ''} onChange={e => set('social_twitter', e.target.value)} disabled={ro} /></Field>
          </div>
          <Field label="Instagram"><input className="input" value={f.social_instagram || ''} onChange={e => set('social_instagram', e.target.value)} disabled={ro} /></Field>

          <h3>Parking operation</h3>
          <div className="form-grid">
            <Field label="Department"><input className="input" value={f.parking_department || ''} onChange={e => set('parking_department', e.target.value)} disabled={ro} /></Field>
            <Field label="Location"><input className="input" value={f.parking_location || ''} onChange={e => set('parking_location', e.target.value)} disabled={ro} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Total bays"><input type="number" className="input" value={f.total_spaces ?? ''} onChange={e => set('total_spaces', e.target.value)} disabled={ro} /></Field>
            <Field label="Currency"><input className="input" value={f.currency || ''} onChange={e => set('currency', e.target.value)} disabled={ro} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Daily rate"><input type="number" className="input" value={f.daily_rate ?? ''} onChange={e => set('daily_rate', e.target.value)} disabled={ro} /></Field>
            <Field label="Grace period (minutes)"><input type="number" className="input" value={f.grace_period_minutes ?? ''} onChange={e => set('grace_period_minutes', e.target.value)} disabled={ro} /></Field>
            <Field label="Lost ticket fee" hint="Flat fee charged when a ticket is lost."><input type="number" className="input" value={(f as any).lost_ticket_fee ?? ''} onChange={e => set('lost_ticket_fee', e.target.value)} disabled={ro} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={!!f.hourly_enabled} onChange={e => set('hourly_enabled', e.target.checked ? 1 : 0)} disabled={ro} /> Enable hourly billing</label>
          {f.hourly_enabled ? <Field label="Hourly rate"><input type="number" className="input" value={f.hourly_rate ?? ''} onChange={e => set('hourly_rate', e.target.value)} disabled={ro} /></Field> : null}

          <h3>Receipts & terms</h3>
          <Field label="Receipt header (printed under hotel name)"><input className="input" value={f.receipt_header || ''} onChange={e => set('receipt_header', e.target.value)} disabled={ro} /></Field>
          <Field label="Receipt footer"><input className="input" value={f.receipt_footer || ''} onChange={e => set('receipt_footer', e.target.value)} disabled={ro} /></Field>
          <Field label="Terms & conditions (printed on tickets)"><textarea className="input" rows={3} value={f.terms || ''} onChange={e => set('terms', e.target.value)} disabled={ro} /></Field>

          {canEdit && <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>}
        </form>

        <div>
          <div className="card">
            <h3>Ticket preview</h3>
            <TicketPrint s={{ ticket_no: 'MA-00000000-0000', registration: 'KAA 123A', space_code: 'P-001', category_name: 'Daily Customer', customer_name: 'Sample Guest', entry_time: new Date().toISOString() } as any} settings={f} />
          </div>
          <div className="card">
            <h3>Receipt preview (live)</h3>
            <ThermalReceipt s={{ ticket_no: 'MA-00000000-0000', registration: 'KAA 123A', space_code: 'P-001', category_name: 'Daily Customer', entry_time: new Date(Date.now() - 3 * 3600e3).toISOString(), exit_time: new Date().toISOString(), base_amount: 400, discount_amount: 0, amount_paid: 400 } as any} quote={{ minutes: 180, base: 400, discount: 0, paid: 400 } as any} payments={[{ id: 1, method: 'cash', amount: 400, reference: '' } as any]} settings={f} cashier="Sample Cashier" />
          </div>
          <div className="card">
            <div className="page-head"><h3>Parking categories</h3>
              {canEdit && <button className="btn btn-sm" onClick={() => setShowCat(true)}>＋ Category</button>}
            </div>
            <table className="table table-sm"><thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Active</th><th></th></tr></thead>
              <tbody>{cats.map(c => (
                <tr key={c.id}><td>{c.code}</td><td>{c.name}</td><td><Badge tone={c.kind === 'paid' ? 'ok' : 'info'}>{c.kind}</Badge></td>
                  <td>{c.active ? 'yes' : 'no'}</td>
                  <td>{canEdit && <button className="btn btn-sm" onClick={() => toggleCat(c)}>{c.active ? 'Disable' : 'Enable'}</button>}</td></tr>
              ))}</tbody></table>
          </div>
        </div>
      </div>

      {showCat && (
        <Modal title="New category" onClose={() => setShowCat(false)}>
          <form onSubmit={saveCat} className="form">
            <div className="form-grid">
              <Field label="Code *"><input className="input" value={cf.code} onChange={e => setCf({ ...cf, code: e.target.value.toLowerCase() })} required /></Field>
              <Field label="Kind"><select className="input" value={cf.kind} onChange={e => setCf({ ...cf, kind: e.target.value })}><option value="paid">Paid</option><option value="complimentary">Complimentary</option></select></Field>
            </div>
            <Field label="Name *"><input className="input" value={cf.name} onChange={e => setCf({ ...cf, name: e.target.value })} required /></Field>
            <Field label="Description"><input className="input" value={cf.description} onChange={e => setCf({ ...cf, description: e.target.value })} /></Field>
            <button className="btn btn-primary">Create</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
