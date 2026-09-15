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
const { Component, MM_TABS, MM_TAB_ALIAS, mmInvGroupOf, mmInvIsUnitised, mmInvIsInflow,
  mmInr: mmInrOf, mmIso: mmIsoOf,
  mmInvestmentFlows: mmFlows, mmXirr: mmXirrOf } =
  new Function('DCLogic', 'StreamableLogic', 'React',
    src + '\n;return { Component, MM_TABS, MM_TAB_ALIAS, mmInvGroupOf, mmInvIsUnitised,' +
    ' mmInvIsInflow, mmInr, mmIso, mmInvestmentFlows, mmXirr };')(
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

/* ------------------------------------------------ the flow a person follows */

/* One real scheme, in the shape the server returns. */
const PPFAS = {
  schemeCode: '122639', isin: 'INF879O01027', isinEffective: 'INF879O01027',
  name: 'Parag Parikh Flexi Cap Fund', amc: 'PPFAS Mutual Fund',
  plan: 'Direct Plan', option: 'Growth', nav: 89.5712, navDate: '2026-09-11', staleDays: 4
};

function withFundSearch(c, result) {
  c.api = function (url) {
    if (url.indexOf('/funds/search') >= 0) {
      return Promise.resolve(result || { funds: [PPFAS], count: 1, catalogue: { stale: false } });
    }
    return Promise.resolve({});
  };
  return c;
}

(async () => {
  console.log('\nAdding a mutual fund, the way the screen does it');
  {
    const c = withFundSearch(book());
    c.openInvestment('add', {});
    ok('the dialog opens', c.state.dlg && c.state.dlg.kind === 'investment');
    ok('and defaults to paying from the bank', c.state.dlg.data.payFrom === 'bank',
      c.state.dlg.data.payFrom);

    /* Search, then take a scheme from the results. */
    c.dlgSet({ fundQuery: 'parag parikh flexi cap' });
    await c.invFundSearch();
    ok('the search returns schemes', (c.state.dlg.data.fundResults || []).length === 1,
      String((c.state.dlg.data.fundResults || []).length));

    c.invPickFund(PPFAS);
    const d = c.state.dlg.data;
    ok('the scheme code is stored', d.schemeCode === '122639', d.schemeCode);
    ok('the ISIN is stored', d.isin === 'INF879O01027', d.isin);
    ok('the AMC is stored', d.amc === 'PPFAS Mutual Fund', d.amc);
    ok('the plan is stored, so Direct cannot be confused with Regular',
      d.plan === 'Direct Plan', d.plan);
    ok('the option is stored', d.option === 'Growth', d.option);
    ok('the latest NAV is filled in', d.currentNav === 89.5712, String(d.currentNav));
    ok('and it is dated', d.navDate === '2026-09-11', d.navDate);
    ok('the name is proposed from the scheme', /Parag Parikh/.test(d.name), d.name);
    ok('the results list is cleared once one is chosen', d.fundResults === null);

    /* Invest ₹50,000 without typing the units. */
    c.dlgSet({ buyDate: '2026-09-15', buyAmount: 50000 });
    ok('the dialog renders without error', !!c.dlgVals().hasDlg);
    c.saveInvestment();

    ok('the holding was created', c.state.db.investments.length === 1);
    const inv = c.state.db.investments[0];
    ok('it kept the scheme code', inv.schemeCode === '122639');
    ok('a holding account was created for it', !!c.acct(inv.accountId), inv.accountId);
    ok('and it is an investment account', c.acct(inv.accountId).type === 'investment',
      c.acct(inv.accountId).type);
    ok('named for what it holds', c.acct(inv.accountId).name === 'Mutual Funds',
      c.acct(inv.accountId).name);

    /* Units were worked out rather than typed — the brief is explicit. */
    const st = c.invState(inv);
    const expectUnits = Math.round((50000 / 89.5712) * 10000) / 10000;
    ok('the units were calculated as amount ÷ NAV', st.units === expectUnits,
      st.units + ' vs ' + expectUnits);
    ok('₹50,000 is invested', st.invested === 50000, String(st.invested));
    ok('and it is worth ₹50,000 at the NAV it was bought at',
      Math.abs(st.value - 50000) < 1, String(st.value));

    /* The accounting. */
    const b = c.balances();
    ok('the bank fell by ₹50,000', b.bank.balance === 450000, String(b.bank.balance));
    ok('the holding account rose by ₹50,000',
      b[inv.accountId].balance === 50000, String(b[inv.accountId].balance));
    ok('the ledger entry is a transfer',
      c.state.db.txns.length === 1 && c.state.db.txns[0].type === 'transfer',
      c.state.db.txns[0] && c.state.db.txns[0].type);
    ok('NOTHING was recorded as an expense',
      c.state.db.txns.filter((t) => t.type === 'expense').length === 0);
    ok('and net worth is unchanged by buying', Math.abs(c.netWorth() - 500000) < 1,
      String(c.netWorth()));
  }

  console.log('\nWhen the NAV moves, the holding follows and the books do not');
  {
    const c = withFundSearch(book());
    c.openInvestment('add', {});
    c.invPickFund(PPFAS);
    c.dlgSet({ buyDate: '2026-03-15', buyAmount: 50000 });
    c.saveInvestment();
    const inv = c.state.db.investments[0];

    /* A later NAV, as a refresh would bring in. */
    c.mutate((db) => { db.investments[0].currentNav = 98.5; db.investments[0].navDate = '2026-09-11'; });
    const st = c.invState(c.inv(inv.id));
    ok('the value rose with the NAV', st.value > 54000 && st.value < 55500, String(st.value));
    ok('the gain is positive', st.gain > 4000, String(st.gain));
    ok('the return is about 10%', st.returnPct > 9 && st.returnPct < 11, String(st.returnPct));
    ok('XIRR is available and higher than the simple return, six months in',
      st.xirr !== null && st.xirr > st.returnPct, 'xirr ' + st.xirr + ' vs ' + st.returnPct);
    ok('the ledger still has exactly one entry', c.state.db.txns.length === 1);
    ok('net worth now reflects the market', c.netWorth() > 504000, String(c.netWorth()));
  }

  console.log('\nAdding more, and taking some out');
  {
    const c = withFundSearch(book());
    c.openInvestment('add', {});
    c.invPickFund(PPFAS);
    c.dlgSet({ buyDate: '2026-01-15', buyAmount: 50000 });
    c.saveInvestment();
    const inv = c.state.db.investments[0];
    const unitsAfterBuy = c.invState(c.inv(inv.id)).units;

    c.openInvTxn(c.inv(inv.id), 'buy');
    c.dlgSet({ date: '2026-05-15', amount: 25000, nav: 90 });
    c.saveInvTxn();
    let st = c.invState(c.inv(inv.id));
    ok('the second purchase adds to what is invested', st.invested === 75000, String(st.invested));
    ok('and adds units', st.units > unitsAfterBuy, String(st.units));
    ok('the bank fell again', c.balances().bank.balance === 425000, String(c.balances().bank.balance));
    ok('still nothing counted as spending',
      c.state.db.txns.filter((t) => t.type === 'expense').length === 0);

    /* Withdraw some. */
    c.openInvTxn(c.inv(inv.id), 'withdrawal');
    c.dlgSet({ date: '2026-08-15', amount: 20000, nav: 100 });
    c.saveInvTxn();
    st = c.invState(c.inv(inv.id));
    ok('the withdrawal reduced what is invested', st.invested === 55000, String(st.invested));
    ok('and reduced the units', st.units < unitsAfterBuy + 277.8, String(st.units));
    ok('the bank got the money back', c.balances().bank.balance === 445000,
      String(c.balances().bank.balance));
    ok('and it was not booked as income',
      c.state.db.txns.filter((t) => t.type === 'income').length === 0);
  }

  console.log('\nThe screen refuses what should not happen');
  {
    const c = withFundSearch(book());
    c.openInvestment('add', {});
    c.invPickFund(PPFAS);
    c.dlgSet({ buyAmount: 10000 });
    c.saveInvestment();
    const inv = c.state.db.investments[0];
    const held = c.invState(c.inv(inv.id)).units;

    /* Selling more units than are held. */
    c.openInvTxn(c.inv(inv.id), 'withdrawal');
    c.dlgSet({ date: '2026-09-15', amount: 999999, units: held + 100, nav: 90 });
    const before = c.state.db.invTxns.length;
    c.saveInvTxn();
    ok('selling more units than are held is refused',
      c.state.db.invTxns.length === before, String(c.state.db.invTxns.length - before));
    ok('and the dialog stays open to be corrected', !!c.state.dlg);

    /* A missing amount. */
    c.dlgSet({ amount: 0, units: 0 });
    c.saveInvTxn();
    ok('a zero amount is refused', c.state.db.invTxns.length === before);
  }

  console.log('\nA failed fund lookup never invents a fund');
  {
    const c = book();
    c.api = () => Promise.reject(Object.assign(new Error('offline'), { status: 0 }));
    c.openInvestment('add', {});
    c.dlgSet({ fundQuery: 'parag parikh' });
    await c.invFundSearch();
    const d = c.state.dlg.data;
    ok('no schemes are produced', Array.isArray(d.fundResults) && d.fundResults.length === 0,
      JSON.stringify(d.fundResults));
    ok('the failure is explained', /could not reach/i.test(d.fundError), d.fundError);
    ok('no NAV was invented', !d.currentNav, String(d.currentNav));
    ok('and no scheme was attached', !d.schemeCode, String(d.schemeCode));

    /* A search that simply matches nothing. */
    const c2 = withFundSearch(book(), { funds: [], count: 0, catalogue: { stale: false } });
    c2.openInvestment('add', {});
    c2.dlgSet({ fundQuery: 'zzzz nonexistent fund' });
    await c2.invFundSearch();
    ok('an empty result says so', /no scheme matched/i.test(c2.state.dlg.data.fundError),
      c2.state.dlg.data.fundError);

    /* A stale catalogue is disclosed rather than passed off as current. */
    const c3 = withFundSearch(book(), { funds: [PPFAS], count: 1, catalogue: { stale: true } });
    c3.openInvestment('add', {});
    c3.dlgSet({ fundQuery: 'parag' });
    await c3.invFundSearch();
    ok('a stale catalogue is disclosed',
      /last downloaded/i.test(c3.state.dlg.data.fundError), c3.state.dlg.data.fundError);
  }

  console.log('\nA deposit needs no fund and no units');
  {
    const c = book();
    c.openInvestment('add', {});
    c.dlgSet({
      name: 'HDFC Fixed Deposit', type: 'Fixed Deposit', institution: 'HDFC Bank',
      currentValue: 107000, rate: 7, maturityDate: '2027-09-15',
      buyDate: '2026-09-15', buyAmount: 100000
    });
    ok('the dialog renders for a deposit', !!c.dlgVals().hasDlg);
    c.saveInvestment();

    const inv = c.state.db.investments[0];
    ok('it was created', !!inv && inv.name === 'HDFC Fixed Deposit');
    ok('into a fixed-deposit account', c.acct(inv.accountId).type === 'fd',
      c.acct(inv.accountId).type);
    const st = c.invState(inv);
    ok('with no units', st.units === 0, String(st.units));
    ok('₹1,00,000 invested', st.invested === 100000, String(st.invested));
    ok('valued at what was entered', st.value === 107000, String(st.value));
    ok('showing a ₹7,000 gain', st.gain === 7000, String(st.gain));
    ok('the bank paid for it', c.balances().bank.balance === 400000, String(c.balances().bank.balance));
    ok('and it was not an expense', c.state.db.txns.filter((t) => t.type === 'expense').length === 0);

    const sum = c.invMonthAndMaturity();
    ok('the maturity is picked up', sum.nextMaturity && sum.nextMaturity.date === '2027-09-15',
      JSON.stringify(sum.nextMaturity));
  }

  console.log('\nThe Investments screen renders');
  {
    const c = withFundSearch(book());
    c.state.tab = 'Investments';
    let v = c.investVals();
    ok('it renders when empty', v.isTable === true && v.tableEmpty === true);
    ok('and invites a first holding', /add investment/i.test(v.emptyBtn), v.emptyBtn);
    ok('every panel has a value', v.panels.every((p) => p.value !== undefined && p.value !== ''));
    ok('an empty portfolio shows a dash for return, not 0%',
      v.panels.find((p) => p.label === 'Overall return').value === '—');

    c.openInvestment('add', {});
    c.invPickFund(PPFAS);
    c.dlgSet({ buyDate: '2026-03-15', buyAmount: 50000 });
    c.saveInvestment();
    c.state.tab = 'Investments';
    v = c.investVals();
    ok('the holding appears as a row', v.tableRows.length === 1, String(v.tableRows.length));
    ok('with a cell for every column',
      v.tableRows[0].cells.length === v.tableCols.length,
      v.tableRows[0].cells.length + ' vs ' + v.tableCols.length);
    ok('the panels total what was invested',
      v.panels[0].value === mmInrOf(50000), v.panels[0].value);
    ok('no panel shows NaN or undefined',
      v.panels.every((p) => !/NaN|undefined|Infinity/.test(String(p.value) + String(p.note))),
      JSON.stringify(v.panels.map((p) => p.value)));
    ok('and no row cell does either',
      v.tableRows[0].cells.every((cell) => !/NaN|undefined|Infinity/.test(String(cell.text || ''))),
      JSON.stringify(v.tableRows[0].cells.map((x) => x.text)));
  }

  /* ------------------------------------------------------------------ SIPs */

  /* A book with one fund already held, which is what a SIP buys into. */
  function sipBook(navHistory) {
    const c = withFundSearch(book());
    c.openInvestment('add', {});
    c.invPickFund(PPFAS);
    c.dlgSet({ buyDate: '2026-01-15', buyAmount: 10000 });
    c.saveInvestment();
    const inv = c.state.db.investments[0];
    c.api = function (url) {
      if (url.indexOf('/history') >= 0) {
        if (navHistory === 'fail') return Promise.reject(new Error('provider down'));
        return Promise.resolve({
          schemeCode: '122639',
          history: navHistory || [
            { date: '2026-06-10', nav: 85 },
            { date: '2026-06-12', nav: 86 },   /* Friday */
            { date: '2026-06-15', nav: 88 },   /* Monday */
            { date: '2026-07-15', nav: 90 }
          ]
        });
      }
      return Promise.resolve({ funds: [PPFAS], count: 1, catalogue: { stale: false } });
    };
    return { c, inv };
  }

  function addSip(c, inv, over) {
    c.openSip('add');
    c.dlgSet(Object.assign({
      investmentId: inv.id, amount: 5000, freq: 'monthly',
      start: '2026-06-15', accountId: 'bank'
    }, over || {}));
    c.saveSip();
    return c.state.db.sips[c.state.db.sips.length - 1];
  }

  console.log('\nSetting up a SIP commits nothing');
  {
    const { c, inv } = sipBook();
    const txnsBefore = c.state.db.txns.length;
    const s = addSip(c, inv);

    ok('the SIP is stored', !!s && s.investmentId === inv.id);
    ok('it owes its first instalment on its start date', s.next === '2026-06-15', s.next);
    ok('nothing has been recorded against it yet', (+s.posted || 0) === 0, String(s.posted));
    ok('no money moved', c.state.db.txns.length === txnsBefore,
      String(c.state.db.txns.length - txnsBefore));
    ok('and no units were bought', c.invUnits(inv.id) === c.invState(inv).units);
    ok('the bank is untouched by setting it up', c.balances().bank.balance === 490000,
      String(c.balances().bank.balance));
  }

  console.log('\nWhat a SIP refuses');
  {
    const { c, inv } = sipBook();
    c.openSip('add');
    c.dlgSet({ investmentId: inv.id, amount: 0, start: '2026-06-15', accountId: 'bank' });
    c.saveSip();
    ok('a zero instalment is refused', c.state.db.sips.length === 0);

    c.dlgSet({ amount: 5000, end: '2026-01-01' });
    c.saveSip();
    ok('an end date before the start is refused', c.state.db.sips.length === 0);

    c.dlgSet({ end: '', accountId: 'nonexistent' });
    c.saveSip();
    ok('an account that is not there is refused', c.state.db.sips.length === 0);

    c.dlgSet({ accountId: 'bank', investmentId: 'gone' });
    c.saveSip();
    ok('an investment that is not there is refused', c.state.db.sips.length === 0);

    c.dlgSet({ investmentId: inv.id, freq: 'hourly' });
    c.saveSip();
    ok('an unknown frequency falls back to monthly rather than being stored',
      c.state.db.sips.length === 1 && c.state.db.sips[0].freq === 'monthly',
      c.state.db.sips[0] && c.state.db.sips[0].freq);
  }

  console.log('\nMissed instalments are all owed, not just the last one');
  {
    const { c, inv } = sipBook();
    const s = addSip(c, inv, { start: '2026-06-15' });
    const pending = c.sipPending(s, '2026-09-15');
    ok('four instalments are owed by 15 September', pending.length === 4,
      JSON.stringify(pending));
    ok('they are the right dates',
      pending.join(',') === '2026-06-15,2026-07-15,2026-08-15,2026-09-15', pending.join(','));

    /* A paused SIP owes nothing. */
    c.toggleSip(s);
    ok('a paused SIP owes nothing',
      c.sipPending(c.state.db.sips[0], '2026-09-15').length === 0);
    c.toggleSip(c.state.db.sips[0]);

    /* An end date stops it. */
    const s2 = addSip(c, inv, { start: '2026-06-15', end: '2026-07-20' });
    ok('an end date stops the schedule', c.sipPending(s2, '2026-09-15').length === 2,
      JSON.stringify(c.sipPending(s2, '2026-09-15')));

    /* A fixed number of instalments stops it too. */
    const s3 = addSip(c, inv, { start: '2026-06-15', count: 2 });
    ok('a fixed count stops the schedule', c.sipPending(s3, '2026-09-15').length === 2,
      String(c.sipPending(s3, '2026-09-15').length));

    /* Frequencies. */
    const q = addSip(c, inv, { start: '2026-03-15', freq: 'quarterly' });
    ok('a quarterly SIP owes three by September',
      c.sipPending(q, '2026-09-15').length === 3, JSON.stringify(c.sipPending(q, '2026-09-15')));
    ok('and is a third of its amount each month',
      Math.abs(c.sipMonthly(q) - 5000 / 3) < 0.01, String(c.sipMonthly(q)));
    const f = addSip(c, inv, { start: '2026-09-01', freq: 'biweekly' });
    ok('a fortnightly SIP counts more than once a month',
      c.sipMonthly(f) > 5000, String(c.sipMonthly(f)));
  }

  console.log('\nA step-up SIP rises on schedule and not before');
  {
    const { c, inv } = sipBook();
    const s = addSip(c, inv, { start: '2025-04-01', amount: 5000, stepUpPct: 10, stepUpEvery: 12 });
    ok('the first year is the base amount', c.sipAmountOn(s, '2026-03-31') === 5000,
      String(c.sipAmountOn(s, '2026-03-31')));
    ok('it steps up on the anniversary', c.sipAmountOn(s, '2026-04-01') === 5500,
      String(c.sipAmountOn(s, '2026-04-01')));
    ok('and compounds the year after', c.sipAmountOn(s, '2027-04-01') === 6050,
      String(c.sipAmountOn(s, '2027-04-01')));
    ok('a date before the SIP started is still the base',
      c.sipAmountOn(s, '2024-01-01') === 5000, String(c.sipAmountOn(s, '2024-01-01')));

    const flat = addSip(c, inv, { start: '2020-01-01', amount: 5000, stepUpPct: 0 });
    ok('no step-up means no rise, ever', c.sipAmountOn(flat, '2030-01-01') === 5000,
      String(c.sipAmountOn(flat, '2030-01-01')));
  }

  console.log('\nMarking an instalment paid');
  {
    const { c, inv } = sipBook();
    const s = addSip(c, inv, { start: '2026-06-14' });   /* a Sunday */
    const bankBefore = c.balances().bank.balance;
    const unitsBefore = c.invUnits(inv.id);

    c.markSipPaid(s, '2026-06-14');
    ok('the transaction dialog opens', c.state.dlg && c.state.dlg.kind === 'invtxn');
    ok('pre-filled with the instalment amount', c.state.dlg.data.amount === 5000,
      String(c.state.dlg.data.amount));
    ok('and the instalment date', c.state.dlg.data.date === '2026-06-14', c.state.dlg.data.date);
    ok('recorded as a SIP, not an ordinary buy', c.state.dlg.data.type === 'sip',
      c.state.dlg.data.type);
    ok('and it knows which SIP it belongs to', c.state.dlg.data.sipId === s.id);
    ok('the NAV lookup is announced rather than silently guessed',
      c.state.dlg.data.navBusy === true && /looking up/i.test(c.state.dlg.data.navNote),
      c.state.dlg.data.navNote);

    await c.sipNavFor(inv, '2026-06-14');
    ok('the NAV used is the last one published on or before that day',
      c.state.dlg.data.nav === 86, String(c.state.dlg.data.nav));
    ok('and the day it actually came from is stated',
      /12 Jun|2026-06-12|Jun 2026/i.test(c.state.dlg.data.navNote), c.state.dlg.data.navNote);
    ok('the lookup is no longer running', c.state.dlg.data.navBusy === false);

    ok('the dialog renders', !!c.dlgVals().hasDlg);
    c.saveInvTxn();

    const st = c.invState(c.inv(inv.id));
    ok('the units were worked out from that NAV',
      Math.abs(st.units - (unitsBefore + Math.round((5000 / 86) * 10000) / 10000)) < 0.0001,
      String(st.units));
    ok('the bank fell by the instalment', c.balances().bank.balance === bankBefore - 5000,
      String(c.balances().bank.balance));
    ok('the ledger entry is a transfer',
      c.state.db.txns[c.state.db.txns.length - 1].type === 'transfer');
    ok('a SIP is never counted as spending',
      c.state.db.txns.filter((t) => t.type === 'expense').length === 0);

    const after = c.state.db.sips[0];
    ok('the SIP counts one instalment recorded', (+after.posted || 0) === 1, String(after.posted));
    ok('the date is remembered so it cannot be recorded twice',
      (after.postedDates || []).indexOf('2026-06-14') >= 0, JSON.stringify(after.postedDates));
    ok('and the schedule moved on a month', after.next === '2026-07-14', after.next);
    ok('that instalment is no longer owed',
      c.sipPending(after, '2026-06-30').length === 0,
      JSON.stringify(c.sipPending(after, '2026-06-30')));
    ok('the invTxn is tagged with the SIP',
      c.state.db.invTxns[c.state.db.invTxns.length - 1].sipId === s.id);
  }

  console.log('\nA SIP that runs out stops asking');
  {
    const { c, inv } = sipBook();
    const s = addSip(c, inv, { start: '2026-09-01', count: 1 });
    c.markSipPaid(s, '2026-09-01');
    c.dlgSet({ nav: 100 });
    c.saveInvTxn();
    const after = c.state.db.sips[0];
    ok('it ends once its last instalment is recorded', after.status === 'ended', after.status);
    ok('and owes nothing more', c.sipPending(after, '2027-01-01').length === 0);
  }

  console.log('\nNo published NAV means nothing is invented');
  {
    const { c, inv } = sipBook('fail');
    const s = addSip(c, inv, { start: '2026-06-15' });
    c.markSipPaid(s, '2026-06-15');
    await c.sipNavFor(inv, '2026-06-15');
    ok('the failure is stated plainly',
      /could not be fetched/i.test(c.state.dlg.data.navNote), c.state.dlg.data.navNote);
    ok('the lookup stops running', c.state.dlg.data.navBusy === false);
    ok('and the SIP has still recorded nothing', (+c.state.db.sips[0].posted || 0) === 0);

    /* A date earlier than anything published. */
    const b = sipBook();
    b.c.markSipPaid(addSip(b.c, b.inv, { start: '2026-01-05' }), '2026-01-05');
    await b.c.sipNavFor(b.inv, '2026-01-05');
    ok('a date before the series says so, rather than reaching forward',
      /no nav was published/i.test(b.c.state.dlg.data.navNote), b.c.state.dlg.data.navNote);
    ok('and leaves the NAV as it was, not zeroed or guessed',
      b.c.state.dlg.data.nav === PPFAS.nav, String(b.c.state.dlg.data.nav));
  }

  console.log('\nSkipping an instalment moves on without moving money');
  {
    const { c, inv } = sipBook();
    const s = addSip(c, inv, { start: '2026-06-15' });
    const bankBefore = c.balances().bank.balance;
    const txnsBefore = c.state.db.txns.length;
    c.skipSip(s);
    const after = c.state.db.sips[0];
    ok('the skipped date is remembered', (after.skipped || []).indexOf('2026-06-15') >= 0,
      JSON.stringify(after.skipped));
    ok('the schedule moved on', after.next === '2026-07-15', after.next);
    ok('but nothing counts as recorded', (+after.posted || 0) === 0, String(after.posted));
    ok('no money moved', c.balances().bank.balance === bankBefore);
    ok('and no ledger entry was made', c.state.db.txns.length === txnsBefore);
    ok('the skipped instalment is not offered again',
      c.sipPending(after, '2026-06-30').length === 0);
  }

  console.log('\nDeleting a SIP keeps what it bought');
  {
    const { c, inv } = sipBook();
    const s = addSip(c, inv, { start: '2026-06-15' });
    c.markSipPaid(s, '2026-06-15');
    c.dlgSet({ nav: 88 });
    c.saveInvTxn();
    const investedBefore = c.invState(c.inv(inv.id)).invested;

    c.deleteSip(c.state.db.sips[0]);
    ok('it asks first', !!c.state.confirm);
    c.state.confirm.ok();
    ok('the SIP is gone', c.state.db.sips.length === 0);
    ok('the instalment it bought is kept',
      c.invState(c.inv(inv.id)).invested === investedBefore,
      String(c.invState(c.inv(inv.id)).invested));
    ok('and so is its ledger entry',
      c.state.db.txns.filter((t) => t.type === 'transfer').length === 2,
      String(c.state.db.txns.length));
  }

  console.log('\nThe SIP screen renders');
  {
    const { c, inv } = sipBook();
    c.state.tab = 'Investments';
    c.setState({ invView: 'sips' });

    let v = c.investVals();
    ok('the SIP view is reached through the tab', v.tableTitle === 'SIPs', v.tableTitle);
    ok('it renders when empty', v.isTable === true && v.tableEmpty === true);
    ok('and offers to add one, since a holding exists', v.emptyBtn === '+ Add SIP', v.emptyBtn);
    ok('every panel has a value', v.panels.every((p) => p.value !== undefined && p.value !== ''));
    ok('with nothing waiting', v.panels[1].value === mmInrOf(0), v.panels[1].value);

    addSip(c, inv, { start: '2026-06-15' });
    v = c.investVals();
    ok('the SIP appears as a row', v.tableRows.length === 1, String(v.tableRows.length));
    ok('with a cell for every column',
      v.tableRows[0].cells.length === v.tableCols.length,
      v.tableRows[0].cells.length + ' vs ' + v.tableCols.length);
    ok('a due SIP is highlighted', /fff8e6/.test(v.tableRows[0].style), v.tableRows[0].style);
    ok('the heading says how many are waiting', /waiting/.test(v.tableSub), v.tableSub);
    ok('committed each month is the instalment', v.panels[0].value === mmInrOf(5000),
      v.panels[0].value);
    ok('no panel shows NaN or undefined',
      v.panels.every((p) => !/NaN|undefined|Infinity/.test(String(p.value) + String(p.note))),
      JSON.stringify(v.panels.map((p) => p.value)));
    ok('and no row cell does either',
      v.tableRows[0].cells.every((cell) => !/NaN|undefined|Infinity/.test(String(cell.text || ''))),
      JSON.stringify(v.tableRows[0].cells.map((x) => x.text)));

    /* The switch back. */
    v.tableTools[0].go();
    ok('the toolbar switches back to holdings', c.state.invView === 'holdings', c.state.invView);
    ok('and the holdings table returns', c.investVals().tableTitle === 'Investments');

    /* A SIP pointing at a deleted investment must not crash the screen. */
    c.setState({ invView: 'sips' });
    c.mutate((db) => { db.investments = []; });
    v = c.investVals();
    ok('an orphaned SIP still renders', v.tableRows.length === 1);
    ok('and says so rather than showing "undefined"',
      /deleted investment/.test(v.tableRows[0].cells[0].text), v.tableRows[0].cells[0].text);
  }

  console.log('\nThe SIP dialog renders');
  {
    const { c, inv } = sipBook();
    c.openSip('add');
    ok('it opens', c.state.dlg && c.state.dlg.kind === 'sip');
    ok('with the existing holding chosen', c.state.dlg.data.investmentId === inv.id);
    ok('and renders', !!c.dlgVals().hasDlg);

    c.dlgSet({ stepUpPct: 10 });
    const withStep = c.dlgVals();
    ok('the step-up interval appears once a step-up is asked for',
      JSON.stringify(withStep.dlgFields).indexOf('Step up every') >= 0);

    c.openSip('edit', c.state.db.sips[0] || Object.assign({}, c.state.dlg.data, { id: 'x', posted: 3, skipped: ['2026-01-01'] }));
    ok('editing renders too', !!c.dlgVals().hasDlg);

    /* With nothing to invest into, it says so instead of offering a broken form. */
    const empty = book();
    empty.openSip('add');
    const ev = empty.dlgVals();
    ok('with no holdings it explains rather than offering an empty list',
      JSON.stringify(ev.dlgFields).indexOf('has to buy into something') >= 0);
  }

  console.log('\nThe Investments panels count SIPs honestly');
  {
    const { c, inv } = sipBook();
    addSip(c, inv, { start: '2026-09-15', amount: 5000, freq: 'monthly' });
    addSip(c, inv, { start: '2026-09-15', amount: 3000, freq: 'quarterly' });
    const sum = c.invMonthAndMaturity();
    ok('a quarterly SIP is not counted as a monthly one',
      sum.monthlySip === Math.round(5000 + 3000 / 3), String(sum.monthlySip));
    ok('both are counted as active', sum.activeSips === 2, String(sum.activeSips));
    ok('and both are due today', sum.dueSips === 2, String(sum.dueSips));
    ok('for the right total', sum.dueAmount === 8000, String(sum.dueAmount));
  }

  console.log('\nGoals are visible again, inside Investments');
  {
    const c = withFundSearch(book());
    c.mutate((db) => {
      db.goals = [
        { id: 'g1', name: 'Emergency fund', target: 300000, saved: 90000, by: '2027-03-31', accountId: 'bank' },
        { id: 'g2', name: 'New laptop', target: 120000, saved: 120000, by: '', accountId: 'bank' }
      ];
    });
    c.state.tab = 'Investments';
    c.setState({ invView: 'goals' });

    const v = c.investVals(c.balances());
    ok('the goals view is reachable', v.tableTitle === 'Savings goals', v.tableTitle);
    ok('both goals are listed', v.tableRows.length === 2, String(v.tableRows.length));
    ok('the first is the one we saved', /Emergency fund/.test(v.tableRows[0].cells[0].text),
      v.tableRows[0].cells[0].text);
    ok('the view switcher is still there', v.tableTools.length >= 4, String(v.tableTools.length));
    ok('and it offers to add a goal',
      JSON.stringify(v.tableTools).indexOf('Add goal') >= 0);
    ok('the panels total what is targeted', v.panels[0].value === mmInrOf(420000),
      v.panels[0].value);
    ok('and what is saved', v.panels[1].value === mmInrOf(210000), v.panels[1].value);
    ok('no cell shows NaN or undefined',
      v.tableRows.every((r) => r.cells.every((cell) => !/NaN|undefined|Infinity/.test(String(cell.text || '')))),
      JSON.stringify(v.tableRows[0].cells.map((x) => x.text)));
    ok('it says how a goal differs from a holding',
      v.hasTableNote && /separate from a holding/.test(v.tableNote), v.tableNote);

    /* The switcher goes all three ways. */
    v.tableTools[0].go();
    ok('back to holdings', c.investVals(c.balances()).tableTitle === 'Investments');
    v.tableTools[1].go();
    ok('across to SIPs', c.investVals(c.balances()).tableTitle === 'SIPs');
    v.tableTools[2].go();
    ok('and back to goals', c.investVals(c.balances()).tableTitle === 'Savings goals');
  }

  console.log('\nThe dashboard shows the portfolio without contradicting it');
  {
    const c = withFundSearch(book());
    const dash = () => c.dashVals(c.balances(), c.baseList(), c.summary());

    let d = dash();
    const find = (label) => d.dashBlocks.filter((b) => b.label === label)[0];
    ok('there is a portfolio block', !!find('Portfolio value'));
    ok('with nothing invested it shows a dash, not zero',
      find('Portfolio value').value === '—', find('Portfolio value').value);
    ok('and says so', /nothing invested/i.test(find('Portfolio value').note),
      find('Portfolio value').note);
    ok('the SIP block says there are none',
      find('SIPs due').value === '—' && /no sips/i.test(find('SIPs due').note),
      find('SIPs due').note);
    ok('no dashboard block shows NaN or undefined',
      d.dashBlocks.every((b) => !/NaN|undefined|Infinity/.test(String(b.value) + String(b.note))),
      JSON.stringify(d.dashBlocks.map((b) => b.value)));

    /* Buy something, then move the price. */
    c.openInvestment('add', {});
    c.invPickFund(PPFAS);
    c.dlgSet({ buyDate: '2026-03-15', buyAmount: 50000 });
    c.saveInvestment();
    c.mutate((db) => { db.investments[0].currentNav = 98.5; });

    d = dash();
    const pv = find('Portfolio value');
    const pf = c.portfolio();
    ok('the block equals the portfolio, to the rupee',
      pv.value === mmInrOf(pf.totals.value), pv.value + ' vs ' + mmInrOf(pf.totals.value));
    ok('the gain is shown with its sign', /^\+/.test(pv.note), pv.note);
    ok('and the return alongside it', /%/.test(pv.note), pv.note);
    ok('the account block still shows what it cost, which is a different number',
      find('Investments & assets').value === mmInrOf(50000),
      find('Investments & assets').value);
    ok('and says which of the two it is', /what they cost/i.test(find('Investments & assets').note),
      find('Investments & assets').note);
    ok('net worth already includes the gain',
      Math.abs(c.netWorth() - (450000 + pf.totals.value)) < 1, String(c.netWorth()));

    const list = d.dashLists.filter((l) => l.title === 'Portfolio')[0];
    ok('the portfolio list is on the dashboard', !!list);
    ok('with the holding in it', list.rows.length === 1, String(list.rows.length));
    ok('showing its return, signed', /^\+/.test(list.rows[0].a), list.rows[0].a);
    ok('and its value', list.rows[0].c === mmInrOf(pf.totals.value), list.rows[0].c);

    /* A SIP that is owed shows as owed. */
    c.openSip('add');
    c.dlgSet({
      investmentId: c.state.db.investments[0].id, amount: 5000,
      freq: 'monthly', start: '2026-08-15', accountId: 'bank'
    });
    c.saveSip();
    d = dash();
    ok('the SIP block counts what is waiting',
      find('SIPs due').value === mmInrOf(10000), find('SIPs due').value);
    ok('and how many instalments, not just how many SIPs',
      /2 instalments waiting, across 1 SIP/.test(find('SIPs due').note), find('SIPs due').note);
    ok('it is coloured as a prompt, not as an error',
      find('SIPs due').valStyle.indexOf('b3701c') >= 0, find('SIPs due').valStyle);
  }

  /* --------------------------------------------------------------- reports */

  /* A book with a fund, a deposit and gold, so allocation has something to
     allocate and the maturity tracker has something to track. */
  function reportBook() {
    const c = withFundSearch(book());
    c.mutate((db) => {
      db.accounts.push(
        { id: 'fd', name: 'Fixed Deposits', type: 'fd', opening: 0, currency: 'INR', archived: false, createdAt: 1, updatedAt: 1 },
        { id: 'au', name: 'Gold', type: 'gold', opening: 0, currency: 'INR', archived: false, createdAt: 1, updatedAt: 1 });
      db.investments = [
        { id: 'i-mf', name: 'Parag Parikh Flexi Cap', type: 'Lump Sum', accountId: 'mf',
          schemeCode: '122639', currentNav: 100, navDate: '2026-09-11', status: 'active',
          institution: 'PPFAS', createdAt: 1, updatedAt: 1 },
        { id: 'i-fd', name: 'HDFC FD', type: 'Fixed Deposit', accountId: 'fd',
          currentValue: 106000, rate: 7.1, maturityDate: '2026-11-30', status: 'active',
          institution: 'HDFC Bank', createdAt: 1, updatedAt: 1 },
        { id: 'i-fd2', name: 'SBI FD (matured)', type: 'Fixed Deposit', accountId: 'fd',
          currentValue: 52000, rate: 6.5, maturityDate: '2026-07-01', status: 'active',
          institution: 'SBI', createdAt: 1, updatedAt: 1 },
        { id: 'i-au', name: 'Sovereign Gold Bond', type: 'Sovereign Gold Bond', accountId: 'au',
          currentNav: 7500, status: 'active', institution: 'RBI', createdAt: 1, updatedAt: 1 }
      ];
      db.invTxns = [
        { id: 'x1', investmentId: 'i-mf', date: '2026-01-15', type: 'buy', amount: 40000, units: 500, nav: 80, accountId: 'bank' },
        { id: 'x2', investmentId: 'i-fd', date: '2025-11-30', type: 'lumpsum', amount: 100000, units: 0, nav: 0, accountId: 'bank' },
        { id: 'x3', investmentId: 'i-fd2', date: '2025-07-01', type: 'lumpsum', amount: 50000, units: 0, nav: 0, accountId: 'bank' },
        { id: 'x4', investmentId: 'i-au', date: '2026-02-10', type: 'buy', amount: 60000, units: 10, nav: 6000, accountId: 'bank' }
      ];
    });
    return c;
  }

  const report = (c, key) => { c.setState({ tab: 'Reports', report: key }); return c.reportVals(c.baseList(), c.balances()); };

  console.log('\nAsset allocation');
  {
    const c = reportBook();
    const v = report(c, 'invalloc');
    ok('the report exists', v.tableTitle === 'Asset allocation', v.tableTitle);
    ok('three kinds are held', v.tableRows.length === 3, String(v.tableRows.length));

    const shares = v.tableRows.map((r) => parseFloat(r.cells[6].text));
    const sum = shares.reduce((m, x) => m + x, 0);
    ok('the shares add to 100%', Math.abs(sum - 100) < 0.2, String(sum));
    ok('they are ordered largest first',
      shares.every((x, i) => i === 0 || shares[i - 1] >= x), JSON.stringify(shares));

    const pf = c.portfolio();
    ok('the total equals the portfolio', v.panels[0].value === mmInrOf(pf.totals.value),
      v.panels[0].value + ' vs ' + mmInrOf(pf.totals.value));
    ok('the number of kinds is reported', v.panels[1].value === '3', v.panels[1].value);
    ok('and the largest one is named', v.panels[2].note.length > 0, v.panels[2].note);
    ok('a bar per kind', v.bars.length === 3, String(v.bars.length));
    ok('and each bar names its share', v.bars.every((b) => /%/.test(b.name)),
      JSON.stringify(v.bars.map((b) => b.name)));
    ok('concentration is stated as a fact, not a judgement',
      /not a judgement/.test(v.tableNote || ''), v.tableNote);
    ok('nothing shows NaN or undefined',
      v.tableRows.every((r) => r.cells.every((x) => !/NaN|undefined|Infinity/.test(String(x.text || '')))),
      JSON.stringify(v.tableRows[0].cells.map((x) => x.text)));

    /* Empty portfolio. */
    const e = report(book(), 'invalloc');
    ok('an empty portfolio renders', e.tableRows.length === 0);
    ok('with a dash for the largest kind, not 0%', e.panels[2].value === '—', e.panels[2].value);
  }

  console.log('\nInvestment performance');
  {
    const c = reportBook();
    const v = report(c, 'invperf');
    ok('the report exists', v.tableTitle === 'Investment performance', v.tableTitle);
    ok('every open holding is listed', v.tableRows.length === 4, String(v.tableRows.length));

    const gains = v.tableRows.map((r) => r.cells[4].text);
    ok('the best is first — gold, up 15,000', /15,000/.test(gains[0]), gains[0]);
    ok('and the smallest gain is last', /2,000/.test(gains[gains.length - 1]),
      gains[gains.length - 1]);

    const pf = c.portfolio();
    ok('the totals equal the portfolio', v.panels[0].value === mmInrOf(pf.totals.invested),
      v.panels[0].value);
    ok('and so does the value', v.panels[1].value === mmInrOf(pf.totals.value), v.panels[1].value);
    ok('the portfolio XIRR is the whole set of flows, not an average',
      /not an average/.test(v.panels[3].note) || v.panels[3].value === '—', v.panels[3].note);
    ok('a hand-priced holding is marked as such',
      v.tableRows.some((r) => /entered by hand/.test(r.cells[7].text)),
      JSON.stringify(v.tableRows.map((r) => r.cells[7].text)));
    ok('and a fund shows the day it was priced',
      v.tableRows.some((r) => /11-09-2026|2026/.test(r.cells[7].text)),
      JSON.stringify(v.tableRows.map((r) => r.cells[7].text)));
    ok('every XIRR cell is a percentage or a dash, never NaN',
      v.tableRows.every((r) => r.cells[6].text === '—' || /^-?\d+\.\d\d%$/.test(r.cells[6].text)),
      JSON.stringify(v.tableRows.map((r) => r.cells[6].text)));
    ok('it says NAV is daily, not live', /not live/.test(v.tableNote || ''), v.tableNote);

    const one = book();
    one.mutate((db) => {
      db.investments = [{ id: 'z', name: 'Only one', type: 'Lump Sum', accountId: 'mf', currentNav: 0, currentValue: 1000, status: 'active', createdAt: 1, updatedAt: 1 }];
    });
    const v1 = report(one, 'invperf');
    ok('with a single holding there is no "worst"', v1.panels[5].value === '—', v1.panels[5].value);
    ok('and it says why', /only one holding/.test(v1.panels[5].note), v1.panels[5].note);
  }

  console.log('\nMaturity tracker');
  {
    const c = reportBook();
    const v = report(c, 'maturity');
    ok('the report exists', v.tableTitle === 'Maturity tracker', v.tableTitle);
    ok('only dated holdings appear', v.tableRows.length === 2, String(v.tableRows.length));
    ok('the soonest is first', /SBI/.test(v.tableRows[0].cells[0].text), v.tableRows[0].cells[0].text);
    ok('one has already matured', v.tableRows[0].cells[4].text === 'matured',
      v.tableRows[0].cells[4].text);
    ok('and is flagged in red', /fdf2f2/.test(v.tableRows[0].style), v.tableRows[0].style);
    ok('the other counts down in days', /^\d+$/.test(v.tableRows[1].cells[4].text),
      v.tableRows[1].cells[4].text);
    ok('the count is right — 30 November is 76 days from 15 September',
      v.tableRows[1].cells[4].text === '76', v.tableRows[1].cells[4].text);
    ok('the rate is shown', /7\.10%/.test(v.tableRows[1].cells[5].text), v.tableRows[1].cells[5].text);

    ok('the next maturity ahead is named', /HDFC FD/.test(v.panels[1].note), v.panels[1].note);
    ok('and it is the one in the future, not the one behind',
      /30-11-2026/.test(v.panels[1].value), v.panels[1].value);
    ok('within 90 days counts it', v.panels[2].value === '1', v.panels[2].value);
    ok('the matured one is counted separately', v.panels[3].value === '1', v.panels[3].value);
    ok('and says what to do about it', /close or roll/.test(v.panels[3].note), v.panels[3].note);
    ok('nothing is closed on your behalf', /nothing is changed on your behalf/i.test(v.tableNote || ''),
      v.tableNote);
    ok('the value maturing is the sum of the two', v.panels[4].value === mmInrOf(158000),
      v.panels[4].value);

    const e = report(book(), 'maturity');
    ok('with nothing dated it still renders', e.tableRows.length === 0);
    ok('and says so rather than showing a date', e.panels[1].value === '—', e.panels[1].value);
  }

  console.log('\nThe new reports export like the old ones');
  {
    const c = reportBook();
    ['invalloc', 'invperf', 'maturity'].forEach((k) => {
      const v = report(c, k);
      ok(k + ' has a header for every cell',
        v.tableRows.every((r) => r.cells.length === v.tableCols.length),
        k + ': ' + (v.tableRows[0] ? v.tableRows[0].cells.length : 0) + ' vs ' + v.tableCols.length);
      ok(k + ' has a label on every column',
        v.tableCols.every((col) => typeof col.label === 'string'),
        JSON.stringify(v.tableCols.map((x) => x.label)));
      ok(k + ' is offered in the report list',
        JSON.stringify(v.tableTools).indexOf(v.tableTitle) >= 0, v.tableTitle);
    });
  }

  /* ------------------------------------------------- one holding, on its own */

  /* A published series with known values at the dates the periods land on,
     so every percentage below can be checked by hand. Last point 11 Sep 2026. */
  const SERIES = [
    { date: '2021-09-10', nav: 50 },
    { date: '2023-09-10', nav: 60 },
    { date: '2025-09-10', nav: 80 },
    { date: '2026-03-10', nav: 90 },
    { date: '2026-06-10', nav: 95 },
    { date: '2026-08-10', nav: 98 },
    { date: '2026-09-11', nav: 100 }
  ];

  function detailBook(series) {
    const c = withFundSearch(book());
    c.openInvestment('add', {});
    c.invPickFund(PPFAS);
    c.dlgSet({ buyDate: '2026-01-15', buyAmount: 50000 });
    c.saveInvestment();
    const inv = c.state.db.investments[0];
    c.api = function (url) {
      if (url.indexOf('/history') >= 0) {
        if (series === 'fail') return Promise.reject(Object.assign(new Error('gone'), { status: 0 }));
        return Promise.resolve({ schemeCode: inv.schemeCode, history: series || SERIES });
      }
      return Promise.resolve({});
    };
    return { c, inv };
  }

  console.log('\nOpening a holding');
  {
    const { c, inv } = detailBook();
    c.state.tab = 'Investments';

    /* From the portfolio row. */
    let v = c.investVals(c.balances());
    v.tableRows[0].go();
    ok('the row opens the holding rather than the edit dialog',
      c.state.invDetail === inv.id, c.state.invDetail);
    ok('and no dialog was opened', !c.state.dlg);

    await c.loadNavHistory(inv);
    v = c.investVals(c.balances());
    ok('the title is the holding', v.tableTitle === inv.name, v.tableTitle);
    ok('the subtitle carries the scheme code', /122639/.test(v.tableSub), v.tableSub);
    ok('and the ISIN', /INF879O01027/.test(v.tableSub), v.tableSub);
    ok('the opening purchase is listed', v.tableRows.length === 1, String(v.tableRows.length));
    ok('with its amount', /50,000/.test(v.tableRows[0].cells[2].text), v.tableRows[0].cells[2].text);
    ok('and its units', /^\d+\.\d{4}$/.test(v.tableRows[0].cells[3].text), v.tableRows[0].cells[3].text);
    ok('there is a way back', /All investments/.test(JSON.stringify(v.tableTools)));
    ok('no cell shows NaN or undefined',
      v.tableRows[0].cells.every((x) => !/NaN|undefined|Infinity/.test(String(x.text || ''))),
      JSON.stringify(v.tableRows[0].cells.map((x) => x.text)));
    ok('no panel does either',
      v.panels.every((p) => !/NaN|undefined|Infinity/.test(String(p.value) + String(p.note))),
      JSON.stringify(v.panels.map((p) => p.value)));

    /* The figures match the portfolio exactly. */
    const st = c.invState(c.inv(inv.id));
    ok('invested matches the portfolio', v.panels[0].value === mmInrOf(st.invested), v.panels[0].value);
    ok('value matches', v.panels[1].value === mmInrOf(st.value), v.panels[1].value);
    ok('gain matches', v.panels[2].value === mmInrOf(st.gain), v.panels[2].value);
    ok('units are shown for a fund', v.panels[5].label === 'Units', v.panels[5].label);
    ok('with the average cost', /average cost/.test(v.panels[5].note), v.panels[5].note);

    v.tableTools[0].go();
    ok('the back button returns to the portfolio', !c.state.invDetail, c.state.invDetail);
    ok('and the portfolio table is showing again',
      c.investVals(c.balances()).tableTitle === 'Investments');
  }

  console.log('\nPublished periods, and only the ones the series covers');
  {
    const { c, inv } = detailBook();
    c.openInvDetail(inv);
    await c.loadNavHistory(inv);

    const per = c.invPeriods(c.inv(inv.id));
    const by = {};
    per.rows.forEach((r) => { by[r.label] = r; });

    ok('six periods plus "since"', per.rows.length === 7, String(per.rows.length));
    ok('1 month is +2.04%', by['1 month'].pct === 2.04, String(by['1 month'].pct));
    ok('3 months is +5.26%', by['3 months'].pct === 5.26, String(by['3 months'].pct));
    ok('6 months is +11.11%', by['6 months'].pct === 11.11, String(by['6 months'].pct));
    ok('1 year is +25.00%', by['1 year'].pct === 25, String(by['1 year'].pct));
    ok('3 years is +66.67%', by['3 years'].pct === 66.67, String(by['3 years'].pct));
    ok('5 years is +100.00%', by['5 years'].pct === 100, String(by['5 years'].pct));

    ok('under a year, nothing is annualised', by['1 month'].cagr === null && by['6 months'].cagr === null);
    ok('a year is annualised at the same rate', by['1 year'].cagr === 25, String(by['1 year'].cagr));
    ok('three years compounds to 18.56% a year', by['3 years'].cagr === 18.56,
      String(by['3 years'].cagr));
    ok('five years to 14.87% a year', by['5 years'].cagr === 14.87, String(by['5 years'].cagr));
    ok('each period names the date it measures from',
      per.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.from)),
      JSON.stringify(per.rows.map((r) => r.from)));
    ok('the "since" row names the first published day',
      /Since 10-09-2021/.test(per.rows[6].label), per.rows[6].label);

    const v = c.investVals(c.balances());
    ok('they are drawn as bars', v.hasBars === true && v.bars.length === 7, String(v.bars.length));
    ok('each bar is signed', v.bars.every((b) => /^[+-]/.test(b.value)),
      JSON.stringify(v.bars.map((b) => b.value)));
    ok('and annualised figures are labelled as per year',
      /a year/.test(v.bars[3].name), v.bars[3].name);
    ok('the note separates what the fund did from what you got',
      /what the fund did, not what you got/.test(v.tableNote), v.tableNote);
  }

  console.log('\nA young fund has no long periods invented for it');
  {
    const { c, inv } = detailBook([
      { date: '2026-06-10', nav: 95 },
      { date: '2026-08-10', nav: 98 },
      { date: '2026-09-11', nav: 100 }
    ]);
    c.openInvDetail(inv);
    await c.loadNavHistory(inv);

    const per = c.invPeriods(c.inv(inv.id));
    const labels = per.rows.map((r) => r.label);
    ok('one month is there', labels.indexOf('1 month') >= 0, labels.join(','));
    ok('three months is there', labels.indexOf('3 months') >= 0, labels.join(','));
    ok('six months is NOT, because the series does not reach back that far',
      labels.indexOf('6 months') < 0, labels.join(','));
    ok('nor is one year', labels.indexOf('1 year') < 0, labels.join(','));
    ok('nor three or five', labels.indexOf('3 years') < 0 && labels.indexOf('5 years') < 0);
    ok('nothing is annualised from three months of data',
      per.rows.every((r) => r.cagr === null), JSON.stringify(per.rows.map((r) => r.cagr)));
  }

  console.log('\nNo history means no periods, not estimated ones');
  {
    const { c, inv } = detailBook('fail');
    c.openInvDetail(inv);
    await c.loadNavHistory(inv);

    const per = c.invPeriods(c.inv(inv.id));
    ok('no periods are produced', per.rows.length === 0, String(per.rows.length));
    ok('the reason is given', /could not be reached/i.test(per.error), per.error);
    const v = c.investVals(c.balances());
    ok('no bars are drawn', v.hasBars === false && v.bars.length === 0);
    ok('and the screen says why', /could not be reached/i.test(v.tableNote), v.tableNote);
    ok('the holding’s own figures are unaffected',
      v.panels[0].value === mmInrOf(50000), v.panels[0].value);

    /* An empty series is different from a failure, and says so too. */
    const b = detailBook([]);
    b.c.openInvDetail(b.inv);
    await b.c.loadNavHistory(b.inv);
    ok('an empty series is reported, not treated as zero return',
      /no published nav history/i.test(b.c.invPeriods(b.c.inv(b.inv.id)).error),
      b.c.invPeriods(b.c.inv(b.inv.id)).error);
  }

  console.log('\nPeriods never come from the wrong scheme');
  {
    const { c, inv } = detailBook();
    c.openInvDetail(inv);
    await c.loadNavHistory(inv);
    ok('the series is held against its scheme code', c.state.invNav.code === '122639',
      c.state.invNav.code);

    /* A second holding, a different fund, no series fetched for it yet. */
    c.mutate((db) => {
      db.investments.push({
        id: 'other', name: 'Some other fund', type: 'Lump Sum', accountId: inv.accountId,
        schemeCode: '999999', currentNav: 10, status: 'active', createdAt: 1, updatedAt: 1
      });
    });
    ok('the other fund gets no periods from the first one’s series',
      c.invPeriods(c.inv('other')) === null, JSON.stringify(c.invPeriods(c.inv('other'))));

    /* A holding with no scheme at all. */
    c.mutate((db) => {
      db.investments.push({
        id: 'manual', name: 'Hand-priced', type: 'Lump Sum', accountId: inv.accountId,
        schemeCode: '', currentNav: 10, status: 'active', createdAt: 1, updatedAt: 1
      });
    });
    ok('an unlinked holding gets none either', c.invPeriods(c.inv('manual')) === null);
    c.setState({ invDetail: 'manual' });
    const v = c.investVals(c.balances());
    ok('and is told how to link one', /search for the fund to link one/.test(v.tableNote),
      v.tableNote);
  }

  console.log('\nA deposit shows what a deposit has');
  {
    const c = book();
    c.openInvestment('add', {});
    c.dlgSet({
      name: 'HDFC Fixed Deposit', type: 'Fixed Deposit', institution: 'HDFC Bank',
      currentValue: 107000, rate: 7.1, maturityDate: '2027-09-15',
      buyDate: '2026-09-15', buyAmount: 100000
    });
    c.saveInvestment();
    const inv = c.state.db.investments[0];
    c.openInvDetail(inv);
    const v = c.investVals(c.balances());

    ok('no units panel', v.panels.every((p) => p.label !== 'Units'),
      JSON.stringify(v.panels.map((p) => p.label)));
    ok('a maturity panel instead', v.panels[5].label === 'Maturity', v.panels[5].label);
    ok('with the date', /15-09-2027/.test(v.panels[5].value), v.panels[5].value);
    ok('and the days to go', /in 365 days/.test(v.panels[5].note), v.panels[5].note);
    ok('the rate is shown', v.panels[6].value === '7.10%', v.panels[6].value);
    ok('no bars, since there is no published series', v.hasBars === false);
    ok('and it is not told to link a fund', !/search for the fund/.test(v.tableNote), v.tableNote);
  }

  console.log('\nRemoving a transaction from a holding');
  {
    const { c, inv } = detailBook();
    c.openInvDetail(inv);
    const txn = c.invTxnsFor(inv.id)[0];
    const ledgerBefore = c.state.db.txns.length;

    c.deleteInvTxn(c.inv(inv.id), txn);
    ok('it asks first', !!c.state.confirm);
    ok('and warns that the ledger entry stays',
      /ledger entry is not removed/i.test(c.state.confirm.msg), c.state.confirm.msg);
    c.state.confirm.ok();

    ok('the holding’s transaction is gone', c.invTxnsFor(inv.id).length === 0);
    ok('the ledger entry is untouched, as promised',
      c.state.db.txns.length === ledgerBefore, String(c.state.db.txns.length));
    ok('so what is invested falls to nothing', c.invState(c.inv(inv.id)).invested === 0,
      String(c.invState(c.inv(inv.id)).invested));
    ok('and the detail view still renders', !!c.investVals(c.balances()).tableEmpty);
  }

  console.log('\nA deleted holding does not strand the screen');
  {
    const { c, inv } = detailBook();
    c.openInvDetail(inv);
    c.mutate((db) => { db.investments = []; });
    const v = c.investVals(c.balances());
    ok('it falls back to the portfolio rather than throwing',
      v.tableTitle === 'Investments', v.tableTitle);
    ok('which is empty', v.tableEmpty === true);
  }

  /* ----------------------------------------------------------- watchlist */

  const PPFAS_REG = {
    schemeCode: '122640', isin: 'INF879O01019', isinEffective: 'INF879O01019',
    name: 'Parag Parikh Flexi Cap Fund', amc: 'PPFAS Mutual Fund',
    plan: 'Regular Plan', option: 'Growth', nav: 81.6012, navDate: '2026-09-11'
  };

  function watchBook(opts) {
    opts = opts || {};
    const c = book();
    c.api = function (url) {
      if (url.indexOf('/funds/search') >= 0) {
        return Promise.resolve({ funds: [PPFAS, PPFAS_REG], count: 2, catalogue: { stale: false } });
      }
      /* One scheme, for the price refresh. */
      const m = url.match(/\/funds\/(\d+)$/);
      if (m) {
        if (opts.refresh === 'fail') return Promise.reject(new Error('provider down'));
        if (opts.refresh === 'partial' && m[1] === '122640') return Promise.reject(new Error('down'));
        /* A provider that answers, but with nothing usable in it. */
        if (opts.refresh === 'zero') return Promise.resolve({ fund: { schemeCode: m[1], nav: 0, navDate: '' } });
        if (opts.refresh === 'empty') return Promise.resolve({ fund: { schemeCode: m[1] } });
        return Promise.resolve({ fund: { schemeCode: m[1], nav: 91.5, navDate: '2026-09-15' }, source: 'AMFI' });
      }
      return Promise.resolve({});
    };
    return c;
  }

  async function watch(c, fund) {
    c.openWatch();
    c.dlgSet({ fundQuery: 'parag' });
    await c.watchFundSearch();
    c.watchPickFund(fund || PPFAS);
    c.saveWatch();
    return c.state.db.watchlist[c.state.db.watchlist.length - 1];
  }

  console.log('\nThe watchlist collection reaches every book');
  {
    const c = book();
    ok('a new book has one', Array.isArray(c.state.db.watchlist), typeof c.state.db.watchlist);
    ok('and it starts empty', c.state.db.watchlist.length === 0);

    /* An older book, saved before the watchlist existed, must gain one
       without losing anything it already had. */
    const migrated = c.migrate({
      schemaVersion: 5, accounts: [{ id: 'a', name: 'Bank', type: 'bank' }],
      txns: [{ id: 't', date: '2026-01-01', type: 'expense', amount: 100 }],
      goals: [{ id: 'g', name: 'Kept', target: 1000, saved: 10 }],
      investments: [{ id: 'i', name: 'Kept too', type: 'Lump Sum' }]
    });
    ok('an older book gains a watchlist', Array.isArray(migrated.watchlist),
      typeof migrated.watchlist);
    ok('empty, not invented', migrated.watchlist.length === 0);
    ok('and nothing it had was lost',
      migrated.accounts.length === 1 && migrated.txns.length === 1 &&
      migrated.goals.length === 1 && migrated.investments.length === 1,
      JSON.stringify({ a: migrated.accounts.length, t: migrated.txns.length,
        g: migrated.goals.length, i: migrated.investments.length }));
  }

  console.log('\nWatching a scheme buys nothing');
  {
    const c = watchBook();
    const w = await watch(c);

    ok('it is on the watchlist', c.state.db.watchlist.length === 1);
    ok('with its scheme code', w.schemeCode === '122639', w.schemeCode);
    ok('its ISIN', w.isin === 'INF879O01027', w.isin);
    ok('its plan, so Direct is not confused with Regular', w.plan === 'Direct Plan', w.plan);
    ok('and its dated NAV', w.nav === 89.5712 && w.navDate === '2026-09-11',
      w.nav + ' @ ' + w.navDate);

    ok('no investment was created', c.state.db.investments.length === 0);
    ok('no transaction was recorded', c.state.db.txns.length === 0);
    ok('no account was created', c.state.db.accounts.length === 2, String(c.state.db.accounts.length));
    ok('the bank is untouched', c.balances().bank.balance === 500000,
      String(c.balances().bank.balance));
    ok('and net worth has not moved', c.netWorth() === 500000, String(c.netWorth()));
    ok('the portfolio is still empty', c.portfolio().rows.length === 0);
    ok('so is its value', c.portfolio().totals.value === 0, String(c.portfolio().totals.value));
  }

  console.log('\nWhat the watchlist refuses');
  {
    const c = watchBook();
    c.openWatch();
    c.saveWatch();
    ok('nothing is added without a scheme chosen', c.state.db.watchlist.length === 0);
    ok('and the dialog stays open', !!c.state.dlg);

    await watch(c);
    c.openWatch();
    c.dlgSet({ fundQuery: 'parag' });
    await c.watchFundSearch();
    c.watchPickFund(PPFAS);
    c.saveWatch();
    ok('the same scheme cannot be watched twice', c.state.db.watchlist.length === 1,
      String(c.state.db.watchlist.length));

    /* But its Regular twin is a different scheme and is allowed. */
    c.watchPickFund(PPFAS_REG);
    c.saveWatch();
    ok('a different plan of the same fund is a different scheme',
      c.state.db.watchlist.length === 2, String(c.state.db.watchlist.length));
    ok('and they are told apart by code',
      c.state.db.watchlist.map((x) => x.schemeCode).join(',') === '122639,122640',
      c.state.db.watchlist.map((x) => x.schemeCode).join(','));
  }

  console.log('\nA failed search adds nothing');
  {
    const c = book();
    c.api = () => Promise.reject(Object.assign(new Error('offline'), { status: 0 }));
    c.openWatch();
    c.dlgSet({ fundQuery: 'parag' });
    await c.watchFundSearch();
    ok('no schemes are produced', (c.state.dlg.data.fundResults || []).length === 0);
    ok('the failure is explained', /could not reach/i.test(c.state.dlg.data.fundError),
      c.state.dlg.data.fundError);
    ok('and it says nothing was added', /nothing has been added/i.test(c.state.dlg.data.fundError),
      c.state.dlg.data.fundError);
    c.saveWatch();
    ok('saving after a failed search still adds nothing', c.state.db.watchlist.length === 0);
  }

  console.log('\nRefreshing prices');
  {
    const c = watchBook();
    await watch(c);
    ok('the price starts at the one the search gave', c.state.db.watchlist[0].nav === 89.5712);

    await c.refreshWatch();
    ok('the price is updated', c.state.db.watchlist[0].nav === 91.5,
      String(c.state.db.watchlist[0].nav));
    ok('and so is its date', c.state.db.watchlist[0].navDate === '2026-09-15',
      c.state.db.watchlist[0].navDate);
    ok('the refresh is no longer running', c.state.watchBusy === false);
    ok('and still nothing was bought', c.state.db.txns.length === 0);
  }

  console.log('\nA failed refresh keeps the price it had, rather than blanking it');
  {
    const c = watchBook({ refresh: 'fail' });
    await watch(c);
    const before = c.state.db.watchlist[0].nav;
    await c.refreshWatch();
    ok('the old price survives', c.state.db.watchlist[0].nav === before,
      String(c.state.db.watchlist[0].nav));
    ok('it is not zeroed', c.state.db.watchlist[0].nav > 0);
    ok('and the date is not moved forward to imply it is fresh',
      c.state.db.watchlist[0].navDate === '2026-09-11', c.state.db.watchlist[0].navDate);

    /* A reply that arrives but carries no usable price is not a price. This
       is the failure that looks like a success, so it is the one most likely
       to write a zero over a real number. */
    for (const mode of ['zero', 'empty']) {
      const z = watchBook({ refresh: mode });
      await watch(z);
      await z.refreshWatch();
      ok('a "' + mode + '" reply does not overwrite the real price',
        z.state.db.watchlist[0].nav === 89.5712, String(z.state.db.watchlist[0].nav));
      ok('and does not clear its date', z.state.db.watchlist[0].navDate === '2026-09-11',
        z.state.db.watchlist[0].navDate);
    }

    /* Some succeed, some do not. */
    const c2 = watchBook({ refresh: 'partial' });
    await watch(c2, PPFAS);
    await watch(c2, PPFAS_REG);
    await c2.refreshWatch();
    const byCode = {};
    c2.state.db.watchlist.forEach((w) => { byCode[w.schemeCode] = w; });
    ok('the one that answered is updated', byCode['122639'].nav === 91.5,
      String(byCode['122639'].nav));
    ok('the one that did not keeps its own price', byCode['122640'].nav === 81.6012,
      String(byCode['122640'].nav));
  }

  console.log('\nMoving a watched scheme into the portfolio');
  {
    const c = watchBook();
    const w = await watch(c);
    c.investFromWatch(w);

    ok('the Add investment dialog opens', c.state.dlg && c.state.dlg.kind === 'investment');
    const d = c.state.dlg.data;
    ok('already identified', d.schemeCode === '122639', d.schemeCode);
    ok('with the ISIN', d.isin === 'INF879O01027', d.isin);
    ok('the plan', d.plan === 'Direct Plan', d.plan);
    ok('and the price to buy at', d.buyNav === 89.5712, String(d.buyNav));
    ok('nothing has been bought yet', c.state.db.investments.length === 0);

    /* Finish the purchase: it is the ordinary flow, with the ordinary rules. */
    c.dlgSet({ buyDate: '2026-09-15', buyAmount: 50000 });
    c.saveInvestment();
    ok('now it is a holding', c.state.db.investments.length === 1);
    ok('the ledger entry is a transfer',
      c.state.db.txns.length === 1 && c.state.db.txns[0].type === 'transfer');
    ok('nothing became an expense',
      c.state.db.txns.filter((t) => t.type === 'expense').length === 0);
    ok('the watchlist entry is left alone — removing it is the user’s call',
      c.state.db.watchlist.length === 1);
  }

  console.log('\nRemoving from the watchlist');
  {
    const c = watchBook();
    const w = await watch(c);
    c.removeWatch(w);
    ok('it is gone', c.state.db.watchlist.length === 0);
    ok('with no confirmation needed, because nothing of value is lost',
      !c.state.confirm);
  }

  console.log('\nThe watchlist screen renders');
  {
    const c = watchBook();
    c.state.tab = 'Investments';
    c.setState({ invView: 'watch' });

    let v = c.investVals(c.balances());
    ok('the view is reachable', v.tableTitle === 'Watchlist', v.tableTitle);
    ok('it renders when empty', v.tableEmpty === true);
    ok('with a dash for the oldest price, not a date', v.panels[1].value === '—',
      v.panels[1].value);
    ok('and says none are held', /none of these are in your portfolio/.test(v.panels[2].note),
      v.panels[2].note);

    await watch(c);
    v = c.investVals(c.balances());
    ok('the scheme appears as a row', v.tableRows.length === 1, String(v.tableRows.length));
    ok('with a cell for every column',
      v.tableRows[0].cells.length === v.tableCols.length,
      v.tableRows[0].cells.length + ' vs ' + v.tableCols.length);
    ok('showing the NAV', /89\.57/.test(v.tableRows[0].cells[3].text), v.tableRows[0].cells[3].text);
    ok('and the day it is from', /11-09-2026/.test(v.tableRows[0].cells[4].text),
      v.tableRows[0].cells[4].text);
    ok('the heading says it counts towards nothing',
      /none of it is yours/.test(v.tableSub), v.tableSub);
    ok('and so does the note',
      /kept out of the portfolio, net worth and every return/.test(v.tableNote), v.tableNote);
    ok('no panel shows NaN or undefined',
      v.panels.every((p) => !/NaN|undefined|Infinity/.test(String(p.value) + String(p.note))),
      JSON.stringify(v.panels.map((p) => p.value)));
    ok('nor any cell',
      v.tableRows[0].cells.every((x) => !/NaN|undefined|Infinity/.test(String(x.text || ''))),
      JSON.stringify(v.tableRows[0].cells.map((x) => x.text)));

    /* A stale price is flagged rather than passed off as current. */
    c.mutate((db) => { db.watchlist[0].navDate = '2026-08-01'; });
    v = c.investVals(c.balances());
    ok('a price more than a week old is flagged',
      v.tableRows[0].cells[4].style.indexOf('b3701c') >= 0, v.tableRows[0].cells[4].style);
    ok('and the panel says how old it is', /45 days old/.test(v.panels[1].note),
      v.panels[1].note);

    /* Owning it is noticed. */
    c.mutate((db) => {
      db.investments.push({ id: 'x', name: 'Owned', type: 'Lump Sum', accountId: 'mf',
        schemeCode: '122639', currentNav: 90, status: 'active', createdAt: 1, updatedAt: 1 });
    });
    v = c.investVals(c.balances());
    ok('a watched scheme already held is counted', v.panels[2].value === '1', v.panels[2].value);

    /* And the view switcher reaches all four. */
    ok('there are four views', v.tableTools.filter((b) =>
      ['Holdings', 'SIPs', 'Goals', 'Watchlist'].indexOf(b.label) >= 0).length === 4,
      JSON.stringify(v.tableTools.map((b) => b.label)));
  }

  console.log('\nThe watchlist dialog renders');
  {
    const c = watchBook();
    c.openWatch();
    ok('it opens', c.state.dlg.kind === 'watch');
    ok('and renders', !!c.dlgVals().hasDlg);

    c.dlgSet({ fundQuery: 'parag' });
    await c.watchFundSearch();
    const withResults = c.dlgVals();
    ok('the results are listed to choose from', withResults.dlgTableRows.length === 2,
      String(withResults.dlgTableRows.length));
    ok('each with a Use action',
      JSON.stringify(withResults.dlgTableRows).indexOf('Use') >= 0);

    c.watchPickFund(PPFAS);
    const picked = c.dlgVals();
    ok('the chosen scheme is shown back', JSON.stringify(picked.dlgFields).indexOf('122639') >= 0);
    ok('with its NAV dated', JSON.stringify(picked.dlgFields).indexOf('as of') >= 0);
    ok('and the dialog says watching buys nothing',
      /buys nothing/.test(picked.dlgNote || JSON.stringify(picked)), picked.dlgNote);
  }

  /* ------------------------------------------- prices, and the date they are as at */

  /* A book holding one linked fund, bought long enough ago that a year's
     worth of XIRR is unambiguous. `now` is what the server will answer with. */
  function pricedBook(now) {
    const c = withFundSearch(book());
    c.openInvestment('add', {});
    c.invPickFund(PPFAS);                         /* NAV 89.5712 on 2026-09-11 */
    c.dlgSet({ buyDate: '2025-09-15', buyAmount: 89571.2 });   /* 1000 units */
    c.saveInvestment();
    c.api = function (url) {
      const m = url.match(/\/funds\/(\d+)$/);
      if (m) {
        if (now === 'fail') return Promise.reject(new Error('down'));
        if (now === 'zero') return Promise.resolve({ fund: { schemeCode: m[1], nav: 0, navDate: '' } });
        return Promise.resolve({ fund: Object.assign({ schemeCode: m[1] }, now) });
      }
      return Promise.resolve({});
    };
    return { c, inv: c.state.db.investments[0] };
  }

  console.log('\nA holding priced when it was added shows no gain until the price moves');
  {
    const { c, inv } = pricedBook();
    const st = c.invState(c.inv(inv.id));
    ok('1000 units were bought', Math.abs(st.units - 1000) < 0.01, String(st.units));
    ok('and at the price it was bought at there is no gain', Math.abs(st.gain) < 1,
      String(st.gain));
    ok('the stored price is the one from the day it was added',
      +c.inv(inv.id).currentNav === 89.5712, String(c.inv(inv.id).currentNav));
  }

  console.log('\nRefreshing prices brings gain, return and XIRR to the new valuation');
  {
    const { c, inv } = pricedBook({ nav: 100, navDate: '2026-09-15' });
    await c.refreshInvestmentNavs();

    const got = c.inv(inv.id);
    ok('the holding takes the new price', +got.currentNav === 100, String(got.currentNav));
    ok('and the date that price is from', got.navDate === '2026-09-15', got.navDate);

    const st = c.invState(got);
    ok('the value follows the price', Math.abs(st.value - 100000) < 1, String(st.value));
    ok('the gain appears', Math.abs(st.gain - 10428.8) < 1, String(st.gain));
    ok('and the return with it', st.returnPct > 11 && st.returnPct < 12, String(st.returnPct));
    ok('XIRR is now computable', st.xirr !== null, String(st.xirr));
    ok('and is about 11.6% over the year held',
      st.xirr > 11 && st.xirr < 12.5, String(st.xirr));
    ok('nothing was bought or sold to make that happen',
      c.state.db.txns.length === 1 && c.state.db.invTxns.length === 1);
  }

  console.log('\nThe closing flow is dated today, not the day of the last purchase');
  {
    const { c, inv } = pricedBook({ nav: 100, navDate: '2026-09-15' });
    await c.refreshInvestmentNavs();
    const flows = mmFlows(c.invTxnsFor(inv.id), c.invValue(c.inv(inv.id)));
    ok('there are two flows: the purchase and the valuation', flows.length === 2,
      String(flows.length));
    ok('the first is money going out', flows[0].amount < 0, String(flows[0].amount));
    ok('on the day it was bought', flows[0].date === '2025-09-15', flows[0].date);
    ok('the last is the value coming back', flows[1].amount > 0, String(flows[1].amount));
    ok('dated TODAY, which is what makes the rate an as-at-today rate',
      flows[1].date === mmIsoOf(new Date()), flows[1].date);

    /* The same holding valued as at an earlier date gives a different, higher
       rate — proof the date is doing real work rather than being decorative. */
    const early = mmXirrOf(mmFlows(c.invTxnsFor(inv.id), 100000, '2026-03-15'));
    const now = mmXirrOf(mmFlows(c.invTxnsFor(inv.id), 100000));
    ok('a shorter holding period gives a higher annualised rate', early > now,
      early + ' vs ' + now);
  }

  console.log('\nAn unchanged price does not churn the book');
  {
    const { c, inv } = pricedBook({ nav: 89.5712, navDate: '2026-09-11' });
    const revBefore = c.rev;
    await c.refreshInvestmentNavs();
    ok('nothing was written when the price had not moved', c.rev === revBefore,
      c.rev + ' vs ' + revBefore);
    ok('and the price is untouched', +c.inv(inv.id).currentNav === 89.5712);
  }

  console.log('\nA failed price fetch changes nothing at all');
  {
    for (const mode of ['fail', 'zero']) {
      const { c, inv } = pricedBook(mode);
      const revBefore = c.rev;
      await c.refreshInvestmentNavs();
      ok('a "' + mode + '" reply leaves the price alone',
        +c.inv(inv.id).currentNav === 89.5712, String(c.inv(inv.id).currentNav));
      ok('and its date alone', c.inv(inv.id).navDate === '2026-09-11',
        c.inv(inv.id).navDate);
      ok('and writes nothing', c.rev === revBefore, c.rev + ' vs ' + revBefore);
      ok('the refresh stops running', c.state.navBusy === false);
    }
  }

  console.log('\nPrices refresh themselves, once, when the tab is opened');
  {
    const { c } = pricedBook({ nav: 100, navDate: '2026-09-15' });
    let calls = 0;
    const under = c.api;
    c.api = function (u) { if (/\/funds\/\d+$/.test(u)) calls++; return under(u); };

    c.state.tab = 'Ledger';
    c.maybeRefreshNavs();
    ok('nothing happens on another tab', calls === 0, String(calls));

    c.state.tab = 'Investments';
    c.maybeRefreshNavs();
    await new Promise((r) => setTimeout(r, 0));
    ok('opening Investments fetches the price', calls === 1, String(calls));
    ok('and it landed', +c.state.db.investments[0].currentNav === 100,
      String(c.state.db.investments[0].currentNav));

    c.maybeRefreshNavs();
    c.maybeRefreshNavs();
    await new Promise((r) => setTimeout(r, 0));
    ok('it does not fetch again and again while you use the tab', calls === 1,
      String(calls));

    /* The case that matters most. NAV is a working-day figure, so on a Monday
       the newest published NAV is Friday's and stays older than today no
       matter how many times it is fetched. Without a once-a-session guard
       every single render would fire another request, forever. */
    const fri = pricedBook({ nav: 100, navDate: '2026-09-11' });
    let n = 0;
    const u = fri.c.api;
    fri.c.api = function (url) { if (/\/funds\/\d+$/.test(url)) n++; return u(url); };
    fri.c.state.tab = 'Investments';
    for (let i = 0; i < 6; i++) {
      fri.c.maybeRefreshNavs();
      await new Promise((r) => setTimeout(r, 0));
    }
    ok('a NAV that stays older than today is still only fetched once', n === 1,
      n + ' requests for a price that can never be dated today');
    ok('and it did take the price it was given',
      +fri.c.state.db.investments[0].currentNav === 100,
      String(fri.c.state.db.investments[0].currentNav));

    /* Same again when the fetch fails: a failure must not become a retry loop. */
    const bad = pricedBook('fail');
    let nb = 0;
    const ub = bad.c.api;
    bad.c.api = function (url) { if (/\/funds\/\d+$/.test(url)) nb++; return ub(url); };
    bad.c.state.tab = 'Investments';
    for (let i = 0; i < 6; i++) {
      bad.c.maybeRefreshNavs();
      await new Promise((r) => setTimeout(r, 0));
    }
    ok('a failed fetch is not retried on every render either', nb === 1,
      nb + ' requests after one failure');

    /* Already current: no request at all. */
    const b = pricedBook({ nav: 100, navDate: '2026-09-15' });
    let calls2 = 0;
    const under2 = b.c.api;
    b.c.api = function (u) { if (/\/funds\/\d+$/.test(u)) calls2++; return under2(u); };
    b.c.mutate((db) => { db.investments[0].navDate = mmIsoOf(new Date()); });
    b.c.state.tab = 'Investments';
    b.c.maybeRefreshNavs();
    await new Promise((r) => setTimeout(r, 0));
    ok('a price already dated today is not fetched again', calls2 === 0, String(calls2));

    /* Locked or signed out: never. */
    const l = pricedBook({ nav: 100, navDate: '2026-09-15' });
    let calls3 = 0;
    const under3 = l.c.api;
    l.c.api = function (u) { if (/\/funds\/\d+$/.test(u)) calls3++; return under3(u); };
    l.c.state.tab = 'Investments';
    l.c.setState({ locked: true });
    l.c.maybeRefreshNavs();
    await new Promise((r) => setTimeout(r, 0));
    ok('nothing is fetched behind the lock screen', calls3 === 0, String(calls3));
  }

  console.log('\nThe screen says what date the figures stand at');
  {
    const { c } = pricedBook({ nav: 100, navDate: '2026-09-15' });
    await c.refreshInvestmentNavs();
    c.state.tab = 'Investments';
    const v = c.investVals(c.balances());

    const find = (label) => v.panels.filter((p) => p.label === label)[0];
    ok('the value says which NAV it is at', /NAV of/.test(find('Current value').note),
      find('Current value').note);
    ok('naming the day', /15 Sep|15-09-2026|Sep 2026/i.test(find('Current value').note),
      find('Current value').note);
    ok('the gain says the same', /NAV of/.test(find('Gain / loss').note),
      find('Gain / loss').note);
    ok('and the return', /NAV of/.test(find('Overall return').note),
      find('Overall return').note);
    ok('XIRR says it is annualised to today, which is a different date',
      /annualised to/.test(find('XIRR').note), find('XIRR').note);
    ok('there is a Refresh prices button', /Refresh prices/.test(JSON.stringify(v.tableTools)));
    ok('the note explains it updates itself',
      /brought up to date on their own/.test(v.tableNote), v.tableNote);
    ok('and that NAV is daily, not live', /not a live price/.test(v.tableNote), v.tableNote);
    ok('no note shows NaN or undefined',
      v.panels.every((p) => !/NaN|undefined|Invalid/.test(String(p.note))),
      JSON.stringify(v.panels.map((p) => p.note)));
  }

  console.log('\nA stale price is called stale');
  {
    const { c } = pricedBook({ nav: 100, navDate: '2026-06-01' });
    await c.refreshInvestmentNavs();
    c.state.tab = 'Investments';
    const v = c.investVals(c.balances());
    ok('the note says the price is more than a week old',
      /more than a week old/.test(v.tableNote), v.tableNote);
    ok('and the Refresh button is highlighted',
      v.tableTools.filter((b) => /Refresh prices/.test(b.label))[0].style.indexOf('cfe0f0') >= 0 ||
      /Refresh prices/.test(JSON.stringify(v.tableTools)),
      JSON.stringify(v.tableTools.map((b) => b.label)));
  }

  console.log('\nHand-priced and unpriced holdings are described, not hidden');
  {
    const c = book();
    c.mutate((db) => {
      db.investments = [
        { id: 'm1', name: 'HDFC FD', type: 'Fixed Deposit', accountId: 'mf',
          currentValue: 106000, status: 'active', createdAt: 1, updatedAt: 1 },
        { id: 'u1', name: 'Something new', type: 'Lump Sum', accountId: 'mf',
          currentNav: 0, currentValue: 0, status: 'active', createdAt: 1, updatedAt: 1 }
      ];
    });
    const asOf = c.invPricedAsOf();
    ok('the hand-priced one is counted', asOf.manual === 1, String(asOf.manual));
    ok('the unpriced one too', asOf.unpriced === 1, String(asOf.unpriced));
    ok('and neither is counted as linked', asOf.linked === 0, String(asOf.linked));

    c.state.tab = 'Investments';
    const v = c.investVals(c.balances());
    ok('the note says how many you priced yourself',
      /1 holding\(s\) are valued at what you entered/.test(v.tableNote), v.tableNote);
    ok('and how many have no price at all',
      /1 have no price yet and are shown at cost/.test(v.tableNote), v.tableNote);
    ok('the panels say prices came from you, not a NAV',
      /prices you entered/.test(v.panels[1].note), v.panels[1].note);
  }

  console.log('\nRefreshing touches only what it should');
  {
    const { c, inv } = pricedBook({ nav: 100, navDate: '2026-09-15' });
    c.mutate((db) => {
      db.investments.push(
        { id: 'sold', name: 'Sold up', type: 'Lump Sum', accountId: inv.accountId,
          schemeCode: '122639', currentNav: 50, navDate: '2025-01-01', status: 'sold',
          createdAt: 1, updatedAt: 1 },
        { id: 'manual', name: 'By hand', type: 'Fixed Deposit', accountId: inv.accountId,
          schemeCode: '', currentValue: 5000, status: 'active', createdAt: 1, updatedAt: 1 });
    });
    await c.refreshInvestmentNavs();
    ok('the open linked holding is updated', +c.inv(inv.id).currentNav === 100);
    ok('a sold holding is left as it was', +c.inv('sold').currentNav === 50,
      String(c.inv('sold').currentNav));
    ok('and an unlinked one is never touched', +c.inv('manual').currentValue === 5000,
      String(c.inv('manual').currentValue));
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
