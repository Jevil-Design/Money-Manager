/* Investment return maths.
 *
 * XIRR is the easiest figure in a finance app to get quietly wrong, and the
 * hardest for a user to check. So it is tested against cases with a known
 * answer, against the awkward inputs that make naive solvers diverge, and
 * against the rule that matters most: it must return null rather than a
 * plausible-looking wrong number.
 *
 *   node test/returns.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'Money Manager.dc.html');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};
const near = (a, b, tol) => a !== null && isFinite(a) && Math.abs(a - b) <= (tol === undefined ? 0.05 : tol);

const src = fs.readFileSync(APP, 'utf8')
  .match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.window = { addEventListener() {}, removeEventListener() {}, indexedDB: null };
global.document = { addEventListener() {}, removeEventListener() {} };
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'Node returns test' }, configurable: true, writable: true
});
class StubLogic {
  constructor(p) { this.props = p || {}; this.state = {}; }
  setState(patch, cb) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); }
  forceUpdate() {}
}
const { mmXirr, mmNpvAt, mmGainLoss, mmReturnPct, mmInvestmentFlows } =
  new Function('DCLogic', 'StreamableLogic', 'React',
    src + '\n;return { mmXirr, mmNpvAt, mmGainLoss, mmReturnPct, mmInvestmentFlows };')(
    StubLogic, StubLogic, {});

/* ------------------------------------------------------- gain and return % */

console.log('\nGain and simple return');
{
  ok('a gain', mmGainLoss(100000, 125000) === 25000, String(mmGainLoss(100000, 125000)));
  ok('a loss', mmGainLoss(100000, 90000) === -10000, String(mmGainLoss(100000, 90000)));
  ok('25% up', mmReturnPct(100000, 125000) === 25, String(mmReturnPct(100000, 125000)));
  ok('10% down', mmReturnPct(100000, 90000) === -10, String(mmReturnPct(100000, 90000)));
  ok('flat is exactly zero', mmReturnPct(100000, 100000) === 0);

  /* The cases that produce NaN, Infinity or -0 in a naive implementation. */
  ok('nothing invested is 0%, not Infinity', mmReturnPct(0, 5000) === 0, String(mmReturnPct(0, 5000)));
  ok('nothing at all is 0%, not NaN', mmReturnPct(0, 0) === 0, String(mmReturnPct(0, 0)));
  ok('a negative investment is 0%, not a wrong sign', mmReturnPct(-100, 50) === 0);
  ok('undefined input is 0, not NaN', mmReturnPct(undefined, 100) === 0 && mmGainLoss(undefined, 1) === 0);
  ok('a string input is 0, not NaN', mmGainLoss('abc', 100) === 0, String(mmGainLoss('abc', 100)));
  ok('the result is never -0', Object.is(mmReturnPct(100000, 100000), -0) === false);
  [mmReturnPct(0, 0), mmReturnPct(0, 100), mmGainLoss(NaN, NaN)].forEach((v, i) => {
    ok('edge case ' + i + ' is a finite number', isFinite(v), String(v));
  });
}

/* -------------------------------------------------------------- known XIRR */

console.log('\nXIRR against answers that can be checked by hand');
{
  /* Exactly one year, 10% up. */
  const a = mmXirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1100 }
  ]);
  ok('₹1,000 to ₹1,100 over one year is 10%', near(a, 10), String(a));

  /* Exactly one year, 10% down. */
  const b = mmXirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 900 }
  ]);
  ok('a 10% loss over a year is -10%', near(b, -10), String(b));

  /* Doubling in a year. */
  const c = mmXirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 2000 }
  ]);
  ok('doubling in a year is 100%', near(c, 100), String(c));

  /* Half a year at 10% total is ~21% annualised, not 20% — compounding. */
  const d = mmXirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2025-07-02', amount: 1100 }
  ]);
  ok('10% in half a year annualises to about 21%', near(d, 21, 0.7), String(d));

  /* Two years, 21% total, compounds to 10% a year. */
  const e = mmXirr([
    { date: '2024-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1210 }
  ]);
  ok('21% over two years is 10% a year', near(e, 10, 0.2), String(e));

  ok('flat over a year is 0%', near(mmXirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1000 }
  ]), 0), String(mmXirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1000 }])));
}

