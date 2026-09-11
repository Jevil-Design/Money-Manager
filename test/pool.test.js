/* Connection reuse on a serverless runtime.
 *
 * The behaviour this covers is the part that is easy to get wrong and
 * impossible to see in normal use: the container is frozen between requests,
 * so a pooled connection can be dead by the time the next request arrives,
 * and node-postgres hands it back without checking. These tests stub the pg
 * driver so the pool's lifecycle can be observed exactly — no database, and
 * no waiting for a real socket to time out.
 *
 *   node test/pool.test.js
 */
'use strict';

const http = require('http');
const path = require('path');
const Module = require('module');

const API = path.join(__dirname, '..', 'api', 'index.js');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* ------------------------------------------------------------- the fake pg */

/* Tracks everything the module under test does to the driver. */
function makeFakePg(behaviour) {
  const log = {
    pools: 0, connects: 0, releases: 0, ends: 0,
    destroyed: 0,            /* release(err) — the client is thrown away */
    errorListeners: 0,
    poolOptions: [],
    queries: []
  };
  behaviour = behaviour || {};
  let connectNo = 0;

  class FakeClient {
    constructor(n) { this.n = n; this.dead = false; }
    async query(sql, params) {
      log.queries.push(String(sql).trim().split('\n')[0].slice(0, 40));
      if (behaviour.onQuery) {
        const r = behaviour.onQuery(String(sql), this.n, params);
        if (r === 'throw-conn') {
          const e = new Error('Connection terminated unexpectedly');
          e.code = '08006';
          throw e;
        }
        if (r === 'throw-query') {
          const e = new Error('syntax error at or near "nope"');
          e.code = '42601';
          throw e;
        }
        if (r && typeof r === 'object') return r;
      }
      /* Plausible answers for the few reads the code actually makes. */
      if (/pg_encoding_to_char/.test(sql)) return { rows: [{ enc: 'UTF8' }], rowCount: 1 };
      if (/FROM mm_meta/.test(sql)) return { rows: [{ value: '3' }], rowCount: 1 };
      if (/COUNT\(\*\)::int AS n FROM mm_user/.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    release(err) {
      log.releases++;
      if (err) { log.destroyed++; this.dead = true; }
    }
  }

  class FakePool {
    constructor(opts) {
      log.pools++;
      log.poolOptions.push(opts);
      this.opts = opts;
    }
    on(event) { if (event === 'error') log.errorListeners++; return this; }
    async connect() {
      log.connects++;
      connectNo++;
      if (behaviour.failConnect && behaviour.failConnect(connectNo)) {
        throw Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' });
      }
      return new FakeClient(connectNo);
    }
    async end() { log.ends++; }
  }

  return { module: { Pool: FakePool, Client: FakeClient }, log };
}

/* The module under test requires 'pg' lazily, on the first request rather
   than at import, so the hook has to stay installed for the whole run and
   answer with whichever fake the current test is using. */
let currentFakePg = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') {
    if (!currentFakePg) throw new Error('no fake pg installed for this test');
    return currentFakePg;
  }
  return origLoad.apply(this, arguments);
};

/* Load api/index.js with 'pg' replaced, and with a clean module scope so the
   pool it caches does not leak between tests. */
function loadApi(fakePgModule, env) {
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING',
    'DATABASE_URL_UNPOOLED', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL',
    'PG_CONNECTION_STRING', 'MM_DIAGNOSTICS', 'ALLOWED_EMAILS', 'AUTH_SECRET']) {
    delete process.env[k];
  }
  Object.assign(process.env, env || {});
  currentFakePg = fakePgModule;
  delete require.cache[require.resolve(API)];
  return require(API);
}

