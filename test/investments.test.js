/* Investment accounting and portfolio maths.
 *
 * The rule this exists to protect: buying an investment is a TRANSFER, never
 * an expense. Getting that wrong double counts the money — once as spending,
 * again as an asset still held — and quietly corrupts every report built on
 * income and expense. §26 of the brief, and Tests 5 and 6 of its final check.
 *
 *   node test/investments.test.js
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

const src = fs.readFileSync(APP, 'utf8')
  .match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }
};
global.window = { addEventListener() {}, removeEventListener() {}, indexedDB: null };
global.document = { addEventListener() {}, removeEventListener() {} };
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'Node investments test' }, configurable: true, writable: true
});
class StubLogic {
  constructor(p) { this.props = p || {}; this.state = {}; }
  setState(patch, cb) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); }
  forceUpdate() {}
}
const { Component, MM_TABS, MM_TAB_ALIAS, mmInvGroupOf, mmInvIsUnitised, mmInvIsInflow } =
  new Function('DCLogic', 'StreamableLogic', 'React',
    src + '\n;return { Component, MM_TABS, MM_TAB_ALIAS, mmInvGroupOf, mmInvIsUnitised, mmInvIsInflow };')(
    StubLogic, StubLogic, {});

/* A book with a bank account and an investment account to hold a fund. */
function book() {
  const c = new Component({});
  c.state.db.accounts = [
    { id: 'bank', name: 'Bank Account', type: 'bank', opening: 500000, currency: 'INR', archived: false, createdAt: 1, updatedAt: 1 },
    { id: 'mf', name: 'Mutual Funds', type: 'investment', opening: 0, currency: 'INR', archived: false, createdAt: 1, updatedAt: 1 }
  ];
  c.state.db.txns = [];
  c.state.db.investments = [];
  c.state.db.invTxns = [];
  c.state.db.sips = [];
  c.state.db.loans = [];
  c.state.auth.phase = 'ready';
  c.bumpRev();
  return c;
}

/* Buying: the ledger entry is a transfer, and the investment records the
   holding. Both halves, exactly as the app will do it. */
function buy(c, opts) {
  c.state.db.txns.push({
    id: 't' + c.state.db.txns.length, date: opts.date, type: 'transfer',
    accountId: opts.from || 'bank', toAccountId: opts.to || 'mf',
    amount: opts.amount, categoryId: '', sub: '', contents: opts.note || 'Investment',
    details: '', payment: 'Bank Transfer', notes: '', tags: [], ref: '',
    reconciled: false, reimb: false, reimbWho: '', reimbStatus: '', importId: ''
  });
  c.state.db.invTxns.push({
    id: 'i' + c.state.db.invTxns.length, investmentId: opts.investmentId,
    date: opts.date, type: opts.type || 'buy', amount: opts.amount,
    units: opts.units || 0, nav: opts.nav || 0, accountId: opts.from || 'bank'
  });
  c.bumpRev();
}

/* ------------------------------------------------------------- navigation */

console.log('\nGoals became Investments without losing anything');
{
  ok('Investments is a tab', MM_TABS.indexOf('Investments') >= 0, MM_TABS.join(','));
  ok('Goals is no longer a tab', MM_TABS.indexOf('Goals') < 0);
  ok('a saved "Goals" preference still resolves', MM_TAB_ALIAS.Goals === 'Investments',
    String(MM_TAB_ALIAS.Goals));
  ok('the other aliases still work', MM_TAB_ALIAS.Transactions === 'Ledger');

  /* The data must survive the tab going away. */
  const c = new Component({});
  const migrated = c.migrate({
    schemaVersion: 4, accounts: [], txns: [],
    goals: [{ id: 'g1', name: 'Emergency fund', target: 300000, saved: 50000 }]
  });
  ok('existing goals are kept', migrated.goals.length === 1, String(migrated.goals.length));
  ok('and are not converted into investments',
    migrated.investments.length === 0, String(migrated.investments.length));
  ok('the goal itself is untouched', migrated.goals[0].name === 'Emergency fund');
  ok('the investment collections now exist',
    Array.isArray(migrated.investments) && Array.isArray(migrated.invTxns) && Array.isArray(migrated.sips));
}

/* ------------------------------------------------- the accounting rule */

