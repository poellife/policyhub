/* =====================================================================
   Portfolio-manager boundary tests.

   A manager has full read/write inside their own owning entities and no
   access at all outside them, nor to the Settings surface. As with the
   investor tests, these hit the API directly rather than the interface.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, MANAGER2, INVESTOR1 } from './test-config.mjs';
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

const staff = await login(ADMIN.email, ADMIN.password);
const pm1   = await login(MANAGER1.email, MANAGER1.password);   // LCG1 only
const pm2   = await login(MANAGER2.email, MANAGER2.password);   // LCG1 + LCG2

const all  = await json(await api(staff, '/policies'));
const p1   = await json(await api(pm1, '/policies'));
const p2   = await json(await api(pm2, '/policies'));
const p1Ids = p1.map((p) => p.id);
const outside = all.filter((p) => !p1Ids.includes(p.id));

console.log('READ SCOPE');
check('single-entity manager sees a subset', p1.length > 0 && p1.length < all.length,
  `${p1.length} of ${all.length}`);
check('every visible policy is in their entity', p1.every((p) => p.fund_code === 'LCG1'),
  [...new Set(p1.map((p) => p.fund_code))].join(','));
check('two-entity manager sees both books', p2.length === all.length, `${p2.length} of ${all.length}`);

let leaked = 0;
for (const p of outside) if ((await api(pm1, `/policies/${p.id}`)).status === 200) leaked++;
check('cannot open a policy outside their entities', leaked === 0, `${leaked} of ${outside.length}`);

const funds1 = await json(await api(pm1, '/funds'));
check('entity list is scoped', funds1.length === 1 && funds1[0].code === 'LCG1',
  funds1.map((f) => f.code).join(','));

const ins1 = await json(await api(pm1, '/insureds'));
const insAll = await json(await api(staff, '/insureds'));
check('insureds are scoped', ins1.length < insAll.length, `${ins1.length} of ${insAll.length}`);

const sum1 = await json(await api(pm1, '/analytics/summary'));
const sumAll = await json(await api(staff, '/analytics/summary'));
check('dashboard totals are scoped',
  Number(sum1.totals.total_death_benefit) < Number(sumAll.totals.total_death_benefit),
  `${sum1.totals.total_death_benefit} < ${sumAll.totals.total_death_benefit}`);
check('manager figures are NOT share-weighted', sum1.scopedToInvestor === false);

const svc1 = await json(await api(pm1, '/servicing'));
check('servicing is scoped', svc1.upcoming.every((r) => p1Ids.includes(r.id)));

const fc1 = await json(await api(pm1, '/reports/premium-forecast?months=12'));
const fcIds = [...new Set(fc1.schedule.flatMap((m) => m.payments.map((x) => x.policy_id)))];
check('forecast is scoped', fcIds.every((id) => p1Ids.includes(id)));

console.log('\nWRITE ACCESS INSIDE THEIR ENTITIES');
const own = p1Ids[0];
const upd = await api(pm1, `/policies/${own}`, { method: 'PUT', body: '{"notes":"managed"}' });
check('can edit a policy in their entity', upd.status === 200, `status ${upd.status}`);
const snap = await api(pm1, `/policies/${own}/values`, {
  method: 'POST', body: '{"as_of_date":"2026-09-30","account_value":1234.56}' });
check('can add a value snapshot', snap.status === 201, `status ${snap.status}`);
const txn = await api(pm1, `/policies/${own}/transactions`, {
  method: 'POST', body: '{"txn_date":"2026-09-30","txn_type":"Fee","amount":25}' });
check('can add a transaction', txn.status === 201, `status ${txn.status}`);
// Pick a policy with room left, rather than one already fully allocated.
let allocTarget = null;
for (const id of p1Ids) {
  const d = await json(await api(pm1, `/policies/${id}`));
  const used = (d.owners || []).reduce((sum, o) => sum + Number(o.pct), 0);
  if (used < 99.9) { allocTarget = id; break; }
}
check('found a policy with unallocated room', allocTarget !== null);
// Allocate somebody the manager can actually reach: naming an investor is
// scoped now, so an arbitrary id would be refused for the right reason and
// prove nothing about allocation itself.
const reachable = await json(await api(pm1, '/investors'));
check('the manager has at least one investor to allocate', reachable.length >= 1,
  `${reachable.length} visible`);
const allocInvestor = reachable[0].id;
// Clear any allocation left by an earlier run so this is repeatable, which also
// exercises the manager's ability to remove one.
const existing = (await json(await api(pm1, `/policies/${allocTarget}`))).owners
  .find((o) => o.investor_id === allocInvestor);
if (existing) {
  const del = await api(pm1, `/policy-investors/${existing.id}`, { method: 'DELETE' });
  check('can remove an allocation in their entity', del.status === 200, `status ${del.status}`);
}
const alloc = await api(pm1, `/policies/${allocTarget}/investors`, {
  method: 'POST', body: JSON.stringify({ investor_id: allocInvestor, pct: 10 }) });
check('can allocate an investor', alloc.status === 201, `status ${alloc.status}`);
const over = await api(pm1, `/policies/${allocTarget}/investors`, {
  method: 'POST', body: JSON.stringify({ investor_id: reachable[0].id, pct: 95 }) });
check('over-allocation still refused', over.status === 400, `status ${over.status}`);

console.log('\nWRITE ATTEMPTS OUTSIDE THEIR ENTITIES');
const foreign = outside[0].id;
for (const [method, path, body] of [
  ['PUT',    `/policies/${foreign}`, '{"notes":"nope"}'],
  ['DELETE', `/policies/${foreign}`, `{"confirm":"${outside[0].policy_number}"}`],
  ['POST',   `/policies/${foreign}/values`, '{"as_of_date":"2026-09-30"}'],
  ['POST',   `/policies/${foreign}/transactions`, '{"txn_date":"2026-09-30","txn_type":"Fee","amount":1}'],
  ['POST',   `/policies/${foreign}/investors`, '{"investor_id":1,"pct":1}'],
]) {
  const r = await api(pm1, path, { method, body });
  check(`${method} on a foreign policy rejected`, r.status === 404, `status ${r.status}`);
}

// creating a policy into someone else's entity
const lcg2 = (await json(await api(staff, '/funds'))).find((f) => f.code === 'LCG2');
const crossCreate = await api(pm1, '/policies', {
  method: 'POST',
  body: JSON.stringify({ policy_number: 'X-CROSS-1', carrier_name: 'Test Co',
    insured_last_name: 'Cross', fund_code: 'LCG2' }),
});
check('cannot create a policy in another entity', crossCreate.status === 403, `status ${crossCreate.status}`);

// moving one of their own policies out of scope
const move = await api(pm1, `/policies/${own}`, {
  method: 'PUT', body: JSON.stringify({ fund_code: 'LCG2' }) });
check('cannot move a policy to another entity', move.status === 403, `status ${move.status}`);

console.log('\nSETTINGS SURFACE IS CLOSED');
for (const [method, path] of [
  ['GET',  '/users'],
  ['POST', '/users'],
  ['GET',  '/audit'],
  ['POST', '/funds'],
  ['PUT',  '/funds/1'],
  ['DELETE', '/funds/1'],
  ['DELETE', '/investors/1'],
]) {
  const r = await api(pm1, path, { method, body: /POST|PUT/.test(method) ? '{}' : undefined });
  check(`${method} ${path} rejected`, r.status === 403, `status ${r.status}`);
}

console.log('\nINVESTOR DIRECTORY IS SCOPED, NOT BLOCKED');
const invAll = await json(await api(staff, '/investors'));
const inv1 = await json(await api(pm1, '/investors'));
check('manager can read investors', Array.isArray(inv1) && inv1.length > 0, `${inv1.length}`);
check('only investors holding positions in their entities', inv1.length < invAll.length,
  `${inv1.length} of ${invAll.length}`);
const hiddenInvestor = invAll.find((i) => !inv1.some((j) => j.id === i.id));
if (hiddenInvestor) {
  const r = await api(pm1, `/investors/${hiddenInvestor.id}`);
  check('cannot open an out-of-scope investor', r.status === 404, `status ${r.status}`);
}

console.log('\nIMPORT IS CONFINED TO THEIR ENTITIES');
const csv = 'Policy Number,Last Name,Carrier Name,Basic Face,Owner\nZZ-9001,Testcase,Test Carrier,1000000,LCG2\n';
const fd = new FormData();
fd.append('file', new Blob([csv], { type: 'text/csv' }), 'x.csv');
fd.append('type', 'policies');
const imp = await fetch(`${BASE}/api/import/run`, { method: 'POST', headers: { Cookie: pm1 }, body: fd });
const impResult = await json(imp);
check('import into a foreign entity is refused per row',
  impResult.created === 0 && impResult.errors.length === 1,
  JSON.stringify(impResult.errors?.[0]?.message || impResult));

const csvOwn = 'Policy Number,Last Name,Carrier Name,Basic Face,Owner\nZZ-9002,Testcase,Test Carrier,1000000,LCG1\n';
const fd2 = new FormData();
fd2.append('file', new Blob([csvOwn], { type: 'text/csv' }), 'y.csv');
fd2.append('type', 'policies');
const imp2 = await json(await fetch(`${BASE}/api/import/run`, { method: 'POST', headers: { Cookie: pm1 }, body: fd2 }));
// created on the first run, updated on re-runs — either proves it was accepted
check('import into their own entity succeeds',
  (imp2.created + imp2.updated) === 1 && imp2.errors.length === 0, JSON.stringify(imp2));

console.log('\nA NEW CLIENT FILED UNDER THE MANAGER\'S OWN ENTITY');
/* The directory admits an investor on three grounds: filed under one of the
   manager's entities, granted by name, or already holding a position inside
   one of their entities. Naming one has to admit exactly the same three —
   it once left out the first, which is the commonest of the three and the
   only one that applies to a brand-new client who holds nothing yet. The
   result was a dropdown that offered the name and a Save that refused it. */
