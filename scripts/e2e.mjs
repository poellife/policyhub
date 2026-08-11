import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
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

await page.fill('#email', 'JP@poelcapital.com');
await page.fill('#password', 'wrongpassword');
await page.click('button[type=submit]');
await page.waitForSelector('.error-box');
check('bad password is rejected', await page.isVisible('.error-box'));

await page.fill('#password', 'poelcapital2026');
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

/* --------------------------- policies -------------------------- */
console.log('\nPOLICIES');
await page.click('a[href="#/policies"]');
await page.waitForSelector('table.data tbody tr');
const rowCount = await page.locator('table.data tbody tr').count();
check('policy rows listed', rowCount === 12, `${rowCount} rows`);
await page.screenshot({ path: `${SHOTS}/04-policies.png`, fullPage: true });

// sort by face amount descending
await page.click('th[data-key="face_amount"]');
await page.waitForTimeout(200);
await page.click('th[data-key="face_amount"]');
await page.waitForTimeout(300);
const firstFace = await page.locator('table.data tbody tr:first-child td:nth-child(9)').textContent();
check('sort by face works', firstFace.includes('10,000,000'), firstFace.trim());

// search filter
await page.fill('#searchInput', 'Ellison');
await page.waitForTimeout(600);
const filtered = await page.locator('table.data tbody tr').count();
check('search narrows the list', filtered === 1, `${filtered} row`);
await page.fill('#searchInput', '');
await page.waitForTimeout(600);

/* ------------------------ policy detail ------------------------ */
console.log('\nPOLICY DETAIL');
await page.click('table.data tbody tr:first-child');
await page.waitForSelector('.tabs');
check('detail header shows insured', (await page.locator('h1').textContent()).length > 2);
await page.screenshot({ path: `${SHOTS}/05-policy-overview.png`, fullPage: true });

await page.click('.tabs button[data-tab="values"]');
await page.waitForTimeout(700);
const avLines = await page.locator('#chartAvCsv svg path.line').count();
check('AV/CSV chart has two series', avLines >= 2, `${avLines} lines`);
check('COI chart rendered', (await page.locator('#chartCoi svg path.line').count()) > 0);
const snapRows = await page.locator('table.data tbody tr').count();
check('value snapshots listed', snapRows >= 18, `${snapRows} snapshots`);
await page.screenshot({ path: `${SHOTS}/06-policy-values.png`, fullPage: true });

// add a snapshot
await page.click('#addValueBtn');
await page.waitForSelector('dialog[open]');
await page.fill('dialog input[name="as_of_date"]', '2026-09-01');
await page.fill('dialog input[name="account_value"]', '12345.67');
await page.fill('dialog input[name="cash_surrender_value"]', '12000');
await page.fill('dialog input[name="cost_of_insurance"]', '500');
await page.click('dialog button[type=submit]');
await page.waitForTimeout(900);
const afterAdd = await page.locator('table.data tbody tr').count();
check('adding a snapshot persists', afterAdd === 19, `${afterAdd} snapshots`);

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
if (await page.locator('[data-remove-life]').count()) {
  await page.click('[data-remove-life]');
  await page.waitForTimeout(1000);
  const afterRemove = await page.locator('table.data tbody tr').count();
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
const lives = await page.locator('table.data tbody tr').count();
check('second life added to policy', lives === 2, `${lives} lives listed`);
const livesText = await page.locator('table.data').first().textContent();
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
await page.fill('dialog input[name="state"]', 'MI');
await page.click('dialog button[type=submit]');
await page.waitForTimeout(1000);
const leCell = await page.locator('table.data tbody tr').first().textContent();
check('editing an insured persists', leCell.includes('84') && leCell.includes('MI'), leCell.trim().slice(0, 60));

/* ---------------------------- import --------------------------- */
console.log('\nIMPORT');
await page.click('a[href="#/import"]');
await page.waitForSelector('#dropzone');
await page.setInputFiles('#fileInput', '/home/claude/policyhub/demo/policies.csv');
await page.waitForSelector('#runImportBtn', { timeout: 10000 });
check('CSV preview shows matched columns',
  (await page.locator('#importResult').textContent()).includes('policy_number'));
await page.screenshot({ path: `${SHOTS}/11-import-preview.png`, fullPage: true });
await page.click('#runImportBtn');
await page.waitForSelector('.ok-box', { timeout: 20000 });
const res = await page.locator('#importResult').textContent();
check('re-import updates rather than duplicates', res.includes('Policies updated'));
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
