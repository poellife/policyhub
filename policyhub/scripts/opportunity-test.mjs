/* =====================================================================
   Opportunities.

   Three things have to hold or this feature is dangerous rather than
   useful: an investor must never see an offer that was not shared with
   them, must never learn who else is in, and two investors racing for
   the last slice must not between them take more than 100%.

   The rest is arithmetic — that the scarcity figure is honest, that a
   declined request releases what it held, and that the LE scenarios say
   what they claim.

   Idempotent: fixtures use a fixed prefix and are removed first.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, MANAGER2, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'OPPT';
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

const investors = await json(await api(admin, '/investors'));
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');
const lcg2 = funds.find((f) => f.code === 'LCG2');
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const make = async (suffix, body = {}, who = admin) => json(await api(who, '/opportunities', {
  method: 'POST',
  body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Offer Life', product_type: 'UL',
    face_amount: 2000000, insured_last_name: 'Offerman', insured_first_name: 'Ida',
    insured_dob: '1943-02-11', insured_gender: 'F', insured_state: 'FL',
    le_months: 84, le_provider: 'ITM21st', le_date: '2026-01-15',
    asking_price: 520000, annual_premium: 46000,
    expected_close: '2026-09-30', offer_closes_on: '2027-06-30',
    fund_id: lcg1.id, ...body },
}));

/* ------------------------------------------------------------------ *
 * Who can see what
 * ------------------------------------------------------------------ */
console.log('AN INVESTOR SEES ONLY WHAT WAS SHARED');
const o1 = await make('1');
check('a manager-or-above can create one', o1?.id > 0);
check('an investor cannot create one',
  (await api(inv1, '/opportunities', { method: 'POST', body: { insured_last_name: 'X' } })).status === 403);

check('before sharing, no investor sees it',
  !((await json(await api(inv1, '/opportunities'))) || []).some((x) => x.id === o1.id));
check('and opening it directly is a 404, not a 403',
  (await api(inv1, `/opportunities/${o1.id}`)).status === 404);

