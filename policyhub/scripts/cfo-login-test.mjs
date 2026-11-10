/* =====================================================================
   The CFO login.

   A read-only login for an owner entity's CFO. It sees what an investor
   sees -- the portfolio, the policies, each policy, premiums due, realized
   maturities -- but across EVERY policy owned by the entities it is given,
   at full-policy figures, rather than one investor's holdings. What has
   to be true:

     - It is created and edited by an administrator, with one or more
       entities, and refused without one.
     - It sees every policy in its entities, and none outside them, on
       every screen it has; a policy in another entity is "not found".
     - Figures are the whole policy, not a share.
     - Investor names never reach it; the insured is shown by full name.
     - It can change nothing, and every staff or investor-dealing route
       (investors, opportunities, documents, exports, users...) is refused.
     - On screen: the CFO menu, CFO wording, no Ownership card.

   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'CFOT';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const admin = await login(ADMIN.email, ADMIN.password);
const call = (cookie) => async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const api = call(admin);
const funds = (await api('/funds')).body;
const LCG1 = funds.find((f) => f.code === 'LCG1');
const LCG2 = funds.find((f) => f.code === 'LCG2');
const OTHER = funds.find((f) => !['LCG1', 'LCG2'].includes(f.code));
const EMAIL = `${PREFIX.toLowerCase()}-cfo@test.local`;
const INVESTOR_NAME = `${PREFIX} Zebulon Holdings`;

const wipe = async () => {
  for (const u of ((await api('/users')).body || []).filter((x) => x.email === EMAIL))
    await api(`/users/${u.id}`, { method: 'DELETE' });
  for (const status of ['', 'Matured']) {
    for (const x of ((await api(`/policies?status=${status}`)).body || [])
      .filter((y) => String(y.policy_number).startsWith(PREFIX))) {
      const d = (await api(`/policies/${x.id}`)).body;
      if (d?.insured_id) await api(`/insureds/${d.insured_id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
    }
  }
  for (const i of ((await api(`/investors?search=${PREFIX}`)).body || []))
    await api(`/investors/${i.id}`, { method: 'DELETE', body: { confirm: i.name } });
};
await wipe();

/* Three policies in the CFO's two entities, one outside them. */
const inv = (await api('/investors', { method: 'POST', body: {
  name: INVESTOR_NAME, investor_type: 'Entity' } })).body;