console.log('\nTest 5: ₹10,000 bank → mutual fund');
{
  const c = book();
  c.state.db.investments.push({
    id: 'inv1', name: 'Parag Parikh Flexi Cap', type: 'Lump Sum', accountId: 'mf',
    schemeCode: '122639', currentNav: 0, status: 'active', createdAt: 1, updatedAt: 1
  });
  const before = c.balances();
  const bankBefore = before.bank.balance;

  buy(c, { investmentId: 'inv1', date: '2026-01-10', amount: 10000, units: 125, nav: 80 });

  const after = c.balances();
  ok('the bank decreased by exactly ₹10,000',
    bankBefore - after.bank.balance === 10000, String(bankBefore - after.bank.balance));
  ok('the investment account increased by exactly ₹10,000',
    after.mf.balance === 10000, String(after.mf.balance));

  /* The whole point: it is not spending. */
  const spent = c.state.db.txns.filter((t) => t.type === 'expense')
    .reduce((n, t) => n + t.amount, 0);
  ok('expenses did NOT increase', spent === 0, String(spent));
  const earned = c.state.db.txns.filter((t) => t.type === 'income')
    .reduce((n, t) => n + t.amount, 0);
  ok('and it was not booked as income either', earned === 0, String(earned));
  ok('the ledger entry is a transfer', c.state.db.txns[0].type === 'transfer');

  /* Money moved between two pockets you own, so you are no poorer. */
  ok('net worth is unchanged by the purchase itself',
    c.netWorth() === 500000, String(c.netWorth()));

  const st = c.invState(c.inv('inv1'));
  ok('the investment shows ₹10,000 invested', st.invested === 10000, String(st.invested));
  ok('and 125 units', st.units === 125, String(st.units));
  ok('with no gain yet, because it has not been valued', st.gain === 0, String(st.gain));
}

console.log('\nWhen the fund gains, net worth follows — but the ledger does not');
{
  const c = book();
  c.state.db.investments.push({
    id: 'inv1', name: 'Fund', type: 'Lump Sum', accountId: 'mf',
    currentNav: 0, status: 'active', createdAt: 1, updatedAt: 1
  });
  buy(c, { investmentId: 'inv1', date: '2026-01-10', amount: 10000, units: 125, nav: 80 });

  /* The NAV rises from 80 to 96 — nothing happened in the ledger. */
  c.inv('inv1').currentNav = 96;
  c.bumpRev();

  const st = c.invState(c.inv('inv1'));
  ok('the value follows units × NAV', st.value === 12000, String(st.value));
  ok('the gain is ₹2,000', st.gain === 2000, String(st.gain));
  ok('the return is 20%', st.returnPct === 20, String(st.returnPct));
  ok('the average purchase price is the NAV paid', st.avgPrice === 80, String(st.avgPrice));

  ok('the investment ACCOUNT still holds only what was paid',
    c.balances().mf.balance === 10000, String(c.balances().mf.balance));
  ok('because the market does not post to the ledger',
    c.state.db.txns.length === 1);
  ok('but net worth includes the gain',
    c.netWorth() === 502000, String(c.netWorth()));
  ok('and reports it as unrealised', c.netWorthParts().unrealised === 2000,
    String(c.netWorthParts().unrealised));
  ok('expenses are still zero', c.state.db.txns.filter((t) => t.type === 'expense').length === 0);
}

console.log('\nTest 6: withdrawing money back out');
{
  const c = book();
  c.state.db.investments.push({
    id: 'inv1', name: 'Fund', type: 'Lump Sum', accountId: 'mf',
    currentNav: 96, status: 'active', createdAt: 1, updatedAt: 1
  });
  buy(c, { investmentId: 'inv1', date: '2026-01-10', amount: 10000, units: 125, nav: 80 });

  /* Selling 50 units at 96 = ₹4,800 back to the bank. */
  c.state.db.txns.push({
    id: 'tw', date: '2026-06-10', type: 'transfer', accountId: 'mf', toAccountId: 'bank',
    amount: 4800, categoryId: '', sub: '', contents: 'Redemption', details: '',
    payment: 'Bank Transfer', notes: '', tags: [], ref: '', reconciled: false,
    reimb: false, reimbWho: '', reimbStatus: '', importId: ''
  });
  c.state.db.invTxns.push({
    id: 'iw', investmentId: 'inv1', date: '2026-06-10', type: 'withdrawal',
    amount: 4800, units: 50, nav: 96, accountId: 'bank'
  });
  c.bumpRev();

  const b = c.balances();
  ok('the bank increased by ₹4,800', b.bank.balance === 500000 - 10000 + 4800, String(b.bank.balance));
  ok('the investment account decreased by ₹4,800', b.mf.balance === 5200, String(b.mf.balance));
  ok('still no expense anywhere', c.state.db.txns.filter((t) => t.type === 'expense').length === 0);
  ok('and no income — a redemption is not earnings',
    c.state.db.txns.filter((t) => t.type === 'income').length === 0);

  const st = c.invState(c.inv('inv1'));
  ok('75 units remain', st.units === 75, String(st.units));
  ok('what is still invested is ₹5,200', st.invested === 5200, String(st.invested));
  ok('worth 75 × 96 = ₹7,200', st.value === 7200, String(st.value));
  ok('so the gain on what is left is ₹2,000', st.gain === 2000, String(st.gain));
  ok('and the gain/loss is still calculated correctly after a withdrawal',
    Math.abs(st.returnPct - 38.4615) < 0.01, String(st.returnPct));
}

