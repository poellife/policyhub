/* =====================================================================
   Whose client is this?

   An investor's holdings say where their money is. This says who looks
   after them — the entity the relationship belongs to — and it is what
   puts a newly approved investor in front of the right manager before
   they hold anything at all.

   Two rules carry the weight, and both are checked here rather than
   assumed:

     - only an administrator may set it. A manager who could assign an
       investor to their own entity would be handing themselves a client
       they were not given.
     - it grants sight of the person, not of their book. A manager who
       sees an investor because of the assignment must still see zero
       against policies held in somebody else's entity.

   And the rest of the record — the address and telephone number they
   typed into the registration form, the tax number — has to be editable,
   because people move house.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, MANAGER2, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'ENTLINK';
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
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const pm2 = await login(MANAGER2.email, MANAGER2.password);
const investor = await login(INVESTOR1.email, INVESTOR1.password);

const wipe = async () => {
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  for (const i of ((await json(await api(admin, '/investors'))) || [])
    .filter((x) => String(x.name).startsWith(PREFIX)))
    await api(admin, `/investors/${i.id}`, { method: 'DELETE' });
  for (const a of ((await json(await api(admin, '/applications'))) || [])
    .filter((x) => String(x.email).includes(PREFIX.toLowerCase()))) {
    if (a.user_id) await api(admin, `/users/${a.user_id}`, { method: 'DELETE' });
    if (a.investor_id) await api(admin, `/investors/${a.investor_id}`, { method: 'DELETE' });
    await api(admin, `/applications/${a.id}`, { method: 'DELETE' });
  }
};
await wipe();

const funds = await json(await api(admin, '/funds'));
const mine = funds.find((f) => f.code === 'LCG1');       // pm1's entity
const theirs = funds.find((f) => f.code === 'LCG2');     // pm2's entity
check('the two entities the managers run are on file', !!mine && !!theirs,
  funds.map((f) => f.code).join(', '));

console.log('AN INVESTOR WITH NOBODY LOOKING AFTER THEM');
const created = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Holdings Trust`, investor_type: 'Trust',
  email: `${PREFIX.toLowerCase()}@example.com`, phone: '(248) 555-0000',
  address_line1: '1 Founders Way', city: 'Southfield', state: 'MI', postal_code: '48075',
  tax_id: '111-22-3333' } }));
check('is created', !!created?.id, JSON.stringify(created).slice(0, 120));
check('with no entity against them', created.fund_id === null, String(created.fund_id));
check('and their tax number sealed on the way in', created.tax_id_last4 === '3333',
  created.tax_id_last4);
check('which is not in the response, encrypted or otherwise',
  !JSON.stringify(created).includes('111223333'),
  Object.keys(created).filter((k) => /tax/.test(k)).join(', '));

const seenBy = async (cookie) => ((await json(await api(cookie, '/investors'))) || [])
  .some((i) => i.id === created.id);
check('no manager can see them yet', !(await seenBy(pm1)) && !(await seenBy(pm2)));

console.log('\nASSIGNING ONE');
/* The two managers do not run the same list: one covers LCG1 alone, the
   other covers both. So the pair that actually proves the rule is an
   investor put into LCG2 — visible to the manager who runs it, invisible
   to the one who does not. */
const away = await json(await api(admin, `/investors/${created.id}`,
  { method: 'PUT', body: { fund_id: theirs.id } }));
check('the record says which entity', away.fund_code === 'LCG2', away.fund_code);
check('and that entity’s manager sees them straight away', await seenBy(pm2));
check('while a manager who does not run it does not', !(await seenBy(pm1)));
check('nor can that manager open the record',
  (await api(pm1, `/investors/${created.id}`)).status === 404);

const assigned = await json(await api(admin, `/investors/${created.id}`,
  { method: 'PUT', body: { fund_id: mine.id } }));
check('moving them across hands them to the other manager',
  assigned.fund_code === 'LCG1' && (await seenBy(pm1)), assigned.fund_code);
check('the investor themselves is told nothing about entities',
  (await api(investor, '/investors')).status === 403);

const row = ((await json(await api(pm1, '/investors'))) || []).find((i) => i.id === created.id);
check('the manager sees the entity on the row', row.fund_code === 'LCG1', row.fund_code);
check('and zero against them, because they hold nothing yet',
  Number(row.position_count) === 0 && Number(row.invested) === 0,
  `${row.position_count} positions · ${row.invested} invested`);
check('the manager can open their record', (await api(pm1, `/investors/${created.id}`)).status === 200);

console.log('\nSIGHT OF THE PERSON IS NOT SIGHT OF THEIR BOOK');
/* Give them a position in the OTHER manager's entity. pm1 must keep
   seeing the person — they are still their client — and must keep seeing
   nothing at all of what that position is worth. */
