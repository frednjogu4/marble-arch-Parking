import React, { useEffect, useState } from 'react';
import { get, post, put, todayStr, fmtMoney, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Tabs, CenterSpin, statusTone } from '../ui';
import { useSettings } from '../components/Layout';

export default function Promotions() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [tab, setTab] = useState('discounts');
  const [promos, setPromos] = useState<any[]>([]);
  const [discounts, setDiscounts] = useState<any[]>([]);
  const [comp, setComp] = useState<any[]>([]);
  const [byCat, setByCat] = useState<any[]>([]);
  const [dStatus, setDStatus] = useState('pending');
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [showPromo, setShowPromo] = useState(false);
  const [pEdit, setPEdit] = useState<any>(null);
  const [pf, setPf] = useState({ name: '', kind: 'percentage', value: '', active: true, valid_from: '', valid_to: '' });

  const loadPromos = async () => {
    try {
      const r = await get<any>('/api/promotions');
      setPromos(r.data);
    } catch {}
  };
  const loadDiscounts = async () => {
    try {
      const r = await get<any>(`/api/discounts?status=${dStatus === 'all' ? '' : dStatus}&pageSize=100`);
      setDiscounts(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const loadComp = async () => {
    try {
      const r = await get<any>(`/api/complimentary?from=${from}&to=${to}&pageSize=100`);
      setComp(r.data);
      setByCat(r.by_category || []);
    } catch {}
  };

  useEffect(() => { loadPromos(); loadDiscounts(); loadComp(); }, []);

  const openPromo = (p?: any) => {
    setPEdit(p || null);
    setPf(p ? { name: p.name, kind: p.kind, value: String(p.value), active: !!p.active, valid_from: p.valid_from || '', valid_to: p.valid_to || '' }
      : { name: '', kind: 'percentage', value: '', active: true, valid_from: '', valid_to: '' });
    setShowPromo(true);
  };

  const savePromo = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { name: pf.name, kind: pf.kind, value: Number(pf.value) || 0, active: pf.active ? 1 : 0, valid_from: pf.valid_from, valid_to: pf.valid_to };
      if (pEdit) await put(`/api/promotions/${pEdit.id}`, body);
      else await post('/api/promotions', body);
      toast('Promotion saved', 'ok');
      setShowPromo(false);
      loadPromos();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const decide = async (id: number, decision: string) => {
    try {
      await post(`/api/discounts/${id}/decision`, { decision });
      toast(`Discount ${decision}`, decision === 'approved' ? 'ok' : 'info');
      loadDiscounts();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  return (
    <div className="page">
      <div className="page-head"><h2>Promotions & Discounts</h2>
        {tab === 'promos' && has('promotions.manage') && <button className="btn btn-primary btn-sm" onClick={() => openPromo()}>＋ Promotion</button>}
      </div>
      <Tabs tabs={[
        { id: 'discounts', label: `Discounts (${discounts.filter(d => d.status === 'pending').length} pending)` },
        { id: 'promos', label: 'Promotions' },
        { id: 'comp', label: 'Complimentary' }
      ]} active={tab} onChange={setTab} />

      {tab === 'discounts' && (
        <div className="card">
          <div className="filters">
            <select className="input" value={dStatus} onChange={e => setDStatus(e.target.value)}>
              <option value="pending">Pending approval</option><option value="approved">Approved</option><option value="applied">Applied</option><option value="rejected">Rejected</option><option value="all">All</option>
            </select>
            <button className="btn btn-sm" onClick={loadDiscounts}>Apply</button>
          </div>
          {discounts.length === 0 && <Empty title="No discounts" />}
          {discounts.length > 0 && (
            <table className="table table-sm"><thead><tr><th>Time</th><th>Ticket</th><th>Original</th><th>Discount</th><th>Final</th><th>Reason</th><th>By</th><th>Status</th><th></th></tr></thead>
              <tbody>{discounts.map(d => (
                <tr key={d.id}>
                  <td>{fmtDT(d.created_at)}</td><td>{d.ticket_no}<div className="muted">{d.registration}</div></td>
                  <td>{fmtMoney(d.original_amount, cur)}</td><td><b>{fmtMoney(d.discount_amount, cur)}</b></td><td>{fmtMoney(d.final_amount, cur)}</td>
                  <td>{d.reason}</td><td>{d.applied_by_name}</td>
                  <td><Badge tone={statusTone(d.status)}>{d.status}</Badge></td>
                  <td className="actions">
                    {d.status === 'pending' && has('discounts.approve') && <>
                      <button className="btn btn-sm" onClick={() => decide(d.id, 'approved')}>Approve</button>
                      <button className="btn btn-sm" onClick={() => decide(d.id, 'rejected')}>Reject</button>
                    </>}
                  </td>
                </tr>
              ))}</tbody></table>
          )}
        </div>
      )}

      {tab === 'promos' && (
        <div className="card">
          {promos.length === 0 && <Empty title="No promotions" />}
          {promos.length > 0 && (
            <table className="table table-sm"><thead><tr><th>Name</th><th>Kind</th><th>Value</th><th>Valid</th><th>Status</th><th></th></tr></thead>
              <tbody>{promos.map(p => (
                <tr key={p.id}>
                  <td><b>{p.name}</b></td><td>{p.kind}</td>
                  <td>{p.kind === 'percentage' ? `${p.value}%` : p.kind === 'fixed' ? fmtMoney(p.value, cur) : p.kind === 'free' ? 'Free' : '-'}</td>
                  <td className="muted">{p.valid_from || '…'} → {p.valid_to || '…'}</td>
                  <td><Badge tone={p.active ? 'ok' : 'muted'}>{p.active ? 'active' : 'inactive'}</Badge></td>
                  <td>{has('promotions.manage') && <button className="btn btn-sm" onClick={() => openPromo(p)}>Edit</button>}</td>
                </tr>
              ))}</tbody></table>
          )}
        </div>
      )}

      {tab === 'comp' && (
        <div className="card">
          <div className="filters">
            <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
            <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
            <button className="btn btn-sm" onClick={loadComp}>Apply</button>
          </div>
          <div className="stat-grid stat-grid-sm">
            {byCat.map(c => <div key={c.comp_category} className="stat"><div className="stat-label">{c.comp_category}</div><div className="stat-value">{c.n}</div></div>)}
            <div className="stat stat-ok"><div className="stat-label">Revenue impact</div><div className="stat-value" style={{ fontSize: 16 }}>{fmtMoney(0, cur)}</div><div className="stat-sub">complimentary = no revenue, counts in occupancy</div></div>
          </div>
          {comp.length === 0 && <Empty title="No complimentary records" />}
          {comp.length > 0 && (
            <table className="table table-sm"><thead><tr><th>Time</th><th>Ticket</th><th>Reg</th><th>Category</th><th>Authorized by</th><th>Reason</th><th>Recorded by</th></tr></thead>
              <tbody>{comp.map(c => (
                <tr key={c.id}><td>{fmtDT(c.created_at)}</td><td>{c.ticket_no}</td><td>{c.registration}</td><td>{c.comp_category}</td><td>{c.authorized_by}</td><td>{c.reason}</td><td>{c.recorded_by_name}</td></tr>
              ))}</tbody></table>
          )}
        </div>
      )}

      {showPromo && (
        <Modal title={pEdit ? 'Edit promotion' : 'New promotion'} onClose={() => setShowPromo(false)}>
          <form onSubmit={savePromo} className="form">
            <Field label="Name *"><input className="input" value={pf.name} onChange={e => setPf({ ...pf, name: e.target.value })} required /></Field>
            <div className="form-grid">
              <Field label="Kind"><select className="input" value={pf.kind} onChange={e => setPf({ ...pf, kind: e.target.value })}>
                <option value="percentage">Percentage</option><option value="fixed">Fixed amount</option><option value="free">Free parking</option>
                <option value="time_based">Time-based</option><option value="event">Event</option><option value="guest">Hotel guest</option>
              </select></Field>
              <Field label="Value (% or amount)"><input type="number" className="input" value={pf.value} onChange={e => setPf({ ...pf, value: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Valid from"><input type="date" className="input" value={pf.valid_from} onChange={e => setPf({ ...pf, valid_from: e.target.value })} /></Field>
              <Field label="Valid to"><input type="date" className="input" value={pf.valid_to} onChange={e => setPf({ ...pf, valid_to: e.target.value })} /></Field>
            </div>
            <label className="check"><input type="checkbox" checked={pf.active} onChange={e => setPf({ ...pf, active: e.target.checked })} /> Active</label>
            <button className="btn btn-primary">Save</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
