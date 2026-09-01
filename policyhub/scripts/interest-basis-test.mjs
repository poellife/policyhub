/* =====================================================================
   Simple interest, compounded, or both.

   The desk prices in simple interest and the operating agreements are
   written in it, so that is what "Return" means here with no qualifier.
   An investor comparing a deal against a bond is holding a compounding
   rate in their head instead. Both are true of the same cash flows and
   on a fifteen-year hold they are very far apart, so the screen can say
   either — or both at once, which is the only reading that makes the gap
   visible.

   What has to hold:

     - both figures come down with every deal, so switching costs no
       request and the two can never disagree;
     - the compounding rate is genuinely the compounding rate: lower than
       simple interest on any multi-year hold, and the same number the
       shared IRR module produces;
     - the choice is remembered against the account, not the browser;
     - and it is a closed set — a preference nobody defined is refused.

   Idempotent: one fixture deal, removed first and last; the preference
   is put back to simple at the end.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';
import { analyzeFlows } from '../public/irr.js';

const PREFIX = 'INTBAS';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const near = (a, b, tol = 1e-9) => Math.abs(Number(a) - Number(b)) < tol;

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

/* A long hold, because that is where the two conventions separate. A deal
   that pays next year reads almost the same either way and would prove
   nothing. */
const opp = await json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Convention Life', product_type: 'UL',
  face_amount: 10000000, insured_last_name: 'Compounded', insured_first_name: 'Cass',
  insured_dob: '1958-05-01', insured_gender: 'M', insured_state: 'MI',
  le_months: 156, le_date: '2026-05-01',
  asking_price: 1500000, annual_premium: 180000,
  expected_close: '2026-10-01', offer_closes_on: '2027-04-30', fund_id: lcg1.id } }));

/* ------------------------------------------------------------------ *
 * Both figures, always
 * ------------------------------------------------------------------ */
console.log('BOTH READINGS COME DOWN WITH EVERY DEAL');
const listed = (await json(await api(admin, '/opportunities')))
  .find((x) => x.id === opp.id);
check('the list carries the simple rate', Number.isFinite(listed.rate_at_le),
  String(listed.rate_at_le));
check('and the compounding one beside it',
  Number.isFinite(listed.rate_at_le_compound), String(listed.rate_at_le_compound));

const detail = await json(await api(admin, `/opportunities/${opp.id}`));
const atLe = detail.analysis.scenarios.find((s) => s.offset_months === 0);
check('and so does every scenario on the detail',
  detail.analysis.scenarios.every((s) => s.compound_rate !== undefined),
  JSON.stringify(detail.analysis.scenarios.map((s) => s.compound_rate)));
check('the list and the detail agree about the deal at life expectancy',
  near(listed.rate_at_le, atLe.rate) && near(listed.rate_at_le_compound, atLe.compound_rate),
  `${listed.rate_at_le_compound} vs ${atLe.compound_rate}`);

/* ------------------------------------------------------------------ *
 * It is really the compounding rate
 * ------------------------------------------------------------------ */
console.log('\nAND THE SECOND ONE IS REALLY COMPOUNDING');
check('over a thirteen-year hold it is well below simple interest',
  atLe.compound_rate < atLe.rate,
  `simple ${(atLe.rate * 100).toFixed(2)}% vs compounded ${(atLe.compound_rate * 100).toFixed(2)}%`);
check('and not by a rounding amount — the gap is the whole point',
  atLe.rate - atLe.compound_rate > 0.05,
  `${((atLe.rate - atLe.compound_rate) * 100).toFixed(2)} points apart`);
check('it is positive on a profitable deal', atLe.compound_rate > 0,
  String(atLe.compound_rate));

/* The same flows through the shared module, so the screen and the report
   cannot drift apart from each other. */
const own = analyzeFlows(atLe.flows);
check('it is the same figure the shared IRR module produces',
  near(own.compound_rate, atLe.compound_rate, 1e-9),
  `${own.compound_rate} vs ${atLe.compound_rate}`);
check('and so is the simple one', near(own.rate, atLe.rate, 1e-9));

console.log('\nTHE LATER IT PAYS, THE FURTHER APART THEY GET');
const early = detail.analysis.scenarios.find((s) => s.offset_months === -24);
const late = detail.analysis.scenarios.find((s) => s.offset_months === 24);
check('both conventions fall as the hold lengthens',
  early.rate > atLe.rate && atLe.rate > late.rate
  && early.compound_rate > atLe.compound_rate && atLe.compound_rate > late.compound_rate,
  `simple ${early.rate.toFixed(3)}/${atLe.rate.toFixed(3)}/${late.rate.toFixed(3)}`);
/* Both fall, but simple interest falls further, so the two readings
   converge in percentage-point terms as the hold lengthens. The RATIO
   between them goes the other way, which is why the pair is shown rather
   than a single "adjusted" figure. */
check('and they converge in points as the hold lengthens',
  (late.rate - late.compound_rate) < (early.rate - early.compound_rate),
  `early gap ${((early.rate - early.compound_rate) * 100).toFixed(1)} → `
  + `late gap ${((late.rate - late.compound_rate) * 100).toFixed(1)}`);

/* ------------------------------------------------------------------ *
 * The preference
 * ------------------------------------------------------------------ */
console.log('\nTHE CHOICE IS REMEMBERED AGAINST THE ACCOUNT');
for (const shown of ['compound', 'both', 'simple']) {
  const put = await api(admin, '/me/prefs/interest_shown', {
    method: 'PUT', body: { shown } });
  const back = (await json(await api(admin, '/me/prefs')))?.interest_shown?.shown;
  check(`"${shown}" is stored and read back`, put.ok && back === shown, `${put.status} ${back}`);
}

console.log('\nAND IT IS A CLOSED SET');
const junk = await api(admin, '/me/prefs/interest_shown', {
  method: 'PUT', body: { shown: 'annualised-ish' } });
check('a value nobody defined is refused', junk.status === 400, String(junk.status));
check('and the stored one is untouched',
  (await json(await api(admin, '/me/prefs')))?.interest_shown?.shown === 'simple');

console.log('\nIT IS A WAY OF READING, NOT A PERMISSION');
const invPut = await api(inv1, '/me/prefs/interest_shown', {
  method: 'PUT', body: { shown: 'both' } });
check('an investor may set their own, like any other display preference',
  invPut.ok, String(invPut.status));
await api(inv1, '/me/prefs/interest_shown', { method: 'PUT', body: { shown: 'simple' } });

/* An investor's copy of the deal is unchanged either way: the figures are
   the same two numbers, and which one is drawn is decided in the browser. */
const invSeen = await json(await api(inv1, '/opportunities'));
check('and it changes nothing about what the server sends anybody',
  invSeen.every((o) => o.rate_at_le_compound !== undefined));

await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All interest-basis checks passed.'}`);
process.exit(fails.length ? 1 : 0);
