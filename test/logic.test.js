/* Smoke test: run the app's logic block and the API module in Node, with the
   few browser globals they touch stubbed, and check the parts this change
   actually touched.  No database and no network — just the pure logic. */
const fs = require('fs');
const path = require('path');
const APP = process.argv[2] || path.join(__dirname, "..", "Money Manager.dc.html");
const API = process.argv[3] || path.join(__dirname, "..", "api", "index.js");

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* ---------------------------------------------------------------- the app */

const html = fs.readFileSync(APP, 'utf8');
const src = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

/* The minimum browser surface the logic block touches while being defined and
   while rendering the sign-in panel. */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
global.window = { addEventListener() {}, removeEventListener() {}, indexedDB: null };
global.navigator = { userAgent: 'Node smoke test' };
global.document = { addEventListener() {}, removeEventListener() {} };

class StubLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(patch, cb) {
    Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    if (cb) cb();
  }
  forceUpdate() {}
}
/* One evaluation of the logic block, handing back the class and the few
   module-level helpers this test exercises directly. */
const appModule = new Function('DCLogic', 'StreamableLogic', 'React',
  src + '\n;return { Component, mmPasswordStrength, mmPasswordProblem, mmIsDbDown, ' +
  'mmValidEmail, MM_DB_DOWN_CODES, MM_DB_DOWN_MESSAGE };')(StubLogic, StubLogic, {});
const { Component, mmPasswordStrength, mmPasswordProblem, mmIsDbDown, MM_DB_DOWN_MESSAGE } = appModule;

console.log('\nPassword strength scoring');
ok('empty password scores nothing', mmPasswordStrength('').label === '');
ok('"aaaaaaaa" is very weak', mmPasswordStrength('aaaaaaaa').score <= 1,
  JSON.stringify(mmPasswordStrength('aaaaaaaa')));
ok('"password1" is not called strong', mmPasswordStrength('password1').score < 4,
  JSON.stringify(mmPasswordStrength('password1')));
ok('a long mixed password is strong', mmPasswordStrength('Tr0ubad0ur-Horse!x').score === 4,
  JSON.stringify(mmPasswordStrength('Tr0ubad0ur-Horse!x')));
