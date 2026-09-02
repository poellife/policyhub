/* =====================================================================
   Life-expectancy reports.

   Records go to a third service and a Medical Summary & Estimated
   Life-Expectancy Analysis comes back. The service is stood in for here
   — a real run costs real money and takes minutes — so what is under
   test is everything on this side of that call.

   What has to hold:

     - the headline is kept and the report is not. This application
       stores initials, an age, an estimate, a range and a confidence,
       and never a medical summary. If a future change starts writing
       the PDF down, this fails;
     - a case is watched, not waited on: it moves through its stages and
       the row follows;
     - a failure over there is reported here rather than swallowed;
     - a report attaches to a policy or a deal, one or the other, and
       follows a deal onto the policy when it is funded — and back if
       the deal is sent back;
     - administrators and nobody else. An investor cannot see it, a
       manager cannot see it, and neither can reach the PDF;
     - deleting one tells the service to forget it too.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import pg from 'pg';
import { startLeStub } from './le-stub.mjs';
import {
  BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login, databaseUrl,
} from './test-config.mjs';

const PREFIX = 'LEREP';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body instanceof FormData ? opts.body
    : opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: {
    Cookie: cookie,
    ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(opts.headers || {}),
  },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const stub = await startLeStub(5077);
const db = new pg.Client({ connectionString: databaseUrl() });
await db.connect();

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);

const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;

const wipe = async () => {
  for (const r of ((await json(await api(admin, '/le-reports')))?.reports || []))
    await api(admin, `/le-reports/${r.id}`, { method: 'DELETE' });
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const records = (name = 'aps.pdf', size = 4096) => {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(size).fill(7)],
    { type: 'application/pdf' }), name);
  form.append('mode', 'full');
  return form;
};

/** Poll this application until the case stops moving. */
const settle = async (id, tries = 20) => {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await json(await api(admin, `/le-reports/${id}`));
    if (['done', 'error', 'expired'].includes(last?.status)) return last;
    await new Promise((r) => setTimeout(r, 60));
  }
  return last;
};

const make = async (suffix, body = {}) => json(await api(admin, '/opportunities', {
  method: 'POST',
  body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Records Life', product_type: 'UL',
    face_amount: 3000000, insured_last_name: 'Recorded', insured_first_name: 'Rae',
    insured_dob: '1945-03-14', insured_gender: 'M', insured_state: 'TX',
    le_months: 120, asking_price: 600000, annual_premium: 48000,
    expected_close: '2026-11-30', offer_closes_on: '2027-05-31', fund_id: lcg1.id, ...body },
}));

/* ------------------------------------------------------------------ *
 * Running one
 * ------------------------------------------------------------------ */
console.log('RECORDS GO OVER AND A CASE COMES BACK');
const started = await json(await api(admin, '/le-reports', {
  method: 'POST', body: records() }));
check('a case is opened straight away rather than blocking on the report',
  started?.id > 0 && started.case_id, JSON.stringify(started?.status));
check('and it starts in a running state', started.status === 'queued', started?.status);

const done = await settle(started.id);
check('watching it through takes it to done', done?.status === 'done', done?.status);

console.log('\nTHE HEADLINE IS KEPT');
check('the initials', done.initials === 'A.B.', done.initials);
check('the age and sex', done.age === 81 && /male/i.test(done.sex), `${done.age} ${done.sex}`);
check('the central estimate', Number(done.central_years) === 4.2, String(done.central_years));
check('the range', Number(done.range_low_years) === 3 && Number(done.range_high_years) === 6,
  `${done.range_low_years}–${done.range_high_years}`);
check('how confident it was', done.confidence === 'lower', done.confidence);
check('which route through the rubric it took', done.le_path === 'dominant', done.le_path);
check('the one-line summary', /metastatic prostate/i.test(done.one_liner), done.one_liner);
check('how much was read, and whether any of it was scanned',
  done.pages === 240 && done.ocr_used === true, `${done.pages} ${done.ocr_used}`);

