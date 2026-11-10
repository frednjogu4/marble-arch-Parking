import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, put, del, fmtMoney, fmtD, todayStr, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Tabs, Pagination, CenterSpin, statusTone } from '../ui';
import { PrintSheet, DocHead } from '../print';
import { useSettings } from '../components/Layout';
import type { Page, Subscription, MPackage } from '../types';

const VTYPES = ['Saloon', 'SUV', 'Pickup', 'Van', 'Truck', 'Motorcycle', 'Other'];

export default function Monthly() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [params] = useSearchParams();
  const [tab, setTab] = useState('subs');
  const [subs, setSubs] = useState<Page<Subscription> | null>(null);
  const [pkgs, setPkgs] = useState<MPackage[]>([]);
  const [q, setQ] = useState(params.get('q') || '');
  const [status, setStatus] = useState('');
  const [expiring, setExpiring] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [renew, setRenew] = useState<any>(null);
  const [showPkg, setShowPkg] = useState(false);
  const [pkgEdit, setPkgEdit] = useState<any>(null);
  const [printSub, setPrintSub] = useState<any>(null);

  const [f, setF] = useState({
    customer_name: '', company: '', phone: '', email: '', registration: '', vehicle_type: 'Saloon',
    package_id: '', start_date: todayStr(), expiry_date: '', amount: '', payment_method: 'cash', payment_reference: ''
  });
  const [rf, setRf] = useState({ package_id: '', start_date: '', expiry_date: '', amount: '', payment_method: 'cash', payment_reference: '' });
  const [pf, setPf] = useState({ name: '', price: '', validity_days: '30', reserved_space: false, vehicle_limit: '1', benefits: '', active: true });

  const loadSubs = async (page = 1) => {
    try {
      setSubs(await get(`/api/monthly/subscriptions?q=${encodeURIComponent(q)}&status=${status}${expiring ? '&expiring_days=7' : ''}&page=${page}`));
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const loadPkgs = async () => {
    try {
      const r = await get<{ data: MPackage[] }>('/api/monthly/packages');
      setPkgs(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  useEffect(() => { loadSubs(); loadPkgs(); }, []);

  const selPkg = pkgs.find(p => String(p.id) === f.package_id);

  const openForm = () => {
    setF({ customer_name: '', company: '', phone: '', email: '', registration: '', vehicle_type: 'Saloon', package_id: pkgs[0] ? String(pkgs[0].id) : '', start_date: todayStr(), expiry_date: '', amount: '', payment_method: 'cash', payment_reference: '' });
    setShowForm(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body: any = { ...f, package_id: Number(f.package_id) };
      if (!body.expiry_date) delete body.expiry_date;
      if (body.amount === '') delete body.amount;
      await post('/api/monthly/subscriptions', body);
      toast('Subscription created', 'ok');
      setShowForm(false);
      loadSubs();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const openDetail = async (id: number) => {
    try {
      const r = await get<any>(`/api/monthly/subscriptions/${id}`);
      setDetail(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const openRenew = (s: any) => {
    setRenew(s);
    setRf({ package_id: String(s.package_id), start_date: '', expiry_date: '', amount: '', payment_method: 'cash', payment_reference: '' });
  };

  const doRenew = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body: any = { ...rf, package_id: Number(rf.package_id) };
      if (!body.start_date) delete body.start_date;
      if (!body.expiry_date) delete body.expiry_date;
      if (body.amount === '') delete body.amount;
      await post(`/api/monthly/subscriptions/${renew.id}/renew`, body);
      toast('Subscription renewed', 'ok');
      setRenew(null);
      setDetail(null);
      loadSubs();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const setSubStatus = async (id: number, st: string) => {
    if (!confirm(`Set subscription to ${st}?`)) return;
    try {
      await put(`/api/monthly/subscriptions/${id}`, { status: st });
      toast('Updated', 'ok');
      setDetail(null);
      loadSubs();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const openPkg = (p?: any) => {
    setPkgEdit(p || null);
    setPf(p ? { name: p.name, price: String(p.price), validity_days: String(p.validity_days), reserved_space: !!p.reserved_space, vehicle_limit: String(p.vehicle_limit), benefits: p.benefits, active: !!p.active } : { name: '', price: '', validity_days: '30', reserved_space: false, vehicle_limit: '1', benefits: '', active: true });
    setShowPkg(true);
  };

  const savePkg = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { name: pf.name, price: Number(pf.price), validity_days: Number(pf.validity_days), reserved_space: pf.reserved_space ? 1 : 0, vehicle_limit: Number(pf.vehicle_limit), benefits: pf.benefits, active: pf.active ? 1 : 0 };
      if (pkgEdit) await put(`/api/monthly/packages/${pkgEdit.id}`, body);
      else await post('/api/monthly/packages', body);
      toast('Package saved', 'ok');
      setShowPkg(false);
      loadPkgs();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const delPkg = async (id: number) => {
    if (!confirm('Delete this package?')) return;
    try {
      await del(`/api/monthly/packages/${id}`);
      toast('Deleted', 'ok');
      loadPkgs();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const canManage = has('monthly.manage');

  return (
    <div className="page">
      <div className="page-head"><h2>Monthly Parking</h2>
        {tab === 'subs' && canManage && <button className="btn btn-primary btn-sm" onClick={openForm}>＋ New subscription</button>}
        {tab === 'pkgs' && canManage && <button className="btn btn-primary btn-sm" onClick={() => openPkg()}>＋ New package</button>}
      </div>
      <Tabs tabs={[{ id: 'subs', label: 'Subscriptions' }, { id: 'pkgs', label: 'Packages' }]} active={tab} onChange={setTab} />

      {tab === 'subs' && (
        <div className="card">
          <div className="filters">
            <input className="input" placeholder="Search name / reg / phone…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadSubs()} />
            <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All statuses</option><option value="active">Active</option><option value="expired">Expired</option><option value="suspended">Suspended</option><option value="cancelled">Cancelled</option>
            </select>
            <label className="check"><input type="checkbox" checked={expiring} onChange={e => setExpiring(e.target.checked)} /> Expiring ≤7 days</label>
            <button className="btn btn-sm" onClick={() => loadSubs()}>Apply</button>
          </div>
          {!subs && <CenterSpin />}
          {subs && subs.data.length === 0 && <Empty title="No subscriptions found" />}
          {subs && subs.data.length > 0 && (<>
            <div className="member-grid">
              {subs.data.map(s => {
                const total = Math.max(1, Math.round((new Date(s.expiry_date).getTime() - new Date(s.start_date).getTime()) / 86400000));
                const left = s.days_remaining ?? 0;
                const usedPct = s.status === 'active' ? Math.min(100, Math.max(0, Math.round(((total - left) / total) * 100))) : 100;
                const tone = s.status !== 'active' ? 'muted' : left <= 2 ? 'err' : left <= 7 ? 'warn' : 'ok';
                return (
                  <div key={s.id} className="card member-card" onClick={() => openDetail(s.id)} style={{ cursor: 'pointer' }}>
                    <div className="member-top">
                      <div><div className="member-name">{s.customer_name}</div><div className="muted">{s.company} {s.phone}</div></div>
                      <span className="member-reg">{s.registration}</span>
                    </div>
                    <div className="member-rows">
                      <div className="mr"><span>Package</span><b>{s.package_name}</b></div>
                      <div className="mr"><span>Fee</span><b>{fmtMoney(s.amount, cur)}</b></div>
                      <div className="mr"><span>Expiry</span><b>{fmtD(s.expiry_date)}</b></div>
                      <div className="mr"><span>Status</span><Badge tone={statusTone(s.status)}>{s.status}</Badge></div>
                    </div>
                    {s.status === 'active' && (<>
                      <div className="member-rows"><div className="mr"><span>Days left</span><Badge tone={tone}>{left}</Badge></div></div>
                      <div className={'progress' + (left <= 7 ? ' low' : '')}><div style={{ width: `${usedPct}%` }} /></div>
                      {left <= 7 && <div className="alert alert-warn" style={{ marginTop: 8, marginBottom: 0 }}>⏰ Expiring soon — offer renewal.</div>}
                    </>)}
                  </div>
                );
              })}
            </div>
            <Pagination page={subs.page} totalPages={subs.totalPages} total={subs.total} onPage={loadSubs} /></>
          )}
        </div>
      )}

      {tab === 'pkgs' && (
        <div className="pkg-grid">
          {pkgs.map(p => (
            <div key={p.id} className="card pkg-card">
              <h3>{p.name} {!p.active && <Badge tone="muted">inactive</Badge>}</h3>
              <div className="pkg-price">{fmtMoney(p.price, cur)}<span> / {p.validity_days} days</span></div>
              <div className="muted">{p.benefits}</div>
              <div className="muted">{p.reserved_space ? '✔ Reserved bay' : 'Standard bay'} · {p.vehicle_limit} vehicle(s)</div>
              {canManage && <div className="btn-row"><button className="btn btn-sm" onClick={() => openPkg(p)}>Edit</button><button className="btn btn-sm" onClick={() => delPkg(p.id)}>Delete</button></div>}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="New subscription" onClose={() => setShowForm(false)} wide>
          <form onSubmit={save} className="form">
            <div className="form-grid">
              <Field label="Customer name *"><input className="input" value={f.customer_name} onChange={e => setF({ ...f, customer_name: e.target.value })} required /></Field>
              <Field label="Company"><input className="input" value={f.company} onChange={e => setF({ ...f, company: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Phone"><input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
              <Field label="Email"><input className="input" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Registration *"><input className="input reg-input" value={f.registration} onChange={e => setF({ ...f, registration: e.target.value.toUpperCase() })} required /></Field>
              <Field label="Vehicle type"><select className="input" value={f.vehicle_type} onChange={e => setF({ ...f, vehicle_type: e.target.value })}>{VTYPES.map(v => <option key={v}>{v}</option>)}</select></Field>
            </div>
            <div className="form-grid">
              <Field label="Package *"><select className="input" value={f.package_id} onChange={e => setF({ ...f, package_id: e.target.value })} required>
                {pkgs.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name} - {fmtMoney(p.price, cur)}</option>)}
              </select></Field>
              <Field label={`Amount (default ${selPkg ? fmtMoney(selPkg.price, cur) : ''})`}><input type="number" className="input" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} placeholder="Leave blank for package price" /></Field>
            </div>
            <div className="form-grid">
              <Field label="Start date"><input type="date" className="input" value={f.start_date} onChange={e => setF({ ...f, start_date: e.target.value })} /></Field>
              <Field label="Expiry date (auto)" hint="Leave blank to auto-calculate"><input type="date" className="input" value={f.expiry_date} onChange={e => setF({ ...f, expiry_date: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Payment method"><select className="input" value={f.payment_method} onChange={e => setF({ ...f, payment_method: e.target.value })}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option></select></Field>
              <Field label="Payment reference"><input className="input" value={f.payment_reference} onChange={e => setF({ ...f, payment_reference: e.target.value.toUpperCase() })} /></Field>
            </div>
            <div className="alert alert-warn">Requires an open shift - the subscription payment is recorded against your shift.</div>
            <button className="btn btn-primary">Create subscription</button>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.registration} - ${detail.customer_name}`} onClose={() => setDetail(null)} wide>
          <table className="kv"><tbody>
            <tr><td>Status</td><td><Badge tone={statusTone(detail.status)}>{detail.status}</Badge> {detail.status === 'active' && <span className="muted">{detail.days_remaining} days remaining</span>}</td></tr>
            <tr><td>Package</td><td>{detail.package_name} · {fmtMoney(detail.amount, cur)}</td></tr>
            <tr><td>Period</td><td>{fmtD(detail.start_date)} → {fmtD(detail.expiry_date)}</td></tr>
            <tr><td>Contact</td><td>{detail.phone} · {detail.email} · {detail.company}</td></tr>
            <tr><td>Vehicle</td><td>{detail.vehicle_type}</td></tr>
          </tbody></table>
          <h4>Payment history</h4>
          {(detail.payments || []).length === 0 && <p className="muted">None.</p>}
          {(detail.payments || []).map((p: any) => (
            <div key={p.id} className="pay-row"><span>{p.method.toUpperCase()} {fmtMoney(p.amount, cur)}</span><span className="muted">{p.reference} · {p.received_by_name}</span></div>
          ))}
          {canManage && (
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => openRenew(detail)}>🔁 Renew</button>
              <button className="btn" onClick={() => setPrintSub(detail)}>🖨 Print record</button>
              {detail.status === 'active' && <button className="btn" onClick={() => setSubStatus(detail.id, 'suspended')}>Suspend</button>}
              {detail.status === 'suspended' && <button className="btn" onClick={() => setSubStatus(detail.id, 'active')}>Reactivate</button>}
              {(detail.status === 'active' || detail.status === 'suspended') && <button className="btn btn-danger" onClick={() => setSubStatus(detail.id, 'cancelled')}>Cancel</button>}
            </div>
          )}
        </Modal>
      )}

      {renew && (
        <Modal title={`Renew ${renew.registration}`} onClose={() => setRenew(null)}>
          <form onSubmit={doRenew} className="form">
            <Field label="Package"><select className="input" value={rf.package_id} onChange={e => setRf({ ...rf, package_id: e.target.value })}>
              {pkgs.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name} - {fmtMoney(p.price, cur)}</option>)}
            </select></Field>
            <div className="form-grid">
              <Field label="Start (auto-continues)" hint="Blank = day after current expiry"><input type="date" className="input" value={rf.start_date} onChange={e => setRf({ ...rf, start_date: e.target.value })} /></Field>
              <Field label="Expiry (auto)"><input type="date" className="input" value={rf.expiry_date} onChange={e => setRf({ ...rf, expiry_date: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Amount (blank = package price)"><input type="number" className="input" value={rf.amount} onChange={e => setRf({ ...rf, amount: e.target.value })} /></Field>
              <Field label="Method"><select className="input" value={rf.payment_method} onChange={e => setRf({ ...rf, payment_method: e.target.value })}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option></select></Field>
            </div>
            <Field label="Payment reference"><input className="input" value={rf.payment_reference} onChange={e => setRf({ ...rf, payment_reference: e.target.value.toUpperCase() })} /></Field>
            <button className="btn btn-primary">Renew subscription</button>
          </form>
        </Modal>
      )}

      {showPkg && (
        <Modal title={pkgEdit ? 'Edit package' : 'New package'} onClose={() => setShowPkg(false)}>
          <form onSubmit={savePkg} className="form">
            <Field label="Name *"><input className="input" value={pf.name} onChange={e => setPf({ ...pf, name: e.target.value })} required /></Field>
            <div className="form-grid">
              <Field label="Price *"><input type="number" className="input" value={pf.price} onChange={e => setPf({ ...pf, price: e.target.value })} required /></Field>
              <Field label="Validity (days)"><input type="number" className="input" value={pf.validity_days} onChange={e => setPf({ ...pf, validity_days: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Vehicle limit"><input type="number" className="input" value={pf.vehicle_limit} onChange={e => setPf({ ...pf, vehicle_limit: e.target.value })} /></Field>
              <Field label="Benefits"><input className="input" value={pf.benefits} onChange={e => setPf({ ...pf, benefits: e.target.value })} /></Field>
            </div>
            <label className="check"><input type="checkbox" checked={pf.reserved_space} onChange={e => setPf({ ...pf, reserved_space: e.target.checked })} /> Includes reserved bay</label>
            <label className="check"><input type="checkbox" checked={pf.active} onChange={e => setPf({ ...pf, active: e.target.checked })} /> Active</label>
            <button className="btn btn-primary">Save package</button>
          </form>
        </Modal>
      )}

      {printSub && settings && (
        <PrintSheet title="Monthly customer record" onClose={() => setPrintSub(null)}>
          <div className="ticket">
            <DocHead settings={settings} title="MONTHLY PARKING RECORD" />
            <table className="kv"><tbody>
              <tr><td>Customer</td><td><b>{printSub.customer_name}</b> {printSub.company}</td></tr>
              <tr><td>Registration</td><td><b>{printSub.registration}</b> ({printSub.vehicle_type})</td></tr>
              <tr><td>Package</td><td>{printSub.package_name}</td></tr>
              <tr><td>Period</td><td>{fmtD(printSub.start_date)} → {fmtD(printSub.expiry_date)}</td></tr>
              <tr><td>Amount</td><td>{fmtMoney(printSub.amount, cur)}</td></tr>
              <tr><td>Status</td><td>{printSub.status}</td></tr>
            </tbody></table>
            <div className="doc-foot">{settings.receipt_footer}</div>
          </div>
        </PrintSheet>
      )}
    </div>
  );
}
