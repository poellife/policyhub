/* =====================================================================
   The two folders, on screen.

   The API suite proves who is sent which link. What is under test here
   is that the difference is legible at the moment somebody fills the
   fields in — two boxes, each saying plainly who gets it — and that the
   investor's own screen shows one folder and calls it what it is.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'INVFOLDUI';
const CASEFOLDER = 'https://www.dropbox.com/scl/fo/invfoldui-case-0001';
const INVFOLDER = 'https://www.dropbox.com/scl/fo/invfoldui-investor-7788';
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

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(`/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
};
await wipe();

const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const me1 = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: invCookie } })))
  .investor.id;
const funds = await json(await api('/funds'));
const policy = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: funds[0]?.code, face_amount: 2000000,
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Ada', dob: '1940-01-01' } }));
await api(`/policies/${policy.id}/investors`, { method: 'POST', body: {
  investor_id: me1, pct: 100, acquired_on: '2024-01-01' } });

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

await signIn(ADMIN);
await p.goto(`${BASE}/#/policy/${policy.id}`);
await p.waitForSelector('#editBtn', { timeout: 20000 });

console.log('THE FORM ASKS FOR BOTH, AND SAYS WHO GETS WHICH');
await p.click('#editBtn');
await p.waitForSelector('dialog[open] input[name="investor_url"]', { timeout: 20000 });
const form = (await p.locator('dialog[open]').innerText()).replace(/\s+/g, ' ');
check('there is a box for the case folder', 
  await p.locator('dialog[open] input[name="documents_url"]').count() === 1);
check('and one for the investors’ folder',
  await p.locator('dialog[open] input[name="investor_url"]').count() === 1);
check('the case folder says it is the office’s', /Staff only/i.test(form), form.slice(0, 200));
check('the investor one says what it is for and warns what goes in it',
  /investors who own a piece/i.test(form) && /only what you would hand over/i.test(form),
  form.slice(-300));
await p.fill('dialog[open] input[name="documents_url"]', CASEFOLDER);
await p.fill('dialog[open] input[name="investor_url"]', INVFOLDER);
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2000);

console.log('\nAND THE DESK SEES THEM AS TWO DIFFERENT THINGS');
/* Read the labels off the policy's own facts lists. The page chrome
   carries a Documents tab of its own, so matching the whole page would
   prove nothing about what the policy says. */
const labels = () => p.locator('dl.kv dt')
  .evaluateAll((els) => els.map((e) => e.textContent.trim()));
const deskLabels = await labels();
check('both are named on the policy', deskLabels.includes('Case files')
  && deskLabels.includes('Investor documents'), deskLabels.join(' | '));
const hrefs = await p.locator('a.ext-link').evaluateAll((els) => els.map((e) => e.href));
check('each points at its own folder',
  hrefs.includes(CASEFOLDER) && hrefs.includes(INVFOLDER), hrefs.join(' | '));

console.log('\nAND THE INVESTOR SEES ONE FOLDER, AND IT IS THEIRS');
await signIn(INVESTOR1);
await p.goto(`${BASE}/#/policy/${policy.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(900);
const theirPage = await p.content();
check('the investor folder is on their screen', theirPage.includes(INVFOLDER));
check('the case folder is not', !theirPage.includes(CASEFOLDER));
const theirLabels = await labels();
check('and it is simply called Documents, because they have only one',
  theirLabels.includes('Documents') && !theirLabels.includes('Case files')
  && !theirLabels.includes('Investor documents'), theirLabels.join(' | '));

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All investor folder UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
