// Critical-workflow tests (spec section 38). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = 'test-secret-xyz';
process.env.SEED_ADMIN_PASSWORD = 'Admin@123';
// Deterministic auth behavior: the suite must pass regardless of backend/.env flags.
process.env.OPEN_ACCESS = 'false';
process.env.NO_LOGIN = 'false';

const { createApp, openDatabase } = require('./server');

let base, db, server, roles = {};
let adminTok, mgrTok, ctlTok, supTok, cashTok, attTok, secTok;
const H = t => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });

async function api(method, p, body, tok) {
  const res = await fetch(base + p, { method, headers: H(tok || ''), body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
let dailyCatId;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-'));
  db = await openDatabase(path.join(dir, 't.db'));
  server = createApp(db).listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = await api('POST', '/api/auth/login', { username: 'admin', password: 'Admin@123' });
  assert.equal(admin.status, 200);
  adminTok = admin.json.token;
  const rl = await api('GET', '/api/roles', null, adminTok);
  for (const r of rl.json.data) roles[r.name] = r.id;
  const mk = async (username, role) => {
    const u = await api('POST', '/api/users', { full_name: username, username, password: 'Pass@1234', role_id: roles[role] }, adminTok);
    assert.equal(u.status, 201, JSON.stringify(u.json));
    const l = await api('POST', '/api/auth/login', { username, password: 'Pass@1234' });
    return l.json.token;
  };
  mgrTok = await mk('t_manager', 'Manager');
  ctlTok = await mk('t_controller', 'Controller');
  supTok = await mk('t_super', 'Supervisor');
  cashTok = await mk('t_cashier', 'Cashier');
  attTok = await mk('t_attendant', 'Parking Attendant');
  secTok = await mk('t_security', 'Security');
  const cats = await api('GET', '/api/categories', null, adminTok);
  dailyCatId = cats.json.data.find(c => c.code === 'daily').id;
});
test.after(async () => { server.close(); db.close(); });

test('1. login works, wrong password rejected', async () => {
  const bad = await api('POST', '/api/auth/login', { username: 'admin', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'INVALID_CREDENTIALS');
});

test('2. RBAC denies unauthorized actions', async () => {
  const a = await api('POST', '/api/users', { full_name: 'x', username: 'x', password: 'Pass@1234', role_id: 1 }, attTok);
  assert.equal(a.status, 403);
  const b = await api('POST', '/api/reconciliation/2026-01-01/finalize', {}, attTok);
  assert.equal(b.status, 403);
  const c = await api('POST', '/api/sessions/entry', { registration: 'KXX999Z', category_id: dailyCatId }, secTok);
  assert.equal(c.status, 403);
});

test('3. vehicle entry occupies a bay; occupancy math holds', async () => {
  const before = await api('GET', '/api/spaces', null, attTok);
  assert.equal(before.json.occupancy.total, 150);
  const avail0 = before.json.occupancy.available;
  const e = await api('POST', '/api/sessions/entry', {
    registration: 'KAA 111A', vehicle_type: 'Saloon', customer_name: 'John Test',
    phone: '0722000001', category_id: dailyCatId
  }, attTok);
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.match(e.json.data.ticket_no, /^MA-\d{8}-\d{4}$/);
  assert.ok(e.json.data.space_code);
  const after = await api('GET', '/api/spaces', null, attTok);
  assert.equal(after.json.occupancy.available, avail0 - 1);
  assert.equal(after.json.occupancy.occupied, before.json.occupancy.occupied + 1);
});

test('4. duplicate active session blocked; override needs permission', async () => {
  const d = await api('POST', '/api/sessions/entry', { registration: 'KAA111A', category_id: dailyCatId }, attTok);
  assert.equal(d.status, 409);
  assert.equal(d.json.error.code, 'DUPLICATE_ACTIVE_SESSION');
  const o1 = await api('POST', '/api/sessions/entry', { registration: 'KAA111A', category_id: dailyCatId, override: true }, attTok);
  assert.equal(o1.status, 403);
  const o2 = await api('POST', '/api/sessions/entry', { registration: 'KAA111A', category_id: dailyCatId, override: true }, supTok);
  assert.equal(o2.status, 201, JSON.stringify(o2.json));
});

test('5. daily quote math (26h = 2 days x 400)', async () => {
  const e = await api('POST', '/api/sessions/entry', {
    registration: 'KBB222B', category_id: dailyCatId, entry_time: hoursAgo(26), override: true
  }, supTok);
  assert.equal(e.status, 201, JSON.stringify(e.json));
  const q = await api('GET', `/api/sessions/${e.json.data.id}/quote`, null, cashTok);
  assert.equal(q.json.quote.base, 800);
  assert.equal(q.json.quote.days, 2);
});

test('6. cash payment + exit frees the bay', async () => {
  const open = await api('POST', '/api/shifts/open', { opening_cash: 1000, station: 'Gate A' }, cashTok);
  assert.equal(open.status, 201, JSON.stringify(open.json));
  const list = await api('GET', '/api/sessions/active?q=KBB222B', null, cashTok);
  const id = list.json.data[0].id;
  const pay = await api('POST', `/api/sessions/${id}/pay`, { method: 'cash', amount: 800 }, cashTok);
  assert.equal(pay.status, 201, JSON.stringify(pay.json));
  assert.equal(pay.json.data.verification_status, 'verified');
  const before = await api('GET', '/api/spaces', null, cashTok);
  const exit = await api('POST', `/api/sessions/${id}/exit`, {}, cashTok);
  assert.equal(exit.status, 200, JSON.stringify(exit.json));
  assert.equal(exit.json.data.status, 'exited');
  assert.ok(exit.json.data.exit_time);
  const after = await api('GET', '/api/spaces', null, cashTok);
  assert.equal(after.json.occupancy.available, before.json.occupancy.available + 1);
});

test('7. M-Pesa STK without credentials is refused honestly (no fake success)', async () => {
  const st = await api('GET', '/api/mpesa/status', null, cashTok);
  assert.equal(st.json.data.configured, false);
  const list = await api('GET', '/api/sessions/active?q=KAA111A', null, cashTok);
  const id = list.json.data[0].id;
  const r = await api('POST', '/api/mpesa/stk-push', { session_id: id, phone: '0722000001' }, adminTok);
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'MPESA_NOT_CONFIGURED');
});

test('8. manual M-Pesa is flagged manual, card needs auth code', async () => {
  const e = await api('POST', '/api/sessions/entry', { registration: 'KCC333C', category_id: dailyCatId, entry_time: hoursAgo(2), override: true }, supTok);
  const id = e.json.data.id;
  const pay = await api('POST', `/api/sessions/${id}/pay`, { method: 'mpesa', amount: 400, reference: 'QHX12345' }, cashTok);
  assert.equal(pay.status, 201);
  assert.equal(pay.json.data.verification_status, 'manual');
  const ex = await api('POST', `/api/sessions/${id}/exit`, {}, cashTok);
  assert.equal(ex.status, 200);

  const e2 = await api('POST', '/api/sessions/entry', { registration: 'KDD444D', category_id: dailyCatId, entry_time: hoursAgo(2), override: true }, supTok);
  const id2 = e2.json.data.id;
  const bad = await api('POST', `/api/sessions/${id2}/pay`, { method: 'card', amount: 400 }, cashTok);
  assert.equal(bad.status, 400);
  const ok = await api('POST', `/api/sessions/${id2}/pay`, { method: 'card', amount: 400, reference: 'AUTH9988', terminal: 'PDQ-1' }, cashTok);
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.terminal, 'PDQ-1');
  const ex2 = await api('POST', `/api/sessions/${id2}/exit`, {}, cashTok);
  assert.equal(ex2.status, 200);
});

