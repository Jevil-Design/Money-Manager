/* The narrow-screen layout.
 *
 * This file exists for the same reason test/csp.test.js does. The app's
 * markup is never compiled by the test suite — it is compiled in the browser
 * by support.js — so a change to the page chrome can pass every test here and
 * still take the site down. That happened once already, with the CSP.
 *
 * So this checks the things that can actually break without anyone noticing:
 * that the mobile rules are well formed, that every selector they use still
 * matches something in the markup, that the elements they need are still
 * tagged, and — most important — that none of it leaks out of the media query
 * and changes the desktop layout.
 *
 *   node test/responsive.test.js
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

/* The markup, with the logic block taken out so a string inside the code
   cannot be mistaken for an element. */
const markup = html.replace(/<script type="text\/x-dc"[^>]*>[\s\S]*?<\/script>/, '');
const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

/* Pull out the narrow-screen media query by matching its braces, since a
   regex cannot count nesting. */
function mediaBlock(src, query) {
  const start = src.indexOf(query);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

const MQ = '@media (max-width: 760px)';
const mobile = mediaBlock(styleBlock, MQ);
/* Comments are stripped from the whole block at once, not line by line — a
   comment spanning several lines would otherwise leave its tail behind and be
   read as a declaration. */
const bare = (mobile || '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\nThe mobile rules are there and well formed');
{
  ok('there is a narrow-screen media query', mobile !== null,
    mobile === null ? 'no ' + MQ + ' block, or its braces do not close' : '');
  ok('the stylesheet\'s braces balance',
    (styleBlock.match(/\{/g) || []).length === (styleBlock.match(/\}/g) || []).length,
    (styleBlock.match(/\{/g) || []).length + ' open vs ' + (styleBlock.match(/\}/g) || []).length + ' close');
  ok('and so do the mobile block\'s',
    mobile !== null && (mobile.match(/\{/g) || []).length === (mobile.match(/\}/g) || []).length);
  const loose = bare.split('\n').map((l) => l.trim())
    .filter((l) => l && !/[{}]$/.test(l) && !/;$/.test(l));
  ok('every declaration in it ends in a semicolon', mobile !== null && loose.length === 0,
    loose.join(' | '));
  ok('the breakpoint is a phone-and-small-tablet width, not an arbitrary one',
    /max-width:\s*760px/.test(styleBlock));
}

/* The attributes the layout hangs on. Each is a bare attribute, the same
   form as data-app and data-print, which have shipped and work. */
const NEEDED = [
  { attr: 'data-chrome', least: 1, why: 'the title bar, which has to wrap' },
  { attr: 'data-chrome-search', least: 1, why: 'the search box, which takes its own line' },
  { attr: 'data-tabs', least: 1, why: 'the tab strip, which becomes the bottom bar' },
  { attr: 'data-main', least: 1, why: 'the content row, which has to clear the bottom bar' },
  { attr: 'data-left', least: 3, why: 'the summary panel, its resizer and its collapsed rail' },
  { attr: 'data-dialog', least: 1, why: 'the dialog, which must not run off the screen' }
];

console.log('\nEvery element the rules need is still tagged');
NEEDED.forEach((n) => {
  const found = (markup.match(new RegExp('\\s' + n.attr + '(?=[\\s>=])', 'g')) || []).length;
  ok(n.attr + ' is on ' + n.why, found >= n.least, 'found ' + found + ', need ' + n.least);
});

console.log('\nThe tags are the form already proven to compile');
{
  /* data-app and data-print are bare attributes and have shipped working, so
     the new ones are written the same way rather than inventing a new shape
     the template compiler has never seen. */
  ok('data-app is a bare attribute, as it always was', /<div data-app style=/.test(markup));
  ok('data-print likewise', /<div data-print style=/.test(markup));
  NEEDED.forEach((n) => {
    const re = new RegExp('<[a-z]+ ' + n.attr + '(?:\\s|>)');
    ok(n.attr + ' is bare and comes first on its element, the same way',
      re.test(markup), (markup.match(new RegExp('<[a-z]+[^>]*' + n.attr + '[^>]*>')) || [''])[0].slice(0, 90));
  });
  ok('no new attribute was given a value, which none of them needs',
    NEEDED.every((n) => !new RegExp(n.attr + '=').test(markup)));
}

console.log('\nEvery selector in the mobile block matches something real');
{
  const selectors = bare.split('}').map((chunk) => chunk.split('{')[0].trim()).filter(Boolean);
  ok('there are rules to check', selectors.length >= 6, String(selectors.length));

  const attrs = new Set();
  selectors.forEach((sel) => {
    (sel.match(/\[data-[a-z-]+\]/g) || []).forEach((a) => attrs.add(a.slice(1, -1)));
  });
  ok('every data- attribute used in a selector exists in the markup',
    [...attrs].every((a) => new RegExp('\\s' + a + '(?=[\\s>=])').test(markup)),
    [...attrs].filter((a) => !new RegExp('\\s' + a + '(?=[\\s>=])').test(markup)).join(', '));
  ok('and every selector is an attribute selector, so nothing depends on a class that does not exist',
    selectors.every((sel) => /^\[data-/.test(sel)),
    selectors.filter((sel) => !/^\[data-/.test(sel)).join(' | '));
}

console.log('\nThe desktop layout is untouched');
{
  const outside = (mobile === null ? styleBlock : styleBlock.replace(mobile, ''))
    .replace(/@media print[\s\S]*?\}\s*\}/, '');
  const leaked = NEEDED.map((n) => n.attr).filter((a) => outside.indexOf('[' + a + ']') >= 0);
  ok('no mobile-only attribute is styled outside the media query', leaked.length === 0,
    leaked.join(', '));
  ok('the print rules still stand on their own',
    /@media print\s*\{[\s\S]*?\[data-app\]\s*\{\s*display:\s*none/.test(styleBlock));
  ok('the tab strip keeps its desktop height in the markup',
    /data-tabs[^>]*height:27px/.test(markup));
  ok('and the title bar keeps its desktop height',
    /data-chrome[^>]*height:28px/.test(markup));
}

console.log('\nThe bottom bar leaves room for itself');
{
  const num = (re) => { const m = (mobile || '').match(re); return m ? parseFloat(m[1]) : null; };
  const tabH = num(/\[data-tabs\]\s*button\s*\{[\s\S]*?height:\s*(\d+)px/);
  const clear = num(/\[data-main\]\s*\{[\s\S]*?padding-bottom:\s*calc\((\d+)px/);
  const pad = num(/\[data-tabs\]\s*\{[\s\S]*?padding:\s*(\d+)px/);

  ok('the tab buttons have a thumb-sized target', tabH !== null && tabH >= 32, String(tabH));
  ok('the content is padded to clear the bar', clear !== null, String(clear));
  ok('and the padding is at least as tall as the bar itself',
    tabH !== null && clear !== null && pad !== null && clear >= tabH + pad,
    clear + ' of clearance vs ' + tabH + ' + ' + pad + ' of bar');
  ok('the bar sits above the content, not under it',
    /\[data-tabs\]\s*\{[\s\S]*?z-index:\s*(\d+)/.test(mobile || '') &&
    parseInt((mobile.match(/\[data-tabs\]\s*\{[\s\S]*?z-index:\s*(\d+)/) || [])[1], 10) >= 50);
  ok('it is pinned to the bottom', /\[data-tabs\]\s*\{[\s\S]*?position:\s*fixed/.test(mobile || ''));
  ok('and it respects the phone\'s home indicator',
    /env\(safe-area-inset-bottom\)/.test(mobile || ''));
  ok('thirteen tabs scroll rather than being hidden behind a menu',
    /\[data-tabs\]\s*\{[\s\S]*?overflow-x:\s*auto/.test(mobile || ''));
}

console.log('\nNothing can run off the side of the screen');
{
  ok('the summary panel steps aside rather than squeezing the content',
    /\[data-left\]\s*\{\s*display:\s*none\s*!important/.test(mobile || ''));
  ok('the content row stacks instead of sitting side by side',
    /\[data-main\]\s*\{[\s\S]*?flex-direction:\s*column\s*!important/.test(mobile || ''));
  ok('a dialog is capped to the viewport', /max-width:\s*calc\(100vw - \d+px\)/.test(mobile || ''));
  ok('and can scroll if it is taller than the screen',
    /\[data-dialog\]\s*\{[\s\S]*?overflow-y:\s*auto/.test(mobile || ''));
  ok('the app uses dvh so mobile browser chrome cannot clip it',
    /height:\s*100dvh/.test(mobile || ''));
}

console.log('\nThe overrides are strong enough to win');
{
  /* Every layout style in this app is inline, and an inline style beats any
     stylesheet rule that is not !important. A rule that quietly loses is
     worse than no rule, because it reads as though the case is handled. */
  const mustWin = [
    ['[data-chrome]', 'height'], ['[data-tabs]', 'height'], ['[data-main]', 'flex-direction'],
    ['[data-left]', 'display'], ['[data-dialog]', 'width'], ['[data-dialog]', 'max-width']
  ];
  mustWin.forEach(([sel, prop]) => {
    const block = (mobile || '').split(sel).slice(1).join(sel);
    const decl = (block.match(new RegExp(prop + ':\\s*[^;]+;')) || [''])[0];
    ok(sel + ' overrides the inline ' + prop, /!important/.test(decl), sel + ' ' + decl.trim());
  });
  ok('the tab buttons override their inline geometry too',
    /\[data-tabs\]\s*button\s*\{[\s\S]*?height:[^;]*!important/.test(mobile || ''));
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
