# Running Money Manager on Vercel

One project serves two things:

| Path | What it is |
|---|---|
| `/` | the app — a static page, rewritten to `Money Manager.dc.html` |
| `/api/*` | the API and the database, one serverless function: `api/index.js` |

`vercel.json` rewrites every `/api/...` path to that one function, carrying the
path along as `mmpath`. That rewrite is load-bearing — without it only
single-segment paths like `/api/health` arrive and everything under
`/api/v1/...` returns Vercel's own 404.

**Your data lives in the cloud database, not in the browser.** Sign in with the
same email and password on any computer or phone and the same books open. The
browser keeps only a session token; nothing financial is stored locally.

The trade-offs that come with that, stated plainly:

- **No offline use.** Without a connection the app cannot load or save. It says
  so rather than pretending a save succeeded — an unsaved edit stays on screen,
  the save indicator reads "Not saved", and it keeps retrying.
- **The database is the only copy.** If the deployment or the database goes
  away, so do the books. Download a backup now and then (Settings → Backup).
- **There is no password reset.** Nothing but you knows your password. A backup
  file is the way back in.

`server/` is the original self-hosted version, excluded from the deployment by
`.vercelignore`. It cannot run on Vercel (it writes to disk at start-up, uses
`better-sqlite3`, and calls `app.listen()`) and it is not the code path this
deployment uses.

## 1. Add a database

**Vercel dashboard → Storage → Create → Neon/Postgres → Connect to project.**
That sets `DATABASE_URL` and `POSTGRES_URL` for you.

Bringing your own (Supabase, RDS, a VPS) works too — add `DATABASE_URL` under
**Settings → Environment Variables**:

```
DATABASE_URL = postgres://user:password@host:5432/dbname?sslmode=require
```

Whichever name your provider sets is fine. Any of these is read, in this
order: `DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`,
`DATABASE_URL_UNPOOLED`, `POSTGRES_PRISMA_URL`, `NEON_DATABASE_URL`,
`PG_CONNECTION_STRING`.

> **Environment variables only reach the running app on the next deployment.**
> After attaching a database or adding a variable, **redeploy** — otherwise the
> app still reports that the database is unavailable. This is the single most
> common cause of that message.

**It must be UTF8.** A database created with a Windows/Latin-1 encoding cannot
store the ₹ sign and every save will fail. Hosted Postgres is UTF8 already;
`/api/health` reports the encoding so you can check.

Tables, indexes and constraints are created on the first request, inside one
transaction, and every statement is `IF NOT EXISTS` — so it is safe to run
concurrently from several containers, safe to re-run, and it never drops or
rewrites anything. `mm_meta.schema_version` records what has been applied, and
`/api/health` reports it. There is no separate migration step.

## 2. Decide who may sign up

The site is on the public internet, so set this before you share the URL:

```
ALLOWED_EMAILS = you@gmail.com, partner@gmail.com
```

Everyone listed can create their own account, each with completely separate
books. **If you leave it unset, the first account to register claims the
deployment and everyone after is refused** — safe for one person, but setting
it explicitly is better, because it survives clearing the database.

## 3. Optional: a session secret

```
AUTH_SECRET = <32 random bytes, base64url>
```

Generate one with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Session tokens are 256 bits of randomness and only their digest is stored, so a
database dump already cannot be replayed as a login. `AUTH_SECRET` keys an HMAC
over them, so the stored digest is worthless without a value that lives in the
environment rather than the database.

It is genuinely optional and safe to add later. **Passwords do not depend on
it** — the only consequence of adding, changing or losing it is that existing
sessions stop matching and people sign in again.

## 4. Optional: Google sign-in

Not required — email and password is the normal route. If you want the Google
button (and Drive backup), follow `server/GOOGLE-SETUP.md`, add your Vercel URL
to the OAuth client's **Authorised JavaScript origins**, and set:

```
GOOGLE_CLIENT_ID = 1234....apps.googleusercontent.com
```

## 5. Use it

Open your Vercel URL → **Create an account** → name, email, password. That is
the whole setup. On another device, open the same URL and **Sign in**.

## Environment variables

