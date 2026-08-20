/* =====================================================================
   Deleting an investor.

   Not the same act as deleting a policy. A policy is a thing the firm
   owns; an investor is somebody it has a relationship with, who may have
   a signature on an executed document and money in an account.

   So the rule is not "are you sure". It is:

     - an administrator, and nobody else.
     - the name typed out, because this is not undoable.
     - their login goes with them. An investor account attached to nobody
       could still sign in, which is worse than no account at all.
     - and where deleting would REWRITE something — a signature on an
       agreement that went out, money on a capital call that was confirmed
       — it is refused, and the right answer is offered instead. A
       signature that vanishes from an executed document, or money that
       arrives from nobody, is not a tidy-up.

   Idempotent: its own investors, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login, scratchPassword } from './test-config.mjs';

const PREFIX = 'INVDEL';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const admin = await login(ADMIN.email, ADMIN.password);
const manager = await login(MANAGER1.email, MANAGER1.password);
const investor = await login(INVESTOR1.email, INVESTOR1.password);

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  for (const a of ((await json(await api(admin, '/agreements'))) || []))
    if (String(a.title || '').startsWith(PREFIX)) {
      if (a.status !== 'Draft') await api(admin, `/agreements/${a.id}/recall`, { method: 'POST' });
      await api(admin, `/agreements/${a.id}`, { method: 'DELETE' });
    }
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(admin, `/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  for (const u of ((await json(await api(admin, '/users'))) || []))
    if (String(u.email).startsWith(PREFIX.toLowerCase()))
      await api(admin, `/users/${u.id}`, { method: 'DELETE' });
  for (const i of ((await json(await api(admin, '/investors'))) || []))
    if (String(i.name).startsWith(PREFIX))
      await api(admin, `/investors/${i.id}`, { method: 'DELETE', body: { confirm: i.name } });
};
await wipe();

const makeInvestor = (name, body = {}) => json(api(admin, '/investors', { method: 'POST',
  body: { name, ...body } }).then((r) => r));

console.log('WHO MAY');
const plain = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Nobody Special` } }));
check('an administrator may delete one',
  (await api(admin, `/investors/${plain.id}`, { method: 'DELETE', body: {
    confirm: plain.name } })).status === 200);
const second = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Still Here`, email: `${PREFIX.toLowerCase()}-still@test.local`,
  login_email: `${PREFIX.toLowerCase()}-still@test.local`,
  login_password: scratchPassword('invdel0') } }));
check('a manager may not',
  (await api(manager, `/investors/${second.id}`, { method: 'DELETE', body: {
    confirm: second.name } })).status === 403);
check('nor an investor',
  (await api(investor, `/investors/${second.id}`, { method: 'DELETE', body: {
    confirm: second.name } })).status === 403);
check('and the record survived both attempts',
  (await api(admin, `/investors/${second.id}`)).status === 200);

console.log('\nTHE NAME HAS TO BE TYPED — WHEN THERE IS SOMETHING TO LOSE');
/* An empty record is a typo somebody is tidying up. Making them type a name
   to remove a row with nothing attached is friction that teaches people to
   type names without reading them, which is the opposite of the point. */
const empty = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Nothing Attached` } }));
check('an empty record goes without ceremony',
  (await api(admin, `/investors/${empty.id}`, { method: 'DELETE' })).status === 200);

const wrong = await api(admin, `/investors/${second.id}`, { method: 'DELETE', body: {
  confirm: 'something else' } });
check('a wrong name is refused', wrong.status === 400, String(wrong.status));
check('and says exactly what to type',
  (await json(wrong))?.confirm_phrase === second.name);
check('nothing at all is refused too',
  (await api(admin, `/investors/${second.id}`, { method: 'DELETE' })).status === 400);
check('the record is still there', (await api(admin, `/investors/${second.id}`)).status === 200);

console.log('\nWHAT WOULD GO WITH THEM, BEFORE ANYTHING DOES');
const held = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Holds Things`, email: `${PREFIX.toLowerCase()}-holds@test.local`,
  login_email: `${PREFIX.toLowerCase()}-holds@test.local`,
  login_password: scratchPassword('invdel') } }));
const policy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 1000000, premium_required: 20000, premium_mode: 'Annual',
  insured_last_name: `${PREFIX}Person`, insured_first_name: 'Ada', dob: '1939-01-01' } }));
await api(admin, `/policies/${policy.id}/transactions`, { method: 'POST', body: {
  txn_date: iso(-200), txn_type: 'Acquisition Cost', amount: 300000 } });
await api(admin, `/policies/${policy.id}/investors`, { method: 'POST', body: {
  investor_id: held.id, pct: 50, acquired_on: iso(-200) } });

const foot = await json(await api(admin, `/investors/${held.id}/footprint`));
check('it counts the positions', foot.positions === 1, String(foot.positions));
check('and the money on them', foot.invested > 0, `$${Math.round(foot.invested)}`);
check('and the login', foot.logins === 1, String(foot.logins));
check('and says this one can go', foot.keeps_records === false);
check('a manager cannot even look at the footprint',
  (await api(manager, `/investors/${held.id}/footprint`)).status === 403);

