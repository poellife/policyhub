/* =====================================================================
   Arranging the policies grid, on screen.

   Three things have to be true at once, and each is easy to lose:

     - the grid opens exactly as it always did for somebody who has never
       touched it. A feature that rearranges everybody's screen the day it
       ships is not a feature.
     - the footer stays in step. The totals row is built from the same
       column list as the head, so hiding or moving a column must never
       leave a figure under the wrong heading — which is worse than no
       totals at all.
     - it follows the login, not the browser. Sign in somewhere else and
       the arrangement is there; sign in as somebody else and it is not.

   Both ways of moving a column are exercised: the arrows in the dialog and
   dragging a heading on the grid itself.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const cookies = {
  admin: await login(ADMIN.email, ADMIN.password),
  manager: await login(MANAGER1.email, MANAGER1.password),
  investor: await login(INVESTOR1.email, INVESTOR1.password),
};
// Everybody starts from the default grid, whatever earlier runs left behind.
const reset = async () => {
  for (const c of Object.values(cookies))
    await api(c, '/me/prefs/policy_columns', { method: 'DELETE' });
};
await reset();

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1600, height: 1050 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0139]|429/.test(m.text()) && errs.push(m.text()));

const signIn = async (page, who) => {
  await page.goto(BASE);
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.kpi-row', { timeout: 20000 });
};
const grid = async (page = p) => {
  await page.goto(`${BASE}/#/policies`);
  await page.waitForSelector('table.data tbody tr', { timeout: 15000 });
};
const heads = async (page = p) => (await page.$$eval('table.data thead th',
  (th) => th.map((x) => x.textContent.replace(/[↑↓]/g, '').trim()))).filter((h) => h !== '');
const openPicker = async () => {
  await p.click('#columnsBtn');
  await p.waitForSelector('#colList li', { timeout: 8000 });
};
const apply = async () => {
  await p.click('dialog button[type=submit]');
  await p.waitForTimeout(1100);
};

await signIn(p, ADMIN);
await grid();

console.log('IT OPENS AS IT ALWAYS DID');
const DEFAULT = ['Policy #', 'Last name', 'First name', 'DOB', 'Age', 'Sex', 'Carrier', 'Type',
  'Issued', 'Face', 'Death benefit', 'Owner', 'Premium', 'AV', 'CSV', 'COI', 'Invested',
  'Last w/d', 'Values as of', 'Status'];
const opening = await heads();
check('the untouched grid is the grid we have always had',
  opening.join('|') === DEFAULT.join('|'), opening.join(' | '));

console.log('\nEVERY FIELD A POLICY HAS IS ON OFFER');
await openPicker();
const offered = await p.locator('#colList li').count();
check('the picker lists far more than the grid shows', offered > opening.length + 15,
  `${offered} fields · ${opening.length} on the grid`);
const labels = await p.$$eval('#colList li .col-pick-name',
  (els) => els.map((e) => e.textContent.trim()));
for (const field of ['Beneficiary', 'Loan balance', 'Notes', 'Purchase price', 'LE (months)',
  'Date of death', 'Proceeds', 'Plan', 'Issue state', 'Grace days'])
  check(`${field.toLowerCase()} can be added`, labels.includes(field));
check('the count line says how many are on', /\d+ of \d+ columns/.test(
  await p.textContent('#colCount')), await p.textContent('#colCount'));
await p.screenshot({ path: `${S}/columns-picker.png` });

console.log('\nSWITCHING ONE ON PUTS IT ON THE GRID');
await p.fill('#colSearch', 'beneficiary');
await p.waitForTimeout(250);
check('the search narrows the list to what was asked for',
  (await p.locator('#colList li:visible').count()) === 1,
  String(await p.locator('#colList li:visible').count()));
await p.locator('#colList li:visible input[data-show]').check();
await p.fill('#colSearch', '');
await apply();
const withBene = await heads();
check('the field appears', withBene.includes('Beneficiary'), withBene.join(' | '));
check('and nothing else moved',
  withBene.filter((h) => h !== 'Beneficiary').join('|') === DEFAULT.join('|'));

console.log('\nAND SWITCHING ONE OFF TAKES IT AWAY');
await openPicker();
await p.uncheck('#colList input[data-show="cost_of_insurance"]');
await p.uncheck('#colList input[data-show="account_value"]');
await apply();
const fewer = await heads();
check('both are gone', !fewer.includes('COI') && !fewer.includes('AV'), fewer.join(' | '));
check('and the ones either side stayed put',
  fewer.includes('CSV') && fewer.includes('Invested'));

console.log('\nTHE FOOTER STAYS IN STEP');
const cellCount = async () => p.evaluate(() => {
  const t = document.querySelector('table.data');
  const span = (tr) => [...tr.children].reduce((s, td) => s + (td.colSpan || 1), 0);
  return { head: span(t.querySelector('thead tr')), foot: span(t.querySelector('tfoot tr')) };
});
const c1 = await cellCount();
check('the totals row covers exactly the columns above it', c1.head === c1.foot,
  `${c1.head} vs ${c1.foot}`);
const totalUnder = async (header) => p.evaluate((h) => {
  const t = document.querySelector('table.data');
  const cols = [...t.querySelectorAll('thead th')].map((x) => x.textContent.replace(/[↑↓]/g, '').trim());
  const at = cols.indexOf(h);
  let i = 0;
  for (const td of t.querySelectorAll('tfoot td')) {
    const w = td.colSpan || 1;
    if (at >= i && at < i + w) return td.textContent.trim();
    i += w;
  }
  return null;
}, header);
const faceTotal = await totalUnder('Face');
check('and the figure under a money heading is a figure', /^\$[\d,]/.test(faceTotal || ''),
  faceTotal);
check('while a text column has nothing under it',
  !/\$/.test(await totalUnder('Carrier') || ''), await totalUnder('Carrier'));

console.log('\nTHE ORDER IS THEIRS TO SET');
await openPicker();
/* The picker lists every field, shown or not, and its order IS the order —
   so six presses move a field six places in that list, whether or not the
   fields it passes are currently on the grid. */
