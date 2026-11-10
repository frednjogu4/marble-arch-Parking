// Shared helpers + business logic (validation, quoting, occupancy, audit).
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status || 500;
    this.code = code || 'INTERNAL';
    this.details = details;
  }
  static bad(code, message, details) { return new ApiError(400, code, message, details); }
  static unauth(message) { return new ApiError(401, 'UNAUTHENTICATED', message || 'Authentication required'); }
  static forbidden(message) { return new ApiError(403, 'FORBIDDEN', message || 'You do not have permission for this action'); }
  static notFound(what) { return new ApiError(404, 'NOT_FOUND', (what || 'Record') + ' not found'); }
  static conflict(code, message, details) { return new ApiError(409, code, message, details); }
}

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const nowIso = () => new Date().toISOString();
function todayStr(d) {
  const x = d ? new Date(d) : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
function addDaysStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const x = new Date(y, m - 1, d + Number(days));
  return todayStr(x);
}
function diffDaysStr(a, b) {
  const pa = String(a).split('-').map(Number), pb = String(b).split('-').map(Number);
  const da = new Date(pa[0], pa[1] - 1, pa[2]), dbb = new Date(pb[0], pb[1] - 1, pb[2]);
  return Math.round((dbb - da) / 86400000);
}

// Kenyan plates like KAA123A / KDQ 456B / KMFG 123A. Normalize to alnum upper.
function normalizeReg(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{2,10}$/.test(s)) throw ApiError.bad('INVALID_REGISTRATION', 'Invalid vehicle registration number');
  return s;
}
function validPhone(raw, { required = false } = {}) {
  const s = String(raw || '').trim();
  if (!s) {
    if (required) throw ApiError.bad('INVALID_PHONE', 'Phone number is required');
    return '';
  }
  if (!/^\+?[0-9][0-9 ()-]{5,17}$/.test(s)) throw ApiError.bad('INVALID_PHONE', 'Invalid phone number');
  return s.replace(/[\s()-]/g, '');
}
function validAmount(n, { min = 0, max = 100000000, name = 'Amount' } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < min || v > max) throw ApiError.bad('INVALID_AMOUNT', `${name} is invalid`);
  return round2(v);
}
function validDateStr(s, name = 'Date') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) throw ApiError.bad('INVALID_DATE', `${name} must be YYYY-MM-DD`);
  return String(s);
}