/* Same rewrite Vercel applies, so routing is exercised as deployed. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const mmpath = u.pathname.replace(/^\/api\/?/, '');
      req.url = '/api/index?mmpath=' + encodeURIComponent(mmpath);
      req.query = { mmpath };
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
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

const URL_A = 'postgres://u:pw@db-a.example.org:5432/mm?sslmode=require';
const URL_B = 'postgres://u:pw@db-b.example.org:5432/mm?sslmode=require';

(async () => {

  /* ------------------------------------------------------------------ 1 */
  console.log('\nThe pool is built once and reused across invocations');
  {
    const fake = makeFakePg();
    const handler = loadApi(fake.module, { DATABASE_URL: URL_A, VERCEL_ENV: 'production' });
    const server = await startServer(handler);
    const port = server.address().port;

    const r1 = await call(port, 'GET', '/api/health');
    const r2 = await call(port, 'GET', '/api/health');
    const r3 = await call(port, 'GET', '/api/health');

    ok('all three requests succeed', r1.status === 200 && r2.status === 200 && r3.status === 200,
      [r1.status, r2.status, r3.status].join(','));
    ok('exactly ONE pool was constructed for three requests', fake.log.pools === 1,
      String(fake.log.pools));
    ok('each request checked out a connection', fake.log.connects === 3, String(fake.log.connects));
    ok('each request returned it to the pool', fake.log.releases === 3, String(fake.log.releases));
    ok('no connection was destroyed', fake.log.destroyed === 0, String(fake.log.destroyed));
    ok('the pool was never torn down between requests', fake.log.ends === 0, String(fake.log.ends));
    ok('an error listener is attached, so a dropped idle socket cannot crash the function',
      fake.log.errorListeners === 1, String(fake.log.errorListeners));

    const o = fake.log.poolOptions[0];
    ok('max is 1 — one in-flight request per container', o.max === 1, String(o.max));
    ok('idle connections are allowed to expire', o.idleTimeoutMillis > 0, String(o.idleTimeoutMillis));
    ok('the runtime may exit while the pool is idle', o.allowExitOnIdle === true, String(o.allowExitOnIdle));
    ok('there is a connection timeout', o.connectionTimeoutMillis > 0, String(o.connectionTimeoutMillis));
    ok('TLS certificates are verified by default',
      o.ssl && o.ssl.rejectUnauthorized === true, JSON.stringify(o.ssl));
    ok('the connection is labelled for the provider dashboard',
      o.application_name === 'money-manager', String(o.application_name));

    /* The schema is applied once per container, not once per request. */
    const schemaRuns = fake.log.queries.filter((q) => /CREATE TABLE IF NOT EXISTS mm_user/.test(q)).length;
    ok('the schema is applied once per container, not per request', schemaRuns <= 1, String(schemaRuns));

    server.close();
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\nA connection that died while the container was frozen is discarded');
  {
    /* The first client handed out is stale: its validation query fails with a
       connection error, exactly as a socket dropped during a freeze would. */
    let firstValidation = true;
    const fake = makeFakePg({
      onQuery: (sql, clientNo) => {
        if (/^SELECT 1$/.test(sql.trim()) && clientNo === 1 && firstValidation) {
          firstValidation = false;
          return 'throw-conn';
        }
        return null;
      }
    });
    const handler = loadApi(fake.module, { DATABASE_URL: URL_A, VERCEL_ENV: 'production' });
    const server = await startServer(handler);
    const port = server.address().port;

    const r = await call(port, 'GET', '/api/health');
    ok('the request still succeeds', r.status === 200, 'HTTP ' + r.status + ' ' + r.raw.slice(0, 120));
    ok('the dead connection was detected and replaced', fake.log.connects === 2,
      String(fake.log.connects));
    ok('the dead connection was destroyed, not pooled', fake.log.destroyed === 1,
      String(fake.log.destroyed));
    ok('the pool itself was kept', fake.log.pools === 1 && fake.log.ends === 0);
    server.close();
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\nA database that is genuinely unreachable is reported safely');
  {
    const fake = makeFakePg({ failConnect: () => true });
    const handler = loadApi(fake.module, { DATABASE_URL: URL_A, VERCEL_ENV: 'production' });
    const server = await startServer(handler);
    const port = server.address().port;

    const reg = await call(port, 'POST', '/api/v1/auth/register',
      { name: 'A', email: 'a@b.co', password: 'abcdefg1', password2: 'abcdefg1' });
    ok('registration returns 503', reg.status === 503, String(reg.status));
    ok('the code is db_unreachable', reg.body && reg.body.code === 'db_unreachable',
      reg.body && reg.body.code);
    ok('the message is the safe sentence',
      reg.body && /^Cloud database is currently unavailable\./.test(reg.body.error || ''),
      reg.body && reg.body.error);
    ok('the host and password are not in the reply',
      !/db-a\.example\.org|pw@|ETIMEDOUT/.test(reg.raw), reg.raw.slice(0, 160));
    ok('it gave up after a bounded number of attempts, it did not hang',
      fake.log.connects === 3, String(fake.log.connects));

    const h = await call(port, 'GET', '/api/health');
    ok('health reports the outage', h.status === 503 && h.body.status === 'error' &&
      h.body.database === 'unavailable', JSON.stringify(h.body && h.body.status));
    ok('health still says the variable IS set, so the operator knows it landed',
      h.body.databaseUrlVarsSet.join(',') === 'DATABASE_URL',
      JSON.stringify(h.body.databaseUrlVarsSet));
    server.close();
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\nA changed connection string rebuilds the pool');
  {
    const fake = makeFakePg();
    let handler = loadApi(fake.module, { DATABASE_URL: URL_A, VERCEL_ENV: 'production' });
    let server = await startServer(handler);
    let port = server.address().port;
    await call(port, 'GET', '/api/health');
    ok('one pool for the first database', fake.log.pools === 1, String(fake.log.pools));

    /* Same warm module, new value — a redeploy onto a different database, or
       a rotated password. The old pool must not keep being used. */
    process.env.DATABASE_URL = URL_B;
    await call(port, 'GET', '/api/health');
    ok('a second pool is built for the new database', fake.log.pools === 2, String(fake.log.pools));
    ok('the stale pool was shut down', fake.log.ends === 1, String(fake.log.ends));
    ok('the new pool points at the new host',
      fake.log.poolOptions[1].connectionString === URL_B);

    /* Unchanged again — no churn. */
    await call(port, 'GET', '/api/health');
    ok('an unchanged value does not rebuild the pool', fake.log.pools === 2, String(fake.log.pools));
    server.close();
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\nA broken connection mid-request is not handed to the next request');
  {
    /* The validation passes, then the real work fails with a connection
       error — the socket died between the two. */
    const fake = makeFakePg({
      onQuery: (sql) => (/pg_encoding_to_char/.test(sql) ? 'throw-conn' : null)
    });
    const handler = loadApi(fake.module, { DATABASE_URL: URL_A, VERCEL_ENV: 'production' });
    const server = await startServer(handler);
    const port = server.address().port;

    await call(port, 'GET', '/api/health');
    ok('the broken connection was destroyed rather than pooled', fake.log.destroyed >= 1,
      String(fake.log.destroyed));
    server.close();
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\nA query error is NOT treated as a broken connection');
  {
    /* A bad query says nothing about the socket. Throwing the connection away
       on every SQL error would mean reconnecting constantly. */
    const fake = makeFakePg({
      onQuery: (sql) => (/pg_encoding_to_char/.test(sql) ? 'throw-query' : null)
    });
    const handler = loadApi(fake.module, { DATABASE_URL: URL_A, VERCEL_ENV: 'production' });
    const server = await startServer(handler);
    const port = server.address().port;

    const h = await call(port, 'GET', '/api/health');
    ok('the request is still answered', h.status === 200 || h.status === 503, String(h.status));
    ok('the connection went back to the pool intact', fake.log.destroyed === 0,
      String(fake.log.destroyed));
    ok('and it was released', fake.log.releases === 1, String(fake.log.releases));
    server.close();
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\nNo variable set: the driver is never even asked for a connection');
  {
    const fake = makeFakePg();
    const handler = loadApi(fake.module, { VERCEL_ENV: 'production' });
    const server = await startServer(handler);
    const port = server.address().port;

    const h = await call(port, 'GET', '/api/health');
    ok('health reports no_database', h.body && h.body.databaseCode === 'no_database',
      h.body && h.body.databaseCode);
    ok('no pool was constructed', fake.log.pools === 0, String(fake.log.pools));
    ok('no connection was attempted', fake.log.connects === 0, String(fake.log.connects));
    ok('and it reports that nothing is set', h.body.databaseUrlVarsSet.length === 0);
    server.close();
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\nA local database connects without TLS');
  {
    const fake = makeFakePg();
    const handler = loadApi(fake.module,
      { DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/mm', VERCEL_ENV: 'development' });
    const server = await startServer(handler);
    const port = server.address().port;
    await call(port, 'GET', '/api/health');
    ok('TLS is off for localhost', fake.log.poolOptions[0].ssl === false,
      JSON.stringify(fake.log.poolOptions[0].ssl));
    server.close();
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\nPGSSL_NO_VERIFY is honoured only when explicitly set');
  {
    const fake = makeFakePg();
    const handler = loadApi(fake.module,
      { DATABASE_URL: URL_A, PGSSL_NO_VERIFY: '1', VERCEL_ENV: 'production' });
    const server = await startServer(handler);
    const port = server.address().port;
    await call(port, 'GET', '/api/health');
    ok('certificate verification can be turned off deliberately',
      fake.log.poolOptions[0].ssl.rejectUnauthorized === false);
    server.close();
    delete process.env.PGSSL_NO_VERIFY;
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
