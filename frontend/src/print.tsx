import React from 'react';
import { createPortal } from 'react-dom';
import { fmtDT, fmtMoney, fmtDur } from './api';
import type { HotelSettings, Session, Quote, Payment } from './types';

export function printNow() {
  document.body.classList.add('printing');
  const cleanup = () => {
    window.onafterprint = null;
    document.body.classList.remove('printing');
  };
  // afterprint fires when the dialog closes; the fallback timer covers
  // browsers where it doesn't (the snapshot is taken at print() anyway).
  window.onafterprint = cleanup;
  setTimeout(() => {
    window.print();
    setTimeout(cleanup, 1000);
  }, 60);
}

export function PrintSheet({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  // Portal to document.body: print CSS hides `.app-shell`, so the sheet
  // MUST live outside it or the printed page comes out blank.
  return createPortal(
    <div className="print-layer">
      <div className="print-toolbar no-print">
        <span>{title}</span>
        <span>
          <button className="btn btn-primary btn-sm" onClick={printNow}>🖨 Print</button>
          {' '}
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </span>
      </div>
      <div className="print-content">{children}</div>
    </div>,
    document.body
  );
}

function HotelHead({ s }: { s: HotelSettings }) {
  return (
    <div className="doc-head">
      {s.logo_data && <img className="doc-logo" src={s.logo_data} alt="logo" />}
      <div className="doc-hotel">{s.hotel_name}</div>
      {s.receipt_header ? <div className="doc-sub"><b>{s.receipt_header}</b></div> : null}
      <div className="doc-sub">{s.address}</div>
      <div className="doc-sub">{[s.phones, s.email].filter(Boolean).join(' · ')}</div>
      <div className="doc-sub">{s.parking_department} · {s.parking_location}</div>
    </div>
  );
}

export function TicketPrint({ s, settings }: { s: Session; settings: HotelSettings }) {
  return (
    <div className="ticket">
      <HotelHead s={settings} />
      <div className="doc-title">PARKING TICKET</div>
      <div className="ticket-no">{s.ticket_no}</div>
      <table className="kv">
        <tbody>
          <tr><td>Registration</td><td><b>{s.registration}</b></td></tr>
          <tr><td>Bay</td><td><b>{s.space_code || 'To be assigned'}</b></td></tr>
          <tr><td>Category</td><td>{s.category_name}</td></tr>
          <tr><td>Customer</td><td>{s.customer_name || '-'}</td></tr>
          <tr><td>Entry</td><td>{fmtDT(s.entry_time)}</td></tr>
          <tr><td>Rate</td><td>{fmtMoney(settings.daily_rate, settings.currency)} / day</td></tr>
        </tbody>
      </table>
      <div className="doc-terms">{settings.terms}</div>
      <div className="doc-foot">{settings.receipt_footer}</div>
    </div>
  );
}

export function ReceiptPrint({ s, quote, payments, settings, cashier }: {
  s: Session; quote: Quote | null; payments: Payment[]; settings: HotelSettings; cashier: string;
}) {
  const q = quote;
  return (
    <div className="ticket">
      <HotelHead s={settings} />
      <div className="doc-title">PARKING RECEIPT</div>
      <div className="ticket-no">{s.ticket_no}</div>
      <table className="kv">
        <tbody>
          <tr><td>Registration</td><td><b>{s.registration}</b></td></tr>
          <tr><td>Bay</td><td>{s.space_code || '-'}</td></tr>
          <tr><td>Category</td><td>{s.category_name}</td></tr>
          <tr><td>Entry</td><td>{fmtDT(s.entry_time)}</td></tr>
          <tr><td>Exit</td><td>{fmtDT(s.exit_time)}</td></tr>
          <tr><td>Duration</td><td>{q ? fmtDur(q.minutes) : '-'}</td></tr>
        </tbody>
      </table>
      <table className="kv">
        <tbody>
          <tr><td>Parking fee</td><td>{fmtMoney(q ? q.base : s.base_amount, settings.currency)}</td></tr>
          {(q ? q.discount : s.discount_amount) > 0 && (
            <tr><td>Discount</td><td>-{fmtMoney(q ? q.discount : s.discount_amount, settings.currency)}</td></tr>
          )}
          <tr className="total"><td>Total paid</td><td><b>{fmtMoney(q ? q.paid : s.amount_paid, settings.currency)}</b></td></tr>
        </tbody>
      </table>
      {payments.length > 0 && (
        <table className="kv">
          <tbody>
            {payments.map(p => (
              <tr key={p.id}>
                <td>{p.method.toUpperCase()}{p.reference ? ` · ${p.reference}` : ''}</td>
                <td>{fmtMoney(p.amount, settings.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="doc-sub">Served by: {cashier} · {fmtDT(s.exit_time)}</div>
      <div className="doc-foot">{settings.receipt_footer}</div>
    </div>
  );
}

export function ThermalReceipt({ s, quote, payments, settings, cashier }: {
  s: Session; quote: Quote | null; payments: Payment[]; settings: HotelSettings; cashier: string;
}) {
  const q = quote;
  const base = q ? q.base : s.base_amount, disc = q ? q.discount : s.discount_amount, paid = q ? q.paid : s.amount_paid;
  return (
    <div className="thermal">
      <div className="t-center">
        <div className="t-hotel">{settings.hotel_name}</div>
        {settings.receipt_header ? <div><b>{settings.receipt_header}</b></div> : null}
        <div>{settings.address}</div>
        <div>{[settings.phones, settings.email].filter(Boolean).join(' · ')}</div>
        <div>** PARKING RECEIPT **</div>
      </div>
      <div className="t-line" />
      <div className="t-center t-no">{s.ticket_no}</div>
      <div className="t-row"><span>Plate:</span><b>{s.registration}</b></div>
      <div className="t-row"><span>Bay:</span><span>{s.space_code || '-'}</span></div>
      <div className="t-row"><span>Category:</span><span>{s.category_name}</span></div>
      <div className="t-row"><span>Entry:</span><span>{fmtDT(s.entry_time)}</span></div>
      <div className="t-row"><span>Exit:</span><span>{fmtDT(s.exit_time)}</span></div>
      <div className="t-row"><span>Duration:</span><span>{q ? fmtDur(q.minutes) : '-'}</span></div>
      <div className="t-line" />
      <div className="t-row"><span>Parking fee</span><span>{fmtMoney(base, settings.currency)}</span></div>
      {disc > 0 && <div className="t-row"><span>Discount</span><span>-{fmtMoney(disc, settings.currency)}</span></div>}
      {payments.map(p => (
        <div className="t-row" key={p.id}><span>{p.method.toUpperCase()}{p.reference ? ` ${p.reference}` : ''}</span><span>{fmtMoney(p.amount, settings.currency)}</span></div>
      ))}
      <div className="t-line" />
      <div className="t-row t-total"><span>TOTAL PAID</span><span>{fmtMoney(paid, settings.currency)}</span></div>
      <div className="t-line" />
      <div className="t-center">
        <div>Served by {cashier}</div>
        <div>{settings.receipt_footer}</div>
      </div>
    </div>
  );
}

export function DocHead({ settings, title, meta }: { settings: HotelSettings; title: string; meta?: string }) {
  return (
    <div className="doc-head doc-head-report">
      <div className="doc-head-row">
        {settings.logo_data && <img className="doc-logo" src={settings.logo_data} alt="logo" />}
        <div>
          <div className="doc-hotel">{settings.hotel_name}</div>
          <div className="doc-sub">{settings.address} · {settings.phones}</div>
        </div>
      </div>
      <div className="doc-title">{title}</div>
      {meta && <div className="doc-sub">{meta}</div>}
    </div>
  );
}
