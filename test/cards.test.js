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
const { Component, mmCardCycle, mmCycleFromDates, mmNiceDate, mmDaysBetween, mmOrdinal } =
  new Function('DCLogic', 'StreamableLogic', 'React',
    src + '\n;return { Component, mmCardCycle, mmCycleFromDates, mmNiceDate, ' +
    'mmDaysBetween, mmOrdinal };')(StubLogic, StubLogic, {});

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

/* ------------------------------------------------- set up from real dates */

console.log('\nThe two dates off a statement become the recurring rule');
{
  const d = mmCycleFromDates('2026-09-25', '2026-10-15');
  ok('the statement day comes from the statement date', d.stmtDay === 25, String(d.stmtDay));
  ok('the due day comes from the due date', d.dueDay === 15, String(d.dueDay));
  ok('and the payment is in the following month', d.dueNextMonth === true);
  ok('20 days apart', d.gapDays === 20, String(d.gapDays));
  ok('one month apart', d.monthsApart === 1, String(d.monthsApart));
}
{
  /* Same month: closes on the 5th, due on the 25th. */
  const d = mmCycleFromDates('2026-09-05', '2026-09-25');
  ok('a same-month due date is recorded as such', d.dueNextMonth === false);
  ok('with the right days', d.stmtDay === 5 && d.dueDay === 25);
}
{
  /* THE case two day numbers cannot express: the due day is AFTER the
     statement day, but in the NEXT month. Inferring from the numbers alone
     puts this bill a month early. */
  const d = mmCycleFromDates('2026-09-02', '2026-10-22');
  ok('statement 2nd, due 22nd of the NEXT month is captured', d.dueNextMonth === true,
    String(d.dueNextMonth));
  const told = mmCardCycle(d.stmtDay, d.dueDay, '2026-09-10', d.dueNextMonth);
  ok('the cycle honours it — due in October', told.dueDate === '2026-10-22', told.dueDate);
  const guessed = mmCardCycle(d.stmtDay, d.dueDay, '2026-09-10');
  ok('while guessing from the numbers alone would have said September',
    guessed.dueDate === '2026-09-22', guessed.dueDate);
  ok('which is the month of error the dates remove',
    told.dueDate !== guessed.dueDate);
}
{
  /* Dates the wrong way round, and incomplete input. */
  ok('a due date before the statement is rejected',
    mmCycleFromDates('2026-09-25', '2026-09-20') === null);
  ok('a missing statement date is rejected', mmCycleFromDates('', '2026-10-15') === null);
  ok('a missing due date is rejected', mmCycleFromDates('2026-09-25', '') === null);
  ok('rubbish is rejected', mmCycleFromDates('not-a-date', 'nor-this') === null);
  ok('null is rejected', mmCycleFromDates(null, null) === null);
  ok('the same day for both is allowed — some cards do close and fall due together',
    mmCycleFromDates('2026-09-25', '2026-09-25') !== null);
}
{
  /* A statement on the 31st still has to become a day that exists. */
  const d = mmCycleFromDates('2026-01-31', '2026-02-20');
  ok('the 31st is reported raw so the dialog can explain it', d.stmtDayRaw === 31,
    String(d.stmtDayRaw));
  ok('but the stored day is pulled back to 28', d.stmtDay === 28, String(d.stmtDay));
  ok('and the cycle it produces is a real date',
    /^\d{4}-\d{2}-28$/.test(mmCardCycle(d.stmtDay, d.dueDay, '2026-03-05', d.dueNextMonth).lastStatement));
}

