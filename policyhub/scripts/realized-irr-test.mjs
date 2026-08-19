/* =====================================================================
   The realized return at the top of Maturities.

   Two different questions live in that one tile and they must not be
   confused:

     realized — what the book has actually returned. Only claims the
       carrier has paid, each inflow dated the day the money arrived. It
       is the same calculation every paid row on the screen shows, done
       once over all of them.

     assumed — the same thing with outstanding claims treated as if they
       were collected today. A claim that has not been paid has had no
       time to run, so folding it in at today's date flatters the rate —
       which is exactly why it must not be the figure labelled realized.

   The test that matters is the third one: a book with one paid claim and
   one outstanding must report a different number for each, and the
   realized one must equal the paid policy's own rate.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'REALIRR';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 5e-4) => a != null && b != null && Math.abs(a - b) < tol;
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const admin = await login(ADMIN.email, ADMIN.password);

/* Its own entity, and every read filtered to it. The figures under test are
   portfolio-wide by nature, so sharing a book with whatever else is on this
   database would make them assert nothing. */
const FUND = 'REALIRRF';

/* Every status, Matured included. The policy grid keeps matured policies out
   of the active book unless asked for by name, so a sweep that only reads the
   default list leaves exactly the fixtures this suite creates. */
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

/** XIRR by bisection, written here rather than imported — a check that used
    the same solver as the thing it checks would only prove it is consistent. */
const xirr = (flows) => {
  const t0 = new Date(flows[0].date);
  const npv = (r) => flows.reduce((s, f) =>
    s + f.amount / (1 + r) ** ((new Date(f.date) - t0) / 86400000 / 365), 0);
  let lo = -0.9999, hi = 100;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
};

/** A policy bought `boughtAgo` days back, dead `diedAgo` days back. */
const make = async (tag, { cost, boughtAgo, diedAgo, benefit }) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Realized Life', product_type: 'UL',
    fund_code: FUND, face_amount: benefit, premium_required: 10000, premium_mode: 'Annual',
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', dob: '1935-01-01' } }));
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-boughtAgo), txn_type: 'Acquisition Cost', amount: cost } });
  await api(admin, `/policies/${p.id}/insureds`, { method: 'GET' }).catch(() => {});
  // A date of death is what matures it — status is not typed in by hand.
  const ins = ((await json(await api(admin, `/insureds?search=${PREFIX}${tag}`))) || []);
  const person = (ins.rows || ins).find((i) => String(i.last_name) === `${PREFIX}${tag}`);
  await api(admin, `/insureds/${person.id}`, { method: 'PUT', body: {
    date_of_death: iso(-diedAgo) } });
  return p;
};

const load = async () => json(await api(admin, `/maturities?fund=${FUND}`));
const mine = (m) => (m.rows || []).filter((r) => String(r.policy_number).startsWith(PREFIX));

console.log('WITH NOTHING PAID, THE FIGURE SAYS SO');
const a = await make('A', { cost: 400000, boughtAgo: 1100, diedAgo: 200, benefit: 1000000 });
let m = await load();
check('the policy matured on its date of death', mine(m).length === 1, String(mine(m).length));
check('there is no realized rate, because nothing has been realized',
  m.realized?.irr == null && m.realized?.policy_count === 0,
  `${pct(m.realized?.irr)} over ${m.realized?.policy_count} paid`);
check('but the assumed figure is still there, for the claim outstanding',
  m.portfolio?.irr != null, pct(m.portfolio?.irr));

console.log('\nRECORDING THE CHEQUE MAKES IT REAL');
/* Paid 60 days ago, not today. If the summary dated it today it would show
   a lower rate than the row does, over a longer holding period. */
await api(admin, `/policies/${a.id}/proceeds`, { method: 'PUT', body: {
  proceeds_amount: 1000000, proceeds_received_on: iso(-60) } });