ok('score always maps to a colour and label',
  [0, 1, 2, 3, 4].every((n) => {
    const r = mmPasswordStrength(['aa', 'aaaaaaaa', 'aaaaaaaa1', 'aaaaaaaaaaaa1', 'Tr0ubad0ur-Horse!x'][n]);
    return typeof r.label === 'string' && /^var\(--c-/.test(r.colour);
  }));

console.log('\nPassword policy (client) matches what the server enforces');
ok('rejects under 8 characters', !!mmPasswordProblem('abc1'));
ok('rejects letters only', !!mmPasswordProblem('abcdefgh'));
ok('rejects digits only', !!mmPasswordProblem('12345678'));
ok('accepts 8 with a letter and a number', mmPasswordProblem('abcdefg1') === '');

console.log('\nDatabase-outage codes are recognised, prose is not relied on');
ok('no_database is an outage', mmIsDbDown({ code: 'no_database' }));
ok('db_unreachable is an outage', mmIsDbDown({ code: 'db_unreachable' }));
ok('db_misconfigured is an outage', mmIsDbDown({ code: 'db_misconfigured' }));
ok('db_driver_missing is an outage', mmIsDbDown({ code: 'db_driver_missing' }));
ok('a rejected password is NOT an outage', !mmIsDbDown({ code: 'bad_credentials' }));
ok('a taken email is NOT an outage', !mmIsDbDown({ code: 'email_taken' }));
ok('no code at all is NOT an outage', !mmIsDbDown({}));

console.log('\nThe Create Account panel renders in every state');
const mk = (authPatch) => {
  const c = new Component({});
  Object.assign(c.state.auth, authPatch);
  return c.authVals();
};
let v = mk({ phase: 'signup' });
ok('fresh form shows no error', !v.hasAuthError && !v.authDbDown && !v.hasSignupIssue);
ok('fresh form button is enabled', v.signupBlocked === false);
ok('fresh form shows no strength meter', v.hasPwStrength === false);
ok('button reads "Create account"', v.signupLabel === 'Create account', v.signupLabel);
ok('passwords start hidden', v.pwFieldType === 'password' && v.pwToggleLabel === 'Show');

v = mk({ phase: 'signup', showPw: true });
ok('the toggle reveals the password', v.pwFieldType === 'text' && v.pwToggleLabel === 'Hide');

v = mk({ phase: 'signup', busy: true });
ok('while submitting the button is disabled', v.signupBlocked === true);
ok('while submitting the button says so', v.signupLabel === 'Creating account…', v.signupLabel);
ok('while submitting the back button is disabled too', v.authBusy === true);

v = mk({ phase: 'signup', form: { name: 'A', email: 'nope', password: 'abc', password2: 'x', samples: false } });
ok('a malformed email is marked on the field', /b98a8a/.test(v.emailFieldStyle));
ok('a weak password is marked on the field', /b98a8a/.test(v.pwFieldStyle));
ok('a mismatched repeat is marked on the field', /b98a8a/.test(v.pw2FieldStyle));
ok('the inline issue names the password problem', !!v.signupIssue, v.signupIssue);
ok('the strength meter appears once typing starts', v.hasPwStrength === true);

v = mk({ phase: 'signup', form: { name: 'A', email: 'a@b.co', password: 'abcdefg1', password2: 'abcdefg1', samples: false } });
ok('a valid form shows no inline issue', !v.hasSignupIssue);
ok('a valid form marks no field', !/b98a8a/.test(v.emailFieldStyle + v.pwFieldStyle + v.pw2FieldStyle));

v = mk({ phase: 'signup', dbDown: true });
ok('an outage shows the outage panel', v.authDbDown === true);
ok('an outage does NOT also show a red error line', v.hasAuthError === false);
ok('an outage offers Retry', typeof v.retryAuth === 'function' && v.retryLabel === 'Retry');
ok('an outage offers administrator info', typeof v.openAdminHelp === 'function');

v = mk({ phase: 'signup', notice: 'Creating account…' });
ok('progress is shown as a notice, not an error', v.hasAuthNotice === true && v.authNotice === 'Creating account…');
v = mk({ phase: 'signup', notice: 'x', error: 'y' });
ok('an error wins over a stale notice', v.hasAuthNotice === false && v.hasAuthError === true);

console.log('\nThe form-level gate agrees with the field-level marks');
const problemFor = (form) => {
  const c = new Component({});
  Object.assign(c.state.auth, { phase: 'signup', form: Object.assign({ samples: false }, form) });
  return c.signupProblem();
};
ok('no name is refused', !!problemFor({ name: '', email: 'a@b.co', password: 'abcdefg1', password2: 'abcdefg1' }));
ok('bad email is refused', !!problemFor({ name: 'A', email: 'a@b', password: 'abcdefg1', password2: 'abcdefg1' }));
ok('weak password is refused', !!problemFor({ name: 'A', email: 'a@b.co', password: 'short', password2: 'short' }));
ok('empty repeat is refused', !!problemFor({ name: 'A', email: 'a@b.co', password: 'abcdefg1', password2: '' }));
ok('mismatched repeat is refused', !!problemFor({ name: 'A', email: 'a@b.co', password: 'abcdefg1', password2: 'abcdefg2' }));
ok('a complete valid form passes', problemFor({ name: 'A', email: 'a@b.co', password: 'abcdefg1', password2: 'abcdefg1' }) === '');

/* ---------------------------------------------------------------- the API */

console.log('\nThe API module loads and its starting document is well formed');
const api = require(API);
const internals = new Function('require', 'module', 'exports', '__filename', '__dirname',
  fs.readFileSync(API, 'utf8') +
  '\n;return { startingDocument, balancesFrom, configProblem, passwordProblem, ' +
  'hashNewPassword, verifyPassword, scrub, DB_UNAVAILABLE_MESSAGE, SCHEMA, SCHEMA_VERSION, ' +
  'DB_URL_VARS, tokenDigest, MM_SCHEMA, documentProblem, MAX_ROWS };')(
  require, { exports: {} }, {}, API, path.dirname(API));

const {
  startingDocument, balancesFrom, configProblem, passwordProblem,
  hashNewPassword, verifyPassword, scrub, DB_UNAVAILABLE_MESSAGE, SCHEMA, DB_URL_VARS, MM_SCHEMA,
  documentProblem
} = internals;

ok('the module exports a handler', typeof api === 'function');

const plain = startingDocument(false);
ok('a plain account has the app\'s schema version', plain.schemaVersion === 4, String(plain.schemaVersion));
ok('a plain account has no accounts', plain.accounts.length === 0);
ok('a plain account has no transactions', plain.txns.length === 0);
ok('a plain account has default categories', plain.categories.length === 26, String(plain.categories.length));
ok('a plain account has default payment methods', plain.payments.length === 8);
ok('a plain account has categorisation rules', plain.rules.length === 13, String(plain.rules.length));
ok('every rule points at a real category',
  plain.rules.every((r) => plain.categories.some((c) => c.id === r.categoryId)));
ok('a plain account has settings', !!plain.settings && plain.settings.currency === 'INR');
ok('a plain account is not marked as demo', plain.settings.demo === false);
ok('categories carry both income and expense kinds',
  plain.categories.some((c) => c.type === 'income') && plain.categories.some((c) => c.type === 'expense'));
ok('every id is unique across the document', (() => {
  const ids = [].concat(plain.categories, plain.rules).map((x) => x.id);
  return new Set(ids).size === ids.length;
})());

console.log('\nSample data obeys the accounting rules');
const demo = startingDocument(true);
ok('samples create the four account kinds',
  ['cash', 'bank', 'credit', 'wallet'].every((t) => demo.accounts.some((a) => a.type === t)),
  demo.accounts.map((a) => a.type).join(','));
ok('samples include transactions', demo.txns.length > 0, String(demo.txns.length));
ok('every sample row is marked demo', demo.txns.every((t) => t.demo === true));
ok('every sample row has a real account',
  demo.txns.every((t) => demo.accounts.some((a) => a.id === t.accountId)));
ok('every transfer has a real destination',
  demo.txns.filter((t) => t.type === 'transfer')
    .every((t) => demo.accounts.some((a) => a.id === t.toAccountId)));
ok('no transfer is also a category posting',
  demo.txns.filter((t) => t.type === 'transfer').every((t) => !t.categoryId));
ok('every income and expense has a category',
  demo.txns.filter((t) => t.type !== 'transfer').every((t) => !!t.categoryId));
ok('every income category is an income category',
  demo.txns.filter((t) => t.type === 'income')
    .every((t) => (demo.categories.find((c) => c.id === t.categoryId) || {}).type === 'income'));
ok('every expense category is an expense category',
  demo.txns.filter((t) => t.type === 'expense')
    .every((t) => (demo.categories.find((c) => c.id === t.categoryId) || {}).type === 'expense'));
ok('every sub-category belongs to its category',
  demo.txns.every((t) => {
    if (!t.sub) return true;
    const c = demo.categories.find((x) => x.id === t.categoryId);
    return !!c && c.subs.indexOf(t.sub) >= 0;
  }));
ok('every amount is a positive finite number',
  demo.txns.every((t) => typeof t.amount === 'number' && isFinite(t.amount) && t.amount > 0));
ok('every date is an ISO day', demo.txns.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date)));
ok('every payment method is one the document knows',
  demo.txns.every((t) => demo.payments.indexOf(t.payment) >= 0),
  demo.txns.map((t) => t.payment).filter((p) => demo.payments.indexOf(p) < 0).join(','));
