import { parse } from 'csv-parse/sync';
import { q, audit } from './db.js';
import { resolveInsured, resolveFund, date, num, int, str, url as link } from './api.js';
import { readWorkbook, sheetToObjects, isXlsx } from './xlsx.js';

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

  // insured detail
  dateofdeath: 'date_of_death', dod: 'date_of_death', deathdate: 'date_of_death',
  smoker: 'smoker', tobacco: 'smoker',
  leprovider: 'le_provider', ledate: 'le_date', lereportdate: 'le_date',
  displayname: 'display_name',

  // the maturity cheque
  proceeds: 'proceeds_amount', proceedsamount: 'proceeds_amount',
  claimamount: 'proceeds_amount', deathbenefitreceived: 'proceeds_amount',
  proceedsreceivedon: 'proceeds_received_on', proceedsreceived: 'proceeds_received_on',
  claimpaidon: 'proceeds_received_on', datereceived: 'proceeds_received_on',

  // where the case file actually lives
  casefiles: 'documents_url', casefileslink: 'documents_url',
  documentslink: 'documents_url', documentsurl: 'documents_url',
  dropbox: 'documents_url', dropboxlink: 'documents_url', filelink: 'documents_url',

  // scheduled future premiums
  duedate: 'due_date', premiumduedate: 'due_date', scheduleddate: 'due_date',
  estimatedamount: 'est_amount', estimatedpremium: 'est_amount',
  scheduledamount: 'est_amount', premiumamount: 'est_amount',
  note: 'note', notes: 'note',

  // master file
  recordtype: 'record_type', rowtype: 'record_type', record: 'record_type',
  role: 'role', lifetype: 'role', insuredrole: 'role',
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

/** Header-keyed rows, before alias mapping — the master reader needs both. */
export function parseCsvRaw(buffer) {
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
  return records;
}