console.log('\nA dividend is income from the holding, not a withdrawal of it');
{
  const c = book();
  c.state.db.investments.push({
    id: 'inv1', name: 'Fund', type: 'Lump Sum', accountId: 'mf',
    currentNav: 80, status: 'active', createdAt: 1, updatedAt: 1
  });
  buy(c, { investmentId: 'inv1', date: '2026-01-10', amount: 10000, units: 125, nav: 80 });
  c.state.db.invTxns.push({
    id: 'id', investmentId: 'inv1', date: '2026-03-10', type: 'dividend',
    amount: 500, units: 0, nav: 0, accountId: 'bank'
  });
  c.bumpRev();

  const st = c.invState(c.inv('inv1'));
  ok('the units are unchanged by a payout', st.units === 125, String(st.units));
  ok('and so is what was invested', st.invested === 10000, String(st.invested));
  ok('the payout still counts in the return, through XIRR',
    st.xirr !== null && isFinite(st.xirr), String(st.xirr));
}

/* ------------------------------------------------------------- portfolio */

console.log('\nThe portfolio rolls up without disagreeing with its parts');
{
  const c = book();
  c.state.db.accounts.push(
    { id: 'fd', name: 'Fixed Deposits', type: 'fd', opening: 0, currency: 'INR', archived: false, createdAt: 1, updatedAt: 1 });
  c.state.db.investments.push(
    { id: 'i1', name: 'Flexi Cap', type: 'Lump Sum', accountId: 'mf', currentNav: 96, status: 'active', createdAt: 1, updatedAt: 1 },
    { id: 'i2', name: 'Bank FD', type: 'Fixed Deposit', accountId: 'fd', currentValue: 107000, status: 'active', createdAt: 1, updatedAt: 1 });
  buy(c, { investmentId: 'i1', date: '2026-01-10', amount: 10000, units: 125, nav: 80 });
  buy(c, { investmentId: 'i2', date: '2026-01-10', amount: 100000, to: 'fd' });

  const p = c.portfolio();
  ok('both holdings are listed', p.rows.length === 2, String(p.rows.length));
  ok('total invested is ₹1,10,000', p.totals.invested === 110000, String(p.totals.invested));
  ok('total value is ₹1,19,000', p.totals.value === 119000, String(p.totals.value));
  ok('total gain is ₹9,000', p.totals.gain === 9000, String(p.totals.gain));

  /* The roll-up must equal the sum of the parts, or two screens disagree. */
  const sumInvested = p.rows.reduce((n, r) => n + r.st.invested, 0);
  const sumValue = p.rows.reduce((n, r) => n + r.st.value, 0);
  ok('the totals equal the sum of the rows',
    sumInvested === p.totals.invested && sumValue === p.totals.value);

  ok('grouped by kind', !!p.byGroup.mf && !!p.byGroup.deposit, Object.keys(p.byGroup).join(','));
  ok('the fund group shows its own gain', p.byGroup.mf.gain === 2000, String(p.byGroup.mf.gain));
  ok('the deposit group shows its own gain', p.byGroup.deposit.gain === 7000, String(p.byGroup.deposit.gain));
  const shares = Object.keys(p.byGroup).reduce((n, k) => n + p.byGroup[k].share, 0);
  ok('the allocation shares add up to 100%', Math.abs(shares - 100) < 0.001, String(shares));

  ok('net worth includes both holdings at their current value',
    c.netWorth() === 500000 + 9000, String(c.netWorth()));

  /* A deposit is not unitised, so it must not invent units or a NAV. */
  const fdState = c.invState(c.inv('i2'));
  ok('a deposit has no units', fdState.units === 0, String(fdState.units));
  ok('and takes its value from what was entered', fdState.value === 107000, String(fdState.value));
}

