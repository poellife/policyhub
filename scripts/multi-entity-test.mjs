/* =====================================================================
   Several entities at once, and a view that is still there tomorrow.

   Two claims, and they lean on each other.

   The first is arithmetic. If a person can ask for LCG1 and LCG2
   together, the answer has to be the same as asking for each and adding
   them up — otherwise the convenience is a way of getting a wrong total
   quickly. So every check here is a sum: the whole book against the
   parts, two entities against those same two one at a time.

   The second is that choosing is not the same as deciding. Ticking two
   entities changes what is on screen now; asking for it to be remembered
   changes what is on screen the next time somebody signs in, on whatever
   machine they sign in from. Those are different acts and the interface
   keeps them apart — remembering is a thing you press, not a thing that
   happens to you.

   And underneath both: a remembered view is a convenience, never a
   permission. A manager who stores a code they are not allowed to see
   must get nothing back, not somebody else's book.

   Idempotent: its own policies, removed first and last, and it puts back
   whatever default the test administrator had before it ran.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login,
         pickEntities, chosenEntities, offeredEntities,
         entityButtonText } from './test-config.mjs';

const PREFIX = 'MULTIENT';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const st of ['', 'Inforce', 'Lapsed', 'Matured', 'Sold', 'Pending'])
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX))
        await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

/* Whatever this administrator had remembered before, so the suite can put
   it back and not quietly rearrange somebody's screen. */
const before = (await json(await api('/me/prefs')))?.view_defaults || null;
const restoreDefault = async () => {
  if (before) await api('/me/prefs/view_defaults', { method: 'PUT', body: before });
  else await api('/me/prefs/view_defaults', { method: 'DELETE' });
};

const funds = (await json(await api('/funds'))) || [];
const codes = funds.map((f) => f.code);
if (codes.length < 2) {
  console.log('This suite needs at least two owner entities in the fixture.');
  process.exit(2);
}
const [A, B] = codes;

/* One policy in each of the first two entities, with faces far enough
   apart that a total cannot be right by coincidence. */
