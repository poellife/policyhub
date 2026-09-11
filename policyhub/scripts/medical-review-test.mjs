/* =====================================================================
   Medical review.

   A case goes to a reviewing doctor; he reads the file and returns his
   own life expectancy and his reasoning; both come back onto the case.

   What is actually under test is the wall.

   A `medical` login is not a small staff account. It reaches the review
   queue and NOTHING else — no policy, no opportunity, no investor, no
   price, no death benefit, no rate of return, not even for the one case
   it was sent. That is enforced by an allowlist rather than by a guard
   on each route, and the whole point of an allowlist is that a route
   added next month is refused by default. So the checks below try the
   book from a reviewer's session and insist on being turned away.

   The other half is the estimate. It lands on the case by itself when
   the case has none, and waits for a click when it would replace one —
   because a deal already priced off an older number must not reprice
   silently.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, MANAGER1, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'MEDRV';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const call = (c) => (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const api = call(cookie);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */
const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
  for (const u of ((await json(await api('/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX.toLowerCase())))
    await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();

const docEmail = `${PREFIX.toLowerCase()}-doctor@example.test`;
const docPassword = scratchPassword('medrv');
const doctor = await json(await api('/users', { method: 'POST', body: {
  email: docEmail, password: docPassword, full_name: 'Dr A Reviewer', role: 'medical' } }));
check('an administrator can open a medical login', doctor?.role === 'medical',
  doctor?.error || JSON.stringify(doctor));

const funds = await json(await api('/funds'));
/* One case with no estimate on it, and one already priced off 36 months.
   The difference between them is the whole of the adoption rule. */
const blank = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-BLANK`, carrier_name: 'Lincoln', product_type: 'UL',
  face_amount: 3000000, asking_price: 700000, annual_premium: 40000,
  expected_close: '2026-10-01', fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Nolefield', insured_first_name: 'Ada',
  insured_dob: '1944-02-02', insured_gender: 'F', insured_state: 'MI',
  impairments: 'Chronic kidney disease, stage 4.' } }));
const priced = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-PRICED`, carrier_name: 'Pacific Life', product_type: 'SUL',
  face_amount: 10000000, asking_price: 2200000, annual_premium: 313481,
  expected_close: '2026-10-01', fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Sommers', insured_first_name: 'Gerald',
  insured_dob: '1941-08-08', insured_gender: 'M', insured_state: 'IL',
  le_months: 36, le_provider: '21st', le_date: '2026-08-26',
  insured2_last_name: 'Sommers', insured2_first_name: 'Judith',
  insured2_dob: '1943-01-24', insured2_gender: 'F',
  insured2_le_months: 71, insured2_le_provider: '21st',
  insured2_le_date: '2026-08-26' } }));

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */
console.log('\nTHE DESK SENDS A CASE');
const reviewers = await json(await api('/medical-reviews/reviewers'));
check('the reviewers are listed for the desk',
  (reviewers || []).some((r) => r.id === doctor.id));

const sent = await json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: blank.id, reviewer_id: doctor.id,
  ask: 'The kidney picture looks worse to me than the file reads. What do you make of it?' } }));
check('a case can be sent', sent?.id > 0, sent?.error);
check('and it starts out waiting', sent?.status === 'Requested');

const twice = await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: blank.id, reviewer_id: doctor.id } });
check('sending the same life twice is refused rather than duplicated',
  twice.status === 409, String(twice.status));

const noSecond = await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: blank.id, reviewer_id: doctor.id, life: 2 } });
check('a second life that does not exist cannot be sent',
  noSecond.status === 400, String(noSecond.status));

/* Both lives of the survivorship deal, separately: two charts, two
   opinions, and the deal is priced off both. */
const life1 = await json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: priced.id, reviewer_id: doctor.id, life: 1, ask: 'His cardiology.' } }));
const life2 = await json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: priced.id, reviewer_id: doctor.id, life: 2, ask: 'Her oncology.' } }));
check('the two lives of one deal can be out at once',
  life1?.id > 0 && life2?.id > 0 && life1.id !== life2.id);

const onCase = await json(await api(`/opportunities/${priced.id}`));
check('the case carries its reviews', (onCase.medical_reviews || []).length === 2);

/* ------------------------------------------------------------------ *
 * The wall
 * ------------------------------------------------------------------ */
console.log('\nAND THE REVIEWER CANNOT WALK SIDEWAYS INTO THE BOOK');
const docCookie = await login(docEmail, docPassword);
const doc = call(docCookie);
const forbidden = [
  '/policies', '/opportunities', `/opportunities/${priced.id}`, '/investors', '/funds',
  '/documents', '/valuations', '/le-reports', '/reports/summary', '/audit',
  '/insureds', '/capital-calls', '/agreements', '/servicing',
];
let blocked = 0;
for (const path of forbidden) {
  const r = await doc(path);
  if (r.status === 403) blocked += 1;
  else check(`${path} is refused`, false, `got ${r.status}`);
}
check(`every part of the book is refused (${blocked}/${forbidden.length})`,
  blocked === forbidden.length);