`.env.example` is the annotated template. Copy it to `.env.local` for local
work; never commit a file with real values (`.gitignore` excludes them).

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string (aliases above) |
| `ALLOWED_EMAILS` | no | who may create an account; unset = first registration claims it |
| `AUTH_SECRET` | no | keys the HMAC over session tokens |
| `GOOGLE_CLIENT_ID` | no | enables the Google sign-in button |
| `KEEP_SNAPSHOTS` | no | snapshots kept per account (default 40) |
| `CORS_ORIGIN` | no | restrict which origins may call the API (default `*`) |
| `PGSSL_NO_VERIFY` | no | set to `1` only if your provider's TLS certificate is not trusted by Node |
| `MM_DIAGNOSTICS` | no | `1` adds a sanitised technical reason to errors and `/api/health`; **ignored in production** |

Every one of these is read on the server only. None is sent to a browser,
embedded in the HTML, or referenced by client-side JavaScript.

## When the database is unavailable

The app shows one sentence:

> **Cloud database is currently unavailable.**
> Nothing has been saved or lost. This deployment needs a database attached
> before accounts can be created — the site administrator can do that from the
> hosting dashboard.

with **Retry** and **Administrator info**. It deliberately does **not** print
variable names, hostnames, connection strings, driver messages or stack
traces — a person trying to sign up cannot act on those, and they should not be
on a public page. The reply carries a machine-readable `code` so the app can
tell an outage from a rejected password without matching on wording:

| `code` | Meaning |
|---|---|
| `no_database` | no connection-string variable is set at all |
| `db_misconfigured` | one is set but is not a usable Postgres URL |
| `db_unreachable` | the database refused the connection or timed out |
| `db_driver_missing` | `pg` is not installed in the deployment |
| `db_encoding` | the database is not UTF8 and cannot store `₹` |

The actionable detail goes to the **function log** (Vercel dashboard →
Deployment → Functions → Logs), which is where it belongs.

## Checking it works

```
curl https://your-project.vercel.app/api/health
```

```json
{
  "status": "ok",
  "database": "connected",
  "schemaVersion": "3",
  "schemaExpected": "3",
  "accounts": 2,
  "databaseUrlVarsSet": ["DATABASE_URL", "POSTGRES_URL"],
  "encoding": "UTF8",
  "encodingOk": true,
  "authSecretSet": true,
  "accessPolicy": "allowlist",
  "keepSnapshots": 40
}
```

`/api/v1/health` is the same endpoint. It is answered without touching the
database first, so it stays useful when the database is the thing that is
broken.

Reading the result:

- `database: "unavailable"` with an **empty** `databaseUrlVarsSet` → no
  database variable is set at all, **or you have not redeployed since setting
  it**. Redeploy first; that is usually the whole problem.
- `database: "unavailable"` but `databaseUrlVarsSet` is **non-empty** → the
  variable is there but the database refused it. `databaseCode` says which kind
  of failure; the reason is in the function log.
- `schemaVersion` missing or behind `schemaExpected` → the connection works but
  initialisation has not completed. The next request retries it.
- `encodingOk: false` → the database is not UTF8; recreate it with UTF8.

This endpoint is unauthenticated, so it reports variable **names** only, never
their values, and no host, port, database name, user or driver text. A name is
not a secret and it is the one fact that answers "did my variable land?".

## Tests

```
npm install
npm test
```

`test/logic.test.js` needs nothing: it runs the app's logic block and the API
module in Node and checks the sign-up form's every state, the password rules
and hashing, document validation, the schema's idempotence, that no error text
leaks a credential, and that the sample data obeys the accounting rules
(income raises, expense lowers, a transfer is neither, a card purchase grows
the outstanding, a card payment shrinks it without a second expense).

`test/pool.test.js` and `test/cookie.test.js` stub the Postgres driver, so they
need no database either. The first covers connection reuse and every way a
pooled connection can die on a serverless runtime; the second pins the session
cookie's attributes and proves it genuinely authenticates rather than being set
and ignored.

`test/api.test.js` serves `api/index.js` over real HTTP through the same
rewrite Vercel applies. Without a database it exercises every
database-unavailable path and asserts that nothing sensitive reaches the
browser. Point it at a **scratch** database to run the full flow — it creates
and then deletes its own accounts:

