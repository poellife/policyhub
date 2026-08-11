import express from 'express';
import { q, audit } from './db.js';
import { requireAuth, requireRole, login, changePassword, createUser, clearToken } from './auth.js';

const router = express.Router();
const canEdit = requireRole('admin', 'editor');

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Accepts 07/06/1929, 1929-07-06, 7-6-29 etc. Returns YYYY-MM-DD or null. */
export const date = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 30 ? '19' : '20') + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
};

/** Build a parameterised INSERT/UPDATE from a whitelist of columns. */
function buildSet(fields, body, start = 1) {
  const cols = [], vals = [], sets = [];
  let i = start;
  for (const [col, coerce] of Object.entries(fields)) {
    if (!(col in body)) continue;
    cols.push(col);
    vals.push(coerce(body[col]));
    sets.push(`${col} = $${i++}`);
  }
  return { cols, vals, sets, next: i };
}

const POLICY_FIELDS = {
  policy_number: str, unique_case_id: str, insured_id: int, fund_id: int,
  carrier_name: str, plan_name: str, product_type: str,
  issue_date: date, issue_age: int, issue_state: str,
  face_amount: num, owner_account: str, beneficiary: str,
  status: str, status_date: date,
  premium_required: num, premium_mode: str, next_premium_due: date,
  grace_period_days: int,
  acquisition_date: date, acquisition_cost: num, notes: str,
};

const INSURED_FIELDS = {
  first_name: str, last_name: str, display_name: str, dob: date, gender: str,
  state: str, smoker: str, le_months: int, le_provider: str, le_date: date,
  date_of_death: date, notes: str,
};

const VALUE_FIELDS = {
  as_of_date: date, account_value: num, cash_surrender_value: num,
  cost_of_insurance: num, death_benefit: num, premium_paid_to_date: num,
  monthly_deduction: num, loan_balance: num, date_of_last_withdrawal: date,
  notes: str,
};

const TXN_FIELDS = { txn_date: date, txn_type: str, amount: num, remarks: str };

/* ------------------------------------------------------------------ *
 * auth
 * ------------------------------------------------------------------ */

router.post('/auth/login', wrap(login));
router.post('/auth/logout', (req, res) => { clearToken(res); res.json({ ok: true }); });
router.get('/auth/me', requireAuth, (req, res) =>
  res.json({ id: req.user.uid, email: req.user.email, name: req.user.name, role: req.user.role })
);
router.post('/auth/password', requireAuth, wrap(changePassword));
router.get('/users', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT id, email, full_name, role, is_active, last_login_at FROM users ORDER BY id'
  );
  res.json(rows);
}));
router.post('/users', requireAuth, requireRole('admin'), wrap(createUser));

router.use(requireAuth); // everything below requires a session

/* ------------------------------------------------------------------ *
 * funds
 * ------------------------------------------------------------------ */

router.get('/funds', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM funds ORDER BY code');
  res.json(rows);
}));

