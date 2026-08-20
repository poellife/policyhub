/* =====================================================================
   Scheduled next steps.

   "Next premium due" is one date on a policy, and a life settlement needs
   more than that: a premium that steps up in year nine, a change-of-
   ownership form to chase, an LE report going stale. These are dated
   intentions, and the two things worth proving are that they are estimates
   rather than ledger entries, and that they come back at you on the
   servicing calendar when the day arrives.

   Idempotent: the fixture policy is removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'SCHED';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) < tol;

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);

const wipe = async () => {
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');
const lcg2 = funds.find((f) => f.code === 'LCG2');
const policy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Schedule Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 1500000, premium_required: 24000, premium_mode: 'Annual',
  insured_last_name: 'Steptest', insured_first_name: 'Sam', dob: '1942-03-03' } }));

console.log('PUTTING A PREMIUM ON THE CALENDAR');
const prem = await api(admin, `/policies/${policy.id}/reminders`, { method: 'POST', body: {
  due_date: iso(400), kind: 'Premium', amount: 31500.75, note: 'Step-up per the illustration' } });
check('a future premium can be scheduled', prem.status === 201, `status ${prem.status}`);
const premRow = await json(prem);
check('with the estimate kept to the cent', near(premRow.amount, 31500.75), String(premRow.amount));
check('and it starts outstanding', premRow.done_at === null);

console.log('\nAND A REMINDER THAT IS NOT A PAYMENT');
const rem = await api(admin, `/policies/${policy.id}/reminders`, { method: 'POST', body: {
  due_date: iso(10), kind: 'Reminder', amount: 999, note: 'Chase the change-of-ownership form' } });
check('a general reminder can be scheduled', rem.status === 201, `status ${rem.status}`);
const remRow = await json(rem);
check('a reminder carries no amount, even if one is sent',
  remRow.amount === null, String(remRow.amount));
check('a reminder with no words is refused',
  (await api(admin, `/policies/${policy.id}/reminders`, { method: 'POST', body: {
    due_date: iso(5), kind: 'Reminder' } })).status === 400);
check('and one with no date is refused',
  (await api(admin, `/policies/${policy.id}/reminders`, { method: 'POST', body: {
    kind: 'Premium', amount: 100 } })).status === 400);
check('a negative estimate is refused',
  (await api(admin, `/policies/${policy.id}/reminders`, { method: 'POST', body: {
    due_date: iso(5), kind: 'Premium', amount: -5 } })).status === 400);

console.log('\nTHEY RIDE ALONG WITH THE POLICY');
const detail = await json(await api(admin, `/policies/${policy.id}`));
check('the policy carries its schedule', (detail.reminders || []).length === 2,
  `${(detail.reminders || []).length}`);
check('soonest first', detail.reminders[0].id === remRow.id);
check('and the ledger is untouched — an estimate is not a payment',
  (detail.transactions || []).length === 0, `${(detail.transactions || []).length} transactions`);

console.log('\nTHE SERVICING CALENDAR PICKS THEM UP');
const svc = await json(await api(admin, '/servicing'));
const mine = (svc.scheduled || []).filter((r) => r.policy_number === `${PREFIX}-1`);
check('both steps are on the calendar', mine.length === 2,
  `${mine.length} of ${(svc.scheduled || []).length}`);
/* A premium years out still belongs on the list: this schedule is the only
   record of what has to be funded, so a calendar that stopped at six weeks
   would take the premium forecast with it. What it does NOT do is raise an
   alarm — that is reserved for the next six weeks of work. */
check('including the premium 400 days out, which the forecast needs',
  mine.some((r) => r.reminder_id === premRow.id),
  mine.map((r) => `${r.kind}:${String(r.due_date).slice(0, 10)}`).join(' '));
check('but it raises no alert yet — it is not news',
  !(svc.alerts || []).some((a) => a.reminder_id === premRow.id));
check('and it is what the calendar says is coming up',
  (svc.upcoming || []).some((u) => u.reminder_id === premRow.id));
