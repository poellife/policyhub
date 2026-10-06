/* =====================================================================
   Deal notes: the desk's own commentary on an opportunity.

   There are already notes on a deal. They are written with an audience
   in mind — the investors shown the sheet — and every member of staff
   can read them. This is the other kind: what the seller actually
   wants, where the price came from, why the last offer was walked away
   from. Administrators only.

   A field like this fails in two directions, so both are under test.
   Reading is the one that matters: a manager who can read it has the
   whole of it. Writing matters too, more quietly — a manager who can
   write has put words somewhere the author believed were private, and
   will go on believing it.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'DEALNOTE';
const PRIVATE = 'Seller is in no hurry — he turned down 19% in March. Do not reopen above 21.';
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
};
await wipe();

/* The manager is scoped to his own owner entities, so the fixture is put
   in one of them. A deal he cannot see at all would pass every check
   below for the wrong reason. */
const mgrCookie = await login(MANAGER1.email, MANAGER1.password);
const mgr = call(mgrCookie);
const mgrFunds = (await json(await mgr('/funds'))) || [];
const fund = mgrFunds[0];
if (!fund) { console.log('  FAIL  the manager has an owner entity to test inside'); process.exit(1); }

console.log('AN ADMINISTRATOR WRITES THEM, AND READS THEM BACK');
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 1500000, fund_id: fund.id, status: 'Open',
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Ada', insured_dob: '1942-03-02',
  le_months: 72, asking_price: 300000, annual_premium: 40000,
  notes: 'Shown to the room on the 3rd.',
  deal_notes: PRIVATE } }));
check('the field is accepted when the deal is created', deal?.deal_notes === PRIVATE,
  String(deal?.deal_notes).slice(0, 60));

const mine = await json(await api(`/opportunities/${deal.id}`));
check('and the deal carries them back to an administrator', mine.deal_notes === PRIVATE);
check('alongside the investors’ notes, which are a different field',
  mine.notes === 'Shown to the room on the 3rd.', mine.notes);

const edited = await json(await api(`/opportunities/${deal.id}`, { method: 'PUT',
  body: { deal_notes: `${PRIVATE} Called again 4 Oct.` } }));
check('they can be rewritten', /4 Oct/.test(edited.deal_notes || ''));
const cleared = await json(await api(`/opportunities/${deal.id}`, { method: 'PUT',
  body: { deal_notes: '' } }));
check('and emptied', cleared.deal_notes === '', JSON.stringify(cleared.deal_notes));
await api(`/opportunities/${deal.id}`, { method: 'PUT', body: { deal_notes: PRIVATE } });

console.log('\nA MANAGER IS NOT SENT THEM AT ALL');
const theirs = await json(await mgr(`/opportunities/${deal.id}`));
check('the manager can see the deal, which is the point', theirs?.id === deal.id,
  JSON.stringify(theirs).slice(0, 80));
check('but the field is absent, not empty', theirs.deal_notes === undefined,
  JSON.stringify(theirs.deal_notes));
check('and the words are nowhere in the reply', !JSON.stringify(theirs).includes('no hurry'));
check('while the investors’ notes still reach him', theirs.notes === 'Shown to the room on the 3rd.');

const list = await json(await mgr('/opportunities'));
const row = (list || []).find((x) => x.id === deal.id);
check('nor are they on the list that lands on his screen first',
  !!row && row.deal_notes === undefined && !JSON.stringify(row).includes('no hurry'));

console.log('\nAND HIS WRITES DO NOT LAND');
const tried = await json(await mgr(`/opportunities/${deal.id}`, { method: 'PUT',
  body: { notes: 'Manager was here.', deal_notes: 'MANAGER WROTE THIS' } }));
check('the rest of his edit goes through', tried?.notes === 'Manager was here.',
  JSON.stringify(tried).slice(0, 80));
const after = await json(await api(`/opportunities/${deal.id}`));
check('and the private notes are untouched', after.deal_notes === PRIVATE,
  String(after.deal_notes).slice(0, 60));

const made = await json(await mgr('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-2`, carrier_name: 'Northbank Life', fund_id: fund.id,
  insured_last_name: `${PREFIX}Two`, deal_notes: 'MANAGER WROTE THIS' } }));
const madeBack = await json(await api(`/opportunities/${made.id}`));
check('nor can he smuggle them in on a deal he creates', !madeBack.deal_notes,
  JSON.stringify(madeBack.deal_notes));

console.log('\nAND AN INVESTOR IS NOWHERE NEAR THEM');
const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const inv = call(invCookie);
const me = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: invCookie } })))
  .investor.id;