for (const [code, face, n] of [[A, 4000000, 1], [B, 7000000, 2]])
  await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${n}`, carrier_name: `${PREFIX} Assurance`,
    product_type: 'UL', fund_code: code, face_amount: face, status: 'Inforce',
    insured_last_name: `${PREFIX}${n}`, insured_first_name: 'Pat', dob: '1938-06-01' } });

console.log('THE LIST ON THE WIRE');
const facesFor = async (param) => {
  const rows = (await json(await api(`/policies?search=${PREFIX}&fund=${param}`))) || [];
  return rows.reduce((n, r) => n + Number(r.face_amount || 0), 0);
};
check('one code returns that entity', await facesFor(A) === 4000000, String(await facesFor(A)));
check('two codes return both', await facesFor(`${A},${B}`) === 11000000,
  String(await facesFor(`${A},${B}`)));
check('and that is exactly the two asked for separately',
  await facesFor(`${A},${B}`) === (await facesFor(A)) + (await facesFor(B)));
check('the order they are given in does not change the answer',
  await facesFor(`${B},${A}`) === await facesFor(`${A},${B}`));
check('a repeated code is not counted twice',
  await facesFor(`${A},${A},${B}`) === 11000000, String(await facesFor(`${A},${A},${B}`)));
check('stray spaces and empty slots are ignored',
  await facesFor(` ${A} , , ${B} `) === 11000000);
check('a code that does not exist returns nothing rather than everything',
  await facesFor('NOSUCHENTITY') === 0, String(await facesFor('NOSUCHENTITY')));
check('and asking for nothing is still the whole book',
  await facesFor('') === 11000000, String(await facesFor('')));

console.log('\nEVERY SCREEN READS IT THE SAME WAY');
const totalFace = async (path) => {
  const d = await json(await api(path));
  return Number(d?.totals?.total_face ?? d?.total_face ?? 0);
};
for (const [name, path] of [
  ['the dashboard', '/analytics/summary'],
  ['the portfolio report', '/reports/portfolio'],
]) {
  const both = await totalFace(`${path}?fund=${A},${B}`);
  const sum = (await totalFace(`${path}?fund=${A}`)) + (await totalFace(`${path}?fund=${B}`));
  check(`${name} adds the two entities up`, near(both, sum, 1), `${both} against ${sum}`);
}
const svc = async (param) =>
  ((await json(await api(`/servicing?fund=${param}`))) || {});
const svcCount = (d) => (d.alerts || []).length + (d.upcoming || []).length;
check('servicing does too',
  svcCount(await svc(`${A},${B}`)) === svcCount(await svc(A)) + svcCount(await svc(B)),
  `${svcCount(await svc(`${A},${B}`))} against ${
    svcCount(await svc(A)) + svcCount(await svc(B))}`);
const insureds = async (param) =>
  ((await json(await api(`/insureds?search=${PREFIX}&fund=${param}`))) || []).length;
check('and so does the list of insureds',
  await insureds(`${A},${B}`) === 2 && await insureds(A) === 1,
  `${await insureds(`${A},${B}`)} for both, ${await insureds(A)} for one`);

console.log('\nA REMEMBERED VIEW IS NOT A PERMISSION');
const mgr = await login(MANAGER1.email, MANAGER1.password);
const asMgr = (p) => fetch(`${BASE}/api${p}`, { headers: { Cookie: mgr } });
const mgrCodes = [...new Set(((await (await asMgr('/policies')).json()) || [])
  .map((p) => p.fund_code).filter(Boolean))];
const forbidden = codes.find((c) => !mgrCodes.includes(c));
if (forbidden) {
  const rows = await (await asMgr(`/policies?fund=${codes.join(',')}`)).json();
  check('a manager listing every code still sees only their own entities',
    rows.every((r) => !r.fund_code || mgrCodes.includes(r.fund_code)),
    `asked for ${codes.join(',')}, got ${
      [...new Set(rows.map((r) => r.fund_code))].join(',') || 'nothing'}`);
  const one = await (await asMgr(`/policies?fund=${forbidden}`)).json();
  check('and asking only for one they may not see returns nothing',
    one.length === 0, `${one.length} rows for ${forbidden}`);
} else {
  check('the fixture has no entity this manager is shut out of, so scope is untested',
    true, 'skipped');
}
const stored = await fetch(`${BASE}/api/me/prefs/view_defaults`, {
  method: 'PUT', headers: { Cookie: mgr, 'Content-Type': 'application/json' },
  body: JSON.stringify({ funds: [forbidden || 'NOSUCH'], status: 'Inforce' }) });
check('storing a view naming an entity they cannot reach is allowed', stored.status === 200);
const after = await (await asMgr('/me/prefs')).json();
check('it comes back as they stored it — it is a preference, not a grant',
  (after.view_defaults?.funds || []).join(',') === (forbidden || 'NOSUCH'));
const still = await (await asMgr(`/policies?fund=${forbidden || 'NOSUCH'}`)).json();
check('and it still shows them nothing', still.length === 0);
await fetch(`${BASE}/api/me/prefs/view_defaults`, { method: 'DELETE', headers: { Cookie: mgr } });

console.log('\nWHAT IS STORED IS CHECKED');
const put = async (body) => (await api('/me/prefs/view_defaults',
  { method: 'PUT', body })).status;
check('a status the screen does not offer is dropped rather than stored',
  await (async () => {
    await put({ funds: [A], status: 'Anything' });
    const v = (await json(await api('/me/prefs')))?.view_defaults;
    return v.status === '' && v.funds.join(',') === A;
  })());
check('and a list of things that are not codes comes back empty',
  await (async () => {
    await put({ funds: [{ code: A }, 7, null], status: '' });
    return ((await json(await api('/me/prefs')))?.view_defaults?.funds || []).length === 0;
  })());
check('something that is not a view at all is refused', await put(['LCG1']) === 400);
await api('/me/prefs/view_defaults', { method: 'DELETE' });

/* ------------------------------ on screen ---------------------------- */
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1050 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));

const signIn = async (page) => {
  await page.goto(BASE);
  await page.fill('#email', ADMIN.email);
  await page.fill('#password', ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.kpi-row', { timeout: 20000 });
  await page.waitForTimeout(600);
};
await signIn(p);

console.log('\nTICKING MORE THAN ONE');
check('the picker offers every entity', (await offeredEntities(p)).join(',') === codes.join(','),
  (await offeredEntities(p)).join(','));
check('and starts on the whole book', (await chosenEntities(p)).length === 0);
check('which the button says in words', await entityButtonText(p) === 'All entities',
  await entityButtonText(p));

await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr', { timeout: 20000 });
await p.waitForTimeout(700);
const rowsWith = async () => p.locator('table.data tbody tr').count();
const allRows = await rowsWith();
await pickEntities(p, [A]);
const oneRows = await rowsWith();
await pickEntities(p, [A, B]);
const twoRows = await rowsWith();
check('one entity shows fewer policies than the whole book', oneRows < allRows,
  `${oneRows} of ${allRows}`);
check('two shows more than one, and no more than the book',
  twoRows > oneRows && twoRows <= allRows, `${oneRows} → ${twoRows} of ${allRows}`);
check('the button names both rather than counting them',
  (await entityButtonText(p)).includes(A) && (await entityButtonText(p)).includes(B),
  await entityButtonText(p));
check('and both boxes are still ticked when the menu is reopened',
  (await chosenEntities(p)).sort().join(',') === [A, B].sort().join(','),
  (await chosenEntities(p)).join(','));
await p.screenshot({ path: `${S}/me1-policies-two.png`, fullPage: true });

console.log('\nAND IT FOLLOWS YOU BETWEEN SCREENS');
for (const [route, name] of [['dashboard', 'the dashboard'], ['servicing', 'servicing'],
  ['maturities', 'maturities'], ['insureds', 'insureds'], ['reports', 'reports']]) {
  await p.goto(`${BASE}/#/${route}`);
  await p.waitForTimeout(1500);
  if (route === 'reports') continue;          // reports has its own picker below
  check(`both are still chosen on ${name}`,
    (await chosenEntities(p)).sort().join(',') === [A, B].sort().join(','),
    (await chosenEntities(p)).join(','));
}
await p.goto(`${BASE}/#/dashboard`);
await p.waitForSelector('.kpi-row'); await p.waitForTimeout(1200);
const hero = async () => Number(
  (await p.locator('.stat .value.hero').first().textContent()).replace(/[^0-9.]/g, ''));