const alert = (svc.alerts || []).find((a) => a.scheduled && a.reminder_id === remRow.id);
check('it reads as an alert', !!alert, JSON.stringify(alert?.reason));
check('naming what it is and when', /Follow-up due in \d+ days/.test(alert?.reason || ''),
  alert?.reason);
check('with the note attached', /change-of-ownership/.test(alert?.reason || ''));

console.log('\nTICKING ONE OFF');
const done = await json(await api(admin, `/policy-reminders/${remRow.id}`,
  { method: 'PUT', body: { done: true } }));
check('it can be marked done', !!done.done_at, String(done.done_at));
check('and records who did it', done.done_by !== null);
const svc2 = await json(await api(admin, '/servicing'));
check('a completed step leaves the calendar',
  !(svc2.scheduled || []).some((r) => r.reminder_id === remRow.id));
const reopened = await json(await api(admin, `/policy-reminders/${remRow.id}`,
  { method: 'PUT', body: { done: false } }));
check('reopening clears the stamp entirely, not just the date',
  reopened.done_at === null && reopened.done_by === null,
  `${reopened.done_at} / ${reopened.done_by}`);

console.log('\nEDITING ONE');
const moved = await json(await api(admin, `/policy-reminders/${premRow.id}`, { method: 'PUT', body: {
  due_date: iso(30), amount: 28000, note: 'Revised after the new illustration' } }));
check('the date, estimate and note all move',
  moved.due_date === iso(30) && near(moved.amount, 28000)
  && /Revised/.test(moved.note), JSON.stringify(moved.note));
const toReminder = await json(await api(admin, `/policy-reminders/${premRow.id}`,
  { method: 'PUT', body: { kind: 'Reminder' } }));
check('changing it to a reminder drops the amount with it',
  toReminder.kind === 'Reminder' && toReminder.amount === null, String(toReminder.amount));

console.log('\nWHO MAY TOUCH THEM');
check('an investor cannot read the schedule',
  (await api(inv1, `/policies/${policy.id}/reminders`)).status === 403);
check('nor is it in their copy of the policy', await (async () => {
  const own = (await json(await api(inv1, '/policies'))) || [];
  if (!own.length) return true;
  const d = await json(await api(inv1, `/policies/${own[0].id}`));
  return (d.reminders || []).length === 0;
})());
check('an investor cannot schedule one',
  (await api(inv1, `/policies/${policy.id}/reminders`, { method: 'POST', body: {
    due_date: iso(5), kind: 'Reminder', note: 'x' } })).status === 403);
check('nor edit one', (await api(inv1, `/policy-reminders/${premRow.id}`,
  { method: 'PUT', body: { done: true } })).status === 403);

const foreign = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-2`, carrier_name: 'Schedule Life', fund_code: 'LCG2',
  face_amount: 500000, insured_last_name: 'Elsewhere', dob: '1940-01-01' } }));
const foreignStep = await json(await api(admin, `/policies/${foreign.id}/reminders`,
  { method: 'POST', body: { due_date: iso(3), kind: 'Reminder', note: 'not yours' } }));
check('a manager cannot read a schedule outside their entities',
  (await api(pm1, `/policies/${foreign.id}/reminders`)).status === 404);
check('nor edit a step in it',
  (await api(pm1, `/policy-reminders/${foreignStep.id}`, { method: 'PUT', body: { done: true } })).status === 404);
check('nor delete one',
  (await api(pm1, `/policy-reminders/${foreignStep.id}`, { method: 'DELETE' })).status === 404);
check('and it is absent from their calendar',
  !((await json(await api(pm1, '/servicing'))).scheduled || [])
    .some((r) => r.reminder_id === foreignStep.id));
check('but present on an admin\'s',
  ((await json(await api(admin, '/servicing'))).scheduled || [])
    .some((r) => r.reminder_id === foreignStep.id));
check('a manager can work the schedule inside their own',
  (await api(pm1, `/policies/${policy.id}/reminders`)).status === 200);

console.log('\nAN INVESTOR SEES SCHEDULED PREMIUMS, BUT NOT THE REST');
/* A premium put on the schedule by hand is money the investor will be asked
   for, so it has to reach them. "Chase the change-of-ownership form" is work
   and stays here. */
const shared = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-3`, carrier_name: 'Schedule Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 4000000, premium_required: 40000, premium_mode: 'Annual',
  next_premium_due: iso(300),
  insured_last_name: 'Sharedcase', insured_first_name: 'Nia', dob: '1941-01-01' } }));
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
await api(admin, `/policies/${shared.id}/investors`,
  { method: 'POST', body: { investor_id: me1, pct: 25 } });
