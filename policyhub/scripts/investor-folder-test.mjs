/* =====================================================================
   The folder the investors are given.

   A case has two folders and they are not the same folder. The CASE
   FILE is the office's: the illustration, the offer, the carrier
   correspondence, the broker's email. The INVESTOR FOLDER is what the
   people who own a piece of the policy are shown — the policy documents
   and whatever of the health picture the office decides they should
   have.

   One link cannot be both, which is the whole of the design here:

     - the case folder is staff-only on a deal and on a policy;
     - the investor folder reaches an investor on both, because that is
       what it is for;
     - neither reaches a reviewing doctor, who gets the records folder
       set on his own review and nothing else;
     - and the investor folder travels onto the policy when the deal is
       funded, so nobody has to paste it in twice.

   What is NOT enforced here, deliberately: what is in the folder. That
   is a decision somebody makes per case, and this application never
   reads it. What it does is make the decision a field rather than an
   email.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'INVFOLD';
const CASEFOLDER = 'https://www.dropbox.com/scl/fo/invfold-case-0001';
const INVFOLDER = 'https://www.dropbox.com/scl/fo/invfold-investor-7788';
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

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(`/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  for (const u of ((await json(await api('/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX.toLowerCase())))
    await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();

const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const inv = call(invCookie);
const me1 = (await json(await inv('/auth/me'))).investor.id;
const funds = await json(await api('/funds'));

console.log('ON A DEAL');
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Lincoln', product_type: 'UL',
  face_amount: 3000000, asking_price: 700000, annual_premium: 40000,
  expected_close: '2026-12-01', fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Folderly', insured_first_name: 'Ada',
  insured_dob: '1944-02-02', insured_gender: 'F', insured_state: 'MI',
  le_months: 48, le_provider: '21st', le_date: '2026-08-26',
  impairments: 'Chronic kidney disease, stage 4.',
  documents_url: CASEFOLDER, investor_url: INVFOLDER } }));
check('both folders can be set on a deal',
  deal?.documents_url === CASEFOLDER && deal?.investor_url === INVFOLDER,
  `${deal?.documents_url} · ${deal?.investor_url}`);
check('a link that would run in the reader’s session is refused',
  (await json(await api(`/opportunities/${deal.id}`, { method: 'PUT', body: {
    investor_url: 'javascript:fetch("/api/policies")' } })))?.investor_url === null);
await api(`/opportunities/${deal.id}`, { method: 'PUT', body: { investor_url: INVFOLDER } });

await api(`/opportunities/${deal.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
const theirs = await json(await inv(`/opportunities/${deal.id}`));
check('the investor shown the deal gets the investor folder',
  theirs?.investor_url === INVFOLDER, theirs?.investor_url);
check('and not the case folder', !theirs?.documents_url
  && !JSON.stringify(theirs).includes('invfold-case'),
  JSON.stringify(theirs).slice(0, 80));

console.log('\nAND THE DOCTOR GETS NEITHER');
const docEmail = `${PREFIX.toLowerCase()}-doctor@example.test`;
const docPassword = scratchPassword('invfold');
const doctor = await json(await api('/users', { method: 'POST', body: {
  email: docEmail, password: docPassword, full_name: 'Dr E Reviewer', role: 'medical' } }));
const sent = await json(await api('/medical-reviews', { method: 'POST', body: {
  opportunity_id: deal.id, reviewer_id: doctor.id,
  records_url: 'https://www.dropbox.com/scl/fo/invfold-medical-5555' } }));
const packet = await json(await call(await login(docEmail, docPassword))(
  `/medical-reviews/${sent.id}`));
check('he is given the records folder set on his review',
  /invfold-medical/.test(packet?.records_url || ''), packet?.records_url);
check('and neither of the other two',
  !JSON.stringify(packet).includes('invfold-case')
  && !JSON.stringify(packet).includes('invfold-investor'),
  JSON.stringify(packet).slice(0, 100));

console.log('\nAND IT TRAVELS ONTO THE POLICY');
const funded = await api(`/opportunities/${deal.id}/fund`, { method: 'POST',
  body: { acquisition_date: '2026-11-01' } });
check('the deal funds', funded.status === 201, String(funded.status));
const policyId = (await json(funded)).policy_id;
const policy = await json(await api(`/policies/${policyId}`));
check('the new policy carries both folders without retyping',
  policy?.documents_url === CASEFOLDER && policy?.investor_url === INVFOLDER,
  `${policy?.documents_url} · ${policy?.investor_url}`);

await api(`/policies/${policyId}/investors`, { method: 'POST', body: {
  investor_id: me1, pct: 100, acquired_on: '2026-11-01' } });
const theirPolicy = await json(await inv(`/policies/${policyId}`));
check('and on the policy the investor sees the investor folder',
  theirPolicy?.investor_url === INVFOLDER, theirPolicy?.investor_url);

console.log('\nAND IT CAN BE CHANGED OR TAKEN AWAY');
await api(`/policies/${policyId}`, { method: 'PUT', body: { investor_url: '' } });
check('clearing it takes the folder off the policy',
  !((await json(await inv(`/policies/${policyId}`)))?.investor_url),
  String((await json(await inv(`/policies/${policyId}`)))?.investor_url));
const moved = 'https://www.dropbox.com/scl/fo/invfold-investor-9999';
await api(`/policies/${policyId}`, { method: 'PUT', body: { investor_url: moved } });
check('and a new one reaches them at once',
  (await json(await inv(`/policies/${policyId}`)))?.investor_url === moved);

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All investor folder checks passed.'}`);
process.exit(fails.length ? 1 : 0);
