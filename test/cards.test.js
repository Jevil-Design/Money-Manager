/* Credit-card billing cycles.
 *
 * Two days of the month plus today's date have to produce the right real
 * dates across month ends, year ends, February, and the days that do not
 * exist in every month. All of it is pure, so none of this needs a browser.
 *
 *   node test/cards.test.js
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

const html = fs.readFileSync(APP, 'utf8');
const src = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
global.window = { addEventListener() {}, removeEventListener() {}, indexedDB: null };
global.document = { addEventListener() {}, removeEventListener() {} };
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'Node cards test' }, configurable: true, writable: true
});

class StubLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(patch, cb) {
    Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    if (cb) cb();
  }
  forceUpdate() {}
}
const { Component, mmCardCycle, mmNiceDate, mmDaysBetween } =
  new Function('DCLogic', 'StreamableLogic', 'React',
    src + '\n;return { Component, mmCardCycle, mmNiceDate, mmDaysBetween };')(StubLogic, StubLogic, {});

/* ------------------------------------------------------------ the base case */

console.log('\nThe card from the dialog: statement 25th, due 15th');
{
  /* Mid-cycle: the 25th has not come round yet this month. */
  const c = mmCardCycle(25, 15, '2026-09-14');
  ok('the statement that closed was last month\'s', c.lastStatement === '2026-08-25', c.lastStatement);
  ok('the one before that', c.previousStatement === '2026-07-25', c.previousStatement);
  ok('the open cycle starts the day after the last statement',
    c.cycleStart === '2026-08-26', c.cycleStart);
  ok('and runs to the next statement', c.cycleEnd === '2026-09-25', c.cycleEnd);
  ok('which is 11 days away', c.daysToStatement === 11, String(c.daysToStatement));
  ok('the closed statement is due next month, on the 15th',
    c.dueDate === '2026-09-15', c.dueDate);
  ok('which is tomorrow', c.daysToDue === 1, String(c.daysToDue));
  ok('the cycle now open will be due a month later',
    c.nextDueDate === '2026-10-15', c.nextDueDate);
  ok('leaving 20 days between closing and paying', c.graceDays === 20, String(c.graceDays));
  ok('nothing was clamped', c.stmtClamped === false && c.dueClamped === false);
}

console.log('\nThe day the statement closes, and the day after');
{
  const on = mmCardCycle(25, 15, '2026-09-25');
  ok('on the 25th the statement has closed today',
    on.lastStatement === '2026-09-25', on.lastStatement);
  ok('so the new cycle starts tomorrow', on.cycleStart === '2026-09-26', on.cycleStart);
  ok('and the next statement is a month out', on.cycleEnd === '2026-10-25', on.cycleEnd);
  ok('today\'s statement is due 15 Oct', on.dueDate === '2026-10-15', on.dueDate);

  const after = mmCardCycle(25, 15, '2026-09-26');
  ok('the day after, the closed statement is still September\'s',
    after.lastStatement === '2026-09-25', after.lastStatement);
  ok('and the cycle start does not move', after.cycleStart === '2026-09-26', after.cycleStart);

  const before = mmCardCycle(25, 15, '2026-09-24');
  ok('the day before, it is still August\'s statement',
    before.lastStatement === '2026-08-25', before.lastStatement);
  ok('closing tomorrow', before.daysToStatement === 1, String(before.daysToStatement));
}

/* ------------------------------------------------------- due before / after */

console.log('\nWhere the due date lands depends on the two days');
{
  /* Due day AFTER the statement day: same month. */
  const same = mmCardCycle(5, 25, '2026-09-10');
  ok('statement 5th, due 25th — the closed statement is due the same month',
    same.lastStatement === '2026-09-05' && same.dueDate === '2026-09-25',
    same.lastStatement + ' / ' + same.dueDate);
  ok('20 days of grace', same.graceDays === 20, String(same.graceDays));

  /* Due day ON the statement day: the next month, not the same day. */
  const equal = mmCardCycle(20, 20, '2026-09-25');
  ok('statement 20th, due 20th — due the following month, not instantly',
    equal.lastStatement === '2026-09-20' && equal.dueDate === '2026-10-20',
    equal.lastStatement + ' / ' + equal.dueDate);
  ok('a full month of grace — 31, because October has 31 days', equal.graceDays === 31, String(equal.graceDays));

  /* Due day BEFORE the statement day: the next month. */
  const next = mmCardCycle(25, 5, '2026-09-26');
  ok('statement 25th, due 5th — due the following month',
    next.dueDate === '2026-10-05', next.dueDate);
  ok('11 days of grace — 6 left in October plus 5 in November', next.graceDays === 11, String(next.graceDays));
}

