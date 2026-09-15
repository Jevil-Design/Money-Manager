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
  mmInr: mmInrOf, mmIso } =
  new Function('DCLogic', 'StreamableLogic', 'React',
    src + '\n;return { Component, MM_TABS, MM_TAB_ALIAS, mmInvGroupOf, mmInvIsUnitised, mmInvIsInflow, mmInr, mmIso };')(
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

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
