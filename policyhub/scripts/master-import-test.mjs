/* =====================================================================
   The master importer — one file carrying every record type.

   The risk with a single-file import is that a row is quietly taken for
   the wrong kind of record and something lands in the wrong table. So the
   checks here are mostly about classification: that an explicit Record
   Type is obeyed, that inference only fires on unambiguous rows, that
   anything doubtful is refused by name rather than guessed, and that the
   preview says all of this before a single row is written.

   Idempotent: fixtures use a fixed prefix and are removed first.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'MSTR';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const send = async (csv, { type = 'master', run = true, who = cookie, extra = {} } = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'master.csv');
  fd.append('type', type);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return json(await fetch(`${BASE}/api/import/${run ? 'run' : 'preview'}`,
    { method: 'POST', headers: { Cookie: who }, body: fd }));
};

const wipe = async () => {
  for (const status of ['', 'Inforce', 'Matured', 'Lapsed']) {
    for (const p of ((await json(await api(`/policies?status=${status}`))) || [])
      .filter((x) => x.policy_number.startsWith(PREFIX))) {
      const d = await json(await api(`/policies/${p.id}`));
      for (const id of [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)].filter(Boolean))
        await api(`/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
    }
  }
};
await wipe();

const HEAD = 'Record Type,Policy Number,Carrier Name,Last Name,First Name,DOB,Gender,LE Months,'
  + 'Date Of Death,Role,Product Type,Basic Face,Owner,Premium Required,Acquisition Date,'
  + 'Acquisition Cost,As Of Date,AV,CSV,COI,Death Benefit,Transaction Date,Transaction Type,Amount,Remarks';

/* ------------------------------------------------------------------ *
 * A full dump, deliberately out of order
 * ------------------------------------------------------------------ */
console.log('ONE FILE, EVERY RECORD TYPE');
const dump = [
  HEAD,
  // Transactions and values appear ABOVE the policies they belong to.
  `Transaction,${PREFIX}-1,,,,,,,,,,,,,,,,,,,,03/15/2023,Premium Payment,42000,`,
  `Value,${PREFIX}-1,,,,,,,,,,,,,,,06/30/2026,18500.25,17200.00,3100.50,2000000,,,,`,
  `Transaction,${PREFIX}-1,,,,,,,,,,,,,,,,,,,,03/15/2024,Premium Payment,44000,`,
  `Life,${PREFIX}-2,,Masterjoint,Cheryl,11/18/1942,F,102,,Survivorship,,,,,,,,,,,,,,,`,
  `Policy,${PREFIX}-1,Master Carrier,Mastersingle,Ruth,04/22/1937,F,84,,,UL,2000000,LCG1,42000,03/19/2021,600000,,,,,,,,,`,
  `Policy,${PREFIX}-2,Master Carrier,Masterjoint,Dean,06/02/1940,M,96,,,SUL,5000000,LCG1,96000,07/02/2019,1120000,,,,,,,,,`,
  `Insured,,,Mastersingle,Ruth,04/22/1937,,90,,,,,,,,,,,,,,,,,Updated LE report`,
  `Value,${PREFIX}-2,,,,,,,,,,,,,,,06/30/2026,41000.00,39500.00,8200.00,5000000,,,,`,
  `Transaction,${PREFIX}-2,,,,,,,,,,,,,,,,,,,,08/25/2024,Premium Payment,96000,`,
].join('\n');

const pre = await send(dump, { run: false });
check('the preview classifies every row',
  pre.byType.policy === 2 && pre.byType.life === 1 && pre.byType.insured === 1
  && pre.byType.value === 2 && pre.byType.transaction === 3,
  JSON.stringify(pre.byType));
check('and reports nothing unclassified', pre.byType.unclassified === 0);
check('it knows the types were declared, not guessed', pre.declared === true);

const res = await send(dump);
check('the import reports no errors', res.errors.length === 0,
  res.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join(' | '));
check('two policies created', res.byType.policy === 2);
check('value snapshots written', res.values >= 2, `${res.values}`);

const all = await json(await api('/policies?status='));
const p1 = all.find((p) => p.policy_number === `${PREFIX}-1`);
const p2 = all.find((p) => p.policy_number === `${PREFIX}-2`);
check('both policies exist', !!p1 && !!p2);