console.log('\nAND THE REPORT IS NOT');
const cols = (await db.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'le_reports'"))
  .rows.map((r) => r.column_name);
check('no column holds a document', !cols.some((c) => /pdf|blob|content|bytes|report_json/i.test(c)),
  cols.join(','));
check('nor the medical sections',
  !cols.some((c) => /overview|problem|medication|systems|social|factors|modules/i.test(c)),
  cols.join(','));
const row = (await db.query('SELECT * FROM le_reports WHERE id = $1', [done.id])).rows[0];
const stored = JSON.stringify(row);
check('and nothing stored looks like a report', stored.length < 1200, `${stored.length} bytes`);

console.log('\nTHE REPORT ITSELF IS FETCHED, NEVER HELD');
const pdf = await api(admin, `/le-reports/${done.id}/report.pdf`);
const bytes = Buffer.from(await pdf.arrayBuffer());
check('it comes back as a PDF', pdf.status === 200
  && (pdf.headers.get('content-type') || '').includes('pdf'), String(pdf.status));
check('as an attachment named for the initials',
  /attachment; filename="AB_Medical_Summary_and_LE_Analysis\.pdf"/
    .test(pdf.headers.get('content-disposition') || ''),
  pdf.headers.get('content-disposition'));
check('and it really is one', bytes.toString('latin1').startsWith('%PDF-'));

/* ------------------------------------------------------------------ *
 * When it goes wrong
 * ------------------------------------------------------------------ */
console.log('\nA FAILURE OVER THERE IS REPORTED HERE');
stub.failNext();
const bad = await json(await api(admin, '/le-reports', { method: 'POST', body: records() }));
const failed = await settle(bad.id);
check('the case ends in error rather than running forever',
  failed?.status === 'error', failed?.status);
check('and says what the service said',
  /no readable text/i.test(failed.error || ''), failed.error);
const noPdf = await api(admin, `/le-reports/${failed.id}/report.pdf`);
check('there is no report to fetch, and it says so rather than 500ing',
  [404, 409].includes(noPdf.status), String(noPdf.status));

console.log('\nAND A CASE THE SERVICE HAS FORGOTTEN');
/* Two different things happen when the service loses a case, and which
   one depends on whether it had already answered. */
const ghost = await json(await api(admin, '/le-reports', { method: 'POST', body: records() }));
await json(await api(admin, `/le-reports/${ghost.id}`));   // nudge it off 'queued'
await fetch(`http://127.0.0.1:5077/api/cases/${ghost.case_id}`,
  { method: 'DELETE', headers: { 'X-API-Key': 'le-stub-key' } });
const purged = await json(await api(admin, `/le-reports/${ghost.id}`));
check('a case purged before it answered is marked expired, not left running',
  purged.status === 'expired', purged.status);
check('and says what happened', /purged/i.test(purged.error || ''), purged.error);
check('with no figures invented for it', purged.central_years === null,
  String(purged.central_years));

const kept = await json(await api(admin, '/le-reports', { method: 'POST', body: records() }));
const keptDone = await settle(kept.id);
check('but one that finished first is done', keptDone.status === 'done');
await fetch(`http://127.0.0.1:5077/api/cases/${kept.case_id}`,
  { method: 'DELETE', headers: { 'X-API-Key': 'le-stub-key' } });
const after = await json(await api(admin, `/le-reports/${kept.id}`));
check('and stays done once the service purges it — the headline is the answer',
  after.status === 'done', after.status);
check('with its figures intact', Number(after.central_years) === 4.2,
  String(after.central_years));
const goneP = await api(admin, `/le-reports/${kept.id}/report.pdf`);
check('only the report itself is gone, and it says so rather than 500ing',
  goneP.status === 404, String(goneP.status));
const goneMsg = (await json(await api(admin, `/le-reports/${kept.id}/report.pdf`)))?.error || '';
check('in a sentence about purging, not a stack trace',
  /purged after a day|no longer on the report service/i.test(goneMsg), goneMsg);

/* ------------------------------------------------------------------ *
 * Attaching
 * ------------------------------------------------------------------ */
console.log('\nATTACHING IT TO SOMETHING');
const o1 = await make('1');
const att = await api(admin, `/le-reports/${done.id}`, {
  method: 'PUT', body: { opportunity_id: o1.id } });
check('a report attaches to a deal', att.ok, String(att.status));
const onDeal = await json(await api(admin, `/opportunities/${o1.id}`));
check('and the deal carries it',
  (onDeal.le_reports || []).some((r) => r.id === done.id));
const both = await api(admin, `/le-reports/${done.id}`, {
  method: 'PUT', body: { opportunity_id: o1.id, policy_id: 1 } });
check('one end or the other, never both', both.status === 400, String(both.status));

console.log('\nAND IT FOLLOWS THE DEAL');
await api(admin, `/opportunities/${o1.id}/shares`, {
  method: 'PUT', body: { investor_ids: [me1, me2] } });
await api(inv1, `/opportunities/${o1.id}/commit`, { method: 'POST', body: { pct: 60 } });
await api(inv2, `/opportunities/${o1.id}/commit`, { method: 'POST', body: { pct: 25 } });
for (const c of (await json(await api(admin, `/opportunities/${o1.id}`))).commitments)
  await api(admin, `/opportunity-commitments/${c.id}`, {
    method: 'PUT', body: { status: 'Confirmed' } });
const funded = await json(await api(admin, `/opportunities/${o1.id}/fund`, { method: 'POST' }));
check('the deal funds', funded?.policy_id > 0, JSON.stringify(funded));
const carried = (await db.query('SELECT * FROM le_reports WHERE id = $1', [done.id])).rows[0];
check('the report moved onto the policy',
  Number(carried.policy_id) === Number(funded.policy_id) && carried.opportunity_id === null,
  `${carried.policy_id} / ${carried.opportunity_id}`);
check('and says it was carried', Number(carried.carried_from) === Number(o1.id),
  String(carried.carried_from));

await api(admin, `/opportunities/${o1.id}/reopen`, {
  method: 'POST', body: { backing_out: [me2] } });
const back = (await db.query('SELECT * FROM le_reports WHERE id = $1', [done.id])).rows[0];
check('and comes back with the deal if it is sent back',
  Number(back.opportunity_id) === Number(o1.id) && back.policy_id === null,
  `${back.opportunity_id} / ${back.policy_id}`);

/* ------------------------------------------------------------------ *
 * Who may
 * ------------------------------------------------------------------ */
console.log('\nADMINISTRATORS AND NOBODY ELSE');
for (const [who, cookie] of [['a manager', pm1], ['an investor', inv1]]) {
  check(`${who} cannot read the list`,
    (await api(cookie, '/le-reports')).status === 403,
    String((await api(cookie, '/le-reports')).status));
  check(`${who} cannot fetch a report`,
    (await api(cookie, `/le-reports/${done.id}/report.pdf`)).status === 403);
  const form = records();
  check(`${who} cannot run one`,
    (await api(cookie, '/le-reports', { method: 'POST', body: form })).status === 403);
}
const invDeal = await json(await api(inv1, `/opportunities/${o1.id}`));
check('and an investor shown the deal is not sent the reports on it',
  invDeal.le_reports === undefined, JSON.stringify(invDeal.le_reports));
const pmDeal = await json(await api(pm1, `/opportunities/${o1.id}`));
check('nor is a manager', pmDeal.le_reports === undefined, JSON.stringify(pmDeal.le_reports));

/* ------------------------------------------------------------------ *
 * Deleting
 * ------------------------------------------------------------------ */
console.log('\nDELETING ONE TELLS THE SERVICE TOO');
const gone = await json(await api(admin, '/le-reports', { method: 'POST', body: records() }));
await settle(gone.id);
const del = await api(admin, `/le-reports/${gone.id}`, { method: 'DELETE' });
check('it goes from here', del.ok);
check('and from the report service',
  (await fetch(`http://127.0.0.1:5077/api/cases/${gone.case_id}`,
    { headers: { 'X-API-Key': 'le-stub-key' } })).status === 404);
check('the row is gone, not flagged',
  (await db.query('SELECT 1 FROM le_reports WHERE id = $1', [gone.id])).rowCount === 0);

console.log('\nAND IT IS ALL ON THE RECORD');
const log = JSON.stringify(await json(await api(admin, '/audit?limit=60')));
check('sending the records is logged, with the filenames',
  /record file\(s\) for a life-expectancy report/i.test(log) && /aps\.pdf/.test(log));
check('so is downloading the report',
  /downloaded the life-expectancy report/i.test(log));

await wipe();
await db.end();
await stub.close();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All LE report checks passed.'}`);
process.exit(fails.length ? 1 : 0);
