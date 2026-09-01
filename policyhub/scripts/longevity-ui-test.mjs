/* =====================================================================
   The longevity risk bench — on screen.

   The score is arithmetic and is tested apart from any of this, without
   a server. What is under test here is the screen: that it exists for an
   administrator and for nobody else, that it scores what is typed into
   it, that the bench accumulates and adds up — and, most of all, that it
   is genuinely SEPARATE.

   That last one is the point of the feature as asked for, so it is
   tested as hard as the rest: the judgements underneath this are new,
   and until they have earned their place they must not be able to mark
   the record. So the panel must be absent from every policy and every
   deal, the chip absent from the list, the card absent from the
   dashboard, and the API must still refuse to store a category on
   anything.

   Idempotent: the bench lives in browser storage and the context is
   thrown away; one fixture policy is made and removed.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'LONGUI';
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

const funds = await json(await api('/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(`/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const opp = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Separate Life', product_type: 'IUL',
  face_amount: 9000000, insured_last_name: 'Apart', insured_first_name: 'Ada',
  insured_dob: '1954-02-11', insured_gender: 'F', insured_state: 'MI', le_months: 156,
  asking_price: 2200000, annual_premium: 140000, expected_close: '2026-12-31',
  offer_closes_on: '2027-06-30', fund_id: lcg1.id,
  impairments: 'Cardiovascular: CAD s/p 4 stents (2022)' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (who) => {
  const ctx = await br.newContext({ viewport: { width: 1480, height: 1200 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));
  await page.goto(BASE);
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.kpi-row', { timeout: 20000 });
  return page;
};
const p = await open(ADMIN);

/* ------------------------------------------------------------------ *
 * It is its own screen
 * ------------------------------------------------------------------ */
console.log('A SCREEN OF ITS OWN');
check('the menu offers it to an administrator',
  await p.locator('nav a', { hasText: 'Longevity' }).count() === 1);
await p.click('nav a:has-text("Longevity")');
await p.waitForSelector('h1:has-text("Longevity risk")', { timeout: 20000 });
await p.waitForTimeout(700);
check('and it says up front that it is not connected to anything',
  /not connected to any policy or opportunity/i.test(await p.locator('.notice-box').innerText()));
check('and that it is a screen rather than a model',
  /screen, not a model/i.test(await p.locator('.notice-box').innerText()));

/* ------------------------------------------------------------------ *
 * It scores what is typed in
 * ------------------------------------------------------------------ */
console.log('\nIT SCORES WHAT IS TYPED INTO IT');
const badge = () => p.locator('#lgOut .risk-badge').innerText();
const bars = () => p.locator('#lgOut .risk-row .risk-label').allTextContents();
check('three risks are shown apart, not collapsed into one number',
  (await bars()).join('|') === 'Duration|Tail|Breakthrough', (await bars()).join('|'));

await p.fill('#lgAge', '80'); await p.selectOption('#lgSex', 'M');
await p.fill('#lgLe', '48'); await p.selectOption('#lgCat', 'renal');
await p.waitForTimeout(400);
const good = await badge();
await p.fill('#lgLe', '160'); await p.selectOption('#lgCat', 'cardiometabolic');
await p.selectOption('#lgSex', 'F');
await p.waitForTimeout(400);
const bad = await badge();
check('a short dialysis case scores low', /Low|Moderate/.test(good), good);
check('a long cardiometabolic one scores high', /High|Elevated/.test(bad), bad);
check('and it re-reads as you type rather than on a button',
  parseInt(bad, 10) > parseInt(good, 10), `${good} → ${bad}`);
check('the reasoning is spelled out, not just the number',
  (await p.locator('#lgOut .risk-why li').count()) >= 3);

console.log('\nIT WILL READ THE BULLETS, BUT ONLY AS A SUGGESTION');
await p.selectOption('#lgCat', '');
await p.fill('#lgText', 'Renal: ESRD on hemodialysis since 2023');
await p.waitForTimeout(500);
check('pasted bullets are read into a category',
  /Reads as End-stage renal/i.test(await p.locator('#lgRead').innerText()),
  await p.locator('#lgRead').innerText());
check('and it says which phrase decided it',
  /ESRD/.test(await p.locator('#lgRead').innerText()));
await p.selectOption('#lgCat', 'neuro');
await p.waitForTimeout(400);
check('a chosen category silences the suggestion rather than arguing with it',
  (await p.locator('#lgRead').innerText()).trim() === '',
  await p.locator('#lgRead').innerText());
check('and the reading follows the choice',
  /Neurodegenerative/i.test(await p.locator('#lgOut').innerText()));

console.log('\nUNRECOGNISED TEXT IS SAID TO BE UNRECOGNISED, NOT GUESSED AT');
await p.selectOption('#lgCat', '');
await p.fill('#lgText', 'Patient is generally unwell');
await p.waitForTimeout(500);
check('it admits it read nothing',
  /Nothing recognised/i.test(await p.locator('#lgRead').innerText()),
  await p.locator('#lgRead').innerText());

/* ------------------------------------------------------------------ *
 * The bench
 * ------------------------------------------------------------------ */
