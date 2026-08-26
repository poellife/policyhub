/* =====================================================================
   Offering a policy that was never an opportunity.

   Not every deal starts on the Opportunities tab. A policy keyed
   straight into the portfolio has no opportunity behind it to send
   back, and when one of its investors backs out there is still a share
   to place. This builds the offer the deal never had.

   What has to hold:

     - the offer carries the policy's own facts, not a blank form;
     - investors who stay are on it as Confirmed at the percentage they
       already hold, so the share on offer is the freed one;
     - the investor who left is Withdrawn — recorded, but holding
       nothing;
     - the policy stays by default, minus the leaver on its cap table;
     - removing it is possible, guarded, and takes the ledger with it;
     - two live offers for one policy are refused;
     - investors cannot do any of it, and a manager cannot reach into
       another entity.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'OFFERP';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) < tol;

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
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

/** A policy keyed straight in, with a cap table — no opportunity anywhere. */
const keyIn = async (suffix, splits, body = {}) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Direct Life', product_type: 'UL',
    face_amount: 2500000, status: 'Inforce', fund_id: lcg1.id,
    insured_last_name: 'Direct', insured_first_name: 'Dana',
    insured_dob: '1946-04-19', insured_gender: 'F', insured_state: 'MI', le_months: 80,
    acquisition_date: '2026-02-01', acquisition_cost: 480000,
    premium_required: 41000, premium_mode: 'Annual', ...body } }));
  for (const [investorId, pct] of splits)
    await api(admin, `/policies/${p.id}/investors`, {
      method: 'POST', body: { investor_id: investorId, pct, acquired_on: '2026-02-01' } });
  return json(await api(admin, `/policies/${p.id}`));
};

/* ------------------------------------------------------------------ *
 * The ordinary case
 * ------------------------------------------------------------------ */
console.log('A POLICY ENTERED BY HAND CAN STILL BE PUT ON THE LIST');
const p1 = await keyIn('1', [[me1, 45], [me2, 30]]);
check('the policy exists with two holders', (p1.owners || []).length === 2,
  JSON.stringify((p1.owners || []).map((o) => [o.name, o.pct])));

const chk = await json(await api(admin, `/policies/${p1.id}/offer-check`));
check('the check reads the cap table', (chk.owners || []).length === 2);
check('and works out what is already unheld', near(chk.unheld_pct, 25),
  String(chk.unheld_pct));
check('it proposes the acquisition cost as the asking price',
  near(chk.asking_price, 480000), String(chk.asking_price));
check('and there is no offer for it yet', chk.existing_offer === null);

const made = await json(await api(admin, `/policies/${p1.id}/offer`, {
  method: 'POST', body: { backing_out: [me2], offer_closes_on: '2027-03-31' } }));
check('the offer is created', made.opportunity_id > 0, JSON.stringify(made));
check('one holder was carried over', made.carried === 1, String(made.carried));
check('one backed out', made.withdrew === 1, String(made.withdrew));
check('releasing their 30%', near(made.freed_pct, 30), String(made.freed_pct));
check('so 55% is on offer — the 25% never placed plus the 30% given up',
  near(made.remaining_pct, 55), String(made.remaining_pct));
check('and the policy was kept', made.policy_removed === false);

const o = await json(await api(admin, `/opportunities/${made.opportunity_id}`));
check('the offer carries the policy number', o.policy_number === `${PREFIX}-1`, o.policy_number);
check('and the carrier', o.carrier_name === 'Direct Life', o.carrier_name);
check('and the death benefit', near(o.face_amount, 2500000), String(o.face_amount));
check('and the insured, from the insureds record',
  o.insured_last_name === 'Direct' && o.insured_first_name === 'Dana',
  `${o.insured_last_name}, ${o.insured_first_name}`);
check('and the premium', near(o.annual_premium, 41000), String(o.annual_premium));
check('and the closing date that was asked for',
  String(o.offer_closes_on).startsWith('2027-03-31'), String(o.offer_closes_on));
check('it is Open', o.status === 'Open', o.status);
check('and claims no policy of its own — funding it later will link, not duplicate',
  !o.policy_id, String(o.policy_id));

check('the investor who stayed is Confirmed at the percentage they hold',
  o.commitments.some((c) => c.investor_id === me1 && c.status === 'Confirmed' && near(c.pct, 45)),
  JSON.stringify(o.commitments.map((c) => [c.investor_id, c.status, c.pct])));
check('the one who left is Withdrawn',
  o.commitments.some((c) => c.investor_id === me2 && c.status === 'Withdrawn'));
check('so the taken figure counts only the holder who stayed',
  near(o.taken_pct, 45), String(o.taken_pct));

console.log('\nTHE POLICY STAYS, MINUS THE INVESTOR WHO LEFT');
const p1after = await json(await api(admin, `/policies/${p1.id}`));
check('the policy is still in the portfolio', p1after?.id === p1.id);
check('the investor who stayed still owns their share',
  (p1after.owners || []).some((x) => x.investor_id === me1 && near(x.pct, 45)));
check('and the one who backed out is off the cap table',
  !(p1after.owners || []).some((x) => x.investor_id === me2),
  JSON.stringify((p1after.owners || []).map((x) => x.investor_id)));

console.log('\nBOTH INVESTORS CAN SEE THE OFFER');
check('the one still in it does',
  ((await json(await api(inv1, '/opportunities'))) || []).some((x) => x.id === o.id));