console.log('\nA card set up from dates behaves that way once saved');
{
  const c = new Component({});
  c.state.db.accounts = [];
  c.state.db.txns = [];
  /* Exactly what the dialog holds while being filled in. */
  c.state.dlg = {
    kind: 'account', mode: 'add',
    data: {
      id: '', name: 'Test Card', type: 'credit', opening: 0, currency: 'INR', color: '#2b5f96',
      limit: 100000, stmtDay: 25, dueDay: 15, dueNextMonth: true,
      stmtRefDate: '2026-09-02', dueRefDate: '2026-10-22',
      minPct: 5, rate: 42, annualFee: 0, lateFee: 0,
      institution: '', number: '', notes: '', archived: false
    }
  };
  c.saveAccount();
  const saved = c.state.db.accounts[0];
  ok('the card was created', !!saved, String(c.state.db.accounts.length));
  ok('the statement day was derived from the date', saved.stmtDay === 2, String(saved.stmtDay));
  ok('the due day was derived from the date', saved.dueDay === 22, String(saved.dueDay));
  ok('and the month offset was taken from the dates, not guessed',
    saved.dueNextMonth === true, String(saved.dueNextMonth));
  ok('the dates are kept so the dialog can show them again',
    saved.stmtRefDate === '2026-09-02' && saved.dueRefDate === '2026-10-22');

  const cs = c.cardState(saved, '2026-09-10');
  ok('the saved card bills on the 2nd', cs.lastStatement === '2026-09-02', cs.lastStatement);
  ok('and falls due on 22 October, a month later', cs.dueDate === '2026-10-22', cs.dueDate);
}
{
  /* Dates the wrong way round must not be saved. */
  const c = new Component({});
  c.state.db.accounts = [];
  c.state.dlg = {
    kind: 'account', mode: 'add',
    data: {
      id: '', name: 'Bad Card', type: 'credit', opening: 0, currency: 'INR', color: '#2b5f96',
      limit: 0, stmtDay: 25, dueDay: 15, stmtRefDate: '2026-09-25', dueRefDate: '2026-09-20',
      minPct: 5, rate: 42, annualFee: 0, lateFee: 0,
      institution: '', number: '', notes: '', archived: false
    }
  };
  c.saveAccount();
  ok('a due date before the statement date is refused', c.state.db.accounts.length === 0,
    String(c.state.db.accounts.length));
  ok('and the dialog stays open to be corrected', !!c.state.dlg);

  /* One date without the other is ambiguous, so it is refused too. */
  c.state.dlg.data.dueRefDate = '';
  c.saveAccount();
  ok('one date without the other is refused', c.state.db.accounts.length === 0);
}
{
  /* No dates at all: the day numbers still work, exactly as before. */
  const c = new Component({});
  c.state.db.accounts = [];
  c.state.dlg = {
    kind: 'account', mode: 'add',
    data: {
      id: '', name: 'Plain Card', type: 'credit', opening: 0, currency: 'INR', color: '#2b5f96',
      limit: 0, stmtDay: 18, dueDay: 8, stmtRefDate: '', dueRefDate: '',
      minPct: 5, rate: 42, annualFee: 0, lateFee: 0,
      institution: '', number: '', notes: '', archived: false
    }
  };
  c.saveAccount();
  const saved = c.state.db.accounts[0];
  ok('a card with no dates still saves', !!saved);
  ok('keeping the days as entered', saved.stmtDay === 18 && saved.dueDay === 8,
    saved.stmtDay + '/' + saved.dueDay);
  ok('with the month offset filled in by the old inference',
    saved.dueNextMonth === true, String(saved.dueNextMonth));
}

console.log('\nA card set up before this existed is not disturbed');
{
  const c = new Component({});
  /* No dueNextMonth, no ref dates — the shape an older card has. */
  const old = {
    id: 'old1', name: 'Old Card', type: 'credit', opening: -5000, currency: 'INR',
    limit: 50000, stmtDay: 25, dueDay: 15, minPct: 5, rate: 42,
    archived: false, createdAt: 1, updatedAt: 1
  };
  const before = c.cardStateAt(Object.assign({}, old), '2026-09-14');
  c.state.db.accounts = [old];
  c.state.db.txns = [];
  const db = c.migrate({ accounts: [Object.assign({}, old)], txns: [], schemaVersion: 5 });
  const migrated = db.accounts[0];
  ok('the migration fills in the month offset', migrated.dueNextMonth === true,
    String(migrated.dueNextMonth));
  ok('and leaves the days alone', migrated.stmtDay === 25 && migrated.dueDay === 15);
  ok('the ref dates start empty', migrated.stmtRefDate === '' && migrated.dueRefDate === '');
  c.state.db.accounts = [migrated];
  c.bumpRev();
  const after = c.cardStateAt(migrated, '2026-09-14');
  ok('and the cycle is identical to before the change',
    after.lastStatement === before.lastStatement && after.dueDate === before.dueDate,
    after.dueDate + ' vs ' + before.dueDate);
}

console.log('\nOrdinals read correctly');
{
  ok('1st, 2nd, 3rd', mmOrdinal(1) === '1st' && mmOrdinal(2) === '2nd' && mmOrdinal(3) === '3rd');
  ok('4th and 5th', mmOrdinal(4) === '4th' && mmOrdinal(5) === '5th');
  ok('the teens are all th', mmOrdinal(11) === '11th' && mmOrdinal(12) === '12th' && mmOrdinal(13) === '13th');
  ok('21st, 22nd, 23rd', mmOrdinal(21) === '21st' && mmOrdinal(22) === '22nd' && mmOrdinal(23) === '23rd');
  ok('28th', mmOrdinal(28) === '28th');
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