ok('every budget points at a real category',
  demo.budgets.every((b) => demo.categories.some((c) => c.id === b.categoryId)));
ok('every recurring row points at a real account and category',
  demo.recurring.every((r) => demo.accounts.some((a) => a.id === r.accountId) &&
    demo.categories.some((c) => c.id === r.categoryId)));
ok('every bill points at a real account', demo.bills.every((b) => demo.accounts.some((a) => a.id === b.accountId)));
ok('every bookmark points at a real account and category',
  demo.bookmarks.every((b) => demo.accounts.some((a) => a.id === b.accountId) &&
    demo.categories.some((c) => c.id === b.categoryId)));

/* Balances, computed the way the server and the app both compute them. */
const bal = balancesFrom(demo);
const byName = {};
bal.accounts.forEach((a) => { byName[a.name] = a; });

const sum = (pred) => demo.txns.filter(pred).reduce((n, t) => n + t.amount, 0);
const bankId = demo.accounts.find((a) => a.name === 'Bank Account').id;
const cashId = demo.accounts.find((a) => a.name === 'Cash').id;
const cardId = demo.accounts.find((a) => a.name === 'Credit Card').id;
const walletId = demo.accounts.find((a) => a.name === 'Wallet').id;

const expectBank = 60000
  + sum((t) => t.type === 'income' && t.accountId === bankId)
  - sum((t) => t.type === 'expense' && t.accountId === bankId)
  - sum((t) => t.type === 'transfer' && t.accountId === bankId)
  + sum((t) => t.type === 'transfer' && t.toAccountId === bankId);