const lcg1 = (await json(await api(pm1, '/funds')))[0];
const fresh = await json(await api(staff, '/investors', { method: 'POST', body: JSON.stringify({
  name: 'MGRSCOPE New Client', investor_type: 'Individual', fund_id: lcg1.id }) }));
check('an admin files a new investor under the manager\'s entity', !!fresh?.id,
  JSON.stringify(fresh).slice(0, 100));
check('they hold nothing yet',
  ((await json(await api(staff, `/investors/${fresh.id}`))).positions || []).length === 0);

const dir = await json(await api(pm1, '/investors'));
check('the manager sees them in the directory', dir.some((i) => i.id === fresh.id),
  `${dir.length} investors visible`);
check('and can open the record',
  (await api(pm1, `/investors/${fresh.id}`)).status === 200);

let freshRoom = null;
for (const p of await json(await api(pm1, '/policies'))) {
  const d = await json(await api(pm1, `/policies/${p.id}`));
  const used = (d.owners || []).reduce((sum, o) => sum + Number(o.pct), 0);
  if (used < 98) { freshRoom = p; break; }
}
check('there is a policy of theirs with room in it', !!freshRoom);
const firstAlloc = await api(pm1, `/policies/${freshRoom.id}/investors`, {
  method: 'POST', body: JSON.stringify({ investor_id: fresh.id, pct: 1 }) });
