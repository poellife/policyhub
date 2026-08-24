/* =====================================================================
   Deleting a batch of policies.

   This exists because of imports. A file loaded with the wrong owner
   column, or twice, leaves rows that have to come out — and doing that
   one at a time, typing each policy number into a confirmation box, is
   how somebody gives up half way.

   It is also the most destructive thing in the application, so what is
   checked here is mostly what it refuses: anybody who is not an
   administrator, a confirmation typed for a different selection, and a
   list containing something that has already gone. And that when it does
   refuse, nothing at all was removed — a bulk delete that half worked is
   worse than one that did not run.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'BULKDEL';
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
const investor = await login(INVESTOR1.email, INVESTOR1.password);
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');

const wipe = async () => {
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  for (const i of ((await json(await api(admin, '/investors'))) || [])
    .filter((x) => String(x.name).startsWith(PREFIX)))
    await api(admin, `/investors/${i.id}`, { method: 'DELETE' });
};
await wipe();

const make = async (n) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${n}`, carrier_name: 'Batch Life', product_type: 'UL',
    fund_code: 'LCG1', face_amount: 1000000 + n, premium_required: 20000,
    premium_mode: 'Annual', acquisition_date: iso(-400), acquisition_cost: 150000,
    insured_last_name: `${PREFIX}surname${n}`, insured_first_name: 'Ada',
    dob: '1938-04-04' } }));
  await api(admin, `/policies/${p.id}/values`, { method: 'POST', body: {
    as_of_date: iso(-30), account_value: 40000, cash_surrender_value: 38000 } });
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-200), txn_type: 'Premium Payment', amount: 20000 } });
  return p;
};

const made = [];
for (let n = 1; n <= 4; n++) made.push(await make(n));
const ids = made.map((p) => p.id);
const alive = async (id) => (await api(admin, `/policies/${id}`)).status === 200;
const aliveCount = async () => (await Promise.all(ids.map(alive))).filter(Boolean).length;

const preview = (who, body) => api(who, '/policies/bulk-delete/preview', { method: 'POST', body });
const remove = (who, body) => api(who, '/policies/bulk-delete', { method: 'POST', body });

console.log('ONLY AN ADMINISTRATOR');
check('a portfolio manager cannot, even in their own entity',
  (await remove(pm1, { ids, confirm: `DELETE ${ids.length}` })).status === 403);
check('nor can they even look at what it would remove',
  (await preview(pm1, { ids })).status === 403);
check('an investor certainly cannot', (await remove(investor, { ids, confirm: 'DELETE 4' })).status === 403);
check('a signed-out request cannot',
  (await fetch(`${BASE}/api/policies/bulk-delete`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, confirm: 'DELETE 4' }) })).status === 401);
check('and after all that, all four are still there', (await aliveCount()) === 4);

console.log('\nWHAT WOULD GO IS COUNTED FIRST');
const view = await json(await preview(admin, { ids }));
check('every one of them is listed by number', view.count === 4
  && view.policies.every((p) => String(p.policy_number).startsWith(PREFIX)), String(view.count));
check('with the ledger entries that go with them', view.transactions === 4, String(view.transactions));
check('and the value snapshots', view.values === 4, String(view.values));
check('the death benefit is totted up, so the size of it is plain',
  Number(view.face_amount) > 4000000, String(view.face_amount));
check('and it says what to type', view.confirm_phrase === 'DELETE 4', view.confirm_phrase);

console.log('\nINVESTOR ALLOCATIONS AND DOCUMENTS ARE COUNTED TOO');
/* These are the two nobody expects. An allocation disappearing from an
   investor's own portfolio, and a document that does not come back. */
const holder = await json(await api(admin, '/investors', { method: 'POST',
  body: { name: `${PREFIX} Holder LLC`, investor_type: 'Entity' } }));
await api(admin, `/policies/${ids[0]}/investors`, { method: 'POST',
  body: { investor_id: holder.id, pct: 30, acquired_on: iso(-300) } });