test('9. complimentary needs authorization; revenue 0 but occupies bay', async () => {
  const cats = await api('GET', '/api/categories', null, supTok);
  const rest = cats.json.data.find(c => c.code === 'restaurant').id;
  const denied = await api('POST', '/api/sessions/entry', {
    registration: 'KEE000A', category_id: rest, comp: { comp_category: 'restaurant', authorized_by: 'X' }
  }, attTok);
  assert.equal(denied.status, 403);
  const e = await api('POST', '/api/sessions/entry', {
    registration: 'KEE000A', customer_name: 'Diner', category_id: rest,
    comp: { comp_category: 'restaurant', reason: 'Lunch guest', authorized_by: 'Duty Manager' }
  }, supTok);
  assert.equal(e.status, 201, JSON.stringify(e.json));
  const occ = await api('GET', '/api/spaces', null, supTok);
  assert.ok(occ.json.occupancy.complimentary >= 1);
  const ex = await api('POST', `/api/sessions/${e.json.data.id}/exit`, {}, cashTok);
  assert.equal(ex.status, 200);
  assert.equal(ex.json.data.payment_status, 'complimentary');
  assert.equal(ex.json.quote.base, 0);
});

test('10. monthly subscription covers daily charge; expired is refused', async () => {
  await api('POST', '/api/shifts/open', { opening_cash: 0 }, adminTok);
  const pkgs = await api('GET', '/api/monthly/packages', null, adminTok);
  const pkgId = pkgs.json.data.find(p => p.name === 'Monthly Standard').id;
  const sub = await api('POST', '/api/monthly/subscriptions', {
    customer_name: 'Acme Ltd', registration: 'KEE555E', package_id: pkgId, payment_method: 'cash'
  }, adminTok);
  assert.equal(sub.status, 201, JSON.stringify(sub.json));
  const subId = sub.json.data.id;
  assert.ok(sub.json.data.days_remaining >= 29);
  const e = await api('POST', '/api/sessions/entry', { registration: 'KEE555E', category_id: dailyCatId }, attTok);
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.equal(e.json.data.category_code, 'monthly');
  const ex = await api('POST', `/api/sessions/${e.json.data.id}/exit`, {}, cashTok);
  assert.equal(ex.status, 200);
  assert.equal(ex.json.quote.base, 0);
  // expire and confirm daily charge now applies
  await api('PUT', `/api/monthly/subscriptions/${subId}`, { status: 'expired' }, adminTok);
  const e2 = await api('POST', '/api/sessions/entry', {
    registration: 'KEE555E', category_id: dailyCatId, entry_time: hoursAgo(2), override: true
  }, adminTok);
  assert.equal(e2.status, 201, JSON.stringify(e2.json));
  assert.equal(e2.json.data.category_code, 'daily');
  const q = await api('GET', `/api/sessions/${e2.json.data.id}/quote`, null, cashTok);
  assert.equal(q.json.quote.base, 400);
  await api('POST', `/api/sessions/${e2.json.data.id}/exit`, { payments: [{ method: 'cash', amount: 400 }] }, cashTok);
});

