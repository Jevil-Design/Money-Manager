/* Does the markup actually render what the logic produces?
 *
 * This exists because of a bug it would have caught. The fund pickers built
 * search results as table rows with a click handler and a "Use" button, and
 * every test passed: the rows were there, the handler was there, the button
 * was there. None of it reached the screen, because the dialog table's markup
 * rendered {{ c.text }} and nothing else — no row onClick, no c.actions. You
 * could search for a fund and then had no way to choose it.
 *
 * npm test never compiles the markup (support.js does that in the browser), so
 * a value the logic produces and the template silently drops is invisible to
 * every other suite. These are the structural invariants that catch it.
 *
 *   node test/template.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'Money Manager.dc.html');
const html = fs.readFileSync(APP, 'utf8');

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || extra === undefined ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

const logic = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const markup = html.replace(/<script type="text\/x-dc"[^>]*>[\s\S]*?<\/script>/, '');

/* Every <sc-for ... as="NAME"> block, with the markup it encloses. */
function forBlocks(src, alias) {
  const out = [];
  const open = new RegExp('<sc-for[^>]*\\sas="' + alias + '"[^>]*>', 'g');
  let m;
  while ((m = open.exec(src))) {
    /* Walk forward counting sc-for depth so a nested loop cannot end this one. */
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const nextOpen = src.indexOf('<sc-for', i);
      const nextClose = src.indexOf('</sc-for>', i);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 7; }
      else { depth--; i = nextClose + 9; }
    }
    out.push({ head: m[0], body: src.slice(start, i - 9) });
  }
  return out;
}

console.log('\nEvery cell list renders every kind of cell the logic can build');
{
  /* tcell() makes a text cell, tbar() a bar, tacts() a cell of buttons. A
     loop that renders only {{ c.text }} drops the other two without a word. */
  const cellLoops = forBlocks(markup, 'c').filter((b) => /\{\{\s*c\.text\s*\}\}/.test(b.body));
  ok('there are cell loops to check', cellLoops.length >= 3, String(cellLoops.length));

  /* Two cell systems are legitimately text-only and are named here rather
     than waved through: the footer, which is totals and never a button, and
     the ledger grid, whose cells are inline-editable ({ plain, editing, val })
     and are built by hand rather than by tcell/tacts. Everything else is a
     tcell/tacts table and must render actions. */
  let checked = 0;
  cellLoops.forEach((b) => {
    const list = (b.head.match(/list="\{\{\s*([\w.]+)\s*\}\}"/) || [])[1] || '(unknown)';
    if (/tableFoot|dlgTableCols/.test(list)) return;       /* totals row */
    if (/c\.editing/.test(b.body)) return;                 /* the ledger grid */
    checked++;
    ok('the loop over ' + list + ' renders action buttons, not just text',
      /c\.actions/.test(b.body), 'renders {{ c.text }} only, so a tacts() cell would vanish');
  });
  ok('both tcell/tacts tables were actually checked', checked === 2, String(checked));
}

console.log('\nEvery table row binds the handler its producer sets');
{
  /* Only rows built from cells are checked. Those come from tcell()/tacts()
     and carry a row-level go or click; hand-built rows elsewhere (the rules
     list, payment methods, snapshots, the data counts) put their buttons in
     their own nested loop and are right as they are. */
  const rowLoops = forBlocks(markup, 'r').filter((b) => /\{\{\s*r\.cells\s*\}\}/.test(b.body));
  ok('there are cell-based row loops to check', rowLoops.length >= 2, String(rowLoops.length));

  rowLoops.forEach((b) => {
    const list = (b.head.match(/list="\{\{\s*([\w.]+)\s*\}\}"/) || [])[1] || '(unknown)';
    /* The row element is the first tag inside the loop. */
    const rowTag = (b.body.match(/<div[^>]*>/) || [''])[0];
    ok('rows of ' + list + ' are clickable',
      /onClick=/.test(rowTag), 'row <div> has no onClick, so r.go / r.click is dead: ' + rowTag.slice(0, 80));
  });
}

console.log('\nThe dialog table matches the main table it mirrors');
{
  const dlgLoop = forBlocks(markup, 'r').find((b) => /dlgTableRows/.test(b.head));
  const mainLoop = forBlocks(markup, 'r').find((b) => /tableRows/.test(b.head) && !/dlg/.test(b.head));
  ok('both tables exist', !!dlgLoop && !!mainLoop);
  ['isText', 'actions'].forEach((k) => {
    ok('the dialog table handles c.' + k + ', as the main table does',
      dlgLoop && mainLoop && new RegExp('c\\.' + k).test(dlgLoop.body) && new RegExp('c\\.' + k).test(mainLoop.body),
      'dialog: ' + (dlgLoop && new RegExp('c\\.' + k).test(dlgLoop.body)));
  });
}

console.log('\nThe fund pickers can actually be used');
{
  /* The specific thing that was broken. Both pickers build a results table
     whose only way in is the row click and the Use button. */
  ['invPickFund', 'watchPickFund'].forEach((fn) => {
    ok(fn + ' is reachable from a row click', new RegExp('go: function \\(\\) \\{ self\\.' + fn).test(logic),
      'no row-level handler calls ' + fn);
    ok(fn + ' is reachable from a Use button',
      new RegExp("label: 'Use'[\\s\\S]{0,80}" + fn).test(logic),
      'no Use action calls ' + fn);
  });
  ok('the Use button stops the click reaching the row underneath it',
    (logic.match(/label: 'Use', go: function \(e\) \{ e\.stopPropagation\(\);/g) || []).length === 2,
    String((logic.match(/label: 'Use', go: function \(e\) \{ e\.stopPropagation\(\);/g) || []).length) + ' of 2');
  ok('and the rows say they are clickable',
    (logic.match(/rowStyle\(0, false\) \+ ';cursor:pointer'/g) || []).length === 2,
    String((logic.match(/rowStyle\(0, false\) \+ ';cursor:pointer'/g) || []).length) + ' of 2');
}

console.log('\nEvery button the logic builds has somewhere to be rendered');
{
  /* tableTools, dlgButtons and field buttons each need their own loop. */
  [['tableTools', 'b'], ['dlgButtons', 'b'], ['fl.buttons', 'fb']].forEach(([list, alias]) => {
    const loop = forBlocks(markup, alias).find((x) => new RegExp('list="\\{\\{\\s*' + list.replace('.', '\\.') + '\\s*\\}\\}"').test(x.head));
    ok(list + ' is rendered as buttons', !!loop && /<button[^>]*onClick=/.test(loop.body),
      loop ? 'found but renders no button' : 'no loop over ' + list);
  });
  ok('the empty-state button is wired', /onClick="\{\{ emptyGo \}\}"/.test(markup));
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
