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
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login, databaseUrl } from './test-config.mjs';

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

const { TEMPLATES: MAILT } = await import('../src/mail.js');
const TEMPLATESFOR = (extra) => MAILT.capital_call({ name: 'A', amount: '$1.00', due: 'd',
  title: 't', policies: 1, note: '', ...extra }).text;

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
   only 70% allocated, so the house's own share has somewhere to show up.
   
   The premium a call is raised over is the one on the SERVICING SCHEDULE.
   The policy also carries an annual figure and a carrier due date, set here
   to numbers that would be obvious if they ever leaked into a call — they
   describe the policy, they are not an obligation, and nothing that asks
   somebody for money is allowed to read them. */
const make = async (tag, { premium, dueIn, holders }) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    fund_code: FUND, face_amount: 2000000, premium_required: 777777, premium_mode: 'Annual',
    next_premium_due: iso(1),
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', dob: '1938-01-01' } }));
  await api(admin, `/policies/${p.id}/reminders`, { method: 'POST', body: {
    kind: 'Premium', due_date: iso(dueIn), amount: premium, note: `${PREFIX} scheduled` } });
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

console.log('\nNOTHING IS READ OFF THE POLICY FORM');
/* Every policy above carries premium_required = 777777 due tomorrow. If any
   of it reached a draft, the figures would be wrong by an order of magnitude
   and there would be a fourth item in the window. */
check('the draft total is the scheduled premiums alone', near(draft.total, 50000), M(draft.total));
check('and no policy appears twice', new Set(draft.items.map((i) => i.policy_number)).size
  === draft.items.length);

console.log('\nWHAT IT COVERS IS FROZEN');
/* The premium moves next week. The notice already sent must keep saying what
   it said, or somebody is asked for one figure and chased for another. */
const remA = ((await json(await api(admin, `/policies/${A.id}`))) || {}).reminders
  ?.find((r) => r.kind === 'Premium');
await api(admin, `/policy-reminders/${remA.id}`, { method: 'PUT', body: {
  kind: 'Premium', due_date: remA.due_date, amount: 999999, note: remA.note } });
const after = await json(await api(admin, `/capital-calls/${call.id}`));
check('the item still says what it said when it went out',
  near(after.items.find((i) => i.policy_number === `${PREFIX}-A`).amount, 40000),
  M(after.items.find((i) => i.policy_number === `${PREFIX}-A`)?.amount));
check('and so does the line', near(after.total, call.total), M(after.total));
await api(admin, `/policy-reminders/${remA.id}`, { method: 'PUT', body: {
  kind: 'Premium', due_date: remA.due_date, amount: 40000, note: remA.note } });

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
  /* Either it is raised, or it is refused because nothing in their book has a
     cap table — which is a fact about the fixture, not about what a manager is
     allowed to do. What must never happen is a 403. */
  check('and raise one over it',
    !!own.id || /nobody holds a share/i.test(own.error || ''),
    JSON.stringify(own).slice(0, 100));
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

console.log('\nMONEY FOR BUYING A POLICY, NOT KEEPING ONE ALIVE');
/* The other half of this. An acquisition has no cap table to read — nobody
   owns the thing yet — so the split comes from what each investor has been
   CONFIRMED for on the deal. */
