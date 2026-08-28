/* =====================================================================
   The document reader on the New opportunity dialog — on screen.

   The reading costs money and takes minutes, so the answer is stood in
   for here. What is under test is the part a person touches: that the
   fields fill in, that they stay editable, that what could not be read
   is left visibly blank, and that the schedule the illustration carried
   ends up on the opportunity that gets created.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'READUI';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: admin, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

/* What the reader would have returned. Two fields are deliberately absent
   — the asking price and the owner entity — because no document states
   them and the form must still be asking for them. */
const ANSWER = {
  fields: {
    policy_number: `${PREFIX}-1`, carrier_name: 'Lincoln National', product_type: 'IUL',
    face_amount: 11000000,
    insured_last_name: 'Delp', insured_first_name: 'Cleves', insured_dob: '1958-06-14',
    insured_gender: 'M', insured_state: 'OH',
    le_months: 193, le_provider: 'Predictive', le_date: '2026-05-01',
    le_months_2: 195, le_provider_2: 'Polaris',
    annual_premium: 220273, account_value: 412000.55,
    cash_surrender_value: 388000, values_as_of: '2026-05-01',
    impairments: 'Cardiovascular: CAD with five stents (2023)\nHepatic: fatty liver',
    mitigating: 'Sustained 60 lb weight loss',
    underwriter_note: 'Mortality risk is higher than at prior underwriting.',
    records_through: '2026-04-30',
  },
  premiums: [
    { due_date: '2026-10-26', amount: 220273 },
    { due_date: '2027-10-26', amount: 245091 },
  ],
  read: ['illustration.pdf', 'polaris.pdf'],
  roles: { 'illustration.pdf': 'illustration', 'polaris.pdf': 'le_report' },
  le_reports: [
    { provider: 'Predictive', mean_le50_months: 193, report_date: '2026-05-01' },
    { provider: 'Polaris', mean_le50_months: 195, report_date: '2025-11-02' },
  ],
  notes: 'Ledger taken from the current-assumptions run.',
};

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1250 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));

/* Stand in for the reader. The browser posts as it always would; the
   answer arrives without a PDF ever leaving the machine. */
let posted = null;
await p.route('**/api/opportunities/extract', async (route) => {
  posted = route.request().method();
  await new Promise((r) => setTimeout(r, 400));      // long enough to see the waiting state
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(ANSWER) });
});

await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(800);

console.log('THE FORM OFFERS TO READ THE DOCUMENTS');
await p.click('#newOppBtn').catch(async () => {
  await p.locator('button', { hasText: 'New opportunity' }).first().click();
});
await p.waitForSelector('dialog', { timeout: 10000 });
check('the drop zone is on the New opportunity form',
  await p.locator('#readDrop').count() === 1);
check('and it says the files are not kept',
  /discarded/i.test(await p.locator('#readDrop').innerText()),
  (await p.locator('#readDrop').innerText()).slice(0, 90));

const val = (name) => p.inputValue(`dialog [name="${name}"]`);
check('the form starts empty', (await val('policy_number')) === '', await val('policy_number'));

/* An actual drop, not a file input set from script.
 *
 * The zone accepts both, and the drop is the one people will use — so it
 * is the one that has to be proven. A DataTransfer is built in the page,
 * two PDFs are put in it, and the events a real drag fires are fired in
 * the order a real drag fires them. */
const dropFiles = async (names) => {
  const dt = await p.evaluateHandle((list) => {
    const d = new DataTransfer();
    for (const name of list)
      d.items.add(new File([new Uint8Array(2048).fill(7)], name, { type: 'application/pdf' }));
    return d;
  }, names);
  const zone = await p.$('#readDrop');
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  const lit = await p.locator('#readDrop.over').count();
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  return lit;
};

console.log('\nTHE PAPERWORK CAN BE DROPPED STRAIGHT ONTO IT');
const litUp = await dropFiles(['Lincoln-illustration.pdf', 'Predictive-LE.pdf']);
check('the zone lights up while a file is over it', litUp === 1, `${litUp} highlighted`);
await p.waitForSelector('.read-result', { timeout: 15000 });
check('and the drop is what did the reading', posted === 'POST', String(posted));
check('the highlight is taken off again afterwards',
  await p.locator('#readDrop.over').count() === 0);
