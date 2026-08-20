/* =====================================================================
   Arranging the policies grid — the part that is stored.

   A column layout is a convenience, but it is still something one login
   writes and another reads, so it gets the same treatment as anything
   else that crosses that line:

     - it is always the caller's own. There is no user id in the path, and
       an admin saving an arrangement must not touch anybody else's.
     - only names the application knows are accepted, so the preferences
       table cannot be used as a parking space for whatever a client posts.
     - what comes back out is rebuilt from the field catalogue, so a value
       edited in the database into something strange reaches the grid as a
       list of known column keys or not at all.

   And the arrangement itself has to survive the catalogue changing: a
   layout saved before a field existed, or by somebody who can see fields
   the reader cannot, must still open.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, MANAGER1, login, scratchPassword } from './test-config.mjs';
import { POLICY_FIELDS, arrangeFields, packArrangement, cleanArrangement }
  from '../public/policy-fields.js';

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

const admin = await login(ADMIN.email, ADMIN.password);
const manager = await login(MANAGER1.email, MANAGER1.password);
const inv = await login(INVESTOR1.email, INVESTOR1.password);

const clear = async (c) => api(c, '/me/prefs/policy_columns', { method: 'DELETE' });
for (const c of [admin, manager, inv]) await clear(c);

console.log('THE CATALOGUE IS THE WHOLE LIST');
const keys = POLICY_FIELDS.map((f) => f.key);
check('every field has a key of its own', new Set(keys).size === keys.length);
check('every field says what it is and where it belongs',
  POLICY_FIELDS.every((f) => f.key && f.header && f.type && f.group));
check('there are more fields than the grid opens with',
  POLICY_FIELDS.length > POLICY_FIELDS.filter((f) => f.default).length,
  `${POLICY_FIELDS.filter((f) => f.default).length} of ${POLICY_FIELDS.length} by default`);
/* Every column drawn on the grid is one of these, and every one of these can
   be drawn — the same list on both sides is what stops a saved arrangement
   naming something the screen cannot render. */
const staffDefault = arrangeFields(null, { investor: false })
  .filter((f) => f.visible).map((f) => f.key);
check('the default arrangement is the grid as it has always been',
  staffDefault.join(',') === ['policy_number', 'insured_last', 'insured_first', 'insured_dob',
    'age', 'insured_gender', 'carrier_name', 'product_type', 'issue_date', 'face_amount',
    'death_benefit', 'fund_code', 'premium_required', 'account_value', 'cash_surrender_value',
    'cost_of_insurance', 'total_invested', 'date_of_last_withdrawal', 'value_as_of',
    'status'].join(','),
  staffDefault.join(' · '));

const invDefault = arrangeFields(null, { investor: true }).filter((f) => f.visible).map((f) => f.key);
check('an investor’s default puts their share second', invDefault[1] === 'my_pct',
  invDefault.slice(0, 3).join(' · '));
check('and offers them none of the carrier’s administration',
  !invDefault.some((k) => ['account_value', 'cash_surrender_value', 'cost_of_insurance',
    'value_as_of', 'date_of_last_withdrawal'].includes(k)));
check('nor is any of it even on their picker',
  !arrangeFields(null, { investor: true }).some((f) => f.staffOnly));
check('and staff are not offered the investor’s own share column',
  !arrangeFields(null, { investor: false }).some((f) => f.key === 'my_pct'));

console.log('\nAN ARRANGEMENT SURVIVES THE CATALOGUE MOVING UNDER IT');
const stale = { order: ['status', 'policy_number', 'a_field_from_2019'], hidden: ['carrier_name'] };
const rebuilt = arrangeFields(stale, { investor: false });
check('a field that no longer exists is dropped, not fatal',
  !rebuilt.some((f) => f.key === 'a_field_from_2019'));
check('what was named keeps the order it was given',
  rebuilt[0].key === 'status' && rebuilt[1].key === 'policy_number',
  rebuilt.slice(0, 3).map((f) => f.key).join(' · '));
check('a field the arrangement never mentioned is still there',
  rebuilt.some((f) => f.key === 'total_invested'));
/* Appended, never inserted. Sliding a field somebody has never seen into the
   middle of a layout they arranged by hand moves their columns for them. */
check('and waits at the end rather than pushing into the middle of the order',
  rebuilt.findIndex((f) => f.key === 'total_invested') > 1,
  rebuilt.map((f) => f.key).slice(0, 5).join(' · '));
/* And it obeys the catalogue on whether it shows at all: "not hidden,
   therefore on" would put every field added in future onto the grid of
   everybody who has ever arranged one. */
check('a field added after the arrangement was saved shows only if it is a default',
  rebuilt.find((f) => f.key === 'total_invested').visible
  && !rebuilt.find((f) => f.key === 'loan_balance').visible,
  `invested ${rebuilt.find((f) => f.key === 'total_invested').visible} · loan ${
    rebuilt.find((f) => f.key === 'loan_balance').visible}`);
check('what was switched off is off', !rebuilt.find((f) => f.key === 'carrier_name').visible);
check('and everything else the arrangement named is on',
  rebuilt.find((f) => f.key === 'status').visible);
