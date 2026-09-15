/* The mutual fund catalogue.
 *
 * Parsing AMFI's file is the part that decides whether the app shows real
 * schemes or nonsense, so it is tested against a fixture with the exact shape
 * AMFI publishes — headings, AMC lines, missing ISINs, unpriced schemes and
 * all. The live file is fetched too, but only when MM_TEST_NETWORK=1, so the
 * suite does not depend on somebody else's uptime.
 *
 *   node test/funds.test.js
 *   MM_TEST_NETWORK=1 node test/funds.test.js     # also check the real file
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'api', 'index.js');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

const { parseAmfi, amfiDate, staleDays } =
  new Function('require', 'module', 'exports', '__filename', '__dirname',
    fs.readFileSync(API, 'utf8') + '\n;return { parseAmfi, amfiDate, staleDays };')(
    require, { exports: {} }, {}, API, path.dirname(API));

/* Exactly the shape AMFI publishes: a scheme-type heading, an AMC line, the
   column header, rows with and without ISINs, and an unpriced scheme. */
const FIXTURE = [
  '',
  'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)',
  '',
  'PPFAS Mutual Fund',
  'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
  '122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;89.5712;11-Sep-2026',
  '122640;INF879O01019;-;Parag Parikh Flexi Cap Fund;Regular Plan;Growth;82.4501;11-Sep-2026',
  '153964;-;-;Parag Parikh Flexi Cap Fund;Direct Plan;Monthly IDCW Payout;21.3300;11-Sep-2026',
  '',
  'PGIM India Mutual Fund',
  '133839;INF663L01FF1;-;PGIM India Flexi Cap Fund;Direct Plan;Direct Growth;43.6000;11-Sep-2026',
  '',
  'Open Ended Schemes(Debt Scheme - Liquid Fund)',
  'Some AMC Mutual Fund',
  '999999;INF000X01234;INF000X01242;Some Liquid Fund;Regular Plan;Growth;N.A.;11-Sep-2026',
  ''
].join('\n');

/* ------------------------------------------------------------------ dates */

console.log('\nAMFI writes dates as 11-Sep-2026');
{
  ok('a normal date', amfiDate('11-Sep-2026') === '2026-09-11', amfiDate('11-Sep-2026'));
  ok('a single-digit day is padded', amfiDate('1-Jan-2026') === '2026-01-01', amfiDate('1-Jan-2026'));
  ok('December', amfiDate('31-Dec-2025') === '2025-12-31', amfiDate('31-Dec-2025'));
  ok('the month name is case-insensitive', amfiDate('11-SEP-2026') === '2026-09-11');
  ok('rubbish is null, not a wrong date', amfiDate('not a date') === null);
  ok('an ISO date is not silently accepted', amfiDate('2026-09-11') === null);
  ok('an unknown month is null', amfiDate('11-Xyz-2026') === null);
  ok('empty is null', amfiDate('') === null && amfiDate(null) === null);
}

/* ----------------------------------------------------------------- parsing */

console.log('\nParsing the file AMFI actually publishes');
{
  const funds = parseAmfi(FIXTURE);
  ok('every scheme row is read, and nothing else', funds.length === 5, String(funds.length));

  const byCode = {};
  funds.forEach((f) => { byCode[f.schemeCode] = f; });

  const ppfas = byCode['122639'];
  ok('the scheme code', ppfas && ppfas.schemeCode === '122639');
  ok('the scheme name', ppfas && ppfas.name === 'Parag Parikh Flexi Cap Fund', ppfas && ppfas.name);
  ok('the ISIN', ppfas && ppfas.isin === 'INF879O01027', ppfas && ppfas.isin);
  ok('the NAV, as a number', ppfas && ppfas.nav === 89.5712, ppfas && String(ppfas.nav));
  ok('the NAV date, as ISO', ppfas && ppfas.navDate === '2026-09-11', ppfas && ppfas.navDate);

  /* Plan and Option are separate columns in the source, which is what makes
     Direct Growth distinguishable from Regular Growth without guessing. */
  ok('the plan is its own field', ppfas && ppfas.plan === 'Direct Plan', ppfas && ppfas.plan);
  ok('the option is its own field', ppfas && ppfas.option === 'Growth', ppfas && ppfas.option);
  ok('the Regular variant is a separate scheme',
    byCode['122640'] && byCode['122640'].plan === 'Regular Plan' && byCode['122640'].schemeCode !== '122639');
  ok('and the IDCW variant is separate again',
    byCode['153964'] && byCode['153964'].option === 'Monthly IDCW Payout', byCode['153964'] && byCode['153964'].option);

  /* The AMC is not a column — it is carried down from the heading above. */
  ok('the AMC comes from the heading above the block',
    ppfas && ppfas.amc === 'PPFAS Mutual Fund', ppfas && ppfas.amc);
  ok('and changes when a new AMC heading appears',
    byCode['133839'] && byCode['133839'].amc === 'PGIM India Mutual Fund', byCode['133839'] && byCode['133839'].amc);
  ok('a scheme-type heading does NOT become the AMC',
    byCode['999999'] && byCode['999999'].amc === 'Some AMC Mutual Fund',
    byCode['999999'] && byCode['999999'].amc);

  ok('a missing ISIN becomes empty, not the literal dash',
    byCode['153964'] && byCode['153964'].isin === '', JSON.stringify(byCode['153964'] && byCode['153964'].isin));
  ok('the reinvestment ISIN is kept when present',
    byCode['999999'] && byCode['999999'].isinReinv === 'INF000X01242');

  /* An unpriced scheme must be null, never 0 — a zero NAV would divide into
     infinite units. */
  ok('an unpriced scheme has a null NAV, not zero',
    byCode['999999'] && byCode['999999'].nav === null, String(byCode['999999'] && byCode['999999'].nav));

  ok('the column header row is not read as a scheme',
    !funds.some((f) => /Scheme Code/i.test(f.name)));
  ok('headings are not read as schemes',
    !funds.some((f) => /Open Ended/i.test(f.name)));
}

