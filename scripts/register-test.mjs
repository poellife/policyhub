/* =====================================================================
   Registering, and being approved.

   This is the only route in the API a stranger can reach, so most of
   what is checked here is what it refuses: a short password, a tax
   number that is not one, a flood of submissions, and — the one that
   matters most — any answer that would tell an outsider whether a given
   person is already a client here.

   The other half is the promise made to the person filling it in: the
   password they chose is the password they get, nobody here ever sees
   it, and their Social Security number is unreadable in the database.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login, scratchPassword } from './test-config.mjs';

const TAG = 'regtest';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json',
             ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const register = (body) => api(null, '/register', { method: 'POST', body });

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const investor = await login(INVESTOR1.email, INVESTOR1.password);

const PASSWORD = scratchPassword(TAG);

const signIn = (email, password) => fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }) });

const wipe = async () => {
  for (const a of ((await json(await api(admin, '/applications'))) || [])
    .filter((x) => String(x.email).includes(TAG))) {
    if (a.user_id) await api(admin, `/users/${a.user_id}`, { method: 'DELETE' });
    if (a.investor_id) await api(admin, `/investors/${a.investor_id}`, { method: 'DELETE' });
    await api(admin, `/applications/${a.id}`, { method: 'DELETE' });
  }
  // A declined-then-deleted row can leave the investor behind; sweep by name.
  for (const i of ((await json(await api(admin, '/investors'))) || [])
    .filter((x) => String(x.email || '').includes(TAG)))
    await api(admin, `/investors/${i.id}`, { method: 'DELETE' });
  // And the deliberate one sent to an address that already has an account.
  for (const a of ((await json(await api(admin, '/applications'))) || [])
    .filter((x) => x.email === ADMIN.email))
    await api(admin, `/applications/${a.id}`, { method: 'DELETE' });
};
await wipe();
// The per-address cap is real and this suite deliberately runs into it, so
// it starts from a clean counter rather than inheriting one from the last run.
await api(admin, '/register-throttle', { method: 'DELETE', body: {} });

const applicant = (n, over = {}) => ({
  full_name: `Applicant ${n}`,
  entity_name: n === 1 ? `${TAG} Family Trust` : '',
  investor_type: n === 1 ? 'Trust' : 'Individual',
  email: `${TAG}-${n}@example.com`,
  password: PASSWORD,
  phone: '(248) 555-0100',
  address_line1: '900 Maple Road',
  address_line2: 'Suite 220',
  city: 'Southfield',
  state: 'MI',
  postal_code: '48075',
  tax_id: '123-45-6789',
  note: 'Introduced by a existing client.',
  ...over,
});

console.log('IT GIVES NOTHING AWAY');
/* Run first, before anything else in this suite spends the per-address
   budget. The property under test is that an address which already has an
   account here answers exactly as an unknown one does — anything else
   turns the form into a way of asking "is this person one of yours?"
   Comparing the two answers to each other rather than to a fixed status
   keeps that true even when the throttle has already tripped. */
const shapeOf = async (r) => `${r.status} ${JSON.stringify(await json(r))}`;
const knownAnswer = await shapeOf(await register(applicant(3, { email: ADMIN.email })));
const strangerAnswer = await shapeOf(await register(applicant(4)));
check('an address we already know answers exactly as a stranger does',
  knownAnswer === strangerAnswer, `${knownAnswer} vs ${strangerAnswer}`);
check('and the one we know creates nothing to approve',
  !((await json(await api(admin, '/applications'))) || [])
    .some((a) => a.email === ADMIN.email),
  ADMIN.email);

console.log('WHAT THE FORM REFUSES');
const bad = async (label, over, expect) => {
  const r = await register(applicant(99, over));
  const body = await json(r);
  check(label, r.status === 400 && expect.test(body?.error || ''), body?.error || r.status);
};
await bad('no name', { full_name: '' }, /your name/i);
await bad('a mangled email', { email: 'not-an-address' }, /valid email/i);
await bad('a short password', { password: 'short' }, /10 characters/i);
await bad('no phone number', { phone: '' }, /phone/i);
await bad('half an address', { city: '', postal_code: '' }, /address/i);
await bad('a tax number that is not nine digits, if one is offered at all',
  { tax_id: '12345' }, /nine-digit/i);
check('and it says everything that is wrong at once, not one at a time',
  /name.*email.*password/i.test((await json(await register({}))).error || ''),
  (await json(await register({}))).error);

console.log('\nA GOOD ONE');
const first = await register(applicant(1));
check('is accepted', first.status === 202, String(first.status));
check('and says nothing about what was created', JSON.stringify(await json(first)) === '{"ok":true}');

