/* =====================================================================
   Premium optimization, on screen.

   Three ways in, all landing in the same place:

     - Servicing → Premium optimization, for the whole book
     - the Premium optimization card on a policy's own Servicing tab,
       which is where somebody actually is when they are deciding what
       to schedule
     - dragging the workbook onto either of them

   The drop is worth testing rather than assuming. It is the gesture
   everybody reaches for first, it is the one that silently does nothing
   when a handler is missing, and "nothing happened" is indistinguishable
   from a broken page.

   Idempotent: its own policy and streams, removed first and last.
   ===================================================================== */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const S = '/home/claude/shots';
const FILE = 'demo/premium-optimization.xlsx';
const FILE_POLICY = 'PO-SAMPLE-4471';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

if (!fs.existsSync(FILE)) {
  console.error(`\nMissing ${FILE}. Run: node scripts/make-premium-stream-sample.js\n`);
  process.exit(2);
}

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const s of ((await json(await api('/premium-streams'))) || []))
    if (s.on_policy_number === FILE_POLICY)
      await api(`/premium-streams/${s.id}`, { method: 'DELETE' });
  for (const st of ['', 'Inforce', 'Lapsed', 'Matured', 'Sold', 'Pending'])
    for (const p of ((await json(await api(`/policies?search=${FILE_POLICY}&status=${st}`))) || []))
      if (p.policy_number === FILE_POLICY)
        await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: FILE_POLICY } });
};
await wipe();
const policy = await json(await api('/policies', { method: 'POST', body: {
  policy_number: FILE_POLICY, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 4000000,
  insured_last_name: 'Fairbanks', insured_first_name: 'Marguerite', dob: '1944-02-02' } }));
if (!policy?.id) { console.error('fixture policy failed', policy); process.exit(2); }

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1300 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 15000 });

const servicingTab = async () => {
  await p.goto(`${BASE}/#/policy/${policy.id}?tab=servicing`);
  await p.waitForSelector('.tabs'); await p.waitForTimeout(500);
  await p.locator('.tabs button', { hasText: 'Servicing' }).first().click();
  await p.waitForTimeout(700);
};

/**
 * A real drop, with a real file on it.
 *
 * Playwright's setInputFiles goes through the hidden input and proves
 * nothing about the drop handler, so this builds a File and a
 * DataTransfer inside the page and dispatches the events a browser
 * would.
 */