router.post('/funds', canEdit, wrap(async (req, res) => {
  const { rows } = await q(
    `INSERT INTO funds (code, name, notes) VALUES ($1,$2,$3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [str(req.body.code), str(req.body.name), str(req.body.notes)]
  );
  res.status(201).json(rows[0]);
}));

/* ------------------------------------------------------------------ *
 * insureds
 * ------------------------------------------------------------------ */

router.get('/insureds', wrap(async (req, res) => {
  const search = str(req.query.search);
  const { rows } = await q(
    `SELECT i.*, COUNT(p.id)::int AS policy_count
       FROM insureds i LEFT JOIN policies p ON p.insured_id = i.id
      WHERE ($1 = '' OR i.first_name ILIKE '%'||$1||'%' OR i.last_name ILIKE '%'||$1||'%'
             OR i.display_name ILIKE '%'||$1||'%')
      GROUP BY i.id ORDER BY i.last_name, i.first_name`,
    [search]
  );
  res.json(rows);
}));

router.get('/insureds/:id', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM insureds WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Insured not found' });
  const pol = await q('SELECT * FROM policy_latest WHERE insured_id = $1', [req.params.id]);
  res.json({ ...rows[0], policies: pol.rows });
}));

router.post('/insureds', canEdit, wrap(async (req, res) => {
  const { cols, vals } = buildSet(INSURED_FIELDS, req.body);
  if (!cols.length) return res.status(400).json({ error: 'No fields supplied' });
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q(
    `INSERT INTO insureds (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals
  );
  await audit(req.user.uid, 'insured', rows[0].id, 'create', rows[0].last_name);
  res.status(201).json(rows[0]);
}));

router.put('/insureds/:id', canEdit, wrap(async (req, res) => {
  const { sets, vals, next } = buildSet(INSURED_FIELDS, req.body);
  if (!sets.length) return res.status(400).json({ error: 'No fields supplied' });
  const { rows } = await q(
    `UPDATE insureds SET ${sets.join(',')}, updated_at = now() WHERE id = $${next} RETURNING *`,
    [...vals, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insured not found' });
  await audit(req.user.uid, 'insured', rows[0].id, 'update', sets.join(','));
  res.json(rows[0]);
}));

/* ------------------------------------------------------------------ *
 * policies
 * ------------------------------------------------------------------ */

router.get('/policies', wrap(async (req, res) => {
  const search = str(req.query.search);
  const status = str(req.query.status);
  const fund = str(req.query.fund);
  const { rows } = await q(
    `SELECT * FROM policy_latest
      WHERE ($1 = '' OR policy_number ILIKE '%'||$1||'%'
             OR carrier_name ILIKE '%'||$1||'%'
             OR insured_last ILIKE '%'||$1||'%'
             OR insured_first ILIKE '%'||$1||'%'
             OR display_name ILIKE '%'||$1||'%')
        AND ($2 = '' OR status = $2)
        AND ($3 = '' OR fund_code = $3)
      ORDER BY insured_last, insured_first, policy_number`,
    [search, status, fund]
  );
  res.json(rows);
}));

router.get('/policies/:id', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM policy_latest WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
  const [values, txns, extra] = await Promise.all([
    q('SELECT * FROM policy_values WHERE policy_id = $1 ORDER BY as_of_date DESC', [req.params.id]),
    q('SELECT * FROM transactions WHERE policy_id = $1 ORDER BY txn_date DESC, id DESC', [req.params.id]),
    q(`SELECT pi.id AS link_id, pi.role, pi.notes AS link_notes, i.*
         FROM policy_insureds pi JOIN insureds i ON i.id = pi.insured_id
        WHERE pi.policy_id = $1 ORDER BY pi.id`, [req.params.id]),
  ]);
  res.json({
    ...rows[0],
    values: values.rows,
    transactions: txns.rows,
    additionalInsureds: extra.rows,
  });
}));

/* ---- additional lives on a policy (survivorship / joint) ---- */

router.post('/policies/:id/insureds', canEdit, wrap(async (req, res) => {
  const insuredId = await resolveInsured(req.body);
  if (!insuredId) return res.status(400).json({ error: 'A last name is required' });

  const { rows: pol } = await q('SELECT insured_id FROM policies WHERE id = $1', [req.params.id]);
  if (!pol[0]) return res.status(404).json({ error: 'Policy not found' });
  if (pol[0].insured_id === insuredId)
    return res.status(409).json({ error: 'That person is already the primary insured on this policy' });

  const role = ['Joint', 'Survivorship', 'Secondary', 'Other'].includes(req.body.role)
    ? req.body.role : 'Joint';
  try {
    const { rows } = await q(
      `INSERT INTO policy_insureds (policy_id, insured_id, role, notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, insuredId, role, str(req.body.notes)]
    );
    await audit(req.user.uid, 'policy_insured', rows[0].id, 'create', `policy ${req.params.id}`);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'That person is already listed on this policy' });
    throw e;
  }
}));

router.delete('/policy-insureds/:id', canEdit, wrap(async (req, res) => {
  const { rowCount } = await q('DELETE FROM policy_insureds WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  await audit(req.user.uid, 'policy_insured', req.params.id, 'delete', '');
  res.json({ ok: true });
}));

router.post('/policies', canEdit, wrap(async (req, res) => {
  const body = { ...req.body };
  body.insured_id = await resolveInsured(body);
  body.fund_id = await resolveFund(body);
  const { cols, vals } = buildSet(POLICY_FIELDS, body);
  if (!cols.includes('policy_number'))
    return res.status(400).json({ error: 'Policy number is required' });
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q(
    `INSERT INTO policies (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals
  );
  await audit(req.user.uid, 'policy', rows[0].id, 'create', rows[0].policy_number);
  res.status(201).json(rows[0]);
}));

router.put('/policies/:id', canEdit, wrap(async (req, res) => {
  const body = { ...req.body };
  if (body.insured_name || body.insured_last_name) body.insured_id = await resolveInsured(body);
  if (body.fund_code) body.fund_id = await resolveFund(body);
  const { sets, vals, next } = buildSet(POLICY_FIELDS, body);
  if (!sets.length) return res.status(400).json({ error: 'No fields supplied' });
  const { rows } = await q(
    `UPDATE policies SET ${sets.join(',')}, updated_at = now() WHERE id = $${next} RETURNING *`,
    [...vals, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
  await audit(req.user.uid, 'policy', rows[0].id, 'update', sets.join(','));
  res.json(rows[0]);
}));

router.delete('/policies/:id', requireRole('admin'), wrap(async (req, res) => {
  const { rowCount } = await q('DELETE FROM policies WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Policy not found' });
  await audit(req.user.uid, 'policy', req.params.id, 'delete', '');
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * value snapshots
 * ------------------------------------------------------------------ */

router.post('/policies/:id/values', canEdit, wrap(async (req, res) => {
  const { cols, vals } = buildSet(VALUE_FIELDS, req.body);
  if (!cols.includes('as_of_date'))
    return res.status(400).json({ error: 'An "as of" date is required' });
  const allCols = ['policy_id', ...cols];
  const allVals = [req.params.id, ...vals];
  const ph = allCols.map((_, i) => `$${i + 1}`).join(',');
  const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(',');
  const { rows } = await q(
    `INSERT INTO policy_values (${allCols.join(',')}) VALUES (${ph})
     ON CONFLICT (policy_id, as_of_date) DO UPDATE SET ${updates} RETURNING *`,
    allVals
  );
  await audit(req.user.uid, 'policy_value', rows[0].id, 'create', `policy ${req.params.id}`);
  res.status(201).json(rows[0]);
}));

router.delete('/values/:id', canEdit, wrap(async (req, res) => {
  await q('DELETE FROM policy_values WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * transactions
 * ------------------------------------------------------------------ */

router.post('/policies/:id/transactions', canEdit, wrap(async (req, res) => {
  const { cols, vals } = buildSet(TXN_FIELDS, req.body);
  if (!cols.includes('txn_date') || !cols.includes('txn_type'))
    return res.status(400).json({ error: 'Date and type are required' });
  const allCols = ['policy_id', ...cols];
  const allVals = [req.params.id, ...vals];
  const ph = allCols.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q(
    `INSERT INTO transactions (${allCols.join(',')}) VALUES (${ph}) RETURNING *`, allVals
  );
  await audit(req.user.uid, 'transaction', rows[0].id, 'create', `policy ${req.params.id}`);
  res.status(201).json(rows[0]);
}));

router.delete('/transactions/:id', canEdit, wrap(async (req, res) => {
  await q('DELETE FROM transactions WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * portfolio analytics
 * ------------------------------------------------------------------ */

router.get('/analytics/summary', wrap(async (req, res) => {
  const [totals, byCarrier, invested, ages] = await Promise.all([
    q(`SELECT
         COUNT(*)::int                                        AS policy_count,
         COUNT(*) FILTER (WHERE status = 'Inforce')::int      AS inforce_count,
         COALESCE(SUM(face_amount),0)                         AS total_face,
         COALESCE(SUM(COALESCE(death_benefit, face_amount)),0) AS total_death_benefit,
         COALESCE(SUM(cash_surrender_value),0)                AS total_csv,
         COALESCE(SUM(account_value),0)                       AS total_av,
         COALESCE(SUM(total_invested),0)                      AS total_invested,
         COALESCE(SUM(total_acquisition),0)                   AS total_acquisition,
         COALESCE(SUM(total_premiums),0)                      AS total_premiums,
         COALESCE(SUM(cost_of_insurance),0)                   AS monthly_coi
       FROM policy_latest WHERE status NOT IN ('Lapsed','Sold','Matured')`),
    q(`SELECT carrier_name, COUNT(*)::int AS n, COALESCE(SUM(face_amount),0) AS face
         FROM policy_latest WHERE status NOT IN ('Lapsed','Sold','Matured')
        GROUP BY carrier_name ORDER BY face DESC`),
    q(`SELECT to_char(date_trunc('month', txn_date),'YYYY-MM') AS month,
              SUM(amount) AS amount
         FROM transactions
        WHERE txn_type IN ('Acquisition Cost','Premium Payment','Fee','Servicing','Commission')
        GROUP BY 1 ORDER BY 1`),
    q(`SELECT
         COALESCE(AVG(EXTRACT(YEAR FROM age(insured_dob))),0) AS avg_age,
         COUNT(*) FILTER (WHERE insured_dob IS NOT NULL)::int AS with_dob
       FROM policy_latest WHERE status NOT IN ('Lapsed','Sold','Matured')`),
  ]);

  // Running total of capital deployed. Months with no activity are filled in
  // so the time axis stays linear (gaps would distort the trend).
  const byMonth = new Map(invested.rows.map((r) => [r.month, Number(r.amount) || 0]));
  const cumulative = [];
  if (invested.rows.length) {
    const [firstY, firstM] = invested.rows[0].month.split('-').map(Number);
    const last = invested.rows[invested.rows.length - 1].month;
    const cursor = new Date(Date.UTC(firstY, firstM - 1, 1));
    let running = 0;
    for (let guard = 0; guard < 1200; guard++) {
      const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
      const amount = byMonth.get(key) || 0;
      running += amount;
      cumulative.push({ month: key, monthly: amount, cumulative: running });
      if (key === last) break;
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  res.json({
    totals: totals.rows[0],
    byCarrier: byCarrier.rows,
    capitalDeployed: cumulative,
    avgInsuredAge: Number(ages.rows[0].avg_age) || 0,
  });
}));

/* ------------------------------------------------------------------ *
 * servicing calendar + lapse risk
 * ------------------------------------------------------------------ */

router.get('/servicing', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, policy_number, carrier_name, display_name, insured_first, insured_last,
            status, premium_required, premium_mode, next_premium_due, grace_period_days,
            face_amount, account_value, cash_surrender_value, cost_of_insurance,
            value_as_of, date_of_last_withdrawal,
            (next_premium_due - CURRENT_DATE) AS days_until_due
       FROM policy_latest
      WHERE status NOT IN ('Lapsed','Sold','Matured')
      ORDER BY next_premium_due NULLS LAST`
  );

  const alerts = [];
  for (const p of rows) {
    const name = p.display_name || `${p.insured_first || ''} ${p.insured_last || ''}`.trim();
    const d = p.days_until_due;

    if (d !== null && d < 0) {
      alerts.push({ ...p, insured: name, severity: 'critical',
        reason: `Premium was due ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago` });
    } else if (d !== null && d <= 14) {
      alerts.push({ ...p, insured: name, severity: 'warning',
        reason: `Premium due in ${d} day${d === 1 ? '' : 's'}` });
    } else if (d !== null && d <= 45) {
      alerts.push({ ...p, insured: name, severity: 'info',
        reason: `Premium due in ${d} days` });
    }

    // Months of coverage the account value can absorb at the current COI.
    const coi = Number(p.cost_of_insurance) || 0;
    const av = Number(p.account_value) || 0;
    if (coi > 0) {
      const months = av / coi;
      if (months < 3) {
        alerts.push({ ...p, insured: name, severity: 'critical',
          reason: `Account value covers only ${months.toFixed(1)} months of cost of insurance` });
      } else if (months < 6) {
        alerts.push({ ...p, insured: name, severity: 'serious',
          reason: `Account value covers ${months.toFixed(1)} months of cost of insurance` });
      }
    }

    // Stale carrier data.
    if (p.value_as_of) {
      const days = Math.floor((Date.now() - new Date(p.value_as_of).getTime()) / 86400000);
      if (days > 120)
        alerts.push({ ...p, insured: name, severity: 'info',
          reason: `No value update in ${days} days` });
    } else {
      alerts.push({ ...p, insured: name, severity: 'info',
        reason: 'No value snapshot recorded yet' });
    }
  }

  const rank = { critical: 0, serious: 1, warning: 2, info: 3 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
  res.json({ upcoming: rows.filter((r) => r.next_premium_due), alerts });
}));

/* ------------------------------------------------------------------ *
 * lookup helpers used by create/import
 * ------------------------------------------------------------------ */

export async function resolveFund(body) {
  if (body.fund_id) return int(body.fund_id);
  const code = str(body.fund_code || body.owner || body.fund);
  if (!code) return null;
  const { rows } = await q(
    `INSERT INTO funds (code, name) VALUES ($1,$1)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    [code]
  );
  return rows[0].id;
}

export async function resolveInsured(body) {
  if (body.insured_id) return int(body.insured_id);

  let first = str(body.insured_first_name || body.first_name);
  let last = str(body.insured_last_name || body.last_name);
  const display = str(body.insured_name || body.display_name || body.primary_insured);

  // "Wolfe, Dean & Cheryl"  ->  last "Wolfe", first "Dean & Cheryl"
  if (!last && display.includes(',')) {
    const [l, f] = display.split(',');
    last = str(l);
    first = str(f);
  } else if (!last && display) {
    const parts = display.split(/\s+/);
    last = parts.pop();
    first = parts.join(' ');
  }
  if (!first && !last && !display) return null;

  const dob = date(body.dob || body.insured_dob);
  const { rows: found } = await q(
    `SELECT id FROM insureds
      WHERE lower(last_name) = lower($1)
        AND lower(first_name) = lower($2)
        AND ($3::date IS NULL OR dob IS NULL OR dob = $3::date)
      LIMIT 1`,
    [last, first, dob]
  );
  if (found[0]) return found[0].id;

  const { rows } = await q(
    `INSERT INTO insureds (first_name, last_name, display_name, dob, gender, state, le_months)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [first, last, display || `${first} ${last}`.trim(), dob,
     str(body.gender) || null, str(body.state) || null, int(body.le_months)]
  );
  return rows[0].id;
}

/* ------------------------------------------------------------------ *
 * audit trail
 * ------------------------------------------------------------------ */

router.get('/audit', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 300`
  );
  res.json(rows);
}));

export default router;
export { wrap, num, int, str };
