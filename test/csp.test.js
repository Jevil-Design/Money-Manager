/* The Content-Security-Policy must allow everything the app actually loads.
 *
 * This exists because it did not. The first CSP allowed the script tags in the
 * page and nothing else — but support.js pulls React, ReactDOM and Babel from
 * unpkg at runtime, so the browser blocked them and the site rendered nothing,
 * while every server-side check still passed because the HTML was served fine.
 *
 * So: read the policy out of vercel.json, read every external host out of the
 * files that are actually shipped, and assert the policy covers them. A new
 * CDN added to either file fails here rather than in production.
 *
 *   node test/csp.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHIPPED = ['support.js', 'Money Manager.dc.html'];

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* ------------------------------------------------------------ the policy */

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const cspHeader = (vercel.headers || [])
  .flatMap((h) => h.headers || [])
  .find((h) => String(h.key).toLowerCase() === 'content-security-policy');

ok('vercel.json sets a Content-Security-Policy', !!cspHeader);
if (!cspHeader) { console.log('\n1 FAILURE(S)'); process.exit(1); }

const directives = {};
cspHeader.value.split(';').map((s) => s.trim()).filter(Boolean).forEach((part) => {
  const bits = part.split(/\s+/);
  directives[bits[0]] = bits.slice(1);
});
const allows = (directive, origin) => {
  const list = directives[directive] || directives['default-src'] || [];
  return list.indexOf(origin) >= 0;
};

/* ------------------------------------- what the shipped files actually load */

/* Where each host is used. Anything found in the files that is not listed
   here fails below, so adding a CDN forces a decision rather than silently
   inheriting default-src. */
const EXPECTED = {
  'https://unpkg.com': ['script-src'],                 /* React, ReactDOM, Babel */
  'https://cdnjs.cloudflare.com': ['script-src', 'worker-src'],  /* xlsx, pdf.js + its worker */
  'https://accounts.google.com': ['script-src', 'frame-src'],    /* Google sign-in */
  'https://www.googleapis.com': ['connect-src'],       /* Drive backup */
  'https://oauth2.googleapis.com': ['connect-src'],    /* token check, server side */
  'https://api.resend.com': ['connect-src']            /* server side only */
};
/* Hosts that appear only as documentation or placeholder text. */
const NOT_LOADED = ['https://backup.example.com', 'https://your-project.vercel.app'];

const found = new Set();
SHIPPED.forEach((f) => {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  (text.match(/https:\/\/[a-zA-Z0-9.-]+/g) || []).forEach((u) => found.add(u));
});

console.log('\nEvery host the shipped files reference is accounted for');
[...found].sort().forEach((host) => {
  if (NOT_LOADED.indexOf(host) >= 0) {
    ok(host + ' is documentation, not loaded', true);
    return;
  }
  const where = EXPECTED[host];
  ok(host + ' is a known dependency', !!where,
    'found in the app but not listed in this test — decide which directive it belongs to');
  if (!where) return;
  where.forEach((directive) => {
    ok('  ' + directive + ' allows ' + host, allows(directive, host),
      JSON.stringify(directives[directive] || directives['default-src']));
  });
});

console.log('\nThe specific things that broke the site');
ok('script-src allows unpkg, where React comes from',
  allows('script-src', 'https://unpkg.com'), JSON.stringify(directives['script-src']));
ok('script-src allows cdnjs, where xlsx and pdf.js come from',
  allows('script-src', 'https://cdnjs.cloudflare.com'));
ok('worker-src allows cdnjs, where the pdf.js worker comes from',
  allows('worker-src', 'https://cdnjs.cloudflare.com'), JSON.stringify(directives['worker-src']));
ok('script-src allows unsafe-eval, which compiling the logic block needs',
  (directives['script-src'] || []).indexOf("'unsafe-eval'") >= 0);

console.log('\nAnd it is still a policy worth having');
ok('script-src does not allow unsafe-inline — the page has no inline scripts',
  (directives['script-src'] || []).indexOf("'unsafe-inline'") < 0,
  JSON.stringify(directives['script-src']));
ok('script-src is not a wildcard', (directives['script-src'] || []).indexOf('*') < 0);
ok('object-src is none', JSON.stringify(directives['object-src']) === JSON.stringify(["'none'"]));
ok('base-uri is none', JSON.stringify(directives['base-uri']) === JSON.stringify(["'none'"]));
ok('frame-ancestors is none', JSON.stringify(directives['frame-ancestors']) === JSON.stringify(["'none'"]));
ok('form-action is self', JSON.stringify(directives['form-action']) === JSON.stringify(["'self'"]));
ok('default-src is self', JSON.stringify(directives['default-src']) === JSON.stringify(["'self'"]));
ok('img-src permits the data: URLs receipts are stored as',
  (directives['img-src'] || []).indexOf('data:') >= 0, JSON.stringify(directives['img-src']));

console.log('\nThe other headers are still set');
const headerNames = (vercel.headers || []).flatMap((h) => h.headers || [])
  .map((h) => String(h.key).toLowerCase());
['x-content-type-options', 'referrer-policy', 'x-frame-options',
  'permissions-policy', 'cross-origin-opener-policy'].forEach((h) => {
  ok(h + ' is set', headerNames.indexOf(h) >= 0);
});
const xfo = (vercel.headers || []).flatMap((h) => h.headers || [])
  .find((h) => String(h.key).toLowerCase() === 'x-frame-options');
ok('x-frame-options is DENY', xfo && xfo.value === 'DENY', xfo && xfo.value);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
