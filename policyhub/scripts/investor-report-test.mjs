/* =====================================================================
   The investor statement, for the people who run the book.

   The portal answers "what do I hold". This answers the question a
   manager gets asked on the phone: what has this person put in, what do
   they own, what is coming out of their pocket next, what has it
   returned. Two things have to hold — every figure is that investor's
   percentage, and a manager only ever sees the part of it they are
   responsible for.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'INVRPT';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);

const wipe = async () => {
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

/* One investor, two policies in different entities, so the manager's copy
   and the admin's copy must differ. */
const investors = await json(await api(admin, '/investors'));
let subject = investors.find((i) => i.name === `${PREFIX} Holdings`);
if (!subject) subject = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Holdings`, investor_type: 'Trust', email: 'ops@example.com' } }));
for (const pos of (await json(await api(admin, `/investors/${subject.id}`))).positions || [])
  await api(admin, `/policy-investors/${pos.link_id}`, { method: 'DELETE' });

const mk = async (suffix, fundCode, pct, opts = {}) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Statement Life', product_type: 'UL',
    fund_code: fundCode, face_amount: 4000000, premium_required: 40000, premium_mode: 'Annual',
    next_premium_due: iso(45), acquisition_date: iso(-730), acquisition_cost: 600000,
    insured_last_name: `Holder${suffix}`, insured_first_name: 'Ida', dob: '1941-06-06',
    ...opts } }));
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-730), txn_type: 'Acquisition Cost', amount: 600000 } });
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-365), txn_type: 'Premium Payment', amount: 40000 } });
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-10), txn_type: 'Fee', amount: 2500 } });
  await api(admin, `/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: subject.id, pct, acquired_on: iso(-730) } });
  return p;
};
const own = await mk('1', 'LCG1', 25);
const other = await mk('2', 'LCG2', 40);
// A premium scheduled by hand has to appear beside the carrier's own date.
await api(admin, `/policies/${own.id}/reminders`, { method: 'POST', body: {
  due_date: iso(200), kind: 'Premium', amount: 46000, note: 'Step-up per the illustration' } });

console.log('AN ADMIN SEES THE WHOLE RELATIONSHIP');
const all = await json(await api(admin, `/reports/investors?investor_ids=${subject.id}`));
check('the statement is produced', all.investors?.length === 1, `${all.investors?.length}`);
const rep = all.investors[0];
check('naming the investor', rep.investor.name === `${PREFIX} Holdings`);
check('with both positions', rep.totals.position_count === 2, `${rep.totals.position_count}`);

// 25% of 4M plus 40% of 4M.
check('death benefit is their share of each policy',
  near(rep.totals.live_death_benefit, 4000000 * 0.25 + 4000000 * 0.40),
  String(rep.totals.live_death_benefit));
// (600,000 + 40,000 + 2,500) at 25%, and again at 40%.
check('capital paid in is their share of every ledger entry',
  near(rep.totals.invested, 642500 * 0.25 + 642500 * 0.40),
  String(rep.totals.invested));
check('premiums a year is their share too',
  near(rep.totals.annual_premium, 40000 * 0.25 + 40000 * 0.40),
  String(rep.totals.annual_premium));

const byKind = Object.fromEntries(rep.paid.map((x) => [x.kind, x.amount]));
check('the acquisition cost is broken out', near(byKind['Acquisition Cost'], 600000 * 0.65),
  String(byKind['Acquisition Cost']));
check('so are the premiums', near(byKind['Premium Payment'], 40000 * 0.65),
  String(byKind['Premium Payment']));
check('and the fees', near(byKind.Fee, 2500 * 0.65), String(byKind.Fee));
check('the parts add up to the whole',
  near(rep.paid.reduce((s, x) => s + x.amount, 0), rep.totals.invested));

console.log('\nWHAT IS DUE NEXT');
const dues = rep.upcoming.filter((u) => String(u.policy_number).startsWith(PREFIX));
check('both carrier dates are listed', dues.filter((u) => u.source !== 'scheduled').length === 2,
  dues.map((u) => `${u.date}:${u.source}`).join(' '));
check('and the one scheduled by hand', dues.some((u) => u.source === 'scheduled'));
check('soonest first', dues.every((u, i) => i === 0 || dues[i - 1].date <= u.date));
const own45 = dues.find((u) => u.policy_number === `${PREFIX}-1` && u.source !== 'scheduled');
check('each amount is their share', near(own45.amount, 40000 * 0.25), String(own45.amount));
check('with the full policy figure beside it', near(own45.amount_full, 40000));
check('and the twelve-month total is summed', rep.upcoming_12mo > 0,
  String(rep.upcoming_12mo));

console.log('\nA RATE, AND WHAT IT RESTS ON');
check('a portfolio IRR is solved', rep.totals.irr !== null, String(rep.totals.irr));
check('and one per position', rep.positions.every((p) => p.irr !== null),
  rep.positions.map((p) => p.irr).join(','));
check('each position states the percentage held',
  rep.positions.map((p) => p.pct).sort((a, b) => a - b).join(',') === '25,40');

console.log('\nA MANAGER SEES ONLY WHAT THEY RUN');
const pmRep = await json(await api(pm1, `/reports/investors?investor_ids=${subject.id}`));
const pmRow = (pmRep.investors || [])[0];
check('the manager gets a statement', !!pmRow, `${pmRep.investors?.length} investors`);
check('but only the position inside their entity',
  pmRow.totals.position_count === 1, `${pmRow.totals.position_count}`);
check('so the figures are theirs to answer for',
  near(pmRow.totals.invested, 642500 * 0.25), String(pmRow.totals.invested));
check('the other entity is absent entirely',
  !pmRow.positions.some((p) => p.policy_number === `${PREFIX}-2`));

console.log('\nINVESTORS CANNOT RUN IT AT ALL');
check('an investor is refused',
  (await api(inv1, '/reports/investors')).status === 403);
check('even for themselves',
  (await api(inv1, `/reports/investors?investor_ids=${subject.id}`)).status === 403);

console.log('\nFILTERS');
const oneFund = await json(await api(admin,
  `/reports/investors?investor_ids=${subject.id}&fund=LCG1`));
check('an owner-entity filter narrows it',
  oneFund.investors[0].totals.position_count === 1,
  String(oneFund.investors[0].totals.position_count));
const everyone = await json(await api(admin, '/reports/investors'));
check('asking for nobody in particular returns everybody',
  everyone.investors.length >= 2, `${everyone.investors.length}`);
check('each with their own totals',
  everyone.investors.every((x) => x.totals && x.investor?.name));

await api(admin, `/policies/${own.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-1` } });
await api(admin, `/policies/${other.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-2` } });
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL INVESTOR REPORT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
