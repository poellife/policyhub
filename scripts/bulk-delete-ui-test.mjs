/* =====================================================================
   Choosing policies to delete, on screen.

   The thing worth watching is the selection itself. It has to survive a
   search — you pick three from one carrier, search for another, pick two
   more — and it has to say plainly when some of what you have picked is
   no longer in front of you. A count of five with three rows on screen
   is alarming unless the page explains it.

   The other half is that a manager, who can delete a policy one at a
   time from its own page, is shown no tick boxes at all.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'BULKUI';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const wipe = async () => {
  for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

// Two carriers, so a search can hide half the selection.
const make = (n, carrier) => api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-${carrier.slice(0, 3).toUpperCase()}${n}`, carrier_name: carrier,
  product_type: 'UL', fund_code: 'LCG1', face_amount: 1000000, premium_required: 20000,
  premium_mode: 'Annual', acquisition_date: iso(-400), acquisition_cost: 150000,
  insured_last_name: `${PREFIX}person${carrier.slice(0, 3)}${n}`, insured_first_name: 'Ada',
  dob: '1938-04-04' } });
for (let n = 1; n <= 3; n++) await make(n, 'Northfield Mutual');
for (let n = 1; n <= 2; n++) await make(n, 'Southgate Assurance');

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1050 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0139]|429/.test(m.text()) && errs.push(m.text()));
p.on('dialog', (d) => d.accept());

const signIn = async (page, who) => {
  await page.goto(BASE);
  await page.fill('#email', who.email); await page.fill('#password', who.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.kpi-row', { timeout: 15000 });
};
const search = async (term) => {
  await p.fill('#searchInput', term);
  await p.waitForTimeout(900);
};

await signIn(p, ADMIN);
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await search(`${PREFIX}-NOR`);

console.log('THE TICKS ARE THERE, AND THEY ARE NOT NAVIGATION');
check('every row has one', (await p.locator('td.tick input').count()) === 3,
  String(await p.locator('td.tick input').count()));
check('and so does the header', (await p.locator('#tickAll').count()) === 1);
check('nothing is offered until something is picked',
  (await p.locator('#bulkBar').count()) === 0);
await p.locator('td.tick input').first().click();
await p.waitForTimeout(500);
check('ticking one does not open the policy', /#\/policies$/.test(p.url()), p.url());
check('the bar appears and counts it',
  /1 policy selected/.test(await p.locator('#bulkBar').textContent()),
  (await p.locator('#bulkBar').textContent()).replace(/\s+/g, ' ').trim());
check('and the row is marked', (await p.locator('tr.ticked').count()) === 1);

console.log('\nSELECT ALL MEANS ALL OF WHAT YOU ARE LOOKING AT');
await p.locator('#tickAll').click();
await p.waitForTimeout(500);
check('all three of the filtered rows are picked',
  /3 policies selected/.test(await p.locator('#bulkBar').textContent()),
  (await p.locator('#bulkBar').textContent()).replace(/\s+/g, ' ').slice(0, 60));
check('not the whole book', (await p.locator('tr.ticked').count()) === 3);
await p.screenshot({ path: `${S}/bd1-selected.png`, fullPage: true });

console.log('\nA SELECTION SURVIVES A SEARCH, AND SAYS SO');
await search(`${PREFIX}-SOU`);
check('the three picked earlier are still counted',
  /3 policies selected/.test(await p.locator('#bulkBar').textContent()),
  (await p.locator('#bulkBar').textContent()).replace(/\s+/g, ' ').slice(0, 80));
check('and the bar explains where they went',
  /3 of them not on screen/.test(await p.locator('#bulkBar').textContent()),
  (await p.locator('#bulkBar').textContent()).replace(/\s+/g, ' ').slice(0, 140));
check('none of the rows in front of you look picked',
  (await p.locator('tr.ticked').count()) === 0);
await p.locator('td.tick input').first().click();
await p.waitForTimeout(500);
check('adding one from this search makes four',
  /4 policies selected/.test(await p.locator('#bulkBar').textContent()));

console.log('\nWHAT THE DIALOG SAYS BEFORE ANYTHING GOES');
await p.click('#bulkDeleteBtn');
await p.waitForSelector('dialog[open]');
await p.waitForTimeout(700);
const dlg = (await p.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('it names every policy, including the ones off screen',
  (await p.locator('dialog[open] table.data tbody tr').first().count()) === 1
  && /NOR1/.test(dlg) && /SOU1/.test(dlg), dlg.slice(0, 120));
check('it counts the ledger entries and snapshots that go with them',
  /Ledger entries/.test(dlg) && /Value snapshots/.test(dlg));
check('it says this cannot be undone', /cannot be undone/i.test(dlg));
check('and points at changing the status instead, for a policy that merely ended',
  /Sold, Matured or Lapsed instead/.test(dlg));
check('the confirmation asks for the count, not a policy number',
  /Type DELETE 4 to confirm/.test(dlg), dlg.slice(-140));
/* The dialog cannot grow, and a death benefit showing "$14,049,49" is a
   different number from the one you are about to delete. */