```
MM_TEST_DATABASE_URL=postgres://... npm run test:api
```

`test/verify-deployment.js` checks a **live** deployment and tells you, in
plain terms, which step is still missing:

```
npm run verify https://your-project.vercel.app
npm run verify https://your-project.vercel.app -- --full
```

Read-only by default. `--full` additionally creates two throwaway accounts,
writes and re-reads a transaction, confirms a second session sees it and a
second user does not, then deletes both accounts.

## Security notes

- **Passwords** are stored as **scrypt** (N=32768, r=8, p=1) over a per-account
  random salt — memory-hard, and in Node's own crypto, so no native addon can
  break the build. Accounts created by earlier builds are PBKDF2-SHA256 at
  210,000 iterations; those still verify and are re-hashed to scrypt on the
  next successful sign-in, so nobody is locked out and the old algorithm drains
  away. `pw_algo` on each row says which is in use.
- **Session tokens** are 256-bit random, stored only as a digest (HMAC-keyed
  when `AUTH_SECRET` is set), expire after 30 days, and slide forward while in
  use.
- **The session is also issued as a cookie** — `HttpOnly` (script on the page
  cannot read it, so an XSS bug cannot walk off with a 30-day session),
  `Secure` (never sent over plain http; relaxed only for localhost, where
  there is no https to use), `SameSite=Lax` (the browser will not attach it to
  a cross-site POST/PUT/DELETE, which is what prevents another site acting as
  the signed-in user), `Path=/`, and `Max-Age` matching the server-side
  expiry. It is cleared on sign-out, on "sign out everywhere", and on account
  deletion. The token is still returned in the JSON body too, because that is
  what the app sends today and what a different-origin deployment needs — an
  `Authorization` header takes precedence over the cookie.

## How the database connection is handled

One `pg.Pool` at module scope, reused by every request that lands on the same
warm container. Connecting costs a TCP round trip plus a TLS handshake plus
authentication, so paying it per request is both slow and a good way to exhaust
a provider's connection limit.

- `max: 1` — a serverless container serves one request at a time, so one
  connection per container is all that can ever be in use. More would multiply
  idle connections across containers and hit the provider's ceiling sooner.
- `idleTimeoutMillis: 30000` — long enough to be reused across a burst, short
  enough that an abandoned container lets its connection go.
- `allowExitOnIdle` — the runtime can freeze or exit without an open handle
  holding it up.
- An `error` listener is attached. A pool without one turns a dropped idle
  socket into an unhandled exception, which on Vercel is an opaque crashed
  invocation with no message.

The awkward part of serverless, which `max: 1` does not solve on its own: the
container is **frozen** between requests, and while it is frozen the database
(or a PgBouncer in front of it, or a NAT idle timer) can drop the socket.
node-postgres hands back an idle client without checking it, so the first query
on a resumed container can fail on a connection that looks fine. So:

- a checked-out client is validated with `SELECT 1`, and a dead one is
  destroyed and replaced — up to three attempts, which also covers a
  serverless database that was asleep and needs a moment;
- any query failing at the connection level marks that client dead even if the
  caller catches the error and carries on, because `/health` deliberately
  swallows a failed encoding lookup and other writes use `.catch(() => {})`.
  Without that, a socket that died mid-request would be returned to the pool
  and handed to the *next* request, which would fail for no visible reason;
- a query error (bad SQL, a constraint) is **not** treated as a broken
  connection, or the pool would churn on every ordinary failure;
- if the connection string changes under a warm container — a redeploy onto a
  different database, or a rotated password — the old pool is shut down and a
  new one built.

`test/pool.test.js` stubs the driver and asserts every one of these.
- **Every query is parameterised.** No user input is ever concatenated into
  SQL.
- **Every financial row is scoped to the authenticated user**, whose identity
  comes from the session token and from nowhere else — never from a body field,
  a query parameter or a header the caller controls. A `user_id` in a request
  body is ignored.
- **Account creation is one transaction**: the user row, the starting document
  (settings, default categories, categorisation rules, and sample data if
  asked for) and the first session either all exist or none of them do.
