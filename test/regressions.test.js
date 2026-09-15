/* Bugs found by audit, and the checks that keep them dead.
 *
 * Each block below names a defect that was actually in the shipped code, says
 * what it did, and pins the behaviour that replaced it. Nothing here is
 * speculative: every one of these failed before the fix.
 *
 *   node test/regressions.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const APP = path.join(__dirname, '..', 'Money Manager.dc.html');
const API = path.join(__dirname, '..', 'api', 'index.js');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

const src = fs.readFileSync(APP, 'utf8')
  .match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }
};
global.window = { addEventListener() {}, removeEventListener() {}, indexedDB: null };
global.document = { addEventListener() {}, removeEventListener() {} };
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'regressions' }, configurable: true, writable: true
});
class StubLogic {
  constructor(p) { this.props = p || {}; this.state = {}; }
  setState(patch, cb) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); }
  forceUpdate() {}
}
const { Component, mmAddM, mmInr, mmNewUserDb } = new Function(
  'DCLogic', 'StreamableLogic', 'React',
  src + '\n;return { Component, mmAddM, mmInr, mmNewUserDb };')(StubLogic, StubLogic, {});

function book() {
  const c = new Component({});
  c.state.db = mmNewUserDb(false);
  c.persist = () => {};
  c.flash = (m) => { c.lastFlash = m; };
  c.flashUndo = (m) => { c.lastFlash = m; };
  c.state.db.accounts = [
    { id: 'bank', name: 'Bank', type: 'bank', opening: 100000, currency: 'INR', archived: false, createdAt: 1, updatedAt: 1 }
  ];
  c.state.auth = { phase: 'ready' };
  c.bumpRev();
  return c;
}

/* ------------------------------------------------------------------------ */
console.log('\nmmAddM used to overflow past the end of a short month');
{
  /* setMonth() alone turns 31 January + 1 month into 3 March, because 31
     February rolls forward. That silently skipped a month in loan schedules,
     recurring dates and the NAV period windows. */
  const cases = [
    ['2026-01-31', 1, '2026-02-28'], ['2026-03-31', -1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'], ['2026-08-31', 1, '2026-09-30'],
    ['2026-05-31', -3, '2026-02-28'], ['2026-01-30', 1, '2026-02-28'],
    ['2026-01-31', 12, '2027-01-31'], ['2026-12-31', 1, '2027-01-31'],
    ['2026-06-15', 1, '2026-07-15'], ['2026-06-15', -1, '2026-05-15']
  ];
  cases.forEach(([from, n, want]) => {
    ok(from + ' + ' + n + ' month(s) = ' + want, mmAddM(from, n) === want, mmAddM(from, n));
  });
  ok('the day of the month is kept when it fits',
    mmAddM('2026-01-15', 1) === '2026-02-15', mmAddM('2026-01-15', 1));
  ok('a nonsense step is treated as none', mmAddM('2026-06-15', 'x') === '2026-06-15',
    mmAddM('2026-06-15', 'x'));
}

console.log('\nA loan starting on the 31st gets a month per instalment');
{
  const c = book();
  c.mutate((db) => {
    db.loans = [{
      id: 'l1', name: 'Home', principal: 1200000, rate: 9, tenure: 12,
      start: '2026-01-31', accountId: '', paid: 0, fees: 0, status: 'active',
      createdAt: 1, updatedAt: 1
    }];
  });
  const rows = c.schedule(c.state.db.loans[0]).rows;
  const dates = rows.map((r) => r.date);
  ok('every instalment has a real date', dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    dates.slice(0, 4).join(', '));
  ok('they are in order', dates.every((d, i) => i === 0 || d > dates[i - 1]), dates.slice(0, 4).join(', '));
  const months = dates.map((d) => d.slice(0, 7));
  ok('there is exactly one per month', new Set(months).size === 12, months.join(','));
  ok('February is not skipped', months[1] === '2026-02', months.slice(0, 3).join(','));
  ok('and February lands on the 28th, not the 3rd of March', dates[1] === '2026-02-28', dates[1]);
  ok('the schedule still closes the principal',
    Math.abs(rows[rows.length - 1].balance) < 1, rows[rows.length - 1].balance);
}

console.log('\nA recurring entry on the 31st offers one instalment a month');
{
  const c = book();
  const cat = c.state.db.categories.find((x) => x.type === 'expense');
  c.mutate((db) => {
    db.recurring = [{
      id: 'r1', desc: 'Rent', type: 'expense', accountId: 'bank', toAccountId: '',
      categoryId: cat.id, sub: '', amount: 1000, freq: 'monthly', next: '2026-01-31',
      end: '', count: 0, posted: 0, postedDates: [], status: 'active',
      payment: 'Bank Transfer', createdAt: 1, updatedAt: 1
    }];
  });
  const pending = c.recurPending(c.state.db.recurring[0], '2026-06-30');
  ok('six months owe six instalments', pending.length === 6, JSON.stringify(pending));
  const months = pending.map((d) => d.slice(0, 7));
  ok('one per month, none skipped', new Set(months).size === 6, months.join(','));
  ok('February clamps to the 28th', pending[1] === '2026-02-28', pending[1]);
}

console.log('\nPosting a recurring entry twice books it once');
{
  const c = book();
  const cat = c.state.db.categories.find((x) => x.type === 'expense');
  c.mutate((db) => {
    db.recurring = [{
      id: 'r1', desc: 'Rent', type: 'expense', accountId: 'bank', toAccountId: '',
      categoryId: cat.id, sub: '', amount: 1000, freq: 'monthly', next: '2026-01-15',
      end: '', count: 0, posted: 0, postedDates: [], status: 'active',
      payment: 'Bank Transfer', createdAt: 1, updatedAt: 1
    }];
  });
  /* The row hands over the object it was drawn with. mutate() clones the book
     on every change, so that object is stale the moment the first click lands
     — which is exactly what a fast double-click sends a second time. */
  const stale = c.state.db.recurring[0];
  c.postRecur(stale, '2026-01-15');
  const after1 = c.state.db.txns.length;
  ok('the first click posts it', after1 === 1, after1);

  c.postRecur(stale, '2026-01-15');
  ok('the second click posts nothing', c.state.db.txns.length === 1, c.state.db.txns.length);
  ok('and says why', /already been posted/i.test(c.lastFlash || ''), c.lastFlash);
  ok('the count is not inflated either', (+c.state.db.recurring[0].posted || 0) === 1,
    c.state.db.recurring[0].posted);
  ok('the bank was debited once', c.balances().bank.balance === 99000, c.balances().bank.balance);

  /* The next one along still posts normally. */
  c.postRecur(c.state.db.recurring[0], '2026-02-15');
  ok('a different instalment still posts', c.state.db.txns.length === 2, c.state.db.txns.length);

  /* A deleted entry cannot be posted from a stale row. */
  c.mutate((db) => { db.recurring = []; });
  c.postRecur(stale, '2026-03-15');
  ok('a deleted entry posts nothing', c.state.db.txns.length === 2, c.state.db.txns.length);
  ok('and says so', /no longer there/i.test(c.lastFlash || ''), c.lastFlash);
}

console.log('\nThe data check no longer says "everything checks out" when it does not');
{
  const c = book();
  const cat = c.state.db.categories[0];
  c.mutate((db) => {
    db.txns = [{
      id: 't1', date: '2026-06-15', type: 'expense', accountId: 'bank',
      categoryId: cat.id, sub: '', amount: 100, contents: '', tags: []
    }];
    db.categories = db.categories.filter((x) => x.id !== cat.id);
  });
  c.checkIntegrity();
  const note = (c.state.dlg && c.state.dlg.note) || '';
  /* Before: the category was set, so it was not "uncategorised"; and the
     wrong-side check was guarded by `catIds[id] &&`, which is false for a
     category that is gone. It fell through both arms and was reported as
     nothing at all — the check claimed every reference resolved. */
  ok('a transaction on a deleted category is reported',
    /category that no longer exists/i.test(note), note.slice(0, 160));
  ok('and it does not claim everything checks out',
    !/Everything checks out/i.test(note), note.slice(0, 120));

  /* The checks either side of it still work. */
  const c2 = book();
  c2.mutate((db) => {
    db.txns = [{ id: 't1', date: '2026-06-15', type: 'expense', accountId: 'bank', categoryId: '', sub: '', amount: 100, contents: '', tags: [] }];
  });
  c2.checkIntegrity();
  ok('an uncategorised row is still reported',
    /uncategorised/i.test((c2.state.dlg && c2.state.dlg.note) || ''),
    ((c2.state.dlg && c2.state.dlg.note) || '').slice(0, 120));

  const c3 = book();
  const inc = c3.state.db.categories.find((x) => x.type === 'income');
  c3.mutate((db) => {
    db.txns = [{ id: 't1', date: '2026-06-15', type: 'expense', accountId: 'bank', categoryId: inc.id, sub: '', amount: 100, contents: '', tags: [] }];
  });
  c3.checkIntegrity();
  ok('a category from the wrong side is still reported',
    /other side of the books/i.test((c3.state.dlg && c3.state.dlg.note) || ''),
    ((c3.state.dlg && c3.state.dlg.note) || '').slice(0, 120));

  const c4 = book();
  c4.checkIntegrity();
  ok('a clean book still reports clean',
    /Everything checks out/i.test((c4.state.dlg && c4.state.dlg.note) || ''),
    ((c4.state.dlg && c4.state.dlg.note) || '').slice(0, 120));
}

console.log('\nEMI never comes back as Infinity');
{
  const c = book();
  /* The loan dialog recomputes the EMI on every keystroke. While the tenure
     box is empty it used to divide by (1+r)^0 - 1, which is zero. */
  ok('no tenure means no instalment', c.emi(100000, 9, 0) === 0, c.emi(100000, 9, 0));
  ok('an empty tenure is the same', c.emi(100000, 9, '') === 0, c.emi(100000, 9, ''));
  ok('a negative tenure too', c.emi(100000, 9, -5) === 0, c.emi(100000, 9, -5));
  ok('a 0% loan divides the principal evenly', Math.abs(c.emi(120000, 0, 12) - 10000) < 0.01,
    c.emi(120000, 0, 12));
  ok('a normal loan is unchanged', Math.abs(c.emi(1200000, 9, 12) - 104941.77) < 0.01,
    c.emi(1200000, 9, 12));
  [[0, 0, 0], [0, 9, 12], [1e9, 100, 600], [-1000, 9, 12], [1000, 1e6, 12]].forEach(([p, r, n]) => {
    const v = c.emi(p, r, n);
    ok('emi(' + p + ', ' + r + ', ' + n + ') is a finite number', isFinite(v), v);
  });
}

console.log('\nNo amount renders as "1e,+21.undefined"');
{
  /* toFixed switches to exponential past about 1e21 and then has no decimal
     point, so splitting on "." left the paise undefined. */
  [1e21, -1e21, 1e30, Number.MAX_SAFE_INTEGER, 1e15, 0, -0, NaN, Infinity, -Infinity,
    null, undefined, '', 'abc'].forEach((n) => {
    const s = mmInr(n);
    ok('mmInr(' + String(n) + ') is a clean figure', !/NaN|undefined|Infinity|e\+/.test(s), s);
  });
  ok('normal amounts are untouched', mmInr(12345678) === '₹1,23,45,678.00', mmInr(12345678));
  ok('paise are kept', mmInr(1234.5) === '₹1,234.50', mmInr(1234.5));
  ok('and a huge one still ends in paise', /\.00$/.test(mmInr(1e21)), mmInr(1e21));
}

/* ----------------------------------------------------------------- server */

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const mmpath = u.pathname.replace(/^\/api\/?/, '');
      req.url = '/api/index?mmpath=' + encodeURIComponent(mmpath) +
        (u.search ? '&' + u.search.slice(1) : '');
      req.query = Object.assign({ mmpath: mmpath }, Object.fromEntries(u.searchParams));
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function callRaw(port, method, p, buf, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': buf.length }, headers || {})
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    req.end(buf);
  });
}

