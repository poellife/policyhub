/* =====================================================================
   Data entry: the forms, as somebody actually types into them.

   Three small things that decide whether a book of record is trustworthy:
   a state that cannot be mistyped, a figure whose magnitude you can read
   without counting zeros, and a link to the file room that goes where it
   says it goes.

   Plus the record of who an opportunity was shown to, which is the part
   of sharing nobody remembers until they are asked.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'ENTRYUI';
const S = '/home/claude/shots';
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
  for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  for (const o of ((await json(await api('/opportunities?all=1'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE', body: { confirm: o.policy_number } });
};
await wipe();

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE); await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });

console.log('ENTERING A POLICY');
await p.goto(`${BASE}/#/policies`); await p.waitForTimeout(900);
await p.click('#newPolicyBtn');
await p.waitForSelector('dialog[open] input[name="policy_number"]');
await p.waitForTimeout(400);

const stateSel = p.locator('dialog[open] select[name="issue_state"]');
check('the issue state is a list, not a text box', (await stateSel.count()) === 1);
check('with every state in it',
  (await stateSel.locator('option').count()) >= 54,
  `${await stateSel.locator('option').count()} options`);
const opts = await stateSel.locator('option').allTextContents();
check('spelled out, so MI is not confused with MS',
  opts.some((o) => /^MI — Michigan$/.test(o.trim()))
  && opts.some((o) => /^MS — Mississippi$/.test(o.trim())),
  opts.slice(24, 27).join(' | '));
check('and it starts empty rather than guessing a state',
  (await stateSel.inputValue()) === '');

const face = p.locator('dialog[open] input[name="face_amount"]');
await face.click();
await p.keyboard.type('2500000');
check('a face amount groups its thousands as it is typed',
  (await face.inputValue()) === '2,500,000', await face.inputValue());
await p.keyboard.type('.5');
check('and keeps the cents', (await face.inputValue()) === '2,500,000.5',
  await face.inputValue());

/* Typing into the middle of a figure is where naive formatting throws the
   caret to the end. Put the caret after the leading 2 and type a digit. */
await face.evaluate((el) => el.setSelectionRange(1, 1));
await p.keyboard.type('7');
check('typing into the middle keeps the caret where it was',
  (await face.inputValue()) === '27,500,000.5', await face.inputValue());
const caret = await face.evaluate((el) => el.selectionStart);
check('immediately after the digit just typed', caret === 2, String(caret));

await face.fill('3,000,000');
await p.fill('dialog[open] input[name="policy_number"]', `${PREFIX}-1`);
await p.fill('dialog[open] input[name="carrier_name"]', 'Entry Life');
await p.fill('dialog[open] input[name="insured_last_name"]', 'Formfield');
await p.fill('dialog[open] input[name="insured_first_name"]', 'Frank');
await p.selectOption('dialog[open] select[name="gender"]', 'M');
await stateSel.selectOption('MI');
await p.fill('dialog[open] input[name="premium_required"]', '48000');
await p.fill('dialog[open] input[name="acquisition_cost"]', '412500');
await p.fill('dialog[open] input[name="documents_url"]',
  'https://www.dropbox.com/scl/fo/entry-ui-case-file');
await p.screenshot({ path: `${S}/en1-form.png`, fullPage: true });
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1800);

const made = ((await json(await api(`/policies?search=${PREFIX}&status=`))) || [])
  .find((x) => x.policy_number === `${PREFIX}-1`);
check('the policy saved', !!made, made ? '' : 'not found');
check('with the commas stripped back out of the numbers',
  Number(made?.face_amount) === 3000000 && Number(made?.acquisition_cost) === 412500,
  `${made?.face_amount} · ${made?.acquisition_cost}`);
check('and the state as a code', made?.issue_state === 'MI', made?.issue_state);
check('the sex of the insured came through', made?.insured_gender === 'M',
  String(made?.insured_gender));

console.log('\nSEX IS ON THE SCREEN, NOT JUST IN THE RECORD');
await p.goto(`${BASE}/#/policies`); await p.waitForSelector('table.data');
await p.waitForTimeout(900);
const heads = (await p.locator('table.data thead th').allTextContents()).map((h) => h.trim());
check('the policy list has a Sex column', heads.some((h) => /^Sex/.test(h)), heads.join(' | '));
const sexIdx = heads.findIndex((h) => /^Sex/.test(h));
const ourRow = p.locator('table.data tbody tr', { hasText: `${PREFIX}-1` }).first();
check('reading Male rather than a letter to decode',
  (await ourRow.locator('td').nth(sexIdx).textContent()).trim() === 'Male',
  (await ourRow.locator('td').nth(sexIdx).textContent()).trim());
/* The totals row spans the same width as the head — a column added above
   it must not push the figures one cell out of line. */
const footWidth = await p.locator('table.data tfoot tr').first().evaluate(
  (tr) => [...tr.children].reduce((n, td) => n + (Number(td.getAttribute('colspan')) || 1), 0));