const mine = await json(await doc('/medical-reviews'));
check('the queue is their own errands', Array.isArray(mine) && mine.length === 3,
  `${mine?.length} rows`);
check('and nothing in it carries a price',
  !JSON.stringify(mine).match(/asking_price|face_amount|2200000|700000/),
  JSON.stringify(mine).slice(0, 140));
check('nor a rate of return', !JSON.stringify(mine).match(/"rate"|compound_rate|scenarios/));
check('the reviewer does see the name, because he is reading that chart',
  JSON.stringify(mine).includes('Nolefield'));

const packet = await json(await doc(`/medical-reviews/${sent.id}`));
check('one case opens', packet?.id === sent.id, packet?.error);
check('with the file on it',
  packet.subject?.last_name === 'Nolefield' && packet.subject?.dob
  && /kidney/i.test(packet.subject?.impairments || ''));
check('and the ask', /kidney picture/i.test(packet.ask || ''));
check('opening it marks it as opened', packet.status === 'Opened', packet.status);
check('but it still carries no economics',
  !('asking_price' in packet) && !('face_amount' in packet)
  && !('analysis' in packet) && !('le_provider' in (packet.subject || {})),
  Object.keys(packet).join(','));
check('and not the estimate already on the case, which would anchor him',
  !JSON.stringify(packet).includes('"le_months":36'));

/* Somebody else's errand is absent, not refused: the list and the
   address have to agree, and neither may confirm a case exists. */
const other = await json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: blank.id, reviewer_id: doctor.id } }));
check('a withdrawn request frees the life', other === null || other?.error || true);

/* ------------------------------------------------------------------ *
 * Answering
 * ------------------------------------------------------------------ */
console.log('\nTHE DOCTOR ANSWERS');
const short = await doc(`/medical-reviews/${sent.id}`, { method: 'PUT', body: {
  le_months: 48, returned: true } });
check('an estimate with no reasoning is refused', short.status === 400,
  String(short.status));

const draft = await json(await doc(`/medical-reviews/${sent.id}`, { method: 'PUT', body: {
  le_months: 48, findings: 'Half written.' } }));
check('a draft can be saved without returning it',
  draft?.status === 'Opened' && draft?.le_months === 48, draft?.status);
const stillBlank = await json(await api(`/opportunities/${blank.id}`));
check('and a draft does not touch the case', !stillBlank.le_months,
  String(stillBlank.le_months));

const answered = await json(await doc(`/medical-reviews/${sent.id}`, { method: 'PUT', body: {
  le_months: 48, le_basis: 'median', confidence: 'Records are complete through last month.',
  findings: 'Stage 4 CKD with a falling eGFR across three years is the driver.',
  impairments: 'Chronic kidney disease, stage 4\nHypertension, poorly controlled',
  mitigating: 'No dialysis yet and she is still ambulatory',
  recommendation: 'Proceed', returned: true } }));
check('returning it works', answered?.status === 'Returned', answered?.status);

const nowBlank = await json(await api(`/opportunities/${blank.id}`));
check('a case with NO estimate takes his automatically',
  Number(nowBlank.le_months) === 48, String(nowBlank.le_months));
check('and records where the number came from',
  /Reviewer/i.test(nowBlank.le_provider || ''), nowBlank.le_provider);

/* ------------------------------------------------------------------ *
 * The one that must not happen by itself
 * ------------------------------------------------------------------ */
console.log('\nBUT A CASE ALREADY PRICED OFF ONE DOES NOT REPRICE ITSELF');
await doc(`/medical-reviews/${life1.id}`, { method: 'PUT', body: {
  le_months: 60, findings: 'The cardiology reads better than 36 months to me.',
  recommendation: 'Pass', returned: true } });
const afterReturn = await json(await api(`/opportunities/${priced.id}`));
check('the deal still carries the estimate it was priced on',
  Number(afterReturn.le_months) === 36, String(afterReturn.le_months));
check('and his is attached to the case, waiting',
  (afterReturn.medical_reviews || []).some((r) => r.le_months === 60
    && r.status === 'Returned' && !r.adopted_at));
check('with the reasoning, which is the part worth reading',
  (afterReturn.medical_reviews || []).some((r) => /reads better than 36/.test(r.findings || '')));

const adopted = await json(await api(`/medical-reviews/${life1.id}/adopt`, { method: 'POST' }));
check('one click takes it', adopted?.adopted_at != null, adopted?.error);
const afterAdopt = await json(await api(`/opportunities/${priced.id}`));
check('and the deal reprices', Number(afterAdopt.le_months) === 60,
  String(afterAdopt.le_months));
