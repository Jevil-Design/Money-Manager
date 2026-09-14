/* Encryption at rest.
 *
 * What goes into Postgres must be ciphertext, what comes back must be the
 * document, a row written before the key existed must still read, a tampered
 * row must fail rather than return altered figures, and a key must be
 * rotatable without rewriting everything first.
 *
 *   node test/crypto.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = path.join(__dirname, '..', 'api', 'index.js');
const SRC = fs.readFileSync(API, 'utf8');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* Load the module's crypto helpers under a chosen key configuration. */
function withKeys(env) {
  for (const k of ['DATA_KEY', 'DATA_KEY_OLD']) delete process.env[k];
  Object.assign(process.env, env || {});
  return new Function('require', 'module', 'exports', '__filename', '__dirname',
    SRC + '\n;return { sealDocument, openDocument, isEncrypted, encryptionOn, ' +
    'parseDataKey, ALL_DATA_KEYS, DATA_KEY };')(
    require, { exports: {} }, {}, API, path.dirname(API));
}

const newKey = () => crypto.randomBytes(32).toString('base64url');
const KEY_A = newKey(), KEY_B = newKey();

const BOOK = {
  schemaVersion: 4,
  accounts: [{ id: 'a1', name: 'HDFC Savings', type: 'bank', opening: 125000 }],
  txns: [{ id: 't1', date: '2026-09-14', type: 'expense', amount: 4999.5, contents: 'Rent paid to landlord' }],
  settings: { currency: 'INR', symbol: '₹' }
};

/* ----------------------------------------------------------------- no key */

console.log('\nWith no key configured, nothing changes');
{
  const m = withKeys({});
  ok('encryption reports itself off', m.encryptionOn() === false);
  const stored = m.sealDocument(BOOK);
  ok('the stored value is plain JSON', JSON.parse(stored).accounts[0].name === 'HDFC Savings');
  ok('and is not an envelope', m.isEncrypted(JSON.parse(stored)) === false);
  ok('a plain row reads straight back',
    m.openDocument(JSON.parse(stored)).txns[0].amount === 4999.5);
}

/* -------------------------------------------------------------- with a key */

console.log('\nWith a key, what reaches the database is ciphertext');
{
  const m = withKeys({ DATA_KEY: KEY_A });
  ok('encryption reports itself on', m.encryptionOn() === true);
  const stored = m.sealDocument(BOOK);
  const env = JSON.parse(stored);

  ok('the stored value is an envelope', m.isEncrypted(env) === true, JSON.stringify(Object.keys(env)));
  ok('it names the algorithm version', env.mmenc === 1);
  ok('it carries a key id so rotation knows what wrote it', typeof env.kid === 'string' && env.kid.length === 8);
  ok('it carries an IV', typeof env.iv === 'string' && Buffer.from(env.iv, 'base64').length === 12);

  /* The thing that actually matters: none of the book is legible. */
  ok('the account name is not in the stored value', stored.indexOf('HDFC Savings') < 0);
  ok('the description is not in the stored value', stored.indexOf('Rent paid') < 0);
  ok('the amount is not in the stored value', stored.indexOf('4999.5') < 0);
  ok('nor is the rupee sign or the currency', stored.indexOf('₹') < 0 && stored.indexOf('INR') < 0);
  ok('no recognisable JSON structure leaks', !/"accounts"|"txns"|"settings"/.test(stored));

  ok('and it round-trips exactly',
    JSON.stringify(m.openDocument(env)) === JSON.stringify(BOOK));
}

console.log('\nEvery write gets its own IV');
{
  const m = withKeys({ DATA_KEY: KEY_A });
  const ivs = new Set(), cts = new Set();
  for (let i = 0; i < 200; i++) {
    const e = JSON.parse(m.sealDocument(BOOK));
    ivs.add(e.iv); cts.add(e.ct);
  }
  /* Reusing an IV under GCM is catastrophic, so this is not a nicety. */
  ok('200 writes produced 200 different IVs', ivs.size === 200, String(ivs.size));
  ok('and 200 different ciphertexts for the same book', cts.size === 200, String(cts.size));
}

/* --------------------------------------------------------- mixed and legacy */

console.log('\nA row written before the key existed still reads');
{
  const before = withKeys({});
  const plain = JSON.parse(before.sealDocument(BOOK));
  const after = withKeys({ DATA_KEY: KEY_A });
  ok('the old plaintext row opens under the new key',
    JSON.stringify(after.openDocument(plain)) === JSON.stringify(BOOK));
  ok('so turning encryption on needs no migration first', true);
  /* And the next write of that row is sealed. */
  ok('rewriting it seals it', after.isEncrypted(JSON.parse(after.sealDocument(plain))) === true);
}

/* ------------------------------------------------------------- tampering */

console.log('\nA tampered row fails rather than returning altered figures');
{
  const m = withKeys({ DATA_KEY: KEY_A });
  const env = JSON.parse(m.sealDocument(BOOK));

  const flipped = Object.assign({}, env);
  const buf = Buffer.from(env.ct, 'base64');
  buf[5] = buf[5] ^ 0xff;                       /* one bit of the ciphertext */
  flipped.ct = buf.toString('base64');
  let threw = null;
  try { m.openDocument(flipped); } catch (e) { threw = e; }
  ok('a single flipped byte is rejected', !!threw, 'it decrypted anyway');
  ok('and the error says nothing about keys or crypto internals',
    threw && !/aes|gcm|tag|cipher/i.test(threw.message), threw && threw.message);

  const movedIv = Object.assign({}, env, { iv: crypto.randomBytes(12).toString('base64') });
  let threw2 = null;
  try { m.openDocument(movedIv); } catch (e) { threw2 = e; }
  ok('a swapped IV is rejected', !!threw2);

  const truncated = Object.assign({}, env, { ct: Buffer.alloc(4).toString('base64') });
  let threw3 = null;
  try { m.openDocument(truncated); } catch (e) { threw3 = e; }
  ok('a truncated record is rejected, not read as empty', !!threw3);
}

