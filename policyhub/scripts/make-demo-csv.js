/* Generates fictional demo CSVs for testing/screenshots.
   Not shipped as data — the production database starts empty. */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'demo');
fs.mkdirSync(OUT, { recursive: true });

const POLICIES = [
  ['LX-4471902', 'Abrams, Harold',      '03/14/1938', 'Lincoln Financial',  '06/12/2007', 5000000,  'LCG2', 62000, 'Annual',  '06/12/2027', '03/19/2021', 812000],
  ['JH-2298317', 'Bergstrom, Eleanor',  '11/02/1941', 'John Hancock',       '02/18/2010', 2500000,  'LCG2', 41500, 'Annual',  '02/18/2027', '07/22/2019', 405000],
  ['MM-7710455', 'Castellano, Vincent', '07/06/1936', 'MassMutual',         '11/01/2006', 10000000, 'LCG2', 148000,'Annual',  '11/01/2026', '01/14/2020', 2210000],
  ['AX-5560218', 'Delgado, Marta',      '04/17/1944', 'AXA / Equitable',    '10/15/2008', 3000000,  'LCG2', 55000, 'Annual',  '09/30/2026', '05/03/2022', 488000],
  ['GW-1029384', 'Ellison, Robert',     '04/22/1937', 'Genworth',           '10/21/2009', 1000000,  'LCG2', 10000, 'Annual',  '10/21/2026', '03/19/2021', 250300],
  ['BH-8834120', 'Fairbanks, Howard',   '07/26/1941', 'Brighthouse',        '03/07/2005', 5000000,  'LCG3', 96000, 'Annual',  '08/25/2026', '11/09/2018', 940000],
  ['PL-3390871', 'Grunwald, Lyle',      '08/22/1932', 'Pacific Life',       '01/18/2005', 2000000,  'LCG3', 70100, 'Annual',  '08/30/2026', '02/28/2021', 331000],
  ['PR-6612093', 'Hollis, William',     '09/24/1941', 'Prudential',         '06/24/2011', 2000000,  'LCG3', 38400, 'Annual',  '12/15/2026', '06/01/2023', 402500],
  ['HL-9982017', 'Ingram, Ann',         '04/27/1935', 'Hartford Life',      '04/26/2003', 1225000,  'LCG2', 13920, 'Annual',  '04/26/2027', '09/12/2017', 198000],
  ['CB-4408822', 'Janowitz, Judith',    '12/20/1927', 'Corebridge / AIG',   '02/28/2011', 750000,   'LCG2', 21400, 'Annual',  '09/05/2026', '04/18/2016', 121000],
  ['WC-2201773', 'Kessler, Moe',        '03/22/1930', 'West Coast Life',    '01/26/2004', 1250000,  'LCG3', 15000, 'Annual',  '01/26/2027', '08/30/2019', 214000],
  ['AO-7745510', 'Lindqvist, Robert',   '08/05/1946', 'Augustar / Ohio Nat','02/28/2010', 750000,   'LCG2', 18600, 'Annual',  '02/28/2027', '10/07/2021', 143000],
];

/* -- policies.csv (with the current month's values, like a CRM export) -- */
const polHeader =
  'Policy Number,Primary Insured,DOB,Carrier Name,Issue Date,Basic Face,Owner,Premium Required,Premium Mode,Next Premium Due,Acquisition Date,Acquisition Cost,Status\n';
fs.writeFileSync(
  path.join(OUT, 'policies.csv'),
  polHeader + POLICIES.map((p) =>
    `${p[0]},"${p[1]}",${p[2]},"${p[3]}",${p[4]},${p[5]},${p[6]},${p[7]},${p[8]},${p[9]},${p[10]},${p[11]},Inforce`
  ).join('\n') + '\n'
);

/* ---------------- values.csv — 18 months of snapshots ---------------- */
const rows = ['Policy Number,As Of Date,AV,CSV,COI,Death Benefit,Date Of Last Withdrawal'];
const END = new Date('2026-08-01T00:00:00');

POLICIES.forEach((p, idx) => {
  const face = p[5];
  // Starting account value scaled to face, drifting down as COI is deducted.
  let av = face * (0.006 + (idx % 5) * 0.0022);
  const baseCoi = face * 0.00035 * (0.8 + ((idx % 4) * 0.15));
  for (let m = 17; m >= 0; m--) {
    const d = new Date(END);
    d.setMonth(d.getMonth() - m);
    const asOf = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const coi = baseCoi * (1 + (17 - m) * 0.012);          // COI creeps up with age
    av = Math.max(0, av - coi + (m % 12 === 0 ? p[7] : 0)); // annual premium paid in
    const surrenderCharge = idx % 4 === 1 ? Math.min(av, face * 0.0009) : 0;
    rows.push([
      p[0], asOf, av.toFixed(2), Math.max(0, av - surrenderCharge).toFixed(2),
      coi.toFixed(2), face, m === 0 ? '2026-07-21' : '',
    ].join(','));
  }
});
fs.writeFileSync(path.join(OUT, 'values.csv'), rows.join('\n') + '\n');

/* ------------------- transactions.csv — premium ledger ---------------- */
const txns = ['Policy Number,Transaction Date,Transaction Type,Amount,Remarks'];
POLICIES.forEach((p) => {
  const acqDate = p[10];
  txns.push(`${p[0]},${acqDate},Acquisition Cost,${p[11]},Policy purchase`);
  const [mm, , yyyy] = acqDate.split('/');
  for (let y = Number(yyyy) + 1; y <= 2026; y++) {
    txns.push(`${p[0]},${mm}/01/${y},Premium Payment,${p[7]},Annual premium`);
  }
  txns.push(`${p[0]},${mm}/15/2024,Servicing,1250,Annual servicing fee`);
});
fs.writeFileSync(path.join(OUT, 'transactions.csv'), txns.join('\n') + '\n');

console.log(`Wrote demo CSVs to ${OUT}`);
console.log(`  policies.csv      ${POLICIES.length} rows`);
console.log(`  values.csv        ${rows.length - 1} rows`);
console.log(`  transactions.csv  ${txns.length - 1} rows`);