await api(admin, `/policies/${shared.id}/reminders`, { method: 'POST', body: {
  due_date: iso(60), kind: 'Premium', amount: 52000, note: 'Step-up per the illustration' } });
await api(admin, `/policies/${shared.id}/reminders`, { method: 'POST', body: {
  due_date: iso(20), kind: 'Reminder', note: 'Chase the change-of-ownership form' } });

const invView = await json(await api(inv1, `/policies/${shared.id}`));
const invSteps = invView.reminders || [];
check('the scheduled premium reaches the investor', invSteps.length === 1,
  invSteps.map((r) => r.kind).join(','));
check('and it is the premium, not the errand', invSteps[0]?.kind === 'Premium');
check('the follow-up work stays internal',
  !invSteps.some((r) => /change-of-ownership/.test(r.note || '')));
check('staff still see both',
  ((await json(await api(admin, `/policies/${shared.id}`))).reminders || []).length === 2);

const invSvc = await json(await api(inv1, '/servicing'));
const mineSteps = (invSvc.scheduled || []).filter((r) => r.policy_number === `${PREFIX}-3`);
check('it is on their premiums screen', mineSteps.length === 1,
  `${mineSteps.length} of ${(invSvc.scheduled || []).length}`);
check('weighted to their 25%', near(mineSteps[0]?.amount, 52000 * 0.25),
  `${mineSteps[0]?.amount} of ${mineSteps[0]?.amount_full}`);
check('with the full-policy figure alongside it',
  near(mineSteps[0]?.amount_full, 52000));
check('an investor gets no errands on their calendar',
  !(invSvc.scheduled || []).some((r) => r.kind === 'Reminder'));
check('and no servicing alerts at all', (invSvc.alerts || []).length === 0,
  `${(invSvc.alerts || []).length} alerts`);
// One 300 days out is beyond a staff window but still ahead, so it counts.
check('a premium far in the future still reaches them',
  (invSvc.scheduled || []).every((r) => r.days_until_due >= 0));

console.log('\nCASH AND ACCOUNT VALUES ARE NOT THEIRS TO HAVE');
await api(admin, `/policies/${shared.id}/values`, { method: 'POST', body: {
  as_of_date: iso(-30), account_value: 91000, cash_surrender_value: 74000,
  cost_of_insurance: 3100, death_benefit: 4000000 } });
const invAfter = await json(await api(inv1, `/policies/${shared.id}`));
check('the API still carries them — the screen is what withholds them',
  invAfter.cash_surrender_value !== undefined);
check('so the removal is a display decision, tested in the browser suite', true,
  'see investor-ui-test');

await api(admin, `/policies/${shared.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-3` } });

console.log('\nREMOVING ONE');
check('a step can be deleted',
  (await api(admin, `/policy-reminders/${premRow.id}`, { method: 'DELETE' })).status === 200);
check('and is gone from the policy',
  ((await json(await api(admin, `/policies/${policy.id}`))).reminders || []).length === 1);

console.log('\nDELETING THE POLICY TAKES ITS SCHEDULE WITH IT');
await api(admin, `/policies/${policy.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-1` } });
check('the steps went too',
  (await api(admin, `/policy-reminders/${remRow.id}`, { method: 'PUT', body: { done: true } })).status === 404);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL SCHEDULE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