const queue = await json(await api(admin, '/applications'));
const mine = queue.find((a) => a.email === `${TAG}-1@example.com`);
check('it is in the queue', !!mine);
check('marked as pending', mine.status === 'Pending', mine.status);
check('with the entity name they gave', mine.entity_name === `${TAG} Family Trust`);
check('their address', /900 Maple Road/.test(mine.address_line1));
check('and what they told us', /Introduced by/.test(mine.note));
check('the count says one is waiting',
  (await json(await api(admin, '/applications/summary'))).pending >= 1);

console.log('\nWHAT IS STORED, AND WHAT IS NOT');
/* Deliberately not asked for on the form. A stranger's first minute on the
   site is the worst moment to ask for a Social Security number, and an
   account can be opened without one. It arrives afterwards, from the
   investor's own Account page or from the office. */
const noTax = await register(applicant(6, { tax_id: '' }));
check('a registration with no tax number at all is accepted', noTax.status === 202,
  String(noTax.status));
const plain = ((await json(await api(admin, '/applications'))) || [])
  .find((a) => a.email === `${TAG}-6@example.com`);
check('and it queues like any other', plain?.status === 'Pending');
check('with nothing shown where the number would be',
  !plain?.tax_id_masked, JSON.stringify(plain?.tax_id_masked));
const approvedPlain = await json(await api(admin, `/applications/${plain.id}/approve`,
  { method: 'POST', body: {} }));
check('approving one still creates the investor', !!approvedPlain.investor_id);
const blank = await json(await api(admin, `/investors/${approvedPlain.investor_id}`));
check('whose record simply has no tax number yet',
  !blank.tax_id_last4, JSON.stringify(blank.tax_id_last4));

console.log('\nTHE INVESTOR CAN SUPPLY IT THEMSELVES, LATER');
const theirLogin = await signIn(`${TAG}-6@example.com`, PASSWORD);
const theirs = theirLogin.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const me6 = await json(await api(theirs, '/auth/me'));
check('their own account says none is on file',
  me6.investor && !me6.investor.tax_id_last4, JSON.stringify(me6.investor));
check('a number that is not nine digits is refused',
  (await api(theirs, '/me/tax-id', { method: 'PUT', body: { tax_id: '123' } })).status === 400);
const supplied = await api(theirs, '/me/tax-id',
  { method: 'PUT', body: { tax_id: '555-66-7788' } });
check('a good one is accepted', supplied.status === 200, String(supplied.status));
check('and the record now carries the last four',
  (await json(await api(admin, `/investors/${approvedPlain.investor_id}`))).tax_id_last4 === '7788');
check('but they cannot change it once it is there',
  (await api(theirs, '/me/tax-id', { method: 'PUT', body: { tax_id: '111-11-1111' } })).status === 409);
check('nor read it back in full',
  (await api(theirs, `/investors/${approvedPlain.investor_id}/tax-id`)).status === 403);
check('while an administrator still can',
  (await json(await api(admin, `/investors/${approvedPlain.investor_id}/tax-id`))).tax_id === '555667788');
check('and their supplying it is on the activity log',
  ((await json(await api(admin, '/audit'))) || [])
    .some((r) => /investor supplied their own tax number/i.test(r.detail || '')));
check('staff cannot use the investor route as a back door',
  (await api(admin, '/me/tax-id', { method: 'PUT', body: { tax_id: '999-99-9999' } })).status === 403);

console.log('\nWHAT IS STORED, AND WHAT IS NOT');
check('the chosen password is nowhere in the response',
  !JSON.stringify(mine).includes(PASSWORD) && !('password_hash' in mine));
check('nor is the tax number, encrypted or otherwise',
  !JSON.stringify(mine).includes('123456789') && !('tax_id_enc' in mine),
  Object.keys(mine).filter((k) => /tax/.test(k)).join(', '));
check('only the last four digits are shown', mine.tax_id_masked === '••-•••6789'
  || mine.tax_id_masked === '•••-••-6789', mine.tax_id_masked);
const revealed = await json(await api(admin, `/applications/${mine.id}/tax-id`));
check('an administrator can read it in full', revealed.tax_id === '123456789', revealed.tax_id);
const audit = await json(await api(admin, '/audit'));
check('and looking at it is written to the audit log',
  (audit || []).some((r) => r.entity === 'application' && /revealed tax id/i.test(r.detail || '')),
  (audit || []).slice(0, 1).map((r) => r.detail).join(''));
check('a manager cannot read it',
  (await api(pm1, `/applications/${mine.id}/tax-id`)).status === 403);
