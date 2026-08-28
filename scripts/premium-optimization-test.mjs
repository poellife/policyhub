/* =====================================================================
   Premium optimization.

   A servicing firm is paid to work out the smallest premium stream that
   keeps a policy in force to maturity and sends back a workbook: a
   header block naming the policy, then a dated table running for
   decades, then a note on the reasoning.

   The properties worth holding:

     - it is read, not guessed at. The header is found by its labels
       rather than by cell position, so a file with the block one row
       lower still reads, and both .xlsx and .csv work.
     - it is filed against the right policy. The number in the file is
       matched and shown back before anything is written, because a
       stream on the wrong policy puts somebody else's figures in front
       of whoever is deciding what to fund.
     - IT IS REFERENCE. Uploading one changes nothing about what is due,
       the premium forecast, or what a capital call would ask for. This
       is the whole point of the feature and the easiest thing to break.
     - administrators and managers only, inside their own entities.

   Idempotent: its own entity, policy and streams, removed first and last.
   ===================================================================== */
import fs from 'node:fs';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'POPT';
const FUND = 'POPTFND';
const XLSX = 'demo/premium-optimization.xlsx';
const CSV = 'demo/premium-optimization.csv';
const FILE_POLICY = 'PO-SAMPLE-4471';

const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) < tol;
const M = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)
    ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, ...(opts.body instanceof FormData
    ? {} : { 'Content-Type': 'application/json' }), ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const upload = (cookie, path, file, extra = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)]), file.split('/').pop());
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  return api(cookie, path, { method: 'POST', body: fd });
};

for (const f of [XLSX, CSV]) {
  if (!fs.existsSync(f)) {
    console.error(`\nMissing ${f}. Run: node scripts/make-premium-stream-sample.js\n`);
    process.exit(2);
  }
}

const admin = await login(ADMIN.email, ADMIN.password);
const manager = await login(MANAGER1.email, MANAGER1.password);
const inv = await login(INVESTOR1.email, INVESTOR1.password);
const me = (await json(await api(inv, '/auth/me'))).investor.id;

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  for (const s of ((await json(await api(admin, '/premium-streams'))) || []))
    if (String(s.policy_number || '').startsWith(FILE_POLICY)
        || String(s.on_policy_number || '').startsWith(PREFIX))
      await api(admin, `/premium-streams/${s.id}`, { method: 'DELETE' });
  /* Both names: the fixture policy carries the number the SAMPLE FILE
     names, which is not the suite's own prefix. Searching only for the
     prefix left it behind, and the second run then found two policies
     with the same number and could not match either. */
  const seen = new Map();
  for (const term of [PREFIX, FILE_POLICY])
    for (const st of STATUSES)
      for (const p of ((await json(await api(admin, `/policies?search=${term}&status=${st}`))) || []))
        if (String(p.policy_number).startsWith(PREFIX)
            || String(p.policy_number) === FILE_POLICY) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(admin, `/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  for (const f of ((await json(await api(admin, '/funds'))) || []).filter((x) => x.code === FUND))
    await api(admin, `/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();
await api(admin, '/funds', { method: 'POST', body: { code: FUND, name: 'Premium optimization fixture' } });

/* The policy the sample file names, plus a scheduled premium of its own so
   there is something for the "changes nothing" checks to compare against. */
const policy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: FILE_POLICY, carrier_name: 'Northbank Life', product_type: 'UL',
  fund_code: FUND, face_amount: 4000000,
  premium_required: 88000, premium_mode: 'Annual', next_premium_due: iso(9),
  insured_last_name: `${PREFIX}Fairbanks`, insured_first_name: 'Marguerite',
  dob: '1944-02-02' } }));
if (!policy?.id) {
  console.error('\nCould not create the fixture policy:', JSON.stringify(policy));
  process.exit(2);
}
await api(admin, `/policies/${policy.id}/investors`, { method: 'POST', body: {
  investor_id: me, pct: 50, acquired_on: iso(-300) } });
const step = await json(await api(admin, `/policies/${policy.id}/reminders`, { method: 'POST',
  body: { kind: 'Premium', due_date: iso(25), amount: 9000, note: `${PREFIX} scheduled` } }));

/* What the rest of the application says BEFORE anything is uploaded. */
const mine = (rows) => (rows || []).filter((r) =>
  String(r.policy_number || '') === FILE_POLICY);
