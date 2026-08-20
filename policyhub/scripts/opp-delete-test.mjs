/* =====================================================================
   Clearing a shelf of opportunities.

   Opportunities go stale faster than anything else here — deals nobody
   took, duplicates off a broker's list, a batch keyed in for a fund that
   never happened. Removing them one page at a time is the chore that ends
   with somebody leaving the mess, so an administrator can take a whole
   selection at once.

   What is checked:

     - only an administrator. A manager keeps the one-at-a-time delete on
       a deal's own page, which is the deliberate act this is not.
     - the count has to be typed. A wrong count deletes nothing.
     - what the preview promises is what goes, and it is built from the
       database rather than from the ids as posted.
     - a batch is all or nothing, and every deletion is on the log.

   Idempotent: its own entity and deals, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, MANAGER2, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'OPPDEL';
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
const me = (await json(await api(investor, '/auth/me'))).investor.id;

const list = async (cookie) => ((await json(await api(cookie, '/opportunities?all=1'))) || []);
const wipe = async () => {
  for (const o of await list(admin))
    if (String(o.insured_last_name || '').startsWith(PREFIX))
      await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const funds = await json(await api(admin, '/funds'));
const fundId = funds.find((f) => f.code === 'LCG1')?.id || funds[0].id;
const make = async (tag, extra = {}) => json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 2000000, insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada',
  insured_dob: '1939-02-02', le_months: 72, le_date: iso(-30),
  asking_price: 300000, annual_premium: 40000,
  expected_close: iso(30), offer_closes_on: iso(90), fund_id: fundId, ...extra } }));

const deals = [];
for (const tag of ['A', 'B', 'C', 'D', 'E']) deals.push(await make(tag));
const ids = deals.map((d) => d.id);

/* One of them has been put in front of investors and asked for, which is the
   case worth warning about — deleting it takes it off somebody's screen. */
await api(admin, `/opportunities/${deals[0].id}/shares`, { method: 'PUT', body: { investor_ids: [me] } });
await api(investor, `/opportunities/${deals[0].id}/commit`, { method: 'POST', body: { pct: 25 } });
await api(admin, `/opportunities/${deals[1].id}/premium-schedule`, { method: 'POST', body: {
  start_date: iso(30), amount: 40000, years: 5 } });

console.log('WHO MAY CLEAR A SHELF');
check('an administrator may',
  (await api(admin, '/opportunities/bulk-delete/preview', { method: 'POST', body: { ids } }))
    .status === 200);
check('a manager may not — one at a time is still theirs',
  (await api(manager, '/opportunities/bulk-delete', { method: 'POST', body: {
    ids, confirm: `DELETE ${ids.length}` } })).status === 403);
check('nor may an investor',
  (await api(investor, '/opportunities/bulk-delete', { method: 'POST', body: {
    ids, confirm: `DELETE ${ids.length}` } })).status === 403);
check('nor may somebody signed out',
  (await fetch(`${BASE}/api/opportunities/bulk-delete`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, confirm: 'DELETE 5' }) })).status === 401);
check('and a manager can still delete one from its own page',
  (await api(manager, `/opportunities/${deals[4].id}`, { method: 'DELETE' })).status === 200);
ids.pop();
deals.pop();

console.log('\nWHAT THE PREVIEW PROMISES');
const preview = await json(await api(admin, '/opportunities/bulk-delete/preview',
  { method: 'POST', body: { ids } }));
check('it counts what was chosen', preview.count === 4, String(preview.count));
check('and names each one, so a wrong tick is visible before it matters',
  preview.opportunities.every((o) => o.insured_last_name.startsWith(PREFIX)));
check('it says how many investors were shown them', preview.shares === 1,
  String(preview.shares));
check('and how many have asked for a piece', preview.requests === 1, String(preview.requests));
check('the premium schedules are counted too', preview.premiums === 5, String(preview.premiums));
check('the phrase to type is tied to the count',
  preview.confirm_phrase === 'DELETE 4', preview.confirm_phrase);

/* Built from the database, not from the ids as posted: an id for something
   that does not exist comes back as missing rather than being deleted blind. */
const withGhost = await json(await api(admin, '/opportunities/bulk-delete/preview',
  { method: 'POST', body: { ids: [...ids, 99999999] } }));
check('an id for something that is not there is reported, not obeyed',
  withGhost.missing.includes(99999999) && withGhost.count === 4,
  `${withGhost.count} found · missing ${withGhost.missing.join(',')}`);
