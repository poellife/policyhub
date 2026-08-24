/* =====================================================================
   Correcting a ledger entry.

   The ledger is not a list of notes. Every return figure in the
   application is worked out from it — the rate on the policy, the entity
   subtotal it sits in, the book on the dashboard, the number on an
   investor's statement. Until now a wrong entry could only be deleted and
   retyped, which does all of that damage anyway and leaves a thinner
   trail: two rows in the log, no statement of what the figure had been.

   So this suite is about two things and they pull in opposite directions.
   The correction has to be easy — one field, in place, from the screen
   where you noticed it. And it has to be impossible to make quietly: the
   log has to name the field, what it was, and what it became, because an
   amount moved by one decimal place is exactly the change somebody will
   need to find six months later.

   Everything else about a transaction stays where it was. An investor
   cannot reach one at all; a manager cannot reach one in an entity that
   is not theirs; and the two fields the rate engine cannot work without
   may not be emptied.

   Idempotent: its own policy, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, MANAGER2, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'TXNEDIT';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const as = (c) => (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const api = as(cookie);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const st of ['', 'Inforce', 'Matured', 'Lapsed', 'Sold', 'Pending'])
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX))
        await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const pol = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: `${PREFIX} Assurance`, product_type: 'UL',
  fund_code: 'LCG1', face_amount: 4000000, status: 'Inforce',
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Pat', dob: '1940-02-02' } }));

/* A decimal place out. This is the mistake the whole feature is for: the
   figure is plausible, nothing else about the row is wrong, and it moves
   every rate the policy touches. */
const txn = await json(await api(`/policies/${pol.id}/transactions`, { method: 'POST', body: {
  txn_date: '2021-05-14', txn_type: 'Acquisition Cost', amount: 60000,
  remarks: 'typed from the closing statement' } }));

const ledger = async (c = api) =>
  ((await json(await c(`/policies/${pol.id}`)))?.transactions || []);
const rateNow = async () =>
  (await json(await api(`/policies/${pol.id}/irr`)))?.result?.rate ?? null;

console.log('A FIGURE CORRECTED IN PLACE');
const wrongRate = await rateNow();
const r = await api(`/transactions/${txn.id}`, { method: 'PUT', body: {
  txn_date: '2021-05-14', txn_type: 'Acquisition Cost', amount: 600000,
  remarks: 'corrected against the closing statement' } });
check('an administrator may correct one', r.status === 200, String(r.status));
const after = (await ledger()).find((t) => t.id === txn.id);
check('the amount is what it was changed to', Number(after?.amount) === 600000,
  String(after?.amount));
check('and the remark with it', /corrected/.test(after?.remarks || ''), after?.remarks);
check('there is still one entry, not two', (await ledger()).length === 1);
check('and the policy has one basis, not the sum of both',
  Number((await json(await api(`/policies/${pol.id}`)))?.total_invested) === 600000,
  String((await json(await api(`/policies/${pol.id}`)))?.total_invested));
const rightRate = await rateNow();
check('the return moves, which is the reason this is worth recording',
  wrongRate !== null && rightRate !== null && Math.abs(wrongRate - rightRate) > 0.1,
  `${(wrongRate * 100).toFixed(1)}% → ${(rightRate * 100).toFixed(1)}%`);

console.log('\nAND THE LOG SAYS WHAT IT WAS');
const log = await json(await api('/audit?limit=40'));
const mine = (log.rows || log || []).filter((e) => e.entity === 'transaction');
const entry = mine.find((e) => /amount/.test(e.detail || ''));
check('the change is in the activity log', !!entry, (mine[0]?.detail || 'nothing').slice(0, 90));
check('naming the field that moved', /amount/.test(entry?.detail || ''),
  (entry?.detail || '').slice(0, 100));
check('what it was', /60000/.test(entry?.detail || ''), (entry?.detail || '').slice(0, 100));
check('and what it became', /600000/.test(entry?.detail || ''), (entry?.detail || '').slice(0, 100));
check('the fields nobody touched are not in it',
  !/txn_type/.test(entry?.detail || ''), (entry?.detail || '').slice(0, 110));

console.log('\nWHAT A CORRECTION MAY NOT DO');
const bad = async (body) => (await api(`/transactions/${txn.id}`, { method: 'PUT', body })).status;
check('a date cannot be emptied', await bad({ txn_date: '' }) === 400);
check('nor a type', await bad({ txn_type: '' }) === 400);
check('an empty request is refused rather than logged as a change',
  await bad({}) === 400);
check('and a transaction that does not exist is not found',
  (await api('/transactions/99999999', { method: 'PUT', body: { amount: 1 } })).status === 404);
check('the entry survived all of that unchanged',
  Number((await ledger()).find((t) => t.id === txn.id)?.amount) === 600000);

