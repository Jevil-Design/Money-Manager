/* Money Manager — backup / restore / sync API, as a Vercel serverless function.
 *
 * This is the Vercel port of server/server.js.  The self-hosted version cannot
 * run here: it writes to disk at import, uses better-sqlite3 (a native addon
 * with a local database file) and calls app.listen(). Serverless functions get
 * a read-only filesystem, no persistent disk and must export a handler, so the
 * storage layer is Postgres and the whole API is this one file.
 *
 * How the data is stored
 * ----------------------
 * Each account's whole book is ONE JSONB document in mm_state, with a
 * revision, rather than seventeen relational tables.  Accounts, transactions,
 * categories, budgets, bills, cards, loans, goals, rules and settings are
 * collections inside it.  The app loads the document once, works on it in
 * memory and writes it back, which is why filtering ten thousand transactions
 * is instant and costs no round trip.
 *
 * Per-user isolation is structural rather than a convention: every table
 * except mm_user is keyed by
 *     user_id TEXT NOT NULL REFERENCES mm_user(id) ON DELETE CASCADE
 * and every query in this file filters on the user id taken from the session
 * token.  There is no query here that can reach another account's row, and
 * deleting an account removes every trace of it.
 *
 * The cost of this shape is that there is no per-transaction SQL: you cannot
 * join a warehouse against a transactions table, because there isn't one.
 * That is the reason to split the document into relational tables — and it is
 * a much larger change than it looks, because the app's accounting rules,
 * schema migrations, undo journal, reconciliation and statement import all
 * assume a single document. Splitting it is a rewrite of the storage layer on
 * both sides, not a migration.
 *
 * Routes (/health needs no auth; everything else needs a session token):
 *   GET    /health              liveness, encoding, schema version, config
 *   POST   /auth/register       {name,email,password} -> {token,user}
 *   POST   /auth/login          {email,password} -> {token,user}
 *   POST   /auth/forgot         {email} — emails a code and a link
 *   POST   /auth/reset          {token|email+code, password} — sets a new one
 *   GET    /auth/session        the signed-in user and the current revision
 *   POST   /auth/logout         end this session
 *   POST   /auth/logout-all     end every session for the account
 *   POST   /auth/password       {current,next} — also ends other sessions
 *   DELETE /auth/account        {password} — removes the account and its data
 *   POST   /auth/google         exchange a Google access token for a session
 *   GET    /state               the live document + revision
 *   PUT    /state               {rev,data} -> {rev}, 409 if rev is stale
 *   POST   /backup              store a snapshot
 *   GET    /backup/latest       newest snapshot
 *   GET    /backup/:id          one snapshot
 *   GET    /snapshots           snapshot list (no payloads)
 *   DELETE /snapshots/:id       remove one snapshot
 *   GET    /transactions        read side, from the live document
 *   GET    /balances            read side, from the live document
 *   GET    /sync-log            recent push/pull activity
 *
 * The database is the only home for a user's books: the browser keeps just a
 * session token.  PUT /state carries the revision it was based on so two
 * devices cannot silently overwrite each other.
 *
 * Reached as /api/health and /api/v1/health alike: vercel.json rewrites every
 * /api/... path to this one function with the rest of the path in mmpath, and
 * routeSegments() drops a leading 'api', 'index' or version segment.
 *
 * Environment (server-side only — none of this is ever sent to a browser):
 *   DATABASE_URL        required — any Postgres (Vercel/Neon, Supabase, RDS…).
 *                       POSTGRES_URL and the other names in DB_URL_VARS are
 *                       accepted too, since each provider sets its own.
 *   AUTH_SECRET         optional — extra pepper mixed into password hashing.
 *                       Set it once and keep it: changing it invalidates every
 *                       existing password, so it is recorded per account row
 *                       and old accounts keep verifying without it.
 *   GOOGLE_CLIENT_ID    optional — enables the Google sign-in button
 *   ALLOWED_EMAILS      optional — who may register. Unset: the first account
 *                       to register claims the deployment and later ones are refused.
 *   KEEP_SNAPSHOTS      optional — how many snapshots to retain (default 40)
 *   CORS_ORIGIN         optional — defaults to * (every route is token-checked)
 *   PGSSL_NO_VERIFY     optional — set to 1 only if your provider uses a
 *                       certificate Node does not trust
 *   MM_DIAGNOSTICS      optional — 1 to include a sanitised technical detail
 *                       alongside the safe error message. Never in production.
 *
 * Error policy: every failure leaves this file as {error, code} where the error field
 * is a sentence safe to render in a browser. Connection strings, SQL text,
 * stack traces and environment values go to the server log only.
 */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

/* The Postgres driver is loaded on first use, not at import.  Anything that
   throws while the module is being imported becomes an opaque
   FUNCTION_INVOCATION_FAILED page with no usable message, so the one dependency
   that could be missing is resolved lazily and reported as readable JSON. */
let pgPoolClass = null;
function getPoolClass() {
  if (pgPoolClass) return pgPoolClass;
  try {
    pgPoolClass = require('pg').Pool;
  } catch (err) {
    /* The user gets the same sentence as any other database outage; the
       actionable version goes to the function log. */
    console.error('money-manager db: the "pg" package is not installed in this deployment. ' +
      'Check that package.json at the repository root lists it and that the build installed dependencies.');
    throw appError(503, 'db_driver_missing', DB_UNAVAILABLE_MESSAGE,
      'The "pg" package is not installed in this deployment.');
  }
  return pgPoolClass;
}

const KEEP_SNAPSHOTS = Math.max(1, parseInt(process.env.KEEP_SNAPSHOTS || '40', 10));
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const IS_PROD = String(process.env.VERCEL_ENV || process.env.NODE_ENV || '').toLowerCase() === 'production';
const DIAGNOSTICS = process.env.MM_DIAGNOSTICS === '1';

/* One error type for everything a browser is allowed to see.
     message — a whole sentence, safe to render as-is
     code    — machine-readable, so the app can offer Retry rather than parse prose
     detail  — for the server log and nothing else
   Anything thrown without this shape is reported as a generic 500. */
function appError(status, code, message, detail) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.safe = true;
  if (detail) e.detail = String(detail);
  return e;
}

/* A connection string, a SQL fragment or a password must never reach a log
   line that might be shipped somewhere, let alone a response.  Strip the
   userinfo out of anything that looks like a URL before printing it. */
function scrub(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/(postgres(?:ql)?:\/\/)[^\s@/]*@/gi, '$1***:***@');
  s = s.replace(/\b(password|pgpassword|pwd)\s*=\s*\S+/gi, '$1=***');
  return s;
}

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomBytes(9).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');

/* ------------------------------------------------------------------ storage */

/* Every name a Postgres provider is known to set on Vercel.  Attaching a
   database and still being told none is configured is a miserable dead end,
   so accept whichever name the provider chose: the Vercel/Neon marketplace
   integration sets DATABASE_URL and POSTGRES_URL, Supabase sets POSTGRES_URL,
   and the unpooled variants are what a serverless function actually wants.
   Order matters only in that a direct connection is preferred over a pooled
   one; any of them will work. */
const DB_URL_VARS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_PRISMA_URL',
  'NEON_DATABASE_URL',
  'PG_CONNECTION_STRING'
];

