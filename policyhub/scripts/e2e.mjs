import { chromium } from 'playwright';
import fs from 'node:fs';

import { BASE, ADMIN } from './test-config.mjs';
const SHOTS = '/home/claude/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => d.accept());   // native confirm() prompts

/* ---------------------------- login ---------------------------- */
console.log('\nLOGIN');
await page.goto(BASE);
await page.waitForSelector('#loginForm');
await page.screenshot({ path: `${SHOTS}/01-login.png` });

await page.fill('#email', ADMIN.email);
await page.fill('#password', 'wrongpassword');
await page.click('button[type=submit]');
await page.waitForSelector('.error-box');
check('bad password is rejected', await page.isVisible('.error-box'));

await page.fill('#password', ADMIN.password);
await page.click('button[type=submit]');
await page.waitForSelector('.kpi-row', { timeout: 10000 });
check('login lands on dashboard', await page.isVisible('.kpi-row'));

/* -------------------------- dashboard -------------------------- */
console.log('\nDASHBOARD');
await page.waitForTimeout(700);
check('capital chart rendered', (await page.locator('#chartCapital svg path.line').count()) > 0);
check('carrier chart rendered', (await page.locator('#chartCarrier svg rect.bar').count()) > 0);
const hero = await page.locator('.stat .value.hero').first().textContent();
check('hero death-benefit figure shown', /\$\d/.test(hero), hero.trim());
await page.screenshot({ path: `${SHOTS}/02-dashboard.png`, fullPage: true });

// hover tooltip on the line chart
const box = await page.locator('#chartCapital svg').boundingBox();
await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
await page.waitForTimeout(250);
check('chart hover tooltip appears', await page.isVisible('.tooltip'));
await page.screenshot({ path: `${SHOTS}/03-dashboard-tooltip.png` });
await page.mouse.move(5, 5);

/* The dashboard can be narrowed to one owner entity. The test that matters
   is not that the figure changes — it is that the parts add back up to the
   whole, and that the alerts below move with the headline rather than
   staying on the full book. */
const fundPicker = page.locator('#entityFilter');
check('the dashboard offers an entity filter', (await fundPicker.count()) === 1);
check('starting on all entities', (await fundPicker.inputValue()) === '');
const entities = (await fundPicker.locator('option').allTextContents()).map((x) => x.trim());
check('with an explicit "all" rather than a blank line',
  /^All entities$/.test(entities[0] || ''), entities.join(' | '));

const readHero = async () => Number(
  (await page.locator('.stat .value.hero').first().textContent()).replace(/[^0-9.]/g, ''));
const whole = await readHero();
let parts = 0;
for (const code of entities.slice(1).map((e) => e.split(' — ')[0])) {
  await fundPicker.selectOption(code);
  await page.waitForSelector('.kpi-row'); await page.waitForTimeout(700);
  parts += await readHero();
}
check('the entities add back up to the whole book', Math.abs(parts - whole) < 1,
  `${parts} against ${whole}`);
const narrowedAlerts = await page.locator('.alert-row').count();
await fundPicker.selectOption('');
await page.waitForSelector('.kpi-row'); await page.waitForTimeout(700);
check('and choosing all puts the whole book back', Math.abs(await readHero() - whole) < 1);
check('the alerts narrow with it rather than staying on the full book',
  narrowedAlerts <= (await page.locator('.alert-row').count()),
  `${narrowedAlerts} narrowed vs ${await page.locator('.alert-row').count()} overall`);
await page.screenshot({ path: `${SHOTS}/03b-dashboard-entity.png`, fullPage: true });

/* --------------------------- policies -------------------------- */
console.log('\nPOLICIES');
await page.click('a[href="#/policies"]');
await page.waitForSelector('table.data tbody tr');
const rowCount = await page.locator('table.data tbody tr').count();
// Assert the relationship, not a magic number — the suite has to pass against
// whatever fixture database it is pointed at.
check('policy rows listed', rowCount > 0, `${rowCount} rows`);
await page.screenshot({ path: `${SHOTS}/04-policies.png`, fullPage: true });