const bytes = [...fs.readFileSync(FILE)];
const dropOnto = async (selector, name) => p.evaluate(async ([sel, fileName, data]) => {
  const file = new File([new Uint8Array(data)], fileName,
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const el = document.querySelector(sel);
  for (const type of ['dragenter', 'dragover', 'drop'])
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
}, [selector, FILE.split('/').pop(), bytes]);

console.log('THE CARD ON THE POLICY ITSELF');
await servicingTab();
check('the policy carries a Premium optimization card',
  (await p.locator('#policyStreams').count()) === 1);
const cardText = (await p.locator('#policyStreams').textContent()).replace(/\s+/g, ' ');
check('which says what it is for', /reference · not a bill/i.test(cardText), cardText.slice(0, 90));
check('with somewhere to drop a file', (await p.locator('#policyStreamDrop').count()) === 1);
check('and a button for people who would rather click',
  (await p.locator('#policyStreamUpload').count()) === 1);
await p.screenshot({ path: `${S}/pou1-policy-empty.png`, fullPage: true });

console.log('\nDROPPING ONE ONTO THE POLICY');
await dropOnto('#policyStreams');
await p.waitForSelector('dialog[open] #streamSummary .kv', { timeout: 15000 });
await p.waitForTimeout(400);
const dlg = (await p.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('the drop opens the dialog with the file already read',
  /300 payments/.test(dlg), dlg.slice(0, 160));
check('titled for the policy it was dropped on',
  /Premium optimization for PO-SAMPLE-4471/.test(
    await p.locator('dialog[open] .dialog-head').textContent()));
check('naming the file it is about to file',
  /premium-optimization\.xlsx/.test(
    await p.locator('dialog[open] #streamDropName').textContent()));
check('and saying it goes on this policy, which is the one the file names',
  /Filed against PO-SAMPLE-4471/.test(dlg) && !/is not/.test(dlg), dlg.slice(-220));
await p.screenshot({ path: `${S}/pou2-dropped.png`, fullPage: true });

await p.fill('dialog[open] input[name=source]', 'Fixture Servicing Co');
await p.click('dialog[open] button[type=submit]');
await p.waitForSelector('#policyStreams table.data tbody tr', { timeout: 15000 });
await p.waitForTimeout(600);
check('it is filed and shows on the card',
  (await p.locator('#policyStreams table.data tbody tr').count()) === 1);
const filed = (await p.locator('#policyStreams').textContent()).replace(/\s+/g, ' ');
check('with the stream type and the count', /Hybrid/.test(filed) && /300/.test(filed),
  filed.slice(0, 200));
check('and what the servicing firm said',
  /minimum cost of insurance/i.test(filed));
await p.screenshot({ path: `${S}/pou3-filed.png`, fullPage: true });

console.log('\nREADING IT FROM THE POLICY');
await p.click('#policyStreams [data-stream]');
await p.waitForSelector('dialog[open] [data-year]', { timeout: 15000 });
await p.waitForTimeout(400);
const years = await p.locator('dialog[open] [data-year]').count();
check('opening it gives a year for each year of the stream', years >= 25, String(years));
await p.click('dialog[open] [data-year]');
await p.waitForTimeout(300);
const opened = await p.locator('dialog[open] tr.year-months:visible').count();
check('and a year opens to its months', opened === 1, String(opened));
const detail = (await p.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('to the cent', /\$14,900\.74|\$7,450\.37/.test(detail),
  (detail.match(/\$[\d,]+\.\d\d/g) || []).slice(0, 4).join(' '));
check('and it says it changes nothing',
  /Nothing on this page changes what is due/i.test(detail));
await p.screenshot({ path: `${S}/pou4-detail.png`, fullPage: true });
await p.click('dialog[open] #dlgCancel');
await p.waitForTimeout(400);

console.log('\nTHE SAME STREAM ON THE SERVICING SCREEN');
await p.goto(`${BASE}/#/servicing`);
await p.waitForSelector('#svcTabs'); await p.waitForTimeout(600);
await p.click('button[data-svctab="optimization"]');
await p.waitForSelector('#uploadStreamBtn'); await p.waitForTimeout(600);
const page = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the tab lists it', /Marguerite Fairbanks/.test(page) && /Hybrid/.test(page),
  page.slice(0, 200));
check('and says reference only at the top', /Reference only/i.test(page));
check('the card for that policy is a drop target',
  (await p.locator(`[data-drop-policy="${policy.id}"]`).count()) === 1);
await p.screenshot({ path: `${S}/pou5-servicing-tab.png`, fullPage: true });

console.log('\nDROPPING ONTO A POLICY THE FILE IS NOT ABOUT');
/* A second policy, so the "this is not that policy" warning has somewhere
   to happen. Filing it is still allowed — a servicing firm's numbering is
   not always ours — but it is said out loud rather than assumed. */
const other = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${FILE_POLICY}-OTHER`, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 1000000,
  insured_last_name: 'Fairbanks', insured_first_name: 'Wrong', dob: '1950-01-01' } }));
await p.goto(`${BASE}/#/policy/${other.id}?tab=servicing`);
await p.waitForSelector('.tabs'); await p.waitForTimeout(500);
await p.locator('.tabs button', { hasText: 'Servicing' }).first().click();
await p.waitForTimeout(700);
await dropOnto('#policyStreams');
await p.waitForSelector('dialog[open] #streamSummary .kv', { timeout: 15000 });
await p.waitForTimeout(400);
const warned = (await p.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('it warns that the file names a different policy',
  /is not PO-SAMPLE-4471-OTHER/.test(warned), warned.slice(-260));
check('and still offers to file it, since the choice is the reader\'s',
  (await p.locator('dialog[open] button[type=submit]').count()) === 1);
await p.click('dialog[open] #dlgCancel');
await p.waitForTimeout(300);
await api(`/policies/${other.id}`, { method: 'DELETE',
  body: { confirm: `${FILE_POLICY}-OTHER` } });

console.log('\nAN INVESTOR SEES NONE OF IT');
const ictx = await br.newContext({ viewport: { width: 1400, height: 1000 } });
const ip = await ictx.newPage();
await ip.goto(BASE);
await ip.fill('#email', INVESTOR1.email); await ip.fill('#password', INVESTOR1.password);
await ip.click('button[type=submit]'); await ip.waitForSelector('.kpi-row', { timeout: 15000 });
await ip.goto(`${BASE}/#/servicing`); await ip.waitForTimeout(1200);
check('there is no Premium optimization tab on their Premiums page',
  (await ip.locator('#svcTabs').count()) === 0);
const invText = (await ip.locator('.main').textContent()).replace(/\s+/g, ' ');
check('nor the words anywhere on it', !/Premium optimization/i.test(invText),
  invText.slice(0, 120));
const own = await ip.evaluate(() => fetch('/api/policies').then((r) => r.json()));
if (own.length) {
  await ip.goto(`${BASE}/#/policy/${own[0].id}?tab=servicing`);
  await ip.waitForSelector('.tabs'); await ip.waitForTimeout(900);
  const tab = await ip.locator('.tabs button', { hasText: 'Premiums' });
  if (await tab.count()) { await tab.first().click(); await ip.waitForTimeout(800); }
  check('nor on a policy of their own',
    (await ip.locator('#policyStreams').count()) === 0);
} else {
  check('nor on a policy of their own', true, 'this investor holds nothing');
}
await ictx.close();

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await wipe();
console.log(fails.length
  ? `\n${fails.length} PREMIUM OPTIMIZATION UI CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL PREMIUM OPTIMIZATION UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
