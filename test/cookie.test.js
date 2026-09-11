/* Session cookie: attributes, precedence, parsing and clearing.
 *
 * The token is issued as an HttpOnly cookie as well as in the JSON body. The
 * cookie is what a cross-site scripting bug cannot read; these tests pin the
 * attributes that make that true, and prove the cookie really is accepted as
 * an authentication transport rather than merely being set and ignored.
 *
 * pg is stubbed with just enough behaviour for register / login / logout to
 * run — no database.
 *
 *   node test/cookie.test.js
 */
'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const API = path.join(__dirname, '..', 'api', 'index.js');
const COOKIE = 'mm_session';

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* The server's own scrypt parameters, so a stored hash can be forged here. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };
function scryptHex(password, saltB64) {
  return crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }).toString('hex');
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------- the fake pg */

const USER = {
  id: 'u1', email: 'ada@example.com', name: 'Ada', token_hash: '',
  created_at: new Date().toISOString(), fail_count: 0, locked_until: null
};
const PASSWORD = 'abcdefg1';
const PW_SALT = crypto.randomBytes(16).toString('base64');

/* Tokens the fake considers live. Digests, as the server stores them. */
const liveDigests = new Set();

function makeFakePg() {
  const log = { authLookups: [] };

  class FakeClient {
    async query(sql, params) {
      const s = String(sql);

      /* --- authentication: honour ONLY digests we have issued --- */
      if (/FROM mm_token t JOIN mm_user u/.test(s)) {
        const presented = (params && params[0]) || [];
        log.authLookups.push(presented);
        const hit = presented.find((d) => liveDigests.has(d));
        if (!hit) return { rows: [], rowCount: 0 };
        return {
          rows: [Object.assign({}, USER, {
            token_id: hit, expires_at: new Date(Date.now() + 8.64e7).toISOString(),
            salt: PW_SALT, pw_hash: scryptHex(PASSWORD, PW_SALT), pw_iters: SCRYPT.N, pw_algo: 'scrypt'
          })],
          rowCount: 1
        };
      }
      /* the legacy long-lived API token path must not match anything here */
      if (/FROM mm_user WHERE token_hash/.test(s)) return { rows: [], rowCount: 0 };

      /* --- registration --- */
      if (/SELECT id FROM mm_user WHERE lower\(email\)/.test(s)) return { rows: [], rowCount: 0 };
      if (/COUNT\(\*\)::int AS n FROM mm_user/.test(s)) return { rows: [{ n: 0 }], rowCount: 1 };
      if (/SELECT \* FROM mm_user WHERE id/.test(s)) return { rows: [USER], rowCount: 1 };

      /* --- login --- */
      if (/SELECT \* FROM mm_user WHERE lower\(email\)/.test(s)) {
        return {
          rows: [Object.assign({}, USER, {
            salt: PW_SALT, pw_hash: scryptHex(PASSWORD, PW_SALT), pw_iters: SCRYPT.N, pw_algo: 'scrypt'
          })],
          rowCount: 1
        };
      }

      /* --- a session being issued: remember its digest as live --- */
      if (/INSERT INTO mm_token/.test(s)) {
        if (params && params[0]) liveDigests.add(params[0]);
        return { rows: [], rowCount: 1 };
      }
      /* --- a session being ended --- */
      if (/DELETE FROM mm_token/.test(s)) {
        const presented = (params && params[1]) || [];
        (Array.isArray(presented) ? presented : []).forEach((d) => liveDigests.delete(d));
        return { rows: [], rowCount: 1 };
      }
      if (/FROM mm_state WHERE user_id/.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }
  class FakePool {
    constructor(o) { this.o = o; }
    on() { return this; }
    async connect() { return new FakeClient(); }
    async end() {}
  }
  return { module: { Pool: FakePool, Client: FakeClient }, log };
}

let currentFakePg = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return currentFakePg;
  return origLoad.apply(this, arguments);
};

function loadApi(fake, env) {
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'AUTH_SECRET', 'ALLOWED_EMAILS', 'MM_DIAGNOSTICS']) {
    delete process.env[k];
  }
  Object.assign(process.env, env || {});
  currentFakePg = fake;
  delete require.cache[require.resolve(API)];
  return require(API);
}

/* `secure` decides whether the request looks like it arrived over https, the
   way it would behind Vercel's proxy. */