/* Once somebody has arranged the grid, `hidden` is the whole truth. A field
   they deliberately switched ON that was never a default must not come back
   off just because the catalogue does not think of it as one. */
const turnedOn = arrangeFields({ order: ['loan_balance', 'policy_number'], hidden: [] },
  { investor: false });
check('a non-default field they switched on stays on',
  turnedOn.find((f) => f.key === 'loan_balance').visible);

console.log('\nWHAT MAY BE STORED');
check('an arrangement of known fields is accepted',
  !!cleanArrangement({ order: ['status', 'policy_number'], hidden: ['status'] }));
check('unknown keys are stripped rather than stored',
  cleanArrangement({ order: ['status', 'rm -rf', '<script>'], hidden: [] }).order.join(',')
    === 'status');
check('duplicates are collapsed',
  cleanArrangement({ order: ['status', 'status'], hidden: [] }).order.length === 1);
check('an arrangement naming nothing at all is refused',
  cleanArrangement({ order: ['nope'], hidden: [] }) === null);
check('and so is anything that is not an arrangement',
  [null, 'x', 42, [], { hidden: ['status'] }].every((v) => cleanArrangement(v) === null));

console.log('\nOVER THE WIRE');
check('nothing is stored until something is saved',
  Object.keys(await json(await api(admin, '/me/prefs'))).length === 0);
const mine = { order: ['status', 'policy_number', 'carrier_name'], hidden: ['carrier_name'] };
const saved = await json(await api(admin, '/me/prefs/policy_columns',
  { method: 'PUT', body: mine }));
check('an arrangement saves and reads back as it went in',
  JSON.stringify(saved.order) === JSON.stringify(mine.order));
check('and is there on the next request',
  JSON.stringify((await json(await api(admin, '/me/prefs'))).policy_columns.order)
    === JSON.stringify(mine.order));
check('a second save replaces rather than duplicates',
  (await json(await api(admin, '/me/prefs/policy_columns', { method: 'PUT',
    body: { order: ['policy_number'], hidden: [] } }))).order.length === 1);
check('rubbish is refused with a message, not stored',
  (await api(admin, '/me/prefs/policy_columns', { method: 'PUT',
    body: { order: ['not_a_field'] } })).status === 400);
check('the refusal did not disturb what was already saved',
  (await json(await api(admin, '/me/prefs'))).policy_columns.order.join(',') === 'policy_number');
check('a preference name the application does not know is a 404',
  (await api(admin, '/me/prefs/anything_else', { method: 'PUT', body: { order: ['status'] } }))
    .status === 404);
check('a very long arrangement cannot grow past the catalogue',
  (await json(await api(admin, '/me/prefs/policy_columns', { method: 'PUT', body: {
    order: [...keys, ...keys, ...keys], hidden: [] } }))).order.length === keys.length);

console.log('\nIT IS PERSONAL');
await api(manager, '/me/prefs/policy_columns', { method: 'PUT',
  body: { order: ['carrier_name', 'policy_number'], hidden: [] } });
await api(inv, '/me/prefs/policy_columns', { method: 'PUT',
  body: { order: ['my_pct', 'policy_number'], hidden: [] } });
const a2 = (await json(await api(admin, '/me/prefs'))).policy_columns;
const m2 = (await json(await api(manager, '/me/prefs'))).policy_columns;
const i2 = (await json(await api(inv, '/me/prefs'))).policy_columns;
check('three logins, three arrangements',
  a2.order[0] !== m2.order[0] && m2.order[0] !== i2.order[0],
  [a2.order[0], m2.order[0], i2.order[0]].join(' · '));
check('an admin saving theirs does not move a manager’s',
  m2.order.join(',') === 'carrier_name,policy_number');
check('nor an investor’s', i2.order.join(',') === 'my_pct,policy_number');
check('and there is no route that writes somebody else’s',
  (await api(admin, '/me/prefs/policy_columns?user_id=1', { method: 'PUT',
    body: { order: ['status'] } })).status === 200
  && (await json(await api(manager, '/me/prefs'))).policy_columns.order[0] === 'carrier_name');

console.log('\nSIGNED OUT, NOTHING IS READABLE');
check('an anonymous request is refused',
  (await fetch(`${BASE}/api/me/prefs`)).status === 401);

console.log('\nBACK TO DEFAULT');
await clear(admin);
check('clearing removes the row rather than storing an empty one',
  (await json(await api(admin, '/me/prefs'))).policy_columns === undefined);
check('and the grid falls back to the catalogue',
  arrangeFields(null, { investor: false }).filter((f) => f.visible).length
    === POLICY_FIELDS.filter((f) => f.default && !f.investorOnly).length);

console.log('\nWHAT THE SCREEN PACKS UP');
const round = arrangeFields(null, { investor: false });
const packed = packArrangement(round);
check('packing keeps the order and only the order and what is off',
  Object.keys(packed).sort().join(',') === 'hidden,order');
check('and unpacking it gives the same grid back',
  arrangeFields(packed, { investor: false }).filter((f) => f.visible).map((f) => f.key).join(',')
    === round.filter((f) => f.visible).map((f) => f.key).join(','));

for (const c of [admin, manager, inv]) await clear(c);
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL COLUMN PREFERENCE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