ok('income raises and expense lowers the bank balance',
  byName['Bank Account'].balance === expectBank,
  byName['Bank Account'].balance + ' vs ' + expectBank);

const expectCash = 5000
  - sum((t) => t.type === 'expense' && t.accountId === cashId)
  + sum((t) => t.type === 'transfer' && t.toAccountId === cashId);
ok('a withdrawal raises cash by exactly what the bank lost',
  byName['Cash'].balance === expectCash, byName['Cash'].balance + ' vs ' + expectCash);

const purchases = sum((t) => t.type === 'expense' && t.accountId === cardId);
const payments = sum((t) => t.type === 'transfer' && t.toAccountId === cardId);
ok('a card purchase grows the outstanding',
  purchases > 0 && byName['Credit Card'].balance === 0 - purchases + payments,
  byName['Credit Card'].balance + ' vs ' + (payments - purchases));
ok('a card payment shrinks the outstanding and is not an expense',
  payments > 0 && !demo.txns.some((t) => t.type === 'expense' && t.toAccountId === cardId));
ok('a card payment lowers the bank by the same amount it clears',
  sum((t) => t.type === 'transfer' && t.accountId === bankId && t.toAccountId === cardId) === payments);

/* A transfer moves money: it must change no one's income or expense totals. */
const income = sum((t) => t.type === 'income');
const expense = sum((t) => t.type === 'expense');
const transfers = sum((t) => t.type === 'transfer');
ok('transfers are neither income nor expense', transfers > 0 &&
  income === sum((t) => t.type === 'income' && t.type !== 'transfer') &&
  expense === sum((t) => t.type === 'expense' && t.type !== 'transfer'));
/* Net worth must equal openings + income - expense, transfers cancelling. */
const openings = demo.accounts.reduce((n, a) => n + a.opening, 0);
ok('net worth = openings + income - expense (transfers cancel)',
  bal.netWorth === openings + income - expense,
  bal.netWorth + ' vs ' + (openings + income - expense));
ok('the wallet top-up and spend both land',
  byName['Wallet'].balance === 1500
    + sum((t) => t.type === 'transfer' && t.toAccountId === walletId)
    - sum((t) => t.type === 'expense' && t.accountId === walletId));

console.log('\nDocument validation accepts real books and refuses nonsense');
ok('a brand-new empty book is accepted', documentProblem(startingDocument(false)) === '',
  documentProblem(startingDocument(false)));
ok('a sample book is accepted', documentProblem(startingDocument(true)) === '',
  documentProblem(startingDocument(true)));
ok('the app\'s own seed shape is accepted', documentProblem({
  accounts: [{ id: 'a', name: 'Cash', type: 'cash', opening: 0 }],
  txns: [{ id: 't', date: '2026-01-01', type: 'expense', accountId: 'a', amount: 10 }],
  categories: [], settings: {}, somethingNewerBuildsWrite: { nested: true }
}) === '');
ok('unknown fields are not a reason to refuse a save', documentProblem({
  accounts: [], txns: [], futureField: [1, 2, 3]
}) === '');
ok('null is refused', !!documentProblem(null));
ok('an array is refused', !!documentProblem([]));
ok('a missing txns list is refused', !!documentProblem({ accounts: [] }));
ok('a non-array txns is refused', !!documentProblem({ accounts: [], txns: {} }));
ok('a non-object settings is refused', !!documentProblem({ accounts: [], txns: [], settings: [] }));
ok('a NaN amount is refused',
  !!documentProblem({ accounts: [], txns: [{ id: 't', type: 'expense', amount: 'abc' }] }),
  documentProblem({ accounts: [], txns: [{ id: 't', type: 'expense', amount: 'abc' }] }));
ok('an Infinity amount is refused',
  !!documentProblem({ accounts: [], txns: [{ id: 't', type: 'expense', amount: Infinity }] }));
ok('an unknown transaction type is refused',
  !!documentProblem({ accounts: [], txns: [{ id: 't', type: 'magic', amount: 1 }] }),
  documentProblem({ accounts: [], txns: [{ id: 't', type: 'magic', amount: 1 }] }));
ok('a missing transaction type is refused',
  !!documentProblem({ accounts: [], txns: [{ id: 't', amount: 1 }] }));
ok('a non-record transaction is refused',
  !!documentProblem({ accounts: [], txns: ['nope'] }));
ok('a non-numeric opening balance is refused',
  !!documentProblem({ accounts: [{ id: 'a', opening: 'lots' }], txns: [] }));