const make = async (tag, fund, last, { premium = 0, died = null } = {}) => {
  const p = (await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Ledger Life', product_type: 'UL',
    fund_code: fund.code, face_amount: 2000000, insured_last_name: last,
    insured_first_name: 'Quentin', dob: '1940-02-02' } })).body;
  await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-900), txn_type: 'Acquisition Cost', amount: 400000 } });
  if (premium) await api(`/policies/${p.id}/reminders`, { method: 'POST', body: {
    kind: 'Premium', due_date: iso(30), amount: premium, note: `${PREFIX}` } });
  await api(`/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: inv.id, pct: 25, acquired_on: iso(-900) } });
  if (died) {
    await api(`/insureds/${p.insured_id}`, { method: 'PUT', body: { date_of_death: iso(-died) } });
    await api(`/policies/${p.id}/proceeds`, { method: 'PUT', body: {
      proceeds_amount: 2000000, proceeds_received_on: iso(-died + 20) } });
  }
  return p;
};
const A = await make('A', LCG1, 'Abernathy', { premium: 48000 });
const B = await make('B', LCG1, 'Bellweather');
const C = await make('C', LCG2, 'Castellano', { died: 60 });
const X = await make('X', OTHER, 'Xenakis', { premium: 9999 });

console.log('AN ADMINISTRATOR SETS IT UP');
const pw = scratchPassword('cfo');
const none = await api('/users', { method: 'POST', body: {
  email: EMAIL, full_name: 'Cora CFO', role: 'cfo', password: pw, fund_ids: [] } });
check('a CFO login without an entity is refused', none.status === 400, String(none.status));
const made = await api('/users', { method: 'POST', body: {
  email: EMAIL, full_name: 'Cora CFO', role: 'cfo', password: pw, fund_ids: [LCG1.id] } });
check('with an entity it is created', made.status === 201 && made.body.role === 'cfo',
  `${made.status} ${made.body?.role}`);
const edit = await api(`/users/${made.body.id}`, { method: 'PUT', body: {
  role: 'cfo', fund_ids: [LCG1.id, LCG2.id] } });
check('a second entity can be added', edit.status === 200, String(edit.status));
const listed = ((await api('/users')).body || []).find((u) => u.email === EMAIL);
check('and the user list says which', /LCG1/.test(listed?.fund_codes) && /LCG2/.test(listed?.fund_codes),
  listed?.fund_codes);

const cfoCookie = await login(EMAIL, pw);
const cfo = call(cfoCookie);

console.log('\nIT SEES EVERY POLICY IN ITS ENTITIES, AND NO OTHERS');
const mine = ((await cfo('/policies')).body || []).filter((p) => String(p.policy_number).startsWith(PREFIX));
const mineAll = [...mine, ...(((await cfo('/policies?status=Matured')).body || [])
  .filter((p) => String(p.policy_number).startsWith(PREFIX)))];
const nums = [...new Set(mineAll.map((p) => p.policy_number))].sort();
check('all three of its policies, not the one outside', JSON.stringify(nums)
  === JSON.stringify([`${PREFIX}-A`, `${PREFIX}-B`, `${PREFIX}-C`]), nums.join(', '));
check('each policy opens', (await cfo(`/policies/${A.id}`)).status === 200
  && (await cfo(`/policies/${C.id}`)).status === 200);
check('a policy in another entity is not found', (await cfo(`/policies/${X.id}`)).status === 404);
check('its return opens', (await cfo(`/policies/${A.id}/irr`)).status === 200);
check('and another entity’s return does not', (await cfo(`/policies/${X.id}/irr`)).status === 404);

console.log('\nFULL-POLICY FIGURES');
const a = (await cfo(`/policies/${A.id}`)).body;
check('the death benefit is the whole policy, not 25%',
  Number(a.death_benefit ?? a.face_amount) === 2000000, String(a.death_benefit));
check('invested is the whole $400,000', Number(a.total_invested) === 400000, String(a.total_invested));
check('there is no "my share" on it', !('my_pct' in a));
const dash = (await cfo('/analytics/summary')).body;
check('the dashboard reads', !!dash && typeof dash === 'object');
const svc = (await cfo('/servicing')).body;
const svcText = JSON.stringify(svc);
check('the premium calendar has its premium, at full amount', svcText.includes('48000'));
check('and not the other entity’s', !svcText.includes('9999'));
const mats = (await cfo('/maturities')).body;
check('the realized maturity is there',
  (mats?.rows || []).some((r) => r.policy_number === `${PREFIX}-C`));
const fl = (await cfo('/funds')).body || [];
check('it can list its own entities for the picker, and only those',
  fl.length === 2 && fl.every((f) => ['LCG1', 'LCG2'].includes(f.code)), fl.map((f) => f.code).join(','));

console.log('\nNO INVESTOR NAMES; INSUREDS BY FULL NAME');
const everything = JSON.stringify([mineAll, a, (await cfo(`/policies/${C.id}`)).body,
  dash, svc, mats, (await cfo(`/policies/${A.id}/irr`)).body]);
check('the investor’s name appears nowhere', !everything.includes('Zebulon'));
check('the policy carries no ownership lines', Array.isArray(a.owners) && a.owners.length === 0);
check('the insured’s full name is shown to a CFO',
  ['Abernathy', 'Bellweather', 'Castellano'].every((n) => everything.includes(n)));
check('no valuations ride along', a.valuations === undefined);

console.log('\nIT CAN CHANGE NOTHING, AND REACHES NOTHING ELSE');
for (const [what, path, opts] of [
  ['edit a policy', `/policies/${A.id}`, { method: 'PUT', body: { carrier_name: 'Changed' } }],
  ['add a transaction', `/policies/${A.id}/transactions`, { method: 'POST',
    body: { txn_date: iso(0), txn_type: 'Premium Payment', amount: 1 } }],
  ['allocate an investor', `/policies/${A.id}/investors`, { method: 'POST',
    body: { investor_id: inv.id, pct: 1 } }],
  ['list investors', '/investors'],
  ['open an investor', `/investors/${inv.id}`],
  ['see opportunities', '/opportunities'],
  ['see documents', '/documents'],
  ['see capital calls', '/capital-calls'],
  ['see agreements', '/agreements'],
  ['see insureds', '/insureds'],
  ['export', '/exports', { method: 'POST', body: { kind: 'policies' } }],
  ['manage users', '/users'],
  ['read the activity log', '/audit'],
  ['run Mortality Watch', '/mortality-watch/summary'],
  ['see valuations', '/valuations'],
]) {
  const r = await cfo(path, opts);
  check(`cannot ${what}`, r.status === 403, String(r.status));
}
check('the policy is unchanged', (await api(`/policies/${A.id}`)).body.carrier_name === 'Ledger Life');
check('it can still change its own screen settings',
  (await cfo('/me/prefs/compounding', { method: 'PUT', body: { how: 'monthly' } })).status === 200);

console.log('\nTAKING AN ENTITY AWAY APPLIES AT ONCE');
await api(`/users/${made.body.id}`, { method: 'PUT', body: { role: 'cfo', fund_ids: [LCG1.id] } });
check('the LCG2 policy is gone from an open session', (await cfo(`/policies/${C.id}`)).status === 404);
await api(`/users/${made.body.id}`, { method: 'PUT', body: { role: 'cfo', fund_ids: [LCG1.id, LCG2.id] } });

console.log('\nON SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
const refused = [];
p.on('response', (r) => { if (r.url().includes('/api/') && r.status() === 403) refused.push(new URL(r.url()).pathname); });
await p.goto(BASE);
await p.fill('#email', EMAIL);
await p.fill('#password', pw);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
const nav = (await p.locator('.nav a').allTextContents()).map((t) => t.trim()).filter(Boolean);
check('the CFO menu', JSON.stringify(nav) === JSON.stringify(
  ['Portfolio', 'Policies', 'Realized', 'Account']), nav.join(' · '));
const dashText = await p.locator('#main').innerText();
check('the dashboard does not speak of a share',
  !/your share|ownership percentage|your portfolio/i.test(dashText), dashText.slice(0, 120));
check('with two entities it gets the entity picker', await p.locator('#entityBtn').count() === 1);
await p.click('#entityBtn');
const opts = (await p.locator('#entityMenu').innerText());
check('listing only its own entities', /LCG1/.test(opts) && /LCG2/.test(opts)
  && !opts.includes(OTHER.code), opts.replace(/\s+/g, ' '));
await p.keyboard.press('Escape');
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr', { timeout: 20000 });
await p.waitForTimeout(800);
const gridText = await p.locator('#main').innerText();
check('the policies grid lists its policies', gridText.includes(`${PREFIX}-A`) && gridText.includes(`${PREFIX}-B`));
check('without a "My share" column', !/my share/i.test(gridText));
await p.goto(`${BASE}/#/policy/${A.id}`);
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.waitForTimeout(800);
const polText = await p.locator('#main').innerText();
check('the policy page names its owner entity', /owner entity/i.test(polText) && polText.includes('LCG1'));
check('and has no Ownership card or investor', !/ownership|your position/i.test(polText)
  && !polText.includes('Zebulon'));
check('and shows the whole death benefit', polText.includes('2,000,000'));
check('the policy page has the overview only, no other tabs',
  await p.locator('.tabs button:visible').count() === 0
  && !/transactions|premiums/i.test(await p.locator('.tabs').innerText().catch(() => '')));
await p.goto(`${BASE}/#/settings`);
await p.waitForTimeout(1500);
check('the Account page has no email-notification settings',
  await p.locator('#saveMailPrefs').count() === 0);
await p.goto(`${BASE}/#/dashboard`);
await p.waitForSelector('#compounding', { timeout: 20000 });
check('the dashboard has the compounding choice', await p.locator('#compounding').count() === 1);
await p.selectOption('#compounding', 'monthly');
await p.waitForTimeout(1500);
check('choosing monthly relabels the return',
  /compounded monthly/i.test(await p.locator('#main').innerText()));
check('and is saved against the CFO’s account',
  (await cfo('/me/prefs')).body?.compounding?.how === 'monthly');
await p.selectOption('#compounding', 'annual');
await p.waitForTimeout(1200);
check('back to annually', /compounded annually/i.test(await p.locator('#main').innerText()));
await p.goto(`${BASE}/#/maturities`);
await p.waitForSelector('#compounding', { timeout: 20000 });
check('Realized has it too', await p.locator('#compounding').count() === 1);
for (const r of ['maturities', 'settings']) {
  await p.goto(`${BASE}/#/${r}`);
  await p.waitForTimeout(1800);
}
check('no screen it has asks for something it is refused', refused.length === 0, [...new Set(refused)].join(', '));
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();

await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All CFO login checks passed.'}`);
process.exit(fails.length ? 1 : 0);
