/* =====================================================================
   Filing a price against the thing it priced — on screen.

   The API suite proves the link is made correctly. This proves a person
   can make it: that the runs are on a screen of their own, that both
   ends of the link have a button, and that what the desk paid the model
   to work out is never drawn on an investor's page.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import pg from 'pg';
import { chromium } from 'playwright';
import {
  BASE, ADMIN, INVESTOR1, login, databaseUrl,
} from './test-config.mjs';

const PREFIX = 'VALUI';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}, cookie = admin) => fetch(`${BASE}/api${path}`, {
  ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const db = new pg.Client({ connectionString: databaseUrl() });
await db.connect();

const funds = await json(await api('/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];

const wipe = async () => {
  await db.query('DELETE FROM valuations WHERE job LIKE $1', [`${PREFIX}%`]);
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(`/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const seedRun = async (suffix, over = {}) => {
  const v = { job: `${PREFIX}-${suffix}`, ran_at: '2026-08-02T09:30:00Z', ran_by: 'valtest',
    case_name: `${PREFIX.toLowerCase()}-${suffix}`, insured: 'Screened, Sam',
    face: 4000000, price: 812345, irr: 14.5, mode: 'IRR', target: 14.5, mean_le: 84, ...over };
  await db.query(
    `INSERT INTO valuations (job, ran_at, ran_by, case_name, insured, face, price, irr,
                             mode, target, mean_le)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [v.job, v.ran_at, v.ran_by, v.case_name, v.insured, v.face, v.price, v.irr,
     v.mode, v.target, v.mean_le]);
  return v.job;
};

const jA = await seedRun('A');
const jB = await seedRun('B', { insured: 'Second, Sal', price: 431000 });

const opp = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Screened Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: 'Screened', insured_first_name: 'Sam',
  insured_dob: '1946-01-20', insured_gender: 'M', insured_state: 'MI',
  le_months: 84, asking_price: 812000, annual_premium: 61000,
  expected_close: '2026-11-30', offer_closes_on: '2027-05-31', fund_id: lcg1.id } }));

const pol = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-2`, carrier_name: 'Screened Life', product_type: 'UL',
  face_amount: 4000000, status: 'Inforce', fund_id: lcg1.id,
  insured_last_name: 'Screened', insured_first_name: 'Sam',
  insured_dob: '1946-01-20', insured_gender: 'M', insured_state: 'MI', le_months: 84,
  acquisition_date: '2026-03-01', acquisition_cost: 812000,
  premium_required: 61000, premium_mode: 'Annual' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1250 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));

const signIn = async (page, who) => {
  await page.goto(BASE);
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.kpi-row', { timeout: 20000 });
};

await signIn(p, ADMIN);

/* ------------------------------------------------------------------ *
 * The screen of runs
 * ------------------------------------------------------------------ */
console.log('THE RUNS HAVE A SCREEN OF THEIR OWN');
check('the menu offers it', await p.locator('nav a', { hasText: 'Valuation runs' }).count() > 0);
await p.click('nav a:has-text("Valuation runs")');
await p.waitForSelector('h1:has-text("Valuation runs")', { timeout: 20000 });
await p.waitForTimeout(600);

const rowFor = (job) => p.locator(`tr:has(button[data-attach="${job}"])`);
check('a seeded run is on it', await rowFor(jA).count() === 1);
const rowText = await rowFor(jA).innerText();
check('with its price', /\$812,345/.test(rowText), rowText.replace(/\s+/g, ' '));
check('and the terms it was priced on', /14\.5% IRR/.test(rowText), rowText.replace(/\s+/g, ' '));
check('and it is shown as attached to nothing yet',
  /not attached/i.test(rowText), rowText.replace(/\s+/g, ' '));
check('the heading counts what has not been filed',
  /not yet attached/i.test(await p.locator('.page-head .sub').innerText()),
  await p.locator('.page-head .sub').innerText());

/* ------------------------------------------------------------------ *
 * Attaching from the list
 * ------------------------------------------------------------------ */
console.log('\nATTACHING ONE FROM THE LIST');
await p.click(`button[data-attach="${jA}"]`);
await p.waitForSelector('dialog', { timeout: 10000 });
check('the dialog says what it is filing',
  /812,345/.test(await p.locator('dialog').innerText()),
  (await p.locator('dialog').innerText()).replace(/\s+/g, ' ').slice(0, 120));