console.log('\nROWS FOUND THEIR POLICY DESPITE THE ORDER');
const d1 = await json(await api(`/policies/${p1.id}`));
const prem1 = d1.transactions.filter((t) => t.txn_type === 'Premium Payment');
check('transactions listed above their policy still landed', prem1.length === 2,
  `${prem1.length} premium rows`);
check('the acquisition cost was seeded from the policy row',
  d1.transactions.some((t) => t.txn_type === 'Acquisition Cost' && Number(t.amount) === 600000));
check('the value snapshot landed', d1.values.some((v) => v.as_of_date === '2026-06-30'
  && Number(v.account_value) === 18500.25));

const d2 = await json(await api(`/policies/${p2.id}`));
check('the additional life attached', (d2.additionalInsureds || []).length === 1,
  `${(d2.additionalInsureds || []).length} extra lives`);
check('with the role given', d2.additionalInsureds[0]?.role === 'Survivorship');
check('and it is a survivorship policy', d2.product_type === 'SUL');

const ins = await json(await api(`/insureds/${p1.insured_id}`));
check('the Insured row updated the person', Number(ins.le_months) === 90,
  `le_months ${ins.le_months}`);

console.log('\nRE-RUNNING THE SAME FILE IS SAFE');
const before = (await json(await api(`/policies/${p1.id}`))).transactions.length;
const again = await send(dump);
const after = (await json(await api(`/policies/${p1.id}`))).transactions.length;
check('duplicate ledger rows are skipped, not appended', after === before,
  `${before} → ${after} transactions`);
check('and the skips are counted', again.skipped >= 3, `${again.skipped} skipped`);
check('policies are updated rather than duplicated',
  (await json(await api('/policies?status='))).filter((p) => p.policy_number === `${PREFIX}-1`).length === 1);
check('capital invested is unchanged',
  Number((await json(await api(`/policies/${p1.id}`))).total_invested) === 686000,
  String((await json(await api(`/policies/${p1.id}`))).total_invested));

console.log('\nDUPLICATES CAN BE ALLOWED DELIBERATELY');
const dupeRow = [HEAD,
  `Transaction,${PREFIX}-1,,,,,,,,,,,,,,,,,,,,03/15/2023,Premium Payment,42000,second payment same day`,
].join('\n');
const forced = await send(dupeRow, { extra: { allowDuplicates: 'true' } });
check('with the box ticked the row is written', forced.created === 1, `created ${forced.created}`);
check('and without it, it is not',
  (await send(dupeRow)).skipped === 1);
// Put it back the way it was.
const extraTxn = (await json(await api(`/policies/${p1.id}`))).transactions
  .find((t) => t.remarks === 'second payment same day');
if (extraTxn) await api(`/transactions/${extraTxn.id}`, { method: 'DELETE' });

console.log('\nWITHOUT A RECORD TYPE COLUMN, ROWS ARE INFERRED');
const noType = [
  'Policy Number,Carrier Name,Last Name,First Name,DOB,Basic Face,Owner,Acquisition Cost',
  `${PREFIX}-3,Master Carrier,Masterinfer,Paul,01/09/1941,750000,LCG1,180000`,
].join('\n') + '\n'
  + [''].join('');
const inferPolicy = await send(noType, { run: false });
check('a row with carrier and face reads as a policy',
  inferPolicy.byType.policy === 1 && inferPolicy.byType.unclassified === 0,
  JSON.stringify(inferPolicy.byType));
check('and the preview says the types were inferred', inferPolicy.declared === false);
check('it imports', (await send(noType)).errors.length === 0);

const inferTxn = ['Policy Number,Transaction Date,Transaction Type,Amount',
  `${PREFIX}-3,05/01/2024,Premium Payment,9000`].join('\n');
const it = await send(inferTxn, { run: false });
check('a dated amount with a type reads as a transaction',
  it.byType.transaction === 1, JSON.stringify(it.byType));

const inferValue = ['Policy Number,As Of Date,AV,CSV,COI',
  `${PREFIX}-3,05/31/2024,1200.00,1100.00,300.00`].join('\n');
const iv = await send(inferValue, { run: false });
check('an as-of date with values reads as a snapshot',
  iv.byType.value === 1, JSON.stringify(iv.byType));

