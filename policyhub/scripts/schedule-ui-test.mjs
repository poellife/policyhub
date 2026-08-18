/* =====================================================================
   The follow-up schedule on screen, and the medical picture on an
   opportunity.

   The point of a scheduled step is that it comes back at you on the day
   it matters, so these checks follow one from the button that creates it
   through to the servicing calendar and back.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'SCHEDUI';
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
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const us = (d) => { const [y, m, dd] = iso(d).split('-'); return `${m}/${dd}/${y}`; };

const wipe = async () => {
  for (const p of ((await json(await api(`/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const funds = await json(await api('/funds'));
const policy = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Screen Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 2000000, premium_required: 24000, premium_mode: 'Annual',
  next_premium_due: iso(300),
  insured_last_name: 'Stepscreen', insured_first_name: 'Sara', dob: '1941-07-07' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE); await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });

const servicingTab = async () => {
  await p.goto(`${BASE}/#/policy/${policy.id}?tab=servicing`);
  await p.waitForSelector('.tabs'); await p.waitForTimeout(500);
  const btn = p.locator('.tabs button', { hasText: 'Servicing' });
  if (await btn.count()) await btn.first().click();
  await p.waitForTimeout(800);
};

console.log('THE CARD AND THE BUTTON');
await servicingTab();
const card = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the card is called the follow-up schedule', /Follow-up schedule/i.test(card),
  card.slice(0, 200));
check('and no longer says status checks', !/Status checks/i.test(card));
check('the button says Schedule next step',
  (await p.locator('#scheduleStepBtn').count()) === 1);
check('and Advance next due date is gone',
  !/Advance next due date/i.test(card));
check('Log premium payment is still there',
  (await p.locator('#logPremiumBtn').count()) === 1);
await p.screenshot({ path: `${S}/sc1-empty.png`, fullPage: true });

console.log('\nSCHEDULING A FUTURE PREMIUM');
await p.click('#scheduleStepBtn');
await p.waitForSelector('dialog[open] input[name="due_date"]');
await p.waitForTimeout(400);
check('the dialog offers a calendar date field',
  (await p.locator('dialog[open] input[name="due_date"]').getAttribute('type')) === 'date');
check('pre-filled a period ahead rather than blank',
  (await p.locator('dialog[open] input[name="due_date"]').inputValue()).length === 10,
  await p.locator('dialog[open] input[name="due_date"]').inputValue());
check('premium is the default kind',
  await p.locator('dialog[open] input[name="kind"][value="Premium"]').isChecked());
check('and the estimated amount is shown for it',
  await p.locator('#stepAmountField').isVisible());
check('pre-filled from the policy premium',
  // The field groups thousands as you type, so read it the way a person does.
  (await p.locator('dialog[open] input[name="amount"]').inputValue()) === '24,000',
  await p.locator('dialog[open] input[name="amount"]').inputValue());
const dlgText = (await p.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('the dialog says the amount is an estimate', /amount is an estimate/i.test(dlgText));
check('and points the actual payment at the ledger', /Log premium payment/.test(dlgText));

await p.fill('dialog[open] input[name="due_date"]', iso(20));
await p.fill('dialog[open] input[name="amount"]', '31500.75');
await p.fill('dialog[open] textarea[name="note"]', 'Step-up per the carrier illustration');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1500);
await servicingTab();
const withStep = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('it appears on the schedule', /\$31,500\.75/.test(withStep), withStep.slice(0, 260));
check('with the date it is due', withStep.includes(us(20)));
check('how far away it is', /in 20 days/.test(withStep));
check('and the note', /Step-up per the carrier illustration/.test(withStep));
check('counted in the card head', /1 outstanding/.test(withStep));

console.log('\nSCHEDULING SOMETHING THAT IS NOT A PAYMENT');
await p.click('#scheduleStepBtn');
await p.waitForSelector('dialog[open] input[name="kind"][value="Reminder"]');
// The radio sits under its own label text, so click the choice, as a person would.
await p.locator('dialog[open] .step-kind label', { hasText: 'Reminder' }).click();
await p.waitForTimeout(400);
check('choosing a reminder hides the amount',
  !(await p.locator('#stepAmountField').isVisible()));
check('and the note becomes required in the label',
  /What is the reminder for/.test(await p.locator('#stepNoteLabel').textContent()));
await p.fill('dialog[open] input[name="due_date"]', iso(-3));
await p.fill('dialog[open] textarea[name="note"]', 'Chase the change-of-ownership form');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1500);
await servicingTab();
const withBoth = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the reminder is on the schedule', /Chase the change-of-ownership form/.test(withBoth));
check('shown as a follow-up, not a premium', /Follow-up/.test(withBoth));
check('and flagged as overdue', /3 days overdue/.test(withBoth));
check('with no dollar figure against it',
  !/Follow-up[^$]*\$/.test(withBoth.slice(withBoth.indexOf('Follow-up'), withBoth.indexOf('Follow-up') + 80)));
check('both are counted', /2 outstanding/.test(withBoth));
await p.screenshot({ path: `${S}/sc2-scheduled.png`, fullPage: true });

console.log('\nON THE SERVICING CALENDAR');
await p.goto(`${BASE}/#/servicing`); await p.waitForSelector('.alert-row');
await p.waitForTimeout(900);
const cal = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the overdue follow-up is an alert', /Chase the change-of-ownership form/.test(cal));
check('named as overdue', /Follow-up 3 days overdue/.test(cal));
check('the scheduled premium is there too', /Scheduled premium of about \$31,500\.75/.test(cal));
check('and the heading counts them', /follow-ups outstanding|follow-up outstanding/.test(cal));
await p.screenshot({ path: `${S}/sc3-calendar.png`, fullPage: true });

console.log('\nTICKING ONE OFF AND PUTTING IT BACK');
await servicingTab();
const row = p.locator('.step-row', { hasText: 'Chase the change-of-ownership' });
await row.locator('[data-step-done]').click();
await p.waitForTimeout(1500); await servicingTab();
check('it drops out of the outstanding count', /1 outstanding/.test(
  (await p.locator('.main').textContent()).replace(/\s+/g, ' ')));
check('and moves under a completed fold',
  (await p.locator('details').count()) >= 1);
await p.locator('details summary').first().click();
await p.waitForTimeout(400);
const doneRow = p.locator('.step-row.step-done', { hasText: 'Chase the change-of-ownership' });
check('where it is dimmed but readable', (await doneRow.count()) === 1);
await doneRow.locator('[data-step-done]').click();
await p.waitForTimeout(1500); await servicingTab();
check('reopening brings it back', /2 outstanding/.test(
  (await p.locator('.main').textContent()).replace(/\s+/g, ' ')));

console.log('\nEDITING AND REMOVING');
const premRow = p.locator('.step-row', { hasText: '$31,500.75' });
await premRow.locator('[data-step-edit]').click();
await p.waitForSelector('dialog[open] input[name="amount"]');
await p.waitForTimeout(400);
check('editing loads the values back in',
  (await p.locator('dialog[open] input[name="amount"]').inputValue()) === '31,500.75');
await p.fill('dialog[open] input[name="amount"]', '28000');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1500); await servicingTab();
check('the change sticks', /\$28,000\.00/.test(
  (await p.locator('.main').textContent()).replace(/\s+/g, ' ')));
p.on('dialog', (d) => d.accept());
await p.locator('.step-row', { hasText: '$28,000.00' }).locator('[data-step-del]').click();
await p.waitForTimeout(1500); await servicingTab();
check('and it can be removed', !/\$28,000\.00/.test(
  (await p.locator('.main').textContent()).replace(/\s+/g, ' ')));

console.log('\nAN INVESTOR SEES NONE OF IT');
const ictx = await br.newContext({ viewport: { width: 1400, height: 950 } });
const ip = await ictx.newPage();
ip.on('pageerror', (e) => errs.push(`investor: ${e.message}`));
await ip.goto(BASE); await ip.fill('#email', INVESTOR1.email);
await ip.fill('#password', INVESTOR1.password);
await ip.click('button[type=submit]'); await ip.waitForSelector('.kpi-row', { timeout: 12000 });
await ip.goto(`${BASE}/#/servicing`); await ip.waitForTimeout(1000);
const itext = (await ip.locator('.main').textContent()).replace(/\s+/g, ' ');
check('no follow-up work on their premium screen',
  !/change-of-ownership/i.test(itext) && !/Follow-up \d+ days/.test(itext));

console.log('\nTHE OPPORTUNITY SHOWS WHAT THE PDF SHOWS');
const opp = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-OPP`, carrier_name: 'Screen Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: 'Fullpicture', insured_first_name: 'Ines',
  insured_dob: '1940-02-02', le_months: 96, le_provider: 'AVS', le_date: '2026-01-01',
  le_provider_2: 'Polaris PUW-41491', le_months_2: 99, records_through: '2025-05-31',
  asking_price: 700000, annual_premium: 50000, expected_close: '2026-10-01',
  offer_closes_on: '2027-01-31', fund_id: funds[0].id,
  impairments: 'Cardiovascular: CAD s/p 5 stents (2023)\nHepatic: fatty liver with ongoing ETOH',
  mitigating: '60 lb weight loss improved OSA and labs',
  underwriter_note: 'Mortality risk is higher than at prior underwriting.',
  thesis: 'Discounted entry at 17.5% of face\nTwo independent LE reports within three months' } }));
await api(`/opportunities/${opp.id}/shares`, { method: 'PUT', body: {
  investor_ids: [(await json(await fetch(`${BASE}/api/auth/me`,
    { headers: { Cookie: (await login(INVESTOR1.email, INVESTOR1.password)) } }))).investor.id] } });

await p.goto(`${BASE}/#/opportunity/${opp.id}`);
await p.waitForSelector('.scenario-table'); await p.waitForTimeout(900);
const oppText = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the medical section is on the page', /Life expectancy and the medical picture/i.test(oppText));
check('with the impairments', /CAD s\/p 5 stents/.test(oppText));
check('and the mitigating factors', /60 lb weight loss/.test(oppText));
check('and the underwriter assessment', /higher than at prior underwriting/.test(oppText));
check('the second LE report is named', /Polaris PUW-41491/.test(oppText));
check('with the records-through date', /05\/31\/2025/.test(oppText));
check('and the investment case', /Two independent LE reports/.test(oppText));
await p.screenshot({ path: `${S}/sc4-opportunity.png`, fullPage: true });

await ip.goto(`${BASE}/#/opportunity/${opp.id}`);
await ip.waitForSelector('.scenario-table', { timeout: 12000 }); await ip.waitForTimeout(900);
const ioppText = (await ip.locator('.main').textContent()).replace(/\s+/g, ' ');
check('an investor it was shared with sees it too', /CAD s\/p 5 stents/.test(ioppText));
check('including the investment case', /Two independent LE reports/.test(ioppText));

console.log('\nERRORS');
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL SCHEDULE UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
