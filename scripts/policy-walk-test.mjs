/* =====================================================================
   Six small things that make the book workable.

     - the insured's date of birth beside their name, because every
       figure on a policy page turns on how old this person is
     - previous and next, so the book can be read case by case instead
       of through the grid each time
     - a value snapshot that can be corrected rather than deleted
     - the next premium entered on the same screen as the statement it
       came from, which schedules it
     - both rates, named, wherever a return is reported to staff
     - a report whose columns the reader chooses

   Idempotent: its own entity and policies, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'WALK';
const FUND = 'WALKFND';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) < tol;
const M = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const admin = await login(ADMIN.email, ADMIN.password);
const inv = await login(INVESTOR1.email, INVESTOR1.password);
const me = (await json(await api(inv, '/auth/me'))).investor.id;

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(admin, `/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  for (const f of ((await json(await api(admin, '/funds'))) || []).filter((x) => x.code === FUND))
    await api(admin, `/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();
await api(admin, '/funds', { method: 'POST', body: { code: FUND, name: 'Walk fixture' } });

const policy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: FUND, face_amount: 2000000,
  premium_required: 888888, premium_mode: 'Annual', next_premium_due: iso(2),
  acquisition_date: iso(-800), acquisition_cost: 300000,
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Ada', dob: '1941-06-15' } }));
await api(admin, `/policies/${policy.id}/investors`, { method: 'POST', body: {
  investor_id: me, pct: 50, acquired_on: iso(-800) } });
await api(admin, `/policies/${policy.id}/transactions`, { method: 'POST', body: {
  txn_date: iso(-800), txn_type: 'Acquisition Cost', amount: 300000 } });

console.log('THE DATE OF BIRTH TRAVELS WITH THE POLICY');
const one = await json(await api(admin, `/policies/${policy.id}`));
check('the policy carries the insured’s date of birth',
  String(one.insured_dob).slice(0, 10) === '1941-06-15', String(one.insured_dob));

console.log('\nCORRECTING A SNAPSHOT');
const snap = await json(await api(admin, `/policies/${policy.id}/values`, { method: 'POST', body: {
  as_of_date: iso(-30), account_value: 41000, cash_surrender_value: 38000,
  cost_of_insurance: 2100, death_benefit: 2000000 } }));
check('a snapshot is recorded', !!snap.id, String(snap.id));

const fixed = await json(await api(admin, `/values/${snap.id}`, { method: 'PUT', body: {
  account_value: 42500, notes: 'Restated by the carrier' } }));
check('a figure can be corrected in place',
  fixed.id === snap.id && near(fixed.account_value, 42500), M(fixed.account_value));
check('and the rest of the row is untouched',
  near(fixed.cash_surrender_value, 38000), M(fixed.cash_surrender_value));
check('the correction is kept, not appended',
  ((await json(await api(admin, `/policies/${policy.id}`))).values || []).length === 1);

const moved = await json(await api(admin, `/values/${snap.id}`, { method: 'PUT', body: {
  as_of_date: iso(-25) } }));
check('a statement filed under the wrong date can be moved',
  String(moved.as_of_date).slice(0, 10) === iso(-25), String(moved.as_of_date));

const second = await json(await api(admin, `/policies/${policy.id}/values`, { method: 'POST', body: {
  as_of_date: iso(-10), account_value: 40000 } }));
check('moving one onto a date that already has one is refused, not merged',
  (await api(admin, `/values/${moved.id}`, { method: 'PUT', body: {
    as_of_date: iso(-10) } })).status === 409);
await api(admin, `/values/${second.id}`, { method: 'DELETE' });

console.log('\nAN INVESTOR CANNOT TOUCH ONE');
check('editing a snapshot is staff work',
  (await api(inv, `/values/${snap.id}`, { method: 'PUT', body: { account_value: 1 } })).status === 403);

console.log('\nTHE NEXT PREMIUM, FROM THE STATEMENT');
/* The dialog writes a scheduled premium; this is the same call it makes. */
const step = await json(await api(admin, `/policies/${policy.id}/reminders`, {
  method: 'POST', body: { kind: 'Premium', due_date: iso(45), amount: 26400,
    note: `Per the carrier statement of ${iso(-25)}` } }));
check('it lands on the servicing calendar', !!step.id, String(step.id));

const withSched = await json(await api(admin, `/policies/${policy.id}`));
check('and the policy reports it as the next premium scheduled',
  String(withSched.next_scheduled_due).slice(0, 10) === iso(45),
  String(withSched.next_scheduled_due));
check('at the amount entered, not the one on the policy form',
  near(withSched.next_scheduled_amount, 26400), M(withSched.next_scheduled_amount));
check('and totals the next twelve months of them',
  near(withSched.scheduled_next_12mo, 26400), M(withSched.scheduled_next_12mo));

