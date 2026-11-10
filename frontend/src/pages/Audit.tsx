import React, { useEffect, useState } from 'react';
import { get, todayStr, fmtDT, errMsg } from '../api';
import { useToast, Badge, Empty, Modal, Pagination, CenterSpin } from '../ui';
import type { Page } from '../types';

const ACTIONS = ['login', 'login_failed', 'login_open_access', 'login_auto', 'logout', 'vehicle_entry', 'vehicle_exit', 'payment_collect',
  'mpesa_stk_push', 'mpesa_callback', 'discount_apply', 'discount_approved', 'refund_request',
  'subscription_create', 'subscription_renew', 'space_move', 'session_void', 'shift_open', 'shift_close',
  'recon_save', 'recon_finalize', 'user_create', 'user_update', 'settings_update', 'dashboard_view'];

export default function Audit() {
  const toast = useToast();
  const [list, setList] = useState<Page<any> | null>(null);
  const [action, setAction] = useState('');
  const [module, setModule] = useState('');
  const [user, setUser] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayStr());
  const [sel, setSel] = useState<any>(null);

  const load = async (page = 1) => {
    try {
      setList(await get(`/api/audit?action=${action}&module=${module}&user=${encodeURIComponent(user)}&from=${from}&to=${to}&page=${page}`));
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="page">
      <div className="page-head"><h2>Audit Logs</h2><span className="muted">Immutable record - entries cannot be edited or deleted.</span></div>
      <div className="card">
        <div className="filters">
          <select className="input" value={action} onChange={e => setAction(e.target.value)}>
            <option value="">All actions</option>{ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <input className="input" placeholder="Module…" value={module} onChange={e => setModule(e.target.value)} />
          <input className="input" placeholder="User…" value={user} onChange={e => setUser(e.target.value)} />
          <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
          <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
          <button className="btn btn-sm" onClick={() => load()}>Apply</button>
        </div>
        {!list && <CenterSpin />}
        {list && list.data.length === 0 && <Empty title="No audit records" />}
        {list && list.data.length > 0 && (
          <><table className="table table-sm"><thead><tr><th>ID</th><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Module</th><th>Record</th></tr></thead>
            <tbody>{list.data.map(a => (
              <tr key={a.id} onClick={() => setSel(a)} style={{ cursor: 'pointer' }}>
                <td>#{a.id}</td><td>{fmtDT(a.created_at)}</td><td>{a.username || '-'}</td><td className="muted">{a.role}</td>
                <td><Badge tone="info">{a.action}</Badge></td><td>{a.module}</td><td className="muted">{a.record_id}</td>
              </tr>
            ))}</tbody></table>
            <Pagination page={list.page} totalPages={list.totalPages} total={list.total} onPage={load} /></>
        )}
      </div>
      {sel && (
        <Modal title={`Audit #${sel.id} - ${sel.action}`} onClose={() => setSel(null)} wide>
          <table className="kv"><tbody>
            <tr><td>Time</td><td>{fmtDT(sel.created_at)}</td></tr>
            <tr><td>User</td><td>{sel.username} ({sel.role})</td></tr>
            <tr><td>Module / record</td><td>{sel.module} / {sel.record_id}</td></tr>
            <tr><td>IP / device</td><td className="muted">{sel.ip} · {sel.user_agent}</td></tr>
            <tr><td>Before</td><td><pre className="pre">{sel.old_value || '-'}</pre></td></tr>
            <tr><td>After</td><td><pre className="pre">{sel.new_value || '-'}</pre></td></tr>
          </tbody></table>
        </Modal>
      )}
    </div>
  );
}