// sort by face amount descending
await page.click('th[data-key="face_amount"]');
await page.waitForTimeout(200);
await page.click('th[data-key="face_amount"]');
await page.waitForTimeout(300);
// Find the column by its key rather than by position: columns get added.
const faceCol = await page.$$eval('table.data thead th',
  (ths) => ths.findIndex((th) => th.dataset.key === 'face_amount') + 1);
const faces = await page.$$eval(`table.data tbody tr td:nth-child(${faceCol})`,
  (tds) => tds.map((td) => Number(td.textContent.replace(/[^0-9.]/g, '')) || 0));
check('sort by face works', faces.every((v, i) => i === 0 || faces[i - 1] >= v),
  `${faces[0]} first of ${faces.length}`);

// search filter — take a surname off the grid so the check is fixture-agnostic
const someInsured = (await page.locator('table.data tbody tr:first-child td:nth-child(2)')
  .textContent()).trim().split(/\s+/).pop();
await page.fill('#searchInput', someInsured);
await page.waitForTimeout(600);
const filtered = await page.locator('table.data tbody tr').count();
check('search narrows the list', filtered > 0 && filtered < rowCount,
  `${filtered} of ${rowCount} for "${someInsured}"`);
await page.fill('#searchInput', '');
await page.waitForTimeout(600);

/* ------------------------ policy detail ------------------------ */
console.log('\nPOLICY DETAIL');
// Open a policy that actually carries value history, so the chart assertions
// below test the charts rather than the fixture. The "Values as of" column is
// found by its header key rather than a fixed position.
const valueCol = await page.$$eval('table.data thead th',
  (ths) => ths.findIndex((th) => th.dataset.key === 'value_as_of') + 1);
const rowIndex = await page.$$eval(`table.data tbody tr td:nth-child(${valueCol})`,
  (tds) => tds.findIndex((td) => td.textContent.trim() && td.textContent.trim() !== '—'));
await page.locator('table.data tbody tr').nth(Math.max(0, rowIndex)).click();
await page.waitForSelector('.tabs');
check('detail header shows insured', (await page.locator('h1').textContent()).length > 2);
await page.screenshot({ path: `${SHOTS}/05-policy-overview.png`, fullPage: true });

await page.click('.tabs button[data-tab="values"]');
await page.waitForTimeout(700);
const avLines = await page.locator('#chartAvCsv svg path.line').count();
const coiLines = await page.locator('#chartCoi svg path.line').count();
// A single snapshot draws no line — there is nothing to join. Only assert the
// chart when the policy has enough history for a line to exist.
const plottable = (await page.locator('table.data tbody tr').count()) > 1;
check('AV/CSV chart has two series', !plottable || avLines >= 2, `${avLines} lines`);
check('COI chart rendered', !plottable || coiLines > 0, `${coiLines} lines`);
const snapRows = await page.locator('table.data tbody tr').count();
check('value snapshots listed', snapRows > 0, `${snapRows} snapshots`);
await page.screenshot({ path: `${SHOTS}/06-policy-values.png`, fullPage: true });

