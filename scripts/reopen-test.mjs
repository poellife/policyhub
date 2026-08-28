/* =====================================================================
   Sending a funded deal back to the list.

   A deal is marked funded and then comes apart — an investor who had
   confirmed backs out before the money moves. The policy that funding
   created has to come off the books and the piece that investor was
   holding has to go back in front of everybody else.

   What has to hold:

     - the investors who stay keep their positions, at the same
       percentages, untouched;
     - the one who leaves is Withdrawn, and their share reads as
       available again — not merely absent;
     - the policy funding CREATED is deleted with its acquisition cost;
     - a policy funding merely ADOPTED is left alone. It was on the books
       before the deal and is not the deal's to destroy;
     - a policy that has picked up work since funding will not go without
       the policy number typed;
     - an investor cannot do any of it, and a manager cannot do it to
       somebody else's entity.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'REOPEN';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) < tol;

const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);

const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];
const other = funds.find((f) => f.id !== lcg1.id) || null;
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const make = async (suffix, body = {}) => json(await api(admin, '/opportunities', {
  method: 'POST',
  body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Reopen Life', product_type: 'UL',
    face_amount: 3000000, insured_last_name: 'Backout', insured_first_name: 'Bram',
    insured_dob: '1944-06-02', insured_gender: 'M', insured_state: 'MI',
    le_months: 78, le_provider: 'ITM21st', le_date: '2026-02-01',
    asking_price: 610000, annual_premium: 52000,
    expected_close: '2026-09-30', offer_closes_on: '2027-06-30',
    fund_id: lcg1.id, ...body },
}));

/** Share with both fixture investors, take `a`% and `b`%, confirm both. */
const stock = async (o, a, b) => {
  await api(admin, `/opportunities/${o.id}/shares`, {
    method: 'PUT', body: { investor_ids: [me1, me2] } });
  await api(inv1, `/opportunities/${o.id}/commit`, { method: 'POST', body: { pct: a } });
  await api(inv2, `/opportunities/${o.id}/commit`, { method: 'POST', body: { pct: b } });
  const full = await json(await api(admin, `/opportunities/${o.id}`));
  for (const c of full.commitments)
    await api(admin, `/opportunity-commitments/${c.id}`, {
      method: 'PUT', body: { status: 'Confirmed' } });
  return json(await api(admin, `/opportunities/${o.id}`));
};

/* ------------------------------------------------------------------ *
 * The ordinary case: one of two investors backs out
 * ------------------------------------------------------------------ */
console.log('AN INVESTOR BACKS OUT OF A FUNDED DEAL');
const o1 = await make('1');
const s1 = await stock(o1, 60, 25);
check('two investors hold 85% between them', near(s1.taken_pct, 85), String(s1.taken_pct));

const funded = await json(await api(admin, `/opportunities/${o1.id}/fund`, { method: 'POST' }));
check('funding creates the policy', funded?.policy_id > 0, JSON.stringify(funded));
check('and writes both allocations', funded.allocations === 2, String(funded.allocations));
const policyId = funded.policy_id;

const chk = await json(await api(admin, `/opportunities/${o1.id}/reopen-check`));
check('the check says it can be sent back', chk.can_reopen === true);
check('and that doing so unwinds the policy it created', chk.unwinds_policy === true);
check('with nothing to lose, no typed confirmation is demanded',
  chk.needs_confirm === false, JSON.stringify(chk.losses));

const back = await json(await api(admin, `/opportunities/${o1.id}/reopen`, {
  method: 'POST', body: { backing_out: [me2] } }));
check('sending it back reports the withdrawal', back.withdrew === 1, JSON.stringify(back));
check('and names what was released', near(back.freed_pct, 25), String(back.freed_pct));
check('leaving 40% available — the 15% never taken plus the 25% given up',
  near(back.remaining_pct, 40), String(back.remaining_pct));
check('the policy was unwound', back.unwound === true);