test('11. discount needs approval before exit honors it', async () => {
  const e = await api('POST', '/api/sessions/entry', { registration: 'KFF666F', category_id: dailyCatId, entry_time: hoursAgo(3), override: true }, supTok);
  const id = e.json.data.id;
  const d = await api('POST', `/api/sessions/${id}/discounts`, { kind: 'fixed', value: 100, reason: 'Test goodwill' }, attTok);
  assert.equal(d.status, 201);
  assert.equal(d.json.data.status, 'pending');
  const blocked = await api('POST', `/api/sessions/${id}/exit`, { payments: [{ method: 'cash', amount: 300 }] }, cashTok);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'DISCOUNT_PENDING');
  const ap = await api('POST', `/api/discounts/${d.json.data.id}/decision`, { decision: 'approved' }, mgrTok);
  assert.equal(ap.status, 200);
  const ex = await api('POST', `/api/sessions/${id}/exit`, { payments: [{ method: 'cash', amount: 300 }] }, cashTok);
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  assert.equal(ex.json.quote.discount, 100);
});

test('12. shift close computes expected and enforces variance notes', async () => {
  const cur = await api('GET', '/api/shifts/current', null, cashTok);
  const exp = cur.json.data.expected_live;
  assert.ok(exp.cash > 0);
  const close = await api('POST', `/api/shifts/${cur.json.data.id}/close`, {
    actual_cash: exp.cash, actual_mpesa: exp.mpesa, actual_card: exp.card
  }, cashTok);
  assert.equal(close.status, 200, JSON.stringify(close.json));
  assert.equal(close.json.variance, 0);
  await api('POST', '/api/shifts/open', { opening_cash: 0 }, cashTok);
  const cur2 = await api('GET', '/api/shifts/current', null, cashTok);
  const bad = await api('POST', `/api/shifts/${cur2.json.data.id}/close`, { actual_cash: 50, actual_mpesa: 0, actual_card: 0 }, cashTok);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'VARIANCE_NOTE_REQUIRED');
  const ok = await api('POST', `/api/shifts/${cur2.json.data.id}/close`, {
    actual_cash: 50, actual_mpesa: 0, actual_card: 0, variance_note: 'Test overage'
  }, cashTok);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.variance, 50);
});

