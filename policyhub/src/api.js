import express from 'express';
import { q, audit } from './db.js';
import { requireAuth, requireRole, login, changePassword, createUser, clearToken } from './auth.js';

const router = express.Router();
const canEdit = requireRole('admin', 'editor');
/** Internal staff. Investors are deliberately excluded from every one of these. */
const staffOnly = requireRole('admin', 'editor', 'viewer');

/* ------------------------------------------------------------------ *
 * Investor scoping
 *
 * An investor login may only ever reach policies it holds a percentage
 * of. That is enforced here, in the SQL, rather than in the UI — every
 * read endpoint passes `scopeId(req)` into an EXISTS check. A null scope
 * (staff) matches everything.
 * ------------------------------------------------------------------ */

const isInvestor = (req) => req.user?.role === 'investor';
const scopeId = (req) => (isInvestor(req) ? Number(req.user.iid) || -1 : null);

/** SQL fragment restricting `<policyCol>` to the scoped investor's holdings. */
const ownedBy = (policyCol, paramIndex) =>
  `($${paramIndex}::int IS NULL OR EXISTS (
      SELECT 1 FROM policy_investors pix
       WHERE pix.policy_id = ${policyCol} AND pix.investor_id = $${paramIndex}))`;

/** The investor's percentage of a policy, or 100 for staff (whole book). */
const shareOf = (policyCol, paramIndex) =>
  `COALESCE((SELECT pix.pct FROM policy_investors pix
              WHERE pix.policy_id = ${policyCol} AND pix.investor_id = $${paramIndex}), 100)`;

/** Blocks investors from staff-only routes with a clear message. */
function blockInvestors(req, res, next) {
  if (isInvestor(req))
    return res.status(403).json({ error: 'Not available on an investor account' });
  next();
}

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
router.get('/auth/me', requireAuth, wrap(async (req, res) => {
  const out = { id: req.user.uid, email: req.user.email, name: req.user.name, role: req.user.role };
  if (req.user.role === 'investor' && req.user.iid) {
    const { rows } = await q('SELECT id, name FROM investors WHERE id = $1', [req.user.iid]);
    out.investor = rows[0] || null;
  }
  res.json(out);
}));
router.post('/auth/password', requireAuth, wrap(changePassword));
router.get('/users', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.last_login_at,
            u.investor_id, i.name AS investor_name
       FROM users u LEFT JOIN investors i ON i.id = u.investor_id
      ORDER BY u.id`
  );
  res.json(rows);
}));
router.post('/users', requireAuth, requireRole('admin'), wrap(createUser));

router.use(requireAuth); // everything below requires a session

/* ------------------------------------------------------------------ *
 * funds
 * ------------------------------------------------------------------ */

router.get('/funds', blockInvestors, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT f.*,
            COUNT(p.id)::int AS policy_count,
            COALESCE(SUM(COALESCE(pl.death_benefit, p.face_amount)), 0) AS total_death_benefit,
            COALESCE(SUM(pl.total_invested), 0) AS total_invested
       FROM funds f
       LEFT JOIN policies p ON p.fund_id = f.id
                           AND p.status NOT IN ('Lapsed','Sold','Matured')
       LEFT JOIN policy_latest pl ON pl.id = p.id
      GROUP BY f.id
      ORDER BY f.code`
  );
  res.json(rows);
}));

router.post('/funds', blockInvestors, canEdit, wrap(async (req, res) => {
  const code = str(req.body.code);
  if (!code) return res.status(400).json({ error: 'A code is required' });
  const { rows } = await q(
    `INSERT INTO funds (code, name, notes) VALUES ($1,$2,$3)
     ON CONFLICT (code) DO UPDATE SET
       name  = COALESCE(NULLIF(EXCLUDED.name,''),  funds.name),
       notes = COALESCE(NULLIF(EXCLUDED.notes,''), funds.notes)
     RETURNING *`,
    [code, str(req.body.name), str(req.body.notes)]
  );
  await audit(req.user.uid, 'fund', rows[0].id, 'create', code);
  res.status(201).json(rows[0]);
}));

