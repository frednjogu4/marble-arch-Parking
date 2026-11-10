// SQLite persistence layer (local/production-file DB) + schema + seed.
// The Supabase/PostgreSQL DDL mirror lives in supabase/migrations/001_init.sql.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PERMISSIONS, ROLE_PERMS, hashPassword } = require('./auth');

const SCHEMA = `
PRAGMA journal_mode = DELETE;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id),
  permission_id INTEGER NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

CREATE TABLE IF NOT EXISTS hotel_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hotel_name TEXT NOT NULL DEFAULT 'Marble Arch Hotel Nairobi',
  logo_data TEXT DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phones TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  registration_details TEXT NOT NULL DEFAULT '',
  parking_department TEXT NOT NULL DEFAULT 'Parking Department',
  parking_location TEXT NOT NULL DEFAULT 'Marble Arch Hotel Nairobi',
  total_spaces INTEGER NOT NULL DEFAULT 150,
  daily_rate REAL NOT NULL DEFAULT 400,
  hourly_enabled INTEGER NOT NULL DEFAULT 0,
  hourly_rate REAL NOT NULL DEFAULT 100,
  grace_period_minutes INTEGER NOT NULL DEFAULT 15,
  currency TEXT NOT NULL DEFAULT 'KES',
  receipt_header TEXT NOT NULL DEFAULT '',
  lost_ticket_fee REAL NOT NULL DEFAULT 1000,
  receipt_footer TEXT NOT NULL DEFAULT 'Thank you for parking with us.',
  terms TEXT NOT NULL DEFAULT '',
  social_facebook TEXT NOT NULL DEFAULT '',
  social_twitter TEXT NOT NULL DEFAULT '',
  social_instagram TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS parking_spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  zone TEXT NOT NULL DEFAULT 'A',
  space_type TEXT NOT NULL DEFAULT 'standard'
    CHECK (space_type IN ('standard','reserved','vip','disabled','staff','motorcycle')),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','occupied','reserved','out_of_service')),
  current_session_id INTEGER REFERENCES parking_sessions(id),
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spaces_status ON parking_spaces(status);
CREATE INDEX IF NOT EXISTS idx_spaces_code ON parking_spaces(code);

CREATE TABLE IF NOT EXISTS parking_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('paid','complimentary')),
  description TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  hourly_rate REAL,
  daily_rate REAL,
  max_charge REAL,
  grace_minutes INTEGER
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  customer_type TEXT NOT NULL DEFAULT 'casual',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration TEXT NOT NULL UNIQUE,
  vehicle_type TEXT NOT NULL DEFAULT 'Saloon',
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  customer_id INTEGER REFERENCES customers(id),
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicles_reg ON vehicles(registration);

CREATE TABLE IF NOT EXISTS monthly_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  price REAL NOT NULL DEFAULT 0,
  validity_days INTEGER NOT NULL DEFAULT 30,
  reserved_space INTEGER NOT NULL DEFAULT 0,
  vehicle_limit INTEGER NOT NULL DEFAULT 1,
  benefits TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monthly_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  registration TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'Saloon',
  package_id INTEGER NOT NULL REFERENCES monthly_packages(id),
  start_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  payment_reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','suspended','cancelled')),
  renewed_from INTEGER REFERENCES monthly_subscriptions(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_reg ON monthly_subscriptions(registration);
CREATE INDEX IF NOT EXISTS idx_subs_status ON monthly_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_expiry ON monthly_subscriptions(expiry_date);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES monthly_subscriptions(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  shift_id INTEGER REFERENCES shifts(id),
  paid_at TEXT NOT NULL,
  received_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parking_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL UNIQUE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  registration TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  category_id INTEGER NOT NULL REFERENCES parking_categories(id),
  monthly_subscription_id INTEGER REFERENCES monthly_subscriptions(id),
  space_id INTEGER REFERENCES parking_spaces(id),
  entry_time TEXT NOT NULL,
  exit_time TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exited','voided')),
  base_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','partial','paid','complimentary')),
  entry_user_id INTEGER REFERENCES users(id),
  exit_user_id INTEGER REFERENCES users(id),
  created_offline INTEGER NOT NULL DEFAULT 0,
  lost_ticket INTEGER NOT NULL DEFAULT 0,
  lost_id_number TEXT NOT NULL DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON parking_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_reg ON parking_sessions(registration);
CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON parking_sessions(ticket_no);
CREATE INDEX IF NOT EXISTS idx_sessions_entry ON parking_sessions(entry_time);
CREATE INDEX IF NOT EXISTS idx_sessions_exit ON parking_sessions(exit_time);
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON parking_sessions(phone);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES parking_sessions(id),
  ticket_no TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  issued_by INTEGER REFERENCES users(id),
  printed_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES parking_sessions(id),
  subscription_id INTEGER REFERENCES monthly_subscriptions(id),
  invoice_id INTEGER REFERENCES invoices(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','mpesa','card')),
  reference TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'manual'
    CHECK (verification_status IN ('verified','manual','pending','failed')),
  terminal TEXT NOT NULL DEFAULT '',
  shift_id INTEGER REFERENCES shifts(id),
  received_by INTEGER REFERENCES users(id),
  paid_at TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(session_id);
CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id);
CREATE INDEX IF NOT EXISTS idx_payments_paid ON payments(paid_at);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method);
-- NOTE: idx_payments_invoice is created by migrate() AFTER the invoice_id ALTER (old DBs would crash here).

CREATE TABLE IF NOT EXISTS payment_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER REFERENCES payments(id),
  session_id INTEGER REFERENCES parking_sessions(id),
  provider TEXT NOT NULL DEFAULT 'mpesa',
  provider_ref TEXT DEFAULT '',
  mpesa_receipt TEXT DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','failed','cancelled','reversed')),
  raw_callback TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ptxn_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_ptxn_ref ON payment_transactions(provider_ref);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('percentage','fixed','free','time_based','event','guest')),
  value REAL NOT NULL DEFAULT 0,
  conditions TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT DEFAULT '',
  valid_to TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES parking_sessions(id),
  promotion_id INTEGER REFERENCES promotions(id),
  original_amount REAL NOT NULL,
  discount_amount REAL NOT NULL,
  final_amount REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  applied_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','applied')),
  validation_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discounts_session ON discounts(session_id);
CREATE INDEX IF NOT EXISTS idx_discounts_status ON discounts(status);

CREATE TABLE IF NOT EXISTS complimentary_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES parking_sessions(id),
  comp_category TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  authorized_by TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comp_session ON complimentary_authorizations(session_id);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  station TEXT NOT NULL DEFAULT 'Main Gate',
  opened_at TEXT NOT NULL,
  opening_cash REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at TEXT,
  expected_cash REAL NOT NULL DEFAULT 0,
  actual_cash REAL,
  expected_mpesa REAL NOT NULL DEFAULT 0,
  actual_mpesa REAL,
  expected_card REAL NOT NULL DEFAULT 0,
  actual_card REAL,
  variance_note TEXT DEFAULT '',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);

CREATE TABLE IF NOT EXISTS shift_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_date TEXT NOT NULL UNIQUE,
  total_cash REAL NOT NULL DEFAULT 0,
  total_mpesa REAL NOT NULL DEFAULT 0,
  total_card REAL NOT NULL DEFAULT 0,
  total_revenue REAL NOT NULL DEFAULT 0,
  paid_vehicles INTEGER NOT NULL DEFAULT 0,
  complimentary_vehicles INTEGER NOT NULL DEFAULT 0,
  monthly_vehicles INTEGER NOT NULL DEFAULT 0,
  total_vehicles INTEGER NOT NULL DEFAULT 0,
  discounts_total REAL NOT NULL DEFAULT 0,
  refunds_total REAL NOT NULL DEFAULT 0,
  variance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','supervisor_reviewed','controller_reviewed','finalized')),
  supervisor_by INTEGER REFERENCES users(id),
  supervisor_at TEXT,
  controller_by INTEGER REFERENCES users(id),
  controller_at TEXT,
  manager_by INTEGER REFERENCES users(id),
  manager_at TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  session_id INTEGER REFERENCES parking_sessions(id),
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','processed')),
  requested_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  username TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  module TEXT NOT NULL,
  record_id TEXT NOT NULL DEFAULT '',
  old_value TEXT DEFAULT '',
  new_value TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  audience_role TEXT DEFAULT '',
  user_id INTEGER REFERENCES users(id),
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  registration TEXT NOT NULL DEFAULT '',
  subscription_id INTEGER REFERENCES monthly_subscriptions(id),
  session_id INTEGER REFERENCES parking_sessions(id),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partial','paid','voided')),
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_no ON invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(due_date);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invitems_inv ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('AUTHORIZED','DENIED')),
  reason TEXT NOT NULL DEFAULT '',
  subscription_id INTEGER REFERENCES monthly_subscriptions(id),
  session_id INTEGER REFERENCES parking_sessions(id),
  checked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_reg ON access_logs(registration);
CREATE INDEX IF NOT EXISTS idx_access_created ON access_logs(created_at);

CREATE TABLE IF NOT EXISTS validation_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  max_amount REAL,
  status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','used','expired','revoked')),
  expires_at TEXT,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  used_by_session INTEGER REFERENCES parking_sessions(id),
  used_amount REAL NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_valid_code ON validation_codes(code);
CREATE INDEX IF NOT EXISTS idx_valid_status ON validation_codes(status);

CREATE TABLE IF NOT EXISTS gate_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES parking_sessions(id),
  action TEXT NOT NULL DEFAULT 'open' CHECK (action IN ('open','override')),
  reason TEXT NOT NULL DEFAULT '',
  opened_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_created ON gate_logs(created_at);
`;

