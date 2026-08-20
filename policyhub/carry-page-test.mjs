/* =====================================================================
   The Carried interest page.

   One screen, admin only, that answers three questions: what has been
   earned, what would be due if everything settled today, and which
   entity each figure belongs to.

   The distinction that matters most is earned versus projected. Earned is
   carried interest on a claim the carrier has already paid — money. The
   rest is arithmetic on a case that has not settled. A single total
   mixing the two reports cash that has not arrived, so the endpoint keeps
   them in separate fields and this suite checks that each is built from
   exactly the rows it claims.

   The rest is access: the page is for admins, and a manager, an editor or
   an investor asking the API directly must be refused, not merely have
   the button hidden.

   Idempotent: its own entities, its own policies, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'CARRYPG';
const FUND = 'CPGFND';
const FEE = 'CPGFEE';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 0.01) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) < tol;
const M = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const admin = await login(ADMIN.email, ADMIN.password);
const manager = await login(MANAGER1.email, MANAGER1.password);
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
  for (const f of ((await json(await api(admin, '/funds'))) || [])
    .filter((x) => x.code === FUND || x.code === FEE))
    await api(admin, `/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();

await api(admin, '/funds', { method: 'POST', body: {
  code: FUND, name: 'Carry page fixture', charges_carry: true, carry_pct: 10 } });
await api(admin, '/funds', { method: 'POST', body: {
  code: FEE, name: 'Carry page fee only', charges_carry: false } });

const make = async (tag, { fund, cost, prem, boughtAgo, premAgo, benefit, diedAgo, paid, paidAgo }) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    fund_code: fund, face_amount: benefit, premium_required: prem || 0, premium_mode: 'Annual',
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', dob: '1936-03-03' } }));
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-boughtAgo), txn_type: 'Acquisition Cost', amount: cost } });
  if (prem) await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-premAgo), txn_type: 'Premium Payment', amount: prem } });
  await api(admin, `/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: me, pct: 100, acquired_on: iso(-boughtAgo) } });
  if (diedAgo !== undefined) {
    const ins = (await json(await api(admin, `/insureds?search=${PREFIX}${tag}`))) || [];
    const person = (ins.rows || ins).find((i) => String(i.last_name) === `${PREFIX}${tag}`);
    await api(admin, `/insureds/${person.id}`, { method: 'PUT', body: { date_of_death: iso(-diedAgo) } });
  }
  if (paid) await api(admin, `/policies/${p.id}/proceeds`, { method: 'PUT', body: {
    proceeds_amount: paid, proceeds_received_on: iso(-paidAgo) } });
  return p;
};

/* A: paid claim — $600,000 + $40,000 in, $1,000,000 back.
     profit 360,000 · carry 36,000 · EARNED
   B: paid claim that lost money — $900,000 in, $500,000 back. carry 0.
   C: still running — $400,000 in, $2,000,000 benefit.
     profit 1,600,000 · carry 160,000 · PROJECTED
   D: still running inside an entity managed for a fee. carry 0.          */
await make('A', { fund: FUND, cost: 600000, prem: 40000, boughtAgo: 1000, premAgo: 400,
  benefit: 1000000, diedAgo: 90, paid: 1000000, paidAgo: 30 });
await make('B', { fund: FUND, cost: 900000, boughtAgo: 800,
  benefit: 500000, diedAgo: 60, paid: 500000, paidAgo: 20 });
await make('C', { fund: FUND, cost: 400000, boughtAgo: 500, benefit: 2000000 });
await make('D', { fund: FEE, cost: 500000, boughtAgo: 600, benefit: 1500000 });

const EARNED = 36000, PROJECTED = 160000;
const get = async (qs = '') => json(await api(admin, `/carry?${qs}`));

console.log('THE PAGE IS FOR ADMINS AND NOBODY ELSE');
check('an admin may read it', (await api(admin, '/carry')).status === 200);
check('a manager is refused', (await api(manager, '/carry')).status === 403,
  String((await api(manager, '/carry')).status));
check('an investor is refused', (await api(inv, '/carry')).status === 403,
  String((await api(inv, '/carry')).status));

const editorEmail = 'carry-page-editor@test.local';
const editorPw = scratchPassword('carrypage');
const stale = ((await json(await api(admin, '/users'))) || []).find((u) => u.email === editorEmail);
if (stale) await api(admin, `/users/${stale.id}`, { method: 'DELETE' });
const editor = await json(await api(admin, '/users', { method: 'POST', body: {
  email: editorEmail, password: editorPw, full_name: 'Carry Page Editor', role: 'editor' } }));
const editorCookie = await login(editorEmail, editorPw);
check('an editor, who may change policies, still may not read it',
  (await api(editorCookie, '/carry')).status === 403,
  String((await api(editorCookie, '/carry')).status));
await api(admin, `/users/${editor.id}`, { method: 'DELETE' });

console.log('\nA STATUS IT DOES NOT KNOW IS REFUSED, NOT GUESSED');
/* The filter names on screen — active, matured — are not the words the
   query layer uses. A mistranslation used to fall through to "everything",
   which reads as a working filter and is not one. */
check('an unknown status is a 400', (await api(admin, '/carry?status=inforce')).status === 400);
check('with a message naming what is allowed',
  /active.*matured.*all/i.test((await json(await api(admin, '/carry?status=inforce'))).error || ''),
  (await json(await api(admin, '/carry?status=inforce'))).error);
check('no status at all means everything', (await get()).status === 'all');

console.log('\nWHAT HAS BEEN EARNED, AND WHAT HAS NOT');
const all = await get(`fund=${FUND}`);
check('all three of the entity’s policies are listed', all.rows.length === 3,
  String(all.rows.length));