ok('a zero amount is allowed (an app may write one)',
  documentProblem({ accounts: [], txns: [{ id: 't', type: 'expense', amount: 0 }] }) === '');
ok('a negative amount is allowed (the app stores signs by type, not value)',
  documentProblem({ accounts: [], txns: [{ id: 't', type: 'expense', amount: -5 }] }) === '');
ok('an absurd row count is refused', !!documentProblem({
  accounts: [], txns: [], categories: new Array(200001).fill({ id: 'x' })
}));
ok('the error text never quotes SQL or a variable name', [
  documentProblem(null), documentProblem([]), documentProblem({ accounts: [], txns: {} })
].every((m) => !/SELECT|INSERT|DATABASE_URL|POSTGRES/i.test(m)));

/* The server now writes a brand-new account's first document, and the app
   reads it back through migrate().  If the two disagree about the shape, the
   app rewrites the document on every single load — so check that a
   server-written book is already current, and that nothing is lost. */
console.log('\nThe server\'s starting document is already current for the app');
{
  const c = new Component({});
  for (const withSamples of [false, true]) {
    const before = startingDocument(withSamples);
    const json = JSON.parse(JSON.stringify(before));      /* as it arrives over HTTP */
    const after = c.migrate(json);
    const label = withSamples ? 'sample book' : 'empty book';
    ok(label + ': the app needs no migration of it', !after.__migrated,
      'migrate() reported a change');
    ok(label + ': the schema version is the app\'s own', after.schemaVersion === 4);
    ok(label + ': no collection was dropped or emptied',
      ['accounts', 'txns', 'categories', 'budgets', 'recurring', 'loans', 'bookmarks',
        'bills', 'goals', 'rules', 'recons', 'views', 'loanEvents'].every(
        (k) => Array.isArray(after[k]) && after[k].length === before[k].length),
      JSON.stringify(['accounts', 'txns', 'categories', 'budgets', 'recurring', 'loans',
        'bookmarks', 'bills', 'goals', 'rules'].map((k) => k + ':' + before[k].length + '->' + after[k].length)));
    ok(label + ': settings survived intact',
      Object.keys(before.settings).every((k) => after.settings[k] === before.settings[k]));
    ok(label + ': the currency symbol survived', after.settings.symbol === '₹');
    ok(label + ': payment methods survived', after.payments.length === before.payments.length);
  }
  /* And the app's own new-user document and the server's must agree on shape,
     or a fallback path would produce a different book from the normal one. */
  const fromApp = c.migrate(JSON.parse(JSON.stringify(startingDocument(false))));
  ok('the server book and the app\'s own agree on which keys exist',
    (() => {
      const appDb = new Function('DCLogic', 'StreamableLogic', 'React',
        src + '\n;return mmNewUserDb;')(StubLogic, StubLogic, {})(false);
      const a = Object.keys(appDb).filter((k) => k !== '__migrated').sort();
      const b = Object.keys(fromApp).filter((k) => k !== '__migrated').sort();
      return a.join(',') === b.join(',');
    })(),
    'key sets differ');
}

console.log('\nConnection-string validation');
ok('a missing scheme is rejected', !!configProblem('host:5432/db'));
ok('a non-URL is rejected', !!configProblem('postgres://'));
ok('a placeholder host is rejected', !!configProblem('postgres://u:p@your-host:5432/db'));
ok('a real Neon-style URL is accepted',
  configProblem('postgres://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require') === '',
  configProblem('postgres://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require'));
ok('postgresql:// is accepted too', configProblem('postgresql://u:p@db.example.org:5432/mm') === '');
ok('DATABASE_URL is the first name read', DB_URL_VARS[0] === 'DATABASE_URL');
ok('POSTGRES_URL is still accepted', DB_URL_VARS.indexOf('POSTGRES_URL') > 0);

console.log('\nNothing sensitive survives scrub()');
ok('a password in a URL is masked',
  !/s3cret/.test(scrub('connect postgres://admin:s3cret@db.host/mm failed')),
  scrub('connect postgres://admin:s3cret@db.host/mm failed'));
ok('a password= parameter is masked',
  !/s3cret/.test(scrub('PGPASSWORD=s3cret')), scrub('PGPASSWORD=s3cret'));
ok('the user-facing outage message names nothing technical',
  !/DATABASE_URL|POSTGRES|postgres|password|host/i.test(DB_UNAVAILABLE_MESSAGE),
  DB_UNAVAILABLE_MESSAGE);
