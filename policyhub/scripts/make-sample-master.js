/* =====================================================================
   Ten sample policies, complete, in one file.

   Everything a policy carries is here: the contract, the life insured
   (two of them where the product is survivorship), the purchase and
   every premium since, a carrier statement every six months, and the
   premiums still to come from the illustration.

   Two columns are deliberately left blank. Owner entity is one, because
   who holds a policy is a decision rather than a fact about it, and
   investor allocations are the other, for the same reason and because
   they are percentages of somebody's money. Both are set in the
   application after the import, which is where a person can see what
   they are choosing.

   The book is built to exercise the whole application rather than to
   look tidy: a premium already overdue, one policy close to lapsing, a
   term policy with no cash value, a survivorship contract, one matured
   position with the cheque received and another still outstanding.

       node scripts/make-sample-master.js
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'sample');
fs.mkdirSync(OUT, { recursive: true });

const TODAY = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const us = (d) => { const [y, m, dd] = iso(d).split('-'); return `${m}/${dd}/${y}`; };
const shift = (base, months = 0, days = 0) => {
  const d = new Date(base);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const at = (months, days = 0) => shift(TODAY, months, days);
const money = (n) => Number(n).toFixed(2);

/* Fictional people; realistic structure. `dueOff` is months from today, so
   the alerts stay meaningful however long after generation this is loaded. */
const BOOK = [
  { pn: 'LF-3392014', carrier: 'Lincoln Financial', type: 'UL', plan: 'LifeGuarantee UL',
    last: 'Ashford', first: 'Margaret', dob: '02/14/1936', sex: 'F', st: 'MI', le: 78,
    leProv: 'ITM21st', issued: '04/18/2006', issueAge: 70, face: 5000000,
    prem: 88000, mode: 'Annual', dueOff: 7, acqOff: -74, cost: 940000, status: 'Inforce',
    runway: 31, csvPct: 1.00, coiMo: 7900, drift: -0.028, growth: 0.045 },

  { pn: 'JH-7741208', carrier: 'John Hancock', type: 'SUL', plan: 'Survivorship UL',
    last: 'Bellweather', first: 'Charles', dob: '06/02/1938', sex: 'M', st: 'FL', le: 84,
    leProv: 'AVS', issued: '09/30/2004', issueAge: 66, face: 8000000,
    prem: 142000, mode: 'Annual', dueOff: 5, acqOff: -92, cost: 1480000, status: 'Inforce',
    runway: 26, csvPct: 0.97, coiMo: 12600, drift: -0.031, growth: 0.040,
    second: { last: 'Bellweather', first: 'Marguerite', dob: '11/18/1941', sex: 'F',
              st: 'FL', le: 96, role: 'Survivorship' } },

  { pn: 'PL-5580933', carrier: 'Pacific Life', type: 'VUL', plan: 'Versa VUL',
    last: 'Castellanos', first: 'Dolores', dob: '11/09/1941', sex: 'F', st: 'AZ', le: 96,
    leProv: 'Predictive', issued: '02/11/2008', issueAge: 66, face: 3000000,
    prem: 31500, mode: 'Semi-Annual', dueOff: 2, acqOff: -63, cost: 512000, status: 'Inforce',
    runway: 17, csvPct: 0.94, coiMo: 3100, drift: -0.021, growth: 0.050 },

  // Premium already past due — this is the one that should be shouting.
  { pn: 'PR-2214887', carrier: 'Prudential', type: 'GUL', plan: 'PruLife Universal',
    last: 'Duchamp', first: 'Alain', dob: '07/22/1937', sex: 'M', st: 'NY', le: 66,
    leProv: 'ITM21st', issued: '11/05/2003', issueAge: 66, face: 2500000,
    prem: 54000, mode: 'Annual', dueOff: 0, dueDays: -22, acqOff: -86, cost: 445000,
    status: 'Grace', runway: 1.0, csvPct: 0.88, coiMo: 5200, drift: -0.055, growth: 0.038 },

  // Thin on account value: the coverage-runway warning should fire.
  { pn: 'MM-9903412', carrier: 'MassMutual', type: 'UL', plan: 'Foundation UL',
    last: 'Ellery', first: 'Frances', dob: '03/30/1939', sex: 'F', st: 'TX', le: 72,
    leProv: 'AVS', issued: '06/14/2007', issueAge: 68, face: 1500000,
    prem: 39000, mode: 'Quarterly', dueOff: 1, acqOff: -47, cost: 286000, status: 'Inforce',
    runway: 1.6, csvPct: 0.91, coiMo: 3400, drift: -0.070, growth: 0.041 },

  { pn: 'AX-1180567', carrier: 'AXA / Equitable', type: 'IUL', plan: 'Athena IUL',
    last: 'Fontaine', first: 'Gerald', dob: '01/17/1943', sex: 'M', st: 'CA', le: 102,
    leProv: 'Predictive', issued: '08/22/2010', issueAge: 67, face: 4000000,
    prem: 62000, mode: 'Annual', dueOff: 9, acqOff: -38, cost: 690000, status: 'Inforce',
    runway: 14, csvPct: 0.96, coiMo: 5600, drift: -0.018, growth: 0.048 },

  // Term: no cash value at all, which the value rows must reflect honestly.
  { pn: 'BH-4407731', carrier: 'Brighthouse', type: 'Term', plan: 'SimplySelect Term',
    last: 'Grimaldi', first: 'Rosa', dob: '05/08/1945', sex: 'F', st: 'NJ', le: 90,
    leProv: 'ITM21st', issued: '03/02/2012', issueAge: 66, face: 1000000,
    prem: 24000, mode: 'Annual', dueOff: 4, acqOff: -29, cost: 148000, status: 'Inforce',
    runway: 0, csvPct: 0, coiMo: 0, drift: 0, growth: 0 },

  { pn: 'GW-6628190', carrier: 'Genworth', type: 'UL', plan: 'Cornerstone UL',
    last: 'Halvorsen', first: 'Nils', dob: '09/12/1934', sex: 'M', st: 'WA', le: 60,
    leProv: 'AVS', issued: '01/28/2002', issueAge: 67, face: 6000000,
    prem: 118000, mode: 'Annual', dueOff: 11, acqOff: -101, cost: 1310000, status: 'Inforce',
    runway: 22, csvPct: 0.93, coiMo: 11000, drift: -0.036, growth: 0.043 },

  // Matured, cheque received: the realized side of the book.
  { pn: 'NW-8815602', carrier: 'Nationwide', type: 'UL', plan: 'YourLife UL',
    last: 'Iverson', first: 'Beatrice', dob: '12/03/1932', sex: 'F', st: 'IL', le: 48,
    leProv: 'ITM21st', issued: '05/19/2001', issueAge: 68, face: 2000000,
    prem: 46000, mode: 'Annual', dueOff: null, acqOff: -79, cost: 402000, status: 'Matured',
    runway: 9, csvPct: 0.92, coiMo: 4300, drift: -0.040, growth: 0.042,
    diedOff: -8, proceeds: 2000000, paidOff: -6 },

  // Matured, claim outstanding: the same thing before the money arrives.
  { pn: 'TR-3320944', carrier: 'Transamerica', type: 'UL', plan: 'TransACE',
    last: 'Jorgensen', first: 'Peter', dob: '08/25/1935', sex: 'M', st: 'OH', le: 54,
    leProv: 'Predictive', issued: '10/07/2005', issueAge: 70, face: 3500000,
    prem: 71000, mode: 'Annual', dueOff: null, acqOff: -56, cost: 615000, status: 'Matured',
    runway: 11, csvPct: 0.90, coiMo: 6800, drift: -0.043, growth: 0.044,
    diedOff: -3 },
];

