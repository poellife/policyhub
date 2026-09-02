/* =====================================================================
   Life-expectancy reports — on screen.

   The API suite proves the case is run, watched and kept correctly. What
   is under test here is the part a person touches: that records can be
   dropped, that the screen says which stage the work is at rather than
   spinning at nothing, that a finished case reads as an estimate and not
   as a row of fields — and that the whole thing is absent for everybody
   who is not an administrator.

   Idempotent: it stands up its own stand-in service and takes it down.
   ===================================================================== */
import { chromium } from 'playwright';
import { startLeStub } from './le-stub.mjs';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const stub = await startLeStub(5077);
const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: admin, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

for (const r of ((await json(await api('/le-reports')))?.reports || []))
  await api(`/le-reports/${r.id}`, { method: 'DELETE' });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (who) => {
  const ctx = await br.newContext({ viewport: { width: 1480, height: 1250 } });
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

console.log('A SCREEN OF ITS OWN');
check('the menu offers it to an administrator',
  await p.locator('nav a', { hasText: 'LE reports' }).count() === 1);
await p.click('nav a:has-text("LE reports")');
await p.waitForSelector('h1:has-text("LE reports")', { timeout: 20000 });
await p.waitForTimeout(600);
check('with somewhere to drop the records', await p.locator('#leDrop').count() === 1);
check('and it says the records are not kept here',
  /not stored here/i.test(await p.locator('#leDrop').innerText()));
check('the depth of the report can be chosen',
  (await p.locator('#leMode option').allTextContents()).length === 2);

console.log('\nIT SAYS WHAT IT KEEPS, BEFORE ANYTHING IS SENT');
const notice = await p.locator('.notice-box').innerText();
check('the headline is kept and the summary is not',
  /the figures survive and the medical summary does not/i.test(notice));
check('and it says an estimate is not a prediction',
  /not a prediction/i.test(notice) && /not prepared by a licensed/i.test(notice));

console.log('\nRECORDS CAN BE DROPPED, NOT ONLY CHOSEN');
const drop = async (names) => {
  const dt = await p.evaluateHandle((list) => {
    const d = new DataTransfer();
    for (const n of list)
      d.items.add(new File([new Uint8Array(4096).fill(7)], n, { type: 'application/pdf' }));
    return d;
  }, names);
  const zone = await p.$('#leDrop');
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  const lit = await p.locator('#leDrop.over').count();
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  return lit;
};
const lit = await drop(['APS-oncology.pdf', 'APS-nephrology.pdf']);
check('the zone lights up while files are over it', lit === 1, `${lit} highlighted`);

console.log('\nAND THE SCREEN SAYS WHERE THE WORK HAS GOT TO');
await p.waitForFunction(
  () => /Reading the records|Analysing|Writing the report|Sent/i
    .test(document.querySelector('#leDrop .read-drop-main')?.textContent || ''),
  null, { timeout: 20000 });
check('a stage is named while it runs, not just a spinner',
  /Reading the records|Analysing|Writing the report|Sent/i
    .test(await p.locator('#leDrop .read-drop-main').innerText()),
  (await p.locator('#leDrop .read-drop-main').innerText()).trim());

/* The stub advances a stage per poll and the screen polls every eight
   seconds, so rather than wait it out, the case is walked to done from
   here and the screen redrawn. */
const running = (await json(await api('/le-reports'))).reports[0];
for (let i = 0; i < 8; i++) {
  const s = await json(await api(`/le-reports/${running.id}`));
  if (s.status === 'done') break;
}
await p.goto(`${BASE}/#/le-reports`);
await p.waitForSelector('.le-case', { timeout: 20000 });
await p.waitForTimeout(700);

console.log('\nA FINISHED CASE READS AS AN ESTIMATE');
const card = p.locator('.le-case').first();
const text = (await card.innerText()).replace(/\s+/g, ' ');
check('the central estimate is the headline', /4\.2 yr/.test(text), text.slice(0, 90));
check('with the range beside it', /range 3–6 yr/.test(text), text.slice(0, 120));
check('and the months the book actually stores', /≈ 50 months/.test(text), text.slice(0, 140));
check('who it is about, without a name', /A\.B\./.test(text) && /81/.test(text));
check('the one-line summary is there', /metastatic prostate/i.test(text));
check('so is how much was read', /240 pages read/.test(text) && /OCR/.test(text));
check('and the report can be fetched',
  await card.locator('a:has-text("Report")').count() === 1);
check('pointed through this server, never at the service',
  /^\/api\/le-reports\/\d+\/report\.pdf$/.test(
    await card.locator('a:has-text("Report")').getAttribute('href')),
  await card.locator('a:has-text("Report")').getAttribute('href'));

console.log('\nAND IT CAN BE FILED AGAINST A DEAL');
const opps = await json(await api('/opportunities'));
const target = opps[0];
await api(`/le-reports/${running.id}`, {
  method: 'PUT', body: { opportunity_id: target.id } });
await p.goto(`${BASE}/#/opportunity/${target.id}`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(900);
const panel = p.locator('.card:has(h2:text-is("Life-expectancy reports"))');
check('the deal carries a panel', await panel.count() === 1);
check('with the estimate on it', /4\.2 yr/.test(await panel.innerText()));
check('and a way to run another from the deal itself',
  await panel.locator('#leRunBtn').count() === 1);
check('the deal is offered the figure as its life expectancy',
  /Use 50 months/.test(await panel.innerText()),
  (await panel.innerText()).replace(/\s+/g, ' ').slice(-120));

console.log('\nADMINISTRATORS AND NOBODY ELSE');
for (const [who, acct] of [['a manager', MANAGER1], ['an investor', INVESTOR1]]) {
  const other = await open(acct);
  check(`${who} has no LE reports tab`,
    await other.locator('nav a', { hasText: 'LE reports' }).count() === 0);
  await other.goto(`${BASE}/#/le-reports`);
  await other.waitForTimeout(900);
  check(`and ${who} typing the address in gets no drop zone`,
    await other.locator('#leDrop').count() === 0);
  /* An investor may not be able to open the deal at all, which is a
     stronger answer than an empty panel -- so this waits for the page to
     settle rather than for a heading that may never come. */
  await other.goto(`${BASE}/#/opportunity/${target.id}`);
  await other.waitForTimeout(1500);
  check(`nor a panel when ${who} opens that deal`,
    await other.locator('.card:has(h2:text-is("Life-expectancy reports"))').count() === 0);
}

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
for (const r of ((await json(await api('/le-reports')))?.reports || []))
  await api(`/le-reports/${r.id}`, { method: 'DELETE' });
await stub.close();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All LE report UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
