/* =====================================================================
   Medical review, on screen.

   The API suite proves the wall and the arithmetic. What is under test
   here is what each of the two people actually sees.

   THE DOCTOR signs in and lands on one screen. There is no menu into the
   book because there is no book on his menu — a tab that answers 403 is
   worse than no tab, it reads as a broken application rather than as a
   boundary. His case shows the chart and the box for his opinion, and
   nowhere on it is a price, a death benefit or a rate.

   THE DESK sees a panel on the deal: what is out, what has come back,
   his reasoning set as prose rather than squeezed into a cell, and the
   one button that takes his number onto the case.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'MEDUI';
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
  for (const u of ((await json(await api('/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX.toLowerCase())))
    await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();

const docEmail = `${PREFIX.toLowerCase()}-doctor@example.test`;
const docPassword = scratchPassword('medui');
const doctor = await json(await api('/users', { method: 'POST', body: {
  email: docEmail, password: docPassword, full_name: 'Dr Helen Marsh', role: 'medical' } }));

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
  impairments: 'Coronary artery disease, three-vessel.\nType 2 diabetes, insulin dependent.',
  mitigating: 'Still driving and living independently.' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

/* ------------------------------------------------------------------ *
 * The desk sends it
 * ------------------------------------------------------------------ */
console.log('THE DESK SENDS A CASE FROM THE DEAL');
const deskCtx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const desk = await deskCtx.newPage();
desk.on('pageerror', (e) => errs.push(`desk: ${e.message}`));
desk.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text())
  && errs.push(`desk: ${m.text()}`));
await desk.goto(BASE);
await desk.fill('#email', ADMIN.email);
await desk.fill('#password', ADMIN.password);
await desk.click('button[type=submit]');
await desk.waitForSelector('.kpi-row', { timeout: 20000 });
await desk.goto(`${BASE}/#/opportunity/${deal.id}`);
await desk.waitForSelector('.scenario-table', { timeout: 20000 });
await desk.waitForTimeout(500);

const panel = () => desk.locator('.card:has(h2:text-is("Medical review"))');
check('the deal carries a medical review panel', await panel().count() === 1);
check('and it says what the doctor will and will not see',
  /no price, no death benefit, no rate of return/i.test(await panel().innerText()));

await desk.click('#medSendBtn');
await desk.waitForSelector('dialog[open] select[name=reviewer_id]', { timeout: 20000 });
const dlg = desk.locator('dialog[open]');
check('the reviewing doctor can be chosen by name',
  (await dlg.locator('select[name=reviewer_id]').innerText()).includes('Helen Marsh'));
check('a two-life deal asks WHICH insured',
  await dlg.locator('select[name=life]').count() === 1);
check('and says why they go separately',
  /two different charts/i.test(await dlg.innerText()));
await dlg.locator('select[name=life]').selectOption('1');
await dlg.locator('textarea[name=ask]')
  .fill('The 21st estimate is 36 months. The cardiology reads worse to me.');
await dlg.locator('button[type=submit]').click();
await desk.waitForTimeout(1800);
check('the request is on the panel',
  /Waiting for you|In progress/i.test(await panel().innerText()),
  (await panel().innerText()).replace(/\s+/g, ' ').slice(0, 120));

/* ------------------------------------------------------------------ *
 * The doctor's whole application
 * ------------------------------------------------------------------ */
console.log('\nAND THE DOCTOR OPENS ON ONE SCREEN');
const docCtx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const doc = await docCtx.newPage();
doc.on('pageerror', (e) => errs.push(`doc: ${e.message}`));
doc.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text())
  && errs.push(`doc: ${m.text()}`));
await doc.goto(BASE);
await doc.fill('#email', docEmail);
await doc.fill('#password', docPassword);
await doc.click('button[type=submit]');
await doc.waitForSelector('.med-card, .empty', { timeout: 20000 });

const menu = (await doc.locator('nav, .sidebar, .nav').first().innerText())
  .replace(/\s+/g, ' ');
check('the menu is the queue and their own account, and nothing else',
  /To review/i.test(menu) && !/Policies/i.test(menu) && !/Opportunit/i.test(menu)
  && !/Investors/i.test(menu) && !/Reports/i.test(menu), menu.slice(0, 140));

