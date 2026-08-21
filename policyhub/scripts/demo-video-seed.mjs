/* =====================================================================
   Fixture for the investor walkthrough video.

   Deliberately not the test fixtures: "Test Investor One" holding
   "Screentest, Maturity" is fine for a suite and embarrassing on camera.
   These are invented people and invented policies with plausible
   carriers, ages, prices and premium histories, so the screens show the
   shape of real numbers without showing anybody's real numbers.

   Idempotent: everything is prefixed and removed before it is rebuilt.
   ===================================================================== */
import { BASE, ADMIN, login } from './test-config.mjs';

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const admin = await login(ADMIN.email, ADMIN.password);

export const DEMO = {
  email: 'r.whitfield@example.com',
  password: process.env.DEMO_PASSWORD || 'demo-walkthrough-2026',
  investorName: 'Whitfield Family Trust',
};

/* ------------------------------ cleanup ----------------------------- */
for (const status of ['', 'Matured', 'Inforce']) {
  for (const p of ((await json(await api(admin, `/policies?status=${status}`))) || [])
    .filter((x) => String(x.policy_number).startsWith('PC-')))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
}
for (const o of ((await json(await api(admin, '/opportunities'))) || [])
  .filter((x) => String(x.policy_number).startsWith('PC-')))
  await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });

const users = await json(await api(admin, '/users'));
const existingUser = users.find((u) => u.email === DEMO.email);
if (existingUser) await api(admin, `/users/${existingUser.id}`, { method: 'DELETE' });

let investors = await json(await api(admin, '/investors'));
let investor = investors.find((i) => i.name === DEMO.investorName);
if (!investor) {
  investor = await json(await api(admin, '/investors', { method: 'POST', body: {
    name: DEMO.investorName, investor_type: 'Trust',
    email: DEMO.email, notes: 'Long-standing relationship; participates deal by deal.' } }));
}
// Clear whatever the trust held from a previous run.
const held = await json(await api(admin, `/investors/${investor.id}`));
for (const pos of held.positions || [])
  await api(admin, `/policy-investors/${pos.link_id}`, { method: 'DELETE' });

/* ------------------------------ policies ---------------------------- */
const BOOK = [
  { pn: 'PC-4417820', carrier: 'Lincoln Financial', type: 'UL', face: 5000000,
    last: 'Hartley', first: 'Margaret', dob: '1938-04-12', gender: 'F', state: 'MI',
    le: 78, leProv: 'ITM21st', leDate: '2024-06-01',
    acquired: '2021-03-15', cost: 780000, premium: 96000, pct: 35 },
  { pn: 'PC-2290641', carrier: 'John Hancock', type: 'SUL', face: 8000000,
    last: 'Okoye', first: 'Daniel', dob: '1940-11-02', gender: 'M', state: 'FL',
    le: 84, leProv: 'AVS', leDate: '2025-01-20',
    acquired: '2022-08-09', cost: 1240000, premium: 142000, pct: 20 },
  { pn: 'PC-7731055', carrier: 'Pacific Life', type: 'VUL', face: 3000000,
    last: 'Reyes', first: 'Aurelia', dob: '1943-02-27', gender: 'F', state: 'AZ',
    le: 96, leProv: 'Predictive', leDate: '2025-09-10',
    acquired: '2023-05-22', cost: 512000, premium: 61500, pct: 50 },
  { pn: 'PC-6104388', carrier: 'Prudential', type: 'GUL', face: 2500000,
    last: 'Vasquez', first: 'Teodoro', dob: '1937-07-19', gender: 'M', state: 'TX',
    le: 66, leProv: 'ITM21st', leDate: '2024-11-05',
    acquired: '2020-10-01', cost: 445000, premium: 54000, pct: 12.5 },
];

const monthsBetween = (a, b) => {
  const x = new Date(`${a}T00:00:00Z`), y = new Date(`${b}T00:00:00Z`);
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
};
const addMonths = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const today = new Date().toISOString().slice(0, 10);

