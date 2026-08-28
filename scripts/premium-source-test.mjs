/* =====================================================================
   Where a premium due comes from.

   There are two places a premium figure could be read from, and only one
   of them is an obligation.

     - the policy form carries an annual premium and a carrier due date.
       Those describe how the policy was written. They are typed in once,
       they drift, and on an imported book they are frequently blank or
       years stale.
     - the servicing calendar carries dated premiums somebody entered
       while looking at a statement, each with the amount they expect to
       pay on that date.

   Reading both meant the same payment appearing twice at two different
   figures, a forecast that disagreed with the capital call raised from
   it, and an investor asked for money against a number nobody had
   checked. So: the servicing calendar, and nothing else. The policy's
   own figures stay on the policy page, labelled as reference, and no
   screen that says money is due may read them.

   Idempotent: its own entity and policies, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'PSRC';
const FUND = 'PSRCFND';
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
  for (const c of ((await json(await api(admin, '/capital-calls'))) || []))
    if (String(c.title || '').startsWith(PREFIX))
      await api(admin, `/capital-calls/${c.id}`, { method: 'DELETE' });
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
await api(admin, '/funds', { method: 'POST', body: { code: FUND, name: 'Premium source fixture' } });

/* One policy, carrying a loud annual premium and a carrier date next week.
   Nothing is scheduled against it yet. */
const policy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: FUND, face_amount: 3000000,
  premium_required: 500000, premium_mode: 'Annual', next_premium_due: iso(7),
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Ada', dob: '1939-03-02' } }));
await api(admin, `/policies/${policy.id}/investors`, { method: 'POST', body: {
  investor_id: me, pct: 50, acquired_on: iso(-500) } });

const mine = (rows) => (rows || []).filter((r) =>
  String(r.policy_number || '').startsWith(PREFIX));

console.log('A POLICY WITH NOTHING SCHEDULED OWES NOTHING YET');
const f0 = await json(await api(admin, '/reports/premium-forecast?months=24'));
check('the forecast does not invent a payment from the policy form',
  mine(f0.schedule.flatMap((m) => m.payments)).length === 0,
  String(mine(f0.schedule.flatMap((m) => m.payments)).length));
check('and says plainly that nothing is scheduled on it',
  (f0.noSchedule || []).some((p) => p.policy_number === `${PREFIX}-1`
    && /servicing calendar/i.test(p.reason)));

const s0 = await json(await api(admin, '/servicing'));
check('the servicing calendar has no premium coming up for it',
  mine(s0.upcoming).length === 0, String(mine(s0.upcoming).length));
check('and raises no alert about a date on the policy form',
  !(s0.alerts || []).some((a) => String(a.policy_number || '').startsWith(PREFIX)
    && /premium/i.test(a.reason || '')));

const d0 = await json(await api(admin, `/capital-calls/draft?days=90&fund=${FUND}`));
check('and there is nothing to raise a capital call over',
  mine(d0.items).length === 0 && near(d0.total, 0), M(d0.total));

const iv0 = await json(await api(inv, '/servicing'));
check('the investor is shown no premium they have not been told about',
  mine(iv0.scheduled).length === 0);

console.log('\nSCHEDULING ONE IS WHAT MAKES IT DUE');
const rem = await json(await api(admin, `/policies/${policy.id}/reminders`, {
  method: 'POST', body: { kind: 'Premium', due_date: iso(30), amount: 12000,
    note: `${PREFIX} per the September statement` } }));
check('the entry is written', !!rem.id, String(rem.id));

const f1 = await json(await api(admin, '/reports/premium-forecast?months=24'));
const paid1 = mine(f1.schedule.flatMap((m) => m.payments));
check('the forecast now carries exactly one payment for this policy',
  paid1.length === 1, String(paid1.length));
check('at the amount entered on the servicing tab, not the policy form',
  near(paid1[0]?.amount, 12000), M(paid1[0]?.amount));
