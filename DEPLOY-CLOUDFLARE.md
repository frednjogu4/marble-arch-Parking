# Cloudflare deployment

Cloudflare Workers cannot run the current Express/`better-sqlite3` API or its
SQLite file. The Worker in this repository serves the built frontend and
forwards `/api` to a separately deployed Node backend over HTTPS. Cloudflare
alone is **not** a database or a complete backend for this application.

1. Deploy the same revision to a Node/Docker host with a persistent disk, using
   `render.yaml` or `Dockerfile` (see `DEPLOY-RENDER.md`). Set `DB_PATH` to a
   file on that disk, `NODE_ENV=production`, `OPEN_ACCESS=false`,
   `NO_LOGIN=false`, a random `JWT_SECRET` of at least 32 characters, and a
   strong `SEED_ADMIN_PASSWORD` of at least 12 characters. Use one backend
   instance for the SQLite database. Confirm `https://<backend>/api/health`
   returns `{"ok":true,"db":"up",...}` before continuing.
2. In Cloudflare Workers & Pages, connect this repository and deploy a commit
   containing `wrangler.jsonc`. Set the **root directory** to the repository
   root, **build command** to `npm run build`, and **deploy command** to
   `npx wrangler deploy`. The build installs the frontend's locked dependencies
   itself, so Cloudflare's root-level Bun install is not sufficient or required.
   The Worker config provides the asset directory and SPA routing.
3. In the Worker's **Settings → Variables and Secrets**, set the plain-text
   variable `BACKEND_ORIGIN` to the backend's HTTPS origin, e.g.
   `https://your-service.onrender.com` (no path, query, or credentials). Deploy
   a new version if required by the dashboard. `keep_vars` preserves dashboard
   variables on subsequent Wrangler deployments. Do not point this at the
   Cloudflare Worker itself.
4. Visit `https://<worker-domain>/api/health`; it should return the backend's
   JSON health response. Then open the frontend and log in as `admin` with
   the configured seed password and change it immediately. Create individual
   staff accounts. Verify entry, exit, payment and a restart with retained data
   before using the system operationally.

If `/api/health` returns `BACKEND_NOT_CONFIGURED`, set the variable on the
actual Worker/environment and redeploy. `BACKEND_UNAVAILABLE` means the backend
could not be reached. The app will not work with only the static frontend.
If the Cloudflare build succeeds but deployment fails, check the deploy command,
Worker build token permissions, and the build logs. These settings must be
applied in Cloudflare; changing this repository does not redeploy an existing
production branch by itself.

Fresh production databases do not create demo users. **Existing databases are
not altered by this change**: disable or reset the demo accounts and review
all credentials before going live. Never use an ephemeral disk for parking
data. Back up the database regularly. M-Pesa STK push requires separately
configured Daraja credentials and a public callback URL; without them, only
manual recording is available.