console.log('\nWHO MAY');
const mgr1 = await login(MANAGER1.email, MANAGER1.password);
const invr = await login(INVESTOR1.email, INVESTOR1.password);
const put = (c, id, body) => as(c)(`/transactions/${id}`, { method: 'PUT', body });

const mgr1Codes = [...new Set(((await json(await as(mgr1)('/policies'))) || [])
  .map((x) => x.fund_code).filter(Boolean))];
check('a manager whose entity this is may correct it',
  mgr1Codes.includes('LCG1')
  && (await put(mgr1, txn.id, { remarks: 'checked by the manager' })).status === 200,
  mgr1Codes.join(','));

/* The same correction on a policy in an entity they do not hold. Not
   "refused" — not found, which is the answer to a question they were
   never entitled to ask. */
const codes = ((await json(await api('/funds'))) || []).map((f) => f.code);
const outside = codes.find((c) => !mgr1Codes.includes(c));
if (outside) {
  const other = await json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-2`, carrier_name: `${PREFIX} Assurance`, product_type: 'UL',
    fund_code: outside, face_amount: 1000000, status: 'Inforce',
    insured_last_name: `${PREFIX}Two`, insured_first_name: 'Sam', dob: '1942-03-03' } }));
  const otherTxn = await json(await api(`/policies/${other.id}/transactions`, {
    method: 'POST', body: {
      txn_date: '2022-01-10', txn_type: 'Acquisition Cost', amount: 250000 } }));
  check(`a manager without ${outside} cannot even see one in it`,
    (await put(mgr1, otherTxn.id, { amount: 1 })).status === 404, outside);
  check('and it is untouched',
    Number(((await json(await api(`/policies/${other.id}`)))?.transactions || [])[0]?.amount)
      === 250000);
} else {
  check('every entity is this manager\u2019s, so scope is untested here', true, 'skipped');
}

check('an investor cannot reach a ledger at all',
  [403, 404].includes((await put(invr, txn.id, { amount: 1 })).status),
  String((await put(invr, txn.id, { amount: 1 })).status));
check('none of them changed the amount',
  Number((await ledger()).find((t) => t.id === txn.id)?.amount) === 600000);

/* ------------------------------ on screen ---------------------------- */
console.log('\nFROM THE SCREEN WHERE YOU NOTICED IT');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1050 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
p.on('dialog', (d) => d.accept());

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/policy/${pol.id}`);
await p.waitForSelector('.policy-tabs, .tabs, h1', { timeout: 20000 });
await p.waitForTimeout(800);
const txnTab = p.locator('a, button').filter({ hasText: /^Transactions$/ }).first();
if (await txnTab.count()) await txnTab.click();
await p.waitForSelector('[data-del-txn]', { timeout: 20000 });
await p.waitForTimeout(500);

check('the ledger row offers Edit beside Delete',
  (await p.locator('[data-edit-txn]').count()) === 1);
await p.click('[data-edit-txn]');
await p.waitForSelector('dialog[open]', { timeout: 10000 });
await p.waitForTimeout(400);
const dlg = p.locator('dialog[open]');
check('the dialog says it is an edit',
  /Edit transaction/i.test(await dlg.locator('.dialog-head').textContent()),
  (await dlg.locator('.dialog-head').textContent()).trim());
check('and it opens on the figures that are there, not blank ones',
  (await dlg.locator('input[name=txn_date]').inputValue()) === '2021-05-14',
  await dlg.locator('input[name=txn_date]').inputValue());
check('with the amount already in it',
  (await dlg.locator('input[name=amount]').inputValue()).replace(/[^0-9.]/g, '') === '600000',
  await dlg.locator('input[name=amount]').inputValue());
check('the type it already is',
  (await dlg.locator('select[name=txn_type]').inputValue()) === 'Acquisition Cost');
check('and it says what a change here will reach',
  (await dlg.locator('.dlg-note').count()) === 1
  && /rate/i.test(await dlg.locator('.dlg-note').textContent()),
  (await dlg.locator('.dlg-note').textContent()).replace(/\s+/g, ' ').slice(0, 90));
await p.screenshot({ path: `${S}/te1-edit-dialog.png` });

await dlg.locator('input[name=amount]').fill('612500');
await dlg.locator('input[name=remarks]').fill('final closing statement');
await dlg.locator('button[type=submit]').first().click();
await p.waitForTimeout(1800);
check('saving puts the new figure on the ledger',
  Number((await ledger()).find((t) => t.id === txn.id)?.amount) === 612500,
  String((await ledger()).find((t) => t.id === txn.id)?.amount));
const shown = await p.locator('table.data tbody tr').first().textContent();
check('and the row on screen shows it without a reload',
  /612,500/.test(shown), shown.replace(/\s+/g, ' ').slice(0, 100));
check('still one row', (await p.locator('[data-edit-txn]').count()) === 1);

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await wipe();
console.log(fails.length
  ? `\n${fails.length} TRANSACTION EDIT CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL TRANSACTION EDIT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
