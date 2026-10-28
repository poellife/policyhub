/* =====================================================================
   Two ways the office works a deal for somebody else.

   ENTERING A REQUEST FOR AN INVESTOR. An investor who rings and says
   "put me down for 20%" has asked as surely as one who typed it in. An
   administrator or portfolio manager can enter it; it is held to every
   rule the investor's own request is held to, it says who took it down,
   it shares the deal with the investor and clears a "not for me".

   LENDING ONE DEAL TO A MANAGER. A manager sees the deals in his own
   entities. An administrator can lend him one more, by name, without
   widening his entities: he works it like his own -- list, badge, page,
   edits, requests -- but funding and deleting stay with the entity.
   Taking it back is immediate.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, MANAGER2, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'ENTERLEND';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const call = (c) => (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const api = call(await login(ADMIN.email, ADMIN.password));
const mgr = call(await login(MANAGER1.email, MANAGER1.password));
const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const inv = call(invCookie);
const me1 = (await json(await inv('/auth/me'))).investor.id;

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
  for (const i of ((await json(await api('/investors'))) || [])
    .filter((x) => String(x.name).startsWith(PREFIX)))
    await api(`/investors/${i.id}`, { method: 'DELETE', body: { confirm: i.name } });
};
await wipe();

const funds = await json(await api('/funds'));
const LCG1 = funds.find((f) => f.code === 'LCG1');
const LCG2 = funds.find((f) => f.code === 'LCG2');
const mgrMe = await json(await mgr('/auth/me'));
const mgrId = mgrMe.user?.id ?? mgrMe.id;
const deal = async (tag, fund) => json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 2000000, fund_id: fund.id, status: 'Open', insured_last_name: `${PREFIX}${tag}`,
  insured_first_name: 'Ada', insured_dob: '1942-03-02', le_months: 72, asking_price: 300000,
  annual_premium: 40000 } }));
const own = await deal('OWN', LCG1);       // in the manager's own entity
const other = await deal('OTHER', LCG2);   // in an entity he does not manage
const mine = await json(await api('/investors', { method: 'POST', body: { name: `${PREFIX} Own Client`, fund_id: LCG1.id } }));
const notMine = await json(await api('/investors', { method: 'POST', body: { name: `${PREFIX} Not His`, fund_id: LCG2.id } }));
check('(fixtures)', !!own?.id && !!other?.id && !!mine?.id && !!notMine?.id && !!mgrId,
  JSON.stringify([own?.id, other?.id, mine?.id, notMine?.id, mgrId]));

console.log('A DEAL OUTSIDE HIS ENTITIES IS NOT HIS — UNTIL IT IS LENT');
check('the manager cannot open the other entity’s deal', (await mgr(`/opportunities/${other.id}`)).status === 404);
check('nor is it on his list', !((await json(await mgr('/opportunities'))) || []).some((x) => x.id === other.id));
const badgeBefore = (await json(await mgr('/opportunities/summary'))).open;
check('a manager cannot lend a deal, even to himself',
  (await mgr(`/opportunities/${other.id}/access`, { method: 'POST', body: { user_id: mgrId } })).status === 403);

const lent = await api(`/opportunities/${other.id}/access`, { method: 'POST', body: { user_id: mgrId } });
check('an administrator lends it to him', lent.status === 200, String(lent.status));
const seen = await json(await mgr(`/opportunities/${other.id}`));
check('now he can open it', seen?.id === other.id, JSON.stringify(seen).slice(0, 80));
check('and is told it is on loan', seen.by_grant === true);
check('it is on his list', ((await json(await mgr('/opportunities'))) || []).some((x) => x.id === other.id));
check('and in his count', (await json(await mgr('/opportunities/summary'))).open === badgeBefore + 1);
check('he can work it — edit it', (await mgr(`/opportunities/${other.id}`, { method: 'PUT',
  body: { notes: 'Worked by the lent manager' } })).status === 200);
check('but not fund it', (await mgr(`/opportunities/${other.id}/fund`, { method: 'POST', body: {} })).status === 403);
check('nor delete it', (await mgr(`/opportunities/${other.id}`, { method: 'DELETE' })).status === 403);
check('nor move it into his own entity, which would make the loan a transfer',
  (await mgr(`/opportunities/${other.id}`, { method: 'PUT', body: { fund_id: LCG1.id } })).status === 403);
check('so it is still in the entity it belongs to',
  (await json(await api(`/opportunities/${other.id}`))).fund_id === LCG2.id);
check('and lending did not widen his entities: a second deal in it stays hidden',
  (await mgr(`/opportunities/${(await deal('OTHER2', LCG2)).id}`)).status === 404);

const access = (await json(await api(`/opportunities/${other.id}`))).manager_access || [];
check('the administrator sees who can work it, and why',
  access.some((m) => m.user_id === mgrId && m.granted_at && !m.via_entity), JSON.stringify(access.map((m) => [m.email, m.via_entity, !!m.granted_at])));
check('a manager whose own entity it is shows as such',
  access.some((m) => m.via_entity), JSON.stringify(access.map((m) => m.email)));
check('a manager is not shown that list', seen.manager_access === undefined);

console.log('\nENTERING A REQUEST FOR AN INVESTOR');
const e1 = await json(await api(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { investor_id: mine.id, pct: 20, notes: 'Called 10/28' } }));
check('an administrator enters 20% for an investor', Number(e1?.pct) === 20 && e1.status === 'Requested',
  JSON.stringify(e1).slice(0, 120));
let d = await json(await api(`/opportunities/${own.id}`));
const row = d.commitments.find((c) => c.investor_id === mine.id);
check('it is marked as entered by staff', !!row?.entered_by_name, String(row?.entered_by_name));
check('it holds the space', Number(d.taken_pct) === 20, String(d.taken_pct));
check('and the deal is shared with them', d.shares.some((x) => x.investor_id === mine.id));
const again = await json(await api(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { investor_id: mine.id, pct: 25, status: 'Confirmed' } }));
d = await json(await api(`/opportunities/${own.id}`));
check('entering again replaces it rather than adding a second',
  d.commitments.filter((c) => c.investor_id === mine.id).length === 1 && Number(d.taken_pct) === 25,
  `${d.commitments.length} rows, ${d.taken_pct}%`);
check('and it can go straight in as confirmed', again?.status === 'Confirmed' && !!again.decided_at);

check('more than is left is refused', (await api(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { investor_id: notMine.id, pct: 80 } })).status === 409);
check('less than the minimum is refused', (await api(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { investor_id: notMine.id, pct: 2 } })).status === 400);
check('so is no investor', (await api(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { pct: 20 } })).status === 400);

/* The investor had said "not for me". Entering a request for them means
   they changed their mind, and the deal is theirs to see again. */