const DEFAULT_CATEGORIES = [
  ['daily', 'Daily Customer', 'paid', 'Standard daily parking'],
  ['hourly', 'Hourly Customer', 'paid', 'Hourly parking (when enabled)'],
  ['monthly', 'Monthly Customer', 'paid', 'Active monthly subscription'],
  ['accommodation', 'Hotel Accommodation Guest', 'complimentary', 'In-house guests'],
  ['restaurant', 'Restaurant Customer', 'complimentary', 'Restaurant patrons'],
  ['bar', 'Bar Customer', 'complimentary', 'Bar patrons'],
  ['conference', 'Conference / Function Customer', 'complimentary', 'Events & conferencing'],
  ['staff', 'Staff', 'complimentary', 'Hotel employees'],
  ['management', 'Management', 'complimentary', 'Hotel management'],
  ['vip', 'VIP', 'complimentary', 'VIP guests'],
  ['authorized', 'Authorized Complimentary', 'complimentary', 'Approved complimentary'],
  ['official', 'Official Hotel Vehicle', 'complimentary', 'Hotel fleet']
];

const DEFAULT_PACKAGES = [
  ['Monthly Standard', 6000, 30, 0, 1, 'Standard monthly bay, one vehicle', 1],
  ['Monthly Reserved', 9000, 30, 1, 1, 'Reserved numbered bay, one vehicle', 1],
  ['Corporate Monthly', 7500, 30, 0, 1, 'Corporate rate, one vehicle', 1],
  ['Motorcycle Monthly', 2500, 30, 0, 1, 'Motorcycle bay', 1]
];

