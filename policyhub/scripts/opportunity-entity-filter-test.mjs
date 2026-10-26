/* =====================================================================
   Opportunities, narrowed by owner entity.

   The same picker the policies grid and the dashboard carry, and the
   same selection: choosing LCG1 on one screen and opening another shows
   LCG1 there too, rather than a page that quietly resets to the whole
   book beside one that did not.

   Under test, on the wire and on the screen:
     - one entity, several, and none (which is the whole book);
     - that it narrows and never widens — a manager naming somebody
       else's entity gets nothing, not a look at it;
     - that an investor is neither offered it nor affected by it;
     - that an empty narrowed list says it is narrowed, rather than
       reading as an empty book.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'OPPENT';
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

const funds = await json(await api('/funds'));
if (funds.length < 2) { console.log('  FAIL  needs two owner entities'); process.exit(1); }

/* The manager's own entity, and one that is not his — so the narrowing
   can be tested against both sides of the line he is allowed to see. */
const mgrCookie = await login(MANAGER1.email, MANAGER1.password);
const mgr = call(mgrCookie);
const mine = ((await json(await mgr('/funds'))) || []).map((f) => f.code);
const A = funds.find((f) => mine.includes(f.code)) || funds[0];
const B = funds.find((f) => f.code !== A.code && !mine.includes(f.code))
  || funds.find((f) => f.code !== A.code);

const make = async (tag, fund) => json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 1500000, fund_id: fund.id, status: 'Open',
  insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', insured_dob: '1942-03-02',
  le_months: 72, asking_price: 300000, annual_premium: 40000 } }));
const inA = await make('A', A);
const inB = await make('B', B);

const ours = (rows) => (rows || []).filter((x) => String(x.policy_number).startsWith(PREFIX))
  .map((x) => x.policy_number).sort();

console.log(`ON THE WIRE (${A.code} and ${B.code})`);
check('with no entity chosen, both are on the list',
  ours(await json(await api('/opportunities'))).join() === `${PREFIX}-A,${PREFIX}-B`,
  ours(await json(await api('/opportunities'))).join());
check(`choosing ${A.code} shows only its deal`,
  ours(await json(await api(`/opportunities?fund=${A.code}`))).join() === `${PREFIX}-A`,
  ours(await json(await api(`/opportunities?fund=${A.code}`))).join());
check(`choosing ${B.code} shows only the other`,
  ours(await json(await api(`/opportunities?fund=${B.code}`))).join() === `${PREFIX}-B`);
check('choosing both is the same as choosing neither',
  ours(await json(await api(`/opportunities?fund=${A.code},${B.code}`))).join()
    === `${PREFIX}-A,${PREFIX}-B`);
check('an entity with nothing in it is an empty list, not an error',
  Array.isArray(await json(await api('/opportunities?fund=NOSUCHENTITY')))
  && ours(await json(await api('/opportunities?fund=NOSUCHENTITY'))).length === 0);

console.log('\nIT NARROWS, AND NEVER WIDENS');
if (mine.length && !mine.includes(B.code)) {
  const theirs = ours(await json(await mgr(`/opportunities?fund=${B.code}`)));
  check(`a manager who names ${B.code}, which is not his, sees nothing of it`,
    theirs.length === 0, theirs.join());
  check('and without a filter he still sees only his own',
    !ours(await json(await mgr('/opportunities'))).includes(`${PREFIX}-B`));
} else {
  console.log('  (skipped — the manager can see every entity in this database)');
}

console.log('\nAN INVESTOR IS UNTOUCHED BY IT');
const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const inv = call(invCookie);
const me = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: invCookie } })))
  .investor.id;
for (const d of [inA, inB])
  await api(`/opportunities/${d.id}/shares`, { method: 'PUT', body: { investor_ids: [me] } });
check('their list is the deals shared with them, filter or no filter',
  ours(await json(await inv(`/opportunities?fund=${A.code}`))).join()
    === `${PREFIX}-A,${PREFIX}-B`,
  ours(await json(await inv(`/opportunities?fund=${A.code}`))).join());

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
const titles = () => p.locator('.opp-card .opp-sub')
  .evaluateAll((els) => els.map((e) => e.textContent).filter((t) => t.includes('OPPENT')));

await signIn(ADMIN);
await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1000);
check('the page carries the entity picker', await p.locator('#entityPick').count() === 1);
check('and both deals are on it to begin with', (await titles()).length === 2,
  String((await titles()).length));

await p.click('#entityBtn');
await p.locator(`.entity-one[value="${A.code}"]`).check();
await p.click('h1');                              // closing the menu applies it
await p.waitForTimeout(1500);
check(`ticking ${A.code} narrows the page to its deal`,
  (await titles()).length === 1 && (await titles())[0].includes(`${PREFIX}-A`),
  (await titles()).join(' | '));
check('and the subheading says so',
  new RegExp(`${A.code} only`).test(await p.locator('.page-head .sub').innerText()),
  await p.locator('.page-head .sub').innerText());

/* The selection is shared. Opening the policies grid and coming back
   should not have reset it -- that is the whole point of one picker. */
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(800);
check('the policies grid is on the same selection',
  (await p.locator('#entityBtn').innerText()).includes(A.code),
  await p.locator('#entityBtn').innerText());
await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(1000);
check('and coming back, so is this page', (await titles()).length === 1);

/* Clear it so the next suite starts on the whole book. */
await p.click('#entityBtn');
await p.locator('#entityAll').check();
await p.click('h1');
await p.waitForTimeout(1200);
check('choosing All entities puts both back', (await titles()).length === 2,
  String((await titles()).length));

await signIn(INVESTOR1);
await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('.page-head', { timeout: 20000 });
await p.waitForTimeout(800);
check('an investor is offered no picker', await p.locator('#entityPick').count() === 0);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All opportunity entity filter checks passed.'}`);
process.exit(fails.length ? 1 : 0);