(async () => {
  console.log('\nA gzip bomb cannot be inflated');
  {
    /* The route cannot be driven end to end here: without a database the
       handler answers 503 before it ever reads a body, so the inflation path
       is unreachable in this harness. What can be pinned is that every place
       the server inflates goes through the capped helper, and that the cap it
       uses actually refuses a bomb — which together are the whole fix. */
    const api = fs.readFileSync(API, 'utf8');

    const bare = (api.match(/zlib\.gunzipSync\s*\(/g) || []).length;
    const helper = (api.match(/const gunzipCapped = \(buf\) => zlib\.gunzipSync\(buf, \{ maxOutputLength/g) || []).length;
    ok('there is one capped gunzip helper', helper === 1, helper);
    ok('and nothing else inflates without a cap', bare === 1, bare + ' raw gunzipSync call(s)');
    ok('every inflation site uses the helper',
      (api.match(/gunzipCapped\(/g) || []).length >= 2,
      (api.match(/gunzipCapped\(/g) || []).length);

    const capMatch = api.match(/const MAX_INFLATED = ([^;]+);/);
    ok('the cap is declared', !!capMatch, capMatch && capMatch[1]);
    const cap = capMatch ? Function('return (' + capMatch[1] + ')')() : 0;
    ok('the cap is a finite, sane size', isFinite(cap) && cap > 0 && cap <= 256 * 1024 * 1024, cap);
    ok('and it is larger than the largest body that can arrive', cap >= 48 * 1024 * 1024, cap);

    /* The cap, exercised. 200 MB of zeros travels in about 200 KB. */
    const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024, 0));
    ok('the bomb really is small on the wire', bomb.length < 1024 * 1024,
      (bomb.length / 1024).toFixed(0) + ' KB on the wire, 200 MB inflated');
    let refused = false;
    try { zlib.gunzipSync(bomb, { maxOutputLength: cap }); }
    catch (e) { refused = e.code === 'ERR_BUFFER_TOO_LARGE'; }
    ok('the cap refuses it', refused);
    ok('and without the cap it would have inflated in full',
      zlib.gunzipSync(bomb).length === 200 * 1024 * 1024);

    /* A real book must not be what the cap catches: 10,000 transactions is
       about 4.5 MB of JSON, which the app gzips before sending. */
    const real = zlib.gzipSync(Buffer.from(JSON.stringify({
      data: { accounts: [], txns: new Array(10000).fill({ id: 'x', date: '2026-01-01', type: 'expense', amount: 1, contents: 'a transaction like any other' }) }
    })));
    let inflated = null;
    try { inflated = zlib.gunzipSync(real, { maxOutputLength: cap }); } catch (e) { inflated = null; }
    ok('a real book of 10,000 transactions still inflates', !!inflated,
      inflated ? (inflated.length / 1024 / 1024).toFixed(1) + ' MB' : 'refused');
  }

  console.log('\nThe server never hands back a raw error');
  {
    const api = fs.readFileSync(API, 'utf8');
    const unscrubbed = api.split('\n').map((l, i) => ({ n: i + 1, l }))
      .filter((x) => /detail:\s*String\((?:e|err)\.message\)/.test(x.l));
    ok('no error detail is sent without scrub()', unscrubbed.length === 0,
      unscrubbed.map((x) => x.n + ': ' + x.l.trim()).join(' | '));

    const handler = require(API);
    const server = await startServer(handler);
    const port = server.address().port;
    try {
      const r = await callRaw(port, 'POST', '/api/v1/auth/login', Buffer.from('not json at all'), {});
      ok('a malformed request never returns a stack trace',
        !/\bat \w+[^\n]*\.js:\d+/.test(r.raw), r.raw.slice(0, 160));
      ok('nor a connection string', !/postgres(?:ql)?:\/\//.test(r.raw), r.raw.slice(0, 160));
      ok('nor the name of an environment variable it reads',
        !/DATABASE_URL|PGPASSWORD/.test(r.raw), r.raw.slice(0, 160));
    } finally { server.close(); }
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
