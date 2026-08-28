/* =====================================================================
   Generates a 10-policy sample set for testing.
   Fictional people; realistic structure. Designed so that importing it
   exercises the whole app: every product type, all four premium modes,
   both owner entities, a past-due premium, a policy close to lapsing,
   a term policy with no cash value, and a matured position.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'sample');
fs.mkdirSync(OUT, { recursive: true });

const TODAY = new Date('2026-08-12T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const us = (d) => { const [y, m, dd] = iso(d).split('-'); return `${m}/${dd}/${y}`; };

// nextDueOffsetMonths is relative to today, so the alerts stay meaningful
// however long after generation the file is imported.
const P = [
  { pn: 'LF-3392014', last: 'Ashford',     first: 'Margaret', dob: '02/14/1936', sex: 'F', st: 'MI',
    le: 78,  carrier: 'Lincoln Financial', type: 'UL',   plan: 'LifeGuarantee UL',
    issued: '04/18/2006', issueAge: 70, face: 5000000, fund: 'LCG2',
    prem: 88000,  mode: 'Annual',      dueOff: 7,  acq: '06/22/2019', cost: 940000,  status: 'Inforce',
    runwayMo: 41, csvPct: 1.00 },

  { pn: 'JH-7741208', last: 'Bellweather', first: 'Charles',  dob: '06/02/1938', sex: 'M', st: 'FL',
    le: 84,  carrier: 'John Hancock',     type: 'SUL',  plan: 'Survivorship UL',
    issued: '09/30/2004', issueAge: 66, face: 8000000, fund: 'LCG2',
    prem: 142000, mode: 'Annual',      dueOff: 5,  acq: '11/14/2018', cost: 1480000, status: 'Inforce',
    runwayMo: 49, csvPct: 0.97 },

  { pn: 'PL-5580933', last: 'Castellanos', first: 'Dolores',  dob: '11/09/1941', sex: 'F', st: 'AZ',
    le: 96,  carrier: 'Pacific Life',     type: 'VUL',  plan: 'Versa VUL',
    issued: '02/11/2008', issueAge: 66, face: 3000000, fund: 'LCG1',
    prem: 31500,  mode: 'Semi-Annual', dueOff: 2,  acq: '03/09/2021', cost: 512000,  status: 'Inforce',
    runwayMo: 62, csvPct: 0.94 },

  // Premium already past due -> critical alert
  { pn: 'PR-2216745', last: 'Drummond',    first: 'Walter',   dob: '04/27/1933', sex: 'M', st: 'OH',
    le: 54,  carrier: 'Prudential',       type: 'GUL',  plan: 'PruLife GUL',
    issued: '07/05/2003', issueAge: 70, face: 2500000, fund: 'LCG2',
    prem: 47000,  mode: 'Annual',      dueOff: -1.4, acq: '08/30/2016', cost: 605000, status: 'Inforce',
    runwayMo: 4.5, csvPct: 1.00 },

  // Account value barely covers the cost of insurance -> lapse-risk alert
  { pn: 'BH-9903471', last: 'Ellsworth',   first: 'Beatrice', dob: '09/18/1940', sex: 'F', st: 'MI',
    le: 90,  carrier: 'Brighthouse',      type: 'IUL',  plan: 'Shield Level IUL',
    issued: '05/22/2009', issueAge: 68, face: 1500000, fund: 'LCG1',
    prem: 3100,   mode: 'Monthly',     dueOff: 0.6, acq: '01/28/2022', cost: 268000, status: 'Inforce',
    runwayMo: 2.4, csvPct: 0.88 },

  { pn: 'MM-4408126', last: 'Fenwick',     first: 'Raymond',  dob: '01/23/1944', sex: 'M', st: 'IL',
    le: 108, carrier: 'MassMutual',       type: 'UL',   plan: 'Strategic UL',
    issued: '10/07/2010', issueAge: 66, face: 4000000, fund: 'LCG1',
    prem: 19750,  mode: 'Quarterly',   dueOff: 1.2, acq: '05/17/2023', cost: 690000, status: 'Inforce',
    runwayMo: 72, csvPct: 0.96 },

  // Whole life -> substantial cash value relative to face
  { pn: 'NY-1187602', last: 'Grantham',    first: 'Sylvia',   dob: '07/30/1935', sex: 'F', st: 'NY',
    le: 66,  carrier: 'New York Life',    type: 'WL',   plan: 'Whole Life 100',
    issued: '03/14/1998', issueAge: 62, face: 1000000, fund: 'LCG2',
    prem: 24000,  mode: 'Annual',      dueOff: 6,  acq: '09/02/2020', cost: 233000, status: 'Inforce',
    runwayMo: 114, csvPct: 0.99 },

  // Premium due inside 14 days -> warning alert
  { pn: 'AX-6624019', last: 'Hollister',   first: 'Edward',   dob: '12/05/1939', sex: 'M', st: 'MI',
    le: 72,  carrier: 'AXA / Equitable',  type: 'UL',   plan: 'Athena UL',
    issued: '08/22/2007', issueAge: 67, face: 6000000, fund: 'LCG2',
    prem: 97500,  mode: 'Annual',      dueOff: 0.33, acq: '04/11/2017', cost: 1210000, status: 'Inforce',
    runwayMo: 46, csvPct: 1.00 },

  // Term -> no cash value at all
  { pn: 'CB-8830557', last: 'Ingersoll',   first: 'Frances',  dob: '03/11/1946', sex: 'F', st: 'TX',
    le: 126, carrier: 'Corebridge / AIG', type: 'Term', plan: 'Select-a-Term 20',
    issued: '06/19/2012', issueAge: 66, face: 750000,  fund: 'LCG1',
    prem: 18900,  mode: 'Annual',      dueOff: 10, acq: '07/25/2024', cost: 96000,  status: 'Inforce',
    runwayMo: 0, csvPct: 0 },

  // Matured -> excluded from dashboard and report totals
  { pn: 'GW-3345890', last: 'Jankowski',   first: 'Stefan',   dob: '08/08/1930', sex: 'M', st: 'PA',
    le: 30,  carrier: 'Genworth',         type: 'UL',   plan: 'Cornerstone UL',
    issued: '01/30/2001', issueAge: 70, face: 2000000, fund: 'LCG2',
    prem: 61000,  mode: 'Annual',      dueOff: null, acq: '02/19/2018', cost: 430000, status: 'Matured',
    runwayMo: 5, csvPct: 1.00 },
];

/* ------------------------------ policies ----------------------------- */