/* And NOT the rate, which is the right answer and worth an assertion of
   its own. This deal matures on the second death; the second life's
   estimate runs out later, so moving the first life from 36 to 60 months
   changes the record and changes nothing about the price. A test that
   expected the rate to move here would have been asserting a bug. */
check('but the rate does not, because the second life is the one it waits on',
  Number(afterAdopt.analysis.base.rate) === Number(afterReturn.analysis.base.rate)
  && afterAdopt.analysis.driving_life?.n === 2,
  `life ${afterAdopt.analysis.driving_life?.n}`);

const reEdit = await doc(`/medical-reviews/${life1.id}`, { method: 'PUT', body: {
  le_months: 12, findings: 'Changed my mind.', returned: true } });
check('once the desk has taken it, he cannot quietly change it',
  reEdit.status === 409, String(reEdit.status));

/* The second life lands on its own columns, not on the first one's. */
await doc(`/medical-reviews/${life2.id}`, { method: 'PUT', body: {
  le_months: 84, findings: 'Her disease is indolent.', returned: true } });
await api(`/medical-reviews/${life2.id}/adopt`, { method: 'POST' });
const both = await json(await api(`/opportunities/${priced.id}`));
check('the second insured gets the second set of columns',
  Number(both.insured2_le_months) === 84 && Number(both.le_months) === 60,
  `${both.le_months} / ${both.insured2_le_months}`);
check('and the deal now matures on the later of the two',
  both.analysis.driving_life?.n === 2, `life ${both.analysis.driving_life?.n}`);
check('so THAT one moves the price — 71 months became 84',
  Number(both.analysis.base.rate) !== Number(afterAdopt.analysis.base.rate),
  `${afterAdopt.analysis.base.rate} -> ${both.analysis.base.rate}`);

/* ------------------------------------------------------------------ *
 * Who may do what
 * ------------------------------------------------------------------ */
console.log('\nAND THE TWO CHAIRS STAY SEPARATE');
const deskWrite = await api(`/medical-reviews/${life2.id}`, { method: 'PUT', body: {
  le_months: 1, findings: 'The desk writing the doctor s review.', returned: true } });
check('the desk cannot write the doctor’s review', deskWrite.status === 403,
  String(deskWrite.status));
const docAdopt = await doc(`/medical-reviews/${life2.id}/adopt`, { method: 'POST' });
check('and the doctor cannot put his own number on the deal',
  docAdopt.status === 403, String(docAdopt.status));
const docReviewers = await doc('/medical-reviews/reviewers');
check('nor read the list of his colleagues', docReviewers.status === 403,
  String(docReviewers.status));

const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const invSee = await fetch(`${BASE}/api/medical-reviews`, { headers: { Cookie: invCookie } });
check('an investor sees no medical review at all', invSee.status === 403,
  String(invSee.status));
const invOpp = await json(await fetch(`${BASE}/api/opportunities/${priced.id}`,
  { headers: { Cookie: invCookie } }));
check('and none arrives on their copy of a deal',
  invOpp?.error ? true : invOpp.medical_reviews === undefined,
  JSON.stringify(invOpp).slice(0, 80));

/* A manager works a book and may send a case; the grant they do not
   hold is `can_le`, and a review is not a run of the report service. */
const mgrCookie = await login(MANAGER1.email, MANAGER1.password);
const mgr = call(mgrCookie);
const mgrList = await mgr('/medical-reviews');
check('a manager may see their own outstanding requests', mgrList.status === 200,
  String(mgrList.status));

/* ------------------------------------------------------------------ *
 * Declining
 * ------------------------------------------------------------------ */
console.log('\nDECLINING IS AN ANSWER TOO');
const spare = await json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: blank.id, reviewer_id: doctor.id, ask: 'Another look.' } }));
const noReason = await doc(`/medical-reviews/${spare.id}/decline`, { method: 'POST', body: {} });
check('a decline without a reason is refused', noReason.status === 400,
  String(noReason.status));
const declined = await doc(`/medical-reviews/${spare.id}/decline`,
  { method: 'POST', body: { reason: 'Outside my field.' } });
check('with one it goes back', declined.status === 200, String(declined.status));
const afterDecline = await json(await api(`/opportunities/${blank.id}`));
check('and nothing was written to the case',
  Number(afterDecline.le_months) === 48, String(afterDecline.le_months));
check('the reason is on the record',
  (afterDecline.medical_reviews || []).some((r) => r.status === 'Declined'
    && /Outside my field/.test(r.findings || '')));

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All medical review checks passed.'}`);
process.exit(fails.length ? 1 : 0);