const queue = (await doc.locator('.med-card').first().innerText()).replace(/\s+/g, ' ');
check('the case is in the queue with the person on it',
  /Gerald Sommers/.test(queue), queue.slice(0, 120));
check('and what was asked', /cardiology reads worse/i.test(queue));
check('the page says the economics are absent on purpose',
  /without them/i.test(await doc.locator('.med-foot').innerText()),
  await doc.locator('.med-foot').innerText());

await doc.locator('.med-card').first().click();
await doc.waitForSelector('#medForm', { timeout: 20000 });
await doc.waitForTimeout(400);
const page = (await doc.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
check('the chart is on the case', /Gerald Sommers/.test(page)
  && /1941/.test(page) && /Coronary artery disease/.test(page));
check('no price anywhere on it',
  !/2,200,000/.test(page) && !/10,000,000/.test(page) && !/asking/i.test(page),
  page.slice(0, 120));
check('no rate of return', !/%/.test(page.replace(/\d+\s*mo/g, '')) || !/31\./.test(page));
/* The provider and the months on the deal are not sent. The ASK is,
   word for word, and in this fixture it happens to name both — which is
   correct: that is the desk deliberately asking a question, not the
   system volunteering an answer. So the assertion is on the file block,
   not on the page. */
const fileBlock = (await doc.locator('.card:has(h2:text-is("The file"))').innerText())
  .replace(/\s+/g, ' ');
check('the estimate already on the deal is not in the file he is sent',
  !/36/.test(fileBlock) && !/21st/.test(fileBlock), fileBlock.slice(0, 140));

console.log('\nHE ANSWERS IN MONTHS, AND SEES THE YEARS AS HE TYPES');
await doc.fill('input[name=le_months]', '60');
await doc.waitForTimeout(200);
check('the months are echoed back in years',
  (await doc.locator('#medYears').innerText()).includes('5.0'),
  await doc.locator('#medYears').innerText());

await doc.click('#medReturn');
await doc.waitForTimeout(600);
check('returning without the reasoning is refused on screen',
  /not a review|say something/i.test(await doc.locator('#medMsg').innerText()),
  await doc.locator('#medMsg').innerText());

await doc.fill('textarea[name=findings]',
  'Three-vessel disease with a preserved ejection fraction reads closer to five years.');
await doc.fill('textarea[name=impairments]', 'Three-vessel coronary disease\nType 2 diabetes');
await doc.selectOption('select[name=recommendation]', 'Proceed');
await doc.click('#medReturn');
await doc.waitForTimeout(2000);
check('and with it, it goes back', /#\/medical$/.test(doc.url()) || !doc.url().match(/medical\/\d/),
  doc.url());

/* ------------------------------------------------------------------ *
 * What the desk gets back
 * ------------------------------------------------------------------ */
console.log('\nAND THE DESK READS THE REASONING, NOT JUST THE NUMBER');
await desk.reload();
await desk.waitForSelector('.scenario-table', { timeout: 20000 });
await desk.waitForTimeout(700);
const back = (await panel().innerText()).replace(/\s+/g, ' ');
check('his estimate is on the panel', /60 mo/.test(back), back.slice(0, 200));
check('with his name against it', /Helen Marsh/.test(back));
check('his recommendation', /Proceed/.test(back));
check('and his reasoning, set as prose',
  /preserved ejection fraction/i.test(back));
check('the button names what it would change rather than asking "are you sure"',
  /Use 60 mo instead of 36/.test(back), back.slice(-160));

const before = await json(await api(`/opportunities/${deal.id}`));
check('and until it is pressed the deal still carries 36',
  Number(before.le_months) === 36, String(before.le_months));

desk.on('dialog', (d) => d.accept());
await desk.locator('[data-med-adopt]').first().click();
await desk.waitForTimeout(2000);
const after = await json(await api(`/opportunities/${deal.id}`));
check('pressing it reprices the record', Number(after.le_months) === 60,
  String(after.le_months));
check('and says where the number came from', /Marsh/i.test(after.le_provider || ''),
  after.le_provider);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All medical review UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