function connectionString() {
  for (let i = 0; i < DB_URL_VARS.length; i++) {
    const v = process.env[DB_URL_VARS[i]];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

/* Which of those names are actually set — NAMES ONLY.  A connection string
   contains the database password, so the value never leaves the server. */
function dbVarsPresent() {
  return DB_URL_VARS.filter((n) => process.env[n] && String(process.env[n]).trim());
}

/* The sentence an end user is allowed to read.  It says what is true — the
   cloud database cannot be reached — and nothing about how it is configured.
   Requirement: no variable names, no credentials, no connection details. */
const DB_UNAVAILABLE_MESSAGE =
  'Cloud database is currently unavailable. Please check the server configuration.';

/* The sentence for whoever deploys this: the server log and /health only. */
function noDatabaseDetail() {
  return 'No database is configured. Add a Postgres database to this Vercel ' +
    'project (Storage → Create → Postgres → Connect), or set DATABASE_URL ' +
    'yourself under Settings → Environment Variables, then redeploy. ' +
    'Accepted variable names: ' + DB_URL_VARS.join(', ') + '.';
}

/* Is the configured value actually a Postgres URL?  A half-pasted string, or
   the literal placeholder from a tutorial, otherwise fails much later with a
   driver message nobody can act on.
   The returned text is written to the server log and may, with diagnostics
   turned on, reach /health — which is unauthenticated — so it names the
   problem without naming the host, the port, the database or the user. */
function configProblem(url) {
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return 'The configured connection string does not start with postgres:// or postgresql://.';
  }
  let parsed;
  try { parsed = new URL(url); }
  catch (e) { return 'The configured connection string is not a valid URL.'; }
  if (!parsed.hostname) return 'The configured connection string has no host.';
  if (/^(your-host|your_host|host|hostname|example\.com|example\.org|changeme|placeholder)$/i.test(parsed.hostname)) {
    return 'The configured connection string still holds a placeholder host.';
  }
  return '';
}

/* Three distinct situations, three distinct codes, one wording for the user:
     no_database      nothing is configured at all
     db_misconfigured the value present is not a usable Postgres URL
     db_unreachable   the database refused the connection or timed out */
/* Connection reuse on a serverless runtime.
 *
 * The pool lives at module scope, so it outlives a single invocation and is
 * reused by every later request that lands on the same warm container — which
 * is the whole point: connecting to Postgres costs a TCP round trip plus a TLS
 * handshake plus authentication, and paying that on every request is both slow
 * and a good way to exhaust a provider's connection limit.
 *
 *   max: 1        A serverless container serves one request at a time, so one
 *                 connection per container is all that can ever be in use.
 *                 More would just multiply idle connections across containers
 *                 and hit the provider's ceiling sooner.
 *   idleTimeout   Long enough to be reused across a burst of requests, short
 *                 enough that an abandoned container lets its connection go.
 *   allowExitOnIdle  Lets the runtime freeze or exit without an open handle
 *                 holding it up.
 *
 * The awkward part of serverless, which max:1 does not solve on its own: the
 * container is FROZEN between requests, and while it is frozen the database
 * (or a PgBouncer in front of it, or a NAT idle timer) can drop the socket.
 * node-postgres hands back an idle client without checking it, so the first
 * query on a resumed container can fail on a connection that looks fine.
 * acquire() therefore validates a client with a cheap SELECT 1 and discards
 * a dead one, which is what makes reuse safe rather than merely faster.
 */
let pool = null;
let poolUrl = '';

function getPool(url) {
  if (pool && poolUrl === url) return pool;
  /* The connection string changed under us — a redeploy with a new database,
     or a rotated password. Drop the old pool rather than keep using it. */
  if (pool) {
    const stale = pool;
    pool = null;
    poolUrl = '';
    stale.end().catch(() => { /* nothing useful to do about a stale pool */ });
  }
  const Pool = getPoolClass();
  pool = new Pool({
    /* sslmode is removed from the URL deliberately — see sslConfigFor. */
    connectionString: withoutSslMode(url),
    ssl: sslConfigFor(url),
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 12000,
    query_timeout: 20000,
    allowExitOnIdle: true,
    application_name: 'money-manager'
  });
  poolUrl = url;
  /* A pool with no 'error' listener turns a dropped idle socket into an
     unhandled exception, which on Vercel is an opaque crashed invocation.
     The pool has already discarded the client by the time this fires; there
     is nothing to do but record it. */
  pool.on('error', (err) => {
    console.error('money-manager db: idle connection dropped — ' + scrub(err && err.message));
  });
  return pool;
}

/* TLS, decided here rather than by the connection string.
 *
 * node-postgres DISCARDS an explicit `ssl` option when the connection string
 * carries `sslmode` — with `?sslmode=require` (which is what Neon, Supabase
 * and most providers hand you) the computed config comes out as `{}`, and
 * whatever we passed is thrown away. Two consequences, one of them a silent
 * security downgrade:
 *
 *   - PGSSL_NO_VERIFY would do nothing at all, so the one documented escape
 *     hatch for a provider whose certificate Node does not trust would appear
 *     to be ignored, with no message saying why.
 *   - `{}` happens to verify today, because that is Node's default. But
 *     pg-connection-string v3 / pg v9 change `sslmode=require` to libpq
 *     semantics — encrypt without verifying — and an explicit
 *     rejectUnauthorized:true would still be discarded. The connection would
 *     quietly become open to interception on a driver upgrade.
 *
 * So the parameter is stripped from the URL and the decision made here, where
 * it is visible and testable. The provider's intent is still honoured: an
 * explicit `sslmode=disable` means no TLS, and `no-verify` means encrypt
 * without checking the certificate.
 */
function sslMode(url) {
  const m = String(url).match(/[?&]sslmode=([^&]*)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

function isLocalHost(url) {
  return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(String(url));
}

function sslConfigFor(url) {
  const mode = sslMode(url);
  /* Plain TCP, only where it was actually asked for or is unavoidable. */
  if (mode === 'disable') return false;
  if (!mode && isLocalHost(url)) return false;
  /* Encrypt but do not verify — the operator's escape hatch, and what the
     provider asked for if they said no-verify. */
  if (process.env.PGSSL_NO_VERIFY === '1' || mode === 'no-verify') {
    return { rejectUnauthorized: false };
  }
  /* Everything else: encrypt AND verify the certificate. */
  return { rejectUnauthorized: true };
}

/* Remove sslmode textually rather than by re-serialising the URL, so the
   password in the userinfo is never re-encoded — a round trip through
   URL.toString() can change it and break authentication. */
function withoutSslMode(url) {
  const q = String(url).indexOf('?');
  if (q < 0) return url;
  const base = url.slice(0, q);
  const kept = url.slice(q + 1).split('&').filter((p) => p && !/^sslmode=/i.test(p));
  return kept.length ? base + '?' + kept.join('&') : base;
}

/* Check the configured connection string before anything tries to use it, so
   a missing or malformed value is reported as such rather than as a timeout. */
function requireUrl() {
  const url = connectionString();
  if (!url) {
    console.error('money-manager db: ' + noDatabaseDetail());
    throw appError(503, 'no_database', DB_UNAVAILABLE_MESSAGE, noDatabaseDetail());
  }
  const bad = configProblem(url);
  if (bad) {
    console.error('money-manager db: ' + bad);
    throw appError(503, 'db_misconfigured', DB_UNAVAILABLE_MESSAGE, bad);
  }
  return url;
}

/* Take a working connection out of the pool, or fail with a safe error.
   Retries cover the two normal serverless cases: a client that went stale
   while the container was frozen, and a provider that was asleep and needs a
   moment to accept the first connection. */
async function acquire() {
  const url = requireUrl();
  const p = getPool(url);
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let client;
    try {
      client = await p.connect();
    } catch (err) {
      lastErr = err;
      continue;                       /* could not get one; try again */
    }
    try {
      await client.query('SELECT 1');
      return watchForBreakage(client);
    } catch (err) {
      lastErr = err;
      /* release(err) destroys the client instead of returning it to the
         pool, so the next attempt gets a genuinely new connection. */
      try { client.release(err); } catch (e) { /* already gone */ }
    }
  }

  const why = scrub(lastErr && lastErr.message);
  console.error('money-manager db: connection failed — ' + why);
  throw appError(503, 'db_unreachable', DB_UNAVAILABLE_MESSAGE, why);
}

/* Mark a client dead the moment any query on it fails at the connection
   level — even if the caller catches that error and carries on.
 *
 * This is not belt-and-braces. /health deliberately swallows a failed
 * encoding lookup because the connection is what it is really reporting on,
 * and other call sites use .catch(() => {}) on writes that do not matter.
 * Without this, a socket that died mid-request would be swallowed along with
 * the error, returned to the pool, and handed to the NEXT request, which
 * would fail for no visible reason. Wrapping query() means the verdict does
 * not depend on who happens to catch what.
 */
function watchForBreakage(client) {
  const rawQuery = client.query.bind(client);
  client.query = function () {
    let out;
    try {
      out = rawQuery.apply(null, arguments);
    } catch (err) {
      if (isConnectionError(err)) client.__mmBroken = true;
      throw err;
    }
    /* The callback form returns undefined; only a promise needs chaining. */
    if (out && typeof out.then === 'function') {
      return out.then(null, (err) => {
        if (isConnectionError(err)) client.__mmBroken = true;
        throw err;
      });
    }
    return out;
  };
  return client;
}

async function withDb(fn) {
  const client = await acquire();
  let broken = null;
  try {
    await ensureSchema(client);
    return await fn(client);
  } catch (err) {
    /* If the failure was the connection itself, this client must not go back
       into the pool for the next request to trip over. */
    if (isConnectionError(err)) broken = err;
    throw err;
  } finally {
    /* Back to the pool for the next invocation on this container — the
       connection is deliberately NOT closed.  Unless it broke, in which case
       release(err) destroys it and the pool opens a fresh one on demand. */
    const discard = broken ||
      (client.__mmBroken ? new Error('the connection was lost during this request') : undefined);
    try { client.release(discard); } catch (e) { /* already gone */ }
  }
}

/* Is this error the connection dying, rather than the query being wrong?
   Only these justify throwing the connection away. */
function isConnectionError(err) {
  if (!err) return false;
  if (/^(08|57P0)/.test(String(err.code || ''))) return true;   /* connection_exception, admin shutdown */
  return /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|Connection terminated|socket hang up|server closed the connection/i
    .test(String(err.message || ''));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_user (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mm_user_token_idx ON mm_user (token_hash);

CREATE TABLE IF NOT EXISTS mm_snapshot (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES mm_user(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT 'Backup',
  device      TEXT NOT NULL DEFAULT 'unknown',
  byte_size   BIGINT NOT NULL,
  txn_count   INTEGER NOT NULL,
  checksum    TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mm_snapshot_user_idx ON mm_snapshot (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mm_sync_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES mm_user(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT 'unknown',
  txn_count   INTEGER,
  byte_size   BIGINT,
  outcome     TEXT NOT NULL DEFAULT 'ok',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mm_sync_log_user_idx ON mm_sync_log (user_id, id DESC);

/* --- email + password sign-in, so an account works from any device --- */
ALTER TABLE mm_user ADD COLUMN IF NOT EXISTS salt        TEXT;
ALTER TABLE mm_user ADD COLUMN IF NOT EXISTS pw_hash     TEXT;
ALTER TABLE mm_user ADD COLUMN IF NOT EXISTS pw_iters    INTEGER;
ALTER TABLE mm_user ADD COLUMN IF NOT EXISTS pw_algo     TEXT;
ALTER TABLE mm_user ADD COLUMN IF NOT EXISTS fail_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mm_user ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

/* Session tokens.  Only the digest is stored, so a database dump cannot be
   replayed as a login. */
CREATE TABLE IF NOT EXISTS mm_token (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES mm_user(id) ON DELETE CASCADE,
  device      TEXT NOT NULL DEFAULT 'unknown',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS mm_token_user_idx ON mm_token (user_id);

/* The live document: one row per account, replaced on every save.  The rev column
   makes concurrent edits from two devices detectable instead of silent. */
CREATE TABLE IF NOT EXISTS mm_state (
  user_id     TEXT PRIMARY KEY REFERENCES mm_user(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,
  rev         BIGINT NOT NULL DEFAULT 1,
  device      TEXT NOT NULL DEFAULT 'unknown',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* --- constraints and indexes ------------------------------------------------
   Email is matched case-insensitively by the application (normEmail lowercases
   before every read and write), but a UNIQUE constraint on the raw column
   would still let 'A@x.com' and 'a@x.com' coexist if that ever slipped.  This
   makes the database itself refuse the second one. */
CREATE UNIQUE INDEX IF NOT EXISTS mm_user_email_lower_idx ON mm_user (lower(email));

/* Both the session lookup and the expiry sweep filter on expires_at. */
CREATE INDEX IF NOT EXISTS mm_token_expiry_idx ON mm_token (expires_at);

CREATE INDEX IF NOT EXISTS mm_state_updated_idx ON mm_state (updated_at DESC);

/* A user's whole book is one JSONB document, so the per-entity reads the app
   performs — transactions by date, by account, by category — happen in memory
   after a single primary-key fetch, and there is no transactions table to
   index.  These make the document itself searchable from SQL for reporting or
   support work without pulling every account's document across the wire. */
CREATE INDEX IF NOT EXISTS mm_state_accounts_idx ON mm_state USING GIN ((data -> 'accounts'));
CREATE INDEX IF NOT EXISTS mm_state_txns_idx ON mm_state USING GIN ((data -> 'txns'));

/* What initialisation has already run.  Nothing here drops or rewrites
   anything: the row is an audit trail, so /health can report which version a
   database is on and a future migration can tell whether it still needs to. */
CREATE TABLE IF NOT EXISTS mm_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* --- password reset ---------------------------------------------------------
   One row per reset request. Neither the link token nor the emailed code is
   stored: only their digests, so a database dump cannot be turned into a
   password reset.

   The code is only six digits — a million possibilities — so it is hashed
   with scrypt rather than SHA-256. Brute-forcing a stolen digest then costs
   about a day of compute for one code that expires in fifteen minutes, which
   makes it pointless. attempts caps online guessing at five.

   ON DELETE CASCADE, like every other table, so deleting an account takes its
   pending resets with it. */
CREATE TABLE IF NOT EXISTS mm_reset (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES mm_user(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  code_salt   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mm_reset_user_idx ON mm_reset (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mm_reset_expiry_idx ON mm_reset (expires_at);
`;

/* Bump when SCHEMA changes, so /health reports what a given database has had
   applied.  It is a record, not a gate: every statement in SCHEMA is
   CREATE/ALTER ... IF NOT EXISTS, so re-running the whole thing is safe,
   concurrent-safe, and never touches a row of data. */
const SCHEMA_VERSION = '4';

/* The tables are created on first use rather than by a separate migration
   step, so deploying needs nothing but a connection string.  Every statement
   is IF NOT EXISTS, so it is safe to run concurrently from several containers.
   `schemaReady` keeps it to once per warm container. */
let schemaReady = false;
async function ensureSchema(client) {
  if (schemaReady) return;
  /* One statement batch, inside one transaction: a container that dies
     half-way leaves the database exactly as it was rather than partly
     migrated.  Two containers running this at once is fine — every statement
     is IF NOT EXISTS, and the loser of a race sees the object already there. */
  await client.query('BEGIN');
  try {
    await client.query(SCHEMA);
    await client.query(
      `INSERT INTO mm_meta (key, value, updated_at) VALUES ('schema_version', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [SCHEMA_VERSION]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    /* Two containers initialising at once can collide on a CREATE INDEX even
       with IF NOT EXISTS (the check and the create are not atomic). That is
       not a failure: the object exists either way. */
    if (err && (err.code === '23505' || err.code === '42P07' || err.code === '42710')) {
      schemaReady = true;
      return;
    }
    console.error('money-manager db: schema initialisation failed — ' + scrub(err && err.message));
    throw appError(503, 'db_unreachable', DB_UNAVAILABLE_MESSAGE, scrub(err && err.message));
  }
  schemaReady = true;
}
/* Belt and braces: if a container thinks the schema is present but a table has
   gone (a fresh database pointed at the same deployment, say), create it and
   retry once.  Providers word the error differently, so match code or text. */
function missingTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  return /relation .* does not exist|no such table|undefined_table/i.test(err.message || '');
}
async function query(client, sql, params) {
  try {
    return await client.query(sql, params);
  } catch (err) {
    if (missingTable(err)) {
      schemaReady = false;
      await ensureSchema(client);
      return await client.query(sql, params);
    }
    throw err;
  }
}

/* -------------------------------------------------------------- request I/O */

/* An answer can be decided before the request body has been read — a rejected
   token, say.  On a keep-alive connection the unread body would then be parsed
   as the start of the next request, which the peer answers with a bare 400.
   Vercel gives each invocation its own request so it never bit there, but the
   local server and any self-hosted use do reuse connections, so drain first. */
function drain(req) {
  if (!req || !req.readable || req.readableEnded) return;
  try { req.resume(); } catch (e) { /* nothing left to read */ }
}

function send(res, status, body, req) {
  drain(req || (res && res.req));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/* Body handling has to cope with either platform behaviour.  With the body
   parser disabled (see the config export) nothing is pre-read and we take the
   raw stream, which is what lets a multi-megabyte compressed push through; if
   the runtime parsed it anyway, req.body is already a Buffer, string or object
   and we use that instead.  Either way the gzip header decides decompression. */
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 48 * 1024 * 1024) {          /* refuse absurd bodies outright */
        reject(Object.assign(new Error('That request body is far too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const encoded = String(req.headers['x-mm-encoding'] || '').toLowerCase() === 'gzip';
  let raw = req.body;
  if (raw == null || raw === '') raw = await rawBody(req);
  if (raw == null || raw === '' || (Buffer.isBuffer(raw) && !raw.length)) return null;

  if (Buffer.isBuffer(raw)) {
    const buf = encoded ? zlib.gunzipSync(raw) : raw;
    return JSON.parse(buf.toString('utf8'));
  }
  if (typeof raw === 'string') {
    /* A parsed-as-text gzip body arrives base64-encoded from our client. */
    if (encoded) return JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
    return JSON.parse(raw);
  }
  return raw;                                     /* already-parsed JSON object */
}

/* Who is calling?  Every authenticated route takes its user from here and
   from nowhere else — never from a body field, a query parameter or any other
   header the caller controls.  That is what makes cross-user access
   impossible rather than merely unlikely. */
async function authenticate(client, req) {
  const token = bearerToken(req);
  if (!token) throw appError(401, 'no_session', 'Please sign in to continue.');
  const digests = tokenDigests(token);

  /* Session tokens issued by email/password or Google sign-in. */
  const sess = await query(client,
    `SELECT u.*, t.id AS token_id, t.expires_at FROM mm_token t JOIN mm_user u ON u.id = t.user_id
      WHERE t.id = ANY($1) AND t.expires_at > now()`, [digests]);
  if (sess.rows.length) {
    /* Sliding expiry: an account in daily use never gets logged out. */
    await query(client,
      `UPDATE mm_token SET last_used = now(), expires_at = now() + INTERVAL '30 days' WHERE id = $1`,
      [sess.rows[0].token_id]).catch(() => {});
    return sess.rows[0];
  }

  /* Long-lived API tokens from the original design still work.  The empty
     string is what a password account's unused token_hash column holds, so it
     must never match. */
  const legacy = await query(client,
    `SELECT * FROM mm_user WHERE token_hash <> '' AND token_hash = ANY($1)`, [digests]);
  if (legacy.rows.length) return legacy.rows[0];

  throw appError(401, 'session_expired', 'Your session has expired — please sign in again.');
}

/* ---------------------------------------------------- password + sessions */

/* Password storage.
 *
 * New accounts use scrypt, which is memory-hard and therefore far more
 * expensive to attack on a GPU than an iterated hash of the same wall-clock
 * cost.  It is in Node's own crypto module, so this needs no native addon —
 * which matters, because a native dependency that fails to build on the
 * serverless runtime takes the whole deployment down with it.  Argon2id would
 * be the other good choice and is omitted only for that reason.
 *
 * PBKDF2-SHA256 at 210,000 iterations is what earlier accounts were created
 * with and is still within OWASP guidance, so those rows keep verifying
 * exactly as before.  A successful sign-in re-hashes them to scrypt in place,
 * so the old algorithm drains away as people use the app.  pw_algo on each row
 * says which to use; nothing is migrated behind a password we could not first
 * verify, so no one is locked out.
 */
const PW_ITERS = 210000;                    /* OWASP guidance for PBKDF2-SHA256 */
const PW_ALGO = 'scrypt';
/* Roughly 32 MiB and ~100 ms on this deployment's 1 GiB function.  N must be
   a power of two, and maxmem has to be raised because Node's default ceiling
   is itself 32 MiB and the allocation would just miss it. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

function pbkdf2(password, saltB64, iters) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), Buffer.from(saltB64, 'base64'), iters, 32, 'sha256',
      (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}
function scryptHash(password, saltB64) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), Buffer.from(saltB64, 'base64'), SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}
function newSalt() { return crypto.randomBytes(16).toString('base64'); }

/* What to store for a brand-new, or newly changed, password. */
async function hashNewPassword(password) {
  const salt = newSalt();
  return {
    salt: salt,
    hash: await scryptHash(password, salt),
    iters: SCRYPT.N,                        /* the cost parameter, per algorithm */
    algo: PW_ALGO
  };
}

/* Verify against whatever that row was written with.  Returns
   {ok, needsUpgrade} so the caller can quietly move an old row forward. */
async function verifyPassword(user, password) {
  if (!user.pw_hash || !user.salt) return { ok: false, needsUpgrade: false };
  const algo = String(user.pw_algo || 'pbkdf2-sha256');
  if (algo === 'scrypt') {
    const h = await scryptHash(password, user.salt);
    return { ok: timingSafeEqual(h, user.pw_hash), needsUpgrade: false };
  }
  const h = await pbkdf2(password, user.salt, user.pw_iters || PW_ITERS);
  const ok = timingSafeEqual(h, user.pw_hash);
  return { ok: ok, needsUpgrade: ok };
}

/* Spend comparable effort when there is nothing to compare against, so that a
   missing account is not distinguishable from a wrong password by timing. */
async function burnPasswordTime(password) {
  try { await scryptHash(String(password == null ? '' : password), newSalt()); }
  catch (e) { /* this call exists only to take time */ }
}

async function writePassword(client, userId, password) {
  const pw = await hashNewPassword(password);
  await query(client,
    'UPDATE mm_user SET salt = $1, pw_hash = $2, pw_iters = $3, pw_algo = $4, updated_at = $5 WHERE id = $6',
    [pw.salt, pw.hash, pw.iters, pw.algo, nowIso(), userId]);
  return pw;
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function passwordProblem(pw) {
  pw = String(pw == null ? '' : pw);
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 200) return 'That password is longer than 200 characters.';
  if (!/[a-zA-Z]/.test(pw)) return 'Include at least one letter.';
  if (!/[0-9]/.test(pw)) return 'Include at least one number.';
  return '';
}
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

/* Session-token digests.
 *
 * A token is 256 bits of randomness and only its digest is stored, so a
 * database dump cannot be replayed as a login.  AUTH_SECRET, when set, keys an
 * HMAC over it, so the stored digest is worthless without a value that lives
 * in the environment rather than in the database.  It is genuinely optional
 * and carries no lock-out risk: the only consequence of adding, changing or
 * losing it is that existing sessions stop matching and people sign in again.
 * Passwords are unaffected by it either way. */
const AUTH_SECRET = String(process.env.AUTH_SECRET || '').trim();
function tokenDigest(token) {
  if (!AUTH_SECRET) return sha(token);
  return 'h1:' + crypto.createHmac('sha256', AUTH_SECRET).update(String(token)).digest('hex');
}
/* Both forms, so sessions issued before AUTH_SECRET was set keep working
   until they expire.  Lookups match with = ANY($1) over this. */
function tokenDigests(token) {
  return AUTH_SECRET ? [tokenDigest(token), sha(token)] : [sha(token)];
}
/* The token this request presented.
 *
 * Three transports, in order of precedence:
 *   Authorization: Bearer   what the app sends today, and the only thing that
 *                           can work when the app is served from a different
 *                           origin than the API (a cookie would not be sent)
 *   X-Api-Token             the original long-lived API token header
 *   mm_session cookie       HttpOnly, so script on the page cannot read it —
 *                           see SESSION_COOKIE below
 */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  const fromHeader = (header.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-token'] || '').trim();
  if (fromHeader) return fromHeader;
  return readCookie(req, SESSION_COOKIE);
}

/* ------------------------------------------------------------ session cookie

   The session token is also issued as a cookie, with the attributes that
   matter:

     HttpOnly   script on the page cannot read it, so a cross-site scripting
                bug cannot walk off with a 30-day session
     Secure     it is never sent over plain http (relaxed only for localhost,
                where there is no https to use)
     SameSite=Lax
                the browser does not attach it to a cross-site POST/PUT/DELETE,
                which is what stops another site from acting as the signed-in
                user. Lax rather than Strict so that arriving from an external
                link still opens a signed-in app.
     Path=/     one cookie for the page and the API alike
     Max-Age    matches the 30-day server-side expiry of the session row

   The token is still returned in the JSON body as well, because that is what
   the app uses today and what a different-origin deployment needs. Nothing
   depends on the cookie yet: it is read when no header is present, so the
   transport can be switched over in the app on its own, and verified, without
   a flag day.
*/
const SESSION_COOKIE = 'mm_session';
const SESSION_DAYS = 30;

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  /* Split on ';' and match the name exactly — a cookie called
     'not_mm_session' must not satisfy a lookup for 'mm_session'. */
  const parts = String(raw).split(';');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    if (parts[i].slice(0, eq).trim() !== name) continue;
    const value = parts[i].slice(eq + 1).trim();
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }
  return '';
}

/* Is this request reaching us over a connection a Secure cookie can use?
   On Vercel everything is https and x-forwarded-proto says so; a local
   http server is the only case where Secure has to be dropped, or the
   browser would discard the cookie and local development could not sign in. */
function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  if (req.socket && req.socket.encrypted) return true;
  const host = String(req.headers.host || '');
  return !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
}

function cookieAttributes(req) {
  const bits = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isSecureRequest(req)) bits.push('Secure');
  return bits;
}

/* Queue a Set-Cookie alongside whatever else this response is sending. */
function addHeader(res, name, value) {
  const existing = res.getHeader(name);
  if (!existing) { res.setHeader(name, value); return; }
  res.setHeader(name, (Array.isArray(existing) ? existing : [existing]).concat(value));
}

function setSessionCookie(res, req, token) {
  addHeader(res, 'Set-Cookie', SESSION_COOKIE + '=' + encodeURIComponent(token) + '; ' +
    cookieAttributes(req).concat('Max-Age=' + (SESSION_DAYS * 24 * 3600)).join('; '));
}

/* Ending a session must also remove the cookie, or the browser keeps
   presenting a token the server has already deleted. */
function clearSessionCookie(res, req) {
  addHeader(res, 'Set-Cookie', SESSION_COOKIE + '=; ' +
    cookieAttributes(req).concat('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT').join('; '));
}

/* Issue a session token.  The caller gets the only copy; we keep its digest. */
async function issueSession(client, userId, device) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(client,
    `INSERT INTO mm_token (id, user_id, device, expires_at)
     VALUES ($1,$2,$3, now() + INTERVAL '30 days')`,
    [tokenDigest(token), userId, String(device || 'unknown').slice(0, 120)]);
  /* Keep the table tidy: drop this account's expired rows. */
  await query(client, 'DELETE FROM mm_token WHERE user_id = $1 AND expires_at < now()', [userId]).catch(() => {});
  return token;
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name || '', createdAt: u.created_at };
}

/* Wrong passwords cost time, and after enough of them the account pauses.
   Without this a public URL is an open guessing target. */
async function noteFailure(client, user) {
  const n = (user.fail_count || 0) + 1;
  const lock = n % 5 === 0 ? Math.min(300, 15 * Math.pow(2, Math.floor(n / 5) - 1)) : 0;
  await query(client,
    `UPDATE mm_user SET fail_count = $1, locked_until = CASE WHEN $2 > 0
        THEN now() + ($2 || ' seconds')::interval ELSE locked_until END WHERE id = $3`,
    [n, lock, user.id]).catch(() => {});
  return lock;
}
async function clearFailures(client, userId) {
  await query(client, 'UPDATE mm_user SET fail_count = 0, locked_until = NULL WHERE id = $1', [userId]).catch(() => {});
}

/* ------------------------------------------------------------ sending email

   Used only for password resets. An HTTP API rather than SMTP, because that
   needs no npm dependency — and a dependency that fails to build on the
   serverless runtime takes the whole deployment down, which is not a trade
   worth making for one transactional email.

   Resend is the provider implemented here (one POST, an API key, no SDK).
   Adding another HTTP provider means one more branch in sendMail().

   Unconfigured is a supported state: the reset endpoints report that plainly
   and the app hides the "forgot password" link, rather than accepting a
   request it cannot fulfil and leaving someone waiting for an email that is
   never coming.
*/
const MAIL_FROM = String(process.env.MAIL_FROM || '').trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();

function mailConfigured() {
  return !!(RESEND_API_KEY && MAIL_FROM);
}

/* Where a reset link should point.
 *
 * Deliberately NOT derived from the Host header. The header is set by the
 * caller, so anyone could POST /auth/forgot with Host: evil.example, and the
 * victim would receive a genuine email containing a valid reset token
 * pointing at the attacker's site. That is a real, known attack (host header
 * injection), and the cost of avoiding it is one environment variable.
 *
 * Vercel sets VERCEL_PROJECT_PRODUCTION_URL, so this is usually automatic.
 * With neither that nor APP_URL, the email carries the code only and no link
 * — degraded, but not exploitable. */
function appOrigin() {
  const explicit = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return /^https?:\/\//.test(explicit) ? explicit : 'https://' + explicit;
  const vercel = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  if (vercel) return 'https://' + vercel.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return '';
}

async function sendMail(to, subject, text) {
  if (!mailConfigured()) {
    throw appError(503, 'reset_unavailable',
      'Password reset is not available on this deployment. Ask the administrator to set it up.',
      'RESEND_API_KEY and MAIL_FROM must both be set for password reset email to be sent.');
  }
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: subject, text: text })
    });
  } catch (err) {
    console.error('money-manager mail: could not reach the mail provider — ' + scrub(err && err.message));
    throw appError(502, 'mail_failed',
      'The reset email could not be sent just now. Please try again in a moment.',
      scrub(err && err.message));
  }
  if (!res.ok) {
    /* The provider's body explains misconfiguration — an unverified sending
       domain, a revoked key — and belongs in the log, never in the reply. */
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch (e) { /* nothing to add */ }
    console.error('money-manager mail: provider returned ' + res.status + ' — ' + scrub(detail));
    throw appError(502, 'mail_failed',
      'The reset email could not be sent just now. Please try again in a moment.',
      'provider HTTP ' + res.status);
  }
}

/* ---------------------------------------------------------- password resets */

const RESET_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;
/* How many requests one account may make in the window, so the endpoint
   cannot be used to flood someone's inbox. */
const RESET_MAX_PER_WINDOW = 3;

/* Six digits, uniformly distributed. Math.random() would be predictable and
   a plain modulo of one byte would bias the low digits, so take a value from
   the full range and reject the tail that would skew it. */
function resetCode() {
  const LIMIT = 1000000;
  const CEILING = Math.floor(0xffffffff / LIMIT) * LIMIT;
  let n;
  do { n = crypto.randomBytes(4).readUInt32BE(0); } while (n >= CEILING);
  return String(n % LIMIT).padStart(6, '0');
}

function resetEmailBody(name, code, link) {
  const lines = [
    'Hello ' + (name || 'there') + ',',
    '',
    'Someone asked to reset the password for your Money Manager account.',
    '',
    'Your reset code is: ' + code,
    ''
  ];
  if (link) {
    lines.push('Or open this link, which fills the code in for you:', link, '');
  }
  lines.push(
    'The code expires in ' + RESET_MINUTES + ' minutes and can only be used once.',
    '',
    'If you did not ask for this, you can ignore this email — nothing has',
    'changed, and your current password still works.',
    '',
    'Resetting the password signs every device out of the account.'
  );
  return lines.join('\n');
}

/* ------------------------------------------- a new account's first document

   Registration writes this inside the same transaction as the user row, so an
   account always opens on a usable book: default categories, payment methods,
   categorisation rules and settings, plus the sample book if it was asked for.
   Doing it here rather than leaving it to the browser's first save is what
   makes "create user, create settings, create default categories, optionally
   create sample data" a single all-or-nothing step.

   MM_SCHEMA must track the app's own constant (currently 4) so migrate() in
   the browser recognises the document as current and does not rewrite it.
   ------------------------------------------------------------------------- */
const MM_SCHEMA = 4;
const MM_PAY = ['Cash', 'UPI', 'Bank Transfer', 'Debit Card', 'Credit Card', 'NEFT', 'RTGS', 'IMPS'];

/* The same id shape the app generates, so nothing downstream has to care
   which side created a record. */
function docId() { return 'i' + crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8); }

const DEFAULT_CATEGORIES = [
  ['Food', 'expense', ['Lunch', 'Dinner', 'Snacks', 'Tea / Coffee']],
  ['Groceries', 'expense', ['Vegetables', 'Provisions', 'Dairy']],
  ['Dining', 'expense', ['Restaurant', 'Takeaway']],
  ['Transport', 'expense', ['Auto', 'Cab', 'Metro', 'Bus']],
  ['Fuel', 'expense', ['Petrol', 'Diesel']],
  ['Shopping', 'expense', ['Clothing', 'Electronics', 'Household']],
  ['Bills', 'expense', ['Electricity', 'Water', 'Internet', 'Mobile', 'Gas']],
  ['Rent', 'expense', ['House Rent', 'Maintenance']],
  ['Home', 'expense', ['Repairs', 'Furniture']],
  ['Education', 'expense', ['Fees', 'Books']],
  ['Healthcare', 'expense', ['Doctor', 'Medicines', 'Tests']],
  ['Insurance', 'expense', ['Life', 'Health', 'Vehicle']],
  ['Entertainment', 'expense', ['Movies', 'Subscriptions', 'Games']],
  ['Travel', 'expense', ['Tickets', 'Hotel']],
  ['Personal', 'expense', ['Grooming', 'Gifts']],
  ['Investment', 'expense', ['SIP', 'Mutual Fund', 'Stocks', 'PPF', 'NPS', 'Fixed Deposit', 'Gold']],
  ['EMI', 'expense', ['Car Loan', 'Home Loan']],
  ['Taxes', 'expense', ['Income Tax', 'GST']],
  ['Miscellaneous', 'expense', []],
  ['Salary', 'income', ['Monthly Salary', 'Bonus']],
  ['Business', 'income', ['Sales', 'Consulting']],
  ['Freelance', 'income', ['Projects']],
  ['Interest', 'income', ['Savings', 'Fixed Deposit']],
  ['Dividend', 'income', []],
  ['Rental Income', 'income', []],
  ['Other Income', 'income', []]
];

/* The built-in narration guesses, as editable rules. */
const DEFAULT_RULES = [
  ['swiggy', 'Dining', 'Takeaway'], ['zomato', 'Dining', 'Takeaway'],
  ['hpcl', 'Fuel', 'Petrol'], ['indian oil', 'Fuel', 'Petrol'],
  ['uber', 'Transport', 'Cab'], ['ola ', 'Transport', 'Cab'],
  ['netflix', 'Entertainment', 'Subscriptions'], ['spotify', 'Entertainment', 'Subscriptions'],
  ['amazon', 'Shopping', ''], ['flipkart', 'Shopping', ''],
  ['bigbasket', 'Groceries', 'Provisions'], ['blinkit', 'Groceries', 'Provisions'],
  ['salary', 'Salary', 'Monthly Salary']
];

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* Sample data, if asked for.
 *
 * It has to obey the app's accounting rules, because these rows are indexed,
 * reported on and reconciled like any others:
 *   income            the account's balance rises
 *   expense           the account's balance falls
 *   transfer          source falls, destination rises, and it is neither
 *                     income nor expense
 *   card purchase     an expense ON the credit account, which is what makes
 *                     the outstanding grow (a credit account's balance is
 *                     negative by the signed convention balancesFrom uses)
 *   card payment      a transfer bank -> card: the bank falls, the card's
 *                     balance rises toward zero, and no expense is recorded,
 *                     because the expense was booked at purchase time
 * Every row is marked demo:true, which is how Settings → Data removes them.
 */
function sampleBook(now) {
  const day = 24 * 3600 * 1000;
  const d = (back) => isoDate(new Date(now - back * day));

  /* Every field the app's migrate() would otherwise backfill is written here.
     If one is missed, the app decides the document needs migrating and
     rewrites it on the first load of every new account — harmless, but it
     burns a revision and a save for nothing.  test/logic.test.js asserts that
     a server-written book needs no migration, which is what keeps these in
     step if either side gains a field. */
  const acct = (name, type, opening, extra) =>
    Object.assign({
      id: docId(), name: name, type: type, opening: opening, currency: 'INR',
      color: '#2b5f96', archived: false, institution: '', number: '', notes: '',
      demo: true, createdAt: now, updatedAt: now
    }, extra || {});

  const accounts = [
    acct('Cash', 'cash', 5000),
    acct('Bank Account', 'bank', 60000, { institution: 'Your Bank', number: '4321' }),
    acct('Credit Card', 'credit', 0, {
      limit: 100000, stmtDay: 25, dueDay: 15, rate: 42, minPct: 5,
      annualFee: 500, lateFee: 750, institution: 'Your Bank', number: '8842'
    }),
    acct('Wallet', 'wallet', 1500)
  ];
  const A = (n) => (accounts.find((a) => a.name === n) || {}).id || '';

  return { accounts: accounts, A: A, d: d, day: day };
}

function startingDocument(withSamples) {
  const now = Date.now();

  const categories = DEFAULT_CATEGORIES.map(([name, type, subs]) => ({
    id: docId(), name: name, type: type, enabled: true, subs: subs.slice(),
    demo: false, createdAt: now, updatedAt: now
  }));
  const C = (n) => (categories.find((c) => c.name === n) || {}).id || '';

  const rules = DEFAULT_RULES.map(([pattern, cat, sub]) => ({
    id: docId(), pattern: pattern, match: 'contains', field: 'text', nocase: true,
    categoryId: C(cat), sub: sub, accountId: '', payment: '', tags: [],
    enabled: true, demo: false, createdAt: now, updatedAt: now
  }));

  const doc = {
    schemaVersion: MM_SCHEMA,
    accounts: [], txns: [], categories: categories, budgets: [], recurring: [],
    loans: [], bookmarks: [], bills: [], goals: [], rules: rules,
    recons: [], views: [], loanEvents: [],
    tags: ['#office', '#travel', '#family', '#salary', '#reimbursable'],
    payments: MM_PAY.slice(),
    settings: {
      currency: 'INR', symbol: '₹', pin: '', pinHash: '', pinSalt: '', demo: false, panelW: 306,
      theme: 'light', autoLock: 0, density: '', applyRules: true, dateFmt: 'dd-mm-yyyy',
      recurMode: 'confirm', weekStart: 1
    }
  };
  if (!withSamples) return doc;

  const { accounts, A, d } = sampleBook(now);
  doc.accounts = accounts;
  doc.settings.demo = true;

  const txn = (date, type, account, cat, sub, amount, contents, details, payment, tags) => ({
    id: docId(), date: date, type: type, accountId: A(account), toAccountId: '',
    categoryId: cat ? C(cat) : '', sub: sub || '', amount: amount,
    contents: contents || '', details: details || '', payment: payment || 'Cash',
    notes: '', tags: tags || [], attachment: null,
    /* reconciliation, reimbursement and import bookkeeping */
    ref: '', reconciled: false, reimb: false, reimbWho: '', reimbStatus: '', importId: '',
    demo: true, createdAt: now, updatedAt: now
  });
  const move = (date, from, to, amount, contents, details, payment) => {
    const t = txn(date, 'transfer', from, '', '', amount, contents, details, payment || 'Bank Transfer');
    t.toAccountId = A(to);
    return t;
  };

  doc.txns = [
    /* income — the bank balance rises */
    txn(d(35), 'income', 'Bank Account', 'Salary', 'Monthly Salary', 45000,
      'Salary', 'Monthly payroll credit', 'Bank Transfer', ['#salary']),
    txn(d(5), 'income', 'Bank Account', 'Salary', 'Monthly Salary', 45000,
      'Salary', 'Monthly payroll credit', 'Bank Transfer', ['#salary']),

    /* expenses — the paying account's balance falls */
    txn(d(34), 'expense', 'Bank Account', 'Rent', 'House Rent', 18000, 'Rent', 'Monthly house rent', 'IMPS'),
    txn(d(4), 'expense', 'Bank Account', 'Rent', 'House Rent', 18000, 'Rent', 'Monthly house rent', 'IMPS'),
    txn(d(30), 'expense', 'Bank Account', 'Bills', 'Electricity', 2400, 'Utilities', 'Electricity bill', 'UPI'),
    txn(d(29), 'expense', 'Bank Account', 'Bills', 'Internet', 999, 'Utilities', 'Broadband', 'UPI'),
    txn(d(12), 'expense', 'Cash', 'Food', 'Lunch', 180, 'Food', 'Lunch', 'Cash'),
    txn(d(9), 'expense', 'Cash', 'Food', 'Dinner', 240, 'Food', 'Dinner', 'Cash'),
    txn(d(8), 'expense', 'Cash', 'Transport', 'Auto', 120, 'Transport', 'Auto fare', 'Cash'),
    txn(d(3), 'expense', 'Wallet', 'Transport', 'Metro', 60, 'Transport', 'Metro card top-up spend', 'UPI'),
    txn(d(20), 'expense', 'Bank Account', 'Groceries', 'Provisions', 5200, 'Groceries', 'Monthly groceries', 'Debit Card'),

    /* a card purchase: an expense ON the card, so the outstanding grows and
       the expense is counted once, here */
    txn(d(18), 'expense', 'Credit Card', 'Fuel', 'Petrol', 3000, 'Fuel', 'Fuel top-up', 'Credit Card'),
    txn(d(15), 'expense', 'Credit Card', 'Shopping', 'Clothing', 2500, 'Shopping', 'Clothes', 'Credit Card'),

    /* a cash withdrawal: money moves, nothing is earned or spent */
    move(d(25), 'Bank Account', 'Cash', 6000, 'Cash withdrawal', 'ATM withdrawal'),
    /* a wallet top-up: likewise */
    move(d(22), 'Bank Account', 'Wallet', 1000, 'Wallet top-up', 'UPI wallet load', 'UPI'),
    /* a card payment: the bank falls, the outstanding shrinks, and NO second
       expense is booked — it was already booked at purchase */
    move(d(6), 'Bank Account', 'Credit Card', 4000, 'Credit card payment', 'Statement payment', 'IMPS')
  ];

  doc.budgets = [
    ['Food', 5000], ['Transport', 2500], ['Groceries', 6000], ['Bills', 4500], ['Fuel', 4000]
  ].map(([cat, amount]) => ({
    id: docId(), categoryId: C(cat), sub: '', period: 'monthly', amount: amount,
    rollover: false, alert: 80, demo: true, createdAt: now, updatedAt: now
  }));

  doc.recurring = [
    ['Monthly salary', 'income', 45000, 'Bank Account', 'Salary', 'Monthly Salary'],
    ['House rent', 'expense', 18000, 'Bank Account', 'Rent', 'House Rent'],
    ['Broadband', 'expense', 999, 'Bank Account', 'Bills', 'Internet']
  ].map(([desc, type, amount, account, cat, sub]) => ({
    id: docId(), desc: desc, type: type, amount: amount, accountId: A(account),
    toAccountId: '', categoryId: C(cat), sub: sub, freq: 'monthly',
    start: d(400), end: '', next: isoDate(new Date(now + 20 * 24 * 3600 * 1000)),
    status: 'active', count: 0, posted: 0, postedDates: [],
    demo: true, createdAt: now, updatedAt: now
  }));

  doc.bills = [
    ['Electricity', 2400, 'Bills', 'Electricity'],
    ['Broadband', 999, 'Bills', 'Internet']
  ].map(([name, amount, cat, sub], i) => ({
    id: docId(), name: name, amount: amount,
    due: isoDate(new Date(now + (10 + i * 4) * 24 * 3600 * 1000)),
    accountId: A('Bank Account'), categoryId: C(cat), sub: sub, freq: 'monthly',
    status: 'unpaid', remind: 3, notes: '', autoPost: false,
    demo: true, createdAt: now, updatedAt: now
  }));

  doc.goals = [{
    id: docId(), name: 'Emergency fund', target: 300000, saved: 50000,
    by: isoDate(new Date(now + 540 * 24 * 3600 * 1000)), accountId: A('Bank Account'),
    notes: 'Six months of expenses', demo: true, createdAt: now, updatedAt: now
  }];

  doc.bookmarks = [
    ['Lunch', 'expense', 'Cash', 'Food', 'Lunch', 180, 'Cash'],
    ['Fuel', 'expense', 'Credit Card', 'Fuel', 'Petrol', 3000, 'Credit Card'],
    ['Rent', 'expense', 'Bank Account', 'Rent', 'House Rent', 18000, 'IMPS']
  ].map(([label, type, account, cat, sub, amount, payment]) => ({
    id: docId(), label: label, type: type, accountId: A(account), categoryId: C(cat),
    sub: sub, amount: amount, contents: label, payment: payment, demo: true
  }));

  return doc;
}

/* ------------------------------------------------------------------- google */

/* Who may hold an account.
 *
 * ALLOWED_EMAILS set  -> only those addresses, exactly as the self-hosted server.
 * ALLOWED_EMAILS unset -> the FIRST address to sign in claims the deployment and
 *   later strangers are refused.  The self-hosted server allowed anyone, which
 *   is fine on a home network but not on a public URL, so the default here fails
 *   closed instead of letting the internet fill your database. */
async function claimAccount(client, email) {
  const allow = (process.env.ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length) return allow.indexOf(email.toLowerCase()) >= 0;
  const { rows } = await query(client, 'SELECT COUNT(*)::int AS n FROM mm_user', []);
  return rows[0].n === 0;
}

async function authGoogle(client, req, res) {
  let body;
  try { body = (await readJsonBody(req)) || {}; }
  catch (e) { return send(res, 400, { error: 'The request body could not be read.' }); }

  const accessToken = body.accessToken || '';
  if (!accessToken) return send(res, 422, { error: 'accessToken is required.' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return send(res, 500, { error: 'This server has no GOOGLE_CLIENT_ID configured.' });

  let info, tokenInfo;
  try {
    const [a, b] = await Promise.all([
      fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } }),
      fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken))
    ]);
    if (!a.ok || !b.ok) return send(res, 401, { error: 'Google did not accept that sign-in.' });
    info = await a.json();
    tokenInfo = await b.json();
  } catch (err) {
    return send(res, 502, { error: 'Could not reach Google to verify the sign-in.' });
  }

  /* The token must belong to OUR OAuth client, or any Google token would work. */
  if (tokenInfo.aud !== clientId && tokenInfo.azp !== clientId) {
    return send(res, 401, { error: 'That sign-in was issued to a different application.' });
  }
  if (!info.email || info.email_verified === false) {
    return send(res, 401, { error: 'Google did not confirm a verified email address.' });
  }

  const email = normEmail(info.email);
  const { rows } = await query(client, 'SELECT id FROM mm_user WHERE lower(email) = $1', [email]);
  if (!rows.length && !(await claimAccount(client, email))) {
    /* Same wording as the password route, and for the same reason: it names
       no address and no variable. Google has already proved who they are, so
       there is no enumeration risk here — only a reason to be consistent. */
    return send(res, 403, {
      error: 'This deployment is not open for new accounts. ' +
        'If you should have access, ask whoever runs it to add you.',
      code: 'not_allowed'
    });
  }

  /* A real session row, the same as password sign-in gets, rather than a
     long-lived bearer token on the user row: it expires, it can be revoked
     from "sign out everywhere", and it is keyed by AUTH_SECRET when set. */
  const ts = nowIso();
  let userId;
  await query(client, 'BEGIN', []);
  try {
    if (rows.length) {
      userId = rows[0].id;
      await query(client, 'UPDATE mm_user SET name = $1, updated_at = $2 WHERE id = $3',
        [info.name || '', ts, userId]);
    } else {
      userId = uid();
      await query(client,
        `INSERT INTO mm_user (id, email, name, token_hash, created_at, updated_at)
         VALUES ($1,$2,$3,'',$4,$4)`,
        [userId, email, info.name || '', ts]);
      await query(client,
        `INSERT INTO mm_state (user_id, data, rev, device, updated_at)
         VALUES ($1,$2,1,$3, now()) ON CONFLICT (user_id) DO NOTHING`,
        [userId, JSON.stringify(startingDocument(false)),
          String(req.headers['x-device'] || 'unknown').slice(0, 120)]);
    }
    var sessionToken = await issueSession(client, userId, req.headers['x-device']);
    await query(client, 'COMMIT', []);
    setSessionCookie(res, req, sessionToken);
    send(res, 200, { token: sessionToken, email: email, name: info.name || '', expiresIn: null });
  } catch (err) {
    await query(client, 'ROLLBACK', []).catch(() => {});
    throw err;
  }
}

