/* Money Manager — backup / restore / sync server
 *
 *   npm install && npm run register -- you@example.com   # prints an API token
 *   npm start                                            # listens on :4000
 *
 * The client (Money Manager.dc.html → Settings → Cloud backup) needs only the
 * base URL and that token. Everything is stored in SQLite at DB_FILE; point
 * DB_FILE at a mounted volume on your storage server and backups persist there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 4000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'money-manager.db');
const FILES_DIR = process.env.FILES_DIR || path.join(__dirname, 'data', 'attachments');
const MAX_BODY = process.env.MAX_BODY || '64mb';
const KEEP_SNAPSHOTS = parseInt(process.env.KEEP_SNAPSHOTS || '40', 10);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(9).toString('hex');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'DELETE'] }));
app.use(express.json({ limit: MAX_BODY }));

/* ---------- Google sign-in (POST /api/v1/auth/google) ---------- */

require('./google-auth')(app, db);

/* ---------- auth ---------- */

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim() || req.get('x-api-token') || '';
  if (!token) return res.status(401).json({ error: 'Missing API token.' });
  const user = db.prepare('SELECT * FROM user WHERE token_hash = ?').get(hash(token));
  if (!user) return res.status(401).json({ error: 'That API token is not recognised.' });
  req.user = user;
  next();
}

/* ---------- health & identity ---------- */

app.get('/api/v1/health', (req, res) => {
  res.json({ ok: true, service: 'money-manager-server', time: now() });
});

