# Running Money Manager on Vercel

The deployment serves two things from one project:

| Path | What it is |
|---|---|
| `/` | the app itself — a static page, rewritten to `Money Manager.dc.html` |
| `/api/v1/*` | the backup & sync API, one serverless function in `api/` |

`server/` is the original self-hosted version. It is excluded from the
deployment by `.vercelignore` and kept only for anyone who wants to run it on
their own machine — it cannot run on Vercel (it writes to disk at start-up,
uses `better-sqlite3`, and calls `app.listen()`).

## 1. Add a database

The API needs Postgres. Any provider works; the Vercel Marketplace (Neon) is
the least work:

**Vercel dashboard → Storage → Create → Neon/Postgres → Connect to project.**

That sets `POSTGRES_URL` for you. If you bring your own database (Supabase,
RDS, a VPS…), add `POSTGRES_URL` yourself under
**Settings → Environment Variables**, e.g.

```
POSTGRES_URL = postgres://user:password@host:5432/dbname?sslmode=require
```

The tables (`mm_user`, `mm_snapshot`, `mm_sync_log`) are created automatically
on the first request. There is no migration step.

## 2. Add your Google client ID

Sign-in is how the server issues you an API token — the `npm run register` CLI
of the self-hosted version cannot run on Vercel.

Follow `server/GOOGLE-SETUP.md` to create an OAuth client, then add your
Vercel URL to the client's **Authorised JavaScript origins**:

```
https://your-project.vercel.app
```

Then set the environment variable:

```
GOOGLE_CLIENT_ID = 1234....apps.googleusercontent.com
```

## 3. Lock it down

The site is on the public internet, so decide who may hold an account:

```
ALLOWED_EMAILS = you@gmail.com
```

**If you leave `ALLOWED_EMAILS` unset, the first Google account to sign in
claims the deployment and everyone afterwards is refused.** That is a safe
default for one person, but setting your address explicitly is better — it
still works if you ever clear the database. (The self-hosted server allowed
anyone to sign up, which is fine on a home network and not fine on a public
URL, so the default here fails closed.)

## 4. Connect the app

Open your Vercel URL, then **Settings → Cloud backup & sync**:

1. Paste your Google client ID into **Google client ID**.
2. Set **Backup to** → **My server**. The **Server URL** already points at this
   site, so leave it alone.
3. Click **Sign in with Google**. The server checks the sign-in with Google,
   confirms it was issued to your OAuth client, and stores an API token in the
   app. You should see *"Server recognised your Google account"*.
4. **Push backup now**, then **Refresh snapshots**.

## Optional environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_EMAILS` | *(first-sign-in claims it)* | comma-separated allowlist |
| `KEEP_SNAPSHOTS` | `40` | how many snapshots to keep per account |
| `CORS_ORIGIN` | `*` | restrict which origins may call the API |
| `PGSSL_NO_VERIFY` | *(unset)* | set to `1` only if your provider's TLS certificate is not trusted by Node |

## Checking it works

```
curl https://your-project.vercel.app/api/v1/health
```

```json
{
  "ok": true,
  "database": "connected",
  "googleSignIn": true,
  "accessPolicy": "allowlist",
  "keepSnapshots": 40
}
```

`ok: false` with `database: "unavailable"` means `POSTGRES_URL` is missing or
wrong. `googleSignIn: false` means `GOOGLE_CLIENT_ID` is not set.

## Size limits — the one real constraint

A serverless request body is capped at about 4.5 MB. A text-only database of
10,000 transactions is already ~4.5 MB of JSON, so **the app gzips every push**
(roughly 20x, taking that same database to ~0.25 MB). Plenty of headroom for
text.

Receipt images are the exception: they are stored inside the backup as data
URLs and barely compress. A database with a few dozen attached photos will
exceed the limit, and the app will tell you so rather than failing obscurely.
**Back up to Google Drive instead in that case** — Drive uploads go straight
from your browser to Google, so no size limit applies.

## What is and is not sent

Pushed: accounts, transactions, categories, budgets, recurring entries, bills,
loans, cards, goals, rules and settings.

Never pushed: your PIN (not even its hash) and this device's API token — both
are stripped before anything leaves the browser.

## Endpoints

All under `/api/v1`, same shapes as the self-hosted server:

```
GET    /health              no auth; liveness and configuration
POST   /auth/google         {accessToken} -> {token, email}
GET    /me                  account and counts
POST   /backup              {label, device, payload} -> stores a snapshot
GET    /backup/latest       newest snapshot with its payload
GET    /backup/:id          one snapshot with its payload
GET    /snapshots           snapshot list, no payloads
DELETE /snapshots/:id       remove one snapshot
GET    /transactions        ?from&to&limit&offset
GET    /balances            per-account balances and net worth
GET    /sync-log            recent push/pull activity
```

Send a gzipped body with `X-MM-Encoding: gzip` and
`Content-Type: application/octet-stream`; plain JSON is accepted too.

`/transactions` and `/balances` are answered from the newest snapshot's JSON.
The self-hosted server mirrored each backup into relational tables to serve
them; keeping a second copy in step is a lot of moving parts for a read side
nothing depends on, so there is one source of truth here instead.
