# Marble Arch Hotel Nairobi — Parking Management System

A complete, working parking operation system: vehicle entry → exit → payment →
shifts → reconciliation → reporting, with role-based access, audit logging and a
mobile-friendly gate interface.

**The workspace was empty, so the system was built fresh (no existing code to preserve).**

## Quick start

```bash
# 1. Install (first time only)
npm run install:all

# 2. Start both servers
./start.sh
# Backend  http://localhost:4000/api
# Frontend http://localhost:5173   (proxies /api to the backend)
```

Or run each in its own terminal:

```bash
npm --prefix backend start        # API on :4000
npm --prefix frontend run dev     # UI on :5173
```

Production single-port mode: `npm run build`, then the backend serves the UI
itself at `http://localhost:4000`.

## Default accounts

| Username    | Password   | Role              |
|-------------|------------|-------------------|
| `admin`     | `Admin@123`| Administrator     |
| `manager` … `accounts` | `Demo@123` | Demo per role |

All seeded accounts **must change their password on first login**.
Change the admin password immediately in production, and set
`JWT_SECRET` + `SEED_ADMIN_PASSWORD` in `backend/.env`.

> **Temporary open access:** `OPEN_ACCESS=true` is currently set in
> `backend/.env`, so sign-in needs a username only (no password).
> `NO_LOGIN=true` skips the login screen entirely (auto signed in as admin).
> To restore login later: set both to `false` and restart
> the backend — no code changes needed.

## Architecture

```
frontend/   React 18 + TypeScript + Vite (same-origin /api calls, no secrets)
backend/    Node + Express API, JWT sessions, bcrypt, RBAC on every route,
            server-side validation, immutable audit log, SQLite (WAL) file DB
            that persists at backend/data/parking.db
supabase/   PostgreSQL DDL mirror + Row Level Security for Supabase deploys
```

- Every dashboard/report figure is aggregated live from database records.
- Payments are immutable (no edit/delete); corrections go through refunds.
- Audit logs have no update/delete path.
- M-Pesa secrets live only in server env — never in the frontend bundle.

## Key flows

- **Entry** (`/entry`): registration, category, auto bay assignment, ticket
  print. Duplicate active sessions blocked unless a supervisor overrides.
  Complimentary entries need `complimentary.authorize` + authorizer name.
- **Exit** (`/exit`): lookup → live quote (daily/hourly/grace/monthly/comp) →
  collect cash / manual M-Pesa+code / card+auth → receipt. Pending discounts
  block exit until approved/rejected.
- **M-Pesa**: if Daraja credentials are configured, cashiers can send STK push
  and only the server callback marks it paid. If not configured, the API
  returns `MPESA_NOT_CONFIGURED` and the gate uses clearly-labelled **manual**
  recording (`verification_status=manual`) — never fake success.
- **Shifts**: open with float → auto-linked payments → close with counted
  actuals; any variance needs a written explanation and notifies control.
- **Reconciliation**: computed from transactions → draft → supervisor review →
  controller review → manager finalize (locked afterwards).
- **Reports**: 17 reports with filters, CSV export (Excel-compatible) and
  print/PDF-ready layouts with hotel letterhead.
- **Offline**: if the network drops, entries/exits/payments queue in a local
  outbox and are always shown as **Pending sync** until replayed.

## Configuration (backend/.env)

See `backend/.env.example`. M-Pesa needs:

```
MPESA_ENV=sandbox|production
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=...
MPESA_PASSKEY=...
MPESA_CALLBACK_URL=https://<public-host>/api/mpesa/callback
# optional: MPESA_CALLBACK_TOKEN=<shared secret (?token=...)>
```

## Supabase / PostgreSQL production path

`supabase/migrations/001_init.sql` contains the full Postgres schema, seeds
(roles, permissions, categories, packages, 150 bays) and RLS policies mirroring
the API's permission matrix (`has_perm()`). Point the API at Postgres (swap the
`db.js` driver), set user `app_metadata.role` from Supabase Auth, and keep the
service-role key server-side only.

## Testing

```bash
npm test   # 16 backend suites: entry, duplicates, exit, cash/M-Pesa/card,
           # complimentary, monthly + expiry, discounts, shifts, recon lock,
           # RBAC, audit trail, report totals, move/void
```

## Security notes

- Change `JWT_SECRET`, admin and demo passwords before production use.
- Serve behind HTTPS; set `TZ=Africa/Nairobi` (default in code).
- Rate limiting is enabled; login is additionally throttled.
- No stack traces are ever returned to clients.

---

## IMPLEMENTATION STATUS

### COMPLETED

- Project architecture (React+TS frontend, Express API, persistent DB)
- Authentication (JWT, bcrypt, forced password change, throttled login)
- RBAC — 8 roles × 40 permissions, enforced server-side on every route
- Database schema — 25 normalized tables, FKs, unique constraints, indexes
- Hotel settings (branding, rates, grace, bays, logo upload, receipt/terms)
- 150-bay live occupancy (available/occupied/reserved/OOS + paid/comp/monthly)
- Vehicle entry (auto ticket, auto bay, duplicates guard, override, backdate)
- 12 parking categories (paid + complimentary), configurable
- Daily/hourly/grace billing, configurable rate (default KES 400)
- Vehicle exit (lookup, live quote, staged payments, receipt, bay release)
- Cash / manual M-Pesa / card recording with verification flags
- M-Pesa Daraja architecture: STK push, signed callback, verify-by-amount,
  pending/paid/failed/cancelled/reversed, honest 501 when unconfigured
