// Client-side PDF generation (hotel letterhead) + mobile sharing.
// Share uses the Web Share API so phones can send the actual PDF file into
// WhatsApp, Email, etc. Fallbacks (download + text links) cover the rest.
import type { HotelSettings } from './types';
import { fmtMoney, fmtDT, fmtD } from './api';

export interface PdfSection { heading?: string; head: string[]; body: (string | number)[][] }
export interface PdfOpts {
  settings: HotelSettings | null;
  title: string;
  meta?: string;
  stats?: string[];
  sections: PdfSection[];
}

export async function buildPdf(o: PdfOpts): Promise<Blob> {
  const [{ default: JsPDF }, atMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = ((atMod as any).default || (atMod as any)) as any;
  const doc: any = new (JsPDF as any)({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const s = o.settings;
  let y = 46;

  const hasLogo = !!(s?.logo_data && (
    s.logo_data.startsWith('data:image/png') ||
    s.logo_data.startsWith('data:image/jpeg') ||
    s.logo_data.startsWith('data:image/jpg')));
  if (hasLogo) {
    try {
      const fmt = s!.logo_data.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      doc.addImage(s!.logo_data, fmt, M, y - 14, 44, 44);
    } catch { /* skip logo */ }
  }
  const tx = M + (hasLogo ? 54 : 0);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(14, 42, 71);
  doc.text(s?.hotel_name || 'Marble Arch Hotel Nairobi', tx, y + 4);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100, 112, 128);
  const sub = [s?.address, s?.phones].filter(Boolean).join(' · ');
  if (sub) doc.text(String(sub).slice(0, 100), tx, y + 18);
  y += 46;
  doc.setDrawColor(201, 162, 39); doc.setLineWidth(2);
  doc.line(M, y, W - M, y); y += 18;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(14, 42, 71);
  doc.text(o.title, M, y); y += 14;
  if (o.meta) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100, 112, 128);
    doc.text(o.meta.slice(0, 150), M, y); y += 12;
  }
  if (o.stats && o.stats.length) {
    doc.setFontSize(10); doc.setTextColor(28, 39, 51);
    for (const line of o.stats) {
      if (y > H - 60) { doc.addPage(); y = 50; }
      doc.text('•  ' + line.slice(0, 115), M, y); y += 13;
    }
    y += 4;
  }
  for (const sec of o.sections) {
    if (sec.heading) {
      if (y > H - 90) { doc.addPage(); y = 50; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(14, 42, 71);
      doc.text(sec.heading, M, y); y += 8;
    }
    if (sec.head.length && sec.body.length) {
      autoTable(doc, {
        startY: y,
        head: [sec.head],
        body: sec.body,
        margin: { left: M, right: M },
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [14, 42, 71], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [247, 249, 252] }
      });
      y = doc.lastAutoTable.finalY + 16;
    } else if (sec.heading) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(130, 140, 155);
      doc.text('No records.', M, y + 2); y += 22;
    }
  }
  const pages = doc.getNumberOfPages();
  const foot = `${s?.receipt_footer || ''}  ·  Generated ${new Date().toLocaleString('en-GB')}`.slice(0, 130);
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setTextColor(140, 150, 165);
    doc.text(foot, M, H - 24);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 24, { align: 'right' });
  }
  return doc.output('blob') as Blob;
}

// ---------------- sharing ----------------
export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

// Clipboard copy with legacy fallback (sandboxed iframes may block the async API).
export async function copyText(text: string): Promise<boolean> {
  try {
    const nav: any = navigator;
    if (nav.clipboard && nav.clipboard.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Print a PDF blob via a hidden iframe. Works even where downloads are
// blocked: the print dialog's "Save as PDF" destination still yields a file.
export function printPdfBlob(blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, url?: string, frame?: HTMLIFrameElement) => {
      if (settled) return;
      settled = true;
      setTimeout(() => {
        try { frame?.remove(); } catch { /* noop */ }
        if (url) URL.revokeObjectURL(url);
      }, 2000);
      resolve(ok);
    };
    try {
      const url = URL.createObjectURL(blob);
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
      const bail = setTimeout(() => done(false, url, f), 10000);
      f.onload = () => {
        try {
          const w = f.contentWindow;
          if (!w) { clearTimeout(bail); done(false, url, f); return; }
          w.focus();
          setTimeout(() => {
            clearTimeout(bail);
            try { w.print(); done(true, url, f); }
            catch { done(false, url, f); }
          }, 500);
        } catch { clearTimeout(bail); done(false, url, f); }
      };
      (f as any).onerror = () => { clearTimeout(bail); done(false, url, f); };
      document.body.appendChild(f);
      f.src = url;
    } catch {
      done(false);
    }
  });
}
export async function sharePdfFile(blob: Blob, filename: string, title: string, text: string): Promise<'shared' | 'dismissed' | 'unsupported'> {
  // 'shared' | 'dismissed' (user cancelled) | 'unsupported' (use fallbacks)
  try {
    const nav: any = navigator;
    if (!nav.share) return 'unsupported';
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (nav.canShare && !nav.canShare({ files: [file] })) {
      await nav.share({ title, text }); // text-only share where files unsupported
      return 'shared';
    }
    await nav.share({ files: [file], title, text });
    return 'shared';
  } catch (e: any) {
    if (e && e.name === 'AbortError') return 'dismissed';
    return 'unsupported';
  }
}

