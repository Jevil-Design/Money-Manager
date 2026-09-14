/* Seal rows that were written before DATA_KEY existed.
 *
 * Turning encryption on is not a migration — reads accept both shapes, and a
 * row seals itself the next time it is written. But a book that is not edited
 * for months stays in the clear until then, and snapshots are never rewritten
 * at all. This walks the database once and seals whatever is still plain.
 *
 * Safe to run repeatedly: an already-sealed row is skipped. Nothing is
 * deleted, every row is verified by reading it back and decrypting before the
 * transaction commits, and the revision is untouched — this is a change of
 * storage, not an edit.
 *
 *   node scripts/encrypt-existing.js            # report only
 *   node scripts/encrypt-existing.js --apply    # actually seal
 *
 * Reads DATABASE_URL and DATA_KEY from the environment or .env.local. Use the
 * SAME DATA_KEY the deployment has, or it will seal rows the app cannot read:
 *   vercel env pull .env.local
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const API = path.join(__dirname, '..', 'api', 'index.js');
const ENV_FILE = path.join(__dirname, '..', '.env.local');

/* Load .env.local without overwriting anything already in the environment. */
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 0 || line.trim().startsWith('#')) continue;
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
if (!DB_URL) { console.error('No DATABASE_URL.'); process.exit(2); }
if (!process.env.DATA_KEY) { console.error('No DATA_KEY — nothing to seal rows with.'); process.exit(2); }

/* Use the app's own sealing, so what this writes is exactly what the running
   deployment writes and reads. */
const { sealDocument, openDocument, isEncrypted, DATA_KEY } =
  new Function('require', 'module', 'exports', '__filename', '__dirname',
    fs.readFileSync(API, 'utf8') +
    '\n;return { sealDocument, openDocument, isEncrypted, DATA_KEY };')(
    require, { exports: {} }, {}, API, path.dirname(API));

const { Client } = require('pg');

const TARGETS = [
  { table: 'mm_state', key: 'user_id', col: 'data' },
  { table: 'mm_snapshot', key: 'id', col: 'payload' }
];

(async () => {
  process.removeAllListeners('warning');
  const client = new Client({
    connectionString: DB_URL.replace(/[?&]sslmode=[^&]*/, ''),
    ssl: { rejectUnauthorized: true }
  });
  await client.connect();
  console.log('key id ' + DATA_KEY.kid + (APPLY ? '  — APPLYING' : '  — dry run, nothing will be written'));

  let totalPlain = 0, totalSealed = 0, totalDone = 0;

  for (const t of TARGETS) {
    const { rows } = await client.query(
      'SELECT ' + t.key + ' AS k, ' + t.col + ' AS v FROM ' + t.table);
    let plain = 0, sealed = 0, done = 0;

    for (const row of rows) {
      if (isEncrypted(row.v)) { sealed++; continue; }
      plain++;
      if (!APPLY) continue;

      /* One row, one transaction, verified before it commits. */
      await client.query('BEGIN');
      try {
        const payload = sealDocument(row.v);
        await client.query(
          'UPDATE ' + t.table + ' SET ' + t.col + ' = $1 WHERE ' + t.key + ' = $2',
          [payload, row.k]);
        const back = await client.query(
          'SELECT ' + t.col + ' AS v FROM ' + t.table + ' WHERE ' + t.key + ' = $1', [row.k]);
        const reopened = openDocument(back.rows[0].v);
        /* Byte-for-byte, or it does not commit. */
        if (JSON.stringify(reopened) !== JSON.stringify(row.v)) {
          throw new Error('round trip did not match for ' + t.table + ' ' + row.k);
        }
        await client.query('COMMIT');
        done++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('  FAILED ' + t.table + ' ' + row.k + ': ' + err.message);
        console.error('  rolled back; nothing was changed for that row');
        await client.end();
        process.exit(1);
      }
    }
    console.log('  ' + t.table.padEnd(12) + rows.length + ' rows | already sealed ' + sealed +
      ' | plain ' + plain + (APPLY ? ' | sealed now ' + done : ''));
    totalPlain += plain; totalSealed += sealed; totalDone += done;
  }

  if (!APPLY) {
    console.log('\n' + totalPlain + ' row(s) would be sealed. Re-run with --apply.');
  } else {
    console.log('\nsealed ' + totalDone + ' row(s); ' + totalSealed + ' were already sealed.');
  }
  await client.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