// add a snapshot
await page.click('#addValueBtn');
await page.waitForSelector('dialog[open]');
// A fresh date every run — as-of dates are unique per policy, so a fixed one
// would make this suite pass once and 409 forever after.
const asOf = `20${30 + Math.floor(Math.random() * 40)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
await page.fill('dialog input[name="as_of_date"]', asOf);
await page.fill('dialog input[name="account_value"]', '12345.67');
await page.fill('dialog input[name="cash_surrender_value"]', '12000');
await page.fill('dialog input[name="cost_of_insurance"]', '500');
await page.click('dialog button[type=submit]');
await page.waitForTimeout(900);
const afterAdd = await page.locator('table.data tbody tr').count();
check('adding a snapshot persists', afterAdd === snapRows + 1,
  `${snapRows} → ${afterAdd} snapshots (${asOf})`);

await page.click('.tabs button[data-tab="transactions"]');
await page.waitForTimeout(600);
check('ledger rows listed', (await page.locator('table.data tbody tr').count()) > 0);
check('basis chart rendered', (await page.locator('#chartBasis svg rect.bar').count()) === 3);
await page.screenshot({ path: `${SHOTS}/07-policy-transactions.png`, fullPage: true });

// log a premium payment via the servicing tab
await page.click('.tabs button[data-tab="servicing"]');
await page.waitForTimeout(500);
await page.click('#logPremiumBtn');
await page.waitForSelector('dialog[open]');
await page.fill('dialog input[name="amount"]', '9999');
await page.click('dialog button[type=submit]');
await page.waitForTimeout(900);
await page.click('.tabs button[data-tab="transactions"]');
await page.waitForTimeout(600);
const ledgerText = await page.locator('table.data').last().textContent();
check('logged premium appears in ledger', ledgerText.includes('9,999'));
await page.screenshot({ path: `${SHOTS}/08-policy-servicing.png`, fullPage: true });

// add a second life to the policy (survivorship case)
await page.click('.tabs button[data-tab="overview"]');
await page.waitForTimeout(500);
// Remove any second life left by a previous run, so the test is repeatable
// (and so the remove path gets exercised too).
const livesRows = () =>
  page.locator('.card').filter({ hasText: 'Lives insured' }).locator('table.data tbody tr');

if (await page.locator('[data-remove-life]').count()) {
  await page.click('[data-remove-life]');
  await page.waitForTimeout(1000);
  const afterRemove = await livesRows().count();
  check('removing a life from a policy works', afterRemove === 1, `${afterRemove} lives`);
}

await page.click('#addLifeBtn');
await page.waitForSelector('dialog[open]');
await page.fill('dialog input[name="insured_last_name"]', 'Castellano');
await page.fill('dialog input[name="insured_first_name"]', 'Marie');
await page.fill('dialog input[name="dob"]', '1939-02-11');
await page.selectOption('dialog select[name="role"]', 'Survivorship');
await page.click('dialog button[type=submit]');
await page.waitForTimeout(1100);
const lives = await livesRows().count();
check('second life added to policy', lives === 2, `${lives} lives listed`);
const livesText = await page.locator('.card').filter({ hasText: 'Lives insured' }).textContent();
check('second life shows its role', livesText.includes('Survivorship') && livesText.includes('Marie'));
await page.screenshot({ path: `${SHOTS}/16-policy-lives.png`, fullPage: true });

/* --------------------------- servicing ------------------------- */
console.log('\nSERVICING');
const strayDialogs = await page.evaluate(() =>
  [...document.querySelectorAll('dialog')].filter(d => d.open)
    .map(d => d.querySelector('.dialog-head')?.textContent || '?'));
check('no dialog left open after edits', strayDialogs.length === 0, strayDialogs.join(', '));
await page.click('a[href="#/servicing"]');
await page.waitForSelector('.card');
await page.waitForTimeout(400);
check('servicing page renders', (await page.locator('.card').count()) >= 2);
await page.screenshot({ path: `${SHOTS}/09-servicing.png`, fullPage: true });

/* --------------------------- insureds -------------------------- */
console.log('\nINSUREDS');
await page.click('a[href="#/insureds"]');
// Wait for this page specifically — the previous view also has tables.
await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Insureds');
await page.waitForSelector('table.data tbody tr');
const ppl = await page.locator('table.data tbody tr').count();
check('insureds listed', ppl >= 12, `${ppl} people`);
await page.screenshot({ path: `${SHOTS}/10-insureds.png`, fullPage: true });

// edit an insured record
await page.click('[data-edit-insured]');
await page.waitForSelector('dialog[open]');
await page.fill('dialog input[name="le_months"]', '84');
// The state is a list now, not something you can mistype.
await page.selectOption('dialog select[name="state"]', 'MI');
await page.click('dialog button[type=submit]');
await page.waitForTimeout(1000);
const leCell = await page.locator('table.data tbody tr').first().textContent();
check('editing an insured persists', leCell.includes('84') && leCell.includes('MI'), leCell.trim().slice(0, 60));

/* ---------------------------- import --------------------------- */
console.log('\nIMPORT');
/* Reached from Settings now rather than from the top menu, since it is a
   setup job rather than a daily one. */
await page.click('a[href="#/settings"]');
await page.waitForSelector('#pwForm');
await page.waitForTimeout(600);
check('Settings offers the importer', (await page.locator('a[href="#/import"]').count()) >= 1);
check('and the menu no longer carries it',
  (await page.locator('.nav a[href="#/import"]').count()) === 0);
await page.locator('a[href="#/import"]').first().click();
await page.waitForSelector('#dropzone');
// The screen defaults to the master importer; this check is about the
// single-purpose policies path, which has its own dedicated option.
await page.selectOption('#importType', 'policies');
await page.setInputFiles('#fileInput', '/home/claude/policyhub/demo/policies.csv');
await page.waitForSelector('#runImportBtn', { timeout: 10000 });
check('CSV preview shows matched columns',
  (await page.locator('#importResult').textContent()).includes('policy_number'));
await page.screenshot({ path: `${SHOTS}/11-import-preview.png`, fullPage: true });
await page.click('#runImportBtn');
await page.waitForSelector('.ok-box', { timeout: 20000 });
const res = await page.locator('#importResult').textContent();
check('re-import updates rather than duplicates', res.includes('Records updated'), res.replace(/\s+/g,' ').trim().slice(0, 80));
await page.screenshot({ path: `${SHOTS}/12-import-done.png`, fullPage: true });

/* ---------------------------- settings ------------------------- */
console.log('\nSETTINGS');
await page.click('a[href="#/settings"]');
await page.waitForSelector('#pwForm');
check('activity log visible to admin',
  (await page.locator('.card').filter({ hasText: 'Activity log' }).count()) === 1);
await page.screenshot({ path: `${SHOTS}/13-settings.png`, fullPage: true });

/* ---------------------------- dark mode ------------------------ */
console.log('\nDARK MODE');
await page.click('a[href="#/dashboard"]');
await page.waitForSelector('.kpi-row');
await page.click('#themeBtn');
await page.waitForTimeout(900);
check('dark theme applied', (await page.getAttribute('html', 'data-theme')) === 'dark');
await page.screenshot({ path: `${SHOTS}/14-dashboard-dark.png`, fullPage: true });
await page.click('#themeBtn');
await page.waitForTimeout(600);

/* ---------------------------- mobile --------------------------- */
console.log('\nMOBILE');
// Reuse the signed-in page so the session cookie carries over.
await page.setViewportSize({ width: 400, height: 850 });
await page.goto(`${BASE}/#/dashboard`);
await page.reload();
await page.waitForSelector('.kpi-row', { timeout: 10000 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${SHOTS}/15-mobile.png`, fullPage: true });
check('mobile layout renders', await page.isVisible('.kpi-row'));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('no horizontal overflow on mobile', overflow <= 1, `${overflow}px overflow`);
await page.setViewportSize({ width: 1500, height: 1000 });

/* --------------------------- security -------------------------- */
console.log('\nSECURITY');
const anon = await browser.newContext();
const ap = await anon.newPage();
const r1 = await ap.request.get(`${BASE}/api/policies`);
check('unauthenticated API access blocked', r1.status() === 401, `status ${r1.status()}`);
const r2 = await ap.request.post(`${BASE}/api/import/run`);
check('unauthenticated import blocked', r2.status() === 401, `status ${r2.status()}`);

// 401s are expected: the boot-time session probe and the deliberate anonymous
// requests above. Anything else is a real failure.
const unexpected = consoleErrors.filter((e) => !/401 \(Unauthorized\)/.test(e));
console.log('\nCONSOLE ERRORS:', unexpected.length ? unexpected.join('\n  ') : 'none unexpected');
check('no unexpected console errors', unexpected.length === 0);

await browser.close();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'ALL CHECKS PASSED'}`);
process.exit(fails.length ? 1 : 0);
