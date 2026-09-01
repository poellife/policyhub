/* =====================================================================
   Filing a price against the thing it priced.

   The model lives in another application and knows nothing about the
   book. It prices a policy — often before there is a policy, sometimes
   long after — and the one fact it cannot hold is which record the
   price belongs to. That fact is this application's, so the link is
   made here, from either end and in either order.

   What has to hold:

     - a run can be attached to an opportunity or to a policy, and taken
       off again, and the record says who did it and when;
     - one or the other, never both;
     - a valuation attached to a deal follows that deal onto the policy
       when it is funded, and says it was carried;
     - a manager sees runs attached inside their own entities and the
       ones attached to nothing, and neither sees nor may touch a run
       filed against another entity's record;
     - an investor cannot read the list, cannot attach, and is not sent
       the desk's pricing on the deal or the policy they hold;
     - a job the service has never heard of is a 404, not a silent
       insert.

   The runs themselves come from the valuation service. This suite does
   not run valuations — they cost real money and take minutes — so it
   seeds rows of its own directly, which is what a completed run leaves
   behind. Everything under test is on this side of that.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import pg from 'pg';
import {
  BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login, databaseUrl,
} from './test-config.mjs';

const PREFIX = 'VALATT';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) < tol;

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const db = new pg.Client({ connectionString: databaseUrl() });
await db.connect();

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);

const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];
const other = funds.find((f) => f.id !== lcg1.id) || null;
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;

const wipe = async () => {
  await db.query("DELETE FROM valuations WHERE job LIKE $1", [`${PREFIX}%`]);
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

/** What a finished run leaves behind, as the sync would have written it. */
const seedRun = async (suffix, over = {}) => {
  const v = {
    job: `${PREFIX}-${suffix}`, ran_at: '2026-08-01T12:00:00Z', ran_by: 'valtest',
    case_name: `${PREFIX.toLowerCase()}-${suffix}`, insured: 'Priced, Pat',
    face: 3000000, price: 610000, irr: 15, mode: 'IRR', target: 15, mean_le: 78, ...over,
  };
  await db.query(
    `INSERT INTO valuations (job, ran_at, ran_by, case_name, insured, face, price, irr,
                             mode, target, mean_le)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [v.job, v.ran_at, v.ran_by, v.case_name, v.insured, v.face, v.price, v.irr,
     v.mode, v.target, v.mean_le]);
  return v.job;
};

const rowFor = async (job) =>
  (await db.query('SELECT * FROM valuations WHERE job = $1', [job])).rows[0];

const make = async (suffix, body = {}) => json(await api(admin, '/opportunities', {
  method: 'POST',
  body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Priced Life', product_type: 'UL',
    face_amount: 3000000, insured_last_name: 'Priced', insured_first_name: 'Pat',
    insured_dob: '1945-03-11', insured_gender: 'M', insured_state: 'MI',
    le_months: 78, le_provider: 'ITM21st', le_date: '2026-02-01',
    asking_price: 610000, annual_premium: 52000,
    expected_close: '2026-09-30', offer_closes_on: '2027-06-30',
    fund_id: lcg1.id, ...body },
}));

const keyIn = async (suffix, body = {}) => json(await api(admin, '/policies', {
  method: 'POST',
  body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Priced Life', product_type: 'UL',
    face_amount: 3000000, status: 'Inforce', fund_id: lcg1.id,
    insured_last_name: 'Priced', insured_first_name: 'Pat',
    insured_dob: '1945-03-11', insured_gender: 'M', insured_state: 'MI', le_months: 78,
    acquisition_date: '2026-02-01', acquisition_cost: 610000,
    premium_required: 52000, premium_mode: 'Annual', ...body },
}));

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */
console.log('THE LIST OF RUNS');
const jA = await seedRun('A');
const listed = await json(await api(admin, '/valuations'));
check('the list comes back as a list with a liveness flag',
  Array.isArray(listed?.valuations) && typeof listed.live === 'boolean',
  JSON.stringify({ live: listed?.live, n: listed?.valuations?.length }));
const mineA = (listed.valuations || []).find((v) => v.job === jA);
check('a seeded run is in it', !!mineA);
check('with its price and the terms it was priced on',
  near(mineA?.price, 610000) && mineA?.mode === 'IRR' && near(mineA?.target, 15),
  `${mineA?.price} ${mineA?.mode} ${mineA?.target}`);
check('and it starts attached to nothing',
  mineA?.policy_id === null && mineA?.opportunity_id === null);
check('a service that cannot be reached is said so rather than hidden',
  listed.live === true || /could not be reached/i.test(listed.note || ''),
  `live=${listed.live} note=${listed.note}`);

/* ------------------------------------------------------------------ *
 * Attaching, and taking it off again
 * ------------------------------------------------------------------ */
console.log('\nATTACHING A RUN TO A DEAL, AND TAKING IT OFF');
const o1 = await make('1');
const att = await api(admin, `/valuations/${jA}`, {
  method: 'PUT', body: { opportunity_id: o1.id } });
check('a run attaches to an opportunity', att.ok, String(att.status));
let row = await rowFor(jA);
check('the row names the deal', Number(row.opportunity_id) === Number(o1.id));
check('and who filed it, and when',
  row.attached_by !== null && row.attached_at !== null,
  `${row.attached_by} @ ${row.attached_at}`);

const seen = await json(await api(admin, `/opportunities/${o1.id}`));
check('and the deal now carries it', (seen.valuations || []).some((v) => v.job === jA),
  JSON.stringify((seen.valuations || []).map((v) => v.job)));

const off = await api(admin, `/valuations/${jA}`, { method: 'PUT', body: {} });
check('an empty body detaches it', off.ok, String(off.status));
row = await rowFor(jA);
check('the link, the hand and the date all go together',
  row.opportunity_id === null && row.policy_id === null
  && row.attached_by === null && row.attached_at === null);

console.log('\nAND TO A POLICY THAT WAS NEVER A DEAL');
const p1 = await keyIn('2');
const jB = await seedRun('B');
const attP = await api(admin, `/valuations/${jB}`, {
  method: 'PUT', body: { policy_id: p1.id } });
check('a run attaches to a policy keyed straight in', attP.ok, String(attP.status));
const pSeen = await json(await api(admin, `/policies/${p1.id}`));
check('and the policy page carries it', (pSeen.valuations || []).some((v) => v.job === jB));
check('nothing was carried — it was filed here directly',
  (pSeen.valuations || []).find((v) => v.job === jB)?.carried_from === null);

console.log('\nONE OR THE OTHER, NEVER BOTH');
const both = await api(admin, `/valuations/${jB}`, {
  method: 'PUT', body: { policy_id: p1.id, opportunity_id: o1.id } });
check('naming both ends is refused rather than resolved', both.status === 400,
  String(both.status));
check('and it is refused in a sentence', /one thing or the other/i.test(
  (await json(both))?.error || ''));
check('the earlier link is untouched',
  Number((await rowFor(jB)).policy_id) === Number(p1.id));

console.log('\nA JOB NOBODY HAS RUN');
const ghost = await api(admin, '/valuations/VALATT-nosuchjob', {
  method: 'PUT', body: { policy_id: p1.id } });
check('is a 404, not a silent insert', ghost.status === 404, String(ghost.status));
check('and no row appeared for it',
  (await db.query('SELECT 1 FROM valuations WHERE job = $1', ['VALATT-nosuchjob']))
    .rowCount === 0);

/* ------------------------------------------------------------------ *
 * Funding carries the price forward
 * ------------------------------------------------------------------ */
console.log('\nWHAT WAS PRICED AS A DEAL IS STILL THE PRICE OF THE POLICY');
const o2 = await make('3');
const jC = await seedRun('C');
await api(admin, `/valuations/${jC}`, { method: 'PUT', body: { opportunity_id: o2.id } });
await api(admin, `/opportunities/${o2.id}/shares`, {
  method: 'PUT', body: { investor_ids: [me1, me2] } });
await api(inv1, `/opportunities/${o2.id}/commit`, { method: 'POST', body: { pct: 60 } });
await api(inv2, `/opportunities/${o2.id}/commit`, { method: 'POST', body: { pct: 25 } });
for (const c of (await json(await api(admin, `/opportunities/${o2.id}`))).commitments)
  await api(admin, `/opportunity-commitments/${c.id}`, {
    method: 'PUT', body: { status: 'Confirmed' } });
const funded = await json(await api(admin, `/opportunities/${o2.id}/fund`, { method: 'POST' }));
check('the deal funds into a policy', funded?.policy_id > 0, JSON.stringify(funded));
const carried = await rowFor(jC);
check('the valuation moved to the policy',
  Number(carried.policy_id) === Number(funded.policy_id) && carried.opportunity_id === null,
  `${carried.policy_id} / ${carried.opportunity_id}`);
check('and the record says it was carried, not filed there by hand',
  Number(carried.carried_from) === Number(o2.id), String(carried.carried_from));
const fundedPage = await json(await api(admin, `/policies/${funded.policy_id}`));
check('the new policy page shows it', (fundedPage.valuations || []).some((v) => v.job === jC));

console.log('\nAND BACK AGAIN IF THE DEAL COMES APART');
const backOut = await api(admin, `/opportunities/${o2.id}/reopen`, {
  method: 'POST', body: { backing_out: [me2] } });
check('the deal goes back on the list', backOut.ok, String(backOut.status));
const returned = await rowFor(jC);
check('and the price goes back to the deal with it',
  Number(returned.opportunity_id) === Number(o2.id) && returned.policy_id === null,
  `${returned.opportunity_id} / ${returned.policy_id}`);
check('no longer marked as carried, because it is not on a policy any more',
  returned.carried_from === null, String(returned.carried_from));

/* ------------------------------------------------------------------ *
 * Entities
 * ------------------------------------------------------------------ */
console.log('\nA MANAGER WORKS INSIDE THEIR OWN ENTITIES');
const jD = await seedRun('D');
const unheld = await json(await api(pm1, '/valuations'));
check('an unattached run belongs to nobody yet, so a manager sees it',
  (unheld.valuations || []).some((v) => v.job === jD));

if (other) {
  const foreignP = await keyIn('4', { fund_id: other.id });
  const jE = await seedRun('E');
  await api(admin, `/valuations/${jE}`, { method: 'PUT', body: { policy_id: foreignP.id } });

  const pmList = await json(await api(pm1, '/valuations'));
  check('but a run filed against another entity’s policy is not on their list',
    !(pmList.valuations || []).some((v) => v.job === jE),
    JSON.stringify((pmList.valuations || []).map((v) => v.job)));

  const reach = await api(pm1, `/valuations/${jD}`, {
    method: 'PUT', body: { policy_id: foreignP.id } });
  check('and they cannot file one against it either', reach.status === 404,
    String(reach.status));
  check('nothing moved', (await rowFor(jD)).policy_id === null);
} else {
  check('a second entity exists to test the boundary with', false, 'only one fund');
}

const ownP = await keyIn('5');
const jF = await seedRun('F');
const pmAttach = await api(pm1, `/valuations/${jF}`, {
  method: 'PUT', body: { policy_id: ownP.id } });
check('inside their own entity a manager may file a price', pmAttach.ok,
  String(pmAttach.status));

/* ------------------------------------------------------------------ *
 * Investors
 * ------------------------------------------------------------------ */
console.log('\nWHAT THE DESK THINKS IT IS WORTH IS THE DESK’S');
const invList = await api(inv1, '/valuations');
check('an investor cannot read the list of runs', invList.status === 403,
  String(invList.status));
const invPut = await api(inv1, `/valuations/${jA}`, {
  method: 'PUT', body: { policy_id: p1.id } });
check('nor file one', invPut.status === 403, String(invPut.status));

const o3 = await make('6');
const jG = await seedRun('G');
await api(admin, `/valuations/${jG}`, { method: 'PUT', body: { opportunity_id: o3.id } });
await api(admin, `/opportunities/${o3.id}/shares`, {
  method: 'PUT', body: { investor_ids: [me1] } });
const invSees = await json(await api(inv1, `/opportunities/${o3.id}`));
check('an investor shown the deal is not shown the pricing of it',
  invSees.valuations === undefined, JSON.stringify(invSees.valuations));
check('though they can still see the deal itself',
  Number(invSees.id) === Number(o3.id));

const invPolicy = await json(await api(inv1, `/policies/${funded.policy_id}`));
check('and the same on a policy they hold',
  invPolicy.valuations === undefined, JSON.stringify(invPolicy.valuations));

/* ------------------------------------------------------------------ *
 * Deleting the record takes the link, not the run
 * ------------------------------------------------------------------ */
console.log('\nDELETING THE RECORD LEAVES THE RUN ON FILE');
const o4 = await make('7');
const jH = await seedRun('H');
await api(admin, `/valuations/${jH}`, { method: 'PUT', body: { opportunity_id: o4.id } });
await api(admin, `/opportunities/${o4.id}`, { method: 'DELETE' });
const orphan = await rowFor(jH);
check('the run survives the deal it was filed against', !!orphan);
check('and goes back to being attached to nothing',
  orphan?.opportunity_id === null && orphan?.policy_id === null,
  `${orphan?.opportunity_id} / ${orphan?.policy_id}`);

await wipe();
await db.end();

console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All valuation-attachment checks passed.'}`);
process.exit(fails.length ? 1 : 0);