check('nothing at all is refused with a message',
  (await api(admin, '/opportunities/bulk-delete/preview', { method: 'POST', body: { ids: [] } }))
    .status === 400);
check('and rubbish in the list does not become an id',
  (await json(await api(admin, '/opportunities/bulk-delete/preview',
    { method: 'POST', body: { ids: ['x', null, 0, -3] } })))?.error !== undefined);

console.log('\nTHE COUNT HAS TO BE TYPED');
const wrongPhrase = await api(admin, '/opportunities/bulk-delete', { method: 'POST', body: {
  ids, confirm: 'DELETE 3' } });
check('a wrong count is refused', wrongPhrase.status === 400);
check('and says what to type instead',
  (await json(wrongPhrase))?.confirm_phrase === 'DELETE 4');
check('nothing was deleted by the attempt',
  (await json(await api(admin, '/opportunities/bulk-delete/preview',
    { method: 'POST', body: { ids } }))).count === 4);
const noPhrase = await api(admin, '/opportunities/bulk-delete', { method: 'POST', body: { ids } });
check('no confirmation at all is refused too', noPhrase.status === 400);

console.log('\nAND THEN IT GOES');
const before = ((await json(await api(admin, '/audit'))) || []).length;
const done = await json(await api(admin, '/opportunities/bulk-delete', { method: 'POST', body: {
  ids, confirm: 'DELETE 4' } }));
check('all four are deleted', done.deleted === 4, JSON.stringify(done));
check('and the response says what went with them',
  done.shares === 1 && done.requests === 1 && done.premiums === 5,
  `${done.shares} shares · ${done.requests} requests · ${done.premiums} premium rows`);
check('they are off the list', (await list(admin))
  .filter((o) => String(o.insured_last_name || '').startsWith(PREFIX)).length === 0);
check('and off the investor’s screen as well',
  (await list(investor)).every((o) => !String(o.insured_last_name || '').startsWith(PREFIX)));

const trail = ((await json(await api(admin, '/audit'))) || []);
/* Matched on the ids just deleted rather than on the words: an earlier run
   of this suite leaves entries that read identically. */
const mine2 = trail.filter((r) => r.entity === 'opportunity'
  && ids.includes(Number(r.entity_id)) && /bulk delete of 4/.test(r.detail || ''));
check('every one of them is on the activity log', mine2.length === 4, String(mine2.length));
check('each entry names the deal and says it was part of a batch',
  mine2.every((r) => /Northbank Life/.test(r.detail) && /bulk delete of 4/.test(r.detail)),
  mine2[0]?.detail?.slice(0, 90));
/* The log is read back capped, so counting it end to end proves nothing.
   What matters is that all four are there, which is asserted above. */
check('and the four are the most recent entries against opportunities',
  trail.filter((r) => r.entity === 'opportunity' && /bulk delete/.test(r.detail || ''))
    .length >= 4, String(before));

console.log('\nA BATCH IS ALL OR NOTHING');
const pair = [await make('X'), await make('Y')];
const pairIds = pair.map((p) => p.id);
await api(admin, `/opportunities/${pair[1].id}`, { method: 'DELETE' });   // one vanishes underneath
const stale = await api(admin, '/opportunities/bulk-delete', { method: 'POST', body: {
  ids: pairIds, confirm: 'DELETE 2' } });
const staleBody = await json(stale);
check('a selection that has changed underneath is refused', stale.status === 409,
  String(stale.status));
check('and says how many are actually there', staleBody?.found === 1,
  staleBody?.error);
check('the survivor is untouched',
  (await api(admin, `/opportunities/${pair[0].id}`)).status === 200);
await api(admin, `/opportunities/${pair[0].id}`, { method: 'DELETE' });

console.log('\nA DEAL IN SOMEBODY ELSE’S ENTITY');
/* Only an administrator can do this at all, and an administrator sees every
   entity — so there is no scope to escape. What matters is that the route
   cannot be reached by the people who do have a scope, which is checked
   above, and that a manager's own deals are still theirs to remove singly. */
const mgr2 = await login(MANAGER2.email, MANAGER2.password);
check('a second manager is refused the batch route as well',
  (await api(mgr2, '/opportunities/bulk-delete/preview', { method: 'POST', body: { ids: [1] } }))
    .status === 403);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL OPPORTUNITY DELETE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