console.log('\nCategories map to the right maths');
{
  ok('a mutual fund is unitised', mmInvIsUnitised('Lump Sum') === true);
  ok('a stock is unitised', mmInvIsUnitised('Stocks') === true);
  ok('gold is unitised', mmInvIsUnitised('Physical Gold') === true);
  ok('a fixed deposit is not', mmInvIsUnitised('Fixed Deposit') === false);
  ok('PPF is not', mmInvIsUnitised('PPF') === false);
  ok('mutual funds group together', mmInvGroupOf('ELSS') === 'mf' && mmInvGroupOf('SIP') === 'mf');
  ok('deposits group together', mmInvGroupOf('Recurring Deposit') === 'deposit');
  ok('an unknown type falls into other', mmInvGroupOf('Something New') === 'other');
  ok('buying is an inflow', mmInvIsInflow('sip') && mmInvIsInflow('buy'));
  ok('withdrawing is not', !mmInvIsInflow('withdrawal') && !mmInvIsInflow('dividend'));
}

/* ------------------------------------------------------------- safety */

console.log('\nNothing produces NaN, Infinity or a negative holding');
{
  const c = book();
  c.state.db.investments.push(
    { id: 'z1', name: 'Never funded', type: 'Lump Sum', accountId: 'mf', status: 'active', createdAt: 1, updatedAt: 1 },
    { id: 'z2', name: 'Rubbish', type: 'Lump Sum', accountId: 'mf', currentNav: 'abc', status: 'active', createdAt: 1, updatedAt: 1 });
  c.state.db.invTxns.push(
    { id: 'x1', investmentId: 'z2', date: '2026-01-10', type: 'buy', amount: 'lots', units: NaN, nav: 0 },
    { id: 'x2', investmentId: 'z2', date: 'not-a-date', type: 'buy', amount: 100, units: 1, nav: 100 },
    /* More sold than bought — must not go negative. */
    { id: 'x3', investmentId: 'z2', date: '2026-02-10', type: 'withdrawal', amount: 999999, units: 999, nav: 1 });
  c.bumpRev();

  const a = c.invState(c.inv('z1'));
  ok('an unfunded investment is all zeroes', a.invested === 0 && a.value === 0 && a.gain === 0);
  ok('with a 0% return, not NaN', a.returnPct === 0, String(a.returnPct));
  ok('and no XIRR at all', a.xirr === null, String(a.xirr));

  const b = c.invState(c.inv('z2'));
  [b.invested, b.value, b.gain, b.returnPct, b.units, b.avgPrice].forEach((v, i) => {
    ok('field ' + i + ' is a finite number', typeof v === 'number' && isFinite(v), String(v));
  });
  ok('units never go negative', b.units >= 0, String(b.units));
  ok('what is invested never goes negative', b.invested >= 0, String(b.invested));
  ok('XIRR is a number or null, never NaN', b.xirr === null || isFinite(b.xirr), String(b.xirr));

  const p = c.portfolio();
  [p.totals.invested, p.totals.value, p.totals.gain, p.totals.returnPct].forEach((v, i) => {
    ok('portfolio total ' + i + ' is finite', isFinite(v), String(v));
  });
  ok('net worth stays a finite number', isFinite(c.netWorth()), String(c.netWorth()));
}

console.log('\nClosed holdings leave the portfolio but not the record');
{
  const c = book();
  c.state.db.investments.push(
    { id: 'i1', name: 'Open', type: 'Lump Sum', accountId: 'mf', currentNav: 80, status: 'active', createdAt: 1, updatedAt: 1 },
    { id: 'i2', name: 'Sold up', type: 'Lump Sum', accountId: 'mf', currentNav: 80, status: 'sold', createdAt: 1, updatedAt: 1 });
  buy(c, { investmentId: 'i1', date: '2026-01-10', amount: 10000, units: 125, nav: 80 });
  buy(c, { investmentId: 'i2', date: '2026-01-10', amount: 50000, units: 625, nav: 80 });

  const p = c.portfolio();
  ok('only the open holding is in the portfolio', p.rows.length === 1, String(p.rows.length));
  ok('and only its money is counted', p.totals.invested === 10000, String(p.totals.invested));
  ok('but the sold one is still in the book',
    c.state.db.investments.length === 2 && !!c.inv('i2'));
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
