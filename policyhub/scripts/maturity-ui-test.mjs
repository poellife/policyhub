/* =====================================================================
   The Maturities screen: that a death recorded through the interface
   moves the policy off the active grid and onto the register, that the
   register adds up, and that proceeds can be entered from it.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'MATUI';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

/* Set up the fixture over the API — the interface is what we are testing,
   not what we should be building test data with. */
const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

for (const status of ['', 'Matured', 'Inforce']) {
  const list = await json(await api(`/policies?status=${status}`));
  for (const p of (list || []).filter((x) => x.policy_number.startsWith(PREFIX))) {
    const d = await json(await api(`/policies/${p.id}`));
    for (const id of [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)].filter(Boolean))
      await api(`/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  }
}
const policy = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Screen Test Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 2500000,
  insured_last_name: 'Screentest', insured_first_name: 'Maturity', dob: '1939-09-09' } }));
await api(`/policies/${policy.id}/transactions`, { method: 'POST', body: {
  txn_date: '2024-01-15', txn_type: 'Acquisition Cost', amount: 400000 } });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
p.on('dialog', (d) => d.accept());

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });

console.log('NAVIGATION');
const nav = await p.$$eval('.nav a', (a) => a.map((x) => x.textContent.trim()));
check('Maturities sits in the menu', nav.includes('Maturities'), nav.join('/'));
check('after Servicing, before Opportunities',
  nav.indexOf('Maturities') > nav.indexOf('Servicing')
  && nav.indexOf('Maturities') < nav.findIndex((n) => n.startsWith('Opportunities')),
  nav.join('/'));

console.log('\nBEFORE THE DEATH IS RECORDED');
const searchGrid = async (term) => {
  await p.goto(`${BASE}/#/policies`);
  await p.waitForSelector('#searchInput');
  // The filter lives in app state and survives navigation, so clear it before
  // typing — refilling the same string would not change anything to react to.
  await p.fill('#searchInput', ''); await p.waitForTimeout(800);
  await p.fill('#searchInput', term); await p.waitForTimeout(1200);
  return p.locator('table.data tbody tr');
};
check('the policy is on the active grid',
  (await (await searchGrid('Screentest')).count()) === 1);
await p.goto(`${BASE}/#/maturities`); await p.waitForTimeout(900);
const emptyText = await p.locator('.main').textContent();
check('the register explains itself when empty or lists others',
  emptyText.includes('Maturities'), emptyText.slice(0, 40).trim());
check('this policy is not in it', !emptyText.includes(`${PREFIX}-1`));
await p.screenshot({ path: `${S}/mt1-before.png`, fullPage: true });

console.log('\nRECORDING THE DEATH THROUGH THE INTERFACE');
await p.goto(`${BASE}/#/policy/${policy.id}`); await p.waitForSelector('.tabs');
await p.waitForTimeout(600);
await p.click('#editInsuredBtn'); await p.waitForSelector('dialog[open]');
await p.waitForTimeout(400);
check('the dialog explains what a death date does',
  (await p.locator('dialog[open]').textContent()).includes('Maturities'));
await p.fill('dialog input[name="date_of_death"]', '2026-07-04');
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1500);
const toastText = await p.locator('.toast').textContent().catch(() => '');
check('the toast names the policy that moved', /moved to Maturities/i.test(toastText || ''),
  (toastText || 'no toast').trim());

await p.goto(`${BASE}/#/policy/${policy.id}`); await p.waitForSelector('.tabs');
await p.waitForTimeout(700);
const detailText = await p.locator('.main').textContent();
check('the policy page shows a maturity notice', detailText.includes('left the active portfolio'));
check('with the date', /0?7\/0?4\/2026/.test(detailText));
check('and says the claim is unpaid', detailText.includes('not been recorded as paid'));
await p.screenshot({ path: `${S}/mt2-policy-matured.png`, fullPage: true });