test('13. reconciliation finalize locks the day', async () => {
  const p = (n) => String(n).padStart(2, '0');
  const nowD = new Date();
  const today = `${nowD.getFullYear()}-${p(nowD.getMonth() + 1)}-${p(nowD.getDate())}`; // local day, like the web client sends
  const save = await api('POST', '/api/reconciliation', { date: today }, ctlTok);
  assert.equal(save.status, 200, JSON.stringify(save.json));
  assert.ok(save.json.data.total_revenue > 0);
  await api('POST', `/api/reconciliation/${today}/review`, { stage: 'supervisor' }, supTok);
  await api('POST', `/api/reconciliation/${today}/review`, { stage: 'controller' }, ctlTok);
  const fin = await api('POST', `/api/reconciliation/${today}/finalize`, {}, mgrTok);
  assert.equal(fin.status, 200, JSON.stringify(fin.json));
  assert.equal(fin.json.data.status, 'finalized');
  const locked = await api('POST', '/api/reconciliation', { date: today }, ctlTok);
  assert.equal(locked.status, 409);
  assert.equal(locked.json.error.code, 'FINALIZED');
});

test('14. audit log captures the trail', async () => {
  const a = await api('GET', '/api/audit?pageSize=200', null, adminTok);
  const actions = a.json.data.map(r => r.action);
  for (const need of ['vehicle_entry', 'vehicle_exit', 'payment_collect', 'shift_open', 'shift_close', 'recon_finalize', 'discount_apply']) {
    assert.ok(actions.includes(need), 'missing audit: ' + need);
  }
});

test('15. reports derive from real transactions; financial RBAC holds', async () => {
  const denied = await api('GET', '/api/reports/revenue', null, attTok);
  assert.equal(denied.status, 403);
  const r = await api('GET', '/api/reports/revenue', null, adminTok);
  assert.equal(r.status, 200);
  const settled = r.json.rows.filter(x => ['verified', 'manual'].includes(x.verification_status));
  const sum = Math.round(settled.reduce((a, x) => a + Number(x.amount), 0) * 100) / 100;
  const tsum = Math.round(r.json.totals.filter(x => ['verified', 'manual'].includes(x.verification_status))
    .reduce((a, x) => a + Number(x.t), 0) * 100) / 100;
  assert.equal(sum, tsum);
  assert.ok(sum > 0);
  const d = await api('GET', '/api/dashboard', null, mgrTok);
  assert.equal(d.json.occupancy.total, 150);
  assert.ok(d.json.revenue_today.total > 0);
});