const snapshot = async () => {
  const [svc, forecast, draft] = await Promise.all([
    json(await api(admin, '/servicing')),
    json(await api(admin, '/reports/premium-forecast?months=24')),
    json(await api(admin, `/capital-calls/draft?days=90&fund=${FUND}`)),
  ]);
  return {
    upcoming: mine(svc.upcoming).map((u) => `${u.next_premium_due}:${u.premium_required}`).join(),
    forecast: forecast.schedule.flatMap((m) => m.payments)
      .filter((p) => p.policy_id === policy.id)
      .map((p) => `${p.due_date}:${p.amount}`).join(),
    grand: Number(forecast.grandTotal).toFixed(2),
    draft: `${draft.items.length}:${Number(draft.total).toFixed(2)}`,
  };
};
const before = await snapshot();

console.log('READING THE FILE, BEFORE ANYTHING IS WRITTEN');
const prevRes = await upload(admin, '/premium-streams/preview', XLSX);
check('the workbook is read', prevRes.status === 200, `status ${prevRes.status}`);
const preview = await json(prevRes);
check('nothing was saved by looking at it',
  ((await json(await api(admin, '/premium-streams'))) || []).length === 0);
const h = preview.header;
check('the insured is read off the header block', h.insured_name === 'Marguerite A Fairbanks',
  h.insured_name);
check('and the policy number', h.policy_number === FILE_POLICY, h.policy_number);
check('and the carrier', /Northbank/.test(h.carrier_name), h.carrier_name);
check('and the face amount, as a number', near(h.face_amount, 4000000), String(h.face_amount));
check('and the dates the policy runs between',
  h.effective_date === '2021-06-14' && h.maturity_date === '2062-06-14',
  `${h.effective_date} → ${h.maturity_date}`);
check('the premium type comes off the Comments tab', h.premium_type === 'Hybrid', h.premium_type);
check('and so does what the servicing firm actually said',
  /minimum cost of insurance/i.test(h.comments), h.comments.slice(0, 70));
check('every dated premium is read', preview.summary.count === 300,
  String(preview.summary.count));
check('and none of them silently dropped', preview.problems.length === 0,
  JSON.stringify(preview.problems.slice(0, 2)));
check('the stream is matched to the policy by its number',
  preview.matched && preview.match.id === policy.id, JSON.stringify(preview.match?.policy_number));
check('the years add up to the stream',
  near(preview.years.reduce((n, y) => n + y.total, 0), preview.summary.total),
  `${M(preview.years.reduce((n, y) => n + y.total, 0))} vs ${M(preview.summary.total)}`);
check('the first payment is the catch-up the file describes',
  near(preview.summary.next_12mo, preview.years[0].total + 0, 1e9) && preview.summary.next_12mo > 0,
  M(preview.summary.next_12mo));

console.log('\nFILING IT');
const bad = await upload(admin, '/premium-streams', XLSX);
check('it will not be filed without a policy', bad.status === 400, `status ${bad.status}`);
const saveRes = await upload(admin, '/premium-streams', XLSX,
  { policy_id: policy.id, source: 'Fixture Servicing Co' });
check('it is filed against the policy', saveRes.status === 201, `status ${saveRes.status}`);
const saved = await json(saveRes);
check('with every row', saved.count === 300, String(saved.count));

const list = await json(await api(admin, '/premium-streams'));
const listed = list.find((s) => s.id === saved.id);
check('it appears on the list', !!listed);
check('carrying the count and the window',
  listed.payments === 300 && String(listed.first_due).slice(0, 10) === preview.summary.first,
  `${listed.payments} · ${listed.first_due}`);
check('and what the next twelve months come to', Number(listed.next_12mo) > 0,
  M(listed.next_12mo));

const full = await json(await api(admin, `/premium-streams/${saved.id}`));
check('opening it gives the years', full.years.length >= 20, String(full.years.length));
check('each year carries its months', full.years[0].rows.length === full.years[0].payments,
  `${full.years[0].rows.length} of ${full.years[0].payments}`);
check('and the year totals still add to the whole',
  near(full.years.reduce((n, y) => n + y.total, 0), full.total), M(full.total));
check('to the cent, not rounded',
  full.years.some((y) => y.rows.some((r) => Math.round(r.amount) !== r.amount)),
  String(full.years[0].rows[0].amount));

