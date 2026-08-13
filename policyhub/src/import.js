import { parse } from 'csv-parse/sync';
import { q, audit } from './db.js';
import { resolveInsured, resolveFund, date, num, int, str } from './api.js';

/* ------------------------------------------------------------------ *
 * Header normalisation & aliases
 * ------------------------------------------------------------------ */

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES = {
  // identity
  policynumber: 'policy_number', policyno: 'policy_number', policy: 'policy_number',
  policyd: 'policy_number', policyid: 'policy_number', contractnumber: 'policy_number',
  uniquecaseid: 'unique_case_id', caseid: 'unique_case_id',

  // insured
  primaryinsured: 'insured_name', insured: 'insured_name', insuredname: 'insured_name',
  lastnamefirstname: 'insured_name', namelastfirst: 'insured_name',
  firstname: 'insured_first_name', lastname: 'insured_last_name',
  dob: 'dob', dateofbirth: 'dob', birthdate: 'dob',
  gender: 'gender', sex: 'gender', lemonths: 'le_months', lifeexpectancy: 'le_months',

  // policy
  carriername: 'carrier_name', carrier: 'carrier_name', insurancecompany: 'carrier_name',
  planname: 'plan_name', product: 'product_type', producttype: 'product_type',
  plantype: 'product_type',
  issuedate: 'issue_date', issueage: 'issue_age', issuestate: 'issue_state', state: 'issue_state',
  basicface: 'face_amount', face: 'face_amount', faceamount: 'face_amount',
  facevalue: 'face_amount', netdeathbenefit: 'face_amount',
  owner: 'owner_raw', ownername: 'owner_raw', fund: 'fund_code', fundcode: 'fund_code',
  beneficiary: 'beneficiary',
  status: 'status', statusdate: 'status_date', policystatus: 'status',
  premiumrequired: 'premium_required', premium: 'premium_required',
  annualpremium: 'premium_required', plannedpremium: 'premium_required',
  premiummode: 'premium_mode', mode: 'premium_mode', paymentmode: 'premium_mode',
  nextpremiumdue: 'next_premium_due', nextduedate: 'next_premium_due', duedate: 'next_premium_due',
  graceperioddays: 'grace_period_days',
  acquisitiondate: 'acquisition_date', purchasedate: 'acquisition_date',
  acquisitioncost: 'acquisition_cost', purchaseprice: 'acquisition_cost',
  notes: 'notes', remarks: 'remarks',

  // values
  av: 'account_value', accountvalue: 'account_value', accumulationvalue: 'account_value',
  csv: 'cash_surrender_value', cashsurrendervalue: 'cash_surrender_value',
  cashvalue: 'cash_surrender_value', surrendervalue: 'cash_surrender_value',
  coi: 'cost_of_insurance', costofinsurance: 'cost_of_insurance',
  monthlycoi: 'cost_of_insurance',
  deathbenefit: 'death_benefit', currentdeathbenefit: 'death_benefit', db: 'death_benefit',
  ppd: 'premium_paid_to_date', premiumpaidtodate: 'premium_paid_to_date',
  monthlydeduction: 'monthly_deduction', loanbalance: 'loan_balance',
  dateoflastwithdrawal: 'date_of_last_withdrawal', lastwithdrawal: 'date_of_last_withdrawal',
  valuesasof: 'as_of_date', asof: 'as_of_date', asofdate: 'as_of_date',
  valuationdate: 'as_of_date',

  // transactions
  transactiondate: 'txn_date', date: 'txn_date',
  transactiontype: 'txn_type', type: 'txn_type',
  amount: 'amount', transactionamount: 'amount',
};

function mapRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = norm(k);
    const key = ALIASES[n] || n;
    if (v !== '' && v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

/** Well beyond any real file, and low enough to bound one request's memory. */
export const MAX_ROWS = 25000;

export function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
    to: MAX_ROWS + 1,          // stop the parser rather than discovering the size after
  });
  if (records.length > MAX_ROWS) {
    const e = new Error(
      `That file has more than ${MAX_ROWS.toLocaleString('en-US')} rows. Split it and import in parts.`
    );
    e.status = 400;
    throw e;
  }
  return records.map(mapRow);
}

/* ------------------------------------------------------------------ *
 * Owner column heuristic
 *   SmartOffice's "Owner" column mixes fund codes (LCG2) with carrier
 *   account numbers (8008821292) and free text. Short alphabetic values
 *   become the fund; anything else is kept as the owner account.
 * ------------------------------------------------------------------ */
