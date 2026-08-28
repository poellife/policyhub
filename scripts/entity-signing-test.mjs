/* =====================================================================
   Signing on behalf of an entity.

   A company, a trust or an IRA cannot hold a pen. Where the party to an
   agreement is one, the signature line needs both halves: the entity,
   which is what is bound, and the human being signing for it in the
   capacity that gives them the authority.

   Getting this wrong is invisible until somebody tries to enforce the
   agreement. Two ways round:

     - the entity name alone. "Kestrel Holdings LLC" typed into a box says
       nothing about who typed it or whether they could.
     - the person's name alone. "Ellen Ward" binds Ellen, personally, and
       not the company she meant to sign for.

   And one thing that must NOT change: an individual signs the way they
   always have, with their own name and nothing else to fill in.

   Idempotent: its own investors and agreement, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, login, scratchPassword } from './test-config.mjs';
import { renderAgreement, canonicalText } from '../public/agreement-template.js';

const PREFIX = 'ENTSIGN';
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

const wipe = async () => {
  for (const a of ((await json(await api(admin, '/agreements'))) || []))
    if (String(a.title || '').startsWith(PREFIX)) {
      if (a.status !== 'Draft')
        await api(admin, `/agreements/${a.id}/recall`, { method: 'POST' });
      await api(admin, `/agreements/${a.id}`, { method: 'DELETE' });
    }
  for (const u of ((await json(await api(admin, '/users'))) || []))
    if (String(u.email).startsWith(PREFIX.toLowerCase())) await api(admin, `/users/${u.id}`, { method: 'DELETE' });
  for (const i of ((await json(await api(admin, '/investors'))) || []))
    if (String(i.name).startsWith(PREFIX)) await api(admin, `/investors/${i.id}`, { method: 'DELETE' });
};
await wipe();

/* Three parties: a company, a trust, and a person — so the rule and its
   exception are both exercised on the same document. */
const makeInvestor = async (name, type) => json(await api(admin, '/investors', {
  method: 'POST', body: { name, investor_type: type, email: `${name.replace(/\W/g, '')}@test.local` } }));
const company = await makeInvestor(`${PREFIX} Kestrel Holdings LLC`, 'Entity');
const trust = await makeInvestor(`${PREFIX} Ward Family Trust`, 'Trust');
const person = await makeInvestor(`${PREFIX} Ellen Ward`, 'Individual');

const loginFor = async (investor, tag) => {
  const email = `${PREFIX.toLowerCase()}-${tag}@test.local`;
  const pw = scratchPassword(tag);
  await api(admin, '/users', { method: 'POST', body: {
    email, password: pw, full_name: investor.name, role: 'investor', investor_id: investor.id } });
  return login(email, pw);
};

const agreement = await json(await api(admin, '/agreements', { method: 'POST', body: {
  title: `${PREFIX} operating agreement`,
  terms: { llc_name: `${PREFIX} Fund I LLC`, manager_name: 'Poel Capital LLC',
    state: 'Michigan', effective_date: iso(-1), purpose: 'Life settlements',
    manager_fee: '2', capital_call_days: '10' } } }));

await api(admin, `/agreements/${agreement.id}/signers`, { method: 'PUT', body: { signers: [
  // The firm itself, which is an entity and therefore signs through somebody.
  { role: 'Manager', name: 'Poel Capital LLC' },
  { investor_id: company.id, name: company.name, contribution: 500000, pct: 50 },
  { investor_id: trust.id, name: trust.name, contribution: 300000, pct: 30 },
  { investor_id: person.id, name: person.name, contribution: 200000, pct: 20 },
] } });

console.log('WHAT KIND OF PARTY EACH ONE IS, TAKEN FROM THE RECORD');
let a = await json(await api(admin, `/agreements/${agreement.id}`));
const partyOf = (name) => a.signers.find((s) => s.name === name);
check('a company is marked as one', partyOf(company.name).party_type === 'Entity',
  partyOf(company.name).party_type);
check('a trust as a trust', partyOf(trust.name).party_type === 'Trust',
  partyOf(trust.name).party_type);
check('and a person as an individual', partyOf(person.name).party_type === 'Individual',
  partyOf(person.name).party_type);
check('the manager is an entity too — the firm signs through somebody',
  a.signers.find((s) => s.role === 'Manager').party_type === 'Entity');

/* Frozen on the agreement rather than re-read: a record edited while the
   document is out for signature must not change what the signature needs. */
await api(admin, `/investors/${company.id}`, { method: 'PUT', body: {
  name: company.name, investor_type: 'Individual' } });
a = await json(await api(admin, `/agreements/${agreement.id}`));
check('changing the investor record afterwards does not change the agreement',
  partyOf(company.name).party_type === 'Entity', partyOf(company.name).party_type);