const monthlyCoi = (p) => {
  if (p.type === 'Term') return 0;
  const base = p.face * 0.00042;                 // rises with attained age
  const ageNow = 2026 - Number(p.dob.slice(-4));
  return Math.round(base * (1 + (ageNow - 80) * 0.035) * 100) / 100;
};

const rows = P.map((p) => {
  const coi = monthlyCoi(p);
  const av = p.type === 'Term' ? 0 : Math.round(coi * p.runwayMo * 100) / 100;
  const csv = Math.round(av * p.csvPct * 100) / 100;
  const due = p.dueOff === null ? '' : us(addMonths(TODAY, Math.round(p.dueOff * 10) / 10 | 0));
  const dueExact = p.dueOff === null ? ''
    : us(new Date(TODAY.getTime() + p.dueOff * 30.44 * 86400000));
  return { ...p, coi, av, csv, due: dueExact || due };
});

const POLICY_HEADER = [
  'Policy Number', 'Last Name', 'First Name', 'DOB', 'Gender', 'LE Months',
  'Carrier Name', 'Product Type', 'Plan Name', 'Issue Date', 'Issue Age', 'Issue State',
  'Basic Face', 'Owner', 'Premium Required', 'Premium Mode', 'Next Premium Due',
  'Acquisition Date', 'Acquisition Cost', 'Status',
  'Values As Of', 'AV', 'CSV', 'COI', 'Death Benefit', 'Date Of Last Withdrawal',
].join(',');

const asOf = us(TODAY);
const policyLines = rows.map((p) => [
  p.pn, p.last, p.first, p.dob, p.sex, p.le,
  `"${p.carrier}"`, p.type, `"${p.plan}"`, p.issued, p.issueAge, p.st,
  p.face, p.fund, p.prem, p.mode, p.due,
  p.acq, p.cost, p.status,
  asOf, p.av.toFixed(2), p.csv.toFixed(2), p.coi.toFixed(2), p.face,
  p.type === 'Term' ? '' : us(addMonths(TODAY, -1)),
].join(','));

fs.writeFileSync(path.join(OUT, '1-policies.csv'), `${POLICY_HEADER}\n${policyLines.join('\n')}\n`);

/* --------------------- 24 months of value history -------------------- */

const vHeader = 'Policy Number,Carrier Name,As Of Date,AV,CSV,COI,Death Benefit,Loan Balance,Date Of Last Withdrawal';
const vLines = [];

