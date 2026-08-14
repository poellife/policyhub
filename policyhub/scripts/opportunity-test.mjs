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
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

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

/* ------------------------------------------------------------------ *
 * The schedule entered a year at a time
 *
 * A carrier illustration steps up unevenly, so what is typed has to be
 * stored exactly — no rounding, no interpolation, and no partial write
 * if one row is wrong.
 * ------------------------------------------------------------------ */
console.log('\nA SCHEDULE TYPED YEAR BY YEAR');
const o9 = await make('9');
const byHand = [
  { due_date: '2026-10-01', amount: 41250.75, notes: 'quoted' },
  { due_date: '2027-10-01', amount: 44800 },
  { due_date: '2028-10-01', amount: 0 },
  { due_date: '2029-10-01', amount: 63177.42 },
];
const wrote = await json(await api(admin, `/opportunities/${o9.id}/premium-schedule`,
  { method: 'POST', body: { rows: byHand } }));
check('every row is written', wrote?.written === 4, JSON.stringify(wrote));
let sched = (await json(await api(admin, `/opportunities/${o9.id}`))).premiums;
check('in date order', sched.map((p) => p.due_date).join(',') === byHand.map((r) => r.due_date).join(','),
  sched.map((p) => p.due_date).join(','));
check('to the cent, exactly as typed',
  sched.every((p, i) => near(p.amount, byHand[i].amount)),
  sched.map((p) => p.amount).join(','));
check('a zero year is kept rather than dropped', sched.length === 4 && near(sched[2].amount, 0));
check('the note survives', sched[0].notes === 'quoted');

const bad = await api(admin, `/opportunities/${o9.id}/premium-schedule`, { method: 'POST', body: {
  rows: [{ due_date: '2030-10-01', amount: 50000 }, { due_date: '', amount: 50000 }] } });
check('a missing date is refused, naming the row', bad.status === 400
  && /Row 2/.test((await json(bad))?.error || ''));
sched = (await json(await api(admin, `/opportunities/${o9.id}`))).premiums;
check('and nothing was replaced — the old schedule stands', sched.length === 4
  && near(sched[3].amount, 63177.42), `${sched.length} rows`);

const dupe = await api(admin, `/opportunities/${o9.id}/premium-schedule`, { method: 'POST', body: {
  rows: [{ due_date: '2031-01-01', amount: 1 }, { due_date: '2031-01-01', amount: 2 }] } });
check('two payments on one day are refused', dupe.status === 400,
  JSON.stringify(await json(dupe)));

const negative = await api(admin, `/opportunities/${o9.id}/premium-schedule`, { method: 'POST', body: {
  rows: [{ due_date: '2031-01-01', amount: -500 }] } });
check('a negative premium is refused', negative.status === 400);

const huge = await api(admin, `/opportunities/${o9.id}/premium-schedule`, { method: 'POST', body: {
  rows: Array.from({ length: 61 }, (_, n) => ({ due_date: `20${26 + n}-01-01`, amount: 1 })) } });
check('and a runaway schedule is capped', huge.status === 400);

const hand = (await json(await api(admin, `/opportunities/${o9.id}`))).analysis;
// The typed years are used as typed; past the end of the schedule the
// projection continues at the last twelve months' rate — here 63,177.42,
// for 2030, 2031 and 2032, the maturity falling on 2033-01-15.
check('the hand-entered amounts are what the analysis spends',
  near(hand.base.premiums_paid, 41250.75 + 44800 + 63177.42 * 4, 0.01),
  `${hand.base.premiums_paid} over ${hand.base.premium_count} payments`);
check('a zero year costs nothing without vanishing from the schedule',
  hand.base.premium_count === 6 && sched.length === 4,
  `${hand.base.premium_count} flows from 4 typed rows`);
check('and the projection past the schedule is declared',
  hand.base.projected_beyond_schedule === 3, String(hand.base.projected_beyond_schedule));

console.log('\nTHE ONE-PAGER NARRATIVE');
const narrative = {
  le_provider_2: 'Polaris PUW-41491', le_months_2: 195, records_through: '2025-05-31',
  impairments: 'Cardiovascular: CAD s/p 5 stents\nHepatic: fatty liver with ongoing ETOH',
  mitigating: '60 lb weight loss improved OSA and labs',
  underwriter_note: 'Mortality risk higher than at prior underwriting.',
  thesis: 'Discounted entry at 2.4% of face\nThree-year premium holiday at ages 67-69',
};
await api(admin, `/opportunities/${o9.id}`, { method: 'PUT', body: narrative });
const withText = await json(await api(admin, `/opportunities/${o9.id}`));
check('the sheet fields round-trip',
  Object.entries(narrative).every(([k, v]) =>
    String(withText[k]).slice(0, 10) === String(v).slice(0, 10)),
  Object.keys(narrative).filter((k) => String(withText[k]).slice(0, 10) !== String(narrative[k]).slice(0, 10)).join(','));
