import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, todayStr, fmtMoney, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Tabs, Pagination, CenterSpin, statusTone } from '../ui';
import { useSettings } from '../components/Layout';
import type { Page, Payment } from '../types';

export default function Payments() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [params] = useSearchParams();
  const [tab, setTab] = useState('all');
  const [list, setList] = useState<Page<Payment> | null>(null);
  const [totals, setTotals] = useState<any[]>([]);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [method, setMethod] = useState('');
  const [verification, setVerification] = useState('');
  const [userId, setUserId] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [q, setQ] = useState(params.get('q') || '');
  const [mpesa, setMpesa] = useState<any>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [showRefund, setShowRefund] = useState(false);
  const [rf, setRf] = useState({ payment_id: '', amount: '', reason: '' });

  const load = async (page = 1) => {
    try {
      const r = await get<any>(`/api/payments?from=${from}&to=${to}&method=${method}&verification=${verification}&user_id=${userId}&q=${encodeURIComponent(q)}&page=${page}`);
      setList({ data: r.data, page: r.page, pageSize: r.pageSize, total: r.total, totalPages: r.totalPages });
      setTotals(r.totals || []);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const loadMpesa = async () => {
    try {
      const s = await get<any>('/api/mpesa/status');
      setMpesa(s.data);
      const t = await get<any>('/api/mpesa/transactions?pageSize=25');
      setTxns(t.data);
    } catch {}
  };
  const loadRefunds = async () => {
    try {
      const r = await get<any>('/api/refunds');
      setRefunds(r.data);
    } catch {}
  };

  useEffect(() => {
    load();
    loadMpesa();
    loadRefunds();
    if (has('users.view')) get<any>('/api/users?pageSize=100').then(r => setUsers(r.data)).catch(() => {});
  }, []);

  const requestRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/refunds', { payment_id: Number(rf.payment_id), amount: rf.amount ? Number(rf.amount) : undefined, reason: rf.reason });
      toast('Refund requested - awaiting approval', 'ok');
      setShowRefund(false);
      setRf({ payment_id: '', amount: '', reason: '' });
      loadRefunds();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const decideRefund = async (id: number, decision: string) => {
    try {
      await post(`/api/refunds/${id}/decision`, { decision });
      toast(`Refund ${decision}`, 'ok');
      loadRefunds();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const reverseTxn = async (id: number) => {
    if (!confirm('Mark this M-Pesa transaction as reversed?')) return;
    try {
      await post(`/api/mpesa/transactions/${id}/reverse`);
      toast('Transaction reversed', 'ok');
      loadMpesa(); load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const grand = totals.reduce((a, t) => a + (['verified', 'manual'].includes(t.verification_status) ? Number(t.t) : 0), 0);

  return (
    <div className="page">
      <div className="page-head"><h2>Payments</h2>
        {has('payments.refund.request') && <button className="btn btn-sm" onClick={() => setShowRefund(true)}>↩ Request refund</button>}
      </div>
      <Tabs tabs={[{ id: 'all', label: 'All payments' }, { id: 'mpesa', label: 'M-Pesa' }, { id: 'refunds', label: `Refunds (${refunds.filter(r => r.status === 'pending').length} pending)` }]} active={tab} onChange={setTab} />

      {tab === 'all' && (
        <div className="card">
          <div className="filters">
            <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
            <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
            <select className="input" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="">All methods</option><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option>
            </select>
            <select className="input" value={verification} onChange={e => setVerification(e.target.value)}>
              <option value="">All verifications</option><option value="verified">Verified</option><option value="manual">Manual</option><option value="pending">Pending</option><option value="failed">Failed</option>
            </select>
            {users.length > 0 && (
              <select className="input" value={userId} onChange={e => setUserId(e.target.value)}>
                <option value="">All users</option>{users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
            )}
            <input className="input" placeholder="Ticket / reg / ref…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
            <button className="btn btn-sm" onClick={() => load()}>Apply</button>
          </div>
          <div className="stat-grid stat-grid-sm">
            {totals.map((t: any) => (
              <div key={t.method + t.verification_status} className="stat">
                <div className="stat-label">{t.method} · {t.verification_status}</div>
                <div className="stat-value" style={{ fontSize: 18 }}>{fmtMoney(t.t, cur)}</div>
                <div className="stat-sub">{t.n} txn(s)</div>
              </div>
            ))}
            <div className="stat stat-ok"><div className="stat-label">Settled total</div><div className="stat-value" style={{ fontSize: 18 }}>{fmtMoney(grand, cur)}</div></div>
          </div>
          {!list && <CenterSpin />}
          {list && list.data.length === 0 && <Empty title="No payments found" />}
          {list && list.data.length > 0 && (
            <><table className="table"><thead><tr><th>ID</th><th>Time</th><th>Ticket</th><th>Method</th><th>Amount</th><th>Ref</th><th>Verification</th><th>By</th></tr></thead>
              <tbody>{list.data.map(p => (
                <tr key={p.id}>
                  <td>#{p.id}</td><td>{fmtDT(p.paid_at)}</td>
                  <td>{p.ticket_no || (p.subscription_id ? `SUB#${p.subscription_id}` : '-')}</td>
                  <td><Badge tone={p.method === 'cash' ? 'ok' : 'info'}>{p.method}</Badge></td>
                  <td><b>{fmtMoney(p.amount, cur)}</b></td>
                  <td className="muted">{p.reference}{p.terminal ? ` · ${p.terminal}` : ''}</td>
                  <td><Badge tone={statusTone(p.verification_status)}>{p.verification_status}</Badge></td>
                  <td>{p.received_by_name}</td>
                </tr>
              ))}</tbody></table>
              <Pagination page={list.page} totalPages={list.totalPages} total={list.total} onPage={load} /></>
          )}
        </div>
      )}

      {tab === 'mpesa' && (
        <div className="card">
          <h3>M-Pesa (Daraja)</h3>
          {mpesa && (
            mpesa.configured
              ? <div className="alert alert-ok">✅ M-Pesa API connected (env: {mpesa.env}, shortcode {mpesa.shortcodeMasked}). STK push available at exit.</div>
              : <div className="alert alert-warn">⚠️ M-Pesa API <b>not configured</b>. Gate payments are recorded <b>manually</b> from customer SMS codes and flagged unverified. Configure {mpesa.requiredEnv?.join(', ')} on the server to enable STK push.</div>
          )}
          <h4>STK transactions</h4>
          {txns.length === 0 && <p className="muted">No STK transactions yet.</p>}
          {txns.length > 0 && (
            <table className="table table-sm"><thead><tr><th>ID</th><th>Ticket</th><th>Phone</th><th>Amount</th><th>Receipt</th><th>Status</th><th></th></tr></thead>
              <tbody>{txns.map(t => (
                <tr key={t.id}>
                  <td>#{t.id}</td><td>{t.ticket_no || '-'}</td><td>{t.phone}</td><td>{fmtMoney(t.amount, cur)}</td>
                  <td>{t.mpesa_receipt || '-'}</td><td><Badge tone={statusTone(t.status)}>{t.status}</Badge></td>
                  <td>{t.status === 'paid' && has('mpesa.manage') && <button className="btn btn-sm" onClick={() => reverseTxn(t.id)}>Reverse</button>}</td>
                </tr>
              ))}</tbody></table>
          )}
        </div>
      )}

      {tab === 'refunds' && (
        <div className="card">
          <h3>Refunds</h3>
          {refunds.length === 0 && <Empty title="No refunds" />}
          {refunds.length > 0 && (
            <table className="table table-sm"><thead><tr><th>ID</th><th>Payment</th><th>Ticket</th><th>Amount</th><th>Reason</th><th>By</th><th>Status</th><th></th></tr></thead>
              <tbody>{refunds.map(r => (
                <tr key={r.id}>
                  <td>#{r.id}</td><td>#{r.payment_id} ({r.method})</td><td>{r.ticket_no || '-'}</td>
                  <td><b>{fmtMoney(r.amount, cur)}</b></td><td>{r.reason}</td><td>{r.requested_by_name}</td>
                  <td><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                  <td className="actions">
                    {r.status === 'pending' && has('payments.refund.approve') && <>
                      <button className="btn btn-sm" onClick={() => decideRefund(r.id, 'approved')}>Approve</button>
                      <button className="btn btn-sm" onClick={() => decideRefund(r.id, 'rejected')}>Reject</button>
                    </>}
                    {r.status === 'approved' && has('payments.refund.approve') && <button className="btn btn-sm" onClick={() => decideRefund(r.id, 'processed')}>Mark paid</button>}
                  </td>
                </tr>
              ))}</tbody></table>
          )}
        </div>
      )}

      {showRefund && (
        <Modal title="Request refund" onClose={() => setShowRefund(false)}>
          <form onSubmit={requestRefund} className="form">
            <Field label="Payment ID * (see All payments table)" hint="Only settled (verified/manual) payments can be refunded">
              <input type="number" className="input" value={rf.payment_id} onChange={e => setRf({ ...rf, payment_id: e.target.value })} required />
            </Field>
            <Field label="Amount (blank = full refundable)"><input type="number" className="input" value={rf.amount} onChange={e => setRf({ ...rf, amount: e.target.value })} /></Field>
            <Field label="Reason *"><input className="input" value={rf.reason} onChange={e => setRf({ ...rf, reason: e.target.value })} required /></Field>
            <button className="btn btn-primary">Submit request</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
