/* =====================================================================
   The sample portfolio, imported the way a person would.

   One file, one upload. This runs it through the real endpoint and then
   checks the book that comes out the other side — because a fixture that
   loads without error but produces a portfolio nobody would recognise is
   worse than no fixture at all.

   Idempotent, and it proves it: the file is imported twice and the second
   pass must not double the capital invested.
   ===================================================================== */
import fs from 'node:fs';
import { BASE, ADMIN, login } from './test-config.mjs';

const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) < tol;

const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: admin, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const FILE = '/home/claude/policyhub/sample/sample-portfolio.csv';
const NUMBERS = ['LF-3392014', 'JH-7741208', 'PL-5580933', 'PR-2214887', 'MM-9903412',
                 'AX-1180567', 'BH-4407731', 'GW-6628190', 'NW-8815602', 'TR-3320944'];

const wipe = async () => {
  for (const status of ['', 'Matured', 'Inforce', 'Grace']) {
    for (const p of ((await json(await api(`/policies?status=${status}`))) || [])
      .filter((x) => NUMBERS.includes(x.policy_number))) {
      const d = await json(await api(`/policies/${p.id}`));
      for (const id of [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)].filter(Boolean))
        await api(`/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
    }
  }
};
await wipe();

const upload = async (extra = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(FILE)], { type: 'text/csv' }), 'sample-portfolio.csv');
  fd.append('type', 'master');
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  return json(await fetch(`${BASE}/api/import/run`, {
    method: 'POST', headers: { Cookie: admin }, body: fd }));
};

console.log('ONE FILE, ONE UPLOAD');
const res = await upload();
check('the import runs without errors', (res.errors || []).length === 0,
  (res.errors || []).slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join(' | '));
check('every row was classified', res.byType?.unclassified === 0, String(res.byType?.unclassified));
check('ten policies created', res.byType?.policy === 10, String(res.byType?.policy));
check('with a second life on the survivorship contract', res.byType?.life === 1);
check('value snapshots came in', res.byType?.value > 80, String(res.byType?.value));
check('so did the ledger', res.byType?.transaction > 70, String(res.byType?.transaction));
check('and the premiums still to come', res.byType?.premium === 40, String(res.byType?.premium));

console.log('\nTHE BOOK THAT COMES OUT');
const live = ((await json(await api('/policies?status='))) || [])
  .filter((p) => NUMBERS.includes(p.policy_number));

/* A matured policy leaves the active list by design and lives in Maturities,
   so the book is the two lists together. */
const onFile = async () => {
  const active = ((await json(await api('/policies?status='))) || [])
    .filter((p) => NUMBERS.includes(p.policy_number)).map((p) => p.policy_number);
  const done = ((await json(await api('/maturities'))).rows || [])
    .filter((r) => NUMBERS.includes(r.policy_number)).map((r) => r.policy_number);
  return new Set([...active, ...done]);
};
check('all ten are on file', (await onFile()).size === 10, String((await onFile()).size));
check('the eight still running are the active list', live.length === 8, String(live.length));
check('none is assigned to an entity yet — that is yours to choose',
  live.every((p) => !p.fund_code), live.map((p) => p.fund_code).filter(Boolean).join(','));
check('every one has a carrier, a face amount and an insured',
  live.every((p) => p.carrier_name && Number(p.face_amount) > 0 && p.insured_last),
  live.filter((p) => !p.carrier_name || !p.face_amount || !p.insured_last)
    .map((p) => p.policy_number).join(','));
check('product types cover the range',
  new Set(live.map((p) => p.product_type)).size >= 5,
  [...new Set(live.map((p) => p.product_type))].join(','));

const one = await json(await api(`/policies/${live.find((p) => p.policy_number === 'LF-3392014').id}`));
check('a policy carries its own ledger', (one.transactions || []).length >= 7,
  `${(one.transactions || []).length} entries`);
check('starting with the purchase',
  (one.transactions || []).some((t) => t.txn_type === 'Acquisition Cost' && near(t.amount, 940000)));
check('its carrier statements', (one.values || []).length >= 8, `${(one.values || []).length}`);
check('with account and cash value on them',
  (one.values || []).every((v) => v.account_value !== null && v.cash_surrender_value !== null));
check('and the premiums still to come',
  (one.reminders || []).filter((r) => r.kind === 'Premium').length === 5,
  `${(one.reminders || []).length}`);
check('every future premium is dated ahead of today',
  (one.reminders || []).every((r) => String(r.due_date).slice(0, 10) >= new Date().toISOString().slice(0, 10)));

console.log('\nIT EXERCISES THE WHOLE APPLICATION');
const surv = live.find((p) => p.policy_number === 'JH-7741208');
const survDetail = await json(await api(`/policies/${surv.id}`));
check('the survivorship policy has two lives',
  (survDetail.additionalInsureds || []).length === 1,
  survDetail.additionalInsureds?.map((i) => i.last_name).join(','));

const term = live.find((p) => p.policy_number === 'BH-4407731');
check('the term policy honestly has no cash value',
  !Number(term.cash_surrender_value), String(term.cash_surrender_value));

const svc = await json(await api('/servicing'));
const overdue = (svc.alerts || []).filter((a) => a.severity === 'critical'
  && NUMBERS.includes(a.policy_number));
check('a premium is already overdue, so the calendar has something to say',
  overdue.length >= 1, overdue.map((a) => a.reason).slice(0, 2).join(' | '));
const runway = (svc.alerts || []).filter((a) => /cost of insurance/.test(a.reason || '')
  && NUMBERS.includes(a.policy_number));
check('and at least one policy is thin on account value', runway.length >= 1,
  `${runway.length} flagged`);

const mat = await json(await api('/maturities'));
const ours = (mat.rows || []).filter((r) => NUMBERS.includes(r.policy_number));
check('two positions have matured', ours.length === 2,
  ours.map((r) => r.policy_number).join(','));
check('one cheque has arrived', ours.filter((r) => r.proceeds_amount != null).length === 1);
check('the other is still outstanding', ours.filter((r) => r.proceeds_amount == null).length === 1);

const irr = await json(await api(`/policies/${one.id}/irr`));
check('a return can be solved on the imported history',
  irr.result?.rate !== null && irr.result.days > 365,
  `${(irr.result?.rate * 100).toFixed(2)}% over ${irr.result?.days} days`);

console.log('\nRE-UPLOADING IT CHANGES NOTHING');
const before = (await json(await api(`/policies/${one.id}`))).total_invested;
const again = await upload();
check('the second pass reports no errors', (again.errors || []).length === 0,
  (again.errors || []).slice(0, 2).map((e) => e.message).join(' | '));
check('duplicate ledger rows are skipped, not added', again.skipped > 0, String(again.skipped));
const after = (await json(await api(`/policies/${one.id}`))).total_invested;
check('so capital invested is unchanged', near(before, after),
  `${before} then ${after}`);
check('and there are still ten policies', (await onFile()).size === 10);
const stillFive = (await json(await api(`/policies/${one.id}`))).reminders || [];
check('future premiums were updated in place, not stacked',
  stillFive.filter((r) => r.kind === 'Premium').length === 5, `${stillFive.length}`);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL SAMPLE IMPORT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