/* -------------------------------------------------------------- read helpers */

/* The self-hosted server mirrored each backup into relational tables to serve
   /transactions and /balances.  Keeping a second copy in sync is a lot of
   moving parts for a read side nothing critical depends on, so both endpoints
   are answered from the newest snapshot's JSON instead — same responses, one
   source of truth. */
async function latestPayload(client, userId) {
  const { rows } = await query(client,
    'SELECT payload FROM mm_snapshot WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
  return rows.length ? rows[0].payload : null;
}

/* Same signed convention as the app: assets positive, liabilities negative,
   transfers move money without being income or expense. */
function balancesFrom(payload) {
  const accounts = (payload && payload.accounts) || [];
  const txns = (payload && payload.txns) || [];
  const map = {};
  accounts.forEach((a) => {
    map[a.id] = { id: a.id, name: a.name, type: a.type, opening: +a.opening || 0, balance: +a.opening || 0, archived: !!a.archived };
  });
  txns.forEach((t) => {
    const amt = +t.amount || 0;
    if (!isFinite(amt)) return;
    const from = map[t.accountId], to = map[t.toAccountId];
    if (t.type === 'income' && from) from.balance += amt;
    else if (t.type === 'expense' && from) from.balance -= amt;
    else if (t.type === 'transfer') {
      if (from) from.balance -= amt;
      if (to) to.balance += amt;
    }
  });
  const live = Object.keys(map).map((k) => map[k]).filter((a) => !a.archived);
  const netWorth = live.reduce((n, a) => n + a.balance, 0);
  return { accounts: live, netWorth };
}

/* Is this a document we are willing to store?
 *
 * The check is deliberately structural and no stricter.  This endpoint
 * replaces a person's entire book, so refusing a save loses their work just
 * as surely as accepting a bad one corrupts it — anything the app might
 * legitimately write has to get through.  So: the top-level shape, the
 * collections that must be arrays, sane sizes, and the one thing that would
 * silently poison every report downstream (a transaction whose amount or type
 * is not usable).  Unknown fields are kept, because a newer build of the app
 * may be writing them and dropping them would quietly destroy data.
 *
 * There is nothing to mass-assign here: the row is keyed by the session's
 * user id, and no field in this body can name a user, an id or a permission.
 */
const MAX_ROWS = 200000;
const TXN_TYPES = { income: 1, expense: 1, transfer: 1 };
const DOC_ARRAYS = ['accounts', 'txns', 'categories', 'budgets', 'recurring',
  'loans', 'bills', 'goals', 'rules'];

function documentProblem(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'The document must be an object.';
  }
  if (!Array.isArray(data.accounts) || !Array.isArray(data.txns)) {
    return 'The document must contain accounts[] and txns[].';
  }
  for (const key of DOC_ARRAYS) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      return 'The document\'s ' + key + ' must be a list.';
    }
    if (Array.isArray(data[key]) && data[key].length > MAX_ROWS) {
      return 'That is more than ' + MAX_ROWS + ' rows in ' + key + ', which is beyond what this can store.';
    }
  }
  if (data.settings !== undefined &&
    (data.settings === null || typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    return 'The document\'s settings must be an object.';
  }
  /* Spot-check the rows that carry money.  A NaN or a missing type here turns
     every balance and every report into nonsense, and it is cheap to catch. */
  for (let i = 0; i < data.txns.length; i++) {
    const t = data.txns[i];
    if (!t || typeof t !== 'object') return 'Transaction ' + (i + 1) + ' is not a record.';
    const amt = Number(t.amount);
    if (!isFinite(amt)) return 'Transaction ' + (i + 1) + ' has an amount that is not a number.';
    if (!TXN_TYPES[t.type]) {
      return 'Transaction ' + (i + 1) + ' has an unknown type (' +
        String(t.type).slice(0, 20) + '). Expected income, expense or transfer.';
    }
  }
  for (let i = 0; i < data.accounts.length; i++) {
    const a = data.accounts[i];
    if (!a || typeof a !== 'object') return 'Account ' + (i + 1) + ' is not a record.';
    if (a.opening !== undefined && !isFinite(Number(a.opening))) {
      return 'Account ' + (i + 1) + ' has an opening balance that is not a number.';
    }
  }
  return '';
}

