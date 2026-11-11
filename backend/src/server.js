// Marble Arch Hotel Nairobi - Parking Management API.
process.env.TZ = process.env.TZ || 'Africa/Nairobi';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { openDatabase } = require('./db');
const { verifyToken, signToken, hashPassword, checkPassword, expandPermissions, PERMISSIONS, ROLE_PERMS } = require('./auth');
const L = require('./lib');
const { registerOpsRoutes } = require('./routes');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'parking.db');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 2000, standardHeaders: true, legacyHeaders: false }));

  // ---------- auth middleware ----------
  async function requireAuth(req, res, next) {
    try {
      const h = req.headers.authorization || '';
      let token = h.startsWith('Bearer ') ? h.slice(7) : null;
      // Redundant transport: some proxies strip `authorization`; accept the
      // same token as `x-auth-token` (sent alongside by the web client).
      if (!token) {
        const x = req.headers['x-auth-token'] || '';
        token = String(x).startsWith('Bearer ') ? String(x).slice(7) : (String(x) || null);
      }
      if (!token) throw L.ApiError.unauth();
      let payload;
      try { payload = verifyToken(token); } catch { throw L.ApiError.unauth('Session expired. Please login again.'); }
      const u = db.prepare(`SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = ? AND u.active = 1 AND u.deleted_at IS NULL`).get(payload.sub);
      if (!u) throw L.ApiError.unauth('Account is disabled');
      req.user = { ...L.userPublic(u), permissions: expandPermissions(u.role_name) };
      next();
    } catch (e) { next(e); }
  }
  // Any-of semantics: user needs at least one listed permission.
  function requirePerm(...codes) {
    return (req, res, next) => {
      const p = req.user.permissions || [];
      if (codes.some(c => p.includes(c))) return next();
      next(L.ApiError.forbidden());
    };
  }
  const ctx = { db, requireAuth, requirePerm };

  // Landing + health: this port serves the JSON API only (the web UI runs on :5173).
  app.get('/', (req, res) => {
    // Single-service production (frontend/dist present): "/" is the web app.
    const spa = path.join(__dirname, '..', '..', 'frontend', 'dist', 'index.html');
    if (fs.existsSync(spa)) return res.sendFile(spa);
    res.json({
      service: 'marble-arch-parking-api', version: '1.0.0', time: L.nowIso(),
      ui: 'Run the frontend dev server (port 5173) for the web app.',
      endpoints: ['/api/health', '/api/auth/mode', '/api/dashboard', '/api/sessions/active',
        '/api/validations', '/api/gate/log', '/api/access/log', '/api/anpr/event']
    });
  });
  app.get('/api/health', (req, res) => {
    let dbUp = false;
    try { db.prepare('SELECT 1 AS ok').get(); dbUp = true; } catch { /* down */ }
    res.status(dbUp ? 200 : 503).json({ ok: dbUp, db: dbUp ? 'up' : 'down', time: L.nowIso() });
  });

  // ---------- auth ----------
  // TEMPORARY open-access mode: when OPEN_ACCESS=true in backend/.env, any
  // active user can sign in with username only (no password). Every such
  // login is audit-logged as login_open_access. Set OPEN_ACCESS=false and
  // restart to restore normal password login.
  const OPEN_ACCESS = () => process.env.OPEN_ACCESS === 'true';
  const NO_LOGIN = () => process.env.NO_LOGIN === 'true';
  app.get('/api/auth/mode', (req, res) => res.json({ openAccess: OPEN_ACCESS() || NO_LOGIN(), noLogin: NO_LOGIN() }));
  // NO-LOGIN mode: issues a session for the configured user with zero
  // credentials. Temporary preview/setup convenience ONLY - every auto login
  // is audit-logged. Disable with NO_LOGIN=false + backend restart.
  app.post('/api/auth/auto-login', L.ah(async (req, res) => {
    if (!NO_LOGIN()) throw L.ApiError.forbidden('Auto login is disabled');
    const uname = process.env.NO_LOGIN_USER || 'admin';
    const u = db.prepare(`SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
      WHERE lower(u.username) = lower(?) AND u.active = 1 AND u.deleted_at IS NULL`).get(uname);
    if (!u) throw L.ApiError.bad('NO_AUTO_USER', 'Auto-login user not found or disabled');
    const user = { ...L.userPublic(u), permissions: expandPermissions(u.role_name) };
    L.audit(db, { ...req, user }, 'login_auto', 'auth', String(u.id), '', u.username + ' (NO LOGIN mode)');
    res.json({ token: signToken(user), user });
  }));
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
  app.post('/api/auth/login', loginLimiter, L.ah(async (req, res) => {
    const { username, password } = req.body || {};
    const openAccess = OPEN_ACCESS();
    if (!username || (!password && !openAccess)) throw L.ApiError.bad('INVALID_CREDENTIALS', 'Username and password are required');
    const u = db.prepare(`SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
      WHERE lower(u.username) = lower(?) AND u.deleted_at IS NULL`).get(String(username).trim());
    let authed = false;
    if (u && u.active) {
      authed = openAccess ? true : await checkPassword(password || '', u.password_hash);
    }
    if (!authed) {
      L.audit(db, req, 'login_failed', 'auth', String(username).slice(0, 60), '', '');
      throw new L.ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    }
    const user = { ...L.userPublic(u), permissions: expandPermissions(u.role_name) };
    L.audit(db, { ...req, user }, openAccess ? 'login_open_access' : 'login', 'auth', String(u.id), '',
      u.username + (openAccess ? ' (NO PASSWORD - temporary open access)' : ''));
    res.json({ token: signToken(user), user });
  }));

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/logout', requireAuth, L.ah(async (req, res) => {
    L.audit(db, req, 'logout', 'auth', String(req.user.id), '', '');
    res.json({ ok: true });
  }));
  app.post('/api/auth/change-password', requireAuth, L.ah(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!new_password || String(new_password).length < 8)
      throw L.ApiError.bad('WEAK_PASSWORD', 'New password must be at least 8 characters');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await checkPassword(current_password || '', u.password_hash)))
      throw L.ApiError.bad('WRONG_PASSWORD', 'Current password is incorrect');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(await hashPassword(new_password), L.nowIso(), req.user.id);
    L.audit(db, req, 'password_change', 'users', String(req.user.id), '', '');
    res.json({ ok: true });
  }));

  // ---------- roles ----------
  app.get('/api/roles', requireAuth, requirePerm('users.view', 'users.manage'), (req, res) => {
    const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
    const out = roles.map(r => ({
      ...r,
      permissions: db.prepare(`SELECT p.code, p.description FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.code`).all(r.id)
    }));
    res.json({ data: out, matrix: ROLE_PERMS, all_permissions: PERMISSIONS.map(p => ({ code: p[0], description: p[1] })) });
  });

  // ---------- users ----------
  app.get('/api/users', requireAuth, requirePerm('users.view', 'users.manage'), L.ah(async (req, res) => {
    const { page, pageSize, limit, offset } = L.paginate(req, 25);
    const q = String(req.query.q || '').trim();
    const where = q ? 'WHERE (u.username LIKE ? OR u.full_name LIKE ? OR r.name LIKE ?) AND u.deleted_at IS NULL' : 'WHERE u.deleted_at IS NULL';
    const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) c FROM users u JOIN roles r ON r.id = u.role_id ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT u.id, u.full_name, u.username, u.email, u.phone, u.role_id, r.name AS role_name,
      u.active, u.must_change_password, u.created_at, u.updated_at
      FROM users u JOIN roles r ON r.id = u.role_id ${where} ORDER BY u.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(L.pageResult(rows, total, page, pageSize));
  }));

  app.post('/api/users', requireAuth, requirePerm('users.manage'), L.ah(async (req, res) => {
    const { full_name, username, email, phone, password, role_id } = req.body || {};
    if (!full_name || !username || !password || !role_id) throw L.ApiError.bad('VALIDATION', 'Full name, username, password and role are required');
    if (String(password).length < 8) throw L.ApiError.bad('WEAK_PASSWORD', 'Password must be at least 8 characters');
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);
    if (!role) throw L.ApiError.bad('INVALID_ROLE', 'Invalid role');
    const exists = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL').get(String(username).trim());
    if (exists) throw L.ApiError.conflict('USERNAME_TAKEN', 'Username is already in use');
    const now = L.nowIso();
    const r = db.prepare(`INSERT INTO users (full_name, username, email, phone, password_hash, role_id, active, must_change_password, created_at, updated_at)
      VALUES (?,?,?,?,?,?,1,1,?,?)`).run(
      String(full_name).trim(), String(username).trim(), (email || '').trim() || null, (phone || '').trim(),
      await hashPassword(password), role_id, now, now);
    L.audit(db, req, 'user_create', 'users', String(r.lastInsertRowid), '', `${username} (${role.name})`);
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
  }));

  app.put('/api/users/:id', requireAuth, requirePerm('users.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!u) throw L.ApiError.notFound('User');
    const { full_name, email, phone, role_id, active } = req.body || {};
    if (role_id) {
      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);
      if (!role) throw L.ApiError.bad('INVALID_ROLE', 'Invalid role');
    }
    if (id === req.user.id && active === 0) throw L.ApiError.bad('INVALID', 'You cannot deactivate your own account');
    const before = JSON.stringify(L.userPublic({ ...u, role_name: '' }));
    db.prepare('UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), phone = COALESCE(?, phone), role_id = COALESCE(?, role_id), active = COALESCE(?, active), updated_at = ? WHERE id = ?')
      .run(full_name ?? null, email ?? null, phone ?? null, role_id ?? null, active ?? null, L.nowIso(), id);
    L.audit(db, req, 'user_update', 'users', String(id), before, JSON.stringify(req.body));
    res.json({ ok: true });
  }));

  app.post('/api/users/:id/reset-password', requireAuth, requirePerm('users.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!u) throw L.ApiError.notFound('User');
    const { password } = req.body || {};
    if (!password || String(password).length < 8) throw L.ApiError.bad('WEAK_PASSWORD', 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?')
      .run(await hashPassword(password), L.nowIso(), id);
    L.audit(db, req, 'password_reset', 'users', String(id), '', '');
    res.json({ ok: true });
  }));

  app.delete('/api/users/:id', requireAuth, requirePerm('users.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw L.ApiError.bad('INVALID', 'You cannot delete your own account');
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!u) throw L.ApiError.notFound('User');
    const admins = db.prepare(`SELECT COUNT(*) c FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Administrator' AND u.active = 1 AND u.deleted_at IS NULL AND u.id != ?`).get(id).c;
    const uRole = db.prepare('SELECT name FROM roles WHERE id = ?').get(u.role_id).name;
    if (uRole === 'Administrator' && admins < 1) throw L.ApiError.bad('LAST_ADMIN', 'Cannot remove the last administrator');
    db.prepare('UPDATE users SET active = 0, deleted_at = ?, updated_at = ? WHERE id = ?').run(L.nowIso(), L.nowIso(), id);
    L.audit(db, req, 'user_delete', 'users', String(id), u.username, 'soft-deleted');
    res.json({ ok: true });
  }));

  // ---------- settings ----------
  app.get('/api/settings', requireAuth, (req, res) => res.json({ data: L.getSettings(db) }));
  app.put('/api/settings', requireAuth, requirePerm('settings.manage'), L.ah(async (req, res) => {
    const b = req.body || {};
    const before = L.getSettings(db);
    if (b.logo_data && String(b.logo_data).length > 700000) throw L.ApiError.bad('LOGO_TOO_LARGE', 'Logo image is too large (max ~500KB)');
    if (b.daily_rate != null) L.validAmount(b.daily_rate, { name: 'Daily rate' });
    if (b.hourly_rate != null) L.validAmount(b.hourly_rate, { name: 'Hourly rate' });
    if (b.lost_ticket_fee != null) L.validAmount(b.lost_ticket_fee, { name: 'Lost ticket fee' });
    if (b.total_spaces != null) {
      const n = Number(b.total_spaces);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw L.ApiError.bad('INVALID_SPACES', 'Total spaces must be 1-500');
    }
    const fields = ['hotel_name', 'logo_data', 'address', 'phones', 'email', 'website', 'registration_details',
      'parking_department', 'parking_location', 'daily_rate', 'hourly_enabled', 'hourly_rate',
      'grace_period_minutes', 'currency', 'lost_ticket_fee', 'receipt_header', 'receipt_footer', 'terms',
      'social_facebook', 'social_twitter', 'social_instagram'];
    const sets = [], args = [];
    for (const f of fields) {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); args.push(b[f]); }
    }
    // Grow/shrink physical space rows when total_spaces changes.
    if (b.total_spaces != null && Number(b.total_spaces) !== before.total_spaces) {
      const target = Number(b.total_spaces);
      const spaces = db.prepare('SELECT * FROM parking_spaces ORDER BY code').all();
      if (target > spaces.length) {
        const now = L.nowIso();
        const ins = db.prepare('INSERT INTO parking_spaces (code, zone, space_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)');
        for (let i = spaces.length + 1; i <= target; i++) {
          const code = 'P-' + String(i).padStart(3, '0');
          ins.run(code, i <= 50 ? 'A' : i <= 100 ? 'B' : 'C', 'standard', 'available', now, now);
        }
      } else {
        const removable = db.prepare(`SELECT * FROM parking_spaces
          WHERE status = 'available' AND current_session_id IS NULL ORDER BY code DESC`).all()
          .slice(0, spaces.length - target);
        if (removable.length < spaces.length - target)
          throw L.ApiError.conflict('SPACES_IN_USE', 'Cannot shrink: only free bays can be removed. Free or relocate vehicles first.');
        const del = db.prepare('DELETE FROM parking_spaces WHERE id = ?');
        for (const s of removable) del.run(s.id);
      }
      sets.push('total_spaces = ?'); args.push(target);
    }
    sets.push('updated_at = ?'); args.push(L.nowIso());
    sets.push('updated_by = ?'); args.push(req.user.id);
    db.prepare(`UPDATE hotel_settings SET ${sets.join(', ')} WHERE id = 1`).run(...args);
    L.audit(db, req, 'settings_update', 'settings', '1', JSON.stringify({ hotel: before.hotel_name, rate: before.daily_rate }), JSON.stringify({ hotel: b.hotel_name, rate: b.daily_rate }));
    res.json({ data: L.getSettings(db) });
  }));

  // ---------- spaces ----------
  app.get('/api/spaces', requireAuth, requirePerm('spaces.view', 'sessions.view', 'dashboard.view'), (req, res) => {
    const spaces = db.prepare(`SELECT s.*, ps.ticket_no, ps.registration, ps.customer_name, ps.entry_time,
        c.code AS category_code, c.name AS category_name, c.kind AS category_kind
      FROM parking_spaces s
      LEFT JOIN parking_sessions ps ON ps.id = s.current_session_id AND ps.status = 'active'
      LEFT JOIN parking_categories c ON c.id = ps.category_id
      ORDER BY s.code`).all();
    res.json({ data: spaces, occupancy: L.occSummary(db) });
  });

  app.put('/api/spaces/:id', requireAuth, requirePerm('spaces.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM parking_spaces WHERE id = ?').get(id);
    if (!s) throw L.ApiError.notFound('Parking space');
    const { status, space_type, notes } = req.body || {};
    if (status && !['available', 'reserved', 'out_of_service'].includes(status))
      throw L.ApiError.bad('INVALID_STATUS', 'Invalid status');
    if (status && s.status === 'occupied' && status !== 'occupied')
      throw L.ApiError.conflict('SPACE_OCCUPIED', 'Space is occupied. Move or exit the vehicle first.');
    if (space_type && !['standard', 'reserved', 'vip', 'disabled', 'staff', 'motorcycle'].includes(space_type))
      throw L.ApiError.bad('INVALID_TYPE', 'Invalid space type');
    const before = `${s.status}/${s.space_type}`;
    db.prepare('UPDATE parking_spaces SET status = COALESCE(?, status), space_type = COALESCE(?, space_type), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?')
      .run(status ?? null, space_type ?? null, notes ?? null, L.nowIso(), id);
    L.audit(db, req, 'space_update', 'spaces', String(id), before, `${status || s.status}/${space_type || s.space_type}`);
    res.json({ ok: true });
  }));

  // ---------- categories ----------
  app.get('/api/categories', requireAuth, (req, res) => {
    res.json({ data: db.prepare('SELECT * FROM parking_categories ORDER BY kind, name').all() });
  });
  app.post('/api/categories', requireAuth, requirePerm('settings.manage'), L.ah(async (req, res) => {
    const { code, name, kind, description } = req.body || {};
    if (!code || !name || !['paid', 'complimentary'].includes(kind)) throw L.ApiError.bad('VALIDATION', 'Code, name and kind (paid/complimentary) are required');
    try {
      const r = db.prepare('INSERT INTO parking_categories (code, name, kind, description, active) VALUES (?,?,?,?,1)')
        .run(String(code).trim().toLowerCase(), String(name).trim(), kind, description || '');
      L.audit(db, req, 'category_create', 'categories', String(r.lastInsertRowid), '', name);
      res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch { throw L.ApiError.conflict('CODE_TAKEN', 'Category code already exists'); }
  }));
  app.put('/api/categories/:id', requireAuth, requirePerm('settings.manage'), L.ah(async (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM parking_categories WHERE id = ?').get(id);
    if (!c) throw L.ApiError.notFound('Category');
    const b = req.body || {};
    const sets = [], args = [];
    for (const f of ['name', 'description', 'active']) {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); args.push(b[f]); }
    }
    // Per-category rate overrides (null/'' clears back to hotel-settings fallback).
    for (const f of ['hourly_rate', 'daily_rate', 'max_charge']) {
      if (b[f] === undefined) continue;
      if (b[f] === null || b[f] === '') { sets.push(`${f} = NULL`); continue; }
      sets.push(`${f} = ?`); args.push(L.validAmount(b[f], { name: f }));
    }
    if (b.grace_minutes !== undefined) {
      if (b.grace_minutes === null || b.grace_minutes === '') sets.push('grace_minutes = NULL');
      else {
        const g = Number(b.grace_minutes);
        if (!Number.isInteger(g) || g < 0 || g > 1440) throw L.ApiError.bad('VALIDATION', 'Grace minutes must be 0-1440');
        sets.push('grace_minutes = ?'); args.push(g);
      }
    }
    if (!sets.length) throw L.ApiError.bad('VALIDATION', 'Nothing to update');
    args.push(id);
    db.prepare(`UPDATE parking_categories SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    L.audit(db, req, 'category_update', 'categories', String(id), c.name, (b.name || c.name));
    res.json({ ok: true });
  }));

  // Operational routes (sessions, payments, monthly, shifts, recon, reports...).
  registerOpsRoutes(app, ctx);

  // ---------- frontend (production single-port) ----------
  const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // ---------- errors (never leak stack traces) ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof L.ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error('Unhandled error:', err && err.message);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error. Please try again.' } });
  });

  return app;
}

async function main() {
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET === 'dev-secret-CHANGE-ME')) {
    throw new Error('Set JWT_SECRET to a long random secret of at least 32 characters in production.');
  }
  if (process.env.NODE_ENV === 'production' && (process.env.OPEN_ACCESS === 'true' || process.env.NO_LOGIN === 'true')) {
    throw new Error('OPEN_ACCESS and NO_LOGIN must be disabled in production.');
  }
  const db = await openDatabase(DB_PATH);
  const app = createApp(db);
  const port = Number(process.env.PORT || 4000);
  app.listen(port, '0.0.0.0', () => console.log(`Marble Arch Parking API on :${port} (db: ${DB_PATH})`));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { createApp, openDatabase, DB_PATH };
