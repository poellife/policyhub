import express from 'express';
import { createHash } from 'node:crypto';
// The rate engine lives under public/ because the browser loads it too: the
// what-if calculator recomputes as you type, and a second implementation
// would eventually disagree with this one.
import { analyzeFlows, poolFlows, ledgerFlows, flowsAfterCarry, netOfCarry, carryOn, CARRY_PCT,
         today, OUTFLOW_TYPES } from '../public/irr.js';
import { analyseOpportunity, addMonths } from './opportunity-analysis.js';
import { cleanArrangement } from '../public/policy-fields.js';
import { recordExport, describeOrigin, clientIp } from './security.js';
import { sendMail, flushMail, mailReady, MAIL_KINDS, choosableKinds, appUrlProblem }
  from './mail.js';
// The agreement template is under public/ for the same reason the rate engine
// is: the browser renders it for preview, and a second copy of the clauses
// would eventually differ from the one that was signed.
import { renderAgreement, canonicalText, AGREEMENT_FIELDS } from '../public/agreement-template.js';
import { agreementPdf } from './agreement-pdf.js';
import { q, pool, audit } from './db.js';
import { authenticate, requireRole, login, changePassword,
         createUser, updateUser, deleteUser, resetPassword, clearToken,
         hashPassword } from './auth.js';
// A tax number is the one field here that is encrypted rather than merely
// scoped: see the file for why, and for how the key is chosen.
import { sealField, openField, digitsOf, maskTaxId } from './secret-field.js';

const router = express.Router();
const canEdit = requireRole('admin', 'editor', 'manager');
const adminOrManager = requireRole('admin', 'manager');
/** Internal staff. Investors are deliberately excluded from every one of these. */
const staffOnly = requireRole('admin', 'editor', 'viewer', 'manager');

/* ------------------------------------------------------------------ *
 * Investor scoping
 *
 * An investor login may only ever reach policies it holds a percentage
 * of. That is enforced here, in the SQL, rather than in the UI — every
 * read endpoint passes `scopeId(req)` into an EXISTS check. A null scope
 * (staff) matches everything.
 * ------------------------------------------------------------------ */

const isInvestor = (req) => req.user?.role === 'investor';
const isManager  = (req) => req.user?.role === 'manager';

/**
 * Two independent visibility scopes, never both active on one account:
 *   inv   — an investor sees only policies they hold a percentage of
 *   funds — a portfolio manager sees only policies owned by their entities
 * Both null for admin / editor / viewer, which means "the whole book".
 */
const scopeId = (req) => (isInvestor(req) ? Number(req.user.iid) || -1 : null);
const fundScope = (req) =>
  isManager(req) ? (req.user.fundIds && req.user.fundIds.length ? req.user.fundIds : [-1]) : null;

/**
 * Investors an administrator has put in this manager's hands by name.
 *
 * Null for anybody who is not a manager, meaning "no extra grants" rather
 * than "everybody" — it is only ever OR-ed with the entity scope, so a null
 * here can never widen an admin's or an investor's view.
 */
const grantedInvestors = (req) =>
  isManager(req) && req.user.investorIds?.length ? req.user.investorIds : null;

/**
 * Which of these investors is this caller allowed to name?
 *
 * Reading a directory and writing a name into it are different acts, and a
 * manager should not be able to hand a deal to — or allocate a policy to —
 * an investor they have no relationship with, even though guessing an id
 * costs nothing. Returns the ids that are out of bounds; empty means fine.
 */
async function investorsOutOfScope(req, ids) {
  if (!isManager(req) || !ids.length) return [];
  const { rows } = await q(
    `SELECT inv.id FROM investors inv
      WHERE inv.id = ANY($1)
        AND inv.id <> ALL(COALESCE($3::int[], '{}'))
        AND NOT EXISTS (SELECT 1 FROM policy_investors pj JOIN policies pp ON pp.id = pj.policy_id
                         WHERE pj.investor_id = inv.id AND pp.fund_id = ANY($2))`,
    [ids, fundScope(req), grantedInvestors(req)]);
  return rows.map((r) => r.id);
}

/**
 * WHERE fragment limiting a row to what the caller may see.
 * `iP` is the investor-scope parameter index, `fP` the fund-scope one.
 */
const visibleTo = (policyCol, fundCol, iP, fP) =>
  `(($${iP}::int IS NULL OR EXISTS (
        SELECT 1 FROM policy_investors pix
         WHERE pix.policy_id = ${policyCol} AND pix.investor_id = $${iP}))
    AND ($${fP}::int[] IS NULL OR ${fundCol} = ANY($${fP})))`;

/** Back-compat shorthand where the fund column is the standard one. */
const ownedBy = (policyCol, iP, fP = null, fundCol = null) =>
  fP === null
    ? `($${iP}::int IS NULL OR EXISTS (
         SELECT 1 FROM policy_investors pix
          WHERE pix.policy_id = ${policyCol} AND pix.investor_id = $${iP}))`
    : visibleTo(policyCol, fundCol, iP, fP);

/** The investor's percentage of a policy, or 100 for everyone else. */
const shareOf = (policyCol, paramIndex) =>
  `COALESCE((SELECT pix.pct FROM policy_investors pix
              WHERE pix.policy_id = ${policyCol} AND pix.investor_id = $${paramIndex}), 100)`;

/* ------------------------------------------------------------------ *
 * Carried interest, in SQL
 *
 * The managing partner takes CARRY_PCT of the profit on each case, and an
 * investor is shown what is left. Every figure that represents money coming
 * BACK to them passes through this; nothing they have paid in is touched.
 *
 * Staff see the gross figures. `scopeParam` is the investor id, which is
 * NULL for everybody else, so the same query serves both without a second
 * code path — and an investor can never be served the staff branch by
 * accident, because the parameter that decides it is the same one that
 * decides what they are allowed to see at all.
 *
 * Carry is linear in the size of a holding, so it does not matter whether
 * the share weighting is applied before or after. These fragments work on
 * whole-policy columns and are multiplied by the share afterwards.
 * ------------------------------------------------------------------ */

/**
 * @param gross  what comes back — a death benefit, or a claim actually paid
 * @param basis  every dollar that went out on that policy
 * @param scopeParam  $n holding the investor id, NULL for staff
 */
/* The rate for the entity that holds the policy. Carried interest is a term
   of an operating agreement and not every entity has one — some books are
   managed for a fee instead — so the rate belongs to the entity. A policy in
   no entity has no agreement to charge under and carries none. */
const carryRate = (fundCol = 'pl.fund_id') =>
  `COALESCE((SELECT fx.carry_pct FROM funds fx WHERE fx.id = ${fundCol}), 0)`;

const afterCarry = (gross, basis, scopeParam, fundCol = 'pl.fund_id') => `
  CASE WHEN $${scopeParam}::int IS NULL THEN (${gross})
       ELSE (${gross}) - (${carryRate(fundCol)} / 100.0)
            * GREATEST(0, COALESCE(${gross}, 0) - COALESCE(${basis}, 0))
  END`;

/**
 * What the managing partner's share comes to on one policy — for us, not
 * for them. The investor's screens show their figures with this already
 * taken out and never name it; ours show the amount itself.
 *
 * `flows` must be the GROSS flows, which is what `portfolioFlows` builds for
 * a staff caller. `earned` says whether the claim was actually collected:
 * carry on a policy still running is what WOULD be due if it matured today,
 * and the two must not be added together as though they were the same money.
 */
function policyCarry(flows, { earned = false } = {}) {
  const a = analyzeFlows(flows || []);
  const carry = carryOn(a.returned, a.invested);
  return {
    basis: a.invested,
    gross_return: a.returned,
    gross_profit: a.profit,
    carry,
    net_return: a.returned - carry,
    net_profit: a.profit - carry,
    earned,
  };
}

/** Blocks investors from routes meant for internal users. */
function blockInvestors(req, res, next) {
  if (isInvestor(req))
    return res.status(403).json({ error: 'Not available on an investor account' });
  next();
}

/** Blocks anyone who isn't full internal staff — used for the Settings surface. */
function blockScoped(req, res, next) {
  if (isInvestor(req) || isManager(req))
    return res.status(403).json({ error: 'Not available on this account' });
  next();
}

/** A manager may only touch a policy inside one of their entities. */
async function assertPolicyInScope(req, policyId) {
  const funds = fundScope(req);
  if (funds === null) return true;
  const { rows } = await q('SELECT fund_id FROM policies WHERE id = $1', [policyId]);
  if (!rows[0]) return false;
  return funds.includes(rows[0].fund_id);
}

const wrapMw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Middleware form of the above, for routes carrying the policy id as :id. */
const inPolicyScope = (param = 'id') => wrapMw(async (req, res, next) => {
  if (await assertPolicyInScope(req, req.params[param])) return next();
  res.status(404).json({ error: 'Policy not found' });
});

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

/**
 * A link somebody will click. Only http and https survive: a stored
 * `javascript:` address would run in the reader's session the moment they
 * clicked it, so the scheme is checked here rather than trusted at render
 * time. A bare `dropbox.com/...` is read as https, since that is what the
 * person pasting it means.
 */
const url = (v) => {
  const s = str(v);
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href.slice(0, 2000);
};

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
  documents_url: url,
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

/* ------------------------------------------------------------------ *
 * investor registration
 *
 * The one route in this API that anybody on the internet can reach, so
 * it is written as if that is the case:
 *
 *   - it is throttled per address, on the same counter the sign-in form
 *     uses, so it cannot be used to grind or to flood the queue;
 *   - it answers the same way whether or not the mailbox is already
 *     known, because "that email already has an account" tells a
 *     stranger who our investors are;
 *   - it stores a hash of the chosen password and never the password;
 *   - the tax number is encrypted on the way in, and only its last four
 *     digits are readable afterwards without a deliberate, audited
 *     request by an administrator;
 *   - it creates nothing. No investor, no login, no access. All it does
 *     is put a form in front of somebody here.
 * ------------------------------------------------------------------ */

const INVESTOR_TYPES = ['Individual', 'Joint', 'Entity', 'Trust', 'IRA', 'Other'];
const APPLICATION_STATUSES = ['Pending', 'Approved', 'Declined'];

/** A tax number is nine digits, whether it is an SSN or an EIN. */
const looksLikeTaxId = (digits) => digits.length === 9;

router.post('/register', wrap(async (req, res) => {
  const ip = req.ip || 'unknown';
  if (await tooManyRegistrations(ip))
    return res.status(429).json({
      error: 'Too many registrations from this connection. Try again in a little while.' });

  const b = req.body || {};
  const email = str(b.email).toLowerCase();
  const password = String(b.password || '');
  const fullName = str(b.full_name);
  const problems = [];

  if (!fullName) problems.push('your name');
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) problems.push('a valid email address');
  if (password.length < 10) problems.push('a password of at least 10 characters');
  if (!str(b.phone)) problems.push('a phone number');
  if (!str(b.address_line1) || !str(b.city) || !str(b.state) || !str(b.postal_code))
    problems.push('your full home address');

  /* A tax number is NOT asked for at sign-up.
   *
   * It is needed eventually — a K-1 cannot be issued without one — but not to
   * open an account, and a stranger's first interaction with the firm is the
   * worst possible moment to ask for it: they are typing it into a form on a
   * site they have no reason to trust yet, over a connection nobody has
   * vouched for. It is collected afterwards, on the investor's own record,
   * once there is a relationship.
   *
   * The field is still accepted here if something sends one, because the
   * column and the encryption already exist and silently discarding a number
   * somebody deliberately supplied would be worse than storing it properly.
   * It is simply never required, and the form no longer asks. */
  const taxDigits = digitsOf(b.tax_id);
  if (taxDigits && !looksLikeTaxId(taxDigits))
    problems.push('a nine-digit Social Security number or tax ID, or none at all');

  if (problems.length)
    return res.status(400).json({ error: `Please give ${problems.join(', ')}.` });

  let sealed = null;
  if (taxDigits) {
    try {
      sealed = sealField(taxDigits);
    } catch (e) {
      /* The key is missing or malformed. Storing the number in the clear
         instead would be the worst possible response, so the form fails and
         says so plainly rather than quietly downgrading. */
      console.error('[register] tax id could not be encrypted:', e.message);
      return res.status(503).json({
        error: 'Registrations are temporarily unavailable. Please call the office.' });
    }
  }

  const hash = await hashPassword(password);
  const type = INVESTOR_TYPES.includes(str(b.investor_type)) ? str(b.investor_type) : 'Individual';

  /* An address that already has a login here is dropped on the floor. The
     sender is told nothing — the answer below is the same one everybody
     gets — because "that email already has an account" is precisely the
     fact a stranger would be fishing for. It also keeps the queue clean:
     an application nobody could ever approve is not work, it is noise. */
  const { rows: existing } = await q(
    'SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.length) {
    await noteRegistration(ip);
    return res.status(202).json({ ok: true });
  }

  try {
    const { rows } = await q(
      `INSERT INTO investor_applications
         (full_name, entity_name, investor_type, email, phone,
          address_line1, address_line2, city, state, postal_code, country,
          tax_id_enc, tax_id_last4, tax_id_key, password_hash, note, submitted_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [fullName, str(b.entity_name), type, email, str(b.phone),
       str(b.address_line1), str(b.address_line2), str(b.city), str(b.state),
       str(b.postal_code), str(b.country) || 'United States',
       /* Empty string, not null: `tax_id_last4` and `tax_id_key` are NOT NULL
          with a default, and an account opened without a number is the
          ordinary case now rather than the exception. */
       sealed?.ciphertext ?? null, taxDigits ? taxDigits.slice(-4) : '',
       sealed?.keyId ?? '', hash,
       str(b.note).slice(0, 1000), String(ip).slice(0, 64)]
    );
    await audit(null, 'application', rows[0].id, 'create', `${fullName} · ${email}`);
    /* Two messages, in opposite directions. The applicant is told we have it
       and that a person reads it, so the wait is a promise rather than a
       silence. The office is told somebody is waiting, so the queue does not
       depend on whoever happens to open the page. */
    await sendMail('registration_received', { to: email, name: fullName });
    await tellStaff('registration_new', await staffAudience({}), {
      name: fullName, email, entity: str(b.entity_name),
      when: new Date().toISOString().replace('T', ' ').slice(0, 16),
    });
  } catch (e) {
    /* A second application from the same mailbox, or an account that
       already exists. Neither is told to the sender: an error that
       distinguishes "already registered" from "not registered" turns this
       form into a way of testing whether somebody is a client of ours. */
    if (e.code !== '23505') throw e;
  }

  await noteRegistration(ip);
  res.status(202).json({ ok: true });
}));

/* The same per-address counter the sign-in throttle uses, under its own
   label so a burst of registrations cannot lock anybody out of signing in.
   The cap is set to stop an automated firehose rather than to ration
   honest use: an adviser registering half a dozen clients from one office
   in an afternoon, or a couple filing separately from the same house,
   must not be turned away. */
const REGISTRATION_WINDOW = '1 hour';
const REGISTRATIONS_PER_IP = 20;

async function tooManyRegistrations(ip) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM login_attempts
      WHERE ident = $1 AND created_at > now() - INTERVAL '${REGISTRATION_WINDOW}'`,
    [`register:${ip}`]);
  return (rows[0]?.n || 0) >= REGISTRATIONS_PER_IP;
}
const noteRegistration = (ip) =>
  q('INSERT INTO login_attempts (ident) VALUES ($1)', [`register:${ip}`]);

router.post('/auth/login', wrap(login));
router.post('/auth/logout', (req, res) => { clearToken(res); res.json({ ok: true }); });
router.get('/auth/me', authenticate, wrap(async (req, res) => {
  const out = { id: req.user.uid, email: req.user.email, name: req.user.name, role: req.user.role,
                must_change_password: !!req.user.mustChangePassword };
  if (req.user.role === 'investor' && req.user.iid) {
    /* Only the last four digits of the tax number, and only so the Account
       page can say whether one is on file. An investor knows their own
       number; reading it back to them adds risk and answers nothing. */
    const { rows } = await q(
      'SELECT id, name, investor_type, tax_id_last4 FROM investors WHERE id = $1',
      [req.user.iid]);
    out.investor = rows[0] || null;
  }
  if (req.user.role === 'manager') {
    const { rows } = await q(
      `SELECT f.id, f.code, f.name FROM user_funds uf
         JOIN funds f ON f.id = uf.fund_id
        WHERE uf.user_id = $1 ORDER BY f.code`, [req.user.uid]);
    out.funds = rows;
  }
  res.json(out);
}));
router.post('/auth/password', authenticate, wrap(changePassword));

/**
 * An investor supplying their own tax number.
 *
 * It is not asked for at sign-up — a stranger's first minute on the site is
 * the worst moment to ask for a Social Security number — so this is how it
 * arrives afterwards, from the person it belongs to, over a session that has
 * already been authenticated.
 *
 * Two deliberate limits:
 *
 *   - it fills a blank, it does not replace. Once a number is on file,
 *     changing it goes through the office. An investor account is the one
 *     most likely to be phished, and a quietly altered tax number sends
 *     somebody else's K-1 to the wrong place.
 *   - it never reads back. `GET /investors/:id/tax-id` stays administrators
 *     only. The Account page shows the last four digits and nothing more.
 */
router.put('/me/tax-id', authenticate, wrap(async (req, res) => {
  if (req.user.role !== 'investor' || !req.user.iid)
    return res.status(403).json({ error: 'Not an investor account' });

  const digits = digitsOf(req.body?.tax_id);
  if (!looksLikeTaxId(digits))
    return res.status(400).json({
      error: 'A tax number is nine digits — a Social Security number or an EIN.' });

  const { rows: cur } = await q(
    'SELECT tax_id_last4 FROM investors WHERE id = $1', [req.user.iid]);
  if (!cur[0]) return res.status(404).json({ error: 'Investor not found' });
  if (cur[0].tax_id_last4)
    return res.status(409).json({
      error: `A tax number ending ${cur[0].tax_id_last4} is already on file. `
           + 'Call the office to change it.' });

  let sealed;
  try {
    sealed = sealField(digits);
  } catch (e) {
    console.error('[me/tax-id] could not encrypt:', e.message);
    return res.status(503).json({
      error: 'That cannot be stored safely right now. Please call the office.' });
  }
  await q(
    `UPDATE investors SET tax_id_enc = $1, tax_id_key = $2, tax_id_last4 = $3,
                          updated_at = now() WHERE id = $4`,
    [sealed.ciphertext, sealed.keyId, digits.slice(-4), req.user.iid]);
  await audit(req.user.uid, 'investor', req.user.iid, 'update',
    `investor supplied their own tax number · ending ${digits.slice(-4)}`);
  res.json({ ok: true, tax_id_last4: digits.slice(-4) });
}));
/* ------------------------------------------------------------------ *
 * Preferences
 *
 * How somebody has arranged a screen — at present, which columns they
 * want on the policies grid and in what order. Personal, not shared: two
 * people reading the same book lay it out differently, and neither should
 * be able to move the other's furniture.
 *
 * Three rules, and they are the whole of the security story here:
 *
 *   - it is always the caller's own row. There is no user id in the path
 *     and no way to write anybody else's, so an administrator cannot
 *     rearrange an investor's screen by accident or otherwise.
 *   - only names this file knows are accepted, so the table cannot be
 *     used as a general-purpose store for whatever a client posts.
 *   - the value is rebuilt from the field catalogue rather than stored as
 *     it arrived. What comes back out is a list of known column keys, so
 *     nothing that reaches the grid can carry anything else with it.
 * ------------------------------------------------------------------ */

/**
 * Who at the firm hears when an investor does something.
 *
 * An investor asking for a piece of a deal, signing an agreement or saying
 * they have wired money is a thing that needs answering. Left to a queue,
 * it waits until somebody happens to open the right page. So the people
 * whose job it is are told:
 *
 *   - the managers of the entity it concerns, and any manager an
 *     administrator has put that investor in the hands of. "Their
 *     investors" is exactly the relationship the scope tables already
 *     describe, so it is read from them rather than guessed.
 *   - every active administrator.
 *   - whoever specifically set the thing in motion, if they are neither.
 *
 * Deduplicated by user id: somebody who is both the manager and the person
 * who issued it gets one message, not three.
 */
async function staffAudience({ fundId = null, investorId = null, alsoUserId = null } = {}) {
  const { rows } = await q(
    `SELECT DISTINCT u.id, u.email, u.full_name
       FROM users u
      WHERE u.is_active = TRUE
        AND u.email <> ''
        AND (
          u.role = 'admin'
          OR (u.role = 'manager' AND $1::int IS NOT NULL
              AND EXISTS (SELECT 1 FROM user_funds uf
                           WHERE uf.user_id = u.id AND uf.fund_id = $1))
          OR (u.role = 'manager' AND $2::int IS NOT NULL
              AND EXISTS (SELECT 1 FROM user_investors ui
                           WHERE ui.user_id = u.id AND ui.investor_id = $2))
          /* A manager whose entity holds a policy this investor is in, even
             where neither link above was set by hand. */
          OR (u.role = 'manager' AND $2::int IS NOT NULL
              AND EXISTS (SELECT 1
                            FROM policy_investors pi
                            JOIN policies p ON p.id = pi.policy_id
                            JOIN user_funds uf ON uf.fund_id = p.fund_id
                           WHERE pi.investor_id = $2 AND uf.user_id = u.id))
          OR u.id = $3::int
        )`,
    [fundId, investorId, alsoUserId]);
  return rows;
}

/** Tell all of them the same thing. Never throws into a route. */
async function tellStaff(kind, audience, vars) {
  let told = 0;
  for (const person of audience) {
    const sent = await sendMail(kind, { to: person.email, userId: person.id, ...vars });
    if (sent.id) told++;
  }
  return told;
}

/* ------------------------------------------------------------------ *
 * Security notices
 *
 * Things one person needs to be told, as opposed to things the system
 * needs to remember — which is why they are not the audit log. A notice is
 * addressed to somebody, it stays in front of them until they have seen
 * it, and it says what to do about it.
 *
 * Two kinds so far: a sign-in from a location this account has not used
 * before, which goes to the account holder; and a bulk export, which goes
 * to every other administrator.
 * ------------------------------------------------------------------ */

router.get('/me/notices', authenticate, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, kind, detail, created_at, seen_at
       FROM security_notices
      WHERE user_id = $1 AND created_at > now() - INTERVAL '60 days'
      ORDER BY created_at DESC LIMIT 50`, [req.user.uid]);
  res.json({
    unseen: rows.filter((r) => !r.seen_at),
    recent: rows,
    /* Where they are right now, in the same words a notice uses — so
       somebody reading "Chrome on Windows · 71.12.34.x" can tell at a glance
       whether it is the machine in front of them. */
    here: describeOrigin(req),
  });
}));

/** Read and understood. Only ever the caller's own. */
router.post('/me/notices/seen', authenticate, wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((n) => parseInt(n, 10)).filter(Number.isFinite).slice(0, 50)
    : null;
  await q(
    `UPDATE security_notices SET seen_at = now()
      WHERE user_id = $1 AND seen_at IS NULL
        AND ($2::int[] IS NULL OR id = ANY($2::int[]))`,
    [req.user.uid, ids]);
  res.json({ ok: true });
}));

/**
 * Where this account has been used, and what it has been told.
 *
 * An admin may read anybody's, because "has somebody else been signing in
 * as Ellen" is a question only an administrator can answer. Everybody else
 * reads their own and nobody else's.
 */
router.get('/security/locations', authenticate, wrap(async (req, res) => {
  const asked = int(req.query.user_id);
  if (asked && asked !== req.user.uid && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not yours to read' });
  const uid = asked || req.user.uid;
  const { rows } = await q(
    `SELECT label, first_seen, last_seen, sign_ins
       FROM login_locations WHERE user_id = $1
      ORDER BY last_seen DESC LIMIT 50`, [uid]);
  res.json(rows);
}));

/**
 * Start the list again.
 *
 * Only ever the caller's own. Useful after something in front of the
 * application changes — a new office, a CDN in the way — and every recorded
 * place is suddenly the wrong shape. The next sign-in is treated as a first
 * sign-in, which raises nothing, and the list rebuilds from there.
 */
router.delete('/security/locations', authenticate, wrap(async (req, res) => {
  const { rowCount } = await q('DELETE FROM login_locations WHERE user_id = $1', [req.user.uid]);
  await q(`UPDATE security_notices SET seen_at = now()
            WHERE user_id = $1 AND kind = 'new_location' AND seen_at IS NULL`, [req.user.uid]);
  await audit(req.user.uid, 'user', req.user.uid, 'update',
    `cleared ${rowCount} recorded sign-in location(s)`);
  res.json({ ok: true, cleared: rowCount });
}));

/** The whole firm's, for an administrator. */
router.get('/security/notices', authenticate, blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT n.id, n.kind, n.detail, n.created_at, n.seen_at,
            u.full_name AS user_name, u.email AS user_email,
            a.full_name AS actor_name
       FROM security_notices n
       JOIN users u ON u.id = n.user_id
       LEFT JOIN users a ON a.id = n.actor_id
      WHERE n.created_at > now() - INTERVAL '90 days'
      ORDER BY n.created_at DESC LIMIT 200`);
  res.json(rows);
}));

/* An export is an administrator's act, recorded with what it contained, and
   every other administrator hears about it. The client asks first and writes
   no file if the answer is no, so the check is the server's, not the
   button's. */
router.post('/exports', authenticate, blockInvestors, requireRole('admin'),
  wrap((req, res) => recordExport(req, res)));

/* ------------------------------------------------------------------ *
 * Email
 *
 * What each person hears about, and whether the sending works at all.
 * Preferences are the caller's own; the health of the queue is an
 * administrator's business.
 * ------------------------------------------------------------------ */

router.get('/me/notifications', authenticate, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT kind, enabled FROM notification_prefs WHERE user_id = $1', [req.user.uid]);
  const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.kind));
  /* Only the kinds that would ever be addressed to somebody in this role —
     an investor has no opinion to express about bulk exports — and only the
     ones there is any point offering a choice about. */
  const mine = choosableKinds(req.user.role);
  res.json({
    email: req.user.email,
    sending: mailReady(),
    kinds: mine.map((k) => ({ ...k, enabled: k.forced || !off.has(k.kind) })),
  });
}));

router.put('/me/notifications', authenticate, wrap(async (req, res) => {
  const wanted = req.body?.kinds && typeof req.body.kinds === 'object' ? req.body.kinds : null;
  if (!wanted) return res.status(400).json({ error: 'Nothing to change' });
  for (const k of MAIL_KINDS) {
    if (!(k.kind in wanted)) continue;
    /* A forced kind cannot be switched off — an administrator does not get
       to stop hearing that somebody signed in from a new country. */
    const on = k.forced ? true : wanted[k.kind] !== false;
    await q(
      `INSERT INTO notification_prefs (user_id, kind, enabled) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [req.user.uid, k.kind, on]);
  }
  res.json({ ok: true });
}));

/** Is the post going out? Counts only — never the contents of a message. */
router.get('/mail/health', authenticate, blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT status, COUNT(*)::int AS n, MAX(created_at) AS latest
         FROM email_outbox GROUP BY status`);
    const { rows: stuck } = await q(
      `SELECT kind, to_email, last_error, attempts, created_at
         FROM email_outbox WHERE status = 'Failed'
        ORDER BY created_at DESC LIMIT 10`);
    res.json({
      configured: mailReady(),
      from: process.env.MAIL_FROM || null,
      /* What every link in every message points at, and whether it looks
         usable. A placeholder left in the setting is invisible until an
         investor clicks it and lands nowhere. */
      link: process.env.APP_URL || null,
      link_problem: appUrlProblem(),
      counts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      latest: rows.reduce((d, r) => (!d || r.latest > d ? r.latest : d), null),
      failures: stuck,
    });
  }));

/**
 * Was a particular message written, and what happened to it?
 *
 * Counts and subjects, never bodies — "did the investor get the capital
 * call" is a question somebody will ask, and answering it should not mean
 * reading their post. Administrators only, for the same reason.
 */
router.get('/mail/outbox', authenticate, blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const kind = str(req.query.kind);
    const to = str(req.query.to);
    const { rows } = await q(
      `SELECT id, kind, to_email, subject, status, attempts, last_error, created_at, sent_at
         FROM email_outbox
        WHERE ($1 = '' OR kind = $1) AND ($2 = '' OR lower(to_email) = lower($2))
        ORDER BY created_at DESC LIMIT 50`, [kind, to]);
    res.json({
      count: rows.length,
      latest_subject: rows[0]?.subject || null,
      latest_status: rows[0]?.status || null,
      messages: rows,
    });
  }));

