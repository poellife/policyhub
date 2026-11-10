/* =====================================================================
   Carried interest is for administrators only.

   The rate an entity charges, the carry on each policy, the commission and
   the return "net to investors" after it are shown to an administrator
   and to nobody else: not an editor, a viewer, a portfolio manager, an
   investor or a CFO. Taken out of every response at the edge, and off
   every screen. An editor may still edit an entity, but not its rate.

   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'CARRYADM';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const call = (cookie) => async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const adminCookie = await login(ADMIN.email, ADMIN.password);
const api = call(adminCookie);
const funds = (await api('/funds')).body;
const LCG1 = funds.find((f) => f.code === 'LCG1');
const users = (await api('/users')).body;
const inv1 = users.find((u) => u.email === INVESTOR1.email)?.investor_id;
const EDITOR = `${PREFIX.toLowerCase()}-ed@test.local`, CFO = `${PREFIX.toLowerCase()}-cfo@test.local`;

const wipe = async () => {
  for (const u of ((await api('/users')).body || []).filter((x) => [EDITOR, CFO].includes(x.email)))
    await api(`/users/${u.id}`, { method: 'DELETE' });
  for (const status of ['', 'Matured'])
    for (const x of ((await api(`/policies?status=${status}`)).body || [])
      .filter((y) => String(y.policy_number).startsWith(PREFIX))) {
      const d = (await api(`/policies/${x.id}`)).body;
      if (d?.insured_id) await api(`/insureds/${d.insured_id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
    }
};
await wipe();

/* One matured, paid policy in LCG1 (so there is carry and a commission to
   hide) held by INVESTOR1, and one still running. */
