/* =====================================================================
   Every field a policy row carries, and what a column made from it
   looks like.

   One catalogue, loaded by the browser and imported by the server. The
   browser builds the grid and the column picker from it; the server uses
   it to check a saved arrangement before storing it, so a preference can
   only ever name fields that exist. Neither side keeps its own list —
   two lists is how a column ends up on one screen and not the other.

   `type` is what the cell IS, not how it looks: the grid turns a type into
   a renderer in one place, so adding a field here is one line rather than
   one line plus a formatter. `default: true` marks the columns the grid
   opens with for somebody who has never arranged it, and the order below
   is the order they appear in.

   `staffOnly` fields are the carrier's administration of the policy —
   account value, surrender value, cost of insurance and the statement
   dates they come from. An investor holds a percentage of a death
   benefit; they are not going to surrender the policy, so a cash value
   quoted beside a purchase price reads like a valuation, which it is not.

   This module is plain ES with no DOM and no Node APIs.
   ===================================================================== */

export const POLICY_FIELDS = [
  { key: 'policy_number', header: 'Policy #', type: 'strong', group: 'Policy', default: true },
  /* An investor's own percentage, and only ever theirs. Second, because
     every figure on the row is that percentage of the policy. */
  { key: 'my_pct', header: 'My share', type: 'pct', group: 'Policy',
    investorOnly: true, default: true },
  { key: 'unique_case_id', header: 'Case ID', type: 'text', group: 'Policy' },

  { key: 'insured_last', header: 'Last name', type: 'text', group: 'Insured', default: true },
  { key: 'insured_first', header: 'First name', type: 'text', group: 'Insured', default: true },
  { key: 'display_name', header: 'Insured', type: 'text', group: 'Insured' },
  { key: 'insured_dob', header: 'DOB', type: 'date', group: 'Insured', default: true },
  { key: 'age', header: 'Age', type: 'age', group: 'Insured', default: true },
  { key: 'insured_gender', header: 'Sex', type: 'sex', group: 'Insured', default: true },
  { key: 'le_months', header: 'LE (months)', type: 'int', group: 'Insured' },
  { key: 'date_of_death', header: 'Date of death', type: 'date', group: 'Insured' },

  { key: 'carrier_name', header: 'Carrier', type: 'text', group: 'Policy', default: true },
  { key: 'plan_name', header: 'Plan', type: 'text', group: 'Policy' },
  { key: 'product_type', header: 'Type', type: 'product', group: 'Policy', default: true },
  { key: 'issue_date', header: 'Issued', type: 'date', group: 'Policy', default: true },
  { key: 'issue_age', header: 'Issue age', type: 'int', group: 'Policy' },
  { key: 'issue_state', header: 'Issue state', type: 'text', group: 'Policy' },

  { key: 'face_amount', header: 'Face', type: 'money', group: 'Money', default: true, total: true },
  { key: 'death_benefit', header: 'Death benefit', type: 'money', group: 'Money',
    default: true, total: true },
  { key: 'fund_code', header: 'Owner', type: 'owner', group: 'Policy', default: true },
  { key: 'owner_account', header: 'Owner account', type: 'text', group: 'Policy' },
  { key: 'beneficiary', header: 'Beneficiary', type: 'text', group: 'Policy' },

  { key: 'premium_required', header: 'Premium', type: 'money', group: 'Premiums',
    default: true, total: true },
  { key: 'premium_mode', header: 'Mode', type: 'text', group: 'Premiums' },
  { key: 'next_premium_due', header: 'Next premium (on the form)', type: 'date',
    group: 'Premiums' },
  /* What is actually scheduled on the servicing calendar, which is the only
     thing any screen or report that says money is due may read. The two
     fields above describe how the policy was written. */
  { key: 'next_scheduled_due', header: 'Next premium scheduled', type: 'date',
    group: 'Premiums', report: true },
  { key: 'next_scheduled_amount', header: 'Next premium amount', type: 'money',
    group: 'Premiums', total: true, report: true },
  { key: 'scheduled_next_12mo', header: 'Scheduled, next 12 months', type: 'money',
    group: 'Premiums', total: true },
  { key: 'grace_period_days', header: 'Grace days', type: 'int', group: 'Premiums' },
  { key: 'acquisition_date', header: 'Acquired', type: 'date', group: 'Money' },
  { key: 'acquisition_cost', header: 'Purchase price', type: 'money', group: 'Money', total: true },

  { key: 'account_value', header: 'AV', type: 'money', group: 'Carrier values',
    staffOnly: true, default: true, total: true },
  { key: 'cash_surrender_value', header: 'CSV', type: 'money', group: 'Carrier values',
    staffOnly: true, default: true, total: true },
  { key: 'cost_of_insurance', header: 'COI', type: 'money', group: 'Carrier values',
    staffOnly: true, default: true, total: true },
  { key: 'premium_paid_to_date', header: 'Premium paid to date', type: 'money',
    group: 'Carrier values', staffOnly: true, total: true },
  { key: 'loan_balance', header: 'Loan balance', type: 'money', group: 'Carrier values',
    staffOnly: true, total: true },

  { key: 'total_invested', header: 'Invested', type: 'money', group: 'Money',
    default: true, total: true },
  { key: 'total_premiums', header: 'Premiums paid', type: 'money', group: 'Money', total: true },
  { key: 'total_acquisition', header: 'Acquisition cost', type: 'money', group: 'Money',
    total: true },

  { key: 'date_of_last_withdrawal', header: 'Last w/d', type: 'date', group: 'Carrier values',
    staffOnly: true, default: true },
  { key: 'value_as_of', header: 'Values as of', type: 'date', group: 'Carrier values',
    staffOnly: true, default: true },

  { key: 'status', header: 'Status', type: 'status', group: 'Status', default: true },
  { key: 'status_date', header: 'Status date', type: 'date', group: 'Status' },
  { key: 'matured_on', header: 'Matured', type: 'date', group: 'Status' },
  { key: 'proceeds_amount', header: 'Proceeds', type: 'money', group: 'Status', total: true },
  { key: 'proceeds_received_on', header: 'Funded', type: 'date', group: 'Status' },
  { key: 'notes', header: 'Notes', type: 'text', group: 'Status' },
  { key: 'created_at', header: 'Added', type: 'date', group: 'Status' },
  { key: 'updated_at', header: 'Last changed', type: 'date', group: 'Status' },
];