check('nor can an investor', (await api(investor, `/applications/${mine.id}/tax-id`)).status === 403);
check('an investor cannot see the queue at all',
  (await api(investor, '/applications')).status === 403);

console.log('\nNOTHING WORKS UNTIL SOMEBODY SAYS SO');
check('the applicant cannot sign in yet',
  (await signIn(`${TAG}-1@example.com`, PASSWORD)).status === 401);
check('and no login was created for them',
  !((await json(await api(admin, '/users'))) || []).some((u) => u.email === `${TAG}-1@example.com`));
check('nor an investor record',
  !((await json(await api(admin, '/investors'))) || []).some((i) => i.name === `${TAG} Family Trust`));

console.log('\nAPPROVING');
const approved = await json(await api(admin, `/applications/${mine.id}/approve`,
  { method: 'POST', body: { note: 'Spoke to them on the phone.' } }));
check('creates the investor', !!approved.investor_id, JSON.stringify(approved));
check('named as they asked to be held', approved.name === `${TAG} Family Trust`, approved.name);
check('and the login', !!approved.user_id);

const nowIn = await signIn(`${TAG}-1@example.com`, PASSWORD);
check('the password they chose is the password that works', nowIn.status === 200,
  String(nowIn.status));
check('a different one does not', (await signIn(`${TAG}-1@example.com`, 'wrong-password-here')).status === 401);

const cookie = nowIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const me = await json(await api(cookie, '/auth/me'));
check('and they arrive as an investor, not staff', me.role === 'investor', me.role);
check('attached to their own record', me.investor?.id === approved.investor_id);
check('holding nothing yet',
  ((await json(await api(cookie, '/policies?status='))) || []).length === 0);

const created = await json(await api(admin, `/investors/${approved.investor_id}`));
check('the address came across with them', /900 Maple Road/.test(created.address_line1 || ''),
  created.address_line1);
check('and the tax number, still only four digits of it',
  created.tax_id_last4 === '6789' && !JSON.stringify(created).includes('123456789'),
  created.tax_id_last4);

check('the same application cannot be approved twice',
  (await api(admin, `/applications/${mine.id}/approve`, { method: 'POST', body: {} })).status === 409);
check('and it is no longer counted as waiting',
  !((await json(await api(admin, '/applications?status=Pending'))) || [])
    .some((a) => a.id === mine.id));
check('an approved application cannot be deleted while the account it made still exists',
  (await api(admin, `/applications/${mine.id}`, { method: 'DELETE' })).status === 409);

console.log('\nDECLINING');
await register(applicant(2));
const second = ((await json(await api(admin, '/applications'))) || [])
  .find((a) => a.email === `${TAG}-2@example.com`);
check('a second registration queues on its own', !!second && second.status === 'Pending');
const declined = await api(admin, `/applications/${second.id}/decline`,
  { method: 'POST', body: { note: 'Not an accredited investor.' } });
check('declining is accepted', declined.status === 200);
const after = ((await json(await api(admin, '/applications'))) || [])
  .find((a) => a.id === second.id);
check('the record stays, so there is an answer to "did anyone reply"',
  after?.status === 'Declined', after?.status);
check('with the reason and who decided',
  /accredited/i.test(after.decision_note) && !!after.decided_by_name, after.decided_by_name);
check('they still cannot sign in',
  (await signIn(`${TAG}-2@example.com`, PASSWORD)).status === 401);
check('and a declined one cannot be approved after the fact',
  (await api(admin, `/applications/${second.id}/approve`, { method: 'POST', body: {} })).status === 409);

console.log('\nAND IT CANNOT BE USED AS A FIREHOSE');
let refused = 0;
let sent = 0;
/* Enough to run past the cap from a standing start. The cap is set high
   enough that an office registering several clients is not turned away,
   so proving it exists means actually reaching it. */
for (let i = 0; i < 26; i++) {
  const r = await register(applicant(50 + i, { email: `${TAG}-flood-${i}@example.com` }));
  sent++;
  if (r.status === 429) refused++;
}
check('a burst of registrations from one address is cut off', refused > 0,
  `${refused} of ${sent} refused`);
check('and the ones that got through are still just applications',
  ((await json(await api(admin, '/applications'))) || [])
    .filter((a) => /flood/.test(a.email)).every((a) => a.status === 'Pending'));

await wipe();
for (const a of ((await json(await api(admin, '/applications'))) || [])
  .filter((x) => /flood/.test(x.email)))
  await api(admin, `/applications/${a.id}`, { method: 'DELETE' });

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL REGISTRATION CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