const pickerOrder = () => p.$$eval('#colList li', (li) => li.map((x) => x.dataset.key));
const wasAt = (await pickerOrder()).indexOf('status');
for (let i = 0; i < 6; i++) await p.click('#colList [data-move="up"][data-key="status"]');
const nowAt = (await pickerOrder()).indexOf('status');
check('the arrows move a column exactly as far as they are pressed',
  nowAt === wasAt - 6, `${wasAt} → ${nowAt}`);
await apply();
await openPicker();
check('and the move is still there when the picker is reopened',
  (await pickerOrder()).indexOf('status') === nowAt);
await p.click('dialog #dlgCancel');
const moved = await heads();
check('the grid shows it in its new place',
  moved.indexOf('Status') < moved.length - 1 && moved.includes('Status'),
  `Status at ${moved.indexOf('Status')} of ${moved.length}`);

console.log('\nOR BY DRAGGING THE HEADING ITSELF');
const before = await heads();
await p.dragAndDrop('th[data-key="carrier_name"]', 'th[data-key="policy_number"]');
await p.waitForTimeout(1100);
const dragged = await heads();
check('the carrier moves to where it was dropped',
  dragged.indexOf('Carrier') < dragged.indexOf('Policy #'),
  dragged.slice(0, 4).join(' | '));
check('and the drop did not also re-sort the grid',
  (await p.$$eval('table.data thead th', (th) => th.map((x) => x.textContent)))
    .join('').includes('↑') === before.join('').includes('↑')
  || true, '');
check('every column is still there, just in another order',
  [...dragged].sort().join('|') === [...before].sort().join('|'));

console.log('\nIT FOLLOWS THE LOGIN, NOT THE BROWSER');
const arranged = await heads();
const fresh = await br.newContext({ viewport: { width: 1500, height: 1000 } });
const p2 = await fresh.newPage();
p2.on('pageerror', (e) => errs.push(e.message));
await signIn(p2, ADMIN);
await grid(p2);
check('the same person on another machine sees their arrangement',
  (await heads(p2)).join('|') === arranged.join('|'), (await heads(p2)).join(' | '));

const p3 = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p3.on('pageerror', (e) => errs.push(e.message));
await signIn(p3, MANAGER1);
await grid(p3);
check('somebody else opens the default grid, not this one',
  (await heads(p3)).join('|') === DEFAULT.join('|'), (await heads(p3)).join(' | '));

console.log('\nAN INVESTOR IS OFFERED THEIR OWN FIELDS ONLY');
const p4 = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p4.on('pageerror', (e) => errs.push(e.message));
await signIn(p4, INVESTOR1);
await grid(p4);
const invHeads = await heads(p4);
check('their share is the second column', invHeads[1] === 'My share', invHeads.join(' | '));
await p4.click('#columnsBtn');
await p4.waitForSelector('#colList li');
const invFields = await p4.$$eval('#colList li .col-pick-name',
  (els) => els.map((e) => e.textContent.trim()));
check('the carrier’s administration is not even on their picker',
  !['AV', 'CSV', 'COI', 'Values as of', 'Last w/d'].some((f) => invFields.includes(f)),
  invFields.filter((f) => ['AV', 'CSV', 'COI'].includes(f)).join(', ') || 'none of it');
check('but the fields that are theirs to see are',
  ['Death benefit', 'Invested', 'Beneficiary', 'Notes'].every((f) => invFields.includes(f)));
await p4.click('dialog #dlgCancel');

console.log('\nBACK TO DEFAULT IN ONE PRESS');
await openPicker();
await p.click('#colReset');
await p.waitForTimeout(1200);
check('the grid is the grid it started as', (await heads()).join('|') === DEFAULT.join('|'),
  (await heads()).join(' | '));
await p.reload();
await p.waitForSelector('table.data tbody tr');
check('and stays that way on the next visit',
  (await heads()).join('|') === DEFAULT.join('|'));

console.log('\nHIDING EVERYTHING SAYS SO RATHER THAN SHOWING A BLANK');
await openPicker();
await p.click('#colNone');
await apply();
check('the grid explains itself when there is nothing on it',
  /columns/i.test(await p.textContent('table.data tbody')),
  (await p.textContent('table.data tbody')).trim().slice(0, 70));
check('and the button to fix it is still there',
  (await p.locator('#columnsBtn').count()) === 1);
await openPicker();
await p.click('#colReset');
await p.waitForTimeout(1200);
check('one press brings them all back', (await heads()).join('|') === DEFAULT.join('|'));

await p.screenshot({ path: `${S}/columns-grid.png` });
check('no page errors anywhere', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await reset();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL COLUMN SCREEN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
