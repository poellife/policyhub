/* =====================================================================
   Narrowing the book to one owner entity, and pricing your own slice.

   Two separate ideas, tested together because they are the same idea
   from opposite ends: a figure is only meaningful when you know what it
   is a figure *of*. Staff need to know which entity; an investor needs
   to know which percentage.

   The entity checks are arithmetic rather than cosmetic — the parts have
   to add back up to the whole on every screen that offers the filter.
   Otherwise a filter that quietly drops rows looks exactly like one that
   works.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'ENTVIEW';
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
const near = (a, b, tol = 0.51) => Math.abs(Number(a) - Number(b)) < tol;

const wipe = async () => {
  for (const st of ['', 'Matured']) {
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || [])
      .filter((x) => String(x.policy_number).startsWith(PREFIX))) {
      const d = await json(await api(`/policies/${p.id}`));
      for (const id of [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)].filter(Boolean))
        await api(`/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
    }
  }
  for (const o of ((await json(await api('/opportunities?all=1'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE', body: { confirm: o.policy_number } });
};
await wipe();

/* Two entities, with lives of known ages so the average can be checked
   against arithmetic rather than against whatever the fixture happens to
   hold. One survivorship policy, because its second life counts too. */
const born = (age) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - age);
  d.setUTCDate(d.getUTCDate() - 1);        // safely past the birthday
  return d.toISOString().slice(0, 10);
};

const mk = async (suffix, fundCode, age, extra = {}) => {
  const p = await json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Entity Life', product_type: 'UL',
    fund_code: fundCode, face_amount: 2000000, premium_required: 30000, premium_mode: 'Annual',
    next_premium_due: iso(20), acquisition_date: iso(-400), acquisition_cost: 300000,
    insured_last_name: `Entview${suffix}`, insured_first_name: 'Ida', dob: born(age),
    gender: 'F', ...extra } }));
  await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-400), txn_type: 'Acquisition Cost', amount: 300000 } });
  await api(`/policies/${p.id}/reminders`, { method: 'POST', body: {
    due_date: iso(30), kind: 'Premium', amount: 31000, note: 'Illustration' } });
  return p;
};

const a1 = await mk('A1', 'LCG1', 80);
const a2 = await mk('A2', 'LCG1', 90);
const b1 = await mk('B1', 'LCG2', 70);

console.log('THE FILTER IS ARITHMETIC, NOT COSMETIC');
const whole = {
  insureds: ((await json(await api('/insureds'))) || []).length,
  servicing: (await json(await api('/servicing'))).upcoming.length,
};
const one = {
  insureds: ((await json(await api('/insureds?fund=LCG1'))) || []).length,
  servicing: (await json(await api('/servicing?fund=LCG1'))).upcoming.length,
};
const funds = await json(await api('/funds'));
let sumInsureds = 0; let sumServicing = 0;
for (const f of funds) {
  sumInsureds += ((await json(await api(`/insureds?fund=${f.code}`))) || []).length;
  sumServicing += (await json(await api(`/servicing?fund=${f.code}`))).upcoming.length;
}
check('the insureds in each entity add up to the whole list',
  sumInsureds === whole.insureds, `${sumInsureds} against ${whole.insureds}`);
check('and so do the premiums on the servicing calendar',
  sumServicing === whole.servicing, `${sumServicing} against ${whole.servicing}`);
check('narrowing actually narrows', one.insureds < whole.insureds,
  `${one.insureds} of ${whole.insureds}`);
check('our two fixtures are both in the entity we put them in',
  ((await json(await api('/insureds?fund=LCG1'))) || [])
    .filter((i) => String(i.last_name).startsWith('Entview')).length === 2);
check('and neither is in the other one',
  ((await json(await api('/insureds?fund=LCG2'))) || [])
    .filter((i) => i.last_name === 'EntviewA1').length === 0);
check('a filter for an entity that does not exist returns nothing, not everything',
  ((await json(await api('/insureds?fund=NOSUCH'))) || []).length === 0);

