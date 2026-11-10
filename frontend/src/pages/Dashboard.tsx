import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, fmtMoney, fmtDT, fmtD, fmtDur, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Stat, Badge, CenterSpin, statusTone, BarChart, PieChart } from '../ui';
import { useSettings } from '../components/Layout';

export default function Dashboard() {
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const { has } = useAuth();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';

  const load = async () => {
    try {
      setD(await get('/api/dashboard'));
    } catch (e: any) {
      toast(errMsg(e), 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  if (loading) return <CenterSpin />;
  if (!d) return <div className="page"><div className="card">Failed to load dashboard.</div></div>;

  const o = d.occupancy;
  const pct = o.total ? Math.round((o.occupied / o.total) * 100) : 0;
  const alerts: string[] = [];
  if (o.available === 0) alerts.push('🚫 Parking lot is FULL — new entries need supervisor override.');
  else if (pct > 90) alerts.push(`⚠️ Lot is ${pct}% full — only ${o.available} bay(s) left.`);
  if (d.outstanding.amount > 0) alerts.push(`💰 ${fmtMoney(d.outstanding.amount, cur)} outstanding across ${d.outstanding.count} vehicle(s).`);
  if (d.monthly.expiring.length > 0) alerts.push(`📅 ${d.monthly.expiring.length} monthly subscription(s) expiring within 7 days.`);
  if (!d.my_shift) alerts.push('⏰ You have no open shift — open one to collect payments.');
  if (d.variance_today !== 0) alerts.push(`⚖️ Today's closed shifts show variance of ${fmtMoney(d.variance_today, cur)}.`);

  const rev7 = (d.revenue_series || []).map((r: any) => ({ label: fmtD(r.d).slice(0, 6), value: Number(r.total) }));
  const methodPie = [
    { label: `Cash ${fmtMoney(d.revenue_today.cash, cur)}`, value: d.revenue_today.cash },
    { label: `M-Pesa ${fmtMoney(d.revenue_today.mpesa, cur)}`, value: d.revenue_today.mpesa },
    { label: `Card ${fmtMoney(d.revenue_today.card, cur)}`, value: d.revenue_today.card }
  ];

  return (
    <div className="page">
      <div className="page-head">
        <h2>Dashboard</h2>
        <button className="btn btn-sm" onClick={load}>↻ Refresh</button>
      </div>

      {alerts.length > 0 && (
        <div className="alerts-banner">
          <div className="ab-head">⚠️ Alerts ({alerts.length})</div>
          {alerts.map((a, i) => <div key={i} className="ab-row">{a}</div>)}
        </div>
      )}

      <div className="stat-grid">
        <Stat label="Parked now" value={o.active_sessions} sub={`${pct}% occupancy`} tone={pct > 90 ? 'err' : pct > 75 ? 'warn' : 'ok'} />
        <Stat label="Entries today" value={d.entered_today} />
        <Stat label="Exits today" value={d.exited_today} />
        <Stat label="Revenue today" value={fmtMoney(d.revenue_today.total, cur)} tone="ok" />
        <Stat label="Complimentary (in lot)" value={o.complimentary} />
        <Stat label="Occupancy" value={`${pct}%`} sub={`${o.available}/${o.total} free`} tone={pct > 90 ? 'err' : pct > 75 ? 'warn' : 'ok'} />
        <Stat label="Avg stay today" value={fmtDur(d.avg_duration_minutes || 0)} />
        <Stat label="Outstanding" value={fmtMoney(d.outstanding.amount, cur)} sub={`${d.outstanding.count} vehicle(s)`} tone={d.outstanding.amount ? 'warn' : undefined} />
      </div>

      <div className="stat-grid">
        <Stat label="Total bays" value={o.total} />
        <Stat label="Available" value={o.available} tone="ok" />
        <Stat label="Reserved" value={o.reserved} />
        <Stat label="Out of service" value={o.out_of_service} tone={o.out_of_service ? 'warn' : undefined} />
        <Stat label="Paid vehicles" value={o.paid} />
        <Stat label="Monthly (in lot)" value={o.monthly} />
        <Stat label="Monthly active" value={d.monthly.active} sub={`${d.monthly.expired} expired`} />
        <Stat label="My shift" value={d.my_shift ? `#${d.my_shift.id}` : 'None open'} sub={d.my_shift ? d.my_shift.station : 'Open a shift to collect'} tone={d.my_shift ? 'ok' : 'warn'} />
      </div>

      <div className="grid-2">
        <div className="card chart-card">
          <div className="chart-title">Revenue — last 7 days ({cur})</div>
          {rev7.length === 0 ? <p className="muted">No revenue in the last 7 days.</p> : <BarChart data={rev7} goldLast />}
        </div>
        <div className="card chart-card">
          <div className="chart-title">Today by payment method</div>
          <PieChart data={methodPie} center={fmtMoney(d.revenue_today.total, cur)} />
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Occupancy</h3>
          <div className="donut-wrap">
            <svg viewBox="0 0 120 120" className="donut">
              <circle cx="60" cy="60" r="48" fill="none" stroke="#e6ebf2" strokeWidth="18" />
              <circle cx="60" cy="60" r="48" fill="none" stroke={pct > 90 ? '#d64545' : '#1f7a4d'} strokeWidth="18"
                strokeDasharray={`${(pct / 100) * 301.6} 301.6`} transform="rotate(-90 60 60)" strokeLinecap="round" />
              <text x="60" y="66" textAnchor="middle" className="donut-text">{pct}%</text>
            </svg>
            <div>
              <div>🟢 Available: <b>{o.available}</b></div>
              <div>🔴 Occupied: <b>{o.occupied}</b></div>
              <div>🔵 Reserved: <b>{o.reserved}</b></div>
              <div>⚫ Out of service: <b>{o.out_of_service}</b></div>
            </div>
          </div>
        </div>
        <div className="card">
          <h3>Subscriptions expiring (7 days)</h3>
          {d.monthly.expiring.length === 0 && <p className="muted">None expiring soon.</p>}
          {d.monthly.expiring.length > 0 && (
            <table className="table table-sm">
              <thead><tr><th>Reg</th><th>Customer</th><th>Expires</th><th>Days</th></tr></thead>
              <tbody>
                {d.monthly.expiring.map((s: any) => (
                  <tr key={s.id}>
                    <td><b>{s.registration}</b></td><td>{s.customer_name}</td>
                    <td>{fmtD(s.expiry_date)}</td>
                    <td><Badge tone={s.days_remaining <= 2 ? 'err' : 'warn'}>{s.days_remaining}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Recent activity</h3>
        <table className="table table-sm table-cards">
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Module</th><th>Detail</th></tr></thead>
          <tbody>
            {d.recent_activity.map((a: any) => (
              <tr key={a.id}>
                <td data-l="Time">{fmtDT(a.created_at)}</td><td data-l="User">{a.username}</td>
                <td data-l="Action"><Badge tone={statusTone(a.action)}>{a.action}</Badge></td>
                <td data-l="Module">{a.module}</td><td data-l="Detail" className="muted">{a.new_value?.slice(0, 60)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {has('audit.view') && <Link className="link" to="/audit">View full audit log →</Link>}
      </div>
    </div>
  );
}
