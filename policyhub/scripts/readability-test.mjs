/* =====================================================================
   Readability.

   Contrast is the one part of visual design that is arithmetic rather
   than taste, so it is checked rather than argued about. Everything here
   is measured against the surface the text actually sits on, in both
   modes, straight out of the browser's computed styles — not against
   what the stylesheet says it intended.

   WCAG AA: 4.5:1 for body text, 3:1 for large text and for the boundary
   of a control you have to find.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });

/* Contrast, computed from what is actually painted rather than from what
   the stylesheet meant. Runs inside page.evaluate because the application
   sets a strict script-src, which is exactly as it should be. */
const contrastOf = (page, sel) => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const f = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // Most elements are transparent; walk up for the surface behind them.
  let bg = 'rgb(255, 255, 255)';
  for (let n = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && !/rgba?\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
  }
  const fg = lum(getComputedStyle(el).color);
  const back = lum(bg);
  const hi = Math.max(fg, back), lo = Math.min(fg, back);
  return { ratio: (hi + 0.05) / (lo + 0.05), size: parseFloat(getComputedStyle(el).fontSize) };
}, sel);

/* Each surface is measured where it actually lives: tiles and alerts on the
   dashboard, headers and cells on the policy grid. */
const SCREENS = [
  ['#/dashboard', '.kpi-row', [
    ['stat tile labels', '.stat .label', 4.5],
    ['stat tile values', '.stat .value', 4.5],
    ['stat tile notes', '.stat .note', 4.5],
    ['card titles', '.card-head h2', 4.5],
    ['alert headline', '.alert-row .who', 4.5],
    ['alert detail', '.alert-row .meta', 4.5],
    ['page sub-heading', '.page-head .sub', 4.5],
    ['muted text', '.muted', 4.5],
    ['menu links', '.nav a:not(.active)', 4.5],
    ['the active menu link', '.nav a.active', 4.5],
    ['buttons', 'button', 4.5],
  ]],
  ['#/policies', 'table.data tbody tr', [
    ['table headers', 'table.data th', 4.5],
    ['table cells', 'table.data td', 4.5],
    ['column totals', 'table.data tfoot td', 4.5],
  ]],
];

const measure = async (label) => {
  console.log(`\n${label.toUpperCase()}`);
  for (const [route, ready, targets] of SCREENS) {
    await p.goto(`${BASE}/${route}`);
    await p.waitForSelector(ready, { timeout: 12000 });
    await p.waitForTimeout(700);
    for (const [name, sel, floor] of targets) {
      const r = await contrastOf(p, sel);
      if (!r) { check(`${name} present`, false, `${sel} not on ${route}`); continue; }
      check(`${name} reads at ${floor}:1`, r.ratio >= floor,
        `${r.ratio.toFixed(2)}:1 at ${r.size}px`);
    }
  }
};

await measure('light mode');

await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await p.waitForTimeout(600);

console.log('\nTYPE IS BIG ENOUGH TO READ');
const sizes = await p.evaluate(() => ({
  body: parseFloat(getComputedStyle(document.body).fontSize),
  th: parseFloat(getComputedStyle(document.querySelector('table.data th')).fontSize),
  td: parseFloat(getComputedStyle(document.querySelector('table.data td')).fontSize),
  label: parseFloat(getComputedStyle(document.querySelector('label') || document.body).fontSize),
}));
check('body text is at least 15px', sizes.body >= 15, `${sizes.body}px`);
check('table headers are at least 11px', sizes.th >= 11, `${sizes.th}px`);
check('table cells are at least 13px', sizes.td >= 13, `${sizes.td}px`);

console.log('\nA ROW CAN BE FOLLOWED ACROSS THE TABLE');
const banding = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('table.data tbody tr')].slice(0, 2);
  if (rows.length < 2) return null;
  return rows.map((r) => getComputedStyle(r).backgroundColor);
});
check('alternate rows are banded', banding && banding[0] !== banding[1],
  (banding || []).join(' vs '));

console.log('\nSTATUS IS NEVER COLOUR ALONE');
const badge = await p.evaluate(() => {
  const b = document.querySelector('.badge');
  return b ? { text: b.textContent.trim(), dots: b.querySelectorAll('.dot').length } : null;
});
check('a status badge carries its own word', !!badge?.text, badge?.text);
check('with a mark beside it, not instead of it', badge?.dots === 1);

console.log('\nKEYBOARD FOCUS IS VISIBLE');
await p.keyboard.press('Tab');
const focus = await p.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  return { tag: el.tagName, width: parseFloat(cs.outlineWidth) || 0, style: cs.outlineStyle };
});
check('tabbing puts a visible ring on something',
  focus && focus.width >= 2 && focus.style !== 'none',
  focus ? `${focus.tag} ${focus.width}px ${focus.style}` : 'nothing focused');

// The same page, chosen for dark rather than inverted into it.
await p.click('#themeBtn');
await p.waitForTimeout(700);
await measure('dark mode');

await br.close();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL READABILITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