check('and can allocate a piece of a policy to them — what the directory offers, the save accepts',
  firstAlloc.status === 201, `status ${firstAlloc.status} ${
    firstAlloc.status !== 201 ? JSON.stringify(await json(firstAlloc)) : ''}`);
if (firstAlloc.status === 201) {
  const made = await json(firstAlloc);
  await api(pm1, `/policy-investors/${made.id}`, { method: 'DELETE' });
}
await api(staff, `/investors/${fresh.id}`, { method: 'DELETE',
  body: JSON.stringify({ confirm: 'MGRSCOPE New Client' }) });

console.log('\nAN ADMIN CAN PUT AN INVESTOR IN A MANAGER\'S HANDS');
/* The entity scope answers "whose money is already in my book". It cannot
   answer "who may I take this new deal to" — and a manager who cannot reach
   an existing client will simply key in a second copy of them. So an admin
   grants the relationship explicitly, and that grant widens the directory
   without opening up holdings. */
const allInvestors = await json(await api(staff, '/investors'));
const pmSeesBefore = await json(await api(pm1, '/investors'));
const stranger = allInvestors.find((i) => !pmSeesBefore.some((x) => x.id === i.id));
check('there is an investor this manager cannot currently reach', !!stranger,
  `${pmSeesBefore.length} of ${allInvestors.length} visible`);