/* -------------------------------------------------------------- boundaries */

console.log('\nMonth ends, year ends and February');
{
  const jan = mmCardCycle(25, 15, '2027-01-03');
  ok('early January looks back to December',
    jan.lastStatement === '2026-12-25', jan.lastStatement);
  ok('and back to November before that',
    jan.previousStatement === '2026-11-25', jan.previousStatement);
  ok('the open cycle ends in January', jan.cycleEnd === '2027-01-25', jan.cycleEnd);
  ok('the December statement is due in January',
    jan.dueDate === '2027-01-15', jan.dueDate);

  const dec = mmCardCycle(25, 15, '2026-12-26');
  ok('late December rolls the next statement into January',
    dec.cycleEnd === '2027-01-25', dec.cycleEnd);
  ok('and its due date into the new year', dec.nextDueDate === '2027-02-15', dec.nextDueDate);

  const feb = mmCardCycle(28, 15, '2026-03-01');
  ok('a 28th statement works in February', feb.lastStatement === '2026-02-28', feb.lastStatement);
  ok('and the cycle starts 1 March', feb.cycleStart === '2026-03-01', feb.cycleStart);

  const leap = mmCardCycle(28, 15, '2028-03-01');
  ok('including in a leap year', leap.lastStatement === '2028-02-28', leap.lastStatement);

  const first = mmCardCycle(1, 20, '2026-09-14');
  ok('a 1st-of-the-month statement', first.lastStatement === '2026-09-01', first.lastStatement);
  ok('with the cycle starting on the 2nd', first.cycleStart === '2026-09-02', first.cycleStart);
  ok('and due on the 20th', first.dueDate === '2026-09-20', first.dueDate);
}

/* ---------------------------------------------------------------- clamping */

console.log('\nDays that do not exist in every month');
{
  const c = mmCardCycle(31, 30, '2026-09-14');
  ok('the 31st is pulled back to the 28th', c.stmtDay === 28, String(c.stmtDay));
  ok('and the 30th too', c.dueDay === 28, String(c.dueDay));
  ok('both are reported as changed', c.stmtClamped === true && c.dueClamped === true);
  ok('the dates that result are real', /^\d{4}-\d{2}-28$/.test(c.lastStatement), c.lastStatement);

  const zero = mmCardCycle(0, 0, '2026-09-14');
  ok('day zero becomes the 1st', zero.stmtDay === 1 && zero.dueDay === 1);
  ok('and is reported as changed', zero.stmtClamped === true);

  const neg = mmCardCycle(-5, 99, '2026-09-14');
  ok('nonsense is clamped into range', neg.stmtDay === 1 && neg.dueDay === 28,
    neg.stmtDay + '/' + neg.dueDay);

  const blank = mmCardCycle('', '', '2026-09-14');
  ok('blank falls back to the usual 25th and 15th',
    blank.stmtDay === 25 && blank.dueDay === 15, blank.stmtDay + '/' + blank.dueDay);
  ok('and blank is NOT reported as clamped — nothing was changed',
    blank.stmtClamped === false && blank.dueClamped === false);

  const text = mmCardCycle('abc', null, '2026-09-14');
  ok('so does unparseable input', text.stmtDay === 25 && text.dueDay === 15);
}

/* --------------------------------------------------------- internal agreement */

console.log('\nEvery cycle it produces is internally consistent');
{
  let bad = [];
  for (let sd = 1; sd <= 28; sd++) {
    for (let dd = 1; dd <= 28; dd += 3) {
      for (const today of ['2026-01-01', '2026-02-15', '2026-02-28', '2026-06-30',
        '2026-09-14', '2026-12-31', '2027-03-01']) {
        const c = mmCardCycle(sd, dd, today);
        if (!(c.previousStatement < c.lastStatement && c.lastStatement < c.cycleEnd)) {
          bad.push('order ' + sd + '/' + dd + '@' + today); continue;
        }
        if (!(c.lastStatement <= today && today < c.cycleEnd)) {
          bad.push('today outside cycle ' + sd + '/' + dd + '@' + today); continue;
        }
        if (c.cycleStart <= c.lastStatement) {
          bad.push('cycle starts too early ' + sd + '/' + dd + '@' + today); continue;
        }
        if (!(c.dueDate > c.lastStatement && c.nextDueDate > c.cycleEnd)) {
          bad.push('due before statement ' + sd + '/' + dd + '@' + today); continue;
        }
        if (c.graceDays < 1 || c.graceDays > 62) {
          bad.push('odd grace ' + c.graceDays + ' ' + sd + '/' + dd + '@' + today); continue;
        }
        if (c.daysToStatement < 1 || c.daysToStatement > 31) {
          bad.push('odd countdown ' + c.daysToStatement + ' ' + sd + '/' + dd + '@' + today);
        }
      }
    }
  }
  ok('across every statement/due day and seven dates, nothing contradicts itself',
    bad.length === 0, bad.slice(0, 4).join(' | ') + (bad.length > 4 ? ' …+' + (bad.length - 4) : ''));
}

