/* =====================================================================
   The Carried interest screen, and the register it was lifted out of.

   Carried interest used to be a tab inside every policy and a column on
   the maturities register. It is now one page of its own, reachable from
   the top menu by an admin and by nobody else. Two things are worth
   watching:

     - the button is not there for a manager, and the page is not merely
       hidden from them — the API refuses it too, which the sister suite
       checks;
     - the places it was removed from no longer carry a trace of it. A
       stale column header with nothing under it is worse than the column.

   Then the register's own sorting: names in two columns, every heading
   clickable, and the totals row unmoved by any of it — sorting rearranges
   rows, it must never change which rows are there.

   Idempotent: its own entity, its own policies, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'CARRYUI';
const FUND = 'CUIFND';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;
const dollars = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(`/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  for (const f of ((await json(await api('/funds'))) || []).filter((x) => x.code === FUND))
    await api(`/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();
await api('/funds', { method: 'POST', body: {
  code: FUND, name: 'Carry screen fixture', charges_carry: true, carry_pct: 10 } });

/* Surnames chosen so that alphabetical order and the order they are created
   in disagree, and death benefits so that money order disagrees with both. */
const CASES = [
  { tag: 'M', last: 'Mercer', first: 'Nora', benefit: 3000000, cost: 900000, paid: 3000000, paidAgo: 40, diedAgo: 120 },
  { tag: 'A', last: 'Alder', first: 'Zane', benefit: 1000000, cost: 400000, paid: 1000000, paidAgo: 90, diedAgo: 200 },
  { tag: 'Z', last: 'Zephyr', first: 'Bo', benefit: 5000000, cost: 2000000, paid: 5000000, paidAgo: 10, diedAgo: 55 },
];
for (const c of CASES) {
  const p = await json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${c.tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    fund_code: FUND, face_amount: c.benefit, premium_required: 20000, premium_mode: 'Annual',
    insured_last_name: `${PREFIX}${c.last}`, insured_first_name: c.first, dob: '1935-05-05' } }));
  await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-900), txn_type: 'Acquisition Cost', amount: c.cost } });
  const ins = (await json(await api(`/insureds?search=${PREFIX}${c.last}`))) || [];
  const person = (ins.rows || ins).find((i) => String(i.last_name) === `${PREFIX}${c.last}`);
  await api(`/insureds/${person.id}`, { method: 'PUT', body: { date_of_death: iso(-c.diedAgo) } });
  await api(`/policies/${p.id}/proceeds`, { method: 'PUT', body: {
    proceeds_amount: c.paid, proceeds_received_on: iso(-c.paidAgo) } });
}
// One still running, so the page has something to project.
const live = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-LIVE`, carrier_name: 'Southgate Assurance', product_type: 'UL',
  fund_code: FUND, face_amount: 2000000, premium_required: 30000, premium_mode: 'Annual',
  insured_last_name: `${PREFIX}Quill`, insured_first_name: 'Ada', dob: '1940-02-02' } }));
await api(`/policies/${live.id}/transactions`, { method: 'POST', body: {
  txn_date: iso(-600), txn_type: 'Acquisition Cost', amount: 500000 } });

const truth = await json(await api(`/carry?fund=${FUND}`));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1600, height: 1100 } });
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
const navLabels = (page) => page.$$eval('nav a, .nav a', (as) => as.map((a) => a.textContent.trim()));
const pickEntity = async () => {
  await p.selectOption('#entityFilter', FUND);
  await p.waitForTimeout(700);
};

await signIn(p, ADMIN);

console.log('THE BUTTON IS ON THE TOP MENU');
const adminNav = await navLabels(p);
check('an admin sees Carried interest', adminNav.some((t) => /carried interest/i.test(t)),
  adminNav.join(' · '));

await p.goto(`${BASE}/#/carry`);
await p.waitForSelector('h1', { timeout: 15000 });
await p.waitForTimeout(600);
check('and it opens a page of its own',
  /carried interest/i.test(await p.textContent('h1')), await p.textContent('h1'));
await pickEntity();

