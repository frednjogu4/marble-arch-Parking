import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, todayStr, fmtMoney, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Pagination, CenterSpin, statusTone } from '../ui';
import { useSettings } from '../components/Layout';
import type { Page, Shift } from '../types';

export default function Shifts() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [mine, setMine] = useState<any>(null);
  const [list, setList] = useState<Page<Shift> | null>(null);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [showOpen, setShowOpen] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [of, setOf] = useState({ station: 'Main Gate', opening_cash: '0' });
  const [cf, setCf] = useState({ actual_cash: '', actual_mpesa: '', actual_card: '', variance_note: '' });
  const [detail, setDetail] = useState<any>(null);

  const loadMine = async () => {
    try {
      const r = await get<any>('/api/shifts/current');
      setMine(r.data);
    } catch {}
  };
  const loadList = async (page = 1) => {
    try {
      setList(await get(`/api/shifts?from=${from}&to=${to}&page=${page}`));
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  useEffect(() => { loadMine(); loadList(); }, []);

  const openShift = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/shifts/open', { station: of.station, opening_cash: Number(of.opening_cash) });
      toast('Shift opened', 'ok');
      setShowOpen(false);
      loadMine(); loadList();
    } catch (err: any) { toast(errMsg(err), 'err'); }
  };

  const openClose = () => {
    if (!mine) return;
    setCf({
      actual_cash: String(mine.expected_live.cash),
      actual_mpesa: String(mine.expected_live.mpesa),
      actual_card: String(mine.expected_live.card),
      variance_note: ''
    });
    setShowClose(true);
  };

  const closeShift = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await post<any>(`/api/shifts/${mine.id}/close`, {
        actual_cash: Number(cf.actual_cash), actual_mpesa: Number(cf.actual_mpesa),
        actual_card: Number(cf.actual_card), variance_note: cf.variance_note
      });
      toast(r.variance !== 0 ? `Shift closed with variance ${fmtMoney(r.variance, cur)}` : 'Shift closed - no variance', r.variance !== 0 ? 'warn' : 'ok');
      setShowClose(false);
      loadMine(); loadList();
    } catch (err: any) { toast(errMsg(e), 'err'); }
  };

  const openDetail = async (id: number) => {
    try {
      const r = await get<any>(`/api/shifts/${id}`);
      setDetail(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const review = async (id: number) => {
    try {
      await post(`/api/shifts/${id}/review`);
      toast('Shift reviewed', 'ok');
      openDetail(id); loadList();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const variance = (s: Shift) => (Number(s.actual_cash || 0) - Number(s.expected_cash)) + (Number(s.actual_mpesa || 0) - Number(s.expected_mpesa)) + (Number(s.actual_card || 0) - Number(s.expected_card));

  return (
    <div className="page">
      <div className="page-head"><h2>Shifts</h2></div>

      <div className="card">
        <h3>My shift</h3>
        {!mine && <>
          <p className="muted">You have no open shift. Open one to start collecting payments.</p>
          {has('shifts.open') && <button className="btn btn-primary" onClick={() => setShowOpen(true)}>▶ Open shift</button>}
        </>}
        {mine && (
          <div>
            <table className="kv"><tbody>
              <tr><td>Shift</td><td><b>#{mine.id}</b> · {mine.station} · opened {fmtDT(mine.opened_at)}</td></tr>
              <tr><td>Opening float</td><td>{fmtMoney(mine.opening_cash, cur)}</td></tr>
              <tr><td>Transactions</td><td>{mine.transaction_count}</td></tr>
              <tr><td>Expected so far</td><td>Cash {fmtMoney(mine.expected_live.cash, cur)} · M-Pesa {fmtMoney(mine.expected_live.mpesa, cur)} · Card {fmtMoney(mine.expected_live.card, cur)}</td></tr>
            </tbody></table>
            {has('shifts.close') && <button className="btn btn-primary" onClick={openClose}>■ Close shift</button>}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Shift history</h3>
        <div className="filters">
          <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
          <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
          <button className="btn btn-sm" onClick={() => loadList()}>Apply</button>
        </div>
        {!list && <CenterSpin />}
        {list && list.data.length === 0 && <Empty title="No shifts found" />}
        {list && list.data.length > 0 && (
          <><table className="table"><thead><tr><th>ID</th><th>User</th><th>Station</th><th>Opened</th><th>Closed</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Status</th></tr></thead>
            <tbody>{list.data.map(s => {
              const exp = Number(s.expected_cash) + Number(s.expected_mpesa) + Number(s.expected_card);
              const act = s.status === 'closed' ? Number(s.actual_cash || 0) + Number(s.actual_mpesa || 0) + Number(s.actual_card || 0) : null;
              return (
                <tr key={s.id} onClick={() => openDetail(s.id)} style={{ cursor: 'pointer' }}>
                  <td>#{s.id}</td><td>{s.username}</td><td>{s.station}</td><td>{fmtDT(s.opened_at)}</td><td>{fmtDT(s.closed_at)}</td>
                  <td>{s.status === 'closed' ? fmtMoney(exp, cur) : '-'}</td>
                  <td>{act == null ? '-' : fmtMoney(act, cur)}</td>
                  <td>{s.status === 'closed' ? <Badge tone={variance(s) !== 0 ? 'warn' : 'ok'}>{fmtMoney(variance(s), cur)}</Badge> : '-'}</td>
                  <td><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
                </tr>
              );
            })}</tbody></table>
            <Pagination page={list.page} totalPages={list.totalPages} total={list.total} onPage={loadList} /></>
        )}
      </div>

      {showOpen && (
        <Modal title="Open shift" onClose={() => setShowOpen(false)}>
          <form onSubmit={openShift} className="form">
            <Field label="Station"><input className="input" value={of.station} onChange={e => setOf({ ...of, station: e.target.value })} /></Field>
            <Field label="Opening cash float"><input type="number" className="input" value={of.opening_cash} onChange={e => setOf({ ...of, opening_cash: e.target.value })} /></Field>
            <button className="btn btn-primary">Open shift</button>
          </form>
        </Modal>
      )}

      {showClose && mine && (
        <Modal title={`Close shift #${mine.id}`} onClose={() => setShowClose(false)}>
          <form onSubmit={closeShift} className="form">
            <table className="table table-sm"><thead><tr><th></th><th>Expected</th><th>Actual (count)</th></tr></thead><tbody>
              <tr><td>Cash</td><td>{fmtMoney(mine.expected_live.cash, cur)}</td><td><input type="number" step="1" className="input" value={cf.actual_cash} onChange={e => setCf({ ...cf, actual_cash: e.target.value })} required /></td></tr>
              <tr><td>M-Pesa</td><td>{fmtMoney(mine.expected_live.mpesa, cur)}</td><td><input type="number" step="1" className="input" value={cf.actual_mpesa} onChange={e => setCf({ ...cf, actual_mpesa: e.target.value })} required /></td></tr>
              <tr><td>Card</td><td>{fmtMoney(mine.expected_live.card, cur)}</td><td><input type="number" step="1" className="input" value={cf.actual_card} onChange={e => setCf({ ...cf, actual_card: e.target.value })} required /></td></tr>
            </tbody></table>
            <Field label="Variance explanation (required if any variance)" hint="Explain any difference between expected and actual">
              <input className="input" value={cf.variance_note} onChange={e => setCf({ ...cf, variance_note: e.target.value })} />
            </Field>
            <button className="btn btn-primary">Close shift</button>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`Shift #${detail.id} - ${detail.username}`} onClose={() => setDetail(null)} wide>
          <table className="kv"><tbody>
            <tr><td>Station</td><td>{detail.station}</td></tr>
            <tr><td>Opened / closed</td><td>{fmtDT(detail.opened_at)} → {fmtDT(detail.closed_at)}</td></tr>
            <tr><td>Opening float</td><td>{fmtMoney(detail.opening_cash, cur)}</td></tr>
            <tr><td>Expected</td><td>Cash {fmtMoney(detail.expected_live.cash, cur)} · M-Pesa {fmtMoney(detail.expected_live.mpesa, cur)} · Card {fmtMoney(detail.expected_live.card, cur)}</td></tr>
            {detail.status === 'closed' && <tr><td>Actual</td><td>Cash {fmtMoney(detail.actual_cash, cur)} · M-Pesa {fmtMoney(detail.actual_mpesa, cur)} · Card {fmtMoney(detail.actual_card, cur)}</td></tr>}
            {detail.variance_note && <tr><td>Variance note</td><td>{detail.variance_note}</td></tr>}
            <tr><td>Work</td><td>{detail.sessions_handled} session(s) handled · {fmtMoney(detail.discounts?.t || 0, cur)} discounts ({detail.discounts?.n || 0}) · {detail.complimentary_count} complimentary</td></tr>
          </tbody></table>
          <h4>Transactions ({detail.transactions.length})</h4>
          <table className="table table-sm"><thead><tr><th>Time</th><th>Ticket</th><th>Method</th><th>Amount</th><th>Ref</th></tr></thead>
            <tbody>{detail.transactions.map((t: any) => <tr key={t.id}><td>{fmtDT(t.paid_at)}</td><td>{t.ticket_no || '-'}</td><td>{t.method}</td><td>{fmtMoney(t.amount, cur)}</td><td>{t.reference}</td></tr>)}</tbody></table>
          {detail.status === 'closed' && has('shifts.review') && !detail.reviewed_by && (
            <button className="btn" onClick={() => review(detail.id)}>✓ Mark reviewed</button>
          )}
          {detail.reviewed_by_name && <p className="muted">Reviewed by {detail.reviewed_by_name}</p>}
        </Modal>
      )}
    </div>
  );
}