await api(`/opportunities/${own.id}/shares`, { method: 'PUT', body: { investor_ids: [mine.id, me1] } });
await inv(`/opportunities/${own.id}/pass`, { method: 'POST', body: { reason: 'Not now' } });
check('(the investor has passed on it)', !!(await json(await inv(`/opportunities/${own.id}`))).my_pass);
const e2 = await api(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { investor_id: me1, pct: 15 } });
check('entering one for them is accepted', e2.status === 201, String(e2.status));
const theirs = await json(await inv(`/opportunities/${own.id}`));
check('the pass is cleared', theirs.my_pass === null, JSON.stringify(theirs.my_pass));
check('and they see the request as theirs', Number(theirs.my_commitment?.pct) === 15,
  JSON.stringify(theirs.my_commitment));

console.log('\nA MANAGER CAN DO IT FOR HIS OWN INVESTORS');
const m1 = await mgr(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { investor_id: mine.id, pct: 25 } });
check('on his own deal, for his own client', m1.status === 201, String(m1.status));
const m2 = await json(await mgr(`/opportunities/${own.id}/commitments`, { method: 'POST',
  body: { investor_id: notMine.id, pct: 20 } }));
check('not for an investor outside his book', /not one of your investors/.test(m2?.error || ''), JSON.stringify(m2));
const m3 = await mgr(`/opportunities/${other.id}/commitments`, { method: 'POST',
  body: { investor_id: mine.id, pct: 20 } });
check('and on a deal lent to him, for his own client', m3.status === 201, String(m3.status));
check('an investor cannot enter one at all', (await inv(`/opportunities/${own.id}/commitments`, {
  method: 'POST', body: { investor_id: me1, pct: 20 } })).status === 403);
const mgr2 = call(await login(MANAGER2.email, MANAGER2.password));
check('(another manager can still work his own entities)', (await mgr2(`/opportunities/${own.id}`)).status === 200);

console.log('\nTAKING IT BACK IS IMMEDIATE');
check('the administrator takes the deal back',
  (await api(`/opportunities/${other.id}/access/${mgrId}`, { method: 'DELETE' })).status === 200);
check('and the next thing he opens is refused', (await mgr(`/opportunities/${other.id}`)).status === 404);
check('and it is off his list', !((await json(await mgr('/opportunities'))) || []).some((x) => x.id === other.id));

console.log('\nON THE SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1450, height: 1200 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
p.on('dialog', (dlg) => dlg.accept());
const signIn = async (who) => {
  await ctx.clearCookies();
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });
};
await signIn(ADMIN);
await p.goto(`${BASE}/#/opportunity/${other.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1000);
const card = p.locator('.card:has(h2:text-is("Portfolio managers"))');
check('the administrator has a Portfolio managers card', await card.count() === 1);
await card.locator(`[data-access-add="${mgrId}"]`).click();
await p.waitForTimeout(1500);
check('and Lend this deal lends it', /Lent this deal/i.test(await card.innerText()));

await p.click('#enterCommitBtn');
await p.waitForSelector('dialog[open] select[name="investor_id"]', { timeout: 10000 });
await p.selectOption('dialog[open] select[name="investor_id"]', String(notMine.id));
await p.fill('dialog[open] input[name="pct"]', '20');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1500);
const interest = (await p.locator('.card:has(h2:text-is("Investor interest"))').innerText()).replace(/\s+/g, ' ');
check('a request entered on screen appears, marked as entered', new RegExp(`${PREFIX} Not His.*entered by`, 'i').test(interest),
  interest.slice(0, 240));

await signIn(MANAGER1);
await p.goto(`${BASE}/#/opportunity/${other.id}`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1000);
check('the manager it was lent to is told so on the page',
  /was lent to you to work on/.test(await p.locator('.main, body').first().innerText()));
check('and has no Portfolio managers card', await p.locator('.card:has(h2:text-is("Portfolio managers"))').count() === 0);
check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();

await api(`/opportunities/${other.id}/access/${mgrId}`, { method: 'DELETE' });
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All enter-and-lend checks passed.'}`);
process.exit(fails.length ? 1 : 0);