console.log('\nEARNED AND PROJECTED ARE SHOWN APART');
const tiles = await p.$$eval('.kpi-row .stat', (els) => els.map((e) => ({
  label: e.querySelector('.label')?.textContent.trim(),
  value: e.querySelector('.value')?.textContent.trim(),
  note: e.querySelector('.note')?.textContent.trim(),
})));
check('three figures, not one', tiles.length === 3, tiles.map((t) => t.label).join(' · '));
check('the first is what the carrier has actually paid us on',
  /earned/i.test(tiles[0].label) && near(dollars(tiles[0].value), truth.totals.earned),
  `${tiles[0].value} vs ${truth.totals.earned}`);
check('the second is what has not arrived',
  near(dollars(tiles[1].value), truth.totals.projected),
  `${tiles[1].value} vs ${truth.totals.projected}`);
check('and the third says in words that only one of them is money',
  /only the first/i.test(tiles[2].note || ''), tiles[2].note);

console.log('\nBY ENTITY, THEN BY POLICY');
const cards = await p.$$eval('.card h2', (hs) => hs.map((h) => h.textContent.trim()));
check('both tables are there', cards.some((h) => /by owner entity/i.test(h))
  && cards.some((h) => /by policy/i.test(h)), cards.join(' · '));
const entRow = await p.locator('.card:has(h2:text-is("By owner entity")) tbody tr')
  .first().locator('td').allTextContents();
check('the entity is named with the rate from its agreement',
  entRow[0].trim() === FUND && /10/.test(entRow[1]), entRow.slice(0, 2).join(' · '));

check('every policy in the entity has a line',
  (await p.locator('tr.clickable').count()) === truth.rows.length,
  `${await p.locator('tr.clickable').count()} of ${truth.rows.length}`);
const headers = (await p.locator('.card:has(h2:text-is("By policy")) thead th')
  .allTextContents()).map((h) => h.trim());
check('the surname has its own column here too',
  headers[0] === 'Last name' && headers[1] === 'First name', headers.slice(0, 2).join(' · '));

console.log('\nTHE FILTERS CHANGE WHAT IS COUNTED');
await p.selectOption('#carryStatus', 'matured');
await p.waitForTimeout(800);
const maturedRows = await p.locator('tr.clickable').count();
check('matured leaves out the case still running', maturedRows === 3, String(maturedRows));
const maturedEarned = dollars(await p.textContent('.kpi-row .stat:nth-child(1) .value'));
check('and the earned figure is unchanged by narrowing to it',
  near(maturedEarned, truth.totals.earned), String(maturedEarned));
check('with nothing left to project',
  near(dollars(await p.textContent('.kpi-row .stat:nth-child(2) .value')), 0));

await p.selectOption('#carryStatus', 'active');
await p.waitForTimeout(800);
check('still running leaves the settled ones out',
  (await p.locator('tr.clickable').count()) === 1,
  String(await p.locator('tr.clickable').count()));
check('and shows nothing as earned',
  near(dollars(await p.textContent('.kpi-row .stat:nth-child(1) .value')), 0));
await p.selectOption('#carryStatus', 'all');
await p.waitForTimeout(800);