console.log('\nWHAT IT REFUSES TO GUESS');
const vague = ['Policy Number,Notes', `${PREFIX}-3,just a note`].join('\n');
const vg = await send(vague, { run: false });
check('an ambiguous row is not classified', vg.byType.unclassified === 1);
check('and the preview names it with its line number',
  vg.problems[0]?.line === 2 && /Record Type/.test(vg.problems[0]?.message),
  vg.problems[0]?.message);
const vgRun = await send(vague);
check('running it writes nothing and reports the line',
  vgRun.created === 0 && vgRun.errors.length === 1 && vgRun.errors[0].line === 2);

const badType = [HEAD, `Widget,${PREFIX}-3,,,,,,,,,,,,,,,,,,,,,,,`].join('\n');
const bt = await send(badType, { run: false });
check('an unknown Record Type is refused by name',
  /"Widget" is not a record type/.test(bt.problems[0]?.message || ''), bt.problems[0]?.message);

console.log('\nERRORS POINT AT THE RIGHT LINE');
const mixedErr = [
  HEAD,
  `Policy,${PREFIX}-4,Master Carrier,Mastererr,Ann,02/02/1939,F,80,,,UL,900000,LCG1,20000,,,,,,,,,,,`,
  `Transaction,NO-SUCH-POLICY,,,,,,,,,,,,,,,,,,,,01/01/2024,Premium Payment,500,`,
  `Value,NO-SUCH-POLICY,,,,,,,,,,,,,,,01/31/2024,100,100,10,900000,,,,`,
].join('\n');
const me = await send(mixedErr);
check('the good row still imports', me.byType.policy === 1 && me.created >= 1);
check('two rows failed', me.errors.length === 2, `${me.errors.length}`);
check('the transaction error points at line 3',
  me.errors.some((e) => e.line === 3 && /No policy matches/.test(e.message)),
  JSON.stringify(me.errors));
check('the value error points at line 4',
  me.errors.some((e) => e.line === 4), JSON.stringify(me.errors.map((e) => e.line)));
check('errors come back in file order',
  me.errors.every((e, i, a) => i === 0 || a[i - 1].line <= e.line));

console.log('\nA MANAGER IS STILL CONFINED TO THEIR ENTITIES');
const pm = await login(MANAGER1.email, MANAGER1.password);
const crossFile = [HEAD,
  `Policy,${PREFIX}-9,Master Carrier,Mastercross,Zed,01/01/1940,M,80,,,UL,1000000,LCG2,10000,,,,,,,,,,,`,
].join('\n');
const cross = await send(crossFile, { who: pm });
check('a policy for another entity is refused', cross.created === 0 && cross.errors.length === 1,
  cross.errors[0]?.message);
check('with the reason given', /not one of your entities/.test(cross.errors[0]?.message || ''));
const ownFile = [HEAD,
  `Policy,${PREFIX}-8,Master Carrier,Masterown,Yves,01/01/1940,M,80,,,UL,1000000,LCG1,10000,,,,,,,,,,,`,
].join('\n');
const own = await send(ownFile, { who: pm });
check('their own entity is accepted', (own.created + own.updated) === 1 && own.errors.length === 0,
  JSON.stringify(own.errors));

console.log('\nTHE TEMPLATE IS A WORKING FILE');
const tpl = await (await api('/import/template/master')).text();
check('the master template downloads', tpl.split('\n')[0].startsWith('Record Type'),
  tpl.split('\n')[0].slice(0, 40));
const tplPreview = await send(tpl, { run: false });
check('and every one of its rows classifies',
  tplPreview.byType.unclassified === 0,
  JSON.stringify(tplPreview.byType));
check('covering all five record types',
  ['policy', 'insured', 'life', 'value', 'transaction'].every((k) => tplPreview.byType[k] > 0),
  JSON.stringify(tplPreview.byType));

console.log('\nTHE PIECEWISE IMPORTERS STILL WORK');
const piecewise = ['Policy Number,Carrier Name,Transaction Date,Transaction Type,Amount',
  `${PREFIX}-3,Master Carrier,09/09/2024,Fee,250`].join('\n');
check('the transactions importer is unaffected',
  (await send(piecewise, { type: 'transactions' })).created === 1);
check('and it now skips duplicates too',
  (await send(piecewise, { type: 'transactions' })).skipped === 1);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL MASTER IMPORT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
