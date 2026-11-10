# Marble Arch Parking — Deploy to Render (one page)

Target: single Docker service on Render (Starter + 1 GB disk ≈ $7.25/mo).
Free tier will NOT work (no persistent disk → database wipes on every deploy).

## What you are deploying
- Backend: Node/Express API + SQLite (`DB_PATH=/data/parking.db` on the Render disk)
- Frontend: React/Vite app served by the same service (single container)
- Login enforced (`OPEN_ACCESS=false`, `NO_LOGIN=false`); first user is seeded `admin`
- M-Pesa runs in clearly-labelled MANUAL mode until Daraja credentials are added

## Step 1 — Code on GitHub
Repo root `frednjogu4/marble-arch-Parking`, branch `main`, must contain:
`render.yaml`, `Dockerfile`, `start.sh`, `backend/`, `frontend/`, `supabase/`,
`backend/.env.example`. Delete any `.zip` from the repo (bloat, not source).

## Step 2 — Render Blueprint
1. dashboard.render.com → **New → Blueprint** → select `marble-arch-Parking`
2. Leave **Blueprint Path empty** (defaults to `render.yaml` at root)
3. **Apply** (confirm **Starter** plan) → wait 3–5 min for first build

What `render.yaml` provisions: web service `marble-arch-parking` (docker,
health check `/api/health`), 1 GB disk mounted at `/data`, env
`DB_PATH=/data/parking.db`, `NODE_ENV=production`, `OPEN_ACCESS/NO_LOGIN=false`,
generated `JWT_SECRET` + `SEED_ADMIN_PASSWORD`.

## Step 3 — First login (do this immediately)
1. Render → service → **Environment** → copy `SEED_ADMIN_PASSWORD`
2. Open the service URL → log in as `admin` + that password
3. **Change the admin password** in the app right away

## Verify it worked
- `https://<your-service>.onrender.com/api/health` returns `{"ok":true,"db":"up",...}`
- `/` shows the login page (NOT a JSON message)
- `/api/dashboard` without login returns 401
- Restart the service → log in again → data you entered is still there (disk works)

## Troubleshooting
| Symptom | Cause → fix |
|---|---|
| "Blueprint file render.yaml not found" | Wrong repo connected, or file missing → connect `marble-arch-Parking`, leave path empty |
| 502 right after Apply | Build still running or failed → wait, then check Logs |
| Data disappears after deploy | Disk not attached → check service has disk at `/data` |
| Login screen skipped / no password asked | `NO_LOGIN`/`OPEN_ACCESS` true → set both `false`, redeploy |
| M-Pesa "NOT_CONFIGURED" | Normal until Daraja keys are set → use manual recording |

## Costs (Oct 2026 pricing)
Starter $7/mo + 1 GB disk $0.25/mo ≈ **$7.25/mo**. Keep the disk — without it
SQLite resets on every deploy.

Fresh production databases do not create demo users. Existing databases may still contain demo accounts; disable or reset them before deployment. To put Cloudflare in front of this service, see [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md).
