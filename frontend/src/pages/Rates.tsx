import React, { useEffect, useState } from 'react';
import { get, put, fmtMoney, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, CenterSpin, Money } from '../ui';
import { useSettings } from '../components/Layout';
import type { RateRow } from '../types';

export default function Rates() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const canManage = has('settings.manage');
  const [rows, setRows] = useState<RateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<RateRow | null>(null);
  const [f, setF] = useState({ hourly_rate: '', daily_rate: '', max_charge: '', grace_minutes: '' });

  const load = async () => {
    setLoading(true);
    try { setRows((await get<{ data: RateRow[] }>('/api/rates')).data); }
    catch (e: any) { toast(errMsg(e), 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const openEdit = (r: RateRow) => {
    setEdit(r);
    setF({ hourly_rate: '', daily_rate: '', max_charge: '', grace_minutes: '' });
  };
  const save = async () => {
    if (!edit) return;
    try {
      // Empty = keep current value (use Clear to fall back to hotel defaults).
      const body: any = {};
      if (f.hourly_rate !== '') body.hourly_rate = Number(f.hourly_rate);
      if (f.daily_rate !== '') body.daily_rate = Number(f.daily_rate);
      if (f.max_charge !== '') body.max_charge = Number(f.max_charge);
      if (f.grace_minutes !== '') body.grace_minutes = Number(f.grace_minutes);
      await put(`/api/categories/${edit.id}`, body);
      toast('Rates updated', 'ok');
      setEdit(null);
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const clearAll = async () => {
    if (!edit) return;
    try {
      await put(`/api/categories/${edit.id}`, { hourly_rate: null, daily_rate: null, max_charge: null, grace_minutes: null });
      toast('Cleared — hotel defaults apply', 'ok');
      setEdit(null);
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  return (
    <div>
      <div className="page-head"><h2>Rates</h2></div>
      {loading ? <div className="card"><CenterSpin /></div> : rows.length === 0 ? <div className="card"><Empty title="No categories" hint="" /></div> : (
        <div className="rate-grid">
          {rows.map(r => (
            <div className={'card rate-card' + (r.kind === 'complimentary' ? ' comp' : '')} key={r.id}>
              <h3>{r.name} {r.active ? null : <Badge tone="muted">inactive</Badge>}</h3>
              {r.kind === 'complimentary' ? (
                <p className="muted">Complimentary — always free{'\n'}<br />Grace: {r.grace_minutes} min</p>
              ) : (<>
                <div className="rate-big"><Money value={r.code === 'hourly' ? r.hourly_rate : r.daily_rate} cur={cur} /><span className="muted" style={{ fontSize: 13 }}> /{r.code === 'hourly' ? 'hr' : r.code === 'monthly' ? 'visit' : 'day'}</span></div>
                <div className="member-rows">
                  <div className="mr"><span>Hourly</span><b><Money value={r.hourly_rate} cur={cur} />{r.overridden.hourly ? ' *' : ''}</b></div>
                  <div className="mr"><span>Daily</span><b><Money value={r.daily_rate} cur={cur} />{r.overridden.daily ? ' *' : ''}</b></div>
                  <div className="mr"><span>Max cap</span><b>{r.max_charge != null ? fmtMoney(r.max_charge, cur) + ' *' : '—'}</b></div>
                  <div className="mr"><span>Grace</span><b>{r.grace_minutes} min{r.overridden.grace ? ' *' : ''}</b></div>
                </div>
              </>)}
              {canManage && <button className="btn btn-sm" onClick={() => openEdit(r)}>Edit rates</button>}
            </div>
          ))}
        </div>
      )}
      <p className="muted">* = per-category override. Without an override the hotel default from Settings applies.</p>

      {edit && (
        <Modal title={`Rates — ${edit.name}`} onClose={() => setEdit(null)}>
          <p className="muted">Current effective: {fmtMoney(edit.daily_rate, cur)}/day · {fmtMoney(edit.hourly_rate, cur)}/hr · cap {edit.max_charge != null ? fmtMoney(edit.max_charge, cur) : '—'} · grace {edit.grace_minutes} min. Leave a field empty to keep it.</p>
          <div className="form-grid">
            <Field label="Hourly rate"><input type="number" min="0" step="any" className="input" value={f.hourly_rate} onChange={e => setF({ ...f, hourly_rate: e.target.value })} /></Field>
            <Field label="Daily rate"><input type="number" min="0" step="any" className="input" value={f.daily_rate} onChange={e => setF({ ...f, daily_rate: e.target.value })} /></Field>
            <Field label="Max charge cap (0/empty = none)"><input type="number" min="0" step="any" className="input" value={f.max_charge} onChange={e => setF({ ...f, max_charge: e.target.value })} /></Field>
            <Field label="Grace minutes"><input type="number" min="0" max="1440" step="1" className="input" value={f.grace_minutes} onChange={e => setF({ ...f, grace_minutes: e.target.value })} /></Field>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={save}>Save</button>
            <button className="btn" onClick={clearAll}>Clear overrides</button>
            <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