console.log('\nMATURITIES NARROW TOO — ROWS, TOTALS AND RETURN TOGETHER');
const matured = await mk('M1', 'LCG2', 88);
await api(`/policies/${matured.id}/transactions`, { method: 'POST', body: {
  txn_date: iso(-100), txn_type: 'Premium Payment', amount: 30000 } });
const md = await json(await api(`/policies/${matured.id}`));
await api(`/insureds/${md.insured_id}`, { method: 'PUT', body: { date_of_death: iso(-30) } });
await api(`/policies/${matured.id}/proceeds`, { method: 'PUT', body: {
  proceeds_amount: 2000000, proceeds_received_on: iso(-10) } });

const allMat = await json(await api('/maturities'));
const lcg1Mat = await json(await api('/maturities?fund=LCG1'));
const lcg2Mat = await json(await api('/maturities?fund=LCG2'));
check('the matured policy shows in its own entity',
  lcg2Mat.rows.some((r) => r.policy_number === `${PREFIX}-M1`));
check('and not in the other', !lcg1Mat.rows.some((r) => r.policy_number === `${PREFIX}-M1`));
check('the totals move with the rows',
  lcg2Mat.totals.policy_count === lcg2Mat.rows.length
  && Number(lcg1Mat.totals.policy_count) + Number(lcg2Mat.totals.policy_count)
     === Number(allMat.totals.policy_count),
  `${lcg1Mat.totals.policy_count} + ${lcg2Mat.totals.policy_count} = ${allMat.totals.policy_count}`);
check('and so does the realized return — it is not left describing the whole book',
  lcg1Mat.portfolio?.irr !== lcg2Mat.portfolio?.irr
  || lcg1Mat.rows.length === lcg2Mat.rows.length,
  `${lcg1Mat.portfolio?.irr} vs ${lcg2Mat.portfolio?.irr}`);

console.log('\nAVERAGE AGE, PER OWNER');
/* Our two LCG1 fixtures are 80 and 90. The entity holds other policies
   from other suites, so the check is that adding our two known ages moves
   the mean exactly as arithmetic says it must. */
const before = funds.find((f) => f.code === 'LCG1');
check('an entity reports how many lives it is exposed to',
  Number(before.lives_count) > 0, String(before.lives_count));
check('and the average age of them', Number(before.avg_insured_age) > 0,
  String(before.avg_insured_age));
check('counted over lives rather than policies',
  Number(before.lives_count) >= Number(before.policy_count),
  `${before.lives_count} lives across ${before.policy_count} policies`);
check('and it says how many of them have a date of birth on file',
  Number(before.lives_with_dob) <= Number(before.lives_count),
  `${before.lives_with_dob} of ${before.lives_count}`);

const survivor = await mk('S1', 'LCG1', 84, { product_type: 'SUL' });
await api(`/policies/${survivor.id}/insureds`, { method: 'POST', body: {
  insured_last_name: 'EntviewS2', insured_first_name: 'Joint', dob: born(76),
  role: 'Survivorship' } });
const after = ((await json(await api('/funds'))) || []).find((f) => f.code === 'LCG1');
check('a survivorship contract adds two lives, not one',
  Number(after.lives_count) === Number(before.lives_count) + 2,
  `${before.lives_count} → ${after.lives_count}`);
const expected = (Number(before.avg_insured_age) * Number(before.lives_with_dob) + 84 + 76)
  / (Number(before.lives_with_dob) + 2);
check('and the mean moves exactly as arithmetic says it should',
  near(after.avg_insured_age, expected, 0.06),
  `${after.avg_insured_age} against ${expected.toFixed(2)}`);