/* ------------------------------------------------------------------- routing */

/* 'v1', 'v2' ... — the API version segment, which is not part of a route. */
function isVersionSeg(seg) {
  if (!seg || seg.length < 2 || seg.charAt(0) !== 'v') return false;
  for (var i = 1; i < seg.length; i++) {
    var c = seg.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/* Which endpoint is being asked for?  Three routing shapes have to work,
   because how a request reaches this file depends on the deployment:

     1. rewritten   /api/v1/state  ->  /api/index?mmpath=v1/state
     2. dynamic     a [...path] route hands the segments to req.query.path
     3. direct      a local server, or /api/health with no rewrite at all

   Nested paths silently 404'd when only (2) was implemented, so all three
   are read here in order of how explicit they are.  A leading 'api',
   'index' or version segment is dropped so every shape ends up identical. */
function routeSegments(req) {
  const url = String(req.url || '');
  const qmark = url.indexOf('?');
  const pathname = qmark < 0 ? url : url.slice(0, qmark);
  const search = qmark < 0 ? '' : url.slice(qmark + 1);

  const decode = (p) => { try { return decodeURIComponent(p); } catch (e) { return p; } };
  const split = (v) => String(v).split('/').map(decode).filter(Boolean);

  let segs = null;

  /* 1. the rewrite tells us plainly.  Read it out of the raw query string so
        this does not depend on the platform's req.query helper existing. */
  let mm = null;
  if (req.query && typeof req.query.mmpath === 'string') mm = req.query.mmpath;
  if (mm === null && search) {
    search.split('&').forEach((pair) => {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      if (key === 'mmpath') mm = eq < 0 ? '' : pair.slice(eq + 1).split('+').join(' ');
    });
  }
  if (mm !== null && String(mm).length) segs = split(mm);

  /* 2. a [...path] dynamic route */
  if (!segs && req.query && req.query.path) {
    const parts = req.query.path;
    segs = (Array.isArray(parts) ? parts : [parts]).filter(Boolean)
      .reduce((acc, p) => acc.concat(split(p)), []);
  }

  /* 3. whatever the URL says */
  if (!segs) segs = split(pathname);

  while (segs.length && (segs[0] === 'api' || segs[0] === 'index' || isVersionSeg(segs[0]))) segs.shift();
  return segs;
}

/* --------------------------------------------------------------- the handler */

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device, X-Api-Token, X-Mm-Encoding');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const segs = routeSegments(req);
  const route = segs.join('/');
  const method = req.method || 'GET';

  /* Health is answered without touching the database so it stays useful when
     the database is the thing that is broken. */
  if (route === 'health' && method === 'GET') {
    let dbOk = false, dbCode = null, dbDetail = null, encoding = null, encodingOk = null;
    let schemaVersion = null, userCount = null;
    try {
      await withDb(async (c) => {
        await c.query('SELECT 1');
        /* A non-UTF8 database silently cannot hold the rupee sign, so report
           it here rather than letting the first save fail mysteriously. */
        try {
          const e = await c.query('SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()');
          encoding = e.rows.length ? e.rows[0].enc : null;
          encodingOk = encoding ? /^UTF8$/i.test(encoding) : null;
        } catch (e2) { /* not fatal; the connection itself is what matters */ }
        /* Proof that initialisation ran, not just that a socket opened. */
        try {
          const v = await c.query(`SELECT value FROM mm_meta WHERE key = 'schema_version'`);
          schemaVersion = v.rows.length ? v.rows[0].value : null;
          const n = await c.query('SELECT COUNT(*)::int AS n FROM mm_user');
          userCount = Number(n.rows[0].n) || 0;
        } catch (e3) { /* the tables are the thing that failed; say so below */ }
      });
      dbOk = true;
    } catch (e) {
      dbCode = (e && e.code) || 'db_unreachable';
      dbDetail = scrub((e && e.detail) || (e && e.message) || '');
    }

    /* This endpoint is unauthenticated — anyone who can open the app can read
       it — so treat it as public, not as a private admin console.
       It reports which variable NAMES are set, because a name is not a secret
       and it is the one thing that answers "I attached a database and it
       still says none is configured" in a single look: either the name the
       provider chose is not one we read, or the deployment predates the
       variable and needs a redeploy.
       It does NOT report the host, the port, the database name, the user, or
       the driver's own words, since those describe infrastructure rather than
       the app's health.  That full detail is in the function log, and can be
       surfaced here in a non-production deployment with MM_DIAGNOSTICS=1. */
    const showDetail = DIAGNOSTICS && !IS_PROD;
    return send(res, dbOk ? 200 : 503, {
      status: dbOk ? 'ok' : 'error',
      ok: dbOk,
      service: 'money-manager-server',
      runtime: 'vercel-serverless',
      time: nowIso(),
      database: dbOk ? 'connected' : 'unavailable',
      databaseCode: dbCode,
      databaseError: showDetail ? dbDetail : null,
      databaseErrorNote: dbOk || showDetail ? null
        : 'The reason is in this deployment\'s function log. Set MM_DIAGNOSTICS=1 on a non-production deployment to see it here.',
      schemaVersion: schemaVersion,
      schemaExpected: SCHEMA_VERSION,
      accounts: userCount,
      databaseUrlVarsSet: dbVarsPresent(),
      databaseUrlVarsAccepted: DB_URL_VARS,
      encoding: encoding,
      encodingOk: encodingOk,
      encodingWarning: encodingOk === false
        ? 'This database is ' + encoding + ', not UTF8, so it cannot store the ₹ sign. Recreate it with UTF8 encoding.'
        : null,
      authSecretSet: !!(process.env.AUTH_SECRET || '').trim(),
      /* The app hides the "forgot password" link unless this is true, rather
         than offering something the deployment cannot do. */
      passwordReset: mailConfigured(),
      passwordResetLink: mailConfigured() ? !!appOrigin() : null,
      googleSignIn: !!process.env.GOOGLE_CLIENT_ID,
      accessPolicy: (process.env.ALLOWED_EMAILS || '').trim()
        ? 'allowlist'
        : 'first account claims this deployment',
      keepSnapshots: KEEP_SNAPSHOTS
    });
  }

  try {
    await withDb(async (client) => {
      if (route === 'auth/google' && method === 'POST') return authGoogle(client, req, res);

      /* ---- create an account (email + password) --------------------------
         Validate, then do the whole creation in one transaction: the account
         row, the starting document and the first session either all exist or
         none of them do.  A half-configured account — a user with no document,
         or a document with no session — is the thing this prevents. */
      if (route === 'auth/register' && method === 'POST') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) { return send(res, 400, { error: 'The request could not be read.', code: 'bad_body' }); }
        const email = normEmail(body.email);
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) return send(res, 422, { error: 'Enter the name you want to be known by.', code: 'name_required' });
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
          return send(res, 422, { error: 'Enter a valid email address.', code: 'email_invalid' });
        }
        const bad = passwordProblem(body.password);
        if (bad) return send(res, 422, { error: bad, code: 'password_weak' });
        /* The app checks this too, but the server is the only check that
           cannot be skipped, and sending both is what the form does. */
        if (body.password2 != null && String(body.password2) !== String(body.password)) {
          return send(res, 422, { error: 'The two passwords don’t match.', code: 'password_mismatch' });
        }

        /* Whether the address is ALLOWED is settled before whether it already
           has an account, and that order is the point.
           The other way round, someone who cannot register here could still
           tell "that address has an account" (409) from "you are not allowed"
           (403), for any address they cared to try — which on a personal
           finance deployment is a list of who banks here. Now anyone not on
           the allowlist gets the same 403 whatever they type, and learns
           nothing about any account.
           It is also the cheap check: a refused caller never reaches the
           password hash, so hammering this endpoint costs almost nothing. */
        if (!(await claimAccount(client, email))) {
          /* Deliberately says nothing about this address, no environment
             variable, and does not echo back what was typed. Enough for
             someone who should have access to know what to ask for. */
          return send(res, 403, {
            error: 'This deployment is not open for new accounts. ' +
              'If you should have access, ask whoever runs it to add you.',
            code: 'not_allowed'
          });
        }

        const existing = await query(client, 'SELECT id FROM mm_user WHERE lower(email) = $1', [email]);
        if (existing.rows.length) {
          return send(res, 409, {
            error: 'An account with this email already exists. Sign in instead.',
            code: 'email_taken'
          });
        }

        /* Hash before BEGIN: scrypt takes ~100 ms and there is no reason to
           hold a transaction open across it. */
        const pw = await hashNewPassword(body.password);
        const id = uid();
        /* The starting document — default categories, payment methods and
           categorisation rules, and the sample book only if it was asked for.
           It is written here, in this transaction, so the account is never
           half-configured: there is no window in which a user row exists with
           no book. The app opens the copy returned below rather than writing
           its own, so a brand-new account does not immediately conflict with
           itself over a revision.
           test/logic.test.js asserts the app needs no migration of it. */
        const startDoc = startingDocument(!!body.samples);

        await query(client, 'BEGIN', []);
        let token;
        try {
          await query(client,
            `INSERT INTO mm_user (id, email, name, token_hash, salt, pw_hash, pw_iters, pw_algo, created_at, updated_at)
             VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8,$8)`,
            [id, email, name, pw.salt, pw.hash, pw.iters, pw.algo, nowIso()]);
          await query(client,
            `INSERT INTO mm_state (user_id, data, rev, device, updated_at)
             VALUES ($1,$2,1,$3, now())`,
            [id, JSON.stringify(startDoc), String(req.headers['x-device'] || 'unknown').slice(0, 120)]);
          token = await issueSession(client, id, req.headers['x-device']);
          await query(client, 'COMMIT', []);
        } catch (err) {
          await query(client, 'ROLLBACK', []).catch(() => {});
          /* Two people registering the same address at the same instant: the
             SELECT above cannot see the other transaction, so the unique
             index is what actually decides it.  That is a 409, not a 500. */
          if (err && err.code === '23505') {
            return send(res, 409, {
              error: 'An account with this email already exists. Sign in instead.',
              code: 'email_taken'
            });
          }
          throw err;
        }
        const u = await query(client, 'SELECT * FROM mm_user WHERE id = $1', [id]);
        setSessionCookie(res, req, token);
        return send(res, 200, {
          token: token,
          user: publicUser(u.rows[0]),
          state: { rev: 1, data: startDoc }
        });
      }

      /* ---- sign in ---- */
      if (route === 'auth/login' && method === 'POST') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) { return send(res, 400, { error: 'The request could not be read.' }); }
        const email = normEmail(body.email);
        if (!email || !body.password) return send(res, 422, { error: 'Enter your email and password.' });

        const found = await query(client, 'SELECT * FROM mm_user WHERE lower(email) = $1', [email]);
        if (!found.rows.length) {
          /* Spend comparable time so a missing account is not detectable. */
          await burnPasswordTime(body.password);
          return send(res, 401, { error: 'That email and password don’t match an account.', code: 'bad_credentials' });
        }
        const user = found.rows[0];
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
          const secs = Math.ceil((new Date(user.locked_until) - new Date()) / 1000);
          return send(res, 429, {
            error: 'Too many attempts. Try again in ' + secs + ' second(s).',
            code: 'throttled'
          });
        }
        if (!user.pw_hash) {
          return send(res, 409, {
            error: 'This account was created with Google sign-in — use that button instead.',
            code: 'use_google'
          });
        }
        const check = await verifyPassword(user, body.password);
        if (!check.ok) {
          const lock = await noteFailure(client, user);
          return send(res, 401, {
            error: lock
              ? 'That email and password don’t match. Too many attempts — paused for ' + lock + ' seconds.'
              : 'That email and password don’t match an account.',
            code: lock ? 'throttled' : 'bad_credentials'
          });
        }
        /* Right password, old algorithm: move the row forward now that we
           have the plaintext to re-derive from.  Failing here must not fail
           the sign-in — the existing hash still verifies. */
        if (check.needsUpgrade) {
          await writePassword(client, user.id, body.password)
            .catch((e) => console.error('money-manager: password re-hash skipped —', scrub(e && e.message)));
        }
        await clearFailures(client, user.id);
        const token = await issueSession(client, user.id, req.headers['x-device']);
        setSessionCookie(res, req, token);
        return send(res, 200, { token: token, user: publicUser(user) });
      }

      /* ---- forgot password: send a code and a link ------------------------
         Answers the same way whether or not the address has an account. If it
         said "no such account" it would be a free tool for working out who
         banks here, so the only thing a caller learns is that the request was
         accepted. */
      if (route === 'auth/forgot' && method === 'POST') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) { return send(res, 400, { error: 'The request could not be read.', code: 'bad_body' }); }
        const email = normEmail(body.email);
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return send(res, 422, { error: 'Enter the email address for your account.', code: 'email_invalid' });
        }
        /* This one IS worth saying plainly: it is the deployment's own
           configuration, not a fact about any account. */
        if (!mailConfigured()) {
          return send(res, 503, {
            error: 'Password reset by email is not set up on this deployment. ' +
              'Ask the administrator to configure it.',
            code: 'reset_unavailable'
          });
        }

        const accepted = {
          ok: true,
          sent: true,
          expiresInMinutes: RESET_MINUTES,
          message: 'If that address has an account, a reset code is on its way to it.'
        };

        const found = await query(client,
          'SELECT id, email, name FROM mm_user WHERE lower(email) = $1', [email]);
        if (!found.rows.length) {
          /* Spend roughly the time a real request costs, so the response time
             does not answer the question the status code refuses to. */
          await burnPasswordTime(crypto.randomBytes(8).toString('hex'));
          return send(res, 200, accepted);
        }
        const account = found.rows[0];

        /* Don't let this become an inbox flood. Expired and used rows do not
           count, so a genuine retry after a mistake still works. */
        const recent = await query(client,
          `SELECT COUNT(*)::int AS n FROM mm_reset
            WHERE user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
          [account.id, String(RESET_MINUTES)]);
        if (Number(recent.rows[0].n) >= RESET_MAX_PER_WINDOW) {
          /* Still a 200: a caller must not be able to tell "too many
             requests" (which proves the account exists) from "sent". */
          console.error('money-manager reset: throttled, ' + RESET_MAX_PER_WINDOW +
            ' requests already in the last ' + RESET_MINUTES + ' minutes for one account');
          return send(res, 200, accepted);
        }

        const token = crypto.randomBytes(32).toString('base64url');
        const code = resetCode();
        const salt = newSalt();
        const codeHash = await scryptHash(code, salt);

        await query(client,
          `INSERT INTO mm_reset (id, user_id, code_hash, code_salt, expires_at)
           VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
          [sha(token), account.id, codeHash, salt, String(RESET_MINUTES)]);
        /* Housekeeping: this account's spent and expired rows. */
        await query(client,
          'DELETE FROM mm_reset WHERE user_id = $1 AND (expires_at < now() OR used_at IS NOT NULL)',
          [account.id]).catch(() => {});

        const origin = appOrigin();
        const link = origin ? origin + '/?reset=' + encodeURIComponent(token) : '';
        if (!origin) {
          console.error('money-manager reset: neither APP_URL nor VERCEL_PROJECT_PRODUCTION_URL ' +
            'is set, so the email carries the code but no link.');
        }
        await sendMail(account.email, 'Reset your Money Manager password',
          resetEmailBody(account.name, code, link));

        return send(res, 200, accepted);
      }

      /* ---- complete the reset --------------------------------------------
         Either half of the email proves control of the inbox: the link's
         token, or the six-digit code with the address. */
      if (route === 'auth/reset' && method === 'POST') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) { return send(res, 400, { error: 'The request could not be read.', code: 'bad_body' }); }

        const bad = passwordProblem(body.password);
        if (bad) return send(res, 422, { error: bad, code: 'password_weak' });
        if (body.password2 != null && String(body.password2) !== String(body.password)) {
          return send(res, 422, { error: 'The two passwords don’t match.', code: 'password_mismatch' });
        }

        const token = String(body.token || '').trim();
        const code = String(body.code || '').replace(/\s+/g, '');
        const email = normEmail(body.email);
        const expired = {
          error: 'That reset code has expired or has already been used. Ask for a new one.',
          code: 'reset_invalid'
        };

        let row = null;
        if (token) {
          /* The link. A 256-bit token is proof on its own. */
          const r = await query(client,
            `SELECT * FROM mm_reset
              WHERE id = $1 AND used_at IS NULL AND expires_at > now()`, [sha(token)]);
          row = r.rows[0] || null;
          if (!row) return send(res, 400, expired);
        } else {
          if (!email || !code) {
            return send(res, 422, {
              error: 'Enter your email address and the code from the email.',
              code: 'reset_incomplete'
            });
          }
          const r = await query(client,
            `SELECT r.* FROM mm_reset r JOIN mm_user u ON u.id = r.user_id
              WHERE lower(u.email) = $1 AND r.used_at IS NULL AND r.expires_at > now()
              ORDER BY r.created_at DESC LIMIT 1`, [email]);
          row = r.rows[0] || null;
          if (!row) {
            await burnPasswordTime(code);
            return send(res, 400, expired);
          }
          if (row.attempts >= RESET_MAX_ATTEMPTS) {
            await query(client, 'UPDATE mm_reset SET used_at = now() WHERE id = $1', [row.id]);
            return send(res, 400, expired);
          }
          const given = await scryptHash(code, row.code_salt);
          if (!timingSafeEqual(given, row.code_hash)) {
            const n = Number(row.attempts) + 1;
            /* Burn the record on the last allowed attempt, so five wrong
               guesses cost a new email rather than allowing a sixth. */
            await query(client,
              'UPDATE mm_reset SET attempts = $1, used_at = CASE WHEN $1 >= $2 THEN now() ELSE NULL END WHERE id = $3',
              [n, RESET_MAX_ATTEMPTS, row.id]);
            const left = Math.max(0, RESET_MAX_ATTEMPTS - n);
            return send(res, 400, {
              error: left
                ? 'That code is not right. ' + left + ' attempt' + (left === 1 ? '' : 's') + ' left.'
                : 'That code is not right, and there are no attempts left. Ask for a new code.',
              code: 'reset_bad_code'
            });
          }
        }

        /* Proven. Change the password and end every session, in one
           transaction — a half-applied reset would leave the account either
           unreachable or still open on a device someone else is holding. */
        await query(client, 'BEGIN', []);
        try {
          await writePassword(client, row.user_id, body.password);
          await query(client, 'UPDATE mm_reset SET used_at = now() WHERE id = $1', [row.id]);
          /* Any other outstanding request for this account is void too. */
          await query(client,
            'UPDATE mm_reset SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
            [row.user_id]);
          /* Signing every device out is the point: if the password was reset
             because someone else had it, their session must not survive. */
          await query(client, 'DELETE FROM mm_token WHERE user_id = $1', [row.user_id]);
          await query(client, 'UPDATE mm_user SET fail_count = 0, locked_until = NULL WHERE id = $1',
            [row.user_id]);
          await query(client, 'COMMIT', []);
        } catch (err) {
          await query(client, 'ROLLBACK', []).catch(() => {});
          throw err;
        }
        clearSessionCookie(res, req);
        return send(res, 200, {
          ok: true,
          message: 'Your password has been changed. Every device has been signed out — sign in again with the new password.'
        });
      }

      const user = await authenticate(client, req);
      const device = String(req.headers['x-device'] || 'unknown').slice(0, 120);

      /* ---- session ---- */
      if (route === 'auth/session' && method === 'GET') {
        const st = await query(client, 'SELECT rev, updated_at, device FROM mm_state WHERE user_id = $1', [user.id]);
        return send(res, 200, {
          user: publicUser(user),
          state: st.rows.length ? { rev: Number(st.rows[0].rev), updatedAt: st.rows[0].updated_at, device: st.rows[0].device } : null
        });
      }
      if (route === 'auth/logout' && method === 'POST') {
        /* Scoped to this user as well as this digest, so a token that somehow
           did not belong to the caller could not be used to end someone
           else's session. */
        await query(client, 'DELETE FROM mm_token WHERE user_id = $1 AND id = ANY($2)',
          [user.id, tokenDigests(bearerToken(req))]);
        clearSessionCookie(res, req);
        return send(res, 200, { ok: true });
      }
      /* Signing out everywhere is the remedy if a device is lost.  That
         includes this device, so its cookie goes too. */
      if (route === 'auth/logout-all' && method === 'POST') {
        await query(client, 'DELETE FROM mm_token WHERE user_id = $1', [user.id]);
        clearSessionCookie(res, req);
        return send(res, 200, { ok: true });
      }
      if (route === 'auth/password' && method === 'POST') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) { return send(res, 400, { error: 'The request could not be read.' }); }
        const bad = passwordProblem(body.next);
        if (bad) return send(res, 422, { error: bad, code: 'password_weak' });
        if (!user.pw_hash) return send(res, 409, { error: 'This account has no password to change.', code: 'use_google' });
        const cur = await verifyPassword(user, body.current);
        if (!cur.ok) return send(res, 401, { error: 'Your current password doesn’t match.', code: 'bad_credentials' });
        await writePassword(client, user.id, body.next);
        /* Every other device must sign in again with the new password. */
        await query(client, 'DELETE FROM mm_token WHERE user_id = $1 AND NOT (id = ANY($2))',
          [user.id, tokenDigests(bearerToken(req))]);
        return send(res, 200, { ok: true });
      }

      /* ---- delete the whole account ---- */
      if (route === 'auth/account' && method === 'DELETE') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) { return send(res, 400, { error: 'The request could not be read.' }); }
        if (user.pw_hash) {
          const cur = await verifyPassword(user, body.password);
          if (!cur.ok) return send(res, 401, { error: 'That password doesn’t match.', code: 'bad_credentials' });
        }
        /* Every dependent row cascades from mm_user. */
        await query(client, 'DELETE FROM mm_user WHERE id = $1', [user.id]);
        clearSessionCookie(res, req);
        return send(res, 200, { deleted: true });
      }

      /* ---- the live document ------------------------------------------------
         This is where the books actually live now.  GET returns the whole
         thing with its revision; PUT replaces it but only if the caller was
         holding the current revision, so two devices cannot quietly
         overwrite one another. */
      if (route === 'state' && method === 'GET') {
        const st = await query(client, 'SELECT data, rev, updated_at, device FROM mm_state WHERE user_id = $1', [user.id]);
        if (!st.rows.length) return send(res, 200, { rev: 0, data: null });
        return send(res, 200, {
          rev: Number(st.rows[0].rev), data: st.rows[0].data,
          updatedAt: st.rows[0].updated_at, device: st.rows[0].device
        });
      }
      if (route === 'state' && method === 'PUT') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) { return send(res, 400, { error: 'The save could not be read. Nothing was changed.', detail: String(e.message) }); }
        const data = body.data;
        const shape = documentProblem(data);
        if (shape) return send(res, 422, { error: shape, code: 'bad_document' });
        const claimed = Number(body.rev || 0);
        const device = String(body.device || req.headers['x-device'] || 'unknown').slice(0, 120);
        const cur = await query(client, 'SELECT rev, updated_at, device FROM mm_state WHERE user_id = $1', [user.id]);
        const serverRev = cur.rows.length ? Number(cur.rows[0].rev) : 0;
        if (serverRev !== claimed && !body.force) {
          return send(res, 409, {
            error: 'This account was changed somewhere else since you loaded it.',
            serverRev: serverRev, yourRev: claimed,
            updatedAt: cur.rows.length ? cur.rows[0].updated_at : null,
            device: cur.rows.length ? cur.rows[0].device : null
          });
        }
        const nextRev = serverRev + 1;
        const json = JSON.stringify(data);
        await query(client,
          `INSERT INTO mm_state (user_id, data, rev, device, updated_at)
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, rev = excluded.rev,
             device = excluded.device, updated_at = excluded.updated_at`,
          [user.id, json, nextRev, device]);
        /* Automatic version history: keep a snapshot if the last one is old,
           because there is no copy in the browser to fall back on. */
        const last = await query(client,
          'SELECT created_at FROM mm_snapshot WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [user.id]);
        const stale = !last.rows.length ||
          (Date.now() - new Date(last.rows[0].created_at).getTime()) > 6 * 3600 * 1000;
        if (stale) {
          await query(client,
            `INSERT INTO mm_snapshot (id, user_id, label, device, byte_size, txn_count, checksum, payload, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [uid(), user.id, 'automatic', device, Buffer.byteLength(json), data.txns.length, sha(json), json, nowIso()]
          ).catch(() => {});
          await query(client,
            `DELETE FROM mm_snapshot WHERE user_id = $1 AND id NOT IN (
               SELECT id FROM mm_snapshot WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
            [user.id, KEEP_SNAPSHOTS]).catch(() => {});
        }
        return send(res, 200, { rev: nextRev, savedAt: nowIso(), transactions: data.txns.length, bytes: Buffer.byteLength(json) });
      }

      /* ---- identity ---- */
      if (route === 'me' && method === 'GET') {
        /* Kept as a plain aggregate rather than a scalar subquery: drivers and
           Postgres-compatible engines differ on how they type the latter, and
           the app prints this number straight into a message. */
        const counts = await query(client,
          'SELECT COUNT(*)::int AS snapshots FROM mm_snapshot WHERE user_id = $1', [user.id]);
        const last = await query(client,
          `SELECT id, created_at, byte_size, txn_count, device FROM mm_snapshot
            WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [user.id]);
        const payload = last.rows.length ? await latestPayload(client, user.id) : null;
        return send(res, 200, {
          email: user.email,
          name: user.name,
          counts: {
            snapshots: Number(counts.rows[0].snapshots) || 0,
            transactions: payload && payload.txns ? payload.txns.length : 0,
            accounts: payload && payload.accounts ? payload.accounts.length : 0
          },
          lastSnapshot: last.rows[0] || null
        });
      }

      /* ---- push ---- */
      if (route === 'backup' && method === 'POST') {
        let body;
        try { body = (await readJsonBody(req)) || {}; }
        catch (e) {
          return send(res, 400, { error: 'The backup could not be read. Nothing was saved.', detail: String(e.message) });
        }
        const payload = body.payload;
        const bad = documentProblem(payload);
        if (bad) return send(res, 422, { error: bad, code: 'bad_document' });
        const json = JSON.stringify(payload);
        const snap = {
          id: uid(),
          label: String(body.label || 'Backup').slice(0, 120),
          device: String(body.device || device).slice(0, 120),
          bytes: Buffer.byteLength(json),
          txns: payload.txns.length,
          checksum: sha(json),
          createdAt: nowIso()
        };
        await query(client, 'BEGIN', []);
        try {
          await query(client,
            `INSERT INTO mm_snapshot (id, user_id, label, device, byte_size, txn_count, checksum, payload, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [snap.id, user.id, snap.label, snap.device, snap.bytes, snap.txns, snap.checksum, json, snap.createdAt]);
          await query(client,
            `DELETE FROM mm_snapshot WHERE user_id = $1 AND id NOT IN (
               SELECT id FROM mm_snapshot WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
            [user.id, KEEP_SNAPSHOTS]);
          await query(client,
            `INSERT INTO mm_sync_log (user_id, direction, device, txn_count, byte_size, outcome, created_at)
             VALUES ($1,'push',$2,$3,$4,'ok',$5)`,
            [user.id, snap.device, snap.txns, snap.bytes, snap.createdAt]);
          await query(client, 'COMMIT', []);
        } catch (err) {
          await query(client, 'ROLLBACK', []).catch(() => {});
          throw err;
        }
        return send(res, 200, {
          id: snap.id, createdAt: snap.createdAt, bytes: snap.bytes,
          transactions: snap.txns, checksum: snap.checksum
        });
      }

      /* ---- pull ---- */
      if (route === 'backup/latest' && method === 'GET') {
        const { rows } = await query(client,
          `SELECT id, created_at, checksum, txn_count, byte_size, payload FROM mm_snapshot
            WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [user.id]);
        if (!rows.length) return send(res, 404, { error: 'No backup has been stored yet.' });
        const row = rows[0];
        await query(client,
          `INSERT INTO mm_sync_log (user_id, direction, device, txn_count, byte_size, outcome, created_at)
           VALUES ($1,'pull',$2,$3,$4,'ok',$5)`,
          [user.id, device, row.txn_count, row.byte_size, nowIso()]);
        return send(res, 200, {
          id: row.id, createdAt: row.created_at, checksum: row.checksum, payload: row.payload
        });
      }

      if (/^backup\/[^/]+$/.test(route) && method === 'GET') {
        const id = route.split('/')[1];
        const { rows } = await query(client,
          'SELECT id, created_at, checksum, payload FROM mm_snapshot WHERE user_id = $1 AND id = $2',
          [user.id, id]);
        if (!rows.length) return send(res, 404, { error: 'Snapshot not found.' });
        return send(res, 200, {
          id: rows[0].id, createdAt: rows[0].created_at, checksum: rows[0].checksum, payload: rows[0].payload
        });
      }

      /* ---- snapshot list / delete ---- */
      if (route === 'snapshots' && method === 'GET') {
        const { rows } = await query(client,
          `SELECT id, label, device, byte_size, txn_count, created_at FROM mm_snapshot
            WHERE user_id = $1 ORDER BY created_at DESC`, [user.id]);
        return send(res, 200, { snapshots: rows });
      }

      if (/^snapshots\/[^/]+$/.test(route) && method === 'DELETE') {
        const id = route.split('/')[1];
        const r = await query(client, 'DELETE FROM mm_snapshot WHERE user_id = $1 AND id = $2', [user.id, id]);
        if (!r.rowCount) return send(res, 404, { error: 'Snapshot not found.' });
        return send(res, 200, { deleted: id });
      }

      /* ---- read side, from the newest snapshot ---- */
      if (route === 'transactions' && method === 'GET') {
        const payload = await latestPayload(client, user.id);
        if (!payload) return send(res, 200, { transactions: [], limit: 0, offset: 0 });
        const q = req.query || {};
        const from = q.from || '0000-01-01';
        const to = q.to || '9999-12-31';
        const limit = Math.min(parseInt(q.limit || '500', 10) || 500, 5000);
        const offset = parseInt(q.offset || '0', 10) || 0;
        const accounts = {}, categories = {};
        (payload.accounts || []).forEach((a) => { accounts[a.id] = a.name; });
        (payload.categories || []).forEach((c) => { categories[c.id] = c.name; });
        const all = (payload.txns || [])
          .filter((t) => t.date >= from && t.date <= to)
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
        return send(res, 200, {
          total: all.length,
          limit, offset,
          transactions: all.slice(offset, offset + limit).map((t) => ({
            id: t.id, txn_date: t.date, kind: t.type, amount: +t.amount || 0,
            account_id: t.accountId, account_name: accounts[t.accountId] || null,
            to_account_id: t.toAccountId || null, to_account_name: accounts[t.toAccountId] || null,
            category_id: t.categoryId || null, category_name: categories[t.categoryId] || null,
            subcategory: t.sub || null, description: t.contents || '', details: t.details || '',
            payment_method: t.payment || '', reference: t.ref || '', notes: t.notes || '',
            tags: t.tags || [], reconciled: !!t.reconciled
          }))
        });
      }

      if (route === 'balances' && method === 'GET') {
        const payload = await latestPayload(client, user.id);
        if (!payload) return send(res, 200, { accounts: [], netWorth: 0 });
        return send(res, 200, balancesFrom(payload));
      }

      if (route === 'sync-log' && method === 'GET') {
        const { rows } = await query(client,
          'SELECT * FROM mm_sync_log WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [user.id]);
        return send(res, 200, { entries: rows });
      }

      return send(res, 404, { error: 'No such endpoint.' });
    });
  } catch (err) {
    sendSafeError(res, err);
  }
};

