import React, { useEffect, useState } from 'react';
import { get, post, fmtMoney, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Pagination, CenterSpin, statusTone } from '../ui';
import { useSettings } from '../components/Layout';
import type { Page } from '../types';

export default function Validations() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const canManage = has('validations.manage');
  const [list, setList] = useState<Page<any> | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ max_amount: '', valid_days: '1', notes: '' });
  const [busy, setBusy] = useState(false);
  const [lastCode, setLastCode] = useState<any>(null);

  const load = async (page = 1) => {
    try { setList(await get(`/api/validations?status=${status}&q=${encodeURIComponent(q)}&page=${page}`)); }
    catch (e: any) { toast(errMsg(e), 'err'); }
  };
  useEffect(() => { load(); }, [status]);

  const issue = async () => {
    setBusy(true);
    try {
      const r = await post<{ data: any }>('/api/validations', {
        max_amount: form.max_amount === '' ? null : Number(form.max_amount),
        valid_days: Number(form.valid_days) || 1, notes: form.notes
      });
      setLastCode(r.data);
      setForm({ max_amount: '', valid_days: '1', notes: '' });
      toast(`Issued ${r.data.code}`, 'ok');
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const revoke = async (id: number) => {
    if (!confirm('Revoke this code? It can never be used.')) return;
    try {
      await post(`/api/validations/${id}/revoke`, {});
      toast('Code revoked', 'ok');
      load(list?.page || 1);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  return (
    <div>
      <div className="page-head"><h2>Hotel Validation Codes</h2></div>
      <div className="grid-2">
        <div className="card">
          <h3>Issue a code</h3>
          {!canManage ? <p className="muted">Your role can view codes but not issue them.</p> : (<>
            <div className="form-grid">
              <Field label="Max cover (blank = full bill)" hint="Caps how much of the parking bill this code pays.">
                <input className="input input-lg" type="number" min="1" placeholder="e.g. 500" value={form.max_amount}
                  onChange={e => setForm({ ...form, max_amount: e.target.value })} />
              </Field>
              <Field label="Valid for (days)"><input className="input" type="number" min="1" max="90" value={form.valid_days}
                onChange={e => setForm({ ...form, valid_days: e.target.value })} /></Field>
            </div>
            <Field label="Notes (room / guest)"><input className="input" placeholder="e.g. Room 101 - guest checkout" value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })} /></Field>
            <div className="btn-row"><button className="btn btn-primary btn-lg" onClick={issue} disabled={busy}>＋ Issue code</button></div>
            {lastCode && (
              <div className="verdict verdict-ok" style={{ marginTop: 12 }}>
                <div className="verdict-word" style={{ fontFamily: 'monospace' }}>{lastCode.code}</div>
                <div className="verdict-reason">
                  {lastCode.max_amount != null ? `Covers up to ${fmtMoney(lastCode.max_amount, cur)}` : 'Covers the full bill'}
                  {' · '}expires {fmtDT(lastCode.expires_at)}
                </div>
                <div className="verdict-sub">Hand this code to the guest - the cashier redeems it at exit.</div>
              </div>
            )}
          </>)}
        </div>
        <div className="card">
          <h3>Codes</h3>
          <div className="filters">
            <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="unused">Unused</option><option value="used">Used</option>
              <option value="expired">Expired</option><option value="revoked">Revoked</option>
            </select>
            <input className="input" placeholder="Code or notes…" value={q} onChange={e => setQ(e.target.value)} />
            <button className="btn btn-sm" onClick={() => load()}>Filter</button>
          </div>
          {!list ? <CenterSpin /> : list.data.length === 0 ? <Empty title="No codes" hint="No validation codes match." /> : (<>
            <table className="table table-cards"><thead><tr><th>Code</th><th>Cover</th><th>Status</th><th>Used</th><th></th></tr></thead>
              <tbody>{list.data.map((r: any) => (
                <tr key={r.id}>
                  <td data-l="Code"><b style={{ fontFamily: 'monospace' }}>{r.code}</b><div className="muted">{r.notes || ''}</div></td>
                  <td data-l="Cover">{r.max_amount != null ? fmtMoney(r.max_amount, cur) : 'Full'}</td>
                  <td data-l="Status"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                  <td data-l="Used">{r.status === 'used' ? <>{fmtMoney(r.used_amount, cur)}<div className="muted">{r.used_ticket || ''}</div></> : <span className="muted">exp {fmtDT(r.expires_at)}</span>}</td>
                  <td>{r.status === 'unused' && canManage && <button className="btn btn-sm btn-danger" onClick={() => revoke(r.id)}>Revoke</button>}</td>
                </tr>
              ))}</tbody>
            </table>
            <Pagination page={list.page} totalPages={list.totalPages} total={list.total} onPage={p => load(p)} />
          </>)}
        </div>
      </div>
    </div>
  );
}