const listed = ((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
  .find((p) => p.id === policy.id);
check('the grid row carries the same three figures',
  String(listed.next_scheduled_due).slice(0, 10) === iso(45)
  && near(listed.next_scheduled_amount, 26400)
  && near(listed.scheduled_next_12mo, 26400));
check('while the policy form still says what it always said',
  near(listed.premium_required, 888888), M(listed.premium_required));

console.log('\nBOTH RATES, EVERYWHERE ONE IS REPORTED');
const irr = await json(await api(admin, `/policies/${policy.id}/irr`));
check('a policy reports simple interest', irr.result?.rate != null, String(irr.result?.rate));
check('and the compounded rate beside it',
  irr.result?.compound_rate != null, String(irr.result?.compound_rate));
check('and they are not the same number',
  !near(irr.result.rate, irr.result.compound_rate, 1e-9),
  `${irr.result.rate} vs ${irr.result.compound_rate}`);

const returns = await json(await api(admin, '/reports/returns?basis=active'));
check('the return report carries both on the book',
  returns.portfolio?.rate != null && returns.portfolio?.compound_rate != null);
check('and both on every policy in it',
  (returns.rows || []).every((r) => 'compound_rate' in r), String(returns.rows?.length));
const sum = await json(await api(admin, '/analytics/summary'));
check('so does the dashboard', sum.rate?.compound_rate != null, String(sum.rate?.compound_rate));
const mats = await json(await api(admin, '/maturities'));
check('so does the maturities register',
  (mats.rows || []).every((r) => 'compound_rate' in r)
  && mats.realized?.compound_rate !== undefined);

console.log('\nWHICH COLUMNS A REPORT SHOWS');
const before = await json(await api(admin, '/me/prefs'));
const saved = await api(admin, '/me/prefs/report_columns', { method: 'PUT', body: {
  order: ['insured_last', 'policy_number', 'death_benefit', 'le_months'],
  hidden: ['policy_number'] } });
check('an arrangement can be stored for the report', saved.status === 200, String(saved.status));
const prefs = await json(await api(admin, '/me/prefs'));
check('and comes back on its own key, apart from the grid’s',
  !!prefs.report_columns && prefs.report_columns.order[0] === 'insured_last',
  JSON.stringify(prefs.report_columns || null).slice(0, 80));
check('the policies grid arrangement is untouched by it',
  JSON.stringify(prefs.policy_columns) === JSON.stringify(before.policy_columns));
check('a nonsense arrangement is refused rather than stored',
  (await api(admin, '/me/prefs/report_columns', { method: 'PUT', body: {
    order: ['no_such_field'] } })).status === 400);
check('and a name nothing uses is not a preference at all',
  (await api(admin, '/me/prefs/whatever', { method: 'PUT', body: { order: ['status'] } })).status === 404);
await api(admin, '/me/prefs/report_columns', { method: 'DELETE' });
check('it can be put back to the default',
  !(await json(await api(admin, '/me/prefs'))).report_columns);

console.log('\nWHAT A MANAGER MAY DO WITH THEIR OWN INVESTORS');
const { MANAGER1 } = await import('./test-config.mjs');
const mgr = await login(MANAGER1.email, MANAGER1.password);
const made = await json(await api(mgr, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Fresh Trust`, investor_type: 'Trust', email: `${PREFIX.toLowerCase()}@example.com`,
} }));
check('a manager can enter an investor', !!made.id, String(made.id));
const theirs = await json(await api(mgr, '/investors'));
check('and it is theirs at once, without anybody approving it',
  (theirs || []).some((i) => i.id === made.id),
  (theirs || []).map((i) => i.name).join(', ').slice(0, 90));
const pw = `walk-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const opened = await api(mgr, `/investors/${made.id}/login`, { method: 'POST', body: {
  login_email: `${PREFIX.toLowerCase()}.login@example.com`, login_password: pw,
  must_change_password: true } });
check('they can open a login for them the same day', opened.status === 201, String(opened.status));
/* A policy in one of the manager's own entities with room on it — the
   fixture above is in an entity they cannot see, and the rest of the book
   is fully allocated by other suites. */
const inTheirBook = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-2`, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 1000000,
  insured_last_name: `${PREFIX}Two`, insured_first_name: 'Bea', dob: '1945-01-01' } }));
const mgrPolicies = await json(await api(mgr, '/policies'));
check('a manager sees a policy in their own entity',
  (mgrPolicies || []).some((p) => p.id === inTheirBook.id));
const alloc = await api(mgr, `/policies/${inTheirBook.id}/investors`, { method: 'POST', body: {
  investor_id: made.id, pct: 40, acquired_on: iso(-1) } });
check('and allocate them a piece of a policy in their own entities',
  alloc.status === 201, `${alloc.status} ${await alloc.clone().text()}`.slice(0, 140));
const link = await json(alloc);
if (link?.id) {
  const changed = await api(mgr, `/policy-investors/${link.id}`, { method: 'PUT', body: {
    pct: 55, acquired_on: iso(-1) } });
  check('and change the percentage afterwards', changed.status === 200,
    `${changed.status} → ${(await json(changed.clone()))?.pct ?? ''}%`);
  await api(mgr, `/policy-investors/${link.id}`, { method: 'DELETE' });
}
const madeUser = ((await json(await api(admin, '/users'))) || [])
  .find((u) => u.investor_id === made.id);
if (madeUser) await api(admin, `/users/${madeUser.id}`, { method: 'DELETE' });
await api(admin, `/investors/${made.id}`, { method: 'DELETE', body: { confirm: made.name } });

await wipe();
console.log(fails.length
  ? `\n${fails.length} CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL POLICY WALK CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
