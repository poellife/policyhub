/* =====================================================================
   The Documents card, from both sides of the wall.

   Posting a K-1 and having the right person — and only the right person
   — find it in their portal is the whole feature, so this follows one
   from the upload dialog through to the investor downloading it.
   ===================================================================== */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'DOCUI';
const S = '/home/claude/shots';
const TMP = '/tmp/docui';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const d of ((await json(await api('/documents'))) || [])
    .filter((x) => String(x.title).startsWith(PREFIX)))
    await api(`/documents/${d.id}`, { method: 'DELETE' });
};
await wipe();

// A small but real PDF, so the browser has something honest to download.
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n');
const pdfPath = `${TMP}/${PREFIX}-k1-2025.pdf`;
fs.writeFileSync(pdfPath, pdf);

const investors = await json(await api('/investors'));
const inv1Id = (await json(await fetch(`${BASE}/api/auth/me`,
  { headers: { Cookie: await login(INVESTOR1.email, INVESTOR1.password) } }))).investor.id;
const inv1Name = investors.find((i) => i.id === inv1Id)?.name;

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = async (email, pass) => {
  const ctx = await br.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${email}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(`${email}: ${m.text()}`));
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE); await p.fill('#email', email); await p.fill('#password', pass);
  await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });
  return p;
};

const staff = await page(ADMIN.email, ADMIN.password);
/* Navigate away and back rather than re-issuing the same hash: the router
   listens for hashchange, so asking for the page you are already on is a
   no-op and would leave a stale card on screen. */
const settings = async (p) => {
  await p.goto(`${BASE}/#/dashboard`);
  await p.waitForTimeout(250);
  await p.goto(`${BASE}/#/settings`);
  await p.waitForFunction(() => /Settings|Account/.test(document.querySelector('h1')?.textContent || ''));
  await p.waitForTimeout(900);
};

console.log('THE CARD IS THERE');
await settings(staff);
const card = staff.locator('.card', { hasText: 'Documents' }).first();
check('Settings has a Documents section', (await card.count()) === 1);
check('with an upload button', (await staff.locator('#addDocBtn').count()) === 1);
const empty = (await card.textContent()).replace(/\s+/g, ' ');
check('and it says what belongs here', /LLC agreement|No documents yet|on file/i.test(empty),
  empty.slice(0, 140));

console.log('\nPOSTING A K-1 FOR ONE INVESTOR');
await staff.click('#addDocBtn');
await staff.waitForSelector('dialog[open] input[type=file]');
await staff.waitForTimeout(400);
check('the dialog asks who it is for',
  (await staff.locator('dialog[open] input[name=target]').count()) === 3);
check('and defaults to the whole firm',
  await staff.locator('dialog[open] input[name=target][value="firm"]').isChecked());
check('the entity picker is hidden until it is wanted',
  !(await staff.locator('#docFundField').isVisible()));

await staff.setInputFiles('dialog[open] input[type=file]', pdfPath);
await staff.fill('dialog[open] input[name=title]', `${PREFIX} K-1 2025`);
await staff.selectOption('dialog[open] select[name=category]', 'K-1');
await staff.fill('dialog[open] input[name=doc_year]', '2025');
await staff.locator('dialog[open] .step-kind label', { hasText: 'One investor' }).click();
await staff.waitForTimeout(400);
check('choosing an investor reveals the picker',
  await staff.locator('#docInvestorField').isVisible());
check('and the entity picker goes away',
  !(await staff.locator('#docFundField').isVisible()));
check('sharing is off until it is ticked',
  !(await staff.locator('dialog[open] input[name=shared]').isChecked()));
await staff.selectOption('dialog[open] select[name=investor_id]', String(inv1Id));
await staff.click('dialog[open] button[type=submit]');
await staff.waitForTimeout(2000);
await settings(staff);

const rowText = (await staff.locator('table.data tr', { hasText: `${PREFIX} K-1 2025` })
  .first().textContent()).replace(/\s+/g, ' ');
check('it is listed', rowText.includes(`${PREFIX} K-1 2025`), rowText.slice(0, 120));
check('against the investor it is for', rowText.includes(inv1Name), inv1Name);
check('and marked staff only', /staff only/i.test(rowText));
check('with its year and size', /2025/.test(rowText) && /B|KB/.test(rowText));
await staff.screenshot({ path: `${S}/doc1-staff.png`, fullPage: true });

console.log('\nTHE INVESTOR CANNOT SEE A DRAFT');
const inv = await page(INVESTOR1.email, INVESTOR1.password);
await settings(inv);
const invCard = inv.locator('.card', { hasText: 'Documents' }).first();
check('their Account page has a Documents section', (await invCard.count()) === 1);
check('but the draft is not in it',
  !(await invCard.textContent()).includes(`${PREFIX} K-1 2025`));

console.log('\nSHARING IT');
await settings(staff);
await staff.locator('table.data tr', { hasText: `${PREFIX} K-1 2025` })
  .first().locator('[data-doc-edit]').click();
await staff.waitForSelector('dialog[open] input[name=shared]');
await staff.waitForTimeout(500);
check('editing reopens on the investor it was filed against',
  await staff.locator('dialog[open] input[name=target][value="investor"]').isChecked());
await staff.check('dialog[open] input[name=shared]');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForTimeout(1800);
await settings(staff);
check('the row now reads as shared',
  /shared/i.test(await staff.locator('table.data tr', { hasText: `${PREFIX} K-1 2025` })
    .first().textContent()));

await settings(inv);
const nowSees = (await inv.locator('.card', { hasText: 'Documents' }).first().textContent())
  .replace(/\s+/g, ' ');
check('and the investor now has it', nowSees.includes(`${PREFIX} K-1 2025`), nowSees.slice(0, 160));
check('with no staff-only column to confuse them',
  !/staff only|whole firm/i.test(nowSees));
await inv.screenshot({ path: `${S}/doc2-investor.png`, fullPage: true });

console.log('\nDOWNLOADING IT');
const wait = inv.waitForEvent('download', { timeout: 15000 });
await inv.locator('.card', { hasText: 'Documents' }).first()
  .locator('[data-doc-get]').first().click();
const dl = await wait;
check('the download starts', !!dl);
check('under the name it was filed as', /\.pdf$/i.test(dl.suggestedFilename()),
  dl.suggestedFilename());
const saved = `${TMP}/out.pdf`;
await dl.saveAs(saved);
check('and the file that arrives is the file that was posted',
  fs.readFileSync(saved).equals(pdf), `${fs.statSync(saved).size} bytes`);

console.log('\nTHE OTHER INVESTOR NEVER SEES IT');
const inv2 = await page(INVESTOR2.email, INVESTOR2.password);
await settings(inv2);
check('not on their page',
  !(await inv2.locator('.card', { hasText: 'Documents' }).first().textContent())
    .includes(`${PREFIX} K-1 2025`));

console.log('\nERRORS');
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL DOCUMENT UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
