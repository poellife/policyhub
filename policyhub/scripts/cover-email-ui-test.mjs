/* =====================================================================
   The cover and the covering email, on screen.

   The API suite proves the arithmetic and the privacy rule. What is
   under test here is what a person actually sees when they open the
   one-pager:

     - page one leads with the whole commitment, and the reader can find
       the premium figure without scrolling into a table;
     - the covering email is written WITHOUT being asked for, because
       "everytime it should also write an email summary" is the
       requirement, and a button somebody has to remember is not that;
     - picking a recipient changes the salutation and nothing else,
       because whatever the sender has edited below it is theirs.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'COVUI';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const funds = await json(await api('/funds'));
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Pacific Life', product_type: 'SUL',
  face_amount: 10000000, asking_price: 2200000, annual_premium: 313481,
  expected_close: '2026-10-01', fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Sommers', insured_first_name: 'Gerald',
  insured_dob: '1941-08-08', insured_gender: 'M', insured_state: 'IL',
  le_months: 36, le_provider: '21st', le_date: '2026-08-26',
  insured2_last_name: 'Sommers', insured2_first_name: 'Judith',
  insured2_dob: '1943-01-24', insured2_gender: 'F',
  insured2_le_months: 71, insured2_le_provider: '21st', insured2_le_date: '2026-08-26',
  thesis: 'Gerald is a repeat seller and the carrier has approved the transfer.' } }));
for (let i = 0; i < 8; i++)
  await api('/opportunity-premiums', { method: 'POST', body: {
    opportunity_id: deal.id, due_date: `${2026 + i}-10-01`, amount: 313481 } });

/* Somebody to address it to. */
const investors = await json(await api('/investors'));
if (investors?.length)
  await api(`/opportunities/${deal.id}/shares`, { method: 'PUT',
    body: { investor_ids: [investors[0].id] } });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });

await p.goto(`${BASE}/#/opportunity/${deal.id}/sheet-full`);
await p.waitForSelector('.opp-cover', { timeout: 20000 });
await p.waitForTimeout(400);

/* ------------------------------------------------------------------ *
 * Page one
 * ------------------------------------------------------------------ */
console.log('THE COVER LEADS WITH WHAT YOU PUT IN, IN FULL');
const cover = (await p.locator('.opp-cover').innerText()).replace(/\s+/g, ' ');
check('the first big figure is the total, not the purchase price',
  /YOU PUT IN \$4,080,886/i.test(cover), cover.slice(0, 120));
check('and the split is written under it',
  /\$2,200,000 at closing, then about \$313,000 a year/i.test(cover),
  (/at closing[^·]{0,40}a year/.exec(cover) || [])[0]);
check('the death benefit is beside it', /\$10,000,000/.test(cover));
check('and the return', /31\.07%|31\.1%/.test(cover));
check('the premium total gets a cell of its own', /\$1,880,886/.test(cover));
/* Both sentences came off the cover on request. The lead figure is the
   commitment — purchase price plus every premium — and the risk language
   is on the detail pages and in the disclaimer. */
check('the cover carries no closing caveat any more',
  !/premiums are a commitment/i.test(cover) && !/median, not a promise/i.test(cover));
check('nobody is named on it',
  !/Sommers/i.test(cover) && !/Gerald/i.test(cover) && !/Judith/i.test(cover));
check('the initials are', /G\.S\. & J\.S\./.test(cover));

const sheet = (await p.locator('.opp-sheet').innerText()).replace(/\s+/g, ' ');
check('the name is out of the investment case too, which had it typed in',
  /repeat seller/i.test(sheet) && !/Gerald/i.test(sheet), sheet.slice(-200));

/* ------------------------------------------------------------------ *
 * The covering email, unasked for
 * ------------------------------------------------------------------ */
console.log('\nAND THE EMAIL IS WRITTEN WITHOUT BEING ASKED FOR');
await p.waitForSelector('.mail-draft', { timeout: 20000 });
check('a draft appears beside the sheet', await p.locator('.mail-draft').count() === 1);
const subject = await p.inputValue('#mailSubject');
const body = await p.inputValue('#mailBody');
check('with a subject line', /Investment opportunity/.test(subject), subject);
check('and the same figures the sheet quotes',
  body.includes('$2,200,000') && body.includes('$1,880,886')
  && body.includes('$10,000,000'), body.slice(0, 200));
check('it tells the investor to look at the attachment',
  /Please see attached document for more detailed information\./.test(body));
check('it names the file to attach',
  /one-pager\.pdf/.test(await p.locator('.mail-draft').innerText()));
check('no name is in the draft',
  !/Sommers/i.test(body) && !/Gerald/i.test(body) && !/Judith/i.test(body),
  body.slice(0, 120));
check('and none in the subject', !/Sommers/i.test(subject));
check('it opens with no salutation, so it cannot go out addressed to the wrong person',
  !/^\w[^\n]{0,60},\n/.test(body), body.slice(0, 40));

if (investors?.length) {
  console.log('\nPICKING A RECIPIENT CHANGES THE SALUTATION AND NOTHING ELSE');
  await p.fill('#mailBody', `${body}\n\nP.S. one line I typed myself.`);
  await p.selectOption('#mailTo', { index: 1 });
  await p.waitForTimeout(200);
  const named = await p.inputValue('#mailBody');
  check('the greeting is added', /^[^\n]+,\n\n/.test(named), named.slice(0, 40));
  check('and the edit below it survives', /P\.S\. one line I typed myself\./.test(named));
  await p.selectOption('#mailTo', { index: 0 });
  await p.waitForTimeout(200);
  const back = await p.inputValue('#mailBody');
  check('choosing nobody takes the greeting off again',
    back.startsWith("Here's the detail on a new opportunity"), back.slice(0, 40));
  check('and still does not touch the rest',
    /P\.S\. one line I typed myself\./.test(back));
}

console.log('\nAND IT STAYS OFF THE PAPER');
check('the draft is marked no-print',
  await p.locator('.no-print .mail-draft, #sheetEmail.no-print').count() >= 1);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All cover and covering-email UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
