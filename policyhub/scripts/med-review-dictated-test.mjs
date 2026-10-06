/* =====================================================================
   Writing the doctor's answer down for him.

   Not every reviewer is going to sit at a screen. The usual way an
   estimate arrives is a telephone call — a number, and two minutes on
   why — and until now that call had nowhere to go: the register showed
   the case as still out, and what the office actually knew lived in
   somebody's notebook.

   So: an administrator can type the answer into the same record the
   doctor would have filled in. Three things are under test, and they
   are the three that make it honest rather than a forgery.

     - It behaves like a returned review. The case takes the estimate
       the ordinary way, the register shows it as back.
     - It never pretends he typed it. Who wrote it down, when, and how
       it came in travel with the review everywhere it is shown.
     - It cannot be used to put words in his mouth. An administrator
       only; and once the doctor has written his own, this refuses
       rather than replacing it.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'MEDDICT';
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
const docPassword = scratchPassword('meddict');
const doctor = await json(await api('/users', { method: 'POST', body: {
  email: docEmail, password: docPassword, full_name: 'Dr H Telephone', role: 'medical' } }));
const doc = call(await login(docEmail, docPassword));

const funds = await json(await api('/funds'));
const make = async (tag, extra = {}) => json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-${tag}`, carrier_name: 'Lincoln', product_type: 'UL',
  face_amount: 3000000, asking_price: 700000, annual_premium: 40000,
  fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: `Phoned${tag}`, insured_first_name: 'Ada',
  insured_dob: '1944-02-02', insured_gender: 'F', insured_state: 'MI', ...extra } }));
const send = async (oppId) => json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: oppId, reviewer_id: doctor.id, ask: 'The kidney picture.' } }));

const REASONING = 'He is reading the creatinine trend rather than the stage. Says the '
  + 'dialysis conversation in the March notes is the thing, and he would move if she starts.';
const HOW = 'By telephone, this afternoon';

console.log('THE CALL IS WRITTEN DOWN, AND IT BEHAVES LIKE A REVIEW');
const blankCase = await make('BLANK');            // no LE on the deal at all
const rev = await send(blankCase.id);
check('the review starts out waiting for him', rev.status === 'Requested', rev.status);

const wrote = await json(await api(`/medical-reviews/${rev.id}/record`, { method: 'POST',
  body: { le_months: 41, le_basis: 'median', findings: REASONING,
    recommendation: 'Proceed', recorded_how: HOW } }));
check('the office can write his answer down', wrote?.le_months === 41,
  JSON.stringify(wrote?.error || wrote?.le_months));
check('and the review now reads as back', wrote.status === 'Returned', wrote.status);
check('his reasoning is kept as typed', wrote.findings === REASONING);
check('as is what he suggested', wrote.recommendation === 'Proceed');

const onCase = await json(await api(`/opportunities/${blankCase.id}`));
check('the estimate lands on a case that had none', Number(onCase.le_months) === 41,
  String(onCase.le_months));
check('credited to the doctor, not to whoever typed it',
  /Telephone/.test(String(onCase.le_provider)), onCase.le_provider);

console.log('\nBUT THE RECORD NEVER SAYS HE TYPED IT');
check('it names who wrote it down', wrote.recorded_by_name === 'Jonathan Polter'
  || !!wrote.recorded_by_name, String(wrote.recorded_by_name));
check('when', !!wrote.recorded_at, String(wrote.recorded_at));
check('and how it came in', wrote.recorded_how === HOW, wrote.recorded_how);
const listed = (await json(await api(`/opportunities/${blankCase.id}`)))
  .medical_reviews.find((x) => x.id === rev.id);
check('and the same is on the deal’s own panel', !!listed.recorded_by_name
  && listed.recorded_how === HOW, JSON.stringify(listed.recorded_how));
const reg = (await json(await api('/medical-reviews?scope=all')))
  .find((x) => x.id === rev.id);
check('and in the register', !!reg && !!reg.recorded_by_name, JSON.stringify(reg?.status));

console.log('\nTHE DOCTOR CAN SEE WHAT WAS WRITTEN, AND CORRECT IT');
const his = await json(await doc(`/medical-reviews/${rev.id}`));
check('he is shown the transcription rather than kept from it',
  his.le_months === 41 && !!his.recorded_by_name, JSON.stringify(his.recorded_by_name));
/* On its own case. The one above went straight onto a deal that had no
   estimate, and an estimate taken onto a case closes the review to
   further edits -- the doctor's own returns are locked the same way,
   and for the same reason: the deal has been priced off it by then. */
