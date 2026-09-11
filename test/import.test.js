/* Statement import: reading a PDF, spreadsheet or CSV from a bank.
 *
 * Every check here fails against the code as it was, so each one names a real
 * defect rather than describing what the parser happened to do. The heavy
 * libraries (XLSX, pdf.js) are stubbed with the shapes they actually return,
 * so this needs no CDN and no fixture files.
 *
 *   node test/import.test.js
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

/* ------------------------------------------------------------ the app logic */

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
/* Node defines navigator as a getter-only global, so a plain assignment
   throws under 'use strict' (it fails silently without it). */
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'Node import test' }, configurable: true, writable: true
});

class StubLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  /* mutate() passes a function updater, which is how every write to the book
     goes through — a stub that only handled the object form left the database
     silently unchanged. */
  setState(patch, cb) {
    Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    if (cb) cb();
  }
  forceUpdate() {}
}
const { Component } = new Function('DCLogic', 'StreamableLogic', 'React',
  src + '\n;return { Component };')(StubLogic, StubLogic, {});

/* A component with an empty book and one account to import into. */
function app() {
  const c = new Component({});
  c.state.db.accounts = [{
    id: 'acc1', name: 'Bank Account', type: 'bank', opening: 0, currency: 'INR',
    archived: false, createdAt: 1, updatedAt: 1
  }];
  c.state.db.txns = [];
  c.state.auth.phase = 'ready';
  return c;
}

/* Run a header + rows grid through the real mapping and classification. */
function importGrid(headers, rows, extra) {
  const c = app();
  c.state.imp = Object.assign({
    step: 2, headers, rows, map: c.autoMap(headers),
    name: 'test.csv', source: 'csv', acctId: 'acc1', autoCat: false
  }, extra || {});
  return { app: c, map: c.state.imp.map, analysis: c.impAnalysis() };
}

/* ------------------------------------------------------------------- dates */

console.log('\nDates a bank actually writes');
{
  const c = app();
  const cases = [
    ['2026-09-03', '2026-09-03', 'ISO'],
    ['03/09/2026', '2026-09-03', 'dd/mm/yyyy'],
    ['03-09-2026', '2026-09-03', 'dd-mm-yyyy'],
    ['3.9.2026', '2026-09-03', 'd.m.yyyy'],
    ['03/09/26', '2026-09-03', 'two-digit year'],
    ['15-Jan-2026', '2026-01-15', 'dd-Mon-yyyy'],
    ['15 Jan 2026', '2026-01-15', 'dd Mon yyyy'],
    ['15 January 2026', '2026-01-15', 'full month name'],
    ['Jan 15, 2026', '2026-01-15', 'Mon dd, yyyy'],
    ['2026-9-3', '2026-09-03', 'unpadded ISO'],
    ['03/09/2026 14:32:01', '2026-09-03', 'date with a time on it'],
    ['2026-09-03 14:32', '2026-09-03', 'ISO with a time on it']
  ];
  cases.forEach(([input, want, what]) => {
    ok(what + ' — "' + input + '"', c.normDate(input) === want, c.normDate(input));
  });

  /* The one that broke every spreadsheet import. A date cell is stored as a
     serial and every cell is stringified on the way out of the sheet, so the
     old numeric-only check could never fire and the date became "45678". */
  ok('an Excel serial as a NUMBER', c.normDate(45678) === '2025-01-21', c.normDate(45678));
  ok('an Excel serial as a STRING (the regression)',
    c.normDate('45678') === '2025-01-21', c.normDate('45678'));
  ok('a real Date object, from cellDates',
    c.normDate(new Date(2026, 8, 3)) === '2026-09-03', c.normDate(new Date(2026, 8, 3)));
  ok('an invalid Date is empty, not "Invalid Date"',
    c.normDate(new Date('nope')) === '', JSON.stringify(c.normDate(new Date('nope'))));

  /* mm/dd/yyyy used to produce month 15 and the row was discarded. */
  ok('03/15/2026 is read as March 15, not month 15',
    c.normDate('03/15/2026') === '2026-03-15', c.normDate('03/15/2026'));
  ok('but 03/09/2026 stays dd/mm — the Indian convention',
    c.normDate('03/09/2026') === '2026-09-03', c.normDate('03/09/2026'));

  /* Things that are not dates must not become them. */
  ok('an amount is not mistaken for a serial', c.normDate('1234.56') === '1234.56');
  ok('a four-digit year alone is not a serial', c.normDate('2026') === '2026');
  ok('a six-digit number is not a serial', c.normDate('123456') === '123456');
  ok('empty stays empty', c.normDate('') === '' && c.normDate(null) === '');
}