check('it offers both ends of the link',
  await p.locator('dialog select[name="opportunity_id"]').count() === 1
  && await p.locator('dialog select[name="policy_id"]').count() === 1);

await p.selectOption('dialog select[name="opportunity_id"]', String(opp.id));
await p.click('dialog button[type=submit]');
await p.waitForSelector('dialog', { state: 'detached', timeout: 15000 });
await p.waitForTimeout(900);
const after = await rowFor(jA).innerText();
check('the list now says where it went',
  /Screened/.test(after) && !/not attached/i.test(after), after.replace(/\s+/g, ' '));
check('and offers to take it off again',
  await p.locator(`button[data-detach="${jA}"]`).count() === 1);

/* ------------------------------------------------------------------ *
 * The deal's own page
 * ------------------------------------------------------------------ */
console.log('\nAND IT IS ON THE DEAL');
await p.goto(`${BASE}/#/opportunity/${opp.id}`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(700);
const panel = p.locator('.card:has(h2:text-is("Valuations"))');
check('the deal carries a valuations panel', await panel.count() === 1);
check('with the run on it', /812,345/.test(await panel.innerText()),
  (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 140));

/* ------------------------------------------------------------------ *
 * Attaching from the record instead
 * ------------------------------------------------------------------ */
console.log('\nOR FILED FROM THE POLICY, THE OTHER WAY ROUND');
await p.goto(`${BASE}/#/policy/${pol.id}`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(700);
const pPanel = p.locator('.card:has(h2:text-is("Valuations"))');
check('the policy has the panel too', await pPanel.count() === 1);
check('and says plainly that nothing is filed yet',
  /Nothing attached yet/i.test(await pPanel.innerText()));

await p.click('#attachValBtn');
await p.waitForSelector('dialog', { timeout: 10000 });
const options = await p.locator('dialog select[name="job"] option').allTextContents();
check('the picker lists the runs that are free', options.some((o) => /Second, Sal/.test(o)),
  JSON.stringify(options));
check('and not the one already filed against the deal',
  !options.some((o) => /Screened, Sam/.test(o)), JSON.stringify(options));

await p.selectOption('dialog select[name="job"]', jB);
await p.click('dialog button[type=submit]');
await p.waitForSelector('dialog', { state: 'detached', timeout: 15000 });
await p.waitForTimeout(900);
const filed = await p.locator('.card:has(h2:text-is("Valuations"))').innerText();
check('the policy now carries it', /431,000/.test(filed), filed.replace(/\s+/g, ' ').slice(0, 140));

console.log('\nAND TAKEN OFF FROM THE SAME PLACE');
await p.click(`button[data-val-detach="${jB}"]`);
await p.waitForTimeout(1200);
check('the panel is empty again',
  /Nothing attached yet/i.test(
    await p.locator('.card:has(h2:text-is("Valuations"))').innerText()));

/* ------------------------------------------------------------------ *
 * The investor's copy
 * ------------------------------------------------------------------ */
console.log('\nAN INVESTOR IS NOT SHOWN THE DESK’S PRICING');
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const me = (await json(await api('/auth/me', {}, inv1))).investor.id;
await api(`/opportunities/${opp.id}/shares`, { method: 'PUT', body: { investor_ids: [me] } });

/* Its own context: a second page in this one is already signed in as the
   administrator, and would be testing the wrong person. */
const ictx = await br.newContext({ viewport: { width: 1500, height: 1250 } });
const ip = await ictx.newPage();
ip.on('pageerror', (e) => errs.push(e.message));
await signIn(ip, INVESTOR1);
check('an investor has no Valuation runs tab',
  await ip.locator('nav a', { hasText: 'Valuation runs' }).count() === 0);
await ip.goto(`${BASE}/#/opportunity/${opp.id}`);
await ip.waitForSelector('h1', { timeout: 20000 });
await ip.waitForTimeout(700);
check('and no valuations panel on the deal they were shown',
  await ip.locator('.card:has(h2:text-is("Valuations"))').count() === 0);
check('nor the price the model put on it',
  !/812,345/.test(await ip.locator('body').innerText()));

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
await db.end();

console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All valuation-attachment UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
