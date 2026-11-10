import React, { useEffect, useState } from 'react';
import { get, post, mutate, fmtMoney, fmtDT, fmtDur, errMsg } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Money, statusTone, CenterSpin } from '../ui';
import { PrintSheet, ThermalReceipt } from '../print';
import { useSettings } from '../components/Layout';
import type { Session, Quote, Payment } from '../types';

export default function Exit() {
  const { has, user } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Session[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Session | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ data: Session; quote: Quote; payments: Payment[] } | null>(null);
  const [pay, setPay] = useState({ method: 'cash', amount: '', reference: '', terminal: '' });
  const [mpesaCfg, setMpesaCfg] = useState(false);
  const [stkPhone, setStkPhone] = useState('');
  const [promos, setPromos] = useState<any[]>([]);
  const [disc, setDisc] = useState({ promotion_id: '', kind: 'fixed', value: '', reason: '' });
  const [showVoid, setShowVoid] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [validCode, setValidCode] = useState('');
  const [showLost, setShowLost] = useState(false);
  const [lostId, setLostId] = useState('');
  const [lostPhone, setLostPhone] = useState('');

  useEffect(() => {
    get<any>('/api/mpesa/status').then(r => setMpesaCfg(r.data.configured)).catch(() => {});
    if (has('discounts.apply')) get<{ data: any[] }>('/api/promotions?active_only=1').then(r => setPromos(r.data)).catch(() => {});
  }, []);

  const lookup = async () => {
    if (!q.trim()) return;
    try {
      const r = await get<{ data: Session[] }>(`/api/exit/lookup?q=${encodeURIComponent(q.trim())}`);
      setFound(r.data);
      if (r.data.length === 1) select(r.data[0].id);
      else if (!r.data.length) toast('No matching vehicle found', 'info');
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const select = async (id: number) => {
    setSelId(id);
    try {
      const r = await get<{ data: Session; quote: Quote }>(`/api/sessions/${id}`);
      setDetail(r.data);
      setQuote(r.quote);
      setPay(p => ({ ...p, amount: r.quote && r.quote.due > 0 ? String(r.quote.due) : '' }));
      if (r.data.phone) setStkPhone(r.data.phone);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const refresh = () => { if (selId) select(selId); };

  const recordPayment = async () => {
    if (!selId) return;
    setBusy(true);
    try {
      const r: any = await mutate('POST', `/api/sessions/${selId}/pay`, {
        method: pay.method, amount: Number(pay.amount), reference: pay.reference, terminal: pay.terminal
      }, `Payment ${pay.amount} session ${selId}`);
      if (r._queued) toast('Offline - payment queued (pending sync)', 'warn');
      else {
        toast(`Recorded ${fmtMoney(pay.amount, cur)}${r.data.verification_status === 'manual' ? ' (manual record)' : ''}`, 'ok');
        setPay({ method: 'cash', amount: '', reference: '', terminal: '' });
        refresh();
      }
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const stkPush = async () => {
    if (!selId || !quote) return;
    setBusy(true);
    try {
      const r = await post<any>('/api/mpesa/stk-push', { session_id: selId, phone: stkPhone });
      toast(r.data?.message || 'STK push sent - awaiting customer PIN', 'info');
      refresh();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const complete = async () => {
    if (!selId) return;
    if (!confirm('Complete exit for this vehicle?')) return;
    setBusy(true);
    try {
      const r: any = await mutate('POST', `/api/sessions/${selId}/exit`, {}, `Exit session ${selId}`);
      if (r._queued) { toast('Offline - exit queued (pending sync)', 'warn'); return; }
      toast('Exit completed', 'ok');
      setReceipt({ data: r.data, quote: r.quote, payments: r.payments });
      setDetail(null); setQuote(null); setSelId(null); setFound([]);
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const applyDiscount = async () => {
    if (!selId) return;
    setBusy(true);
    try {
      const body: any = { reason: disc.reason };
      if (disc.promotion_id) body.promotion_id = Number(disc.promotion_id);
      else { body.kind = disc.kind; body.value = Number(disc.value); }
      const r = await post<any>(`/api/sessions/${selId}/discounts`, body);
      toast(r.data.status === 'pending' ? 'Discount requested - awaiting approval' : 'Discount applied', r.data.status === 'pending' ? 'info' : 'ok');
      setDisc({ promotion_id: '', kind: 'fixed', value: '', reason: '' });
      refresh();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const decideDiscount = async (id: number, decision: string) => {
    try {
      await post(`/api/discounts/${id}/decision`, { decision });
      toast(`Discount ${decision}`, decision === 'approved' ? 'ok' : 'info');
      refresh();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const redeem = async () => {
    if (!selId || !validCode.trim()) return;
    setBusy(true);
    try {
      const r = await post<any>(`/api/sessions/${selId}/validate`, { code: validCode });
      toast(`Validation ${r.data.validation_code || ''}: ${fmtMoney(r.data.discount_amount, cur)} off`, 'ok');
      setValidCode('');
      refresh();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const markLost = async () => {
    if (!selId || !lostId.trim()) { toast('ID number is required', 'err'); return; }
    setBusy(true);
    try {
      await post(`/api/sessions/${selId}/mark-lost`, { id_number: lostId, phone: lostPhone });
      toast('Ticket flagged as lost - flat fee applies', 'warn');
      setShowLost(false); setLostId(''); setLostPhone('');
      refresh();
    } catch (e: any) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  };

  const unmarkLost = async () => {
    if (!selId) return;
    if (!confirm('Ticket recovered? Normal charges will apply.')) return;
    try {
      await post(`/api/sessions/${selId}/unmark-lost`, {});
      toast('Lost flag cleared', 'ok');
      refresh();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  const voidSession = async () => {
    if (!selId || !voidReason.trim()) { toast('Reason required', 'err'); return; }
    try {
      await post(`/api/sessions/${selId}/void`, { reason: voidReason });
      toast('Session voided', 'ok');
      setShowVoid(false); setVoidReason('');
      setDetail(null); setQuote(null); setSelId(null); setFound([]);
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  return (
    <div className="page gate">
      <div className="page-head"><h2>Vehicle Exit</h2></div>
      <div className="card">
        <div className="row-inline">
          <input className="input input-lg" placeholder="Scan/type: registration, ticket or phone…" value={q}
            onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookup()} autoFocus style={{ flex: 1 }} />
          <button className="btn btn-primary btn-lg" onClick={lookup}>Find</button>
        </div>
        {found.length > 1 && (
          <table className="table table-sm" style={{ marginTop: 12 }}>
            <tbody>
              {found.map(s => (
                <tr key={s.id} className={s.id === selId ? 'row-sel' : ''} onClick={() => select(s.id)} style={{ cursor: 'pointer' }}>
                  <td><b>{s.registration}</b><div className="muted">{s.ticket_no}</div></td>
                  <td>{s.category_name}</td>
                  <td>{s.space_code || '-'}</td>
                  <td><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!detail && <Empty title="Find a vehicle to begin exit" hint="Search by registration, ticket number or phone." />}

      {detail && (
        <div className="grid-2">
          <div className="card">
            <h3>{detail.registration} <Badge tone={statusTone(detail.status)}>{detail.status}</Badge></h3>
            <table className="kv"><tbody>
              <tr><td>Ticket</td><td><b>{detail.ticket_no}</b></td></tr>
              {(detail as any).lost_ticket ? (
                <tr><td>Ticket status</td><td><Badge tone="warn">LOST - flat fee</Badge> <span className="muted">ID: {(detail as any).lost_id_number || '-'}</span></td></tr>
              ) : null}
              <tr><td>Customer</td><td>{detail.customer_name || '-'} {detail.phone}</td></tr>
              <tr><td>Category</td><td>{detail.category_name}</td></tr>
              <tr><td>Bay</td><td>{detail.space_code || '-'}</td></tr>
              <tr><td>Entry</td><td>{fmtDT(detail.entry_time)}</td></tr>
              {quote && <tr><td>Duration</td><td>{fmtDur(quote.minutes)}{quote.days > 0 ? ` (${quote.days} day(s))` : ''}</td></tr>}
            </tbody></table>

            {quote && (
              <table className="kv bill"><tbody>
                <tr><td>Parking fee {quote.base_reason === 'monthly' ? '(monthly covered)' : quote.base_reason === 'complimentary' ? '(complimentary)' : quote.base_reason === 'grace' ? '(within grace)' : quote.base_reason === 'lost' ? '(lost ticket flat fee)' : ''}</td>
                  <td>{fmtMoney(quote.base, cur)}</td></tr>
                {quote.discount > 0 && <tr><td>Discount</td><td>-{fmtMoney(quote.discount, cur)}</td></tr>}
                {quote.paid > 0 && <tr><td>Paid</td><td>{fmtMoney(quote.paid, cur)}</td></tr>}
                <tr className="total"><td>Balance due</td><td><b>{fmtMoney(quote.due, cur)}</b></td></tr>
              </tbody></table>
            )}
            {quote && quote.pending_discounts > 0 && <div className="alert alert-warn">A discount is awaiting approval - exit is blocked until decided.</div>}

            {detail.status === 'active' && (
              <div className="btn-row">
                <button className="btn btn-primary btn-lg" onClick={complete} disabled={busy || !quote || quote.due > 0}>
                  {busy ? '…' : quote && quote.due > 0 ? `Collect ${fmtMoney(quote.due, cur)} to exit` : '✅ Complete exit'}
                </button>
                {(detail as any).lost_ticket
                  ? (has('sessions.override') && <button className="btn" onClick={unmarkLost}>Ticket recovered</button>)
                  : <button className="btn" onClick={() => setShowLost(true)}>🎫 Lost ticket…</button>}
                {has('sessions.void') && <button className="btn btn-danger" onClick={() => setShowVoid(true)}>Void</button>}
              </div>
            )}
          </div>

          <div>
            <div className="card">
              <h3>Payments</h3>
              {(detail.payments || []).length === 0 && <p className="muted">No payments recorded.</p>}
              {(detail.payments || []).map((p: Payment) => (
                <div key={p.id} className="pay-row">
                  <span><Badge tone={p.method === 'cash' ? 'ok' : 'info'}>{p.method.toUpperCase()}</Badge> {fmtMoney(p.amount, cur)}</span>
                  <span className="muted">{p.reference} · <Badge tone={statusTone(p.verification_status)}>{p.verification_status}</Badge></span>
                </div>
              ))}
              {detail.status === 'active' && quote && quote.due > 0 && has('payments.collect') && (
                <div className="pay-form">
                  <div className="method-tabs">
                    {['cash', 'mpesa', 'card'].map(m => (
                      <button key={m} className={`method-tab ${pay.method === m ? 'on' : ''}`} onClick={() => setPay({ ...pay, method: m, amount: quote.due > 0 ? String(quote.due) : pay.amount })}>
                        {m === 'cash' ? '💵 Cash' : m === 'mpesa' ? '📱 M-Pesa' : '💳 Card'}
                      </button>
                    ))}
                  </div>
                  <div className="form-grid">
                    <Field label="Amount"><input className="input input-lg" type="number" min="1" step="1" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} /></Field>
                    {pay.method !== 'cash' && (
                      <Field label={pay.method === 'mpesa' ? 'M-Pesa code *' : 'Auth / ref *'}>
                        <input className="input input-lg" value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value.toUpperCase() })} placeholder={pay.method === 'mpesa' ? 'e.g. QHX…' : 'Auth code'} />
                      </Field>
                    )}
                  </div>
                  {pay.method === 'card' && (
                    <Field label="PDQ terminal"><input className="input" value={pay.terminal} onChange={e => setPay({ ...pay, terminal: e.target.value })} placeholder="e.g. PDQ-1" /></Field>
                  )}
                  {pay.method === 'mpesa' && !mpesaCfg && (
                    <div className="alert alert-warn">M-Pesa API not configured - recording is <b>manual</b> (verify customer SMS). It will be flagged as unverified.</div>
                  )}
                  <div className="btn-row">
                    <button className="btn btn-primary btn-lg" onClick={recordPayment} disabled={busy}>＋ Record payment</button>
                    <button className="btn" onClick={refresh}>↻</button>
                  </div>
                  {pay.method === 'mpesa' && mpesaCfg && has('mpesa.manage') && (
                    <div className="stk-box">
                      <Field label="STK push to phone"><input className="input" value={stkPhone} onChange={e => setStkPhone(e.target.value)} /></Field>
                      <button className="btn" onClick={stkPush} disabled={busy}>📲 Send STK push ({fmtMoney(quote.due, cur)})</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="card">
              <h3>Discounts</h3>
              {(detail.discounts || []).length === 0 && <p className="muted">None.</p>}
              {(detail.discounts || []).map(d => (
                <div key={d.id} className="pay-row">
                  <span>{fmtMoney(d.discount_amount, cur)} <span className="muted">{d.reason}</span></span>
                  <span>
                    <Badge tone={statusTone(d.status)}>{d.status}</Badge>{' '}
                    {d.status === 'pending' && has('discounts.approve') && (
                      <span>
                        <button className="btn btn-sm" onClick={() => decideDiscount(d.id, 'approved')}>Approve</button>{' '}
                        <button className="btn btn-sm" onClick={() => decideDiscount(d.id, 'rejected')}>Reject</button>
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {detail.status === 'active' && has('discounts.apply') && !(detail.discounts || []).some(d => d.status !== 'rejected') && quote && quote.base > 0 && (
                <div className="pay-form">
                  {promos.length > 0 && (
                    <Field label="Promotion (optional)"><select className="input" value={disc.promotion_id} onChange={e => setDisc({ ...disc, promotion_id: e.target.value })}>
                      <option value="">Manual discount…</option>
                      {promos.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select></Field>
                  )}
                  {!disc.promotion_id && (
                    <div className="form-grid">
                      <Field label="Kind"><select className="input" value={disc.kind} onChange={e => setDisc({ ...disc, kind: e.target.value })}>
                        <option value="fixed">Fixed amount</option><option value="percentage">Percentage</option><option value="free">Free parking</option>
                      </select></Field>
                      {disc.kind !== 'free' && <Field label="Value"><input className="input" type="number" min="1" value={disc.value} onChange={e => setDisc({ ...disc, value: e.target.value })} /></Field>}
                    </div>
                  )}
                  <Field label="Reason *"><input className="input" value={disc.reason} onChange={e => setDisc({ ...disc, reason: e.target.value })} /></Field>
                  <button className="btn" onClick={applyDiscount} disabled={busy}>{has('discounts.approve') ? 'Apply discount' : 'Request discount'}</button>
                </div>
              )}
              {detail.status === 'active' && has('payments.collect') && !(detail.discounts || []).some(d => d.status !== 'rejected') && quote && quote.due > 0 && (
                <div className="pay-form">
                  <Field label="Hotel validation code" hint="Guest hands over a code issued by reception.">
                    <div className="row-inline" style={{ margin: 0 }}>
                      <input className="input" placeholder="HV-XXXXXX" value={validCode}
                        onChange={e => setValidCode(e.target.value.toUpperCase())} style={{ flex: 1, fontFamily: 'monospace' }} />
                      <button className="btn btn-primary" onClick={redeem} disabled={busy || !validCode.trim()}>Redeem</button>
                    </div>
                  </Field>
                </div>
              )}
              {detail.complimentary && detail.complimentary.length > 0 && (
                <div className="comp-box">
                  <b>Complimentary:</b> {detail.complimentary[0].comp_category} · authorized by {detail.complimentary[0].authorized_by}
                  <div className="muted">{detail.complimentary[0].reason}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showLost && (
        <Modal title="Flag lost ticket" onClose={() => setShowLost(false)}>
          <div className="alert alert-warn">A <b>flat lost-ticket fee</b> will replace the normal charge. Capture the driver's ID.</div>
          <Field label="National ID / passport *"><input className="input input-lg" value={lostId} onChange={e => setLostId(e.target.value)} placeholder="e.g. 12345678" /></Field>
          <Field label="Phone (optional)"><input className="input" value={lostPhone} onChange={e => setLostPhone(e.target.value)} /></Field>
          <div className="btn-row"><button className="btn btn-primary" onClick={markLost} disabled={busy}>Flag as lost</button></div>
        </Modal>
      )}

      {showVoid && (
        <Modal title="Void session" onClose={() => setShowVoid(false)}>
          <Field label="Void reason *"><input className="input" value={voidReason} onChange={e => setVoidReason(e.target.value)} /></Field>
          <div className="btn-row"><button className="btn btn-danger" onClick={voidSession}>Confirm void</button></div>
        </Modal>
      )}

      {receipt && settings && (
        <PrintSheet title={`Receipt ${receipt.data.ticket_no}`} onClose={() => setReceipt(null)}>
          <ThermalReceipt s={receipt.data} quote={receipt.quote} payments={[...(detail?.payments || []), ...receipt.payments]} settings={settings} cashier={user?.full_name || ''} />
        </PrintSheet>
      )}
    </div>
  );
}
