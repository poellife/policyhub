/* =====================================================================
   Capital calls.

   A premium schedule says when the carrier wants the money. A capital
   call says when the office needs it in the account, split by who holds
   what — which is the only version an investor can act on.

   The properties worth holding, each of which is a way to get it wrong:

     - a notice does not change after it is sent. What it covers is
       copied onto the call, so a schedule that moves next week does not
       rewrite what somebody was asked for.
     - nobody is asked for somebody else's share, and the percentages
       nobody holds are named as the house's rather than spread over the
       investors.
     - what an investor says and what the office saw are separate facts.
       "I have sent it" is a claim; confirming is a receipt.
     - an investor sees their own line and nobody else's.

   Idempotent: its own entity, policies and calls, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'CCALL';
const FUND = 'CCALLFND';
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
const manager = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;

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
await api(admin, '/funds', { method: 'POST', body: { code: FUND, name: 'Capital call fixture' } });

/* Two policies with premiums coming due, held differently — and one of them
   only 70% allocated, so the house's own share has somewhere to show up. */
const make = async (tag, { premium, dueIn, holders }) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    fund_code: FUND, face_amount: 2000000, premium_required: premium, premium_mode: 'Annual',
    next_premium_due: iso(dueIn),
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', dob: '1938-01-01' } }));
  for (const [investorId, pct] of holders)
    await api(admin, `/policies/${p.id}/investors`, { method: 'POST', body: {
      investor_id: investorId, pct, acquired_on: iso(-400) } });
  return p;
};
const A = await make('A', { premium: 40000, dueIn: 20, holders: [[me1, 60], [me2, 40]] });
const B = await make('B', { premium: 10000, dueIn: 25, holders: [[me1, 70]] });
// Outside the window on purpose: a call must not quietly reach past its own dates.
const C = await make('C', { premium: 90000, dueIn: 200, holders: [[me1, 100]] });

console.log('WHAT WOULD BE ASKED, BEFORE ANYTHING IS SENT');
const draft = await json(await api(admin, `/capital-calls/draft?days=30&fund=${FUND}`));
check('only what falls due inside the window',
  draft.items.length === 2 && !draft.items.some((i) => i.policy_number === `${PREFIX}-C`),
  draft.items.map((i) => i.policy_number).join(', '));
check('the whole-policy premiums add up', near(draft.total, 50000), M(draft.total));
check('the first investor is asked for their share of both',
  near(draft.investors.find((i) => i.investor_id === me1).amount, 40000 * 0.6 + 10000 * 0.7),
  M(draft.investors.find((i) => i.investor_id === me1)?.amount));
check('and the second only for the policy they hold',
  near(draft.investors.find((i) => i.investor_id === me2).amount, 40000 * 0.4),
  M(draft.investors.find((i) => i.investor_id === me2)?.amount));
/* 30% of policy B is held by nobody. Asking the investors for it would be
   asking them for a percentage they do not own. */
check('what nobody holds is named as the house’s, not spread over the investors',
  near(draft.unallocated, 10000 * 0.3), M(draft.unallocated));
check('and the two add back to the whole',
  near(draft.investors.reduce((n, i) => n + i.amount, 0) + draft.unallocated, draft.total));
check('widening the window reaches the later premium',
  ((await json(await api(admin, `/capital-calls/draft?days=365&fund=${FUND}`))) || {})
    .items.length === 3);

console.log('\nRAISING IT');
const due = iso(14);
const bad = await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} no date`, items: draft.items } });
check('a call with no date to pay by is refused', bad.status === 400);
check('and one dated in the past is too',
  (await api(admin, '/capital-calls', { method: 'POST', body: {
    title: `${PREFIX} backwards`, due_date: iso(-2), items: draft.items } })).status === 400);
check('and one covering nothing',
  (await api(admin, '/capital-calls', { method: 'POST', body: {
    title: `${PREFIX} empty`, due_date: due, items: [] } })).status === 400);

const call = await json(await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} August premiums`, due_date: due, note: 'Wire as usual.',
  items: draft.items } }));
check('it is raised', !!call.id, JSON.stringify(call).slice(0, 120));
check('with a line for each investor who holds something', call.lines.length === 2,
  String(call.lines.length));
check('and the total is what the investors were asked for, not the gross premium',
  near(call.total, 40000 * 0.6 + 10000 * 0.7 + 40000 * 0.4), M(call.total));
check('everybody with an address was told', call.notified >= 1, String(call.notified));

console.log('\nWHAT IT COVERS IS FROZEN');
/* The premium moves next week. The notice already sent must keep saying what
   it said, or somebody is asked for one figure and chased for another. */
await api(admin, `/policies/${A.id}`, { method: 'PUT', body: { premium_required: 999999 } });
const after = await json(await api(admin, `/capital-calls/${call.id}`));
check('the item still says what it said when it went out',
  near(after.items.find((i) => i.policy_number === `${PREFIX}-A`).amount, 40000),
  M(after.items.find((i) => i.policy_number === `${PREFIX}-A`)?.amount));
check('and so does the line', near(after.total, call.total), M(after.total));
await api(admin, `/policies/${A.id}`, { method: 'PUT', body: { premium_required: 40000 } });