m = await load();
const rowA = mine(m).find((r) => r.policy_number === `${PREFIX}-A`);
check('one paid claim is counted', m.realized?.policy_count === 1, String(m.realized?.policy_count));
check('and with only one, the realized figure is that policy’s own rate',
  near(m.realized.irr, rowA.irr), `${pct(m.realized.irr)} vs row ${pct(rowA.irr)}`);
/* Worked out independently: 400,000 out 1,100 days ago, 1,000,000 back 60
   days ago. If the summary dated that inflow today instead, the rate would
   come out lower over a longer holding period, and this would catch it. */
const byHand = xirr([{ date: iso(-1100), amount: -400000 }, { date: iso(-60), amount: 1000000 }]);
check('and it is dated the day the cheque arrived, not today',
  near(m.realized.irr, byHand, 1e-4), `${pct(m.realized.irr)} vs ${pct(byHand)} worked out by hand`);
check('with everything paid, the assumed figure agrees — there is nothing left to assume',
  near(m.realized.irr, m.portfolio.irr),
  `realized ${pct(m.realized.irr)} · assumed ${pct(m.portfolio.irr)}`);

console.log('\nA PAID CLAIM AND AN OUTSTANDING ONE ARE NOT THE SAME NUMBER');
const b = await make('B', { cost: 900000, boughtAgo: 300, diedAgo: 20, benefit: 2000000 });
m = await load();
check('two have matured, one of them paid',
  mine(m).length === 2 && m.realized.policy_count === 1,
  `${mine(m).length} matured · ${m.realized.policy_count} paid`);
check('the realized figure still ignores the unpaid one',
  near(m.realized.irr, rowA.irr, 2e-3), `${pct(m.realized.irr)} vs ${pct(rowA.irr)}`);
check('while the assumed figure moves, because it folds it in',
  !near(m.portfolio.irr, m.realized.irr, 1e-3),
  `realized ${pct(m.realized.irr)} · assumed ${pct(m.portfolio.irr)}`);
check('and the assumed one reads higher, which is the whole reason to separate them',
  m.portfolio.irr > m.realized.irr,
  `assumed ${pct(m.portfolio.irr)} vs realized ${pct(m.realized.irr)}`);

console.log('\nPAY THE SECOND AND THEY CONVERGE');
await api(admin, `/policies/${b.id}/proceeds`, { method: 'PUT', body: {
  proceeds_amount: 2000000, proceeds_received_on: iso(-10) } });
m = await load();
check('both are counted as paid', m.realized.policy_count === 2, String(m.realized.policy_count));
check('and the two figures are now the same, because nothing is being assumed',
  near(m.realized.irr, m.portfolio.irr),
  `${pct(m.realized.irr)} vs ${pct(m.portfolio.irr)}`);

console.log('\nIT IS ONE RATE OVER THE FLOWS, NOT AN AVERAGE OF THE RATES');
/* The two policies are deliberately different sizes. A mean of the two
   per-policy rates would weight the $400k position the same as the $900k
   one, which is what this checks against. */
const rows = mine(m);
const mean = rows.reduce((s, r) => s + Number(r.irr), 0) / rows.length;
check('the portfolio rate is not the mean of the row rates',
  !near(m.realized.irr, mean, 1e-4),
  `portfolio ${pct(m.realized.irr)} · mean of rows ${pct(mean)}`);
check('and it sits inside the range they span',
  m.realized.irr > Math.min(...rows.map((r) => Number(r.irr)))
  && m.realized.irr < Math.max(...rows.map((r) => Number(r.irr))),
  rows.map((r) => `${r.policy_number} ${pct(Number(r.irr))}`).join(' · '));

console.log('\nCLEARING THE CHEQUE PUTS IT BACK');
await api(admin, `/policies/${b.id}/proceeds`, { method: 'PUT', body: {
  proceeds_amount: null, proceeds_received_on: null } });
m = await load();
check('one paid again', m.realized.policy_count === 1, String(m.realized.policy_count));
check('and the realized rate is back to the one policy that was paid',
  near(m.realized.irr, rowA.irr, 2e-3), `${pct(m.realized.irr)} vs ${pct(rowA.irr)}`);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL REALIZED IRR CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