check('and the totals row still spans the same width', footWidth === heads.length,
  `${footWidth} against ${heads.length} columns`);

console.log('\nTHE CASE FILES LINK');
await p.goto(`${BASE}/#/policy/${made.id}`); await p.waitForTimeout(1200);
const link = p.locator('a.ext-link').first();
check('the policy shows a link to the folder', (await link.count()) === 1);
check('pointing where it was told to',
  (await link.getAttribute('href')) === 'https://www.dropbox.com/scl/fo/entry-ui-case-file',
  await link.getAttribute('href'));
check('opening in its own tab', (await link.getAttribute('target')) === '_blank');
check('without handing the new tab this session',
  /noopener/.test(await link.getAttribute('rel')), await link.getAttribute('rel'));
await p.screenshot({ path: `${S}/en2-policy.png`, fullPage: true });

console.log('\nAN OPPORTUNITY, WITH WHAT THE CARRIER SAYS IT HOLDS');
await p.goto(`${BASE}/#/opportunities`); await p.waitForTimeout(900);
await p.click('#newOppBtn');
await p.waitForSelector('dialog[open] input[name="policy_number"]');
await p.waitForTimeout(400);
check('there is a place for the account value',
  (await p.locator('dialog[open] input[name="account_value"]').count()) === 1);
check('and for the cash surrender value',
  (await p.locator('dialog[open] input[name="cash_surrender_value"]').count()) === 1);
check('dated, because a value with no date is not a value',
  (await p.locator('dialog[open] input[name="values_as_of"]').getAttribute('type')) === 'date');
check('the opportunity state is a list too',
  (await p.locator('dialog[open] select[name="insured_state"]').count()) === 1);

await p.fill('dialog[open] input[name="policy_number"]', `${PREFIX}-OPP`);
await p.fill('dialog[open] input[name="carrier_name"]', 'Entry Life');
await p.fill('dialog[open] input[name="insured_last_name"]', 'Offered');
await p.fill('dialog[open] input[name="insured_first_name"]', 'Olive');
await p.fill('dialog[open] input[name="insured_dob"]', '1940-03-03');
await p.locator('dialog[open] select[name="insured_state"]').selectOption('FL');
await p.fill('dialog[open] input[name="le_months"]', '84');
await p.fill('dialog[open] input[name="face_amount"]', '4000000');
await p.fill('dialog[open] input[name="asking_price"]', '620000');
await p.fill('dialog[open] input[name="annual_premium"]', '60000');
const av = p.locator('dialog[open] input[name="account_value"]');
await av.click(); await p.keyboard.type('185000');
check('the account value groups as it is typed', (await av.inputValue()) === '185,000',
  await av.inputValue());
await p.fill('dialog[open] input[name="cash_surrender_value"]', '162000');
await p.fill('dialog[open] input[name="values_as_of"]', '2026-07-31');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2000);

const opp = ((await json(await api('/opportunities?all=1'))) || [])
  .find((x) => x.policy_number === `${PREFIX}-OPP`);
check('the opportunity saved', !!opp);
const oppPage = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the carrier values card is on the page', /Carrier values/.test(oppPage));
check('showing the account value', /\$185,000/.test(oppPage), oppPage.slice(0, 160));
check('and the surrender value', /\$162,000/.test(oppPage));
check('with the gap over surrender the price actually represents',
  /\$458,000/.test(oppPage), 'asking 620,000 less surrender 162,000');
check('as at the date the carrier stated', /07\/31\/2026/.test(oppPage));
await p.screenshot({ path: `${S}/en3-opp.png`, fullPage: true });

console.log('\nWHO IT WAS SHOWN TO');
check('the page says nobody has seen it yet',
  /Not shared with anybody yet/.test(oppPage));
await p.click('#shareOppBtn');
await p.waitForSelector('dialog[open]');
await p.waitForTimeout(500);
const picker = p.locator('dialog[open] select[name="investor_ids"]');
const investorName = (await picker.locator('option').first().textContent()).trim();
await picker.selectOption({ index: 0 });
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1800);

const shared = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the shared-with card names the investor',
  shared.includes(investorName),
  shared.slice(shared.indexOf('Shared with'), shared.indexOf('Shared with') + 200));
check('with the date it went out',
  new RegExp(new Date().toLocaleDateString('en-US')).test(shared));
check('the time of day as well, since two sends in a day are not the same send',
  /\d{1,2}:\d{2}\s?(AM|PM)/i.test(shared), shared.slice(shared.indexOf('Shared with'), shared.indexOf('Shared with') + 200));
check('who sent it', /Test Admin/.test(shared));
check('and that they have not asked for anything yet', /nothing yet/.test(shared));
await p.screenshot({ path: `${S}/en4-shared.png`, fullPage: true });

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL ENTRY UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