const bothHero = await hero();
await pickEntities(p, [A]);
const aHero = await hero();
await pickEntities(p, [B]);
const bHero = await hero();
check('the dashboard headline for two is the two headlines added up',
  near(bothHero, aHero + bHero, 2), `${bothHero} against ${aHero} + ${bHero}`);
check('and the subheading says which two it is',
  await (async () => {
    await pickEntities(p, [A, B]);
    const sub = await p.locator('.page-head .sub').first().textContent();
    return sub.includes(A) && sub.includes(B);
  })(), (await p.locator('.page-head .sub').first().textContent()).trim());
await p.screenshot({ path: `${S}/me2-dashboard-two.png`, fullPage: true });

console.log('\nREMEMBERING IT');
await p.click('#entityBtn');
await p.waitForSelector('#entityMenu:not([hidden])');
check('the menu offers to remember the view',
  (await p.locator('#entityRemember').count()) === 1);
check('and does not yet claim this is the default',
  (await p.locator('#entityForget').count()) === 0);
await p.click('#entityRemember');
await p.waitForTimeout(1400);
const savedPref = (await json(await api('/me/prefs')))?.view_defaults;
check('pressing it stores exactly what is on screen',
  (savedPref?.funds || []).sort().join(',') === [A, B].sort().join(','),
  JSON.stringify(savedPref));
await p.click('#entityBtn');
await p.waitForSelector('#entityMenu:not([hidden])');
check('and the menu now says so instead of offering again',
  (await p.locator('#entityForget').count()) === 1
  && (await p.locator('#entityRemember').count()) === 0);
await p.screenshot({ path: `${S}/me3-remembered.png` });
await p.keyboard.press('Escape');

console.log('\nAND FINDING IT AGAIN TOMORROW');
await ctx.clearCookies();
await signIn(p);
check('signing in again starts on the remembered entities',
  (await chosenEntities(p)).sort().join(',') === [A, B].sort().join(','),
  (await chosenEntities(p)).join(','));
check('the dashboard shows that book, not the whole one',
  near(await hero(), bothHero, 2), `${await hero()} against ${bothHero}`);
check('and the button says which two without being opened',
  (await entityButtonText(p)).includes(A), await entityButtonText(p));

/* Looking at something else for a moment must not change what is stored. */
await pickEntities(p, [A]);
check('narrowing to one afterwards does not overwrite the default',
  ((await json(await api('/me/prefs')))?.view_defaults?.funds || []).sort().join(',')
    === [A, B].sort().join(','));
await p.click('#entityBtn');
await p.waitForSelector('#entityMenu:not([hidden])');
check('and the menu offers a way back to it',
  (await p.locator('#entityRestore').count()) === 1);
await p.click('#entityRestore');
await p.waitForTimeout(1500);
check('which puts both back', (await chosenEntities(p)).sort().join(',')
  === [A, B].sort().join(','), (await chosenEntities(p)).join(','));

console.log('\nAND A WAY TO STOP');
await p.click('#entityBtn');
await p.waitForSelector('#entityMenu:not([hidden])');
await p.click('#entityForget');
await p.waitForTimeout(1400);
check('forgetting it clears the stored view',
  !((await json(await api('/me/prefs')))?.view_defaults?.funds || []).length);
await ctx.clearCookies();
await signIn(p);
check('so the next sign-in is back to the whole book',
  (await chosenEntities(p)).length === 0, (await chosenEntities(p)).join(','));

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await restoreDefault();
await wipe();
console.log(fails.length
  ? `\n${fails.length} MULTI-ENTITY CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL MULTI-ENTITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
