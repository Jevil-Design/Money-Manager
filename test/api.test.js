/* Integration test: serve api/index.js over real HTTP and exercise the paths
   that produced the bug report, plus the auth surface if a database is
   reachable.  Set MM_TEST_DATABASE_URL to run the database half; without it
   the outage half still runs, which is the half that matters for the fix. */
const http = require('http');
const path = require("path");
const API = process.argv[2] || path.join(__dirname, "..", "api", "index.js");

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* Vercel's rewrite turns /api/v1/x into /api/index?mmpath=v1/x.  Reproduce
   that here so routing is tested the way it is actually deployed. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let mmpath = u.pathname.replace(/^\/api\/?/, '');
      req.url = '/api/index?mmpath=' + encodeURIComponent(mmpath) +
        (u.search ? '&' + u.search.slice(1) : '');
      req.query = Object.assign({ mmpath: mmpath }, Object.fromEntries(u.searchParams));
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        headers || {})
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* report the raw text */ }
        resolve({ status: res.statusCode, body: json, raw: raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* Every name that must never appear in anything sent to a browser. */
const FORBIDDEN = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL',
  'POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED', 'PG_CONNECTION_STRING', 'ALLOWED_EMAILS',
  'AUTH_SECRET', 'PGSSL_NO_VERIFY', 'password=', 'sslmode', 'at Object.', 'node:internal'];
const leaks = (text) => FORBIDDEN.filter((f) => String(text).indexOf(f) >= 0);

function freshHandler(env) {
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING',
    'DATABASE_URL_UNPOOLED', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL',
    'PG_CONNECTION_STRING', 'MM_DIAGNOSTICS', 'ALLOWED_EMAILS', 'AUTH_SECRET']) delete process.env[k];
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve(API)];
  return require(API);
}