export const whatsappShareUrl = (text: string) => 'https://wa.me/?text=' + encodeURIComponent(text);
export const emailShareUrl = (subject: string, body: string) =>
  `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

// ---------------- report -> PDF sections ----------------
const dash = (v: any) => (v == null || v === '' ? '-' : String(v));

export function reportSections(id: string, out: any, cur: string): { stats: string[]; sections: PdfSection[] } {
  if (['daily', 'weekly', 'monthly'].includes(id)) {
    const byDay: Record<string, any> = {};
    for (const r of out.revenue_by_day_method || []) {
      byDay[r.d] = byDay[r.d] || { d: r.d, cash: 0, mpesa: 0, card: 0 };
      byDay[r.d][r.method] = Number(r.t);
    }
    const traffic: Record<string, any> = {};
    for (const t of out.traffic || []) traffic[t.d] = t;
    let gt = 0, te = 0, tx = 0;
    const rows = Object.values(byDay).map((d: any) => {
      const t = d.cash + d.mpesa + d.card;
      gt += t; te += traffic[d.d]?.entries || 0; tx += traffic[d.d]?.exits || 0;
      return [fmtD(d.d), fmtMoney(d.cash, cur), fmtMoney(d.mpesa, cur), fmtMoney(d.card, cur), fmtMoney(t, cur), traffic[d.d]?.entries || 0, traffic[d.d]?.exits || 0];
    });
    const compN = (out.complimentary || []).reduce((a: number, c: any) => a + Number(c.n || 0), 0);
    const sections: PdfSection[] = [{
      heading: 'Revenue by day',
      head: ['Day', 'Cash', 'M-Pesa', 'Card', 'Total', 'Entries', 'Exits'], body: rows
    }];
    if (out.complimentary?.length) {
      sections.push({
        heading: 'Complimentary by day', head: ['Day', 'Vehicles'],
        body: out.complimentary.map((c: any) => [fmtD(c.d), c.n])
      });
    }
    return { stats: [`Total revenue: ${fmtMoney(gt, cur)}`, `Entries: ${te} · Exits: ${tx}`, `Complimentary vehicles: ${compN}`], sections };
  }
  if (['revenue', 'cash', 'mpesa', 'card'].includes(id)) {
    const settled = (out.totals || []).filter((t: any) => ['verified', 'manual'].includes(t.verification_status));
    const gross = settled.reduce((a: number, t: any) => a + Number(t.t), 0);
    const stats = [
      ...settled.map((t: any) => `${t.method} · ${t.verification_status}: ${fmtMoney(t.t, cur)} (${t.n})`),
      `Refunds (processed): ${fmtMoney(out.refunds_total, cur)}`,
      `Net revenue: ${fmtMoney(gross - Number(out.refunds_total || 0), cur)}`
    ];
    const sections: PdfSection[] = [{
      heading: 'Payments',
      head: ['Time', 'Ticket', 'Method', 'Amount', 'Ref', 'Verification', 'By'],
      body: (out.rows || []).map((p: any) => [fmtDT(p.paid_at), dash(p.ticket_no), p.method, fmtMoney(p.amount, cur), dash(p.reference), p.verification_status, dash(p.received_by_name)])
    }];
    if (id === 'mpesa' && out.transactions?.length) {
      sections.push({
        heading: 'STK transactions',
        head: ['ID', 'Ticket', 'Phone', 'Amount', 'Receipt', 'Status'],
        body: out.transactions.map((t: any) => ['#' + t.id, dash(t.ticket_no), dash(t.phone), fmtMoney(t.amount, cur), dash(t.mpesa_receipt), t.status])
      });
    }
    return { stats, sections };
  }
  if (id === 'shifts') {
    return {
      stats: [`Shifts: ${(out.rows || []).length}`],
      sections: [
        {
          heading: 'Shifts', head: ['ID', 'User', 'Station', 'Opened', 'Closed', 'Status'],
          body: (out.rows || []).map((s: any) => ['#' + s.id, dash(s.username), dash(s.station), fmtDT(s.opened_at), fmtDT(s.closed_at), s.status])
        },
        {
          heading: 'Shift amounts (expected / actual)',
          head: ['ID', 'Exp Cash', 'Act Cash', 'Exp M-Pesa', 'Act M-Pesa', 'Exp Card', 'Act Card'],
          body: (out.rows || []).map((s: any) => ['#' + s.id, fmtMoney(s.expected_cash, cur), fmtMoney(s.actual_cash, cur), fmtMoney(s.expected_mpesa, cur), fmtMoney(s.actual_mpesa, cur), fmtMoney(s.expected_card, cur), fmtMoney(s.actual_card, cur)])
        }
      ]
    };
  }
  if (id === 'variance') {
    const tot = (out.rows || []).reduce((a: number, s: any) => a + Number(s.variance || 0), 0);
    return {
      stats: [`Shifts with variance: ${(out.rows || []).length}`, `Total variance: ${fmtMoney(tot, cur)}`],
      sections: [{
        heading: 'Variances', head: ['Shift', 'User', 'Closed', 'Variance', 'Explanation'],
        body: (out.rows || []).map((s: any) => ['#' + s.id, dash(s.username), fmtDT(s.closed_at), fmtMoney(s.variance, cur), dash(s.variance_note)])
      }]
    };
  }
  if (id === 'complimentary') {
    const total = (out.by_category || []).reduce((a: number, c: any) => a + Number(c.n || 0), 0);
    return {
      stats: [...(out.by_category || []).map((c: any) => `${c.comp_category}: ${c.n}`), `Total complimentary: ${total} · Revenue impact: ${fmtMoney(0, cur)}`],
      sections: [{
        heading: 'Complimentary records',
        head: ['Time', 'Ticket', 'Reg', 'Category', 'Authorized by', 'Recorded by'],
        body: (out.rows || []).map((r: any) => [fmtDT(r.created_at), dash(r.ticket_no), dash(r.registration), dash(r.comp_category), dash(r.authorized_by), dash(r.recorded_by_name)])
      }]
    };
  }
  if (id === 'monthly-customers') {
    return {
      stats: [`Subscription revenue in period: ${fmtMoney(out.revenue, cur)}`, `Records: ${(out.rows || []).length}`],
      sections: [{
        heading: 'Monthly customers',
        head: ['Customer', 'Reg', 'Package', 'Period', 'Days left', 'Status'],
        body: (out.rows || []).map((s: any) => [dash(s.customer_name), dash(s.registration), dash(s.package_name), `${s.start_date} → ${s.expiry_date}`, dash(s.days_remaining), s.status])
      }]
    };
  }
  if (id === 'vehicle-history') {
    return {
      stats: [`Registration: ${out.registration}`, `Visits: ${out.visits}`, `Total paid: ${fmtMoney(out.total_paid, cur)}`],
      sections: [{
        heading: 'Visits',
        head: ['Ticket', 'Entry', 'Exit', 'Category', 'Paid'],
        body: (out.rows || []).map((s: any) => [dash(s.ticket_no), fmtDT(s.entry_time), fmtDT(s.exit_time), dash(s.category_name), fmtMoney(s.amount_paid, cur)])
      }]
    };
  }
  if (id === 'occupancy') {
    const o = out.snapshot || {};
    return {
      stats: [`Total: ${o.total ?? '-'} · Occupied: ${o.occupied ?? '-'} · Available: ${o.available ?? '-'}`,
        `Paid ${o.paid ?? 0} · Complimentary ${o.complimentary ?? 0} · Monthly ${o.monthly ?? 0}`],
      sections: [{
        heading: 'Entries by hour', head: ['Hour', 'Entries'],
        body: (out.entries_by_hour || []).map((r: any) => [`${r.h}:00`, r.entries])
      }]
    };
  }
  if (id === 'user-activity') {
    return {
      stats: [`Action groups: ${(out.rows || []).length}`, `Login events: ${(out.logins || []).length}`],
      sections: [
        {
          heading: 'Actions by user', head: ['User', 'Role', 'Action', 'Count', 'Last'],
          body: (out.rows || []).map((r: any) => [dash(r.username), dash(r.role), dash(r.action), r.n, fmtDT(r.last_at)])
        },
        {
          heading: 'Logins', head: ['Time', 'User', 'Action'],
          body: (out.logins || []).map((r: any) => [fmtDT(r.created_at), dash(r.username), dash(r.action)])
        }
      ]
    };
  }
  if (id === 'discounts') {
    const tot = (out.rows || []).reduce((a: number, r: any) => a + Number(r.discount_amount || 0), 0);
    const pend = (out.rows || []).filter((r: any) => r.status === 'pending').length;
    return {
      stats: [`Total discounts: ${fmtMoney(tot, cur)} (${(out.rows || []).length})`, `Pending approval: ${pend}`],
      sections: [{
        heading: 'Discounts', head: ['Time', 'Ticket', 'Original', 'Discount', 'Reason', 'By', 'Status'],
        body: (out.rows || []).map((r: any) => [fmtDT(r.created_at), dash(r.ticket_no), fmtMoney(r.original_amount, cur), fmtMoney(r.discount_amount, cur), dash(r.reason), dash(r.applied_by_name), r.status])
      }]
    };
  }
  if (id === 'refunds') {
    const tot = (out.rows || []).reduce((a: number, r: any) => a + Number(r.amount || 0), 0);
    return {
      stats: [`Total refunds: ${fmtMoney(tot, cur)} (${(out.rows || []).length})`],
      sections: [{
        heading: 'Refunds', head: ['Time', 'Ticket', 'Amount', 'Reason', 'By', 'Status'],
        body: (out.rows || []).map((r: any) => [fmtDT(r.created_at), dash(r.ticket_no), fmtMoney(r.amount, cur), dash(r.reason), dash(r.requested_by_name), r.status])
      }]
    };
  }
  if (id === 'audit') {
    return {
      stats: [`Records shown: ${(out.data || []).length}${out.total ? ` of ${out.total}` : ''}`],
      sections: [{
        heading: 'Audit trail', head: ['Time', 'User', 'Action', 'Module', 'Record'],
        body: (out.data || []).map((r: any) => [fmtDT(r.created_at), dash(r.username), dash(r.action), dash(r.module), dash(r.record_id)])
      }]
    };
  }
  return { stats: [], sections: [] };
}

export function reportSummaryText(title: string, meta: string, stats: string[], rowCount: number, hotel?: string): string {
  return [`*${title}*`, meta, '', ...stats, `Records: ${rowCount}`, `— ${hotel || 'Marble Arch Hotel Nairobi Parking'}`].join('\n');
}

// ---------------- reconciliation ----------------
export function reconPdfData(c: any, s: any, cur: string): { stats: string[]; sections: PdfSection[] } {
  const r = s || c;
  const net = Number(r.total_revenue || 0) - Number(r.refunds_total || 0);
  const stats = [
    `Total revenue: ${fmtMoney(r.total_revenue, cur)}`,
    `Net revenue: ${fmtMoney(net, cur)}`,
    `Status: ${String(s?.status || 'not saved').replace(/_/g, ' ')}`
  ];
  const sections: PdfSection[] = [
    {
      heading: 'Revenue', head: ['Item', 'Amount'],
      body: [
        ['Cash', fmtMoney(r.total_cash, cur)],
        ['M-Pesa', fmtMoney(r.total_mpesa, cur)],
        ['Card', fmtMoney(r.total_card, cur)],
        ['TOTAL REVENUE', fmtMoney(r.total_revenue, cur)],
        ['Refunds (processed)', '-' + fmtMoney(r.refunds_total, cur)],
        ['NET REVENUE', fmtMoney(net, cur)],
        ['Discounts given', fmtMoney(r.discounts_total, cur)],
        ['Shift variance', fmtMoney(r.variance, cur)]
      ]
    },
    {
      heading: 'Vehicles', head: ['Category', 'Count'],
      body: [
        ['Paid', String(r.paid_vehicles ?? 0)],
        ['Complimentary', String(r.complimentary_vehicles ?? 0)],
        ['Monthly', String(r.monthly_vehicles ?? 0)],
        ['Entered', String(r.entered_vehicles ?? r.total_vehicles ?? 0)],
        ...(r.exited_vehicles != null ? [['Exited', String(r.exited_vehicles)]] : [])
      ]
    }
  ];
  if (s) {
    sections.push({
      heading: 'Approvals', head: ['Stage', 'By', 'At'],
      body: [
        ['Supervisor', s.supervisor_name || '-', s.supervisor_at ? fmtDT(s.supervisor_at) : '-'],
        ['Controller', s.controller_name || '-', s.controller_at ? fmtDT(s.controller_at) : '-'],
        ['Manager (finalize)', s.manager_name || '-', s.manager_at ? fmtDT(s.manager_at) : '-']
      ]
    });
  }
  return { stats, sections };
}

export function reconSummary(date: string, c: any, s: any, cur: string, hotel?: string): string {
  const r = s || c;
  return [
    `*Daily Reconciliation — ${date}*`,
    `Status: ${String(s?.status || 'not saved').replace(/_/g, ' ')}`,
    `Revenue: ${fmtMoney(r.total_revenue, cur)} (cash ${fmtMoney(r.total_cash, cur)} · mpesa ${fmtMoney(r.total_mpesa, cur)} · card ${fmtMoney(r.total_card, cur)})`,
    `Vehicles: paid ${r.paid_vehicles ?? 0} · comp ${r.complimentary_vehicles ?? 0} · monthly ${r.monthly_vehicles ?? 0}`,
    `Variance: ${fmtMoney(r.variance, cur)}`,
    `— ${hotel || 'Marble Arch Hotel Nairobi Parking'}`
  ].join('\n');
}