test('16. move + void workflows are audited', async () => {
  const e = await api('POST', '/api/sessions/entry', { registration: 'KGG777G', category_id: dailyCatId }, attTok);
  const id = e.json.data.id;
  const spaces = await api('GET', '/api/spaces', null, attTok);
  const target = spaces.json.data.find(s => s.status === 'available' && s.id !== e.json.data.space_id);
  const mv = await api('POST', `/api/sessions/${id}/move`, { space_id: target.id }, attTok);
  assert.equal(mv.status, 200, JSON.stringify(mv.json));
  const e2 = await api('POST', '/api/sessions/entry', { registration: 'KHH888H', category_id: dailyCatId }, attTok);
  const novoid = await api('POST', `/api/sessions/${e2.json.data.id}/void`, {}, supTok);
  assert.equal(novoid.status, 400);
  const vd = await api('POST', `/api/sessions/${e2.json.data.id}/void`, { reason: 'Test error entry' }, supTok);
  assert.equal(vd.status, 200);
  const a = await api('GET', '/api/audit?action=space_move&pageSize=5', null, adminTok);
  assert.ok(a.json.data.length >= 1);
});

test('17. M-Pesa/card references can only be used once', async () => {
  const cur = await api('GET', '/api/shifts/current', null, cashTok);
  if (!cur.json.data) await api('POST', '/api/shifts/open', { opening_cash: 0 }, cashTok);
  const e1 = await api('POST', '/api/sessions/entry', { registration: 'KDJ111A', category_id: dailyCatId, entry_time: hoursAgo(2), override: true }, supTok);
  assert.equal(e1.status, 201, JSON.stringify(e1.json));
  const id1 = e1.json.data.id;
  const p1 = await api('POST', `/api/sessions/${id1}/pay`, { method: 'mpesa', amount: 400, reference: 'DUPREF001' }, cashTok);
  assert.equal(p1.status, 201, JSON.stringify(p1.json));
  const e2 = await api('POST', '/api/sessions/entry', { registration: 'KDJ222B', category_id: dailyCatId, entry_time: hoursAgo(2), override: true }, supTok);
  const id2 = e2.json.data.id;
  const p2 = await api('POST', `/api/sessions/${id2}/pay`, { method: 'mpesa', amount: 400, reference: 'dupref001' }, cashTok);
  assert.equal(p2.status, 409);
  assert.equal(p2.json.error.code, 'DUPLICATE_REFERENCE');
  const p3 = await api('POST', `/api/sessions/${id2}/pay`, { method: 'card', amount: 400, reference: 'DUPREF001', terminal: 'PDQ-1' }, cashTok);
  assert.equal(p3.status, 409);
  const p4 = await api('POST', `/api/sessions/${id2}/pay`, { method: 'cash', amount: 400 }, cashTok);
  assert.equal(p4.status, 201, JSON.stringify(p4.json));
});