export function parseCsv(buffer) {
  return parseCsvRaw(buffer).map(mapRow);
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
        /* The maturity cheque. Kept on the policy rather than in the ledger:
           it is the one inflow that settles the position, and the return
           calculation reads it from here to know the claim was actually
           paid rather than merely assumed. */
        proceeds_amount: num(row.proceeds_amount),
        proceeds_received_on: date(row.proceeds_received_on),
        documents_url: link(row.documents_url),
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
  const result = { created: 0, updated: 0, values: 0, skipped: 0, errors: [] };
  const allowedFunds = opts.fundScope || null;
  // A ledger row is append-only, so re-uploading the same file would double
  // the capital invested and halve every IRR computed from it. An identical
  // row — same policy, date, type and amount — is therefore skipped and
  // counted, unless the file genuinely contains two such payments and the
  // person says so.
  const allowDuplicates = !!opts.allowDuplicates;
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

      if (!allowDuplicates) {
        const { rows: dup } = await q(
          `SELECT 1 FROM transactions
            WHERE policy_id = $1 AND txn_date = $2 AND txn_type = $3 AND amount = $4 LIMIT 1`,
          [policyId, d, type, amount]
        );
        if (dup[0]) { result.skipped++; continue; }
      }

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

/* ------------------------------------------------------------------ *
 * Master import — one file, every record type
 *
 * A full data dump does not arrive as four tidy files. This takes one,
 * works out what each row is, and loads them in dependency order so a
 * transaction can appear above the policy it belongs to and still land.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Reading whatever was uploaded
 *
 * A CSV is one table. A workbook is several, and the sheets carry meaning
 * of their own — a tab called "2975464 Premiums" is that policy's ledger,
 * even though not one row inside it names the policy.
 * ------------------------------------------------------------------ */

/**
 * A premium-history tab, as people actually keep them: a date column, an
 * amount column, and nothing else. No policy number (it is the tab name)
 * and no transaction type (they are all premiums).
 *
 * Recognising this shape is the difference between "one file, technically"
 * and a file somebody can actually export from what they already have.
 */
function looksLikePremiumHistory(rows) {
  if (!rows.length) return false;
  const dated = rows.filter((r) => r.txn_date !== undefined).length;
  if (dated < Math.max(2, rows.length * 0.6)) return false;
  const hasAmount = rows.some((r) => r.amount !== undefined);
  const hasPremium = rows.some((r) => r.premium_required !== undefined);
  // Identity columns would make it a policy sheet, not a ledger.
  const identity = rows.some((r) =>
    r.carrier_name !== undefined || r.face_amount !== undefined || r.dob !== undefined);
  return !identity && (hasAmount || hasPremium);
}

/** Pull a policy number out of a sheet name like "2975464 Premiums". */
function policyNumberFromSheet(name) {
  const cleaned = String(name || '')
    .replace(/\b(premium|premiums|history|ledger|payments|transactions|txns|values|value)\b/gi, '')
    .replace(/[()\-–—]+$/g, '')
    .trim();
  const token = cleaned.split(/\s+/).filter(Boolean).pop();
  return token && /[0-9]/.test(token) ? token : (cleaned || null);
}

/**
 * Everything uploaded, flattened into rows that remember where they came
 * from. With several files and several tabs, "line 12" on its own is not
 * an error message anybody can act on.
 */
export function readUploads(files) {
  const entries = [];
  const sources = [];
  let declared = false;

  for (const f of files) {
    const name = f.originalname || f.name || 'upload';
    const tables = isXlsx(name)
      ? readWorkbook(f.buffer).map((s) => ({ sheet: s.name, ...sheetToObjects(s.rows) }))
      : [{ sheet: null, objects: parseCsvWithLines(f.buffer) }];

    for (const table of tables) {
      const mapped = table.objects.map(({ obj, line }) => ({ row: mapRow(obj), line }));
      // Whether the person labelled their rows has to be judged before any
      // are labelled on their behalf below.
      if (mapped.some((m) => str(m.row.record_type) !== '')) declared = true;
      if (!mapped.length) {
        sources.push({ file: name, sheet: table.sheet, rows: 0, note: 'no data rows' });
        continue;
      }

      // A ledger tab named after its policy: give every row that number and
      // the type they all share, then say so in the preview.
      let note = null;
      const bareRows = mapped.map((m) => m.row);
      if (table.sheet && !bareRows.some((r) => str(r.policy_number)) && looksLikePremiumHistory(bareRows)) {
        const pn = policyNumberFromSheet(table.sheet);
        if (pn) {
          // Spreadsheets end in a Total line. It is a footer, not a payment,
          // and the date column holds the word "Total" rather than a date.
          const footers = [];
          for (let i = mapped.length - 1; i >= 0; i--) {
            if (date(mapped[i].row.txn_date)) break;
            footers.push(...mapped.splice(i, 1));
          }
          for (const { row } of mapped) {
            row.policy_number = pn;
            if (row.amount === undefined && row.premium_required !== undefined) {
              row.amount = row.premium_required;
              delete row.premium_required;
            }
            if (row.txn_type === undefined) row.txn_type = 'Premium Payment';
            row.record_type = row.record_type || 'Transaction';
          }
          note = `read as premium history for policy "${pn}"`
            + (footers.length ? `, ${footers.length} total row${footers.length === 1 ? '' : 's'} ignored` : '');
        }
      }

      sources.push({ file: name, sheet: table.sheet, rows: mapped.length, note });
      for (const m of mapped) entries.push({ ...m, file: name, sheet: table.sheet });
    }
  }
  return { entries, sources, declared };
}

/** CSV rows with their real line numbers (header is line 1). */
function parseCsvWithLines(buffer) {
  return parseCsvRaw(buffer).map((obj, i) => ({ obj, line: i + 2 }));
}

const RECORD_TYPES = {
  policy: 'policy', policies: 'policy', p: 'policy',
  insured: 'insured', insureds: 'insured', person: 'insured', life: 'life',
  additionallife: 'life', additionalinsured: 'life', secondinsured: 'life',
  survivorship: 'life', joint: 'life',
  value: 'value', values: 'value', valuation: 'value', snapshot: 'value', v: 'value',
  transaction: 'transaction', transactions: 'transaction', txn: 'transaction',
  ledger: 'transaction', payment: 'transaction', t: 'transaction',
  // A premium that has not been paid yet — an illustration, not a ledger
  // entry. It lands on the follow-up schedule rather than in the accounts.
  premium: 'premium', premiums: 'premium', scheduledpremium: 'premium',
  futurepremium: 'premium', premiumschedule: 'premium',
};

const VALUE_ONLY_KEYS = ['account_value', 'cash_surrender_value', 'cost_of_insurance',
  'death_benefit', 'premium_paid_to_date', 'monthly_deduction', 'loan_balance'];
const POLICY_ONLY_KEYS = ['proceeds_amount', 'proceeds_received_on', 'documents_url',
  'carrier_name', 'face_amount', 'issue_date', 'product_type',
  'premium_required', 'acquisition_cost', 'plan_name', 'owner_raw', 'fund_code', 'status'];
const INSURED_ONLY_KEYS = ['dob', 'gender', 'le_months', 'le_provider', 'le_date',
  'smoker', 'date_of_death', 'issue_state'];

const has = (row, keys) => keys.some((k) => row[k] !== undefined && str(row[k]) !== '');

/**
 * What kind of record is this row?
 *
 * An explicit Record Type column always wins. Without one the shape of the
 * row decides, but only on unambiguous evidence — a row that could be two
 * things is returned as an error naming what to add, because guessing wrong
 * on a book of record is worse than asking.
 */
export function classifyRow(row) {
  const declared = str(row.record_type);
  if (declared) {
    const t = RECORD_TYPES[norm(declared)];
    return t
      ? { type: t }
      : { error: `"${declared}" is not a record type. Use Policy, Insured, Life, Value, Transaction or Premium.` };
  }

  const looksPremium = has(row, ['due_date']) && has(row, ['est_amount']);
  const looksTransaction = has(row, ['txn_type'])
    || (has(row, ['txn_date']) && has(row, ['amount']));
  const looksValue = has(row, VALUE_ONLY_KEYS) || has(row, ['as_of_date']);
  const looksPolicy = has(row, POLICY_ONLY_KEYS);
  const looksLife = has(row, ['role']);

  if (looksPremium && !looksPolicy) return { type: 'premium' };
  if (looksTransaction && !looksPolicy) return { type: 'transaction' };
  if (looksLife && !looksPolicy) return { type: 'life' };
  // A policy row legitimately carries current values, so policy wins over
  // value when both are present — that is the monthly-export shape.
  if (looksPolicy) return { type: 'policy' };
  if (looksValue) return { type: 'value' };
  if (has(row, INSURED_ONLY_KEYS) && has(row, ['insured_name', 'insured_last_name', 'last_name']))
    return { type: 'insured' };

  return { error: 'Cannot tell what this row is. Add a "Record Type" column with Policy, Insured, Life, Value, Transaction or Premium.' };
}

/** Update a person's own details — life expectancy, date of death, and so on. */
async function importInsuredRow(row) {
  const insuredId = await resolveInsured(row);
  if (!insuredId) throw new Error('A last name is required to identify the insured');
  const fields = {
    display_name: str(row.display_name) || null,
    gender: str(row.gender) || null,
    issue_state: undefined,               // not a person field
    state: str(row.issue_state) || null,
    smoker: str(row.smoker) || null,
    le_months: int(row.le_months),
    le_provider: str(row.le_provider) || null,
    le_date: date(row.le_date),
    date_of_death: date(row.date_of_death),
    notes: str(row.notes) || null,
  };
  delete fields.issue_state;
  const sets = [], vals = [];
  let n = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    sets.push(`${k} = $${n++}`); vals.push(v);
  }
  if (!sets.length) throw new Error('No insured details supplied to update');
  await q(`UPDATE insureds SET ${sets.join(',')}, updated_at = now() WHERE id = $${n}`,
    [...vals, insuredId]);
  return insuredId;
}