check('the second life expectancy is kept apart from the first',
  withText.le_months === 84 && withText.le_months_2 === 195,
  `${withText.le_months} / ${withText.le_months_2}`);
check('an investor sees the narrative once it is shared with them', await (async () => {
  await api(admin, `/opportunities/${o9.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
  const seen = await json(await api(inv1, `/opportunities/${o9.id}`));
  return seen?.impairments === narrative.impairments;
})());
check('but an investor still cannot write them',
  (await api(inv1, `/opportunities/${o9.id}`, { method: 'PUT', body: { thesis: 'x' } })).status === 403);

console.log('\nCORRECTING ONE PAYMENT');
const target = sched[1];
const moved = await json(await api(admin, `/opportunity-premiums/${target.id}`, { method: 'PUT',
  body: { due_date: '2027-11-15', amount: 45500.5, notes: 'revised illustration' } }));
check('the date, amount and note all move', moved?.due_date === '2027-11-15'
  && near(moved.amount, 45500.5) && moved.notes === 'revised illustration',
  JSON.stringify(moved));
const onto = await api(admin, `/opportunity-premiums/${target.id}`, { method: 'PUT',
  body: { due_date: '2026-10-01' } });
check('but not onto a day that is already taken', onto.status === 400);
check('an investor cannot edit a payment',
  (await api(inv1, `/opportunity-premiums/${target.id}`, { method: 'PUT', body: { amount: 1 } })).status === 403);
check('the owning entity\'s manager can',
  (await api(pm1, `/opportunity-premiums/${target.id}`, { method: 'PUT', body: { amount: 45500.5 } })).status === 200);
// …but a manager whose entities do not include the owner sees nothing to edit.
const elsewhere = await make('9B', { fund_id: lcg2.id });
await api(admin, `/opportunities/${elsewhere.id}/premium-schedule`,
  { method: 'POST', body: { rows: [{ due_date: '2026-12-01', amount: 9000 }] } });
const elsewhereRow = (await json(await api(admin, `/opportunities/${elsewhere.id}`))).premiums[0];
check('a manager outside the owning entity cannot',
  (await api(pm1, `/opportunity-premiums/${elsewhereRow.id}`, { method: 'PUT', body: { amount: 1 } })).status === 404);
check('and cannot post a schedule to it either',
  (await api(pm1, `/opportunities/${elsewhere.id}/premium-schedule`,
    { method: 'POST', body: { rows: [{ due_date: '2026-12-01', amount: 1 }] } })).status === 404);

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

// The deal keyed in by hand as well as posted as an opportunity. The policy
// number collides, and the refusal has to name the policy rather than saying
// "that record already exists" — which is what the constraint alone gives you.
const twin = await make('11', { policy_number: `${PREFIX}-10` });
const twinFund = await api(admin, `/opportunities/${twin.id}/fund`, { method: 'POST' });
const twinBody = await json(twinFund);
check('funding a policy number already in the portfolio is refused', twinFund.status === 409,
  `status ${twinFund.status}`);
check('and the refusal names the policy, not the constraint',
  /already in the portfolio/.test(twinBody?.error || '') && /OPPT-10/.test(twinBody?.error || ''),
  twinBody?.error);
check('it points at the policy so it can be opened', twinBody?.policy_id === newPolicyId);
const twinAfter = await json(await api(admin, `/opportunities/${twin.id}`));
check('and the opportunity is not left marked funded',
  twinAfter.status !== 'Funded' && !twinAfter.policy_id, twinAfter.status);
check('an editor cannot fund',
  (await api(inv1, `/opportunities/${o10.id}/fund`, { method: 'POST' })).status === 403);

await api(admin, `/policies/${newPolicyId}`, { method: 'DELETE', body: { confirm: `${PREFIX}-10` } });

console.log('\nUNAUTHENTICATED');
for (const path of ['/opportunities', '/opportunities/summary', `/opportunities/${o1.id}`])
  check(`GET ${path} needs a session`, (await fetch(`${BASE}/api${path}`)).status === 401);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL OPPORTUNITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
