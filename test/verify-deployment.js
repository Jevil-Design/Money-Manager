/* Verify a LIVE deployment, end to end.
 *
 *   node test/verify-deployment.js https://your-project.vercel.app
 *
 * Read-only by default: it checks /api/health and reports, in plain terms,
 * exactly which deployment step is still missing.
 *
 * Add --full to also create a throwaway account, write a transaction, read it
 * back from a second session, confirm a second user cannot see it, and then
 * delete both accounts. Only do that against a deployment you are happy to
 * have two short-lived accounts created in.
 *
 *   node test/verify-deployment.js https://your-project.vercel.app --full
 */
'use strict';

const BASE = String(process.argv[2] || '').replace(/\/+$/, '');
const FULL = process.argv.includes('--full');

if (!BASE) {
  console.error('Usage: node test/verify-deployment.js https://your-project.vercel.app [--full]');
  process.exit(2);
}
if (!/^https?:\/\//.test(BASE)) {
  console.error('The URL must start with https://');
  process.exit(2);
}

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

async function api(method, path, body, token) {
  const headers = { 'X-Device': 'deployment check' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* keep the raw text */ }
  return { status: res.status, body: json, raw: text };
}

/* Everything that must never appear in a reply a browser receives. */
const FORBIDDEN = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL',
  'PG_CONNECTION_STRING', 'ALLOWED_EMAILS', 'AUTH_SECRET', 'password=', 'sslmode',
  'ECONNREFUSED', 'node:internal'];

/* ------------------------------------------------------------------ report */

function explain(h) {
  const set = (h && h.databaseUrlVarsSet) || [];
  console.log('\n' + '-'.repeat(66));
  if (h && h.database === 'connected') {
    console.log('The database is connected. Nothing further is required.');
    if (h.encodingOk === false) {
      console.log('\nBUT: this database is ' + h.encoding + ', not UTF8, so it cannot store the');
      console.log('rupee sign and saves will fail. Recreate it with UTF8 encoding.');
    }
    if (!h.authSecretSet) {
      console.log('\nOptional: AUTH_SECRET is not set. Sessions work without it; setting it');
      console.log('means a database dump holds nothing replayable as a login.');
    }
    if (h.accessPolicy !== 'allowlist') {
      console.log('\nWorth doing before you share the URL: ALLOWED_EMAILS is not set, so the');
      console.log('FIRST account to register claims this deployment and everyone after is');
      console.log('refused. Set it to the addresses that should be able to sign up.');
    }
    if (h.schemaVersion && h.schemaExpected && h.schemaVersion !== h.schemaExpected) {
      console.log('\nNote: schema version ' + h.schemaVersion + ' is behind ' + h.schemaExpected +
        '. The next request applies it.');
    }
    console.log('-'.repeat(66));
    return;
  }

  console.log('The database is NOT connected. What to do next:');
  if (!set.length) {
    console.log('');
    console.log('  No connection-string variable is set on this deployment at all.');
    console.log('  Either it was never added, or it was added and the project has not');
    console.log('  been redeployed since — environment variables only reach the running');
    console.log('  app on the NEXT deployment, which is the usual cause.');
    console.log('');
    console.log('  1. Vercel dashboard -> Storage -> Create -> Neon/Postgres');
    console.log('     -> Connect to project.  That sets DATABASE_URL for you.');
    console.log('     Or add DATABASE_URL yourself under Settings -> Environment');
    console.log('     Variables, for all environments.');
    console.log('  2. Deployments -> the newest one -> Redeploy.');
    console.log('  3. Run this script again.');
  } else {
    console.log('');
    console.log('  ' + set.join(', ') + ' is set, so the variable landed — but the');
    console.log('  database refused the connection. Reported reason: ' +
      ((h && h.databaseCode) || 'unknown') + '.');
    console.log('');
    if (h && h.databaseCode === 'db_misconfigured') {
      console.log('  The value is not a usable Postgres URL. It should look like');
      console.log('  postgres://user:password@host:5432/dbname?sslmode=require');
      console.log('  Check for a truncated paste or a leftover placeholder host.');
    } else if (h && h.databaseCode === 'db_driver_missing') {
      console.log('  The "pg" package is not in the deployment. Check that package.json');
      console.log('  at the repository root lists it and that the build installed it.');
    } else {
      console.log('  Usually: the database is paused or deleted, the credentials have');
      console.log('  been rotated, or its firewall does not allow this deployment.');
      console.log('  If the provider needs a certificate Node does not trust, set');
      console.log('  PGSSL_NO_VERIFY=1 and redeploy.');
    }
    console.log('');
    console.log('  The exact reason is in the function log:');
    console.log('  Vercel dashboard -> Deployment -> Functions -> Logs.');
  }
  console.log('-'.repeat(66));
}