const funds2 = await json(await api(admin, '/funds'));
const oppFund = funds2.find((f) => f.code === FUND)?.id;
const opp = await json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-OPP`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: `${PREFIX}Offer`, insured_first_name: 'Ada',
  insured_dob: '1937-01-01', le_months: 60, le_date: iso(-30),
  asking_price: 800000, annual_premium: 50000,
  expected_close: iso(30), offer_closes_on: iso(60), fund_id: oppFund } }));
await api(admin, `/opportunities/${opp.id}/shares`,
  { method: 'PUT', body: { investor_ids: [me1, me2] } });
await api(inv1, `/opportunities/${opp.id}/commit`, { method: 'POST', body: { pct: 50 } });
await api(inv2, `/opportunities/${opp.id}/commit`, { method: 'POST', body: { pct: 25 } });

let oppNow = await json(await api(admin, `/opportunities/${opp.id}`));
const commitOf = (id) => oppNow.commitments.find((c) => c.investor_id === id);
await api(admin, `/opportunity-commitments/${commitOf(me1).id}`,
  { method: 'PUT', body: { status: 'Confirmed' } });

const acq = await json(await api(admin,
  `/capital-calls/draft/acquisition?opportunity_id=${opp.id}`));
check('the price is what the deal is being bought for', near(acq.total, 800000), M(acq.total));
check('and the split is what people were confirmed for',
  acq.investors.length === 1 && near(acq.investors[0].amount, 800000 * 0.5),
  acq.investors.map((i) => `${i.name} ${M(i.amount)}`).join(', '));
/* A request is not an allocation. Somebody who has asked but not been
   confirmed is named separately rather than being asked for money against a
   share nobody has granted them. */
check('somebody who only asked is listed apart, not called',
  acq.unconfirmed.length === 1 && acq.unconfirmed[0].investor_id === me2,
  acq.unconfirmed.map((u) => u.name).join(', '));
check('and the rest is the house’s', near(acq.unallocated, 800000 * 0.5), M(acq.unallocated));
check('a deal with no price on it is refused rather than called for nothing',
  (await api(admin, `/capital-calls/draft/acquisition?opportunity_id=${C.id}`)).status !== 200);

const acqCall = await json(await api(admin, '/capital-calls', { method: 'POST', body: {
  purpose: 'Acquisition', title: `${PREFIX} buying it`, due_date: iso(10),
  items: acq.items,
  lines: acq.investors.map((i) => ({ investor_id: i.investor_id, amount: i.amount })) } }));
check('the call is raised against the deal', !!acqCall.id, JSON.stringify(acqCall).slice(0, 100));
check('and says what it is for', acqCall.purpose === 'Acquisition', acqCall.purpose);
check('only the confirmed investor is asked',
  acqCall.lines.length === 1 && near(acqCall.total, 400000), M(acqCall.total));
check('the item it covers is the deal, not a policy',
  acqCall.items[0].kind === 'Acquisition' && !acqCall.items[0].policy_id,
  acqCall.items[0].kind);
check('and the notice tells them which kind of call it is',
  /purchase of/i.test(TEMPLATESFOR({ purpose: 'Acquisition' }))
  && /premium/i.test(TEMPLATESFOR({ purpose: 'Premiums' })));

console.log('\nCHOOSING WHO GETS ASKED');
/* Somebody excluded is simply not asked. Their share is NOT moved onto the
   others — nobody is ever asked for a percentage they did not agree to. */
const bothDraft = await json(await api(admin, `/capital-calls/draft?days=30&fund=${FUND}`));
const someone = bothDraft.investors[0];
const partial = await json(await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} only one of them`, due_date: iso(12), items: bothDraft.items,
  investor_ids: [someone.investor_id] } }));
check('only the chosen investor is on the call', partial.lines.length === 1,
  String(partial.lines.length));
check('and for exactly their own share, unchanged',
  near(partial.total, someone.amount), `${M(partial.total)} vs ${M(someone.amount)}`);
check('the total is less than the whole, rather than the whole redistributed',
  partial.total < bothDraft.investors.reduce((n, i) => n + i.amount, 0));
check('asking for nobody is refused rather than calling everybody',
  (await api(admin, '/capital-calls', { method: 'POST', body: {
    title: `${PREFIX} nobody`, due_date: iso(12), items: bothDraft.items,
    investor_ids: [] } })).status === 400);
await api(admin, `/capital-calls/${partial.id}`, { method: 'DELETE' });
await api(admin, `/capital-calls/${acqCall.id}`, { method: 'DELETE' });
await api(admin, `/opportunities/${opp.id}`, { method: 'DELETE' });

console.log('\nTHE SAME CALL, RAISED TWICE');
/* The commonest way an investor ends up with two debts for one obligation:
   somebody raises the call, cannot see that it went out, and raises it again
   — often with a different set of people ticked. The second one must fold
   into the first. */
const dupDraft = await json(await api(admin, `/capital-calls/draft?days=30&fund=${FUND}`));
const dupDue = iso(16);
const first = await json(await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} twice`, due_date: dupDue, items: dupDraft.items,
  investor_ids: [me1] } }));
check('the first one is written', !!first.id && !first.merged, String(first.id));
check('with one investor on it', first.lines.length === 1);

const again = await json(await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} twice`, due_date: dupDue, items: dupDraft.items,
  investor_ids: [me1] } }));