const COLUMNS = [
  'Record Type', 'Policy Number', 'Carrier Name', 'Last Name', 'First Name', 'DOB',
  'Gender', 'State', 'LE Months', 'LE Provider', 'Date Of Death', 'Role', 'Product Type',
  'Plan Name', 'Issue Date', 'Issue Age', 'Basic Face', 'Owner', 'Premium Required',
  'Premium Mode', 'Next Premium Due', 'Acquisition Date', 'Acquisition Cost', 'Status',
  'As Of Date', 'AV', 'CSV', 'COI', 'Death Benefit', 'Loan Balance',
  'Transaction Date', 'Transaction Type', 'Amount', 'Remarks',
  'Due Date', 'Estimated Amount', 'Note',
  'Proceeds Amount', 'Proceeds Received On',
  // Left blank on purpose: paste the case's Dropbox folder here and every
  // investor who owns a piece of the policy gets the same link.
  'Case Files Link',
];

const rows = [];
const add = (o) => rows.push(COLUMNS.map((c) => (o[c] === undefined ? '' : String(o[c]))));

for (const p of BOOK) {
  const acquired = at(p.acqOff);
  const nextDue = p.dueOff === null ? '' : us(at(p.dueOff, p.dueDays || 0));

  add({
    'Record Type': 'Policy', 'Policy Number': p.pn, 'Carrier Name': p.carrier,
    'Last Name': p.last, 'First Name': p.first, DOB: p.dob, Gender: p.sex, State: p.st,
    'LE Months': p.le, 'LE Provider': p.leProv, 'Product Type': p.type, 'Plan Name': p.plan,
    'Issue Date': p.issued, 'Issue Age': p.issueAge, 'Basic Face': p.face,
    Owner: '',                                   // you choose the entity
    'Premium Required': p.prem, 'Premium Mode': p.mode, 'Next Premium Due': nextDue,
    'Acquisition Date': us(acquired), 'Acquisition Cost': p.cost,
    Status: p.status === 'Matured' ? 'Inforce' : p.status,  // the death date matures it
    /* The maturity cheque belongs to the contract, not the ledger: it is the
       one inflow that closes the position rather than funding it. */
    'Proceeds Amount': p.proceeds ? money(p.proceeds) : '',
    'Proceeds Received On': p.proceeds ? us(at(p.paidOff)) : '',
  });

  if (p.second) {
    add({
      'Record Type': 'Life', 'Policy Number': p.pn, 'Carrier Name': p.carrier,
      'Last Name': p.second.last, 'First Name': p.second.first, DOB: p.second.dob,
      Gender: p.second.sex, State: p.second.st, 'LE Months': p.second.le, Role: p.second.role,
    });
  }

  /* A death date is what moves a policy to Maturities, so it is set on the
     person rather than typed as a status on the contract. */
  if (p.diedOff !== undefined) {
    add({
      'Record Type': 'Insured', 'Last Name': p.last, 'First Name': p.first, DOB: p.dob,
      'LE Months': p.le, 'Date Of Death': us(at(p.diedOff)),
      Remarks: 'Death certificate received',
    });
  }

  // The purchase, then a premium every year since, rising as COI does.
  add({
    'Record Type': 'Transaction', 'Policy Number': p.pn, 'Carrier Name': p.carrier,
    'Transaction Date': us(acquired), 'Transaction Type': 'Acquisition Cost',
    Amount: money(p.cost), Remarks: 'Purchase price',
  });
  const yearsHeld = Math.max(0, Math.floor(-p.acqOff / 12));
  const stop = p.diedOff !== undefined ? Math.floor((p.acqOff * -1 + p.diedOff) / 12) : yearsHeld;
  for (let y = 0; y <= Math.max(0, stop); y++) {
    add({
      'Record Type': 'Transaction', 'Policy Number': p.pn, 'Carrier Name': p.carrier,
      'Transaction Date': us(at(p.acqOff + 12 * y)), 'Transaction Type': 'Premium Payment',
      Amount: money(p.prem * (1 + p.growth) ** y), Remarks: `Policy year ${y + 1}`,
    });
  }
  add({
    'Record Type': 'Transaction', 'Policy Number': p.pn, 'Carrier Name': p.carrier,
    'Transaction Date': us(at(p.acqOff, 3)), 'Transaction Type': 'Fee',
    Amount: money(Math.round(p.cost * 0.012)), Remarks: 'Closing and escrow',
  });
  /* A carrier statement every six months since purchase. Account value drifts
     down as cost of insurance eats it, which is what makes the coverage-runway
     warning mean something. */
  const snapshots = Math.min(14, Math.max(2, Math.floor(-p.acqOff / 6)));
  /* Work backwards from where the policy should stand today. `runway` is the
     months of cost of insurance the account value still covers, which is the
     number the servicing alerts actually key on — so the book is written to
     produce a stated position rather than whatever a decay curve happens to
     land on. A term policy has no account value and nothing deducted from
     one, so it has no runway either. */
  const coiToday = p.coiMo * 1.02 ** snapshots;
  const avToday = p.coiMo ? p.runway * coiToday : 0;
  for (let n = snapshots; n >= 0; n--) {
    const when = at(-6 * n);
    if (p.diedOff !== undefined && -6 * n > p.diedOff) continue;
    const decay = (1 + p.drift) ** (snapshots - n);
    const av = avToday ? Math.round(avToday / (1 + p.drift) ** snapshots * decay) : 0;
    add({
      'Record Type': 'Value', 'Policy Number': p.pn, 'Carrier Name': p.carrier,
      'As Of Date': us(when), AV: money(av), CSV: money(Math.round(av * p.csvPct)),
      COI: money(Math.round(p.coiMo * (1 + 0.02) ** (snapshots - n))),
      'Death Benefit': p.face, 'Loan Balance': '0.00',
    });
  }

  // What the illustration says is still to come.
  if (p.dueOff !== null) {
    for (let y = 1; y <= 5; y++) {
      add({
        'Record Type': 'Premium', 'Policy Number': p.pn, 'Carrier Name': p.carrier,
        'Due Date': us(at((p.dueOff || 0) + 12 * y, p.dueDays || 0)),
        'Estimated Amount': money(p.prem * (1 + p.growth) ** y),
        Note: y === 1 ? 'Per the current carrier illustration' : '',
      });
    }
  }
}

const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = [COLUMNS, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
const file = path.join(OUT, 'sample-portfolio.csv');
fs.writeFileSync(file, csv);

const counts = rows.reduce((a, r) => { a[r[0]] = (a[r[0]] || 0) + 1; return a; }, {});
console.log(`Wrote ${file}`);
console.log(`${rows.length} rows: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