const mk = async (tag, died) => {
  const p = (await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Margin Life', product_type: 'UL',
    fund_code: 'LCG1', face_amount: 1000000, insured_last_name: `${PREFIX}${tag}`,
    insured_first_name: 'Ada', dob: '1938-03-03' } })).body;
  await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-1200), txn_type: 'Acquisition Cost', amount: 500000 } });
  if (inv1) await api(`/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: inv1, pct: 50, acquired_on: iso(-1200) } });
  if (died) {
    await api(`/insureds/${p.insured_id}`, { method: 'PUT', body: { date_of_death: iso(-died) } });
    await api(`/policies/${p.id}/proceeds`, { method: 'PUT', body: {
      proceeds_amount: 1000000, proceeds_received_on: iso(-died + 10) } });
  }
  return p;
};
const M = await mk('M', 40);
await mk('L');

const pw = scratchPassword('carry');
await api('/users', { method: 'POST', body: { email: EDITOR, full_name: 'Ed Itor', role: 'editor', password: pw } });
await api('/users', { method: 'POST', body: { email: CFO, full_name: 'Cy Effo', role: 'cfo', password: pw, fund_ids: [LCG1.id] } });

const CARRY_KEYS = ['carry', 'carry_pct', 'charges_carry', 'commission', 'commission_pct',
  'net_rate', 'net_compound_rate', 'net_profit', 'net_return', 'policies_without_carry'];
const hasCarryKey = (v) => {
  if (Array.isArray(v)) return v.some(hasCarryKey);
  if (!v || typeof v !== 'object') return false;
  return Object.entries(v).some(([k, x]) => CARRY_KEYS.includes(k) || hasCarryKey(x));
};

console.log('THE ADMINISTRATOR STILL SEES IT ALL');
const aSum = (await api('/analytics/summary')).body;
check('the dashboard carries the carried-interest figure', !!aSum.carry, JSON.stringify(aSum.carry));
check('entities carry their rate', (await api('/funds')).body.every((f) => 'carry_pct' in f));
const aMat = (await api('/maturities')).body;
const aRow = aMat.rows.find((r) => r.id === M.id);
check('the maturities register has commission and net return', aRow && 'commission' in aRow
  && 'net_compound_rate' in aRow, aRow ? Object.keys(aRow).filter((k) => CARRY_KEYS.includes(k)).join(',') : 'no row');
check('and the Carried interest screen opens', (await api('/carry')).status === 200);

const roles = [
  ['an editor', await login(EDITOR, pw)],
  ['a portfolio manager', await login(MANAGER1.email, MANAGER1.password)],
  ['an investor', await login(INVESTOR1.email, INVESTOR1.password)],
  ['a CFO', await login(CFO, pw)],
];
for (const [who, cookie] of roles) {
  console.log(`\n${who.toUpperCase()} SEES NONE OF IT`);
  const c = call(cookie);
  const reads = {};
  for (const path of ['/analytics/summary', '/funds', '/maturities', '/policies',
    `/policies/${M.id}`, `/policies/${M.id}/irr`, '/servicing']) {
    const r = await c(path);
    if (r.status === 200) reads[path] = r.body;
  }
  const leaked = Object.entries(reads).filter(([, b]) => hasCarryKey(b)).map(([p]) => p);
  check(`no carried-interest field in anything ${who} can read`, leaked.length === 0,
    `${Object.keys(reads).length} read · leaked: ${leaked.join(', ') || 'none'}`);
  check('the Carried interest screen is refused', (await c('/carry')).status === 403);
}

console.log('\nAN EDITOR CAN EDIT AN ENTITY BUT NOT ITS RATE');
const ed = call(roles[0][1]);
const before = Number(LCG1.carry_pct);
const put = await ed(`/funds/${LCG1.id}`, { method: 'PUT', body: {
  code: LCG1.code, name: LCG1.name, notes: LCG1.notes || '', carry_pct: before + 7 } });
check('the save goes through', put.status === 200, String(put.status));
const after = Number((await api('/funds')).body.find((f) => f.id === LCG1.id).carry_pct);
check('and the rate is unchanged', after === before, `${before} → ${after}`);

console.log('\nON SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctxFor = async (email, password) => {
  const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE);
  await p.fill('#email', email);
  await p.fill('#password', password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row', { timeout: 20000 });
  return p;
};
const text = async (p, route) => {
  await p.goto(`${BASE}/#/${route}`);
  await p.waitForTimeout(1800);
  return p.locator('#main').innerText();
};
const ap = await ctxFor(ADMIN.email, ADMIN.password);
check('the administrator’s dashboard shows Carried interest', /carried interest/i.test(await text(ap, 'dashboard')));
check('and the entities table its rates', /carried interest/i.test(await text(ap, 'settings')));
for (const [who, email, password] of [['editor', EDITOR, pw], ['manager', MANAGER1.email, MANAGER1.password],
  ['investor', INVESTOR1.email, INVESTOR1.password], ['CFO', CFO, pw]]) {
  const p = await ctxFor(email, password);
  const nav = (await p.locator('.nav a').allTextContents()).join(' ');
  const seen = [await text(p, 'dashboard'), await text(p, 'maturities'), await text(p, 'settings')].join('\n');
    /* "commissions" in the plural is a ledger cost (a broker paid on a
     purchase), named in the note on what Gain is made of -- not ours. */
  const hit = `${nav}\n${seen}`.match(/.{0,60}(carried interest|\bcommission\b|net to investors).{0,40}/i);
  check(`the ${who} sees no carried interest, commission or "net to investors" anywhere`,
    !hit, hit ? hit[0].replace(/\s+/g, ' ') : '');
  if (who === 'editor') {
    await p.goto(`${BASE}/#/settings`);
    await p.waitForTimeout(1500);
    const editBtn = p.locator('[data-edit-entity], button:has-text("Edit")').first();
    if (await p.locator('#addEntityBtn').count()) {
      await p.click('#addEntityBtn');
      await p.waitForSelector('dialog[open]');
      const dlg = await p.locator('dialog[open]').innerText();
      check('the editor’s entity form has no carried-interest section',
        !/carried interest|share of the profit/i.test(dlg));
      await p.click('#dlgCancel');
    }
    void editBtn;
  }
}
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();

await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All carried-interest visibility checks passed.'}`);
process.exit(fails.length ? 1 : 0);