console.log('\nA LINE LEADS BACK TO ITS POLICY');
check('the export is offered', (await p.locator('#exportCarryBtn').count()) === 1);
await p.locator('tr.clickable').first().click();
await p.waitForTimeout(900);
check('clicking a row opens that policy', /#\/policy\/\d+/.test(p.url()), p.url());

console.log('\nIT IS NO LONGER INSIDE EACH POLICY');
const tabs = await p.$$eval('.tabs a, .tabs button, [role=tab]',
  (els) => els.map((e) => e.textContent.trim()));
check('the policy page has no carried-interest tab',
  !tabs.some((t) => /carr(y|ied)/i.test(t)), tabs.join(' · '));

console.log('\nNOR ON THE REGISTER');
await p.goto(`${BASE}/#/maturities`);
await p.waitForSelector('table.data tbody tr', { timeout: 15000 });
await pickEntity();
const matHead = await p.$$eval('table.data thead th', (th) => th.map((h) => h.textContent.trim()));
check('no carried-interest column is left behind',
  !matHead.some((h) => /carr(y|ied)/i.test(h)), matHead.join(' | '));
check('and no button to reveal one',
  (await p.locator('#carryBtn').count()) === 0);
check('the headings are the ones we expect',
  matHead.slice(0, 7).join('|').replace(/[↑↓]/g, '')
    === 'Matured|Last name|First name|Policy #|Carrier|Type|Owner',
  matHead.join(' | '));

console.log('\nTHE REGISTER SORTS BY WHICHEVER COLUMN IS CLICKED');
const col = async (name) => {
  const i = (await p.$$eval('table.data thead th',
    (th) => th.map((h) => h.textContent.replace(/[↑↓]/g, '').trim()))).indexOf(name);
  return p.$$eval(`table.data tbody tr td:nth-child(${i + 1})`,
    (tds) => tds.map((t) => t.textContent.trim()));
};
const clickHead = async (key) => {
  await p.click(`th[data-mat-key="${key}"]`);
  await p.waitForTimeout(700);
};
const surnames = () => col('Last name');

check('it opens on the most recent maturity',
  (await col('Matured')).length === 3, String((await col('Matured')).length));
await clickHead('insured_last');
const zToA = await surnames();
check('clicking a name column runs it Z to A first',
  zToA.join(' ').indexOf('Zephyr') < zToA.join(' ').indexOf('Alder'), zToA.join(' · '));
await clickHead('insured_last');
const aToZ = await surnames();
check('clicking it again turns it round',
  aToZ.join(' ').indexOf('Alder') < aToZ.join(' ').indexOf('Zephyr'), aToZ.join(' · '));
check('and the same policies are there either way',
  [...zToA].sort().join('|') === [...aToZ].sort().join('|'));

await clickHead('insured_first');
const firsts = await col('First name');
check('the forename sorts on its own, not with the surname',
  firsts[0] === 'Zane', firsts.join(' · '));

await clickHead('death_benefit');
const money = (await col('Death benefit')).map(dollars);
check('a money column sorts by value, largest first',
  money.every((v, i) => i === 0 || money[i - 1] >= v), money.join(' · '));
await clickHead('death_benefit');
const moneyUp = (await col('Death benefit')).map(dollars);
check('and reverses to smallest first',
  moneyUp.every((v, i) => i === 0 || moneyUp[i - 1] <= v), moneyUp.join(' · '));
check('sorting never changes the total underneath',
  near(money.reduce((s, v) => s + v, 0), moneyUp.reduce((s, v) => s + v, 0)));

const arrow = await p.$$eval('th[data-mat-key="death_benefit"] .arrow', (a) => a.length);
check('the column being sorted on says so with an arrow', arrow === 1, String(arrow));
check('and the card head repeats it in words',
  /sorted by death benefit, low to high/i.test(await p.textContent('.card-head')),
  (await p.textContent('.card-head')).trim().slice(0, 120));

const widths = await p.$$eval('table.data', (ts) => {
  const t = ts[ts.length - 1];
  return {
    head: t.querySelectorAll('thead th').length,
    body: t.querySelector('tbody tr')?.querySelectorAll('td').length || 0,
  };
});
check('head and body stay in step', widths.head === widths.body,
  `${widths.head} vs ${widths.body}`);

console.log('\nA MANAGER IS NOT OFFERED IT AT ALL');
// A context of its own — sharing this one would arrive already signed in.
const ctx2 = await br.newContext({ viewport: { width: 1500, height: 1000 } });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => errs.push(e.message));
await signIn(p2, MANAGER1);
const mgrNav = await navLabels(p2);
check('no Carried interest button', !mgrNav.some((t) => /carried interest/i.test(t)),
  mgrNav.join(' · '));
await p2.goto(`${BASE}/#/carry`);
await p2.waitForTimeout(1200);
const mgrView = ((await p2.textContent('#app')) || '').trim();
check('and typing the address in gets them nowhere useful',
  !/carried interest/i.test(mgrView), mgrView.slice(0, 90));

await p.goto(`${BASE}/#/carry`);
await p.waitForTimeout(1200);
await p.screenshot({ path: `${S}/carry-page.png`, fullPage: true });
check('no page errors anywhere', errs.length === 0, errs.slice(0, 3).join(' | '));

await ctx2.close();
await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL CARRY SCREEN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