const corrCase = await make('CORRECT', { le_months: 72, le_provider: '21st Services',
  le_date: '2026-02-02' });
const corr = await send(corrCase.id);
await api(`/medical-reviews/${corr.id}/record`, { method: 'POST',
  body: { le_months: 41, findings: REASONING, recorded_how: HOW } });
const fixed = await json(await doc(`/medical-reviews/${corr.id}`, { method: 'PUT',
  body: { le_months: 38, findings: 'Forty-one was my first thought; thirty-eight on reflection.',
    recommendation: 'Proceed', returned: true } }));
check('and when he writes his own, it is his number', fixed.le_months === 38,
  JSON.stringify(fixed.error || fixed.le_months));
check('and the office’s handwriting comes off it',
  !fixed.recorded_by_name && !fixed.recorded_at && !fixed.recorded_how,
  JSON.stringify([fixed.recorded_by_name, fixed.recorded_how]));

console.log('\nIT CANNOT BE USED TO OVERWRITE WHAT HE WROTE HIMSELF');
const again = await api(`/medical-reviews/${corr.id}/record`, { method: 'POST',
  body: { le_months: 60, recorded_how: 'He definitely said sixty' } });
check('a review he returned himself is refused', again.status === 409, String(again.status));
const still = await json(await api(`/medical-reviews/${corr.id}`));
check('and his own answer stands', still.le_months === 38, String(still.le_months));

console.log('\nAND ONLY AN ADMINISTRATOR MAY DO IT AT ALL');
const live = await send((await make('MGR')).id);
const mgr = call(await login(MANAGER1.email, MANAGER1.password));
const byMgr = await mgr(`/medical-reviews/${live.id}/record`, { method: 'POST',
  body: { le_months: 24, recorded_how: 'Manager heard it' } });
check('a manager is refused', byMgr.status === 403, String(byMgr.status));
const byDoc = await doc(`/medical-reviews/${live.id}/record`, { method: 'POST',
  body: { le_months: 24 } });
check('and so is the doctor, who has a route of his own', byDoc.status === 403,
  String(byDoc.status));

console.log('\nAND THE NUMBER IS THE ONE THING IT INSISTS ON');
const noNumber = await api(`/medical-reviews/${live.id}/record`, { method: 'POST',
  body: { findings: 'He talked for a while but would not commit.' } });
check('no estimate, no record', noNumber.status === 400, String(noNumber.status));
const silly = await api(`/medical-reviews/${live.id}/record`, { method: 'POST',
  body: { le_months: 4000 } });
check('nor a figure that cannot be a life expectancy', silly.status === 400, String(silly.status));

console.log('\nA CASE THAT ALREADY HAS AN ESTIMATE IS NOT REPRICED BEHIND ANYBODY');
const priced = await make('PRICED', { le_months: 72, le_provider: '21st Services',
  le_date: '2026-02-02' });
const rev2 = await send(priced.id);
await api(`/medical-reviews/${rev2.id}/record`, { method: 'POST',
  body: { le_months: 44, findings: 'Much worse than 72.', recorded_how: HOW } });
const after = await json(await api(`/opportunities/${priced.id}`));
check('the report the deal was priced off stays where it is',
  Number(after.le_months) === 72, String(after.le_months));
check('and nothing moved on its own', after.internal_le_months == null,
  String(after.internal_le_months));
/* Taken by hand, which is the rule for every returned review on a case
   that already carries a number -- dictated or not. */
await api(`/medical-reviews/${rev2.id}/adopt`, { method: 'POST' });
const taken = await json(await api(`/opportunities/${priced.id}`));
check('and once taken it sits beside it as the internal LE',
  Number(taken.internal_le_months) === 44, String(taken.internal_le_months));
check('with the report still the one it is priced off',
  Number(taken.le_months) === 72, String(taken.le_months));

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All dictated review checks passed.'}`);
process.exit(fails.length ? 1 : 0);