for (const b of BOOK) {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: b.pn, carrier_name: b.carrier, product_type: b.type, fund_code: 'LCG1',
    face_amount: b.face, insured_last_name: b.last, insured_first_name: b.first,
    dob: b.dob, premium_required: b.premium, premium_mode: 'Annual',
    acquisition_date: b.acquired, acquisition_cost: b.cost,
    next_premium_due: addMonths(b.acquired, (monthsBetween(b.acquired, today) / 12 | 0) * 12 + 12),
    status: 'Inforce' } }));

  await api(admin, `/insureds/${p.insured_id}`, { method: 'PUT', body: {
    gender: b.gender, state: b.state, le_months: b.le, le_provider: b.leProv, le_date: b.leDate } });

  // Purchase, then a premium every year since.
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: b.acquired, txn_type: 'Acquisition Cost', amount: b.cost,
    remarks: 'Purchase price' } });
  const years = Math.floor(monthsBetween(b.acquired, today) / 12);
  for (let n = 0; n <= years; n++)
    await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
      txn_date: addMonths(b.acquired, 12 * n), txn_type: 'Premium Payment',
      amount: Math.round(b.premium * (1.04 ** n)), remarks: `Policy year ${n + 1}` } });

  // A carrier statement every six months, values drifting the way they do.
  for (let n = 0; n <= years * 2; n++) {
    const at = addMonths(b.acquired, 6 * n);
    if (at > today) break;
    await api(admin, `/policies/${p.id}/values`, { method: 'POST', body: {
      as_of_date: at,
      account_value: Math.round(b.face * 0.012 * (1 - n * 0.03)),
      cash_surrender_value: Math.round(b.face * 0.009 * (1 - n * 0.03)),
      cost_of_insurance: Math.round(b.premium / 12 * (1 + n * 0.02)),
      death_benefit: b.face } });
  }

  /* What is coming, on the servicing calendar.
     Every premium an investor is shown — the Premiums page, the next-due
     tile on their portfolio, the premium forecast, and anything a capital
     call is raised over — is read from here and from nowhere else. The
     annual figure on the policy form above is reference data and reaches
     none of those screens, so a book without these entries shows an
     investor "nothing scheduled" however many policies they hold. */
  const first = 12 + BOOK.indexOf(b) * 26;      // staggered, so the list has months in it
  for (let n = 0; n < 3; n++)
    await api(admin, `/policies/${p.id}/reminders`, { method: 'POST', body: {
      kind: 'Premium',
      due_date: addMonths(new Date(Date.now() + first * 86400000).toISOString().slice(0, 10),
        12 * n),
      amount: Math.round(b.premium * (1.04 ** (years + 1 + n))),
      note: n === 0 ? 'Per the carrier statement' : 'Per the illustration' } });

  await api(admin, `/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: investor.id, pct: b.pct, acquired_on: b.acquired } });
}

/* ---------------------------- opportunity --------------------------- */
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');
const opp = await json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: 'PC-9902147', carrier_name: 'Lincoln National', product_type: 'UL',
  face_amount: 11000000, insured_last_name: 'Ellsworth', insured_first_name: 'Raymond',
  insured_dob: '1963-04-18', insured_gender: 'M', insured_state: 'OH',
  le_months: 193, le_provider: 'Predictive', le_date: '2026-05-01',
  le_provider_2: 'Polaris', le_months_2: 195, records_through: '2026-04-30',
  asking_price: 265000, annual_premium: 220273,
  expected_close: addMonths(today, 2), offer_closes_on: addMonths(today, 1),
  fund_id: lcg1.id,
  impairments: [
    'Cardiovascular: coronary artery disease with five stents (2023), paroxysmal atrial fibrillation following ablation',
    'Metabolic: type 2 diabetes on metformin and semaglutide; hyperlipidaemia and hypertension',
    'Hepatic: extensive fatty liver with ongoing moderate alcohol use — the key life-expectancy risk',
    'Pulmonary: mild sleep apnoea, improved after a 60 lb weight loss',
  ].join('\n'),
  mitigating: 'Sustained 60 lb weight loss improved sleep apnoea, laboratory values and mobility.',
  underwriter_note: 'Mortality risk is higher than at prior underwriting, on the new ablation and '
    + 'the progression of the diabetes. The estimate reflects complete records through April 2026.',
  thesis: [
    'Discounted entry at 2.4% of face for an $11M institutional-quality policy.',
    'Two independent life-expectancy reports within two months of each other.',
    'A three-year premium holiday at ages 67–69 makes the cash flow materially easier than a level premium.',
  ].join('\n'),
  notes: 'Carrier illustration, both LE reports and the full medical file are in the data room.' } }));

const sched = [220273, 245091, 245091, 245091, 245091, 0, 0, 0, 38167.20, 111347.08,
               116036.35, 129681.04, 145854.09, 156890.59, 198165.08];
await api(admin, `/opportunities/${opp.id}/premium-schedule`, { method: 'POST', body: {
  rows: sched.map((amount, i) => ({ due_date: addMonths(today, 2 + 12 * i), amount })) } });
await api(admin, `/opportunities/${opp.id}/shares`,
  { method: 'PUT', body: { investor_ids: [investor.id] } });

/* --------------------------- one that paid -------------------------- */
/* A book with nothing realized in it is a promise. One claim that has been
   collected, with the cheque and the date it arrived, is the difference
   between showing somebody a projection and showing them a result. */
const matured = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: 'PC-5540118', carrier_name: 'Pacific Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 3000000, premium_required: 62000, premium_mode: 'Annual',
  insured_last_name: 'Vandermeer', insured_first_name: 'Alice', dob: '1934-09-02',
  insured_gender: 'F', insured_state: 'FL',
  acquisition_date: '2019-05-20', acquisition_cost: 520000 } }));
await api(admin, `/policies/${matured.id}/transactions`, { method: 'POST', body: {
  txn_date: '2019-05-20', txn_type: 'Acquisition Cost', amount: 520000 } });
for (const [d, a] of [['2020-05-20', 62000], ['2021-05-20', 64100], ['2022-05-20', 66300],
                      ['2023-05-20', 69800], ['2024-05-20', 72400]])
  await api(admin, `/policies/${matured.id}/transactions`, { method: 'POST', body: {
    txn_date: d, txn_type: 'Premium Payment', amount: a } });
await api(admin, `/policies/${matured.id}/investors`, { method: 'POST', body: {
  investor_id: investor.id, pct: 40, acquired_on: '2019-05-20' } });
const insureds = await json(await api(admin, '/insureds?search=Vandermeer'));
const vandermeer = (insureds.rows || insureds).find((i) => i.last_name === 'Vandermeer');
if (vandermeer)
  await api(admin, `/insureds/${vandermeer.id}`, { method: 'PUT', body: {
    date_of_death: '2025-11-14' } });
await api(admin, `/policies/${matured.id}/proceeds`, { method: 'PUT', body: {
  proceeds_amount: 3000000, proceeds_received_on: '2026-01-09' } });

/* --------------------- an agreement, and a call --------------------- */
/* Both are things the portal now asks the investor to DO, and a walkthrough
   that only shows figures misses the half of it that involves them. */
for (const a of ((await json(await api(admin, '/agreements'))) || []))
  if (String(a.title || '').startsWith('LCG1 Fund')) {
    if (a.status !== 'Draft') await api(admin, `/agreements/${a.id}/recall`, { method: 'POST' });
    await api(admin, `/agreements/${a.id}`, { method: 'DELETE' });
  }
const agreement = await json(await api(admin, '/agreements', { method: 'POST', body: {
  title: 'LCG1 Fund I LLC — operating agreement', fund_id: lcg1.id,
  terms: {
    llc_name: 'LCG1 Fund I LLC', manager_name: 'Poel Capital LLC', state: 'Michigan',
    effective_date: '2026-01-01', purpose: 'Acquiring and holding life settlement policies',
    manager_fee: '2', capital_call_days: '10',
    profit_split: '90/10 after return of capital',
  } } }));
await api(admin, `/agreements/${agreement.id}/signers`, { method: 'PUT', body: { signers: [
  { role: 'Manager', name: 'Poel Capital LLC' },
  { investor_id: investor.id, name: DEMO.investorName,
    email: DEMO.email, contribution: 1250000, pct: 35 },
] } });
await api(admin, `/agreements/${agreement.id}/issue`, { method: 'POST' });

for (const c of ((await json(await api(admin, '/capital-calls'))) || []))
  if (String(c.title || '').startsWith('Premiums —')) 
    await api(admin, `/capital-calls/${c.id}`, { method: 'DELETE' }).catch(() => {});
const draft = await json(await api(admin, '/capital-calls/draft?days=60'));
if (draft.items?.length) {
  const due = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
  await api(admin, '/capital-calls', { method: 'POST', body: {
    title: 'Premiums — third quarter', due_date: due, items: draft.items,
    note: 'Wiring instructions are unchanged. Call the office if anything looks unfamiliar.' } });
}

/* ------------------------------- login ------------------------------ */
const made = await api(admin, '/users', { method: 'POST', body: {
  email: DEMO.email, password: DEMO.password, full_name: 'R. Whitfield',
  role: 'investor', investor_id: investor.id } });
if (!made.ok && made.status !== 409) {
  console.error('could not create the demo login', made.status, await made.text());
  process.exit(1);
}

console.log(`Demo investor ready: ${DEMO.email} · ${BOOK.length} policies · 1 opportunity`);