test('18. invoice lifecycle: create -> partial -> paid; guards hold', async () => {
  const cur = await api('GET', '/api/shifts/current', null, adminTok);
  if (!cur.json.data) {
    const sh = await api('POST', '/api/shifts/open', { opening_cash: 0 }, adminTok);
    assert.equal(sh.status, 201, JSON.stringify(sh.json));
  }
  const bad = await api('POST', '/api/invoices', { customer_name: 'No Items Ltd' }, adminTok);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'ITEMS_REQUIRED');
  const c = await api('POST', '/api/invoices', { customer_name: 'Acme Ltd', company: 'Acme Ltd',
    registration: 'KAA 222B', items: [{ description: 'October parking', quantity: 2, unit_price: 500 }] }, adminTok);
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.match(c.json.data.invoice_no, /^INV-\d{8}-\d{4}$/);
  assert.equal(c.json.data.total, 1000);
  assert.equal(c.json.data.display_status, 'unpaid');
  const id = c.json.data.id;
  const over = await api('POST', `/api/invoices/${id}/pay`, { method: 'cash', amount: 1001 }, adminTok);
  assert.equal(over.status, 400);
  assert.equal(over.json.error.code, 'EXCEEDS_BALANCE');
  const p1 = await api('POST', `/api/invoices/${id}/pay`, { method: 'cash', amount: 400 }, adminTok);
  assert.equal(p1.status, 201, JSON.stringify(p1.json));
  assert.equal(p1.json.invoice.status, 'partial');
  assert.equal(p1.json.invoice.balance, 600);
  const editLocked = await api('PUT', `/api/invoices/${id}`, { notes: 'late edit' }, adminTok);
  assert.equal(editLocked.status, 400);
  assert.equal(editLocked.json.error.code, 'INVALID_STATUS');
  const p2 = await api('POST', `/api/invoices/${id}/pay`, { method: 'cash', amount: 600 }, adminTok);
  assert.equal(p2.json.invoice.status, 'paid');
  const again = await api('POST', `/api/invoices/${id}/pay`, { method: 'cash', amount: 1 }, adminTok);
  assert.equal(again.json.error.code, 'ALREADY_PAID');
  const v = await api('POST', `/api/invoices/${id}/void`, { reason: 'test' }, adminTok);
  assert.equal(v.json.error.code, 'VOID_HAS_PAYMENTS');
  const c2 = await api('POST', '/api/invoices', { customer_name: 'Void Me', items: [{ description: 'x', unit_price: 50 }] }, adminTok);
  const id2 = c2.json.data.id;
  const noReason = await api('POST', `/api/invoices/${id2}/void`, {}, adminTok);
  assert.equal(noReason.json.error.code, 'REASON_REQUIRED');
  const e = await api('PUT', `/api/invoices/${id2}`, { notes: 'edited ok', items: [{ description: 'x', unit_price: 60 }] }, adminTok);
  assert.equal(e.status, 200);
  assert.equal(e.json.data.total, 60);
  const v2 = await api('POST', `/api/invoices/${id2}/void`, { reason: 'duplicate billing' }, adminTok);
  assert.equal(v2.json.data.status, 'voided');
  const tabs = await api('GET', '/api/invoices?status=paid', null, adminTok);
  assert.ok(tabs.json.data.every(r => r.display_status === 'paid'));
});

test('19. access control verdicts + log; security role may check', async () => {
  const casual = await api('POST', '/api/access/check', { registration: 'KZZ 001A' }, secTok);
  assert.equal(casual.status, 200);
  assert.equal(casual.json.data.verdict, 'AUTHORIZED');
  assert.equal(casual.json.data.suggested_category, 'daily');
  const ms = await api('POST', '/api/monthly/subscriptions', { package_id: 1, customer_name: 'Access Member',
    registration: 'KZZ 002B', payment_method: 'cash' }, adminTok);
  assert.equal(ms.status, 201, JSON.stringify(ms.json));
  const monthly = await api('POST', '/api/access/check', { registration: 'KZZ002B' }, secTok);
  assert.equal(monthly.json.data.verdict, 'AUTHORIZED');
  assert.equal(monthly.json.data.suggested_category, 'monthly');
  const en = await api('POST', '/api/sessions/entry', { registration: 'KZZ 003C', category_id: dailyCatId }, attTok);
  assert.equal(en.status, 201);
  const dup = await api('POST', '/api/access/check', { registration: 'KZZ003C' }, secTok);
  assert.equal(dup.json.data.verdict, 'DENIED');
  const log = await api('GET', '/api/access/log?verdict=DENIED', null, adminTok);
  assert.ok(log.json.data.length >= 1);
  assert.ok(log.json.data.every(r => r.verdict === 'DENIED'));
  const forbid = await api('POST', '/api/invoices', { customer_name: 'x', items: [{ description: 'x', unit_price: 1 }] }, secTok);
  assert.equal(forbid.status, 403);
});

test('20. settlement aggregates method/client/outstanding', async () => {
  const s = await api('GET', '/api/settlement', null, adminTok);
  assert.equal(s.status, 200);
  const d = s.json.data;
  assert.ok(Array.isArray(d.by_method) && Array.isArray(d.by_client));
  assert.ok(Array.isArray(d.outstanding_sessions) && Array.isArray(d.outstanding_invoices));
  assert.ok(d.totals.collected >= 1000);
  const denied = await api('GET', '/api/settlement', null, secTok);
  assert.equal(denied.status, 403);
});

