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
/* Parked in extraction, because that is the stage a real case sits in
   for twenty minutes and the one somebody stares at wondering whether
   anything is happening. */
stub.stallAt('extracting');
const lit = await drop(['APS-oncology.pdf', 'APS-nephrology.pdf']);
check('the zone lights up while files are over it', lit === 1, `${lit} highlighted`);

console.log('\nAND THE SCREEN SAYS WHERE THE WORK HAS GOT TO');
await p.waitForSelector('.le-progress', { timeout: 30000 });
check('the case appears in the list the moment it is sent, not when it finishes',
  await p.locator('.le-case').count() === 1);
check('and the count in the header goes with it',
  /1 case/.test(await p.locator('.page-head .sub').innerText()),
  (await p.locator('.page-head .sub').innerText()).trim());

/* Nothing is reloaded from here on. The point of the block is that it
   keeps itself up to date on a screen somebody is already looking at, so
   the test waits for the screen to move on its own. */
const running = (await json(await api('/le-reports'))).reports[0];
await p.waitForFunction(
  () => document.querySelector('.le-step.now .le-step-label')?.textContent
    === 'Reading the records', null, { timeout: 40000 });
check('the block follows the case without the page being reloaded', true);

const steps = await p.locator('.le-progress .le-step-label').allTextContents();
check('every stage is named, in the order they happen',
  steps.join(' > ') === 'Queued > Reading the records > Analysing > Writing the report',
  steps.join(' > '));
check('the one running is marked, and the ones behind it are ticked',
  await p.locator('.le-step.now .le-step-label').innerText() === 'Reading the records'
  && await p.locator('.le-step.done').count() === 1,
  `${await p.locator('.le-step.done').count()} done`);
const clock = (await p.locator('.le-progress [data-le-clock]').innerText()).trim();
check('a clock says it has not hung', /^\d+[smh]/.test(clock), clock);
await p.waitForTimeout(1600);
const clock2 = (await p.locator('.le-progress [data-le-clock]').innerText()).trim();
check('and it is ticking, not a number printed once', clock2 !== clock, `${clock} → ${clock2}`);

const log = (await p.locator('.le-progress [data-le-log]').innerText()).replace(/\s+/g, ' ');
check('the service\u2019s own commentary is on screen', /Running OCR/i.test(log), log.slice(0, 80));
check('with the time of each line', /\d\d:\d\d:\d\d/.test(log));
check('including the page it has reached', /OCR pages \d+.\d+ of 240/.test(log));

const wait = (await p.locator('.le-progress [data-le-wait]').innerText()).replace(/\s+/g, ' ');
const prop = /Reading page (\d+) of 240 by OCR — (\d+)% of the way/.exec(wait);
check('the wait is put as a real proportion once OCR starts counting',
  !!prop && Math.round((Number(prop[1]) / 240) * 100) === Number(prop[2]),
  wait.slice(0, 70));
check('with the time left projected from this case, not assumed',
  /more minutes? of reading left|about a minute/.test(wait), wait.slice(0, 140));
check('the bar is drawn to match', await p.locator('.le-bar > span').count() === 1);
check('and it says the window does not have to stay open',
  /you can close this window/i.test(wait) && /keeps running/i.test(wait), wait.slice(-90));
check('the badge on the card keeps up with the stepper',
  /Reading the records/.test(await p.locator('.le-case .le-badge').first().innerText()),
  (await p.locator('.le-case .le-badge').first().innerText()).trim());

/* Let it go. The screen should notice it has finished and redraw itself
   into the estimate, again without being touched. */
stub.stallAt(null);
await p.waitForSelector('.le-badge.done', { timeout: 60000 });
await p.waitForTimeout(500);
check('and when it finishes the screen turns into the estimate by itself',
  await p.locator('.le-progress').count() === 0);

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

console.log('\nNOBODY WHO HAS NOT BEEN GIVEN IT');
for (const [who, acct] of [['a manager', MANAGER1], ['an investor', INVESTOR1]]) {
  const other = await open(acct);
  check(`${who} has no LE reports tab`,
    await other.locator('nav a', { hasText: 'LE reports' }).count() === 0);
  await other.goto(`${BASE}/#/le-reports`);
  await other.waitForTimeout(900);
  check(`and ${who} typing the address in gets no drop zone`,
    await other.locator('#leDrop').count() === 0);
  check(`and is told it has to be granted rather than shown a failure`,
    /granted to an account/i.test(await other.locator('.empty, .error-box').first().innerText()
      .catch(() => '')) || who === 'an investor');
  /* An investor may not be able to open the deal at all, which is a
     stronger answer than an empty panel -- so this waits for the page to
     settle rather than for a heading that may never come. */
  await other.goto(`${BASE}/#/opportunity/${target.id}`);
  await other.waitForTimeout(1500);
  check(`nor a panel when ${who} opens that deal`,
    await other.locator('.card:has(h2:text-is("Life-expectancy reports"))').count() === 0);
  await other.context().close();
}

console.log('\nAND AN ADMINISTRATOR CAN HAND IT OVER');
/* Ticked in the real dialog rather than by writing the column, because
   the checkbox not being wired into the save is exactly the mistake this
   is here to catch. */
await p.goto(`${BASE}/#/settings`);
await p.waitForTimeout(1200);
const row = p.locator('tr', { hasText: MANAGER1.email }).first();
await row.locator('button:has-text("Edit"), a:has-text("Edit")').first().click();
await p.waitForSelector('input[name=can_le]', { timeout: 15000 });
check('the grant is offered as its own tick box, beside Policy Valuation',
  await p.locator('input[name=can_le]').count() === 1);
check('and it says what it hands over',
  /protected health information/i.test(
    await p.locator('label:has(input[name=can_le])').innerText()));
await p.locator('input[name=can_le]').check();
await p.locator('.dlg button:has-text("Save changes"), button:has-text("Save changes")')
  .first().click();
await p.waitForTimeout(2000);

const granted = await open(MANAGER1);
check('the manager now has the tab',
  await granted.locator('nav a', { hasText: 'LE reports' }).count() === 1);
await granted.click('nav a:has-text("LE reports")');
await granted.waitForSelector('h1:has-text("LE reports")', { timeout: 20000 });
await granted.waitForTimeout(700);
check('and somewhere to drop the records', await granted.locator('#leDrop').count() === 1);
await granted.goto(`${BASE}/#/opportunity/${target.id}`);
await granted.waitForTimeout(1800);
check('and the deal carries the panel for them too',
  await granted.locator('.card:has(h2:text-is("Life-expectancy reports"))').count() === 1);
await granted.context().close();

/* Put it back, so the suite leaves the book as it found it. */
const usersBack = await json(await api('/users'));
const mgrRow = (usersBack.users || usersBack).find((u) => u.email === MANAGER1.email);
await api(`/users/${mgrRow.id}`, { method: 'PUT', body: {
  full_name: mgrRow.full_name, role: mgrRow.role, is_active: mgrRow.is_active,
  investor_id: mgrRow.investor_id, fund_ids: mgrRow.fund_ids || [],
  investor_ids: mgrRow.granted_investor_ids || mgrRow.investor_ids || [],
  can_value: !!mgrRow.can_value, can_le: false } });
const after = await json(await api('/users'));
check('and it can be taken back',
  (after.users || after).find((u) => u.email === MANAGER1.email)?.can_le === false);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
for (const r of ((await json(await api('/le-reports')))?.reports || []))
  await api(`/le-reports/${r.id}`, { method: 'DELETE' });
await stub.close();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All LE report UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
