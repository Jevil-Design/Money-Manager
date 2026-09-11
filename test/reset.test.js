/* Password reset by emailed code or link.
 *
 * Both pg and fetch are stubbed, so this needs no database and sends no mail.
 * The properties worth pinning are the security ones: that the endpoint does
 * not reveal who has an account, that neither the code nor the link token is
 * stored in the clear, that guessing is capped, that a used code cannot be
 * replayed, and that a completed reset ends every session.
 *
 *   node test/reset.test.js
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

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };
const scryptHex = (pw, saltB64) => crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'),
  SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------ an in-memory stand-in DB */

function makeDb() {
  const state = {
    users: [{ id: 'u1', email: 'ada@example.com', name: 'Ada', token_hash: '', fail_count: 0, locked_until: null }],
    resets: [],
    tokens: [],
    passwordWrites: [],
    deletedTokensFor: []
  };

  class FakeClient {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ');

      if (/^(BEGIN|COMMIT|ROLLBACK|SELECT 1)$/i.test(s.trim())) return { rows: [], rowCount: 0 };
      if (/CREATE TABLE|ALTER TABLE|CREATE INDEX|CREATE UNIQUE INDEX/i.test(s)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO mm_meta/i.test(s)) return { rows: [], rowCount: 1 };
      if (/pg_encoding_to_char/.test(s)) return { rows: [{ enc: 'UTF8' }], rowCount: 1 };
      if (/FROM mm_meta/.test(s)) return { rows: [{ value: '4' }], rowCount: 1 };

      /* who has an account */
      if (/SELECT id, email, name FROM mm_user WHERE lower\(email\)/.test(s)) {
        const u = state.users.find((x) => x.email.toLowerCase() === params[0]);
        return { rows: u ? [{ id: u.id, email: u.email, name: u.name }] : [], rowCount: u ? 1 : 0 };
      }
      if (/COUNT\(\*\)::int AS n FROM mm_user/.test(s)) {
        return { rows: [{ n: state.users.length }], rowCount: 1 };
      }

      /* rate-limit window */
      if (/COUNT\(\*\)::int AS n FROM mm_reset/.test(s)) {
        const n = state.resets.filter((r) => r.user_id === params[0]).length;
        return { rows: [{ n }], rowCount: 1 };
      }

      /* creating a reset */
      if (/INSERT INTO mm_reset/.test(s)) {
        state.resets.push({
          id: params[0], user_id: params[1], code_hash: params[2], code_salt: params[3],
          attempts: 0, used_at: null, created_at: new Date()
        });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM mm_reset WHERE user_id = \$1 AND \(expires_at/.test(s)) {
        state.resets = state.resets.filter((r) => r.user_id !== params[0] || !r.used_at);
        return { rows: [], rowCount: 0 };
      }

      /* redeeming by link token */
      if (/SELECT \* FROM mm_reset WHERE id = \$1 AND used_at IS NULL/.test(s)) {
        const r = state.resets.find((x) => x.id === params[0] && !x.used_at);
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      /* redeeming by email + code */
      if (/FROM mm_reset r JOIN mm_user u/.test(s)) {
        const u = state.users.find((x) => x.email.toLowerCase() === params[0]);
        if (!u) return { rows: [], rowCount: 0 };
        const list = state.resets.filter((x) => x.user_id === u.id && !x.used_at);
        const r = list[list.length - 1];
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/UPDATE mm_reset SET attempts/.test(s)) {
        const r = state.resets.find((x) => x.id === params[2]);
        if (r) { r.attempts = params[0]; if (params[0] >= params[1]) r.used_at = new Date(); }
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE mm_reset SET used_at = now\(\) WHERE id = \$1/.test(s)) {
        const r = state.resets.find((x) => x.id === params[0]);
        if (r) r.used_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE mm_reset SET used_at = now\(\) WHERE user_id = \$1/.test(s)) {
        state.resets.filter((x) => x.user_id === params[0] && !x.used_at)
          .forEach((x) => { x.used_at = new Date(); });
        return { rows: [], rowCount: 1 };
      }

      /* the password itself */
      if (/UPDATE mm_user SET salt = \$1, pw_hash = \$2/.test(s)) {
        state.passwordWrites.push({ userId: params[5], salt: params[0], hash: params[1], algo: params[3] });
        const u = state.users.find((x) => x.id === params[5]);
        if (u) { u.salt = params[0]; u.pw_hash = params[1]; u.pw_iters = params[2]; u.pw_algo = params[3]; }
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM mm_token WHERE user_id = \$1$/.test(s.trim())) {
        state.deletedTokensFor.push(params[0]);
        state.tokens = state.tokens.filter((t) => t.user_id !== params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE mm_user SET fail_count = 0/.test(s)) return { rows: [], rowCount: 1 };

      /* sign-in, to prove the new password works afterwards */
      if (/SELECT \* FROM mm_user WHERE lower\(email\)/.test(s)) {
        const u = state.users.find((x) => x.email.toLowerCase() === params[0]);
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (/INSERT INTO mm_token/.test(s)) {
        state.tokens.push({ id: params[0], user_id: params[1] });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM mm_token t JOIN mm_user u/.test(s)) {
        const hit = (params[0] || []).find((d) => state.tokens.some((t) => t.id === d));
        if (!hit) return { rows: [], rowCount: 0 };
        const t = state.tokens.find((x) => x.id === hit);
        const u = state.users.find((x) => x.id === t.user_id);
        return { rows: [Object.assign({}, u, { token_id: hit })], rowCount: 1 };
      }
      if (/FROM mm_user WHERE token_hash/.test(s)) return { rows: [], rowCount: 0 };
      if (/DELETE FROM mm_token/.test(s)) return { rows: [], rowCount: 0 };
      if (/FROM mm_state WHERE user_id/.test(s)) return { rows: [], rowCount: 0 };

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

/* --------------------------------------------------------- the stubbed mail */

let mailbox = [];
const realFetch = global.fetch;
function stubFetch(behaviour) {
  mailbox = [];
  global.fetch = async (url, opts) => {
    if (String(url).indexOf('api.resend.com') >= 0) {
      const body = JSON.parse(opts.body);
      mailbox.push(body);
      if (behaviour === 'fail') return { ok: false, status: 422, text: async () => 'domain not verified' };
      if (behaviour === 'throw') throw new Error('getaddrinfo ENOTFOUND api.resend.com');
      return { ok: true, status: 200, text: async () => '{"id":"x"}' };
    }
    return realFetch(url, opts);
  };
}

/* ------------------------------------------------------------- the harness */

let currentFakePg = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return currentFakePg;
  return origLoad.apply(this, arguments);
};

function loadApi(fake, env) {
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'AUTH_SECRET', 'ALLOWED_EMAILS',
    'MM_DIAGNOSTICS', 'RESEND_API_KEY', 'MAIL_FROM', 'APP_URL',
    'VERCEL_PROJECT_PRODUCTION_URL']) delete process.env[k];
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
        const set = res.headers['set-cookie'] || [];
        resolve({ status: res.statusCode, body: json, raw, setCookie: Array.isArray(set) ? set : [set] });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const DB_URL = 'postgres://u:pw@db.example.org:5432/mm?sslmode=require';
const MAILED = { RESEND_API_KEY: 're_test_key', MAIL_FROM: 'Money Manager <mm@example.org>' };
const codeFrom = (mail) => (mail.text.match(/reset code is: (\d{6})/) || [])[1];
const linkFrom = (mail) => (mail.text.match(/\?reset=([A-Za-z0-9_-]+)/) || [])[1];

(async () => {

  /* ------------------------------------------------------------------ 1 */
  console.log('\nAsking for a code says nothing about who has an account');
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;

    const known = await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    const unknown = await call(port, 'POST', '/api/v1/auth/forgot', { email: 'nobody@example.com' });

    ok('a known address is accepted', known.status === 200, String(known.status));
    ok('an unknown address answers identically',
      unknown.status === known.status && unknown.body.message === known.body.message,
      unknown.status + ' ' + JSON.stringify(unknown.body));
    ok('the wording does not claim an account exists',
      /if that address has an account/i.test(known.body.message), known.body.message);
    ok('only the real address was emailed', mailbox.length === 1 && mailbox[0].to[0] === 'ada@example.com',
      JSON.stringify(mailbox.map((m) => m.to)));
    ok('an invalid address is rejected before any lookup',
      (await call(port, 'POST', '/api/v1/auth/forgot', { email: 'not-an-email' })).status === 422);
    server.close();
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\nThe email carries a code and a link, and neither is stored in the clear');
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });

    const mail = mailbox[0];
    const code = codeFrom(mail), token = linkFrom(mail);
    ok('the email contains a six-digit code', /^\d{6}$/.test(code || ''), String(code));
    ok('the email contains a link to the app',
      mail.text.indexOf('https://mm.example.app/?reset=') >= 0, mail.text.slice(0, 200));
    ok('the link token is long and random', (token || '').length >= 40, String(token && token.length));
    ok('it says how long it lasts and that it is single use',
      /expires in 15 minutes/.test(mail.text) && /only be used once/.test(mail.text));
    ok('it tells an unexpecting recipient to ignore it', /did not ask for this/.test(mail.text));
    ok('it warns that every device is signed out', /signs every device out/.test(mail.text));
    ok('it is addressed from the configured sender', mail.from === MAILED.MAIL_FROM, mail.from);

    const row = db.state.resets[0];
    ok('the stored row does not contain the code',
      JSON.stringify(row).indexOf(code) < 0, JSON.stringify(row).slice(0, 160));
    ok('the stored row does not contain the link token', JSON.stringify(row).indexOf(token) < 0);
    ok('the link token is stored as its SHA-256 digest', row.id === sha256(token));
    ok('the code is stored as a scrypt hash, not a bare digest',
      row.code_hash === scryptHex(code, row.code_salt) && row.code_hash !== sha256(code));
    ok('the response body never carries the code or token',
      mailbox.length === 1 && !/\d{6}/.test(JSON.stringify({})) === true);
    server.close();
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\nResetting with the code works, once');
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    const code = codeFrom(mailbox[0]);

    /* A session exists before the reset, to prove it is ended by it. */
    db.state.tokens.push({ id: 'existing-session', user_id: 'u1' });

    const weak = await call(port, 'POST', '/api/v1/auth/reset',
      { email: 'ada@example.com', code, password: 'abc' });
    ok('a weak new password is refused', weak.status === 422 && weak.body.code === 'password_weak',
      JSON.stringify(weak.body));
    const mism = await call(port, 'POST', '/api/v1/auth/reset',
      { email: 'ada@example.com', code, password: 'abcdefg1', password2: 'abcdefg2' });
    ok('a mismatched confirmation is refused', mism.status === 422 && mism.body.code === 'password_mismatch');

    const done = await call(port, 'POST', '/api/v1/auth/reset',
      { email: 'ada@example.com', code, password: 'newpass12', password2: 'newpass12' });
    ok('the right code sets the new password', done.status === 200 && done.body.ok === true,
      JSON.stringify(done.body));
    ok('the new password was written as scrypt',
      db.state.passwordWrites.length === 1 && db.state.passwordWrites[0].algo === 'scrypt');
    ok('the stored hash is not the password',
      db.state.passwordWrites[0].hash.indexOf('newpass12') < 0);
    ok('every session for the account was ended',
      db.state.deletedTokensFor.indexOf('u1') >= 0 && db.state.tokens.length === 0);
    ok('the session cookie is cleared too',
      done.setCookie.some((c) => /^mm_session=/.test(c) && /Max-Age=0/.test(c)),
      JSON.stringify(done.setCookie));
    ok('the reply says what happened', /signed out/i.test(done.body.message || ''), done.body.message);

    const replay = await call(port, 'POST', '/api/v1/auth/reset',
      { email: 'ada@example.com', code, password: 'another12', password2: 'another12' });
    ok('the same code cannot be used twice',
      replay.status === 400 && replay.body.code === 'reset_invalid', JSON.stringify(replay.body));
    ok('and no second password was written', db.state.passwordWrites.length === 1);

    /* The new password must actually work. */
    const login = await call(port, 'POST', '/api/v1/auth/login',
      { email: 'ada@example.com', password: 'newpass12' });
    ok('the account signs in with the new password', login.status === 200 && !!login.body.token,
      String(login.status));
    const old = await call(port, 'POST', '/api/v1/auth/login',
      { email: 'ada@example.com', password: 'abcdefg1' });
    ok('the old password no longer works', old.status === 401, String(old.status));
    server.close();
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\nResetting from the link needs no code or address');
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    const token = linkFrom(mailbox[0]);

    const done = await call(port, 'POST', '/api/v1/auth/reset',
      { token, password: 'linkpass12', password2: 'linkpass12' });
    ok('the link token alone is enough', done.status === 200 && done.body.ok === true,
      JSON.stringify(done.body));
    ok('it ended every session', db.state.deletedTokensFor.indexOf('u1') >= 0);
    const replay = await call(port, 'POST', '/api/v1/auth/reset',
      { token, password: 'again12345', password2: 'again12345' });
    ok('the link cannot be reused', replay.status === 400 && replay.body.code === 'reset_invalid');
    const forged = await call(port, 'POST', '/api/v1/auth/reset',
      { token: 'not-a-real-token', password: 'nope123456', password2: 'nope123456' });
    ok('a forged token is refused', forged.status === 400 && forged.body.code === 'reset_invalid');
    server.close();
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\nGuessing the code is capped');
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    const real = codeFrom(mailbox[0]);
    const wrong = real === '000000' ? '111111' : '000000';

    const seen = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(port, 'POST', '/api/v1/auth/reset',
        { email: 'ada@example.com', code: wrong, password: 'guessing12', password2: 'guessing12' });
      seen.push(r.body && r.body.code);
    }
    ok('each wrong guess is refused', seen.every((c) => c === 'reset_bad_code'), JSON.stringify(seen));
    ok('no password was written by any of them', db.state.passwordWrites.length === 0);

    /* The fifth wrong guess burns the record, so the real code is dead too. */
    const after = await call(port, 'POST', '/api/v1/auth/reset',
      { email: 'ada@example.com', code: real, password: 'guessing12', password2: 'guessing12' });
    ok('after five wrong guesses even the real code is refused',
      after.status === 400 && after.body.code === 'reset_invalid', JSON.stringify(after.body));
    ok('so a new email is required', db.state.resets.every((r) => !!r.used_at));
    server.close();
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\nRequests are rate limited without revealing anything');
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    const answers = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
      answers.push(r.status);
    }
    ok('every request is answered 200', answers.every((s) => s === 200), JSON.stringify(answers));
    ok('but only three emails were actually sent', mailbox.length === 3, String(mailbox.length));
    server.close();
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\nWithout email configured the feature declares itself unavailable');
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      { DATABASE_URL: DB_URL, VERCEL_ENV: 'production' }));
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    ok('the request is refused, not silently dropped',
      r.status === 503 && r.body.code === 'reset_unavailable', JSON.stringify(r.body));
    ok('no email was attempted', mailbox.length === 0);
    ok('the message does not name an environment variable',
      !/RESEND|MAIL_FROM|API_KEY/i.test(r.body.error), r.body.error);
    const h = await call(port, 'GET', '/api/health');
    ok('health reports password reset as unavailable', h.body.passwordReset === false,
      String(h.body.passwordReset));
    server.close();
  }
  {
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    const h = await call(port, 'GET', '/api/health');
    ok('health reports it as available once configured', h.body.passwordReset === true);
    ok('and that links can be built', h.body.passwordResetLink === true);
    server.close();
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\nThe link origin never comes from the request');
  {
    /* Host header injection: if the link were built from the Host header,
       anyone could have a real token emailed pointing at their own site. */
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' },
      { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' });
    ok('a spoofed Host does not appear in the email',
      mailbox[0].text.indexOf('evil.example') < 0, mailbox[0].text.slice(0, 200));
    ok('the link uses the configured origin',
      mailbox[0].text.indexOf('https://mm.example.app/?reset=') >= 0);
    server.close();
  }
  {
    /* With no origin configured, send the code and simply omit the link. */
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production' }, MAILED)));
    const port = server.address().port;
    await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' },
      { Host: 'evil.example' });
    ok('with no configured origin the email still carries a code',
      /reset code is: \d{6}/.test(mailbox[0].text));
    ok('and carries no link at all',
      mailbox[0].text.indexOf('?reset=') < 0, mailbox[0].text.slice(0, 200));
    server.close();
  }
  {
    /* Vercel supplies the production URL, so this is usually automatic. */
    const db = makeDb();
    stubFetch();
    const server = await startServer(loadApi(db.module,
      Object.assign({
        DATABASE_URL: DB_URL, VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: 'money-manager-three-weld.vercel.app'
      }, MAILED)));
    const port = server.address().port;
    await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    ok('the Vercel production URL is used when APP_URL is unset',
      mailbox[0].text.indexOf('https://money-manager-three-weld.vercel.app/?reset=') >= 0,
      mailbox[0].text.slice(0, 200));
    server.close();
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\nA mail provider failure is reported honestly');
  {
    const db = makeDb();
    stubFetch('fail');
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    ok('the caller is told it did not send', r.status === 502 && r.body.code === 'mail_failed',
      JSON.stringify(r.body));
    ok('it does not claim an email is on its way', !/on its way/i.test(r.body.error), r.body.error);
    ok('the provider\'s own words are not passed through',
      !/domain not verified/.test(r.raw), r.raw.slice(0, 160));
    server.close();
  }
  {
    const db = makeDb();
    stubFetch('throw');
    const server = await startServer(loadApi(db.module,
      Object.assign({ DATABASE_URL: DB_URL, VERCEL_ENV: 'production', APP_URL: 'https://mm.example.app' }, MAILED)));
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/v1/auth/forgot', { email: 'ada@example.com' });
    ok('an unreachable provider is also reported', r.status === 502 && r.body.code === 'mail_failed');
    ok('and no hostname or stack leaks', !/ENOTFOUND|api\.resend\.com|at Object/.test(r.raw),
      r.raw.slice(0, 160));
    server.close();
  }

  /* ------------------------------------------------------------------ 10 */
  console.log('\nThe generated code is well formed');
  {
    const src = require('fs').readFileSync(API, 'utf8');
    const { resetCode } = new Function('require', 'module', 'exports', '__filename', '__dirname',
      src + '\n;return { resetCode };')(require, { exports: {} }, {}, API, path.dirname(API));
    const seen = new Set();
    let allSixDigits = true;
    for (let i = 0; i < 3000; i++) {
      const c = resetCode();
      if (!/^\d{6}$/.test(c)) allSixDigits = false;
      seen.add(c);
    }
    ok('every code is exactly six digits', allSixDigits);
    ok('codes are not repeating (3000 draws, >2900 distinct)', seen.size > 2900, String(seen.size));
    /* A biased generator would skew the leading digit away from uniform. */
    const firsts = {};
    for (const c of seen) firsts[c[0]] = (firsts[c[0]] || 0) + 1;
    const counts = Object.values(firsts);
    ok('leading digits are spread across all ten values',
      Object.keys(firsts).length === 10 && Math.max(...counts) < Math.min(...counts) * 2.5,
      JSON.stringify(firsts));
  }

  global.fetch = realFetch;
  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