- **Wrong passwords** are throttled with a growing pause, and a missing account
  answers identically to a wrong password, in the same time.
- **Errors** carry a safe sentence and a code. SQL, stack traces, connection
  strings and environment values go to the server log only.

## Two devices at once

Each save carries the revision it was based on. If the account changed
elsewhere in the meantime the server refuses the write and the app asks
whether to take the other version or replace it — the version being replaced
is kept as a snapshot either way. Nothing is silently overwritten.

A snapshot is also written automatically every few hours as you work, and
before any restore, import or local-data upload, which is your version history
given there is no local copy.

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

If you used this app before it moved to the cloud, your data is still in this
browser. The first time you sign in, the app looks for it and offers:

- **Upload to my account** — takes a snapshot of the account first, then copies
  the old data up. The copy in the browser is left exactly where it is.
- **Keep local data** — changes nothing and stops asking.
- **Skip for now** — changes nothing and asks again next time.

Nothing is ever deleted from the browser, and if the upload cannot be saved the
local copy is untouched and it can be retried. **Settings → Account → Import
data left by the older version…** does the same thing on demand.

If the old data was in an *encrypted* local account, it cannot be read here —
open the previous version, sign in, download a backup file, and restore that
file instead.

## Endpoints

`/api/health` needs no auth. Everything else is under `/api/v1` and requires a
session token (`Authorization: Bearer …`):

```
GET    /api/health           liveness, encoding, schema version, configuration
POST   /auth/register        {name,email,password,password2,samples} -> {token,user,state}
POST   /auth/login           {email,password} -> {token,user}
GET    /auth/session         who am I, and the current revision
POST   /auth/logout          end this session
POST   /auth/logout-all      end every session
POST   /auth/password        {current,next}
DELETE /auth/account         {password} — deletes everything
POST   /auth/google          {accessToken} -> {token,user}
GET    /state                the live document + revision
PUT    /state                {rev,data} -> {rev}, or 409 on a stale revision
POST   /backup               store a snapshot
GET    /backup/latest        newest snapshot
GET    /backup/:id           one snapshot
GET    /snapshots            snapshot list, no payloads
DELETE /snapshots/:id        remove one snapshot
GET    /transactions         ?from&to&limit&offset
GET    /balances             per-account balances and net worth
GET    /sync-log             recent push/pull activity
```

Send a gzipped body with `X-MM-Encoding: gzip` and
`Content-Type: application/octet-stream`; plain JSON is accepted too.

`/transactions` and `/balances` are answered from the live document rather than
a mirrored relational copy.

## How the data is stored

Each account's whole book is one row in `mm_state` — a `JSONB` document with
its revision — rather than seventeen relational tables. The tables are:

| Table | Holds |
|---|---|
| `mm_user` | one row per account: email, name, password hash, lockout counters |
| `mm_token` | one row per live session, keyed by digest |
| `mm_state` | one row per account: the live book, as `JSONB`, plus its revision |
| `mm_snapshot` | version history and backups, one row per snapshot |
| `mm_sync_log` | recent push/pull activity |
| `mm_meta` | the applied schema version |

Everything except `mm_user` is keyed by `user_id REFERENCES mm_user(id) ON
DELETE CASCADE`, which is what makes per-user isolation structural: there is no
query in the API that can reach a row belonging to another account, and
deleting an account removes every trace of it.

Accounts, transactions, categories, budgets, bills, cards, loans, goals, rules
and settings are collections inside that document. The app loads it once, works
on it in memory, and writes it back — which is why filtering 10,000
transactions is instant and needs no round trip. Indexes on
`lower(mm_user.email)`, `mm_token(user_id)`, `mm_token(expires_at)`,
`mm_snapshot(user_id, created_at DESC)`, `mm_sync_log(user_id, id DESC)` and
GIN indexes on `mm_state(data->'accounts')` and `mm_state(data->'txns')` cover
every access path the API actually has.

If you need per-transaction SQL — a warehouse, an external report, a join
against something else — that is the reason to split the document into
relational tables, and it is a much larger change than it looks: the app's
accounting rules, migrations, undo journal, reconciliation and import all
assume one document. See the note at the top of `api/index.js`.