console.log('\nON SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE); await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 15000 });

for (const [route, name] of [['insureds', 'Insureds'], ['servicing', 'Servicing'],
                             ['maturities', 'Maturities'], ['dashboard', 'the dashboard']]) {
  await p.goto(`${BASE}/#/${route}`); await p.waitForTimeout(1300);
  check(`${name} offers the entity picker`, (await p.locator('#entityFilter').count()) === 1);
}

/* One selection, carried between screens — a filter that silently resets
   on every tab is how somebody reads one entity's totals beside another's
   alerts. */
await p.goto(`${BASE}/#/insureds`); await p.waitForTimeout(1200);
const allRows = await p.locator('table.data tbody tr').count();
await p.locator('#entityFilter').selectOption('LCG1');
await p.waitForTimeout(1400);
const oneRows = await p.locator('table.data tbody tr').count();
check('choosing an entity narrows the list on screen', oneRows < allRows,
  `${oneRows} of ${allRows}`);
check('and the heading says which entity you are looking at',
  /LCG1/.test(await p.locator('.page-head .sub').first().textContent()),
  (await p.locator('.page-head .sub').first().textContent()).trim());
check('and the average age of the people in it',
  /average age/i.test(await p.locator('.page-head .sub').first().textContent()));
await p.screenshot({ path: `${S}/ev1-insureds.png`, fullPage: true });

await p.goto(`${BASE}/#/servicing`); await p.waitForTimeout(1400);
check('the choice is still LCG1 on the next screen',
  (await p.locator('#entityFilter').inputValue()) === 'LCG1');
check('and that screen says so too',
  /LCG1 only/.test(await p.locator('.page-head .sub').first().textContent()),
  (await p.locator('.page-head .sub').first().textContent()).trim());
await p.goto(`${BASE}/#/maturities`); await p.waitForTimeout(1400);
check('and on maturities', (await p.locator('#entityFilter').inputValue()) === 'LCG1');

await p.locator('#entityFilter').selectOption('');
await p.waitForTimeout(1200);
await p.goto(`${BASE}/#/settings`); await p.waitForTimeout(1500);
const entityCard = p.locator('.card', { hasText: 'Owner entities' });
const heads = (await entityCard.locator('thead th').allTextContents()).map((h) => h.trim());
check('the entity table has a lives column', heads.includes('Lives'), heads.join(' | '));
check('and an average age column', heads.some((h) => /Avg age/i.test(h)), heads.join(' | '));
const lcg1Row = (await entityCard.locator('tbody tr', { hasText: 'LCG1' }).first().textContent())
  .replace(/\s+/g, ' ');
check('with a figure in it for an entity that holds policies',
  /\d\d\.\d/.test(lcg1Row), lcg1Row.slice(0, 120));
await p.screenshot({ path: `${S}/ev2-entities.png`, fullPage: true });

console.log('\nAN INVESTOR PRICING THEIR OWN SLICE');
const opp = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-OPP`, carrier_name: 'Entity Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: 'Entviewopp', insured_first_name: 'Otto',
  insured_dob: born(82), insured_gender: 'M', le_months: 84, le_date: iso(-30),
  asking_price: 800000, annual_premium: 60000,
  expected_close: iso(30), offer_closes_on: iso(60) } }));
await api(`/opportunities/${opp.id}/premium-schedule`, { method: 'POST', body: {
  start_date: iso(60), amount: 60000, years: 8, growth_pct: 4, replace: true } });
const investors = await json(await api('/investors'));
const me = investors.find((i) => /one/i.test(i.name));
await api(`/opportunities/${opp.id}/shares`, { method: 'PUT', body: { investor_ids: [me.id] } });

const invCtx = await br.newContext({ viewport: { width: 1440, height: 1100 } });
const inv = await invCtx.newPage();
inv.on('pageerror', (e) => errs.push(e.message));
await inv.goto(BASE);
await inv.fill('#email', INVESTOR1.email); await inv.fill('#password', INVESTOR1.password);
await inv.click('button[type=submit]'); await inv.waitForSelector('.kpi-row', { timeout: 15000 });
await inv.goto(`${BASE}/#/opportunity/${opp.id}`);
await inv.waitForSelector('.scenario-table', { timeout: 12000 });
await inv.waitForTimeout(900);

const moneyIn = async (sel) => Number(
  (await inv.locator(sel).textContent()).replace(/[^0-9.]/g, ''));
const investedRow = '.scenario-table tbody tr:nth-child(4) td.at-le';
const premiumRow = '.scenario-table tbody tr:nth-child(3) td.at-le';
const irrRow = '.scenario-table tbody tr:last-child td.at-le';

const fullInvested = await moneyIn(investedRow);
const fullPremiums = await moneyIn(premiumRow);
const fullIrr = (await inv.locator(irrRow).textContent()).trim();
const firstScheduleShare = '.card:has(h2:text("Premium schedule")) tbody tr:first-child td:nth-child(3)';
const fullFirstPremium = Number((await inv.locator(
  '.card:has(h2:text("Premium schedule")) tbody tr:first-child td:nth-child(2)')
  .textContent()).replace(/[^0-9.]/g, ''));

check('before choosing anything, the page says it is showing the whole policy',
  /whole policy/i.test(await inv.locator('#shareBanner').textContent()),
  (await inv.locator('#shareBanner').textContent()).trim());
check('and total invested is the whole policy figure', fullInvested > 0, String(fullInvested));
await inv.screenshot({ path: `${S}/ev3-before.png`, fullPage: true });

await inv.fill('#takePct', '25');
await inv.waitForTimeout(700);

check('typing 25 says so, before anything is requested',
  /your 25%/i.test(await inv.locator('#shareBanner').textContent()),
  (await inv.locator('#shareBanner').textContent()).trim());
check('total invested restates to a quarter',
  near(await moneyIn(investedRow), fullInvested / 4, 1),
  `${await moneyIn(investedRow)} against ${(fullInvested / 4).toFixed(2)}`);
check('so do the premiums to life expectancy',
  near(await moneyIn(premiumRow), fullPremiums / 4, 1),
  `${await moneyIn(premiumRow)} against ${(fullPremiums / 4).toFixed(2)}`);
check('and every dated premium in the schedule',
  near(await moneyIn(firstScheduleShare), fullFirstPremium / 4, 1),
  `${await moneyIn(firstScheduleShare)} against ${(fullFirstPremium / 4).toFixed(2)}`);
check('the outlay box agrees with the scenario table exactly',
  near(await moneyIn('#takeOutlay'), await moneyIn(investedRow), 0.01),
  `${await moneyIn('#takeOutlay')} against ${await moneyIn(investedRow)}`);
check('purchase price plus premiums is the outlay',
  near(await moneyIn('#takeCost') + await moneyIn('#takePremiums'),
    await moneyIn('#takeOutlay'), 1),
  `${await moneyIn('#takeCost')} + ${await moneyIn('#takePremiums')} = ${await moneyIn('#takeOutlay')}`);
check('and the rate does not move, because a rate has no size',
  (await inv.locator(irrRow).textContent()).trim() === fullIrr, fullIrr);
await inv.screenshot({ path: `${S}/ev4-at-25.png`, fullPage: true });

await inv.fill('#takePct', '50');
await inv.waitForTimeout(600);
check('changing it to 50 doubles the outlay again',
  near(await moneyIn('#takeOutlay'), fullInvested / 2, 1),
  `${await moneyIn('#takeOutlay')} against ${(fullInvested / 2).toFixed(2)}`);
await inv.fill('#takePct', '');
await inv.waitForTimeout(600);
check('clearing the box puts the whole policy back',
  near(await moneyIn(investedRow), fullInvested, 1)
  && /whole policy/i.test(await inv.locator('#shareBanner').textContent()),
  String(await moneyIn(investedRow)));
check('asking for more than is left is refused before it is sent',
  await (async () => { await inv.fill('#takePct', '99999'); await inv.waitForTimeout(500);
    return /available to you/i.test(await inv.locator('#takeMsg').textContent()); })(),
  (await inv.locator('#takeMsg').textContent()).trim());

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL ENTITY VIEW CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