const clipped = await p.evaluate(() => [...document.querySelectorAll('dialog[open] table.dlg-list td')]
  .filter((td) => td.scrollWidth > td.clientWidth + 1 && td.classList.contains('dlg-amt'))
  .map((td) => td.textContent.trim()));
check('and no figure in the list is cut off by the edge of the dialog',
  clipped.length === 0, clipped.join(' | '));
await p.screenshot({ path: `${S}/bd2-dialog.png`, fullPage: true });

console.log('\nTYPING THE WRONG THING DOES NOTHING');
await p.fill('dialog[open] input[name="confirm"]', 'DELETE 3');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1000);
check('a count that is not the count is refused',
  /does not match/i.test(await p.locator('dialog[open]').textContent()),
  (await p.locator('dialog[open] .error-box').last().textContent()).replace(/\s+/g, ' ').slice(0, 80));
check('and all five policies are still on file',
  ((await json(await api(`/policies?search=${PREFIX}&status=`))) || []).length === 5);

console.log('\nAND THEN IT DOES IT');
await p.fill('dialog[open] input[name="confirm"]', 'DELETE 4');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2500);
const left = (await json(await api(`/policies?search=${PREFIX}&status=`))) || [];
check('four are gone and one is left', left.length === 1,
  left.map((x) => x.policy_number).join(', '));
check('the selection is emptied afterwards, so nothing is left armed',
  (await p.locator('#bulkBar').count()) === 0);
await p.screenshot({ path: `${S}/bd3-after.png`, fullPage: true });

console.log('\nA MANAGER IS NOT OFFERED IT AT ALL');
const mgrCtx = await br.newContext({ viewport: { width: 1500, height: 1000 } });
const m = await mgrCtx.newPage();
m.on('pageerror', (e) => errs.push(e.message));
await signIn(m, MANAGER1);
await m.goto(`${BASE}/#/policies`);
await m.waitForSelector('table.data tbody tr', { timeout: 12000 });
await m.waitForTimeout(700);
check('no tick column', (await m.locator('td.tick').count()) === 0);
check('no select-all box', (await m.locator('#tickAll').count()) === 0);
check('and the totals row still lines up with the columns',
  await m.evaluate(() => {
    const t = document.querySelector('table.data');
    const head = t.querySelectorAll('thead th').length;
    const foot = [...t.querySelectorAll('tfoot td')]
      .reduce((a, td) => a + (Number(td.getAttribute('colspan')) || 1), 0);
    return head === foot;
  }));
check('clicking a row still opens the policy',
  await m.locator('table.data tbody tr').first().click().then(() => m.waitForTimeout(1200))
    .then(() => /#\/policy\//.test(m.url())), m.url());

console.log('\nAND THE ADMIN TOTALS ROW LINES UP WITH ITS EXTRA COLUMN');
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await p.waitForTimeout(700);
check('head and foot agree on how many cells there are',
  await p.evaluate(() => {
    const t = document.querySelector('table.data');
    const head = t.querySelectorAll('thead th').length;
    const foot = [...t.querySelectorAll('tfoot td')]
      .reduce((a, td) => a + (Number(td.getAttribute('colspan')) || 1), 0);
    return head === foot;
  }));

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL BULK DELETE UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