/* ----------------------------------------------------------------- amounts */

console.log('\nAmounts a bank actually writes');
{
  const c = app();
  const cases = [
    ['1234.56', 1234.56, 'plain'],
    ['1,234.56', 1234.56, 'thousands separator'],
    ['1,23,456.78', 123456.78, 'Indian grouping'],
    ['₹ 1,234.56', 1234.56, 'rupee sign and a space'],
    ['-1,234.56', -1234.56, 'negative'],
    ['(1,234.56)', -1234.56, 'accounting parentheses'],
    ['1,234.56 Dr', -1234.56, 'trailing Dr'],
    ['1.234,56', 1234.56, 'European separators'],
    ['1200', 1200, 'whole rupees'],
    ['', 0, 'blank'],
    ['   ', 0, 'whitespace'],
    ['n/a', 0, 'not a number']
  ];
  cases.forEach(([input, want, what]) => {
    const got = c.impAmount(input);
    ok(what + ' — "' + input + '"', Math.abs(got - want) < 0.005, String(got));
  });
  ok('a number passes through', c.impAmount(1234.56) === 1234.56);
  ok('the sign is kept, not discarded', c.impAmount('-500') === -500);
}

/* -------------------------------------------------------- the direction bug */

console.log('\nWhich way the money went');
{
  /* Separate debit and credit columns: unambiguous, and already worked. */
  const r = importGrid(
    ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance'],
    [
      ['01/09/2026', 'Salary', '', '45000.00', '45000.00'],
      ['02/09/2026', 'Rent', '18000.00', '', '27000.00']
    ]);
  const byDesc = {};
  r.analysis.all.forEach((p) => { byDesc[p.contents] = p; });
  ok('a deposit column is income', byDesc.Salary.type === 'income', byDesc.Salary.type);
  ok('a withdrawal column is expense', byDesc.Rent.type === 'expense', byDesc.Rent.type);
  ok('both amounts are positive', byDesc.Salary.amount === 45000 && byDesc.Rent.amount === 18000);
  ok('both rows are importable', r.analysis.ok.length === 2, String(r.analysis.ok.length));
}
{
  /* ONE signed Amount column and no type column. This is the bug: every row,
     salary included, used to be classified as an expense. */
  const r = importGrid(
    ['Date', 'Description', 'Amount'],
    [
      ['01/09/2026', 'Salary credit', '45000.00'],
      ['02/09/2026', 'Rent paid', '-18000.00'],
      ['03/09/2026', 'Groceries', '-2500.00']
    ]);
  const t = {};
  r.analysis.all.forEach((p) => { t[p.contents] = p; });
  ok('a negative amount is an expense', t['Rent paid'].type === 'expense', t['Rent paid'].type);
  ok('a POSITIVE amount is income, not an expense (the bug)',
    t['Salary credit'].type === 'income', t['Salary credit'].type);
  ok('the stored amount is unsigned', t['Rent paid'].amount === 18000, String(t['Rent paid'].amount));
  ok('all three rows are importable', r.analysis.ok.length === 3, String(r.analysis.ok.length));
}
{
  /* An all-positive Amount column says nothing about direction. Guessing
     "income" there would invent income out of nothing, so the safe default
     for a bank statement stands. */
  const r = importGrid(
    ['Date', 'Description', 'Amount'],
    [['01/09/2026', 'Shop', '500.00'], ['02/09/2026', 'Shop', '250.00']]);
  ok('an unsigned amount column still defaults to expense',
    r.analysis.all.every((p) => p.type === 'expense'),
    r.analysis.all.map((p) => p.type).join(','));
}
{
  /* A Dr/Cr marker column. */
  const r = importGrid(
    ['Date', 'Particulars', 'Amount', 'Dr/Cr'],
    [
      ['01/09/2026', 'Salary', '45000.00', 'CR'],
      ['02/09/2026', 'Rent', '18000.00', 'DR']
    ]);
  const t = {};
  r.analysis.all.forEach((p) => { t[p.contents] = p; });
  ok('CR is income', t.Salary.type === 'income', t.Salary.type);
  ok('DR is expense — it used to fall through to the default',
    t.Rent.type === 'expense', t.Rent.type);
}
{
  /* No sign, no marker, but a running balance — the direction is in how the
     balance moved. The import dialog already claimed this worked. */
  const r = importGrid(
    ['Date', 'Narration', 'Amount', 'Balance'],
    [
      ['01/09/2026', 'Opening spend', '1000.00', '9000.00'],
      ['02/09/2026', 'Money in', '5000.00', '14000.00'],
      ['03/09/2026', 'Money out', '2000.00', '12000.00']
    ], { seedBalance: true });
  const t = {};
  r.analysis.all.forEach((p) => { t[p.contents] = p; });
  ok('a balance that rose by the amount is income', t['Money in'].type === 'income',
    t['Money in'].type);
  ok('a balance that fell by the amount is expense', t['Money out'].type === 'expense',
    t['Money out'].type);
}