console.log('\nXIRR on a real SIP, the case the brief describes');
{
  /* ₹5,000 on the 10th of each month for a year, valued at the end. */
  const flows = [];
  for (let m = 0; m < 12; m++) {
    flows.push({ date: '2025-' + String(m + 1).padStart(2, '0') + '-10', amount: -5000 });
  }
  const invested = 60000;

  /* Valued at exactly what was put in: the money was invested for varying
     lengths, but it earned nothing, so the rate is zero. */
  const flat = mmXirr(flows.concat([{ date: '2026-01-10', amount: invested }]));
  ok('a SIP worth exactly what was paid in returns 0%', near(flat, 0, 0.01), String(flat));

  /* A gain. Each instalment was invested for a different length of time, so
     XIRR must be well above the 10% simple return — that is the whole point
     of using it rather than gain ÷ invested. */
  const value = 66000;
  const x = mmXirr(flows.concat([{ date: '2026-01-10', amount: value }]));
  const simple = mmReturnPct(invested, value);
  ok('the simple return is 10%', near(simple, 10, 0.001), String(simple));
  ok('XIRR is higher than the simple return, because the money went in gradually',
    x !== null && x > simple + 5, 'xirr ' + x + ' vs simple ' + simple);
  ok('and it is a believable annual rate (15-25%)', x > 15 && x < 25, String(x));

  /* A loss. */
  const down = mmXirr(flows.concat([{ date: '2026-01-10', amount: 54000 }]));
  ok('a losing SIP gives a negative XIRR', down !== null && down < -8, String(down));

  /* The NPV of the flows at the answer must be ~0 — the definition. */
  const all = flows.concat([{ date: '2026-01-10', amount: value }]);
  ok('the rate it returns really does zero the NPV',
    Math.abs(mmNpvAt(all, x / 100)) < 0.5, String(mmNpvAt(all, x / 100)));
}

console.log('\nXIRR with money going out as well as in');
{
  /* Bought, took some out, still holding the rest. */
  const x = mmXirr([
    { date: '2024-01-01', amount: -100000 },
    { date: '2024-07-01', amount: 20000 },
    { date: '2025-01-01', amount: -50000 },
    { date: '2026-01-01', amount: 150000 }
  ]);
  ok('a mix of buys and withdrawals resolves', x !== null, String(x));
  ok('and is a believable rate', x > 0 && x < 60, String(x));
}

/* ------------------------------------------------ when it must refuse */

console.log('\nXIRR refuses rather than inventing a number');
{
  ok('no flows', mmXirr([]) === null);
  ok('one flow', mmXirr([{ date: '2025-01-01', amount: -1000 }]) === null);
  ok('not an array', mmXirr(null) === null && mmXirr(undefined) === null);

  /* Only money out, or only money in: no rate balances them. */
  ok('only money out', mmXirr([
    { date: '2025-01-01', amount: -1000 }, { date: '2025-06-01', amount: -1000 }
  ]) === null);
  ok('only money in', mmXirr([
    { date: '2025-01-01', amount: 1000 }, { date: '2025-06-01', amount: 1000 }
  ]) === null);

  /* Everything on one day: no time span to annualise over. */
  ok('every flow on the same day', mmXirr([
    { date: '2025-01-01', amount: -1000 }, { date: '2025-01-01', amount: 1100 }
  ]) === null);

  ok('a malformed date', mmXirr([
    { date: 'yesterday', amount: -1000 }, { date: '2026-01-01', amount: 1100 }
  ]) === null);
  ok('a missing date', mmXirr([
    { amount: -1000 }, { date: '2026-01-01', amount: 1100 }
  ]) === null);

  /* A total wipeout has no finite annual rate. */
  ok('losing everything returns null, not -100%', mmXirr([
    { date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 0.0000001 }
  ]) === null, String(mmXirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 0.0000001 }])));

  /* Zero-amount rows are ignored rather than breaking the solve. */
  ok('zero amounts are skipped', near(mmXirr([
    { date: '2025-01-01', amount: -1000 },
    { date: '2025-06-01', amount: 0 },
    { date: '2026-01-01', amount: 1100 }
  ]), 10), String(mmXirr([{ date: '2025-01-01', amount: -1000 }, { date: '2025-06-01', amount: 0 }, { date: '2026-01-01', amount: 1100 }])));
}

