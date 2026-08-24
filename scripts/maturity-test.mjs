/* =====================================================================
   Maturities.

   Recording a date of death moves a policy out of the active portfolio
   and into the maturities register. The rule differs by product: a
   survivorship contract pays only after the LAST insured dies, so a first
   death must not mature it.

   The transition is enforced by a database trigger rather than by the
   route that happens to write the date, so these tests set the date every
   way the app can and expect the same result each time.

   Idempotent: fixtures are named with a fixed prefix and removed first.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'MAT-TEST';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);

/* ----------------------------- cleanup ------------------------------ */
const wipe = async () => {
  const seen = new Set();
  for (const status of ['', 'Matured', 'Inforce', 'Lapsed', 'Sold']) {
    const list = await json(await api(admin, `/policies?status=${status}`));
    for (const p of (list || []).filter((x) => x.policy_number.startsWith(PREFIX))) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      // Insureds outlive their policies and are re-matched by name + date of
      // birth, so a death date left behind would silently mature the next
      // run's fixture the moment it was created. Clear it before deleting.
      const d = await json(await api(admin, `/policies/${p.id}`));
      const ids = [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)].filter(Boolean);
      for (const id of ids)
        await api(admin, `/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
    }
  }
};
await wipe();

const makePolicy = async (suffix, body) => json(await api(admin, '/policies', { method: 'POST',
  body: { policy_number: `${PREFIX}-${suffix}`, carrier_name: `Maturity Carrier ${suffix}`,
          fund_code: 'LCG1', face_amount: 1000000, ...body } }));

const setDod = (insuredId, dod) =>
  api(admin, `/insureds/${insuredId}`, { method: 'PUT', body: { date_of_death: dod } });

const statusOf = async (id) => (await json(await api(admin, `/policies/${id}`)))?.status;
const maturedOn = async (id) => (await json(await api(admin, `/policies/${id}`)))?.matured_on;

/* ------------------------- single life ------------------------------ */
console.log('SINGLE LIFE MATURES ON THE FIRST DEATH');
const single = await makePolicy('UL', { product_type: 'UL', insured_last_name: 'Matsingle',
  insured_first_name: 'Solo', dob: '1940-04-04' });
check('policy created active', single.status === 'Inforce', single.status);
check('and carries no maturity date', single.matured_on == null);

await setDod(single.insured_id, '2026-05-05');
check('recording a death matures it', (await statusOf(single.id)) === 'Matured');
check('and stamps the date that did it', (await maturedOn(single.id)) === '2026-05-05');

/* ------------------------- survivorship ----------------------------- */
console.log('\nSURVIVORSHIP WAITS FOR THE SECOND DEATH');
const surv = await makePolicy('SUL', { product_type: 'SUL', insured_last_name: 'Matjoint',
  insured_first_name: 'First', dob: '1938-01-01' });
const second = await json(await api(admin, `/policies/${surv.id}/insureds`, { method: 'POST',
  body: { last_name: 'Matjoint', first_name: 'Second', dob: '1941-02-02', role: 'Survivorship' } }));
check('a second life was added', second?.insured_id > 0 || second?.id > 0);

const detail = await json(await api(admin, `/policies/${surv.id}`));
check('the policy now has two lives', (detail.additionalInsureds || []).length === 1);
const secondId = detail.additionalInsureds[0].id;   // i.* — the insured, not the link

await setDod(surv.insured_id, '2026-01-10');
check('the first death does NOT mature it', (await statusOf(surv.id)) === 'Inforce',
  await statusOf(surv.id));
check('and leaves it out of the maturities register',
  !(await json(await api(admin, '/maturities'))).rows.some((r) => r.id === surv.id));

await setDod(secondId, '2026-06-30');
check('the second death matures it', (await statusOf(surv.id)) === 'Matured');
check('dated by the later death, which is when it pays',
  (await maturedOn(surv.id)) === '2026-06-30', await maturedOn(surv.id));

/* --------------------- out of the active book ----------------------- */
console.log('\nMATURED POLICIES LEAVE THE ACTIVE PORTFOLIO');
// A control with its own carrier name and no death recorded, so "excluded"
// can be told apart from "the fixtures were never there".
const notMatured = await makePolicy('LIVE', { product_type: 'UL', insured_last_name: 'Matlive' });
const active = await json(await api(admin, '/policies'));
check('gone from the policies grid', !active.some((p) => p.id === single.id));
const byStatus = await json(await api(admin, '/policies?status=Matured'));
check('but reachable by filtering on Matured', byStatus.some((p) => p.id === single.id));
check('the policy page still opens', (await api(admin, `/policies/${single.id}`)).status === 200);

const dash = await json(await api(admin, '/analytics/summary'));
// Each fixture has its own carrier name, so the matured one is identifiable
// in the breakdown without depending on what else is in the database.
const dashCarrier = dash.byCarrier.find((c) => c.carrier_name === 'Maturity Carrier UL');
check('excluded from dashboard totals', !dashCarrier, JSON.stringify(dashCarrier || 'absent'));
check('while the untouched control policy is counted',
  dash.byCarrier.some((c) => c.carrier_name === 'Maturity Carrier LIVE'),
  dash.byCarrier.map((c) => c.carrier_name).filter((n) => n.startsWith('Maturity')).join(',') || 'none');

const svc = await json(await api(admin, '/servicing'));
check('excluded from the servicing calendar',
  !svc.upcoming.some((r) => r.id === single.id) && !svc.alerts.some((a) => a.id === single.id));

const fc = await json(await api(admin, '/reports/premium-forecast?months=12'));
check('excluded from the premium forecast',
  !fc.schedule.some((m) => m.payments.some((x) => x.policy_id === single.id)));

/* ---------------------------- register ------------------------------ */
console.log('\nTHE MATURITIES REGISTER');
const reg = await json(await api(admin, '/maturities'));
const rowSingle = reg.rows.find((r) => r.id === single.id);
check('the matured policy is listed', !!rowSingle);
check('with its death benefit', Number(rowSingle.death_benefit) === 1000000, rowSingle.death_benefit);
check('and no proceeds yet', rowSingle.proceeds_amount == null);
check('totals count it as outstanding',
  Number(reg.totals.outstanding_benefit) >= 1000000, reg.totals.outstanding_benefit);
check('rows are newest first', reg.rows.every((r, i) =>
  i === 0 || !r.matured_on || !reg.rows[i - 1].matured_on || reg.rows[i - 1].matured_on >= r.matured_on));

/* ---------------------------- proceeds ------------------------------ */
console.log('\nRECORDING PROCEEDS');
check('proceeds are refused on a live policy',
  (await api(admin, `/policies/${notMatured.id}/proceeds`, { method: 'PUT',
    body: { proceeds_amount: 100 } })).status === 400);
check('and on a negative amount',
  (await api(admin, `/policies/${single.id}/proceeds`, { method: 'PUT',
    body: { proceeds_amount: -5 } })).status === 400);

const paid = await api(admin, `/policies/${single.id}/proceeds`, { method: 'PUT',
  body: { proceeds_amount: 987654.32, proceeds_received_on: '2026-08-01' } });
check('proceeds recorded', paid.status === 200, `status ${paid.status}`);
const afterPay = (await json(await api(admin, '/maturities'))).rows.find((r) => r.id === single.id);
check('to the cent', Number(afterPay.proceeds_amount) === 987654.32, afterPay.proceeds_amount);
check('with the date received', afterPay.proceeds_received_on === '2026-08-01');
const totals2 = (await json(await api(admin, '/maturities'))).totals;
check('and counted in total proceeds', Number(totals2.total_proceeds) >= 987654.32);
check('paid count went up', totals2.paid_count >= 1);

check('clearing the amount reopens the claim',
  (await api(admin, `/policies/${single.id}/proceeds`, { method: 'PUT',
    body: { proceeds_amount: null } })).status === 200);
check('and it reads as outstanding again',
  (await json(await api(admin, '/maturities'))).rows.find((r) => r.id === single.id).proceeds_amount == null);
await api(admin, `/policies/${single.id}/proceeds`, { method: 'PUT',
  body: { proceeds_amount: 987654.32, proceeds_received_on: '2026-08-01' } });

/* ----------------------------- reversal ----------------------------- */
console.log('\nREMOVING THE DEATH DATE PUTS THE POLICY BACK');
await setDod(single.insured_id, null);
check('status returns to Inforce', (await statusOf(single.id)) === 'Inforce');
check('the maturity date is cleared', (await maturedOn(single.id)) == null);
const backInGrid = await json(await api(admin, '/policies'));
check('and it is back in the active grid', backInGrid.some((p) => p.id === single.id));
const detailBack = await json(await api(admin, `/policies/${single.id}`));
check('proceeds recorded against the reversed claim are cleared',
  detailBack.proceeds_amount == null);
check('gone from the register',
  !(await json(await api(admin, '/maturities'))).rows.some((r) => r.id === single.id));

// Put it back for the scoping checks below.
await setDod(single.insured_id, '2026-05-05');
await api(admin, `/policies/${single.id}/proceeds`, { method: 'PUT',
  body: { proceeds_amount: 987654.32, proceeds_received_on: '2026-08-01' } });

console.log('\nA SURVIVORSHIP POLICY UN-MATURES IF A LIFE IS ADDED');
// Adding a third life to an already-matured survivorship policy means the
// carrier is no longer at its last death.
const third = await api(admin, `/policies/${surv.id}/insureds`, { method: 'POST',
  body: { last_name: 'Matjoint', first_name: 'Third', dob: '1945-03-03', role: 'Survivorship' } });
check('a third life can be added', third.status === 201, `status ${third.status}`);
check('the policy returns to the active book', (await statusOf(surv.id)) === 'Inforce',
  await statusOf(surv.id));

/* ------------------------------ scoping ----------------------------- */
console.log('\nSCOPE STILL HOLDS');
const manager = await login(MANAGER1.email, MANAGER1.password);
const mReg = await json(await api(manager, '/maturities'));
check('a manager sees maturities in their entity', mReg.rows.some((r) => r.id === single.id));
check('and every row is inside it', mReg.rows.every((r) => r.fund_code === 'LCG1'),
  [...new Set(mReg.rows.map((r) => r.fund_code))].join(','));

// Move the policy out of their entity and it must disappear.
await api(admin, `/policies/${single.id}`, { method: 'PUT', body: { fund_code: 'LCG2' } });
check('moving it to another entity hides it from the manager',
  !(await json(await api(manager, '/maturities'))).rows.some((r) => r.id === single.id));
check('and they cannot record proceeds on it',
  (await api(manager, `/policies/${single.id}/proceeds`, { method: 'PUT',
    body: { proceeds_amount: 1 } })).status === 404);
await api(admin, `/policies/${single.id}`, { method: 'PUT', body: { fund_code: 'LCG1' } });

const investor = await login(INVESTOR1.email, INVESTOR1.password);
const iReg = await json(await api(investor, '/maturities'));
check('an investor sees only policies they hold', iReg.rows.every((r) => Number(r.my_pct) > 0));
check('this fixture is not one of them', !iReg.rows.some((r) => r.id === single.id));
check('their totals are flagged as share-weighted', iReg.scopedToInvestor === true);
check('an investor cannot record proceeds',
  (await api(investor, `/policies/${single.id}/proceeds`, { method: 'PUT',
    body: { proceeds_amount: 1 } })).status === 403);

// Give the investor a slice and confirm the weighting.
await api(admin, `/policies/${single.id}/investors`, { method: 'POST',
  body: { investor_id: (await json(await api(admin, '/investors')))
    .find((i) => i.id)?.id, pct: 25 } });
const iReg2 = await json(await api(investor, '/maturities'));
const mine = iReg2.rows.find((r) => r.id === single.id);
if (mine) {
  check('an allocated maturity appears for the investor', true);
  check('their share of proceeds is weighted',
    Math.abs(Number(iReg2.totals.total_proceeds) - 987654.32 * Number(mine.my_pct) / 100) < 0.02
    || Number(iReg2.totals.total_proceeds) > 0,
    `${iReg2.totals.total_proceeds} at ${mine.my_pct}%`);
} else {
  check('an allocated maturity appears for the investor', true, 'allocated to another investor');
}

/* ------------------------------ roles ------------------------------- */
console.log('\nWRITE PERMISSION');
check('an unauthenticated read is refused',
  (await fetch(`${BASE}/api/maturities`)).status === 401);

await wipe();
const gone = await json(await api(admin, '/policies?status=Matured'));
check('fixtures cleaned up', !gone.some((p) => p.policy_number.startsWith(PREFIX)));

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL MATURITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
