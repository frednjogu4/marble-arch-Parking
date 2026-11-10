// Operational routes: sessions, payments, M-Pesa, monthly, shifts, recon, reports.
const L = require('./lib');
const mpesa = require('./mpesa');

const VEHICLE_TYPES = ['Saloon', 'SUV', 'Pickup', 'Van', 'Truck', 'Motorcycle', 'Other'];
const COMP_CATS = ['accommodation', 'restaurant', 'bar', 'conference', 'staff', 'management', 'vip', 'authorized', 'official'];
const PAY_METHODS = ['cash', 'mpesa', 'card'];

function registerOpsRoutes(app, ctx) {
  const { db, requireAuth, requirePerm } = ctx;
  const hasPerm = (req, code) => (req.user.permissions || []).includes(code);

  const sessionDetail = id => {
    const s = L.sessionById(db, id);
    if (!s) return null;
    s.payments = db.prepare(`SELECT p.*, u.username AS received_by_name FROM payments p
      LEFT JOIN users u ON u.id = p.received_by WHERE p.session_id = ? ORDER BY p.id`).all(id);
    s.discounts = db.prepare(`SELECT d.*, u1.username AS applied_by_name, u2.username AS approved_by_name, pr.name AS promotion_name
      FROM discounts d LEFT JOIN users u1 ON u1.id = d.applied_by LEFT JOIN users u2 ON u2.id = d.approved_by
      LEFT JOIN promotions pr ON pr.id = d.promotion_id WHERE d.session_id = ? ORDER BY d.id`).all(id);
    s.complimentary = db.prepare('SELECT * FROM complimentary_authorizations WHERE session_id = ?').all(id);
    if (s.monthly_subscription_id) s.monthly_subscription = db.prepare('SELECT * FROM monthly_subscriptions WHERE id = ?').get(s.monthly_subscription_id);
    return s;
  };

  const findCustomer = (name, phone) => {
    if (phone) {
      const c = db.prepare('SELECT * FROM customers WHERE phone = ? AND deleted_at IS NULL').get(phone);
      if (c) return c;
    }
    if (name) return db.prepare('SELECT * FROM customers WHERE lower(name) = lower(?) AND deleted_at IS NULL').get(name) || null;
    return null;
  };

  // ================= VEHICLE ENTRY =================
  app.post('/api/sessions/entry', requireAuth, requirePerm('sessions.entry'), L.ah(async (req, res) => {
    const b = req.body || {};
    const registration = L.normalizeReg(b.registration);
    const vehicle_type = VEHICLE_TYPES.includes(b.vehicle_type) ? b.vehicle_type : 'Saloon';
    const customer_name = String(b.customer_name || '').trim();
    const phone = L.validPhone(b.phone || '');
    const category = db.prepare('SELECT * FROM parking_categories WHERE id = ? AND active = 1').get(b.category_id);
    if (!category) throw L.ApiError.bad('INVALID_CATEGORY', 'Invalid parking category');
    const override = Boolean(b.override);

    L.refreshExpiredSubs(db);

    const doEntry = db.transaction(() => {
      // Vehicle + customer linkage.
      let vehicle = db.prepare('SELECT * FROM vehicles WHERE registration = ?').get(registration);
      let customer = findCustomer(customer_name, phone);
      if (!customer && (customer_name || phone)) {
        const now = L.nowIso();
        const r = db.prepare('INSERT INTO customers (name, phone, customer_type, created_at, updated_at) VALUES (?,?,?,?,?)')
          .run(customer_name || registration, phone || '', 'casual', now, now);
        customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(r.lastInsertRowid));
      }
      if (!vehicle) {
        const now = L.nowIso();
        const vMake = String(b.vehicle_make || '').trim().slice(0, 60), vModel = String(b.vehicle_model || '').trim().slice(0, 60), vColor = String(b.vehicle_color || '').trim().slice(0, 40);
        const r = db.prepare('INSERT INTO vehicles (registration, vehicle_type, make, model, color, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(registration, vehicle_type, vMake, vModel, vColor, customer ? customer.id : null, now, now);
        vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(r.lastInsertRowid));
      } else {
        const uMake = String(b.vehicle_make || '').trim().slice(0, 60), uModel = String(b.vehicle_model || '').trim().slice(0, 60), uColor = String(b.vehicle_color || '').trim().slice(0, 40);
        db.prepare('UPDATE vehicles SET vehicle_type = ?, customer_id = COALESCE(customer_id, ?), make = CASE WHEN ? = ? THEN make ELSE ? END, model = CASE WHEN ? = ? THEN model ELSE ? END, color = CASE WHEN ? = ? THEN color ELSE ? END, updated_at = ? WHERE id = ?')
          .run(vehicle_type, customer ? customer.id : null, uMake, '', uMake, uModel, '', uModel, uColor, '', uColor, L.nowIso(), vehicle.id);
      }

      // Duplicate active session guard.
      const dup = db.prepare("SELECT * FROM parking_sessions WHERE vehicle_id = ? AND status = 'active'").get(vehicle.id);
      if (dup && !override) {
        throw L.ApiError.conflict('DUPLICATE_ACTIVE_SESSION',
          `Vehicle ${registration} is already parked (ticket ${dup.ticket_no}). Authorized override required.`,
          { session_id: dup.id, ticket_no: dup.ticket_no });
      }
      if (dup && override && !hasPerm(req, 'sessions.override'))
        throw L.ApiError.forbidden('Override requires supervisor authorization');

      // Monthly coverage.
      let monthlySub = L.findActiveSub(db, registration);
      let categoryId = category.id, catKind = category.kind, catCode = category.code;
      if (monthlySub && catKind === 'paid' && catCode !== 'monthly') {
        const mc = db.prepare("SELECT * FROM parking_categories WHERE code = 'monthly'").get();
        if (mc) { categoryId = mc.id; catKind = 'paid'; catCode = 'monthly'; }
      }
      if (catCode === 'monthly' && !monthlySub)
        throw L.ApiError.bad('NO_MONTHLY_COVER', `No active monthly subscription covers ${registration}`);

      // Complimentary authorization.
      let comp = null;
      if (catKind === 'complimentary') {
        if (!hasPerm(req, 'complimentary.authorize'))
          throw L.ApiError.forbidden('Complimentary parking requires an authorized supervisor/manager');
        comp = b.comp || {};
        if (!COMP_CATS.includes(comp.comp_category)) throw L.ApiError.bad('INVALID_COMP', 'Valid complimentary category is required');
        if (!String(comp.authorized_by || '').trim()) throw L.ApiError.bad('INVALID_COMP', 'Authorizing person is required for complimentary parking');
      }

      // Space allocation.
      let space = null;
      if (b.space_id != null && b.space_id !== '') {
        space = db.prepare('SELECT * FROM parking_spaces WHERE id = ?').get(Number(b.space_id));
        if (!space) throw L.ApiError.notFound('Parking space');
        if (space.status === 'occupied' || space.status === 'out_of_service')
          throw L.ApiError.conflict('SPACE_NOT_AVAILABLE', `Space ${space.code} is ${space.status.replace(/_/g, ' ')}`);
        if (space.status === 'reserved') {
          const reservedOk = catCode === 'monthly' || (catKind === 'complimentary' && ['vip', 'management', 'authorized'].includes((comp || {}).comp_category)) || hasPerm(req, 'sessions.override');
          if (!reservedOk) throw L.ApiError.forbidden(`Space ${space.code} is reserved`);
        }
      } else {
        space = db.prepare(`SELECT * FROM parking_spaces WHERE status = 'available' AND space_type = 'standard' ORDER BY zone, code LIMIT 1`).get()
          || db.prepare(`SELECT * FROM parking_spaces WHERE status = 'available' ORDER BY zone, code LIMIT 1`).get();
        if (!space && !override) throw L.ApiError.conflict('NO_SPACE_AVAILABLE', 'No parking bays available. Supervisor override required to admit without a bay.');
        if (!space && override && !hasPerm(req, 'sessions.override')) throw L.ApiError.forbidden();
      }

      // Entry time (backdate only with override permission).
      let entryTime = L.nowIso();
      if (b.entry_time) {
        if (!hasPerm(req, 'sessions.override')) throw L.ApiError.forbidden('Backdating entry requires supervisor authorization');
        const t = new Date(b.entry_time);
        if (isNaN(t) || t > new Date() || t < new Date(Date.now() - 30 * 86400000))
          throw L.ApiError.bad('INVALID_ENTRY_TIME', 'Entry time must be within the last 30 days and not in the future');
        entryTime = t.toISOString();
      }

      const ticketNo = L.nextTicketNo(db, entryTime);
      const now = L.nowIso();
      const r = db.prepare(`INSERT INTO parking_sessions (ticket_no, vehicle_id, registration, customer_name, phone,
        category_id, monthly_subscription_id, space_id, entry_time, status, entry_user_id, created_offline, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?, ?,?)`).run(
        ticketNo, vehicle.id, registration, customer_name, phone, categoryId,
        monthlySub ? monthlySub.id : null, space ? space.id : null, entryTime, req.user.id,
        b.created_offline ? 1 : 0, String(b.notes || '').slice(0, 500), now, now);
      const sessionId = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO tickets (session_id, ticket_no, issued_at, issued_by) VALUES (?,?,?,?)')
        .run(sessionId, ticketNo, now, req.user.id);
      if (space) db.prepare("UPDATE parking_spaces SET status = 'occupied', current_session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, now, space.id);
      if (comp) {
        db.prepare(`INSERT INTO complimentary_authorizations (session_id, comp_category, reason, reference, authorized_by, recorded_by, created_at)
          VALUES (?,?,?,?,?,?,?)`).run(sessionId, comp.comp_category, String(comp.reason || '').slice(0, 500),
          String(comp.reference || '').slice(0, 100), String(comp.authorized_by).trim(), req.user.id, now);
      }
      return sessionId;
    });

    let sessionId;
    try { sessionId = doEntry(); }
    catch (e) { if (e instanceof L.ApiError) throw e; throw e; }

    const detail = sessionDetail(sessionId);
    L.audit(db, req, 'vehicle_entry', 'sessions', String(sessionId), b.override ? 'override' : '',
      `${detail.registration} ${detail.ticket_no} ${detail.space_code || 'no-bay'}`);
    if (L.occSummary(db).available === 0)
      L.notify(db, { type: 'lot_full', title: 'Parking lot full', message: 'All bays are now occupied.', link: '/live', audience_role: 'Supervisor' });
    res.status(201).json({ data: detail, settings: L.getSettings(db) });
  }));

  // ================= SESSION LISTS / DETAIL =================
  app.get('/api/sessions/active', requireAuth, requirePerm('sessions.view'), (req, res) => {
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const where = q ? `AND (s.ticket_no LIKE ? OR s.registration LIKE ? OR s.phone LIKE ? OR s.customer_name LIKE ?)` : '';
    const args = q ? [like, like, like, like] : [];
    const total = db.prepare(`SELECT COUNT(*) c FROM parking_sessions s WHERE s.status = 'active' ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT s.*, c.code AS category_code, c.name AS category_name, c.kind AS category_kind,
        sp.code AS space_code, u.username AS entry_username
      FROM parking_sessions s JOIN parking_categories c ON c.id = s.category_id
      LEFT JOIN parking_spaces sp ON sp.id = s.space_id LEFT JOIN users u ON u.id = s.entry_user_id
      WHERE s.status = 'active' ${where} ORDER BY s.entry_time DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ ...L.pageResult(rows, total, page, pageSize), occupancy: L.occSummary(db) });
  });

  app.get('/api/sessions', requireAuth, requirePerm('sessions.view'), (req, res) => {
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const { status, from, to, category_id, q } = req.query;
    const conds = [], args = [];
    if (status) { conds.push('s.status = ?'); args.push(status); }
    if (from) { conds.push("date(s.entry_time, 'localtime') >= ?"); args.push(from); }
    if (to) { conds.push("date(s.entry_time, 'localtime') <= ?"); args.push(to); }
    if (category_id) { conds.push('s.category_id = ?'); args.push(category_id); }
    if (q) { const like = `%${q}%`; conds.push('(s.ticket_no LIKE ? OR s.registration LIKE ? OR s.phone LIKE ? OR s.customer_name LIKE ?)'); args.push(like, like, like, like); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM parking_sessions s ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT s.*, c.code AS category_code, c.name AS category_name, c.kind AS category_kind,
        sp.code AS space_code FROM parking_sessions s JOIN parking_categories c ON c.id = s.category_id
      LEFT JOIN parking_spaces sp ON sp.id = s.space_id ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });

  app.get('/api/sessions/:id', requireAuth, requirePerm('sessions.view'), L.ah(async (req, res) => {
    const d = sessionDetail(Number(req.params.id));
    if (!d) throw L.ApiError.notFound('Parking session');
    res.json({ data: d, quote: d.status === 'active' ? L.quoteSession(db, d.id) : null, settings: L.getSettings(db) });
  }));

  app.get('/api/sessions/:id/quote', requireAuth, requirePerm('sessions.view'), L.ah(async (req, res) => {
    const d = sessionDetail(Number(req.params.id));
    if (!d) throw L.ApiError.notFound('Parking session');
    res.json({ data: d, quote: L.quoteSession(db, d.id), settings: L.getSettings(db) });
  }));

  app.post('/api/sessions/:id/move', requireAuth, requirePerm('sessions.move'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Only active sessions can be moved');
    const to = db.prepare('SELECT * FROM parking_spaces WHERE id = ?').get(Number((req.body || {}).space_id));
    if (!to) throw L.ApiError.notFound('Parking space');
    if (to.status === 'occupied' || to.status === 'out_of_service')
      throw L.ApiError.conflict('SPACE_NOT_AVAILABLE', `Space ${to.code} is ${to.status.replace(/_/g, ' ')}`);
    if (to.status === 'reserved' && !hasPerm(req, 'sessions.override') && req.user.role_name !== 'Administrator')
      throw L.ApiError.forbidden(`Space ${to.code} is reserved`);
    const now = L.nowIso();
    const from = s.space_id ? db.prepare('SELECT * FROM parking_spaces WHERE id = ?').get(s.space_id) : null;
    db.prepare('UPDATE parking_sessions SET space_id = ?, updated_at = ? WHERE id = ?').run(to.id, now, id);
    db.prepare('UPDATE parking_spaces SET status = ?, current_session_id = ?, updated_at = ? WHERE id = ?')
      .run('occupied', id, now, to.id);
    if (from) {
      const restore = from.space_type === 'reserved' ? 'reserved' : 'available';
      db.prepare('UPDATE parking_spaces SET status = ?, current_session_id = NULL, updated_at = ? WHERE id = ?').run(restore, now, from.id);
    }
    L.audit(db, req, 'space_move', 'sessions', String(id), from ? from.code : 'none', to.code);
    res.json({ ok: true, data: sessionDetail(id) });
  }));

  app.post('/api/sessions/:id/void', requireAuth, requirePerm('sessions.void'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Only active sessions can be voided');
    if (Number(s.amount_paid) > 0) throw L.ApiError.conflict('HAS_PAYMENTS', 'Session has payments. Use the refund process instead.');
    const { reason } = req.body || {};
    if (!String(reason || '').trim()) throw L.ApiError.bad('REASON_REQUIRED', 'A void reason is required');
    const now = L.nowIso();
    db.prepare('UPDATE parking_sessions SET status = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run('voided', `[VOIDED: ${String(reason).slice(0, 300)}] ${s.notes || ''}`, now, id);
    if (s.space_id) {
      const sp = db.prepare('SELECT * FROM parking_spaces WHERE id = ?').get(s.space_id);
      const restore = sp && sp.space_type === 'reserved' ? 'reserved' : 'available';
      db.prepare('UPDATE parking_spaces SET status = ?, current_session_id = NULL, updated_at = ? WHERE id = ?').run(restore, now, s.space_id);
    }
    L.audit(db, req, 'session_void', 'sessions', String(id), s.ticket_no, reason);
    res.json({ ok: true });
  }));

  // ================= EXIT =================
  app.get('/api/exit/lookup', requireAuth, requirePerm('sessions.view'), (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ data: [] });
    const like = `%${q.toUpperCase()}%`;
    const rows = db.prepare(`SELECT s.*, c.code AS category_code, c.name AS category_name, c.kind AS category_kind, sp.code AS space_code
      FROM parking_sessions s JOIN parking_categories c ON c.id = s.category_id
      LEFT JOIN parking_spaces sp ON sp.id = s.space_id
      WHERE (s.ticket_no LIKE ? OR s.registration LIKE ? OR s.phone LIKE ?)
      ORDER BY CASE s.status WHEN 'active' THEN 0 ELSE 1 END, s.id DESC LIMIT 10`).all(like, like, like);
    res.json({ data: rows });
  });

  function validatePaymentInput(p, i) {
    if (!PAY_METHODS.includes(p.method)) throw L.ApiError.bad('INVALID_METHOD', `Payment ${i + 1}: invalid method`);
    const amount = L.validAmount(p.amount, { min: 0.01, name: `Payment ${i + 1} amount` });
    if (p.method === 'mpesa' && !String(p.reference || '').trim())
      throw L.ApiError.bad('REFERENCE_REQUIRED', `Payment ${i + 1}: M-Pesa transaction code is required`);
    if (p.method === 'card' && !String(p.reference || '').trim())
      throw L.ApiError.bad('REFERENCE_REQUIRED', `Payment ${i + 1}: card authorization/reference number is required`);
    return { method: p.method, amount, reference: String(p.reference || '').trim().toUpperCase(), terminal: String(p.terminal || '').trim(), notes: String(p.notes || '').slice(0, 300) };
  }

  // Record a (possibly partial) payment against an active session.
  app.post('/api/sessions/:id/pay', requireAuth, requirePerm('payments.collect'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Session is not active');
    const p = validatePaymentInput(req.body || {}, 0);
    const shift = L.getOpenShift(db, req.user.id);
    if (!shift) throw L.ApiError.conflict('SHIFT_REQUIRED', 'Open a shift before collecting payments');
    const verification = p.method === 'cash' ? 'verified' : 'manual';
    const pay = L.recordPayment(db, { session_id: id, ...p, verification_status: verification, shift_id: shift.id, received_by: req.user.id });
    L.audit(db, req, 'payment_collect', 'payments', String(pay.id), '', `${s.ticket_no} ${p.method} ${p.amount}`);
    res.status(201).json({ data: pay, quote: L.quoteSession(db, id) });
  }));

  // Lost ticket: flat fee + mandatory ID capture. Monthly coverage still wins over lost.
  app.post('/api/sessions/:id/mark-lost', requireAuth, requirePerm('sessions.exit'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Session is not active');
    const idNumber = String((req.body || {}).id_number || '').trim();
    if (!idNumber) throw L.ApiError.bad('ID_REQUIRED', 'National ID / passport number is required for a lost ticket');
    const phone = String((req.body || {}).phone || '').trim();
    const now = L.nowIso();
    db.prepare(`UPDATE parking_sessions SET lost_ticket = 1, lost_id_number = ?,
      phone = CASE WHEN phone = '' THEN ? ELSE phone END, updated_at = ? WHERE id = ?`)
      .run(idNumber, phone, now, id);
    L.audit(db, req, 'ticket_lost', 'sessions', String(id), s.ticket_no, `id=${idNumber}`);
    res.json({ data: L.sessionById(db, id), quote: L.quoteSession(db, id) });
  }));

  app.post('/api/sessions/:id/unmark-lost', requireAuth, requirePerm('sessions.override'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Session is not active');
    if (!s.lost_ticket) throw L.ApiError.bad('NOT_LOST', 'Ticket is not flagged as lost');
    db.prepare(`UPDATE parking_sessions SET lost_ticket = 0, lost_id_number = '', updated_at = ? WHERE id = ?`).run(L.nowIso(), id);
    L.audit(db, req, 'ticket_unmark_lost', 'sessions', String(id), s.ticket_no, 'ticket recovered');
    res.json({ data: L.sessionById(db, id), quote: L.quoteSession(db, id) });
  }));

  // Complete exit: record final payments (optional), verify, close, free bay.
  app.post('/api/sessions/:id/exit', requireAuth, requirePerm('sessions.exit'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s) throw L.ApiError.notFound('Parking session');
    if (s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Session is not active');
    const body = req.body || {};
    const inputs = Array.isArray(body.payments) ? body.payments : [];

    const finish = db.transaction(() => {
      const q0 = L.quoteSession(db, id);
      if (q0.pending_discounts > 0) throw L.ApiError.conflict('DISCOUNT_PENDING', 'A discount is awaiting approval. Approve or reject it before exit.');
      const shift = inputs.length ? L.getOpenShift(db, req.user.id) : null;
      if (inputs.length && !shift) throw L.ApiError.conflict('SHIFT_REQUIRED', 'Open a shift before collecting payments');
      if (inputs.length && !hasPerm(req, 'payments.collect')) throw L.ApiError.forbidden('Payment collection permission required');
      const recorded = [];
      inputs.forEach((raw, i) => {
        const p = validatePaymentInput(raw, i);
        const verification = p.method === 'cash' ? 'verified' : 'manual';
        recorded.push(L.recordPayment(db, { session_id: id, ...p, verification_status: verification, shift_id: shift.id, received_by: req.user.id }));
      });
      const q = L.quoteSession(db, id);
      if (q.due > 0) {
        throw L.ApiError.conflict('PAYMENT_REQUIRED', `Outstanding balance of ${q.due.toFixed(2)}. Collect full payment before exit.`, { quote: q });
      }
      const now = L.nowIso();
      const payment_status = s.category_kind === 'complimentary' ? 'complimentary' : 'paid';
      db.prepare(`UPDATE parking_sessions SET exit_time = ?, status = 'exited', base_amount = ?, discount_amount = ?,
        amount_paid = ?, payment_status = ?, exit_user_id = ?, updated_at = ? WHERE id = ?`)
        .run(now, q.base, q.discount, q.paid, payment_status, req.user.id, now, id);
      if (s.space_id) {
        const sp = db.prepare('SELECT * FROM parking_spaces WHERE id = ?').get(s.space_id);
        if (sp && sp.status === 'occupied') {
          const restore = sp.space_type === 'reserved' ? 'reserved' : 'available';
          db.prepare('UPDATE parking_spaces SET status = ?, current_session_id = NULL, updated_at = ? WHERE id = ?').run(restore, now, s.space_id);
        }
      }
      return { quote: q, recorded };
    });

    const { quote, recorded } = finish();
    const detail = sessionDetail(id);
    L.audit(db, req, 'vehicle_exit', 'sessions', String(id), s.ticket_no, `paid=${quote.paid} due=0`);
    // Gate opens on every paid exit: keep an automatic barrier event for the audit trail.
    try {
      db.prepare(`INSERT INTO gate_logs (session_id, action, reason, opened_by, created_at)
        VALUES (?,'open',?,?,?)`).run(id, `Paid exit ${s.ticket_no}`, req.user.id, L.nowIso());
    } catch (e) { /* gate logging must never block an exit */ }
    res.json({ data: detail, quote, payments: recorded, settings: L.getSettings(db) });
  }));

  // ================= PAYMENTS =================
  app.get('/api/payments', requireAuth, requirePerm('payments.view'), (req, res) => {
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const { from, to, method, user_id, verification, q, shift_id } = req.query;
    const conds = [], args = [];
    if (from) { conds.push("date(p.paid_at, 'localtime') >= ?"); args.push(from); }
    if (to) { conds.push("date(p.paid_at, 'localtime') <= ?"); args.push(to); }
    if (method) { conds.push('p.method = ?'); args.push(method); }
    if (user_id) { conds.push('p.received_by = ?'); args.push(user_id); }
    if (verification) { conds.push('p.verification_status = ?'); args.push(verification); }
    if (shift_id) { conds.push('p.shift_id = ?'); args.push(shift_id); }
    if (q) { const like = `%${q}%`; conds.push('(p.reference LIKE ? OR s.ticket_no LIKE ? OR s.registration LIKE ?)'); args.push(like, like, like); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM payments p LEFT JOIN parking_sessions s ON s.id = p.session_id ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT p.*, s.ticket_no, s.registration, u.username AS received_by_name
      FROM payments p LEFT JOIN parking_sessions s ON s.id = p.session_id LEFT JOIN users u ON u.id = p.received_by
      ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const totals = db.prepare(`SELECT p.method, COUNT(*) n, COALESCE(SUM(p.amount),0) t FROM payments p
      LEFT JOIN parking_sessions s ON s.id = p.session_id ${where} GROUP BY p.method`).all(...args);
    res.json({ ...L.pageResult(rows, total, page, pageSize), totals });
  });

  // ================= M-PESA =================
  app.get('/api/mpesa/status', requireAuth, requirePerm('mpesa.view', 'payments.view'), (req, res) => {
    res.json({ data: mpesa.publicStatus() });
  });

  app.get('/api/mpesa/transactions', requireAuth, requirePerm('mpesa.view', 'payments.view'), (req, res) => {
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const { status } = req.query;
    const where = status ? 'WHERE t.status = ?' : '';
    const args = status ? [status] : [];
    const total = db.prepare(`SELECT COUNT(*) c FROM payment_transactions t ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT t.*, s.ticket_no, s.registration FROM payment_transactions t
      LEFT JOIN parking_sessions s ON s.id = t.session_id ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });

  app.post('/api/mpesa/stk-push', requireAuth, requirePerm('mpesa.manage'), L.ah(async (req, res) => {
    const { session_id, phone } = req.body || {};
    const s = L.sessionById(db, Number(session_id));
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Session is not active');
    const ph = L.validPhone(phone, { required: true });
    if (!mpesa.isConfigured()) {
      L.audit(db, req, 'mpesa_stk_blocked', 'mpesa', String(session_id), '', 'credentials not configured');
      throw new L.ApiError(501, 'MPESA_NOT_CONFIGURED',
        'M-Pesa Daraja credentials are not configured on the server. Record the payment manually with the customer SMS code instead - no automatic confirmation is available.');
    }
    const q = L.quoteSession(db, s.id);
    if (q.due <= 0) throw L.ApiError.bad('NOTHING_DUE', 'No amount due on this session');
    const shift = L.getOpenShift(db, req.user.id);
    if (!shift) throw L.ApiError.conflict('SHIFT_REQUIRED', 'Open a shift before collecting payments');
    const pay = L.recordPayment(db, { session_id: s.id, amount: q.due, method: 'mpesa', reference: 'STK-PENDING', verification_status: 'pending', shift_id: shift.id, received_by: req.user.id, notes: 'STK push initiated' });
    const now = L.nowIso();
    const t = db.prepare(`INSERT INTO payment_transactions (payment_id, session_id, provider, phone, amount, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(pay.id, s.id, 'mpesa', ph, q.due, 'pending', now, now);
    const txnId = Number(t.lastInsertRowid);
    try {
      const r = await mpesa.initiateStkPush({ phone: ph, amount: q.due });
      db.prepare('UPDATE payment_transactions SET provider_ref = ?, updated_at = ? WHERE id = ?')
        .run(r.CheckoutRequestID || '', L.nowIso(), txnId);
      L.audit(db, req, 'mpesa_stk_push', 'mpesa', String(txnId), '', `${s.ticket_no} ${q.due}`);
      res.status(201).json({ data: { ...db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(txnId), message: r.CustomerMessage || 'STK push sent' } });
    } catch (e) {
      db.prepare("UPDATE payment_transactions SET status = 'failed', updated_at = ? WHERE id = ?").run(L.nowIso(), txnId);
      db.prepare("UPDATE payments SET verification_status = 'failed', notes = ? WHERE id = ?").run('STK push failed: ' + e.message.slice(0, 200), pay.id);
      L.recomputeSessionTotals(db, s.id);
      throw new L.ApiError(e.status || 502, e.code || 'MPESA_STK_FAILED', 'STK push failed: ' + e.message);
    }
  }));

  // Daraja server-to-server callback. No user session; optional shared token.
  app.post('/api/mpesa/callback', L.ah(async (req, res) => {
    const token = process.env.MPESA_CALLBACK_TOKEN;
    if (token && req.query.token !== token) return res.status(403).json({ ResultCode: 1, ResultDesc: 'Forbidden' });
    const cb = mpesa.parseCallback(req.body || {});
    if (cb.checkoutRequestId) {
      const txn = db.prepare('SELECT * FROM payment_transactions WHERE provider_ref = ?').get(cb.checkoutRequestId);
      if (txn) {
        let status = 'failed';
        if (cb.resultCode === 0) {
          status = (cb.amount != null && Math.abs(cb.amount - txn.amount) < 0.01) ? 'paid' : 'failed';
        } else if (cb.resultCode === 1032) status = 'cancelled';
        const now = L.nowIso();
        db.prepare('UPDATE payment_transactions SET status = ?, mpesa_receipt = ?, raw_callback = ?, updated_at = ? WHERE id = ?')
          .run(status, cb.receipt || '', JSON.stringify(req.body).slice(0, 4000), now, txn.id);
        if (txn.payment_id) {
          db.prepare('UPDATE payments SET verification_status = ?, reference = ?, paid_at = ? WHERE id = ?')
            .run(status === 'paid' ? 'verified' : 'failed', cb.receipt || 'STK-' + status.toUpperCase(), status === 'paid' ? now : txn.created_at, txn.payment_id);
          L.recomputeSessionTotals(db, txn.session_id);
        }
        L.audit(db, req, 'mpesa_callback', 'mpesa', String(txn.id), 'pending', status);
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }));

  app.post('/api/mpesa/transactions/:id/reverse', requireAuth, requirePerm('mpesa.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const txn = db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(id);
    if (!txn) throw L.ApiError.notFound('Transaction');
    if (txn.status !== 'paid') throw L.ApiError.bad('INVALID_STATUS', 'Only paid transactions can be reversed');
    const now = L.nowIso();
    db.prepare("UPDATE payment_transactions SET status = 'reversed', updated_at = ? WHERE id = ?").run(now, id);
    if (txn.payment_id) {
      db.prepare("UPDATE payments SET verification_status = 'failed', notes = ? WHERE id = ?")
        .run('Reversed on ' + now.slice(0, 10), txn.payment_id);
      if (txn.session_id) L.recomputeSessionTotals(db, txn.session_id);
    }
    L.audit(db, req, 'mpesa_reverse', 'mpesa', String(id), 'paid', 'reversed');
    res.json({ ok: true });
  }));

  // ================= MONTHLY PACKAGES =================
  app.get('/api/monthly/packages', requireAuth, requirePerm('monthly.view'), (req, res) => {
    res.json({ data: db.prepare('SELECT * FROM monthly_packages ORDER BY price').all() });
  });
  app.post('/api/monthly/packages', requireAuth, requirePerm('monthly.manage'), L.ah(async (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) throw L.ApiError.bad('VALIDATION', 'Package name is required');
    const price = L.validAmount(b.price, { name: 'Price' });
    const validity = Number(b.validity_days || 30);
    if (!Number.isInteger(validity) || validity < 1 || validity > 366) throw L.ApiError.bad('VALIDATION', 'Validity must be 1-366 days');
    const now = L.nowIso();
    try {
      const r = db.prepare(`INSERT INTO monthly_packages (name, price, validity_days, reserved_space, vehicle_limit, benefits, active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, ?,?)`).run(String(b.name).trim(), price, validity, b.reserved_space ? 1 : 0,
        Math.max(1, Number(b.vehicle_limit) || 1), String(b.benefits || '').slice(0, 500), b.active === 0 ? 0 : 1, now, now);
      L.audit(db, req, 'package_create', 'monthly', String(r.lastInsertRowid), '', b.name);
      res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch { throw L.ApiError.conflict('NAME_TAKEN', 'Package name already exists'); }
  }));
  app.put('/api/monthly/packages/:id', requireAuth, requirePerm('monthly.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare('SELECT * FROM monthly_packages WHERE id = ?').get(id);
    if (!p) throw L.ApiError.notFound('Package');
    const b = req.body || {};
    if (b.price != null) L.validAmount(b.price, { name: 'Price' });
    db.prepare(`UPDATE monthly_packages SET name = COALESCE(?, name), price = COALESCE(?, price),
      validity_days = COALESCE(?, validity_days), reserved_space = COALESCE(?, reserved_space),
      vehicle_limit = COALESCE(?, vehicle_limit), benefits = COALESCE(?, benefits), active = COALESCE(?, active), updated_at = ? WHERE id = ?`)
      .run(b.name ?? null, b.price ?? null, b.validity_days ?? null, b.reserved_space ?? null,
        b.vehicle_limit ?? null, b.benefits ?? null, b.active ?? null, L.nowIso(), id);
    L.audit(db, req, 'package_update', 'monthly', String(id), p.name, b.name || p.name);
    res.json({ ok: true });
  }));
  app.delete('/api/monthly/packages/:id', requireAuth, requirePerm('monthly.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const used = db.prepare('SELECT COUNT(*) c FROM monthly_subscriptions WHERE package_id = ?').get(id).c;
    if (used > 0) throw L.ApiError.conflict('PACKAGE_IN_USE', 'Package has subscriptions. Deactivate it instead.');
    db.prepare('DELETE FROM monthly_packages WHERE id = ?').run(id);
    L.audit(db, req, 'package_delete', 'monthly', String(id), '', '');
    res.json({ ok: true });
  }));

  // ================= MONTHLY SUBSCRIPTIONS =================
  function subWithMeta(row) {
    if (!row) return null;
    const t = L.todayStr();
    return { ...row, days_remaining: L.diffDaysStr(t, row.expiry_date), expired: row.expiry_date < t };
  }
  app.get('/api/monthly/subscriptions', requireAuth, requirePerm('monthly.view'), (req, res) => {
    L.refreshExpiredSubs(db);
    const { status, q, expiring_days } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const conds = [], args = [];
    if (status) { conds.push('s.status = ?'); args.push(status); }
    if (q) { const like = `%${q}%`; conds.push('(s.customer_name LIKE ? OR s.registration LIKE ? OR s.phone LIKE ? OR s.company LIKE ?)'); args.push(like, like, like, like); }
    if (expiring_days) { conds.push("s.status = 'active'"); conds.push('s.expiry_date <= ?'); args.push(L.addDaysStr(L.todayStr(), Number(expiring_days))); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM monthly_subscriptions s ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT s.*, p.name AS package_name, p.price AS package_price, u.username AS created_by_name
      FROM monthly_subscriptions s JOIN monthly_packages p ON p.id = s.package_id
      LEFT JOIN users u ON u.id = s.created_by ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows.map(subWithMeta), total, page, pageSize));
  });

  app.get('/api/monthly/subscriptions/:id', requireAuth, requirePerm('monthly.view'), L.ah(async (req, res) => {
    const s = db.prepare(`SELECT s.*, p.name AS package_name FROM monthly_subscriptions s
      JOIN monthly_packages p ON p.id = s.package_id WHERE s.id = ?`).get(Number(req.params.id));
    if (!s) throw L.ApiError.notFound('Subscription');
    s.payments = db.prepare(`SELECT sp.*, u.username AS received_by_name FROM subscription_payments sp
      LEFT JOIN users u ON u.id = sp.received_by WHERE sp.subscription_id = ? ORDER BY sp.id`).all(s.id);
    s.sessions = db.prepare('SELECT * FROM parking_sessions WHERE monthly_subscription_id = ? ORDER BY id DESC LIMIT 20').all(s.id);
    res.json({ data: subWithMeta(s), settings: L.getSettings(db) });
  }));

  app.post('/api/monthly/subscriptions', requireAuth, requirePerm('monthly.manage'), L.ah(async (req, res) => {
    const b = req.body || {};
    const pkg = db.prepare('SELECT * FROM monthly_packages WHERE id = ? AND active = 1').get(Number(b.package_id));
    if (!pkg) throw L.ApiError.bad('INVALID_PACKAGE', 'Valid active package is required');
    if (!String(b.customer_name || '').trim()) throw L.ApiError.bad('VALIDATION', 'Customer name is required');
    const registration = L.normalizeReg(b.registration);
    const phone = L.validPhone(b.phone || '');
    const start = b.start_date ? L.validDateStr(b.start_date, 'Start date') : L.todayStr();
    const expiry = b.expiry_date ? L.validDateStr(b.expiry_date, 'Expiry date') : L.addDaysStr(start, pkg.validity_days);
    if (expiry < start) throw L.ApiError.bad('INVALID_DATES', 'Expiry date cannot be before start date');
    if (expiry < L.todayStr()) throw L.ApiError.bad('INVALID_DATES', 'Expiry date is in the past');
    const amount = b.amount != null ? L.validAmount(b.amount, { name: 'Amount' }) : pkg.price;
    const method = b.payment_method || 'cash';
    if (!PAY_METHODS.includes(method)) throw L.ApiError.bad('INVALID_METHOD', 'Invalid payment method');
    const dup = db.prepare(`SELECT * FROM monthly_subscriptions WHERE registration = ? AND status = 'active'
      AND NOT (expiry_date < ? OR start_date > ?)`).get(registration, start, expiry);
    if (dup) throw L.ApiError.conflict('OVERLAPPING_SUBSCRIPTION', `An active subscription (expires ${dup.expiry_date}) already covers ${registration} in this period`);

    const create = db.transaction(() => {
      const shift = L.getOpenShift(db, req.user.id);
      if (!shift) throw L.ApiError.conflict('SHIFT_REQUIRED', 'Open a shift before recording subscription payment');
      const now = L.nowIso();
      const r = db.prepare(`INSERT INTO monthly_subscriptions (customer_name, company, phone, email, registration, vehicle_type,
        package_id, start_date, expiry_date, amount, payment_method, payment_reference, status, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        String(b.customer_name).trim(), String(b.company || '').trim(), phone, String(b.email || '').trim(),
        registration, VEHICLE_TYPES.includes(b.vehicle_type) ? b.vehicle_type : 'Saloon',
        pkg.id, start, expiry, amount, method, String(b.payment_reference || '').trim().toUpperCase(),
        'active', req.user.id, now, now);
      const subId = Number(r.lastInsertRowid);
      if (amount > 0) {
        L.recordPayment(db, { subscription_id: subId, amount, method, reference: String(b.payment_reference || '').trim().toUpperCase(),
          verification_status: method === 'cash' ? 'verified' : 'manual', shift_id: shift.id, received_by: req.user.id });
      }
      // Link vehicle record.
      const v = db.prepare('SELECT * FROM vehicles WHERE registration = ?').get(registration);
      if (!v) db.prepare('INSERT INTO vehicles (registration, vehicle_type, created_at, updated_at) VALUES (?,?,?,?)').run(registration, 'Saloon', now, now);
      return subId;
    });
    const subId = create();
    L.audit(db, req, 'subscription_create', 'monthly', String(subId), '', `${registration} ${pkg.name} ${amount}`);
    res.status(201).json({ data: subWithMeta(db.prepare('SELECT * FROM monthly_subscriptions WHERE id = ?').get(subId)) });
  }));

  app.post('/api/monthly/subscriptions/:id/renew', requireAuth, requirePerm('monthly.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const old = db.prepare('SELECT * FROM monthly_subscriptions WHERE id = ?').get(id);
    if (!old) throw L.ApiError.notFound('Subscription');
    const b = req.body || {};
    const pkg = db.prepare('SELECT * FROM monthly_packages WHERE id = ? AND active = 1').get(Number(b.package_id || old.package_id));
    if (!pkg) throw L.ApiError.bad('INVALID_PACKAGE', 'Valid active package is required');
    const start = b.start_date ? L.validDateStr(b.start_date, 'Start date')
      : (old.expiry_date >= L.todayStr() ? L.addDaysStr(old.expiry_date, 1) : L.todayStr());
    const expiry = b.expiry_date ? L.validDateStr(b.expiry_date, 'Expiry date') : L.addDaysStr(start, pkg.validity_days);
    if (expiry < start || expiry < L.todayStr()) throw L.ApiError.bad('INVALID_DATES', 'Invalid renewal dates');
    const amount = b.amount != null ? L.validAmount(b.amount, { name: 'Amount' }) : pkg.price;
    const method = b.payment_method || 'cash';
    if (!PAY_METHODS.includes(method)) throw L.ApiError.bad('INVALID_METHOD', 'Invalid payment method');

    const renew = db.transaction(() => {
      const shift = L.getOpenShift(db, req.user.id);
      if (!shift) throw L.ApiError.conflict('SHIFT_REQUIRED', 'Open a shift before recording subscription payment');
      const now = L.nowIso();
      db.prepare('UPDATE monthly_subscriptions SET status = ?, updated_at = ? WHERE id = ?')
        .run(old.expiry_date < L.todayStr() ? 'expired' : 'cancelled', now, id);
      const r = db.prepare(`INSERT INTO monthly_subscriptions (customer_name, company, phone, email, registration, vehicle_type,
        package_id, start_date, expiry_date, amount, payment_method, payment_reference, status, renewed_from, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        old.customer_name, old.company, old.phone, old.email, old.registration, old.vehicle_type,
        pkg.id, start, expiry, amount, method, String(b.payment_reference || '').trim().toUpperCase(),
        'active', id, req.user.id, now, now);
      const subId = Number(r.lastInsertRowid);
      if (amount > 0) {
        L.recordPayment(db, { subscription_id: subId, amount, method, reference: String(b.payment_reference || '').trim().toUpperCase(),
          verification_status: method === 'cash' ? 'verified' : 'manual', shift_id: shift.id, received_by: req.user.id, notes: 'Renewal' });
      }
      return subId;
    });
    const subId = renew();
    L.audit(db, req, 'subscription_renew', 'monthly', String(subId), String(id), `${old.registration} ${pkg.name}`);
    res.status(201).json({ data: subWithMeta(db.prepare('SELECT * FROM monthly_subscriptions WHERE id = ?').get(subId)) });
  }));

  app.put('/api/monthly/subscriptions/:id', requireAuth, requirePerm('monthly.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM monthly_subscriptions WHERE id = ?').get(id);
    if (!s) throw L.ApiError.notFound('Subscription');
    const { status } = req.body || {};
    if (!['active', 'expired', 'suspended', 'cancelled'].includes(status)) throw L.ApiError.bad('INVALID_STATUS', 'Invalid status');
    if (status === 'active' && s.expiry_date < L.todayStr())
      throw L.ApiError.bad('EXPIRED', 'Cannot reactivate a past-expiry subscription. Renew it instead.');
    db.prepare('UPDATE monthly_subscriptions SET status = ?, updated_at = ? WHERE id = ?').run(status, L.nowIso(), id);
    L.audit(db, req, 'subscription_status', 'monthly', String(id), s.status, status);
    res.json({ ok: true });
  }));

  // ================= PROMOTIONS & DISCOUNTS =================
  app.get('/api/promotions', requireAuth, requirePerm('discounts.apply', 'promotions.manage'), (req, res) => {
    const activeOnly = req.query.active_only === '1';
    res.json({ data: db.prepare(`SELECT * FROM promotions ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY active DESC, name`).all() });
  });
  app.post('/api/promotions', requireAuth, requirePerm('promotions.manage'), L.ah(async (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) throw L.ApiError.bad('VALIDATION', 'Promotion name is required');
    if (!['percentage', 'fixed', 'free', 'time_based', 'event', 'guest'].includes(b.kind)) throw L.ApiError.bad('VALIDATION', 'Invalid promotion kind');
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO promotions (name, kind, value, conditions, active, valid_from, valid_to, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(String(b.name).trim(), b.kind, L.validAmount(b.value || 0, { name: 'Value' }),
      typeof b.conditions === 'string' ? b.conditions : JSON.stringify(b.conditions || {}),
      b.active === 0 ? 0 : 1, b.valid_from || '', b.valid_to || '', req.user.id, now, now);
    L.audit(db, req, 'promotion_create', 'promotions', String(r.lastInsertRowid), '', b.name);
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
  }));
  app.put('/api/promotions/:id', requireAuth, requirePerm('promotions.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare('SELECT * FROM promotions WHERE id = ?').get(id);
    if (!p) throw L.ApiError.notFound('Promotion');
    const b = req.body || {};
    db.prepare(`UPDATE promotions SET name = COALESCE(?, name), kind = COALESCE(?, kind), value = COALESCE(?, value),
      active = COALESCE(?, active), valid_from = COALESCE(?, valid_from), valid_to = COALESCE(?, valid_to), updated_at = ? WHERE id = ?`)
      .run(b.name ?? null, b.kind ?? null, b.value ?? null, b.active ?? null, b.valid_from ?? null, b.valid_to ?? null, L.nowIso(), id);
    L.audit(db, req, 'promotion_update', 'promotions', String(id), p.name, b.name || p.name);
    res.json({ ok: true });
  }));

  app.get('/api/discounts', requireAuth, requirePerm('discounts.approve', 'reports.view'), (req, res) => {
    const { status, from, to } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const conds = [], args = [];
    if (status) { conds.push('d.status = ?'); args.push(status); }
    if (from) { conds.push("date(d.created_at, 'localtime') >= ?"); args.push(from); }
    if (to) { conds.push("date(d.created_at, 'localtime') <= ?"); args.push(to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM discounts d ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT d.*, s.ticket_no, s.registration, u1.username AS applied_by_name, u2.username AS approved_by_name
      FROM discounts d JOIN parking_sessions s ON s.id = d.session_id
      LEFT JOIN users u1 ON u1.id = d.applied_by LEFT JOIN users u2 ON u2.id = d.approved_by
      ${where} ORDER BY d.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });

  // Redeem a hotel validation code: immediate applied discount, capped by code ceiling and due.
  app.post('/api/sessions/:id/validate', requireAuth, requirePerm('payments.collect'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Session is not active');
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    if (!code) throw L.ApiError.bad('CODE_REQUIRED', 'Validation code is required');
    const v = db.prepare('SELECT * FROM validation_codes WHERE code = ?').get(code);
    if (!v) throw L.ApiError.notFound('Validation code');
    if (v.status === 'revoked') throw L.ApiError.bad('CODE_REVOKED', 'This code was revoked');
    if (v.status === 'used') throw L.ApiError.bad('CODE_USED', 'This code was already used');
    if (v.expires_at && v.expires_at < L.nowIso()) {
      db.prepare("UPDATE validation_codes SET status = 'expired' WHERE id = ?").run(v.id);
      throw L.ApiError.bad('CODE_EXPIRED', 'This code has expired');
    }
    const q = L.quoteSession(db, id);
    if (q.base <= 0) throw L.ApiError.bad('NOTHING_TO_DISCOUNT', 'Nothing to discount');
    const exists = db.prepare(`SELECT id FROM discounts WHERE session_id = ? AND status IN ('pending','approved','applied')`).get(id);
    if (exists) throw L.ApiError.bad('DISCOUNT_EXISTS', 'A discount already applies to this session');
    const cover = L.round2(Math.min(q.due, v.max_amount != null ? v.max_amount : q.due));
    if (cover <= 0) throw L.ApiError.bad('NOTHING_TO_DISCOUNT', 'Nothing left to discount');
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO discounts (session_id, promotion_id, original_amount, discount_amount, final_amount,
      reason, applied_by, approved_by, status, validation_code, created_at, decided_at)
      VALUES (?,NULL,?,?,?,?,?,?,'applied',?,?,?)`)
      .run(id, q.base, cover, L.round2(q.base - cover), `Hotel validation ${code}`,
        req.user.id, req.user.id, code, now, now);
    db.prepare(`UPDATE validation_codes SET status = 'used', used_by_session = ?, used_amount = ?, used_at = ? WHERE id = ?`)
      .run(id, cover, now, v.id);
    L.recomputeSessionTotals(db, id);
    L.audit(db, req, 'validation_redeem', 'sessions', String(id), code, `off=${cover}`);
    res.status(201).json({ data: db.prepare('SELECT * FROM discounts WHERE id = ?').get(r.lastInsertRowid), quote: L.quoteSession(db, id) });
  }));

  app.post('/api/sessions/:id/discounts', requireAuth, requirePerm('discounts.apply'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = L.sessionById(db, id);
    if (!s || s.status !== 'active') throw L.ApiError.bad('INVALID_SESSION', 'Session is not active');
    const b = req.body || {};
    if (!String(b.reason || '').trim()) throw L.ApiError.bad('REASON_REQUIRED', 'A discount reason is required');
    const existing = db.prepare("SELECT * FROM discounts WHERE session_id = ? AND status != 'rejected'").get(id);
    if (existing) throw L.ApiError.conflict('DISCOUNT_EXISTS', 'A discount already exists on this session');
    const q = L.quoteSession(db, id);
    if (q.base <= 0) throw L.ApiError.bad('NOTHING_TO_DISCOUNT', 'Session has no chargeable amount');
    let kind = b.kind, value = Number(b.value || 0), promotion_id = null;
    if (b.promotion_id) {
      const pr = db.prepare('SELECT * FROM promotions WHERE id = ? AND active = 1').get(Number(b.promotion_id));
      if (!pr) throw L.ApiError.bad('INVALID_PROMOTION', 'Promotion not found or inactive');
      promotion_id = pr.id; kind = pr.kind; value = pr.value;
    }
    let discount = 0;
    if (kind === 'percentage') {
      if (!(value > 0 && value <= 100)) throw L.ApiError.bad('INVALID_DISCOUNT', 'Percentage must be 1-100');
      discount = L.round2(q.base * value / 100);
    } else if (kind === 'fixed') {
      discount = L.validAmount(value, { min: 0.01, name: 'Discount' });
      if (discount > q.base) throw L.ApiError.bad('INVALID_DISCOUNT', 'Discount exceeds the amount due');
    } else if (kind === 'free') {
      discount = q.base;
    } else throw L.ApiError.bad('INVALID_DISCOUNT', 'Discount kind must be percentage, fixed or free');
    const auto = hasPerm(req, 'discounts.approve');
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO discounts (session_id, promotion_id, original_amount, discount_amount, final_amount, reason, applied_by, approved_by, status, created_at, decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, promotion_id, q.base, discount, L.round2(q.base - discount),
      String(b.reason).slice(0, 500), req.user.id, auto ? req.user.id : null, auto ? 'applied' : 'pending', now, auto ? now : null);
    if (auto) L.recomputeSessionTotals(db, id);
    else L.notify(db, { type: 'discount_pending', title: 'Discount awaiting approval', message: `${s.ticket_no} - ${discount.toFixed(2)} by ${req.user.username}`, link: '/promotions', audience_role: 'Manager' });
    L.audit(db, req, 'discount_apply', 'discounts', String(r.lastInsertRowid), '', `${s.ticket_no} ${discount} ${auto ? 'applied' : 'pending'}`);
    res.status(201).json({ data: db.prepare('SELECT * FROM discounts WHERE id = ?').get(Number(r.lastInsertRowid)), quote: L.quoteSession(db, id) });
  }));

  app.post('/api/discounts/:id/decision', requireAuth, requirePerm('discounts.approve'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const d = db.prepare('SELECT * FROM discounts WHERE id = ?').get(id);
    if (!d) throw L.ApiError.notFound('Discount');
    if (d.status !== 'pending') throw L.ApiError.bad('INVALID_STATUS', 'Discount is already decided');
    const { decision } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) throw L.ApiError.bad('INVALID_DECISION', 'Decision must be approved or rejected');
    db.prepare('UPDATE discounts SET status = ?, approved_by = ?, decided_at = ? WHERE id = ?').run(decision, req.user.id, L.nowIso(), id);
    if (decision === 'approved') {
      const s = L.sessionById(db, d.session_id);
      if (s && s.status === 'active') L.recomputeSessionTotals(db, d.session_id);
    }
    L.audit(db, req, 'discount_' + decision, 'discounts', String(id), 'pending', decision);
    res.json({ ok: true, quote: L.quoteSession(db, d.session_id) });
  }));

  // ================= COMPLIMENTARY =================
  app.get('/api/complimentary', requireAuth, requirePerm('complimentary.view', 'reports.view'), (req, res) => {
    const { from, to, comp_category } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const conds = [], args = [];
    if (from) { conds.push("date(ca.created_at, 'localtime') >= ?"); args.push(from); }
    if (to) { conds.push("date(ca.created_at, 'localtime') <= ?"); args.push(to); }
    if (comp_category) { conds.push('ca.comp_category = ?'); args.push(comp_category); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM complimentary_authorizations ca ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT ca.*, s.ticket_no, s.registration, s.entry_time, s.exit_time, s.status,
        u.username AS recorded_by_name FROM complimentary_authorizations ca
parking_sessions s ON s.id = ca.session_id LEFT JOIN users u ON u.id = ca.recorded_by
      ${where} ORDER BY ca.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const byCat = db.prepare(`SELECT ca.comp_category, COUNT(*) n FROM complimentary_authorizations ca ${where} GROUP BY ca.comp_category`).all(...args);
    res.json({ ...L.pageResult(rows, total, page, pageSize), by_category: byCat });
  });

  // ================= CUSTOMERS & VEHICLES =================
  app.get('/api/customers', requireAuth, requirePerm('customers.view'), (req, res) => {
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const q = String(req.query.q || '').trim();
    const where = q ? 'AND (c.name LIKE ? OR c.phone LIKE ? OR c.company LIKE ? OR c.email LIKE ?)' : '';
    const like = `%${q}%`;
    const args = q ? [like, like, like, like] : [];
    const total = db.prepare(`SELECT COUNT(*) c FROM customers c WHERE c.deleted_at IS NULL ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM parking_sessions s
        LEFT JOIN vehicles v ON v.id = s.vehicle_id WHERE v.customer_id = c.id OR s.phone = c.phone) AS visits
      FROM customers c WHERE c.deleted_at IS NULL ${where} ORDER BY c.name LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });

  app.post('/api/customers', requireAuth, requirePerm('customers.manage'), L.ah(async (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) throw L.ApiError.bad('VALIDATION', 'Customer name is required');
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO customers (name, phone, email, company, customer_type, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(String(b.name).trim(), L.validPhone(b.phone || ''), String(b.email || '').trim(),
      String(b.company || '').trim(), String(b.customer_type || 'casual').slice(0, 40), String(b.notes || '').slice(0, 500), now, now);
    L.audit(db, req, 'customer_create', 'customers', String(r.lastInsertRowid), '', b.name);
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
  }));

  app.get('/api/customers/:id', requireAuth, requirePerm('customers.view'), L.ah(async (req, res) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL').get(Number(req.params.id));
    if (!c) throw L.ApiError.notFound('Customer');
    const vehicles = db.prepare('SELECT * FROM vehicles WHERE customer_id = ?').all(c.id);
    const regs = vehicles.map(v => v.registration);
    let sessions = [];
    if (regs.length) {
      const ph = regs.map(() => '?').join(',');
      sessions = db.prepare(`SELECT s.*, cat.name AS category_name FROM parking_sessions s
        JOIN parking_categories cat ON cat.id = s.category_id
        WHERE s.registration IN (${ph}) OR s.phone = ? ORDER BY s.id DESC LIMIT 100`).all(...regs, c.phone || '');
    } else if (c.phone) {
      sessions = db.prepare(`SELECT s.*, cat.name AS category_name FROM parking_sessions s
        JOIN parking_categories cat ON cat.id = s.category_id WHERE s.phone = ? ORDER BY s.id DESC LIMIT 100`).all(c.phone);
    }
    const subs = regs.length
      ? db.prepare(`SELECT ms.*, p.name AS package_name FROM monthly_subscriptions ms JOIN monthly_packages p ON p.id = ms.package_id
        WHERE ms.registration IN (${regs.map(() => '?').join(',')}) OR ms.phone = ? ORDER BY ms.id DESC`).all(...regs, c.phone || '')
      : [];
    const totalPaid = sessions.filter(s => s.payment_status === 'paid').reduce((a, s) => a + Number(s.amount_paid || 0), 0);
    res.json({ data: { ...c, vehicles, sessions, subscriptions: subs, total_paid: L.round2(totalPaid), visits: sessions.length } });
  }));

  app.put('/api/customers/:id', requireAuth, requirePerm('customers.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!c) throw L.ApiError.notFound('Customer');
    const b = req.body || {};
    if (b.phone) L.validPhone(b.phone);
    db.prepare(`UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email),
      company = COALESCE(?, company), customer_type = COALESCE(?, customer_type), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`)
      .run(b.name ?? null, b.phone ?? null, b.email ?? null, b.company ?? null, b.customer_type ?? null, b.notes ?? null, L.nowIso(), id);
    L.audit(db, req, 'customer_update', 'customers', String(id), c.name, b.name || c.name);
    res.json({ ok: true });
  }));

  app.get('/api/vehicles/history', requireAuth, requirePerm('sessions.view'), L.ah(async (req, res) => {
    const reg = L.normalizeReg(req.query.registration || '');
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE registration = ?').get(reg);
    const sessions = db.prepare(`SELECT s.*, cat.code AS category_code, cat.name AS category_name, cat.kind AS category_kind
      FROM parking_sessions s JOIN parking_categories cat ON cat.id = s.category_id
      WHERE s.registration = ? ORDER BY s.id DESC LIMIT 200`).all(reg);
    const subs = db.prepare(`SELECT ms.*, p.name AS package_name FROM monthly_subscriptions ms
      JOIN monthly_packages p ON p.id = ms.package_id WHERE ms.registration = ? ORDER BY ms.id DESC`).all(reg);
    const paid = sessions.filter(s => s.status === 'exited').reduce((a, s) => a + Number(s.amount_paid || 0), 0);
    const comp = sessions.filter(s => s.payment_status === 'complimentary').length;
    const discounts = db.prepare(`SELECT COALESCE(SUM(d.discount_amount),0) t FROM discounts d
      JOIN parking_sessions s ON s.id = d.session_id WHERE s.registration = ? AND d.status IN ('applied','approved')`).get(reg).t || 0;
    res.json({
      data: {
        vehicle, sessions, subscriptions: subs,
        stats: {
          visits: sessions.length, total_paid: L.round2(paid), complimentary: comp,
          discounts: L.round2(discounts),
          last_visit: sessions.length ? sessions[0].entry_time : null,
          first_visit: sessions.length ? sessions[sessions.length - 1].entry_time : null
        }
      }
    });
  }));

  // ================= SHIFTS =================
  function shiftExpected(shiftId) {
    const rows = db.prepare(`SELECT method, COALESCE(SUM(amount),0) t, COUNT(*) n FROM payments
      WHERE shift_id = ? AND verification_status IN ('verified','manual') GROUP BY method`).all(shiftId);
    const m = { cash: 0, mpesa: 0, card: 0 };
    for (const r of rows) m[r.method] = L.round2(r.t);
    return m;
  }

  app.post('/api/shifts/open', requireAuth, requirePerm('shifts.open'), L.ah(async (req, res) => {
    const existing = L.getOpenShift(db, req.user.id);
    if (existing) throw L.ApiError.conflict('SHIFT_OPEN', `You already have an open shift (#${existing.id}). Close it first.`);
    const b = req.body || {};
    const opening = L.validAmount(b.opening_cash || 0, { name: 'Opening cash' });
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO shifts (user_id, station, opened_at, opening_cash, status, created_at, updated_at)
      VALUES (?,?,?,?,?, ?,?)`).run(req.user.id, String(b.station || 'Main Gate').slice(0, 80), now, opening, 'open', now, now);
    L.audit(db, req, 'shift_open', 'shifts', String(r.lastInsertRowid), '', `float ${opening}`);
    res.status(201).json({ data: db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(r.lastInsertRowid)) });
  }));

  app.get('/api/shifts/current', requireAuth, (req, res) => {
    const s = L.getOpenShift(db, req.user.id);
    if (!s) return res.json({ data: null });
    const exp = shiftExpected(s.id);
    const txns = db.prepare('SELECT COUNT(*) c FROM payments WHERE shift_id = ?').get(s.id).c;
    res.json({ data: { ...s, expected_live: exp, transaction_count: txns } });
  });

  app.get('/api/shifts', requireAuth, requirePerm('shifts.view'), (req, res) => {
    const { from, to, user_id, status } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const conds = [], args = [];
    if (from) { conds.push("date(s.opened_at, 'localtime') >= ?"); args.push(from); }
    if (to) { conds.push("date(s.opened_at, 'localtime') <= ?"); args.push(to); }
    if (user_id) { conds.push('s.user_id = ?'); args.push(user_id); }
    if (status) { conds.push('s.status = ?'); args.push(status); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM shifts s ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT s.*, u.username, u.full_name, r.username AS reviewed_by_name FROM shifts s
      JOIN users u ON u.id = s.user_id LEFT JOIN users r ON r.id = s.reviewed_by
      ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });

  app.get('/api/shifts/:id', requireAuth, requirePerm('shifts.view'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = db.prepare(`SELECT s.*, u.username, u.full_name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(id);
    if (!s) throw L.ApiError.notFound('Shift');
    const txns = db.prepare(`SELECT p.*, ps.ticket_no, ps.registration FROM payments p
      LEFT JOIN parking_sessions ps ON ps.id = p.session_id WHERE p.shift_id = ? ORDER BY p.id`).all(id);
    const exp = s.status === 'closed'
      ? { cash: s.expected_cash, mpesa: s.expected_mpesa, card: s.expected_card }
      : shiftExpected(id);
    const sessionsHandled = db.prepare(`SELECT COUNT(*) c FROM parking_sessions
      WHERE (entry_user_id = ? AND entry_time >= ? AND entry_time <= ?) OR (exit_user_id = ? AND exit_time >= ? AND exit_time <= ?)`)
      .get(s.user_id, s.opened_at, s.closed_at || L.nowIso(), s.user_id, s.opened_at, s.closed_at || L.nowIso()).c;
    const discounts = db.prepare(`SELECT COALESCE(SUM(discount_amount),0) t, COUNT(*) n FROM discounts WHERE applied_by = ?
      AND created_at >= ? AND created_at <= ? AND status IN ('applied','approved')`).get(s.user_id, s.opened_at, s.closed_at || L.nowIso());
    const comp = db.prepare(`SELECT COUNT(*) c FROM complimentary_authorizations WHERE recorded_by = ?
      AND created_at >= ? AND created_at <= ?`).get(s.user_id, s.opened_at, s.closed_at || L.nowIso()).c;
    res.json({ data: { ...s, expected_live: exp, transactions: txns, sessions_handled: sessionsHandled, discounts, complimentary_count: comp } });
  }));

  app.post('/api/shifts/:id/close', requireAuth, requirePerm('shifts.close'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (!s) throw L.ApiError.notFound('Shift');
    if (s.status !== 'open') throw L.ApiError.bad('ALREADY_CLOSED', 'Shift is already closed');
    if (s.user_id !== req.user.id && !hasPerm(req, 'shifts.review'))
      throw L.ApiError.forbidden('You can only close your own shift');
    const b = req.body || {};
    const actual = {
      cash: L.validAmount(b.actual_cash ?? 0, { name: 'Actual cash' }),
      mpesa: L.validAmount(b.actual_mpesa ?? 0, { name: 'Actual M-Pesa' }),
      card: L.validAmount(b.actual_card ?? 0, { name: 'Actual card' })
    };
    const exp = shiftExpected(id);
    const variance = L.round2((actual.cash - exp.cash) + (actual.mpesa - exp.mpesa) + (actual.card - exp.card));
    if (variance !== 0 && !String(b.variance_note || '').trim())
      throw L.ApiError.bad('VARIANCE_NOTE_REQUIRED', `Variance of ${variance.toFixed(2)} requires an explanation`);
    const now = L.nowIso();
    db.prepare(`UPDATE shifts SET status = 'closed', closed_at = ?, expected_cash = ?, actual_cash = ?,
      expected_mpesa = ?, actual_mpesa = ?, expected_card = ?, actual_card = ?, variance_note = ?, updated_at = ? WHERE id = ?`)
      .run(now, exp.cash, actual.cash, exp.mpesa, actual.mpesa, exp.card, actual.card,
        String(b.variance_note || '').slice(0, 1000), now, id);
    L.audit(db, req, 'shift_close', 'shifts', String(id), '', `variance ${variance}`);
    if (variance !== 0) {
      L.notify(db, { type: 'shift_variance', title: 'Shift variance reported',
        message: `Shift #${id} closed with variance ${variance.toFixed(2)}`, link: `/shifts/${id}`, audience_role: 'Controller' });
      L.notify(db, { type: 'shift_variance', title: 'Shift variance reported',
        message: `Shift #${id} closed with variance ${variance.toFixed(2)}`, link: `/shifts/${id}`, audience_role: 'Manager' });
    }
    res.json({ data: db.prepare('SELECT * FROM shifts WHERE id = ?').get(id), expected: exp, variance });
  }));

  app.post('/api/shifts/:id/review', requireAuth, requirePerm('shifts.review'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (!s) throw L.ApiError.notFound('Shift');
    db.prepare('UPDATE shifts SET reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?').run(req.user.id, L.nowIso(), L.nowIso(), id);
    L.audit(db, req, 'shift_review', 'shifts', String(id), '', '');
    res.json({ ok: true });
  }));

  // ================= RECONCILIATION =================
  function reconCompute(date) {
    const rev = db.prepare(`SELECT method, COALESCE(SUM(amount),0) t, COUNT(*) n FROM payments
      WHERE date(paid_at, 'localtime') = ? AND verification_status IN ('verified','manual') GROUP BY method`).all(date);
    const m = { cash: 0, mpesa: 0, card: 0 };
    for (const r of rev) m[r.method] = L.round2(r.t);
    const exited = db.prepare(`SELECT c.kind, COUNT(*) n,
        SUM(CASE WHEN s.monthly_subscription_id IS NOT NULL THEN 1 ELSE 0 END) mon
      FROM parking_sessions s JOIN parking_categories c ON c.id = s.category_id
      WHERE s.status = 'exited' AND date(s.exit_time, 'localtime') = ? GROUP BY c.kind`).all(date);
    let paid = 0, comp = 0, monthly = 0;
    for (const r of exited) {
      if (r.kind === 'complimentary') comp = r.n;
      else { paid += r.n - r.mon; monthly += r.mon; }
    }
    const entered = db.prepare("SELECT COUNT(*) c FROM parking_sessions WHERE date(entry_time, 'localtime') = ? AND status != 'voided'").get(date).c;
    const discounts = db.prepare(`SELECT COALESCE(SUM(discount_amount),0) t, COUNT(*) n FROM discounts
      WHERE date(created_at, 'localtime') = ? AND status IN ('applied','approved')`).get(date);
    const refunds = db.prepare(`SELECT COALESCE(SUM(amount),0) t, COUNT(*) n FROM refunds WHERE status = 'processed' AND date(decided_at, 'localtime') = ?`).get(date);
    const shifts = db.prepare(`SELECT * FROM shifts WHERE status = 'closed' AND date(closed_at, 'localtime') = ?`).all(date);
    let variance = 0;
    for (const sh of shifts) {
      variance += (Number(sh.actual_cash) - Number(sh.expected_cash)) + (Number(sh.actual_mpesa) - Number(sh.expected_mpesa)) + (Number(sh.actual_card) - Number(sh.expected_card));
    }
    const mpesaManual = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM payments
      WHERE date(paid_at, 'localtime') = ? AND method = 'mpesa' AND verification_status = 'manual'`).get(date).t || 0;
    const mpesaVerified = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM payments
      WHERE date(paid_at, 'localtime') = ? AND method = 'mpesa' AND verification_status = 'verified'`).get(date).t || 0;
    const total = L.round2(m.cash + m.mpesa + m.card);
    return {
      recon_date: date, total_cash: m.cash, total_mpesa: m.mpesa, total_card: m.card, total_revenue: total,
      paid_vehicles: paid, complimentary_vehicles: comp, monthly_vehicles: monthly,
      total_vehicles: entered, entered_vehicles: entered, exited_vehicles: paid + comp + monthly,
      discounts_total: L.round2(discounts.t), discounts_count: discounts.n,
      refunds_total: L.round2(refunds.t), refunds_count: refunds.n,
      net_revenue: L.round2(total - refunds.t),
      variance: L.round2(variance), shifts_closed: shifts.length,
      mpesa_manual: L.round2(mpesaManual), mpesa_verified: L.round2(mpesaVerified)
    };
  }

  app.get('/api/reconciliation', requireAuth, requirePerm('recon.view'), (req, res) => {
    const date = req.query.date ? L.validDateStr(req.query.date) : L.todayStr();
    const saved = db.prepare(`SELECT r.*, u1.username AS supervisor_name, u2.username AS controller_name, u3.username AS manager_name
      FROM daily_reconciliations r LEFT JOIN users u1 ON u1.id = r.supervisor_by
      LEFT JOIN users u2 ON u2.id = r.controller_by LEFT JOIN users u3 ON u3.id = r.manager_by
      WHERE r.recon_date = ?`).get(date) || null;
    res.json({ computed: reconCompute(date), saved, settings: L.getSettings(db) });
  });

  app.get('/api/reconciliation/list', requireAuth, requirePerm('recon.view'), (req, res) => {
    const { from, to } = req.query;
    const conds = [], args = [];
    if (from) { conds.push('recon_date >= ?'); args.push(from); }
    if (to) { conds.push('recon_date <= ?'); args.push(to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    res.json({ data: db.prepare(`SELECT * FROM daily_reconciliations ${where} ORDER BY recon_date DESC LIMIT 120`).all(...args) });
  });

  app.post('/api/reconciliation', requireAuth, requirePerm('recon.edit'), L.ah(async (req, res) => {
    const b = req.body || {};
    const date = b.date ? L.validDateStr(b.date) : L.todayStr();
    const existing = db.prepare('SELECT * FROM daily_reconciliations WHERE recon_date = ?').get(date);
    if (existing && existing.status === 'finalized')
      throw L.ApiError.conflict('FINALIZED', 'This day is finalized and cannot be modified');
    const c = reconCompute(date);
    const now = L.nowIso();
    if (existing) {
      db.prepare(`UPDATE daily_reconciliations SET total_cash=?, total_mpesa=?, total_card=?, total_revenue=?,
        paid_vehicles=?, complimentary_vehicles=?, monthly_vehicles=?, total_vehicles=?, discounts_total=?, refunds_total=?,
        variance=?, notes=?, updated_at=? WHERE recon_date=?`)
        .run(c.total_cash, c.total_mpesa, c.total_card, c.total_revenue, c.paid_vehicles, c.complimentary_vehicles,
          c.monthly_vehicles, c.total_vehicles, c.discounts_total, c.refunds_total, c.variance,
          String(b.notes || existing.notes || '').slice(0, 2000), now, date);
    } else {
      db.prepare(`INSERT INTO daily_reconciliations (recon_date, total_cash, total_mpesa, total_card, total_revenue,
        paid_vehicles, complimentary_vehicles, monthly_vehicles, total_vehicles, discounts_total, refunds_total,
        variance, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(date, c.total_cash, c.total_mpesa, c.total_card, c.total_revenue, c.paid_vehicles, c.complimentary_vehicles,
          c.monthly_vehicles, c.total_vehicles, c.discounts_total, c.refunds_total, c.variance, 'draft',
          String(b.notes || '').slice(0, 2000), now, now);
    }
    L.audit(db, req, 'recon_save', 'reconciliation', date, '', `rev ${c.total_revenue}`);
    res.json({ data: db.prepare('SELECT * FROM daily_reconciliations WHERE recon_date = ?').get(date) });
  }));

  app.post('/api/reconciliation/:date/review', requireAuth, L.ah(async (req, res) => {
    const date = L.validDateStr(req.params.date);
    const { stage } = req.body || {};
    const r = db.prepare('SELECT * FROM daily_reconciliations WHERE recon_date = ?').get(date);
    if (!r) throw L.ApiError.bad('NO_DRAFT', 'Save a reconciliation draft for this day first');
    if (r.status === 'finalized') throw L.ApiError.conflict('FINALIZED', 'This day is finalized');
    const now = L.nowIso();
    if (stage === 'supervisor') {
      if (!hasPerm(req, 'recon.review.supervisor')) throw L.ApiError.forbidden();
      if (r.status !== 'draft') throw L.ApiError.bad('INVALID_STAGE', 'Supervisor review applies to drafts');
      db.prepare("UPDATE daily_reconciliations SET status='supervisor_reviewed', supervisor_by=?, supervisor_at=?, updated_at=? WHERE recon_date=?")
        .run(req.user.id, now, now, date);
    } else if (stage === 'controller') {
      if (!hasPerm(req, 'recon.review.controller')) throw L.ApiError.forbidden();
      if (r.status !== 'supervisor_reviewed') throw L.ApiError.bad('INVALID_STAGE', 'Controller review requires supervisor review first');
      db.prepare("UPDATE daily_reconciliations SET status='controller_reviewed', controller_by=?, controller_at=?, updated_at=? WHERE recon_date=?")
        .run(req.user.id, now, now, date);
    } else throw L.ApiError.bad('INVALID_STAGE', 'Stage must be supervisor or controller');
    L.audit(db, req, 'recon_review_' + stage, 'reconciliation', date, r.status, stage);
    res.json({ data: db.prepare('SELECT * FROM daily_reconciliations WHERE recon_date = ?').get(date) });
  }));

  app.post('/api/reconciliation/:date/finalize', requireAuth, requirePerm('recon.finalize'), L.ah(async (req, res) => {
    const date = L.validDateStr(req.params.date);
    const r = db.prepare('SELECT * FROM daily_reconciliations WHERE recon_date = ?').get(date);
    if (!r) throw L.ApiError.bad('NO_DRAFT', 'Save a reconciliation draft for this day first');
    if (r.status === 'finalized') throw L.ApiError.conflict('FINALIZED', 'Already finalized');
    if (r.status !== 'controller_reviewed')
      throw L.ApiError.bad('INVALID_STAGE', 'Finalization requires controller review first');
    const c = reconCompute(date);
    const now = L.nowIso();
    db.prepare(`UPDATE daily_reconciliations SET total_cash=?, total_mpesa=?, total_card=?, total_revenue=?,
      paid_vehicles=?, complimentary_vehicles=?, monthly_vehicles=?, total_vehicles=?, discounts_total=?, refunds_total=?,
      variance=?, status='finalized', manager_by=?, manager_at=?, updated_at=? WHERE recon_date=?`)
      .run(c.total_cash, c.total_mpesa, c.total_card, c.total_revenue, c.paid_vehicles, c.complimentary_vehicles,
        c.monthly_vehicles, c.total_vehicles, c.discounts_total, c.refunds_total, c.variance, req.user.id, now, now, date);
    L.audit(db, req, 'recon_finalize', 'reconciliation', date, r.status, 'finalized');
    L.notify(db, { type: 'recon_finalized', title: 'Day finalized', message: `${date} finalized. Revenue ${c.total_revenue.toFixed(2)}`, link: '/reconciliation', audience_role: '' });
    res.json({ data: db.prepare('SELECT * FROM daily_reconciliations WHERE recon_date = ?').get(date) });
  }));

  // ================= REFUNDS =================
  app.get('/api/refunds', requireAuth, requirePerm('payments.view'), (req, res) => {
    const { status } = req.query;
    const where = status ? 'WHERE r.status = ?' : '';
    const args = status ? [status] : [];
    res.json({ data: db.prepare(`SELECT r.*, p.method, p.amount AS payment_amount, p.reference, s.ticket_no, s.registration,
        u1.username AS requested_by_name, u2.username AS approved_by_name
      FROM refunds r JOIN payments p ON p.id = r.payment_id LEFT JOIN parking_sessions s ON s.id = r.session_id
      LEFT JOIN users u1 ON u1.id = r.requested_by LEFT JOIN users u2 ON u2.id = r.approved_by
      ${where} ORDER BY r.id DESC LIMIT 200`).all(...args) });
  });

  app.post('/api/refunds', requireAuth, requirePerm('payments.refund.request'), L.ah(async (req, res) => {
    const { payment_id, amount, reason } = req.body || {};
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(payment_id));
    if (!p) throw L.ApiError.notFound('Payment');
    if (!['verified', 'manual'].includes(p.verification_status)) throw L.ApiError.bad('INVALID_PAYMENT', 'Only settled payments can be refunded');
    if (!String(reason || '').trim()) throw L.ApiError.bad('REASON_REQUIRED', 'A refund reason is required');
    const already = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE payment_id = ? AND status != 'rejected'`).get(p.id).t || 0;
    const amt = L.validAmount(amount != null ? amount : p.amount - already, { min: 0.01, name: 'Refund amount' });
    if (amt > L.round2(p.amount - already)) throw L.ApiError.bad('EXCEEDS_PAYMENT', 'Refund exceeds the refundable balance');
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO refunds (payment_id, session_id, amount, reason, status, requested_by, created_at, decided_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(p.id, p.session_id, amt, String(reason).slice(0, 500), 'pending', req.user.id, now, null);
    L.notify(db, { type: 'refund_pending', title: 'Refund awaiting approval', message: `${amt.toFixed(2)} on payment #${p.id} by ${req.user.username}`, link: '/payments', audience_role: 'Manager' });
    L.audit(db, req, 'refund_request', 'refunds', String(r.lastInsertRowid), '', `${amt} payment ${p.id}`);
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
  }));

  app.post('/api/refunds/:id/decision', requireAuth, requirePerm('payments.refund.approve'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
    if (!r) throw L.ApiError.notFound('Refund');
    const { decision } = req.body || {};
    if (!['approved', 'rejected', 'processed'].includes(decision)) throw L.ApiError.bad('INVALID_DECISION', 'Invalid decision');
    if (r.status !== 'pending' && !(r.status === 'approved' && decision === 'processed'))
      throw L.ApiError.bad('INVALID_STATUS', 'Refund is already decided');
    db.prepare('UPDATE refunds SET status = ?, approved_by = ?, decided_at = ? WHERE id = ?')
      .run(decision, req.user.id, L.nowIso(), id);
    L.audit(db, req, 'refund_' + decision, 'refunds', String(id), r.status, decision);
    res.json({ ok: true });
  }));

  // ================= BILLING / INVOICES =================
  const invoiceDetail = id => {
    const inv = L.invoiceDisplay(L.invoiceById(db, id));
    if (!inv) return null;
    inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
    inv.payments = db.prepare(`SELECT p.*, u.username AS received_by_name FROM payments p
      LEFT JOIN users u ON u.id = p.received_by WHERE p.invoice_id = ? ORDER BY p.id`).all(id);
    return inv;
  };

  app.get('/api/invoices', requireAuth, requirePerm('billing.view'), (req, res) => {
    const { status, q } = req.query;
    const conds = [], args = [];
    if (q) { const like = `%${q}%`; conds.push('(invoice_no LIKE ? OR customer_name LIKE ? OR company LIKE ? OR registration LIKE ?)'); args.push(like, like, like, like); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    let rows = db.prepare(`SELECT * FROM invoices ${where} ORDER BY id DESC LIMIT 500`).all(...args).map(r => L.invoiceDisplay(r));
    if (status && status !== 'all') rows = rows.filter(r => r.display_status === status);
    res.json({ data: rows });
  });

  app.post('/api/invoices', requireAuth, requirePerm('billing.manage'), L.ah(async (req, res) => {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw L.ApiError.bad('ITEMS_REQUIRED', 'At least one invoice line item is required');
    const lines = items.map(it => {
      const desc = String(it.description || '').trim();
      if (!desc) throw L.ApiError.bad('VALIDATION', 'Each line item needs a description');
      const qty = Number(it.quantity != null ? it.quantity : 1);
      if (!(qty > 0)) throw L.ApiError.bad('VALIDATION', 'Line quantity must be greater than zero');
      const price = L.validAmount(it.unit_price != null ? it.unit_price : 0, { name: 'Unit price' });
      return { description: desc.slice(0, 300), quantity: qty, unit_price: price, amount: L.round2(qty * price) };
    });
    const subtotal = L.round2(lines.reduce((a, l) => a + l.amount, 0));
    if (!(subtotal > 0)) throw L.ApiError.bad('VALIDATION', 'Invoice total must be greater than zero');
    const discount = L.validAmount(b.discount_amount != null ? b.discount_amount : 0, { name: 'Discount' });
    if (discount > subtotal) throw L.ApiError.bad('INVALID_DISCOUNT', 'Discount exceeds the subtotal');
    const total = L.round2(subtotal - discount);
    const today = L.todayStr();
    const due = b.due_date ? L.validDateStr(b.due_date, 'Due date') : L.addDaysStr(today, 7);
    if (due < today) throw L.ApiError.bad('INVALID_DATES', 'Due date cannot be in the past');
    const now = L.nowIso();
    const invoiceNo = L.nextInvoiceNo(db, today);
    const r = db.prepare(`INSERT INTO invoices (invoice_no, customer_name, company, phone, email, registration,
        subscription_id, session_id, issue_date, due_date, subtotal, discount_amount, total, amount_paid, balance,
        status, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      invoiceNo, String(b.customer_name || '').trim().slice(0, 200), String(b.company || '').trim().slice(0, 200),
      L.validPhone(b.phone || ''), String(b.email || '').trim().slice(0, 200),
      b.registration ? L.normalizeReg(b.registration) : '',
      b.subscription_id != null ? Number(b.subscription_id) : null,
      b.session_id != null ? Number(b.session_id) : null,
      today, due, subtotal, discount, total, 0, total, 'unpaid',
      String(b.notes || '').slice(0, 1000), req.user.id, now, now);
    const invId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)');
    for (const l of lines) ins.run(invId, l.description, l.quantity, l.unit_price, l.amount);
    L.audit(db, req, 'invoice_create', 'invoices', String(invId), '', `${invoiceNo} ${total}`);
    res.status(201).json({ data: invoiceDetail(invId) });
  }));

  app.get('/api/invoices/:id', requireAuth, requirePerm('billing.view'), (req, res) => {
    const inv = invoiceDetail(Number(req.params.id));
    if (!inv) throw L.ApiError.notFound('Invoice');
    res.json({ data: inv });
  });

  app.put('/api/invoices/:id', requireAuth, requirePerm('billing.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const inv = L.invoiceById(db, id);
    if (!inv) throw L.ApiError.notFound('Invoice');
    if (inv.status !== 'unpaid') throw L.ApiError.bad('INVALID_STATUS', 'Only unpaid invoices can be edited');
    const b = req.body || {};
    const update = db.transaction(() => {
      if (Array.isArray(b.items)) {
        if (!b.items.length) throw L.ApiError.bad('ITEMS_REQUIRED', 'At least one invoice line item is required');
        db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
        const ins = db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)');
        let sub = 0;
        for (const it of b.items) {
          const desc = String(it.description || '').trim();
          if (!desc) throw L.ApiError.bad('VALIDATION', 'Each line item needs a description');
          const qty = Number(it.quantity != null ? it.quantity : 1);
          if (!(qty > 0)) throw L.ApiError.bad('VALIDATION', 'Line quantity must be greater than zero');
          const price = L.validAmount(it.unit_price != null ? it.unit_price : 0, { name: 'Unit price' });
          const amt = L.round2(qty * price);
          ins.run(id, desc.slice(0, 300), qty, price, amt);
          sub = L.round2(sub + amt);
        }
        if (!(sub > 0)) throw L.ApiError.bad('VALIDATION', 'Invoice total must be greater than zero');
        const discount = L.validAmount(b.discount_amount != null ? b.discount_amount : inv.discount_amount, { name: 'Discount' });
        if (discount > sub) throw L.ApiError.bad('INVALID_DISCOUNT', 'Discount exceeds the subtotal');
        db.prepare('UPDATE invoices SET subtotal = ?, discount_amount = ?, total = ?, balance = ?, updated_at = ? WHERE id = ?')
          .run(sub, discount, L.round2(sub - discount), L.round2(sub - discount), L.nowIso(), id);
      }
      db.prepare(`UPDATE invoices SET customer_name = COALESCE(?, customer_name), company = COALESCE(?, company),
        phone = COALESCE(?, phone), email = COALESCE(?, email), due_date = COALESCE(?, due_date),
        notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`)
        .run(b.customer_name ?? null, b.company ?? null, b.phone ?? null, b.email ?? null,
          b.due_date ? L.validDateStr(b.due_date, 'Due date') : null, b.notes ?? null, L.nowIso(), id);
    });
    update();
    L.audit(db, req, 'invoice_update', 'invoices', String(id), '', '');
    res.json({ data: invoiceDetail(id) });
  }));

  app.post('/api/invoices/:id/pay', requireAuth, requirePerm('billing.view'), requirePerm('payments.collect'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const inv = L.invoiceById(db, id);
    if (!inv) throw L.ApiError.notFound('Invoice');
    if (inv.status === 'voided') throw L.ApiError.bad('INVALID_STATUS', 'Voided invoices cannot be paid');
    if (inv.status === 'paid') throw L.ApiError.bad('ALREADY_PAID', 'Invoice is already fully paid');
    const b = req.body || {};
    const method = b.method || 'cash';
    if (!PAY_METHODS.includes(method)) throw L.ApiError.bad('INVALID_METHOD', 'Invalid payment method');
    const amt = L.validAmount(b.amount != null ? b.amount : inv.balance, { min: 0.01, name: 'Payment amount' });
    if (amt > inv.balance) throw L.ApiError.bad('EXCEEDS_BALANCE', `Payment exceeds the ${inv.balance.toFixed(2)} balance`);
    const shift = L.getOpenShift(db, req.user.id);
    if (!shift) throw L.ApiError.conflict('SHIFT_REQUIRED', 'Open a shift before collecting payments');
    const pay = L.recordPayment(db, { invoice_id: id, amount: amt, method,
      reference: String(b.reference || '').trim().toUpperCase(),
      verification_status: method === 'cash' ? 'verified' : 'manual',
      terminal: String(b.terminal || '').trim(), shift_id: shift.id, received_by: req.user.id,
      notes: String(b.notes || '').slice(0, 500) });
    L.audit(db, req, 'invoice_pay', 'invoices', String(id), '', `${amt} ${method}`);
    res.status(201).json({ data: pay, invoice: invoiceDetail(id) });
  }));

  app.post('/api/invoices/:id/void', requireAuth, requirePerm('billing.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const inv = L.invoiceById(db, id);
    if (!inv) throw L.ApiError.notFound('Invoice');
    if (inv.status === 'voided') throw L.ApiError.bad('INVALID_STATUS', 'Invoice is already voided');
    const n = db.prepare('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?').get(id).c;
    if (n > 0) throw L.ApiError.bad('VOID_HAS_PAYMENTS', 'Invoices with recorded payments cannot be voided - issue a refund instead');
    if (!String((req.body || {}).reason || '').trim()) throw L.ApiError.bad('REASON_REQUIRED', 'A void reason is required');
    db.prepare('UPDATE invoices SET status = ?, balance = 0, notes = ?, updated_at = ? WHERE id = ?')
      .run('voided', `${inv.notes || ''} [VOIDED: ${String(req.body.reason).slice(0, 300)}]`.trim(), L.nowIso(), id);
    L.audit(db, req, 'invoice_void', 'invoices', String(id), inv.status, 'voided');
    res.json({ data: invoiceDetail(id) });
  }));

  // ================= SETTLEMENT =================
  app.get('/api/settlement', requireAuth, requirePerm('settlement.view'), (req, res) => {
    const date = req.query.date ? L.validDateStr(req.query.date) : L.todayStr();
    const GOOD = "p.verification_status IN ('verified','manual')";
    const byMethod = db.prepare(`SELECT p.method, COUNT(*) n, COALESCE(SUM(p.amount),0) t FROM payments p
      WHERE ${GOOD} AND date(p.paid_at, 'localtime') = ? GROUP BY p.method`).all(date);
    const rows = db.prepare(`SELECT p.amount, p.method,
        COALESCE(NULLIF(s.customer_name,''), NULLIF(s.registration,''), NULLIF(ms.customer_name,''), NULLIF(i.company,''), NULLIF(i.customer_name,''), 'Walk-in') AS payer
      FROM payments p
      LEFT JOIN parking_sessions s ON s.id = p.session_id
      LEFT JOIN monthly_subscriptions ms ON ms.id = p.subscription_id
      LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE ${GOOD} AND date(p.paid_at, 'localtime') = ?`).all(date);
    const byClientMap = {};
    for (const r of rows) {
      byClientMap[r.payer] = byClientMap[r.payer] || { payer: r.payer, total: 0, count: 0 };
      byClientMap[r.payer].total = L.round2(byClientMap[r.payer].total + r.amount);
      byClientMap[r.payer].count += 1;
    }
    const sessionsOut = db.prepare(`SELECT s.id, s.ticket_no, s.registration, s.customer_name, s.status,
        ROUND(COALESCE(s.base_amount,0) - COALESCE(s.discount_amount,0) - COALESCE(s.amount_paid,0), 2) AS due
      FROM parking_sessions s WHERE s.status != 'voided'
      AND (COALESCE(s.base_amount,0) - COALESCE(s.discount_amount,0) - COALESCE(s.amount_paid,0)) > 0.005
      ORDER BY s.id DESC LIMIT 200`).all();
    const invoicesOut = db.prepare(`SELECT * FROM invoices WHERE status IN ('unpaid','partial') AND balance > 0.005 ORDER BY due_date LIMIT 200`)
      .all().map(r => L.invoiceDisplay(r));
    res.json({ data: {
      date,
      by_method: byMethod.map(r => ({ method: r.method, count: r.n, total: L.round2(r.t) })),
      by_client: Object.values(byClientMap).sort((a, b2) => b2.total - a.total),
      outstanding_sessions: sessionsOut,
      outstanding_invoices: invoicesOut,
      totals: {
        collected: L.round2(rows.reduce((a, r) => a + r.amount, 0)),
        outstanding_sessions: L.round2(sessionsOut.reduce((a, r) => a + r.due, 0)),
        outstanding_invoices: L.round2(invoicesOut.reduce((a, r) => a + r.balance, 0))
      }
    }});
  });

  // ================= VALIDATION CODES =================
  app.get('/api/validations', requireAuth, requirePerm('validations.view'), (req, res) => {
    const { status, q } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 50);
    db.prepare("UPDATE validation_codes SET status = 'expired' WHERE status = 'unused' AND expires_at IS NOT NULL AND expires_at < ?").run(L.nowIso());
    const conds = [], args = [];
    if (status) { conds.push('v.status = ?'); args.push(status); }
    if (q) { conds.push('(v.code LIKE ? OR v.notes LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM validation_codes v ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT v.*, u.username AS created_by_name, s.ticket_no AS used_ticket
      FROM validation_codes v LEFT JOIN users u ON u.id = v.created_by
      LEFT JOIN parking_sessions s ON s.id = v.used_by_session
      ${where} ORDER BY v.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });

  app.post('/api/validations', requireAuth, requirePerm('validations.manage'), (req, res) => {
    const b = req.body || {};
    const maxAmount = b.max_amount == null || b.max_amount === '' ? null : Number(b.max_amount);
    if (maxAmount != null && (!Number.isFinite(maxAmount) || maxAmount <= 0))
      throw L.ApiError.bad('BAD_AMOUNT', 'max_amount must be a positive number');
    const days = b.valid_days == null || b.valid_days === '' ? 1 : Number(b.valid_days);
    if (!Number.isFinite(days) || days <= 0 || days > 90)
      throw L.ApiError.bad('BAD_VALIDITY', 'valid_days must be between 1 and 90');
    const code = L.nextValidationCode(db);
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO validation_codes (code, max_amount, status, expires_at, notes, created_by, created_at)
      VALUES (?,?,'unused',?,?,?,?)`).run(code, maxAmount, expires, String(b.notes || '').slice(0, 200), req.user.id, now);
    L.audit(db, req, 'validation_issue', 'validations', code, '', `max=${maxAmount == null ? 'full' : maxAmount}`);
    res.status(201).json({ data: db.prepare('SELECT * FROM validation_codes WHERE id = ?').get(r.lastInsertRowid) });
  });

  app.post('/api/validations/:id/revoke', requireAuth, requirePerm('validations.manage'), (req, res) => {
    const v = db.prepare('SELECT * FROM validation_codes WHERE id = ?').get(Number(req.params.id));
    if (!v) throw L.ApiError.notFound('Validation code');
    if (v.status !== 'unused') throw L.ApiError.bad('CODE_LOCKED', 'Only unused codes can be revoked');
    db.prepare("UPDATE validation_codes SET status = 'revoked' WHERE id = ?").run(v.id);
    L.audit(db, req, 'validation_revoke', 'validations', v.code, '', String((req.body || {}).reason || ''));
    res.json({ data: db.prepare('SELECT * FROM validation_codes WHERE id = ?').get(v.id) });
  });

  // ================= ACCESS CONTROL =================
  app.post('/api/access/check', requireAuth, requirePerm('access.view'), L.ah(async (req, res) => {
    const registration = L.normalizeReg((req.body || {}).registration);
    L.refreshExpiredSubs(db);
    const active = db.prepare(`SELECT s.*, c.code AS category_code FROM parking_sessions s
      JOIN parking_categories c ON c.id = s.category_id
      WHERE s.registration = ? AND s.status = 'active'`).get(registration);
    const sub = L.findActiveSub(db, registration);
    let verdict, reason;
    if (active) {
      verdict = 'DENIED';
      reason = `Already parked (ticket ${active.ticket_no}). Exit the vehicle first - duplicate entry is not allowed.`;
    } else if (sub) {
      verdict = 'AUTHORIZED';
      reason = `Active monthly subscription (${sub.customer_name}, expires ${sub.expiry_date}). Admit as monthly.`;
    } else {
      verdict = 'AUTHORIZED';
      reason = 'No active session or subscription. Admit as casual - fee payable on exit.';
    }
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO access_logs (registration, verdict, reason, subscription_id, session_id, checked_by, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(registration, verdict, reason, sub ? sub.id : null, active ? active.id : null, req.user.id, now);
    L.audit(db, req, 'access_check', 'access', String(r.lastInsertRowid), '', `${registration} ${verdict}`);
    res.json({ data: { id: Number(r.lastInsertRowid), registration, verdict, reason,
      subscription: sub || null, active_session: active || null,
      suggested_category: active ? null : (sub ? 'monthly' : 'daily') } });
  }));

  app.get('/api/access/log', requireAuth, requirePerm('access.view'), (req, res) => {
    const { date, verdict, q } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 50);
    const conds = [], args = [];
    if (date) { L.validDateStr(date); conds.push("date(created_at, 'localtime') = ?"); args.push(date); }
    if (verdict) { conds.push('verdict = ?'); args.push(verdict); }
    if (q) { conds.push('registration LIKE ?'); args.push(`%${q}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM access_logs ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT a.*, u.username AS checked_by_name FROM access_logs a
      LEFT JOIN users u ON u.id = a.checked_by ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ ...L.pageResult(rows, total, page, pageSize) });
  });

  // ================= GATE =================
  app.post('/api/gate/open', requireAuth, requirePerm('sessions.exit'), L.ah(async (req, res) => {
    const b = req.body || {};
    const reason = String(b.reason || '').trim();
    if (!reason) throw L.ApiError.bad('REASON_REQUIRED', 'A reason is required to open the gate');
    const sessionId = b.session_id == null || b.session_id === '' ? null : Number(b.session_id);
    if (sessionId != null && !Number.isInteger(sessionId))
      throw L.ApiError.bad('BAD_SESSION', 'session_id must be an integer');
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO gate_logs (session_id, action, reason, opened_by, created_at)
      VALUES (?,?,?,?,?)`).run(sessionId, b.action === 'override' ? 'override' : 'open', reason, req.user.id, now);
    L.audit(db, req, 'gate_open', 'gate', String(r.lastInsertRowid), '', reason.slice(0, 120));
    res.status(201).json({ data: db.prepare(`SELECT g.*, u.username AS opened_by_name
      FROM gate_logs g LEFT JOIN users u ON u.id = g.opened_by WHERE g.id = ?`).get(r.lastInsertRowid) });
  }));

  app.get('/api/gate/log', requireAuth, requirePerm('sessions.view'), (req, res) => {
    const { date, q } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 50);
    const conds = [], args = [];
    if (date) { L.validDateStr(date); conds.push("date(g.created_at, 'localtime') = ?"); args.push(date); }
    if (q) { conds.push('(s.ticket_no LIKE ? OR g.reason LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM gate_logs g LEFT JOIN parking_sessions s ON s.id = g.session_id ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT g.*, u.username AS opened_by_name, s.ticket_no, s.registration
      FROM gate_logs g LEFT JOIN users u ON u.id = g.opened_by
      LEFT JOIN parking_sessions s ON s.id = g.session_id
      ${where} ORDER BY g.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });

  // ================= ANPR =================
  // Camera webhook: plate in, verdict + suggested gate action out. 60 s dedupe per plate.
  app.post('/api/anpr/event', requireAuth, requirePerm('access.view'), L.ah(async (req, res) => {
    const b = req.body || {};
    const rawPlate = String(b.plate || b.registration || '').trim();
    if (!rawPlate) throw L.ApiError.bad('PLATE_REQUIRED', 'A plate/registration is required');
    const registration = L.normalizeReg(rawPlate);
    const camera = String(b.camera_id || b.camera || 'gate').slice(0, 40);
    const recent = db.prepare(`SELECT * FROM access_logs WHERE registration = ?
      AND (strftime('%s','now') - strftime('%s', created_at)) < 60
      ORDER BY id DESC LIMIT 1`).get(registration);
    if (recent) {
      return res.json({ data: { id: recent.id, registration, verdict: recent.verdict, reason: recent.reason,
        suggested_action: recent.verdict === 'DENIED' ? 'deny_duplicate'
          : (recent.subscription_id ? 'open_gate_monthly' : 'admit_cashier'),
        subscription_id: recent.subscription_id, session_id: recent.session_id,
        camera, deduped: true } });
    }
    L.refreshExpiredSubs(db);
    const active = db.prepare(`SELECT s.*, c.code AS category_code FROM parking_sessions s
      JOIN parking_categories c ON c.id = s.category_id
      WHERE s.registration = ? AND s.status = 'active'`).get(registration);
    const sub = L.findActiveSub(db, registration);
    let verdict, reason, action;
    if (active) {
      verdict = 'DENIED'; action = 'deny_duplicate';
      reason = `ANPR ${camera}: already parked (ticket ${active.ticket_no}). Keep gate closed.`;
    } else if (sub) {
      verdict = 'AUTHORIZED'; action = 'open_gate_monthly';
      reason = `ANPR ${camera}: monthly ${sub.customer_name}, expires ${sub.expiry_date}. Open gate.`;
    } else {
      verdict = 'AUTHORIZED'; action = 'admit_cashier';
      reason = `ANPR ${camera}: no subscription. Admit as casual, fee on exit.`;
    }
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO access_logs (registration, verdict, reason, subscription_id, session_id, checked_by, created_at)
      VALUES (?,?,?,?,?,NULL,?)`).run(registration, verdict, reason, sub ? sub.id : null, active ? active.id : null, now);
    L.audit(db, req, 'anpr_event', 'access', String(r.lastInsertRowid), '', `${camera} ${registration} ${verdict}`);
    res.json({ data: { id: Number(r.lastInsertRowid), registration, verdict, reason, suggested_action: action,
      subscription: sub || null, active_session: active || null, camera, deduped: false } });
  }));

  // ================= RATES =================
  app.get('/api/rates', requireAuth, requirePerm('settings.view'), (req, res) => {
    const st = L.getSettings(db);
    const cats = db.prepare('SELECT * FROM parking_categories ORDER BY kind, name').all();
    res.json({ data: cats.map(c => ({
      id: c.id, code: c.code, name: c.name, kind: c.kind, active: c.active,
      hourly_rate: c.hourly_rate != null ? c.hourly_rate : st.hourly_rate,
      daily_rate: c.daily_rate != null ? c.daily_rate : st.daily_rate,
      max_charge: c.max_charge, grace_minutes: c.grace_minutes != null ? c.grace_minutes : st.grace_period_minutes,
      overridden: { hourly: c.hourly_rate != null, daily: c.daily_rate != null, max: c.max_charge != null, grace: c.grace_minutes != null }
    })), settings: { hourly_enabled: st.hourly_enabled, hourly_rate: st.hourly_rate, daily_rate: st.daily_rate,
      grace_period_minutes: st.grace_period_minutes, currency: st.currency } });
  });

  // ================= REPORTS =================
  app.get('/api/reports/:name', requireAuth, L.ah(async (req, res) => {
    const name = req.params.name;
    const financial = ['revenue', 'cash', 'mpesa', 'card', 'variance', 'refunds', 'discounts'].includes(name);
    if (financial) {
      if (!hasPerm(req, 'reports.financial')) throw L.ApiError.forbidden('Financial reports require additional permission');
    } else if (!hasPerm(req, 'reports.view')) throw L.ApiError.forbidden();
    const { from, to, user_id, method, category_id, q } = req.query;
    const f = from || L.addDaysStr(L.todayStr(), -30), t = to || L.todayStr();
    L.validDateStr(f); L.validDateStr(t);
    const ok = { settings: L.getSettings(db), from: f, to: t };
    const GOOD = "p.verification_status IN ('verified','manual')";

    if (name === 'daily' || name === 'weekly' || name === 'monthly') {
      const days = db.prepare(`SELECT date(paid_at, 'localtime') d, method, COALESCE(SUM(amount),0) t, COUNT(*) n FROM payments p
        WHERE ${GOOD} AND date(paid_at, 'localtime') BETWEEN ? AND ? GROUP BY d, method ORDER BY d`).all(f, t);
      const traffic = db.prepare(`SELECT date(entry_time, 'localtime') d, COUNT(*) entries,
        SUM(CASE WHEN status='exited' THEN 1 ELSE 0 END) exits FROM parking_sessions
        WHERE date(entry_time, 'localtime') BETWEEN ? AND ? AND status != 'voided' GROUP BY d ORDER BY d`).all(f, t);
      const comp = db.prepare(`SELECT date(ca.created_at, 'localtime') d, COUNT(*) n FROM complimentary_authorizations ca
        WHERE date(ca.created_at, 'localtime') BETWEEN ? AND ? GROUP BY d`).all(f, t);
      return res.json({ ...ok, revenue_by_day_method: days, traffic, complimentary: comp });
    }
    if (['revenue', 'cash', 'mpesa', 'card'].includes(name)) {
      const conds = [`date(p.paid_at, 'localtime') BETWEEN ? AND ?`], args = [f, t];
      if (name !== 'revenue') { conds.push('p.method = ?'); args.push(name); }
      if (user_id) { conds.push('p.received_by = ?'); args.push(user_id); }
      if (method) { conds.push('p.method = ?'); args.push(method); }
      if (q) { const like = `%${q}%`; conds.push('(p.reference LIKE ? OR s.ticket_no LIKE ? OR s.registration LIKE ?)'); args.push(like, like, like); }
      const where = 'WHERE ' + conds.join(' AND ');
      const rows = db.prepare(`SELECT p.*, s.ticket_no, s.registration, u.username AS received_by_name FROM payments p
        LEFT JOIN parking_sessions s ON s.id = p.session_id LEFT JOIN users u ON u.id = p.received_by
        ${where} ORDER BY p.paid_at DESC LIMIT 2000`).all(...args);
      const totals = db.prepare(`SELECT p.method, p.verification_status, COUNT(*) n, COALESCE(SUM(p.amount),0) t FROM payments p
        LEFT JOIN parking_sessions s ON s.id = p.session_id ${where} GROUP BY p.method, p.verification_status`).all(...args);
      const refunds = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE status='processed' AND date(decided_at, 'localtime') BETWEEN ? AND ?`).get(f, t).t || 0;
      let txns = [];
      if (name === 'mpesa') txns = db.prepare(`SELECT t.*, s.ticket_no FROM payment_transactions t
        LEFT JOIN parking_sessions s ON s.id = t.session_id WHERE date(t.created_at, 'localtime') BETWEEN ? AND ? ORDER BY t.id DESC LIMIT 500`).all(f, t);
      return res.json({ ...ok, rows, totals, refunds_total: L.round2(refunds), transactions: txns });
    }
    if (name === 'shifts') {
      const rows = db.prepare(`SELECT s.*, u.username FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE date(s.opened_at, 'localtime') BETWEEN ? AND ? ${user_id ? 'AND s.user_id = ' + Number(user_id) : ''} ORDER BY s.id DESC`).all(f, t);
      return res.json({ ...ok, rows });
    }
    if (name === 'variance') {
      const rows = db.prepare(`SELECT s.*, u.username,
        ((COALESCE(s.actual_cash,0)-s.expected_cash)+(COALESCE(s.actual_mpesa,0)-s.expected_mpesa)+(COALESCE(s.actual_card,0)-s.expected_card)) AS variance
        FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE s.status='closed' AND date(s.closed_at, 'localtime') BETWEEN ? AND ?
        AND (((COALESCE(s.actual_cash,0)-s.expected_cash)+(COALESCE(s.actual_mpesa,0)-s.expected_mpesa)+(COALESCE(s.actual_card,0)-s.expected_card)) != 0)
        ORDER BY s.closed_at DESC`).all(f, t);
      return res.json({ ...ok, rows });
    }
    if (name === 'complimentary') {
      const rows = db.prepare(`SELECT ca.*, s.ticket_no, s.registration, s.entry_time, s.exit_time, u.username AS recorded_by_name
        FROM complimentary_authorizations ca JOIN parking_sessions s ON s.id = ca.session_id
        LEFT JOIN users u ON u.id = ca.recorded_by
        WHERE date(ca.created_at, 'localtime') BETWEEN ? AND ? ORDER BY ca.id DESC LIMIT 2000`).all(f, t);
      const byCat = db.prepare(`SELECT comp_category, COUNT(*) n FROM complimentary_authorizations
        WHERE date(created_at, 'localtime') BETWEEN ? AND ? GROUP BY comp_category`).all(f, t);
      return res.json({ ...ok, rows, by_category: byCat });
    }
    if (name === 'monthly-customers') {
      L.refreshExpiredSubs(db);
      const rows = db.prepare(`SELECT ms.*, p.name AS package_name FROM monthly_subscriptions ms
        JOIN monthly_packages p ON p.id = ms.package_id
        WHERE (ms.start_date BETWEEN ? AND ? OR ms.expiry_date BETWEEN ? AND ? OR (ms.start_date <= ? AND ms.expiry_date >= ?))
        ORDER BY ms.expiry_date`).all(f, t, f, t, f, t);
      const revenue = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM subscription_payments WHERE date(paid_at, 'localtime') BETWEEN ? AND ?`).get(f, t).t || 0;
      return res.json({ ...ok, rows: rows.map(r => ({ ...r, days_remaining: L.diffDaysStr(L.todayStr(), r.expiry_date) })), revenue: L.round2(revenue) });
    }
    if (name === 'vehicle-history') {
      if (!q) throw L.ApiError.bad('REGISTRATION_REQUIRED', 'Registration query (q) is required');
      const reg = L.normalizeReg(q);
      const rows = db.prepare(`SELECT s.*, cat.name AS category_name FROM parking_sessions s
        JOIN parking_categories cat ON cat.id = s.category_id WHERE s.registration = ? ORDER BY s.id DESC LIMIT 500`).all(reg);
      const paid = rows.filter(r => r.status === 'exited').reduce((a, r) => a + Number(r.amount_paid || 0), 0);
      return res.json({ ...ok, registration: reg, rows, total_paid: L.round2(paid), visits: rows.length });
    }
    if (name === 'occupancy') {
      const hours = db.prepare(`SELECT strftime('%H', entry_time, 'localtime') h, COUNT(*) entries FROM parking_sessions
        WHERE date(entry_time, 'localtime') BETWEEN ? AND ? AND status != 'voided' GROUP BY h ORDER BY h`).all(f, t);
      const exits = db.prepare(`SELECT strftime('%H', exit_time, 'localtime') h, COUNT(*) n FROM parking_sessions
        WHERE status='exited' AND date(exit_time, 'localtime') BETWEEN ? AND ? GROUP BY h ORDER BY h`).all(f, t);
      return res.json({ ...ok, snapshot: L.occSummary(db), entries_by_hour: hours, exits_by_hour: exits });
    }
    if (name === 'user-activity') {
      const rows = db.prepare(`SELECT username, role, action, COUNT(*) n, MAX(created_at) last_at FROM audit_logs
        WHERE date(created_at, 'localtime') BETWEEN ? AND ? ${user_id ? 'AND user_id = ' + Number(user_id) : ''}
        GROUP BY username, role, action ORDER BY n DESC LIMIT 500`).all(f, t);
      const logins = db.prepare(`SELECT * FROM audit_logs WHERE action IN ('login','login_failed','logout')
        AND date(created_at, 'localtime') BETWEEN ? AND ? ORDER BY id DESC LIMIT 500`).all(f, t);
      return res.json({ ...ok, rows, logins });
    }
    if (name === 'discounts') {
      const rows = db.prepare(`SELECT d.*, s.ticket_no, s.registration, u1.username AS applied_by_name, u2.username AS approved_by_name
        FROM discounts d JOIN parking_sessions s ON s.id = d.session_id
        LEFT JOIN users u1 ON u1.id = d.applied_by LEFT JOIN users u2 ON u2.id = d.approved_by
        WHERE date(d.created_at, 'localtime') BETWEEN ? AND ? ORDER BY d.id DESC LIMIT 1000`).all(f, t);
      return res.json({ ...ok, rows });
    }
    if (name === 'refunds') {
      const rows = db.prepare(`SELECT r.*, p.method, s.ticket_no, s.registration, u1.username AS requested_by_name
        FROM refunds r JOIN payments p ON p.id = r.payment_id LEFT JOIN parking_sessions s ON s.id = r.session_id
        LEFT JOIN users u1 ON u1.id = r.requested_by
        WHERE date(r.created_at, 'localtime') BETWEEN ? AND ? ORDER BY r.id DESC`).all(f, t);
      return res.json({ ...ok, rows });
    }
    if (name === 'audit') {
      const { page, pageSize, limit, offset } = L.paginate(req, 50);
      const conds = ["date(created_at, 'localtime') BETWEEN ? AND ?"], args = [f, t];
      if (q) { const like = `%${q}%`; conds.push('(username LIKE ? OR action LIKE ? OR module LIKE ? OR record_id LIKE ?)'); args.push(like, like, like, like); }
      const where = 'WHERE ' + conds.join(' AND ');
      const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...args).c;
      const rows = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return res.json({ ...ok, ...L.pageResult(rows, total, page, pageSize) });
    }
    throw L.ApiError.notFound('Report');
  }));

  // ================= DASHBOARD =================
  app.get('/api/dashboard', requireAuth, requirePerm('dashboard.view'), (req, res) => {
    L.refreshExpiredSubs(db);
    const t = L.todayStr();
    const occ = L.occSummary(db);
    const rev = db.prepare(`SELECT method, COALESCE(SUM(amount),0) total FROM payments
      WHERE date(paid_at, 'localtime') = ? AND verification_status IN ('verified','manual') GROUP BY method`).all(t);
    const m = { cash: 0, mpesa: 0, card: 0 };
    for (const r of rev) m[r.method] = L.round2(r.total);
    const entered = db.prepare("SELECT COUNT(*) c FROM parking_sessions WHERE date(entry_time, 'localtime') = ? AND status != 'voided'").get(t).c;
    const exited = db.prepare("SELECT COUNT(*) c FROM parking_sessions WHERE status = 'exited' AND date(exit_time, 'localtime') = ?").get(t).c;
    const activeRows = db.prepare('SELECT id FROM parking_sessions WHERE status = ?').all('active');
    let outstanding = 0, outstandingCount = 0;
    for (const r of activeRows) {
      try { const q = L.quoteSession(db, r.id); if (q.due > 0) { outstanding += q.due; outstandingCount++; } } catch {}
    }
    const monthlyActive = db.prepare("SELECT COUNT(*) c FROM monthly_subscriptions WHERE status = 'active'").get().c;
    const monthlyExpired = db.prepare("SELECT COUNT(*) c FROM monthly_subscriptions WHERE status = 'expired'").get().c;
    const expiring = db.prepare(`SELECT s.*, p.name AS package_name FROM monthly_subscriptions s
      JOIN monthly_packages p ON p.id = s.package_id
      WHERE s.status = 'active' AND s.expiry_date BETWEEN ? AND ? ORDER BY s.expiry_date LIMIT 10`).all(t, L.addDaysStr(t, 7));
    const shifts = db.prepare(`SELECT * FROM shifts WHERE status = 'closed' AND date(closed_at, 'localtime') = ?`).all(t);
    let variance = 0;
    for (const sh of shifts) variance += (Number(sh.actual_cash) - Number(sh.expected_cash)) + (Number(sh.actual_mpesa) - Number(sh.expected_mpesa)) + (Number(sh.actual_card) - Number(sh.expected_card));
    const series = db.prepare(`SELECT date(paid_at, 'localtime') d, COALESCE(SUM(amount),0) total FROM payments
      WHERE date(paid_at, 'localtime') BETWEEN ? AND ? AND verification_status IN ('verified','manual') GROUP BY d ORDER BY d`)
      .all(L.addDaysStr(t, -6), t);
    const trafficSeries = db.prepare(`SELECT date(entry_time, 'localtime') d, COUNT(*) entries FROM parking_sessions
      WHERE date(entry_time, 'localtime') BETWEEN ? AND ? AND status != 'voided' GROUP BY d ORDER BY d`).all(L.addDaysStr(t, -6), t);
    const avgDur = db.prepare(`SELECT COALESCE(AVG((julianday(exit_time) - julianday(entry_time)) * 24 * 60), 0) m
      FROM parking_sessions WHERE status = 'exited' AND date(exit_time, 'localtime') = ?`).get(t).m;
    const recent = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 8').all();
    const shift = L.getOpenShift(db, req.user.id);
    res.json({
      occupancy: occ, revenue_today: { ...m, total: L.round2(m.cash + m.mpesa + m.card) },
      entered_today: entered, exited_today: exited,
      avg_duration_minutes: Math.round(Number(avgDur) || 0),
      outstanding: { amount: L.round2(outstanding), count: outstandingCount },
      monthly: { active: monthlyActive, expired: monthlyExpired, expiring: expiring.map(s => ({ ...s, days_remaining: L.diffDaysStr(t, s.expiry_date) })) },
      variance_today: L.round2(variance), revenue_series: series, traffic_series: trafficSeries,
      recent_activity: recent, my_shift: shift, settings: L.getSettings(db)
    });
    L.audit(db, req, 'dashboard_view', 'dashboard', '', '', '');
  });

  // ================= GLOBAL SEARCH =================
  app.get('/api/search', requireAuth, requirePerm('sessions.view'), (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ sessions: [], customers: [], subscriptions: [], payments: [] });
    const like = `%${q.toUpperCase()}%`;
    const sessions = db.prepare(`SELECT s.*, sp.code AS space_code FROM parking_sessions s
      LEFT JOIN parking_spaces sp ON sp.id = s.space_id
      WHERE s.ticket_no LIKE ? OR s.registration LIKE ? OR s.phone LIKE ? OR s.customer_name LIKE ?
      ORDER BY s.id DESC LIMIT 8`).all(like, like, like, like);
    const customers = hasPerm(req, 'customers.view') ? db.prepare(`SELECT * FROM customers
      WHERE deleted_at IS NULL AND (name LIKE ? OR phone LIKE ? OR company LIKE ?) LIMIT 8`).all(like, like, like) : [];
    const subscriptions = hasPerm(req, 'monthly.view') ? db.prepare(`SELECT ms.*, p.name AS package_name FROM monthly_subscriptions ms
      JOIN monthly_packages p ON p.id = ms.package_id
      WHERE ms.registration LIKE ? OR ms.customer_name LIKE ? OR ms.phone LIKE ? ORDER BY ms.id DESC LIMIT 8`).all(like, like, like) : [];
    const payments = hasPerm(req, 'payments.view') ? db.prepare(`SELECT p.*, s.ticket_no FROM payments p
      LEFT JOIN parking_sessions s ON s.id = p.session_id WHERE p.reference LIKE ? ORDER BY p.id DESC LIMIT 8`).all(like) : [];
    res.json({ sessions, customers, subscriptions, payments });
  });

  // ================= NOTIFICATIONS =================
  app.get('/api/notifications', requireAuth, (req, res) => {
    const role = req.user.role_name;
    const stored = db.prepare(`SELECT * FROM notifications
      WHERE (audience_role = '' OR audience_role IS NULL OR audience_role = ?) AND (user_id IS NULL OR user_id = ?)
      ORDER BY id DESC LIMIT 50`).all(role, req.user.id);
    const t = L.todayStr();
    const exp = db.prepare(`SELECT s.*, p.name AS package_name FROM monthly_subscriptions s
      JOIN monthly_packages p ON p.id = s.package_id
      WHERE s.status = 'active' AND s.expiry_date BETWEEN ? AND ? ORDER BY s.expiry_date LIMIT 20`).all(t, L.addDaysStr(t, 7));
    const alerts = exp.map(s => ({
      id: 'exp-' + s.id, computed: true, type: s.expiry_date < L.addDaysStr(t, 3) ? 'sub_expiring_soon' : 'sub_expiring',
      title: `Subscription expiring: ${s.registration}`,
      message: `${s.customer_name} - ${s.package_name} expires ${s.expiry_date} (${L.diffDaysStr(t, s.expiry_date)} days)`,
      link: '/monthly', created_at: L.nowIso()
    }));
    const unreadStored = stored.filter(n => !n.read_at).length;
    res.json({ stored, alerts, unread: unreadStored + alerts.length });
  });

  app.post('/api/notifications/:id/read', requireAuth, L.ah(async (req, res) => {
    const id = req.params.id;
    if (String(id).startsWith('exp-')) return res.json({ ok: true });
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(L.nowIso(), Number(id));
    res.json({ ok: true });
  }));

  app.post('/api/notifications/read-all', requireAuth, (req, res) => {
    const role = req.user.role_name;
    db.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL
      AND (audience_role = '' OR audience_role IS NULL OR audience_role = ?) AND (user_id IS NULL OR user_id = ?)`)
      .run(L.nowIso(), role, req.user.id);
    res.json({ ok: true });
  });

  // ================= AUDIT =================
  app.get('/api/audit', requireAuth, requirePerm('audit.view'), (req, res) => {
    const { action, module, user, from, to } = req.query;
    const { page, pageSize, limit, offset } = L.paginate(req, 50);
    const conds = [], args = [];
    if (action) { conds.push('action = ?'); args.push(action); }
    if (module) { conds.push('module = ?'); args.push(module); }
    if (user) { conds.push('(username LIKE ? OR user_id = ?)'); args.push(`%${user}%`, Number(user) || -1); }
    if (from) { conds.push("date(created_at, 'localtime') >= ?"); args.push(from); }
    if (to) { conds.push("date(created_at, 'localtime') <= ?"); args.push(to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  });
}

module.exports = { registerOpsRoutes };
