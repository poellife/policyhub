/* =====================================================================
   An investor passing on a deal.

   Until now an investor had two answers — ask for a piece, or say
   nothing — and silence is not an answer anybody can act on. The desk
   could not tell "has not looked" from "looked and is not interested",
   and the investor's own list kept showing a deal they had decided
   against as if it were still waiting on them.

   Under test, on the wire and on the screen:
     - passing takes the deal off their open list and out of the badge;
     - the desk sees who passed and why, where it used to see a blank;
     - a pass and a live request cannot both stand;
     - changing their mind is one click, and leaves them undecided;
     - nobody but the investor can pass for them, and no investor sees
       another's answer.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'OPPPASS';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const call = (c) => (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const api = call(cookie);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const inv1Cookie = await login(INVESTOR1.email, INVESTOR1.password);
const inv1 = call(inv1Cookie);
const me1 = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: inv1Cookie } })))
  .investor.id;
const inv2Cookie = await login(INVESTOR2.email, INVESTOR2.password);
const inv2 = call(inv2Cookie);
const me2 = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: inv2Cookie } })))
  .investor.id;

const funds = await json(await api('/funds'));
const make = async (tag) => {
  const d = await json(await api('/opportunities', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    face_amount: 1500000, fund_id: funds[0].id, status: 'Open',
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', insured_dob: '1942-03-02',
    le_months: 72, asking_price: 300000, annual_premium: 40000 } }));
  await api(`/opportunities/${d.id}/shares`, { method: 'PUT',
    body: { investor_ids: [me1, me2] } });
  return d;
};
const deal = await make('1');
const other = await make('2');

const badge = async (c) => (await json(await c('/opportunities/summary'))).undecided;
const before = await badge(inv1);

console.log('PASSING TAKES IT OFF THEIR LIST');
const passed = await inv1(`/opportunities/${deal.id}/pass`, { method: 'POST',
  body: { reason: 'Too long a wait' } });
check('an investor can pass on a deal shared with them', passed.status === 200,
  String(passed.status));
const mine = await json(await inv1(`/opportunities/${deal.id}`));
check('their copy of the deal says so', !!mine.my_pass?.passed_at,
  JSON.stringify(mine.my_pass));
check('with what they said', mine.my_pass?.reason === 'Too long a wait');
const listed = (await json(await inv1('/opportunities'))).find((x) => x.id === deal.id);
check('and the list marks it answered', !!listed?.my_passed_at, String(listed?.my_passed_at));
check('the badge counts one fewer deal waiting on them',
  (await badge(inv1)) === before - 1, `${await badge(inv1)} vs ${before}`);

console.log('\nTHE DESK SEES WHO PASSED, WHERE IT USED TO SEE A BLANK');
const desk = await json(await api(`/opportunities/${deal.id}`));
const theirs = (desk.passes || []).find((x) => x.investor_id === me1);
check('the pass is on the deal for the desk', !!theirs, JSON.stringify(desk.passes));
check('named, dated, with the reason', !!theirs?.investor_name && !!theirs?.passed_at
  && theirs?.reason === 'Too long a wait');

console.log('\nNO INVESTOR SEES ANOTHER’S ANSWER');
const seen2 = await json(await inv2(`/opportunities/${deal.id}`));
check('the other investor has no pass of their own', seen2.my_pass === null,
  JSON.stringify(seen2.my_pass));
check('and is not told anybody else passed', seen2.passes === undefined
  && !JSON.stringify(seen2).includes('Too long a wait'));

console.log('\nA PASS AND A REQUEST CANNOT BOTH STAND');
const min = Number((await json(await inv2(`/opportunities/${other.id}`))).min_commitment_pct) || 5;
const asked = await inv2(`/opportunities/${other.id}/commit`, { method: 'POST',
  body: { pct: Math.max(min, 10) } });
check('(the other investor asks for a piece of the second deal)', asked.status < 300,
  String(asked.status));
const both = await inv2(`/opportunities/${other.id}/pass`, { method: 'POST', body: {} });
check('and is then refused a pass on it, with the reason why', both.status === 409,
  String(both.status));
check('the request stands untouched',
  (await json(await inv2(`/opportunities/${other.id}`))).my_commitment?.status === 'Requested');

console.log('\nCHANGING THEIR MIND IS ONE CALL');
const undo = await inv1(`/opportunities/${deal.id}/pass`, { method: 'DELETE' });
check('the pass can be taken back', undo.status === 200, String(undo.status));
check('and they are undecided again, not "un-passed"',
  (await json(await inv1(`/opportunities/${deal.id}`))).my_pass === null);
check('back on the badge', (await badge(inv1)) === before, `${await badge(inv1)} vs ${before}`);
check('and off the desk’s list of passes',
  !((await json(await api(`/opportunities/${deal.id}`))).passes || [])
    .some((x) => x.investor_id === me1));
check('taking back a pass that is not there is a plain not-found',
  (await inv1(`/opportunities/${deal.id}/pass`, { method: 'DELETE' })).status === 404);

console.log('\nNOBODY PASSES FOR THEM');
check('staff cannot pass on an investor’s behalf',
  (await api(`/opportunities/${deal.id}/pass`, { method: 'POST', body: {} })).status === 403);
const unshared = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-3`, carrier_name: 'Northbank Life', fund_id: funds[0].id,
  insured_last_name: `${PREFIX}3`, status: 'Open' } }));
check('and an investor cannot pass on a deal never shown to them',
  (await inv1(`/opportunities/${unshared.id}/pass`, { method: 'POST', body: {} })).status === 404);

console.log('\nON THE SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
const signIn = async (who) => {
  await ctx.clearCookies();
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });
};

await signIn(INVESTOR1);
await p.goto(`${BASE}/#/opportunity/${deal.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1200);
check('the deal page offers a pass', await p.locator('#passBtn').count() === 1);
await p.click('#passBtn');
await p.waitForSelector('dialog[open] select[name="preset"]', { timeout: 20000 });
check('with a few common reasons, none of them required',
  await p.locator('dialog[open] select[name="preset"] option').count() >= 4);
await p.selectOption('dialog[open] select[name="preset"]', 'The return is too low for me');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1800);
const after = (await p.locator('.main, body').first().innerText()).replace(/\s+/g, ' ');
check('the page then says they passed', /You passed on this/.test(after), after.slice(0, 200));
check('and says what they said', /return is too low/.test(after));
check('the request box is no longer offered over it',
  await p.locator('#takeBtn').count() === 0);
check('and there is a way back', await p.locator('#unpassBtn').count() === 1);

await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1000);
const list = (await p.locator('.main, body').first().innerText()).replace(/\s+/g, ' ');
check('on their list it has moved under its own heading',
  /You passed on/i.test(list), list.slice(0, 300));

await signIn(ADMIN);
await p.goto(`${BASE}/#/opportunity/${deal.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1200);
const shared = (await p.locator('.card:has(h2:text-is("Shared with"))').innerText())
  .replace(/\s+/g, ' ');
check('the desk sees "Passed" where it used to see "nothing yet"',
  /Passed/i.test(shared) && /return is too low/.test(shared), shared.slice(0, 260));

await signIn(INVESTOR1);
await p.goto(`${BASE}/#/opportunity/${deal.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1000);
await p.click('#unpassBtn');
await p.waitForTimeout(1500);
check('changing their mind brings the request box back',
  await p.locator('#takeBtn').count() === 1);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All opportunity pass checks passed.'}`);
process.exit(fails.length ? 1 : 0);
