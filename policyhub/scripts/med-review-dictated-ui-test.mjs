/* =====================================================================
   Writing the doctor's answer down, on screen.

   The API suite proves what the record holds. What is under test here
   is that somebody on the telephone can find the button while the call
   is still going on, that the form asks for the number first because
   that is the order he will say it in, and — the part that matters —
   that once it is saved every screen showing the estimate also says who
   typed it. An estimate whose provenance is only in the database is an
   estimate nobody can defend in a meeting.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'MEDDICTUI';
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
  for (const u of ((await json(await api('/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX.toLowerCase())))
    await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();

const doctor = await json(await api('/users', { method: 'POST', body: {
  email: `${PREFIX.toLowerCase()}-doctor@example.test`, password: scratchPassword('meddictui'),
  full_name: 'Dr H Telephone', role: 'medical' } }));
const funds = await json(await api('/funds'));
/* A case that already carries an estimate, so that writing the answer
   down does not adopt it and close the review — the screen under test
   is the one with the answer on it and the button still there. */
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Lincoln', product_type: 'UL',
  face_amount: 3000000, asking_price: 700000, annual_premium: 40000,
  fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Phonedin', insured_first_name: 'Ada', insured_dob: '1944-02-02',
  insured_gender: 'F', insured_state: 'MI',
  le_months: 72, le_provider: '21st Services', le_date: '2026-02-02' } }));
const rev = await json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: deal.id, reviewer_id: doctor.id, ask: 'The kidney picture.' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });

console.log('THE BUTTON IS THERE WHILE THE CASE IS STILL OUT');
await p.goto(`${BASE}/#/med-review/${rev.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(900);
check('the review screen offers to take his answer down',
  await p.locator('#medRecord').count() === 1,
  (await p.locator('#medRecord').count()) ? '' : (await p.locator('.main, body')
    .first().innerText()).replace(/\s+/g, ' ').slice(0, 200));
check('and says what it is for',
  /over the telephone/i.test(await p.locator('.main, body').first().innerText()));

console.log('\nAND THE FORM ASKS FOR THE NUMBER FIRST');
await p.click('#medRecord');
await p.waitForSelector('dialog[open] input[name="le_months"]', { timeout: 20000 });
const form = (await p.locator('dialog[open]').innerText()).replace(/\s+/g, ' ');
check('it is addressed to the right doctor', /Telephone/.test(form), form.slice(0, 120));
check('there is a box for his reasoning',
  await p.locator('dialog[open] textarea[name="findings"]').count() === 1);
check('one for what he suggests',
  await p.locator('dialog[open] select[name="recommendation"]').count() === 1);
check('and one for how the answer came in',
  await p.locator('dialog[open] input[name="recorded_how"]').count() === 1);
check('and it is honest about whose handwriting this is',
  /you<\/strong> wrote it down|you wrote it down/i.test(form)
  || /mistakes your handwriting for his/i.test(form), form.slice(0, 300));

await p.fill('dialog[open] input[name="le_months"]', '41');
await p.fill('dialog[open] textarea[name="findings"]',
  'Reading the creatinine trend rather than the stage.');
await p.selectOption('dialog[open] select[name="recommendation"]', 'Proceed');
await p.fill('dialog[open] input[name="recorded_how"]', 'By telephone, this afternoon');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2200);

console.log('\nAND AFTERWARDS EVERY SCREEN SAYS WHO TYPED IT');
const detail = (await p.locator('.main, body').first().innerText()).replace(/\s+/g, ' ');
check('the estimate is on the review screen', /41 months/.test(detail), detail.slice(0, 200));
check('with who wrote it down', /Written down by/i.test(detail));
check('and how it came in', /By telephone, this afternoon/.test(detail));
check('and that the estimate is still his', /did not type it himself/i.test(detail));

await p.goto(`${BASE}/#/opportunity/${deal.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1200);
const panel = (await p.locator('.card:has(h2:text-is("Medical review"))').innerText())
  .replace(/\s+/g, ' ');
check('the deal’s own panel carries the same sentence',
  /How this was taken/i.test(panel) && /By telephone, this afternoon/.test(panel),
  panel.slice(0, 260));
check('and the button now offers to correct it',
  /Change what you took down/i.test(panel));

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All dictated review UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
