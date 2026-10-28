# MASTER-PROMPT.md — Hotel Parking Management System (Nairobi, Kenya) — v2 Enhanced

> v2 = user's original brief + operational hardening (marked **[ADDED]**).
> Stack unchanged: Python/Flask backend, Flutter attendant app, single-file admin dashboard, Raspberry Pi gate.

## 1. OVERVIEW
Full parking system for a Nairobi hotel:
- Entry/exit gates with ticketing, ANPR-ready plate capture
- Fees: KSh 200 first hour, KSh 100/hr after, KSh 1,000 lost ticket flat, 24h cap KSh 1,500
- Payments: CASH, PDQ card, M-PESA STK Push (Daraja), hotel validation codes
- Attendant: Flutter Android tablet app (Bluetooth thermal printer)
- Admin: web dashboard (revenue, occupancy, transactions, CSV export)
- Gate: Raspberry Pi GPIO relay
- Timezone: Africa/Nairobi (EAT)
- **[ADDED]** Roles: Admin / Manager / Cashier / Attendant / Security — every money action tied to a user + shift
- **[ADDED]** Shifts with opening float, expected-vs-actual close, variance notes
- **[ADDED]** Daily reconciliation (draft → review → finalize/lock) + full audit trail
- **[ADDED]** Monthly clients, complimentary (staff/guest/event), discounts with approval, refunds with approval
- **[ADDED]** All rates/fees configurable in Settings (never hardcoded) + offline-tolerant attendant app

## 2. TECH STACK
- Backend: Python 3.10+, Flask, Flask-SQLAlchemy, PyJWT, requests
- DB: SQLite (→ PostgreSQL for production)
- App: Flutter (http, shared_preferences, esc_pos_bluetooth optional)
- Dashboard: single admin.html + Chart.js
- M-Pesa: Safaricom Daraja OAuth + STK Push + Callback
- **[ADDED]** Backend extras: Flask-Migrate (Alembic — no "just swap URI" without migrations), Flask-Limiter (login brute-force), gunicorn + systemd in production, pytest suite
- **[ADDED]** Time rule: store UTC in DB, display Africa/Nairobi; fee math on timezone-aware datetimes