console.log('\nTHE BENCH ADDS UP');
await p.fill('#lgText', '');
const add = async (label, age, sex, le, cat, cost) => {
  await p.fill('#lgLabel', label); await p.fill('#lgAge', age);
  await p.selectOption('#lgSex', sex); await p.fill('#lgLe', le);
  await p.selectOption('#lgCat', cat); await p.fill('#lgCost', cost);
  await p.click('#lgAdd'); await p.waitForTimeout(600);
};
await add('Big cardio', '74', 'M', '156', 'cardiometabolic', '3000000');
await add('Small dialysis', '81', 'F', '90', 'renal', '500000');
check('cases land on the bench', await p.locator('[data-lg-drop]').count() === 2,
  String(await p.locator('[data-lg-drop]').count()));
check('each carries its own three numbers and a composite',
  await p.locator('tbody tr .risk-chip').count() === 2);

const conc = p.locator('.card:has(h2:text-is("Where the bench is concentrated"))');
check('two cases are enough for a shape', await conc.count() === 1);
const concText = (await conc.innerText()).replace(/\s+/g, ' ');
check('weighted by cost rather than by head count — 3M against 500k is 85.7%',
  /85\.7%/.test(concText), concText.slice(0, 200));
check('and the pipeline-heavy concentration is flagged',
  /Cardiometabolic.*over 30%/is.test(concText), concText.slice(-200));

console.log('\nAND SURVIVES A RELOAD, IN THIS BROWSER ONLY');
await p.reload();
await p.waitForSelector('h1:has-text("Longevity risk")', { timeout: 20000 });
await p.waitForTimeout(800);
check('the bench is still there after a reload',
  await p.locator('[data-lg-drop]').count() === 2);
check('and it says where it is kept',
  /this browser only/i.test(
    await p.locator('.card:has(h2:text-is("The bench")) .card-head').innerText()),
  await p.locator('.card:has(h2:text-is("The bench")) .card-head').innerText());

const fresh = await open(ADMIN);
await fresh.goto(`${BASE}/#/longevity`);
await fresh.waitForSelector('h1', { timeout: 20000 });
await fresh.waitForTimeout(700);
check('but it is not the firm’s data — another browser starts empty',
  await fresh.locator('[data-lg-drop]').count() === 0);

await p.locator('[data-lg-drop]').first().click();
await p.waitForTimeout(700);
check('a case can be taken off again', await p.locator('[data-lg-drop]').count() === 1);

/* ------------------------------------------------------------------ *
 * It is genuinely separate
 * ------------------------------------------------------------------ */
console.log('\nIT TOUCHES NOTHING ELSE — WHICH IS THE POINT');
await p.goto(`${BASE}/#/opportunity/${opp.id}`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(900);
check('no risk panel on a deal',
  await p.locator('.card:has(h2:text-is("Longevity risk"))').count() === 0);
check('and the deal is otherwise unchanged — the valuations panel is still there',
  await p.locator('.card:has(h2:text-is("Valuations"))').count() === 1);

await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(800);
check('no score chip on the opportunities list',
  !/LR \d+/.test(await p.locator('body').innerText()));

await p.goto(`${BASE}/#/dashboard`);
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.waitForTimeout(1100);
check('no concentration card on the dashboard',
  await p.locator('.card:has(h2:text-is("Longevity risk by impairment"))').count() === 0);

const pols = await json(await api('/policies'));
await p.goto(`${BASE}/#/policy/${pols[0].id}`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(900);
check('no risk panel on a policy',
  await p.locator('.card:has(h2:text-is("Longevity risk"))').count() === 0);

console.log('\nAND THE API STILL HAS NOWHERE TO PUT A CATEGORY');
const stored = await api(`/opportunities/${opp.id}`, {
  method: 'PUT', body: { impairment_category: 'renal' } });
const back = await json(await api(`/opportunities/${opp.id}`));
check('a category sent to an opportunity is ignored, not stored',
  back.impairment_category === undefined, JSON.stringify(back.impairment_category));
check('there is no such field to write, so the update has nothing in it',
  stored.status === 400 && /No fields supplied/i.test((await json(stored))?.error || ''),
  String(stored.status));
const pBack = await json(await api(`/policies/${pols[0].id}`));
check('and a policy has no such field either',
  pBack.impairment_category === undefined, JSON.stringify(pBack.impairment_category));

/* ------------------------------------------------------------------ *
 * Administrators only
 * ------------------------------------------------------------------ */
console.log('\nADMINISTRATORS ONLY');
for (const [who, what] of [[MANAGER1, 'a manager'], [INVESTOR1, 'an investor']]) {
  const other = await open(who);
  check(`${what} has no Longevity tab`,
    await other.locator('nav a', { hasText: 'Longevity' }).count() === 0);
  await other.goto(`${BASE}/#/longevity`);
  await other.waitForTimeout(1000);
  check(`and ${what} typing the address in does not get the bench`,
    await other.locator('#lgAdd').count() === 0);
  check(`${what} is told why rather than shown a blank`,
    /kept to administrators/i.test(await other.locator('body').innerText()));
}

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All longevity bench UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
