// v2->v3 merge tests: hotel validation codes, lost tickets, gate log, ANPR webhook.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = 'test-secret-xyz';
process.env.SEED_ADMIN_PASSWORD = 'Admin@123';
process.env.OPEN_ACCESS = 'false';
process.env.NO_LOGIN = 'false';

const { createApp, openDatabase } = require('./server');

let base, db, server, roles = {};
let adminTok, supTok, cashTok, attTok, secTok;
const H = t => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });

async function api(method, p, body, tok) {
  const res = await fetch(base + p, { method, headers: H(tok || ''), body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
let dailyCatId;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-merge-'));
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
  supTok = await mk('m_super', 'Supervisor');
  cashTok = await mk('m_cashier', 'Cashier');
  attTok = await mk('m_attendant', 'Parking Attendant');
  secTok = await mk('m_security', 'Security');
  const cats = await api('GET', '/api/categories', null, adminTok);
  dailyCatId = cats.json.data.find(c => c.code === 'daily').id;
  await api('POST', '/api/shifts/open', { opening_cash: 0, station: 'Test' }, cashTok);
  await api('POST', '/api/shifts/open', { opening_cash: 0, station: 'Test' }, adminTok);
});
test.after(async () => { server.close(); db.close(); });

async function entry(reg, hrs, tok) {
  const e = await api('POST', '/api/sessions/entry',
    { registration: reg, category_id: dailyCatId, entry_time: hoursAgo(hrs), override: true }, tok || supTok);
  assert.equal(e.status, 201, JSON.stringify(e.json));
  return e.json.data;
}

test('25. validation code: issue, capped redeem, reuse blocked, full cover exits free', async () => {
  const forbid = await api('POST', '/api/validations', { max_amount: 200 }, cashTok);
  assert.equal(forbid.status, 403);
  const capped = await api('POST', '/api/validations', { max_amount: 200, notes: 'Room 101' }, supTok);
  assert.equal(capped.status, 201, JSON.stringify(capped.json));
  assert.match(capped.json.data.code, /^HV-[A-Z2-9]{6}$/);
  const full = await api('POST', '/api/validations', { notes: 'VIP guest' }, supTok);
  assert.equal(full.status, 201);
  assert.equal(full.json.data.max_amount, null);

  const s1 = await entry('KMM100A', 2);
  const r1 = await api('POST', `/api/sessions/${s1.id}/validate`, { code: capped.json.data.code }, cashTok);
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  assert.equal(r1.json.data.discount_amount, 200);
  assert.equal(r1.json.data.status, 'applied');
  assert.equal(r1.json.quote.due, 200);

  const s2 = await entry('KMM101B', 2);
  const reuse = await api('POST', `/api/sessions/${s2.id}/validate`, { code: capped.json.data.code }, cashTok);
  assert.equal(reuse.status, 400);
  assert.equal(reuse.json.error.code, 'CODE_USED');

  const r2 = await api('POST', `/api/sessions/${s2.id}/validate`, { code: full.json.data.code.toLowerCase() }, cashTok);
  assert.equal(r2.status, 201, JSON.stringify(r2.json));
  assert.equal(r2.json.quote.due, 0);
  const ex = await api('POST', `/api/sessions/${s2.id}/exit`, {}, cashTok);
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  const missing = await api('POST', `/api/sessions/${s1.id}/validate`, { code: 'HV-XXXXXX' }, cashTok);
  assert.equal(missing.status, 404);
});

test('26. revoked / expired codes are rejected; used codes cannot be revoked', async () => {
  const v = await api('POST', '/api/validations', { max_amount: 500 }, supTok);
  assert.equal(v.status, 201);
  const rev = await api('POST', `/api/validations/${v.json.data.id}/revoke`, { reason: 'guest cancelled' }, supTok);
  assert.equal(rev.status, 200);
  assert.equal(rev.json.data.status, 'revoked');
  const s = await entry('KMM102C', 2);
  const bad = await api('POST', `/api/sessions/${s.id}/validate`, { code: v.json.data.code }, cashTok);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'CODE_REVOKED');
  const rev2 = await api('POST', `/api/validations/${v.json.data.id}/revoke`, {}, supTok);
  assert.equal(rev2.status, 400);
  assert.equal(rev2.json.error.code, 'CODE_LOCKED');

  const v2 = await api('POST', '/api/validations', { max_amount: 500 }, supTok);
  db.prepare('UPDATE validation_codes SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3600e3).toISOString(), v2.json.data.id);
  const s3 = await entry('KMM103D', 2);
  const exp = await api('POST', `/api/sessions/${s3.id}/validate`, { code: v2.json.data.code }, cashTok);
  assert.equal(exp.status, 400);
  assert.equal(exp.json.error.code, 'CODE_EXPIRED');
});

test('27. lost ticket: ID enforced, flat fee applies, monthly still wins, unmark restores', async () => {
  const s = await entry('KMM200B', 2);
  const noId = await api('POST', `/api/sessions/${s.id}/mark-lost`, {}, cashTok);
  assert.equal(noId.status, 400);
  assert.equal(noId.json.error.code, 'ID_REQUIRED');
  const lost = await api('POST', `/api/sessions/${s.id}/mark-lost`, { id_number: 'K123456', phone: '0722000002' }, cashTok);
  assert.equal(lost.status, 200, JSON.stringify(lost.json));
  assert.equal(lost.json.data.lost_ticket, 1);
  assert.equal(lost.json.data.lost_id_number, 'K123456');
  assert.equal(lost.json.quote.base, 1000);
  assert.equal(lost.json.quote.base_reason, 'lost');

  const fee = await api('PUT', '/api/settings', { lost_ticket_fee: 1500 }, adminTok);
  assert.equal(fee.status, 200, JSON.stringify(fee.json));
  const q2 = await api('GET', `/api/sessions/${s.id}/quote`, null, cashTok);
  assert.equal(q2.json.quote.base, 1500);
  await api('PUT', '/api/settings', { lost_ticket_fee: 1000 }, adminTok);

  const pay = await api('POST', `/api/sessions/${s.id}/pay`, { method: 'cash', amount: 1000 }, cashTok);
  assert.equal(pay.status, 201, JSON.stringify(pay.json));
  const ex = await api('POST', `/api/sessions/${s.id}/exit`, {}, cashTok);
  assert.equal(ex.status, 200, JSON.stringify(ex.json));

  const ms = await api('POST', '/api/monthly/subscriptions', { package_id: 1, customer_name: 'Lost Member',
    registration: 'KMM201C', payment_method: 'cash' }, adminTok);
  assert.equal(ms.status, 201, JSON.stringify(ms.json));
  const m = await api('POST', '/api/sessions/entry', { registration: 'KMM201C', category_id: dailyCatId }, attTok);
  assert.equal(m.status, 201, JSON.stringify(m.json));
  const ml = await api('POST', `/api/sessions/${m.json.data.id}/mark-lost`, { id_number: 'M1' }, cashTok);
  assert.equal(ml.status, 200);
  assert.equal(ml.json.quote.base, 0);
  assert.equal(ml.json.quote.base_reason, 'monthly');
  await api('POST', `/api/sessions/${m.json.data.id}/exit`, {}, cashTok);

  const u = await entry('KMM202D', 2);
  await api('POST', `/api/sessions/${u.id}/mark-lost`, { id_number: 'U9' }, cashTok);
  const un = await api('POST', `/api/sessions/${u.id}/unmark-lost`, {}, supTok);
  assert.equal(un.status, 200, JSON.stringify(un.json));
  assert.equal(un.json.data.lost_ticket, 0);
  assert.equal(un.json.quote.base, 400);
  const un2 = await api('POST', `/api/sessions/${u.id}/unmark-lost`, {}, supTok);
  assert.equal(un2.status, 400);
  assert.equal(un2.json.error.code, 'NOT_LOST');
});

test('28. gate opens are logged automatically on exit and manually with reason', async () => {
  const s = await entry('KMM400G', 2);
  await api('POST', `/api/sessions/${s.id}/pay`, { method: 'cash', amount: 400 }, cashTok);
  await api('POST', `/api/sessions/${s.id}/exit`, {}, cashTok);
  const log = await api('GET', `/api/gate/log?q=${s.ticket_no}`, null, cashTok);
  assert.equal(log.status, 200);
  assert.ok(log.json.data.some(r => r.action === 'open' && r.session_id === s.id), JSON.stringify(log.json.data));

  const noReason = await api('POST', '/api/gate/open', {}, cashTok);
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error.code, 'REASON_REQUIRED');
  const man = await api('POST', '/api/gate/open', { reason: 'VIP escort, barrier check' }, cashTok);
  assert.equal(man.status, 201, JSON.stringify(man.json));
  assert.equal(man.json.data.action, 'open');
  const forbid = await api('POST', '/api/gate/open', { reason: 'x' }, secTok);
  assert.equal(forbid.status, 403);
});