check('dated where it was scheduled', paid1[0]?.due_date === iso(30), paid1[0]?.due_date);
check('and the policy no longer reads as unscheduled',
  !(f1.noSchedule || []).some((p) => p.policy_number === `${PREFIX}-1`));

const s1 = await json(await api(admin, '/servicing'));
check('the calendar shows it once, not twice', mine(s1.upcoming).length === 1,
  String(mine(s1.upcoming).length));
check('at the same figure', near(mine(s1.upcoming)[0]?.premium_required, 12000),
  M(mine(s1.upcoming)[0]?.premium_required));

const d1 = await json(await api(admin, `/capital-calls/draft?days=90&fund=${FUND}`));
check('a capital call would be raised over it', mine(d1.items).length === 1);
check('for the scheduled amount', near(d1.total, 12000), M(d1.total));
check('and the investor asked for their half',
  near(d1.investors.find((i) => i.investor_id === me)?.amount, 6000),
  M(d1.investors.find((i) => i.investor_id === me)?.amount));

console.log('\nTHE POLICY FORM CAN SAY WHAT IT LIKES');
/* Move the annual figure and the carrier date to numbers that could not be
   missed if they leaked. Nothing that says money is due may change. */
await api(admin, `/policies/${policy.id}`, { method: 'PUT', body: {
  premium_required: 999999, next_premium_due: iso(3), premium_mode: 'Monthly' } });

const f2 = await json(await api(admin, '/reports/premium-forecast?months=24'));
const paid2 = mine(f2.schedule.flatMap((m) => m.payments));
check('the forecast is unmoved', paid2.length === 1 && near(paid2[0].amount, 12000),
  `${paid2.length} × ${M(paid2[0]?.amount)}`);
check('a monthly mode does not multiply it up', near(f2.grandTotal, f1.grandTotal),
  `${M(f2.grandTotal)} vs ${M(f1.grandTotal)}`);
const s2 = await json(await api(admin, '/servicing'));
check('the calendar is unmoved',
  mine(s2.upcoming).length === 1 && near(mine(s2.upcoming)[0].premium_required, 12000));
const d2 = await json(await api(admin, `/capital-calls/draft?days=90&fund=${FUND}`));
check('and so is what would be called for', near(d2.total, 12000), M(d2.total));

console.log('\nWHAT THE INVESTOR IS TOLD');
const iv2 = await json(await api(inv, '/servicing'));
const dues = mine(iv2.scheduled).filter((r) => r.kind === 'Premium');
check('one premium date, once', dues.length === 1, String(dues.length));
check('weighted to their share', near(dues[0]?.amount, 6000), M(dues[0]?.amount));
check('with the whole-policy figure beside it', near(dues[0]?.amount_full, 12000),
  M(dues[0]?.amount_full));
const stmt = await json(await api(admin, `/reports/investors?investor_ids=${me}`));
const upcoming = (stmt.investors[0]?.upcoming || [])
  .filter((u) => String(u.policy_number || '').startsWith(PREFIX));
check('their statement lists the same one payment', upcoming.length === 1,
  String(upcoming.length));
check('at the same figure', near(upcoming[0]?.amount, 6000), M(upcoming[0]?.amount));
check('and calls it what it is', upcoming[0]?.source === 'scheduled', upcoming[0]?.source);

console.log('\nMARKING IT DONE TAKES IT OFF THE LIST');
await api(admin, `/policy-reminders/${rem.id}`, { method: 'PUT', body: { done: true } });
const f3 = await json(await api(admin, '/reports/premium-forecast?months=24'));
check('a premium that has been paid is no longer owed',
  mine(f3.schedule.flatMap((m) => m.payments)).length === 0);
const d3 = await json(await api(admin, `/capital-calls/draft?days=90&fund=${FUND}`));
check('and cannot be called for again', mine(d3.items).length === 0, M(d3.total));

await wipe();
console.log(fails.length
  ? `\n${fails.length} PREMIUM SOURCE CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL PREMIUM SOURCE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
