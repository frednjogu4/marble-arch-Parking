import React, { useEffect, useState } from 'react';
import { get, fmtMoney, fmtDT, todayStr, errMsg, downloadCsv } from '../api';
import { useToast, Badge, Empty, Tabs, CenterSpin, statusTone, Money, BarChart } from '../ui';
import { useSettings } from '../components/Layout';

export default function DailyReport() {
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [tab, setTab] = useState('entries');
  const [date, setDate] = useState(todayStr());
  const [daily, setDaily] = useState<any>(null);
  const [access, setAccess] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    let ok = false;
    try { setDaily(await get<any>(`/api/reports/daily?from=${date}&to=${date}`)); ok = true; }
    catch (e: any) { /* reports.view missing — access-only user */ }
    try { setAccess((await get<any>(`/api/access/log?date=${date}&page=1&pageSize=200`)).data || []); }
    catch (e: any) { setAccess([]); }
    if (!ok) { setDaily({ revenue_by_day_method: [], traffic: [] }); toast('Revenue section needs reports permission', 'warn'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [date]);

  const revRows = daily?.revenue_by_day_method || [];
  const dayTotal = revRows.reduce((a: number, r: any) => a + Number(r.t || 0), 0);
  const allowed = access.filter(r => r.verdict === 'AUTHORIZED').length;
  const denied = access.filter(r => r.verdict === 'DENIED').length;
  const traffic = daily?.traffic?.[0];

  return (
    <div>
      <div className="page-head">
        <h2>Daily Report</h2>
        <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} style={{ width: 'auto' }} />
      </div>
      {loading || !daily ? <div className="card"><CenterSpin /></div> : (<>
        <div className="stat-grid">
          <div className="stat stat-ok"><div className="stat-label">Revenue {date}</div><div className="stat-value"><Money value={dayTotal} cur={cur} /></div></div>
          <div className="stat"><div className="stat-label">Entries / Exits</div><div className="stat-value">{traffic?.entries || 0} / {traffic?.exits || 0}</div></div>
          <div className="stat stat-ok"><div className="stat-label">Access allowed</div><div className="stat-value">{allowed}</div></div>
          <div className="stat stat-err"><div className="stat-label">Access denied</div><div className="stat-value">{denied}</div></div>
        </div>
        <Tabs tabs={[{ id: 'entries', label: 'Revenue by method' }, { id: 'access', label: `Access log (${access.length})` }]} active={tab} onChange={setTab} />
        {tab === 'entries' ? (
          <div className="card">
            <div className="page-head"><h3>Collections</h3>
              <button className="btn btn-sm" onClick={() => downloadCsv(`daily-${date}.csv`, revRows.map((r: any) => ({ day: r.d, method: r.method, count: r.n, total: r.t })))}>CSV</button>
            </div>
            {revRows.length === 0 ? <Empty title="No revenue" hint="Nothing collected on this day." /> : (<>
              <BarChart data={revRows.map((r: any) => ({ label: r.method, value: Number(r.t) }))} goldLast />
              <table className="table table-cards" style={{ marginTop: 12 }}><thead><tr><th>Method</th><th>Count</th><th>Total</th></tr></thead>
                <tbody>{revRows.map((r: any, i: number) => <tr key={i}><td data-l="Method"><b>{r.method}</b></td><td data-l="Count">{r.n}</td><td data-l="Total"><Money value={r.t} cur={cur} /></td></tr>)}</tbody>
              </table></>)}
          </div>
        ) : (
          <div className="card">
            <div className="page-head"><h3>Allowed / denied</h3>
              <button className="btn btn-sm" onClick={() => downloadCsv(`access-${date}.csv`, access.map(r => ({ time: r.created_at, plate: r.registration, verdict: r.verdict, reason: r.reason })))}>CSV</button>
            </div>
            {access.length === 0 ? <Empty title="No checks" hint="No access checks logged on this day." /> : (
              <table className="table table-cards"><thead><tr><th>Time</th><th>Plate</th><th>Verdict</th><th>Reason</th></tr></thead>
                <tbody>{access.map((r: any) => <tr key={r.id}><td data-l="Time">{fmtDT(r.created_at)}</td><td data-l="Plate"><b>{r.registration}</b></td><td data-l="Verdict"><Badge tone={statusTone(r.verdict)}>{r.verdict}</Badge></td><td data-l="Reason">{r.reason}</td></tr>)}</tbody>
              </table>)}
          </div>
        )}
      </>)}
    </div>
  );
}