/** Prove it end to end, to the address of whoever asks. */
router.post('/mail/test', authenticate, blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    if (!mailReady())
      return res.status(503).json({
        error: 'No mail key is set on the server, so nothing can be sent yet. '
          + 'Add RESEND_API_KEY and MAIL_FROM and restart.' });
    const queued = await sendMail('test', {
      to: req.user.email, userId: req.user.uid, who: req.user.name || req.user.email });
    if (queued.error) return res.status(500).json({ error: queued.error });
    const out = await flushMail({ limit: 5 });
    await audit(req.user.uid, 'user', req.user.uid, 'update', 'sent a test email');
    res.json({ ok: true, to: req.user.email, ...out });
  }));

const PREF_CLEANERS = { policy_columns: cleanArrangement };

router.get('/me/prefs', authenticate, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT name, value FROM user_prefs WHERE user_id = $1', [req.user.uid]);
  const out = {};
  for (const r of rows) {
    const clean = PREF_CLEANERS[r.name];
    if (!clean) continue;                       // a name we no longer use
    const value = clean(r.value);
    if (value) out[r.name] = value;
  }
  res.json(out);
}));

router.put('/me/prefs/:name', authenticate, wrap(async (req, res) => {
  const clean = PREF_CLEANERS[req.params.name];
  if (!clean) return res.status(404).json({ error: 'Unknown preference' });
  const value = clean(req.body);
  if (!value)
    return res.status(400).json({ error: 'That is not an arrangement this screen understands.' });
  await q(
    `INSERT INTO user_prefs (user_id, name, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [req.user.uid, req.params.name, JSON.stringify(value)]
  );
  res.json(value);
}));

/** Back to the catalogue's own idea of the screen. */
router.delete('/me/prefs/:name', authenticate, wrap(async (req, res) => {
  if (!PREF_CLEANERS[req.params.name])
    return res.status(404).json({ error: 'Unknown preference' });
  await q('DELETE FROM user_prefs WHERE user_id = $1 AND name = $2',
    [req.user.uid, req.params.name]);
  res.json({ ok: true });
}));

router.get('/users', authenticate, blockScoped, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.last_login_at,
            u.investor_id, i.name AS investor_name,
            COALESCE((SELECT string_agg(f.code, ', ' ORDER BY f.code)
                        FROM user_funds uf JOIN funds f ON f.id = uf.fund_id
                       WHERE uf.user_id = u.id), '') AS fund_codes,
            COALESCE((SELECT array_agg(uf.fund_id)
                        FROM user_funds uf WHERE uf.user_id = u.id), '{}') AS fund_ids,
            COALESCE((SELECT string_agg(iv.name, ', ' ORDER BY iv.name)
                        FROM user_investors ui JOIN investors iv ON iv.id = ui.investor_id
                       WHERE ui.user_id = u.id), '') AS investor_names,
            COALESCE((SELECT array_agg(ui.investor_id)
                        FROM user_investors ui WHERE ui.user_id = u.id), '{}') AS granted_investor_ids
       FROM users u LEFT JOIN investors i ON i.id = u.investor_id
      ORDER BY u.id`
  );
  res.json(rows);
}));
router.post('/users', authenticate, blockScoped, requireRole('admin'), wrap(createUser));
router.put('/users/:id', authenticate, blockScoped, requireRole('admin'), wrap(updateUser));
router.delete('/users/:id', authenticate, blockScoped, requireRole('admin'), wrap(deleteUser));
router.post('/users/:id/password', authenticate, blockScoped,
  requireRole('admin'), wrap(resetPassword));

// Everything below requires a session AND a fresh read of the account.
// authenticate is the pair; nothing may sit between its two halves.
router.use(authenticate);

/* ------------------------------------------------------------------ *
 * de-identification for investors
 * ------------------------------------------------------------------ */

/**
 * An investor is entitled to know what they own. They are not entitled to
 * know who is insured under it, and a name attached to a life expectancy and
 * a set of impairments is health information about an identifiable person.
 * So the name is reduced to initials before it leaves the building.
 *
 * This is done once, at the edge, rather than at each of the twenty-odd
 * places a name is selected. A screen added next year is covered by default;
 * a screen someone forgets to mask is not a possibility. It also covers what
 * the browser does downstream — every export, print and report is built from
 * this response, so none of them can carry a name the API never sent.
 */
const NAME_KEYS = new Set([
  'display_name', 'insured', 'insured_name', 'primary_insured',
  'insured_first', 'insured_last', 'first_name', 'last_name',
  'insured_first_name', 'insured_last_name',
]);
const FIRST_KEYS = ['insured_first', 'first_name', 'insured_first_name'];
const LAST_KEYS = ['insured_last', 'last_name', 'insured_last_name'];
const WHOLE_KEYS = ['display_name', 'insured', 'insured_name', 'primary_insured'];

const initialOf = (v) => {
  const t = str(v).replace(/[^\p{L}]/gu, '');
  return t ? `${t[0].toUpperCase()}.` : '';
};

/** "Margaret", "Ashford" -> { first: "M.", last: "A.", whole: "M. A." } */
function initialsFor(row) {
  let first = initialOf(FIRST_KEYS.map((k) => row[k]).find((v) => str(v)));
  let last = initialOf(LAST_KEYS.map((k) => row[k]).find((v) => str(v)));
  if (!first && !last) {
    const whole = str(WHOLE_KEYS.map((k) => row[k]).find((v) => str(v)));
    const parts = whole.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 1) last = initialOf(parts[0]);
    else if (parts.length > 1) {
      // "Ashford, Margaret" reads the other way round from "Margaret Ashford".
      const reversed = /,/.test(whole);
      first = initialOf(reversed ? parts[1] : parts[0]);
      last = initialOf(reversed ? parts[0] : parts[parts.length - 1]);
    }
  }
  return { first, last, whole: [first, last].filter(Boolean).join(' ') || '—' };
}

function deidentify(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((v) => deidentify(v, seen));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deidentify(v, seen);

  const named = [...NAME_KEYS].filter((k) => k in out);
  if (named.length) {
    const { first, last, whole } = initialsFor(value);
    /* A first-name field keeps the first initial and a last-name field the
       last one, so a screen with two columns reads "H." and "F." while a
       screen that composes them still reads "H. F." — and so does one that
       prints display_name. No caller has to know it is looking at a mask. */
    for (const k of FIRST_KEYS) if (k in out && out[k] !== null) out[k] = first || whole;
    for (const k of LAST_KEYS) if (k in out && out[k] !== null) out[k] = last || whole;
    for (const k of WHOLE_KEYS) if (k in out && out[k] !== null) out[k] = whole;
    if (!WHOLE_KEYS.some((k) => k in out)) out.display_name = whole;
  }
  return out;
}

/*
 * One exception, set per-response rather than per-route so it has to be
 * asked for: an operating agreement. The member is a party to it, the
 * document names what the LLC was formed to hold, and the clauses are
 * rendered as prose that no field-level mask could reach — half-masking
 * it would leave the summary and the body disagreeing about the same
 * document. Whether the insured is named at all is a drafting decision,
 * made once when the agreement is written, and the field is optional.
 */
router.use((req, res, next) => {
  if (!isInvestor(req)) return next();
  const send = res.json.bind(res);
  res.json = (body) => (res.locals.identified ? send(body) : send(deidentify(body)));
  next();
});

/**
 * Every route parameter in this API is a database serial. Reject anything that
 * is not one before it reaches a query: otherwise Postgres raises the type
 * error, and a message naming the column type it expected is a free hint to
 * anyone probing. A bad id is "not found", which is also simply true.
 */
const serialParam = (req, res, next, v) =>
  /^\d{1,9}$/.test(String(v)) ? next() : res.status(404).json({ error: 'Not found' });
router.param('id', serialParam);
router.param('linkId', serialParam);

/* ------------------------------------------------------------------ *
 * funds
 * ------------------------------------------------------------------ */

router.get('/funds', blockInvestors, wrap(async (req, res) => {
  const funds = fundScope(req);
  const { rows } = await q(
    /* Average insured age, per owner entity.
       Counted over distinct lives rather than over policies: an entity
       holding two contracts on the same person has one life in its book,
       not two, and averaging per policy would quietly double-weight them.
       Every life the entity is exposed to is included — the second life on
       a survivorship contract as much as the primary — because that is
       what the entity's mortality actually depends on. Lives with no date
       of birth are left out of the mean rather than counted as zero, and
       the count of lives is returned beside it so the reader can see how
       much the figure is standing on. */
    `SELECT f.*,
            COUNT(p.id)::int AS policy_count,
            COALESCE(SUM(COALESCE(pl.death_benefit, p.face_amount)), 0) AS total_death_benefit,
            COALESCE(SUM(pl.total_invested), 0) AS total_invested,
            lives.n            AS lives_count,
            lives.dated        AS lives_with_dob,
            lives.avg_age      AS avg_insured_age
       FROM funds f
       LEFT JOIN policies p ON p.fund_id = f.id
                           AND p.status NOT IN ('Lapsed','Sold','Matured')
       LEFT JOIN policy_latest pl ON pl.id = p.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int                                            AS n,
                COUNT(i.dob)::int                                        AS dated,
                ROUND(AVG(EXTRACT(YEAR FROM age(CURRENT_DATE, i.dob)))::numeric, 1)
                                                                         AS avg_age
           FROM insureds i
          WHERE i.id IN (
            SELECT pol.insured_id
              FROM policies pol
             WHERE pol.fund_id = f.id
               AND pol.status NOT IN ('Lapsed','Sold','Matured')
               AND pol.insured_id IS NOT NULL
            UNION
            SELECT pi.insured_id
              FROM policy_insureds pi
              JOIN policies pol2 ON pol2.id = pi.policy_id
             WHERE pol2.fund_id = f.id
               AND pol2.status NOT IN ('Lapsed','Sold','Matured'))
            AND i.date_of_death IS NULL
       ) lives ON TRUE
      WHERE ($1::int[] IS NULL OR f.id = ANY($1))
      GROUP BY f.id, lives.n, lives.dated, lives.avg_age
      ORDER BY f.code`,
    [funds]
  );
  res.json(rows);
}));

/**
 * The carried interest an entity charges, from a form.
 *
 * Absent means leave it alone, which is what lets a rename not silently
 * change the terms. "Not charged" is simply zero — a book managed for a fee
 * is not a special case, it is the same field with nothing in it.
 */
function carryPctFrom(body) {
  if (body.charges_carry === false || body.charges_carry === 'false') return 0;
  if (!('carry_pct' in body) && !('charges_carry' in body)) return null;
  const v = num(body.carry_pct);
  if (v === null) return body.charges_carry ? CARRY_PCT : 0;
  if (v < 0 || v > 100) return { error: 'Carried interest is a percentage between 0 and 100.' };
  return v;
}

router.post('/funds', blockScoped, requireRole('admin','editor'), wrap(async (req, res) => {
  const code = str(req.body.code);
  if (!code) return res.status(400).json({ error: 'A code is required' });
  const carry = carryPctFrom(req.body);
  if (carry && carry.error) return res.status(400).json({ error: carry.error });
  const { rows } = await q(
    `INSERT INTO funds (code, name, notes, carry_pct) VALUES ($1,$2,$3,COALESCE($4, 10))
     ON CONFLICT (code) DO UPDATE SET
       name  = COALESCE(NULLIF(EXCLUDED.name,''),  funds.name),
       notes = COALESCE(NULLIF(EXCLUDED.notes,''), funds.notes),
       carry_pct = COALESCE($4, funds.carry_pct)
     RETURNING *`,
    [code, str(req.body.name), str(req.body.notes), carry]
  );
  await audit(req.user.uid, 'fund', rows[0].id, 'create',
    `${code} · carried interest ${rows[0].carry_pct}%`);
  res.status(201).json(rows[0]);
}));

router.put('/funds/:id', blockScoped, requireRole('admin','editor'), wrap(async (req, res) => {
  const code = str(req.body.code);
  if (!code) return res.status(400).json({ error: 'A code is required' });
  try {
    const carry = carryPctFrom(req.body);
    if (carry && carry.error) return res.status(400).json({ error: carry.error });
    const { rows: was } = await q('SELECT carry_pct FROM funds WHERE id = $1', [req.params.id]);
    const { rows } = await q(
      `UPDATE funds SET code = $1, name = $2, notes = $3,
              carry_pct = COALESCE($4, carry_pct)
        WHERE id = $5 RETURNING *`,
      [code, str(req.body.name), str(req.body.notes), carry, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Entity not found' });
    /* Changing the rate changes what every investor in that entity is shown,
       so it is written down in its own words rather than as "update". */
    const changed = was[0] && Number(was[0].carry_pct) !== Number(rows[0].carry_pct);
    await audit(req.user.uid, 'fund', rows[0].id, 'update',
      changed
        ? `${code} · carried interest ${was[0].carry_pct}% → ${rows[0].carry_pct}%`
        : code);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'Another entity already uses that code' });
    throw e;
  }
}));

/** Refuses to orphan policies — reassign them first. */
router.delete('/funds/:id', blockScoped, requireRole('admin','editor'), wrap(async (req, res) => {
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
  const funds = fundScope(req);
  // Narrow to one owner entity, the same way the dashboard does. It joins
  // through the policies the person is insured under, so a life covered by
  // two entities appears under either — which is the truth about them.
  const fund = str(req.query.fund);
  const { rows } = await q(
    `SELECT i.*, COUNT(p.id)::int AS policy_count
       FROM insureds i
       JOIN policies p ON p.insured_id = i.id AND ${visibleTo('p.id', 'p.fund_id', 2, 3)}
       LEFT JOIN funds f ON f.id = p.fund_id
      WHERE ($1 = '' OR i.first_name ILIKE '%'||$1||'%' OR i.last_name ILIKE '%'||$1||'%'
             OR i.display_name ILIKE '%'||$1||'%')
        AND ($4 = '' OR f.code = $4)
      GROUP BY i.id ORDER BY i.last_name, i.first_name`,
    [search, scope, funds, fund]
  );
  res.json(rows);
}));