console.log('\nMalformed input does not produce malformed funds');
{
  ok('empty input gives nothing', parseAmfi('').length === 0);
  ok('only headings gives nothing', parseAmfi('Some AMC Mutual Fund\nOpen Ended Schemes(x)').length === 0);
  ok('a row with too few columns is skipped',
    parseAmfi('AMC Mutual Fund\n1;2;3;4').length === 0);
  ok('a non-numeric scheme code is skipped',
    parseAmfi('AMC Mutual Fund\nABC;i;-;N;Direct Plan;Growth;10;11-Sep-2026').length === 0);
  ok('a negative NAV is treated as unpriced',
    parseAmfi('AMC Mutual Fund\n12345;i;-;N;Direct Plan;Growth;-5;11-Sep-2026')[0].nav === null);
  ok('a bad date leaves navDate null rather than guessing',
    parseAmfi('AMC Mutual Fund\n12345;i;-;N;Direct Plan;Growth;10;rubbish')[0].navDate === null);
}

/* ------------------------------------------------------------- staleness */

console.log('\nNAV age is reported, because NAV is not live');
{
  const today = new Date().toISOString().slice(0, 10);
  ok('today is zero days old', staleDays(today) === 0, String(staleDays(today)));
  const threeAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  ok('three days ago is three', staleDays(threeAgo) === 3, String(staleDays(threeAgo)));
  ok('no date gives null, not zero', staleDays(null) === null);
  ok('rubbish gives null', staleDays('not-a-date') === null);
  const future = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  ok('a future date is clamped to zero rather than negative', staleDays(future) === 0,
    String(staleDays(future)));
}

/* ------------------------------------------------------------ the real file */

if (process.env.MM_TEST_NETWORK !== '1') {
  console.log('\nThe live AMFI file: SKIPPED (set MM_TEST_NETWORK=1 to check it)');
  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
}

(async () => {
  console.log('\nThe file AMFI is publishing right now');
  let text = '';
  try {
    const r = await fetch('https://www.amfiindia.com/spages/NAVAll.txt');
    ok('AMFI answers', r.ok, 'HTTP ' + r.status);
    text = await r.text();
  } catch (e) {
    ok('AMFI answers', false, e.message);
    console.log('\n' + fails + ' FAILURE(S)');
    process.exit(1);
  }

  const funds = parseAmfi(text);
  ok('thousands of schemes are parsed', funds.length > 8000, String(funds.length));
  ok('every one has a numeric scheme code', funds.every((f) => /^\d+$/.test(f.schemeCode)));
  ok('every one has a name', funds.every((f) => !!f.name));
  ok('almost all carry an AMC',
    funds.filter((f) => f.amc).length > funds.length * 0.98,
    funds.filter((f) => !f.amc).length + ' without');
  ok('every NAV is null or a positive number',
    funds.every((f) => f.nav === null || (isFinite(f.nav) && f.nav > 0)));
  ok('every date is null or ISO',
    funds.every((f) => f.navDate === null || /^\d{4}-\d{2}-\d{2}$/.test(f.navDate)));
  ok('scheme codes are unique',
    new Set(funds.map((f) => f.schemeCode)).size === funds.length,
    String(funds.length - new Set(funds.map((f) => f.schemeCode)).size) + ' duplicates');

  /* The scheme the brief names as the acceptance test. */
  const ppfas = funds.filter((f) => /^Parag Parikh Flexi Cap Fund$/i.test(f.name));
  ok('Parag Parikh Flexi Cap Fund is found', ppfas.length >= 2, String(ppfas.length));
  const direct = ppfas.find((f) => /direct/i.test(f.plan) && /^growth$/i.test(f.option));
  const regular = ppfas.find((f) => /regular/i.test(f.plan) && /^growth$/i.test(f.option));
  ok('its Direct Growth plan is there', !!direct, direct && direct.schemeCode);
  ok('its Regular Growth plan is there too', !!regular, regular && regular.schemeCode);
  ok('they are different schemes with different codes',
    direct && regular && direct.schemeCode !== regular.schemeCode);
  ok('both carry a real NAV', direct && regular && direct.nav > 0 && regular.nav > 0,
    direct && regular && (direct.nav + ' / ' + regular.nav));
  ok('Direct is priced above Regular, as its lower fees imply',
    direct && regular && direct.nav > regular.nav,
    direct && regular && (direct.nav + ' vs ' + regular.nav));
  ok('the AMC is PPFAS', direct && /PPFAS/i.test(direct.amc), direct && direct.amc);
  ok('the NAV is dated', direct && /^\d{4}-\d{2}-\d{2}$/.test(direct.navDate), direct && direct.navDate);
  const age = staleDays(direct && direct.navDate);
  ok('and is recent — under a week old (' + age + ' days)', age !== null && age <= 7, String(age));

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})();