await api(`/opportunities/${deal.id}/shares`, { method: 'PUT', body: { investor_ids: [me] } });
const shown = await json(await inv(`/opportunities/${deal.id}`));
check('the deal reaches the investor it was shared with', shown?.id === deal.id,
  JSON.stringify(shown).slice(0, 80));
check('and carries no trace of the desk’s notes',
  shown.deal_notes === undefined && !JSON.stringify(shown).includes('no hurry'));

console.log('\nAND WHO SENT US THE DEAL');
await api(`/opportunities/${deal.id}`, { method: 'PUT', body: {
  source_name: 'Abacus Settlements', source_contact: 'Marty Feld \u00b7 248-555-0134',
  source_on: '2026-09-18' } });
const sourced = await json(await api(`/opportunities/${deal.id}`));
check('an administrator can record the introducer',
  sourced.source_name === 'Abacus Settlements', String(sourced.source_name));
check('with a person at that firm', /Marty Feld/.test(String(sourced.source_contact)));
check('and the date it arrived', String(sourced.source_on).startsWith('2026-09-18'),
  String(sourced.source_on));

const mgrSource = await json(await mgr(`/opportunities/${deal.id}`));
check('a manager is not told who sent it', mgrSource.source_name === undefined
  && !JSON.stringify(mgrSource).includes('Abacus'), JSON.stringify(mgrSource.source_name));
await mgr(`/opportunities/${deal.id}`, { method: 'PUT',
  body: { source_name: 'MANAGER WROTE THIS' } });
check('nor can he change it',
  (await json(await api(`/opportunities/${deal.id}`))).source_name === 'Abacus Settlements');
const invSource = await json(await inv(`/opportunities/${deal.id}`));
check('and an investor is nowhere near it', invSource.source_name === undefined
  && !JSON.stringify(invSource).includes('Abacus'));

console.log('\nAND THE LOG BESIDE THE STANDING NOTE');
/* The column above is a summary and is replaced each time it is edited.
   A negotiation arrives one call at a time, so it goes in entries. */
const n1 = await json(await api(`/opportunities/${deal.id}/notes`, { method: 'POST',
  body: { body: 'He came back at 22. Says the son is the holdup.' } }));
check('an entry can be added', !!n1?.id, JSON.stringify(n1?.error));
await new Promise((r) => { setTimeout(r, 1100); });
await api(`/opportunities/${deal.id}/notes`, { method: 'POST',
  body: { body: 'Quiet since the 9th. Broker chasing.' } });
const withLog = await json(await api(`/opportunities/${deal.id}`));
check('both are on the deal', (withLog.deal_note_log || []).length === 2,
  String((withLog.deal_note_log || []).length));
check('newest first, because that is what you came to read',
  /Quiet since/.test(withLog.deal_note_log[0].body), withLog.deal_note_log[0].body);
check('each is signed', !!withLog.deal_note_log[0].created_by_name,
  String(withLog.deal_note_log[0].created_by_name));
check('and dated', !!withLog.deal_note_log[0].created_at);
check('and the standing note is untouched by any of it',
  withLog.deal_notes === PRIVATE, String(withLog.deal_notes).slice(0, 40));

const empty = await api(`/opportunities/${deal.id}/notes`, { method: 'POST',
  body: { body: '   ' } });
check('an empty entry is refused rather than filed', empty.status === 400, String(empty.status));

const gone = await json(await api(`/opportunities/${deal.id}/notes/${n1.id}`,
  { method: 'DELETE' }));
check('one typed onto the wrong deal can be deleted', (gone?.log || []).length === 1,
  JSON.stringify(gone?.error));

console.log('\nAND THE LOG IS AS PRIVATE AS THE FIELD');
const mgrLog = await json(await mgr(`/opportunities/${deal.id}`));
check('a manager is not sent it', mgrLog.deal_note_log === undefined
  && !JSON.stringify(mgrLog).includes('son is the holdup'),
  JSON.stringify(mgrLog.deal_note_log));
const mgrWrite = await mgr(`/opportunities/${deal.id}/notes`, { method: 'POST',
  body: { body: 'MANAGER WROTE THIS' } });
check('nor may he add to it', mgrWrite.status === 403, String(mgrWrite.status));
const invLog = await json(await inv(`/opportunities/${deal.id}`));
check('and an investor is nowhere near it', invLog.deal_note_log === undefined
  && !JSON.stringify(invLog).includes('Quiet since'));

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All deal notes checks passed.'}`);
process.exit(fails.length ? 1 : 0);
