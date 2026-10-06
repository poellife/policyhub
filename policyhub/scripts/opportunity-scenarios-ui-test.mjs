/* =====================================================================
   Scenarios, on screen.

   The API suite proves what the figures are. What is under test here is
   that the comparison is legible — the deal first, every variant read
   against it, and what each one actually changed in black against what
   it borrowed in grey — and that choosing one is a deliberate act with
   the consequence named before it happens.

   And the other side of it: that an investor gets a case rather than a
   menu, told which case it is and never shown the rest.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'OPPSCENUI';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const me = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: invCookie } })))
  .investor.id;
const funds = await json(await api('/funds'));
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 2000000, fund_id: funds[0].id, status: 'Open',
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Ada', insured_dob: '1942-03-02',
  insured_gender: 'F', insured_state: 'MI',
  le_months: 72, le_provider: '21st Services', le_date: '2026-02-02',
  asking_price: 300000, annual_premium: 40000 } }));
await api(`/opportunities/${deal.id}/shares`, { method: 'PUT', body: { investor_ids: [me] } });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
/* One handler for the whole page: two race each other and hang. */
let answer = true;
p.on('dialog', (d) => (answer ? d.accept() : d.dismiss()));
const signIn = async (who) => {
  await ctx.clearCookies();
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });
};
const card = () => p.locator('.card:has(h2:text-is("Scenarios"))');
const open = async () => {
  await p.goto(`${BASE}/#/opportunity/${deal.id}`);
  await p.waitForSelector('.page-head', { timeout: 20000 });
  await p.waitForTimeout(1200);
};

await signIn(ADMIN);
await open();

console.log('THE DEAL IS THE FIRST ROW, AND IT IS NOT A SCENARIO');
check('there is a Scenarios card', await card().count() === 1);
const bare = (await card().innerText()).replace(/\s+/g, ' ');
check('with the deal on it before anything has been added',
  /The deal as it stands/.test(bare), bare.slice(0, 160));
check('and nothing to delete on that row',
  await card().locator('tbody tr').first().locator('[data-scen-rm]').count() === 0);

console.log('\nONE IS ADDED FROM THE CARD');
await card().locator('#scenAddBtn').click();
await p.waitForSelector('dialog[open] input[name="le_months"]', { timeout: 20000 });
const form = (await p.locator('dialog[open]').innerText()).replace(/\s+/g, ' ');
check('the form asks for a name, an LE and a price',
  await p.locator('dialog[open] input[name="name"]').count() === 1
  && await p.locator('dialog[open] input[name="asking_price"]').count() === 1);
check('and says an empty box means the deal’s own figure',
  /Leave a box empty and the deal's own figure is used/i.test(form), form.slice(0, 260));
check('and that none of it touches the deal',
  /Nothing here touches the deal/i.test(form));
await p.fill('dialog[open] input[name="name"]', 'If he lives to 96 months');
await p.fill('dialog[open] input[name="le_months"]', '96');
await p.fill('dialog[open] textarea[name="note"]', 'The cardiology reads better than 21st.');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2000);

await card().locator('#scenAddBtn').click();
await p.waitForSelector('dialog[open] input[name="asking_price"]', { timeout: 20000 });
await p.fill('dialog[open] input[name="name"]', 'If we get him to 260');
await p.fill('dialog[open] input[name="asking_price"]', '260000');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2000);

const rows = () => card().locator('tbody tr');
check('both are on the card beneath the deal', await rows().count() === 3,
  String(await rows().count()));
const body = (await card().innerText()).replace(/\s+/g, ' ');
check('each carries its own return', (body.match(/%/g) || []).length >= 3, body.slice(0, 300));
check('and the note explaining why it is worth looking at',
  /cardiology reads better/.test(body));
/* What a scenario borrowed from the deal is set in grey, so the eye
   lands on what it actually changed. */
const borrowed = await rows().nth(2).locator('td .muted').count();
check('a figure borrowed from the deal is set apart from one that changed',
  borrowed >= 1, String(borrowed));

console.log('\nCHOOSING ONE NAMES THE CONSEQUENCE BEFORE IT HAPPENS');
await rows().nth(2).locator('input[name=scenShown]').check();
await p.waitForTimeout(2200);
const chosen = (await card().innerText()).replace(/\s+/g, ' ');
check('the card says who is being shown what',
  /Investors are currently shown .*If we get him to 260/.test(chosen), chosen.slice(-220));
check('and the row is marked', await card().locator('tr.scen-shown').count() === 1);

console.log('\nTHE INVESTOR GETS A CASE, NOT A MENU');
await signIn(INVESTOR1);
await open();
const theirs = (await p.locator('.main, body').first().innerText()).replace(/\s+/g, ' ');
check('no Scenarios card for them', await card().count() === 0);
check('they are told which case these figures are',
  /These figures are the If we get him to 260 case/.test(theirs), theirs.slice(0, 400));
check('and the price they read is the scenario’s',
  /\$260,000/.test(theirs) && !/\$300,000/.test(theirs),
  `${/\$260,000/.test(theirs)} / ${/\$300,000/.test(theirs)}`);
check('and none of the other cases is anywhere on the page',
  !(await p.content()).includes('cardiology reads better'));

console.log('\nAND THE DESK CAN PUT THEM BACK');
await signIn(ADMIN);
await open();
await rows().nth(0).locator('input[name=scenShown]').check();
await p.waitForTimeout(2200);
check('the card says so', /Investors are currently shown the deal as it stands/
  .test((await card().innerText()).replace(/\s+/g, ' ')));
check('and no row is marked any more', await card().locator('tr.scen-shown').count() === 0);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All opportunity scenario UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