await api(admin, `/investors/${company.id}`, { method: 'PUT', body: {
  name: company.name, investor_type: 'Entity' } });

console.log('\nTHE DOCUMENT ASKS FOR BOTH');
const blocks = renderAgreement(a.terms, a.signers);
const sigs = blocks.filter((b) => b.type === 'signature');
check('an entity’s signature block is marked as needing a person',
  sigs.find((b) => b.caption === company.name)?.entity === true);
check('a trust’s too', sigs.find((b) => b.caption === trust.name)?.entity === true);
check('an individual’s is not', sigs.find((b) => b.caption === person.name)?.entity === false);
/* The hash covers the words the parties agreed to. How a signature line is
   laid out is not one of them — putting it in would mean every document
   already out for signature no longer matched itself. */
const withFlag = canonicalText(blocks);
const withoutFlag = canonicalText(blocks.map((b) =>
  (b.type === 'signature' ? { ...b, entity: false } : b)));
check('and none of this changes the text being signed', withFlag === withoutFlag);

await api(admin, `/agreements/${agreement.id}/issue`, { method: 'POST' });
a = await json(await api(admin, `/agreements/${agreement.id}`));
check('the agreement is out for signature', a.status === 'Out for signature', a.status);

console.log('\nA COMPANY CANNOT SIGN ON ITS OWN');
const asCompany = await loginFor(company, 'co');
const sign = (cookie, body) => api(cookie, `/agreements/${agreement.id}/sign`,
  { method: 'POST', body: { agreed: true, body_hash: a.body_hash, ...body } });

const nameOnly = await sign(asCompany, { signed_name: company.name });
check('the entity name by itself is refused', nameOnly.status === 400, String(nameOnly.status));
check('and the message says why, in words a person can act on',
  /signs through a person/i.test((await json(nameOnly))?.error || ''),
  (await json(nameOnly))?.error);

const personOnly = await sign(asCompany, { signed_name: 'Ellen Ward' });
check('signing your own name instead is refused too — it would bind you, not the company',
  personOnly.status === 400);
check('with the reason being the party name, not the missing person',
  /that is the name this agreement is drawn in/i.test((await json(personOnly))?.error || ''),
  (await json(personOnly))?.error);

const noTitle = await sign(asCompany, {
  signed_name: company.name, signed_by_name: 'Ellen Ward' });
check('a person with no capacity is refused', noTitle.status === 400);
check('and is told what a capacity is',
  /capacity/i.test((await json(noTitle))?.error || ''), (await json(noTitle))?.error);

const echoed = await sign(asCompany, {
  signed_name: company.name, signed_by_name: company.name, signed_by_title: 'Manager' });
check('repeating the entity name as the person is refused',
  echoed.status === 400, (await json(echoed))?.error);
const initialOnly = await sign(asCompany, {
  signed_name: company.name, signed_by_name: '.', signed_by_title: 'Manager' });
check('and so is something that is not a name', initialOnly.status === 400);

console.log('\nBOTH HALVES, AND IT SIGNS');
const done = await sign(asCompany, {
  signed_name: company.name, signed_by_name: 'Ellen Ward', signed_by_title: 'Managing Member' });
check('the entity and the person together are accepted', done.status === 200,
  JSON.stringify(await json(done)));
a = await json(await api(admin, `/agreements/${agreement.id}`));
const signed = partyOf(company.name);
check('the party bound is the company', signed.signed_name === company.name, signed.signed_name);
check('the person who bound it is recorded', signed.signed_by_name === 'Ellen Ward',
  signed.signed_by_name);
check('with the capacity they signed in', signed.signed_by_title === 'Managing Member',
  signed.signed_by_title);
check('the activity log carries both',
  ((await json(await api(admin, '/audit'))) || []).some((r) =>
    /Ellen Ward, Managing Member/.test(r.detail || '')));
check('and the signature block prints both',
  renderAgreement(a.terms, a.signers)
    .find((b) => b.type === 'signature' && b.caption === company.name)
    ?.signed?.signed_by_title === 'Managing Member');
check('signing twice is still refused', (await sign(asCompany, {
  signed_name: company.name, signed_by_name: 'Ellen Ward', signed_by_title: 'Managing Member' }))
  .status === 409);

console.log('\nA TRUST SIGNS BY ITS TRUSTEE');
const asTrust = await loginFor(trust, 'tr');
const trustNoPerson = await api(asTrust, `/agreements/${agreement.id}/sign`, {
  method: 'POST', body: { signed_name: trust.name, agreed: true, body_hash: a.body_hash } });