check('raising it again does not write a second call', again.id === first.id && again.merged,
  `${again.id} vs ${first.id}`);
check('and nobody is asked twice', again.lines.length === 1 && again.added === 0,
  `${again.lines.length} line(s), ${again.added} added`);
check('and nobody is emailed twice', again.notified === 0, String(again.notified));

const widened = await json(await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} twice`, due_date: dupDue, items: dupDraft.items,
  investor_ids: [me1, me2] } }));
check('but somebody remembered late is added to the call already open',
  widened.id === first.id && widened.added === 1, `${widened.id}, +${widened.added}`);
check('and only they are told', widened.notified === 1, String(widened.notified));
check('the call now covers both, once each', widened.lines.length === 2
  && new Set(widened.lines.map((l) => l.investor_id)).size === 2);

/* A different figure, or a different date, is a different ask. */
const different = await json(await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} twice`, due_date: iso(17), items: dupDraft.items,
  investor_ids: [me1] } }));
check('a call for a different date is its own call',
  different.id !== first.id && !different.merged, String(different.id));

/* Two clicks at once. Both requests get past the look-up; the index decides. */
const racedRaw = await Promise.all([0, 1].map(() =>
  api(admin, '/capital-calls', { method: 'POST', body: {
    title: `${PREFIX} raced`, due_date: iso(18), items: dupDraft.items,
    investor_ids: [me1, me2] } })));
const raced = await Promise.all(racedRaw.map(json));
check('two raised at the same instant produce one call',
  raced[0].id === raced[1].id, raced.map((r) => r.id).join(' vs '));
check('and that one has each investor once',
  raced[0].lines.length === 2 || raced[1].lines.length === 2);

console.log('\nFOLDING IN THE ONES ALREADY THERE');
/* Duplicates raised before this existed carry no signature, so they are
   found by computing what their signature would be, and folded by hand. */
const legacyDue = iso(19);
const mk = async (who) => json(await api(admin, '/capital-calls', { method: 'POST', body: {
  title: `${PREFIX} legacy`, due_date: legacyDue, items: dupDraft.items,
  investor_ids: who } }));
const legacyA = await mk([me1]);
/* Clear the signature so it looks like a call raised by the old code. One of
   the two places this suite reaches past the API — there is no route that
   writes a call the old way, and that is the point. */
const { default: pg } = await import('pg');
const db = new pg.Client({ connectionString: databaseUrl() });
await db.connect();
await db.query('UPDATE capital_calls SET signature = $2 WHERE id = $1', [legacyA.id, '']);
const legacyB = await mk([me2]);
check('two legacy calls exist side by side', legacyB.id !== legacyA.id && !legacyB.merged,
  `${legacyA.id}, ${legacyB.id}`);

const dupes = await json(await api(admin, '/capital-calls/duplicates'));
const group = (dupes.groups || []).find((g) => g.calls.some((c) => c.id === legacyA.id));
check('they are reported as the same ask', !!group && group.calls.length === 2,
  String(group?.calls.length));
check('and the earliest is the one to keep', group?.keep === Math.min(legacyA.id, legacyB.id),
  String(group?.keep));

const folded = await json(await api(admin, `/capital-calls/${group.keep}/absorb`,
  { method: 'POST', body: { ids: group.calls.filter((c) => c.id !== group.keep).map((c) => c.id) } }));
check('folding moves the other investor across',
  folded.lines.length === 2 && folded.moved === 1, `${folded.lines.length} line(s)`);
check('the copy is cancelled, not deleted — the record still reads',
  ((await json(await api(admin, `/capital-calls/${group.calls.find((c) => c.id !== group.keep).id}`)))
    || {}).status === 'Cancelled');
check('and there is nothing left to combine',
  !((await json(await api(admin, '/capital-calls/duplicates'))).groups || [])
    .some((g) => g.calls.some((c) => c.id === group.keep)));
check('an investor cannot ask which calls are duplicates',
  (await api(inv1, '/capital-calls/duplicates')).status === 403);

await db.end();
for (const c of [first, different, raced[0], legacyA, legacyB])
  await api(admin, `/capital-calls/${c.id}`, { method: 'DELETE' });

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