app.get('/api/v1/me', auth, (req, res) => {
  const counts = db.prepare(
    `SELECT (SELECT COUNT(*) FROM txn WHERE user_id = ?)      AS transactions,
            (SELECT COUNT(*) FROM account WHERE user_id = ?)  AS accounts,
            (SELECT COUNT(*) FROM snapshot WHERE user_id = ?) AS snapshots`
  ).get(req.user.id, req.user.id, req.user.id);
  const last = db.prepare('SELECT created_at, byte_size, txn_count FROM snapshot WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
  res.json({ email: req.user.email, name: req.user.name, counts, lastSnapshot: last || null });
});

/* ---------- push: store a full client export ---------- */

app.post('/api/v1/backup', auth, (req, res) => {
  const payload = req.body && req.body.payload;
  if (!payload || !Array.isArray(payload.accounts) || !Array.isArray(payload.txns)) {
    return res.status(422).json({ error: 'Payload must contain accounts[] and txns[].' });
  }
  const json = JSON.stringify(payload);
  const snap = {
    id: uid(),
    user_id: req.user.id,
    label: (req.body.label || 'Backup').slice(0, 120),
    device: (req.body.device || 'unknown').slice(0, 120),
    byte_size: Buffer.byteLength(json),
    txn_count: payload.txns.length,
    checksum: hash(json),
    payload: json,
    created_at: now()
  };

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO snapshot (id, user_id, label, device, byte_size, txn_count, checksum, payload, created_at)
       VALUES (@id, @user_id, @label, @device, @byte_size, @txn_count, @checksum, @payload, @created_at)`
    ).run(snap);
    materialise(req.user.id, payload);
    db.prepare(
      `DELETE FROM snapshot WHERE user_id = ? AND id NOT IN
        (SELECT id FROM snapshot WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`
    ).run(req.user.id, req.user.id, KEEP_SNAPSHOTS);
    db.prepare(
      `INSERT INTO sync_log (user_id, direction, device, txn_count, byte_size, outcome, created_at)
       VALUES (?, 'push', ?, ?, ?, 'ok', ?)`
    ).run(req.user.id, snap.device, snap.txn_count, snap.byte_size, snap.created_at);
  });

  try {
    write();
    res.json({ id: snap.id, createdAt: snap.created_at, bytes: snap.byte_size, transactions: snap.txn_count, checksum: snap.checksum });
  } catch (err) {
    res.status(500).json({ error: 'The backup could not be stored. Nothing was changed.', detail: String(err.message) });
  }
});

/* ---------- pull: latest or a specific snapshot ---------- */

app.get('/api/v1/backup/latest', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM snapshot WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'No backup has been stored yet.' });
  db.prepare(`INSERT INTO sync_log (user_id, direction, device, txn_count, byte_size, outcome, created_at)
              VALUES (?, 'pull', ?, ?, ?, 'ok', ?)`).run(req.user.id, req.get('x-device') || 'unknown', row.txn_count, row.byte_size, now());
  res.json({ id: row.id, createdAt: row.created_at, checksum: row.checksum, payload: JSON.parse(row.payload) });
});

app.get('/api/v1/backup/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM snapshot WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!row) return res.status(404).json({ error: 'Snapshot not found.' });
  res.json({ id: row.id, createdAt: row.created_at, checksum: row.checksum, payload: JSON.parse(row.payload) });
});

app.get('/api/v1/snapshots', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, label, device, byte_size, txn_count, created_at FROM snapshot WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json({ snapshots: rows });
});

app.delete('/api/v1/snapshots/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM snapshot WHERE user_id = ? AND id = ?').run(req.user.id, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Snapshot not found.' });
  res.json({ deleted: req.params.id });
});

/* ---------- normalised read side (for reporting / other clients) ---------- */

app.get('/api/v1/transactions', auth, (req, res) => {
  const from = req.query.from || '0000-01-01';
  const to = req.query.to || '9999-12-31';
  const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(
    `SELECT t.*, a.name AS account_name, c.name AS category_name
       FROM txn t
       LEFT JOIN account a ON a.id = t.account_id
       LEFT JOIN category c ON c.id = t.category_id
      WHERE t.user_id = ? AND t.txn_date BETWEEN ? AND ?
      ORDER BY t.txn_date DESC, t.created_at DESC
      LIMIT ? OFFSET ?`
  ).all(req.user.id, from, to, limit, offset);
  res.json({ transactions: rows, limit, offset });
});

app.get('/api/v1/balances', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT a.id, a.name, a.type, a.opening,
            a.opening + COALESCE((SELECT SUM(l.delta) FROM transaction_line l WHERE l.account_id = a.id), 0) AS balance
       FROM account a WHERE a.user_id = ? AND a.archived = 0 ORDER BY a.sort_order, a.name`
  ).all(req.user.id);
  const netWorth = rows.reduce((n, r) => n + r.balance, 0);
  res.json({ accounts: rows, netWorth });
});

app.get('/api/v1/sync-log', auth, (req, res) => {
  res.json({ entries: db.prepare('SELECT * FROM sync_log WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id) });
});

/* ---------- attachments on the storage server ---------- */

app.post('/api/v1/attachments', auth, (req, res) => {
  const { txnId, fileName, mimeType, dataUrl } = req.body || {};
  if (!fileName || !dataUrl) return res.status(422).json({ error: 'fileName and dataUrl are required.' });
  const base64 = String(dataUrl).split(',').pop();
  const buf = Buffer.from(base64, 'base64');
  const id = uid();
  const key = `${req.user.id}/${id}-${fileName.replace(/[^\w.\-]/g, '_')}`;
  const target = path.join(FILES_DIR, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  db.prepare(
    `INSERT INTO attachment (id, user_id, txn_id, file_name, mime_type, byte_size, storage_key, checksum, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, txnId || null, fileName, mimeType || null, buf.length, key, hash(buf), now(), now());
  res.json({ id, storageKey: key, bytes: buf.length });
});

app.get('/api/v1/attachments/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM attachment WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!row) return res.status(404).json({ error: 'Attachment not found.' });
  res.sendFile(path.join(FILES_DIR, row.storage_key));
});

/* ---------- write the client export into the normalised tables ---------- */

function materialise(userId, p) {
  const del = (t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  db.prepare('DELETE FROM transaction_line WHERE account_id IN (SELECT id FROM account WHERE user_id = ?)').run(userId);
  ['txn', 'budget', 'recurring_transaction', 'credit_card', 'loan', 'savings_goal', 'tag'].forEach(del);
  db.prepare('DELETE FROM subcategory WHERE category_id IN (SELECT id FROM category WHERE user_id = ?)').run(userId);
  del('category');
  del('account');

  const ts = now();
  const insAcc = db.prepare(
    `INSERT INTO account (id, user_id, name, type, opening, currency_code, colour, icon, credit_limit, due_day, sort_order, archived, is_demo, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  (p.accounts || []).forEach((a, i) => insAcc.run(
    a.id, userId, a.name, a.type, +a.opening || 0, a.currency || 'INR', a.color || null, a.icon || null,
    a.limit == null ? null : +a.limit, a.dueDay == null ? null : +a.dueDay, i, a.archived ? 1 : 0, a.demo ? 1 : 0,
    a.createdAt ? new Date(a.createdAt).toISOString() : ts, ts
  ));

  const insCat = db.prepare(
    `INSERT INTO category (id, user_id, name, kind, icon, enabled, sort_order, is_demo, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const insSub = db.prepare('INSERT INTO subcategory (id, category_id, name, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)');
  (p.categories || []).forEach((c, i) => {
    insCat.run(c.id, userId, c.name, c.type, c.icon || null, c.enabled === false ? 0 : 1, i, c.demo ? 1 : 0,
      c.createdAt ? new Date(c.createdAt).toISOString() : ts, ts);
    (c.subs || []).forEach((s, j) => insSub.run(uid(), c.id, s, j, ts, ts));
  });

  const insTxn = db.prepare(
    `INSERT INTO txn (id, user_id, txn_date, kind, account_id, to_account_id, category_id, subcategory, amount,
                      contents, details, payment_method, notes, is_demo, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insLine = db.prepare('INSERT INTO transaction_line (id, txn_id, account_id, delta, created_at) VALUES (?,?,?,?,?)');
  const insTag = db.prepare('INSERT OR IGNORE INTO tag (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)');
  const getTag = db.prepare('SELECT id FROM tag WHERE user_id = ? AND name = ?');
  const linkTag = db.prepare('INSERT OR IGNORE INTO transaction_tag (txn_id, tag_id) VALUES (?,?)');
  const accountIds = new Set((p.accounts || []).map((a) => a.id));

  (p.txns || []).forEach((t) => {
    const amount = +t.amount || 0;
    insTxn.run(
      t.id, userId, t.date, t.type,
      accountIds.has(t.accountId) ? t.accountId : null,
      accountIds.has(t.toAccountId) ? t.toAccountId : null,
      t.categoryId || null, t.sub || null, amount, t.contents || null, t.details || null,
      t.payment || null, t.notes || null, t.demo ? 1 : 0,
      t.createdAt ? new Date(t.createdAt).toISOString() : ts, ts
    );
    // signed lines — the single source of truth for balances; a transfer nets to zero
    if (t.type === 'income' && accountIds.has(t.accountId)) insLine.run(uid(), t.id, t.accountId, amount, ts);
    if (t.type === 'expense' && accountIds.has(t.accountId)) insLine.run(uid(), t.id, t.accountId, -amount, ts);
    if (t.type === 'transfer') {
      if (accountIds.has(t.accountId)) insLine.run(uid(), t.id, t.accountId, -amount, ts);
      if (accountIds.has(t.toAccountId)) insLine.run(uid(), t.id, t.toAccountId, amount, ts);
    }
    (t.tags || []).forEach((name) => {
      insTag.run(uid(), userId, name, ts, ts);
      const tag = getTag.get(userId, name);
      if (tag) linkTag.run(t.id, tag.id);
    });
  });

  const insBud = db.prepare(
    `INSERT INTO budget (id, user_id, category_id, subcategory, period, amount, rollover, alert_pct, is_demo, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  (p.budgets || []).forEach((b) => insBud.run(b.id, userId, b.categoryId || null, b.sub || null, b.period || 'monthly',
    +b.amount || 0, b.rollover ? 1 : 0, +b.alert || 80, b.demo ? 1 : 0, ts, ts));

  const insRec = db.prepare(
    `INSERT INTO recurring_transaction (id, user_id, description, kind, amount, account_id, category_id, subcategory,
                                        frequency, start_date, end_date, next_date, status, is_demo, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  (p.recurring || []).forEach((r) => insRec.run(r.id, userId, r.desc, r.type, +r.amount || 0,
    accountIds.has(r.accountId) ? r.accountId : null, r.categoryId || null, r.sub || null, r.freq,
    r.start, r.end || null, r.next || null, r.status || 'active', r.demo ? 1 : 0, ts, ts));

  const insCard = db.prepare(
    `INSERT INTO credit_card (id, user_id, account_id, credit_limit, billing_day, due_day, interest_rate, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  (p.accounts || []).filter((a) => a.type === 'credit').forEach((a) => insCard.run(
    uid(), userId, a.id, +a.limit || 0, a.billingDay == null ? null : +a.billingDay,
    a.dueDay == null ? null : +a.dueDay, a.rate == null ? null : +a.rate, ts, ts
  ));

  const insLoan = db.prepare(
    `INSERT INTO loan (id, user_id, name, lender, principal, interest_rate, tenure_months, start_date, emis_paid, is_demo, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  (p.loans || []).forEach((l) => insLoan.run(l.id, userId, l.name, l.lender || null, +l.principal || 0,
    +l.rate || 0, +l.tenure || 0, l.start, +l.paid || 0, l.demo ? 1 : 0, ts, ts));

  const insGoal = db.prepare(
    `INSERT INTO savings_goal (id, user_id, name, target, saved, target_date, account_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  (p.goals || []).forEach((g) => insGoal.run(g.id, userId, g.name, +g.target || 0, +g.saved || 0,
    g.targetDate || null, accountIds.has(g.accountId) ? g.accountId : null, ts, ts));

  db.prepare(
    `INSERT INTO settings (user_id, data, created_at, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(p.settings || {}), ts, ts);
}

app.use((req, res) => res.status(404).json({ error: 'No such endpoint.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Nothing was saved.' });
});

app.listen(PORT, () => {
  console.log(`Money Manager server listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
  console.log(`Attachments: ${FILES_DIR}`);
});