check('and so does the one who stepped out, in case they change their mind',
  ((await json(await api(inv2, '/opportunities'))) || []).some((x) => x.id === o.id));
check('who can ask for a piece again',
  (await api(inv2, `/opportunities/${o.id}/commit`, { method: 'POST', body: { pct: 20 } })).ok);
const retaken = await json(await api(admin, `/opportunities/${o.id}`));
check('held against the freed share', near(retaken.taken_pct, 65), String(retaken.taken_pct));

console.log('\nONE POLICY, ONE LIVE OFFER');
const again = await api(admin, `/policies/${p1.id}/offer`, {
  method: 'POST', body: { backing_out: [] } });
check('a second offer for the same policy is refused', again.status === 409,
  String(again.status));
const chk2 = await json(await api(admin, `/policies/${p1.id}/offer-check`));
check('and the check points at the one that exists',
  chk2.existing_offer?.id === o.id, JSON.stringify(chk2.existing_offer));

/* ------------------------------------------------------------------ *
 * Taking the policy out with it
 * ------------------------------------------------------------------ */
console.log('\nWHEN THE PURCHASE IS NOT GOING AHEAD AT ALL');
const p2 = await keyIn('2', [[me1, 50], [me2, 50]]);
await api(admin, `/policies/${p2.id}/transactions`, { method: 'POST', body: {
  txn_date: '2026-03-01', txn_type: 'Premium', amount: 10250, remarks: `${PREFIX} premium` } });

const chk3 = await json(await api(admin, `/policies/${p2.id}/offer-check`));
check('the check counts the work on the policy', chk3.activity >= 1, String(chk3.activity));
check('and demands the policy number before it will be removed',
  chk3.needs_confirm === true);
check('naming what would go', (chk3.losses || []).length > 0, (chk3.losses || []).join(', '));

const refused = await api(admin, `/policies/${p2.id}/offer`, {
  method: 'POST', body: { backing_out: [me2], remove_policy: true } });
check('without it the request is refused', refused.status === 409, String(refused.status));
check('and the policy is untouched',
  (await api(admin, `/policies/${p2.id}`)).status === 200);
check('with both holders still on it',
  ((await json(await api(admin, `/policies/${p2.id}`))).owners || []).length === 2);
check('and no offer was left behind',
  !((await json(await api(admin, '/opportunities'))) || [])
    .some((x) => x.policy_number === `${PREFIX}-2`));

const gone = await json(await api(admin, `/policies/${p2.id}/offer`, {
  method: 'POST', body: { backing_out: [me2], remove_policy: true, confirm: `${PREFIX}-2` } }));
check('with the number typed it goes through', gone.ok === true, JSON.stringify(gone));
check('the policy is out of the portfolio',
  (await api(admin, `/policies/${p2.id}`)).status === 404);
check('and it says what it destroyed', (gone.destroyed || []).length > 0,
  (gone.destroyed || []).join(', '));
const o2 = await json(await api(admin, `/opportunities/${gone.opportunity_id}`));
check('the offer still stands with the holder who stayed',
  o2.commitments.some((c) => c.investor_id === me1 && c.status === 'Confirmed' && near(c.pct, 50)));
check('and 50% available', near(o2.remaining_pct, 50), String(o2.remaining_pct));

/* ------------------------------------------------------------------ *
 * Nobody backing out
 * ------------------------------------------------------------------ */
console.log('\nA POLICY WITH A FREE SHARE AND NOBODY LEAVING');
const p3 = await keyIn('3', [[me1, 60]]);
const spare = await json(await api(admin, `/policies/${p3.id}/offer`, {
  method: 'POST', body: {} }));
check('it can go on the list to place what was never placed', spare.ok === true);
check('nobody withdrew', spare.withdrew === 0, String(spare.withdrew));
check('and the 40% that was never held is what is on offer',
  near(spare.remaining_pct, 40), String(spare.remaining_pct));
check('the cap table is untouched',
  ((await json(await api(admin, `/policies/${p3.id}`))).owners || []).length === 1);

/* ------------------------------------------------------------------ *
 * Who may do it
 * ------------------------------------------------------------------ */
console.log('\nWHO MAY OFFER ONE');
const p4 = await keyIn('4', [[me1, 70]]);
check('an investor cannot',
  (await api(inv1, `/policies/${p4.id}/offer`, { method: 'POST', body: {} })).status === 403);
check('nor ask what it would carry',
  (await api(inv1, `/policies/${p4.id}/offer-check`)).status === 403);
check('and an investor who holds none of it cannot be named as backing out',
  (await api(admin, `/policies/${p4.id}/offer`, {
    method: 'POST', body: { backing_out: [999999] } })).status === 400);

if (other) {
  const foreign = await keyIn('5', [], { fund_id: other.id });
  const st = (await api(pm1, `/policies/${foreign.id}/offer`, { method: 'POST', body: {} })).status;
  check('a manager cannot offer another entity’s policy',
    [403, 404].includes(st), String(st));
} else {
  check('the fixture has only one entity, so cross-entity reach is untested', true, 'skipped');
}

console.log('\nIT IS ON THE RECORD');
const log = (await json(await api(admin, '/audit'))) || [];
check('the audit log carries the offer',
  log.some((r) => /offered from policy/i.test(String(r.detail || ''))),
  log.slice(0, 3).map((r) => r.detail).join(' | '));

await wipe();
console.log(fails.length
  ? `\n${fails.length} OFFER-POLICY CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL OFFER-POLICY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