function splitOwner(row) {
  const raw = str(row.owner_raw);
  if (!raw) return;
  if (/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(raw) && /[A-Za-z]/.test(raw)) {
    row.fund_code = row.fund_code || raw;
  }
  row.owner_account = raw;
}

/* ------------------------------------------------------------------ *
 * Importers
 * ------------------------------------------------------------------ */

const VALUE_KEYS = [
  'account_value', 'cash_surrender_value', 'cost_of_insurance', 'death_benefit',
  'premium_paid_to_date', 'monthly_deduction', 'loan_balance', 'date_of_last_withdrawal',
];

async function findPolicyId(row, allowedFunds = null) {
  const pn = str(row.policy_number);
  if (!pn) return null;
  const carrier = str(row.carrier_name);
  const { rows } = await q(
    `SELECT id FROM policies
      WHERE lower(policy_number) = lower($1)
        AND ($2 = '' OR lower(carrier_name) = lower($2))
        AND ($3::int[] IS NULL OR fund_id = ANY($3))
      ORDER BY id LIMIT 1`,
    [pn, carrier, allowedFunds]
  );
  return rows[0]?.id || null;
}

/**
 * Policy import. Also writes a value snapshot when the row carries
 * AV/CSV/COI columns — this is what makes a monthly CRM export double as
 * the monthly value update.
 */
async function importPolicies(rows, opts, user) {
  const result = { created: 0, updated: 0, values: 0, errors: [] };
  const defaultAsOf = date(opts.asOfDate) || new Date().toISOString().slice(0, 10);
  const allowedFunds = opts.fundScope || null;   // null = whole book

  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    try {
      splitOwner(row);
      if (!str(row.policy_number)) {
        result.errors.push({ line, message: 'Missing policy number' });
        continue;
      }

      const insuredId = await resolveInsured(row);
      const fundId = await resolveFund(row);
      const existingId = await findPolicyId(row);

      // A portfolio manager may only import into their own entities, and may
      // not overwrite a policy that currently belongs to someone else's.
      if (allowedFunds) {
        if (!allowedFunds.includes(fundId)) {
          result.errors.push({ line,
            message: `Owner "${str(row.owner_account) || str(row.fund_code) || 'blank'}" is not one of your entities` });
          continue;
        }
        if (existingId) {
          const { rows: cur } = await q('SELECT fund_id FROM policies WHERE id = $1', [existingId]);
          if (!cur[0] || !allowedFunds.includes(cur[0].fund_id)) {
            result.errors.push({ line, message: 'That policy belongs to another entity' });
            continue;
          }
        }
      }

      const cols = {
        policy_number: str(row.policy_number),
        unique_case_id: str(row.unique_case_id),
        insured_id: insuredId,
        fund_id: fundId,
        carrier_name: str(row.carrier_name),
        plan_name: str(row.plan_name),
        product_type: str(row.product_type),
        issue_date: date(row.issue_date),
        issue_age: int(row.issue_age),
        issue_state: str(row.issue_state),
        face_amount: num(row.face_amount),
        owner_account: str(row.owner_account),
        beneficiary: str(row.beneficiary),
        status: str(row.status) || 'Inforce',
        status_date: date(row.status_date),
        premium_required: num(row.premium_required),
        premium_mode: str(row.premium_mode) || 'Annual',
        next_premium_due: date(row.next_premium_due),
        grace_period_days: int(row.grace_period_days) ?? 61,
        acquisition_date: date(row.acquisition_date),
        acquisition_cost: num(row.acquisition_cost),
        notes: str(row.notes),
      };

      let policyId;
      if (existingId) {
        // Only overwrite columns the CSV actually supplied.
        const sets = [], vals = [];
        let n = 1;
        for (const [k, v] of Object.entries(cols)) {
          const supplied =
            v !== null && v !== '' &&
            !(k === 'status' && !row.status) &&
            !(k === 'premium_mode' && !row.premium_mode) &&
            !(k === 'grace_period_days' && !row.grace_period_days);
          if (supplied) { sets.push(`${k} = $${n++}`); vals.push(v); }
        }
        if (sets.length) {
          await q(
            `UPDATE policies SET ${sets.join(',')}, updated_at = now() WHERE id = $${n}`,
            [...vals, existingId]
          );
        }
        policyId = existingId;
        result.updated++;
      } else {
        const keys = Object.keys(cols);
        const ph = keys.map((_, n) => `$${n + 1}`).join(',');
        const ins = await q(
          `INSERT INTO policies (${keys.join(',')}) VALUES (${ph}) RETURNING id`,
          Object.values(cols)
        );
        policyId = ins.rows[0].id;
        result.created++;
      }

      // Snapshot any value columns present on the row.
      const hasValues = VALUE_KEYS.some((k) => row[k] !== undefined);
      if (hasValues) {
        const asOf = date(row.as_of_date) || defaultAsOf;
        await q(
          `INSERT INTO policy_values
             (policy_id, as_of_date, account_value, cash_surrender_value, cost_of_insurance,
              death_benefit, premium_paid_to_date, monthly_deduction, loan_balance,
              date_of_last_withdrawal, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'csv')
           ON CONFLICT (policy_id, as_of_date) DO UPDATE SET
             account_value = COALESCE(EXCLUDED.account_value, policy_values.account_value),
             cash_surrender_value = COALESCE(EXCLUDED.cash_surrender_value, policy_values.cash_surrender_value),
             cost_of_insurance = COALESCE(EXCLUDED.cost_of_insurance, policy_values.cost_of_insurance),
             death_benefit = COALESCE(EXCLUDED.death_benefit, policy_values.death_benefit),
             premium_paid_to_date = COALESCE(EXCLUDED.premium_paid_to_date, policy_values.premium_paid_to_date),
             monthly_deduction = COALESCE(EXCLUDED.monthly_deduction, policy_values.monthly_deduction),
             loan_balance = COALESCE(EXCLUDED.loan_balance, policy_values.loan_balance),
             date_of_last_withdrawal = COALESCE(EXCLUDED.date_of_last_withdrawal, policy_values.date_of_last_withdrawal)`,
          [policyId, asOf, num(row.account_value), num(row.cash_surrender_value),
           num(row.cost_of_insurance), num(row.death_benefit), num(row.premium_paid_to_date),
           num(row.monthly_deduction), num(row.loan_balance), date(row.date_of_last_withdrawal)]
        );
        result.values++;
      }

      // An acquisition cost on the policy row seeds the ledger once.
      const acq = num(row.acquisition_cost);
      if (acq && !existingId) {
        await q(
          `INSERT INTO transactions (policy_id, txn_date, txn_type, amount, remarks, source)
           VALUES ($1,$2,'Acquisition Cost',$3,'Imported with policy','csv')`,
          [policyId, date(row.acquisition_date) || defaultAsOf, acq]
        );
      }
    } catch (e) {
      result.errors.push({ line, message: e.message });
    }
  }
  return result;
}