/* ------------------------------------------- the saved card uses the same maths */

console.log('\nA saved card agrees with what the dialog previewed');
{
  const c = new Component({});
  c.state.db.accounts = [{
    id: 'card1', name: 'Card', type: 'credit', opening: 0, currency: 'INR',
    limit: 100000, stmtDay: 25, dueDay: 15, minPct: 5, rate: 42,
    archived: false, createdAt: 1, updatedAt: 1
  }];
  c.state.db.txns = [];
  const preview = mmCardCycle(25, 15, '2026-09-14');
  const saved = c.cardState(c.state.db.accounts[0], '2026-09-14');
  ok('the statement date matches', saved.lastStatement === preview.lastStatement,
    saved.lastStatement + ' vs ' + preview.lastStatement);
  ok('the previous statement matches', saved.previousStatement === preview.previousStatement);
  ok('the due date matches', saved.dueDate === preview.dueDate,
    saved.dueDate + ' vs ' + preview.dueDate);

  /* And the maths it feeds still classifies spending correctly. */
  c.state.db.txns = [
    /* Inside the closed statement. */
    { id: 't1', date: '2026-08-10', type: 'expense', accountId: 'card1', toAccountId: '',
      amount: 5000, contents: 'Billed spend', categoryId: '', tags: [] },
    /* After it closed — next statement, not this one. */
    { id: 't2', date: '2026-09-10', type: 'expense', accountId: 'card1', toAccountId: '',
      amount: 2000, contents: 'Unbilled spend', categoryId: '', tags: [] }
  ];
  c.bumpRev();
  const s2 = c.cardState(c.state.db.accounts[0], '2026-09-14');
  ok('spending after the statement closed is unbilled', s2.unbilled === 2000, String(s2.unbilled));
  ok('and only the earlier spend is payable now',
    s2.statementBalance === 5000, String(s2.statementBalance));
  ok('the total owed is both', s2.owed === 7000, String(s2.owed));
  ok('the minimum due is 5% of the statement, floored at 100',
    s2.minDue === 250, String(s2.minDue));

  /* A payment after the statement closed settles it rather than looking
     like next month's problem. */
  c.state.db.txns.push({
    id: 't3', date: '2026-09-12', type: 'transfer', accountId: 'bank', toAccountId: 'card1',
    amount: 5000, contents: 'Paid the bill', categoryId: '', tags: []
  });
  c.bumpRev();
  const s3 = c.cardState(c.state.db.accounts[0], '2026-09-14');
  ok('paying after closing clears the statement, not next month',
    s3.statementBalance === 0, String(s3.statementBalance));
  ok('while the unbilled spend still stands', s3.unbilled === 2000, String(s3.unbilled));
  ok('and nothing is due', s3.minDue === 0, String(s3.minDue));
}

/* --------------------------------------------------------------- formatting */

console.log('\nThe dates read as prose');
{
  ok('25 Sep 2026', mmNiceDate('2026-09-25') === '25 Sep 2026', mmNiceDate('2026-09-25'));
  ok('a single-digit day loses its zero', mmNiceDate('2026-01-05') === '5 Jan 2026',
    mmNiceDate('2026-01-05'));
  ok('December', mmNiceDate('2026-12-31') === '31 Dec 2026', mmNiceDate('2026-12-31'));
  ok('nonsense is passed through', mmNiceDate('not-a-date') === 'not-a-date');
  ok('empty stays empty', mmNiceDate('') === '' && mmNiceDate(null) === '');
  ok('days between two dates', mmDaysBetween('2026-09-14', '2026-09-25') === 11,
    String(mmDaysBetween('2026-09-14', '2026-09-25')));
  ok('and it survives a month end', mmDaysBetween('2026-08-26', '2026-09-25') === 30,
    String(mmDaysBetween('2026-08-26', '2026-09-25')));
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