/* ----------------------------------------------------------- wrong key */

console.log('\nThe wrong key cannot read a book');
{
  const a = withKeys({ DATA_KEY: KEY_A });
  const env = JSON.parse(a.sealDocument(BOOK));
  const b = withKeys({ DATA_KEY: KEY_B });
  let threw = null;
  try { b.openDocument(env); } catch (e) { threw = e; }
  ok('a different key is refused', !!threw);
  ok('with a message that says nothing is lost',
    threw && /nothing has been lost/i.test(threw.message), threw && threw.message);
  ok('and a machine-readable code', threw && threw.code === 'data_key_mismatch', threw && threw.code);

  const none = withKeys({});
  let threw2 = null;
  try { none.openDocument(env); } catch (e) { threw2 = e; }
  ok('no key at all is refused rather than returning ciphertext',
    !!threw2 && threw2.code === 'data_key_missing', threw2 && threw2.code);
  ok('and it does not claim the data is gone',
    threw2 && /nothing has been lost/i.test(threw2.message));
}

/* ------------------------------------------------------------- rotation */

console.log('\nA key can be rotated without rewriting every row first');
{
  const old = withKeys({ DATA_KEY: KEY_A });
  const writtenWithOld = JSON.parse(old.sealDocument(BOOK));

  const rotated = withKeys({ DATA_KEY: KEY_B, DATA_KEY_OLD: KEY_A });
  ok('both keys are loaded', rotated.ALL_DATA_KEYS.length === 2, String(rotated.ALL_DATA_KEYS.length));
  ok('a row written with the old key still opens',
    JSON.stringify(rotated.openDocument(writtenWithOld)) === JSON.stringify(BOOK));

  const rewritten = JSON.parse(rotated.sealDocument(BOOK));
  ok('but new writes use the new key',
    rewritten.kid === rotated.DATA_KEY.kid && rewritten.kid !== writtenWithOld.kid,
    rewritten.kid + ' vs ' + writtenWithOld.kid);

  /* Once everything is rewritten, the old key can be dropped. */
  const afterRotation = withKeys({ DATA_KEY: KEY_B });
  ok('and the rewritten row opens without the old key',
    JSON.stringify(afterRotation.openDocument(rewritten)) === JSON.stringify(BOOK));

  /* Several old keys, comma separated. */
  const many = withKeys({ DATA_KEY: KEY_B, DATA_KEY_OLD: KEY_A + ',' + newKey() });
  ok('several retired keys are accepted', many.ALL_DATA_KEYS.length === 3,
    String(many.ALL_DATA_KEYS.length));
  ok('and the old row still opens', !!many.openDocument(writtenWithOld));
}

/* ---------------------------------------------------------- bad key input */

console.log('\nA malformed key is ignored, not crashed on');
{
  const short = withKeys({ DATA_KEY: Buffer.alloc(16).toString('base64url') });
  ok('a 16-byte key is refused', short.encryptionOn() === false);
  ok('and the app keeps working unencrypted rather than failing to start',
    JSON.parse(short.sealDocument(BOOK)).accounts[0].name === 'HDFC Savings');

  const junk = withKeys({ DATA_KEY: 'not a key at all!!' });
  ok('nonsense is refused too', junk.encryptionOn() === false);

  const blank = withKeys({ DATA_KEY: '   ' });
  ok('whitespace is treated as unset', blank.encryptionOn() === false);

  /* base64url and standard base64 must both work — Vercel round-trips
     values through places that are fussy about + and /. */
  const raw = crypto.randomBytes(32);
  const urlSafe = withKeys({ DATA_KEY: raw.toString('base64url') });
  const standard = withKeys({ DATA_KEY: raw.toString('base64') });
  ok('base64url is accepted', urlSafe.encryptionOn() === true);
  ok('standard base64 is accepted', standard.encryptionOn() === true);
  ok('and both produce the same key id',
    urlSafe.DATA_KEY.kid === standard.DATA_KEY.kid,
    urlSafe.DATA_KEY.kid + ' vs ' + standard.DATA_KEY.kid);
}

/* -------------------------------------------------------- realistic sizes */

console.log('\nA real-sized book seals and opens');
{
  const m = withKeys({ DATA_KEY: KEY_A });
  const big = { schemaVersion: 4, accounts: [], txns: [], settings: { currency: 'INR' } };
  for (let i = 0; i < 5000; i++) {
    big.txns.push({
      id: 'i' + i, date: '2026-09-14', type: i % 3 ? 'expense' : 'income',
      amount: 100 + i, contents: 'Transaction number ' + i + ' ₹', accountId: 'a1'
    });
  }
  const t0 = Date.now();
  const stored = m.sealDocument(big);
  const back = m.openDocument(JSON.parse(stored));
  const ms = Date.now() - t0;
  ok('5,000 transactions round-trip', back.txns.length === 5000, String(back.txns.length));
  ok('the rupee sign survives', back.txns[0].contents.indexOf('₹') >= 0);
  ok('the figures are exact', back.txns[4999].amount === 5099);
  ok('and it is fast enough to sit in a request (' + ms + ' ms)', ms < 2000, ms + ' ms');
  ok('nothing legible is in the stored form', stored.indexOf('Transaction number') < 0);
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