/* ---------------------------------------------------------------- csv shape */

console.log('\nCSV delimiters');
{
  const c = app();
  ok('comma separated', c.parseCsv('a,b,c\n1,2,3')[1].join('|') === '1|2|3');
  ok('semicolon separated — everything used to land in one column',
    c.parseCsv('a;b;c\n1;2;3')[1].join('|') === '1|2|3',
    JSON.stringify(c.parseCsv('a;b;c\n1;2;3')[1]));
  ok('tab separated', c.parseCsv('a\tb\tc\n1\t2\t3')[1].join('|') === '1|2|3',
    JSON.stringify(c.parseCsv('a\tb\tc\n1\t2\t3')[1]));
  ok('pipe separated', c.parseCsv('a|b|c\n1|2|3')[1].join('~') === '1~2~3');
  ok('quoted commas inside a comma file are not split',
    c.parseCsv('a,b\n"Smith, John",2')[1][0] === 'Smith, John',
    JSON.stringify(c.parseCsv('a,b\n"Smith, John",2')[1]));
  ok('a description containing a semicolon does not change the delimiter',
    c.parseCsv('Date,Description,Amount\n01/09/2026,"Paid; urgent",500')[1].length === 3,
    JSON.stringify(c.parseCsv('Date,Description,Amount\n01/09/2026,"Paid; urgent",500')[1]));
  ok('escaped quotes survive', c.parseCsv('a\n"He said ""hi"""')[1][0] === 'He said "hi"');
  ok('a single column file still parses', c.parseCsv('only\nvalue').length === 2);
}

/* -------------------------------------------------------- spreadsheet shape */

console.log('\nSpreadsheets');

/* The shape XLSX actually hands back: a grid, with dates as Date objects once
   cellDates is on. The stub records the options it was called with. */
function stubXlsx(grid, opts) {
  const seen = {};
  global.window.XLSX = {
    read: (buf, o) => { seen.read = o; return { SheetNames: ['Sheet1'], Sheets: { Sheet1: { __grid: grid } } }; },
    utils: {
      sheet_to_json: (sheet, o) => {
        seen.toJson = o;
        return sheet.__grid.map((r) => r.map((c) => (c == null ? (o.defval !== undefined ? o.defval : '') : c)));
      }
    }
  };
  return seen;
}

