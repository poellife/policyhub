/* =====================================================================
   An investor in more than one owner entity.

   An investor used to be filed under one entity. A client of two had to
   be filed under one and granted to the other's manager by hand. Now an
   administrator ticks as many as apply. What has to be true:

     - The list is saved, read back, and shown as "LCG1, TESTCO".
     - Every manager of any entity on the list sees the investor; taking
       the entity off takes the investor out of that manager's list again.
     - The entity filter on the Investors screen finds them under each.
     - The single "owner entity" column stays one of the list, so older
       screens still have an answer; an old-style single fund_id still works.
     - Only an administrator can change it, and only to entities that exist.
     - On screen: ticks on the form, and the list column shows them all.

   Idempotent: fixture investors use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'MULTIENT';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const call = (cookie) => async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const api = call(admin), mgr = call(pm1);

const funds = (await api('/funds')).body;
const LCG1 = funds.find((f) => f.code === 'LCG1');
const OTHER = funds.find((f) => f.code !== 'LCG1' && f.code !== 'LCG2');
if (!LCG1 || !OTHER) { console.log('needs LCG1 and one entity pm1 does not manage'); process.exit(1); }

const wipe = async () => {
  for (const i of ((await api(`/investors?search=${PREFIX}`)).body || []))
    await api(`/investors/${i.id}`, { method: 'DELETE', body: { confirm: i.name } });
};
await wipe();
const mgrSees = async (id) => ((await mgr(`/investors?search=${PREFIX}`)).body || [])
  .some((i) => i.id === id);

console.log('SAVED AS A LIST');
const made = await api('/investors', { method: 'POST', body: {
  name: `${PREFIX} Ruth Two-Entities`, investor_type: 'Individual', fund_ids: [OTHER.id] } });
check('an investor can be created with an entity list', made.status === 201, String(made.status));
const id = made.body.id;
check('and reads back with it', JSON.stringify(made.body.fund_ids) === JSON.stringify([OTHER.id])
  && made.body.fund_codes === OTHER.code, `${made.body.fund_ids} ${made.body.fund_codes}`);
check('the single column holds it as the primary', made.body.fund_id === OTHER.id);
check('pm1 does not see someone filed only under another entity', !(await mgrSees(id)));

const two = await api(`/investors/${id}`, { method: 'PUT', body: { fund_ids: [OTHER.id, LCG1.id] } });
const codes = [LCG1.code, OTHER.code].sort().join(', ');
check('a second entity is added', two.status === 200 && two.body.fund_codes === codes,
  `${two.status} ${two.body?.fund_codes}`);
check('the primary stays the one it was', two.body.fund_id === OTHER.id, String(two.body.fund_id));
check('and now pm1, who manages LCG1, sees them', await mgrSees(id));
check('the detail opens for pm1 too', (await mgr(`/investors/${id}`)).status === 200);

console.log('\nFOUND UNDER EACH');
const under = async (code) => ((await api(`/investors?search=${PREFIX}&fund=${code}`)).body || [])
  .some((i) => i.id === id);
check(`filtering on ${LCG1.code} finds them`, await under(LCG1.code));
check(`and filtering on ${OTHER.code}`, await under(OTHER.code));

console.log('\nTAKEN OFF AGAIN');
const back = await api(`/investors/${id}`, { method: 'PUT', body: { fund_ids: [LCG1.id] } });
check('removing the primary moves it to what is left',
  back.body.fund_id === LCG1.id && back.body.fund_codes === LCG1.code,
  `${back.body.fund_id} ${back.body.fund_codes}`);
check(`no longer under ${OTHER.code}`, !(await under(OTHER.code)));
const none = await api(`/investors/${id}`, { method: 'PUT', body: { fund_ids: [] } });
check('clearing the list leaves them unassigned',
  none.body.fund_id === null && none.body.fund_codes === '', JSON.stringify(none.body.fund_ids));
check('and out of pm1’s list', !(await mgrSees(id)));

console.log('\nOLDER CLIENTS AND THE RULES');
const legacy = await api(`/investors/${id}`, { method: 'PUT', body: { fund_id: LCG1.id } });
check('a single fund_id still works, as a list of one',
  legacy.body.fund_codes === LCG1.code && legacy.body.fund_id === LCG1.id);
const bad = await api(`/investors/${id}`, { method: 'PUT', body: { fund_ids: [LCG1.id, 999999] } });
check('an entity that does not exist is refused', bad.status === 400, String(bad.status));
check('and changes nothing', (await api(`/investors/${id}`)).body.fund_codes === LCG1.code);
await mgr(`/investors/${id}`, { method: 'PUT', body: { phone: '555-0100', fund_ids: [OTHER.id] } });
const after = (await api(`/investors/${id}`)).body;
check('a manager cannot change the entities (the field is ignored)',
  after.fund_codes === LCG1.code && after.phone === '555-0100', `${after.fund_codes} ${after.phone}`);
await api(`/investors/${id}`, { method: 'PUT', body: { fund_ids: [OTHER.id] } });
check('a manager whose entity was removed cannot open them',
  (await mgr(`/investors/${id}`)).status === 404);

console.log('\nON SCREEN');
await api(`/investors/${id}`, { method: 'PUT', body: { fund_ids: [OTHER.id] } });
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/investor/${id}`);
await p.waitForSelector('#editInvestorBtn', { timeout: 20000 });
await p.click('#editInvestorBtn');
await p.waitForSelector('#invFundTicks');
const ticks = p.locator('#invFundTicks input[name="fund_ids"]');
check('the form has one tick per entity', await ticks.count() === funds.length,
  `${await ticks.count()} of ${funds.length}`);
check('with the current one ticked',
  await p.locator(`#invFundTicks input[value="${OTHER.id}"]`).isChecked());
await p.locator(`#invFundTicks input[value="${LCG1.id}"]`).check();
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1500);
check('saving keeps both', (await api(`/investors/${id}`)).body.fund_codes === codes);
await p.goto(`${BASE}/#/investors`);
await p.waitForSelector(`tr[data-investor="${id}"]`, { timeout: 20000 });
check('the Investors list shows both',
  (await p.locator(`tr[data-investor="${id}"]`).innerText()).includes(codes));
await p.goto(`${BASE}/#/investor/${id}`);
await p.waitForSelector('#editInvestorBtn');
await p.click('#editInvestorBtn');
await p.waitForSelector('#invFundTicks');
await p.locator(`#invFundTicks input[value="${LCG1.id}"]`).uncheck();
await p.locator(`#invFundTicks input[value="${OTHER.id}"]`).uncheck();
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1500);
check('unticking all of them leaves them unassigned',
  (await api(`/investors/${id}`)).body.fund_codes === '');
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();

await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All multi-entity investor checks passed.'}`);
process.exit(fails.length ? 1 : 0);