function paginate(req, def = 25, max = 200) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(max, Math.max(1, parseInt(req.query.pageSize, 10) || def));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
function pageResult(rows, total, page, pageSize) {
  return { data: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function audit(db, req, action, module, recordId, oldValue, newValue) {
  try {
    const u = (req && req.user) || {};
    db.prepare(`INSERT INTO audit_logs (user_id, username, role, action, module, record_id, old_value, new_value, ip, user_agent, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      u.id || null, u.username || '', u.role_name || '',
      action, module, recordId == null ? '' : String(recordId),
      oldValue == null ? '' : String(oldValue).slice(0, 4000),
      newValue == null ? '' : String(newValue).slice(0, 4000),
      (req && (req.ip || (req.connection && req.connection.remoteAddress))) || '',
      (req && req.headers && String(req.headers['user-agent'] || '').slice(0, 300)) || '',
      nowIso()
    );
  } catch (e) { console.error('audit failed:', e.message); }
}

function notify(db, { type, title, message, link, audience_role, user_id }) {
  try {
    db.prepare(`INSERT INTO notifications (type, title, message, link, audience_role, user_id, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(type, title, message || '', link || '', audience_role || '', user_id || null, nowIso());
  } catch (e) { console.error('notify failed:', e.message); }
}

function getSettings(db) {
  return db.prepare('SELECT * FROM hotel_settings WHERE id = 1').get();
}

function getOpenShift(db, userId) {
  return db.prepare('SELECT * FROM shifts WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(userId, 'open') || null;
}

function userPublic(u) {
  if (!u) return null;
  return {
    id: u.id, full_name: u.full_name, username: u.username, email: u.email,
    phone: u.phone, role_id: u.role_id, role_name: u.role_name, active: u.active,
    must_change_password: u.must_change_password, created_at: u.created_at
  };
}

// Mark past-expiry subscriptions expired (idempotent). Returns count changed.
function refreshExpiredSubs(db) {
  const t = todayStr();
  const r = db.prepare(`UPDATE monthly_subscriptions SET status='expired', updated_at=?
    WHERE status='active' AND expiry_date < ?`).run(nowIso(), t);
  return r.changes;
}

function findActiveSub(db, registration, dateStr) {
  const d = dateStr || todayStr();
  return db.prepare(`SELECT s.*, p.name AS package_name, p.price AS package_price, p.reserved_space, p.validity_days
    FROM monthly_subscriptions s JOIN monthly_packages p ON p.id = s.package_id
    WHERE s.registration = ? AND s.status = 'active' AND s.start_date <= ? AND s.expiry_date >= ?
    ORDER BY s.expiry_date DESC LIMIT 1`).get(registration, d, d) || null;
}

function sessionById(db, id) {
  return db.prepare(`SELECT s.*, c.code AS category_code, c.name AS category_name, c.kind AS category_kind,
      c.hourly_rate AS category_hourly_rate, c.daily_rate AS category_daily_rate,
      c.max_charge AS category_max_charge, c.grace_minutes AS category_grace_minutes,
      sp.code AS space_code, sp.zone AS space_zone
    FROM parking_sessions s
    JOIN parking_categories c ON c.id = s.category_id
    LEFT JOIN parking_spaces sp ON sp.id = s.space_id
    WHERE s.id = ?`).get(id) || null;
}

// Full fee quote for a session at a given moment. Pure read (no writes).
function quoteSession(db, sessionId, atIso) {
  const s = sessionById(db, sessionId);
  if (!s) throw ApiError.notFound('Parking session');
  const settings = getSettings(db);
  const at = atIso ? new Date(atIso) : new Date();
  const entry = new Date(s.entry_time);
  const minutes = Math.max(0, Math.floor((at - entry) / 60000));
  const hoursExact = minutes / 60;

  const eff = (sess) => ({
    hourly: sess.category_hourly_rate != null ? sess.category_hourly_rate : settings.hourly_rate,
    daily: sess.category_daily_rate != null ? sess.category_daily_rate : settings.daily_rate,
    grace: sess.category_grace_minutes != null ? sess.category_grace_minutes : (settings.grace_period_minutes || 0),
    max: sess.category_max_charge != null ? sess.category_max_charge : null
  });
  let base = 0, baseReason = '', rate = settings.daily_rate, days = 0, hours = 0, monthlySub = null, capped = false;
  if (s.category_kind === 'complimentary') {
    baseReason = 'complimentary';
  } else {
    monthlySub = s.monthly_subscription_id
      ? db.prepare('SELECT * FROM monthly_subscriptions WHERE id = ?').get(s.monthly_subscription_id)
      : findActiveSub(db, s.registration, todayStr(at));
    const covered = monthlySub && monthlySub.status === 'active' &&
      monthlySub.start_date <= todayStr(at) && monthlySub.expiry_date >= todayStr(at);
    if (covered) {
      baseReason = 'monthly';
    } else if (s.lost_ticket) {
      base = round2(settings.lost_ticket_fee != null ? settings.lost_ticket_fee : 1000);
      baseReason = 'lost';
      rate = base;
    } else if (minutes <= (eff(s).grace)) {
      baseReason = 'grace';
    } else if (s.category_code === 'hourly' && settings.hourly_enabled) {
      hours = Math.max(1, Math.ceil(hoursExact));
      rate = eff(s).hourly;
      base = round2(hours * rate);
      baseReason = 'hourly';
    } else {
      days = Math.max(1, Math.ceil(minutes / 1440));
      rate = eff(s).daily;
      base = round2(days * rate);
      baseReason = 'daily';
    }
    const cap = eff(s).max;
    if (cap != null && cap > 0 && base > cap) { base = round2(cap); capped = true; }
  }

  const d = db.prepare(`SELECT COALESCE(SUM(discount_amount),0) t FROM discounts
    WHERE session_id = ? AND status IN ('applied','approved')`).get(sessionId).t || 0;
  const p = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM payments
    WHERE session_id = ? AND verification_status IN ('verified','manual')`).get(sessionId).t || 0;
  const discount = round2(d), paid = round2(p);
  const due = Math.max(0, round2(base - discount - paid));
  const pendingDiscounts = db.prepare(`SELECT COUNT(*) c FROM discounts WHERE session_id = ? AND status = 'pending'`).get(sessionId).c;

  return {
    session_id: s.id, ticket_no: s.ticket_no, registration: s.registration,
    entry_time: s.entry_time, minutes, hours, days, rate: round2(rate),
    base: round2(base), base_reason: baseReason, rate_capped: capped, discount, paid, due,
    monthly_covered: baseReason === 'monthly',
    monthly_subscription_id: monthlySub ? monthlySub.id : null,
    category: { code: s.category_code, name: s.category_name, kind: s.category_kind },
    pending_discounts: pendingDiscounts
  };
}

function occSummary(db) {
  const total = db.prepare('SELECT COUNT(*) c FROM parking_spaces').get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM parking_spaces GROUP BY status').all();
  const m = { available: 0, occupied: 0, reserved: 0, out_of_service: 0 };
  for (const r of byStatus) m[r.status] = r.c;
  const paid = db.prepare(`SELECT COUNT(*) c FROM parking_sessions s JOIN parking_categories c ON c.id = s.category_id
    WHERE s.status='active' AND c.kind='paid' AND s.monthly_subscription_id IS NULL`).get().c;
  const comp = db.prepare(`SELECT COUNT(*) c FROM parking_sessions s JOIN parking_categories c ON c.id = s.category_id
    WHERE s.status='active' AND c.kind='complimentary'`).get().c;
  const monthly = db.prepare(`SELECT COUNT(*) c FROM parking_sessions WHERE status='active' AND monthly_subscription_id IS NOT NULL`).get().c;
  return {
    total, occupied: m.occupied, available: m.available, reserved: m.reserved, out_of_service: m.out_of_service,
    paid, complimentary: comp, monthly, active_sessions: paid + comp + monthly
  };
}

function nextTicketNo(db, entryTime) {
  const dayDate = entryTime ? todayStr(new Date(entryTime)) : todayStr();
  const day = dayDate.replace(/-/g, '');
  const prefix = `MA-${day}-`;
  // Sequence is derived from existing ticket numbers for this day label —
  // NEVER from COUNT over entry_time: stored timestamps are UTC while the
  // day label is local time, so a COUNT filter miscounts near midnight and
  // re-issues an existing number (UNIQUE violation -> 500).
  const row = db.prepare('SELECT ticket_no FROM parking_sessions WHERE ticket_no LIKE ? ORDER BY ticket_no DESC LIMIT 1').get(prefix + '%');
  let n = 0;
  if (row && row.ticket_no) {
    const m = /-(\d+)$/.exec(row.ticket_no);
    if (m) n = parseInt(m[1], 10) || 0;
  }
  return `${prefix}${String(n + 1).padStart(4, '0')}`;
}

// Recompute paid/discount/status totals for an ACTIVE session after payment changes.
function recomputeSessionTotals(db, sessionId) {
  const s = sessionById(db, sessionId);
  if (!s || s.status !== 'active') return;
  const q = quoteSession(db, sessionId);
  const payment_status = s.category_kind === 'complimentary' ? 'complimentary'
    : q.due <= 0 && (q.base > 0 || q.monthly_covered) && q.paid + q.discount > 0 || q.due <= 0 && q.base === 0 && (q.base_reason === 'monthly' || q.base_reason === 'grace')
      ? (q.base === 0 ? (q.base_reason === 'monthly' || q.base_reason === 'grace' ? 'paid' : 'unpaid') : 'paid')
      : q.paid > 0 ? 'partial' : 'unpaid';
  db.prepare('UPDATE parking_sessions SET base_amount=?, discount_amount=?, amount_paid=?, payment_status=?, updated_at=? WHERE id=?')
    .run(q.base, q.discount, q.paid, payment_status, nowIso(), sessionId);
}

function recordPayment(db, { session_id = null, subscription_id = null, invoice_id = null, amount, method, reference = '', verification_status, terminal = '', shift_id = null, received_by, paid_at = null, notes = '' }) {
  const ref = String(reference || '').trim();
  // An M-Pesa code / card auth represents real money: each reference may be
  // recorded only once, otherwise the same money is double-counted as
  // revenue. Cash carries no money-identifier so it is exempt, as is the
  // STK-PENDING placeholder (replaced by the real receipt on callback).
  if ((method === 'mpesa' || method === 'card') && ref !== '' && ref !== 'STK-PENDING') {
    const dup = db.prepare('SELECT id FROM payments WHERE reference = ? LIMIT 1').get(ref);
    if (dup) throw ApiError.conflict('DUPLICATE_REFERENCE', `Reference ${ref} was already recorded (payment #${dup.id}). Each M-Pesa/card reference can only be used once.`);
  }
  const at = paid_at || nowIso();
  const r = db.prepare(`INSERT INTO payments (session_id, subscription_id, invoice_id, amount, method, reference, verification_status, terminal, shift_id, received_by, paid_at, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(session_id, subscription_id, invoice_id, round2(amount), method, reference || '', verification_status, terminal || '', shift_id, received_by, at, notes || '', nowIso());
  const paymentId = Number(r.lastInsertRowid);
  if (shift_id) {
    db.prepare('INSERT INTO shift_transactions (shift_id, payment_id, created_at) VALUES (?,?,?)').run(shift_id, paymentId, nowIso());
  }
  if (subscription_id) {
    db.prepare(`INSERT INTO subscription_payments (subscription_id, amount, method, reference, shift_id, paid_at, received_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(subscription_id, round2(amount), method, reference || '', shift_id, at, received_by, nowIso());
  }
  if (session_id) recomputeSessionTotals(db, session_id);
  if (invoice_id) recomputeInvoice(db, invoice_id);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}

function nextInvoiceNo(db, dateStr) {
  const dayDate = dateStr || todayStr();
  const day = dayDate.replace(/-/g, '');
  const prefix = `INV-${day}-`;
  const row = db.prepare('SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1').get(prefix + '%');
  let n = 0;
  if (row && row.invoice_no) {
    const m = /-(\d+)$/.exec(row.invoice_no);
    if (m) n = parseInt(m[1], 10) || 0;
  }
  return `${prefix}${String(n + 1).padStart(4, '0')}`;
}

function invoiceById(db, id) {
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) || null;
}

function invoiceDisplay(inv, today) {
  const t = today || todayStr();
  if (!inv) return null;
  const overdue = inv.status !== 'paid' && inv.status !== 'voided' && inv.due_date && inv.due_date < t;
  return { ...inv, display_status: overdue ? 'overdue' : inv.status, overdue: Boolean(overdue) };
}

// Recompute paid/balance/status from settled payments. Pure totals (no writes beyond the row).
function recomputeInvoice(db, id) {
  const inv = invoiceById(db, id);
  if (!inv || inv.status === 'voided') return inv;
  const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM payments
    WHERE invoice_id = ? AND verification_status IN ('verified','manual')`).get(id).t || 0;
  const paidR = round2(paid), balance = round2(Math.max(0, inv.total - paidR));
  const status = balance <= 0 ? 'paid' : (paidR > 0 ? 'partial' : 'unpaid');
  db.prepare('UPDATE invoices SET amount_paid = ?, balance = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(paidR, balance, status, nowIso(), id);
  return invoiceById(db, id);
}

// Hotel validation code: HV- + 6 unambiguous chars. Retried until unique.
function nextValidationCode(db) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = 'HV-';
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const dup = db.prepare('SELECT id FROM validation_codes WHERE code = ?').get(code);
    if (!dup) return code;
  }
  throw ApiError.conflict('CODE_COLLISION', 'Could not mint a unique validation code, try again');
}

module.exports = {
  ApiError, ah, round2, nowIso, todayStr, addDaysStr, diffDaysStr,
  normalizeReg, validPhone, validAmount, validDateStr,
  paginate, pageResult, audit, notify, getSettings, getOpenShift, userPublic,
  refreshExpiredSubs, findActiveSub, sessionById, quoteSession, occSummary,
  nextTicketNo, nextValidationCode, nextInvoiceNo, invoiceById, invoiceDisplay, recomputeInvoice, recomputeSessionTotals, recordPayment
};