- Monthly packages + subscriptions + renewal + expiry enforcement + alerts
- Promotions + approval-gated discounts (pending blocks exit)
- Complimentary workflow (KES 0 revenue, counts in occupancy/traffic)
- Executive dashboard (all figures from live DB aggregates)
- Live parking grid with move + reprint
- Shifts (open/close, expected vs actual, variance notes + notifications)
- End-of-day reconciliation with 3-stage approval + finalize lock
- 17 reports + filters + CSV + print letterhead layouts
- Vehicle history, customer database, global search
- Immutable audit log (all sensitive actions, IP/device metadata)
- Notifications (expiry alerts, variance, approvals, finalization)
- Server + client validation, offline outbox with honest sync states
- Responsive UI + mobile gate mode + print styles
- 16 automated backend test suites — all passing
- Supabase migration (Postgres DDL + RLS policies)

### IN PROGRESS

- None — all specified phases (1–6) are implemented.

### REQUIRES EXTERNAL CREDENTIALS (clearly isolated, not faked)

| Integration | Needed to go live | Where to configure |
|---|---|---|
| M-Pesa STK push + callbacks | Daraja consumer key/secret, shortcode, passkey, public callback URL | `backend/.env` (`MPESA_*`) |
| Supabase production DB | Supabase project + Auth users with `app_metadata.role` | `supabase/migrations/001_init.sql`, then point API driver at Postgres |

No integration is claimed live until credentials are configured and verified:
`/api/mpesa/status` reports `configured:false` until then, and M-Pesa amounts
stay flagged `manual` (unverified) in every report.

- **PDF + phone sharing:** every report and the daily reconciliation can be downloaded as a letterheaded PDF or shared straight to WhatsApp/Email via the phone share sheet (desktop falls back to an in-app PDF preview with download, print/save-as-PDF, summary links, one-tap copy and a manual-copy text box). Buttons require `reports.export` permission (reconciliation PDF/share is ungated like print).

## Reliability notes (Sep 2026 fixes)
- **Ticket numbering** derives the daily sequence from existing ticket numbers (`MA-YYYYMMDD-NNNN`), never from a UTC-timestamp count — entries issued 00:00–03:00 EAT no longer collide with `MA-…-0001` (previously a 500 "Unexpected server error").
- **All day filters are local-time aware**: SQL uses `date(col, 'localtime')` / `strftime('%H', col, 'localtime')` so dashboard, reconciliation and reports attribute the 00:00–03:00 EAT window to the correct Nairobi day. Day labels sent by clients must be local `YYYY-MM-DD`.
- **SQLite runs in DELETE journal mode** (single `parking.db` file, `synchronous=FULL`). A `-wal` file captured out of sync with the main DB by file-level snapshots is silently ignored by SQLite (total loss of those transactions); DELETE mode commits straight into the main file so that failure mode cannot occur. A boot-time checkpoint folds any valid WAL content before the switch.
- **Receipt/report printing** renders the print sheet via portal to `document.body` (print CSS hides `.app-shell`), with `@page { margin: 0 }` for clean tickets without browser headers/footers.
- **Test suite is env-independent**: `app.test.js` forces `OPEN_ACCESS=false` / `NO_LOGIN=false` so results don't depend on `backend/.env`.
- **Payment reference uniqueness:** every non-empty M-Pesa/card reference can be recorded only once (case-insensitive, across sessions, exits and subscriptions); reuse is rejected with 409 DUPLICATE_REFERENCE. Cash is exempt (no money-identifier) as is the STK-PENDING placeholder.

## Single-file demo (comparison / offline testing)
- `marble-arch-parking.html` is a fully self-contained build (no server, no network): entry with auto-bay, exit/payment with grace + KES 400/24h, duplicate + full-lot guards, live bays, daily report with CSV, PIN-locked settings, JSON backup/restore. PIN is chosen on first run and stored hashed (SHA-256, cyrb53 fallback).
- Correctness carried over: East Africa Time throughout, per-day ticket sequences that cannot collide after midnight, one-time M-Pesa/card references, complimentary parking requiring authoriser name + PIN.
- Verified with a 15-group runtime harness (setup, entry, duplicates, fee math, find/exit, ref reuse, comp PIN gate, sequencing, report/CSV, settings, PIN change, restore, full lot). Data lives only in that browser — download a backup from Settings daily.

## Production deploy (Railway — recommended)

Single-service mode: the backend serves the built UI itself on one port.

```bash
# 1. Build the UI once (creates frontend/dist)
npm --prefix frontend install
npm --prefix frontend run build

# 2. Configure backend/.env from the template (see backend/.env.example).
#    PRODUCTION: OPEN_ACCESS=false, NO_LOGIN=false, strong JWT_SECRET +
#    SEED_ADMIN_PASSWORD. A fresh database seeds itself on first boot.

# 3. Deploy the repo root with the provided Dockerfile + railway.json,
#    mount a persistent volume at /data, and set DB_PATH=/data/parking.db.
#    Healthcheck: GET /api/health
```

Requirements: Node.js 20+. The zip ships **without** `node_modules/`, `frontend/dist/`,
`backend/data/*.db` and `backend/.env` — install, configure from `.env.example`, and
a clean database seeds automatically.