console.log('\nWhatever it returns is a usable number');
{
  /* Fuzz: random but realistic portfolios must never yield NaN or Infinity. */
  let bad = [];
  for (let n = 0; n < 4000; n++) {
    const flows = [];
    const count = 2 + Math.floor(Math.random() * 10);
    for (let i = 0; i < count; i++) {
      const y = 2020 + Math.floor(Math.random() * 6);
      const mo = 1 + Math.floor(Math.random() * 12);
      const d = 1 + Math.floor(Math.random() * 28);
      flows.push({
        date: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
        amount: (Math.random() < 0.6 ? -1 : 1) * Math.round(Math.random() * 200000)
      });
    }
    const r = mmXirr(flows);
    if (r !== null && !isFinite(r)) bad.push('non-finite: ' + r);
    if (typeof r !== 'number' && r !== null) bad.push('wrong type: ' + typeof r);
  }
  ok('4,000 random portfolios yield a number or null — never NaN or Infinity',
    bad.length === 0, bad.slice(0, 3).join(' | '));
}

/* --------------------------------------------- flows from transactions */

console.log('\nTransactions become the right cash flows');
{
  const txns = [
    { date: '2025-01-10', type: 'sip', amount: 5000 },
    { date: '2025-02-10', type: 'sip', amount: 5000 },
    { date: '2025-03-10', type: 'buy', amount: 20000 },
    { date: '2025-06-10', type: 'dividend', amount: 800 },
    { date: '2025-09-10', type: 'withdrawal', amount: 10000 }
  ];
  const flows = mmInvestmentFlows(txns, 25000, '2026-01-10');

  ok('every transaction became a flow, plus the holding', flows.length === 6, String(flows.length));
  const byDate = {};
  flows.forEach((f) => { byDate[f.date] = f.amount; });
  ok('a SIP is money out', byDate['2025-01-10'] === -5000, String(byDate['2025-01-10']));
  ok('a buy is money out', byDate['2025-03-10'] === -20000, String(byDate['2025-03-10']));
  ok('a dividend is money in', byDate['2025-06-10'] === 800, String(byDate['2025-06-10']));
  ok('a withdrawal is money in', byDate['2025-09-10'] === 10000, String(byDate['2025-09-10']));
  ok('what is still held counts as a final inflow', byDate['2026-01-10'] === 25000,
    String(byDate['2026-01-10']));

  const x = mmXirr(flows);
  ok('and the whole thing produces an XIRR', x !== null && isFinite(x), String(x));

  ok('a bad date in a transaction is skipped, not fatal',
    mmInvestmentFlows([{ date: 'nope', type: 'sip', amount: 100 }], 500, '2026-01-01').length === 1);
  ok('a zero-amount transaction is skipped',
    mmInvestmentFlows([{ date: '2025-01-01', type: 'sip', amount: 0 }], 500, '2026-01-01').length === 1);
  ok('no holding value means no closing flow',
    mmInvestmentFlows([{ date: '2025-01-01', type: 'sip', amount: 100 }], 0, '2026-01-01').length === 1);
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