/** Attach an additional life to a policy — survivorship, joint, secondary. */
async function importLifeRow(row, allowedFunds) {
  const policyId = await findPolicyId(row, allowedFunds);
  if (!policyId) throw new Error(`No policy matches "${str(row.policy_number)}"`);
  const insuredId = await resolveInsured(row);
  if (!insuredId) throw new Error('A last name is required for the additional life');

  const { rows: pol } = await q('SELECT insured_id FROM policies WHERE id = $1', [policyId]);
  if (pol[0]?.insured_id === insuredId)
    throw new Error('That person is already the primary insured on this policy');

  await q(
    `INSERT INTO policy_insureds (policy_id, insured_id, role, notes)
     VALUES ($1,$2,$3,$4) ON CONFLICT (policy_id, insured_id) DO UPDATE SET role = EXCLUDED.role`,
    [policyId, insuredId, str(row.role) || 'Survivorship', str(row.notes)]
  );
  return policyId;
}

/**
 * Load a mixed file.
 *
 * Rows are classified first, then run in dependency order — policies (which
 * create their insureds), then insured detail, then additional lives, then
 * values, then the ledger. Original line numbers travel with every row so an
 * error points at the line in the file the person is looking at.
 */
async function importMaster(entries, opts, user) {
  const allowedFunds = opts.fundScope || null;
  const result = {
    created: 0, updated: 0, values: 0, skipped: 0, errors: [],
    byType: { policy: 0, insured: 0, life: 0, value: 0, transaction: 0, premium: 0, unclassified: 0 },
  };

  const buckets = { policy: [], insured: [], life: [], value: [], transaction: [], premium: [] };
  for (const entry of entries) {
    const { type, error } = classifyRow(entry.row);
    if (error) {
      result.errors.push({ ...where(entry), message: error });
      result.byType.unclassified++;
      continue;
    }
    buckets[type].push(entry);
    result.byType[type]++;
  }

  // Errors come back from the sub-importers numbered from 2; map each one
  // to the file, sheet and line the person is actually looking at.
  const relocate = (subErrors, bucket) => subErrors.map((e) => ({
    ...where(bucket[e.line - 2] || {}), message: e.message,
  }));

  // 1. Policies first — everything else hangs off them.
  if (buckets.policy.length) {
    const sub = await importPolicies(buckets.policy.map((b) => b.row), opts, user);
    result.created += sub.created;
    result.updated += sub.updated;
    result.values += sub.values;
    result.errors.push(...relocate(sub.errors, buckets.policy));
  }

  // 2. Person-level detail, 3. additional lives.
  for (const [kind, fn] of [['insured', importInsuredRow], ['life', importLifeRow]]) {
    for (const entry of buckets[kind]) {
      try {
        await fn(entry.row, allowedFunds);
        result.updated++;
      } catch (e) {
        result.errors.push({ ...where(entry), message: e.message });
      }
    }
  }

  // 4. Value snapshots.
  if (buckets.value.length) {
    const sub = await importValues(buckets.value.map((b) => b.row), opts);
    result.values += sub.values;
    result.errors.push(...relocate(sub.errors, buckets.value));
  }

  // 5. The ledger.
  if (buckets.transaction.length) {
    const sub = await importTransactions(buckets.transaction.map((b) => b.row), opts);
    result.created += sub.created;
    result.skipped += sub.skipped || 0;
    result.errors.push(...relocate(sub.errors, buckets.transaction));
  }

  // 6. Premiums still to come.
  if (buckets.premium.length) {
    const sub = await importPremiums(buckets.premium.map((b) => b.row),
      { ...opts, userId: user?.uid ?? null });
    result.created += sub.created;
    result.updated += sub.updated;
    result.errors.push(...relocate(sub.errors, buckets.premium));
  }

  result.errors.sort((a, b) =>
    String(a.file).localeCompare(String(b.file)) || String(a.sheet).localeCompare(String(b.sheet))
    || (a.line - b.line));
  return result;
}