const users = await json(await api(staff, '/users'));
const pm1User = users.find((u) => u.email === MANAGER1.email);
check('the users list reports what a manager has been granted',
  Array.isArray(pm1User?.granted_investor_ids), JSON.stringify(pm1User?.granted_investor_ids));

check('before the grant, the manager cannot open them',
  (await api(pm1, `/investors/${stranger.id}`)).status === 404);

const grant = await api(staff, `/users/${pm1User.id}`, { method: 'PUT', body: JSON.stringify({
  full_name: pm1User.full_name, role: 'manager', is_active: true,
  fund_ids: pm1User.fund_ids, investor_ids: [stranger.id] }) });
check('an admin can grant one', grant.status === 200, `status ${grant.status}`);

const pmSeesAfter = await json(await api(pm1, '/investors'));
check('the granted investor is now in the manager\'s directory',
  pmSeesAfter.some((x) => x.id === stranger.id),
  `${pmSeesBefore.length} → ${pmSeesAfter.length}`);
check('and they can open the record', (await api(pm1, `/investors/${stranger.id}`)).status === 200);

const strangerDetail = await json(await api(pm1, `/investors/${stranger.id}`));
check('but it shows no positions from outside their entities',
  (strangerDetail.positions || []).every((p) => p.fund_code === 'LCG1'),
  (strangerDetail.positions || []).map((p) => p.fund_code).join(',') || 'none');
check('and still no login details', (strangerDetail.logins || []).length === 0);
check('the grant did not widen the policy list',
  (await json(await api(pm1, '/policies'))).every((p) => p.fund_code === 'LCG1'));

console.log('\nNAMING AN INVESTOR IS SCOPED TOO, NOT JUST READING ONE');
const outsider = allInvestors.find((i) =>
  i.id !== stranger.id && !pmSeesBefore.some((x) => x.id === i.id));
if (outsider) {
  let room = null;
  for (const p of await json(await api(pm1, '/policies'))) {
    const d = await json(await api(pm1, `/policies/${p.id}`));
    const used = (d.owners || []).reduce((sum, o) => sum + Number(o.pct), 0);
    if (used < 98 && !(d.owners || []).some((o) => o.investor_id === stranger.id)) { room = p; break; }
  }
  check('there is a policy with room to allocate into', !!room);
  const sneak = await api(pm1, `/policies/${room.id}/investors`, {
    method: 'POST', body: JSON.stringify({ investor_id: outsider.id, pct: 1 }) });
  check('a manager cannot allocate to an investor who is not theirs',
    sneak.status === 403, `status ${sneak.status}`);
  const allowed = await api(pm1, `/policies/${room.id}/investors`, {
    method: 'POST', body: JSON.stringify({ investor_id: stranger.id, pct: 1 }) });
  check('but can allocate to the one they were granted',
    [201, 409].includes(allowed.status), `status ${allowed.status}`);
  if (allowed.status === 201) {
    const made = await json(allowed);
    await api(pm1, `/policy-investors/${made.id}`, { method: 'DELETE' });
  }
} else {
  check('there is a policy with room to allocate into', true, 'skipped');
  check('a manager cannot allocate to an investor who is not theirs', true, 'no outsider to test with');
  check('but can allocate to the one they were granted', true, 'skipped');
}

// Put it back the way it was found.
await api(staff, `/users/${pm1User.id}`, { method: 'PUT', body: JSON.stringify({
  full_name: pm1User.full_name, role: 'manager', is_active: true,
  fund_ids: pm1User.fund_ids, investor_ids: pm1User.granted_investor_ids || [] }) });
check('revoking it takes the investor away again',
  !((await json(await api(pm1, '/investors'))) || []).some((x) => x.id === stranger.id));

console.log('\nINVESTORS ARE STILL LOCKED OUT OF MANAGER ROUTES');
const harrison = await login(INVESTOR1.email, INVESTOR1.password);
for (const path of ['/funds', '/investors', '/users']) {
  const r = await api(harrison, path);
  check(`investor GET ${path} rejected`, r.status === 403, `status ${r.status}`);
}

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL MANAGER SECURITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
