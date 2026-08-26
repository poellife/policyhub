/* =====================================================================
   Input the database will not take.

   Reported from production: entering a new opportunity returned
   "Something went wrong. Quote reference c5e6c36d if you report this."
   The log behind the reference said

     invalid byte sequence for encoding "UTF8": 0x00

   — a NUL byte carried in on a paste. PostgreSQL text cannot hold one at
   all, so the INSERT failed, and because the handler had no rule for it
   the person got a five-word apology and a reference number for a paste
   that looked perfectly ordinary on the screen. Medical summaries and
   underwriter notes are pasted out of PDFs; this was going to keep
   happening.

   Looking for it turned up three more of the same shape — a figure with
   an extra digit, a life expectancy beyond a whole number, a year typed
   with five digits — every one of them a 500 for what is really somebody
   mistyping a form.

   So: text is stripped of what cannot be stored, figures and dates are
   checked against the columns they are bound for and refused by name,
   and the error handler turns anything that still reaches the database
   into a readable 400 rather than a reference number.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'LIMIT';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const admin = await login(ADMIN.email, ADMIN.password);
const funds = await json(await api(admin, '/funds'));
const fundId = funds[0]?.id;

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

/** Post it, and report the status and the message the person would read. */
const tryPost = async (path, body) => {
  const r = await api(admin, path, { method: 'POST', body });
  return { status: r.status, ...(await json(r) || {}) };
};

const readable = (r, must) => r.status === 400 && new RegExp(must, 'i').test(String(r.error || ''));

const NUL = String.fromCharCode(0);

/* ------------------------------------------------------------------ *
 * The reported failure
 * ------------------------------------------------------------------ */
console.log('A PASTE OUT OF A PDF GOES IN');

/* The exact shape of the production failure: free text carrying a NUL,
   which is what a copy out of a PDF viewer routinely contains. */
let r = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-0`, carrier_name: 'Prudential', product_type: 'IUL',
  insured_last_name: 'Termansen', insured_first_name: 'Eric',
  insured_dob: '01/17/1966', insured_gender: 'M', insured_state: 'AZ',
  le_months: 246, fund_id: fundId,
  impairments: `Cardiovascular:${NUL} five stents (2023)\nHepatic:${NUL} fatty liver`,
  underwriter_note: `Records complete through April.${NUL}`,
  notes: `Pasted from the carrier PDF${NUL}` });
check('an opportunity whose notes carry a NUL byte is created, not refused',
  r.id > 0, `${r.status} ${r.error || ''}`);
check('the byte is gone from what was stored',
  !JSON.stringify(r).includes('\\u0000'), 'a NUL survived');
check('and the words around it are untouched',
  r.impairments === 'Cardiovascular: five stents (2023)\nHepatic: fatty liver',
  JSON.stringify(r.impairments));
check('including the line breaks the one-pager reads as bullets',
  String(r.impairments).split('\n').length === 2,
  JSON.stringify(r.impairments));

console.log('\nA FIGURE WITH AN EXTRA DIGIT IS A REFUSAL, NOT A CRASH');

r = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-1`, insured_last_name: 'Overflow', fund_id: fundId,
  face_amount: '999999999999999999' });
check('a death benefit too large for the column is refused', r.status === 400,
  `${r.status} ${r.error}`);
check('and the message names the field and what fits',
  readable(r, 'death benefit.*too large'), r.error);
check('with no reference number, because it is not a server error',
  !('ref' in r), JSON.stringify(r.ref));

r = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-2`, insured_last_name: 'Overflow', fund_id: fundId,
  asking_price: '1e20' });
check('the same for an asking price', readable(r, 'asking price.*too large'),
  `${r.status} ${r.error}`);

/* An integer field with no sensible range of its own: the ceiling that
   applies is the column's, and the message says so. (Life expectancy has
   a narrower limit of its own — that is checked further down.) */
r = await tryPost('/policies', {
  policy_number: `${PREFIX}-5b`, insured_last_name: 'Overflow',
  insured_id: '99999999999' });
check('a whole number past what an integer column holds is refused by name',
  readable(r, 'insured id.*too large'), `${r.status} ${r.error}`);
check('and it names the ceiling', /2,147,483,647/.test(String(r.error)), r.error);

r = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-4`, insured_last_name: 'Overflow', fund_id: fundId,
  insured_dob: '01/17/19666' });
check('a year with an extra digit is refused as a date',
  readable(r, 'date of birth.*year'), `${r.status} ${r.error}`);

/* ------------------------------------------------------------------ *
 * The same guard everywhere, not just on opportunities
 * ------------------------------------------------------------------ */
console.log('\nTHE GUARD IS ON THE BUILDER, SO IT IS ON EVERY FORM');

r = await tryPost('/policies', {
  policy_number: `${PREFIX}-P1`, insured_last_name: 'Overflow',
  face_amount: '99999999999999999' });
check('a policy with an impossible death benefit is refused',
  readable(r, 'death benefit.*too large'), `${r.status} ${r.error}`);

r = await tryPost('/policies', {
  policy_number: `${PREFIX}-P2`, insured_last_name: 'Overflow', issue_date: '01/01/40000' });
check('and one with an impossible issue date',
  readable(r, 'issue date.*year'), `${r.status} ${r.error}`);

