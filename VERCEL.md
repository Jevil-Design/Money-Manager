# Running Money Manager on Vercel

One project serves two things:

| Path | What it is |
|---|---|
| `/` | the app — a static page, rewritten to `Money Manager.dc.html` |
| `/api/v1/*` | the API and the database, one serverless function in `api/` |

**Your data lives in the cloud database, not in the browser.** Sign in with the
same email and password on any computer or phone and the same books open. The
browser keeps only a session token; nothing financial is stored locally.

The trade-offs that come with that, stated plainly:

- **No offline use.** Without a connection the app cannot load or save.
- **The database is the only copy.** If the deployment or the database goes
  away, so do the books. Download a backup now and then (Settings → Backup).
- **There is no password reset.** Nothing but you knows your password. A backup
  file is the way back in.

`server/` is the original self-hosted version, excluded from the deployment by
`.vercelignore`. It cannot run on Vercel (it writes to disk at start-up, uses
`better-sqlite3`, and calls `app.listen()`).

## 1. Add a database

**Vercel dashboard → Storage → Create → Neon/Postgres → Connect to project.**
That sets `POSTGRES_URL` for you.

Bringing your own (Supabase, RDS, a VPS) works too — add `POSTGRES_URL` under
**Settings → Environment Variables**:

```
POSTGRES_URL = postgres://user:password@host:5432/dbname?sslmode=require
```

**It must be UTF8.** A database created with a Windows/Latin-1 encoding cannot
store the ₹ sign and every save will fail. Hosted Postgres is UTF8 already;
`/api/v1/health` reports the encoding so you can check.

Tables are created on the first request — `mm_user`, `mm_token`, `mm_state`,
`mm_snapshot`, `mm_sync_log`. There is no migration step.

## 2. Decide who may sign up

The site is on the public internet, so set this before you share the URL:

```
ALLOWED_EMAILS = you@gmail.com, partner@gmail.com
```

Everyone listed can create their own account, each with completely separate
books. **If you leave it unset, the first account to register claims the
deployment and everyone after is refused** — safe for one person, but setting
it explicitly is better because it survives clearing the database.

## 3. Optional: Google sign-in

Not required — email and password is the normal route. If you want the Google
button (and Drive backup), follow `server/GOOGLE-SETUP.md`, add your Vercel URL
to the OAuth client's **Authorised JavaScript origins**, and set:

```
GOOGLE_CLIENT_ID = 1234....apps.googleusercontent.com
```

## 4. Use it

Open your Vercel URL → **Create an account** → name, email, password. That is
the whole setup. On another device, open the same URL and **Sign in**.

## Optional environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_EMAILS` | *(first registration claims it)* | who may create an account |
| `GOOGLE_CLIENT_ID` | *(unset)* | enables the Google sign-in button |
| `KEEP_SNAPSHOTS` | `40` | snapshots kept per account |
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
  "encoding": "UTF8",
  "encodingOk": true,
  "accessPolicy": "allowlist",
  "keepSnapshots": 40
}
```

- `database: "unavailable"` → `POSTGRES_URL` is missing or wrong.
- `encodingOk: false` → the database is not UTF8; recreate it with UTF8.

## Two devices at once

Each save carries the revision it was based on. If the account changed
elsewhere in the meantime the server refuses the write and the app asks
whether to take the other version or replace it — the version being replaced
is kept as a snapshot either way. Nothing is silently overwritten.

A snapshot is also written automatically every few hours as you work, and
before any restore or import, which is your version history given there is no
local copy.

## Sessions

A session lasts 30 days and renews while you use it. Changing your password
signs out every other device. **Settings → Account → Sign out of every
device** does the same on demand, which is what to use if a phone is lost.

## Size limits

A serverless request body is capped at about 4.5 MB, and 10,000 plain
transactions is already ~4.5 MB of JSON — so **every save is gzipped**
(roughly 20x). Plenty of headroom for text.

Receipt images are the exception: they are stored inside the document as data
URLs and barely compress. A few dozen photos will exceed the limit and the app
will say so. Keep attachments modest, or use Google Drive backup, whose
uploads go straight from the browser to Google.

## Coming from the older local-only version

If you used this app before it moved to the cloud, your data is still in the
browser. Sign in, then **Settings → Account → Import data left by the older
version…**. It copies the old database into your cloud account (keeping a
snapshot of whatever was there first).

If the old data was in an *encrypted* local account, that import cannot read
it — open the previous version, sign in, download a backup file, and restore
that file instead.

## Endpoints

All under `/api/v1`:

```
GET    /health              no auth; liveness, encoding, configuration
POST   /auth/register       {name,email,password} -> {token,user}
POST   /auth/login          {email,password} -> {token,user}
GET    /auth/session        who am I, and the current revision
POST   /auth/logout         end this session
POST   /auth/logout-all     end every session
POST   /auth/password       {current,next}
DELETE /auth/account        {password} — deletes everything
POST   /auth/google         {accessToken} -> {token,user}
GET    /state               the live document + revision
PUT    /state               {rev,data} -> {rev}, or 409 on a stale revision
POST   /backup              store a snapshot
GET    /backup/latest       newest snapshot
GET    /backup/:id          one snapshot
GET    /snapshots           snapshot list, no payloads
DELETE /snapshots/:id       remove one snapshot
GET    /transactions        ?from&to&limit&offset
GET    /balances            per-account balances and net worth
GET    /sync-log            recent push/pull activity
```

Send a gzipped body with `X-MM-Encoding: gzip` and
`Content-Type: application/octet-stream`; plain JSON is accepted too.

Passwords are stored as PBKDF2-SHA256 (210,000 iterations) over a per-account
random salt. Session tokens are stored only as digests. Wrong passwords are
throttled with a growing pause. `/transactions` and `/balances` are answered
from the live document rather than a mirrored relational copy.
