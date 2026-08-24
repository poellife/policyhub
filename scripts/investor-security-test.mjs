/* =====================================================================
   Investor boundary tests.

   These deliberately bypass the interface and hit the API directly with
   an investor session, because that is what an attacker would do. A UI
   that merely hides a button is not a security boundary.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, INVESTOR2 } from './test-config.mjs';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const staff    = await login(ADMIN.email, ADMIN.password);
const harrison = await login(INVESTOR1.email, INVESTOR1.password);
const okonkwo  = await login(INVESTOR2.email, INVESTOR2.password);

const allPolicies = await json(await api(staff, '/policies'));
const harrisonIds = (await json(await api(harrison, '/policies'))).map((p) => p.id);
const okonkwoIds  = (await json(await api(okonkwo,  '/policies'))).map((p) => p.id);
const notHarrison = allPolicies.filter((p) => !harrisonIds.includes(p.id));

console.log('\nREAD ISOLATION');
check('investor list is a strict subset', harrisonIds.length > 0 && harrisonIds.length < allPolicies.length,
  `${harrisonIds.length} of ${allPolicies.length}`);

let leaked = 0;
for (const p of notHarrison) {
  const r = await api(harrison, `/policies/${p.id}`);
  if (r.status === 200) leaked++;
}
check('cannot open an unowned policy by id', leaked === 0, `${leaked} leaked of ${notHarrison.length}`);

const okOnly = okonkwoIds.filter((id) => !harrisonIds.includes(id));
check('two investors have genuinely different books', okOnly.length > 0, `${okOnly.length} exclusive to okonkwo`);

// A policy both hold: each must see only their own cap-table line.
const shared = harrisonIds.filter((id) => okonkwoIds.includes(id))[0];
if (shared) {
  const hDetail = await json(await api(harrison, `/policies/${shared}`));
  const sDetail = await json(await api(staff, `/policies/${shared}`));
  check('shared policy: investor sees only their own allocation',
    hDetail.owners.length === 1, `${hDetail.owners.length} rows`);
  check('shared policy: staff sees the whole cap table',
    sDetail.owners.length > 1, `${sDetail.owners.length} rows`);
  check('shared policy: percentages differ per investor',
    Number(hDetail.my_pct) !== 100 && Number(sDetail.my_pct) === 100,
    `investor ${hDetail.my_pct}% / staff ${sDetail.my_pct}%`);
}

console.log('\nINSURED ISOLATION');
const staffInsureds = await json(await api(staff, '/insureds'));
const hInsureds = await json(await api(harrison, '/insureds'));
check('insured list is scoped', hInsureds.length < staffInsureds.length,
  `${hInsureds.length} of ${staffInsureds.length}`);
const hInsuredIds = hInsureds.map((i) => i.id);
const foreignInsured = staffInsureds.find((i) => !hInsuredIds.includes(i.id));
if (foreignInsured) {
  const r = await api(harrison, `/insureds/${foreignInsured.id}`);
  check('cannot open an unowned insured by id', r.status === 404, `status ${r.status}`);
}

console.log('\nSTAFF-ONLY ROUTES REJECT INVESTORS');
const blocked = [
  ['GET',  '/investors'],
  ['GET',  '/investors/1'],
  ['GET',  '/funds'],
  ['GET',  '/users'],
  ['GET',  '/audit'],
  ['POST', '/investors'],
  ['POST', '/funds'],
  ['POST', '/policies'],
  ['POST', '/insureds'],
];
for (const [method, path] of blocked) {
  const r = await api(harrison, path, { method, body: method === 'POST' ? '{}' : undefined });
  check(`${method} ${path} rejected`, r.status === 403 || r.status === 404, `status ${r.status}`);
}

console.log('\nWRITE ATTEMPTS ON OWNED DATA STILL REJECTED');
const ownId = harrisonIds[0];
const writes = [
  ['PUT',    `/policies/${ownId}`, '{"notes":"hacked"}'],
  ['DELETE', `/policies/${ownId}`, '{"confirm":"x"}'],
  ['POST',   `/policies/${ownId}/values`, '{"as_of_date":"2026-01-01"}'],
  ['POST',   `/policies/${ownId}/transactions`, '{"txn_date":"2026-01-01","txn_type":"Fee","amount":1}'],
  ['POST',   `/policies/${ownId}/investors`, '{"investor_id":1,"pct":1}'],
];
for (const [method, path, body] of writes) {
  const r = await api(harrison, path, { method, body });
  check(`${method} ${path.replace(String(ownId), ':own')} rejected`, r.status === 403, `status ${r.status}`);
}

console.log('\nIMPORT AND TEMPLATES REJECTED');
for (const path of ['/import/run', '/import/preview']) {
  const r = await api(harrison, path, { method: 'POST' });
  check(`POST ${path} rejected`, r.status === 403, `status ${r.status}`);
}
const tpl = await api(harrison, '/import/template/policies');
check('GET /import/template rejected', tpl.status === 403, `status ${tpl.status}`);

console.log('\nREPORTS AND SERVICING ARE SCOPED, NOT BLOCKED');
const hSum = await json(await api(harrison, '/analytics/summary'));
const sSum = await json(await api(staff, '/analytics/summary'));
check('investor summary is scoped', hSum.scopedToInvestor === true && sSum.scopedToInvestor === false);
check('investor totals are smaller than the book',
  Number(hSum.totals.total_death_benefit) < Number(sSum.totals.total_death_benefit),
  `${hSum.totals.total_death_benefit} < ${sSum.totals.total_death_benefit}`);

const hSvc = await json(await api(harrison, '/servicing'));
const svcIds = [...new Set(hSvc.upcoming.map((r) => r.id))];
check('servicing only lists owned policies', svcIds.every((id) => harrisonIds.includes(id)),
  svcIds.join(','));

const hFc = await json(await api(harrison, '/reports/premium-forecast?months=12'));
const fcIds = [...new Set(hFc.schedule.flatMap((m) => m.payments.map((p) => p.policy_id)))];
check('forecast only covers owned policies', fcIds.every((id) => harrisonIds.includes(id)),
  fcIds.join(','));

const hRpt = await json(await api(harrison, '/reports/portfolio'));
check('portfolio report is scoped', hRpt.scopedToInvestor === true);
check('report totals match the dashboard',
  Math.abs(Number(hRpt.totals.total_death_benefit) - Number(hSum.totals.total_death_benefit)) < 0.01,
  `${hRpt.totals.total_death_benefit} vs ${hSum.totals.total_death_benefit}`);

console.log('\nSHARE MATHS');
const hPolicies = await json(await api(harrison, '/policies'));
const expectedDB = hPolicies
  .filter((p) => !['Lapsed', 'Sold', 'Matured'].includes(p.status))
  .reduce((sum, p) => sum + (Number(p.death_benefit ?? p.face_amount) * Number(p.my_pct)) / 100, 0);
check('weighted death benefit matches row-by-row maths',
  Math.abs(expectedDB - Number(hSum.totals.total_death_benefit)) < 0.01,
  `${expectedDB.toFixed(2)} vs ${Number(hSum.totals.total_death_benefit).toFixed(2)}`);

console.log('\nFORGED SCOPE');
const forged = await api(harrison, `/policies?fund=&search=&status=`, {});
check('query params cannot widen scope', (await json(forged)).length === harrisonIds.length);

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL INVESTOR SECURITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