check('earned is the ten per cent on the claim that was paid',
  near(all.totals.earned, EARNED), `${M(all.totals.earned)} vs ${M(EARNED)}`);
check('projected is the ten per cent on the case still running',
  near(all.totals.projected, PROJECTED), `${M(all.totals.projected)} vs ${M(PROJECTED)}`);
check('the two are separate fields, never one number',
  'earned' in all.totals && 'projected' in all.totals &&
  !Object.keys(all.totals).some((k) => /^(total|combined)$/.test(k)),
  Object.keys(all.totals).join(', '));
check('earned adds up the rows marked earned and no others',
  near(all.totals.earned, all.rows.filter((r) => r.earned).reduce((s, r) => s + r.carry, 0)));
check('and projected adds up the rest',
  near(all.totals.projected, all.rows.filter((r) => !r.earned).reduce((s, r) => s + r.carry, 0)));

const A = all.rows.find((r) => r.policy_number === `${PREFIX}-A`);
const B = all.rows.find((r) => r.policy_number === `${PREFIX}-B`);
const C = all.rows.find((r) => r.policy_number === `${PREFIX}-C`);
check('the paid case is marked earned', A.earned === true);
check('with the whole-policy profit behind it', near(A.gross_profit, 360000), M(A.gross_profit));
check('and the investors keep the other ninety per cent',
  near(A.net_profit, 324000), M(A.net_profit));
check('the case that lost money carries none', near(B.carry, 0), M(B.carry));
check('and is still shown, so the loss is not hidden by the filter', !!B);
check('the live case is not marked earned', C.earned === false);
check('though its rate is quoted the same way', near(C.carry, PROJECTED), M(C.carry));

console.log('\nLARGEST FIRST');
check('the rows run from the biggest amount down',
  all.rows.every((r, i) => i === 0 || all.rows[i - 1].carry >= r.carry),
  all.rows.map((r) => Math.round(r.carry)).join(' · '));

console.log('\nTHE STATUS FILTER PICKS THE BOOK, NOT A SUBSET OF IT');
const matured = await get(`status=matured&fund=${FUND}`);
check('matured shows only the two settled cases', matured.rows.length === 2,
  matured.rows.map((r) => r.policy_number).join(', '));
check('its earned figure is the same money as before',
  near(matured.totals.earned, EARNED), M(matured.totals.earned));
check('and nothing is projected on a book that has already settled',
  near(matured.totals.projected, 0), M(matured.totals.projected));

const active = await get(`status=active&fund=${FUND}`);
check('still running shows only the live case', active.rows.length === 1,
  active.rows.map((r) => r.policy_number).join(', '));
check('nothing has been earned on it yet', near(active.totals.earned, 0), M(active.totals.earned));
check('and the projection is the whole of it',
  near(active.totals.projected, PROJECTED), M(active.totals.projected));
check('the two halves add back to the whole',
  near(matured.rows.length + active.rows.length, all.rows.length));

console.log('\nBY ENTITY');
check('one entity, because the filter asked for one', all.byFund.length === 1,
  all.byFund.map((f) => f.fund_code).join(', '));
check('carrying the rate from its agreement', Number(all.byFund[0].carry_pct) === 10,
  String(all.byFund[0].carry_pct));
check('and totals that match the rows underneath',
  near(all.byFund[0].earned, EARNED) && near(all.byFund[0].projected, PROJECTED),
  `${M(all.byFund[0].earned)} · ${M(all.byFund[0].projected)}`);
check('with the policy count to go with them', all.byFund[0].policies === 3,
  String(all.byFund[0].policies));

console.log('\nAN ENTITY MANAGED FOR A FEE IS COUNTED BUT CHARGES NOTHING');
const both = await get();
const feeRow = both.byFund.find((f) => f.fund_code === FEE);
const D = both.rows.find((r) => r.policy_number === `${PREFIX}-D`);
check('its policy is on the list', !!D);
check('at a rate of none', Number(D.carry_pct) === 0, String(D.carry_pct));
check('so it contributes nothing to either figure',
  near(D.carry, 0) && near(feeRow.earned, 0) && near(feeRow.projected, 0),
  `${M(D.carry)} · ${M(feeRow.earned)} · ${M(feeRow.projected)}`);
check('but its profit is still reported, because we manage it',
  near(D.gross_profit, 1000000), M(D.gross_profit));
check('and the header count says how many charge none',
  both.totals.policies - both.totals.charged >= 1,
  `${both.totals.charged} of ${both.totals.policies} charge`);

console.log('\nTHE ENTITY FILTER NARROWS AND SAYS SO');
check('unfiltered, both entities appear',
  both.byFund.some((f) => f.fund_code === FUND) && both.byFund.some((f) => f.fund_code === FEE));
check('filtered, only the one asked for does',
  all.byFund.every((f) => f.fund_code === FUND));
check('and the response repeats the filter back', all.fund === FUND, all.fund);

console.log('\nEVERY ROW CARRIES WHAT THE TABLE PRINTS');
const need = ['insured_last', 'insured_first', 'policy_number', 'carrier_name', 'fund_code',
  'status', 'carry_pct', 'basis', 'gross_return', 'gross_profit', 'carry', 'net_profit', 'earned'];
check('no column on screen is missing from the payload',
  need.every((k) => k in A), need.filter((k) => !(k in A)).join(', '));
check('the names are split, so the table can show surname first',
  A.insured_last === `${PREFIX}A` && A.insured_first === 'Ada',
  `${A.insured_last} / ${A.insured_first}`);
check('carry plus what the investors keep is the whole profit',
  all.rows.every((r) => near(r.carry + r.net_profit, r.gross_profit)));
check('and comes back less capital in is that profit',
  all.rows.every((r) => near(r.gross_return - r.basis, r.gross_profit)));

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL CARRY PAGE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
