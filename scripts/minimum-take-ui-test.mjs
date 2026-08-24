/* =====================================================================
   The floor, on screen.

   The API refuses a small request, but an investor should not have to
   click to find that out. The box states the range, the button will not
   fire below it, and the reason appears as they type.

   The second half is the case worth watching: when fewer than ten points
   are left the wording has to change, because "minimum 10%" in front of
   a 6% remainder is a contradiction the investor cannot resolve.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'MINUI';
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

const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);
const me1 = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: inv1 } }))).investor.id;
const me2 = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: inv2 } }))).investor.id;
const funds = await json(await api('/funds'));

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const make = async (suffix) => {
  const o = await json(await api('/opportunities', { method: 'POST', body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Floor Life', product_type: 'UL',
    face_amount: 3000000, insured_last_name: 'Minimum', insured_first_name: 'Isla',
    insured_dob: '1940-06-04', insured_gender: 'F', insured_state: 'MI',
    le_months: 72, le_provider: 'AVS', le_date: '2026-02-01',
    asking_price: 640000, annual_premium: 52000,
    expected_close: '2026-10-31', offer_closes_on: '2027-08-31',
    fund_id: funds.find((f) => f.code === 'LCG1').id } }));
  await api(`/opportunities/${o.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
  return o;
};

const open = await make('open');
const nearly = await make('nearly');

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1400, height: 1050 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]|409|429/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', INVESTOR1.email); await p.fill('#password', INVESTOR1.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 15000 });

console.log('THE BOX STATES THE RANGE BEFORE ANYTHING IS TYPED');
await p.goto(`${BASE}/#/opportunity/${open.id}`);
await p.waitForSelector('#takePct', { timeout: 12000 });
await p.waitForTimeout(600);
check('the input will not go below ten',
  (await p.locator('#takePct').getAttribute('min')) === '10',
  await p.locator('#takePct').getAttribute('min'));
check('and says so in the placeholder',
  /^10% to /.test(await p.locator('#takePct').getAttribute('placeholder')),
  await p.locator('#takePct').getAttribute('placeholder'));
const hint = (await p.locator('.opp-take .field .muted').first().textContent()).replace(/\s+/g, ' ');
check('with the range spelled out underneath', /Minimum 10%, up to 100%/.test(hint), hint);

console.log('\nTYPING TOO LITTLE SAYS SO, AND STOPS THE BUTTON');
await p.fill('#takePct', '4');
await p.waitForTimeout(500);
check('the reason appears without clicking',
  /smallest share we can take is 10%/i.test(await p.locator('#takeMsg').textContent()),
  (await p.locator('#takeMsg').textContent()).trim());
check('and the request button is not clickable',
  await p.locator('#takeBtn').isDisabled());
check('but the figures still restate, so they can see what 4% would cost',
  (await p.locator('#takeCost').textContent()) !== '—',
  (await p.locator('#takeCost').textContent()).trim());
await p.screenshot({ path: `${S}/mt1-too-small.png`, fullPage: true });

await p.fill('#takePct', '10');
await p.waitForTimeout(500);
check('at ten the warning clears', (await p.locator('#takeMsg').textContent()).trim() === '');
check('and the button comes back', !(await p.locator('#takeBtn').isDisabled()));
await p.click('#takeBtn');
await p.waitForTimeout(1800);
check('ten per cent goes through',
  /Your request: 10%/.test(await p.locator('.main').textContent()),
  (await p.locator('.opp-take').last().textContent()).replace(/\s+/g, ' ').slice(0, 60));

console.log('\nWHEN LESS THAN TEN IS LEFT, THE WORDING CHANGES');
/* Somebody else takes 94, leaving six. "Minimum 10%" in front of a 6%
   remainder would be an instruction the investor cannot follow. */
await api(`/opportunities/${nearly.id}/shares`,
  { method: 'PUT', body: { investor_ids: [me1, me2] } });
await fetch(`${BASE}/api/opportunities/${nearly.id}/commit`, {
  method: 'POST', headers: { Cookie: inv2, 'Content-Type': 'application/json' },
  body: JSON.stringify({ pct: 94 }) });

await p.goto(`${BASE}/#/opportunity/${nearly.id}`);
await p.waitForSelector('#takePct', { timeout: 12000 });
await p.waitForTimeout(700);
check('the input floor drops to what is actually left',
  (await p.locator('#takePct').getAttribute('min')) === '6',
  await p.locator('#takePct').getAttribute('min'));
const lastHint = (await p.locator('.opp-take .field .muted').first().textContent()).replace(/\s+/g, ' ');
check('and the hint says the last slice is taken whole',
  /Only 6% is left, and the last slice is taken whole/.test(lastHint), lastHint);
check('it does not still claim a ten per cent minimum', !/Minimum 10%/.test(lastHint), lastHint);

await p.fill('#takePct', '3');
await p.waitForTimeout(500);
check('half of it is refused, in those words',
  /last slice has to be taken whole/i.test(await p.locator('#takeMsg').textContent()),
  (await p.locator('#takeMsg').textContent()).trim());
await p.screenshot({ path: `${S}/mt2-last-slice.png`, fullPage: true });

await p.fill('#takePct', '6');
await p.waitForTimeout(500);
check('the whole remainder is allowed', !(await p.locator('#takeBtn').isDisabled()));
await p.click('#takeBtn');
await p.waitForTimeout(1800);
check('and goes through', /Your request: 6%/.test(await p.locator('.main').textContent()),
  (await p.locator('.opp-take').last().textContent()).replace(/\s+/g, ' ').slice(0, 60));

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL MINIMUM TAKE UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
