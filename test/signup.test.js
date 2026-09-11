/* Who may create an account, and the limits that make open registration
 * survivable on a public URL.
 *
 * pg is stubbed with enough of a database to let registration complete, so
 * this needs no real one.
 *
 *   node test/signup.test.js
 */
'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const API = path.join(__dirname, '..', 'api', 'index.js');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* ------------------------------------------------ an in-memory stand-in DB */

function makeDb(seedUsers) {
  const state = {
    users: (seedUsers || []).slice(),
    rate: [],            /* { bucket, at } */
    created: []
  };
  class FakeClient {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();

      if (/^(BEGIN|COMMIT|ROLLBACK|SELECT 1)$/i.test(s)) return { rows: [], rowCount: 0 };
      if (/CREATE TABLE|ALTER TABLE|CREATE INDEX|CREATE UNIQUE INDEX/i.test(s)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO mm_meta/i.test(s)) return { rows: [], rowCount: 1 };
      if (/pg_encoding_to_char/.test(s)) return { rows: [{ enc: 'UTF8' }], rowCount: 1 };
      if (/FROM mm_meta/.test(s)) return { rows: [{ value: '5' }], rowCount: 1 };

      /* rate limiting */
      if (/COUNT\(\*\)::int AS n FROM mm_rate/.test(s)) {
        const bucket = params[0], mins = Number(params[1]);
        const since = Date.now() - mins * 60000;
        const n = state.rate.filter((r) => r.bucket === bucket && r.at > since).length;
        return { rows: [{ n }], rowCount: 1 };
      }
      if (/INSERT INTO mm_rate/.test(s)) {
        state.rate.push({ bucket: params[0], at: Date.now() });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM mm_rate/.test(s)) return { rows: [], rowCount: 0 };

      /* accounts */
      if (/COUNT\(\*\)::int AS n FROM mm_user/.test(s)) {
        return { rows: [{ n: state.users.length }], rowCount: 1 };
      }
      if (/SELECT id FROM mm_user WHERE lower\(email\)/.test(s)) {
        const u = state.users.find((x) => x.email.toLowerCase() === params[0]);
        return { rows: u ? [{ id: u.id }] : [], rowCount: u ? 1 : 0 };
      }
      if (/INSERT INTO mm_user/.test(s)) {
        const u = { id: params[0], email: params[1], name: params[2], created_at: new Date().toISOString() };
        state.users.push(u);
        state.created.push(u);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT \* FROM mm_user WHERE id/.test(s)) {
        const u = state.users.find((x) => x.id === params[0]);
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (/INSERT INTO mm_state|INSERT INTO mm_token|DELETE FROM mm_token/.test(s)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }
  class FakePool {
    on() { return this; }
    async connect() { return new FakeClient(); }
    async end() {}
  }
  return { state, module: { Pool: FakePool, Client: FakeClient } };
}

let currentFakePg = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return currentFakePg;
  return origLoad.apply(this, arguments);
};

const ENV_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'AUTH_SECRET', 'ALLOWED_EMAILS',
  'ALLOW_SIGNUPS', 'MAX_ACCOUNTS', 'SIGNUP_LIMIT_TRIES', 'SIGNUP_LIMIT_IP_HOUR',
  'SIGNUP_LIMIT_IP_DAY', 'SIGNUP_LIMIT_HOUR', 'MM_DIAGNOSTICS', 'RESEND_API_KEY', 'MAIL_FROM'];