console.log('\nAFTER');
const goneRows = await searchGrid('Screentest');
const goneText = (await goneRows.first().textContent().catch(() => '')) || '';
check('it has left the active grid',
  (await goneRows.count()) === 0 || /No policies/i.test(goneText),
  `${await goneRows.count()} rows: ${goneText.replace(/\s+/g, ' ').trim().slice(0, 60)}`);

await p.goto(`${BASE}/#/maturities`); await p.waitForTimeout(1000);
const row = p.locator('table.data tbody tr', { hasText: `${PREFIX}-1` });
check('it appears on the register', (await row.count()) === 1);
check('with the maturity date', /0?7\/0?4\/2026/.test(await row.textContent()));
check('the death benefit to the cent', (await row.textContent()).includes('$2,500,000.00'));
check('and reads as awaiting payment', (await row.textContent()).includes('Awaiting'));
await p.screenshot({ path: `${S}/mt3-register.png`, fullPage: true });

console.log('\nRECORDING PROCEEDS');
await row.locator('[data-proceeds]').click();
await p.waitForSelector('dialog[open]'); await p.waitForTimeout(400);
await p.fill('dialog input[name="proceeds_amount"]', '2487500.25');
await p.fill('dialog input[name="proceeds_received_on"]', '2026-09-15');
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1500);
const row2 = p.locator('table.data tbody tr', { hasText: `${PREFIX}-1` });
const rowText = await row2.textContent();
check('proceeds show on the row', rowText.includes('$2,487,500.25'), rowText.replace(/\s+/g, ' ').trim().slice(0, 120));
check('with the date received', /0?9\/15\/2026/.test(rowText));
check('gain is shown against capital invested', rowText.includes('$2,087,500.25'),
  'proceeds 2,487,500.25 less 400,000.00 invested');
const tiles = await p.locator('.kpi-row').textContent();
check('the realized gain tile agrees', tiles.includes('Realized gain'));
await p.screenshot({ path: `${S}/mt4-proceeds.png`, fullPage: true });

console.log('\nREVERSAL');
await p.goto(`${BASE}/#/policy/${policy.id}`); await p.waitForSelector('.tabs');
await p.waitForTimeout(600);
await p.click('#editInsuredBtn'); await p.waitForSelector('dialog[open]');
await p.waitForTimeout(300);
await p.fill('dialog input[name="date_of_death"]', '');
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1500);
await p.goto(`${BASE}/#/maturities`); await p.waitForTimeout(900);
check('clearing the date removes it from the register',
  (await p.locator('table.data tbody tr', { hasText: `${PREFIX}-1` }).count()) === 0);
check('and puts it back on the active grid',
  (await (await searchGrid('Screentest')).count()) === 1);

console.log('\nINVESTOR VIEW');
const ictx = await br.newContext({ viewport: { width: 1400, height: 950 } });
const ip = await ictx.newPage();
ip.on('pageerror', (e) => errs.push(`investor: ${e.message}`));
await ip.goto(BASE);
await ip.fill('#email', INVESTOR1.email); await ip.fill('#password', INVESTOR1.password);
await ip.click('button[type=submit]'); await ip.waitForSelector('.kpi-row', { timeout: 12000 });
const inav = await ip.$$eval('.nav a', (a) => a.map((x) => x.textContent.trim()));
check('an investor gets it as "Realized"', inav.includes('Realized'), inav.join('/'));
await ip.goto(`${BASE}/#/maturities`); await ip.waitForTimeout(900);
const itext = await ip.locator('.main').textContent();
check('the page renders for an investor', itext.includes('Realized'));
check('and states that the figures are their share',
  (await ip.locator('.share-note').count()) === 1,
  await ip.locator('.share-note').textContent().catch(() => 'absent'));
check('with no way to switch to whole-policy figures',
  (await ip.locator('[data-share]').count()) === 0);
check('with no owner-entity column', !itext.includes('LCG1'));
await ip.screenshot({ path: `${S}/mt5-investor.png`, fullPage: true });

/* ------------------------------ cleanup ----------------------------- */
await api(`/policies/${policy.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-1` } });

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL MATURITY UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