function startServer(handler, secure) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const mmpath = u.pathname.replace(/^\/api\/?/, '');
      req.url = '/api/index?mmpath=' + encodeURIComponent(mmpath);
      req.query = { mmpath };
      if (secure) req.headers['x-forwarded-proto'] = 'https';
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
        resolve({
          status: res.statusCode, body: json, raw,
          setCookie: Array.isArray(set) ? set : [set],
          session: (Array.isArray(set) ? set : [set]).find((c) => c.indexOf(COOKIE + '=') === 0) || ''
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const URL_OK = 'postgres://u:pw@db.example.org:5432/mm?sslmode=require';
const REG = { name: 'Ada', email: 'ada@example.com', password: PASSWORD, password2: PASSWORD };

(async () => {

  console.log('\nRegistration issues a hardened session cookie');
  {
    const fake = makeFakePg();
    const server = await startServer(loadApi(fake.module, { DATABASE_URL: URL_OK, VERCEL_ENV: 'production' }), true);
    const port = server.address().port;

    const r = await call(port, 'POST', '/api/v1/auth/register', REG);
    ok('registration succeeds', r.status === 200, 'HTTP ' + r.status + ' ' + r.raw.slice(0, 160));
    ok('a session cookie is set', !!r.session, JSON.stringify(r.setCookie));
    ok('it is HttpOnly, so script on the page cannot read it', /;\s*HttpOnly/i.test(r.session), r.session);
    ok('it is Secure, so it never crosses plain http', /;\s*Secure/i.test(r.session), r.session);
    ok('it is SameSite=Lax, so a cross-site write cannot use it',
      /;\s*SameSite=Lax/i.test(r.session), r.session);
    ok('it is scoped to the whole site', /;\s*Path=\//i.test(r.session), r.session);
    ok('it expires with the server-side session, after 30 days',
      /;\s*Max-Age=2592000/i.test(r.session), r.session);
    ok('the cookie carries the same token the body returned',
      decodeURIComponent(r.session.slice((COOKIE + '=').length).split(';')[0]) === r.body.token);
    ok('the password is nowhere in the response', !new RegExp(PASSWORD).test(r.raw));
    server.close();
  }

  console.log('\nSign-in issues it too, and Secure is dropped only for local http');
  {
    const fake = makeFakePg();
    const server = await startServer(loadApi(fake.module, { DATABASE_URL: URL_OK, VERCEL_ENV: 'production' }), true);
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/v1/auth/login', { email: USER.email, password: PASSWORD });
    ok('sign-in succeeds', r.status === 200 && !!r.body.token, 'HTTP ' + r.status + ' ' + r.raw.slice(0, 160));
    ok('a session cookie is set', /;\s*HttpOnly/i.test(r.session) && /;\s*Secure/i.test(r.session), r.session);
    server.close();
  }
  {
    /* Plain http on localhost: a Secure cookie would be discarded by the
       browser and local development could never sign in. */
    const fake = makeFakePg();
    const server = await startServer(loadApi(fake.module,
      { DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/mm', VERCEL_ENV: 'development' }), false);
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/v1/auth/login',
      { email: USER.email, password: PASSWORD }, { Host: 'localhost:3000' });
    ok('over local http the cookie is still HttpOnly', /;\s*HttpOnly/i.test(r.session), r.session);
    ok('but not Secure, so local sign-in works', !/;\s*Secure/i.test(r.session), r.session);
    server.close();
  }

  console.log('\nThe cookie really authenticates — it is not set and ignored');
  {
    const fake = makeFakePg();
    const server = await startServer(loadApi(fake.module, { DATABASE_URL: URL_OK, VERCEL_ENV: 'production' }), true);
    const port = server.address().port;

    const login = await call(port, 'POST', '/api/v1/auth/login', { email: USER.email, password: PASSWORD });
    const token = login.body.token;
    ok('we have a token and a cookie to test with', !!token && !!login.session);

    /* No Authorization header at all — only the cookie. */
    const viaCookie = await call(port, 'GET', '/api/v1/auth/session', undefined,
      { Cookie: COOKIE + '=' + encodeURIComponent(token) });
    ok('a cookie-only request is authenticated', viaCookie.status === 200,
      'HTTP ' + viaCookie.status + ' ' + viaCookie.raw.slice(0, 140));
    ok('and it identifies the right account',
      viaCookie.body && viaCookie.body.user && viaCookie.body.user.email === USER.email);

    /* No credential of any kind. */
    const naked = await call(port, 'GET', '/api/v1/auth/session');
    ok('with neither header nor cookie it is refused', naked.status === 401, 'HTTP ' + naked.status);

    /* A wrong cookie value must not authenticate. */
    const wrong = await call(port, 'GET', '/api/v1/auth/session', undefined,
      { Cookie: COOKIE + '=not-a-real-token' });
    ok('a forged cookie is refused', wrong.status === 401, 'HTTP ' + wrong.status);

    /* The header still wins, which is what keeps a cross-origin deployment
       working, where the browser would not send the cookie at all. */
    fake.log.authLookups.length = 0;
    await call(port, 'GET', '/api/v1/auth/session', undefined, {
      Authorization: 'Bearer ' + token,
      Cookie: COOKIE + '=a-different-value'
    });
    const looked = fake.log.authLookups[0] || [];
    ok('the Authorization header takes precedence over the cookie',
      looked.indexOf(sha256(token)) >= 0 && looked.indexOf(sha256('a-different-value')) < 0,
      JSON.stringify(looked));
    server.close();
  }

  console.log('\nCookie parsing is exact');
  {
    const fake = makeFakePg();
    const server = await startServer(loadApi(fake.module, { DATABASE_URL: URL_OK, VERCEL_ENV: 'production' }), true);
    const port = server.address().port;
    const login = await call(port, 'POST', '/api/v1/auth/login', { email: USER.email, password: PASSWORD });
    const token = login.body.token;

    /* A similarly-named cookie must not be mistaken for ours. */
    const decoy = await call(port, 'GET', '/api/v1/auth/session', undefined,
      { Cookie: 'not_' + COOKIE + '=' + encodeURIComponent(token) });
    ok('a cookie whose name merely ends with ours is ignored', decoy.status === 401,
      'HTTP ' + decoy.status);

    /* Ours found among several, with spacing as browsers send it. */
    const among = await call(port, 'GET', '/api/v1/auth/session', undefined, {
      Cookie: 'theme=dark; ' + COOKIE + '=' + encodeURIComponent(token) + '; other=1'
    });
    ok('ours is found among other cookies', among.status === 200, 'HTTP ' + among.status);

    /* A malformed header must not throw. */
    const junk = await call(port, 'GET', '/api/v1/auth/session', undefined,
      { Cookie: 'novalue; =nokey; ' + COOKIE });
    ok('a malformed Cookie header is refused, not a crash', junk.status === 401, 'HTTP ' + junk.status);
    server.close();
  }

  console.log('\nEnding a session removes the cookie');
  {
    const fake = makeFakePg();
    const server = await startServer(loadApi(fake.module, { DATABASE_URL: URL_OK, VERCEL_ENV: 'production' }), true);
    const port = server.address().port;

    let login = await call(port, 'POST', '/api/v1/auth/login', { email: USER.email, password: PASSWORD });
    let token = login.body.token;
    const out = await call(port, 'POST', '/api/v1/auth/logout', {},
      { Cookie: COOKIE + '=' + encodeURIComponent(token) });
    ok('signing out succeeds', out.status === 200, 'HTTP ' + out.status);
    ok('the cookie is cleared', /Max-Age=0/i.test(out.session), out.session);
    ok('it is cleared with the same attributes, or the browser keeps it',
      /HttpOnly/i.test(out.session) && /SameSite=Lax/i.test(out.session) && /Path=\//i.test(out.session),
      out.session);
    const after = await call(port, 'GET', '/api/v1/auth/session', undefined,
      { Cookie: COOKIE + '=' + encodeURIComponent(token) });
    ok('the ended session no longer authenticates', after.status === 401, 'HTTP ' + after.status);

    /* Signing out everywhere must clear this device's cookie too. */
    login = await call(port, 'POST', '/api/v1/auth/login', { email: USER.email, password: PASSWORD });
    token = login.body.token;
    const outAll = await call(port, 'POST', '/api/v1/auth/logout-all', {},
      { Cookie: COOKIE + '=' + encodeURIComponent(token) });
    ok('signing out everywhere clears this cookie as well',
      outAll.status === 200 && /Max-Age=0/i.test(outAll.session), outAll.session);

    /* Deleting the account likewise. */
    login = await call(port, 'POST', '/api/v1/auth/login', { email: USER.email, password: PASSWORD });
    token = login.body.token;
    const del = await call(port, 'DELETE', '/api/v1/auth/account', { password: PASSWORD },
      { Cookie: COOKIE + '=' + encodeURIComponent(token) });
    ok('deleting the account clears the cookie',
      del.status === 200 && /Max-Age=0/i.test(del.session), del.status + ' ' + del.session);
    server.close();
  }

  console.log('\nA failed sign-in sets no cookie');
  {
    const fake = makeFakePg();
    const server = await startServer(loadApi(fake.module, { DATABASE_URL: URL_OK, VERCEL_ENV: 'production' }), true);
    const port = server.address().port;
    const bad = await call(port, 'POST', '/api/v1/auth/login', { email: USER.email, password: 'wrongpass9' });
    ok('a wrong password is refused', bad.status === 401, 'HTTP ' + bad.status);
    ok('and no session cookie is issued', !bad.session, JSON.stringify(bad.setCookie));
    server.close();
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