async function seed(db) {
  const now = new Date().toISOString();
  const roleCount = db.prepare('SELECT COUNT(*) c FROM roles').get().c;
  if (roleCount > 0) return; // already seeded

  const insRole = db.prepare('INSERT INTO roles (name, description, created_at) VALUES (?,?,?)');
  const insPerm = db.prepare('INSERT INTO permissions (code, description) VALUES (?,?)');
  const insRP = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?,?)');
  const roleIds = {};
  for (const name of Object.keys(ROLE_PERMS)) {
    const r = insRole.run(name, name, now);
    roleIds[name] = Number(r.lastInsertRowid);
  }
  const permIds = {};
  for (const [code, desc] of PERMISSIONS) {
    const r = insPerm.run(code, desc);
    permIds[code] = Number(r.lastInsertRowid);
  }
  for (const [role, codes] of Object.entries(ROLE_PERMS)) {
    const list = codes.includes('*') ? PERMISSIONS.map(p => p[0]) : codes;
    for (const code of list) insRP.run(roleIds[role], permIds[code]);
  }

  // Default administrator (must change password on first login).
  const adminHash = await hashPassword(process.env.SEED_ADMIN_PASSWORD || 'Admin@123');
  db.prepare(`INSERT INTO users (full_name, username, email, phone, password_hash, role_id, active, must_change_password, created_at, updated_at)
    VALUES (?,?,?,?,?,?,1,1,?,?)`).run(
    'System Administrator', 'admin', 'admin@marblearchhotel.co.ke', '', adminHash, roleIds['Administrator'], now, now
  );
  // Labelled demo accounts for each operational role.
  const demos = [
    ['Demo Manager', 'manager', 'Manager'], ['Demo Controller', 'controller', 'Controller'],
    ['Demo Supervisor', 'supervisor', 'Supervisor'], ['Demo Cashier', 'cashier', 'Cashier'],
    ['Demo Attendant', 'attendant', 'Parking Attendant'], ['Demo Security', 'security', 'Security'],
    ['Demo Accounts', 'accounts', 'Accounts']
  ];
  const demoHash = await hashPassword('Demo@123');
  const insUser = db.prepare(`INSERT INTO users (full_name, username, email, phone, password_hash, role_id, active, must_change_password, created_at, updated_at)
    VALUES (?,?,?,?,?,?,1,1,?,?)`);
  for (const [name, uname, role] of demos) {
    insUser.run(name, uname, `${uname}@marblearchhotel.co.ke`, '', demoHash, roleIds[role], now, now);
  }

  // Hotel settings defaults.
  db.prepare(`INSERT INTO hotel_settings (id, hotel_name, address, phones, email, website, registration_details,
    parking_department, parking_location, total_spaces, daily_rate, hourly_enabled, hourly_rate,
    grace_period_minutes, currency, receipt_footer, terms, updated_at)
    VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Marble Arch Hotel Nairobi',
    'Marble Arch Hotel, Nairobi, Kenya',
    '+254 20 0000000',
    'parking@marblearchhotel.co.ke',
    'https://marblearchhotel.co.ke',
    '',
    'Parking Department',
    'Marble Arch Hotel Nairobi - Basement & Surface Parking',
    150, 400, 0, 100, 15, 'KES',
    'Thank you for parking at Marble Arch Hotel Nairobi.',
    'Vehicles are parked at owners risk. Please retain your ticket. Unpaid vehicles will not be released.',
    now
  );

  // Parking spaces P-001..P-150 (140 standard, 8 reserved, 2 out of service).
  const insSpace = db.prepare(`INSERT INTO parking_spaces (code, zone, space_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`);
  const mkSpaces = db.transaction(() => {
    for (let i = 1; i <= 150; i++) {
      const code = 'P-' + String(i).padStart(3, '0');
      const zone = i <= 50 ? 'A' : i <= 100 ? 'B' : 'C';
      let type = 'standard', status = 'available';
      if (i >= 141 && i <= 148) { type = 'reserved'; status = 'reserved'; }
      if (i >= 149) { status = 'out_of_service'; }
      insSpace.run(code, zone, type, status, now, now);
    }
  });
  mkSpaces();

  const insCat = db.prepare('INSERT INTO parking_categories (code, name, kind, description, active) VALUES (?,?,?,?,1)');
  for (const c of DEFAULT_CATEGORIES) insCat.run(c[0], c[1], c[2], c[3]);

  const insPkg = db.prepare(`INSERT INTO monthly_packages (name, price, validity_days, reserved_space, vehicle_limit, benefits, active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const p of DEFAULT_PACKAGES) insPkg.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], now, now);

  // One clearly-labelled inactive sample promotion (not applied to anything).
  db.prepare(`INSERT INTO promotions (name, kind, value, conditions, active, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('SAMPLE - Weekend 10% Off (inactive)', 'percentage', 10, '{}', 0, 1, now, now);

  db.prepare(`INSERT INTO audit_logs (user_id, username, role, action, module, record_id, new_value, created_at)
    VALUES (1,'admin','Administrator','seed','system','',?,?)`).run('Initial database seed completed', now);
}

// Lightweight forward migration for existing DB files: CREATE TABLE IF NOT
// EXISTS covers new tables, but new COLUMNS on old tables need ALTERs.
function migrate(db) {
  const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map(r => r.name);
  const ensure = (t, c, ddl) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); };
  ensure('hotel_settings', 'receipt_header', "TEXT NOT NULL DEFAULT ''");
  ensure('parking_categories', 'hourly_rate', 'REAL');
  ensure('parking_categories', 'daily_rate', 'REAL');
  ensure('parking_categories', 'max_charge', 'REAL');
  ensure('parking_categories', 'grace_minutes', 'INTEGER');
  ensure('vehicles', 'make', "TEXT NOT NULL DEFAULT ''");
  ensure('vehicles', 'model', "TEXT NOT NULL DEFAULT ''");
  ensure('vehicles', 'color', "TEXT NOT NULL DEFAULT ''");
  ensure('payments', 'invoice_id', 'INTEGER REFERENCES invoices(id)');
  ensure('parking_sessions', 'lost_ticket', 'INTEGER NOT NULL DEFAULT 0');
  ensure('parking_sessions', 'lost_id_number', "TEXT NOT NULL DEFAULT ''");
  ensure('discounts', 'validation_code', "TEXT NOT NULL DEFAULT ''");
  ensure('hotel_settings', 'lost_ticket_fee', 'REAL NOT NULL DEFAULT 1000');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id)');
  // Sync any permissions added to auth.js after the original seed.
  try {
    const have = new Set(db.prepare('SELECT code FROM permissions').all().map(r => r.code));
    const insP = db.prepare('INSERT INTO permissions (code, description) VALUES (?,?)');
    const ids = {};
    for (const row of db.prepare('SELECT id, code FROM permissions').all()) ids[row.code] = row.id;
    for (const [code, desc] of PERMISSIONS) {
      if (!have.has(code)) { ids[code] = Number(insP.run(code, desc).lastInsertRowid); have.add(code); }
    }
    const roles = db.prepare('SELECT id, name FROM roles').all();
    const link = db.prepare(`INSERT INTO role_permissions (role_id, permission_id)
      SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?)`);
    for (const r of roles) {
      const codes = ROLE_PERMS[r.name] || [];
      const list = codes.includes('*') ? PERMISSIONS.map(x => x[0]) : codes;
      for (const code of list) if (ids[code]) link.run(r.id, ids[code], r.id, ids[code]);
    }
  } catch (e) { console.error('permission sync failed:', e.message); }
}

async function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  // Durability: fold any still-valid WAL content into the main file, then
  // run in DELETE journal mode so the database is ALWAYS one
  // self-consistent file. (A -wal file captured out of sync with the main
  // db by a file-level snapshot/backup is silently ignored by SQLite,
  // losing every transaction it held; DELETE mode commits straight into
  // parking.db so that failure mode cannot happen.)
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  await seed(db);
  migrate(db);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
  return db;
}

module.exports = { openDatabase, SCHEMA };