const good = await tryPost('/policies', {
  policy_number: `${PREFIX}-P3`, insured_last_name: 'Ordinary', insured_first_name: 'Olive',
  carrier_name: 'Lincoln Financial', face_amount: '2,500,000', acquisition_cost: '$480,000',
  acquisition_date: '02/01/2026', fund_id: fundId });
check('a policy with ordinary figures is created as before', good.id > 0,
  `${good.status} ${good.error || ''}`);
check('and the money it was given still reads back correctly',
  Number(good.face_amount) === 2500000 && Number(good.acquisition_cost) === 480000,
  `${good.face_amount} / ${good.acquisition_cost}`);

r = await tryPost(`/policies/${good.id}/transactions`, {
  txn_date: '2026-03-01', txn_type: 'Premium', amount: '9'.repeat(20) });
check('a transaction amount beyond the column is refused by name',
  readable(r, 'amount.*too large'), `${r.status} ${r.error}`);

r = await tryPost(`/policies/${good.id}/values`, {
  as_of_date: '2026-03-01', account_value: '1e18' });
check('so is a carrier value', readable(r, 'account value.*too large'),
  `${r.status} ${r.error}`);

r = await tryPost('/policies', {
  policy_number: `${PREFIX}-P4`, insured_last_name: `Pasted${NUL}`,
  carrier_name: `Lincoln${NUL} Financial`, notes: `From a PDF${NUL}`, fund_id: fundId });
check('a policy pasted in with NUL bytes is created too', r.id > 0,
  `${r.status} ${r.error || ''}`);
check('with the carrier name intact', r.carrier_name === 'Lincoln Financial',
  JSON.stringify(r.carrier_name));

/* ------------------------------------------------------------------ *
 * What still has to work
 * ------------------------------------------------------------------ */
console.log('\nNOTHING ORDINARY IS CAUGHT BY IT');

const ok = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-5`, carrier_name: 'Prudential', product_type: 'IUL',
  insured_last_name: 'Termansen', insured_first_name: 'Eric', insured_dob: '01/17/1966',
  insured_gender: 'M', insured_state: 'AZ', le_months: 246,
  face_amount: 11000000, asking_price: 265000, annual_premium: 220273, fund_id: fundId });
check('the deal from the report goes in exactly as typed', ok.id > 0,
  `${ok.status} ${ok.error || ''}`);
check('with the date read the American way it was entered',
  String(ok.insured_dob).startsWith('1966-01-17'), String(ok.insured_dob));
check('and the life expectancy intact', Number(ok.le_months) === 246, String(ok.le_months));

const edge = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-6`, insured_last_name: 'Edge', fund_id: fundId,
  face_amount: 99999999999999.99, le_months: 1200, insured_dob: '1900-01-01' });
check('a figure exactly at the ceiling is still accepted', edge.id > 0,
  `${edge.status} ${edge.error || ''}`);

const blank = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-7`, insured_last_name: 'Blank', fund_id: fundId,
  face_amount: '', le_months: '', insured_dob: '' });
check('and empty fields are still simply empty, not refused', blank.id > 0,
  `${blank.status} ${blank.error || ''}`);
check('reading back as nothing rather than zero',
  blank.face_amount === null && blank.le_months === null && blank.insured_dob === null,
  JSON.stringify([blank.face_amount, blank.le_months, blank.insured_dob]));

/* ------------------------------------------------------------------ *
 * A life expectancy is months a person might live
 * ------------------------------------------------------------------ */
/* This is the one where the column type is not the real limit. `le_months`
   is an INTEGER, so Postgres takes two billion of them without complaint —
   and then the scenario arithmetic adds that many months to a date, throws,
   and takes the whole Opportunities list down with it. One typed field, and
   nobody in the firm can open the tab. */
console.log('\nA LIFE EXPECTANCY HAS TO BE A LIFE EXPECTANCY');

r = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-8`, insured_last_name: 'Immortal', fund_id: fundId,
  le_months: 2147483647 });
check('a life expectancy the column would take but a person could not is refused',
  readable(r, 'life expectancy.*between'), `${r.status} ${r.error}`);
check('and it says what the range is', /1200/.test(String(r.error)), r.error);

r = await tryPost('/opportunities', {
  policy_number: `${PREFIX}-9`, insured_last_name: 'Ordinary', fund_id: fundId,
  le_months: 246 });
check('an ordinary one is untouched', r.id > 0, `${r.status} ${r.error || ''}`);

const listed = await json(await api(admin, '/opportunities'));
check('and the Opportunities list still answers for everybody',
  Array.isArray(listed), JSON.stringify(listed).slice(0, 120));

/* Editing has to be guarded the same way — the same builder writes both,
   but a test that only covers POST would not notice if that changed. */
console.log('\nEDITING IS GUARDED THE SAME WAY');
const edit = await api(admin, `/opportunities/${ok.id}`, {
  method: 'PUT', body: { asking_price: '9'.repeat(18) } });
const editBody = await json(edit);
check('an edit that overflows is refused too', edit.status === 400,
  `${edit.status} ${editBody?.error}`);
check('naming the field', /asking price/i.test(String(editBody?.error)), editBody?.error);
const after = await json(await api(admin, `/opportunities/${ok.id}`));
check('and the record is untouched', Number(after.asking_price) === 265000,
  String(after.asking_price));

await wipe();
console.log(fails.length
  ? `\n${fails.length} BAD-INPUT CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL BAD-INPUT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