router.get('/insureds/:id', wrap(async (req, res) => {
  const scope = scopeId(req);
  const funds = fundScope(req);
  const { rows } = await q(
    `SELECT i.* FROM insureds i
      WHERE i.id = $1
        AND EXISTS (SELECT 1 FROM policies p
                     WHERE p.insured_id = i.id AND ${visibleTo('p.id', 'p.fund_id', 2, 3)})`,
    [req.params.id, scope, funds]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insured not found' });
  const pol = await q(
    `SELECT pl.* FROM policy_latest pl
      WHERE pl.insured_id = $1 AND ${visibleTo('pl.id', 'pl.fund_id', 2, 3)}`,
    [req.params.id, scope, funds]
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
  const mFunds = fundScope(req);
  if (mFunds !== null) {
    const { rows: own } = await q(
      `SELECT 1 FROM policies WHERE insured_id = $1 AND fund_id = ANY($2) LIMIT 1`,
      [req.params.id, mFunds]
    );
    if (!own[0]) return res.status(404).json({ error: 'Insured not found' });
  }
  const { sets, vals, next } = buildSet(INSURED_FIELDS, req.body);
  if (!sets.length) return res.status(400).json({ error: 'No fields supplied' });
  const { rows } = await q(
    `UPDATE insureds SET ${sets.join(',')}, updated_at = now() WHERE id = $${next} RETURNING *`,
    [...vals, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insured not found' });
  await audit(req.user.uid, 'insured', rows[0].id, 'update', sets.join(','));

  // Recording a death moves policies out of the active book by database
  // trigger. Report which ones, so the person who typed the date is told
  // rather than discovering it later.
  let maturityChanges = [];
  if ('date_of_death' in req.body) {
    const { rows: affected } = await q(
      `SELECT p.id, p.policy_number, p.carrier_name, p.status, p.matured_on
         FROM policies p
        WHERE p.insured_id = $1
           OR p.id IN (SELECT policy_id FROM policy_insureds WHERE insured_id = $1)`,
      [rows[0].id]
    );
    maturityChanges = affected.map((p) => ({
      id: p.id, policy_number: p.policy_number, carrier_name: p.carrier_name,
      matured: p.status === 'Matured' && p.matured_on !== null,
    }));
    for (const p of affected.filter((x) => x.status === 'Matured' && x.matured_on))
      await audit(req.user.uid, 'policy', p.id, 'update',
        `matured on ${p.matured_on} (death recorded for ${rows[0].last_name || rows[0].display_name})`);
  }
  res.json({ ...rows[0], policies: maturityChanges });
}));

/* ------------------------------------------------------------------ *
 * policies
 * ------------------------------------------------------------------ */

router.get('/policies', wrap(async (req, res) => {
  const search = str(req.query.search);
  const status = str(req.query.status);
  const fund = str(req.query.fund);
  const scope = scopeId(req);
  const funds = fundScope(req);
  const { rows } = await q(
    /* `pl.*` first, then the two money-back columns written over it: a
       death benefit and a claim paid are what the investor receives, so
       they read net of the managing partner's share. The client multiplies
       by the share afterwards, which carry is indifferent to. */
    `SELECT pl.*,
            ${afterCarry('COALESCE(pl.death_benefit, pl.face_amount)', 'pl.total_invested', 4)}
                                                     AS death_benefit,
            ${afterCarry('pl.proceeds_amount', 'pl.total_invested', 4)} AS proceeds_amount,
            ${shareOf('pl.id', 4)} AS my_pct
       FROM policy_latest pl
      WHERE ($1 = '' OR pl.policy_number ILIKE '%'||$1||'%'
             OR pl.carrier_name ILIKE '%'||$1||'%'
             OR pl.insured_last ILIKE '%'||$1||'%'
             OR pl.insured_first ILIKE '%'||$1||'%'
             OR pl.display_name ILIKE '%'||$1||'%')
        AND ($2 = '' OR pl.status = $2)
        -- Matured policies belong to the Maturities register, not the active
        -- book. They come back only when explicitly asked for by status.
        AND ($2 <> '' OR pl.status <> 'Matured')
        AND ($3 = '' OR pl.fund_code = $3)
        AND ${visibleTo('pl.id', 'pl.fund_id', 4, 5)}
      ORDER BY pl.insured_last, pl.insured_first, pl.policy_number`,
    [search, status, fund, scope, funds]
  );
  res.json(rows);
}));

router.get('/policies/:id', wrap(async (req, res) => {
  const scope = scopeId(req);
  const funds = fundScope(req);
  const { rows } = await q(
    // Same rule as the grid: what comes back reads net for an investor.
    `SELECT pl.*,
            ${afterCarry('COALESCE(pl.death_benefit, pl.face_amount)', 'pl.total_invested', 2)}
                                                     AS death_benefit,
            ${afterCarry('pl.proceeds_amount', 'pl.total_invested', 2)} AS proceeds_amount,
            ${shareOf('pl.id', 2)} AS my_pct
       FROM policy_latest pl
      WHERE pl.id = $1 AND ${visibleTo('pl.id', 'pl.fund_id', 2, 3)}`,
    [req.params.id, scope, funds]
  );
  // A policy the investor doesn't hold is reported as missing, not forbidden —
  // "forbidden" would confirm it exists.
  if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
  const [values, txns, extra, reminders] = await Promise.all([
    q('SELECT * FROM policy_values WHERE policy_id = $1 ORDER BY as_of_date DESC', [req.params.id]),
    q('SELECT * FROM transactions WHERE policy_id = $1 ORDER BY txn_date DESC, id DESC', [req.params.id]),
    q(`SELECT pi.id AS link_id, pi.role, pi.notes AS link_notes, i.*
         FROM policy_insureds pi JOIN insureds i ON i.id = pi.insured_id
        WHERE pi.policy_id = $1 ORDER BY pi.id`, [req.params.id]),
    /* A scheduled premium is money the investor will be asked for, so it
       belongs in front of them. The rest of the follow-up schedule — chase
       this form, call that carrier — is servicing work and stays internal. */
    q(`SELECT r.*, u.full_name AS done_by_name
         FROM policy_reminders r LEFT JOIN users u ON u.id = r.done_by
        WHERE r.policy_id = $1
          AND ($2::boolean IS NOT TRUE OR (r.kind = 'Premium' AND r.done_at IS NULL))
        ORDER BY (r.done_at IS NOT NULL), r.due_date, r.id`,
      [req.params.id, isInvestor(req)]),
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
    reminders: reminders.rows,
  });
}));

/* ---- additional lives on a policy (survivorship / joint) ---- */

router.post('/policies/:id/insureds', blockInvestors, canEdit, inPolicyScope('id'), wrap(async (req, res) => {
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
  const { rows: link } = await q('SELECT policy_id FROM policy_insureds WHERE id = $1', [req.params.id]);
  if (!link[0] || !(await assertPolicyInScope(req, link[0].policy_id)))
    return res.status(404).json({ error: 'Not found' });
  const { rowCount } = await q('DELETE FROM policy_insureds WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  await audit(req.user.uid, 'policy_insured', req.params.id, 'delete', '');
  res.json({ ok: true });
}));

router.post('/policies', blockInvestors, canEdit, wrap(async (req, res) => {
  const body = { ...req.body };
  body.insured_id = await resolveInsured(body);
  body.fund_id = await resolveFund(body);
  const funds = fundScope(req);
  if (funds !== null && !funds.includes(body.fund_id))
    return res.status(403).json({ error: 'Assign the policy to one of your own entities' });
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

router.put('/policies/:id', blockInvestors, canEdit, inPolicyScope('id'), wrap(async (req, res) => {
  const body = { ...req.body };
  if (body.insured_name || body.insured_last_name) body.insured_id = await resolveInsured(body);
  // Present-but-empty means "no owner", so test for the key rather than truthiness.
  if ('fund_code' in body || 'fund_id' in body) body.fund_id = await resolveFund(body);
  // A manager must not be able to move a policy out of their own entities.
  const mgrFunds = fundScope(req);
  if (mgrFunds !== null && 'fund_id' in body && !mgrFunds.includes(body.fund_id))
    return res.status(403).json({ error: 'You can only move a policy between your own entities' });
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
router.delete('/policies/:id', blockInvestors, adminOrManager, inPolicyScope('id'), wrap(async (req, res) => {
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

/**
 * Deleting a lot of policies at once.
 *
 * This exists because of imports. A file loaded with the wrong owner
 * column, or twice, or from the wrong export, leaves a hundred rows that
 * have to come out — and doing that one policy at a time, typing each
 * policy number into a confirmation box, is how somebody gives up half
 * way and leaves the book in a worse state than either extreme.
 *
 * It is the most destructive thing in the application, so:
 *
 *   - administrators only. A portfolio manager can delete a policy in
 *     their own entity one at a time; nobody clears a shelf but an admin.
 *   - all or nothing, inside one transaction. A bulk delete that half
 *     worked is worse than one that did not run.
 *   - the confirmation carries the count, so a number typed for one
 *     selection cannot authorise a different one.
 *   - what goes with them is counted and shown first. Transactions and
 *     value snapshots are obvious; the documents filed against a policy
 *     are not, and those are files that do not come back.
 */

/** Beyond this, do it in two goes — one transaction should stay bounded. */
const BULK_DELETE_LIMIT = 500;

/** The exact words. Tied to the count, so it changes with the selection. */
export const bulkDeletePhrase = (n) => `DELETE ${n}`;

async function bulkDeleteTally(ids) {
  const { rows } = await q(
    `SELECT p.id, p.policy_number, p.carrier_name, p.face_amount, p.status,
            i.first_name, i.last_name,
            (SELECT COUNT(*)::int FROM policy_values v   WHERE v.policy_id = p.id) AS value_count,
            (SELECT COUNT(*)::int FROM transactions t    WHERE t.policy_id = p.id) AS txn_count,
            (SELECT COUNT(*)::int FROM policy_investors a WHERE a.policy_id = p.id) AS holder_count,
            (SELECT COUNT(*)::int FROM documents d       WHERE d.policy_id = p.id) AS document_count,
            (SELECT COALESCE(SUM(amount),0) FROM transactions t WHERE t.policy_id = p.id) AS invested
       FROM policies p LEFT JOIN insureds i ON i.id = p.insured_id
      WHERE p.id = ANY($1::int[])
      ORDER BY p.policy_number`,
    [ids]
  );
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  return {
    policies: rows,
    count: rows.length,
    values: sum('value_count'),
    transactions: sum('txn_count'),
    holders: sum('holder_count'),
    documents: sum('document_count'),
    invested: sum('invested'),
    face_amount: sum('face_amount'),
    confirm_phrase: bulkDeletePhrase(rows.length),
  };
}

/** Which ids were asked for, cleaned up — no duplicates, no rubbish. */
function bulkIds(body) {
  const raw = Array.isArray(body?.ids) ? body.ids : [];
  const ids = [...new Set(raw.map((v) => int(v)).filter((v) => Number.isInteger(v) && v > 0))];
  if (!ids.length) return { error: 'Choose at least one policy to delete.' };
  if (ids.length > BULK_DELETE_LIMIT)
    return { error: `That is ${ids.length} policies. Delete at most ${BULK_DELETE_LIMIT} at a time.` };
  return { ids };
}

/** What would go, before anything does. */
router.post('/policies/bulk-delete/preview', blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const { ids, error } = bulkIds(req.body);
    if (error) return res.status(400).json({ error });
    const tally = await bulkDeleteTally(ids);
    const missing = ids.filter((id) => !tally.policies.some((p) => p.id === id));
    res.json({ ...tally, missing });
  }));

router.post('/policies/bulk-delete', blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const { ids, error } = bulkIds(req.body);
    if (error) return res.status(400).json({ error });

    const tally = await bulkDeleteTally(ids);
    if (tally.count !== ids.length) {
      // Somebody else got there first, or the page was open a long time.
      const gone = ids.length - tally.count;
      return res.status(409).json({
        error: `${gone} of those policies no longer ${gone === 1 ? 'exists' : 'exist'}. `
             + 'Reload and choose again.',
        found: tally.count,
      });
    }
    if (str(req.body?.confirm) !== tally.confirm_phrase)
      return res.status(400).json({
        error: `Type ${tally.confirm_phrase} to confirm.`,
        confirm_phrase: tally.confirm_phrase,
      });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        'DELETE FROM policies WHERE id = ANY($1::int[])', [ids]);
      if (rowCount !== ids.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The selection changed while it was being deleted. Nothing was removed.' });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    /* One audit entry per policy, in the same shape a single deletion
       writes, so the log reads the same however the policy was removed —
       and marked as part of a batch, because thirty entries at the same
       second with no explanation is its own kind of alarming. */
    for (const p of tally.policies)
      await audit(req.user.uid, 'policy', p.id, 'delete',
        `${p.policy_number} · ${p.carrier_name} · ` +
        `${[p.last_name, p.first_name].filter(Boolean).join(', ')} · face ${p.face_amount} · ` +
        `${p.value_count} value snapshots · ${p.txn_count} transactions · ${p.invested} invested · ` +
        `bulk delete of ${tally.count}`);

    res.json({ ok: true, deleted: tally.count, values: tally.values,
      transactions: tally.transactions, documents: tally.documents,
      policy_numbers: tally.policies.map((p) => p.policy_number) });
  }));

/* ------------------------------------------------------------------ *
 * documents
 *
 * The paperwork the fund runs on: LLC agreements, subscription
 * documents, K-1s, carrier letters. Small in number, awkward in
 * visibility -- some belong to the firm, some to one owning entity, and
 * a K-1 belongs to exactly one person and nobody else.
 * ------------------------------------------------------------------ */

const DOC_CATEGORIES = [
  'LLC Agreement', 'Subscription Agreement', 'K-1', 'Tax', 'Statement',
  'Policy Document', 'Correspondence', 'Other',
];

/**
 * What a document may be, on the way in.
 *
 * A whitelist rather than a blocklist, and deliberately without text/html
 * or svg: those execute in a browser, and a file somebody uploaded is a
 * file somebody chose. Everything is served as an attachment as well, so
 * neither measure is load-bearing on its own.
 */
const DOC_TYPES = new Map([
  ['pdf',  'application/pdf'],
  ['doc',  'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls',  'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt',  'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['csv',  'text/csv'],
  ['txt',  'text/plain'],
  ['rtf',  'application/rtf'],
  ['png',  'image/png'],
  ['jpg',  'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif',  'image/gif'],
  ['tif',  'image/tiff'],
  ['tiff', 'image/tiff'],
  ['zip',  'application/zip'],
]);

const docExt = (name) => String(name || '').toLowerCase().split('.').pop();

/** Strip any path, and any control character, a client may have volunteered. */
const safeName = (name) => String(name || 'document')
  .replace(/[\\/]/g, '_')
  .replace(/[\x00-\x1f\x7f]/g, '')
  .trim().slice(0, 200) || 'document';

/**
 * WHERE fragment for the documents a caller may see.
 *
 * An investor sees only what is addressed to them AND marked shared -- a
 * draft K-1 sitting against their name is not theirs until somebody says
 * so. A manager sees the firm's documents plus anything belonging to their
 * own entities or to an investor they may reach. Other staff see the
 * cabinet.
 */
function documentScope(req) {
  if (isInvestor(req))
    return { sql: 'd.investor_id = $1 AND d.shared IS TRUE', params: [Number(req.user.iid) || -1] };
  const funds = fundScope(req);
  if (funds === null) return { sql: 'TRUE', params: [] };
  const granted = grantedInvestors(req);
  return {
    sql: `(d.fund_id IS NULL OR d.fund_id = ANY($1))
          AND (d.investor_id IS NULL
               OR d.investor_id = ANY(COALESCE($2::int[], '{}'))
               OR EXISTS (SELECT 1 FROM policy_investors pj JOIN policies pp ON pp.id = pj.policy_id
                           WHERE pj.investor_id = d.investor_id AND pp.fund_id = ANY($1)))`,
    params: [funds, granted],
  };
}

router.get('/documents', wrap(async (req, res) => {
  const scope = documentScope(req);
  const n = scope.params.length;
  const search = str(req.query.search);
  const category = str(req.query.category);
  const { rows } = await q(
    `SELECT * FROM document_list d
      WHERE ${scope.sql}
        AND ($${n + 1} = '' OR d.title ILIKE '%'||$${n + 1}||'%'
             OR d.file_name ILIKE '%'||$${n + 1}||'%'
             OR d.notes ILIKE '%'||$${n + 1}||'%'
             OR d.investor_name ILIKE '%'||$${n + 1}||'%')
        AND ($${n + 2} = '' OR d.category = $${n + 2})
      ORDER BY d.doc_year DESC NULLS LAST, d.created_at DESC`,
    [...scope.params, search, category]);
  res.json(rows);
}));

router.get('/documents/categories', wrap(async (req, res) => res.json(DOC_CATEGORIES)));

/** The bytes. Always as an attachment, never rendered in place. */
router.get('/documents/:id/download', wrap(async (req, res) => {
  const scope = documentScope(req);
  const { rows } = await q(
    `SELECT d.file_name, d.mime_type, d.byte_size, doc.content
       FROM document_list d JOIN documents doc ON doc.id = d.id
      WHERE d.id = $${scope.params.length + 1} AND ${scope.sql}`,
    [...scope.params, req.params.id]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  await audit(req.user.uid, 'document', Number(req.params.id), 'read', doc.file_name);
  /* Content-Disposition: attachment, with nosniff beside it. Between them a
     stored file cannot be talked into executing in the browser as this
     origin, which is the whole risk in letting people upload and each other
     download. */
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', doc.byte_size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition',
    `attachment; filename="${safeName(doc.file_name).replace(/"/g, '')}"`);
  res.send(doc.content);
}));

router.put('/documents/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const scope = documentScope(req);
  const { rows: found } = await q(
    `SELECT d.id FROM document_list d
      WHERE d.id = $${scope.params.length + 1} AND ${scope.sql}`,
    [...scope.params, req.params.id]);
  if (!found[0]) return res.status(404).json({ error: 'Document not found' });

  const category = DOC_CATEGORIES.includes(str(req.body.category))
    ? str(req.body.category) : 'Other';
  const investorId = int(req.body.investor_id);
  if (investorId && (await investorsOutOfScope(req, [investorId])).length)
    return res.status(403).json({ error: 'That investor is not one of yours' });

  const { rows } = await q(
    `UPDATE documents SET title = $1, category = $2, doc_year = $3, notes = $4,
            fund_id = $5, investor_id = $6, shared = $7, updated_at = now()
      WHERE id = $8 RETURNING id`,
    [str(req.body.title) || 'Untitled', category, int(req.body.doc_year), str(req.body.notes),
     int(req.body.fund_id), investorId,
     req.body.shared === true || req.body.shared === 'true', req.params.id]);
  await audit(req.user.uid, 'document', rows[0].id, 'update', str(req.body.title));
  res.json({ ok: true });
}));

router.delete('/documents/:id', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    const scope = documentScope(req);
    const { rows } = await q(
      `SELECT d.id, d.title FROM document_list d
        WHERE d.id = $${scope.params.length + 1} AND ${scope.sql}`,
      [...scope.params, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    await q('DELETE FROM documents WHERE id = $1', [req.params.id]);
    await audit(req.user.uid, 'document', Number(req.params.id), 'delete', rows[0].title);
    res.json({ ok: true });
  }));

/**
 * Store an uploaded document. Called from server.js, which owns multer --
 * exported rather than routed here so the byte limits and the parser stay
 * together with the other upload routes.
 */
export async function storeDocument(req, res) {
  const file = (req.files?.file || [])[0] || (req.files?.files || [])[0];
  if (!file) return res.status(400).json({ error: 'Choose a file to upload' });

  const ext = docExt(file.originalname);
  if (!DOC_TYPES.has(ext))
    return res.status(400).json({
      error: `A .${ext} file cannot be stored here. Accepted: ${[...DOC_TYPES.keys()].join(', ')}.` });
  if (!file.buffer?.length) return res.status(400).json({ error: 'That file is empty' });

  const funds = fundScope(req);
  const fundId = int(req.body.fund_id);
  if (funds && fundId && !funds.includes(fundId))
    return res.status(403).json({ error: 'That owner entity is not one of yours' });
  const investorId = int(req.body.investor_id);
  if (investorId && (await investorsOutOfScope(req, [investorId])).length)
    return res.status(403).json({ error: 'That investor is not one of yours' });

  const category = DOC_CATEGORIES.includes(str(req.body.category))
    ? str(req.body.category) : 'Other';
  // The mime type comes from the extension just whitelisted, never from the
  // browser: a client is free to claim anything, and often does.
  const mime = DOC_TYPES.get(ext);
  const checksum = createHash('sha256').update(file.buffer).digest('hex');

  const { rows } = await q(
    `INSERT INTO documents (title, category, doc_year, notes, fund_id, investor_id,
                            policy_id, shared, file_name, mime_type, byte_size,
                            checksum, content, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [str(req.body.title) || safeName(file.originalname), category, int(req.body.doc_year),
     str(req.body.notes), fundId, investorId, int(req.body.policy_id),
     req.body.shared === 'true' || req.body.shared === true,
     safeName(file.originalname), mime, file.buffer.length, checksum, file.buffer, req.user.uid]);

  await audit(req.user.uid, 'document', rows[0].id, 'create',
    `${category} - ${safeName(file.originalname)} - ${file.buffer.length} bytes`);
  res.status(201).json({ id: rows[0].id, ok: true });
}

/* ------------------------------------------------------------------ *
 * scheduled next steps
 *
 * A dated intention against a policy: a premium expected in three years
 * at roughly this figure, or a piece of work — chase the change of
 * ownership, refresh the LE report — that has no figure at all. Both are
 * estimates until they happen. Marking one done records that it did; the
 * transaction ledger, not this list, remains the record of what was paid.
 * ------------------------------------------------------------------ */

const REMINDER_KINDS = ['Premium', 'Reminder'];

// Staff only. These are internal servicing notes — "chase the change of
// ownership form" is not something to put in front of an investor, and
// inPolicyScope alone would not keep them out: it constrains entities, and an
// investor has no entity scope to constrain.
router.get('/policies/:id/reminders', blockInvestors, staffOnly, inPolicyScope('id'),
  wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT r.*, u.full_name AS done_by_name
       FROM policy_reminders r LEFT JOIN users u ON u.id = r.done_by
      WHERE r.policy_id = $1
      ORDER BY (r.done_at IS NOT NULL), r.due_date, r.id`, [req.params.id]);
    res.json(rows);
  }));

router.post('/policies/:id/reminders', blockInvestors, canEdit, inPolicyScope('id'),
  wrap(async (req, res) => {
    const due = date(req.body.due_date);
    const kind = REMINDER_KINDS.includes(str(req.body.kind)) ? str(req.body.kind) : 'Reminder';
    const amount = kind === 'Premium' ? num(req.body.amount) : null;
    const note = str(req.body.note);
    if (!due) return res.status(400).json({ error: 'A date is required' });
    if (amount !== null && amount < 0)
      return res.status(400).json({ error: 'An estimated amount cannot be negative' });
    // A reminder with no words is a dot on a calendar nobody can act on.
    if (kind === 'Reminder' && !note)
      return res.status(400).json({ error: 'Say what the reminder is for' });
    const { rows } = await q(
      `INSERT INTO policy_reminders (policy_id, due_date, kind, amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, due, kind, amount, note, req.user.uid]);
    await audit(req.user.uid, 'policy_reminder', rows[0].id, 'create',
      `policy ${req.params.id} · ${kind} ${due}`);
    res.status(201).json(rows[0]);
  }));

/** Edit one, or tick it off. `done` is sent as a boolean either way. */
router.put('/policy-reminders/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const { rows: found } = await q('SELECT * FROM policy_reminders WHERE id = $1', [req.params.id]);
  if (!found[0] || !(await assertPolicyInScope(req, found[0].policy_id)))
    return res.status(404).json({ error: 'Not found' });
  const r = found[0];

  const due = req.body.due_date === undefined ? r.due_date : date(req.body.due_date);
  if (!due) return res.status(400).json({ error: 'A date is required' });
  const kind = req.body.kind === undefined ? r.kind
    : (REMINDER_KINDS.includes(str(req.body.kind)) ? str(req.body.kind) : r.kind);
  const amount = kind !== 'Premium' ? null
    : (req.body.amount === undefined ? r.amount : num(req.body.amount));
  const note = req.body.note === undefined ? r.note : str(req.body.note);
  if (kind === 'Reminder' && !note)
    return res.status(400).json({ error: 'Say what the reminder is for' });

  // Ticking it off stamps who and when; un-ticking clears both, so a mistake
  // leaves no misleading trail of somebody having done something they did not.
  const doneAt = req.body.done === undefined ? r.done_at : (req.body.done ? new Date() : null);
  const doneBy = req.body.done === undefined ? r.done_by : (req.body.done ? req.user.uid : null);

  const { rows } = await q(
    `UPDATE policy_reminders SET due_date=$1, kind=$2, amount=$3, note=$4, done_at=$5, done_by=$6
      WHERE id=$7 RETURNING *`,
    [due, kind, amount, note, doneAt, doneBy, req.params.id]);
  await audit(req.user.uid, 'policy_reminder', Number(req.params.id), 'update',
    req.body.done === undefined ? `${kind} ${due}` : (req.body.done ? 'marked done' : 'reopened'));
  res.json(rows[0]);
}));

router.delete('/policy-reminders/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const { rows } = await q('SELECT policy_id FROM policy_reminders WHERE id = $1', [req.params.id]);
  if (!rows[0] || !(await assertPolicyInScope(req, rows[0].policy_id)))
    return res.status(404).json({ error: 'Not found' });
  await q('DELETE FROM policy_reminders WHERE id = $1', [req.params.id]);
  await audit(req.user.uid, 'policy_reminder', Number(req.params.id), 'delete',
    `policy ${rows[0].policy_id}`);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * value snapshots
 * ------------------------------------------------------------------ */

router.post('/policies/:id/values', blockInvestors, canEdit, inPolicyScope('id'), wrap(async (req, res) => {
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
  const { rows } = await q('SELECT policy_id FROM policy_values WHERE id = $1', [req.params.id]);
  if (!rows[0] || !(await assertPolicyInScope(req, rows[0].policy_id)))
    return res.status(404).json({ error: 'Not found' });
  await q('DELETE FROM policy_values WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * transactions
 * ------------------------------------------------------------------ */

router.post('/policies/:id/transactions', blockInvestors, canEdit, inPolicyScope('id'), wrap(async (req, res) => {
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
  const { rows } = await q('SELECT policy_id FROM transactions WHERE id = $1', [req.params.id]);
  if (!rows[0] || !(await assertPolicyInScope(req, rows[0].policy_id)))
    return res.status(404).json({ error: 'Not found' });
  await q('DELETE FROM transactions WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * portfolio analytics
 * ------------------------------------------------------------------ */

router.get('/analytics/summary', wrap(async (req, res) => {
  const scope = scopeId(req);
  const funds = fundScope(req);
  /* Narrow the whole dashboard to one owner entity. Blank means the book
     as a whole, which is what a person means by "all". The filter sits
     inside the scope predicate rather than replacing it, so choosing an
     entity can only ever show less than the reader is already allowed. */
  const fund = str(req.query.fund);
  // For an investor every money figure is multiplied by their percentage, so
  // the dashboard reads as *their* portfolio rather than the whole book.
  const w = `(${shareOf('pl.id', 1)} / 100.0)`;
  const vis = visibleTo('pl.id', 'pl.fund_id', 1, 2);

  const [totals, byCarrier, invested, ages] = await Promise.all([
    q(`SELECT
         COUNT(*)::int                                            AS policy_count,
         COUNT(*) FILTER (WHERE pl.status = 'Inforce')::int        AS inforce_count,
         COALESCE(SUM(pl.face_amount * ${w}),0)                    AS total_face,
         COALESCE(SUM(${afterCarry('COALESCE(pl.death_benefit, pl.face_amount)',
           'pl.total_invested', 1)} * ${w}),0)                      AS total_death_benefit,
         COALESCE(SUM(pl.cash_surrender_value * ${w}),0)           AS total_csv,
         COALESCE(SUM(pl.account_value * ${w}),0)                  AS total_av,
         COALESCE(SUM(pl.total_invested * ${w}),0)                 AS total_invested,
         COALESCE(SUM(pl.total_acquisition * ${w}),0)              AS total_acquisition,
         COALESCE(SUM(pl.total_premiums * ${w}),0)                 AS total_premiums,
         COALESCE(SUM(pl.cost_of_insurance * ${w}),0)              AS monthly_coi
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND ${vis} AND ($3 = '' OR pl.fund_code = $3)`, [scope, funds, fund]),
    q(`SELECT pl.carrier_name, COUNT(*)::int AS n,
              COALESCE(SUM(pl.face_amount * ${w}),0) AS face
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND ${vis}
          AND ($3 = '' OR pl.fund_code = $3)
        GROUP BY pl.carrier_name ORDER BY face DESC`, [scope, funds, fund]),
    q(`SELECT to_char(date_trunc('month', t.txn_date),'YYYY-MM') AS month,
              SUM(t.amount * (COALESCE((SELECT pix.pct FROM policy_investors pix
                    WHERE pix.policy_id = t.policy_id AND pix.investor_id = $1), 100) / 100.0)) AS amount
         FROM transactions t
        WHERE t.txn_type IN ('Acquisition Cost','Premium Payment','Fee','Servicing','Commission')
          AND ${visibleTo('t.policy_id', '(SELECT fund_id FROM policies WHERE id = t.policy_id)', 1, 2)}
          AND ($3 = '' OR (SELECT f.code FROM funds f
                 WHERE f.id = (SELECT fund_id FROM policies WHERE id = t.policy_id)) = $3)
        GROUP BY 1 ORDER BY 1`, [scope, funds, fund]),
    /* Average age of the lives the book is exposed to.
       Counted over distinct people, not over policies, and every life on
       a contract rather than only the primary — two policies on the same
       person is one life, and a survivorship contract is two. The same
       rule the per-entity figure uses, so the dashboard and the entity
       table can never disagree about the same book. */
    q(`SELECT
         COUNT(*)::int                                                    AS lives,
         COUNT(i.dob)::int                                                AS with_dob,
         COALESCE(AVG(EXTRACT(YEAR FROM age(CURRENT_DATE, i.dob))), 0)    AS avg_age
       FROM insureds i
      WHERE i.date_of_death IS NULL
        AND i.id IN (
          SELECT pl.insured_id
            FROM policy_latest pl
           WHERE pl.insured_id IS NOT NULL
             AND pl.status NOT IN ('Lapsed','Sold','Matured')
             AND ${vis} AND ($3 = '' OR pl.fund_code = $3)
          UNION
          SELECT pi.insured_id
            FROM policy_insureds pi
            JOIN policy_latest pl2 ON pl2.id = pi.policy_id
           WHERE pl2.status NOT IN ('Lapsed','Sold','Matured')
             AND ${visibleTo('pl2.id', 'pl2.fund_id', 1, 2)}
             AND ($3 = '' OR pl2.fund_code = $3))`, [scope, funds, fund]),
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

  // Book-level return. Every policy's dated flows in one series, with each
  // live policy carrying a death benefit dated today — "what the book has
  // returned if every remaining insured died this morning". Realized
  // policies contribute the cheque that actually arrived, on the day it
  // arrived, so this converges on the true number as the book runs off.
  const { byPolicy: bookFlows } = await portfolioFlows(req, { fund });
  /* Pooled per policy, not poured into one series: simple interest measures
     each dollar against one end date, and a book has one per policy. See
     `poolFlows` in public/irr.js. */
  const returnOnBook = poolFlows([...bookFlows.values()]);

  /* Carry is totalled over the LIVE book only. What a matured policy has
     produced belongs to the Maturities register, which splits it into earned
     and still-to-come; adding it in here as well would report the same money
     twice under a heading that says "if every policy matured today". */
  const { policies: flowPolicies, byPolicy } = scope !== null
    ? { policies: [], byPolicy: new Map() }
    : await portfolioFlows(req, { basis: 'active', fund });

  /* What the managing partner's share would come to if every policy still
     running matured today — ours to see, never sent to an investor. It is a
     projection and is labelled as one; carry actually earned is on the
     Maturities register, where the claims that produced it are. */
  const carry = scope !== null ? null : (() => {
    let total = 0, charged = 0, none = 0;
    for (const p of flowPolicies) {
      const rate = Number(p.carry_pct) || 0;
      if (!rate) { none++; continue; }
      const a = analyzeFlows(byPolicy.get(p.id) || []);
      const amount = carryOn(a.returned, a.invested, rate);
      if (amount > 0) charged++;
      total += amount;
    }
    return { total, policies: charged, policies_without_carry: none, projected: true };
  })();

  res.json({
    fund,
    totals: totals.rows[0],
    // Spread, not `carry: null`: the key name alone would announce it.
    ...(carry ? { carry } : {}),
    byCarrier: byCarrier.rows,
    capitalDeployed: cumulative,
    avgInsuredAge: Number(ages.rows[0].avg_age) || 0,
    lives: Number(ages.rows[0].lives) || 0,
    livesWithDob: Number(ages.rows[0].with_dob) || 0,
    rate: returnOnBook,
    scopedToInvestor: scope !== null,
  });
}));


/* ------------------------------------------------------------------ *
 * Opportunities
 *
 * A policy being offered rather than owned. Managers and above create
 * them, choose which investors see each one, and confirm the requests
 * that come back. An investor sees only what has been shared with them,
 * how much is left, and what the return looks like if the insured lives
 * two years past life expectancy.
 * ------------------------------------------------------------------ */

const oppEdit = requireRole('admin', 'editor', 'manager');

/** The entity filter for opportunities, mirroring the policy rules. */
const oppFundScope = (req) => (isManager(req) ? (req.user.fundIds?.length ? req.user.fundIds : [-1]) : null);

/**
 * Can this caller see this opportunity at all?
 * Investors: only if it has been shared with them and is still open.
 * Managers: only inside their entities. Everyone else: yes.
 */
/**
 * A passed deal is one we decided against. It is kept — the reasoning, the
 * medical file and the price we would not pay are worth having the next time
 * the same policy comes round — but it disappears from everybody's list
 * except an administrator's. Only an admin can bring it back.
 */
const isAdmin = (req) => req.user?.role === 'admin';
const canSeePassed = (req) => isAdmin(req);

async function oppVisible(req, id) {
  const { rows } = await q(
    `SELECT o.id, o.fund_id, o.status,
            EXISTS (SELECT 1 FROM opportunity_shares s
                     WHERE s.opportunity_id = o.id AND s.investor_id = $2) AS shared
       FROM opportunities o WHERE o.id = $1`,
    [id, scopeId(req) ?? -1]
  );
  const o = rows[0];
  if (!o) return null;
  if (o.status === 'Passed' && !canSeePassed(req)) return null;
  if (isInvestor(req)) return o.shared && o.status === 'Open' ? o : null;
  const funds = oppFundScope(req);
  if (funds && !funds.includes(o.fund_id)) return null;
  return o;
}

/* Open → live. Passed → we said no; admin-only. Closed/Withdrawn → off the
   table without a decision recorded. Funded → it became a policy. */
const OPP_STATUSES = ['Open', 'Passed', 'Closed', 'Withdrawn', 'Funded'];

/**
 * The smallest slice an investor may ask for.
 *
 * A life settlement is not a liquid instrument — every position carries years
 * of premium calls, servicing and paperwork, and a cap table of twenty
 * two-per-cent holders costs more to administer than the small tickets are
 * worth. Ten per cent is the floor.
 *
 * The one exception is the last slice. If fewer than ten points are left, an
 * investor may take exactly what remains: a floor that could leave a deal
 * permanently six per cent short would be a worse rule than no floor at all.
 * So the effective minimum is `min(10, what is left)`.
 *
 * It binds what an INVESTOR may request. A manager confirming a request is
 * making a commercial decision and is not held to it.
 */
export const MIN_COMMITMENT_PCT = 10;

/** The smallest request that can be accepted right now, given what is left. */
export const minimumTake = (remainingPct) =>
  Math.min(MIN_COMMITMENT_PCT, Math.max(0, Number(remainingPct) || 0));

/** "10%" rather than "10.0000%", but "6.25%" when the figure needs it. */
const pctText = (n) => {
  const v = Number(n) || 0;
  return `${v % 1 ? String(Number(v.toFixed(2))) : String(Math.round(v))}%`;
};

const OPP_FIELDS = {
  policy_number: str, carrier_name: str, product_type: str, face_amount: num,
  insured_last_name: str, insured_first_name: str, insured_dob: date,
  insured_gender: str, insured_state: str,
  le_months: int, le_provider: str, le_date: date,
  asking_price: num, annual_premium: num, expected_close: date, offer_closes_on: date,
  fund_id: int, status: str, notes: str,
  // The one-pager's narrative. Free text, one bullet per line.
  le_provider_2: str, le_months_2: int, impairments: str, mitigating: str,
  underwriter_note: str, thesis: str, records_through: date,
  // The carrier's current statement of what the policy holds.
  account_value: num, cash_surrender_value: num, values_as_of: date,
};

/** Everything an opportunity carries, with its analysis. */
async function loadOpportunity(req, id) {
  const { rows } = await q(
    `SELECT o.*, f.code AS fund_code,
            t.taken_pct, t.confirmed_pct, t.requested_pct, t.investor_count
       FROM opportunities o
       LEFT JOIN funds f ON f.id = o.fund_id
       LEFT JOIN opportunity_taken t ON t.opportunity_id = o.id
      WHERE o.id = $1`, [id]);
  const o = rows[0];
  if (!o) return null;

  const [prem, shares, commits] = await Promise.all([
    q('SELECT * FROM opportunity_premiums WHERE opportunity_id = $1 ORDER BY due_date', [id]),
    /* Who this was shown to, and when. Sharing is the moment an
       opportunity leaves the office, so it is recorded rather than
       inferred from who happens to have access today. */
    q(`SELECT s.investor_id, i.name, s.shared_at, u.full_name AS shared_by_name
         FROM opportunity_shares s
         JOIN investors i ON i.id = s.investor_id
         LEFT JOIN users u ON u.id = s.shared_by
        WHERE s.opportunity_id = $1 ORDER BY s.shared_at, i.name`, [id]),
    q(`SELECT c.*, i.name AS investor_name FROM opportunity_commitments c
         JOIN investors i ON i.id = c.investor_id
        WHERE c.opportunity_id = $1 ORDER BY c.requested_at`, [id]),
  ]);

  o.premiums = prem.rows;
  o.taken_pct = Number(o.taken_pct) || 0;
  o.confirmed_pct = Number(o.confirmed_pct) || 0;
  o.remaining_pct = Math.max(0, 100 - o.taken_pct);

  const me = scopeId(req);
  if (me === null) {
    o.shares = shares.rows;
    o.commitments = commits.rows;
  } else {
    // An investor sees their own line and nothing about anybody else —
    // the same rule the policy cap table follows.
    o.shares = undefined;
    o.commitments = commits.rows.filter((c) => c.investor_id === me)
      .map((c) => ({ id: c.id, pct: Number(c.pct), status: c.status,
                     requested_at: c.requested_at, notes: c.notes }));
    o.my_commitment = o.commitments[0] || null;
  }

  /* Sent rather than assumed, so the portal never states a floor the server
     would disagree with — including on the last slice, where it is smaller.
     Their own existing request is added back, because replacing it is not
     competing with it. */
  o.min_commitment_pct = minimumTake(
    o.remaining_pct + (Number(o.my_commitment?.pct) || 0));

  const share = me === null ? 1 : (Number(o.my_commitment?.pct) || 0) / 100;
  /* Net for an investor: they are weighing up what they would actually
     receive, and every figure on that page has to be the same money. */
  const { rows: fr } = await q('SELECT carry_pct FROM funds WHERE id = $1', [o.fund_id]);
  const oppCarry = me === null ? 0 : Number(fr[0]?.carry_pct) || 0;
  o.analysis = analyseOpportunity(o, 1, oppCarry);
  // Alongside the whole-policy figures, what their own slice would cost.
  o.my_analysis = share > 0 ? analyseOpportunity(o, share, oppCarry) : null;
  return o;
}

router.get('/opportunities', wrap(async (req, res) => {
  const me = scopeId(req);
  const funds = oppFundScope(req);
  const { rows } = await q(
    `SELECT o.id, o.policy_number, o.carrier_name, o.product_type, o.face_amount,
            o.insured_last_name, o.insured_first_name, o.insured_dob, o.insured_gender,
            o.insured_state, o.le_months, o.le_date, o.asking_price, o.annual_premium,
            o.expected_close, o.offer_closes_on, o.status, o.fund_id, o.notes,
            o.created_at, f.code AS fund_code,
            COALESCE(f.carry_pct, 0)      AS carry_pct,
            COALESCE(t.taken_pct, 0)      AS taken_pct,
            COALESCE(t.confirmed_pct, 0)  AS confirmed_pct,
            (SELECT COUNT(*)::int FROM opportunity_shares s WHERE s.opportunity_id = o.id) AS shared_with,
            (SELECT c.pct FROM opportunity_commitments c
              WHERE c.opportunity_id = o.id AND c.investor_id = $1
                AND c.status IN ('Requested','Confirmed')) AS my_pct,
            (SELECT c.status FROM opportunity_commitments c
              WHERE c.opportunity_id = o.id AND c.investor_id = $1) AS my_status
       FROM opportunities o
       LEFT JOIN funds f ON f.id = o.fund_id
       LEFT JOIN opportunity_taken t ON t.opportunity_id = o.id
      WHERE ($1::int IS NULL OR (o.status = 'Open' AND EXISTS (
               SELECT 1 FROM opportunity_shares s
                WHERE s.opportunity_id = o.id AND s.investor_id = $1)))
        AND ($2::int[] IS NULL OR o.fund_id = ANY($2))
        -- A passed deal is on file but off the list, for everybody but an admin.
        AND (o.status <> 'Passed' OR $3::boolean)
      ORDER BY (o.status = 'Open') DESC, o.offer_closes_on NULLS LAST, o.created_at DESC`,
    [me, funds, canSeePassed(req)]
  );

  // Pull every schedule in one query: a rate computed from the stated
  // annual premium would not match the one on the detail page, and two
  // different numbers for the same deal is worse than none.
  const { rows: prem } = rows.length
    ? await q(`SELECT opportunity_id, due_date, amount FROM opportunity_premiums
                WHERE opportunity_id = ANY($1) ORDER BY due_date`, [rows.map((r) => r.id)])
    : { rows: [] };
  const schedules = new Map();
  for (const p of prem) {
    if (!schedules.has(p.opportunity_id)) schedules.set(p.opportunity_id, []);
    schedules.get(p.opportunity_id).push(p);
  }

  const list = rows.map((o) => {
    const taken = Number(o.taken_pct) || 0;
    const withPremiums = { ...o, premiums: schedules.get(o.id) || [] };
    const a = analyseOpportunity(withPremiums, 1,
      me === null ? 0 : Number(o.carry_pct) || 0);
    return {
      ...o,
      taken_pct: taken,
      remaining_pct: Math.max(0, 100 - taken),
      min_commitment_pct: minimumTake(
        Math.max(0, 100 - taken) + (Number(o.my_pct) || 0)),
      rate_at_le: a.base?.rate ?? null,
      matures_on: a.base?.matures_on ?? null,
      shared_with: me === null ? o.shared_with : undefined,
    };
  });
  res.json(list);
}));

/** Just the count, for the badge in the menu. */
router.get('/opportunities/summary', wrap(async (req, res) => {
  const me = scopeId(req);
  const funds = oppFundScope(req);
  const { rows } = await q(
    `SELECT COUNT(*)::int AS open,
            COUNT(*) FILTER (WHERE c.id IS NULL)::int AS undecided
       FROM opportunities o
       LEFT JOIN opportunity_commitments c
              ON c.opportunity_id = o.id AND c.investor_id = $1
      WHERE o.status = 'Open'
        AND ($1::int IS NULL OR EXISTS (SELECT 1 FROM opportunity_shares s
              WHERE s.opportunity_id = o.id AND s.investor_id = $1))
        AND ($2::int[] IS NULL OR o.fund_id = ANY($2))`,
    [me, funds]
  );
  // For an investor the badge counts what they have not answered yet; for
  // staff it counts what is live.
  res.json({ open: rows[0].open, undecided: me === null ? rows[0].open : rows[0].undecided });
}));

router.get('/opportunities/:id', wrap(async (req, res) => {
  if (!(await oppVisible(req, req.params.id)))
    return res.status(404).json({ error: 'Opportunity not found' });
  const o = await loadOpportunity(req, req.params.id);
  if (!o) return res.status(404).json({ error: 'Opportunity not found' });
  res.json(o);
}));

router.post('/opportunities', blockInvestors, oppEdit, wrap(async (req, res) => {
  const funds = oppFundScope(req);
  const fundId = int(req.body.fund_id);
  if (funds && !funds.includes(fundId))
    return res.status(403).json({ error: 'Choose one of your own owner entities' });
  if (!str(req.body.insured_last_name) && !str(req.body.policy_number))
    return res.status(400).json({ error: 'A policy number or an insured last name is required' });
  if ('status' in req.body && !OPP_STATUSES.includes(str(req.body.status)))
    return res.status(400).json({ error: `Status must be one of ${OPP_STATUSES.join(', ')}` });

  const { cols, vals } = buildSet(OPP_FIELDS, req.body);
  cols.push('created_by'); vals.push(req.user.uid);
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q(
    `INSERT INTO opportunities (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
  await audit(req.user.uid, 'opportunity', rows[0].id, 'create',
    `${rows[0].policy_number || rows[0].insured_last_name} · ${rows[0].carrier_name}`);
  res.status(201).json(rows[0]);
}));

router.put('/opportunities/:id', blockInvestors, oppEdit, wrap(async (req, res) => {
  if (!(await oppVisible(req, req.params.id)))
    return res.status(404).json({ error: 'Opportunity not found' });
  const funds = oppFundScope(req);
  if (funds && 'fund_id' in req.body && !funds.includes(int(req.body.fund_id)))
    return res.status(403).json({ error: 'That owner entity is not one of yours' });
  if ('status' in req.body && !OPP_STATUSES.includes(str(req.body.status)))
    return res.status(400).json({ error: `Status must be one of ${OPP_STATUSES.join(', ')}` });
  // Funded is a consequence of creating the policy, never a label typed on by
  // hand: setting it here would leave an opportunity claiming a policy that
  // does not exist. Use POST /opportunities/:id/fund.
  if (str(req.body.status) === 'Funded') {
    const cur = await q('SELECT policy_id FROM opportunities WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]?.policy_id)
      return res.status(400).json({
        error: 'Use "Fund it" to mark this funded — that creates the policy in the portfolio, '
          + 'or links it to one already there.' });
  }

  const { sets, vals, next } = buildSet(OPP_FIELDS, req.body);
  if (!sets.length) return res.status(400).json({ error: 'No fields supplied' });
  const { rows } = await q(
    `UPDATE opportunities SET ${sets.join(',')}, updated_at = now() WHERE id = $${next} RETURNING *`,
    [...vals, req.params.id]);
  await audit(req.user.uid, 'opportunity', rows[0].id, 'update', sets.join(','));
  res.json(rows[0]);
}));

router.delete('/opportunities/:id', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    if (!(await oppVisible(req, req.params.id)))
      return res.status(404).json({ error: 'Opportunity not found' });
    const { rows } = await q('SELECT * FROM opportunities WHERE id = $1', [req.params.id]);
    await audit(req.user.uid, 'opportunity', Number(req.params.id), 'delete',
      `${rows[0].policy_number || rows[0].insured_last_name} · ${rows[0].carrier_name}`);
    await q('DELETE FROM opportunities WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

/* ------------------------------------------------------------------ *
 * Clearing several at once
 *
 * A shelf of opportunities goes stale faster than anything else here —
 * deals that were never taken, duplicates from a broker's list, a batch
 * keyed in for a fund that never happened. Removing them one page at a
 * time is the kind of chore that ends with somebody leaving the mess.
 *
 * Only an administrator, and only with the count typed out. A manager can
 * still delete one at a time from its own page, which is the deliberate
 * act this is not.
 * ------------------------------------------------------------------ */

/** Which ids were asked for, cleaned up — no duplicates, no rubbish. */
function bulkOppIds(body) {
  const raw = Array.isArray(body?.ids) ? body.ids : [];
  const ids = [...new Set(raw.map((v) => int(v)).filter((v) => Number.isInteger(v) && v > 0))];
  if (!ids.length) return { error: 'Choose at least one opportunity to delete.' };
  if (ids.length > BULK_DELETE_LIMIT)
    return { error: `That is ${ids.length}. Delete at most ${BULK_DELETE_LIMIT} at a time.` };
  return { ids };
}

/**
 * What would go, before anything does.
 *
 * Scoped exactly as reading is: an administrator sees every entity, so this
 * is not narrowed further — but it is still built from a query rather than
 * from the ids as posted, so an id for something that does not exist simply
 * does not come back rather than being deleted blind.
 */
async function bulkOppTally(ids) {
  const { rows } = await q(
    `SELECT o.id, o.policy_number, o.carrier_name, o.status, o.face_amount,
            o.insured_last_name, o.insured_first_name, f.code AS fund_code,
            o.policy_id,
            (SELECT COUNT(*)::int FROM opportunity_shares s
              WHERE s.opportunity_id = o.id) AS shared_with,
            (SELECT COUNT(*)::int FROM opportunity_commitments c
              WHERE c.opportunity_id = o.id AND c.status IN ('Requested','Confirmed'))
                                              AS live_requests,
            (SELECT COUNT(*)::int FROM opportunity_premiums pm
              WHERE pm.opportunity_id = o.id) AS premium_rows
       FROM opportunities o
       LEFT JOIN funds f ON f.id = o.fund_id
      WHERE o.id = ANY($1::int[])
      ORDER BY o.insured_last_name, o.policy_number`,
    [ids]);
  const sum = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  return {
    count: rows.length,
    opportunities: rows,
    shares: sum('shared_with'),
    requests: sum('live_requests'),
    premiums: sum('premium_rows'),
    /* A deal that was funded became a policy. Deleting the opportunity does
       not touch the policy, but it does throw away where it came from, so it
       is called out separately rather than counted in with the rest. */
    funded: rows.filter((r) => r.policy_id || r.status === 'Funded').length,
    confirm_phrase: bulkDeletePhrase(rows.length),
  };
}

router.post('/opportunities/bulk-delete/preview', blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const { ids, error } = bulkOppIds(req.body);
    if (error) return res.status(400).json({ error });
    const tally = await bulkOppTally(ids);
    const missing = ids.filter((id) => !tally.opportunities.some((o) => o.id === id));
    res.json({ ...tally, missing });
  }));

router.post('/opportunities/bulk-delete', blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const { ids, error } = bulkOppIds(req.body);
    if (error) return res.status(400).json({ error });

    const tally = await bulkOppTally(ids);
    if (tally.count !== ids.length) {
      const gone = ids.length - tally.count;
      return res.status(409).json({
        error: `${gone} of those no longer ${gone === 1 ? 'exists' : 'exist'}. `
             + 'Reload and choose again.',
        found: tally.count,
      });
    }
    if (str(req.body?.confirm) !== tally.confirm_phrase)
      return res.status(400).json({
        error: `Type ${tally.confirm_phrase} to confirm.`,
        confirm_phrase: tally.confirm_phrase,
      });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        'DELETE FROM opportunities WHERE id = ANY($1::int[])', [ids]);
      if (rowCount !== ids.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'The selection changed while it was being deleted. Nothing was removed.' });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    /* One entry each, in the same shape a single deletion writes, so the log
       reads the same however a deal was removed — and marked as part of a
       batch, because thirty entries at the same second with no explanation is
       its own kind of alarming. */
    for (const o of tally.opportunities)
      await audit(req.user.uid, 'opportunity', o.id, 'delete',
        `${o.policy_number || o.insured_last_name} · ${o.carrier_name} · ${o.status} · `
        + `${o.shared_with} shared · ${o.live_requests} live request(s) · `
        + `bulk delete of ${tally.count}`);

    res.json({ ok: true, deleted: tally.count, shares: tally.shares,
      requests: tally.requests, premiums: tally.premiums });
  }));

/* ==================================================================== *
 * Capital calls
 *
 * The ask, and the trail of what came back. A call is raised over a
 * window of premiums that are coming due, split across the investors who
 * hold those policies, and given ONE date the money has to be in by —
 * which is the thing a premium schedule cannot tell anybody, because a
 * carrier's due date is when the carrier wants it, not when the office
 * needs it in the account.
 *
 * Three properties this has to hold:
 *
 *   - a notice does not change after it is sent. The premiums it covers
 *     are copied onto the call, not joined to; a schedule that moves
 *     afterwards does not rewrite what somebody was asked for.
 *   - what an investor says and what the office saw are separate facts.
 *     An investor marking a line paid is a claim. Confirming it is a
 *     receipt. Collapsing the two would mean either treating a claim as
 *     money in the bank or giving the investor no way to say anything.
 *   - nobody is asked for somebody else's share. A line is that
 *     investor's percentage of each policy in the call, and an investor
 *     sees their own line and the total of the call, never anybody
 *     else's.
 * ==================================================================== */

const CALL_STATUSES = ['Open', 'Closed', 'Cancelled'];

/** Which calls this reader may see at all. */
function callScope(req) {
  if (isInvestor(req))
    return { sql: `EXISTS (SELECT 1 FROM capital_call_lines l
                            WHERE l.call_id = c.id AND l.investor_id = $1)`,
             params: [Number(req.user.iid)] };
  const funds = fundScope(req);
  if (funds) return { sql: '(c.fund_id IS NULL OR c.fund_id = ANY($1))', params: [funds] };
  return { sql: 'TRUE', params: [] };
}

/** A call with its items and lines, or null. */
async function loadCall(id) {
  const { rows } = await q(
    `SELECT c.*, f.code AS fund_code, u.full_name AS raised_by
       FROM capital_calls c
       LEFT JOIN funds f ON f.id = c.fund_id
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = $1`, [id]);
  const call = rows[0];
  if (!call) return null;
  const [items, lines] = await Promise.all([
    q(`SELECT * FROM capital_call_items WHERE call_id = $1 ORDER BY due_date, insured_name`, [id]),
    q(`SELECT l.*, i.name AS investor_name, i.email AS investor_email,
              u.email AS login_email, u.id AS user_id
         FROM capital_call_lines l
         JOIN investors i ON i.id = l.investor_id
         LEFT JOIN users u ON u.investor_id = i.id AND u.is_active = TRUE
        WHERE l.call_id = $1 ORDER BY i.name`, [id]),
  ]);
  call.items = items.rows;
  call.lines = lines.rows;
  call.total = call.lines.reduce((n, l) => n + Number(l.amount || 0), 0);
  call.collected = call.lines.filter((l) => l.confirmed_at)
    .reduce((n, l) => n + Number(l.amount || 0), 0);
  call.claimed = call.lines.filter((l) => l.marked_paid_at && !l.confirmed_at)
    .reduce((n, l) => n + Number(l.amount || 0), 0);
  return call;
}

const callVisible = async (req, id) => {
  const scope = callScope(req);
  const { rows } = await q(
    `SELECT c.id FROM capital_calls c
      WHERE c.id = $${scope.params.length + 1} AND ${scope.sql}`, [...scope.params, id]);
  return !!rows[0];
};

/**
 * What is coming due, and who would be asked for what.
 *
 * The same figures the premium forecast produces, turned round: by
 * investor rather than by month, because that is the shape of the ask.
 * Nothing is written — this is what the form shows before anybody commits
 * to sending it.
 */
router.get('/capital-calls/draft', blockInvestors, canEdit, wrap(async (req, res) => {
  const days = Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 30));
  const fund = str(req.query.fund);
  const scope = scopeId(req);
  const funds = fundScope(req);
  const to = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  /* Premiums the carrier has dated inside the window, plus anything posted
     to the schedule by hand — the same two sources the forecast reads, for
     the same reason: a book imported without a next-due column would
     otherwise produce an empty call. */
  const { rows: carrier } = await q(
    `SELECT pl.id AS policy_id, pl.policy_number, pl.carrier_name,
            COALESCE(pl.display_name,
                     TRIM(COALESCE(pl.insured_first,'') || ' ' || COALESCE(pl.insured_last,'')))
              AS insured_name,
            pl.next_premium_due AS due_date, pl.premium_required AS amount, pl.fund_id
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
        AND pl.next_premium_due IS NOT NULL AND pl.next_premium_due <= $4::date
        AND COALESCE(pl.premium_required, 0) > 0
        AND ($3 = '' OR pl.fund_code = $3)
        AND ${visibleTo('pl.id', 'pl.fund_id', 1, 2)}
      ORDER BY pl.next_premium_due`,
    [scope, funds, fund, to]);
  const { rows: posted } = await q(
    `SELECT pl.id AS policy_id, pl.policy_number, pl.carrier_name,
            COALESCE(pl.display_name,
                     TRIM(COALESCE(pl.insured_first,'') || ' ' || COALESCE(pl.insured_last,'')))
              AS insured_name,
            r.due_date, r.amount, pl.fund_id, r.note
       FROM policy_reminders r
       JOIN policy_latest pl ON pl.id = r.policy_id
      WHERE r.kind = 'Premium' AND r.done_at IS NULL
        AND r.due_date >= CURRENT_DATE AND r.due_date <= $4::date
        AND pl.status NOT IN ('Lapsed','Sold','Matured')
        AND ($3 = '' OR pl.fund_code = $3)
        AND ${visibleTo('pl.id', 'pl.fund_id', 1, 2)}
      ORDER BY r.due_date`,
    [scope, funds, fund, to]);

  const items = [...carrier, ...posted].map((r) => ({
    ...r, amount: Number(r.amount) || 0,
    due_date: String(r.due_date).slice(0, 10),
  }));
  if (!items.length)
    return res.json({ days, to, items: [], investors: [], total: 0, unallocated: 0 });

  /* Who holds what, at the percentages on file now. A call is a snapshot:
     somebody who buys in next week is not asked for this one. */
  const { rows: holders } = await q(
    `SELECT pi.policy_id, pi.investor_id, pi.pct, i.name
       FROM policy_investors pi JOIN investors i ON i.id = pi.investor_id
      WHERE pi.policy_id = ANY($1)`, [items.map((i) => i.policy_id)]);

  const byInvestor = new Map();
  let unallocated = 0;
  for (const item of items) {
    const mine = holders.filter((h) => h.policy_id === item.policy_id);
    const held = mine.reduce((n, h) => n + Number(h.pct), 0);
    /* The house's own share. Named rather than spread over the investors,
       because asking somebody for a percentage they do not hold is how a
       capital call becomes an argument. */
    unallocated += item.amount * Math.max(0, 100 - held) / 100;
    for (const h of mine) {
      const at = byInvestor.get(h.investor_id)
        || { investor_id: h.investor_id, name: h.name, amount: 0, policies: 0 };
      at.amount += item.amount * Number(h.pct) / 100;
      at.policies++;
      byInvestor.set(h.investor_id, at);
    }
  }

  res.json({
    days, to, items,
    investors: [...byInvestor.values()].sort((a, b) => b.amount - a.amount),
    total: items.reduce((n, i) => n + i.amount, 0),
    unallocated,
  });
}));

router.get('/capital-calls', wrap(async (req, res) => {
  const scope = callScope(req);
  const mine = isInvestor(req) ? Number(req.user.iid) : null;
  const { rows } = await q(
    `SELECT c.*, f.code AS fund_code,
            (SELECT COUNT(*)::int FROM capital_call_lines l WHERE l.call_id = c.id) AS parties,
            (SELECT COALESCE(SUM(l.amount),0) FROM capital_call_lines l WHERE l.call_id = c.id)
              AS total,
            (SELECT COALESCE(SUM(l.amount),0) FROM capital_call_lines l
              WHERE l.call_id = c.id AND l.confirmed_at IS NOT NULL) AS collected,
            (SELECT l.amount FROM capital_call_lines l
              WHERE l.call_id = c.id AND l.investor_id = $${scope.params.length + 1}) AS my_amount,
            (SELECT l.marked_paid_at FROM capital_call_lines l
              WHERE l.call_id = c.id AND l.investor_id = $${scope.params.length + 1})
              AS my_marked_at,
            (SELECT l.confirmed_at FROM capital_call_lines l
              WHERE l.call_id = c.id AND l.investor_id = $${scope.params.length + 1})
              AS my_confirmed_at
       FROM capital_calls c
       LEFT JOIN funds f ON f.id = c.fund_id
      WHERE ${scope.sql}
      ORDER BY (c.status = 'Open') DESC, c.due_date DESC, c.id DESC`,
    [...scope.params, mine]);
  res.json(rows);
}));

router.get('/capital-calls/:id', wrap(async (req, res) => {
  if (!(await callVisible(req, req.params.id)))
    return res.status(404).json({ error: 'Capital call not found' });
  const call = await loadCall(req.params.id);
  if (isInvestor(req)) {
    /* Their own line, the total of the call, and what it is for. Who else
       was asked and for how much is somebody else's business. */
    const mine = Number(req.user.iid);
    call.lines = call.lines.filter((l) => l.investor_id === mine)
      .map((l) => ({ ...l, investor_email: undefined, login_email: undefined }));
    call.me = call.lines[0] || null;
  }
  res.json(call);
}));

/** Raise one. This is the moment the figures stop moving. */
router.post('/capital-calls', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    const due = date(req.body.due_date);
    if (!due) return res.status(400).json({ error: 'Give the date the money has to be in by' });
    if (due < today())
      return res.status(400).json({ error: 'That date has already passed' });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length)
      return res.status(400).json({ error: 'A call has to cover at least one premium' });

    const fundId = int(req.body.fund_id);
    const scoped = fundScope(req);
    if (fundId && scoped && !scoped.includes(fundId))
      return res.status(403).json({ error: 'That owner entity is not one of yours' });

    /* Every policy named has to be one this person may see. Otherwise a call
       is a way to read a premium out of somebody else's book. */
    const policyIds = [...new Set(items.map((i) => int(i.policy_id)).filter(Boolean))];
    const { rows: allowed } = await q(
      `SELECT pl.id, pl.policy_number, pl.carrier_name,
              COALESCE(pl.display_name,
                       TRIM(COALESCE(pl.insured_first,'') || ' ' || COALESCE(pl.insured_last,'')))
                AS insured_name
         FROM policy_latest pl
        WHERE pl.id = ANY($3) AND ${visibleTo('pl.id', 'pl.fund_id', 1, 2)}`,
      [scopeId(req), fundScope(req), policyIds]);
    if (allowed.length !== policyIds.length)
      return res.status(403).json({ error: 'One of those policies is not one of yours' });
    const byId = new Map(allowed.map((p) => [p.id, p]));

    const { rows: holders } = await q(
      `SELECT policy_id, investor_id, pct FROM policy_investors WHERE policy_id = ANY($1)`,
      [policyIds]);

    const lines = new Map();
    const rows = [];
    for (const raw of items) {
      const policyId = int(raw.policy_id);
      const amount = num(raw.amount);
      if (!policyId || !amount || amount <= 0) continue;
      const p = byId.get(policyId);
      rows.push({ policyId, amount, due: date(raw.due_date),
        number: p.policy_number, carrier: p.carrier_name, insured: p.insured_name,
        note: str(raw.note) });
      for (const h of holders.filter((x) => x.policy_id === policyId))
        lines.set(h.investor_id,
          (lines.get(h.investor_id) || 0) + amount * Number(h.pct) / 100);
    }
    if (!rows.length) return res.status(400).json({ error: 'None of those premiums had an amount' });
    if (!lines.size)
      return res.status(400).json({
        error: 'Nobody holds a share of those policies, so there is nobody to ask.' });

    const client = await pool.connect();
    let callId;
    try {
      await client.query('BEGIN');
      const { rows: made } = await client.query(
        `INSERT INTO capital_calls (reference, title, fund_id, due_date, covers_from, covers_to,
                                    note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [str(req.body.reference), str(req.body.title) || 'Premium capital call', fundId, due,
         rows.reduce((d, r) => (!d || (r.due && r.due < d) ? r.due : d), null),
         rows.reduce((d, r) => (!d || (r.due && r.due > d) ? r.due : d), null),
         str(req.body.note), req.user.uid]);
      callId = made[0].id;
      for (const r of rows)
        await client.query(
          `INSERT INTO capital_call_items (call_id, policy_id, policy_number, carrier_name,
                                           insured_name, due_date, amount, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [callId, r.policyId, r.number, r.carrier, r.insured, r.due, r.amount, r.note]);
      for (const [investorId, amount] of lines)
        await client.query(
          `INSERT INTO capital_call_lines (call_id, investor_id, amount) VALUES ($1,$2,$3)`,
          [callId, investorId, Math.round(amount * 100) / 100]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const call = await loadCall(callId);
    await audit(req.user.uid, 'capital_call', callId, 'create',
      `${call.title} · ${rows.length} premium(s) · ${call.lines.length} investor(s) · `
      + `${call.total.toFixed(2)} due ${due}`);

    /* And they are told, once, with their own figure and the date. An ask
       nobody hears about is not an ask. */
    let told = 0;
    for (const line of call.lines) {
      const to = line.login_email || line.investor_email;
      if (!to) continue;
      const sent = await sendMail('capital_call', {
        to, userId: line.user_id || null, name: line.investor_name,
        amount: `$${Number(line.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        due, title: call.title,
        policies: rows.length, note: call.note,
      });
      if (sent.id) told++;
    }
    res.status(201).json({ ...call, notified: told });
  }));

/** An investor says the money has gone. A claim, not a receipt. */
router.post('/capital-calls/:id/paid', wrap(async (req, res) => {
  const mine = scopeId(req);
  if (mine === null) return res.status(403).json({ error: 'Not an investor account' });
  const { rows } = await q(
    `UPDATE capital_call_lines
        SET marked_paid_at = now(), marked_paid_by = $1, marked_note = $2
      WHERE call_id = $3 AND investor_id = $4 AND confirmed_at IS NULL
      RETURNING id, amount`,
    [req.user.uid, str(req.body.note).slice(0, 300), req.params.id, mine]);
  if (!rows[0])
    return res.status(409).json({
      error: 'Either this is not your call, or the office has already confirmed it.' });
  await audit(req.user.uid, 'capital_call', Number(req.params.id), 'update',
    `investor ${mine} says ${rows[0].amount} has been sent`);
  /* A claim needs somebody to go and look at a bank account, which nobody
     does on a schedule. */
  const { rows: ctx } = await q(
    `SELECT c.title, c.fund_id, i.name FROM capital_calls c, investors i
      WHERE c.id = $1 AND i.id = $2`, [req.params.id, mine]);
  await tellStaff('capital_call_paid',
    await staffAudience({ fundId: ctx[0]?.fund_id, investorId: mine }), {
      investor: ctx[0]?.name || `investor ${mine}`,
      amount: `$${Number(rows[0].amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      title: ctx[0]?.title || 'a capital call',
      note: str(req.body.note).slice(0, 300),
    });
  res.json({ ok: true });
}));

/** The office saw it arrive. A receipt. */
router.put('/capital-calls/:id/lines/:lineId', blockInvestors, canEdit, wrap(async (req, res) => {
  if (!(await callVisible(req, req.params.id)))
    return res.status(404).json({ error: 'Capital call not found' });
  const action = str(req.body.action);
  if (!['confirm', 'unconfirm', 'waive'].includes(action))
    return res.status(400).json({ error: 'Say what to do: confirm, unconfirm or waive' });

  const sets = action === 'confirm'
    ? `confirmed_at = now(), confirmed_by = ${req.user.uid}, waived_at = NULL`
    : action === 'waive'
      ? `waived_at = now(), confirmed_at = NULL, confirmed_by = NULL`
      : `confirmed_at = NULL, confirmed_by = NULL`;
  const { rows } = await q(
    `UPDATE capital_call_lines SET ${sets}
      WHERE id = $1 AND call_id = $2 RETURNING investor_id, amount`,
    [req.params.lineId, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'That line is not on this call' });
  await audit(req.user.uid, 'capital_call', Number(req.params.id), 'update',
    `${action} ${rows[0].amount} from investor ${rows[0].investor_id}`);

  /* Everything in and confirmed closes the call on its own — a list that
     stays open with nothing outstanding is a list nobody trusts. */
  const call = await loadCall(req.params.id);
  const outstanding = call.lines.filter((l) => !l.confirmed_at && !l.waived_at);
  if (!outstanding.length && call.status === 'Open')
    await q(`UPDATE capital_calls SET status = 'Closed', closed_at = now(), updated_at = now()
              WHERE id = $1`, [req.params.id]);
  res.json({ ok: true, outstanding: outstanding.length });
}));

router.put('/capital-calls/:id', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    if (!(await callVisible(req, req.params.id)))
      return res.status(404).json({ error: 'Capital call not found' });
    const status = str(req.body.status);
    if (!CALL_STATUSES.includes(status))
      return res.status(400).json({ error: 'Status must be Open, Closed or Cancelled' });
    await q(
      `UPDATE capital_calls SET status = $1, note = COALESCE(NULLIF($2,''), note),
                                closed_at = CASE WHEN $1 = 'Open' THEN NULL ELSE now() END,
                                updated_at = now()
        WHERE id = $3`, [status, str(req.body.note), req.params.id]);
    await audit(req.user.uid, 'capital_call', Number(req.params.id), 'update', status);
    res.json({ ok: true });
  }));

router.delete('/capital-calls/:id', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const call = await loadCall(req.params.id);
  if (!call) return res.status(404).json({ error: 'Capital call not found' });
  const paid = call.lines.filter((l) => l.confirmed_at).length;
  if (paid)
    return res.status(409).json({
      error: `${paid} payment${paid === 1 ? ' has' : 's have'} been confirmed against this call. `
        + 'Cancel it instead — that keeps the record of what was asked and what came in.' });
  await q('DELETE FROM capital_calls WHERE id = $1', [req.params.id]);
  await audit(req.user.uid, 'capital_call', Number(req.params.id), 'delete', call.title);
  res.json({ ok: true });
}));

/* ------------------------- premium schedule ------------------------- */

router.post('/opportunities/:id/premiums', blockInvestors, oppEdit, wrap(async (req, res) => {
  if (!(await oppVisible(req, req.params.id)))
    return res.status(404).json({ error: 'Opportunity not found' });
  const due = date(req.body.due_date);
  const amount = num(req.body.amount);
  if (!due) return res.status(400).json({ error: 'A due date is required' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'An amount is required' });
  const { rows } = await q(
    `INSERT INTO opportunity_premiums (opportunity_id, due_date, amount, notes)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (opportunity_id, due_date) DO UPDATE SET amount = EXCLUDED.amount
     RETURNING *`,
    [req.params.id, due, amount, str(req.body.notes)]);
  res.status(201).json(rows[0]);
}));

/**
 * Lay out a whole schedule at once.
 *
 * Two ways in. `rows` is the honest one: every year typed out individually,
 * which is what an actual carrier illustration gives you — the amounts step
 * up unevenly as cost of insurance rises, and no growth rate reproduces
 * that. `start_date`/`amount`/`years` is the shortcut for when the numbers
 * really are level, and only ever a starting point.
 *
 * Either way the write is all-or-nothing: the rows are validated in full
 * before anything is deleted, so a bad amount in year nine cannot leave a
 * half-replaced schedule behind.
 */
router.post('/opportunities/:id/premium-schedule', blockInvestors, oppEdit, wrap(async (req, res) => {
  if (!(await oppVisible(req, req.params.id)))
    return res.status(404).json({ error: 'Opportunity not found' });

  if (Array.isArray(req.body.rows)) {
    const rows = [];
    const seen = new Map();
    if (req.body.rows.length > 60)
      return res.status(400).json({ error: 'A schedule cannot run past 60 payments' });
    for (const [i, r] of req.body.rows.entries()) {
      const due = date(r.due_date);
      const amount = num(r.amount);
      if (!due) return res.status(400).json({ error: `Row ${i + 1} needs a due date` });
      if (amount === null || amount < 0)
        return res.status(400).json({ error: `Row ${i + 1} needs an amount of zero or more` });
      // Two payments cannot share a due date — the table enforces it, and
      // reporting it here names the year rather than throwing a constraint.
      if (seen.has(due))
        return res.status(400).json({ error: `Two payments are both dated ${due}` });
      seen.set(due, true);
      rows.push({ due, amount, notes: str(r.notes) });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM opportunity_premiums WHERE opportunity_id = $1', [req.params.id]);
      for (const r of rows)
        await client.query(
          `INSERT INTO opportunity_premiums (opportunity_id, due_date, amount, notes)
           VALUES ($1,$2,$3,$4)`, [req.params.id, r.due, r.amount, r.notes]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await audit(req.user.uid, 'opportunity', Number(req.params.id), 'update',
      `premium schedule: ${rows.length} payment${rows.length === 1 ? '' : 's'} entered by hand`);
    return res.json({ ok: true, written: rows.length });
  }

  const start = date(req.body.start_date);
  const amount = num(req.body.amount);
  const years = Math.min(40, Math.max(1, int(req.body.years) || 10));
  const growth = Number(req.body.growth_pct) || 0;
  if (!start || !amount) return res.status(400).json({ error: 'A start date and amount are required' });
  if (req.body.replace) await q('DELETE FROM opportunity_premiums WHERE opportunity_id = $1', [req.params.id]);

  let written = 0;
  for (let n = 0; n < years; n++) {
    const due = addMonths(start, 12 * n);
    const amt = Math.round(amount * (1 + growth / 100) ** n * 100) / 100;
    await q(
      `INSERT INTO opportunity_premiums (opportunity_id, due_date, amount)
       VALUES ($1,$2,$3) ON CONFLICT (opportunity_id, due_date) DO UPDATE SET amount = EXCLUDED.amount`,
      [req.params.id, due, amt]);
    written++;
  }
  await audit(req.user.uid, 'opportunity', Number(req.params.id), 'update',
    `premium schedule: ${written} years from ${start}`);
  res.json({ ok: true, written });
}));

/** Correct one payment — the date, the amount, or the note against it. */
router.put('/opportunity-premiums/:id', blockInvestors, oppEdit, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM opportunity_premiums WHERE id = $1', [req.params.id]);
  if (!rows[0] || !(await oppVisible(req, rows[0].opportunity_id)))
    return res.status(404).json({ error: 'Not found' });
  const due = req.body.due_date === undefined ? rows[0].due_date : date(req.body.due_date);
  const amount = req.body.amount === undefined ? Number(rows[0].amount) : num(req.body.amount);
  if (!due) return res.status(400).json({ error: 'A due date is required' });
  if (amount === null || amount < 0)
    return res.status(400).json({ error: 'An amount of zero or more is required' });
  const clash = await q(
    'SELECT 1 FROM opportunity_premiums WHERE opportunity_id = $1 AND due_date = $2 AND id <> $3',
    [rows[0].opportunity_id, due, req.params.id]);
  if (clash.rows.length)
    return res.status(400).json({ error: 'Another payment is already dated that day' });
  const updated = await q(
    `UPDATE opportunity_premiums SET due_date = $1, amount = $2, notes = $3
     WHERE id = $4 RETURNING *`,
    [due, amount, req.body.notes === undefined ? rows[0].notes : str(req.body.notes), req.params.id]);
  await audit(req.user.uid, 'opportunity', Number(rows[0].opportunity_id), 'update',
    `premium ${String(rows[0].due_date).slice(0, 10)} → ${due} ${amount}`);
  res.json(updated.rows[0]);
}));

router.delete('/opportunity-premiums/:id', blockInvestors, oppEdit, wrap(async (req, res) => {
  const { rows } = await q('SELECT opportunity_id FROM opportunity_premiums WHERE id = $1', [req.params.id]);
  if (!rows[0] || !(await oppVisible(req, rows[0].opportunity_id)))
    return res.status(404).json({ error: 'Not found' });
  await q('DELETE FROM opportunity_premiums WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------------------------- sharing ------------------------------- */

/** Replace the list of investors who can see this. */
router.put('/opportunities/:id/shares', blockInvestors, oppEdit, wrap(async (req, res) => {
  if (!(await oppVisible(req, req.params.id)))
    return res.status(404).json({ error: 'Opportunity not found' });
  const ids = (Array.isArray(req.body.investor_ids) ? req.body.investor_ids : [])
    .map((n) => parseInt(n, 10)).filter(Number.isInteger);

  // Someone who has already asked for a piece cannot be un-shared out from
  // under their own request; that would leave a commitment nobody can see.
  const { rows: held } = await q(
    `SELECT investor_id FROM opportunity_commitments
      WHERE opportunity_id = $1 AND status IN ('Requested','Confirmed')`, [req.params.id]);
  const locked = held.map((r) => r.investor_id);
  const missing = locked.filter((id) => !ids.includes(id));
  if (missing.length)
    return res.status(400).json({
      error: 'Those investors have already asked for a piece — decline their request before removing them.' });

  const barred = await investorsOutOfScope(req, ids);
  if (barred.length)
    return res.status(403).json({
      error: 'You can only share with investors in your own entities, or ones an administrator '
        + 'has given you access to.' });

  /* Who is newly on the list, worked out before the write — afterwards there
     is no way to tell somebody who was just added from somebody who has been
     able to see it for a month, and telling the second group again is how a
     notice becomes noise. */
  const { rows: had } = await q(
    'SELECT investor_id FROM opportunity_shares WHERE opportunity_id = $1', [req.params.id]);
  const fresh = ids.filter((id) => !had.some((h) => h.investor_id === id));

  await q('DELETE FROM opportunity_shares WHERE opportunity_id = $1 AND investor_id <> ALL($2)',
    [req.params.id, ids.length ? ids : [-1]]);
  for (const id of ids)
    await q(`INSERT INTO opportunity_shares (opportunity_id, investor_id, shared_by)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.params.id, id, req.user.uid]);
  await audit(req.user.uid, 'opportunity', Number(req.params.id), 'update',
    `shared with ${ids.length} investor(s)`);

  let told = 0;
  if (fresh.length) {
    const { rows: oppRows } = await q(
      `SELECT o.*, f.code AS fund_code FROM opportunities o
         LEFT JOIN funds f ON f.id = o.fund_id WHERE o.id = $1`, [req.params.id]);
    const opp = oppRows[0] || {};
    const { rows: people } = await q(
      `SELECT i.id, i.name, i.email, u.email AS login_email, u.id AS user_id
         FROM investors i LEFT JOIN users u ON u.investor_id = i.id AND u.is_active = TRUE
        WHERE i.id = ANY($1)`, [fresh]);
    /* What the deal is called in a sentence: the insured, the carrier, and
       the face — enough to recognise it without opening anything, and not so
       much that the email is the deal sheet. */
    const headline = [
      [opp.insured_last_name, opp.insured_first_name].filter(Boolean).join(', ')
        || opp.policy_number || 'a policy',
      opp.carrier_name,
      opp.face_amount
        ? `$${Number(opp.face_amount).toLocaleString('en-US')} death benefit` : '',
    ].filter(Boolean).join(' · ');
    for (const person of people) {
      const to = person.login_email || person.email;
      if (!to) continue;
      const sent = await sendMail('opportunity_shared', {
        to, userId: person.user_id || null, name: person.name, headline,
        closes: opp.offer_closes_on ? String(opp.offer_closes_on).slice(0, 10) : '',
      });
      if (sent.id) told++;
    }
  }
  res.json({ ok: true, shared_with: ids.length, notified: told });
}));

/* --------------------------- commitments ---------------------------- */

/**
 * An investor asks for a percentage.
 *
 * Taken inside a transaction that locks the opportunity row: two people
 * clicking at the same moment must not between them take 130% of a policy.
 */
router.post('/opportunities/:id/commit', wrap(async (req, res) => {
  const me = scopeId(req);
  if (me === null)
    return res.status(403).json({ error: 'Only an investor account can take a share' });
  const pct = num(req.body.pct);
  if (!pct || pct <= 0) return res.status(400).json({ error: 'Enter the percentage you want' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lock } = await client.query(
      `SELECT o.id, o.status, o.offer_closes_on
         FROM opportunities o WHERE o.id = $1 FOR UPDATE`, [req.params.id]);
    const o = lock[0];
    if (!o) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Opportunity not found' }); }

    const { rows: sh } = await client.query(
      'SELECT 1 FROM opportunity_shares WHERE opportunity_id = $1 AND investor_id = $2',
      [o.id, me]);
    if (!sh[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Opportunity not found' }); }
    if (o.status !== 'Open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This opportunity is no longer open' });
    }
    if (o.offer_closes_on && String(o.offer_closes_on).slice(0, 10) < today()) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The offer period for this opportunity has closed' });
    }

    const { rows: sum } = await client.query(
      `SELECT COALESCE(SUM(pct),0) AS taken FROM opportunity_commitments
        WHERE opportunity_id = $1 AND status IN ('Requested','Confirmed') AND investor_id <> $2`,
      [o.id, me]);
    const remaining = 100 - Number(sum[0].taken);
    if (pct > remaining + 1e-9) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: remaining <= 0
          ? 'This opportunity has just been fully spoken for.'
          : `Only ${remaining.toFixed(remaining % 1 ? 4 : 0)}% is still available.`,
        remaining_pct: Math.max(0, remaining),
      });
    }

    /* The floor, checked here rather than only in the browser: the rule is
       about what the firm will accept, so it has to hold for anything that
       can reach this route. */
    const floor = minimumTake(remaining);
    if (pct < floor - 1e-9) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: floor < MIN_COMMITMENT_PCT
          ? `Only ${pctText(remaining)} is left, and the last slice has to be taken whole — `
            + `ask for ${pctText(floor)}.`
          : `The smallest share we can take is ${pctText(MIN_COMMITMENT_PCT)}.`,
        min_commitment_pct: floor,
        remaining_pct: Math.max(0, remaining),
      });
    }

    const { rows } = await client.query(
      `INSERT INTO opportunity_commitments (opportunity_id, investor_id, pct, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (opportunity_id, investor_id) DO UPDATE
         SET pct = EXCLUDED.pct, status = 'Requested', notes = EXCLUDED.notes,
             requested_at = now(), decided_at = NULL, decided_by = NULL
       RETURNING *`,
      [o.id, me, pct, str(req.body.notes)]);
    await client.query('COMMIT');
    await audit(req.user.uid, 'opportunity', o.id, 'update', `investor ${me} requested ${pct}%`);

    /* Somebody has to confirm or decline this, so somebody has to know it
       happened. The manager whose client it is, and the administrators. */
    const { rows: about } = await q(
      `SELECT o.fund_id, o.policy_number, o.carrier_name, o.face_amount,
              o.insured_first_name, o.insured_last_name, i.name AS investor_name
         FROM opportunities o, investors i WHERE o.id = $1 AND i.id = $2`, [o.id, me]);
    const ctx = about[0] || {};
    await tellStaff('investor_interest',
      await staffAudience({ fundId: ctx.fund_id, investorId: me }), {
        investor: ctx.investor_name || `investor ${me}`,
        pct: `${pctText(pct)}`,
        headline: [[ctx.insured_last_name, ctx.insured_first_name].filter(Boolean).join(', ')
          || ctx.policy_number, ctx.carrier_name].filter(Boolean).join(' · '),
        note: str(req.body.notes),
        remaining: pctText(Math.max(0, remaining - pct)),
      });
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

/** An investor changes their mind before it is confirmed. */
router.delete('/opportunities/:id/commit', wrap(async (req, res) => {
  const me = scopeId(req);
  if (me === null) return res.status(403).json({ error: 'Not an investor account' });
  const { rows } = await q(
    `UPDATE opportunity_commitments SET status = 'Withdrawn', decided_at = now()
      WHERE opportunity_id = $1 AND investor_id = $2 AND status = 'Requested'
      RETURNING id`, [req.params.id, me]);
  if (!rows[0])
    return res.status(409).json({ error: 'That request has already been decided — speak to your manager.' });
  await audit(req.user.uid, 'opportunity', Number(req.params.id), 'update', `investor ${me} withdrew`);
  res.json({ ok: true });
}));

/** A manager confirms or declines a request. */
router.put('/opportunity-commitments/:id', blockInvestors, oppEdit, wrap(async (req, res) => {
  const decision = str(req.body.status);
  if (!['Confirmed', 'Declined'].includes(decision))
    return res.status(400).json({ error: 'Decision must be Confirmed or Declined' });
  const { rows: cur } = await q(
    'SELECT * FROM opportunity_commitments WHERE id = $1', [req.params.id]);
  if (!cur[0] || !(await oppVisible(req, cur[0].opportunity_id)))
    return res.status(404).json({ error: 'Not found' });

  const { rows } = await q(
    `UPDATE opportunity_commitments
        SET status = $1, decided_at = now(), decided_by = $2, notes = COALESCE(NULLIF($3,''), notes)
      WHERE id = $4 RETURNING *`,
    [decision, req.user.uid, str(req.body.notes), req.params.id]);
  await audit(req.user.uid, 'opportunity', cur[0].opportunity_id, 'update',
    `${decision.toLowerCase()} ${cur[0].pct}% for investor ${cur[0].investor_id}`);
  res.json(rows[0]);
}));

/**
 * Turn a closed deal into a real policy.
 *
 * Creates the policy and its insured, seeds the ledger with the purchase
 * price, and writes the cap table from the confirmed commitments — so the
 * book of record starts out matching what was actually agreed, with no
 * re-keying.
 */
router.post('/opportunities/:id/fund', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    if (!(await oppVisible(req, req.params.id)))
      return res.status(404).json({ error: 'Opportunity not found' });
    const o = await loadOpportunity(req, req.params.id);
    if (o.policy_id) return res.status(409).json({ error: 'This opportunity has already been funded' });
    if (!str(o.policy_number) || !str(o.carrier_name))
      return res.status(400).json({ error: 'A policy number and carrier are needed before funding' });

    const insuredId = await resolveInsured({
      insured_last_name: o.insured_last_name, insured_first_name: o.insured_first_name,
      dob: o.insured_dob, gender: o.insured_gender, state: o.insured_state,
      le_months: o.le_months, le_provider: o.le_provider, le_date: o.le_date,
    });
    // A policy number is unique across the portfolio. The usual cause of a
    // collision is that the deal was keyed in by hand as well as posted as an
    // opportunity, and the right answer is to join the two records rather than
    // to create a second one or to refuse outright. So: say which policy it
    // is, and take `link` as the instruction to adopt it.
    const clash = await q(
      'SELECT id, carrier_name FROM policies WHERE lower(policy_number) = lower($1)',
      [str(o.policy_number)]);
    if (clash.rows.length && !req.body.link)
      return res.status(409).json({
        error: `Policy ${o.policy_number} is already in the portfolio (${
          clash.rows[0].carrier_name || 'no carrier'}). Link this opportunity to that policy, `
          + 'or change the policy number here first.',
        policy_id: clash.rows[0].id,
        can_link: true,
      });

    const acquired = date(req.body.acquisition_date) || o.expected_close || today();

    /* Adopting a policy that is already on the books. Nothing about the
       policy is rewritten — it is the record of what was actually bought,
       and an opportunity's asking price is what was hoped for. Only the
       confirmed allocations are carried across, and only where the policy
       does not already have that investor. */
    if (clash.rows.length) {
      const policyId = clash.rows[0].id;
      let linked = 0;
      for (const c of o.commitments.filter((x) => x.status === 'Confirmed')) {
        const ins = await q(
          `INSERT INTO policy_investors (policy_id, investor_id, pct, acquired_on, notes)
           VALUES ($1,$2,$3,$4,'From opportunity') ON CONFLICT DO NOTHING RETURNING id`,
          [policyId, c.investor_id, c.pct, acquired]);
        linked += ins.rows.length;
      }
      await q(`UPDATE opportunities SET status = 'Funded', policy_id = $1, updated_at = now()
                WHERE id = $2`, [policyId, req.params.id]);
      await audit(req.user.uid, 'opportunity', Number(req.params.id), 'update',
        `linked to existing policy ${o.policy_number} with ${linked} allocation(s)`);
      return res.status(200).json({ policy_id: policyId, allocations: linked, linked: true });
    }

    // All of it or none of it: a half-funded deal — a policy with no
    // acquisition cost, or a cap table with no policy behind it — is worse
    // than a failure you can retry.
    const client = await pool.connect();
    let policyId; let policyNumber; let allocated = 0;
    try {
      await client.query('BEGIN');
      const { rows: pol } = await client.query(
        `INSERT INTO policies (policy_number, carrier_name, product_type, face_amount,
                               insured_id, fund_id, status, premium_required, premium_mode,
                               acquisition_date, acquisition_cost, notes)
         VALUES ($1,$2,$3,$4,$5,$6,'Inforce',$7,'Annual',$8,$9,$10) RETURNING id, policy_number`,
        [o.policy_number, o.carrier_name, o.product_type, o.face_amount, insuredId, o.fund_id,
         o.annual_premium, acquired, o.asking_price, o.notes]);
      policyId = pol[0].id;
      policyNumber = pol[0].policy_number;

      if (Number(o.asking_price))
        await client.query(
          `INSERT INTO transactions (policy_id, txn_date, txn_type, amount, remarks, source)
           VALUES ($1,$2,'Acquisition Cost',$3,'Funded from opportunity','app')`,
          [policyId, acquired, o.asking_price]);

      /* The carrier values quoted in the deal become the policy's opening
         statement, so a newly funded policy is not blank until the next
         statement arrives — the servicing alerts have something to read on
         day one. Dated as quoted, not as funded: it is the carrier's figure
         on the carrier's date. */
      if (o.account_value != null || o.cash_surrender_value != null)
        await client.query(
          `INSERT INTO policy_values (policy_id, as_of_date, account_value,
                                      cash_surrender_value, death_benefit, notes)
           VALUES ($1,$2,$3,$4,$5,'Quoted on the opportunity')
           ON CONFLICT DO NOTHING`,
          [policyId, o.values_as_of || acquired, o.account_value,
           o.cash_surrender_value, o.face_amount]);

      for (const c of o.commitments.filter((x) => x.status === 'Confirmed')) {
        await client.query(
          `INSERT INTO policy_investors (policy_id, investor_id, pct, acquired_on, notes)
           VALUES ($1,$2,$3,$4,'From opportunity') ON CONFLICT DO NOTHING`,
          [policyId, c.investor_id, c.pct, acquired]);
        allocated++;
      }

      await client.query(
        `UPDATE opportunities SET status = 'Funded', policy_id = $1, updated_at = now()
          WHERE id = $2`, [policyId, req.params.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505')
        return res.status(409).json({
          error: `Policy ${o.policy_number} was created by somebody else while this was `
            + 'being funded. Reload the opportunity and try again.' });
      throw e;
    } finally {
      client.release();
    }

    await audit(req.user.uid, 'opportunity', Number(req.params.id), 'update',
      `funded as policy ${policyNumber} with ${allocated} allocation(s)`);
    res.status(201).json({ policy_id: policyId, allocations: allocated });
  }));

/* ------------------------------------------------------------------ *
 * internal rate of return
 *
 * Every figure here comes from dated cash flows, never from an average.
 * A policy's return depends entirely on *when* each premium left and when
 * the check arrived, so the ledger is replayed date by date and solved.
 * ------------------------------------------------------------------ */

/**
 * The terminal inflow for a policy, and what to call it.
 *
 *  - paid claim      → the actual cheque, on the day it was received
 *  - matured, unpaid → the death benefit, assumed collected today
 *  - still in force  → the death benefit, as if the insured died today
 *  - lapsed          → nothing; a lapse is a total loss and should read as one
 *
 * The claim lands on the date the money arrived rather than the date of
 * death: carriers take weeks to pay, and that delay is a real cost to the
 * return, not an accounting nicety.
 */
function terminalFlow(p, asOf, lastOutflow = null) {
  const benefit = Number(p.benefit) || 0;
  if (p.status === 'Lapsed') return null;
  if (p.proceeds_amount != null)
    return { date: p.proceeds_received_on || p.matured_on || asOf,
             amount: Number(p.proceeds_amount), label: 'Death benefit received', actual: true };
  if (!benefit) return null;
  /* You cannot be paid before you have paid.
   *
   * A policy acquired next month, asked "what if the insured died today",
   * produces a claim dated before the purchase that funds it — and no rate
   * satisfies flows that arrive before the money that bought them, so the
   * screen showed a dash. Anchoring the assumption at the last outflow keeps
   * the timeline coherent and the question answerable. */
  const at = lastOutflow && lastOutflow > asOf ? lastOutflow : asOf;
  return { date: at, amount: benefit, actual: false,
           label: p.status === 'Matured' ? 'Death benefit (claim outstanding)' : 'Death benefit if matured today' };
}

/**
 * Cash flows for every policy the caller can see, share-weighted for an
 * investor. Two queries regardless of how many policies — the ledger is
 * fetched in one pass and bucketed in memory.
 */
/** Which policies each basis covers. Anything else is reported, not dropped. */
const BASIS_FILTER = {
  all: "pl.status <> 'Sold'",
  active: "pl.status NOT IN ('Matured','Sold','Lapsed')",
  realized: "pl.status = 'Matured'",
};

async function portfolioFlows(req, { onlyMatured = false, basis, fund = '' } = {}) {
  const scope = scopeId(req);
  const funds = fundScope(req);
  const vis = visibleTo('pl.id', 'pl.fund_id', 1, 2);
  const asOf = today();
  const filter = BASIS_FILTER[basis] || (onlyMatured ? BASIS_FILTER.realized : BASIS_FILTER.all);

  const { rows: policies } = await q(
    `SELECT pl.id, pl.policy_number, pl.status, pl.matured_on, pl.fund_code,
            pl.carrier_name, pl.product_type, pl.display_name,
            pl.insured_first, pl.insured_last, pl.insured_dob, pl.insured_gender,
            pl.proceeds_amount, pl.proceeds_received_on, pl.face_amount,
            COALESCE(pl.death_benefit, pl.face_amount) AS benefit,
            ${carryRate()} AS carry_pct,
            (${shareOf('pl.id', 1)}) AS my_pct,
            (${shareOf('pl.id', 1)}) / 100.0 AS factor
       FROM policy_latest pl
      WHERE ${filter} AND ($3 = '' OR pl.fund_code = $3) AND ${vis}`,
    [scope, funds, fund]
  );
  if (!policies.length) return { policies: [], byPolicy: new Map(), asOf };

  const { rows: txns } = await q(
    `SELECT policy_id, txn_date, txn_type, amount FROM transactions
      WHERE policy_id = ANY($1) ORDER BY txn_date, id`,
    [policies.map((p) => p.id)]
  );
  const ledger = new Map();
  for (const t of txns) {
    if (!ledger.has(t.policy_id)) ledger.set(t.policy_id, []);
    ledger.get(t.policy_id).push(t);
  }

  const byPolicy = new Map();
  for (const p of policies) {
    const factor = Number(p.factor) || 0;
    const raw = ledgerFlows(ledger.get(p.id) || [], factor);
    const lastOut = raw.reduce(
      (d, f) => (f.amount < 0 && (!d || f.date > d) ? f.date : d), null);
    const terminal = terminalFlow(p, asOf, lastOut);
    if (terminal) raw.push({ ...terminal, amount: terminal.amount * factor });
    /* An investor is shown their return after the managing partner's share
       of the profit, per case. Done here rather than at each of the dozen
       places a rate is displayed, so no screen can be missed — every rate,
       profit and multiple in the application is solved from these flows. */
    const pct = Number(p.carry_pct) || 0;
    const flows = scope === null || !pct ? raw : flowsAfterCarry(raw, pct);
    byPolicy.set(p.id, flows);
  }
  /* Deliberately no single combined series: every rate above this is pooled
     per policy by `poolFlows`, because simple interest needs one end date
     per policy and a book has more than one. */
  return { policies, byPolicy, asOf };
}

/** The policy's own cash-flow schedule, with both scenarios spelled out. */
router.get('/policies/:id/irr', wrap(async (req, res) => {
  const scope = scopeId(req);
  const funds = fundScope(req);
  const { rows } = await q(
    `SELECT pl.id, pl.policy_number, pl.status, pl.matured_on,
            pl.proceeds_amount, pl.proceeds_received_on,
            COALESCE(pl.death_benefit, pl.face_amount) AS benefit,
            pl.face_amount, pl.cash_surrender_value, pl.fund_id, pl.fund_code,
            ${carryRate()} AS carry_pct,
            (${shareOf('pl.id', 2)}) AS my_pct
       FROM policy_latest pl
      WHERE pl.id = $1 AND ${visibleTo('pl.id', 'pl.fund_id', 2, 3)}`,
    [req.params.id, scope, funds]
  );
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Policy not found' });

  const { rows: txns } = await q(
    `SELECT txn_date, txn_type, amount, remarks FROM transactions
      WHERE policy_id = $1 ORDER BY txn_date, id`, [req.params.id]
  );

  // Investors see their slice. The rate itself is unchanged by scaling every
  // flow — a rate has no size — but the dollars beside it must be theirs.
  const factor = scope === null ? 1 : (Number(p.my_pct) || 0) / 100;
  const asOf = today();
  const base = ledgerFlows(txns, factor);

  const lastOutflow = base.reduce(
    (d, f) => (f.amount < 0 && (!d || f.date > d) ? f.date : d), null);
  const terminal = terminalFlow(p, asOf, lastOutflow);
  const gross = terminal
    ? [...base, { ...terminal, amount: terminal.amount * factor }]
    : base;
  const rate = Number(p.carry_pct) || 0;
  const withTerminal = scope === null || !rate ? gross : flowsAfterCarry(gross, rate);

  /* The dollar figures beside the rate have to be the same money the rate
     was solved on. `basis` is every dollar that went out on this policy at
     this investor's share — the same denominator the flows use — so the
     death benefit and any claim paid read net for them and gross for us. */
  const basis = base.reduce((sum, f) => sum + (f.amount < 0 ? -f.amount : 0), 0);
  const net = (v) => (v == null ? null
    : scope === null ? Number(v) : netOfCarry(Number(v), basis, rate));

  /* For us, the amount itself rather than the deduction. An investor never
     receives this block: `scope` is their id, and it is only built when
     there isn't one. Carry on a policy still running is what WOULD be due if
     it matured today; on a paid claim it is earned. The two are labelled
     rather than added. */
  const carry = scope === null && rate
    ? { ...policyCarry(gross), rate, earned: p.proceeds_amount != null,
        fund_code: p.fund_code }
    : null;

  res.json({
    policy_id: p.id,
    policy_number: p.policy_number,
    status: p.status,
    matured_on: p.matured_on,
    ...(carry ? { carry } : {}),
    proceeds_amount: p.proceeds_amount == null ? null
      : net(Number(p.proceeds_amount) * factor),
    proceeds_received_on: p.proceeds_received_on,
    death_benefit: net(Number(p.benefit || 0) * factor),
    cash_surrender_value: Number(p.cash_surrender_value || 0) * factor,
    my_pct: scope === null ? null : Number(p.my_pct),
    as_of: asOf,
    settled: p.proceeds_amount != null,
    ledger: base,                                    // outflows only, dated
    result: analyzeFlows(withTerminal),
  });
}));

/* ------------------------------------------------------------------ *
 * carried interest
 *
 * Ours, and only ever ours. An investor's screens have this deducted and
 * never name it; this endpoint is the other side of the same arithmetic and
 * is closed to them twice over — `blockInvestors` refuses the request, and
 * `requireRole('admin')` refuses everyone else besides.
 *
 * Administrators only rather than staff generally: what the firm earns is
 * not a portfolio manager's business, and a manager scoped to one entity
 * asking for "all entities" would be a question with an awkward answer.
 * ------------------------------------------------------------------ */

/* The words the screen uses, against the words `portfolioFlows` knows.
   Kept as a map rather than passed straight through: "matured" reading as
   "all" because the filter did not recognise it is the kind of silence that
   looks like working software. */
const CARRY_BASIS = { active: 'active', matured: 'realized', all: 'all' };

router.get('/carry', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const asked = str(req.query.status) || 'all';
  const basis = CARRY_BASIS[asked];
  if (!basis)
    return res.status(400).json({ error: 'Status must be active, matured or all.' });
  const fund = str(req.query.fund);
  const { policies, byPolicy } = await portfolioFlows(req, { basis, fund });

  const rows = policies.map((p) => {
    const rate = Number(p.carry_pct) || 0;
    const a = analyzeFlows(byPolicy.get(p.id) || []);
    const earned = p.proceeds_amount != null;
    return {
      id: p.id, policy_number: p.policy_number, carrier_name: p.carrier_name,
      product_type: p.product_type, fund_code: p.fund_code || '',
      display_name: p.display_name, insured_first: p.insured_first,
      insured_last: p.insured_last, status: p.status, matured_on: p.matured_on,
      carry_pct: rate,
      basis: a.invested, gross_return: a.returned, gross_profit: a.profit,
      carry: rate ? carryOn(a.returned, a.invested, rate) : 0,
      net_profit: a.profit - (rate ? carryOn(a.returned, a.invested, rate) : 0),
      /* Earned means the carrier has paid. Everything else is what WOULD be
         due if the claim were collected today — real, but not money. The two
         are never added together. */
      earned,
      rate: a.rate,
    };
  }).sort((x, y) => y.carry - x.carry);

  const byFund = new Map();
  let earned = 0, projected = 0;
  for (const r of rows) {
    const key = r.fund_code || '(no entity)';
    if (!byFund.has(key))
      byFund.set(key, { fund_code: key, carry_pct: r.carry_pct, policies: 0,
                        earned: 0, projected: 0, basis: 0, gross_profit: 0 });
    const b = byFund.get(key);
    b.policies++; b.basis += r.basis; b.gross_profit += r.gross_profit;
    if (r.earned) { b.earned += r.carry; earned += r.carry; }
    else { b.projected += r.carry; projected += r.carry; }
  }

  res.json({
    status: asked,
    fund,
    rows,
    totals: { earned, projected, policies: rows.length,
              charged: rows.filter((r) => r.carry_pct > 0).length },
    byFund: [...byFund.values()].sort((a2, b2) => (a2.fund_code < b2.fund_code ? -1 : 1)),
  });
}));

/* ------------------------------------------------------------------ *
 * maturities
 *
 * A policy leaves the active book the moment its qualifying death is
 * recorded — the database trigger does that, so it happens no matter which
 * route the date arrived by. This endpoint is the register of what has
 * matured and what has been collected against it.
 * ------------------------------------------------------------------ */

router.get('/maturities', wrap(async (req, res) => {
  const scope = scopeId(req);
  const funds = fundScope(req);
  // Same entity filter as the dashboard, applied to the rows, the totals
  // and the realized return together — a return computed over one book and
  // shown above totals for another would be worse than no filter at all.
  const fund = str(req.query.fund);
  const w = `(${shareOf('pl.id', 1)} / 100.0)`;
  const vis = `${visibleTo('pl.id', 'pl.fund_id', 1, 2)} AND ($3 = '' OR pl.fund_code = $3)`;

  // Death benefit at maturity is the carrier's last reported figure, falling
  // back to the face amount when no snapshot was ever taken.
  const benefit = 'COALESCE(pl.death_benefit, pl.face_amount)';
  /* Money coming back, after the managing partner's share of the profit —
     gross for staff, net for an investor. The basis is that policy's own
     ledger, which is what the carry is calculated against. */
  const netBenefit = afterCarry(benefit, 'pl.total_invested', 1);
  const netProceeds = afterCarry('pl.proceeds_amount', 'pl.total_invested', 1);

  const [rows, totals] = await Promise.all([
    q(`SELECT pl.id, pl.policy_number, pl.carrier_name, pl.product_type,
              pl.fund_code, pl.display_name, pl.insured_first, pl.insured_last,
              pl.insured_dob, pl.insured_gender, pl.status,
              pl.matured_on, ${netProceeds}       AS proceeds_amount,
              pl.proceeds_received_on,
              pl.face_amount, ${netBenefit}       AS death_benefit,
              pl.total_invested, pl.total_acquisition, pl.total_premiums,
              ${shareOf('pl.id', 1)}              AS my_pct,
              (SELECT COUNT(*)::int FROM policy_insureds pi WHERE pi.policy_id = pl.id) + 1
                                                   AS lives_count
         FROM policy_latest pl
        WHERE pl.status = 'Matured' AND ${vis}
        ORDER BY pl.matured_on DESC NULLS LAST, pl.policy_number`,
      [scope, funds, fund]),
    q(`SELECT COUNT(*)::int                                     AS policy_count,
              COUNT(pl.proceeds_amount)::int                    AS paid_count,
              COALESCE(SUM(${netBenefit} * ${w}), 0)            AS total_death_benefit,
              COALESCE(SUM(${netProceeds} * ${w}), 0)           AS total_proceeds,
              COALESCE(SUM(pl.total_invested * ${w}), 0)        AS total_invested,
              COALESCE(SUM(pl.total_acquisition * ${w}), 0)     AS total_acquisition,
              COALESCE(SUM(CASE WHEN pl.proceeds_amount IS NULL
                                THEN ${netBenefit} * ${w} END), 0)
                                                                AS outstanding_benefit
         FROM policy_latest pl
        WHERE pl.status = 'Matured' AND ${vis}`, [scope, funds, fund]),
  ]);

  // Return on each matured policy, and one rate across all of them together.
  const { policies, byPolicy } = await portfolioFlows(req, { onlyMatured: true, fund });
  const withReturn = rows.rows.map((r) => {
    const a = analyzeFlows(byPolicy.get(r.id) || []);
    return { ...r, rate: a.rate, rate_days: a.days, rate_short: a.short_period,
             rate_ambiguous: a.ambiguous, multiple: a.multiple };
  });

  /* Two different questions, and the headline is the first one.
   *
   *   realized — what the book has actually returned. Only claims the
   *     carrier has paid, and each one's inflow dated the day the cheque
   *     arrived. That is a fact, and it is what every paid row on the
   *     screen already shows.
   *
   *   assumed — the same calculation with every outstanding claim treated
   *     as if it were collected today. Useful, but it is a projection, and
   *     showing it under the word "realized" overstates the return on a
   *     book with claims still in the post: an unpaid claim assumed
   *     collected today has had no time to run, so it flatters the rate.
   *
   * Both go over, so the screen can lead with whichever it actually has and
   * label it honestly. Neither is an average of the per-policy rates — that
   * would weight a $50k position the same as a $5m one. */
  const paidIds = new Set(policies.filter((p) => p.proceeds_amount != null).map((p) => p.id));
  const paidFlows = [...paidIds].map((id) => byPolicy.get(id) || []);

  /* Carried interest on the maturities — ours, and only ever ours. Split the
     way the register itself splits: earned on claims the carrier has paid,
     and outstanding on claims still to come. Adding them together would
     report money that has not arrived as though it had. */
  const carryRows = scope !== null ? null : policies.map((p) => {
    const rate = Number(p.carry_pct) || 0;
    const a = analyzeFlows(byPolicy.get(p.id) || []);
    return {
      policy_id: p.id, fund_code: p.fund_code || '', rate,
      paid: p.proceeds_amount != null,
      carry: rate ? carryOn(a.returned, a.invested, rate) : 0,
    };
  });
  const carrySummary = carryRows === null ? null : (() => {
    const byFund = new Map();
    let earned = 0, outstanding = 0;
    for (const r of carryRows) {
      const key = r.fund_code || '(no entity)';
      if (!byFund.has(key))
        byFund.set(key, { fund_code: key, earned: 0, outstanding: 0, policies: 0, rate: r.rate });
      const b = byFund.get(key);
      b.policies++;
      if (r.paid) { b.earned += r.carry; earned += r.carry; }
      else { b.outstanding += r.carry; outstanding += r.carry; }
    }
    return {
      earned, outstanding,
      byFund: [...byFund.values()].sort((a2, b2) => (a2.fund_code < b2.fund_code ? -1 : 1)),
      byPolicy: Object.fromEntries(carryRows.map((r) => [r.policy_id, r.carry])),
    };
  })();

  res.json({
    rows: withReturn,
    totals: totals.rows[0],
    /* Kept under its old name so nothing reading this endpoint breaks, and
       it remains the right figure for "what if everything landed today". */
    portfolio: poolFlows([...byPolicy.values()]),
    realized: { ...poolFlows(paidFlows), policy_count: paidIds.size },
    ...(carrySummary ? { carry: carrySummary } : {}),
    scopedToInvestor: scope !== null,
  });
}));

/** Record (or clear) what the carrier actually paid on a matured policy. */
router.put('/policies/:id/proceeds', canEdit, inPolicyScope('id'), wrap(async (req, res) => {
  const { rows: cur } = await q(
    'SELECT policy_number, status, matured_on FROM policies WHERE id = $1', [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: 'Policy not found' });
  if (cur[0].status !== 'Matured')
    return res.status(400).json({
      error: 'Proceeds can only be recorded once the policy has matured. Add the date of death first.' });

  const amount = num(req.body.proceeds_amount);
  const on = date(req.body.proceeds_received_on);
  if (amount !== null && amount < 0)
    return res.status(400).json({ error: 'Proceeds cannot be negative' });

  const { rows } = await q(
    `UPDATE policies SET proceeds_amount = $1, proceeds_received_on = $2, updated_at = now()
      WHERE id = $3 RETURNING id, proceeds_amount, proceeds_received_on`,
    [amount, on, req.params.id]
  );
  await audit(req.user.uid, 'policy', Number(req.params.id), 'update',
    amount === null
      ? `proceeds cleared on ${cur[0].policy_number}`
      : `proceeds ${amount} received ${on || 'date not given'} on ${cur[0].policy_number}`);
  res.json(rows[0]);
}));

/* ------------------------------------------------------------------ *
 * servicing calendar + lapse risk
 * ------------------------------------------------------------------ */

router.get('/servicing', wrap(async (req, res) => {
  const scope = scopeId(req);
  const funds = fundScope(req);
  // Same entity filter the dashboard uses, so the two agree when one is set.
  const fund = str(req.query.fund);
  const { rows } = await q(
    `SELECT pl.id, pl.policy_number, pl.carrier_name, pl.display_name,
            pl.insured_first, pl.insured_last, pl.insured_gender,
            pl.status, pl.premium_mode, pl.next_premium_due, pl.grace_period_days,
            pl.face_amount, pl.account_value, pl.cash_surrender_value, pl.cost_of_insurance,
            pl.value_as_of, pl.date_of_last_withdrawal,
            ${shareOf('pl.id', 1)} AS my_pct,
            pl.premium_required * (${shareOf('pl.id', 1)} / 100.0) AS premium_required,
            pl.premium_required AS premium_required_full,
            (pl.next_premium_due - CURRENT_DATE) AS days_until_due
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
        AND ($3 = '' OR pl.fund_code = $3)
        AND ${visibleTo('pl.id', 'pl.fund_id', 1, 2)}
      ORDER BY pl.next_premium_due NULLS LAST`,
    [scope, funds, fund]
  );

  /* Investors get dates, not servicing work.
     Lapse risk, stale carrier statements and overdue premiums are things
     somebody here is already chasing. On an investor's screen they are an
     alarm about a policy they hold a fraction of and cannot act on, and the
     only effect is a phone call. They see what is coming and what it costs
     them; the rest is the manager's job. */
  const alerts = [];
  for (const p of (isInvestor(req) ? [] : rows)) {
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

  /* Scheduled next steps join the calendar as alerts of their own. A note
     written six months ago is only useful if it comes back at you on the day
     it matters, and the servicing screen is where somebody is already
     looking. Investors get none of these — they are internal work. */
  /* For staff this is the next 45 days of work. For an investor it is every
     scheduled premium still ahead, whenever it falls, weighted to their share
     — they are being told what they will be asked to fund, not chased. */
  const steps = await q(
    `SELECT r.id AS reminder_id, r.due_date, r.kind, r.note,
            r.amount * (CASE WHEN $1::int IS NULL THEN 1 ELSE ${shareOf('pl.id', 1)} / 100.0 END)
                                                        AS amount,
            r.amount                                    AS amount_full,
            ${shareOf('pl.id', 1)}                      AS my_pct,
            (r.due_date - CURRENT_DATE) AS days_until_due,
            pl.id, pl.policy_number, pl.carrier_name, pl.display_name,
            pl.insured_first, pl.insured_last, pl.insured_gender, pl.status
       FROM policy_reminders r JOIN policy_latest pl ON pl.id = r.policy_id
      WHERE r.done_at IS NULL
        AND ($1::int IS NULL OR (r.kind = 'Premium' AND r.due_date >= CURRENT_DATE))
        AND ($1::int IS NOT NULL OR r.due_date <= CURRENT_DATE + 45)
        AND ($3 = '' OR pl.fund_code = $3)
        AND ${visibleTo('pl.id', 'pl.fund_id', 1, 2)}
      ORDER BY r.due_date`,
    [scope, funds, fund]);
  if (!isInvestor(req)) {
    for (const r of steps.rows) {
      const name = r.display_name || `${r.insured_first || ''} ${r.insured_last || ''}`.trim();
      const d = r.days_until_due;
      const when = d < 0 ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`
        : d === 0 ? 'due today'
          : `due in ${d} day${d === 1 ? '' : 's'}`;
      const what = r.kind === 'Premium'
        ? `Scheduled premium${r.amount ? ` of about ${Number(r.amount).toLocaleString('en-US',
            { style: 'currency', currency: 'USD' })}` : ''}`
        : 'Follow-up';
      alerts.push({
        ...r, insured: name, scheduled: true,
        severity: d < 0 ? 'critical' : d <= 14 ? 'warning' : 'info',
        reason: `${what} ${when}${r.note ? ` — ${r.note}` : ''}`,
      });
    }
  }

  const rank = { critical: 0, serious: 1, warning: 2, info: 3 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
  res.json({ upcoming: rows.filter((r) => r.next_premium_due), alerts, scheduled: steps.rows });
}));

/* ------------------------------------------------------------------ *
 * investors and fractional ownership
 * ------------------------------------------------------------------ */

const INVESTOR_FIELDS = {
  name: str, legal_name: str, investor_type: str, email: str,
  phone: str, tax_id_last4: str, notes: str,
  address_line1: str, address_line2: str, city: str, state: str,
  postal_code: str, country: str,
  // Whose client they are. Only an administrator may set it.
  fund_id: int,
};

router.get('/investors', blockInvestors, staffOnly, wrap(async (req, res) => {
  const search = str(req.query.search);
  const funds = fundScope(req);
  /* A manager sees three kinds of investor:
       - the ones assigned to one of their entities, which is the
         relationship an administrator set when the account was opened;
       - the ones holding a position inside one of their entities, which
         is where the money actually is;
       - any an administrator has granted them by name, so a new deal can
         be taken to an existing client without keying in a duplicate.
     The figures shown still cover only their own entities, so somebody
     visible for one of the other two reasons reads as zero here rather
     than exposing a book that is not theirs to see. */
  const granted = grantedInvestors(req);
  const { rows } = await q(
    `SELECT inv.*, f.code AS fund_code, f.name AS fund_name,
            /* Whether they can sign in, and as what. Staff-only — this route
               already is — and it is the address, never anything about the
               password. It is here so the investor form can say "already
               signs in as…" rather than offering to open a second login. */
            (SELECT u.email FROM users u WHERE u.investor_id = inv.id LIMIT 1) AS login_email,
            /* pl.id, not pi.id: the scope and status filters live on the
               join to policy_latest, so counting the link row would count
               a position held in somebody else's entity even while its
               money reads as zero. */
            COUNT(pl.id)::int AS position_count,
            COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * pi.pct / 100.0), 0) AS death_benefit,
            COALESCE(SUM(pl.total_invested * pi.pct / 100.0), 0) AS invested,
            COALESCE(SUM(pl.cash_surrender_value * pi.pct / 100.0), 0) AS csv
       FROM investors inv
       LEFT JOIN funds f ON f.id = inv.fund_id
       LEFT JOIN policy_investors pi ON pi.investor_id = inv.id
       LEFT JOIN policy_latest pl ON pl.id = pi.policy_id
                                 AND pl.status NOT IN ('Lapsed','Sold','Matured')
                                 AND ($2::int[] IS NULL OR pl.fund_id = ANY($2))
      WHERE ($1 = '' OR inv.name ILIKE '%'||$1||'%' OR inv.legal_name ILIKE '%'||$1||'%'
             OR inv.email ILIKE '%'||$1||'%')
        AND ($4 = '' OR f.code = $4)
        AND ($2::int[] IS NULL OR inv.fund_id = ANY($2)
             OR inv.id = ANY(COALESCE($3::int[], '{}')) OR EXISTS (
              SELECT 1 FROM policy_investors pj JOIN policies pp ON pp.id = pj.policy_id
               WHERE pj.investor_id = inv.id AND pp.fund_id = ANY($2)))
      GROUP BY inv.id, f.code, f.name ORDER BY inv.name`,
    [search, funds, granted, str(req.query.fund)]
  );
  res.json(rows);
}));

router.get('/investors/:id', blockInvestors, staffOnly, wrap(async (req, res) => {
  const funds = fundScope(req);
  const granted = grantedInvestors(req);
  const { rows } = await q(
    `SELECT inv.*, f.code AS fund_code, f.name AS fund_name
       FROM investors inv
       LEFT JOIN funds f ON f.id = inv.fund_id
      WHERE inv.id = $1
        AND ($2::int[] IS NULL OR inv.fund_id = ANY($2)
             OR inv.id = ANY(COALESCE($3::int[], '{}')) OR EXISTS (
              SELECT 1 FROM policy_investors pj JOIN policies pp ON pp.id = pj.policy_id
               WHERE pj.investor_id = inv.id AND pp.fund_id = ANY($2)))`,
    [req.params.id, funds, granted]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Investor not found' });
  const positions = await q(
    `SELECT pi.id AS link_id, pi.pct, pi.acquired_on, pi.notes AS link_notes,
            pl.id, pl.policy_number, pl.carrier_name, pl.product_type, pl.status,
            pl.insured_first, pl.insured_last, pl.insured_gender, pl.display_name, pl.fund_code,
            pl.face_amount, pl.death_benefit, pl.cash_surrender_value,
            pl.account_value, pl.cost_of_insurance, pl.premium_required,
            pl.total_invested
       FROM policy_investors pi JOIN policy_latest pl ON pl.id = pi.policy_id
      WHERE pi.investor_id = $1 AND ($2::int[] IS NULL OR pl.fund_id = ANY($2))
      ORDER BY pl.insured_last, pl.policy_number`,
    [req.params.id, funds]
  );
  // Login details are account administration — managers don't get them.
  const logins = funds === null
    ? await q('SELECT id, email, full_name, is_active, last_login_at FROM users WHERE investor_id = $1',
        [req.params.id])
    : { rows: [] };
  res.json({ ...rows[0], positions: positions.rows, logins: logins.rows });
}));

/**
 * Which entity an investor belongs to is an administrator's decision.
 *
 * A manager assigning one to their own entity would be handing themselves
 * a client they were not given — a small escalation, but the kind that is
 * only obvious in hindsight. The field is dropped from anybody else's
 * request rather than refused, so a manager editing a phone number does
 * not get an error about a field they never touched.
 */
const adminOnlyInvestorFields = (req) => {
  if (req.user.role === 'admin') return req.body;
  const { fund_id: _drop, ...rest } = req.body || {};
  return rest;
};

/**
 * A replacement tax number, sealed on the way in. Only an administrator
 * can set one, and only the last four digits are readable afterwards —
 * the same rule the registration form follows, because it is the same
 * number.
 */
async function applyTaxId(req, investorId) {
  if (req.user.role !== 'admin') return null;
  const raw = str(req.body?.tax_id);
  if (!raw) return null;
  const digits = digitsOf(raw);
  if (digits.length !== 9)
    return { error: 'A tax number is nine digits — a Social Security number or an EIN.' };
  const sealed = sealField(digits);
  await q(
    `UPDATE investors SET tax_id_enc = $1, tax_id_key = $2, tax_id_last4 = $3,
                          updated_at = now() WHERE id = $4`,
    [sealed.ciphertext, sealed.keyId, digits.slice(-4), investorId]);
  await audit(req.user.uid, 'investor', Number(investorId), 'update',
    `tax number replaced · ending ${digits.slice(-4)}`);
  return null;
}

/** The whole number, for an administrator, on the record. */
router.get('/investors/:id/tax-id', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT name, tax_id_enc FROM investors WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Investor not found' });
  const value = openField(rows[0].tax_id_enc);
  await audit(req.user.uid, 'investor', Number(req.params.id), 'read',
    `revealed tax id for ${rows[0].name}`);
  if (!value)
    return res.status(409).json({
      error: 'There is no readable tax number on this record. Enter it again to store one.' });
  res.json({ tax_id: value });
}));

/* ------------------------------------------------------------------ *
 * Opening the portal for an investor
 *
 * An investor who registers themselves arrives with a login already —
 * they chose the password and nobody else ever knew it. An investor the
 * office opens an account for has no such thing, and used to need a
 * second trip through Settings by an administrator, which a manager could
 * not make at all. So the login is set up on the same screen as the
 * record, by whoever is doing the setting up.
 *
 * Three things hold it in:
 *
 *   - only ever an INVESTOR login, tied to that investor. This is not a
 *     way for a manager to create staff accounts; the role is not taken
 *     from the request at all.
 *   - only for an investor they may already work with, which for a manager
 *     means their own entities.
 *   - the password is marked as borrowed. Staff typed it, so staff know
 *     it, and the account can do nothing until the investor replaces it.
 * ------------------------------------------------------------------ */

const LOGIN_MIN = 10;

/** What was asked for, if anything, and whether it makes sense. */
function loginRequest(body) {
  const wanted = body?.login_email || body?.login_password || body?.create_login;
  if (!wanted) return { none: true };
  const email = String(body.login_email || '').trim().toLowerCase();
  const password = String(body.login_password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { error: 'That is not an email address the portal can sign in with.' };
  if (password.length < LOGIN_MIN)
    return { error: `A password must be at least ${LOGIN_MIN} characters.` };
  return {
    email,
    password,
    /* Off only if somebody deliberately says so — for the case where the
       investor is sitting there and typed it themselves. */
    mustChange: body.must_change_password !== false && body.must_change_password !== 'false',
  };
}

/** Create the login inside whatever transaction the caller is running. */
async function openInvestorLogin(client, { email, password, mustChange }, investor) {
  const { rows: clash } = await client.query(
    'SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (clash.length) return { error: `${email} already has a login.` };
  const hash = await hashPassword(password);
  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, full_name, role, investor_id,
                        must_change_password)
     VALUES ($1,$2,$3,'investor',$4,$5) RETURNING id, email`,
    [email, hash, investor.name, investor.id, !!mustChange]);
  return { user: rows[0] };
}

/** Who may hand out a login at all. */
const mayOpenLogin = (req) => ['admin', 'manager'].includes(req.user.role);

router.post('/investors/:id/login', blockInvestors, canEdit, wrap(async (req, res) => {
  if (!mayOpenLogin(req))
    return res.status(403).json({
      error: 'Opening a login is for an administrator or the entity manager.' });
  const wanted = loginRequest({ ...req.body, create_login: true });
  if (wanted.error) return res.status(400).json({ error: wanted.error });

  const { rows } = await q('SELECT id, name FROM investors WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Investor not found' });
  if ((await investorsOutOfScope(req, [rows[0].id])).length)
    return res.status(403).json({ error: 'That investor is not one of yours' });
  const { rows: already } = await q(
    'SELECT email FROM users WHERE investor_id = $1', [req.params.id]);
  if (already[0])
    return res.status(409).json({
      error: `${rows[0].name} already signs in as ${already[0].email}.` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const made = await openInvestorLogin(client, wanted, rows[0]);
    if (made.error) { await client.query('ROLLBACK'); return res.status(409).json({ error: made.error }); }
    await client.query('COMMIT');
    await audit(req.user.uid, 'user', made.user.id, 'create',
      `${made.user.email} · investor login for ${rows[0].name}`
      + `${wanted.mustChange ? ' · password set by staff, must be changed on first sign-in' : ''}`);
    /* Tells them the account exists and what address it is under. Never the
       password — that goes down a telephone, not through a mail server. */
    await sendMail('portal_open', { to: made.user.email, userId: made.user.id,
      name: rows[0].name, email: made.user.email });
    res.status(201).json({ ok: true, email: made.user.email,
      must_change_password: !!wanted.mustChange });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

router.post('/investors', blockInvestors, canEdit, wrap(async (req, res) => {
  if (!str(req.body.name)) return res.status(400).json({ error: 'A name is required' });

  /* A login, if one was asked for on the same screen. Checked BEFORE the
     record is written: an investor created and then refused a login because
     the address was already taken leaves somebody half-set-up, and the next
     attempt makes a duplicate investor. */
  const wanted = loginRequest(req.body);
  if (wanted.error) return res.status(400).json({ error: wanted.error });
  if (!wanted.none && !mayOpenLogin(req))
    return res.status(403).json({
      error: 'Opening a login is for an administrator or the entity manager. '
        + 'Save the investor without one and ask them to set it up.' });
  if (!wanted.none) {
    const { rows: clash } = await q(
      'SELECT id FROM users WHERE lower(email) = lower($1)', [wanted.email]);
    if (clash.length)
      return res.status(409).json({ error: `${wanted.email} already has a login.` });
  }

  const { cols, vals } = buildSet(INVESTOR_FIELDS, adminOnlyInvestorFields(req));
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q(
    `INSERT INTO investors (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals
  );
  const bad = await applyTaxId(req, rows[0].id);
  if (bad) return res.status(400).json(bad);
  await audit(req.user.uid, 'investor', rows[0].id, 'create', rows[0].name);

  let login = null;
  if (!wanted.none) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const made = await openInvestorLogin(client, wanted, rows[0]);
      if (made.error) {
        await client.query('ROLLBACK');
        /* The record stands — it is good work either way — and the message
           says exactly what is missing so it can be finished from Edit. */
        return res.status(409).json({
          error: `${rows[0].name} was saved, but the login was not: ${made.error}`,
          investor_id: rows[0].id });
      }
      await client.query('COMMIT');
      login = made.user;
      await audit(req.user.uid, 'user', made.user.id, 'create',
        `${made.user.email} · investor login for ${rows[0].name}`
        + `${wanted.mustChange ? ' · password set by staff, must be changed on first sign-in' : ''}`);
      await sendMail('portal_open', { to: made.user.email, userId: made.user.id,
        name: rows[0].name, email: made.user.email });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  // Read it back rather than returning the row as it was inserted: the tax
  // number is sealed in a second statement, and a response that omitted it
  // would say the record has no number on it when it does.
  const { rows: fresh } = await q(
    `SELECT inv.*, f.code AS fund_code FROM investors inv
       LEFT JOIN funds f ON f.id = inv.fund_id WHERE inv.id = $1`, [rows[0].id]);
  res.status(201).json({ ...fresh[0],
    ...(login ? { login_email: login.email,
                  must_change_password: !!wanted.mustChange } : {}) });
}));

router.put('/investors/:id', blockInvestors, canEdit, wrap(async (req, res) => {
  const { sets, vals, next } = buildSet(INVESTOR_FIELDS, adminOnlyInvestorFields(req));
  if (!sets.length && !str(req.body?.tax_id))
    return res.status(400).json({ error: 'No fields supplied' });
  if (sets.length) {
    const { rowCount } = await q(
      `UPDATE investors SET ${sets.join(',')}, updated_at = now() WHERE id = $${next}`,
      [...vals, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Investor not found' });
  }
  const bad = await applyTaxId(req, req.params.id);
  if (bad) return res.status(400).json(bad);
  const { rows } = await q(
    `SELECT inv.*, f.code AS fund_code FROM investors inv
       LEFT JOIN funds f ON f.id = inv.fund_id WHERE inv.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Investor not found' });
  await audit(req.user.uid, 'investor', rows[0].id, 'update', rows[0].name);
  res.json(rows[0]);
}));

router.delete('/investors/:id', blockScoped, requireRole('admin'), wrap(async (req, res) => {
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

router.post('/policies/:id/investors', blockInvestors, canEdit, inPolicyScope('id'), wrap(async (req, res) => {
  const investorId = int(req.body.investor_id);
  const pct = num(req.body.pct);
  if (!investorId) return res.status(400).json({ error: 'Choose an investor' });
  if (pct === null || pct <= 0 || pct > 100)
    return res.status(400).json({ error: 'Percentage must be between 0 and 100' });
  if ((await investorsOutOfScope(req, [investorId])).length)
    return res.status(403).json({
      error: 'That investor is not one of yours. Ask an administrator to give you access.' });

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
  if (!cur[0] || !(await assertPolicyInScope(req, cur[0].policy_id)))
    return res.status(404).json({ error: 'Allocation not found' });

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
  const { rows: cur } = await q('SELECT policy_id FROM policy_investors WHERE id = $1', [req.params.linkId]);
  if (!cur[0] || !(await assertPolicyInScope(req, cur[0].policy_id)))
    return res.status(404).json({ error: 'Allocation not found' });
  const { rows } = await q('DELETE FROM policy_investors WHERE id = $1 RETURNING *', [req.params.linkId]);
  if (!rows[0]) return res.status(404).json({ error: 'Allocation not found' });
  await audit(req.user.uid, 'policy_investor', Number(req.params.linkId), 'delete',
    `policy ${rows[0].policy_id} · investor ${rows[0].investor_id}`);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * reports
 * ------------------------------------------------------------------ */

/**
 * Return analysis, in one of two bases.
 *
 *   active   — policies still in force, each valued as if the insured died
 *              today and the carrier paid the current death benefit
 *   realized — matured policies, using the cheque that actually arrived on
 *              the day it arrived (or the benefit assumed collected today
 *              where the claim is still outstanding)
 *
 * Owner entities get their own rate pooled from the policies inside them —
 * total profit over total dollar-years — not by averaging their rates. A $5m
 * position and a $50k one do not contribute equally, and averaging pretends
 * they do.
 */
router.get('/reports/returns', wrap(async (req, res) => {
  const basis = req.query.basis === 'realized' ? 'realized' : 'active';
  const fund = str(req.query.fund);

  const { policies, byPolicy, asOf } = await portfolioFlows(req, { basis, fund });

  const scoped = scopeId(req) !== null;
  const rows = policies.map((p) => {
    /* The rate already carries the deduction — `portfolioFlows` applied it
       to the flows — so the dollars beside it have to as well, or the table
       would show a profit that its own rate disagrees with. */
    const a = analyzeFlows(byPolicy.get(p.id) || []);
    const factor = Number(p.factor) || 0;
    const basisOf = a.invested;
    const net = (v) => (v == null ? null
      : scoped ? netOfCarry(Number(v), basisOf, Number(p.carry_pct) || 0) : Number(v));
    return {
      id: p.id, policy_number: p.policy_number, carrier_name: p.carrier_name,
      product_type: p.product_type, fund_code: p.fund_code, status: p.status,
      display_name: p.display_name, insured_first: p.insured_first,
      insured_last: p.insured_last, insured_dob: p.insured_dob,
      my_pct: scopeId(req) === null ? null : Number(p.my_pct),
      face_amount: Number(p.face_amount || 0) * factor,
      death_benefit: net(Number(p.benefit || 0) * factor),
      matured_on: p.matured_on,
      proceeds_amount: p.proceeds_amount == null ? null
        : net(Number(p.proceeds_amount) * factor),
      proceeds_received_on: p.proceeds_received_on,
      settled: p.proceeds_amount != null,
      rate: a.rate, invested: a.invested, returned: a.returned, profit: a.profit,
      multiple: a.multiple, days: a.days, years: a.years,
      first_flow: a.first_flow, last_flow: a.last_flow,
      short_period: a.short_period, extreme: a.extreme, ambiguous: a.ambiguous,
    };
  }).sort((x, y) => {
    // Highest return first; anything without a computable rate sinks to the
    // bottom rather than sorting as if it were zero.
    if (x.rate === null && y.rate === null) return y.invested - x.invested;
    if (x.rate === null) return 1;
    if (y.rate === null) return -1;
    return y.rate - x.rate;
  });

  const groups = new Map();
  for (const p of policies) {
    const key = p.fund_code || 'Unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.id);
  }
  const byFund = [...groups.entries()].map(([fund_code, ids]) => {
    const a = poolFlows(ids.map((id) => byPolicy.get(id) || []));
    return { fund_code, n: ids.length, rate: a.rate, invested: a.invested,
             returned: a.returned, profit: a.profit, multiple: a.multiple, days: a.days };
  }).sort((x, y) => (y.rate ?? -Infinity) - (x.rate ?? -Infinity));

  // Anything the basis leaves out is named, so the reader can see the shape of
  // what is missing instead of assuming the table is the whole book.
  const scope = scopeId(req);
  const funds = fundScope(req);
  const { rows: excluded } = await q(
    `SELECT pl.status, COUNT(*)::int AS n,
            COALESCE(SUM(pl.total_invested * (${shareOf('pl.id', 1)} / 100.0)), 0) AS invested
       FROM policy_latest pl
      WHERE NOT (${BASIS_FILTER[basis]}) AND ($3 = '' OR pl.fund_code = $3)
        AND ${visibleTo('pl.id', 'pl.fund_id', 1, 2)}
      GROUP BY pl.status ORDER BY pl.status`,
    [scope, funds, fund]
  );

  const portfolio = poolFlows([...byPolicy.values()]);
  // The simple mean is reported alongside, because the gap between it and the
  // capital-weighted rate is itself worth seeing.
  const rated = rows.filter((r) => r.rate !== null);
  const meanIrr = rated.length ? rated.reduce((s, r) => s + r.rate, 0) / rated.length : null;

  res.json({
    basis, as_of: asOf, fund,
    rows, byFund, excluded, portfolio,
    mean_rate: meanIrr,
    rated_count: rated.length,
    scopedToInvestor: scope !== null,
  });
}));

const MODE_MONTHS = { Monthly: 1, Quarterly: 3, 'Semi-Annual': 6, Annual: 12 };

/**
 * Projects each active policy's premium payments forward and groups them by
 * calendar month. A due date already in the past is reported in the current
 * month and flagged overdue rather than silently rolled forward.
 */
/**
 * One statement per investor, for the people who run the book.
 *
 * The investor portal answers "what do I hold". This answers the question a
 * manager actually gets asked on the phone — what has this person put in,
 * what do they own, what is coming out of their pocket next, and what has it
 * returned so far — with every figure already multiplied by their percentage
 * so nobody is doing arithmetic in their head while talking.
 *
 * Staff only, and scoped: a manager sees the investors they may reach and
 * only the positions inside their own entities, so the totals on this
 * document are the totals *they* are responsible for.
 */
router.get('/reports/investors', blockInvestors, staffOnly, wrap(async (req, res) => {
  const fund = str(req.query.fund);
  const wanted = String(req.query.investor_ids || '')
    .split(',').map((n) => parseInt(n, 10)).filter(Number.isInteger);
  const funds = fundScope(req);
  const granted = grantedInvestors(req);
  const asOf = today();

  const { rows: investors } = await q(
    `SELECT inv.id, inv.name, inv.legal_name, inv.investor_type, inv.email, inv.phone,
            inv.is_active, inv.notes
       FROM investors inv
      WHERE ($1::int[] IS NULL OR inv.id = ANY($1))
        AND ($2::int[] IS NULL OR inv.id = ANY(COALESCE($3::int[], '{}')) OR EXISTS (
              SELECT 1 FROM policy_investors pj JOIN policies pp ON pp.id = pj.policy_id
               WHERE pj.investor_id = inv.id AND pp.fund_id = ANY($2)))
      ORDER BY inv.name`,
    [wanted.length ? wanted : null, funds, granted]);
  if (!investors.length) return res.json({ as_of: asOf, investors: [] });

  const ids = investors.map((i) => i.id);
  const { rows: positions } = await q(
    `SELECT pi.investor_id, pi.pct, pi.acquired_on, pi.notes AS position_notes,
            pl.id, pl.policy_number, pl.carrier_name, pl.product_type, pl.fund_code,
            pl.display_name, pl.insured_first, pl.insured_last, pl.insured_dob,
            pl.insured_gender, pl.status, pl.matured_on, pl.proceeds_amount, pl.proceeds_received_on,
            pl.face_amount, COALESCE(pl.death_benefit, pl.face_amount) AS death_benefit,
            pl.premium_required, pl.premium_mode, pl.next_premium_due, pl.le_months
       FROM policy_investors pi JOIN policy_latest pl ON pl.id = pi.policy_id
      WHERE pi.investor_id = ANY($1)
        AND ($2 = '' OR pl.fund_code = $2)
        AND ($3::int[] IS NULL OR pl.fund_id = ANY($3))
      ORDER BY pl.insured_last, pl.policy_number`,
    [ids, fund, funds]);

  const policyIds = [...new Set(positions.map((p) => p.id))];
  const [{ rows: txns }, { rows: steps }] = policyIds.length
    ? await Promise.all([
      q(`SELECT policy_id, txn_date, txn_type, amount FROM transactions
          WHERE policy_id = ANY($1) ORDER BY txn_date, id`, [policyIds]),
      q(`SELECT policy_id, due_date, amount, note FROM policy_reminders
          WHERE policy_id = ANY($1) AND kind = 'Premium' AND done_at IS NULL
            AND due_date >= CURRENT_DATE
          ORDER BY due_date`, [policyIds]),
    ])
    : [{ rows: [] }, { rows: [] }];

  const ledger = new Map();
  for (const t of txns) {
    if (!ledger.has(t.policy_id)) ledger.set(t.policy_id, []);
    ledger.get(t.policy_id).push(t);
  }
  const planned = new Map();
  for (const r of steps) {
    if (!planned.has(r.policy_id)) planned.set(r.policy_id, []);
    planned.get(r.policy_id).push(r);
  }

  const byInvestor = new Map(investors.map((i) => [i.id, []]));
  for (const p of positions) byInvestor.get(p.investor_id)?.push(p);

  const out = investors.map((inv) => {
    const mine = byInvestor.get(inv.id) || [];
    const allFlows = [];
    const paid = {};          // what has actually left this investor, by kind
    const upcoming = [];      // what is due to leave next

    const rows = mine.map((p) => {
      const factor = Number(p.pct) / 100;
      const flows = ledgerFlows(ledger.get(p.id) || [], factor);
      for (const t of ledger.get(p.id) || []) {
        if (!OUTFLOW_TYPES.includes(t.txn_type)) continue;
        paid[t.txn_type] = (paid[t.txn_type] || 0) + Number(t.amount) * factor;
      }
      const lastOut = flows.reduce(
        (d, f) => (f.amount < 0 && (!d || f.date > d) ? f.date : d), null);
      const terminal = terminalFlow(
        { ...p, benefit: p.death_benefit }, asOf, lastOut);
      const withTerminal = terminal
        ? [...flows, { ...terminal, amount: terminal.amount * factor }] : flows;
      allFlows.push(...withTerminal);
      const a = analyzeFlows(withTerminal);

      if (p.status !== 'Matured' && p.next_premium_due)
        upcoming.push({ policy_id: p.id, policy_number: p.policy_number,
          insured: p.display_name || `${p.insured_first || ''} ${p.insured_last || ''}`.trim(),
          date: String(p.next_premium_due).slice(0, 10),
          amount: Number(p.premium_required || 0) * factor,
          amount_full: Number(p.premium_required || 0),
          source: p.premium_mode || 'carrier' });
      for (const r of planned.get(p.id) || [])
        upcoming.push({ policy_id: p.id, policy_number: p.policy_number,
          insured: p.display_name || `${p.insured_first || ''} ${p.insured_last || ''}`.trim(),
          date: String(r.due_date).slice(0, 10),
          amount: Number(r.amount || 0) * factor,
          amount_full: Number(r.amount || 0),
          source: 'scheduled', note: r.note });

      return {
        id: p.id, policy_number: p.policy_number, carrier_name: p.carrier_name,
        product_type: p.product_type, fund_code: p.fund_code, status: p.status,
        insured: p.display_name || `${p.insured_first || ''} ${p.insured_last || ''}`.trim(),
        insured_dob: p.insured_dob, le_months: p.le_months,
        pct: Number(p.pct), acquired_on: p.acquired_on,
        face_amount: Number(p.face_amount || 0) * factor,
        death_benefit: Number(p.death_benefit || 0) * factor,
        premium_required: Number(p.premium_required || 0) * factor,
        premium_mode: p.premium_mode, next_premium_due: p.next_premium_due,
        matured_on: p.matured_on,
        proceeds_amount: p.proceeds_amount == null ? null : Number(p.proceeds_amount) * factor,
        proceeds_received_on: p.proceeds_received_on,
        settled: p.proceeds_amount != null,
        invested: a.invested, returned: a.returned, profit: a.profit,
        multiple: a.multiple, rate: a.rate, days: a.days,
        short_period: a.short_period, extreme: a.extreme, ambiguous: a.ambiguous,
      };
    });

    const overall = analyzeFlows(allFlows);
    const live = rows.filter((r) => r.status !== 'Matured');
    const realized = rows.filter((r) => r.status === 'Matured');
    upcoming.sort((a, b) => (a.date < b.date ? -1 : 1));

    return {
      investor: inv,
      positions: rows,
      totals: {
        position_count: rows.length,
        live_count: live.length,
        realized_count: realized.length,
        death_benefit: rows.reduce((s, r) => s + r.death_benefit, 0),
        live_death_benefit: live.reduce((s, r) => s + r.death_benefit, 0),
        invested: rows.reduce((s, r) => s + r.invested, 0),
        annual_premium: live.reduce((s, r) => s + r.premium_required, 0),
        proceeds: realized.reduce((s, r) => s + (r.proceeds_amount || 0), 0),
        rate: overall.rate,
        multiple: overall.multiple,
        profit: overall.profit,
        short_period: overall.short_period, extreme: overall.extreme,
        ambiguous: overall.ambiguous,
      },
      paid: Object.entries(paid).map(([kind, amount]) => ({ kind, amount }))
        .sort((a, b) => b.amount - a.amount),
      upcoming: upcoming.slice(0, 24),
      upcoming_12mo: upcoming
        .filter((u) => u.date <= addMonths(asOf, 12))
        .reduce((s, u) => s + u.amount, 0),
    };
  });

  res.json({ as_of: asOf, fund, investors: out });
}));

router.get('/reports/premium-forecast', wrap(async (req, res) => {
  const asked = Math.min(60, Math.max(1, parseInt(req.query.months, 10) || 24));
  /* A horizon in days, for the short questions. "What is due this week" is not
     a shorter version of "what is due over five years" — a month bucket cannot
     answer it — so when `days` is given the reply is a dated list of payments
     rather than a column of monthly totals. */
  const days = req.query.days ? Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 0)) : 0;
  /* The dated window is filtered out of the month buckets, so the buckets have
     to reach past it — otherwise "the next 400 days" quietly stops at whatever
     the month horizon happened to be. Two months of headroom covers a window
     ending mid-month and a payment dated the last day of it. */
  const months = days ? Math.min(60, Math.max(asked, Math.ceil(days / 28) + 1)) : asked;
  const fund = str(req.query.fund);

  const scope = scopeId(req);
  const funds = fundScope(req);
  const { rows } = await q(
    `SELECT pl.id, pl.policy_number, pl.carrier_name, pl.display_name,
            pl.insured_first, pl.insured_last, pl.insured_gender,
            pl.fund_code, pl.premium_mode, pl.next_premium_due, pl.status,
            pl.face_amount, pl.cost_of_insurance, pl.account_value,
            ${shareOf('pl.id', 2)} AS my_pct,
            pl.premium_required * (${shareOf('pl.id', 2)} / 100.0) AS premium_required
       FROM policy_latest pl
      WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
        AND ($1 = '' OR pl.fund_code = $1)
        AND ${visibleTo('pl.id', 'pl.fund_id', 2, 3)}
      ORDER BY pl.insured_last, pl.insured_first`,
    [fund, scope, funds]
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

  /* Premiums somebody here posted to the schedule by hand. They are as real a
     call on the investor's money as a date the carrier printed, and leaving
     them out is what made this report read empty on a book imported without a
     next-due column. */
  const { rows: posted } = await q(
    `SELECT r.id, r.due_date, r.amount, r.note, pl.id AS policy_id,
            pl.policy_number, pl.carrier_name, pl.fund_code,
            pl.display_name, pl.insured_first, pl.insured_last,
            r.amount * (${shareOf('pl.id', 2)} / 100.0) AS my_amount
       FROM policy_reminders r
       JOIN policy_latest pl ON pl.id = r.policy_id
      WHERE r.kind = 'Premium' AND r.done_at IS NULL AND r.due_date >= CURRENT_DATE
        AND pl.status NOT IN ('Lapsed','Sold','Matured')
        AND ($1 = '' OR pl.fund_code = $1)
        AND ${visibleTo('pl.id', 'pl.fund_id', 2, 3)}
      ORDER BY r.due_date, pl.insured_last`,
    [fund, scope, funds]
  );
  const postedRows = posted.map((r) => ({
    policy_id: r.policy_id, policy_number: r.policy_number, carrier_name: r.carrier_name,
    insured: r.display_name || `${r.insured_first || ''} ${r.insured_last || ''}`.trim() || '—',
    fund_code: r.fund_code, amount: Number(r.my_amount) || 0, mode: 'Scheduled',
    due_date: String(r.due_date).slice(0, 10), overdue: false,
    note: r.note || '', source: 'scheduled', reminder_id: r.id,
  }));
  for (const r of postedRows) {
    const b = buckets.get(r.due_date.slice(0, 7));
    if (b) { b.total += r.amount; b.payments.push(r); running += r.amount; }
  }
  // Re-run the cumulative column now that the posted rows are in their buckets.
  let cum = 0;
  for (const b of schedule) {
    b.payments.sort((x, y) => (x.due_date < y.due_date ? -1 : 1));
    cum += b.total; b.cumulative = cum;
  }

  /* The dated window. Everything due between today and today plus `days`,
     from both sources, in one list — which is also exactly what a capital
     call is made of. */
  const from = today();
  const to = new Date(Date.now() + (days || 0) * 86400000).toISOString().slice(0, 10);
  const inWindow = days
    ? schedule.flatMap((b) => b.payments)
        // Anything already overdue belongs in front of somebody now, whatever
        // window was asked for — it is the most urgent thing on the list.
        .filter((x) => x.overdue || (x.due_date >= from && x.due_date <= to))
        .sort((a, b2) => (a.due_date < b2.due_date ? -1 : 1))
    : [];

  res.json({
    months,
    days,
    window: days
      ? { days, from, to, total: inWindow.reduce((s2, x) => s2 + x.amount, 0),
          payments: inWindow,
          policies: new Set(inWindow.map((x) => x.policy_id)).size }
      : null,
    generatedAt: new Date().toISOString(),
    schedule,
    grandTotal: cum,
    policiesScheduled: rows.length - noSchedule.length,
    noSchedule,
  });
}));

/** Everything a portfolio summary needs that /analytics/summary doesn't cover. */
router.get('/reports/portfolio', wrap(async (req, res) => {
  const fund = str(req.query.fund);
  const scope = scopeId(req);
  const funds = fundScope(req);
  const w = `(${shareOf('pl.id', 2)} / 100.0)`;
  const vis3 = visibleTo('pl.id', 'pl.fund_id', 2, 3);
  const [totals, byCarrier, byProduct, byFund, ages] = await Promise.all([
    q(`SELECT COUNT(*)::int AS policy_count,
              COALESCE(SUM(pl.face_amount * ${w}),0) AS total_face,
              COALESCE(SUM(${afterCarry('COALESCE(pl.death_benefit, pl.face_amount)',
                'pl.total_invested', 2)} * ${w}),0) AS total_death_benefit,
              COALESCE(SUM(pl.cash_surrender_value * ${w}),0) AS total_csv,
              COALESCE(SUM(pl.account_value * ${w}),0) AS total_av,
              COALESCE(SUM(pl.total_invested * ${w}),0) AS total_invested,
              COALESCE(SUM(pl.total_acquisition * ${w}),0) AS total_acquisition,
              COALESCE(SUM(pl.total_premiums * ${w}),0) AS total_premiums,
              COALESCE(SUM(pl.cost_of_insurance * ${w}),0) AS monthly_coi,
              COALESCE(SUM(pl.premium_required * ${w}),0) AS annual_premium
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${vis3}`, [fund, scope, funds]),
    q(`SELECT pl.carrier_name, COUNT(*)::int AS n,
              COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS face
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${vis3}
        GROUP BY pl.carrier_name ORDER BY face DESC`, [fund, scope, funds]),
    q(`SELECT COALESCE(NULLIF(pl.product_type,''),'Unclassified') AS product_type,
              COUNT(*)::int AS n,
              COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS face
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${vis3}
        GROUP BY 1 ORDER BY face DESC`, [fund, scope, funds]),
    q(`SELECT COALESCE(pl.fund_code,'Unassigned') AS fund_code, COUNT(*)::int AS n,
              COALESCE(SUM(COALESCE(pl.death_benefit, pl.face_amount) * ${w}),0) AS face,
              COALESCE(SUM(pl.total_invested * ${w}),0) AS invested
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured')
          AND ($1 = '' OR pl.fund_code = $1) AND ${vis3}
        GROUP BY 1 ORDER BY face DESC`, [fund, scope, funds]),
    q(`SELECT COALESCE(AVG(EXTRACT(YEAR FROM age(pl.insured_dob))),0) AS avg_age,
              COALESCE(MIN(EXTRACT(YEAR FROM age(pl.insured_dob))),0) AS min_age,
              COALESCE(MAX(EXTRACT(YEAR FROM age(pl.insured_dob))),0) AS max_age
         FROM policy_latest pl
        WHERE pl.status NOT IN ('Lapsed','Sold','Matured') AND pl.insured_dob IS NOT NULL
          AND ($1 = '' OR pl.fund_code = $1) AND ${vis3}`, [fund, scope, funds]),
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
  if (found[0]) {
    /* Fill in what the record does not have yet. Somebody entering a policy
       knows the sex and the state of the person they are entering; if the
       insured was created by an import that carried neither, this is the
       moment it becomes known. Nothing already recorded is overwritten —
       correcting a value is what the insured's own form is for. */
    const fill = {
      gender: str(body.gender) || null,
      state: str(body.state) || null,
      le_months: int(body.le_months),
    };
    const sets = Object.entries(fill).filter(([, v]) => v !== null && v !== '');
    if (sets.length)
      await q(
        `UPDATE insureds SET ${sets.map(([k], i) => `${k} = COALESCE(${k}, $${i + 1})`).join(', ')}
          WHERE id = $${sets.length + 1}`,
        [...sets.map(([, v]) => v), found[0].id]);
    return found[0].id;
  }

  const { rows } = await q(
    `INSERT INTO insureds (first_name, last_name, display_name, dob, gender, state, le_months)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [first, last, display || `${first} ${last}`.trim(), dob,
     str(body.gender) || null, str(body.state) || null, int(body.le_months)]
  );
  return rows[0].id;
}

/* ------------------------------------------------------------------ *
 * operating agreements
 *
 * A manager fills in the blanks, names the members, and issues it. Each
 * member then signs it in their own portal. Three rules make that worth
 * anything:
 *
 *   - the text is frozen at issue, by hash. Editing an agreement that is
 *     out for signature is refused, because the alternative is a member
 *     bound to words they never read.
 *   - a signature records who, when, from where, and against which text.
 *   - only the person the signature belongs to can make it. Nobody signs
 *     on anybody else's behalf, manager included.
 * ------------------------------------------------------------------ */

const AGREEMENT_STATUSES = ['Draft', 'Out for signature', 'Executed', 'Void'];

/* What kind of party is on the signature line.
 *
 * Everything except an individual signs through a human being: a company by
 * an officer or manager, a trust by its trustee, an IRA by its custodian.
 * The list mirrors `investors.investor_type` so a party's kind is read from
 * the record rather than guessed from the shape of its name — "Ward Family
 * Holdings" and "Ward Family" are not distinguishable by eye, and getting it
 * wrong in either direction produces a signature that does not bind. */
const PARTY_TYPES = ['Individual', 'Entity', 'Trust', 'IRA', 'Other'];
const signsThroughAPerson = (partyType) =>
  !!partyType && partyType !== 'Individual';

/* Where the kind of party comes from, in order of how much it is worth
   trusting:
 *
 *   1. what somebody chose on the form. A party who is not an investor on
 *      file has no record to read, and whoever drew the agreement knows.
 *   2. the investor record, which is where this is normally kept.
 *   3. the legal suffix on the name, as a default only.
 *
 * The third is a guess, but a narrow one: these are the endings a legal name
 * carries BECAUSE it is an entity, not a pattern in ordinary names. "Ward
 * Family Holdings" and "Ward Family" are not distinguishable by eye and this
 * does not try — it reads "Holdings LLC" and nothing else. A manager called
 * "Alan Spiegel" is a person and signs as one; "Poel Capital LLC" is not. */
const ENTITY_SUFFIX =
  /\b(l\.?l\.?c|l\.?l\.?l?\.?p|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|pllc|partners|partnership|fund|foundation|holdings)\.?$/i;
const TRUST_WORD = /\btrust(ee|s)?\b|\bfamily trust\b|\brevocable\b/i;
const looksLikeAnEntity = (name) => {
  const n = String(name || '').trim().replace(/,\s*$/, '');
  if (!n) return null;
  if (TRUST_WORD.test(n)) return 'Trust';
  return ENTITY_SUFFIX.test(n) ? 'Entity' : null;
};
/* What to call the human being's authority, for the message rather than for
   validation — we do not police job titles. */
const CAPACITY_HINT = {
  Trust: 'Trustee', IRA: 'Custodian or account holder',
  Entity: 'Manager, Member, President…', Other: 'the capacity you sign in',
};
const TERM_KEYS = new Set(AGREEMENT_FIELDS.map((f) => f.key));

/** Only the blanks the template knows about, coerced to their own type. */
function cleanTerms(input) {
  const out = {};
  for (const field of AGREEMENT_FIELDS) {
    const raw = input?.[field.key];
    if (raw === undefined) continue;
    if (field.type === 'pct' || field.type === 'int') {
      const n = num(raw);
      if (n !== null) out[field.key] = field.type === 'int' ? Math.round(n) : n;
    } else if (field.type === 'date') {
      const d = date(raw);
      if (d) out[field.key] = d;
    } else {
      const v = str(raw);
      if (v) out[field.key] = v.slice(0, 500);
    }
  }
  return out;
}

/** The agreement, its parties, and the text as it stands. */
async function loadAgreement(id) {
  const { rows } = await q(
    `SELECT a.*, f.code AS fund_code, p.policy_number,
            u.full_name AS created_by_name, iu.full_name AS issued_by_name
       FROM agreements a
       LEFT JOIN funds f     ON f.id = a.fund_id
       LEFT JOIN policies p  ON p.id = a.policy_id
       LEFT JOIN users u     ON u.id = a.created_by
       LEFT JOIN users iu    ON iu.id = a.issued_by
      WHERE a.id = $1`, [id]);
  const a = rows[0];
  if (!a) return null;
  const { rows: signers } = await q(
    `SELECT s.*, i.name AS investor_name
       FROM agreement_signers s
       LEFT JOIN investors i ON i.id = s.investor_id
      WHERE s.agreement_id = $1
      ORDER BY (s.role = 'Manager') DESC, s.sort_order, s.id`, [id]);
  a.signers = signers;
  a.blocks = renderAgreement(a.terms || {}, signers);
  a.current_hash = createHash('sha256').update(canonicalText(a.blocks)).digest('hex');
  a.signed_count = signers.filter((x) => x.signed_at).length;
  a.member_count = signers.filter((x) => x.role !== 'Manager').length;
  return a;
}

/** Which agreements this reader may see at all. */
function agreementScope(req) {
  if (isInvestor(req))
    return {
      sql: `a.status <> 'Draft' AND EXISTS (SELECT 1 FROM agreement_signers s
             WHERE s.agreement_id = a.id AND s.investor_id = $1)`,
      params: [Number(req.user.iid) || -1],
    };
  const funds = fundScope(req);
  if (funds === null) return { sql: 'TRUE', params: [] };
  return { sql: '(a.fund_id IS NULL OR a.fund_id = ANY($1))', params: [funds] };
}

const canSeeAgreement = async (req, id) => {
  const scope = agreementScope(req);
  const { rows } = await q(
    `SELECT 1 FROM agreements a WHERE a.id = $${scope.params.length + 1} AND ${scope.sql}`,
    [...scope.params, id]);
  return rows.length > 0;
};

/** The blanks, so the form can be built from the template rather than guessed. */
router.get('/agreement-template', blockInvestors, wrap(async (req, res) => {
  res.json({ fields: AGREEMENT_FIELDS });
}));

router.get('/agreements', wrap(async (req, res) => {
  const scope = agreementScope(req);
  const { rows } = await q(
    `SELECT a.id, a.title, a.status, a.fund_id, a.policy_id, a.issued_at, a.executed_at,
            a.created_at, a.terms->>'llc_name' AS llc_name,
            a.terms->>'effective_date' AS effective_date,
            f.code AS fund_code, p.policy_number,
            (SELECT COUNT(*)::int FROM agreement_signers s
              WHERE s.agreement_id = a.id AND s.role <> 'Manager')          AS member_count,
            -- Everybody who has to sign, the manager included: "2 of 3
            -- signed" is a sentence, "2 signed" against "1 member" is a
            -- puzzle.
            (SELECT COUNT(*)::int FROM agreement_signers s
              WHERE s.agreement_id = a.id)                                  AS party_count,
            (SELECT COUNT(*)::int FROM agreement_signers s
              WHERE s.agreement_id = a.id AND s.signed_at IS NOT NULL)      AS signed_count,
            ${isInvestor(req)
              ? `(SELECT s.signed_at FROM agreement_signers s
                   WHERE s.agreement_id = a.id AND s.investor_id = $1)`
              : 'NULL::timestamptz'}                                        AS my_signed_at
       FROM agreements a
       LEFT JOIN funds f    ON f.id = a.fund_id
       LEFT JOIN policies p ON p.id = a.policy_id
      WHERE ${scope.sql}
      ORDER BY a.created_at DESC`, scope.params);
  res.json(rows);
}));

router.get('/agreements/:id', wrap(async (req, res) => {
  res.locals.identified = true;      // a party reads their own agreement whole
  if (!(await canSeeAgreement(req, req.params.id)))
    return res.status(404).json({ error: 'Agreement not found' });
  const a = await loadAgreement(req.params.id);
  if (!a) return res.status(404).json({ error: 'Agreement not found' });
  /* An investor is shown the document and their own line on it. Who else
     was asked, what they put in and what they hold is somebody else's
     business — except on the Schedule, which is part of the agreement
     they are signing and which they are entitled to read in full. */
  if (isInvestor(req)) {
    const mine = Number(req.user.iid);
    a.me = a.signers.find((s) => s.investor_id === mine) || null;
    a.signers = a.signers.map((s) => ({
      id: s.id, role: s.role, name: s.name, pct: s.pct, contribution: s.contribution,
      signed_at: s.signed_at, is_me: s.investor_id === mine,
      /* What kind of party each one is, and who signed for it, are part of the
         signature block on a document they are a party to — not somebody
         else's business the way a contribution is. */
      party_type: s.party_type, signed_by_name: s.signed_by_name,
      signed_by_title: s.signed_by_title,
    }));
  }
  res.json(a);
}));

router.post('/agreements', blockInvestors, requireRole('admin', 'manager'), wrap(async (req, res) => {
  const funds = fundScope(req);
  const fundId = int(req.body.fund_id);
  if (funds && fundId && !funds.includes(fundId))
    return res.status(403).json({ error: 'That owner entity is not one of yours' });
  const terms = cleanTerms(req.body.terms);
  const { rows } = await q(
    `INSERT INTO agreements (title, fund_id, policy_id, terms, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [str(req.body.title) || terms.llc_name || 'Operating agreement',
     fundId, int(req.body.policy_id), JSON.stringify(terms), req.user.uid]);
  await audit(req.user.uid, 'agreement', rows[0].id, 'create', terms.llc_name || '');
  res.status(201).json({ id: rows[0].id });
}));

router.put('/agreements/:id', blockInvestors, requireRole('admin', 'manager'), wrap(async (req, res) => {
  if (!(await canSeeAgreement(req, req.params.id)))
    return res.status(404).json({ error: 'Agreement not found' });
  const { rows: cur } = await q('SELECT status FROM agreements WHERE id = $1', [req.params.id]);
  if (cur[0].status !== 'Draft')
    return res.status(409).json({
      error: 'This agreement has already gone out for signature. Recall it first — anyone who has '
        + 'signed will have to sign again, which is the point.' });

  const terms = cleanTerms(req.body.terms);
  const fundId = int(req.body.fund_id);
  const funds = fundScope(req);
  if (funds && fundId && !funds.includes(fundId))
    return res.status(403).json({ error: 'That owner entity is not one of yours' });
  await q(
    `UPDATE agreements SET title = $1, fund_id = $2, policy_id = $3, terms = $4, updated_at = now()
      WHERE id = $5`,
    [str(req.body.title) || terms.llc_name || 'Operating agreement',
     fundId, int(req.body.policy_id), JSON.stringify(terms), req.params.id]);
  await audit(req.user.uid, 'agreement', Number(req.params.id), 'update', terms.llc_name || '');
  res.json({ ok: true });
}));

/** Replace the list of parties. Draft only, for the same reason. */
router.put('/agreements/:id/signers', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    if (!(await canSeeAgreement(req, req.params.id)))
      return res.status(404).json({ error: 'Agreement not found' });
    const { rows: cur } = await q('SELECT status, terms FROM agreements WHERE id = $1', [req.params.id]);
    if (cur[0].status !== 'Draft')
      return res.status(409).json({ error: 'Recall the agreement before changing who is on it' });

    const incoming = Array.isArray(req.body.signers) ? req.body.signers : [];
    const investorIds = incoming.map((s) => int(s.investor_id)).filter(Boolean);
    const barred = await investorsOutOfScope(req, investorIds);
    if (barred.length)
      return res.status(403).json({
        error: 'You can only put investors on an agreement if they are in your own entities, or '
          + 'an administrator has given you access to them.' });

    /* What kind of party each one is, read from the investor record now and
       then frozen on the agreement. A company, a trust or an IRA signs
       through a human being, and which of the two it is must not change
       because somebody edited a record while the document was out. */
    const types = new Map();
    if (investorIds.length) {
      const { rows: kinds } = await q(
        'SELECT id, investor_type FROM investors WHERE id = ANY($1)', [investorIds]);
      for (const k of kinds) types.set(k.id, k.investor_type || 'Individual');
    }

    const seen = new Set();
    const rows = [];
    for (const s of incoming) {
      const investorId = int(s.investor_id);
      if (investorId && seen.has(investorId)) continue;
      if (investorId) seen.add(investorId);
      const name = str(s.name);
      if (!name && !investorId) continue;
      rows.push({
        investor_id: investorId,
        role: s.role === 'Manager' ? 'Manager' : 'Member',
        name, email: str(s.email), address: str(s.address),
        contribution: num(s.contribution), pct: num(s.pct),
        party_type: PARTY_TYPES.includes(str(s.party_type)) ? str(s.party_type)
          : types.get(investorId)
          || looksLikeAnEntity(name)
          || 'Individual',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM agreement_signers WHERE agreement_id = $1', [req.params.id]);
      for (const [i, r] of rows.entries())
        await client.query(
          `INSERT INTO agreement_signers (agreement_id, investor_id, role, name, email, address,
                                          contribution, pct, sort_order, party_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.params.id, r.investor_id, r.role, r.name, r.email, r.address,
           r.contribution, r.pct, i, r.party_type]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await audit(req.user.uid, 'agreement', Number(req.params.id), 'update',
      `${rows.length} part${rows.length === 1 ? 'y' : 'ies'}`);
    res.json({ ok: true, signers: rows.length });
  }));

/**
 * Issue it. This is the moment the text stops moving: the rendered
 * document is hashed and the hash is stored, and every signature from
 * here on is checked against it.
 */
router.post('/agreements/:id/issue', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    if (!(await canSeeAgreement(req, req.params.id)))
      return res.status(404).json({ error: 'Agreement not found' });
    const a = await loadAgreement(req.params.id);
    if (a.status !== 'Draft')
      return res.status(409).json({ error: 'This agreement is already out for signature' });

    const missing = AGREEMENT_FIELDS.filter((f) => f.required && !str(a.terms?.[f.key]))
      .map((f) => f.label);
    if (missing.length)
      return res.status(400).json({ error: `Still to fill in: ${missing.join(', ')}.` });
    if (!a.signers.some((s) => s.role !== 'Manager'))
      return res.status(400).json({ error: 'Add at least one member before sending it out' });

    await q(
      `UPDATE agreements SET status = 'Out for signature', body_hash = $1,
                             issued_at = now(), issued_by = $2, updated_at = now()
        WHERE id = $3`, [a.current_hash, req.user.uid, req.params.id]);
    await audit(req.user.uid, 'agreement', Number(req.params.id), 'update',
      `issued to ${a.member_count} member(s) · ${a.current_hash.slice(0, 16)}`);

    /* Each party who has a portal login is told it is waiting. An agreement
       nobody knows about is an agreement nobody signs. */
    const { rows: parties } = await q(
      `SELECT u.id, u.email, s.name
         FROM agreement_signers s
         JOIN users u ON u.investor_id = s.investor_id AND u.is_active = TRUE
        WHERE s.agreement_id = $1 AND s.role <> 'Manager'`, [req.params.id]);
    for (const party of parties)
      await sendMail('agreement_out', {
        to: party.email, userId: party.id, name: party.name,
        title: a.terms?.llc_name || a.title || 'An operating agreement',
        parties: `${a.member_count} ${a.member_count === 1 ? 'member is' : 'members are'} `
          + 'party to it, and the manager signs as well.',
      });
    res.json({ ok: true, body_hash: a.current_hash, sent_to: a.member_count });
  }));

/** Pull it back to draft. Signatures already given are cleared, and said so. */
router.post('/agreements/:id/recall', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    if (!(await canSeeAgreement(req, req.params.id)))
      return res.status(404).json({ error: 'Agreement not found' });
    const { rows: cur } = await q('SELECT status FROM agreements WHERE id = $1', [req.params.id]);
    if (cur[0].status === 'Executed')
      return res.status(409).json({
        error: 'This agreement is fully executed. Void it and issue a replacement rather than '
          + 'unpicking signatures.' });
    const { rowCount } = await q(
      `UPDATE agreement_signers SET signed_at = NULL, signed_name = NULL, signed_ip = NULL,
                                    signed_agent = NULL, signed_hash = NULL,
                                    signed_by_name = '', signed_by_title = '',
                                    declined_at = NULL, decline_note = ''
        WHERE agreement_id = $1 AND (signed_at IS NOT NULL OR declined_at IS NOT NULL)`,
      [req.params.id]);
    await q(
      `UPDATE agreements SET status = 'Draft', body_hash = NULL, issued_at = NULL,
                             executed_at = NULL, updated_at = now()
        WHERE id = $1`, [req.params.id]);
    await audit(req.user.uid, 'agreement', Number(req.params.id), 'update',
      `recalled to draft, ${rowCount} signature(s) cleared`);
    res.json({ ok: true, cleared: rowCount });
  }));

router.post('/agreements/:id/void', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    if (!(await canSeeAgreement(req, req.params.id)))
      return res.status(404).json({ error: 'Agreement not found' });
    const reason = str(req.body.reason);
    if (!reason) return res.status(400).json({ error: 'Say why it is being voided' });
    await q(
      `UPDATE agreements SET status = 'Void', void_reason = $1, updated_at = now() WHERE id = $2`,
      [reason, req.params.id]);
    await audit(req.user.uid, 'agreement', Number(req.params.id), 'update', `voided: ${reason}`);
    res.json({ ok: true });
  }));

router.delete('/agreements/:id', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q('SELECT status, title FROM agreements WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Agreement not found' });
  if (rows[0].status !== 'Draft')
    return res.status(409).json({
      error: 'Only a draft can be deleted. An agreement that has been sent out is part of the '
        + 'record — void it instead.' });
  await q('DELETE FROM agreements WHERE id = $1', [req.params.id]);
  await audit(req.user.uid, 'agreement', Number(req.params.id), 'delete', rows[0].title);
  res.json({ ok: true });
}));

/**
 * Sign it.
 *
 * The signer types their own name, and it has to match the name on the
 * agreement — not as a security measure, but because a signature that
 * reads differently from the party it is under invites an argument later.
 * The hash of what they were shown is checked against the issued hash,
 * so a document that changed under them cannot be signed by accident.
 */
router.post('/agreements/:id/sign', wrap(async (req, res) => {
  if (!(await canSeeAgreement(req, req.params.id)))
    return res.status(404).json({ error: 'Agreement not found' });
  const a = await loadAgreement(req.params.id);
  if (a.status !== 'Out for signature')
    return res.status(409).json({
      error: a.status === 'Executed'
        ? 'This agreement is already fully executed'
        : 'This agreement is not out for signature' });

  const mine = isInvestor(req) ? Number(req.user.iid) : null;
  const signer = mine
    ? a.signers.find((s) => s.investor_id === mine)
    : a.signers.find((s) => s.role === 'Manager');
  if (!signer)
    return res.status(403).json({ error: 'You are not a party to this agreement' });
  if (signer.signed_at)
    return res.status(409).json({ error: 'You have already signed this agreement' });

  const typed = str(req.body.signed_name);
  if (!typed) return res.status(400).json({ error: 'Type your name to sign' });
  const tidy = (v) => String(v).toLowerCase().replace(/[^a-z]/g, '');
  if (tidy(typed) !== tidy(signer.name))
    return res.status(400).json({
      error: `Sign as "${signer.name}" — that is the name this agreement is drawn in.` });

  /* A company, trust or IRA cannot hold a pen.
   *
   * Where the party is one, the signature line needs both halves: the entity,
   * which is the party bound, and the person signing for it in the capacity
   * that gives them the authority. The entity name alone is not a signature,
   * and the person's name alone binds the person rather than the entity —
   * which is the failure worth preventing, because it is invisible until
   * somebody tries to enforce the agreement. */
  const byName = str(req.body.signed_by_name);
  const byTitle = str(req.body.signed_by_title);
  const entity = signsThroughAPerson(signer.party_type);
  if (entity) {
    if (!byName)
      return res.status(400).json({
        error: `${signer.name} is ${signer.party_type === 'Trust' ? 'a trust'
          : signer.party_type === 'IRA' ? 'an account' : 'an entity'}, so it signs through a `
          + 'person. Give the name of the individual signing on its behalf.' });
    if (byName.length < 2 || !/[a-z]/i.test(byName))
      return res.status(400).json({ error: 'That does not look like a person’s name.' });
    if (tidy(byName) === tidy(signer.name))
      return res.status(400).json({
        error: `The person signing has to be named as well as ${signer.name}. `
          + 'Repeating the entity name does not say who signed.' });
    if (!byTitle)
      return res.status(400).json({
        error: 'Give the capacity you are signing in — '
          + `${CAPACITY_HINT[signer.party_type] || 'Manager, Trustee…'}.` });
  }

  if (req.body.agreed !== true)
    return res.status(400).json({ error: 'Tick the box to confirm you intend to sign' });
  if (a.body_hash && str(req.body.body_hash) && str(req.body.body_hash) !== a.body_hash)
    return res.status(409).json({
      error: 'The agreement changed since this page was opened. Reload it and read it again '
        + 'before signing.' });

  /* The same resolution the sign-in fingerprint uses: behind a CDN the
     socket address is the CDN, and a signature stamped with a Cloudflare
     machine's address records nothing about who signed. */
  const ip = clientIp(req) || req.socket?.remoteAddress || '';

  await q(
    `UPDATE agreement_signers
        SET signed_at = now(), signed_name = $1, signed_ip = $2, signed_agent = $3,
            signed_hash = $4, declined_at = NULL, decline_note = '',
            signed_by_name = $5, signed_by_title = $6
      WHERE id = $7`,
    [typed, ip.slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 300),
     a.body_hash || a.current_hash,
     entity ? byName.slice(0, 120) : '', entity ? byTitle.slice(0, 80) : '',
     signer.id]);

  // Everyone who had to sign has signed: file it.
  const after = await loadAgreement(req.params.id);
  const outstanding = after.signers.filter((s) => !s.signed_at);
  let documentId = null;
  if (!outstanding.length) {
    documentId = await fileExecutedAgreement(after, req.user.uid);
    await q(
      `UPDATE agreements SET status = 'Executed', executed_at = now(), document_id = $1,
                             updated_at = now() WHERE id = $2`, [documentId, req.params.id]);
  }
  await audit(req.user.uid, 'agreement', Number(req.params.id), 'update',
    `signed by ${typed}${entity ? ` (by ${byName}, ${byTitle})` : ''}${
      outstanding.length ? `, ${outstanding.length} to go` : ' — fully executed'}`);

  /* Whoever sent it out is waiting on it, so they hear about each signature
     rather than having to keep opening the page to look. */
  await tellStaff('agreement_signed',
    await staffAudience({ fundId: a.fund_id, investorId: signer.investor_id,
      alsoUserId: a.issued_by }), {
      title: a.terms?.llc_name || a.title || 'the operating agreement',
      who: `${typed}${entity ? ` (by ${byName}, ${byTitle})` : ''}`,
      outstanding: outstanding.length,
    });
  res.json({ ok: true, executed: !outstanding.length, outstanding: outstanding.length });
}));

/** A party can also say no, which is information rather than an error. */
router.post('/agreements/:id/decline', wrap(async (req, res) => {
  if (!(await canSeeAgreement(req, req.params.id)))
    return res.status(404).json({ error: 'Agreement not found' });
  const a = await loadAgreement(req.params.id);
  const mine = isInvestor(req) ? Number(req.user.iid) : null;
  const signer = mine
    ? a.signers.find((s) => s.investor_id === mine)
    : a.signers.find((s) => s.role === 'Manager');
  if (!signer) return res.status(403).json({ error: 'You are not a party to this agreement' });
  if (signer.signed_at)
    return res.status(409).json({ error: 'You have already signed this agreement' });
  await q(
    `UPDATE agreement_signers SET declined_at = now(), decline_note = $1 WHERE id = $2`,
    [str(req.body.note).slice(0, 500), signer.id]);
  await audit(req.user.uid, 'agreement', Number(req.params.id), 'update',
    `declined by ${signer.name}`);
  /* A refusal needs answering more urgently than a signature does, and it is
     the one thing nobody thinks to go and look for. */
  await tellStaff('agreement_declined',
    await staffAudience({ fundId: a.fund_id, investorId: signer.investor_id,
      alsoUserId: a.issued_by }), {
      title: a.terms?.llc_name || a.title || 'the operating agreement',
      who: signer.name, note: str(req.body.note).slice(0, 300),
    });
  res.json({ ok: true });
}));

/**
 * The PDF, at any stage.
 *
 * A draft prints with empty signature lines and a watermark of sorts in
 * its filename; an executed one prints with the signatures and the audit
 * line under each. Same renderer either way, so what a member reads
 * before signing is what they get afterwards.
 */
router.get('/agreements/:id/pdf', wrap(async (req, res) => {
  if (!(await canSeeAgreement(req, req.params.id)))
    return res.status(404).json({ error: 'Agreement not found' });
  const a = await loadAgreement(req.params.id);
  const pdf = agreementPdf(a.blocks, {
    title: a.title,
    hash: a.body_hash || a.current_hash,
  });
  const stem = safeName(`${a.terms?.llc_name || a.title || 'agreement'}`)
    .replace(/\.[^.]*$/, '').slice(0, 60) || 'agreement';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `inline; filename="${stem}-${a.status === 'Executed' ? 'executed' : 'draft'}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(pdf);
}));

/**
 * File the executed agreement in the cabinet, one copy per member.
 *
 * A copy each rather than one shared copy: the documents cabinet shares a
 * row with exactly one investor, and an agreement every member can see is
 * an agreement whose Schedule tells each of them what the others put in.
 * They are entitled to that on their own copy and nowhere else.
 */
async function fileExecutedAgreement(a, userId) {
  const pdf = agreementPdf(a.blocks, { title: a.title, hash: a.body_hash || a.current_hash });
  const checksum = createHash('sha256').update(pdf).digest('hex');
  const stem = safeName(`${a.terms?.llc_name || a.title || 'agreement'}`)
    .replace(/\.[^.]*$/, '').slice(0, 60) || 'agreement';
  const fileName = `${stem}-executed.pdf`;
  const year = Number(String(a.terms?.effective_date || '').slice(0, 4)) || null;

  let firstId = null;
  const members = a.signers.filter((s) => s.role !== 'Manager' && s.investor_id);
  const targets = members.length ? members : [{ investor_id: null }];
  for (const m of targets) {
    const { rows } = await q(
      `INSERT INTO documents (title, category, doc_year, notes, fund_id, investor_id,
                              policy_id, shared, file_name, mime_type, byte_size,
                              checksum, content, uploaded_by)
       VALUES ($1,'LLC Agreement',$2,$3,$4,$5,$6,TRUE,$7,'application/pdf',$8,$9,$10,$11)
       RETURNING id`,
      [a.title || a.terms?.llc_name || 'Operating agreement', year,
       `Executed ${new Date().toISOString().slice(0, 10)} · document ${
         (a.body_hash || a.current_hash).slice(0, 16)}`,
       a.fund_id, m.investor_id, a.policy_id, fileName, pdf.length, checksum, pdf, userId]);
    firstId = firstId ?? rows[0].id;
  }
  return firstId;
}

/* ---------------------- the queue, for the firm --------------------- */

const applicationRow = (a) => ({
  ...a,
  tax_id_enc: undefined,
  tax_id_key: undefined,
  password_hash: undefined,
  tax_id_masked: maskTaxId(a.tax_id_last4, a.investor_type),
});

router.get('/applications', blockInvestors, requireRole('admin', 'manager', 'editor'),
  wrap(async (req, res) => {
    const status = APPLICATION_STATUSES.includes(str(req.query.status))
      ? str(req.query.status) : '';
    const { rows } = await q(
      `SELECT a.*, u.full_name AS decided_by_name, i.name AS investor_name
         FROM investor_applications a
         LEFT JOIN users u     ON u.id = a.decided_by
         LEFT JOIN investors i ON i.id = a.investor_id
        WHERE ($1 = '' OR a.status = $1)
        ORDER BY (a.status = 'Pending') DESC, a.submitted_at DESC`, [status]);
    res.json(rows.map(applicationRow));
  }));

/**
 * Lift the registration cap for an address that has hit it.
 *
 * The cap is deliberately blunt, so somebody legitimate will occasionally
 * run into it — an adviser onboarding a group, a family filing separately
 * from one house. When they telephone, this is the answer, rather than
 * telling them to wait an hour. Administrators only, and on the record.
 */
router.delete('/register-throttle', blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const ip = str(req.body?.ip);
    const { rowCount } = await q(
      `DELETE FROM login_attempts
        WHERE ident LIKE 'register:%' AND ($1 = '' OR ident = 'register:' || $1)`, [ip]);
    await audit(req.user.uid, 'user', null, 'update',
      `cleared the registration limit${ip ? ` for ${ip}` : ' for every address'} · ${rowCount} row(s)`);
    res.json({ ok: true, cleared: rowCount });
  }));

/** How many are waiting — for the badge, so the menu can say so. */
router.get('/applications/summary', blockInvestors, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS pending FROM investor_applications WHERE status = 'Pending'`);
  res.json({ pending: rows[0].pending });
}));