/* The single exit for every failure.
   A browser only ever receives: a status, a whole-sentence message, and a
   machine-readable code.  Raw driver text, SQL, connection strings, stack
   traces and environment values stay in the server log.  An error is only
   quoted to the user if it was raised deliberately with appError() or carries
   an explicit status — anything else is a bug and reads as a generic 500. */
function sendSafeError(res, err) {
  const status = err && err.status ? err.status : 500;
  const raw = String((err && err.message) || '');

  if (status === 500 || !(err && (err.safe || err.status))) {
    /* Full detail to the server console: that is the developer diagnostic,
       and on Vercel it is the function log. Never the response. */
    console.error('money-manager api:', scrub((err && err.stack) || raw));
  }

  /* A database that cannot store the text we send is worth naming, because
     "something went wrong" would send someone hunting for hours.  The message
     describes the encoding, not the connection. */
  if (/has no equivalent in encoding|invalid byte sequence|character with byte sequence/i.test(raw)) {
    return send(res, 500, {
      error: 'This database cannot store the characters the app uses (for example the ₹ sign). ' +
        'It needs to be created with UTF8 encoding — most hosted Postgres already is. ' +
        'Check GET /api/health for the encoding it reports.',
      code: 'db_encoding'
    });
  }

  const body = {
    error: (err && err.safe) || (err && err.status && status !== 500)
      ? raw
      : 'Something went wrong on the server. Nothing was saved.',
    code: (err && err.code) || (status === 500 ? 'server_error' : 'request_error')
  };
  /* Opt-in, never in production: the sanitised reason, for local debugging. */
  if (DIAGNOSTICS && !IS_PROD && err && err.detail) body.detail = scrub(err.detail);
  send(res, status, body);
}

/* Pushes arrive gzipped, so the platform body cap applies to the compressed
   bytes.  Raising this does not raise Vercel's own 4.5 MB request limit — it
   only stops the runtime rejecting a large body before we see it. */
/* Take the body ourselves so a compressed push is not rejected by a default
   parser limit before the function sees it.  Vercel still enforces its own
   platform cap on the incoming request, which gzip keeps us well under. */
/* Nothing may escape as an unhandled rejection: that is what turns a small
   mistake into an opaque FUNCTION_INVOCATION_FAILED page with no message.
   Every failure leaves here as readable JSON instead. */
module.exports = async function handler(req, res) {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("money-manager api (unhandled):", scrub((err && err.stack) || err));
    try {
      sendSafeError(res, err);
    } catch (e) {
      try { res.statusCode = 500; res.end(String.fromCharCode(123) + JSON.stringify("error") + ":" + JSON.stringify("server error") + String.fromCharCode(125)); } catch (e2) { /* nothing left to do */ }
    }
  }
};

module.exports.config = { api: { bodyParser: false } };
