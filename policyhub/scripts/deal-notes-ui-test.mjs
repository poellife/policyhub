/* =====================================================================
   Deal notes, on screen.

   The API suite proves who is sent them. What is under test here is that
   there is somewhere obvious to put them, that an administrator can see
   the place even before anything is written in it, and that for a
   manager the box and the card are absent rather than greyed out — a
   disabled box that silently saves nothing is worse than no box.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'DEALNOTEUI';
const PRIVATE = 'Seller turned down 19% in March. Do not reopen above 21.';
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

const mgrCookie = await login(MANAGER1.email, MANAGER1.password);
const mgrFunds = (await json(await fetch(`${BASE}/api/funds`,
  { headers: { Cookie: mgrCookie } }))) || [];
const fund = mgrFunds[0];
if (!fund) { console.log('  FAIL  the manager has an owner entity to test inside'); process.exit(1); }

const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 1500000, fund_id: fund.id, status: 'Open',
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Ada', insured_dob: '1942-03-02',
  le_months: 72, asking_price: 300000, annual_premium: 40000 } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
const signIn = async (who) => {
  await ctx.clearCookies();
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });
};
const cards = () => p.locator('.card-head h2')
  .evaluateAll((els) => els.map((e) => e.textContent.trim()));

await signIn(ADMIN);
await p.goto(`${BASE}/#/opportunity/${deal.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(900);

console.log('THE ADMINISTRATOR SEES THE PLACE BEFORE IT HAS ANYTHING IN IT');
const empty = await cards();
check('there is a Deal notes card on a deal with none written', empty.includes('Deal notes'),
  empty.join(' | '));
const emptyText = (await p.locator('.card:has(h2:text-is("Deal notes"))').innerText())
  .replace(/\s+/g, ' ');
check('and it says so plainly rather than sitting blank',
  /Nothing written yet/i.test(emptyText), emptyText.slice(0, 120));
check('and it says who it is for', /administrators only/i.test(emptyText));

console.log('\nAND WRITES THEM IN THE EDIT FORM');
await p.click('#editOppBtn');
await p.waitForSelector('dialog[open] textarea[name="deal_notes"]', { timeout: 20000 });
const form = (await p.locator('dialog[open]').innerText()).replace(/\s+/g, ' ');
check('the form warns that this one is not for anybody else',
  /not visible to managers or editors/i.test(form), form.slice(-260));
check('and the investors’ notes are still their own box',
  await p.locator('dialog[open] textarea[name="notes"]').count() === 1);
await p.fill('dialog[open] textarea[name="deal_notes"]', PRIVATE);
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2000);
const written = (await p.locator('.card:has(h2:text-is("Deal notes"))').innerText());
check('what was typed comes back on the card', written.includes('Do not reopen above 21'),
  written.replace(/\s+/g, ' ').slice(0, 140));

console.log('\nFOR A MANAGER THERE IS NO CARD AND NO BOX');
await signIn(MANAGER1);
await p.goto(`${BASE}/#/opportunity/${deal.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(900);
check('the manager is on the deal, which is the point',
  (await p.locator('.page-head').innerText()).includes(PREFIX), '');
check('no Deal notes card', !(await cards()).includes('Deal notes'), (await cards()).join(' | '));
check('and the words are not in the page source either',
  !(await p.content()).includes('reopen above 21'));
if (await p.locator('#editOppBtn').count()) {
  await p.click('#editOppBtn');
  await p.waitForSelector('dialog[open]', { timeout: 20000 });
  check('nor a box for them in his edit form',
    await p.locator('dialog[open] textarea[name="deal_notes"]').count() === 0);
  check('though he still has the investors’ notes',
    await p.locator('dialog[open] textarea[name="notes"]').count() === 1);
  await p.keyboard.press('Escape');
}

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All deal notes UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