/**
 * The full tax number, once, deliberately, and on the record.
 *
 * Administrators only, and every read is written to the audit log with the
 * name of the person who asked. If somebody ever needs to answer "who has
 * looked at this investor's Social Security number", the answer is here.
 */
router.get('/applications/:id/tax-id', blockInvestors, requireRole('admin'),
  wrap(async (req, res) => {
    const { rows } = await q(
      'SELECT full_name, email, tax_id_enc FROM investor_applications WHERE id = $1',
      [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Application not found' });
    const value = openField(rows[0].tax_id_enc);
    await audit(req.user.uid, 'application', Number(req.params.id), 'read',
      `revealed tax id for ${rows[0].full_name}`);
    if (!value)
      return res.status(409).json({
        error: 'That number cannot be decrypted with the current key. It was stored under a '
          + 'different one — ask the applicant to supply it again.' });
    res.json({ tax_id: value });
  }));

/**
 * Approve.
 *
 * Creates the investor record and the login from what the applicant typed,
 * with the password they chose — they never have to be sent one, and
 * nobody here ever knows it. All of it in one transaction: an investor
 * with no login, or a login pointing at no investor, are both worse than
 * a failure that can be retried.
 */
router.post('/applications/:id/approve', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    const { rows: found } = await q(
      'SELECT * FROM investor_applications WHERE id = $1', [req.params.id]);
    const a = found[0];
    if (!a) return res.status(404).json({ error: 'Application not found' });
    if (a.status !== 'Pending')
      return res.status(409).json({ error: `This application was already ${a.status.toLowerCase()}` });

    const { rows: clash } = await q('SELECT id FROM users WHERE lower(email) = lower($1)', [a.email]);
    if (clash.length)
      return res.status(409).json({
        error: `${a.email} already has a login. Decline this application and use the existing `
          + 'account, or change the address on the account first.' });

    // The name the money is held in, if they gave one; otherwise their own.
    const investorName = str(a.entity_name) || str(a.full_name);

    /* Which of our entities this relationship belongs to. Optional — an
       investor can be opened before it is settled which LLC they will
       come in through — but naming it here is what puts them in front of
       that entity's manager straight away, rather than only once they
       hold something. A manager approving may only assign their own. */
    const fundId = int(req.body.fund_id);
    const scoped = fundScope(req);
    if (fundId && scoped && !scoped.includes(fundId))
      return res.status(403).json({ error: 'That owner entity is not one of yours' });
    const client = await pool.connect();
    let investorId; let userId;
    try {
      await client.query('BEGIN');
      const { rows: inv } = await client.query(
        `INSERT INTO investors (name, legal_name, investor_type, email, phone,
                                address_line1, address_line2, city, state, postal_code,
                                country, tax_id_last4, tax_id_enc, tax_id_key, fund_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [investorName, str(a.full_name), a.investor_type, a.email, a.phone,
         a.address_line1, a.address_line2, a.city, a.state, a.postal_code,
         a.country, a.tax_id_last4, a.tax_id_enc, a.tax_id_key, fundId,
         `Registered ${String(a.submitted_at).slice(0, 10)}${a.note ? ` · ${a.note}` : ''}`]);
      investorId = inv[0].id;

      const { rows: usr } = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role, investor_id)
         VALUES ($1,$2,$3,'investor',$4) RETURNING id`,
        [a.email, a.password_hash, a.full_name, investorId]);
      userId = usr[0].id;

      await client.query(
        `UPDATE investor_applications
            SET status = 'Approved', decided_at = now(), decided_by = $1,
                decision_note = $2, investor_id = $3, user_id = $4,
                password_hash = 'moved-to-account'
          WHERE id = $5`,
        [req.user.uid, str(req.body.note), investorId, userId, req.params.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505')
        return res.status(409).json({
          error: 'Somebody else approved this application, or that email was taken while this '
            + 'one was open. Reload the list.' });
      throw e;
    } finally {
      client.release();
    }

    await audit(req.user.uid, 'application', Number(req.params.id), 'update',
      `approved ${a.full_name} · investor ${investorId} · user ${userId}${
        fundId ? ` · entity ${fundId}` : ' · no entity assigned'}`);
    /* They were told to expect this, so it has to arrive. Their password is
       the one they chose when they registered — nobody here has ever known
       it — so the message says to use that rather than carrying anything. */
    await sendMail('registration_approved', {
      to: a.email, userId, name: a.full_name, email: a.email });
    res.json({ ok: true, investor_id: investorId, user_id: userId,
               name: investorName, fund_id: fundId });
  }));

/**
 * Decline. The application is kept — a record of who asked and what was
 * decided is worth more than a tidy table — but the password hash is
 * thrown away, because there is no longer any account for it to become.
 */
router.post('/applications/:id/decline', blockInvestors, requireRole('admin', 'manager'),
  wrap(async (req, res) => {
    const { rows } = await q(
      `UPDATE investor_applications
          SET status = 'Declined', decided_at = now(), decided_by = $1, decision_note = $2,
              password_hash = 'declined'
        WHERE id = $3 AND status = 'Pending'
        RETURNING full_name, email`,
      [req.user.uid, str(req.body.note), req.params.id]);
    if (!rows[0])
      return res.status(409).json({ error: 'That application is no longer pending' });
    await audit(req.user.uid, 'application', Number(req.params.id), 'update',
      `declined ${rows[0].full_name}${str(req.body.note) ? ` · ${str(req.body.note)}` : ''}`);
    res.json({ ok: true });
  }));

/**
 * Delete. Administrators only, and the reason to keep it is stated in the
 * refusal: an approved application is the provenance of a live account.
 */
router.delete('/applications/:id', blockInvestors, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT status, full_name, investor_id, user_id FROM investor_applications WHERE id = $1',
    [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Application not found' });
  /* An approved application is the provenance of a live account, so it
     stays. Once that account and that investor have both been deleted
     there is nothing left for it to be the provenance of, and keeping it
     is not record-keeping — it is litter. */
  if (rows[0].status === 'Approved' && (rows[0].investor_id || rows[0].user_id))
    return res.status(409).json({
      error: 'This application is where a live investor account came from. It stays on the '
        + 'record; disable the account instead if the relationship has ended.' });
  await q('DELETE FROM investor_applications WHERE id = $1', [req.params.id]);
  await audit(req.user.uid, 'application', Number(req.params.id), 'delete', rows[0].full_name);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * audit trail
 * ------------------------------------------------------------------ */

router.get('/audit', blockScoped, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 300`
  );
  res.json(rows);
}));

export default router;
export { wrap, num, int, str, url };