async function importValues(rows, opts) {
  const result = { created: 0, updated: 0, values: 0, errors: [] };
  const defaultAsOf = date(opts.asOfDate);
  const allowedFunds = opts.fundScope || null;

  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    try {
      const policyId = await findPolicyId(row, allowedFunds);
      if (!policyId) {
        result.errors.push({ line, message: `No policy matches "${str(row.policy_number)}"` });
        continue;
      }
      const asOf = date(row.as_of_date) || defaultAsOf;
      if (!asOf) {
        result.errors.push({ line, message: 'Missing "as of" date (add a column or set one for the whole file)' });
        continue;
      }
      await q(
        `INSERT INTO policy_values
           (policy_id, as_of_date, account_value, cash_surrender_value, cost_of_insurance,
            death_benefit, premium_paid_to_date, monthly_deduction, loan_balance,
            date_of_last_withdrawal, notes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'csv')
         ON CONFLICT (policy_id, as_of_date) DO UPDATE SET
           account_value = COALESCE(EXCLUDED.account_value, policy_values.account_value),
           cash_surrender_value = COALESCE(EXCLUDED.cash_surrender_value, policy_values.cash_surrender_value),
           cost_of_insurance = COALESCE(EXCLUDED.cost_of_insurance, policy_values.cost_of_insurance),
           death_benefit = COALESCE(EXCLUDED.death_benefit, policy_values.death_benefit),
           premium_paid_to_date = COALESCE(EXCLUDED.premium_paid_to_date, policy_values.premium_paid_to_date),
           monthly_deduction = COALESCE(EXCLUDED.monthly_deduction, policy_values.monthly_deduction),
           loan_balance = COALESCE(EXCLUDED.loan_balance, policy_values.loan_balance),
           date_of_last_withdrawal = COALESCE(EXCLUDED.date_of_last_withdrawal, policy_values.date_of_last_withdrawal)`,
        [policyId, asOf, num(row.account_value), num(row.cash_surrender_value),
         num(row.cost_of_insurance), num(row.death_benefit), num(row.premium_paid_to_date),
         num(row.monthly_deduction), num(row.loan_balance), date(row.date_of_last_withdrawal),
         str(row.notes)]
      );
      result.values++;
    } catch (e) {
      result.errors.push({ line, message: e.message });
    }
  }
  return result;
}