## 3. BACKEND — app.py (key structure)
```python
# Models
User(id, username, password_hash, role, active, must_change_password)  # [ADDED] role/active/force-change
Slot(id, code, zone, slot_type, is_occupied)                           # [ADDED] zone/type (STD/VIP/STF)
Ticket(id, ticket_no, plate, slot_id, entry_time, exit_time, status OPEN/CLOSED/LOST,
       fee_due, discount, amount_paid)                                  # [ADDED] money columns
Payment(id, ticket_id, amount, method cash/pdq/mpesa/validation,
        status PENDING/CONFIRMED/FAILED/UNDERPAID, mpesa_receipt UNIQUE,   # [ADDED] receipt single-use
        checkout_id UNIQUE, phone, paid_at, shift_id, received_by)         # [ADDED] shift+user link
Validation(id, code UNIQUE, used, used_by_ticket, expires, created_by)     # [ADDED] unique+creator
# [ADDED] Ops models:
Shift(id, user_id, opened_at, closed_at, opening_float, expected_cash/pdq/mpesa,
      actual_cash/pdq/mpesa, variance_note, status OPEN/CLOSED, reviewed_by)
Reconciliation(id, date UNIQUE, totals_json, status DRAFT/FINALIZED, finalized_by)
AuditLog(id, user_id, action, module, record_id, detail, created_at)
MonthlySub(id, customer, plate UNIQUE-active, package, start, expiry, amount, status)
Discount(id, ticket_id, kind, value, amount, reason, status PENDING/APPLIED, applied_by, approved_by)
Refund(id, payment_id, amount, reason, status PENDING/APPROVED/PROCESSED)
Settings(id=1, first_hour, extra_hour, lost_fee, cap_24h, grace_min, currency,
         hotel_name, receipt_header/footer)                               # [ADDED] configurable rates
AccessLog(id, plate, verdict AUTHORIZED/DENIED, reason, created_at)       # [ADDED] gate checks

# Helpers
EAT = timezone("Africa/Nairobi")
fee(ticket, now):  # [ADDED] exact rules
  - grace_min free (default 15) → 0
  - LOST → lost_fee flat (identity check required: ID/phone recorded)
  - else: first_hour + ceil(hours-1)+ * extra_hour; cap_24h applied PER 24h block
  - monthly-active plate → 0 (subscription covers); complimentary/validation → 0
  - partial hours ALWAYS round UP; overnight spans each midnight boundary cleanly
normalize_plate(): uppercase, strip non-alnum, 2–10 chars, Kenyan formats   # [ADDED]
token_required decorator (JWT Bearer, 8h expiry) + role_required(*roles)    # [ADDED]
DarajaOAuth() -> cached token (refresh 1 min before expiry)                 # [ADDED] expiry
stk_push(phone, amount, ticket_no) -> CheckoutRequestID (PENDING row first) # [ADDED] row-first
/mpesa/callback -> IDEMPOTENT on checkout_id (retries safe); timeout sweep:  # [ADDED]
  PENDING older than 10 min → FAILED (cron or on-status-check); reversal endpoint
open_gate(reason, user) -> GPIO17 HIGH 5s + AuditLog EVERY opening;          # [ADDED]
  interlocks: never open without CONFIRMED payment/validation unless override role;
  manual key override → attendant logs it within 5 min (alert if not)

# API
POST /api/login                          {username,password} -> {token} (rate-limited 5/min)  # [ADDED]
POST /api/entry                          {plate, slot?} -> {ticket_no, slot, entry_time}
  # [ADDED] guards: duplicate OPEN ticket for plate → 409 (override role only)
GET  /api/exit               -> {plate, hours, fee, discount, due, status}
POST /api/pay/cash | /pdq                {ticket_no} -> closes ticket, gate
  # [ADDED] requires OPEN shift for that user; PDQ requires auth code (single-use)
POST /api/pay/mpesa                       {ticket_no, phone} -> {checkout_id}
GET  /api/pay/mpesa/status/<checkout_id>  -> {status} (also runs timeout sweep)
POST /api/pay/validation                  {ticket_no, code} -> single-use check, gate
POST /api/lost-ticket                     {ticket_no, id_number, phone} -> LOST, flat fee  # [ADDED] ID check
# [ADDED] Ops API:
POST /api/shifts/open  {opening_float} | POST /api/shifts/close {actuals, variance_note?}
GET  /api/shifts/current | POST /api/shifts/<id>/review (manager)
POST /api/recon/<date>/finalize (manager; locks day) | GET /api/recon/<date>
POST /api/discounts {ticket_no, kind, value, reason} | POST /api/discounts/<id>/decision
POST /api/refunds  {payment_id, amount, reason} | POST /api/refunds/<id>/decision
GET/POST /api/monthly/subs | POST /api/monthly/subs/<id>/renew
POST /api/access/check {plate} -> AUTHORIZED/DENIED + reason (logged)
GET  /api/settings | PUT /api/settings (admin; rates change audited)
GET  /api/audit?action=&from=&to=  |  GET /api/health (db+disk+mpesa-config status)
GET  /api/admin/dashboard/summary?date=
GET  /api/admin/dashboard/revenue_range?days=14
GET  /api/admin/dashboard/occupancy_history?date=
GET  /api/admin/dashboard/transactions?date=&method=
POST /api/admin/validation                -> new 24h code "HV..." (single-use, audited)
GET  /admin -> admin.html

Bootstrap: admin user from ADMIN_PASSWORD env (no default password in code!),
  force change on first login; 100 slots P001–P100 across zones A–D.          # [ADDED]
Run (dev): flask run --host=0.0.0.0 --port=5000
Run (prod): gunicorn -w 3 app:app behind nginx/caddy HTTPS, systemd unit.    # [ADDED]
```

## 4. FLUTTER APP (lib/main.dart)
- LoginPage → JWT stored in SharedPreferences, auto-login
- HomePage: 4 tiles (ENTRY / EXIT / VALIDATION / LOST TICKET) + occupancy badge
- Entry: prompt plate → POST /api/entry → print ticket (ESC/POS BT) → snack
- ExitPage: lookup ticket → fee card → CASH / PDQ / M-PESA buttons
  M-Pesa: STK push → poll status every 3s → "PAID — gate open"
- Lost ticket: KSh 1,000 flat cash
- SERVER const = "http://<server-ip>:5000"
- **[ADDED] Shift tile**: open (float) / close (actuals + variance note) — app blocks payments without open shift
- **[ADDED] Offline outbox**: queue entries + cash payments in SQLite when server unreachable; banner "OFFLINE — N unsynced"; auto-sync + conflict rule (server ticket_no wins, local marked duplicate)
- **[ADDED] Printer fallback**: BT disconnect → show ticket as QR + big ticket_no, "Print later" queue, reprint button
- **[ADDED] Access tile (security)**: plate → AUTHORIZED/DENIED screen (green/red), works from cached monthly list when offline (flag "offline verdict — recheck")
- **[ADDED] Hardening**: auto-logout 15 min idle, no JWT in logs, SERVER via first-run setup screen (not hardcoded), app PIN after login

pubspec: http, shared_preferences (+ esc_pos_bluetooth, flutter_bluetooth_serial optional)