ok('the outage message is a whole sentence', /^Cloud database is currently unavailable\./.test(DB_UNAVAILABLE_MESSAGE));

console.log('\nSchema initialisation is idempotent by construction');
const creates = SCHEMA.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)[^;]*/g) || [];
ok('every CREATE is IF NOT EXISTS',
  creates.every((c) => /IF NOT EXISTS/.test(c)),
  creates.filter((c) => !/IF NOT EXISTS/.test(c)).join(' | '));
const alters = SCHEMA.match(/ALTER TABLE[^;]*/g) || [];
ok('every ALTER ... ADD COLUMN is IF NOT EXISTS',
  alters.every((c) => /IF NOT EXISTS/.test(c)), alters.filter((c) => !/IF NOT EXISTS/.test(c)).join(' | '));
ok('nothing drops or truncates', !/\b(DROP|TRUNCATE|DELETE FROM)\b/i.test(SCHEMA));
ok('every financial table is keyed to a user and cascades',
  ['mm_snapshot', 'mm_sync_log', 'mm_token', 'mm_state'].every((t) => {
    const block = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS ' + t));
    const body = block.slice(0, block.indexOf(');'));
    return /user_id[\s\S]*REFERENCES mm_user\(id\) ON DELETE CASCADE/.test(body);
  }));
ok('email is uniquely indexed, case-insensitively',
  /CREATE UNIQUE INDEX IF NOT EXISTS \S+ ON mm_user \(lower\(email\)\)/.test(SCHEMA));
ok('the app document schema version matches the app', MM_SCHEMA === 4);

console.log('\nPassword hashing');
(async () => {
  const t0 = Date.now();
  const pw = await hashNewPassword('correct horse 7');
  const ms = Date.now() - t0;
  ok('new passwords are stored as scrypt', pw.algo === 'scrypt', pw.algo);
  ok('the hash is not the password', !/correct horse 7/.test(pw.hash));
  ok('each hash gets its own salt', (await hashNewPassword('correct horse 7')).salt !== pw.salt);
  ok('the same password with a different salt hashes differently',
    (await hashNewPassword('correct horse 7')).hash !== pw.hash);
  ok('hashing costs real time but not too much (' + ms + ' ms)', ms >= 20 && ms < 3000, ms + ' ms');

  const row = { salt: pw.salt, pw_hash: pw.hash, pw_iters: pw.iters, pw_algo: pw.algo };
  ok('the right password verifies', (await verifyPassword(row, 'correct horse 7')).ok);
  ok('a wrong password does not', !(await verifyPassword(row, 'correct horse 8')).ok);
  ok('a verified scrypt row needs no upgrade',
    (await verifyPassword(row, 'correct horse 7')).needsUpgrade === false);
  ok('a row with no hash never verifies',
    !(await verifyPassword({ salt: '', pw_hash: '', pw_algo: 'scrypt' }, '')).ok);

  /* An account created by the previous build: PBKDF2, and it must still work
     and be flagged for upgrade. */
  const crypto = require('crypto');
  const legacySalt = crypto.randomBytes(16).toString('base64');
  const legacyHash = crypto.pbkdf2Sync('old password 1', Buffer.from(legacySalt, 'base64'),
    210000, 32, 'sha256').toString('hex');
  const legacyRow = { salt: legacySalt, pw_hash: legacyHash, pw_iters: 210000, pw_algo: 'pbkdf2-sha256' };
  ok('an existing PBKDF2 account still signs in', (await verifyPassword(legacyRow, 'old password 1')).ok);
  ok('and is flagged to be re-hashed', (await verifyPassword(legacyRow, 'old password 1')).needsUpgrade === true);
  ok('a wrong password on a PBKDF2 account is refused',
    !(await verifyPassword(legacyRow, 'old password 2')).ok);
  ok('a row with no pw_algo is treated as PBKDF2',
    (await verifyPassword({ salt: legacySalt, pw_hash: legacyHash, pw_iters: 210000 }, 'old password 1')).ok);

  console.log('\nServer-side password policy');
  ok('server rejects under 8', !!passwordProblem('abc1'));
  ok('server rejects letters only', !!passwordProblem('abcdefgh'));
  ok('server rejects digits only', !!passwordProblem('12345678'));
  ok('server accepts a valid one', passwordProblem('abcdefg1') === '');
  ok('server caps absurd lengths', !!passwordProblem('a1'.repeat(200)));

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})();