const TXN_TYPES = ['Acquisition Cost', 'Premium Payment', 'Withdrawal', 'Loan',
                   'Fee', 'Commission', 'Servicing', 'Other'];

async function importTransactions(rows, opts = {}) {
  const result = { created: 0, updated: 0, values: 0, errors: [] };
  const allowedFunds = opts.fundScope || null;
  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    try {
      const policyId = await findPolicyId(row, allowedFunds);
      if (!policyId) {
        result.errors.push({ line, message: `No policy matches "${str(row.policy_number)}"` });
        continue;
      }
      const d = date(row.txn_date);
      if (!d) { result.errors.push({ line, message: 'Missing or unreadable transaction date' }); continue; }

      const rawType = str(row.txn_type);
      const type = TXN_TYPES.find((t) => norm(t) === norm(rawType)) || (rawType ? 'Other' : 'Premium Payment');
      const amount = num(row.amount);
      if (amount === null) { result.errors.push({ line, message: 'Missing or unreadable amount' }); continue; }

      await q(
        `INSERT INTO transactions (policy_id, txn_date, txn_type, amount, remarks, source)
         VALUES ($1,$2,$3,$4,$5,'csv')`,
        [policyId, d, type, amount, str(row.remarks) || (rawType && type === 'Other' ? rawType : '')]
      );
      result.created++;
    } catch (e) {
      result.errors.push({ line, message: e.message });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

export function previewCsv(buffer, type) {
  const rows = parseCsv(buffer);
  const recognised = new Set();
  const unrecognised = new Set();
  const known = new Set([
    ...Object.values(ALIASES),
    'policy_number', 'insured_name', 'carrier_name', 'as_of_date',
  ]);
  for (const r of rows.slice(0, 50)) {
    for (const k of Object.keys(r)) (known.has(k) ? recognised : unrecognised).add(k);
  }
  return {
    type,
    rowCount: rows.length,
    recognised: [...recognised],
    unrecognised: [...unrecognised],
    sample: rows.slice(0, 8),
  };
}

export async function runImport(buffer, type, opts, user) {
  const rows = parseCsv(buffer);
  if (!rows.length) return { created: 0, updated: 0, values: 0, errors: [{ line: 1, message: 'File is empty' }] };

  let result;
  if (type === 'values') result = await importValues(rows, opts);
  else if (type === 'transactions') result = await importTransactions(rows);
  else result = await importPolicies(rows, opts, user);

  result.rowCount = rows.length;
  await audit(user?.uid, 'import', null, 'import',
    `${type}: ${result.created} created, ${result.updated} updated, ${result.values} value rows, ${result.errors.length} errors`);
  return result;
}

export const TEMPLATES = {
  policies:
    'Policy Number,Primary Insured,DOB,Carrier Name,Issue Date,Basic Face,Owner,Premium Required,Premium Mode,Next Premium Due,Acquisition Date,Acquisition Cost,Status,Values As Of,AV,CSV,COI,Death Benefit,Date Of Last Withdrawal\n' +
    '2975464,"Setliff, Reuben",04/22/1937,Genworth Call Pay,10/21/2009,1000000,8883255433,10000,Annual,10/21/2026,03/19/2021,250300,Inforce,08/11/2026,3173.60,3173.60,4068.30,07/21/2026\n',
  values:
    'Policy Number,Carrier Name,As Of Date,AV,CSV,COI,Death Benefit,Loan Balance,Date Of Last Withdrawal\n' +
    '2975464,Genworth Call Pay,09/30/2026,3050.00,3050.00,4100.00,1000000,0,07/21/2026\n',
  transactions:
    'Policy Number,Carrier Name,Transaction Date,Transaction Type,Amount,Remarks\n' +
    '2975464,Genworth Call Pay,03/27/2023,Premium Payment,10000,Annual premium\n',
};