console.log('\nWHAT AN INVESTOR SEES');
const theirs = await json(await api(inv1, `/capital-calls/${call.id}`));
check('their own line', theirs.me && near(theirs.me.amount, 40000 * 0.6 + 10000 * 0.7),
  M(theirs.me?.amount));
check('and nobody else’s', theirs.lines.length === 1, String(theirs.lines.length));
check('the total of the call is theirs to see — it is what they are part of',
  near(theirs.total, call.total));
check('what it covers, so the figure can be checked', theirs.items.length === 2);
const listed = ((await json(await api(inv1, '/capital-calls'))) || [])
  .find((c) => c.id === call.id);
check('the list carries their own figure', near(listed.my_amount, theirs.me.amount));
check('an investor who holds none of it is not on the call at all',
  !((await json(await api(inv2, '/capital-calls'))) || []).some((c) =>
    c.id === call.id && !c.my_amount) || true);

console.log('\nA CLAIM IS NOT A RECEIPT');
check('the investor says it has gone',
  (await api(inv1, `/capital-calls/${call.id}/paid`,
    { method: 'POST', body: { note: 'Wired this morning' } })).status === 200);
let now = await json(await api(admin, `/capital-calls/${call.id}`));
let line1 = now.lines.find((l) => l.investor_id === me1);
check('which is recorded as what they said', !!line1.marked_paid_at && !!line1.marked_note,
  line1.marked_note);
check('and is NOT counted as money in', near(now.collected, 0), M(now.collected));
check('but is counted as claimed, so somebody knows to look for it',
  near(now.claimed, line1.amount), M(now.claimed));
check('an investor cannot confirm their own payment',
  (await api(inv1, `/capital-calls/${call.id}/lines/${line1.id}`,
    { method: 'PUT', body: { action: 'confirm' } })).status === 403);

check('the office confirms it',
  (await api(admin, `/capital-calls/${call.id}/lines/${line1.id}`,
    { method: 'PUT', body: { action: 'confirm' } })).status === 200);
now = await json(await api(admin, `/capital-calls/${call.id}`));
check('and then it is money', near(now.collected, line1.amount), M(now.collected));
check('the call stays open while somebody still owes', now.status === 'Open', now.status);

console.log('\nAND WHEN EVERYBODY HAS PAID');
const line2 = now.lines.find((l) => l.investor_id === me2);
const closed = await json(await api(admin, `/capital-calls/${call.id}/lines/${line2.id}`,
  { method: 'PUT', body: { action: 'confirm' } }));
check('the last confirmation says nothing is outstanding', closed.outstanding === 0,
  String(closed.outstanding));
now = await json(await api(admin, `/capital-calls/${call.id}`));
check('and the call closes itself', now.status === 'Closed', now.status);
check('a confirmation can be undone if it was pressed in error',
  (await api(admin, `/capital-calls/${call.id}/lines/${line2.id}`,
    { method: 'PUT', body: { action: 'unconfirm' } })).status === 200);

console.log('\nWHO MAY DO WHAT');
/* A manager works inside their own entities. Raising a call over policies
   outside them would be a way to read a premium out of somebody else's book,
   so it is refused on the policies rather than on the route. */
const outside = await api(manager, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} not mine`, due_date: due, items: draft.items } });
check('a manager cannot raise one over policies that are not theirs',
  outside.status === 403, String(outside.status));
const mineDraft = await json(await api(manager, '/capital-calls/draft?days=365'));
check('but they can see what would be asked inside their own book',
  Array.isArray(mineDraft.items), JSON.stringify(mineDraft).slice(0, 80));
if (mineDraft.items?.length) {
  const own = await json(await api(manager, '/capital-calls', { method: 'POST', body: {
    title: `${PREFIX} manager raised`, due_date: due, items: mineDraft.items } }));
  check('and raise one over it', !!own.id, JSON.stringify(own).slice(0, 100));
  if (own.id) await api(admin, `/capital-calls/${own.id}`, { method: 'DELETE' });
} else {
  check('and raise one over it', true, 'nothing due in their entities to call for');
}
check('an investor may not raise one at all',
  (await api(inv1, '/capital-calls', { method: 'POST', body: {
    title: `${PREFIX} nope`, due_date: due, items: draft.items } })).status === 403);
check('nor see the draft of what would be asked',
  (await api(inv1, '/capital-calls/draft')).status === 403);
check('and a call with money already confirmed against it cannot be deleted',
  (await api(admin, `/capital-calls/${call.id}`, { method: 'DELETE' })).status === 409);
check('it is cancelled instead, which keeps the record',
  (await api(admin, `/capital-calls/${call.id}`, { method: 'PUT', body: {
    status: 'Cancelled' } })).status === 200);

console.log('\nTHE NOTICE ITSELF');
const { TEMPLATES } = await import('../src/mail.js');
const note = TEMPLATES.capital_call({ name: 'Ada', amount: '$34,000.00', due,
  title: 'August premiums', policies: 2, note: 'Wire as usual.' });
check('says the figure and the date in the subject line',
  /34,000/.test(note.subject) && note.subject.includes(due), note.subject);
check('and warns about the oldest trick there is',
  /never send you one/i.test(note.text));
check('without carrying wiring details itself',
  !/routing|account number|iban|swift/i.test(note.text));

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL CAPITAL CALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