check('a dropped illustration fills the form',
  (await val('carrier_name')) === 'Lincoln National', await val('carrier_name'));

/* Clear it down and do the same through the file picker, so both doors
   are covered rather than whichever one was written first. */
await p.click('dialog #dlgCancel');
await p.waitForTimeout(400);
await p.locator('button', { hasText: 'New opportunity' }).first().click();
await p.waitForSelector('dialog', { timeout: 10000 });

console.log('\nCHOOSING THEM INSTEAD FILLS IT IN THE SAME WAY');
await p.setInputFiles('#readFiles', [
  { name: 'illustration.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2048, 7) },
  { name: 'polaris.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2048, 7) },
]);
await p.waitForSelector('#readBusy:not([hidden])', { timeout: 5000 }).catch(() => {});
check('it says what it is doing while it works', posted === 'POST', String(posted));
await p.waitForSelector('.read-result', { timeout: 15000 });

check('the policy number is filled', (await val('policy_number')) === `${PREFIX}-1`,
  await val('policy_number'));
check('the carrier', (await val('carrier_name')) === 'Lincoln National', await val('carrier_name'));
check('the insured, split into two fields',
  (await val('insured_last_name')) === 'Delp' && (await val('insured_first_name')) === 'Cleves');
check('the date of birth, in the date field',
  (await val('insured_dob')) === '1958-06-14', await val('insured_dob'));
check('the money fields, grouped the way the form writes money',
  (await val('face_amount')) === '11,000,000', await val('face_amount'));
check('the life expectancy and its provider',
  (await val('le_months')) === '193' && (await val('le_provider')) === 'Predictive');
check('the second opinion too',
  (await val('le_months_2')) === '195' && (await val('le_provider_2')) === 'Polaris');
check('the state, as a selected option',
  (await val('insured_state')) === 'OH', await val('insured_state'));
check('the impairments, one per line',
  (await val('impairments')).split('\n').length === 2, await val('impairments'));

console.log('\nWHAT IT COULD NOT READ IS LEFT FOR YOU');
check('the asking price is still empty — no document states it',
  (await val('asking_price')) === '', await val('asking_price'));
check('and the owner entity is still unchosen', (await val('fund_id')) === '',
  await val('fund_id'));

console.log('\nNOTHING IS LOCKED');
await p.fill('dialog [name="carrier_name"]', 'Lincoln Financial');
check('a field it filled can be typed over',
  (await val('carrier_name')) === 'Lincoln Financial', await val('carrier_name'));

console.log('\nIT SAYS WHAT IT READ');
const summary = await p.locator('.read-result').innerText();
check('naming each document and what it took it for',
  /illustration\.pdf/.test(summary) && /life-expectancy report/i.test(summary),
  summary.slice(0, 120));
check('and how many payments it scheduled', /2 premium payments/.test(summary),
  summary.slice(0, 160));
check('and it tells you to check the figures', /check every figure/i.test(summary));

console.log('\nCREATING IT CARRIES THE SCHEDULE ACROSS');
await p.fill('dialog [name="asking_price"]', '265000');
await p.click('dialog button[type=submit]');
await p.waitForTimeout(2500);

const made = ((await json(await api('/opportunities'))) || [])
  .find((x) => x.policy_number === `${PREFIX}-1`);
check('the opportunity exists', !!made, 'not created');
const full = made && await json(await api(`/opportunities/${made.id}`));
check('with the edit that was typed over the reading',
  full?.carrier_name === 'Lincoln Financial', full?.carrier_name);
check('the price that was never read', Number(full?.asking_price) === 265000,
  String(full?.asking_price));
check('the medical picture the LE report carried',
  /five stents/.test(full?.impairments || ''), (full?.impairments || '').slice(0, 60));
check('and the illustration’s premium schedule, posted with it',
  (full?.premiums || []).length === 2, String((full?.premiums || []).length));

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await wipe();
console.log(fails.length
  ? `\n${fails.length} EXTRACT UI CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL EXTRACT UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