test('21. rates endpoint merges category overrides with settings fallback', async () => {
  const r0 = await api('GET', '/api/rates', null, adminTok);
  assert.equal(r0.status, 200);
  assert.equal(r0.json.data.length, 12);
  const daily = r0.json.data.find(c => c.code === 'daily');
  assert.equal(daily.daily_rate, 400);
  assert.equal(daily.overridden.daily, false);
  const upd = await api('PUT', `/api/categories/${daily.id}`, { daily_rate: 750, max_charge: 1500, grace_minutes: 30 }, adminTok);
  assert.equal(upd.status, 200);
  const r1 = await api('GET', '/api/rates', null, adminTok);
  const d1 = r1.json.data.find(c => c.code === 'daily');
  assert.equal(d1.daily_rate, 750);
  assert.equal(d1.max_charge, 1500);
  assert.equal(d1.grace_minutes, 30);
  assert.equal(d1.overridden.daily, true);
  const clr = await api('PUT', `/api/categories/${daily.id}`, { daily_rate: null, max_charge: null, grace_minutes: null }, adminTok);
  assert.equal(clr.status, 200);
  const r2 = await api('GET', '/api/rates', null, adminTok);
  assert.equal(r2.json.data.find(c => c.code === 'daily').daily_rate, 400);
});

test('22. entry captures vehicle make/model/color', async () => {
  const e = await api('POST', '/api/sessions/entry', { registration: 'KCC 100D', category_id: dailyCatId,
    vehicle_make: 'Toyota', vehicle_model: 'Corolla', vehicle_color: 'Silver' }, attTok);
  assert.equal(e.status, 201);
  const h = await api('GET', '/api/vehicles/history?registration=KCC100D', null, attTok);
  assert.equal(h.status, 200);
  const row = (h.json.data || {}).vehicle || h.json.vehicle;
  assert.ok(row, JSON.stringify(h.json).slice(0, 300));
  assert.equal(row.make, 'Toyota');
  assert.equal(row.model, 'Corolla');
  assert.equal(row.color, 'Silver');
});

test('23. quote honors per-category rate and daily cap', async () => {
  const nc = await api('POST', '/api/categories', { code: 'auditrate', name: 'Audit Rate', kind: 'paid' }, adminTok);
  assert.equal(nc.status, 201);
  const cid = nc.json.id;
  await api('PUT', `/api/categories/${cid}`, { daily_rate: 1000, max_charge: 800 }, adminTok);
  const e = await api('POST', '/api/sessions/entry', { registration: 'KRR 500E', category_id: cid, entry_time: hoursAgo(26) }, supTok);
  assert.equal(e.status, 201, JSON.stringify(e.json));
  const q = await api('GET', `/api/sessions/${e.json.data.id}/quote`, null, adminTok);
  assert.equal(q.json.quote.base, 800);
  assert.equal(q.json.quote.rate_capped, true);
  await api('PUT', `/api/categories/${cid}`, { daily_rate: null, max_charge: null }, adminTok);
});

test('24. billing RBAC: attendant blocked, cashier collects invoice payments', async () => {
  const blk = await api('POST', '/api/invoices', { customer_name: 'x', items: [{ description: 'x', unit_price: 1 }] }, attTok);
  assert.equal(blk.status, 403);
  const c = await api('POST', '/api/invoices', { customer_name: 'Cashier Pay', items: [{ description: 'fee', unit_price: 200 }] }, adminTok);
  const id = c.json.data.id;
  const cur24 = await api('GET', '/api/shifts/current', null, cashTok);
  if (!cur24.json.data) {
    const sh = await api('POST', '/api/shifts/open', { opening_cash: 0 }, cashTok);
    assert.equal(sh.status, 201, JSON.stringify(sh.json));
  }
  const p = await api('POST', `/api/invoices/${id}/pay`, { method: 'cash', amount: 200 }, cashTok);
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal(p.json.invoice.status, 'paid');
});