console.log('\nAND IT CHANGES NOTHING');
/* The whole point. A premium optimization is somebody else's model of what
   would be ideal; it is not a bill, and no screen that says money is due may
   move because one was uploaded. */
const after = await snapshot();
check('what is coming up on the calendar is untouched',
  after.upcoming === before.upcoming, `${before.upcoming} → ${after.upcoming}`);
check('the premium forecast is untouched',
  after.forecast === before.forecast && after.grand === before.grand,
  `${before.grand} → ${after.grand}`);
check('and what a capital call would ask for is untouched',
  after.draft === before.draft, `${before.draft} → ${after.draft}`);
check('the scheduled premium is still the only thing due on that policy',
  after.forecast === `${iso(25)}:9000`, after.forecast);

console.log('\nA CSV OF THE SAME FILE');
const csvPrev = await json(await upload(admin, '/premium-streams/preview', CSV));
check('reads the same header', csvPrev.header.policy_number === FILE_POLICY
  && near(csvPrev.header.face_amount, 4000000), csvPrev.header.policy_number);
check('and the same payments', csvPrev.summary.count === 300, String(csvPrev.summary.count));
check('and matches the same policy', csvPrev.match?.id === policy.id);
/* A CSV is one sheet, so the Comments tab is not in it. Saying nothing is
   right; inventing a premium type would not be. */
check('with no comments, because a CSV has no second sheet', csvPrev.header.comments === '');

console.log('\nA FILE THAT NAMES NOTHING WE HOLD');
const strayName = '/tmp/popt-stray.csv';
fs.writeFileSync(strayName, fs.readFileSync(CSV, 'utf8')
  .replace(FILE_POLICY, 'NOT-A-POLICY-99999'));
const stray = await json(await upload(admin, '/premium-streams/preview', strayName));
check('is read anyway', stray.summary.count === 300, String(stray.summary.count));
check('but matches nothing, and says so', stray.matched === false && !stray.match,
  JSON.stringify(stray.match));
fs.unlinkSync(strayName);

const junk = '/tmp/popt-junk.csv';
fs.writeFileSync(junk, 'this is not a premium stream\njust,some,words\n');
const junkRes = await upload(admin, '/premium-streams/preview', junk);
check('a file with no dated table is refused with a readable reason',
  junkRes.status === 400 && /Date.*Premium/is.test((await json(junkRes)).error || ''),
  (await json(await upload(admin, '/premium-streams/preview', junk))).error);
fs.unlinkSync(junk);

console.log('\nWHO MAY SEE THEM');
check('an investor cannot list them',
  (await api(inv, '/premium-streams')).status === 403);
check('nor open one', (await api(inv, `/premium-streams/${saved.id}`)).status === 403);
check('nor upload one', (await upload(inv, '/premium-streams/preview', CSV)).status === 403);
check('nor delete one',
  (await api(inv, `/premium-streams/${saved.id}`, { method: 'DELETE' })).status === 403);

const managerSees = await json(await api(manager, '/premium-streams'));
check('a manager sees none of it while the policy is outside their entities',
  !(managerSees || []).some((s) => s.id === saved.id),
  `${(managerSees || []).length} visible`);
check('and cannot open it', (await api(manager, `/premium-streams/${saved.id}`)).status === 404);
check('nor file one against a policy that is not theirs',
  (await upload(manager, '/premium-streams', CSV, { policy_id: policy.id })).status === 404);

console.log('\nREMOVING ONE');
check('it can be removed',
  (await api(admin, `/premium-streams/${saved.id}`, { method: 'DELETE' })).status === 200);
check('and is gone', (await api(admin, `/premium-streams/${saved.id}`)).status === 404);
check('its rows went with it',
  !((await json(await api(admin, '/premium-streams'))) || []).some((s) => s.id === saved.id));
check('the policy is untouched by any of it',
  (await api(admin, `/policies/${policy.id}`)).status === 200);
check('and so is its schedule',
  ((await json(await api(admin, `/policies/${policy.id}`))).reminders || [])
    .some((r) => r.id === step.id));

await wipe();
console.log(fails.length
  ? `\n${fails.length} PREMIUM OPTIMIZATION CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL PREMIUM OPTIMIZATION CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