/**
 * Future premiums, from a carrier illustration.
 *
 * These are not ledger entries — nothing has been paid — so they go on the
 * policy's follow-up schedule, where they drive "next premium due" and show
 * up for the investors who will be asked to fund them. Re-importing the same
 * illustration replaces the estimate for that date rather than stacking a
 * second one beside it, because an illustration is a statement about a day,
 * not an event that happened on it.
 */
async function importPremiums(rows, opts = {}) {
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  const allowedFunds = opts.fundScope || null;
  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    try {
      const policyId = await findPolicyId(row, allowedFunds);
      const due = date(row.due_date) || date(row.txn_date);
      const amount = num(row.est_amount ?? row.amount);
      if (!due) throw new Error('A due date is required');
      if (amount === null || amount < 0)
        throw new Error('An estimated amount of zero or more is required');

      const existing = await q(
        `SELECT id FROM policy_reminders
          WHERE policy_id = $1 AND kind = 'Premium' AND due_date = $2 AND done_at IS NULL`,
        [policyId, due]);
      if (existing.rows.length) {
        await q('UPDATE policy_reminders SET amount = $1, note = $2 WHERE id = $3',
          [amount, str(row.note), existing.rows[0].id]);
        result.updated++;
      } else {
        await q(
          `INSERT INTO policy_reminders (policy_id, due_date, kind, amount, note, created_by)
           VALUES ($1,$2,'Premium',$3,$4,$5)`,
          [policyId, due, amount, str(row.note), opts.userId || null]);
        result.created++;
      }
    } catch (e) {
      result.errors.push({ line, message: e.message });
    }
  }
  return result;
}