function loadApi(fake, env) {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env || {});
  currentFakePg = fake;
  delete require.cache[require.resolve(API)];
  return require(API);
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const mmpath = u.pathname.replace(/^\/api\/?/, '');
      req.url = '/api/index?mmpath=' + encodeURIComponent(mmpath);
      req.query = { mmpath };
      req.headers['x-forwarded-proto'] = 'https';
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        headers || {})
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { /* raw only */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const DB = 'postgres://u:pw@db.example.org:5432/mm?sslmode=require';
let n = 0;
const reg = (extra) => Object.assign({
  name: 'Person', email: 'p' + (++n) + '@example.com',
  password: 'abcdefg1', password2: 'abcdefg1'
}, extra || {});
/* Vercel's edge sets this and overwrites whatever the client sent. */
const from = (ip) => ({ 'x-vercel-forwarded-for': ip });

(async () => {

  /* ------------------------------------------------------------------ 1 */
  console.log('\nALLOW_SIGNUPS=open lets anyone in');
  {
    const db = makeDb([{ id: 'u0', email: 'owner@example.com', name: 'Owner' }]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open' }));
    const port = server.address().port;

    const r = await call(port, 'POST', '/api/v1/auth/register', reg(), from('203.0.113.10'));
    ok('a stranger can create an account', r.status === 200 && !!r.body.token,
      'HTTP ' + r.status + ' ' + r.raw.slice(0, 140));
    ok('they get their own starting document', r.body.state && r.body.state.rev === 1);
    ok('an account already existing does not block them', db.state.users.length === 2);

    const h = await call(port, 'GET', '/api/health');
    ok('health reports signups as open', h.body.signups === 'open', h.body.signups);
    ok('and describes the policy in words', h.body.accessPolicy === 'anyone may register',
      h.body.accessPolicy);
    ok('and publishes the limits', h.body.signupLimits && h.body.signupLimits.perCallerPerHour === 3,
      JSON.stringify(h.body.signupLimits));
    server.close();
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\nALLOW_SIGNUPS=closed shuts it completely');
  {
    const db = makeDb([{ id: 'u0', email: 'owner@example.com', name: 'Owner' }]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'closed' }));
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/v1/auth/register', reg(), from('203.0.113.11'));
    ok('nobody can register', r.status === 403 && r.body.code === 'not_allowed',
      'HTTP ' + r.status + ' ' + JSON.stringify(r.body));
    ok('not even an address on the allowlist', (await call(port, 'POST', '/api/v1/auth/register',
      reg({ email: 'owner2@example.com' }), from('203.0.113.11'))).status === 403);
    ok('no account was created', db.state.created.length === 0);
    const h = await call(port, 'GET', '/api/health');
    ok('health says closed', h.body.signups === 'closed', h.body.signups);
    ok('and reports no limits, since none apply', h.body.signupLimits === null);
    server.close();
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\nThe default is unchanged — the allowlist still rules');
  {
    const db = makeDb([{ id: 'u0', email: 'owner@example.com', name: 'Owner' }]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOWED_EMAILS: 'allowed@example.com' }));
    const port = server.address().port;
    const outsider = await call(port, 'POST', '/api/v1/auth/register', reg(), from('203.0.113.12'));
    ok('an address not on the list is refused', outsider.status === 403 &&
      outsider.body.code === 'not_allowed', 'HTTP ' + outsider.status);
    const insider = await call(port, 'POST', '/api/v1/auth/register',
      reg({ email: 'allowed@example.com' }), from('203.0.113.12'));
    ok('an address on the list is admitted', insider.status === 200, 'HTTP ' + insider.status);
    const h = await call(port, 'GET', '/api/health');
    ok('health says allowlist', h.body.signups === 'allowlist', h.body.signups);
    server.close();
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\nOne caller cannot farm accounts');
  {
    const db = makeDb([]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open' }));
    const port = server.address().port;
    const ip = from('198.51.100.7');

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push((await call(port, 'POST', '/api/v1/auth/register', reg(), ip)).status);
    }
    const made = results.filter((s) => s === 200).length;
    const blocked = results.filter((s) => s === 429).length;
    ok('the first few succeed', made === 3, 'created ' + made + ' of 6: ' + results.join(','));
    ok('the rest are throttled with 429', blocked === 3, results.join(','));
    ok('only the successful ones reached the database', db.state.created.length === 3,
      String(db.state.created.length));

    /* A different caller is unaffected — the limit is per caller. */
    const other = await call(port, 'POST', '/api/v1/auth/register', reg(), from('198.51.100.8'));
    ok('a different address is not caught by someone else\'s limit',
      other.status === 200, 'HTTP ' + other.status);
    server.close();
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\nHammering the endpoint is limited separately from succeeding');
  {
    /* Repeated attempts on an address that already exists: each is a 409, not
       an account, so the per-account limit never trips — the attempt limit is
       what has to stop it. */
    const db = makeDb([{ id: 'u0', email: 'taken@example.com', name: 'Owner' }]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open', SIGNUP_LIMIT_TRIES: '4' }));
    const port = server.address().port;
    const ip = from('198.51.100.9');
    const seen = [];
    for (let i = 0; i < 6; i++) {
      seen.push((await call(port, 'POST', '/api/v1/auth/register',
        reg({ email: 'taken@example.com' }), ip)).status);
    }
    ok('repeated attempts are eventually throttled',
      seen.filter((s) => s === 429).length === 2, seen.join(','));
    ok('and the earlier ones were answered honestly as 409',
      seen.filter((s) => s === 409).length === 4, seen.join(','));
    ok('no account was created by any of them', db.state.created.length === 0);
    server.close();
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\nA deployment-wide ceiling backs up the per-caller limits');
  {
    /* Abuse spread across many addresses is invisible to a per-caller limit. */
    const db = makeDb([]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open', SIGNUP_LIMIT_HOUR: '2' }));
    const port = server.address().port;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      /* A different address every time, so only the global limit can catch it. */
      seen.push((await call(port, 'POST', '/api/v1/auth/register', reg(), from('192.0.2.' + (10 + i)))).status);
    }
    ok('the deployment-wide hourly limit stops it', seen.join(',') === '200,200,429,429', seen.join(','));
    ok('and only the allowed number were created', db.state.created.length === 2,
      String(db.state.created.length));
    server.close();
  }
  {
    const db = makeDb([{ id: 'a', email: 'a@example.com' }, { id: 'b', email: 'b@example.com' }]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open', MAX_ACCOUNTS: '2' }));
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/v1/auth/register', reg(), from('192.0.2.50'));
    ok('MAX_ACCOUNTS is a hard ceiling', r.status === 403 && r.body.code === 'signup_full',
      'HTTP ' + r.status + ' ' + JSON.stringify(r.body));
    ok('nothing was created', db.state.created.length === 0);
    server.close();
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\nThe limit cannot be sidestepped by forging a header');
  {
    const db = makeDb([]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open' }));
    const port = server.address().port;

    /* Same real caller each time, but a different spoofed x-forwarded-for.
       Vercel's own header is what must be believed. */
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push((await call(port, 'POST', '/api/v1/auth/register', reg(), {
        'x-vercel-forwarded-for': '198.51.100.20',
        'x-forwarded-for': '10.0.0.' + i,
        'x-real-ip': '10.0.1.' + i
      })).status);
    }
    ok('a spoofed x-forwarded-for does not reset the limit',
      seen.filter((s) => s === 200).length === 3, seen.join(','));
    ok('the trustworthy header is the one that counts',
      seen.filter((s) => s === 429).length === 2, seen.join(','));
    server.close();
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\nWhat a throttled or refused caller is told');
  {
    const db = makeDb([]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open', SIGNUP_LIMIT_IP_HOUR: '1' }));
    const port = server.address().port;
    const ip = from('198.51.100.30');
    await call(port, 'POST', '/api/v1/auth/register', reg(), ip);
    const blocked = await call(port, 'POST', '/api/v1/auth/register', reg(), ip);
    ok('the refusal is a 429', blocked.status === 429, String(blocked.status));
    ok('it reads as temporary, not as a rejection of them',
      /try again later/i.test(blocked.body.error), blocked.body.error);
    ok('it names no limit, variable or address',
      !/SIGNUP_LIMIT|ALLOW_SIGNUPS|198\.51\.100|bucket|mm_rate/i.test(blocked.raw),
      blocked.raw.slice(0, 200));
    ok('and no stack trace or SQL', !/\bat \w|SELECT |INSERT /.test(blocked.raw));
    server.close();
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\nOpen registration still refuses bad input');
  {
    const db = makeDb([]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open' }));
    const port = server.address().port;
    const ip = from('198.51.100.40');
    ok('a weak password is still refused',
      (await call(port, 'POST', '/api/v1/auth/register',
        reg({ password: 'abc', password2: 'abc' }), ip)).status === 422);
    ok('a malformed address is still refused',
      (await call(port, 'POST', '/api/v1/auth/register',
        reg({ email: 'not-an-email' }), ip)).status === 422);
    ok('a mismatched confirmation is still refused',
      (await call(port, 'POST', '/api/v1/auth/register',
        reg({ password2: 'different1' }), ip)).status === 422);
    ok('none of those created anything', db.state.created.length === 0);
    ok('and none of them used up an account slot',
      (await call(port, 'POST', '/api/v1/auth/register', reg(), ip)).status === 200);
    server.close();
  }

  /* ----------------------------------------------------------------- 9b */
  console.log('\nA rotating IPv6 address does not reset the limit');
  {
    /* Measured on the real deployment: the caller's address changed between
       two requests three seconds apart, so three accounts became four.
       Privacy extensions rotate the low half of an IPv6 address, which is
       why the /64 is the unit and the full address is not. */
    const src = require('fs').readFileSync(API, 'utf8');
    const { ipKey } = new Function('require', 'module', 'exports', '__filename', '__dirname',
      src + '\n;return { ipKey };')(require, { exports: {} }, {}, API, path.dirname(API));

    ok('two addresses in the same /64 are one caller',
      ipKey('2001:db8:abcd:1234:1111:2222:3333:4444') ===
      ipKey('2001:db8:abcd:1234:9999:8888:7777:6666'),
      ipKey('2001:db8:abcd:1234:1111:2222:3333:4444'));
    ok('a different /64 is a different caller',
      ipKey('2001:db8:abcd:1234::1') !== ipKey('2001:db8:abcd:9999::1'));
    ok('shorthand and expanded forms agree',
      ipKey('2001:db8:abcd:1234::1') === ipKey('2001:0db8:abcd:1234:0000:0000:0000:0001'),
      ipKey('2001:db8:abcd:1234::1') + ' vs ' + ipKey('2001:0db8:abcd:1234:0000:0000:0000:0001'));
    ok('leading zeros do not split a caller in two',
      ipKey('2001:0db8:0000:0001::5') === ipKey('2001:db8:0:1::5'));
    ok('IPv4 is used whole, not narrowed to a /24',
      ipKey('203.0.113.7') === '203.0.113.7' && ipKey('203.0.113.8') !== ipKey('203.0.113.7'));
    ok('an IPv4-mapped IPv6 address is treated as the IPv4 it is',
      ipKey('::ffff:203.0.113.7') === '203.0.113.7', ipKey('::ffff:203.0.113.7'));
    ok('an empty address is empty, not a shared bucket', ipKey('') === '' && ipKey(null) === '');
    ok('a bracketed address is unwrapped',
      ipKey('[2001:db8:abcd:1234::1]') === ipKey('2001:db8:abcd:1234::1'));
    ok('nonsense is passed through rather than crashing',
      typeof ipKey('not-an-address') === 'string');

    /* And end to end: a rotating low half must not buy more accounts. */
    const db = makeDb([]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open' }));
    const port = server.address().port;
    const seen = [];
    for (let i = 0; i < 5; i++) {
      /* Same /64, a new interface identifier each time — exactly what
         privacy extensions do. */
      seen.push((await call(port, 'POST', '/api/v1/auth/register', reg(),
        from('2001:db8:1111:2222:aaaa:bbbb:cccc:' + (1000 + i)))).status);
    }
    ok('a rotating address within one /64 still stops at the limit',
      seen.filter((s) => s === 200).length === 3, seen.join(','));
    ok('and the rest are throttled', seen.filter((s) => s === 429).length === 2, seen.join(','));

    /* A genuinely different customer is still unaffected. */
    const elsewhere = await call(port, 'POST', '/api/v1/auth/register', reg(),
      from('2001:db8:3333:4444::1'));
    ok('a different /64 is still allowed', elsewhere.status === 200, String(elsewhere.status));
    server.close();
  }

  /* ----------------------------------------------------------------- 10 */
  console.log('\nEvery account is still its own');
  {
    const db = makeDb([]);
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB, VERCEL_ENV: 'production', ALLOW_SIGNUPS: 'open' }));
    const port = server.address().port;
    const a = await call(port, 'POST', '/api/v1/auth/register',
      reg({ email: 'one@example.com', samples: true }), from('192.0.2.80'));
    const b = await call(port, 'POST', '/api/v1/auth/register',
      reg({ email: 'two@example.com' }), from('192.0.2.81'));
    ok('two strangers both get in', a.status === 200 && b.status === 200);
    ok('their session tokens differ', a.body.token !== b.body.token);
    ok('their user ids differ', a.body.user.id !== b.body.user.id);
    ok('one asked for samples and got them',
      a.body.state.data.accounts.length === 4 && a.body.state.data.txns.length > 0,
      String(a.body.state.data.accounts.length));
    ok('the other did not', b.body.state.data.accounts.length === 0,
      String(b.body.state.data.accounts.length));
    ok('both still get their own default categories',
      a.body.state.data.categories.length === 26 && b.body.state.data.categories.length === 26);
    ok('no password or hash comes back to either',
      !/abcdefg1|pw_hash|"salt"/.test(a.raw + b.raw));
    server.close();
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
