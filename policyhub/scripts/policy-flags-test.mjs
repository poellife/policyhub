/* =====================================================================
   ROP and Age 100 issue: two tick boxes on every policy.

     - Both start unticked; each can be ticked and unticked on its own.
     - Ticked from a row of the policies grid (without opening the policy),
       from the policy's own page, and from Edit policy; all three agree.
     - Saved at once and written to the activity log.
     - Staff only: an investor's copy of the policy does not carry them,
       and a viewer sees a mark, not a box.
   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'FLAGT';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const call = (cookie) => async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const api = call(await login(ADMIN.email, ADMIN.password));
const wipe = async () => {
  for (const x of ((await api('/policies?status=')).body || []).filter((y) => String(y.policy_number).startsWith(PREFIX)))
    await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
};
await wipe();
const users = (await api('/users')).body;
const inv1 = users.find((u) => u.email === INVESTOR1.email)?.investor_id;
const mk = async (tag) => (await api('/policies', { method: 'POST', body: { policy_number: `${PREFIX}-${tag}`,
  carrier_name: 'Flag Life', product_type: 'UL', fund_code: 'LCG1', face_amount: 1000000,
  insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Fay', dob: '1940-01-01' } })).body;
const A = await mk('A'), B = await mk('B');
if (inv1) await api(`/policies/${A.id}/investors`, { method: 'POST', body: { investor_id: inv1, pct: 10 } });
const get = async (id) => (await api(`/policies/${id}`)).body;

console.log('ON THE RECORD');
check('both start unticked', A.rop === false && A.age100_issue === false, `${A.rop} ${A.age100_issue}`);
check('ROP can be ticked on its own', (await api(`/policies/${A.id}`, { method: 'PUT', body: { rop: true } })).status === 200
  && (await get(A.id)).rop === true && (await get(A.id)).age100_issue === false);
check('and Age 100 issue on its own', (await api(`/policies/${A.id}`, { method: 'PUT', body: { age100_issue: true } })).status === 200
  && (await get(A.id)).rop === true && (await get(A.id)).age100_issue === true);
check('and unticked', (await api(`/policies/${A.id}`, { method: 'PUT', body: { rop: false } })).status === 200
  && (await get(A.id)).rop === false);
check('the list carries them', ((await api('/policies')).body || []).find((p) => p.id === A.id)?.age100_issue === true);
check('other policies are untouched', (await get(B.id)).rop === false && (await get(B.id)).age100_issue === false);
check('and it is in the activity log', ((await api('/audit')).body || []).some((a) => /rop|age100_issue/.test(a.detail || '')));
if (inv1) {
  const inv = call(await login(INVESTOR1.email, INVESTOR1.password));
  const mine = (await inv(`/policies/${A.id}`)).body;
  check('an investor’s copy does not carry them', mine && !('rop' in mine) && !('age100_issue' in mine));
  check('nor can an investor set them', (await inv(`/policies/${A.id}`, { method: 'PUT', body: { rop: true } })).status === 403);
}

console.log('\nON SCREEN');
await api(`/policies/${A.id}`, { method: 'PUT', body: { rop: false, age100_issue: false } });
await api('/me/prefs/policy_columns', { method: 'DELETE' });
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector(`tr[data-id="${A.id}"]`, { timeout: 20000 });
const heads = (await p.locator('table.data thead th').allTextContents()).map((t) => t.trim().toLowerCase());
check('the grid has ROP and Age 100 issue columns', heads.some((h) => h.startsWith('rop')) && heads.some((h) => h.startsWith('age 100 issue')), heads.join(' | '));
await p.locator(`tr[data-id="${A.id}"] input[data-flag="rop"]`).check();
await p.waitForTimeout(900);
check('ticking ROP in a row saves it', (await get(A.id)).rop === true);
check('without opening the policy', /#\/policies$/.test(p.url()), p.url());
await p.locator(`tr[data-id="${B.id}"] input[data-flag="age100_issue"]`).check();
await p.waitForTimeout(900);
check('each row is its own policy', (await get(B.id)).age100_issue === true && (await get(B.id)).rop === false
  && (await get(A.id)).age100_issue === false);
await p.goto(`${BASE}/#/policy/${A.id}`);
await p.waitForSelector('input[data-flag="age100_issue"]', { timeout: 20000 });
check('the policy page shows ROP ticked', await p.locator('input[data-flag="rop"]').first().isChecked());
await p.locator('input[data-flag="rop"]').first().uncheck();
await p.waitForTimeout(900);
check('and unticking it there saves', (await get(A.id)).rop === false);
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All policy flag checks passed.'}`);
process.exit(fails.length ? 1 : 0);