/** Where a row came from, for an error message somebody can act on. */
const where = (entry) => ({
  line: entry.line ?? 0,
  file: entry.file ?? null,
  sheet: entry.sheet ?? null,
});

/**
 * What is in the upload, before anything is written.
 *
 * Reports every file and sheet found, what each row was taken to be, and
 * anything it could not classify — with the file, tab and line number, so
 * "line 12" is never left to mean twelve of what.
 */
export function previewUpload(files, type) {
  const { entries, sources, declared } = readUploads(files);
  if (entries.length > MAX_ROWS) {
    const e = new Error(
      `That is ${entries.length.toLocaleString('en-US')} rows across ${files.length} file(s), ` +
      `more than the ${MAX_ROWS.toLocaleString('en-US')} this will read at once. Split it and import in parts.`);
    e.status = 400;
    throw e;
  }

  const known = new Set([...Object.values(ALIASES),
    'policy_number', 'insured_name', 'carrier_name', 'as_of_date']);
  const recognised = new Set(), unrecognised = new Set();
  for (const { row } of entries.slice(0, 400))
    for (const k of Object.keys(row)) (known.has(k) ? recognised : unrecognised).add(k);

  const out = {
    type,
    rowCount: entries.length,
    fileCount: files.length,
    sources,
    recognised: [...recognised],
    unrecognised: [...unrecognised],
    sample: entries.slice(0, 8).map((e) => e.row),
  };

  if (type === 'master') {
    const byType = { policy: 0, insured: 0, life: 0, value: 0, transaction: 0, unclassified: 0 };
    const problems = [];
    for (const entry of entries) {
      const { type: t2, error } = classifyRow(entry.row);
      if (error) {
        byType.unclassified++;
        if (problems.length < 20) problems.push({ ...where(entry), message: error });
      } else byType[t2]++;
    }
    out.byType = byType;
    out.problems = problems;
    out.declared = declared;
  }
  return out;
}

/** Kept for the single-file callers and the existing tests. */
export const previewCsv = (buffer, type) =>
  previewUpload([{ originalname: 'upload.csv', buffer }], type);

export async function runImport(files, type, opts, user) {
  const list = Array.isArray(files) ? files : [{ originalname: 'upload.csv', buffer: files }];
  const { entries } = readUploads(list);
  if (!entries.length)
    return { created: 0, updated: 0, values: 0, skipped: 0, rowCount: 0,
             errors: [{ line: 1, message: 'Nothing to import — no data rows found' }] };
  if (entries.length > MAX_ROWS) {
    const e = new Error(
      `That is ${entries.length.toLocaleString('en-US')} rows, more than the ` +
      `${MAX_ROWS.toLocaleString('en-US')} this will read at once. Split it and import in parts.`);
    e.status = 400;
    throw e;
  }

  let result;
  if (type === 'master') {
    result = await importMaster(entries, opts, user);
  } else {
    // The single-purpose importers take plain rows; carry the provenance
    // back onto their errors afterwards.
    const rows = entries.map((e) => e.row);
    if (type === 'values') result = await importValues(rows, opts);
    else if (type === 'transactions') result = await importTransactions(rows, opts);
    else result = await importPolicies(rows, opts, user);
    result.errors = result.errors.map((e) => ({ ...where(entries[e.line - 2] || {}), message: e.message }));
  }

  result.rowCount = entries.length;
  result.skipped = result.skipped || 0;
  await audit(user?.uid, 'import', null, 'import',
    `${type}: ${list.length} file(s), ${result.created} created, ${result.updated} updated, ` +
    `${result.values} value rows, ${result.skipped} duplicates skipped, ${result.errors.length} errors`);
  return result;
}