## 5. ADMIN DASHBOARD (admin.html)
- Dark theme, auto-refresh 60s
- KPIs: revenue today, transactions, entries, exits, lost tickets, occupancy
- Charts: entries-vs-exits hourly (line), revenue by method (doughnut), 14-day trend (line)
- Transactions table with method filter, status color coding
- CSV export, logout
- Login via /api/login, token in localStorage
- **[ADDED] Rates page**: edit first-hour/extra-hour/lost/cap/grace + receipt text (audited, manager+)
- **[ADDED] Shifts page**: open/closed, expected vs actual, variance notes, review button
- **[ADDED] Reconciliation page**: day totals, finalize + lock (manager), finalized days read-only
- **[ADDED] Approvals inbox**: pending discounts + refunds (badge count), approve/reject with reason
- **[ADDED] Monthly + validations**: subs list/expiry alerts/renew; validation codes issue/revoke
- **[ADDED] M-Pesa page**: PENDING/FAILED transactions, retry/timeout, reversals, callback log
- **[ADDED] Audit log page**: filter by user/action/date; gate openings highlighted
- **[ADDED] Users page**: create/disable/reset, role assignment, force-password-change

## 6. M-PESA DARAJA SETUP
Sandbox:
1. developer.safaricom.co.ke → app → Key/Secret
2. ShortCode 174379 + public sandbox passkey
3. ngrok http 5000 → set CB_URL to https callback
4. Test phone 254110, PIN 0000
Production:
- Base https://api.safaricom.co.ke
- Real Business ShortCode, production passkey
- HTTPS callback URL registered in Daraja portal
- **[ADDED] Reliability rules**: callback handler idempotent (UNIQUE checkout_id, returns 200 even on duplicates); PENDING sweep to FAILED after 10 min; STK timeout on tablet shows "Check phone — if deducted, tap VERIFY" (verify = status endpoint, never double-charge); reversal API for erroneous pushes; if Daraja is down, cashier uses manual M-Pesa recording (type receipt code, single-use enforced, flagged `manual`)
- **[ADDED] Reconciliation**: daily report (system M-Pesa total vs C2B register/statement total, unmatched list)

## 7. DEPLOYMENT RUNBOOK
```bash
pip install -r requirements.txt
export MPESA_KEY=... MPESA_SECRET=... MPESA_PASSKEY=... CB_URL=...
python app.py

# Flutter tablet on same LAN, SERVER = server IP
# Gate relay: GPIO17 → relay IN → 24V contactor → gate motor (never direct GPIO)
# Manual key override for fail-safe
```
Ops:
- Daily SQLite backup cron: sqlite3 parking.db ".backup backup_$(date +%F).db"
- PostgreSQL: just swap URI
- Daily M-Pesa reconciliation vs C2B register
- Security: strong JWT secret, HTTPS via nginx/caddy, rate-limit login, change default creds
- **[ADDED] Harden the runbook**:
  - `.env` (never commit): JWT_SECRET (32+ random), ADMIN_PASSWORD, MPESA_*, CB_URL, DB_URI
  - systemd unit `[parking.service]` + logrotate; health check cron hitting /api/health (alert on fail)
  - Backup: nightly `.backup` + weekly restore DRILL to a temp file (un-tested backups don't count)
  - PostgreSQL: migrate via `flask db upgrade` (Alembic), not URI swap; enable pgcrypto/pg_trgm as needed
  - Network: tablet API on LAN only (UFW: allow 5000 from LAN, deny WAN); Pi on UPS + watchdog reboot
  - Gate wiring: relay module with optocoupler, flyback diode, fused 24V; vehicle loop detector before auto-close; gate-open alert if held > 60s

## 8. [ADDED] TESTING (pytest — must stay green)
- Fee math: grace free, 45 min = 200, 61 min = 300, 25h = cap+200 block math, lost = 1000
- Duplicate OPEN plate → 409; override role bypasses
- Validation code: single-use, expired rejected, audited
- M-Pesa: callback twice → one CONFIRMED (idempotent); PENDING > 10 min → FAILED; manual receipt reused → 409
- Shift: pay without open shift → 403; close with variance and no note → 422
- RBAC: attendant cannot finalize/refund-approve; cashier cannot edit rates
- Recon: finalized day rejects new payments edits (read-only)

## 9. [ADDED] GO-LIVE CHECKLIST
- [ ] Rates + hotel profile + receipt text configured (not defaults)
- [ ] Admin password changed, cashier/attendant accounts created, ex-staff disabled
- [ ] Daraja production callback live-tested with KSh 10 STK (then reversed)
- [ ] Printer paired + fallback drill done; offline drill done (airplane mode → queue → sync)
- [ ] Backup + restore drill done; PG migration rehearsed if applicable
- [ ] Gate: interlock test (no pay → no open), loop-detector test, manual-key drill logged
- [ ] Tablet SERVER set, auto-logout verified, spare tablet charged