const after = await json(await api(admin, `/opportunities/${o1.id}`));
check('the opportunity is Open again', after.status === 'Open', after.status);
check('and no longer claims a policy', !after.policy_id, String(after.policy_id));
check('the investor who stayed is still Confirmed at the same percentage',
  after.commitments.some((c) => c.investor_id === me1 && c.status === 'Confirmed'
    && near(c.pct, 60)),
  JSON.stringify(after.commitments.map((c) => [c.investor_id, c.status, c.pct])));
check('the one who left is Withdrawn',
  after.commitments.some((c) => c.investor_id === me2 && c.status === 'Withdrawn'));
check('and the taken figure counts only the investor who stayed',
  near(after.taken_pct, 60), String(after.taken_pct));

check('the policy is gone from the portfolio',
  (await api(admin, `/policies/${policyId}`)).status === 404);
check('and so is the acquisition cost that came with it',
  !((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
    .some((p) => p.id === policyId));

console.log('\nIT GOES BACK IN FRONT OF THE INVESTOR WHO IS STILL LOOKING');
check('the investor who stayed still sees it',
  ((await json(await api(inv1, '/opportunities'))) || []).some((x) => x.id === o1.id));
const seen2 = ((await json(await api(inv2, '/opportunities'))) || []).find((x) => x.id === o1.id);
check('and so does the one who pulled out — it is on offer again, not hidden',
  !!seen2, 'not visible');
check('who can ask for a piece a second time',
  (await api(inv2, `/opportunities/${o1.id}/commit`, {
    method: 'POST', body: { pct: 10 } })).ok);
const retaken = await json(await api(admin, `/opportunities/${o1.id}`));
check('which is held against the freed share, not on top of it',
  near(retaken.taken_pct, 70), String(retaken.taken_pct));

/* ------------------------------------------------------------------ *
 * A policy that has been worked on since it was funded
 * ------------------------------------------------------------------ */
console.log('\nA POLICY WITH WORK ON IT WILL NOT GO QUIETLY');
const o2 = await make('2');
await stock(o2, 50, 30);
const f2 = await json(await api(admin, `/opportunities/${o2.id}/fund`, { method: 'POST' }));
const paid = await api(admin, `/policies/${f2.policy_id}/transactions`, { method: 'POST', body: {
  txn_date: '2026-07-01', txn_type: 'Premium',
  amount: 13500, remarks: `${PREFIX} premium paid after funding` } });
check('a premium is recorded against the funded policy', paid.ok,
  JSON.stringify(await json(paid.clone())));

const chk2 = await json(await api(admin, `/opportunities/${o2.id}/reopen-check`));
check('the check notices the later work', chk2.transactions_since >= 1,
  String(chk2.transactions_since));
check('and demands the policy number', chk2.needs_confirm === true);
check('naming what would be destroyed', (chk2.losses || []).length > 0,
  (chk2.losses || []).join(', '));

const refused = await api(admin, `/opportunities/${o2.id}/reopen`, {
  method: 'POST', body: { backing_out: [me2] } });
check('without it the request is refused', refused.status === 409, String(refused.status));
const stillFunded = await json(await api(admin, `/opportunities/${o2.id}`));
check('and nothing moved — it is still funded', stillFunded.status === 'Funded');
check('with both investors still confirmed',
  stillFunded.commitments.filter((c) => c.status === 'Confirmed').length === 2);

const wrong = await api(admin, `/opportunities/${o2.id}/reopen`, {
  method: 'POST', body: { backing_out: [me2], confirm: 'not-the-number' } });
check('the wrong number is refused too', wrong.status === 409);

const forced = await json(await api(admin, `/opportunities/${o2.id}/reopen`, {
  method: 'POST', body: { backing_out: [me2], confirm: `${PREFIX}-2` } }));
check('the right one goes through', forced.ok === true, JSON.stringify(forced));
check('and says what it destroyed', (forced.destroyed || []).length > 0,
  (forced.destroyed || []).join(', '));
check('the policy is gone', (await api(admin, `/policies/${f2.policy_id}`)).status === 404);

/* ------------------------------------------------------------------ *
 * A policy that was adopted rather than created
 * ------------------------------------------------------------------ */
console.log('\nA POLICY THAT WAS ALREADY ON THE BOOKS IS NOT THE DEAL’S TO DELETE');
const owned = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-3`, carrier_name: 'Reopen Life', face_amount: 1500000,
  fund_id: lcg1.id, status: 'Inforce', insured_last_name: 'Priorly', insured_first_name: 'Pat',
  acquisition_date: '2025-01-15', acquisition_cost: 300000 } }));
check('a policy exists before any opportunity names it', owned?.id > 0);
const o3 = await make('3');
await stock(o3, 40, 20);
const f3 = await json(await api(admin, `/opportunities/${o3.id}/fund`, {
  method: 'POST', body: { link: true } }));
check('funding links to it rather than creating a second', f3.linked === true,
  JSON.stringify(f3));
check('against the policy that was already there', f3.policy_id === owned.id);

const chk3 = await json(await api(admin, `/opportunities/${o3.id}/reopen-check`));
check('the check says this one does NOT unwind the policy',
  chk3.unwinds_policy === false, JSON.stringify(chk3.unwinds_policy));
const back3 = await json(await api(admin, `/opportunities/${o3.id}/reopen`, {
  method: 'POST', body: { backing_out: [me2] } }));
check('it still goes back to the list', back3.ok === true);
check('reporting that the policy was kept', back3.policy_kept === true);
check('and the policy is still there',
  (await api(admin, `/policies/${owned.id}`)).status === 200);

/* ------------------------------------------------------------------ *
 * Who may do it
 * ------------------------------------------------------------------ */
console.log('\nWHO MAY SEND ONE BACK');
const o4 = await make('4');
await stock(o4, 30, 30);
const f4 = await json(await api(admin, `/opportunities/${o4.id}/fund`, { method: 'POST' }));
check('an investor cannot',
  (await api(inv1, `/opportunities/${o4.id}/reopen`, { method: 'POST', body: {} })).status === 403);
check('and cannot even ask what it would cost',
  (await api(inv1, `/opportunities/${o4.id}/reopen-check`)).status === 403);

if (other) {
  const foreign = await make('5', { fund_id: other.id });
  const st = (await api(pm1, `/opportunities/${foreign.id}/reopen`,
    { method: 'POST', body: {} })).status;
  check('a manager cannot reach into another entity', [403, 404].includes(st), String(st));
} else {
  check('the fixture has only one entity, so cross-entity reach is untested', true, 'skipped');
}

check('an opportunity that was never funded cannot be sent back',
  (await api(admin, `/opportunities/${o1.id}/reopen`, { method: 'POST', body: {} })).status === 409);
check('and an investor with no live commitment cannot be named as backing out',
  (await api(admin, `/opportunities/${o4.id}/reopen`, {
    method: 'POST', body: { backing_out: [999999] } })).status === 400);

console.log('\nNOBODY HAS TO BE BACKING OUT');
const plain = await json(await api(admin, `/opportunities/${o4.id}/reopen`, {
  method: 'POST', body: {} }));
check('a funded deal can go back with everybody still in', plain.ok === true);
check('nobody was withdrawn', plain.withdrew === 0, String(plain.withdrew));
const o4after = await json(await api(admin, `/opportunities/${o4.id}`));
check('and both investors keep their confirmed positions',
  o4after.commitments.filter((c) => c.status === 'Confirmed').length === 2);
check('so the remaining figure is unchanged', near(o4after.taken_pct, 60),
  String(o4after.taken_pct));

/* ------------------------------------------------------------------ *
 * The audit trail
 * ------------------------------------------------------------------ */
console.log('\nIT IS ON THE RECORD');
const log = (await json(await api(admin, '/audit'))) || [];
check('the audit log carries the reversal',
  log.some((r) => /sent back to the list/i.test(String(r.detail || ''))),
  log.slice(0, 3).map((r) => r.detail).join(' | '));

await wipe();
console.log(fails.length
  ? `\n${fails.length} REOPEN CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL REOPEN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