/**
 * The master template, built from a column list rather than typed out.
 *
 * Every row has to line up with the header, and a template where one sample
 * row is a comma short teaches the reader the wrong shape. Naming the cells
 * that matter and letting the rest fall out blank makes that impossible.
 */
const MASTER_COLUMNS = [
  'Record Type', 'Policy Number', 'Carrier Name', 'Last Name', 'First Name', 'DOB',
  'Gender', 'State', 'LE Months', 'Date Of Death', 'Role', 'Product Type', 'Issue Date',
  'Basic Face', 'Owner', 'Premium Required', 'Premium Mode', 'Next Premium Due',
  'Acquisition Date', 'Acquisition Cost', 'Status', 'As Of Date', 'AV', 'CSV', 'COI',
  'Death Benefit', 'Loan Balance', 'Transaction Date', 'Transaction Type', 'Amount',
  'Remarks', 'Due Date', 'Estimated Amount', 'Note', 'Proceeds Amount',
  'Proceeds Received On', 'Case Files Link',
];

const MASTER_ROWS = [
  { 'Record Type': 'Policy', 'Policy Number': '2975464', 'Carrier Name': 'Genworth Call Pay',
    'Last Name': 'Setliff', 'First Name': 'Reuben', DOB: '04/22/1937', Gender: 'M', State: 'SD',
    'LE Months': '84', 'Product Type': 'UL', 'Issue Date': '10/21/2009', 'Basic Face': '1000000',
    Owner: 'LCG1', 'Premium Required': '10000', 'Premium Mode': 'Annual',
    'Next Premium Due': '10/21/2026', 'Acquisition Date': '03/19/2021',
    'Acquisition Cost': '250300', Status: 'Inforce',
    'Case Files Link': 'https://www.dropbox.com/scl/fo/example-2975464' },
  { 'Record Type': 'Policy', 'Policy Number': '884120', 'Carrier Name': 'Brighthouse',
    'Last Name': 'Wolfe', 'First Name': 'Dean', DOB: '06/02/1940', Gender: 'M', State: 'MI',
    'LE Months': '96', 'Product Type': 'SUL', 'Issue Date': '03/14/2011', 'Basic Face': '5000000',
    Owner: 'LCG2', 'Premium Required': '96000', 'Premium Mode': 'Annual',
    'Next Premium Due': '08/25/2026', 'Acquisition Date': '07/02/2019',
    'Acquisition Cost': '1120000', Status: 'Inforce' },
  { 'Record Type': 'Life', 'Policy Number': '884120', 'Carrier Name': 'Brighthouse',
    'Last Name': 'Wolfe', 'First Name': 'Cheryl', DOB: '11/18/1942', Gender: 'F', State: 'MI',
    'LE Months': '102', Role: 'Survivorship' },
  { 'Record Type': 'Insured', 'Last Name': 'Setliff', 'First Name': 'Reuben',
    DOB: '04/22/1937', 'LE Months': '90', Remarks: 'Updated LE report' },
  { 'Record Type': 'Value', 'Policy Number': '2975464', 'As Of Date': '06/30/2026',
    AV: '3200.10', CSV: '3200.10', COI: '4050.00', 'Death Benefit': '1000000',
    'Loan Balance': '0' },
  { 'Record Type': 'Value', 'Policy Number': '2975464', 'As Of Date': '07/31/2026',
    AV: '3173.60', CSV: '3173.60', COI: '4068.30', 'Death Benefit': '1000000',
    'Loan Balance': '0' },
  { 'Record Type': 'Transaction', 'Policy Number': '2975464',
    'Transaction Date': '03/27/2023', 'Transaction Type': 'Premium Payment',
    Amount: '10000', Remarks: 'Annual premium' },
  { 'Record Type': 'Transaction', 'Policy Number': '884120',
    'Transaction Date': '08/25/2024', 'Transaction Type': 'Premium Payment', Amount: '96000' },
  { 'Record Type': 'Premium', 'Policy Number': '2975464', 'Due Date': '10/21/2027',
    'Estimated Amount': '10400', Note: 'Illustration step-up' },
];

function buildMaster() {
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (vals) => vals.map(cell).join(',');
  return [
    line(MASTER_COLUMNS),
    ...MASTER_ROWS.map((r) => line(MASTER_COLUMNS.map((c) => r[c] ?? ''))),
  ].join('\n') + '\n';
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
  master: buildMaster(),
};