await api(admin, `/opportunities/${o1.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
check('once shared, the chosen investor sees it',
  ((await json(await api(inv1, '/opportunities'))) || []).some((x) => x.id === o1.id));
check('but the one it was not shared with does not',
  !((await json(await api(inv2, '/opportunities'))) || []).some((x) => x.id === o1.id));
check('and still cannot open it', (await api(inv2, `/opportunities/${o1.id}`)).status === 404);

console.log('\nTHE BADGE COUNTS WHAT IS WAITING');
const sum1 = await json(await api(inv1, '/opportunities/summary'));
check('the investor has one undecided offer', sum1.undecided >= 1, JSON.stringify(sum1));
const sum2 = await json(await api(inv2, '/opportunities/summary'));
check('the other investor has fewer', sum2.undecided < sum1.undecided,
  `${sum2.undecided} vs ${sum1.undecided}`);

/* ------------------------------------------------------------------ *
 * Taking a share
 * ------------------------------------------------------------------ */
console.log('\nTAKING A SHARE');
await api(admin, `/opportunities/${o1.id}/shares`, { method: 'PUT', body: { investor_ids: [me1, me2] } });
const before = await json(await api(inv1, `/opportunities/${o1.id}`));
check('it starts fully available', near(before.remaining_pct, 100), String(before.remaining_pct));

const take = await api(inv1, `/opportunities/${o1.id}/commit`, { method: 'POST', body: { pct: 65 } });
check('an investor can request a percentage', take.status === 201, `status ${take.status}`);

const seenBy2 = await json(await api(inv2, `/opportunities/${o1.id}`));
check('the remainder drops for everybody else at once', near(seenBy2.remaining_pct, 35),
  String(seenBy2.remaining_pct));
check('a request counts against availability before it is confirmed',
  near(seenBy2.taken_pct, 65) && near(seenBy2.confirmed_pct, 0));

console.log('\nNOBODY LEARNS WHO ELSE IS IN');
check('the other investor sees no co-investor rows',
  Array.isArray(seenBy2.commitments) && seenBy2.commitments.length === 0,
  JSON.stringify(seenBy2.commitments));
check('and no share list at all', seenBy2.shares === undefined);
const leak = JSON.stringify(seenBy2);
check('no investor name appears anywhere in the payload',
  !investors.some((i) => i.id !== me2 && leak.includes(i.name)),
  investors.filter((i) => i.id !== me2 && leak.includes(i.name)).map((i) => i.name).join(','));
check('the list view leaks nothing either',
  !((await json(await api(inv2, '/opportunities'))) || []).some((x) => x.shared_with !== undefined));
check('while staff do see the whole cap table',
  (await json(await api(admin, `/opportunities/${o1.id}`))).commitments.length === 1);

console.log('\nOVER-SUBSCRIPTION IS REFUSED');
const over = await api(inv2, `/opportunities/${o1.id}/commit`, { method: 'POST', body: { pct: 50 } });
check('asking for more than remains is refused', over.status === 409, `status ${over.status}`);
const overBody = await json(over);
check('and the message says how much is left', /35%/.test(overBody.error), overBody.error);
check('the refusal reports the remainder as data too', near(overBody.remaining_pct, 35));
check('nothing was written', near((await json(await api(admin, `/opportunities/${o1.id}`))).taken_pct, 65));

const exact = await api(inv2, `/opportunities/${o1.id}/commit`, { method: 'POST', body: { pct: 35 } });
check('taking exactly the remainder works', exact.status === 201, `status ${exact.status}`);
check('now nothing is left',
  near((await json(await api(inv1, `/opportunities/${o1.id}`))).remaining_pct, 0));

console.log('\nTWO INVESTORS RACING FOR THE LAST SLICE');
const o2 = await make('2');
await api(admin, `/opportunities/${o2.id}/shares`, { method: 'PUT', body: { investor_ids: [me1, me2] } });
// Both fire at once for 60% of the same 100%. Exactly one may win.
const [r1, r2] = await Promise.all([
  api(inv1, `/opportunities/${o2.id}/commit`, { method: 'POST', body: { pct: 60 } }),
  api(inv2, `/opportunities/${o2.id}/commit`, { method: 'POST', body: { pct: 60 } }),
]);
const wins = [r1.status, r2.status].filter((s) => s === 201).length;
check('exactly one of two simultaneous requests succeeds', wins === 1, `${r1.status} / ${r2.status}`);
const raced = await json(await api(admin, `/opportunities/${o2.id}`));
check('and the total never exceeds 100%', Number(raced.taken_pct) <= 100, String(raced.taken_pct));

console.log('\nDECIDING A REQUEST');
const commit1 = (await json(await api(admin, `/opportunities/${o1.id}`)))
  .commitments.find((c) => c.investor_id === me1);
check('a manager can confirm',
  (await api(admin, `/opportunity-commitments/${commit1.id}`,
    { method: 'PUT', body: { status: 'Confirmed' } })).status === 200);
const afterConfirm = await json(await api(admin, `/opportunities/${o1.id}`));
check('confirmed is counted separately from requested',
  near(afterConfirm.confirmed_pct, 65) && near(afterConfirm.taken_pct, 100));

const commit2 = afterConfirm.commitments.find((c) => c.investor_id === me2);
check('declining releases the percentage',
  (await api(admin, `/opportunity-commitments/${commit2.id}`,
    { method: 'PUT', body: { status: 'Declined' } })).status === 200);
const afterDecline = await json(await api(admin, `/opportunities/${o1.id}`));
check('so it becomes available again', near(afterDecline.remaining_pct, 35),
  String(afterDecline.remaining_pct));
check('an investor cannot decide their own request',
  (await api(inv1, `/opportunity-commitments/${commit1.id}`,
    { method: 'PUT', body: { status: 'Confirmed' } })).status === 403);
check('nor an arbitrary decision value',
  (await api(admin, `/opportunity-commitments/${commit1.id}`,
    { method: 'PUT', body: { status: 'Whatever' } })).status === 400);

console.log('\nWITHDRAWING');
const o3 = await make('3');
await api(admin, `/opportunities/${o3.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
await api(inv1, `/opportunities/${o3.id}/commit`, { method: 'POST', body: { pct: 40 } });
check('an investor can withdraw before a decision',
  (await api(inv1, `/opportunities/${o3.id}/commit`, { method: 'DELETE' })).status === 200);
check('and the percentage is released',
  near((await json(await api(admin, `/opportunities/${o3.id}`))).remaining_pct, 100));
await api(inv1, `/opportunities/${o3.id}/commit`, { method: 'POST', body: { pct: 40 } });
const c3 = (await json(await api(admin, `/opportunities/${o3.id}`))).commitments[0];
await api(admin, `/opportunity-commitments/${c3.id}`, { method: 'PUT', body: { status: 'Confirmed' } });
check('but not after it is confirmed',
  (await api(inv1, `/opportunities/${o3.id}/commit`, { method: 'DELETE' })).status === 409);
check('and they cannot be un-shared while holding it',
  (await api(admin, `/opportunities/${o3.id}/shares`,
    { method: 'PUT', body: { investor_ids: [] } })).status === 400);

console.log('\nCLOSED OFFERS TAKE NOTHING');
const o4 = await make('4', { offer_closes_on: '2020-01-01' });
await api(admin, `/opportunities/${o4.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
const late = await api(inv1, `/opportunities/${o4.id}/commit`, { method: 'POST', body: { pct: 10 } });
check('a passed deadline is refused', late.status === 409, `status ${late.status}`);
check('with a reason', /closed/i.test((await json(late))?.error || ''));

const o5 = await make('5', { status: 'Closed' });
await api(admin, `/opportunities/${o5.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
check('a closed opportunity is not listed for investors',
  !((await json(await api(inv1, '/opportunities'))) || []).some((x) => x.id === o5.id));

/* ------------------------------------------------------------------ *
 * The analysis
 * ------------------------------------------------------------------ */
console.log('\nTHE LE SCENARIOS');
const o6 = await make('6');
await api(admin, `/opportunities/${o6.id}/premium-schedule`, { method: 'POST', body: {
  start_date: '2026-10-15', amount: 46000, years: 12, growth_pct: 5, replace: true } });
const an = (await json(await api(admin, `/opportunities/${o6.id}`))).analysis;
check('three scenarios are returned', an.scenarios.length === 3,
  an.scenarios.map((s) => s.offset_months).join(','));
check('centred on life expectancy',
  an.scenarios.map((s) => s.offset_months).join(',') === '-24,0,24');
check('a longer life means a later maturity',
  an.scenarios[0].matures_on < an.scenarios[1].matures_on
  && an.scenarios[1].matures_on < an.scenarios[2].matures_on,
  an.scenarios.map((s) => s.matures_on).join(' < '));
check('and more premiums paid',
  an.scenarios[0].premiums_paid < an.scenarios[1].premiums_paid
  && an.scenarios[1].premiums_paid < an.scenarios[2].premiums_paid);
check('so a lower return — which is the whole point',
  an.scenarios[0].irr > an.scenarios[1].irr && an.scenarios[1].irr > an.scenarios[2].irr,
  an.scenarios.map((s) => `${(s.irr * 100).toFixed(2)}%`).join(' > '));
check('life expectancy runs from the LE report date, not today',
  an.le_from === '2026-01-15', an.le_from);
check('84 months from that date is the base maturity',
  an.base.matures_on === '2033-01-15', an.base.matures_on);
check('the purchase price is counted as invested',
  Number(an.base.invested) > 520000, String(an.base.invested));
check('and the death benefit as returned', near(an.base.returned, 2000000));

const listed = ((await json(await api(admin, '/opportunities'))) || []).find((x) => x.id === o6.id);
check('the list and the detail agree on the rate', near(listed.irr_at_le, an.base.irr, 1e-9),
  `${listed.irr_at_le} vs ${an.base.irr}`);

const unpriced = await make('7', { asking_price: null, face_amount: null });
const unan = (await json(await api(admin, `/opportunities/${unpriced.id}`))).analysis;
check('an unpriced opportunity reports no scenarios rather than a made-up rate',
  unan.priced === false && unan.scenarios.length === 0);

console.log('\nA MANAGER IS CONFINED TO THEIR ENTITIES');
const foreign = await make('8', { fund_id: lcg2.id });
check('a manager does not see another entity\'s opportunity',
  !((await json(await api(pm1, '/opportunities'))) || []).some((x) => x.id === foreign.id));
check('and cannot open it', (await api(pm1, `/opportunities/${foreign.id}`)).status === 404);
check('nor create one there',
  (await api(pm1, '/opportunities', { method: 'POST', body: {
    insured_last_name: 'Nope', fund_id: lcg2.id } })).status === 403);
const own = await make('9', { fund_id: lcg1.id }, pm1);
check('but can create one in their own', own?.id > 0);
check('and see it', ((await json(await api(pm1, '/opportunities'))) || []).some((x) => x.id === own.id));

console.log('\nFUNDING IT');
const o10 = await make('10');
await api(admin, `/opportunities/${o10.id}/shares`, { method: 'PUT', body: { investor_ids: [me1, me2] } });
await api(inv1, `/opportunities/${o10.id}/commit`, { method: 'POST', body: { pct: 55 } });
await api(inv2, `/opportunities/${o10.id}/commit`, { method: 'POST', body: { pct: 20 } });
const cs = (await json(await api(admin, `/opportunities/${o10.id}`))).commitments;
await api(admin, `/opportunity-commitments/${cs[0].id}`, { method: 'PUT', body: { status: 'Confirmed' } });
const funded = await api(admin, `/opportunities/${o10.id}/fund`, { method: 'POST',
  body: { acquisition_date: '2026-09-30' } });
check('funding creates the policy', funded.status === 201, `status ${funded.status}`);
const { policy_id: newPolicyId, allocations } = await json(funded);
check('only confirmed allocations are carried over', allocations === 1, `${allocations}`);

const pol = await json(await api(admin, `/policies/${newPolicyId}`));
check('the policy carries the deal terms',
  pol.policy_number === `${PREFIX}-10` && Number(pol.face_amount) === 2000000);
check('the purchase price is in the ledger',
  pol.transactions.some((t) => t.txn_type === 'Acquisition Cost' && Number(t.amount) === 520000));
check('and the cap table matches the confirmed share',
  pol.owners.length === 1 && near(pol.owners[0].pct, 55),
  JSON.stringify(pol.owners.map((o) => `${o.name} ${o.pct}`)));
const oppAfter = await json(await api(admin, `/opportunities/${o10.id}`));
check('the opportunity is marked funded and linked', oppAfter.status === 'Funded'
  && oppAfter.policy_id === newPolicyId);
check('funding twice is refused',
  (await api(admin, `/opportunities/${o10.id}/fund`, { method: 'POST' })).status === 409);
check('an editor cannot fund',
  (await api(inv1, `/opportunities/${o10.id}/fund`, { method: 'POST' })).status === 403);

await api(admin, `/policies/${newPolicyId}`, { method: 'DELETE', body: { confirm: `${PREFIX}-10` } });

console.log('\nUNAUTHENTICATED');
for (const path of ['/opportunities', '/opportunities/summary', `/opportunities/${o1.id}`])
  check(`GET ${path} needs a session`, (await fetch(`${BASE}/api${path}`)).status === 401);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL OPPORTUNITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
