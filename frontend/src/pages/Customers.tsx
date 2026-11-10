import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, put, fmtMoney, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Pagination, CenterSpin, statusTone } from '../ui';
import { useSettings } from '../components/Layout';
import type { Page } from '../types';

export default function Customers() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [list, setList] = useState<Page<any> | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [f, setF] = useState({ name: '', phone: '', email: '', company: '', customer_type: 'casual', notes: '' });

  const load = async (page = 1) => {
    try {
      setList(await get(`/api/customers?q=${encodeURIComponent(q)}&page=${page}`));
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  useEffect(() => { load(); }, []);

  const openForm = (c?: any) => {
    setEdit(c || null);
    setF(c ? { name: c.name, phone: c.phone, email: c.email, company: c.company, customer_type: c.customer_type, notes: c.notes } : { name: '', phone: '', email: '', company: '', customer_type: 'casual', notes: '' });
    setShowForm(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (edit) await put(`/api/customers/${edit.id}`, f);
      else await post('/api/customers', f);
      toast(edit ? 'Customer updated' : 'Customer created', 'ok');
      setShowForm(false);
      load();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const openDetail = async (id: number) => {
    try {
      const r = await get<any>(`/api/customers/${id}`);
      setDetail(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Customers</h2>
        {has('customers.manage') && <button className="btn btn-primary btn-sm" onClick={() => openForm()}>＋ New customer</button>}
      </div>
      <div className="card">
        <div className="row-inline">
          <input className="input" placeholder="Search name / phone / company…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
          <button className="btn btn-sm" onClick={() => load()}>Search</button>
        </div>
        {!list && <CenterSpin />}
        {list && list.data.length === 0 && <Empty title="No customers found" />}
        {list && list.data.length > 0 && (
          <><table className="table"><thead><tr><th>Name</th><th>Phone</th><th>Company</th><th>Type</th><th>Visits</th><th></th></tr></thead>
            <tbody>{list.data.map((c: any) => (
              <tr key={c.id}>
                <td><b>{c.name}</b><div className="muted">{c.email}</div></td>
                <td>{c.phone || '-'}</td><td>{c.company || '-'}</td><td>{c.customer_type}</td><td>{c.visits}</td>
                <td className="actions">
                  <button className="btn btn-sm" onClick={() => openDetail(c.id)}>View</button>
                  {has('customers.manage') && <button className="btn btn-sm" onClick={() => openForm(c)}>Edit</button>}
                </td>
              </tr>
            ))}</tbody></table>
            <Pagination page={list.page} totalPages={list.totalPages} total={list.total} onPage={load} /></>
        )}
      </div>

      {showForm && (
        <Modal title={edit ? 'Edit customer' : 'New customer'} onClose={() => setShowForm(false)}>
          <form onSubmit={save} className="form">
            <Field label="Name *"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></Field>
            <div className="form-grid">
              <Field label="Phone"><input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
              <Field label="Email"><input className="input" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Company"><input className="input" value={f.company} onChange={e => setF({ ...f, company: e.target.value })} /></Field>
              <Field label="Type"><input className="input" value={f.customer_type} onChange={e => setF({ ...f, customer_type: e.target.value })} /></Field>
            </div>
            <Field label="Notes"><input className="input" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></Field>
            <button className="btn btn-primary">Save</button>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)} wide>
          <div className="stat-grid">
            <div className="stat"><div className="stat-label">Visits</div><div className="stat-value">{detail.visits}</div></div>
            <div className="stat"><div className="stat-label">Total paid</div><div className="stat-value">{fmtMoney(detail.total_paid, cur)}</div></div>
            <div className="stat"><div className="stat-label">Vehicles</div><div className="stat-value">{detail.vehicles.length}</div></div>
          </div>
          <p className="muted">{detail.phone} · {detail.email} · {detail.company}</p>
          {detail.vehicles.length > 0 && <p><b>Vehicles:</b> {detail.vehicles.map((v: any) => v.registration).join(', ')}</p>}
          {detail.subscriptions.length > 0 && <>
            <h4>Monthly subscriptions</h4>
            <table className="table table-sm"><thead><tr><th>Reg</th><th>Package</th><th>Expiry</th><th>Status</th></tr></thead>
              <tbody>{detail.subscriptions.map((s: any) => <tr key={s.id}><td>{s.registration}</td><td>{s.package_name}</td><td>{s.expiry_date}</td><td><Badge tone={statusTone(s.status)}>{s.status}</Badge></td></tr>)}</tbody></table>
          </>}
          <h4>Visit history</h4>
          {detail.sessions.length === 0 && <p className="muted">No visits yet.</p>}
          {detail.sessions.length > 0 && (
            <table className="table table-sm"><thead><tr><th>Ticket</th><th>Reg</th><th>Entry</th><th>Exit</th><th>Paid</th></tr></thead>
              <tbody>{detail.sessions.map((s: any) => <tr key={s.id}><td>{s.ticket_no}</td><td>{s.registration}</td><td>{fmtDT(s.entry_time)}</td><td>{fmtDT(s.exit_time)}</td><td>{fmtMoney(s.amount_paid, cur)}</td></tr>)}</tbody></table>
          )}
        </Modal>
      )}
    </div>
  );
}
