import React, { useEffect, useState } from 'react';
import { get, fmtMoney, todayStr, errMsg, downloadCsv } from '../api';
import { useToast, Badge, Empty, CenterSpin, statusTone, Money, BarChart, PieChart } from '../ui';
import { useSettings } from '../components/Layout';

export default function Settlement() {
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [date, setDate] = useState(todayStr());
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const pieData = (d ? d.by_method : []).map((x: any) => ({ label: x.method + ' (' + x.count + ')', value: x.total }));
  const barData = (d ? d.by_client : []).slice(0, 7).map((x: any) => ({ label: String(x.payer).slice(0, 10), value: x.total }));

  const load = async () => {
    setLoading(true);
    try { setD((await get<{ data: any }>(`/api/settlement?date=${date}`)).data); }
    catch (e: any) { toast(errMsg(e), 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [date]);

  return (
    <div>
      <div className="page-head">
        <h2>Settlement</h2>
        <div className="row-inline" style={{ margin: 0 }}>
          <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
          {d && <button className="btn btn-sm" onClick={() => downloadCsv(`settlement-${date}.csv`, d.by_client.map((c: any) => ({ payer: c.payer, count: c.count, total: c.total })))}>CSV</button>}
        </div>
      </div>
      {loading || !d ? <div className="card"><CenterSpin /></div> : (
        <>
          <div className="stat-grid">
            <div className="stat stat-ok"><div className="stat-label">Collected {date}</div><div className="stat-value"><Money value={d.totals.collected} cur={cur} /></div></div>
            <div className="stat stat-warn"><div className="stat-label">Outstanding sessions</div><div className="stat-value"><Money value={d.totals.outstanding_sessions} cur={cur} /></div><div className="stat-sub">{d.outstanding_sessions.length} session(s)</div></div>
            <div className="stat stat-err"><div className="stat-label">Outstanding invoices</div><div className="stat-value"><Money value={d.totals.outstanding_invoices} cur={cur} /></div><div className="stat-sub">{d.outstanding_invoices.length} invoice(s)</div></div>
          </div>
          <div className="grid-2">
            <div className="card chart-card">
              <div className="chart-title">By payment method</div>
              {d.by_method.length === 0 ? <Empty title="No collections" hint="Nothing collected on this day." /> :
                <PieChart data={pieData} center={fmtMoney(d.totals.collected, cur)} />}
            </div>
            <div className="card chart-card">
              <div className="chart-title">Top clients</div>
              {d.by_client.length === 0 ? <Empty title="No clients" hint="Nothing collected on this day." /> :
                <BarChart data={barData} />}
            </div>
          </div>
          <div className="card">
            <h3>Collections by client</h3>
            {d.by_client.length === 0 ? <Empty title="None" hint="No collections." /> : (
              <table className="table table-cards"><thead><tr><th>Payer</th><th>Payments</th><th>Total</th></tr></thead>
                <tbody>{d.by_client.map((c: any, i: number) => <tr key={i}><td data-l="Payer"><b>{c.payer}</b></td><td data-l="Payments">{c.count}</td><td data-l="Total"><Money value={c.total} cur={cur} /></td></tr>)}</tbody>
              </table>)}
          </div>
          <div className="card">
            <h3>Outstanding session balances</h3>
            {d.outstanding_sessions.length === 0 ? <Empty title="All settled" hint="No session balances outstanding." /> : (
              <table className="table table-cards"><thead><tr><th>Ticket</th><th>Plate</th><th>Customer</th><th>Status</th><th>Due</th></tr></thead>
                <tbody>{d.outstanding_sessions.map((s: any) => <tr key={s.id}><td data-l="Ticket">{s.ticket_no}</td><td data-l="Plate"><b>{s.registration}</b></td><td data-l="Customer">{s.customer_name || '—'}</td><td data-l="Status"><Badge tone={statusTone(s.status)}>{s.status}</Badge></td><td data-l="Due"><b><Money value={s.due} cur={cur} /></b></td></tr>)}</tbody>
              </table>)}
          </div>
          <div className="card">
            <h3>Outstanding invoices</h3>
            {d.outstanding_invoices.length === 0 ? <Empty title="All settled" hint="No invoice balances outstanding." /> : (
              <table className="table table-cards"><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Balance</th><th>Status</th></tr></thead>
                <tbody>{d.outstanding_invoices.map((r: any) => <tr key={r.id}><td data-l="Invoice"><b>{r.invoice_no}</b></td><td data-l="Customer">{r.company || r.customer_name}</td><td data-l="Due">{r.due_date}</td><td data-l="Balance"><b><Money value={r.balance} cur={cur} /></b></td><td data-l="Status"><Badge tone={statusTone(r.display_status)}>{r.display_status}</Badge></td></tr>)}</tbody>
              </table>)}
          </div>
        </>
      )}
    </div>
  );
}