test('29. ANPR webhook: verdicts, suggested actions, 60s dedupe, rejects blanks', async () => {
  const c1 = await api('POST', '/api/anpr/event', { plate: 'KMM300A', camera_id: 'entry-cam-1' }, secTok);
  assert.equal(c1.status, 200, JSON.stringify(c1.json));
  assert.equal(c1.json.data.verdict, 'AUTHORIZED');
  assert.equal(c1.json.data.suggested_action, 'admit_cashier');
  assert.equal(c1.json.data.deduped, false);
  const c2 = await api('POST', '/api/anpr/event', { plate: 'kmm300a', camera_id: 'entry-cam-1' }, secTok);
  assert.equal(c2.json.data.deduped, true);
  assert.equal(c2.json.data.id, c1.json.data.id);

  const ms = await api('POST', '/api/monthly/subscriptions', { package_id: 1, customer_name: 'ANPR Member',
    registration: 'KMM300M', payment_method: 'cash' }, adminTok);
  assert.equal(ms.status, 201, JSON.stringify(ms.json));
  const m = await api('POST', '/api/anpr/event', { plate: 'KMM300M', camera_id: 'entry-cam-1' }, secTok);
  assert.equal(m.json.data.verdict, 'AUTHORIZED');
  assert.equal(m.json.data.suggested_action, 'open_gate_monthly');

  await entry('KMM301D', 1);
  const d = await api('POST', '/api/anpr/event', { plate: 'KMM301D' }, secTok);
  assert.equal(d.json.data.verdict, 'DENIED');
  assert.equal(d.json.data.suggested_action, 'deny_duplicate');

  const blank = await api('POST', '/api/anpr/event', { plate: '' }, secTok);
  assert.equal(blank.status, 400);
  assert.equal(blank.json.error.code, 'PLATE_REQUIRED');

  const log = await api('GET', '/api/access/log?q=KMM300', null, adminTok);
  assert.ok(log.json.data.length >= 2);
});

test('30. validation list RBAC + joins show code lifecycle', async () => {
  const forbid = await api('GET', '/api/validations', null, attTok);
  assert.equal(forbid.status, 403);
  const list = await api('GET', '/api/validations?status=used', null, cashTok);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.length >= 2);
  const row = list.json.data.find(r => r.used_ticket);
  assert.ok(row, 'used codes join back to the session ticket');
  assert.ok(row.used_amount > 0);
  const open = await api('GET', '/api/validations?status=unused', null, cashTok);
  assert.ok(open.json.data.every(r => r.status === 'unused'));
});