check('the trust name alone is refused', trustNoPerson.status === 400);
check('and it is called a trust, not an entity',
  /is a trust/i.test((await json(trustNoPerson))?.error || ''),
  (await json(trustNoPerson))?.error);
const trustOk = await api(asTrust, `/agreements/${agreement.id}/sign`, {
  method: 'POST', body: { signed_name: trust.name, signed_by_name: 'Marcus Ward',
    signed_by_title: 'Trustee', agreed: true, body_hash: a.body_hash } });
check('trustee and trust together sign it', trustOk.status === 200);

console.log('\nA PERSON SIGNS THE WAY THEY ALWAYS HAVE');
const asPerson = await loginFor(person, 'pp');
const plain = await api(asPerson, `/agreements/${agreement.id}/sign`, {
  method: 'POST', body: { signed_name: person.name, agreed: true, body_hash: a.body_hash } });
check('their own name and nothing else', plain.status === 200, JSON.stringify(await json(plain)));
a = await json(await api(admin, `/agreements/${agreement.id}`));
check('and nothing is recorded about signing on behalf of anybody',
  partyOf(person.name).signed_by_name === '' && partyOf(person.name).signed_by_title === '',
  `${partyOf(person.name).signed_by_name}/${partyOf(person.name).signed_by_title}`);

console.log('\nAND SO DOES THE FIRM');
const managerNoPerson = await api(admin, `/agreements/${agreement.id}/sign`, {
  method: 'POST', body: { signed_name: 'Poel Capital LLC', agreed: true, body_hash: a.body_hash } });
check('the manager cannot sign as a name on a page either', managerNoPerson.status === 400,
  (await json(managerNoPerson))?.error);
const managerOk = await api(admin, `/agreements/${agreement.id}/sign`, {
  method: 'POST', body: { signed_name: 'Poel Capital LLC', signed_by_name: 'Jonathan Polter',
    signed_by_title: 'Manager', agreed: true, body_hash: a.body_hash } });
check('with a person and a capacity, it does', managerOk.status === 200);
a = await json(await api(admin, `/agreements/${agreement.id}`));
check('the agreement is fully executed', a.status === 'Executed', a.status);
check('and the executed copy is filed', !!a.document_id);

console.log('\nRECALLING CLEARS WHO SIGNED FOR WHOM');
await api(admin, `/agreements/${agreement.id}/void`, { method: 'POST', body: { reason: 'test' } });
a = await json(await api(admin, `/agreements/${agreement.id}`));
check('a voided agreement keeps its signatures', partyOf(company.name).signed_by_name === 'Ellen Ward');


console.log('\nA PARTY WITH NO RECORD TO READ');
/* Somebody who is not an investor on file has no `investor_type` to consult,
   so the legal suffix on the name is the default — and whoever draws the
   agreement can always say otherwise. */
const spare = await json(await api(admin, '/agreements', { method: 'POST', body: {
  title: `${PREFIX} second agreement`,
  terms: { llc_name: `${PREFIX} Fund II LLC`, manager_name: 'Alan Spiegel',
    state: 'Michigan', effective_date: iso(-1), purpose: 'Life settlements',
    manager_fee: '2', capital_call_days: '10' } } }));
await api(admin, `/agreements/${spare.id}/signers`, { method: 'PUT', body: { signers: [
  { role: 'Manager', name: 'Alan Spiegel' },
  { name: `${PREFIX} Bellwether Capital LLC` },
  { name: `${PREFIX} Hartley Revocable Trust` },
  { name: `${PREFIX} Marcus Hartley` },
  { name: `${PREFIX} Quietly An Entity`, party_type: 'Entity' },
] } });
const two = await json(await api(admin, `/agreements/${spare.id}`));
const kind = (n) => two.signers.find((s) => s.name === n)?.party_type;
check('a manager who is a person signs as one', kind('Alan Spiegel') === 'Individual',
  kind('Alan Spiegel'));
check('a legal suffix is read as an entity',
  kind(`${PREFIX} Bellwether Capital LLC`) === 'Entity', kind(`${PREFIX} Bellwether Capital LLC`));
check('and a trust as a trust',
  kind(`${PREFIX} Hartley Revocable Trust`) === 'Trust', kind(`${PREFIX} Hartley Revocable Trust`));
check('an ordinary name is left alone',
  kind(`${PREFIX} Marcus Hartley`) === 'Individual', kind(`${PREFIX} Marcus Hartley`));
check('and whoever draws the agreement can say otherwise',
  kind(`${PREFIX} Quietly An Entity`) === 'Entity', kind(`${PREFIX} Quietly An Entity`));
await api(admin, `/agreements/${spare.id}`, { method: 'DELETE' });

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL ENTITY SIGNING CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
