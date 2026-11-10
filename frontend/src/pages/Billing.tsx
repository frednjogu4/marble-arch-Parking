import React, { useEffect, useState } from 'react';
import { get, post, put, fmtMoney, fmtD, errMsg, downloadCsv } from '../api';
import { useAuth } from '../auth';
import { useToast, Field, Badge, Empty, Modal, Tabs, CenterSpin, statusTone, Money } from '../ui';
import { PrintSheet, DocHead } from '../print';
import { useSettings } from '../components/Layout';
import type { Invoice, InvoiceItem } from '../types';

const TABS = [
  { id: 'due', label: 'Due' }, { id: 'partial', label: 'Partial' },
  { id: 'overdue', label: 'Overdue' }, { id: 'paid', label: 'Paid' },
  { id: 'voided', label: 'Voided' }, { id: 'all', label: 'All' }
];

const blankItem = (): InvoiceItem => ({ description: '', quantity: 1, unit_price: 0, amount: 0 });

export default function Billing() {
  const { has } = useAuth();
  const toast = useToast();
  const settings = useSettings();
  const cur = settings?.currency || 'KES';
  const canManage = has('billing.manage');
  const [tab, setTab] = useState('due');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<Invoice | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [voidRow, setVoidRow] = useState<Invoice | null>(null);
  const [printInv, setPrintInv] = useState<any>(null);

  const [f, setF] = useState({ customer_name: '', company: '', phone: '', email: '', registration: '', due_date: '', discount_amount: '', notes: '' });
  const [items, setItems] = useState<InvoiceItem[]>([blankItem()]);
  const [pf, setPf] = useState({ amount: '', method: 'cash', reference: '', terminal: '', notes: '' });
  const [voidReason, setVoidReason] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await get<{ data: Invoice[] }>(`/api/invoices?status=${tab}&q=${encodeURIComponent(q)}`);
      setRows(r.data);
    } catch (e: any) { toast(errMsg(e), 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [tab]);
  useEffect(() => { const t = setTimeout(() => { if (q !== '') load(); }, 400); return () => clearTimeout(t); }, [q]);

  const openNew = () => {
    setEdit(null);
    setF({ customer_name: '', company: '', phone: '', email: '', registration: '', due_date: '', discount_amount: '', notes: '' });
    setItems([blankItem()]);
    setShowForm(true);
  };
  const openEdit = (inv: Invoice) => {
    setEdit(inv);
    setF({ customer_name: inv.customer_name, company: inv.company, phone: inv.phone, email: inv.email, registration: inv.registration, due_date: inv.due_date, discount_amount: String(inv.discount_amount || ''), notes: inv.notes || '' });
    setItems((inv.items && inv.items.length ? inv.items : [blankItem()]).map(i => ({ ...i })));
    setShowForm(true);
  };
  const setItem = (i: number, k: keyof InvoiceItem, v: any) => {
    setItems(items.map((it, j) => j === i ? { ...it, [k]: v } : it));
  };
  const subtotal = items.reduce((a, i) => a + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  const total = Math.max(0, subtotal - Number(f.discount_amount || 0));

  const save = async () => {
    try {
      const body: any = { ...f, discount_amount: f.discount_amount === '' ? 0 : Number(f.discount_amount), items: items.map(i => ({ description: i.description, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })) };
      if (!f.due_date) delete body.due_date;
      if (edit) await put(`/api/invoices/${edit.id}`, body);
      else await post('/api/invoices', body);
      toast(edit ? 'Invoice updated' : 'Invoice created', 'ok');
      setShowForm(false);
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const openDetail = async (id: number) => {
    try { setDetail((await get<{ data: any }>(`/api/invoices/${id}`)).data); } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const doPay = async () => {
    try {
      const r = await post<{ data: any; invoice: any }>(`/api/invoices/${pay.id}/pay`, { ...pf, amount: Number(pf.amount) });
      toast(`Payment recorded. Balance ${fmtMoney(r.invoice.balance, cur)}`, 'ok');
      setPay(null);
      setDetail(r.invoice);
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };
  const doVoid = async () => {
    try {
      await post(`/api/invoices/${voidRow!.id}/void`, { reason: voidReason });
      toast('Invoice voided', 'ok');
      setVoidRow(null); setVoidReason('');
      load();
    } catch (e: any) { toast(errMsg(e), 'err'); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>Billing & Invoices</h2>
        <div className="row-inline" style={{ margin: 0 }}>
          <button className="btn btn-sm" onClick={() => downloadCsv('invoices.csv', rows.map(r => ({ no: r.invoice_no, customer: r.customer_name, company: r.company, due: r.due_date, total: r.total, paid: r.amount_paid, balance: r.balance, status: r.display_status })))}>CSV</button>
          {canManage && <button className="btn btn-primary btn-sm" onClick={openNew}>+ New invoice</button>}
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div className="card">
        <div className="filters">
          <input className="input" placeholder="Search no / customer / company / plate…" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 260 }} />
        </div>
        {loading ? <CenterSpin /> : rows.length === 0 ? <Empty title="No invoices" hint="Nothing in this tab yet." /> : (
          <table className="table table-cards">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td data-l="Invoice"><b>{r.invoice_no}</b></td>
                  <td data-l="Customer">{r.company || r.customer_name}{r.registration ? <span className="muted"> · {r.registration}</span> : null}</td>
                  <td data-l="Due">{fmtD(r.due_date)}</td>
                  <td data-l="Total"><Money value={r.total} cur={cur} /></td>
                  <td data-l="Paid"><Money value={r.amount_paid} cur={cur} /></td>
                  <td data-l="Balance"><b><Money value={r.balance} cur={cur} /></b></td>
                  <td data-l="Status"><Badge tone={statusTone(r.display_status)}>{r.display_status}</Badge></td>
                  <td data-l="Actions" className="no-l actions">
                    <button className="btn btn-sm" onClick={() => openDetail(r.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <Modal title={edit ? `Edit ${edit.invoice_no}` : 'New invoice'} onClose={() => setShowForm(false)} wide>
          <div className="form-grid">
            <Field label="Customer name"><input className="input" value={f.customer_name} onChange={e => setF({ ...f, customer_name: e.target.value })} /></Field>
            <Field label="Company"><input className="input" value={f.company} onChange={e => setF({ ...f, company: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Email"><input className="input" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Vehicle registration (optional)"><input className="input reg-input" value={f.registration} onChange={e => setF({ ...f, registration: e.target.value })} /></Field>
            <Field label="Due date (default +7 days)"><input type="date" className="input" value={f.due_date} onChange={e => setF({ ...f, due_date: e.target.value })} /></Field>
          </div>
          <h4>Line items</h4>
          {items.map((it, i) => (
            <div className="form-grid" key={i} style={{ gridTemplateColumns: '2fr 1fr 1fr auto', alignItems: 'end' }}>
              <Field label={i === 0 ? 'Description' : ''}><input className="input" value={it.description} onChange={e => setItem(i, 'description', e.target.value)} /></Field>
              <Field label={i === 0 ? 'Qty' : ''}><input type="number" min="0" step="any" className="input" value={it.quantity} onChange={e => setItem(i, 'quantity', e.target.value)} /></Field>
              <Field label={i === 0 ? 'Unit price' : ''}><input type="number" min="0" step="any" className="input" value={it.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)} /></Field>
              <button className="btn btn-sm" onClick={() => setItems(items.filter((_, j) => j !== i))} disabled={items.length === 1}>✕</button>
            </div>
          ))}
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => setItems([...items, blankItem()])}>+ Add line</button>
          </div>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field label="Discount amount"><input type="number" min="0" step="any" className="input" value={f.discount_amount} onChange={e => setF({ ...f, discount_amount: e.target.value })} /></Field>
            <Field label="Notes"><input className="input" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></Field>
          </div>
          <table className="kv"><tbody>
            <tr><td>Subtotal</td><td><Money value={subtotal} cur={cur} /></td></tr>
            <tr className="total"><td>Total</td><td><Money value={total} cur={cur} /></td></tr>
          </tbody></table>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={save}>{edit ? 'Save changes' : 'Create invoice'}</button>
            <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={detail.invoice_no} onClose={() => setDetail(null)} wide>
          <p><Badge tone={statusTone(detail.display_status)}>{detail.display_status}</Badge> <span className="muted">Issued {fmtD(detail.issue_date)} · Due {fmtD(detail.due_date)}</span></p>
          <table className="kv"><tbody>
            <tr><td>Customer</td><td>{detail.company || detail.customer_name} {detail.phone ? `· ${detail.phone}` : ''}</td></tr>
            {detail.registration ? <tr><td>Vehicle</td><td>{detail.registration}</td></tr> : null}
            <tr><td>Subtotal</td><td><Money value={detail.subtotal} cur={cur} /></td></tr>
            <tr><td>Discount</td><td><Money value={detail.discount_amount} cur={cur} /></td></tr>
            <tr><td>Paid</td><td><Money value={detail.amount_paid} cur={cur} /></td></tr>
            <tr className="total"><td>Balance</td><td><Money value={detail.balance} cur={cur} /></td></tr>
          </tbody></table>
          <h4>Items</h4>
          <table className="table table-sm"><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead>
            <tbody>{(detail.items || []).map((i: any) => <tr key={i.id}><td>{i.description}</td><td>{i.quantity}</td><td><Money value={i.unit_price} cur={cur} /></td><td><Money value={i.amount} cur={cur} /></td></tr>)}</tbody>
          </table>
          {(detail.payments || []).length > 0 && (<><h4>Payments</h4>
            <table className="table table-sm"><thead><tr><th>#</th><th>Method</th><th>Amount</th><th>By</th></tr></thead>
              <tbody>{detail.payments.map((p: any) => <tr key={p.id}><td>{p.id}</td><td>{p.method}{p.reference ? ` · ${p.reference}` : ''}</td><td><Money value={p.amount} cur={cur} /></td><td>{p.received_by_name}</td></tr>)}</tbody>
            </table></>)}
          <div className="btn-row">
            {detail.status !== 'paid' && detail.status !== 'voided' && has('payments.collect') && <button className="btn btn-primary" onClick={() => { setPay(detail); setPf({ amount: String(detail.balance), method: 'cash', reference: '', terminal: '', notes: '' }); }}>Record payment</button>}
            {detail.status === 'unpaid' && canManage && <button className="btn" onClick={() => { setDetail(null); openEdit(detail); }}>Edit</button>}
            {detail.status !== 'voided' && detail.status !== 'paid' && canManage && <button className="btn" onClick={() => { setDetail(null); setVoidRow(detail); }}>Void</button>}
            <button className="btn" onClick={() => setPrintInv(detail)}>Print</button>
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
          </div>
        </Modal>
      )}

      {pay && (
        <Modal title={`Pay ${pay.invoice_no}`} onClose={() => setPay(null)}>
          <div className="method-tabs">
            {['cash', 'mpesa', 'card'].map(m => <button key={m} className={'method-tab' + (pf.method === m ? ' on' : '')} onClick={() => setPf({ ...pf, method: m })}>{m.toUpperCase()}</button>)}
          </div>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field label={`Amount (balance ${fmtMoney(pay.balance, cur)})`}><input type="number" min="0" step="any" className="input input-lg" value={pf.amount} onChange={e => setPf({ ...pf, amount: e.target.value })} /></Field>
            <Field label={pf.method === 'cash' ? 'Reference (optional)' : 'M-Pesa code / auth code'}><input className="input" value={pf.reference} onChange={e => setPf({ ...pf, reference: e.target.value })} /></Field>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={doPay}>Record payment</button>
            <button className="btn" onClick={() => setPay(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {voidRow && (
        <Modal title={`Void ${voidRow.invoice_no}`} onClose={() => setVoidRow(null)}>
          <Field label="Void reason (required)"><input className="input" value={voidReason} onChange={e => setVoidReason(e.target.value)} /></Field>
          <div className="btn-row">
            <button className="btn btn-danger" onClick={doVoid}>Void invoice</button>
            <button className="btn" onClick={() => setVoidRow(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {printInv && settings && (
        <PrintSheet title={printInv.invoice_no} onClose={() => setPrintInv(null)}>
          <div className="inv-doc">
            <DocHead settings={settings} title="INVOICE" meta={printInv.invoice_no} />
            <div className="inv-head">
              <div><b>{printInv.company || printInv.customer_name}</b><br />{printInv.phone} {printInv.email}<br />{printInv.registration}</div>
              <div style={{ textAlign: 'right' }}>Issued: {fmtD(printInv.issue_date)}<br />Due: {fmtD(printInv.due_date)}<br /><Badge tone={statusTone(printInv.display_status)}>{printInv.display_status}</Badge></div>
            </div>
            <table className="table table-sm"><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead>
              <tbody>{(printInv.items || []).map((i: any) => <tr key={i.id}><td>{i.description}</td><td>{i.quantity}</td><td>{fmtMoney(i.unit_price, cur)}</td><td>{fmtMoney(i.amount, cur)}</td></tr>)}</tbody>
            </table>
            <table className="kv"><tbody>
              <tr><td>Subtotal</td><td>{fmtMoney(printInv.subtotal, cur)}</td></tr>
              <tr><td>Discount</td><td>{fmtMoney(printInv.discount_amount, cur)}</td></tr>
              <tr><td>Paid</td><td>{fmtMoney(printInv.amount_paid, cur)}</td></tr>
              <tr className="total"><td>Balance due</td><td>{fmtMoney(printInv.balance, cur)}</td></tr>
            </tbody></table>
            {printInv.notes ? <p className="muted">{printInv.notes}</p> : null}
            <div className="doc-foot">{settings.receipt_footer}</div>
          </div>
        </PrintSheet>
      )}
    </div>
  );
}
