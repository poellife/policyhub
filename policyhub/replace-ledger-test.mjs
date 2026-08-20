/* =====================================================================
   Re-baselining a policy's ledger from a better record.

   A ledger is normally append-only: the file adds to what is there, and a
   row identical to one on file is refused so that re-importing cannot
   double the capital invested. That is the right default and it stays the
   default.

   But sometimes the file IS the record. A premium calculation workbook the
   office actually runs on, against a CRM export that turned out to be
   patchy, disagree — and adding one to the other produces a total that
   matches neither. `replaceLedger` clears each policy the file touches
   before writing its rows.

   What has to hold:
     - it is per policy. A file naming one policy does not touch another.
     - it is admin and editor only. A manager may import into their own
       entities; rewriting a book of record from a spreadsheet is a
       different act.
     - what was removed is on the activity log, with the count and total.
     - and the ledger afterwards says exactly what the file said.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'RELEDGER';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;
const M = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const us = (d) => { const [y, m, dd] = iso(d).split('-'); return `${m}/${dd}/${y}`; };

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(admin, `/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
};
await wipe();

const make = async (tag) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Rebase Life', product_type: 'UL',
    fund_code: 'LCG1', face_amount: 2000000, premium_required: 30000, premium_mode: 'Annual',
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', dob: '1936-01-01' } }));
  // A patchy history: three rows, one of which the better record disagrees with.
  for (const [d, amt, kind] of [
    [-900, 500000, 'Acquisition Cost'], [-600, 30000, 'Premium Payment'],
    [-300, 12345, 'Premium Payment']])
    await api(admin, `/policies/${p.id}/transactions`,
      { method: 'POST', body: { txn_date: iso(d), txn_type: kind, amount: amt } });
  return p;
};

const A = await make('A');
const B = await make('B');
const before = async (id) => Number((await json(await api(admin, `/policies/${id}`))).total_invested);

check('the patchy history is on both policies',
  near(await before(A.id), 542345) && near(await before(B.id), 542345),
  `${M(await before(A.id))} · ${M(await before(B.id))}`);

/** The better record, for policy A only. Two rows, one of them different. */
const file = [
  'Record Type,Policy Number,Carrier Name,Transaction Date,Transaction Type,Amount',
  `Transaction,${PREFIX}-A,Rebase Life,${us(-900)},Acquisition Cost,500000.00`,
  `Transaction,${PREFIX}-A,Rebase Life,${us(-600)},Premium Payment,30000.00`,
  `Transaction,${PREFIX}-A,Rebase Life,${us(-200)},Premium Payment,7500.00`,
].join('\n');

const upload = async (cookie, body, replace) => {
  const fd = new FormData();
  fd.append('files', new Blob([body], { type: 'text/csv' }), 'rebase.csv');
  fd.append('type', 'master');
  if (replace) fd.append('replaceLedger', 'true');
  const r = await fetch(`${BASE}/api/import/run`,
    { method: 'POST', headers: { Cookie: cookie }, body: fd });
  return { status: r.status, body: await r.json() };
};

console.log('WITHOUT IT, THE FILE ADDS TO WHAT IS THERE');
const added = await upload(admin, file, false);
check('the two rows already on file are refused', added.body.skipped === 2,
  String(added.body.skipped));
check('and only the new one lands', added.body.created === 1, String(added.body.created));
check('so the total is the union of both records',
  near(await before(A.id), 549845), M(await before(A.id)));

console.log('\nWITH IT, THE FILE IS THE RECORD');
const replaced = await upload(admin, file, true);
check('everything that was there is cleared first', replaced.body.removed === 4,
  String(replaced.body.removed));
check('and every row of the file is written', replaced.body.created === 3,
  String(replaced.body.created));
check('nothing is skipped as a duplicate, because nothing is left to duplicate',
  replaced.body.skipped === 0, String(replaced.body.skipped));
check('the ledger now says exactly what the file said',
  near(await before(A.id), 537500), `${M(await before(A.id))} vs ${M(537500)}`);
const det = await json(await api(admin, `/policies/${A.id}`));
check('row for row', (det.transactions || []).length === 3,
  String((det.transactions || []).length));
check('including the figure the two records disagreed on',
  (det.transactions || []).some((t) => near(t.amount, 7500))
  && !(det.transactions || []).some((t) => near(t.amount, 12345)));

console.log('\nIT TOUCHES ONLY THE POLICIES IN THE FILE');
check('the one the file never mentioned is exactly as it was',
  near(await before(B.id), 542345), M(await before(B.id)));
check('with its rows intact',
  ((await json(await api(admin, `/policies/${B.id}`))).transactions || []).length === 3);

console.log('\nWHAT WAS REMOVED IS ON THE RECORD');
const log = await json(await api(admin, '/audit'));
const entry = (log || []).find((r) => /ledger replaced on import/.test(r.detail || ''));
check('the clearance is written to the activity log', !!entry, entry?.detail);
check('with the number of rows and their total',
  /4 rows totalling 549845/.test(entry?.detail || ''), entry?.detail);

console.log('\nA MANAGER CANNOT DO IT');
/* They may import into their own entities — that is not in question — but
   rewriting a book of record from a spreadsheet is a different act. */
const mgr = await upload(pm1, file, true);
check('their import still runs', mgr.status === 200, String(mgr.status));
check('but nothing is cleared', !mgr.body.removed, String(mgr.body.removed));
check('and the ledger is untouched by it',
  near(await before(A.id), 537500), M(await before(A.id)));

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL LEDGER REPLACEMENT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