const elsewhere = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-OTHER`, carrier_name: 'Entity Life', product_type: 'UL',
  fund_code: 'LCG2', face_amount: 5000000, premium_required: 40000, premium_mode: 'Annual',
  acquisition_date: iso(-300), acquisition_cost: 600000,
  insured_last_name: `${PREFIX}far`, insured_first_name: 'Ada', dob: '1938-02-02' } }));
await api(admin, `/policies/${elsewhere.id}/transactions`, { method: 'POST', body: {
  txn_date: iso(-300), txn_type: 'Acquisition Cost', amount: 600000 } });
await api(admin, `/policies/${elsewhere.id}/investors`, { method: 'POST', body: {
  investor_id: created.id, pct: 40, acquired_on: iso(-300) } });

const afterRow = ((await json(await api(pm1, '/investors'))) || [])
  .find((i) => i.id === created.id);
check('their own manager still has them on the list', !!afterRow);
check('and still sees nothing of a position held elsewhere',
  Number(afterRow.position_count) === 0 && Number(afterRow.death_benefit) === 0,
  `${afterRow.position_count} positions · ${afterRow.death_benefit} death benefit`);
const adminRow = ((await json(await api(admin, '/investors'))) || [])
  .find((i) => i.id === created.id);
check('while an administrator sees the position for what it is',
  Number(adminRow.position_count) === 1 && Number(adminRow.death_benefit) > 0,
  `${adminRow.position_count} positions · ${adminRow.death_benefit}`);
check('and the other entity’s manager sees them for holding it',
  await seenBy(pm2));

console.log('\nONLY AN ADMINISTRATOR MAY REASSIGN');
const attempt = await api(pm1, `/investors/${created.id}`, { method: 'PUT', body: {
  fund_id: theirs.id, phone: '(248) 555-9999' } });
check('a manager’s attempt is not an error', attempt.status === 200, String(attempt.status));
const afterAttempt = await json(await api(admin, `/investors/${created.id}`));
check('but the entity is untouched', afterAttempt.fund_code === 'LCG1', afterAttempt.fund_code);
check('and the rest of their edit went through, as it should',
  afterAttempt.phone === '(248) 555-9999', afterAttempt.phone);

console.log('\nEVERYTHING THEY TYPED AT SIGN-UP CAN BE CORRECTED');
const edited = await json(await api(admin, `/investors/${created.id}`, { method: 'PUT', body: {
  address_line1: '77 Cranbrook Road', address_line2: 'Suite 4',
  city: 'Bloomfield Hills', state: 'MI', postal_code: '48304',
  country: 'United States', email: `${PREFIX.toLowerCase()}-new@example.com`,
  legal_name: `${PREFIX} Holdings Trust u/a 2019` } }));
check('the address moves with them', edited.address_line1 === '77 Cranbrook Road',
  edited.address_line1);
check('so does the city and ZIP',
  edited.city === 'Bloomfield Hills' && edited.postal_code === '48304',
  `${edited.city} ${edited.postal_code}`);
check('and the email', /new@example.com$/.test(edited.email), edited.email);

const replaced = await json(await api(admin, `/investors/${created.id}`, { method: 'PUT', body: {
  tax_id: '444-55-6666' } }));
check('a new tax number replaces the old one', replaced.tax_id_last4 === '6666',
  replaced.tax_id_last4);
check('and reads back in full for an administrator',
  (await json(await api(admin, `/investors/${created.id}/tax-id`))).tax_id === '444556666');
check('a manager cannot read it',
  (await api(pm1, `/investors/${created.id}/tax-id`)).status === 403);
const auditRows = await json(await api(admin, '/audit'));
check('and both the replacement and the reading are on the record',
  (auditRows || []).some((r) => /tax number replaced/i.test(r.detail || ''))
  && (auditRows || []).some((r) => /revealed tax id for ENTLINK/i.test(r.detail || '')));
check('a tax number that is not nine digits is refused',
  (await api(admin, `/investors/${created.id}`, { method: 'PUT', body: { tax_id: '123' } })).status === 400);
check('and the good one is still there afterwards',
  (await json(await api(admin, `/investors/${created.id}`))).tax_id_last4 === '6666');

console.log('\nASSIGNED AT THE MOMENT OF APPROVAL');
await api(admin, '/register-throttle', { method: 'DELETE', body: {} });
await fetch(`${BASE}/api/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    full_name: 'Approval Assignment', entity_name: `${PREFIX} Approved LLC`,
    investor_type: 'Entity', email: `${PREFIX.toLowerCase()}-approve@example.com`,
    password: 'a-good-long-password-here', phone: '(248) 555-0101',
    address_line1: '5 Register Road', city: 'Southfield', state: 'MI',
    postal_code: '48075', tax_id: '222-33-4444' }) });
const pending = ((await json(await api(admin, '/applications'))) || [])
  .find((a) => a.email === `${PREFIX.toLowerCase()}-approve@example.com`);
check('the registration is waiting', !!pending);
const approved = await json(await api(admin, `/applications/${pending.id}/approve`,
  { method: 'POST', body: { fund_id: mine.id } }));
check('approving with an entity assigns it there and then',
  approved.fund_id === mine.id, String(approved.fund_id));
const newRow = ((await json(await api(pm1, '/investors'))) || [])
  .find((i) => i.id === approved.investor_id);
check('so the manager has them before they hold anything', !!newRow,
  newRow ? newRow.fund_code : 'not in the list');
check('and their address came across from the form',
  /5 Register Road/.test((await json(await api(admin, `/investors/${approved.investor_id}`)))
    .address_line1 || ''));

console.log('\nFILTERING THE LIST BY ENTITY');
const all = ((await json(await api(admin, '/investors'))) || []).length;
const inMine = ((await json(await api(admin, '/investors?fund=LCG1'))) || []);
check('the investor list narrows to one entity', inMine.length < all,
  `${inMine.length} of ${all}`);
check('and everyone in it belongs to that entity',
  inMine.every((i) => i.fund_code === 'LCG1'),
  inMine.map((i) => i.fund_code).join(','));
check('our two fixtures are among them',
  inMine.filter((i) => String(i.name).startsWith(PREFIX)).length === 2,
  inMine.filter((i) => String(i.name).startsWith(PREFIX)).map((i) => i.name).join(', '));

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL INVESTOR ENTITY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