(async () => {
  /* ---------------------------------------------------------------------
     1. No database configured at all — the exact situation that produced
        "No database is configured. Add a Postgres database to this Vercel
        project ..." on the Create Account page.
     --------------------------------------------------------------------- */
  console.log('\nNo database configured (the reported bug)');
  {
    const server = await startServer(freshHandler({ VERCEL_ENV: 'production' }));
    const port = server.address().port;

    const reg = await call(port, 'POST', '/api/v1/auth/register',
      { name: 'Ada', email: 'ada@example.com', password: 'abcdefg1', password2: 'abcdefg1' });
    ok('registering returns 503, not a crash', reg.status === 503, String(reg.status));
    ok('the message is the safe sentence',
      reg.body && reg.body.error === 'Cloud database is currently unavailable. Please check the server configuration.',
      reg.body && reg.body.error);
    ok('the reply carries code no_database', reg.body && reg.body.code === 'no_database', reg.body && reg.body.code);
    ok('the reply leaks no variable name or credential',
      leaks(reg.raw).length === 0, leaks(reg.raw).join(', '));
    ok('the reply carries no stack trace and no SQL', !/\bat \w|SELECT |INSERT /.test(reg.raw));
    ok('the old message is gone', !/No database is configured/.test(reg.raw));
    ok('no detail field in production', reg.body && reg.body.detail === undefined);

    const login = await call(port, 'POST', '/api/v1/auth/login',
      { email: 'ada@example.com', password: 'abcdefg1' });
    ok('signing in gives the same safe answer',
      login.status === 503 && login.body.code === 'no_database' && leaks(login.raw).length === 0);

    const state = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer x' });
    ok('a data read gives the same safe answer',
      state.status === 503 && state.body.code === 'no_database' && leaks(state.raw).length === 0);

    /* Health is the operator's surface: it may name which variables are set,
       because names are not secrets, but never a value. */
    const h = await call(port, 'GET', '/api/health');
    ok('health answers 503 when the database is down', h.status === 503, String(h.status));
    ok('health reports status error', h.body && h.body.status === 'error', h.body && h.body.status);
    ok('health reports database unavailable', h.body && h.body.database === 'unavailable');
    ok('health lists no variable as set', h.body && Array.isArray(h.body.databaseUrlVarsSet) &&
      h.body.databaseUrlVarsSet.length === 0, JSON.stringify(h.body && h.body.databaseUrlVarsSet));
    ok('health names the accepted variables for the operator',
      h.body && h.body.databaseUrlVarsAccepted.indexOf('DATABASE_URL') === 0);
    ok('health is reachable at /api/health and /api/v1/health',
      (await call(port, 'GET', '/api/v1/health')).status === 503);
    ok('health sets no-store', /no-store/.test(h.headers['cache-control'] || ''));

    server.close();
  }

  /* ---------------------------------------------------------------------
     2. A variable is set but is not a usable Postgres URL.
     --------------------------------------------------------------------- */
  console.log('\nA database variable is set but unusable');
  {
    const server = await startServer(freshHandler({
      VERCEL_ENV: 'production', DATABASE_URL: 'postgres://u:s3cretpw@your-host:5432/db'
    }));
    const port = server.address().port;
    const reg = await call(port, 'POST', '/api/v1/auth/register',
      { name: 'Ada', email: 'ada@example.com', password: 'abcdefg1', password2: 'abcdefg1' });
    ok('a placeholder host is reported as misconfigured',
      reg.status === 503 && reg.body.code === 'db_misconfigured', JSON.stringify(reg.body));
    ok('the user still sees only the safe sentence',
      reg.body.error === 'Cloud database is currently unavailable. Please check the server configuration.');
    ok('the password in the connection string never reaches the browser',
      !/s3cretpw/.test(reg.raw) && leaks(reg.raw).length === 0);

    const h = await call(port, 'GET', '/api/health');
    ok('health says which variable is set, by name only',
      h.body.databaseUrlVarsSet.length === 1 && h.body.databaseUrlVarsSet[0] === 'DATABASE_URL',
      JSON.stringify(h.body.databaseUrlVarsSet));
    ok('health never echoes the connection string', !/s3cretpw/.test(h.raw) && !/your-host/.test(h.raw));
    server.close();
  }

  /* ---------------------------------------------------------------------
     3. A well-formed URL pointing at nothing.
     --------------------------------------------------------------------- */
  console.log('\nA well-formed URL that nothing answers');
  {
    const server = await startServer(freshHandler({
      VERCEL_ENV: 'production',
      DATABASE_URL: 'postgres://u:s3cretpw@127.0.0.1:1/mmtest'
    }));
    const port = server.address().port;
    const reg = await call(port, 'POST', '/api/v1/auth/register',
      { name: 'Ada', email: 'ada@example.com', password: 'abcdefg1', password2: 'abcdefg1' });
    ok('a refused connection is reported as unreachable',
      reg.status === 503 && reg.body.code === 'db_unreachable', JSON.stringify(reg.body));
    ok('the user sees only the safe sentence',
      reg.body.error === 'Cloud database is currently unavailable. Please check the server configuration.');
    ok('no driver text, host, port or password reaches the browser',
      !/s3cretpw|ECONNREFUSED|127\.0\.0\.1/.test(reg.raw), reg.raw);
    server.close();
  }

  /* ---------------------------------------------------------------------
     4. Diagnostics are opt-in and never on in production.
     --------------------------------------------------------------------- */
  console.log('\nDeveloper diagnostics stay out of production');
  {
    let server = await startServer(freshHandler({ VERCEL_ENV: 'production', MM_DIAGNOSTICS: '1' }));
    let port = server.address().port;
    let r = await call(port, 'POST', '/api/v1/auth/login', { email: 'a@b.co', password: 'x' });
    ok('MM_DIAGNOSTICS is ignored in production', r.body.detail === undefined, JSON.stringify(r.body));
    ok('and still leaks nothing', leaks(r.raw).length === 0);
    server.close();

    server = await startServer(freshHandler({ VERCEL_ENV: 'development', MM_DIAGNOSTICS: '1' }));
    port = server.address().port;
    r = await call(port, 'POST', '/api/v1/auth/login', { email: 'a@b.co', password: 'x' });
    ok('in development the sanitised reason is available', typeof r.body.detail === 'string',
      JSON.stringify(r.body));
    ok('the user-facing message is unchanged either way',
      r.body.error === 'Cloud database is currently unavailable. Please check the server configuration.');
    server.close();
  }

  /* ---------------------------------------------------------------------
     5. Routing and method handling, independent of the database.
     --------------------------------------------------------------------- */
  console.log('\nRouting');
  {
    const server = await startServer(freshHandler({ VERCEL_ENV: 'production' }));
    const port = server.address().port;
    const opts = await call(port, 'OPTIONS', '/api/v1/auth/register');
    ok('preflight is answered 204', opts.status === 204, String(opts.status));
    ok('preflight advertises the headers the app sends',
      /X-Mm-Encoding/i.test(opts.headers['access-control-allow-headers'] || ''));
    server.close();
  }

  /* ---------------------------------------------------------------------
     6. The full flow, if a test database was provided.
     --------------------------------------------------------------------- */
  const TEST_DB = process.env.MM_TEST_DATABASE_URL;
  if (!TEST_DB) {
    console.log('\nDatabase-backed flow: SKIPPED (set MM_TEST_DATABASE_URL to run it)');
  } else {
    console.log('\nThe full flow against a real database');
    const server = await startServer(freshHandler({
      VERCEL_ENV: 'development', DATABASE_URL: TEST_DB, ALLOWED_EMAILS: ''
    }));
    const port = server.address().port;
    const stamp = Date.now();
    const a = { name: 'User A', email: 'a' + stamp + '@example.com', password: 'abcdefg1' };
    const b = { name: 'User B', email: 'b' + stamp + '@example.com', password: 'hijklmn2' };

    /* Name both addresses in the allowlist.
       claimAccount() reads ALLOWED_EMAILS at request time, so this can be set
       now that the addresses exist. Without it the empty-allowlist rule takes
       over — "the first account claims this deployment" — and User B would be
       refused with 403, so the isolation checks below would never run. It also
       makes the run independent of whatever the database already contains. */
    process.env.ALLOWED_EMAILS = a.email + ', ' + b.email;

    /* Hoisted so the finally below can always reach them: a failure anywhere
       in this block must still delete the accounts it created, or a scratch
       database slowly fills with orphaned test users. */
    let tokenA = '', tokenB = '';
    try {
    const h = await call(port, 'GET', '/api/health');
    ok('health reports connected', h.body.status === 'ok' && h.body.database === 'connected',
      JSON.stringify(h.body));
    ok('health reports the schema version it applied', h.body.schemaVersion === h.body.schemaExpected,
      h.body.schemaVersion + ' vs ' + h.body.schemaExpected);
    ok('health reports UTF8', h.body.encodingOk === true, String(h.body.encoding));

    /* TEST 2 — create a valid account, with sample data. */
    const ra = await call(port, 'POST', '/api/v1/auth/register',
      Object.assign({ password2: a.password, samples: true }, a));
    ok('TEST 2: a valid account is created', ra.status === 200 && !!ra.body.token, JSON.stringify(ra.body).slice(0, 200));
    ok('TEST 2: the response carries the user', ra.body.user && ra.body.user.email === a.email);
    ok('TEST 2: no password or hash comes back', !/abcdefg1|pw_hash|salt/.test(ra.raw));
    ok('TEST 11: sample data was created for this user',
      ra.body.state && ra.body.state.data.accounts.length === 4 && ra.body.state.data.txns.length > 0,
      JSON.stringify(ra.body.state && ra.body.state.rev));
    ok('TEST 11: the document arrives at revision 1', ra.body.state.rev === 1);
    tokenA = ra.body.token;

    /* TEST 3 — the same email again. */
    const dupe = await call(port, 'POST', '/api/v1/auth/register',
      Object.assign({ password2: a.password }, a));
    ok('TEST 3: a duplicate email is refused with 409', dupe.status === 409, String(dupe.status));
    ok('TEST 3: and says so plainly',
      /An account with this email already exists/.test(dupe.body.error), dupe.body.error);
    ok('TEST 3: the code is email_taken', dupe.body.code === 'email_taken');

    /* Case-insensitivity: the same address in capitals is the same account. */
    const dupeCase = await call(port, 'POST', '/api/v1/auth/register',
      { name: a.name, email: a.email.toUpperCase(), password: a.password, password2: a.password });
    ok('the same address in capitals is the same account', dupeCase.status === 409, String(dupeCase.status));

    /* TEST 4 — wrong password. */
    const bad = await call(port, 'POST', '/api/v1/auth/login', { email: a.email, password: 'wrongpass9' });
    ok('TEST 4: a wrong password is rejected', bad.status === 401, String(bad.status));
    ok('TEST 4: with no hint about which half was wrong',
      /don.t match an account/.test(bad.body.error), bad.body.error);

    /* An address with no account must answer identically. */
    const nobody = await call(port, 'POST', '/api/v1/auth/login',
      { email: 'nobody' + stamp + '@example.com', password: 'wrongpass9' });
    ok('a missing account is indistinguishable from a wrong password',
      nobody.status === bad.status && nobody.body.error === bad.body.error);

    /* TEST 5 — the right password. */
    const good = await call(port, 'POST', '/api/v1/auth/login', { email: a.email, password: a.password });
    ok('TEST 5: the right password signs in', good.status === 200 && !!good.body.token);
    const tokenA2 = good.body.token;
    ok('TEST 5: a second sign-in gets its own session token', tokenA2 !== tokenA);

    /* TEST 6 / 7 — write a transaction, read it back. */
    const st0 = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer ' + tokenA });
    ok('TEST 6: the document reads back', st0.status === 200 && !!st0.body.data);
    const doc = st0.body.data;
    const acctId = doc.accounts[0].id;
    const catId = doc.categories.find((c) => c.type === 'expense').id;
    doc.txns.push({
      id: 'itest' + stamp, date: '2026-09-11', type: 'expense', accountId: acctId,
      toAccountId: '', categoryId: catId, sub: '', amount: 123.45,
      contents: 'Integration test ₹', details: '', payment: 'Cash', notes: '',
      tags: [], attachment: null, createdAt: Date.now(), updatedAt: Date.now()
    });
    const put = await call(port, 'PUT', '/api/v1/state',
      { rev: st0.body.rev, data: doc }, { Authorization: 'Bearer ' + tokenA });
    ok('TEST 6: the transaction is stored', put.status === 200 && put.body.rev === st0.body.rev + 1,
      JSON.stringify(put.body));

    const st1 = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer ' + tokenA });
    ok('TEST 7: it is still there on a fresh read',
      st1.body.data.txns.some((t) => t.id === 'itest' + stamp));
    ok('TEST 7: the rupee sign survived the round trip',
      st1.body.data.txns.some((t) => t.contents === 'Integration test ₹'));

    /* TEST 8 — the other session, standing in for another computer. */
    const st2 = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer ' + tokenA2 });
    ok('TEST 8: another device on the same account sees the same data',
      st2.body.rev === st1.body.rev &&
      st2.body.data.txns.some((t) => t.id === 'itest' + stamp));

    /* A stale revision must be refused rather than silently overwriting. */
    const stale = await call(port, 'PUT', '/api/v1/state',
      { rev: st0.body.rev, data: doc }, { Authorization: 'Bearer ' + tokenA2 });
    ok('a stale save is refused with 409, not applied', stale.status === 409, String(stale.status));
    ok('and the reply says what the current revision is', stale.body.serverRev === st1.body.rev);

    /* TEST 9 — a second user must see none of the first user's data. */
    const rb = await call(port, 'POST', '/api/v1/auth/register',
      Object.assign({ password2: b.password, samples: false }, b));
    ok('TEST 9: a second account can be created', rb.status === 200 && !!rb.body.token,
      JSON.stringify(rb.body).slice(0, 200));
    tokenB = rb.body.token;
    const stB = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer ' + tokenB });
    ok('TEST 9: User B sees their own empty book', stB.status === 200 &&
      stB.body.data.accounts.length === 0 && stB.body.data.txns.length === 0,
      JSON.stringify({ a: stB.body.data.accounts.length, t: stB.body.data.txns.length }));
    ok('TEST 9: User B cannot see User A\'s transaction',
      !stB.body.data.txns.some((t) => t.id === 'itest' + stamp));
    ok('TEST 9: User B still has their own default categories',
      stB.body.data.categories.length === 26, String(stB.body.data.categories.length));
    const snapsB = await call(port, 'GET', '/api/v1/snapshots', undefined, { Authorization: 'Bearer ' + tokenB });
    ok('TEST 9: User B sees none of User A\'s snapshots',
      snapsB.status === 200 && snapsB.body.snapshots.length === 0);
    const balB = await call(port, 'GET', '/api/v1/balances', undefined, { Authorization: 'Bearer ' + tokenB });
    ok('TEST 9: User B\'s balances are their own', balB.status === 200 && balB.body.netWorth === 0,
      JSON.stringify(balB.body));

    /* IDOR: a snapshot id belonging to A must not be readable by B. */
    const snapA = await call(port, 'POST', '/api/v1/backup',
      { label: 'test', payload: st1.body.data }, { Authorization: 'Bearer ' + tokenA });
    ok('a snapshot can be stored', snapA.status === 200 && !!snapA.body.id, JSON.stringify(snapA.body));
    const steal = await call(port, 'GET', '/api/v1/backup/' + snapA.body.id, undefined,
      { Authorization: 'Bearer ' + tokenB });
    ok('IDOR: User B cannot fetch User A\'s snapshot by id', steal.status === 404, String(steal.status));
    const stealDel = await call(port, 'DELETE', '/api/v1/snapshots/' + snapA.body.id, undefined,
      { Authorization: 'Bearer ' + tokenB });
    ok('IDOR: User B cannot delete User A\'s snapshot', stealDel.status === 404, String(stealDel.status));
    const stillThere = await call(port, 'GET', '/api/v1/backup/' + snapA.body.id, undefined,
      { Authorization: 'Bearer ' + tokenA });
    ok('and it is still there for User A', stillThere.status === 200);

    /* A body-supplied user id must be ignored. */
    const spoof = await call(port, 'PUT', '/api/v1/state',
      { rev: stB.body.rev, data: stB.body.data, user_id: 'someone-else', userId: 'someone-else' },
      { Authorization: 'Bearer ' + tokenB });
    ok('a user_id in the body is ignored, not obeyed', spoof.status === 200);
    const stA3 = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer ' + tokenA });
    ok('User A\'s document was untouched by that',
      stA3.body.data.txns.some((t) => t.id === 'itest' + stamp));

    /* Unauthenticated and malformed access. */
    const noTok = await call(port, 'GET', '/api/v1/state');
    ok('no token is 401', noTok.status === 401, String(noTok.status));
    const junkTok = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer nonsense' });
    ok('a junk token is 401', junkTok.status === 401, String(junkTok.status));
    /* Injection attempts in a path id. Percent-encoded, because that is how a
       browser would send them and because http.request refuses a raw space —
       the server decodes the segment before it ever reaches a query, so this
       is the same payload either way. */
    for (const payload of ["' OR 1=1 --", "1'; DROP TABLE mm_user; --", "' UNION SELECT * FROM mm_user --"]) {
      const inject = await call(port, 'GET', '/api/v1/backup/' + encodeURIComponent(payload),
        undefined, { Authorization: 'Bearer ' + tokenA });
      ok('injection in a path id is just a 404: ' + payload,
        inject.status === 404, String(inject.status) + ' ' + inject.raw.slice(0, 120));
    }
    /* ...and the table it tried to drop is still there. */
    const stillAlive = await call(port, 'GET', '/api/v1/auth/session', undefined,
      { Authorization: 'Bearer ' + tokenA });
    ok('the accounts table survived the injection attempts', stillAlive.status === 200,
      String(stillAlive.status));
    const badDoc = await call(port, 'PUT', '/api/v1/state',
      { rev: 0, data: { nope: true } }, { Authorization: 'Bearer ' + tokenB });
    ok('a malformed document is refused with 422', badDoc.status === 422, String(badDoc.status));

    /* Weak passwords are refused server-side even if the form is bypassed. */
    const weak = await call(port, 'POST', '/api/v1/auth/register',
      { name: 'C', email: 'c' + stamp + '@example.com', password: 'abc', password2: 'abc' });
    ok('the server refuses a weak password on its own', weak.status === 422, String(weak.status));
    const mismatch = await call(port, 'POST', '/api/v1/auth/register',
      { name: 'C', email: 'c' + stamp + '@example.com', password: 'abcdefg1', password2: 'abcdefg2' });
    ok('the server refuses a mismatched confirmation', mismatch.status === 422 &&
      mismatch.body.code === 'password_mismatch', JSON.stringify(mismatch.body));

    /* Sessions end on request. */
    const out = await call(port, 'POST', '/api/v1/auth/logout', {}, { Authorization: 'Bearer ' + tokenA2 });
    ok('signing out succeeds', out.status === 200);
    const afterOut = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer ' + tokenA2 });
    ok('the signed-out token stops working', afterOut.status === 401, String(afterOut.status));
    const otherStill = await call(port, 'GET', '/api/v1/state', undefined, { Authorization: 'Bearer ' + tokenA });
    ok('the other session on that account still works', otherStill.status === 200);

    } finally {
      /* Clean up after ourselves, whether or not the checks above passed. */
      for (const [tok, who, pw] of [[tokenA, 'A', a.password], [tokenB, 'B', b.password]]) {
        if (!tok) continue;
        const del = await call(port, 'DELETE', '/api/v1/auth/account', { password: pw },
          { Authorization: 'Bearer ' + tok });
        ok('test account ' + who + ' was removed', del.status === 200,
          String(del.status) + ' — delete it by hand if this failed');
      }
      server.close();
    }
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