const withHolder = await json(await preview(admin, { ids }));
check('an investor allocation is shown before it vanishes',
  withHolder.holders === 1, String(withHolder.holders));

console.log('\nTHE CONFIRMATION IS TIED TO THE COUNT');
const wrongWord = await json(await remove(admin, { ids, confirm: 'delete them' }));
check('a phrase that is not the phrase is refused', /Type DELETE 4/.test(wrongWord?.error || ''),
  wrongWord?.error);
const staleCount = await json(await remove(admin, { ids, confirm: 'DELETE 3' }));
check('a phrase typed for a different number of policies is refused',
  /Type DELETE 4/.test(staleCount?.error || ''), staleCount?.error);
check('no confirmation at all is refused', (await remove(admin, { ids })).status === 400);
check('and nothing was deleted by any of that', (await aliveCount()) === 4);

console.log('\nWHAT IT REFUSES TO BE ASKED');
check('an empty list', (await remove(admin, { ids: [], confirm: 'DELETE 0' })).status === 400);
check('no list at all', (await remove(admin, { confirm: 'DELETE 0' })).status === 400);
check('rubbish instead of ids',
  (await remove(admin, { ids: ['not-a-number', null], confirm: 'DELETE 0' })).status === 400);
const tooMany = await json(await remove(admin,
  { ids: Array.from({ length: 501 }, (_, i) => i + 1), confirm: 'DELETE 501' }));
check('more than five hundred at once', /at most 500/.test(tooMany?.error || ''), tooMany?.error);

console.log('\nA POLICY THAT HAS ALREADY GONE STOPS THE WHOLE THING');
/* All or nothing. Half a batch is worse than none, because you cannot tell
   from the screen which half. */
const ghost = { ids: [...ids, 999999], confirm: 'DELETE 5' };
const stale = await json(await remove(admin, ghost));
check('the batch is refused rather than quietly shortened',
  /no longer exists/.test(stale?.error || ''), stale?.error);
check('and all four survive it', (await aliveCount()) === 4);
const ghostView = await json(await preview(admin, { ids: [...ids, 999999] }));
check('the preview names the missing one rather than hiding it',
  ghostView.missing?.length === 1 && ghostView.count === 4,
  `${ghostView.count} found · ${(ghostView.missing || []).join(',')}`);

console.log('\nAND THEN IT DOES IT');
const done = await json(await remove(admin, { ids, confirm: 'DELETE 4' }));
check('all four go in one go', done.deleted === 4, JSON.stringify(done).slice(0, 90));
check('it says what went with them',
  done.transactions === 4 && done.values === 4,
  `${done.transactions} ledger · ${done.values} snapshots`);
check('and names them, so the toast is not the only record',
  (done.policy_numbers || []).length === 4);
check('none of them can be opened afterwards', (await aliveCount()) === 0);
check('nor do they appear in a search', ((await json(await api(admin,
  `/policies?search=${PREFIX}&status=`))) || []).length === 0);

console.log('\nEVERY ONE IS ON THE ACTIVITY LOG SEPARATELY');
const log = await json(await api(admin, '/audit'));
const entries = (log || []).filter((r) => /BULKDEL-/.test(r.detail || '') && r.action === 'delete');
check('one entry per policy, not one for the batch', entries.length >= 4, String(entries.length));
check('each says it was part of a batch',
  entries.slice(0, 4).every((r) => /bulk delete of 4/.test(r.detail)),
  entries[0]?.detail?.slice(-40));
check('and carries what was lost with it',
  /face .*value snapshots.*transactions/.test(entries[0]?.detail || ''),
  entries[0]?.detail?.slice(0, 90));

console.log('\nTHE ALLOCATION WENT WITH THE POLICY');
const after = await json(await api(admin, `/investors/${holder.id}`));
check('the investor holds nothing now', (after.positions || []).length === 0,
  String((after.positions || []).length));
check('but the investor record itself is untouched', after.id === holder.id);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL BULK DELETE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