rows.forEach((p) => {
  if (p.type === 'Term') {                       // term has no values to track
    for (let m = 23; m >= 0; m--) {
      const d = addMonths(TODAY, -m);
      vLines.push([p.pn, `"${p.carrier}"`, iso(d), '0.00', '0.00', '0.00', p.face, '0', ''].join(','));
    }
    return;
  }
  const stepMonths = { Monthly: 1, Quarterly: 3, 'Semi-Annual': 6, Annual: 12 }[p.mode] || 12;
  // Simulate forward — premiums in, cost of insurance out — then scale the whole
  // series so the last month lands exactly on the policy's current account value.
  // Walking backwards instead produced jagged, sometimes negative histories.
  const hist = [];
  let av = p.av * 1.6;
  for (let m = 23; m >= 0; m--) {
    const d = addMonths(TODAY, -m);
    const coi = p.coi * (1 - m * 0.009);         // COI was lower in the past
    if ((23 - m) % stepMonths === 0) av += p.prem;
    av = Math.max(coi * 1.2, av - coi);
    hist.push({ d, av, coi });
  }
  const scale = hist[23].av ? p.av / hist[23].av : 1;
  hist.forEach((h) => { h.av *= scale; });
  hist.forEach(({ d, av: a, coi }, i) => {
    const c = p.csvPct === 0 ? 0 : a * p.csvPct;
    vLines.push([
      p.pn, `"${p.carrier}"`, iso(d), a.toFixed(2), Math.max(0, c).toFixed(2),
      coi.toFixed(2), p.face, '0',
      i === 23 ? us(addMonths(TODAY, -1)) : '',
    ].join(','));
  });
});

fs.writeFileSync(path.join(OUT, '2-values.csv'), `${vHeader}\n${vLines.join('\n')}\n`);

/* ----------------------------- ledger -------------------------------- */

const tHeader = 'Policy Number,Carrier Name,Transaction Date,Transaction Type,Amount,Remarks';
const tLines = [];

rows.forEach((p) => {
  tLines.push([p.pn, `"${p.carrier}"`, p.acq, 'Acquisition Cost', p.cost, 'Policy purchase'].join(','));
  tLines.push([p.pn, `"${p.carrier}"`, p.acq, 'Fee', Math.round(p.cost * 0.02),
               'Closing and escrow costs'].join(','));

  const [am, ad, ay] = p.acq.split('/').map(Number);
  const perYear = { Monthly: 12, Quarterly: 4, 'Semi-Annual': 2, Annual: 1 }[p.mode] || 1;
  const each = p.prem;
  for (let y = ay + 1; y <= 2026; y++) {
    for (let k = 0; k < perYear; k++) {
      const mo = String(((am - 1 + k * (12 / perYear)) % 12) + 1).padStart(2, '0');
      if (y === 2026 && Number(mo) > 8) continue;
      tLines.push([p.pn, `"${p.carrier}"`, `${mo}/${String(ad).padStart(2, '0')}/${y}`,
                   'Premium Payment', each, `${p.mode} premium`].join(','));
    }
    tLines.push([p.pn, `"${p.carrier}"`, `${String(am).padStart(2, '0')}/15/${y}`,
                 'Servicing', 950, 'Annual servicing and tracking'].join(','));
  }
});

fs.writeFileSync(path.join(OUT, '3-transactions.csv'), `${tHeader}\n${tLines.join('\n')}\n`);

/* ------------------------------ summary ------------------------------ */

const totalFace = rows.reduce((s, p) => s + p.face, 0);
const inforceFace = rows.filter((p) => p.status === 'Inforce').reduce((s, p) => s + p.face, 0);
const totalCost = rows.reduce((s, p) => s + p.cost, 0);

console.log(`Wrote sample files to ${OUT}`);
console.log(`  1-policies.csv      ${rows.length} policies`);
console.log(`  2-values.csv        ${vLines.length} snapshots (24 months each)`);
console.log(`  3-transactions.csv  ${tLines.length} ledger entries`);
console.log(`\n  total face      $${totalFace.toLocaleString()}`);
console.log(`  in force        $${inforceFace.toLocaleString()} (9 policies; 1 matured)`);
console.log(`  acquisition     $${totalCost.toLocaleString()}`);
console.log('\n  expected alerts:');
console.log('   critical  Drummond   premium past due');
console.log('   critical  Ellsworth  ~2.4 months of coverage runway');
console.log('   warning   Hollister  premium due within 14 days');