{
  const c = app();
  const seen = stubXlsx([
    ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt'],
    [new Date(2026, 8, 3), 'Rent', 18000, '']
  ]);
  const out = c.parseSheet(new Uint8Array(0));
  ok('cellDates is requested, so dates arrive as dates',
    seen.read && seen.read.cellDates === true, JSON.stringify(seen.read));
  ok('a Date cell becomes an ISO string, not a serial',
    out.rows[0][0] === '2026-09-03', out.rows[0][0]);
  ok('the header row is found', out.headers[0] === 'Date' && out.headers[2] === 'Withdrawal Amt');
  ok('numbers survive as text', out.rows[0][2] === '18000', out.rows[0][2]);
}
{
  /* A real bank export: several rows of account details above the header. */
  const c = app();
  stubXlsx([
    ['STATEMENT OF ACCOUNT', '', '', ''],
    ['Account No', '1234567890', '', ''],
    ['Period', '01/09/2026 to 30/09/2026', '', ''],
    [],
    ['Txn Date', 'Particulars', 'Debit', 'Credit'],
    ['01/09/2026', 'Rent', '18000.00', '']
  ]);
  const out = c.parseSheet(new Uint8Array(0));
  ok('a title block above the header is skipped',
    out.headers[0] === 'Txn Date' && out.headers[3] === 'Credit', JSON.stringify(out.headers));
  ok('and only real rows come through', out.rows.length === 1 && out.rows[0][1] === 'Rent',
    String(out.rows.length));
}
{
  /* No header at all. Taking row 0 as the header would silently eat a
     transaction, which is worse than inventing column names. */
  const c = app();
  stubXlsx([
    ['01/09/2026', 'Rent', '18000.00'],
    ['02/09/2026', 'Salary', '45000.00']
  ]);
  const out = c.parseSheet(new Uint8Array(0));
  ok('a headerless sheet keeps every row', out.rows.length === 2, String(out.rows.length));
  ok('and gets generic column names', out.headers[0] === 'Column 1', JSON.stringify(out.headers));
  ok('no transaction was consumed as a header',
    out.rows[0][1] === 'Rent' && out.rows[1][1] === 'Salary');
}
{
  const c = app();
  stubXlsx([]);
  let threw = '';
  try { c.parseSheet(new Uint8Array(0)); } catch (e) { threw = e.message; }
  ok('an empty sheet says so plainly', /empty/i.test(threw), threw);
  ok('and does not mention a stack or a library', !/XLSX|undefined|null/.test(threw), threw);
}

/* ----------------------------------------------------------- header mapping */

console.log('\nColumn mapping');
{
  const c = app();
  const m = c.autoMap(['Txn Date', 'Narration', 'Withdrawal Amt (INR)', 'Deposit Amt (INR)',
    'Closing Balance', 'Cheque/Reference No']);
  ok('the date column is found', m.date === '0', m.date);
  ok('the description column is found', m.contents === '1', m.contents);
  ok('withdrawal maps to debit', m.debit === '2', m.debit);
  ok('deposit maps to credit', m.credit === '3', m.credit);
  ok('the balance column is found', m.balance === '4', m.balance);
  ok('the reference column is found', m.ref === '5', m.ref);
}
{
  const c = app();
  const m = c.autoMap(['Date', 'Description', 'Debit', 'Credit', 'Balance']);
  ok('plain headers map too',
    m.date === '0' && m.contents === '1' && m.debit === '2' && m.credit === '3' && m.balance === '4',
    JSON.stringify(m));
}

/* -------------------------------------------------------------------- pdfs */

console.log('\nPDF statements');

/* pdf.js hands back text fragments with a transform matrix; [4] is x and
   [5] is the baseline y. */
function stubPdf(pages) {
  global.window.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: (n) => Promise.resolve({
          getTextContent: () => Promise.resolve({
            items: pages[n - 1].map((it) => ({ str: it.s, transform: [1, 0, 0, 1, it.x, it.y] }))
          })
        })
      })
    })
  };
}

