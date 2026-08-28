/* =====================================================================
   Offering a hand-entered policy — on screen.

   The API suite proves the offer is built correctly. This is about the
   dialog: whether the person pressing the button can see who holds what,
   how much goes on offer if this box is ticked, and — because this is
   the one place the policy's fate is a question rather than a
   consequence — what choosing to remove it would cost.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'OFFERUI';
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

const pol = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Direct Life', product_type: 'UL',
  face_amount: 3500000, status: 'Inforce', fund_id: funds[0].id,
  insured_last_name: 'Keyed', insured_first_name: 'Kay',
  insured_dob: '1944-08-30', insured_gender: 'F', insured_state: 'MI', le_months: 76,
  acquisition_date: '2026-01-20', acquisition_cost: 690000,
  premium_required: 48000, premium_mode: 'Annual' } }));
for (const [id, pct] of [[me1, 50], [me2, 20]])
  await api(admin, `/policies/${pol.id}/investors`, {
    method: 'POST', body: { investor_id: id, pct, acquired_on: '2026-01-20' } });
await api(admin, `/policies/${pol.id}/transactions`, { method: 'POST', body: {
  txn_date: '2026-03-10', txn_type: 'Premium', amount: 12000, remarks: `${PREFIX} premium` } });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1200 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/policy/${pol.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(700);

console.log('A HAND-ENTERED POLICY OFFERS THE WAY ON TO THE LIST');
check('the button is on the policy page', await p.locator('#offerPolicyBtn').count() === 1);

await p.click('#offerPolicyBtn');
await p.waitForSelector('dialog .pick-list', { timeout: 10000 });
/* Read the cap-table list itself, not the whole dialog: the paragraph
   above it mentions figures too, and a check that passes on the prose
   would keep passing with an empty list. */
const picks = () => p.locator('dialog .pick-list').innerText();
check('the dialog lists both holders with their percentages',
  /50%/.test(await picks()) && /20%/.test(await picks()), await picks());
check('the asking price is prefilled from the acquisition cost',
  (await p.inputValue('dialog input[name=asking_price]')).replace(/,/g, '') === '690000',
  await p.inputValue('dialog input[name=asking_price]'));

const note = () => p.locator('#freedNote').innerText();
check('before anything is ticked it names the share never placed',
  /30/.test(await note()), await note());

console.log('\nTHE POLICY’S FATE IS ASKED, NOT ASSUMED');
check('keeping it is the default',
  await p.locator('dialog input[name=policy_fate][value=keep]').isChecked());
check('and the warning is out of the way until it is wanted',
  await p.locator('#removeWarn').isHidden());
await p.check('dialog input[name=policy_fate][value=remove]');
await p.waitForTimeout(250);
check('choosing to remove it shows what that destroys',
  await p.locator('#removeWarn').isVisible());
check('naming the transaction on the ledger',
  /transaction/i.test(await p.locator('#removeWarn').innerText()),
  await p.locator('#removeWarn').innerText());
check('and asking for the policy number',
  await p.locator('dialog input[name=confirm]').count() === 1);
await p.check('dialog input[name=policy_fate][value=keep]');
await p.waitForTimeout(200);
check('going back to keeping it puts the warning away',
  await p.locator('#removeWarn').isHidden());

console.log('\nTICKING WHO LEFT MOVES THE FIGURE');
for (const r of await p.locator('dialog .pick-list .entity-opt').all())
  if (/20/.test(await r.innerText())) await r.locator('input').check();
await p.waitForTimeout(250);
check('the share on offer grows by what was released', /50/.test(await note()), await note());

await p.click('dialog button[type=submit]');
await p.waitForTimeout(2500);
check('it lands on the new opportunity', /#\/opportunity\//.test(p.url()), p.url());

const list = (await json(await api(admin, '/opportunities'))) || [];
const made = list.find((x) => x.policy_number === `${PREFIX}-1`);
check('which is Open', made?.status === 'Open', made?.status);
const full = await json(await api(admin, `/opportunities/${made.id}`));
check('carrying the holder who stayed at 50%',
  full.commitments.some((c) => c.investor_id === me1 && c.status === 'Confirmed'
    && Number(c.pct) === 50));
check('with 50% available', Number(full.remaining_pct) === 50, String(full.remaining_pct));
const still = await json(await api(admin, `/policies/${pol.id}`));
check('and the policy still in the portfolio, minus the leaver',
  (still.owners || []).length === 1 && still.owners[0].investor_id === me1,
  JSON.stringify((still.owners || []).map((x) => x.investor_id)));

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await wipe();
console.log(fails.length
  ? `\n${fails.length} OFFER-POLICY UI CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL OFFER-POLICY UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