/* -------------------------------------------------------------------- main */

(async () => {
  console.log('Checking ' + BASE + '\n');

  console.log('The app is being served');
  let page;
  try {
    page = await fetch(BASE + '/');
    ok('the page loads', page.ok, 'HTTP ' + page.status);
    const html = await page.text();
    ok('it is the Money Manager page', /Money Manager/.test(html));
    /* A credential must never be in the HTML, by any route. */
    ok('the HTML carries no database credential',
      !FORBIDDEN.some((f) => html.indexOf(f) >= 0) && !/postgres(ql)?:\/\/[^\s"']*@/.test(html));
  } catch (e) {
    ok('the page loads', false, e.message);
    console.log('\nThe deployment is not reachable at all. Check the URL.');
    process.exit(1);
  }

  console.log('\nHealth');
  const h = await api('GET', '/api/health');
  ok('/api/health answers', h.status === 200 || h.status === 503, 'HTTP ' + h.status);
  ok('it returns JSON', !!h.body, h.raw.slice(0, 120));
  if (!h.body) {
    console.log('\n/api/health did not return JSON. The rewrite in vercel.json may be');
    console.log('missing, or the function failed to start. Check the function log.');
    process.exit(1);
  }
  ok('it reports a status', h.body.status === 'ok' || h.body.status === 'error', String(h.body.status));
  ok('the reply names no variable value',
    !/postgres(ql)?:\/\/[^\s"']*@/.test(h.raw), 'a connection string appeared in /api/health');
  ok('the deployed build is the fixed one (health reports a schema version field)',
    'schemaExpected' in h.body,
    'this looks like an older build — push and redeploy the current code');

  const connected = h.body.database === 'connected';
  console.log('\n  database:            ' + h.body.database);
  console.log('  databaseCode:        ' + (h.body.databaseCode || '—'));
  console.log('  variables set:       ' + (((h.body.databaseUrlVarsSet || []).join(', ')) || '(none)'));
  console.log('  schema version:      ' + (h.body.schemaVersion || '—') +
    ' (expected ' + (h.body.schemaExpected || '—') + ')');
  console.log('  encoding:            ' + (h.body.encoding || '—') +
    (h.body.encodingOk === false ? '  ** NOT UTF8 **' : ''));
  console.log('  accounts:            ' + (h.body.accounts === null || h.body.accounts === undefined ? '—' : h.body.accounts));
  console.log('  AUTH_SECRET set:     ' + (h.body.authSecretSet ? 'yes' : 'no'));
  console.log('  who may register:    ' + (h.body.accessPolicy || '—'));

  if (!connected) {
    /* The behaviour that this whole change was about: a real user hitting
       Create Account must get a safe sentence, not a configuration dump. */
    console.log('\nThe outage is reported safely to the browser');
    const reg = await api('POST', '/api/v1/auth/register',
      { name: 'Check', email: 'check@example.invalid', password: 'abcdefg1', password2: 'abcdefg1' });
    ok('Create Account returns 503, not a crash', reg.status === 503, 'HTTP ' + reg.status);
    ok('the message is the safe sentence',
      !!reg.body && /^Cloud database is currently unavailable\./.test(reg.body.error || ''),
      reg.body && reg.body.error);
    ok('the old configuration dump is gone', !/No database is configured/.test(reg.raw));
    ok('nothing sensitive is in the reply',
      !FORBIDDEN.some((f) => reg.raw.indexOf(f) >= 0), reg.raw.slice(0, 200));
    explain(h.body);
    process.exit(1);
  }

  ok('the database is connected', true);
  ok('the database is UTF8 and can store the rupee sign', h.body.encodingOk === true,
    String(h.body.encoding));
  ok('initialisation has run', h.body.schemaVersion === h.body.schemaExpected,
    (h.body.schemaVersion || 'none') + ' vs ' + h.body.schemaExpected);

  if (!FULL) {
    explain(h.body);
    console.log('\nRead-only checks only. Add --full to create, use and delete two');
    console.log('throwaway accounts and verify the whole sign-up / isolation flow.');
    console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
    process.exit(fails ? 1 : 0);
  }

  /* ------------------------------------------------------------ full flow */

  console.log('\nThe full flow (two throwaway accounts, deleted at the end)');
  /* The addresses can be pinned, because a deployment with ALLOWED_EMAILS set
     will refuse anything not on the list — and putting a generated,
     timestamped address on that list is impossible. Set MM_CHECK_EMAIL_A and
     MM_CHECK_EMAIL_B to addresses you have allowed, run the check, then take
     them off the list again. */
  const stamp = Date.now();
  const A = {
    name: 'Check A',
    email: process.env.MM_CHECK_EMAIL_A || 'mm-check-a-' + stamp + '@example.com',
    password: 'abcdefg1'
  };
  const B = {
    name: 'Check B',
    email: process.env.MM_CHECK_EMAIL_B || 'mm-check-b-' + stamp + '@example.com',
    password: 'hijklmn2'
  };
  let tokenA = '', tokenB = '';

  try {
    const ra = await api('POST', '/api/v1/auth/register',
      { name: A.name, email: A.email, password: A.password, password2: A.password, samples: true });
    ok('TEST 2: an account is created', ra.status === 200 && !!ra.body.token,
      'HTTP ' + ra.status + ' ' + JSON.stringify(ra.body).slice(0, 160));
    if (ra.status === 403) {
      console.log('\n  Registration was refused. ALLOWED_EMAILS does not include this');
      console.log('  address, or an account already exists and the deployment is set to');
      console.log('  "first account claims it". That is a configuration answer, not a');
      console.log('  fault — the database itself is connected and working.');
      process.exit(fails ? 1 : 0);
    }
    if (ra.status !== 200) { throw new Error('cannot continue without an account'); }
    tokenA = ra.body.token;

    ok('TEST 11: sample data was created for this user only',
      !!ra.body.state && ra.body.state.data.accounts.length === 4 && ra.body.state.data.txns.length > 0,
      JSON.stringify(ra.body.state && {
        accounts: ra.body.state.data.accounts.length, txns: ra.body.state.data.txns.length
      }));
    ok('no password or hash comes back',
      !new RegExp(A.password).test(ra.raw) && !/pw_hash|"salt"/.test(ra.raw));

    const dupe = await api('POST', '/api/v1/auth/register',
      { name: A.name, email: A.email, password: A.password, password2: A.password });
    ok('TEST 3: the same email again is refused',
      dupe.status === 409 && /already exists/i.test(dupe.body.error || ''),
      'HTTP ' + dupe.status + ' ' + (dupe.body && dupe.body.error));

    const bad = await api('POST', '/api/v1/auth/login', { email: A.email, password: 'wrongpass9' });
    ok('TEST 4: a wrong password is rejected', bad.status === 401, 'HTTP ' + bad.status);

    const good = await api('POST', '/api/v1/auth/login', { email: A.email, password: A.password });
    ok('TEST 5: the right password signs in', good.status === 200 && !!good.body.token,
      'HTTP ' + good.status);
    const tokenA2 = good.body.token;

    const st0 = await api('GET', '/api/v1/state', undefined, tokenA);
    ok('the book reads back', st0.status === 200 && !!st0.body.data);
    const doc = st0.body.data;
    doc.txns.push({
      id: 'icheck' + stamp, date: new Date().toISOString().slice(0, 10), type: 'expense',
      accountId: doc.accounts[0].id, toAccountId: '',
      categoryId: (doc.categories.find((c) => c.type === 'expense') || {}).id || '',
      sub: '', amount: 123.45, contents: 'Deployment check ₹', details: '',
      payment: 'Cash', notes: '', tags: [], attachment: null,
      ref: '', reconciled: false, reimb: false, reimbWho: '', reimbStatus: '', importId: '',
      createdAt: Date.now(), updatedAt: Date.now()
    });
    const put = await api('PUT', '/api/v1/state', { rev: st0.body.rev, data: doc }, tokenA);
    ok('TEST 6: a transaction is stored in Postgres',
      put.status === 200 && put.body.rev === st0.body.rev + 1,
      'HTTP ' + put.status + ' ' + JSON.stringify(put.body).slice(0, 160));

    const st1 = await api('GET', '/api/v1/state', undefined, tokenA);
    ok('TEST 7: it is still there on a fresh read',
      st1.body.data.txns.some((t) => t.id === 'icheck' + stamp));
    ok('TEST 7: the rupee sign survived the round trip',
      st1.body.data.txns.some((t) => t.contents === 'Deployment check ₹'));

    const st2 = await api('GET', '/api/v1/state', undefined, tokenA2);
    ok('TEST 8: a second session sees the same data',
      st2.status === 200 && st2.body.rev === st1.body.rev &&
      st2.body.data.txns.some((t) => t.id === 'icheck' + stamp));

    const stale = await api('PUT', '/api/v1/state', { rev: st0.body.rev, data: doc }, tokenA2);
    ok('a stale save is refused rather than overwriting', stale.status === 409, 'HTTP ' + stale.status);

    const rb = await api('POST', '/api/v1/auth/register',
      { name: B.name, email: B.email, password: B.password, password2: B.password, samples: false });
    if (rb.status === 200) {
      tokenB = rb.body.token;
      const stB = await api('GET', '/api/v1/state', undefined, tokenB);
      ok('TEST 9: User B gets their own empty book',
        stB.status === 200 && stB.body.data.accounts.length === 0 && stB.body.data.txns.length === 0,
        JSON.stringify({ accounts: stB.body.data.accounts.length, txns: stB.body.data.txns.length }));
      ok('TEST 9: User B cannot see User A\'s transaction',
        !stB.body.data.txns.some((t) => t.id === 'icheck' + stamp));
      ok('TEST 9: User B has their own default categories',
        stB.body.data.categories.length > 0, String(stB.body.data.categories.length));

      const snapA = await api('POST', '/api/v1/backup',
        { label: 'deployment check', payload: st1.body.data }, tokenA);
      if (snapA.status === 200) {
        const steal = await api('GET', '/api/v1/backup/' + snapA.body.id, undefined, tokenB);
        ok('IDOR: User B cannot read User A\'s snapshot by id', steal.status === 404,
          'HTTP ' + steal.status);
      }
    } else {
      console.log('  SKIP  TEST 9: a second account could not be created (HTTP ' + rb.status +
        ') — ' + ((rb.body && rb.body.error) || '') );
      console.log('         ALLOWED_EMAILS likely does not include it. Isolation is covered');
      console.log('         by test/api.test.js against a scratch database.');
    }

    const noTok = await api('GET', '/api/v1/state');
    ok('an unauthenticated read is refused', noTok.status === 401, 'HTTP ' + noTok.status);
    const junk = await api('GET', '/api/v1/state', undefined, 'nonsense');
    ok('a junk token is refused', junk.status === 401, 'HTTP ' + junk.status);
  } finally {
    console.log('\nCleaning up');
    for (const [tok, who, pw] of [[tokenA, 'A', A.password], [tokenB, 'B', B.password]]) {
      if (!tok) continue;
      const del = await api('DELETE', '/api/v1/auth/account', { password: pw }, tok);
      ok('throwaway account ' + who + ' was deleted', del.status === 200,
        'HTTP ' + del.status + ' — delete it by hand if this failed');
    }
  }

  explain(h.body);
  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\n' + e.message);
  process.exit(1);
});
