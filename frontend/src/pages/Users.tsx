import React, { useEffect, useState } from 'react';
import { get, post, put, del, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Pagination, CenterSpin } from '../ui';
import type { Page, User } from '../types';

export default function Users() {
  const { has, user: me } = useAuth();
  const toast = useToast();
  const [list, setList] = useState<Page<User> | null>(null);
  const [q, setQ] = useState('');
  const [roles, setRoles] = useState<any[]>([]);
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  const [allPerms, setAllPerms] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [showPw, setShowPw] = useState<any>(null);
  const [pw, setPw] = useState('');
  const [showMatrix, setShowMatrix] = useState(false);
  const [f, setF] = useState({ full_name: '', username: '', email: '', phone: '', password: '', role_id: '', active: true });

  const load = async (page = 1) => {
    try {
      setList(await get(`/api/users?q=${encodeURIComponent(q)}&page=${page}`));
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const loadRoles = async () => {
    try {
      const r = await get<any>('/api/roles');
      setRoles(r.data);
      setMatrix(r.matrix);
      setAllPerms(r.all_permissions);
    } catch {}
  };

  useEffect(() => { load(); loadRoles(); }, []);

  const openForm = (u?: any) => {
    setEdit(u || null);
    setF(u ? { full_name: u.full_name, username: u.username, email: u.email || '', phone: u.phone || '', password: '', role_id: String(u.role_id), active: !!u.active }
      : { full_name: '', username: '', email: '', phone: '', password: '', role_id: roles[0] ? String(roles[0].id) : '', active: true });
    setShowForm(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (edit) {
        await put(`/api/users/${edit.id}`, { full_name: f.full_name, email: f.email, phone: f.phone, role_id: Number(f.role_id), active: f.active ? 1 : 0 });
      } else {
        await post('/api/users', { ...f, role_id: Number(f.role_id) });
      }
      toast(edit ? 'User updated' : 'User created (must change password on login)', 'ok');
      setShowForm(false);
      load();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const resetPw = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post(`/api/users/${showPw.id}/reset-password`, { password: pw });
      toast('Password reset - user must change it on login', 'ok');
      setShowPw(null);
      setPw('');
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const remove = async (u: any) => {
    if (!confirm(`Deactivate user ${u.username}?`)) return;
    try {
      await del(`/api/users/${u.id}`);
      toast('User deactivated', 'ok');
      load();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const canManage = has('users.manage');

  return (
    <div className="page">
      <div className="page-head">
        <h2>Users</h2>
        <span>
          <button className="btn btn-sm" onClick={() => setShowMatrix(!showMatrix)}>{showMatrix ? 'Hide' : 'Show'} role permissions</button>
          {' '}{canManage && <button className="btn btn-primary btn-sm" onClick={() => openForm()}>＋ New user</button>}
        </span>
      </div>

      {showMatrix && (
        <div className="card">
          <h3>Role permission matrix</h3>
          <div className="matrix-wrap">
            <table className="table table-sm matrix">
              <thead><tr><th>Permission</th>{Object.keys(matrix).map(r => <th key={r}>{r}</th>)}</tr></thead>
              <tbody>
                {allPerms.map((p: any) => (
                  <tr key={p.code}>
                    <td title={p.description}>{p.code}</td>
                    {Object.keys(matrix).map(r => (
                      <td key={r} className="matrix-cell">{matrix[r].includes('*') || matrix[r].includes(p.code) ? '✔' : '·'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row-inline">
          <input className="input" placeholder="Search username / name / role…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
          <button className="btn btn-sm" onClick={() => load()}>Search</button>
        </div>
        {!list && <CenterSpin />}
        {list && list.data.length === 0 && <Empty title="No users found" />}
        {list && list.data.length > 0 && (
          <><table className="table"><thead><tr><th>User</th><th>Role</th><th>Contact</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>{list.data.map(u => (
              <tr key={u.id}>
                <td><b>{u.full_name}</b><div className="muted">@{u.username}{u.must_change_password ? ' · must change PW' : ''}</div></td>
                <td><Badge tone="info">{u.role_name}</Badge></td>
                <td className="muted">{u.email}<br />{u.phone}</td>
                <td><Badge tone={u.active ? 'ok' : 'err'}>{u.active ? 'active' : 'inactive'}</Badge></td>
                <td className="muted">{fmtDT(u.created_at)}</td>
                <td className="actions">
                  {canManage && <><button className="btn btn-sm" onClick={() => openForm(u)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => setShowPw(u)}>Reset PW</button>
                    {u.id !== me?.id && <button className="btn btn-sm" onClick={() => remove(u)}>Deactivate</button>}</>}
                </td>
              </tr>
            ))}</tbody></table>
            <Pagination page={list.page} totalPages={list.totalPages} total={list.total} onPage={load} /></>
        )}
      </div>

      {showForm && (
        <Modal title={edit ? 'Edit user' : 'New user'} onClose={() => setShowForm(false)}>
          <form onSubmit={save} className="form">
            <Field label="Full name *"><input className="input" value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} required /></Field>
            <div className="form-grid">
              <Field label="Username *"><input className="input" value={f.username} onChange={e => setF({ ...f, username: e.target.value })} required disabled={!!edit} /></Field>
              <Field label="Role *"><select className="input" value={f.role_id} onChange={e => setF({ ...f, role_id: e.target.value })} required>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></Field>
            </div>
            <div className="form-grid">
              <Field label="Email"><input className="input" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
            </div>
            {!edit && <Field label="Temporary password * (min 8 chars)" hint="User must change it on first login"><input type="password" className="input" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required /></Field>}
            {edit && <label className="check"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Active</label>}
            <button className="btn btn-primary">Save</button>
          </form>
        </Modal>
      )}

      {showPw && (
        <Modal title={`Reset password - ${showPw.username}`} onClose={() => setShowPw(null)}>
          <form onSubmit={resetPw} className="form">
            <Field label="New temporary password * (min 8 chars)"><input type="password" className="input" value={pw} onChange={e => setPw(e.target.value)} required /></Field>
            <button className="btn btn-primary">Reset</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