router.put('/funds/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const code = str(req.body.code);
  if (!code) return res.status(400).json({ error: 'A code is required' });
  try {
    const { rows } = await q(
      `UPDATE funds SET code = $1, name = $2, notes = $3 WHERE id = $4 RETURNING *`,
      [code, str(req.body.name), str(req.body.notes), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Entity not found' });
    await audit(req.user.uid, 'fund', rows[0].id, 'update', code);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'Another entity already uses that code' });
    throw e;
  }
}));

/** Refuses to orphan policies — reassign them first. */
router.delete('/funds/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const { rows: used } = await q(
    'SELECT COUNT(*)::int AS n FROM policies WHERE fund_id = $1', [req.params.id]
  );
  if (used[0].n > 0)
    return res.status(409).json({
      error: `${used[0].n} ${used[0].n === 1 ? 'policy is' : 'policies are'} still owned by this entity. ` +
             'Reassign them to another owner first.' });

  const { rows } = await q('DELETE FROM funds WHERE id = $1 RETURNING code', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Entity not found' });
  await audit(req.user.uid, 'fund', Number(req.params.id), 'delete', rows[0].code);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * insureds
 * ------------------------------------------------------------------ */

router.get('/insureds', wrap(async (req, res) => {
  const search = str(req.query.search);
  const scope = scopeId(req);
  const { rows } = await q(
    `SELECT i.*, COUNT(p.id)::int AS policy_count
       FROM insureds i
       JOIN policies p ON p.insured_id = i.id AND ${ownedBy('p.id', 2)}
      WHERE ($1 = '' OR i.first_name ILIKE '%'||$1||'%' OR i.last_name ILIKE '%'||$1||'%'
             OR i.display_name ILIKE '%'||$1||'%')
      GROUP BY i.id ORDER BY i.last_name, i.first_name`,
    [search, scope]
  );
  res.json(rows);
}));

router.get('/insureds/:id', wrap(async (req, res) => {
  const scope = scopeId(req);
  const { rows } = await q(
    `SELECT i.* FROM insureds i
      WHERE i.id = $1
        AND ($2::int IS NULL OR EXISTS (
              SELECT 1 FROM policies p
               WHERE p.insured_id = i.id AND ${ownedBy('p.id', 2)}))`,
    [req.params.id, scope]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insured not found' });
  const pol = await q(
    `SELECT pl.* FROM policy_latest pl
      WHERE pl.insured_id = $1 AND ${ownedBy('pl.id', 2)}`,
    [req.params.id, scope]
  );
  res.json({ ...rows[0], policies: pol.rows });
}));

router.post('/insureds', blockInvestors, canEdit, wrap(async (req, res) => {
  const { cols, vals } = buildSet(INSURED_FIELDS, req.body);
  if (!cols.length) return res.status(400).json({ error: 'No fields supplied' });
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q(
    `INSERT INTO insureds (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals
  );
  await audit(req.user.uid, 'insured', rows[0].id, 'create', rows[0].last_name);
  res.status(201).json(rows[0]);
}));

router.put('/insureds/:id', blockInvestors, canEdit, wrap(async (req, res) => {
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
  const scope = scopeId(req);
  const { rows } = await q(
    `SELECT pl.*, ${shareOf('pl.id', 4)} AS my_pct
       FROM policy_latest pl
      WHERE ($1 = '' OR pl.policy_number ILIKE '%'||$1||'%'
             OR pl.carrier_name ILIKE '%'||$1||'%'
             OR pl.insured_last ILIKE '%'||$1||'%'
             OR pl.insured_first ILIKE '%'||$1||'%'
             OR pl.display_name ILIKE '%'||$1||'%')
        AND ($2 = '' OR pl.status = $2)
        AND ($3 = '' OR pl.fund_code = $3)
        AND ${ownedBy('pl.id', 4)}
      ORDER BY pl.insured_last, pl.insured_first, pl.policy_number`,
    [search, status, fund, scope]
  );
  res.json(rows);
}));

router.get('/policies/:id', wrap(async (req, res) => {
  const scope = scopeId(req);
  const { rows } = await q(
    `SELECT pl.*, ${shareOf('pl.id', 2)} AS my_pct
       FROM policy_latest pl
      WHERE pl.id = $1 AND ${ownedBy('pl.id', 2)}`,
    [req.params.id, scope]
  );
  // A policy the investor doesn't hold is reported as missing, not forbidden —
  // "forbidden" would confirm it exists.
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
  const [values, txns, extra] = await Promise.all([
    q('SELECT * FROM policy_values WHERE policy_id = $1 ORDER BY as_of_date DESC', [req.params.id]),
    q('SELECT * FROM transactions WHERE policy_id = $1 ORDER BY txn_date DESC, id DESC', [req.params.id]),
    q(`SELECT pi.id AS link_id, pi.role, pi.notes AS link_notes, i.*
         FROM policy_insureds pi JOIN insureds i ON i.id = pi.insured_id
        WHERE pi.policy_id = $1 ORDER BY pi.id`, [req.params.id]),
  ]);
  // Staff see the whole cap table; an investor sees only their own line.
  const owners = await q(
    `SELECT pi.id, pi.pct, pi.acquired_on, pi.notes,
            i.id AS investor_id, i.name, i.investor_type
       FROM policy_investors pi JOIN investors i ON i.id = pi.investor_id
      WHERE pi.policy_id = $1 AND ($2::int IS NULL OR pi.investor_id = $2)
      ORDER BY pi.pct DESC, i.name`,
    [req.params.id, scope]
  );

  res.json({
    ...rows[0],
    values: values.rows,
    transactions: txns.rows,
    additionalInsureds: extra.rows,
    owners: owners.rows,
  });
}));

/* ---- additional lives on a policy (survivorship / joint) ---- */

router.post('/policies/:id/insureds', blockInvestors, canEdit, wrap(async (req, res) => {
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

router.delete('/policy-insureds/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const { rowCount } = await q('DELETE FROM policy_insureds WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  await audit(req.user.uid, 'policy_insured', req.params.id, 'delete', '');
  res.json({ ok: true });
}));

router.post('/policies', blockInvestors, canEdit, wrap(async (req, res) => {
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

router.put('/policies/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const body = { ...req.body };
  if (body.insured_name || body.insured_last_name) body.insured_id = await resolveInsured(body);
  // Present-but-empty means "no owner", so test for the key rather than truthiness.
  if ('fund_code' in body || 'fund_id' in body) body.fund_id = await resolveFund(body);
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

/**
 * Hard delete. Cascades to value snapshots, transactions and additional-insured
 * links, so the audit entry captures what was destroyed before it goes — the
 * activity log is the only remaining record afterwards.
 */
router.delete('/policies/:id', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT p.*, i.first_name, i.last_name,
            (SELECT COUNT(*)::int FROM policy_values v WHERE v.policy_id = p.id) AS value_count,
            (SELECT COUNT(*)::int FROM transactions t WHERE t.policy_id = p.id) AS txn_count,
            (SELECT COALESCE(SUM(amount),0) FROM transactions t WHERE t.policy_id = p.id) AS invested
       FROM policies p LEFT JOIN insureds i ON i.id = p.insured_id
      WHERE p.id = $1`,
    [req.params.id]
  );
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Policy not found' });

  // Typed confirmation must match the policy number exactly.
  if (str(req.body?.confirm) !== str(p.policy_number))
    return res.status(400).json({ error: 'Confirmation text does not match the policy number' });

  await q('DELETE FROM policies WHERE id = $1', [req.params.id]);
  await audit(req.user.uid, 'policy', Number(req.params.id), 'delete',
    `${p.policy_number} · ${p.carrier_name} · ${[p.last_name, p.first_name].filter(Boolean).join(', ')} · ` +
    `face ${p.face_amount} · ${p.value_count} value snapshots · ${p.txn_count} transactions · ` +
    `${p.invested} invested`);

  res.json({ ok: true, deleted: {
    policy_number: p.policy_number, values: p.value_count, transactions: p.txn_count } });
}));

/* ------------------------------------------------------------------ *
 * value snapshots
 * ------------------------------------------------------------------ */

router.post('/policies/:id/values', blockInvestors, canEdit, wrap(async (req, res) => {
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

router.delete('/values/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  await q('DELETE FROM policy_values WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * transactions
 * ------------------------------------------------------------------ */

router.post('/policies/:id/transactions', blockInvestors, canEdit, wrap(async (req, res) => {
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

router.delete('/transactions/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  await q('DELETE FROM transactions WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * portfolio analytics
 * ------------------------------------------------------------------ */

router.get('/analytics/summary', wrap(async (req, res) => {
  const scope = scopeId(req);
  // For an investor every money figure is multiplied by their percentage, so
  // the dashboard reads as *their* portfolio rather than the whole book.
  const w = `(${shareOf('pl.id', 1)} / 100.0)`;

  const [totals, byCarrier, invested, ages] = await Promise.all([
    q(`SELECT
         COUNT(*)::int                                            AS policy_count,
         COUNT(*) FILTER (WHERE pl.status = 'Inforce')::int        AS inforce_count,
         COALESCE(SUM(pl.face_amount * ${w}),0)                    AS total_face,
         COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS total_death_benefit,
         COALESCE(SUM(pl.cash_surrender_value * ${w}),0)           AS total_csv,
         COALESCE(SUM(pl.account_value * ${w}),0)                  AS total_av,
         COALESCE(SUM(pl.total_invested * ${w}),0)                 AS total_invested,
         COALESCE(SUM(pl.total_acquisition * ${w}),0)              AS total_acquisition,
         COALESCE(SUM(pl.total_premiums * ${w}),0)                 AS total_premiums,
         COALESCE(SUM(pl.cost_of_insurance * ${w}),0)              AS monthly_coi
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND ${ownedBy('pl.id', 1)}`, [scope]),
    q(`SELECT pl.carrier_name, COUNT(*)::int AS n,
              COALESCE(SUM(pl.face_amount * ${w}),0) AS face
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND ${ownedBy('pl.id', 1)}
        GROUP BY pl.carrier_name ORDER BY face DESC`, [scope]),
    q(`SELECT to_char(date_trunc('month', t.txn_date),'YYYY-MM') AS month,
              SUM(t.amount * (COALESCE((SELECT pix.pct FROM policy_investors pix
                    WHERE pix.policy_id = t.policy_id AND pix.investor_id = $1), 100) / 100.0)) AS amount
         FROM transactions t
        WHERE t.txn_type IN ('Acquisition Cost','Premium Payment','Fee','Servicing','Commission')
          AND ${ownedBy('t.policy_id', 1)}
        GROUP BY 1 ORDER BY 1`, [scope]),
    q(`SELECT
         COALESCE(AVG(EXTRACT(YEAR FROM age(pl.insured_dob))),0) AS avg_age,
         COUNT(*) FILTER (WHERE pl.insured_dob IS NOT NULL)::int AS with_dob
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND ${ownedBy('pl.id', 1)}`, [scope]),
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
    scopedToInvestor: scope !== null,
  });
}));

/* ------------------------------------------------------------------ *
 * servicing calendar + lapse risk
 * ------------------------------------------------------------------ */

router.get('/servicing', wrap(async (req, res) => {
  const scope = scopeId(req);
  const { rows } = await q(
    `SELECT pl.id, pl.policy_number, pl.carrier_name, pl.display_name,
            pl.insured_first, pl.insured_last,
            pl.status, pl.premium_mode, pl.next_premium_due, pl.grace_period_days,
            pl.face_amount, pl.account_value, pl.cash_surrender_value, pl.cost_of_insurance,
            pl.value_as_of, pl.date_of_last_withdrawal,
            ${shareOf('pl.id', 1)} AS my_pct,
            pl.premium_required * (${shareOf('pl.id', 1)} / 100.0) AS premium_required,
            pl.premium_required AS premium_required_full,
            (pl.next_premium_due - CURRENT_DATE) AS days_until_due
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND ${ownedBy('pl.id', 1)}
      ORDER BY pl.next_premium_due NULLS LAST`,
    [scope]
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
 * investors and fractional ownership
 * ------------------------------------------------------------------ */

const INVESTOR_FIELDS = {
  name: str, legal_name: str, investor_type: str, email: str,
  phone: str, tax_id_last4: str, notes: str,
};

router.get('/investors', blockInvestors, staffOnly, wrap(async (req, res) => {
  const search = str(req.query.search);
  const { rows } = await q(
    `SELECT inv.*,
            COUNT(pi.id)::int AS position_count,
            COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * pi.pct / 100.0), 0) AS death_benefit,
            COALESCE(SUM(pl.total_invested * pi.pct / 100.0), 0) AS invested,
            COALESCE(SUM(pl.cash_surrender_value * pi.pct / 100.0), 0) AS csv
       FROM investors inv
       LEFT JOIN policy_investors pi ON pi.investor_id = inv.id
       LEFT JOIN policy_latest pl ON pl.id = pi.policy_id
                                 AND pl.status NOT IN ('Lapsed','Sold','Matured')
      WHERE ($1 = '' OR inv.name ILIKE '%'||$1||'%' OR inv.legal_name ILIKE '%'||$1||'%'
             OR inv.email ILIKE '%'||$1||'%')
      GROUP BY inv.id ORDER BY inv.name`,
    [search]
  );
  res.json(rows);
}));

router.get('/investors/:id', blockInvestors, staffOnly, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM investors WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Investor not found' });
  const positions = await q(
    `SELECT pi.id AS link_id, pi.pct, pi.acquired_on, pi.notes AS link_notes,
            pl.id, pl.policy_number, pl.carrier_name, pl.product_type, pl.status,
            pl.insured_first, pl.insured_last, pl.display_name, pl.fund_code,
            pl.face_amount, pl.death_benefit, pl.cash_surrender_value,
            pl.account_value, pl.cost_of_insurance, pl.premium_required,
            pl.total_invested
       FROM policy_investors pi JOIN policy_latest pl ON pl.id = pi.policy_id
      WHERE pi.investor_id = $1
      ORDER BY pl.insured_last, pl.policy_number`,
    [req.params.id]
  );
  const logins = await q(
    'SELECT id, email, full_name, is_active, last_login_at FROM users WHERE investor_id = $1',
    [req.params.id]
  );
  res.json({ ...rows[0], positions: positions.rows, logins: logins.rows });
}));

router.post('/investors', blockInvestors, canEdit, wrap(async (req, res) => {
  if (!str(req.body.name)) return res.status(400).json({ error: 'A name is required' });
  const { cols, vals } = buildSet(INVESTOR_FIELDS, req.body);
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q(
    `INSERT INTO investors (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals
  );
  await audit(req.user.uid, 'investor', rows[0].id, 'create', rows[0].name);
  res.status(201).json(rows[0]);
}));

router.put('/investors/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const { sets, vals, next } = buildSet(INVESTOR_FIELDS, req.body);
  if (!sets.length) return res.status(400).json({ error: 'No fields supplied' });
  const { rows } = await q(
    `UPDATE investors SET ${sets.join(',')}, updated_at = now() WHERE id = $${next} RETURNING *`,
    [...vals, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Investor not found' });
  await audit(req.user.uid, 'investor', rows[0].id, 'update', rows[0].name);
  res.json(rows[0]);
}));

router.delete('/investors/:id', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const [{ rows: pos }, { rows: usr }] = await Promise.all([
    q('SELECT COUNT(*)::int AS n FROM policy_investors WHERE investor_id = $1', [req.params.id]),
    q('SELECT COUNT(*)::int AS n FROM users WHERE investor_id = $1', [req.params.id]),
  ]);
  if (pos[0].n > 0)
    return res.status(409).json({
      error: `This investor holds ${pos[0].n} position${pos[0].n === 1 ? '' : 's'}. Remove them first.` });
  if (usr[0].n > 0)
    return res.status(409).json({
      error: 'A login is still attached to this investor. Remove the login first.' });
  const { rows } = await q('DELETE FROM investors WHERE id = $1 RETURNING name', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Investor not found' });
  await audit(req.user.uid, 'investor', Number(req.params.id), 'delete', rows[0].name);
  res.json({ ok: true });
}));

/* ---- allocations on a policy ---- */

/** Total already allocated on a policy, optionally ignoring one row. */
async function allocatedPct(policyId, excludeLinkId = null) {
  const { rows } = await q(
    `SELECT COALESCE(SUM(pct),0) AS total FROM policy_investors
      WHERE policy_id = $1 AND ($2::int IS NULL OR id <> $2)`,
    [policyId, excludeLinkId]
  );
  return Number(rows[0].total) || 0;
}

router.post('/policies/:id/investors', blockInvestors, canEdit, wrap(async (req, res) => {
  const investorId = int(req.body.investor_id);
  const pct = num(req.body.pct);
  if (!investorId) return res.status(400).json({ error: 'Choose an investor' });
  if (pct === null || pct <= 0 || pct > 100)
    return res.status(400).json({ error: 'Percentage must be between 0 and 100' });

  const already = await allocatedPct(req.params.id);
  if (already + pct > 100.000001)
    return res.status(400).json({
      error: `That would allocate ${(already + pct).toFixed(4)}%. Only ${(100 - already).toFixed(4)}% is unallocated.` });

  try {
    const { rows } = await q(
      `INSERT INTO policy_investors (policy_id, investor_id, pct, acquired_on, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, investorId, pct, date(req.body.acquired_on), str(req.body.notes)]
    );
    await audit(req.user.uid, 'policy_investor', rows[0].id, 'create',
      `policy ${req.params.id} · investor ${investorId} · ${pct}%`);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'That investor already holds a piece of this policy' });
    throw e;
  }
}));

router.put('/policy-investors/:linkId', blockInvestors, canEdit, wrap(async (req, res) => {
  const pct = num(req.body.pct);
  if (pct === null || pct <= 0 || pct > 100)
    return res.status(400).json({ error: 'Percentage must be between 0 and 100' });
  const { rows: cur } = await q('SELECT * FROM policy_investors WHERE id = $1', [req.params.linkId]);
  if (!cur[0]) return res.status(404).json({ error: 'Allocation not found' });

  const others = await allocatedPct(cur[0].policy_id, cur[0].id);
  if (others + pct > 100.000001)
    return res.status(400).json({
      error: `That would allocate ${(others + pct).toFixed(4)}%. Only ${(100 - others).toFixed(4)}% is available.` });

  const { rows } = await q(
    `UPDATE policy_investors SET pct = $1, acquired_on = $2, notes = $3
      WHERE id = $4 RETURNING *`,
    [pct, date(req.body.acquired_on), str(req.body.notes), req.params.linkId]
  );
  await audit(req.user.uid, 'policy_investor', rows[0].id, 'update', `${pct}%`);
  res.json(rows[0]);
}));

router.delete('/policy-investors/:linkId', blockInvestors, canEdit, wrap(async (req, res) => {
  const { rows } = await q('DELETE FROM policy_investors WHERE id = $1 RETURNING *', [req.params.linkId]);
  if (!rows[0]) return res.status(404).json({ error: 'Allocation not found' });
  await audit(req.user.uid, 'policy_investor', Number(req.params.linkId), 'delete',
    `policy ${rows[0].policy_id} · investor ${rows[0].investor_id}`);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * reports
 * ------------------------------------------------------------------ */

const MODE_MONTHS = { Monthly: 1, Quarterly: 3, 'Semi-Annual': 6, Annual: 12 };

/**
 * Projects each active policy's premium payments forward and groups them by
 * calendar month. A due date already in the past is reported in the current
 * month and flagged overdue rather than silently rolled forward.
 */
router.get('/reports/premium-forecast', wrap(async (req, res) => {
  const months = Math.min(60, Math.max(1, parseInt(req.query.months, 10) || 24));
  const fund = str(req.query.fund);

  const scope = scopeId(req);
  const { rows } = await q(
    `SELECT pl.id, pl.policy_number, pl.carrier_name, pl.display_name,
            pl.insured_first, pl.insured_last,
            pl.fund_code, pl.premium_mode, pl.next_premium_due, pl.status,
            pl.face_amount, pl.cost_of_insurance, pl.account_value,
            ${shareOf('pl.id', 2)} AS my_pct,
            pl.premium_required * (${shareOf('pl.id', 2)} / 100.0) AS premium_required
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
        AND ($1 = '' OR pl.fund_code = $1)
        AND ${ownedBy('pl.id', 2)}
      ORDER BY pl.insured_last, pl.insured_first`,
    [fund, scope]
  );

  const now = new Date();
  const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const horizon = new Date(startMonth);
  horizon.setUTCMonth(horizon.getUTCMonth() + months);

  const buckets = new Map();
  const monthKey = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  for (let i = 0; i < months; i++) {
    const d = new Date(startMonth);
    d.setUTCMonth(d.getUTCMonth() + i);
    buckets.set(monthKey(d), { month: monthKey(d), total: 0, payments: [] });
  }

  const noSchedule = [];
  for (const p of rows) {
    const amount = Number(p.premium_required) || 0;
    const step = MODE_MONTHS[p.premium_mode] || 12;
    const insured = p.display_name ||
      `${p.insured_first || ''} ${p.insured_last || ''}`.trim() || '—';

    if (!amount || !p.next_premium_due) {
      noSchedule.push({ ...p, insured,
        reason: !amount ? 'No premium amount recorded' : 'No next due date recorded' });
      continue;
    }

    let due = new Date(`${String(p.next_premium_due).slice(0, 10)}T00:00:00Z`);
    let overdue = false;
    if (due < startMonth) {
      overdue = true;                       // surface it now, don't skip it
      due = new Date(startMonth);
    }
    let guard = 0;
    while (due < horizon && guard++ < 240) {
      const b = buckets.get(monthKey(due));
      if (b) {
        b.total += amount;
        b.payments.push({
          policy_id: p.id, policy_number: p.policy_number, carrier_name: p.carrier_name,
          insured, fund_code: p.fund_code, amount, mode: p.premium_mode,
          due_date: due.toISOString().slice(0, 10), overdue,
        });
      }
      overdue = false;
      due.setUTCMonth(due.getUTCMonth() + step);
    }
  }

  const schedule = [...buckets.values()];
  let running = 0;
  for (const b of schedule) { running += b.total; b.cumulative = running; }

  res.json({
    months,
    generatedAt: new Date().toISOString(),
    schedule,
    grandTotal: running,
    policiesScheduled: rows.length - noSchedule.length,
    noSchedule,
  });
}));

/** Everything a portfolio summary needs that /analytics/summary doesn't cover. */
router.get('/reports/portfolio', wrap(async (req, res) => {
  const fund = str(req.query.fund);
  const scope = scopeId(req);
  const w = `(${shareOf('pl.id', 2)} / 100.0)`;
  const [totals, byCarrier, byProduct, byFund, ages] = await Promise.all([
    q(`SELECT COUNT(*)::int AS policy_count,
              COALESCE(SUM(pl.face_amount * ${w}),0) AS total_face,
              COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS total_death_benefit,
              COALESCE(SUM(pl.cash_surrender_value * ${w}),0) AS total_csv,
              COALESCE(SUM(pl.account_value * ${w}),0) AS total_av,
              COALESCE(SUM(pl.total_invested * ${w}),0) AS total_invested,
              COALESCE(SUM(pl.total_acquisition * ${w}),0) AS total_acquisition,
              COALESCE(SUM(pl.total_premiums * ${w}),0) AS total_premiums,
              COALESCE(SUM(pl.cost_of_insurance * ${w}),0) AS monthly_coi,
              COALESCE(SUM(pl.premium_required * ${w}),0) AS annual_premium
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${ownedBy('pl.id', 2)}`, [fund, scope]),
    q(`SELECT pl.carrier_name, COUNT(*)::int AS n,
              COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS face
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${ownedBy('pl.id', 2)}
        GROUP BY pl.carrier_name ORDER BY face DESC`, [fund, scope]),
    q(`SELECT COALESCE(NULLIF(pl.product_type,''),'Unclassified') AS product_type,
              COUNT(*)::int AS n,
              COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS face
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${ownedBy('pl.id', 2)}
        GROUP BY 1 ORDER BY face DESC`, [fund, scope]),
    q(`SELECT COALESCE(pl.fund_code,'Unassigned') AS fund_code, COUNT(*)::int AS n,
              COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS face,
              COALESCE(SUM(pl.total_invested * ${w}),0) AS invested
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${ownedBy('pl.id', 2)}
        GROUP BY 1 ORDER BY face DESC`, [fund, scope]),
    q(`SELECT COALESCE(AVG(EXTRACT(YEAR FROM age(pl.insured_dob))),0) AS avg_age,
              COALESCE(MIN(EXTRACT(YEAR FROM age(pl.insured_dob))),0) AS min_age,
              COALESCE(MAX(EXTRACT(YEAR FROM age(pl.insured_dob))),0) AS max_age
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND pl.insured_dob IS NOT NULL
          AND ($1 = '' OR pl.fund_code = $1) AND ${ownedBy('pl.id', 2)}`, [fund, scope]),
  ]);

  res.json({
    generatedAt: new Date().toISOString(),
    totals: totals.rows[0],
    byCarrier: byCarrier.rows,
    byProduct: byProduct.rows,
    byFund: byFund.rows,
    ages: ages.rows[0],
    scopedToInvestor: scope !== null,
  });
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

router.get('/audit', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 300`
  );
  res.json(rows);
}));

export default router;
export { wrap, num, int, str };