(async () => {
  {
    /* Cells on one visual row whose baselines differ by a fraction of a
       pixel. Keying on an exact rounded y split them into separate lines, and
       a row without its amount gets thrown away. */
    const c = app();
    stubPdf([[
      { s: '01/09/2026', x: 50, y: 700.0 },
      { s: 'RENT PAID', x: 150, y: 700.4 },
      { s: '18,000.00', x: 400, y: 699.6 },
      { s: '27,000.00', x: 500, y: 700.2 },

      { s: '02/09/2026', x: 50, y: 680 },
      { s: 'SALARY', x: 150, y: 680 },
      { s: '45,000.00', x: 400, y: 680 },
      { s: '72,000.00', x: 500, y: 680 }
    ]]);
    const out = await c.parsePdfStatement(new Uint8Array(0));
    ok('fragments a fraction of a pixel apart stay on one row',
      out.rows.length === 2, String(out.rows.length) + ' ' + JSON.stringify(out.rows));
    if (out.rows.length === 2) {
      ok('the date is read', out.rows[0][0] === '2026-09-01', out.rows[0][0]);
      ok('the description survives', /RENT/.test(out.rows[0][1]), out.rows[0][1]);
      ok('the amount is the second-to-last figure, not the balance',
        out.rows[0][2] === '18000', out.rows[0][2]);
      ok('the running balance tells income from expense',
        out.rows[1][3] === 'income', out.rows[1][3]);
    }
  }
  {
    /* Whole-rupee amounts with no decimal part. The old pattern required
       exactly two decimals and skipped these rows entirely. */
    const c = app();
    stubPdf([[
      { s: '01/09/2026', x: 50, y: 700 },
      { s: 'CASH DEPOSIT', x: 150, y: 700 },
      { s: '1,200', x: 400, y: 700 }
    ]]);
    const out = await c.parsePdfStatement(new Uint8Array(0));
    ok('a comma-grouped whole-rupee amount is read',
      out.rows.length === 1 && out.rows[0][2] === '1200',
      JSON.stringify(out.rows));
  }
  {
    /* A Dr/Cr marker on the line. */
    const c = app();
    stubPdf([[
      { s: '01/09/2026', x: 50, y: 700 },
      { s: 'NEFT SALARY CR', x: 150, y: 700 },
      { s: '45,000.00', x: 400, y: 700 }
    ]]);
    const out = await c.parsePdfStatement(new Uint8Array(0));
    ok('a CR marker makes it income', out.rows[0][3] === 'income', out.rows[0][3]);
    ok('and the marker is stripped from the description',
      !/\bCR\b/.test(out.rows[0][1]), out.rows[0][1]);
  }
  {
    /* Page furniture must not become transactions. */
    const c = app();
    stubPdf([[
      { s: 'Statement for 01/09/2026 to 30/09/2026', x: 50, y: 760 },
      { s: 'Page 1 of 3', x: 500, y: 20 },
      { s: '01/09/2026', x: 50, y: 700 },
      { s: 'RENT', x: 150, y: 700 },
      { s: '18,000.00', x: 400, y: 700 }
    ]]);
    const out = await c.parsePdfStatement(new Uint8Array(0));
    ok('a header line with dates but no amount is skipped',
      out.rows.length === 1, String(out.rows.length) + ' ' + JSON.stringify(out.rows));
  }
  {
    /* Several pages. */
    const c = app();
    stubPdf([
      [{ s: '01/09/2026', x: 50, y: 700 }, { s: 'A', x: 150, y: 700 }, { s: '100.00', x: 400, y: 700 }],
      [{ s: '02/09/2026', x: 50, y: 700 }, { s: 'B', x: 150, y: 700 }, { s: '200.00', x: 400, y: 700 }]
    ]);
    const out = await c.parsePdfStatement(new Uint8Array(0));
    ok('every page is read', out.rows.length === 2, String(out.rows.length));
  }
  {
    const c = app();
    global.window.pdfjsLib = null;
    let msg = '';
    await c.parsePdfStatement(new Uint8Array(0)).catch((e) => { msg = e.message; });
    ok('a missing PDF library is reported in plain words',
      /reader/i.test(msg) && /connection/i.test(msg), msg);
  }

  /* ------------------------------------------------- end to end, as imported */

  console.log('\nAn imported row obeys the accounting rules');
  {
    const r = importGrid(
      ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt'],
      [
        ['01/09/2026', 'Salary', '', '45000.00'],
        ['02/09/2026', 'Rent', '18000.00', '']
      ]);
    const c = r.app;
    c.state.imp.step = 2;
    c.runImport(false);
    const txns = c.state.db.txns;
    ok('both rows were written', txns.length === 2, String(txns.length));
    const income = txns.filter((t) => t.type === 'income');
    const expense = txns.filter((t) => t.type === 'expense');
    ok('one income and one expense', income.length === 1 && expense.length === 1,
      txns.map((t) => t.type).join(','));
    ok('every amount is positive and finite',
      txns.every((t) => t.amount > 0 && isFinite(t.amount)),
      JSON.stringify(txns.map((t) => t.amount)));
    ok('every date is an ISO day', txns.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date)),
      JSON.stringify(txns.map((t) => t.date)));
    ok('every row is scoped to the chosen account',
      txns.every((t) => t.accountId === 'acc1'));
    ok('no imported row is a transfer without a destination',
      txns.every((t) => t.type !== 'transfer' || t.toAccountId));
    ok('they carry the import id, so the batch can be undone',
      txns.every((t) => !!t.importId), JSON.stringify(txns.map((t) => t.importId)));

    /* The signed convention: income raises, expense lowers. */
    const bal = c.balances ? null : null;
    const net = txns.reduce((n, t) => n + (t.type === 'income' ? t.amount : -t.amount), 0);
    ok('net effect is 45000 - 18000', Math.abs(net - 27000) < 0.005, String(net));
  }
  {
    /* Importing the same file twice must not double the books. */
    const r = importGrid(
      ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt'],
      [['01/09/2026', 'Rent', '18000.00', '']]);
    const c = r.app;
    const grid = [['01/09/2026', 'Rent', '18000.00', '']];
    const headers = ['Date', 'Narration', 'Withdrawal Amt', 'Deposit Amt'];
    c.runImport(false);
    ok('the first import writes the row', c.state.db.txns.length === 1);

    /* runImport closes the dialog and clears imp, so uploading the same file
       again means seeding it afresh — which is exactly what a person doing it
       twice by mistake would do. */
    c.state.imp = {
      step: 2, headers, rows: grid, map: c.autoMap(headers),
      name: 'test.csv', source: 'csv', acctId: 'acc1', autoCat: false
    };
    c.bumpRev();
    const again = c.impAnalysis();
    ok('the second look sees it as already stored',
      again.dupes.length === 1 && again.ok.length === 0,
      'ok=' + again.ok.length + ' dupes=' + again.dupes.length);
    ok('and says why', /already stored/i.test(again.dupes[0].why || ''), again.dupes[0].why);
  }
  {
    /* Rows that cannot be read are reported, not silently dropped. */
    const r = importGrid(
      ['Date', 'Narration', 'Amount'],
      [
        ['not a date', 'Rubbish', '100.00'],
        ['01/09/2026', 'No amount', ''],
        ['01/09/2026', 'Fine', '100.00']
      ]);
    ok('one row is importable', r.analysis.ok.length === 1, String(r.analysis.ok.length));
    ok('two are reported as unreadable', r.analysis.invalid.length === 2,
      String(r.analysis.invalid.length));
    ok('each unreadable row says why',
      r.analysis.invalid.every((p) => !!p.why),
      JSON.stringify(r.analysis.invalid.map((p) => p.why)));
    ok('and names the row number', r.analysis.invalid.every((p) => p.row > 0));
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