/**
 * What the Policy Schedule report opens with.
 *
 * Not the same set as the grid. The grid is a working screen — carrier
 * values, statement dates, the things somebody is chasing. The report is a
 * document that goes to a reader: who is insured, what it is worth, what it
 * costs to keep, and where it stands. A field carries `report: true` when
 * it belongs on that document as well as, or instead of, the grid.
 */
const REPORT_DEFAULT_KEYS = new Set([
  'insured_last', 'insured_first', 'insured_dob', 'age', 'insured_gender',
  'carrier_name', 'product_type', 'policy_number', 'issue_date',
  'death_benefit', 'fund_code',
  'next_scheduled_amount', 'premium_mode', 'next_scheduled_due',
  'account_value', 'cash_surrender_value', 'cost_of_insurance',
  'status',
]);

export const POLICY_FIELD_KEYS = POLICY_FIELDS.map((f) => f.key);
export const POLICY_GROUPS = [...new Set(POLICY_FIELDS.map((f) => f.group))];

/** The fields somebody in this role may see at all. */
export const fieldsFor = (investor) => POLICY_FIELDS.filter((f) => (investor
  ? !f.staffOnly
  : !f.investorOnly));

/**
 * A saved arrangement, made safe.
 *
 * Anything unrecognised is dropped rather than rejected: an arrangement
 * saved before a field was renamed, or naming a field this person may not
 * see, has to keep working. What comes back is always a complete list —
 * every field they may see, the ones they arranged in the order they chose,
 * and anything the arrangement never mentioned waiting at the end.
 *
 * Two rules that are easy to get subtly wrong:
 *
 *   - a field the arrangement does not mention is appended, never inserted.
 *     Sliding a newly added field into the middle of a layout somebody
 *     arranged by hand moves their columns without being asked.
 *   - and unless it was switched off by name, it follows the catalogue's
 *     own default for whether it shows, rather than "not hidden, therefore
 *     on" — otherwise every field added in future would appear unbidden on
 *     the grid of everybody who has ever arranged one. Switching off is
 *     always obeyed, and for a field they did arrange `hidden` is the whole
 *     truth, so a non-default column they switched on stays on.
 */
export function arrangeFields(pref, { investor = false, forReport = false } = {}) {
  const allowed = fieldsFor(investor);
  /* Which fields are on by default for somebody who has never arranged
     this particular surface. The grid and the report are arranged
     separately and neither inherits the other's choices. */
  const isDefault = (f) => (forReport
    ? REPORT_DEFAULT_KEYS.has(f.key) || !!f.report
    : !!f.default);
  const byKey = new Map(allowed.map((f) => [f.key, f]));
  const wanted = Array.isArray(pref?.order) ? pref.order : null;
  const hidden = new Set(Array.isArray(pref?.hidden) ? pref.hidden : []);

  const named = [];
  const seen = new Set();
  for (const key of wanted || []) {
    if (!byKey.has(key) || seen.has(key)) continue;
    seen.add(key);
    named.push(byKey.get(key));
  }
  const rest = allowed.filter((f) => !seen.has(f.key));

  return [...named, ...rest].map((f) => ({
    ...f,
    visible: hidden.has(f.key) ? false
      : wanted && seen.has(f.key) ? true : isDefault(f),
  }));
}

/** What gets stored: the order, and what is switched off. Nothing else. */
export function packArrangement(fields) {
  return {
    order: fields.map((f) => f.key),
    hidden: fields.filter((f) => !f.visible).map((f) => f.key),
  };
}

/**
 * The server's gate. Returns a clean object or null, never throws: an
 * arrangement is a convenience, and a malformed one is worth ignoring
 * rather than turning into an error the person cannot act on.
 */
export function cleanArrangement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const known = new Set(POLICY_FIELD_KEYS);
  const list = (v) => (Array.isArray(v) ? v : [])
    .filter((k) => typeof k === 'string' && known.has(k))
    .filter((k, i, a) => a.indexOf(k) === i)
    .slice(0, POLICY_FIELD_KEYS.length);
  const order = list(value.order);
  const hidden = list(value.hidden);
  if (!order.length) return null;
  return { order, hidden };
}