console.log('\nAND WHEN IT GOES, THE LOGIN GOES WITH IT');
/* An investor login attached to nobody could still sign in, and would see
   whatever an investor with no investor sees. That is worse than no account. */
const before = ((await json(await api(admin, '/users'))) || [])
  .filter((u) => Number(u.investor_id) === held.id).length;
check('there is a login to lose', before === 1);
const gone = await json(await api(admin, `/investors/${held.id}`, { method: 'DELETE', body: {
  confirm: held.name } }));
check('the investor is deleted', !!gone.ok);
check('the report says what went with them',
  gone.removed.positions === 1 && gone.removed.logins === 1,
  JSON.stringify(gone.removed).slice(0, 90));
check('the login is gone too',
  ((await json(await api(admin, '/users'))) || [])
    .filter((u) => Number(u.investor_id) === held.id).length === 0);
check('and no login is left pointing at nobody',
  ((await json(await api(admin, '/users'))) || [])
    .every((u) => u.role !== 'investor' || u.investor_id));
check('the policy itself is untouched',
  (await api(admin, `/policies/${policy.id}`)).status === 200);
/* The cap table lives on the policy record rather than behind a route of its
   own, so that is where the absence is checked. */
const policyNow = await json(await api(admin, `/policies/${policy.id}`));
check('their share of it simply became unallocated',
  !(policyNow.investors || []).some((a) => Number(a.investor_id) === held.id),
  (policyNow.investors || []).map((a) => a.investor_id).join(',') || 'nobody holds it');
check('and the deletion is on the activity log with what it took',
  ((await json(await api(admin, '/audit'))) || []).some((r) =>
    r.entity === 'investor' && new RegExp(`${PREFIX} Holds Things.*position`).test(r.detail || '')));

console.log('\nWHAT WOULD BE A REWRITE IS REFUSED');
/* Somebody who has signed an agreement that went out. Deleting them takes a
   signature off an executed document — which is not tidying, it is a
   different document. */
const signerPw = scratchPassword('invdel2');
const signer = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Signed Something`, email: `${PREFIX.toLowerCase()}-signed@test.local`,
  login_email: `${PREFIX.toLowerCase()}-signed@test.local`,
  login_password: signerPw, must_change_password: false } }));
const agreement = await json(await api(admin, '/agreements', { method: 'POST', body: {
  title: `${PREFIX} agreement`,
  terms: { llc_name: `${PREFIX} Fund LLC`, manager_name: 'Poel Capital LLC', state: 'Michigan',
    effective_date: iso(-1), purpose: 'Life settlements', manager_fee: '2',
    capital_call_days: '10' } } }));
await api(admin, `/agreements/${agreement.id}/signers`, { method: 'PUT', body: { signers: [
  { role: 'Manager', name: 'Alan Spiegel' },
  { investor_id: signer.id, name: signer.name, contribution: 100000, pct: 100 } ] } });
await api(admin, `/agreements/${agreement.id}/issue`, { method: 'POST' });

const footBefore = await json(await api(admin, `/investors/${signer.id}/footprint`));
check('an unsigned agreement does not stop a deletion',
  footBefore.keeps_records === false, JSON.stringify(footBefore).slice(0, 80));

/* Sign as them, the way the portal does, so there is a signature on a
   document that has gone out — the case deletion must refuse. */
const theirCookie = await login(`${PREFIX.toLowerCase()}-signed@test.local`, signerPw);
const theySigned = await api(theirCookie, `/agreements/${agreement.id}/sign`, {
  method: 'POST', body: { signed_name: signer.name, agreed: true } });
check('the investor signs it', theySigned.status === 200,
  JSON.stringify(await json(theySigned)).slice(0, 100));

const footNow = await json(await api(admin, `/investors/${signer.id}/footprint`));
check('the footprint now says this is a record, not just an attachment',
  footNow.keeps_records === true && footNow.signed_agreements === 1,
  JSON.stringify(footNow).slice(0, 90));

const refused = await api(admin, `/investors/${signer.id}`, { method: 'DELETE', body: {
  confirm: signer.name } });
check('deleting them is refused even with the name typed correctly',
  refused.status === 409, String(refused.status));
const why = await json(refused);
check('and the reason names what would be rewritten',
  /signed 1 agreement/.test(why.error || ''), why.error);
check('and points at the answer that is not a rewrite',
  /inactive/i.test(why.error || ''));
check('they are still there', (await api(admin, `/investors/${signer.id}`)).status === 200);

console.log('\nMAKING THEM INACTIVE IS THE ANSWER');
const parked = await json(await api(admin, `/investors/${signer.id}`, { method: 'PUT', body: {
  name: signer.name, is_active: false } }));
check('an administrator can do it', parked.is_active === false, String(parked.is_active));
check('the signature is exactly where it was',
  (await json(await api(admin, `/agreements/${agreement.id}`)))
    .signers.find((x) => x.investor_id === signer.id)?.signed_at != null);
check('a manager cannot',
  (await json(await api(manager, `/investors/${signer.id}`, { method: 'PUT', body: {
    name: signer.name, is_active: true } })))?.is_active === false);
check('and an administrator can put them back',
  (await json(await api(admin, `/investors/${signer.id}`, { method: 'PUT', body: {
    name: signer.name, is_active: true } }))).is_active === true);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL INVESTOR DELETE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
