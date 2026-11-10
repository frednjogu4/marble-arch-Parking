import React, { useEffect, useState } from 'react';
import { get, post, fmtDT, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Modal, Field, Badge, CenterSpin, statusTone } from '../ui';
import { PrintSheet, TicketPrint } from '../print';
import { useSettings } from '../components/Layout';
import type { Space, Session } from '../types';

export default function LiveView() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [occ, setOcc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [zone, setZone] = useState('');
  const [sel, setSel] = useState<Space | null>(null);
  const [detail, setDetail] = useState<Session | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [ticket, setTicket] = useState<Session | null>(null);

  const load = async (silent = false) => {
    try {
      const r = await get<{ data: Space[]; occupancy: any }>('/api/spaces');
      setSpaces(r.data);
      setOcc(r.occupancy);
      if (sel) {
        const fresh = r.data.find(s => s.id === sel.id);
        if (fresh) setSel(fresh);
      }
    } catch (e: any) { if (!silent) toast(errMsg(e), 'err'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, []);

  const openSpace = async (s: Space) => {
    setSel(s);
    setDetail(null);
    if (s.current_session_id) {
      try {
        const r = await get<{ data: Session }>(`/api/sessions/${s.current_session_id}`);
        setDetail(r.data);
      } catch {}
    }
  };

  const doMove = async () => {
    if (!detail || !moveTo) return;
    try {
      await post(`/api/sessions/${detail.id}/move`, { space_id: Number(moveTo) });
      toast('Vehicle moved', 'ok');
      setMoveTo('');
      load(true);
      setSel(null);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const reprint = async () => {
    if (!detail) return;
    setTicket(detail);
  };

  if (loading) return <CenterSpin />;

  const zones = [...new Set(spaces.map(s => s.zone))].sort();
  const shown = spaces.filter(s =>
    (!filter || s.status === filter) && (!zone || s.zone === zone));

  return (
    <div className="page">
      <div className="page-head">
        <h2>Live Parking</h2>
        <div className="chip-row">
          {occ && <>
            <span className="chip">Total {occ.total}</span>
            <span className="chip chip-ok">Free {occ.available}</span>
            <span className="chip chip-warn">Occupied {occ.occupied}</span>
            <span className="chip chip-info">Reserved {occ.reserved}</span>
            <span className="chip chip-err">OOS {occ.out_of_service}</span>
          </>}
          <button className="btn btn-sm" onClick={() => load()}>↻</button>
        </div>
      </div>

      <div className="row-inline no-print">
        <select className="input" value={zone} onChange={e => setZone(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">All zones</option>
          {zones.map(z => <option key={z} value={z}>Zone {z}</option>)}
        </select>
        <select className="input" value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All statuses</option>
          <option value="available">Available</option>
          <option value="occupied">Occupied</option>
          <option value="reserved">Reserved</option>
          <option value="out_of_service">Out of service</option>
        </select>
        <span className="muted">{shown.length} bays</span>
      </div>

      <div className="legend no-print">
        <span><i className="sw sw-available" /> Available</span>
        <span><i className="sw sw-occupied" /> Occupied</span>
        <span><i className="sw sw-comp" /> Complimentary</span>
        <span><i className="sw sw-monthly" /> Monthly</span>
        <span><i className="sw sw-reserved" /> Reserved</span>
        <span><i className="sw sw-oos" /> Out of service</span>
      </div>

      {zones.filter(z => !zone || z === zone).map(z => {
        const zb = spaces.filter(x => x.zone === z);
        const c = (st: string) => zb.filter(x => x.status === st).length;
        return (
        <div key={z}>
          <h4 className="zone-title">Zone {z}
            <span className="zone-counts">
              <span className="chip chip-ok">{c('available')} free</span>
              <span className="chip chip-warn">{c('occupied')} used</span>
              <span className="chip chip-info">{c('reserved')} res</span>
              <span className="chip chip-err">{c('out_of_service')} OOS</span>
            </span>
          </h4>
          <div className="bay-grid">
            {shown.filter(s => s.zone === z).map(s => {
              let cls = 'bay-available';
              if (s.status === 'occupied') {
                cls = s.category_kind === 'complimentary' ? 'bay-comp'
                  : s.category_code === 'monthly' ? 'bay-monthly' : 'bay-occupied';
              } else if (s.status === 'reserved') cls = 'bay-reserved';
              else if (s.status === 'out_of_service') cls = 'bay-oos';
              return (
                <button key={s.id} className={`bay ${cls}`} onClick={() => openSpace(s)} title={`${s.code} - ${s.status}`}>
                  <span className="bay-code">{s.code}</span>
                  {s.status === 'occupied' && <span className="bay-reg">{s.registration}</span>}
                </button>
              );
            })}
          </div>
        </div>
        );
      })}

      {sel && (
        <Modal title={`Bay ${sel.code} - ${sel.status.replace(/_/g, ' ')}`} onClose={() => setSel(null)}>
          <table className="kv"><tbody>
            <tr><td>Zone / type</td><td>{sel.zone} / {sel.space_type}</td></tr>
            {sel.status === 'occupied' && <>
              <tr><td>Registration</td><td><b>{sel.registration}</b></td></tr>
              <tr><td>Customer</td><td>{sel.customer_name || '-'}</td></tr>
              <tr><td>Ticket</td><td>{sel.ticket_no}</td></tr>
              <tr><td>Entry</td><td>{fmtDT(sel.entry_time)}</td></tr>
              <tr><td>Category</td><td><Badge tone={statusTone(sel.category_code || '')}>{sel.category_name}</Badge></td></tr>
            </>}
            {sel.notes && <tr><td>Notes</td><td>{sel.notes}</td></tr>}
          </tbody></table>
          {detail && has('sessions.move') && (
            <div className="row-inline">
              <select className="input" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
                <option value="">Move to bay…</option>
                {spaces.filter(s => s.status === 'available' && s.id !== sel.id).map(s => (
                  <option key={s.id} value={s.id}>{s.code} · Zone {s.zone}</option>
                ))}
              </select>
              <button className="btn" onClick={doMove} disabled={!moveTo}>Move</button>
            </div>
          )}
          {detail && <div className="btn-row"><button className="btn" onClick={reprint}>🖨 Reprint ticket</button></div>}
        </Modal>
      )}

      {ticket && settings && (
        <PrintSheet title={`Ticket ${ticket.ticket_no}`} onClose={() => setTicket(null)}>
          <TicketPrint s={ticket} settings={settings} />
        </PrintSheet>
      )}
    </div>
  );
}
