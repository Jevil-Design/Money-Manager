/* Money Manager — backup / restore / sync API, as a Vercel serverless function.
 *
 * This is the Vercel port of server/server.js.  The self-hosted version cannot
 * run here: it writes to disk at import, uses better-sqlite3 (a native addon
 * with a local database file) and calls app.listen(). Serverless functions get
 * a read-only filesystem, no persistent disk and must export a handler, so the
 * storage layer is Postgres and the whole API is this one file.
 *
 * Routes (all under /api/v1, identical shapes to the self-hosted server):
 *   GET    /health                 no auth — liveness + configuration report
 *   POST   /auth/google            exchange a Google access token for an API token
 *   GET    /me                     account + counts
 *   POST   /backup                 store a snapshot
 *   GET    /backup/latest          newest snapshot
 *   GET    /backup/:id             one snapshot
 *   GET    /snapshots              snapshot list (no payloads)
 *   DELETE /snapshots/:id          remove one snapshot
 *   GET    /transactions           read side, served from the newest snapshot
 *   GET    /balances               read side, served from the newest snapshot
 *   GET    /sync-log               recent push/pull activity
 *
 * Environment:
 *   POSTGRES_URL        required — any Postgres (Vercel/Neon, Supabase, RDS…)
 *   GOOGLE_CLIENT_ID    required for sign-in — the OAuth client the app uses
 *   ALLOWED_EMAILS      optional — comma-separated allowlist. See claimAccount().
 *   KEEP_SNAPSHOTS      optional — how many snapshots to retain (default 40)
 *   CORS_ORIGIN         optional — defaults to * (every route is token-checked)
 *   PGSSL_NO_VERIFY     optional — set to 1 only if your provider uses a
 *                       certificate Node does not trust
 */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { Client } = require('pg');

const KEEP_SNAPSHOTS = Math.max(1, parseInt(process.env.KEEP_SNAPSHOTS || '40', 10));
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomBytes(9).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');

/* ------------------------------------------------------------------ storage */

function connectionString() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING || '';
}

/* One short-lived client per invocation.  Serverless containers are frozen
   between requests, so a long-lived pool would hold sockets the database has
   already dropped; connecting per request is the reliable pattern. */
async function withDb(fn) {
  const url = connectionString();
  if (!url) {
    const err = new Error('No database is configured. Set POSTGRES_URL in the Vercel project settings.');
    err.status = 503;
    throw err;
  }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const client = new Client({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' },
    connectionTimeoutMillis: 8000,
    query_timeout: 20000
  });
  await client.connect();
  try {
    await ensureSchema(client);
    return await fn(client);
  } finally {
    try { await client.end(); } catch (e) { /* the socket is going away anyway */ }
  }
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
`;

/* The tables are created on first use rather than by a separate migration
   step, so deploying needs nothing but a connection string.  Every statement
   is IF NOT EXISTS, so it is safe to run concurrently from several containers.
   `schemaReady` keeps it to once per warm container. */
let schemaReady = false;
async function ensureSchema(client) {
  if (schemaReady) return;
  await client.query(SCHEMA);
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

function send(res, status, body) {
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

async function authenticate(client, req) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-token'] || '';
  if (!token) {
    const e = new Error('Missing API token.'); e.status = 401; throw e;
  }
  const { rows } = await query(client, 'SELECT * FROM mm_user WHERE token_hash = $1', [sha(String(token))]);
  if (!rows.length) {
    const e = new Error('That API token is not recognised.'); e.status = 401; throw e;
  }
  return rows[0];
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

  const { rows } = await query(client, 'SELECT id FROM mm_user WHERE email = $1', [info.email]);
  if (!rows.length && !(await claimAccount(client, info.email))) {
    return send(res, 403, {
      error: 'This server is not open to ' + info.email +
        '. Add the address to ALLOWED_EMAILS in the Vercel project settings to let it in.'
    });
  }

  /* Issue (and rotate) this server's own bearer token for the account. */
  const apiToken = crypto.randomBytes(24).toString('base64url');
  const ts = nowIso();
  if (rows.length) {
    await query(client,
      'UPDATE mm_user SET token_hash = $1, name = $2, updated_at = $3 WHERE id = $4',
      [sha(apiToken), info.name || '', ts, rows[0].id]);
  } else {
    await query(client,
      'INSERT INTO mm_user (id, email, name, token_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(), info.email, info.name || '', sha(apiToken), ts, ts]);
  }
  send(res, 200, { token: apiToken, email: info.email, name: info.name || '', expiresIn: null });
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

/* --------------------------------------------------------------- the handler */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device, X-Api-Token, X-Mm-Encoding');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  /* /api/v1/backup/latest -> ['backup','latest'] */
  const parts = (req.query && req.query.path) || [];
  const segs = (Array.isArray(parts) ? parts : [parts]).filter(Boolean);
  if (segs[0] === 'v1') segs.shift();
  const route = segs.join('/');
  const method = req.method || 'GET';

  /* Health is answered without touching the database so it stays useful when
     the database is the thing that is broken. */
  if (route === 'health' && method === 'GET') {
    let dbOk = false, dbError = null;
    try { await withDb(async (c) => { await c.query('SELECT 1'); }); dbOk = true; }
    catch (e) { dbError = e.message; }
    return send(res, dbOk ? 200 : 503, {
      ok: dbOk,
      service: 'money-manager-server',
      runtime: 'vercel-serverless',
      time: nowIso(),
      database: dbOk ? 'connected' : 'unavailable',
      databaseError: dbError,
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

      const user = await authenticate(client, req);
      const device = String(req.headers['x-device'] || 'unknown').slice(0, 120);

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
        if (!payload || !Array.isArray(payload.accounts) || !Array.isArray(payload.txns)) {
          return send(res, 422, { error: 'Payload must contain accounts[] and txns[].' });
        }
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
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error('money-manager api:', err && err.message);
    /* Never leak a connection string or SQL in an error shown to a browser. */
    send(res, status, {
      error: status === 500
        ? 'Something went wrong on the server. Nothing was saved.'
        : err.message
    });
  }
};

/* Pushes arrive gzipped, so the platform body cap applies to the compressed
   bytes.  Raising this does not raise Vercel's own 4.5 MB request limit — it
   only stops the runtime rejecting a large body before we see it. */
/* Take the body ourselves so a compressed push is not rejected by a default
   parser limit before the function sees it.  Vercel still enforces its own
   platform cap on the incoming request, which gzip keeps us well under. */
module.exports.config = { api: { bodyParser: false } };
