/* =====================================================================
   Sending a funded deal back to the list — on screen.

   The API suite proves the reversal is correct. This one is about the
   moment before it: whether the person pressing the button can see what
   it will do. Three things have to be on the screen — who is holding
   what, how much goes back on offer if this box is ticked, and what the
   delete would destroy.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'REOPENUI';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const admin = await login(ADMIN.email, ADMIN.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);
const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const funds = await json(await api(admin, '/funds'));
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const o = await json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Reopen Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: 'Screener', insured_first_name: 'Sue',
  insured_dob: '1945-03-08', insured_gender: 'F', insured_state: 'MI',
  le_months: 72, asking_price: 700000, annual_premium: 60000,
  expected_close: '2026-10-15', offer_closes_on: '2027-05-31', fund_id: funds[0].id } }));
await api(admin, `/opportunities/${o.id}/shares`, {
  method: 'PUT', body: { investor_ids: [me1, me2] } });
await api(inv1, `/opportunities/${o.id}/commit`, { method: 'POST', body: { pct: 55 } });
await api(inv2, `/opportunities/${o.id}/commit`, { method: 'POST', body: { pct: 25 } });
for (const c of (await json(await api(admin, `/opportunities/${o.id}`))).commitments)
  await api(admin, `/opportunity-commitments/${c.id}`, {
    method: 'PUT', body: { status: 'Confirmed' } });
await api(admin, `/opportunities/${o.id}/fund`, { method: 'POST' });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });

await p.goto(`${BASE}/#/opportunity/${o.id}`);
await p.waitForSelector('.opp-card', { timeout: 20000 });
await p.waitForTimeout(600);

console.log('A FUNDED DEAL OFFERS THE WAY BACK');
check('the button is on the page', await p.locator('#unfundOppBtn').count() === 1);
check('and "Fund it" is not offered twice', await p.locator('#fundOppBtn').count() === 0);

await p.click('#unfundOppBtn');
await p.waitForSelector('dialog .pick-list', { timeout: 10000 });
const body = await p.locator('dialog .dialog-body').innerText();
check('the dialog says the policy comes off the books',
  /comes out of the portfolio/i.test(body), body.slice(0, 120));
check('and lists both investors with their percentages',
  /55/.test(body) && /25/.test(body), body.slice(0, 400));

const note = () => p.locator('#freedNote').innerText();
check('before anything is ticked it states what is available as it stands',
  /20/.test(await note()), await note());

const boxes = p.locator('dialog input[name=backing_out]');
check('there is a box per live commitment', await boxes.count() === 2,
  String(await boxes.count()));
/* Tick the 25% holder. The figure has to move before the button is
   pressed — that is the whole point of the control. */
const rows = await p.locator('dialog .entity-opt').all();
for (const r of rows) if (/25/.test(await r.innerText())) await r.locator('input').check();
await p.waitForTimeout(250);
check('ticking one recomputes what goes back on offer', /45/.test(await note()),
  await note());

await p.click('dialog button[type=submit]');
await p.waitForTimeout(2200);

/* Open renders a live deadline chip; anything else renders a closed one
   carrying the status word. Reading the chip rather than the page text
   keeps the check off the carrier name, which happens to contain the
   word "Reopen" and would pass for the wrong reason. */
const closed = await p.locator('.opp-deadline.closed').count();
check('the status chip is live again rather than closed', closed === 0, `${closed} closed chip(s)`);
check('and no longer says Funded',
  !/Funded/.test(await p.locator('.page-head').innerText()));
const after = await json(await api(admin, `/opportunities/${o.id}`));
check('and the server agrees', after.status === 'Open', after.status);
check('with 45% available', Number(after.remaining_pct) === 45, String(after.remaining_pct));
check('the investor who stayed is untouched',
  after.commitments.some((c) => c.investor_id === me1 && c.status === 'Confirmed'));

await p.waitForTimeout(400);
check('and the page now offers to fund it again',
  await p.locator('#fundOppBtn').count() === 1);

await p.screenshot({ path: '/home/claude/shots/reopen-after.png' });
console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await wipe();
console.log(fails.length
  ? `\n${fails.length} REOPEN UI CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL REOPEN UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
