-- =====================================================================
--  PolicyHub - Life Settlement Portfolio Management
--  Schema (PostgreSQL 13+)
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'admin',   -- admin | editor | viewer
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owning entity / fund (LCG2, Life Capital Group 2, etc.)
CREATE TABLE IF NOT EXISTS funds (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insureds (
  id            SERIAL PRIMARY KEY,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL DEFAULT '',      -- e.g. "Dean & Cheryl Wolfe" for joint/survivorship
  dob           DATE,
  gender        TEXT,                          -- M | F | Joint
  state         TEXT,
  smoker        TEXT,                          -- Smoker | Non-Smoker | Unknown
  le_months     INTEGER,                       -- life expectancy in months
  le_provider   TEXT,
  le_date       DATE,
  date_of_death DATE,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insureds_last_name ON insureds (lower(last_name));

CREATE TABLE IF NOT EXISTS policies (
  id                  SERIAL PRIMARY KEY,
  policy_number       TEXT NOT NULL,
  unique_case_id      TEXT NOT NULL DEFAULT '',
  insured_id          INTEGER REFERENCES insureds(id) ON DELETE SET NULL,
  fund_id             INTEGER REFERENCES funds(id) ON DELETE SET NULL,

  carrier_name        TEXT NOT NULL DEFAULT '',
  plan_name           TEXT NOT NULL DEFAULT '',
  product_type        TEXT NOT NULL DEFAULT '',  -- UL | GUL | VUL | IUL | Whole Life | Term | Other
  issue_date          DATE,
  issue_age           INTEGER,
  issue_state         TEXT,

  face_amount         NUMERIC(16,2),             -- "Basic Face" / death benefit at issue
  owner_account       TEXT NOT NULL DEFAULT '',  -- carrier-side owner/account reference
  beneficiary         TEXT NOT NULL DEFAULT '',

  status              TEXT NOT NULL DEFAULT 'Inforce', -- Inforce | Grace | Lapsed | Matured | Sold | Pending
  status_date         DATE,

  premium_required    NUMERIC(16,2),             -- amount due each premium period
  premium_mode        TEXT NOT NULL DEFAULT 'Annual', -- Monthly | Quarterly | Semi-Annual | Annual
  next_premium_due    DATE,
  grace_period_days   INTEGER NOT NULL DEFAULT 61,

  acquisition_date    DATE,
  acquisition_cost    NUMERIC(16,2),             -- purchase price paid for the policy

  notes               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_number, carrier_name)
);
CREATE INDEX IF NOT EXISTS idx_policies_insured ON policies (insured_id);
CREATE INDEX IF NOT EXISTS idx_policies_status  ON policies (status);
CREATE INDEX IF NOT EXISTS idx_policies_due     ON policies (next_premium_due);

-- ---------------------------------------------------------------------
--  Investors and fractional ownership
--
--  An owning entity (funds) holds a policy on paper; investors hold
--  economic percentages of it. A policy's allocations may total less than
--  100% (the remainder is unallocated / house) but never more.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investors (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  legal_name    TEXT NOT NULL DEFAULT '',
  investor_type TEXT NOT NULL DEFAULT 'Individual', -- Individual | Entity | Trust | IRA | Other
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  tax_id_last4  TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investors_name ON investors (lower(name));

CREATE TABLE IF NOT EXISTS policy_investors (
  id           SERIAL PRIMARY KEY,
  policy_id    INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  investor_id  INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  pct          NUMERIC(9,6) NOT NULL CHECK (pct > 0 AND pct <= 100),
  acquired_on  DATE,
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, investor_id)
);
CREATE INDEX IF NOT EXISTS idx_pi_policy   ON policy_investors (policy_id);
CREATE INDEX IF NOT EXISTS idx_pi_investor ON policy_investors (investor_id);

-- A login may be tied to an investor; that user sees only that investor's
-- positions. Staff logins leave this null.
ALTER TABLE users ADD COLUMN IF NOT EXISTS investor_id INTEGER
  REFERENCES investors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_investor ON users (investor_id);

-- Portfolio managers are scoped to one or more owning entities. Inside those
-- entities they have full read/write; outside them the data does not exist.
CREATE TABLE IF NOT EXISTS user_funds (
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  fund_id    INTEGER NOT NULL REFERENCES funds(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fund_id)
);
CREATE INDEX IF NOT EXISTS idx_user_funds_user ON user_funds (user_id);

-- Investors a manager may work with directly, independent of the entities.
--
-- The entity scope answers "whose money is already in my book"; it cannot
-- answer "who may I take this new deal to". A manager introducing an
-- opportunity needs the investor on file *before* that investor holds
-- anything, and without this they would have no way to reach the record —
-- so they would key in a second copy of a client the firm already has, and
-- the two would drift. An administrator grants the relationship here once.
--
-- This only ever widens what a manager can see. It never narrows the entity
-- scope, and it grants nothing over policies: an investor being reachable is
-- not the same as their holdings being readable.
CREATE TABLE IF NOT EXISTS user_investors (
  user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  investor_id INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, investor_id)
);
CREATE INDEX IF NOT EXISTS idx_user_investors_user ON user_investors (user_id);
CREATE INDEX IF NOT EXISTS idx_user_investors_investor ON user_investors (investor_id);

-- Bumped whenever a password changes. Every session cookie carries the number
-- it was issued under, so raising it retires all of that user's cookies at once
-- instead of waiting out the 12-hour expiry.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Failed sign-in attempts, kept in the database rather than in process memory
-- so that the throttle survives a restart or redeploy and is shared by every
-- instance. Rows older than the window are pruned as they are counted.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  ident      TEXT NOT NULL,             -- lower(email) | client ip
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (ident, created_at);

-- Additional lives on a policy (survivorship / second-to-die / joint).
-- The PRIMARY insured stays on policies.insured_id; this table holds the
-- extra lives, so there is exactly one source of truth for each.
CREATE TABLE IF NOT EXISTS policy_insureds (
  id          SERIAL PRIMARY KEY,
  policy_id   INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  insured_id  INTEGER NOT NULL REFERENCES insureds(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'Joint',  -- Joint | Survivorship | Secondary | Other
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, insured_id)
);
CREATE INDEX IF NOT EXISTS idx_policy_insureds ON policy_insureds (policy_id);

-- Monthly (or ad-hoc) snapshot of carrier-reported values
CREATE TABLE IF NOT EXISTS policy_values (
  id                  SERIAL PRIMARY KEY,
  policy_id           INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  as_of_date          DATE NOT NULL,
  account_value       NUMERIC(16,2),   -- AV
  cash_surrender_value NUMERIC(16,2),  -- CSV
  cost_of_insurance   NUMERIC(16,2),   -- COI (monthly deduction)
  death_benefit       NUMERIC(16,2),   -- current DB (may differ from face)
  premium_paid_to_date NUMERIC(16,2),  -- PPD
  monthly_deduction   NUMERIC(16,2),
  loan_balance        NUMERIC(16,2),
  date_of_last_withdrawal DATE,
  source              TEXT NOT NULL DEFAULT 'manual', -- manual | csv | carrier
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_values_policy_date ON policy_values (policy_id, as_of_date DESC);

CREATE TABLE IF NOT EXISTS transactions (
  id            SERIAL PRIMARY KEY,
  policy_id     INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  txn_date      DATE NOT NULL,
  txn_type      TEXT NOT NULL,   -- Acquisition Cost | Premium Payment | Withdrawal | Loan | Fee | Commission | Servicing | Other
  amount        NUMERIC(16,2) NOT NULL DEFAULT 0,
  remarks       TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_txn_policy_date ON transactions (policy_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions (txn_type);

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  action      TEXT NOT NULL,     -- create | update | delete | import | login
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

-- ---------------------------------------------------------------------
--  Maturities
--
--  A policy matures when the death that triggers the claim is recorded.
--  Which death that is depends on the product:
--
--    SUL (survivorship / second-to-die) — the carrier pays only after the
--      LAST insured has died, so a first death is recorded but the policy
--      stays in the active book until the second.
--    Everything else — the first recorded death matures it.
--
--  matured_on holds the date that triggered it. Its presence is also what
--  marks the maturity as automatic: a policy an administrator marked
--  'Matured' by hand has no matured_on and is left alone by the trigger.
-- ---------------------------------------------------------------------
ALTER TABLE policies ADD COLUMN IF NOT EXISTS matured_on DATE;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS proceeds_amount NUMERIC(16,2);
ALTER TABLE policies ADD COLUMN IF NOT EXISTS proceeds_received_on DATE;
CREATE INDEX IF NOT EXISTS idx_policies_matured ON policies (matured_on);

-- ---------------------------------------------------------------------
--  Case files
--
--  The file room for a policy usually lives somewhere else already —
--  Dropbox, a shared drive, the servicer's own portal. Rather than ask
--  anyone to move it, a policy carries a link to it, and everyone with
--  sight of the policy gets the same link. Only the address is stored;
--  who may open it is decided by the folder's own sharing settings.
-- ---------------------------------------------------------------------
ALTER TABLE policies ADD COLUMN IF NOT EXISTS documents_url TEXT;

-- The rule, as a function, so the trigger and any report agree by construction.
CREATE OR REPLACE FUNCTION policy_maturity_date(p_id INTEGER)
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN l.lives = 0 THEN NULL
           WHEN p.product_type = 'SUL' THEN
             CASE WHEN l.deaths = l.lives THEN l.last_death ELSE NULL END
           ELSE l.first_death
         END
    FROM policies p
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int                AS lives,
             COUNT(dod)::int              AS deaths,
             MIN(dod)                     AS first_death,
             MAX(dod)                     AS last_death
        FROM (
          SELECT i.date_of_death AS dod
            FROM insureds i WHERE i.id = p.insured_id
          UNION ALL
          SELECT i2.date_of_death
            FROM policy_insureds pi JOIN insureds i2 ON i2.id = pi.insured_id
           WHERE pi.policy_id = p.id
        ) lives_of_policy
    ) l
   WHERE p.id = p_id;
$$;

-- Apply the rule to one policy. Sold and Lapsed are left alone: a policy that
-- was sold is somebody else's claim, and one that lapsed pays nothing, so a
-- death recorded afterwards should not quietly resurrect either.
CREATE OR REPLACE FUNCTION apply_policy_maturity(p_id INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  computed DATE;
  cur      RECORD;
BEGIN
  SELECT status, matured_on INTO cur FROM policies WHERE id = p_id;
  IF NOT FOUND OR cur.status IN ('Sold', 'Lapsed') THEN RETURN; END IF;

  computed := policy_maturity_date(p_id);

  IF computed IS NOT NULL THEN
    UPDATE policies
       SET matured_on  = computed,
           status      = 'Matured',
           status_date = COALESCE(status_date, computed),
           updated_at  = now()
     WHERE id = p_id
       AND (matured_on IS DISTINCT FROM computed OR status <> 'Matured');

  ELSIF cur.matured_on IS NOT NULL THEN
    -- The qualifying death was removed or a second life was added to a
    -- survivorship policy. Undo the automatic maturity, and with it the
    -- proceeds recorded against a claim that is no longer being made.
    UPDATE policies
       SET matured_on = NULL, status = 'Inforce',
           proceeds_amount = NULL, proceeds_received_on = NULL,
           updated_at = now()
     WHERE id = p_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sync_maturity_for_insured() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id FROM policies WHERE insured_id = NEW.id
    UNION
    SELECT policy_id FROM policy_insureds WHERE insured_id = NEW.id
  LOOP
    PERFORM apply_policy_maturity(r.id);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION sync_maturity_for_policy() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM apply_policy_maturity(COALESCE(NEW.policy_id, OLD.policy_id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION sync_maturity_self() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM apply_policy_maturity(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_maturity_insured ON insureds;
CREATE TRIGGER trg_maturity_insured
  AFTER INSERT OR UPDATE OF date_of_death ON insureds
  FOR EACH ROW EXECUTE FUNCTION sync_maturity_for_insured();

DROP TRIGGER IF EXISTS trg_maturity_lives ON policy_insureds;
CREATE TRIGGER trg_maturity_lives
  AFTER INSERT OR DELETE ON policy_insureds
  FOR EACH ROW EXECUTE FUNCTION sync_maturity_for_policy();

-- Changing the product type or the primary insured can change the answer too.
DROP TRIGGER IF EXISTS trg_maturity_policy ON policies;
CREATE TRIGGER trg_maturity_policy
  AFTER INSERT OR UPDATE OF product_type, insured_id, status ON policies
  FOR EACH ROW EXECUTE FUNCTION sync_maturity_self();

-- ---------------------------------------------------------------------
--  Convenience view: each policy with its most recent value snapshot
--
--  Dropped and rebuilt rather than replaced: the view selects policies.*,
--  so any column added to that table lands in the middle of the view's
--  column list, and CREATE OR REPLACE VIEW may only append at the end.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS policy_latest;
CREATE OR REPLACE VIEW policy_latest AS
SELECT
  p.*,
  i.display_name,
  i.first_name  AS insured_first,
  i.last_name   AS insured_last,
  i.dob         AS insured_dob,
  i.gender      AS insured_gender,
  i.date_of_death,
  i.le_months,
  f.code        AS fund_code,
  v.as_of_date              AS value_as_of,
  v.account_value,
  v.cash_surrender_value,
  v.cost_of_insurance,
  v.death_benefit,
  v.premium_paid_to_date,
  v.loan_balance,
  v.date_of_last_withdrawal,
  COALESCE(t.total_invested, 0)   AS total_invested,
  COALESCE(t.total_premiums, 0)   AS total_premiums,
  COALESCE(t.total_acquisition, 0) AS total_acquisition
FROM policies p
LEFT JOIN insureds i ON i.id = p.insured_id
LEFT JOIN funds    f ON f.id = p.fund_id
LEFT JOIN LATERAL (
  SELECT * FROM policy_values pv
  WHERE pv.policy_id = p.id
  ORDER BY pv.as_of_date DESC
  LIMIT 1
) v ON TRUE
LEFT JOIN LATERAL (
  SELECT
    SUM(amount) FILTER (WHERE txn_type IN ('Acquisition Cost','Premium Payment','Fee','Servicing','Commission')) AS total_invested,
    SUM(amount) FILTER (WHERE txn_type = 'Premium Payment')  AS total_premiums,
    SUM(amount) FILTER (WHERE txn_type = 'Acquisition Cost') AS total_acquisition
  FROM transactions tx WHERE tx.policy_id = p.id
) t ON TRUE;

-- Reconcile every policy against the maturity rule at startup. It is cheap and
-- idempotent, it backfills a database that predates these columns, and it means
-- a change to the rule above takes effect on the next deploy rather than
-- waiting for someone to touch each record.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM policies LOOP
    PERFORM apply_policy_maturity(r.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
--  Opportunities
--
--  A policy being offered, not one that is owned. Deliberately its own
--  table rather than a row in `policies`: a deal that may never close
--  must not reach the dashboard, the IRR reports or the maturities
--  register, and keeping it separate means no query has to remember to
--  exclude it. On funding it is converted into a real policy.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  id                 SERIAL PRIMARY KEY,
  policy_number      TEXT NOT NULL DEFAULT '',
  carrier_name       TEXT NOT NULL DEFAULT '',
  product_type       TEXT NOT NULL DEFAULT '',
  face_amount        NUMERIC(16,2),

  -- The insured is held here rather than in `insureds`: these are people
  -- whose policies we do not own, and they should not appear in the
  -- insureds directory unless and until the deal closes.
  insured_last_name  TEXT NOT NULL DEFAULT '',
  insured_first_name TEXT NOT NULL DEFAULT '',
  insured_dob        DATE,
  insured_gender     TEXT,
  insured_state      TEXT,
  le_months          INTEGER,
  le_provider        TEXT NOT NULL DEFAULT '',
  le_date            DATE,

  asking_price       NUMERIC(16,2),        -- the price for the whole policy
  annual_premium     NUMERIC(16,2),        -- used when no schedule is posted
  expected_close     DATE,                 -- when the money would go out
  offer_closes_on    DATE,                 -- when the offer expires

  fund_id            INTEGER REFERENCES funds(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'Open',  -- Open | Closed | Withdrawn | Funded
  policy_id          INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  notes              TEXT NOT NULL DEFAULT '',
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities (status);
CREATE INDEX IF NOT EXISTS idx_opportunities_fund ON opportunities (fund_id);

-- What goes on the investor one-pager but cannot be computed: the medical
-- picture behind the life expectancy, the underwriter's view of it, and the
-- case for the deal. Free text, one bullet per line, because every file
-- reads differently and a fixed set of fields would lose more than it gained.
--
-- A second LE is held separately: two independent reports either corroborate
-- each other or they do not, and averaging them away hides that.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS le_provider_2 TEXT NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS le_months_2 INTEGER;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS impairments TEXT NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS mitigating TEXT NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS underwriter_note TEXT NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS thesis TEXT NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS records_through DATE;

-- What the carrier says the policy is worth today. Account value is what
-- keeps the contract alive; cash surrender value is what walking away is
-- worth, and it is the floor under the price being asked. Both are quoted
-- as at a stated date, because a value with no date is not a value.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS account_value NUMERIC(16,2);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS cash_surrender_value NUMERIC(16,2);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS values_as_of DATE;

-- The premium schedule as offered. Beyond its last row the projection
-- continues at the same annual rate, which the analysis states on its face.
CREATE TABLE IF NOT EXISTS opportunity_premiums (
  id             SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  due_date       DATE NOT NULL,
  amount         NUMERIC(16,2) NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  UNIQUE (opportunity_id, due_date)
);
CREATE INDEX IF NOT EXISTS idx_opp_premiums ON opportunity_premiums (opportunity_id, due_date);

-- Who has been shown it. An investor sees nothing that is not listed here.
CREATE TABLE IF NOT EXISTS opportunity_shares (
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  investor_id    INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  shared_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (opportunity_id, investor_id)
);
CREATE INDEX IF NOT EXISTS idx_opp_shares_investor ON opportunity_shares (investor_id);

-- What an investor has asked for. A request holds the percentage from the
-- moment it is made — that is what makes the remaining figure honest — but
-- it is not an allocation until somebody confirms it.
CREATE TABLE IF NOT EXISTS opportunity_commitments (
  id             SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  investor_id    INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  pct            NUMERIC(9,6) NOT NULL CHECK (pct > 0 AND pct <= 100),
  status         TEXT NOT NULL DEFAULT 'Requested',  -- Requested | Confirmed | Declined | Withdrawn
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ,
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes          TEXT NOT NULL DEFAULT '',
  UNIQUE (opportunity_id, investor_id)
);
CREATE INDEX IF NOT EXISTS idx_opp_commit ON opportunity_commitments (opportunity_id, status);
CREATE INDEX IF NOT EXISTS idx_opp_commit_investor ON opportunity_commitments (investor_id);

-- Percentage spoken for: requests count, because a request holds the space
-- until it is decided. Declined and withdrawn ones release it.
CREATE OR REPLACE VIEW opportunity_taken AS
SELECT o.id AS opportunity_id,
       COALESCE(SUM(c.pct) FILTER (WHERE c.status IN ('Requested','Confirmed')), 0) AS taken_pct,
       COALESCE(SUM(c.pct) FILTER (WHERE c.status = 'Confirmed'), 0)                AS confirmed_pct,
       COALESCE(SUM(c.pct) FILTER (WHERE c.status = 'Requested'), 0)                AS requested_pct,
       COUNT(*) FILTER (WHERE c.status IN ('Requested','Confirmed'))::int           AS investor_count
  FROM opportunities o
  LEFT JOIN opportunity_commitments c ON c.opportunity_id = o.id
 GROUP BY o.id;


/* ====================================================================
   Scheduled next steps
   ====================================================================

   "Next premium due" is one date on the policy, and a life settlement
   needs more than that. The carrier illustration says the premium steps
   up in three years; the change-of-ownership form has to be chased in
   April; the LE report should be refreshed before it goes stale. None of
   those are a premium payment, and none of them fit in a single column.

   So this is a small list of dated intentions against a policy. Two
   kinds, because they behave differently on a calendar: a Premium
   carries a figure and is money that has to be found, while a Reminder
   is work that has to be done. Both are estimates until they happen —
   marking one done is what makes it real, and the transaction ledger,
   not this table, remains the record of what was actually paid.
   ==================================================================== */
CREATE TABLE IF NOT EXISTS policy_reminders (
  id          SERIAL PRIMARY KEY,
  policy_id   INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  due_date    DATE NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'Reminder',   -- Premium | Reminder
  amount      NUMERIC(16,2),                      -- estimate; only for Premium
  note        TEXT NOT NULL DEFAULT '',
  done_at     TIMESTAMPTZ,
  done_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_policy_reminders_policy ON policy_reminders (policy_id);
-- The servicing calendar reads "what is outstanding, soonest first" on every
-- load, so that is the index worth having.
CREATE INDEX IF NOT EXISTS idx_policy_reminders_open
  ON policy_reminders (due_date) WHERE done_at IS NULL;


/* ====================================================================
   Documents
   ====================================================================

   The paperwork a life-settlement fund runs on: the LLC agreement, the
   subscription documents, a K-1 for each investor each year, the odd
   carrier letter. Small in number, awkward in every other way — some
   belong to the firm, some to one owning entity, and some to exactly
   one person and nobody else.

   The bytes live in the database rather than on disk. A container
   filesystem is thrown away on every redeploy, so a file written there
   is a file lost, and object storage would mean an account, a set of
   credentials and a second thing to keep alive. A K-1 is a few hundred
   kilobytes; the whole cabinet fits comfortably in a column, is backed
   up with everything else, and cannot drift out of sync with the record
   that points at it.

   Visibility is the reason this table has as many columns as it does:
     fund_id     — the owning entity it belongs to, or null for the firm
     investor_id — the one investor it is about, or null for nobody
     shared      — whether that investor may see it at all
   A K-1 is investor_id = them, shared = true. A draft of the same K-1 is
   the same row with shared = false, and only staff can see it.
   ==================================================================== */
CREATE TABLE IF NOT EXISTS documents (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'Other',
  doc_year      INTEGER,                       -- K-1s and statements are annual
  notes         TEXT NOT NULL DEFAULT '',

  fund_id       INTEGER REFERENCES funds(id)     ON DELETE SET NULL,
  investor_id   INTEGER REFERENCES investors(id) ON DELETE CASCADE,
  policy_id     INTEGER REFERENCES policies(id)  ON DELETE CASCADE,
  shared        BOOLEAN NOT NULL DEFAULT FALSE, -- may the investor see it

  file_name     TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size     INTEGER NOT NULL,
  -- SHA-256 of the bytes: lets the same file be recognised on re-upload
  -- without comparing megabytes, and proves nothing changed underneath.
  checksum      TEXT NOT NULL DEFAULT '',
  content       BYTEA NOT NULL,

  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_investor ON documents (investor_id);
CREATE INDEX IF NOT EXISTS idx_documents_fund     ON documents (fund_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents (category, doc_year);

/* Listing the cabinet must never drag the cabinet into memory. Every list
   query reads this view; only a download touches `content`. */
CREATE OR REPLACE VIEW document_list AS
SELECT d.id, d.title, d.category, d.doc_year, d.notes,
       d.fund_id, d.investor_id, d.policy_id, d.shared,
       d.file_name, d.mime_type, d.byte_size, d.checksum,
       d.uploaded_by, d.created_at, d.updated_at,
       f.code  AS fund_code,
       i.name  AS investor_name,
       p.policy_number,
       u.full_name AS uploaded_by_name
  FROM documents d
  LEFT JOIN funds f      ON f.id = d.fund_id
  LEFT JOIN investors i  ON i.id = d.investor_id
  LEFT JOIN policies p   ON p.id = d.policy_id
  LEFT JOIN users u      ON u.id = d.uploaded_by;

-- ---------------------------------------------------------------------
--  Operating agreements
--
--  A new LLC agreement is not a new document — it is the same clauses
--  with different blanks filled in. So only the blanks are stored, in
--  `terms`, and the text is rendered from the template on demand. That
--  keeps every agreement in step with counsel's language and makes it
--  impossible for a clause to be quietly different in one copy.
--
--  What is stored, and never re-derived, is `body_hash`: the digest of
--  the exact text at the moment the agreement was issued for signature.
--  A signature is a signature of *that* text. If the template is ever
--  revised, the hash on an executed agreement no longer matches what
--  the template would produce today — which is the correct and visible
--  answer, rather than a silent rewrite of what somebody signed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreements (
  id            SERIAL PRIMARY KEY,
  template      TEXT NOT NULL DEFAULT 'llc_operating_v1',
  title         TEXT NOT NULL DEFAULT '',
  fund_id       INTEGER REFERENCES funds(id) ON DELETE SET NULL,
  policy_id     INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  -- Draft | Out for signature | Executed | Void
  status        TEXT NOT NULL DEFAULT 'Draft',
  terms         JSONB NOT NULL DEFAULT '{}'::jsonb,
  body_hash     TEXT,
  issued_at     TIMESTAMPTZ,
  issued_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executed_at   TIMESTAMPTZ,
  void_reason   TEXT NOT NULL DEFAULT '',
  document_id   INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreements_fund   ON agreements (fund_id);
CREATE INDEX IF NOT EXISTS idx_agreements_status ON agreements (status);

-- One row per party. The signature itself is four columns: what they
-- typed, when, from where, and against which text — an electronic
-- signature is worth exactly as much as the record of how it was taken.
CREATE TABLE IF NOT EXISTS agreement_signers (
  id            SERIAL PRIMARY KEY,
  agreement_id  INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  investor_id   INTEGER REFERENCES investors(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'Member',   -- Member | Manager
  name          TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  contribution  NUMERIC(16,2),
  pct           NUMERIC(9,6),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  signed_at     TIMESTAMPTZ,
  signed_name   TEXT,
  signed_ip     TEXT,
  signed_agent  TEXT,
  signed_hash   TEXT,
  declined_at   TIMESTAMPTZ,
  decline_note  TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_signer_once
  ON agreement_signers (agreement_id, investor_id) WHERE investor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreement_signers_investor
  ON agreement_signers (investor_id);

-- ---------------------------------------------------------------------
--  Investor registration
--
--  An investor fills in their own details and chooses their own password;
--  nobody here ever sees that password, because it is hashed in the same
--  request that receives it and only the hash is stored. The application
--  sits here until somebody approves it, at which point the investor
--  record and the login are created from it in one transaction.
--
--  The tax number is encrypted (see src/secret-field.js). Only the last
--  four digits are held in the clear, which is what every screen shows
--  and what a person actually uses to tell two records apart.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investor_applications (
  id             SERIAL PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Approved | Declined
  full_name      TEXT NOT NULL,
  entity_name    TEXT NOT NULL DEFAULT '',
  investor_type  TEXT NOT NULL DEFAULT 'Individual',
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  address_line1  TEXT NOT NULL DEFAULT '',
  address_line2  TEXT NOT NULL DEFAULT '',
  city           TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT '',
  postal_code    TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT 'United States',
  tax_id_enc     TEXT,
  tax_id_last4   TEXT NOT NULL DEFAULT '',
  tax_id_key     TEXT NOT NULL DEFAULT '',
  password_hash  TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',          -- what the applicant told us
  submitted_ip   TEXT NOT NULL DEFAULT '',
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ,
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_note  TEXT NOT NULL DEFAULT '',
  investor_id    INTEGER REFERENCES investors(id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- One live application per mailbox. A declined one does not block a fresh
-- attempt, because circumstances change and re-applying is the normal path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_pending_email
  ON investor_applications (lower(email)) WHERE status = 'Pending';
CREATE INDEX IF NOT EXISTS idx_applications_status
  ON investor_applications (status, submitted_at DESC);

-- The same details, on the investor record they become.
ALTER TABLE investors ADD COLUMN IF NOT EXISTS address_line1 TEXT NOT NULL DEFAULT '';
ALTER TABLE investors ADD COLUMN IF NOT EXISTS address_line2 TEXT NOT NULL DEFAULT '';
ALTER TABLE investors ADD COLUMN IF NOT EXISTS city          TEXT NOT NULL DEFAULT '';
ALTER TABLE investors ADD COLUMN IF NOT EXISTS state         TEXT NOT NULL DEFAULT '';
ALTER TABLE investors ADD COLUMN IF NOT EXISTS postal_code   TEXT NOT NULL DEFAULT '';
ALTER TABLE investors ADD COLUMN IF NOT EXISTS country       TEXT NOT NULL DEFAULT '';
ALTER TABLE investors ADD COLUMN IF NOT EXISTS tax_id_enc    TEXT;
ALTER TABLE investors ADD COLUMN IF NOT EXISTS tax_id_key    TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------
--  Which entity an investor belongs to
--
--  Distinct from where their money actually is: a position in a policy
--  puts an investor in front of that policy's entity whatever this says.
--  This is the relationship — whose client they are, and therefore which
--  manager sees them in their list before they hold anything at all.
--  Assigned by an administrator, usually at the moment a registration is
--  approved.
-- ---------------------------------------------------------------------
ALTER TABLE investors ADD COLUMN IF NOT EXISTS fund_id INTEGER
  REFERENCES funds(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_investors_fund ON investors (fund_id);

/* ====================================================================== *
 * Capital calls
 *
 * A premium falls due on a policy several investors own between them.
 * Somebody has to ask each of them for their share, say by when, and then
 * know who has paid. That is a capital call, and until now it lived in
 * whoever's inbox raised it.
 *
 * Three tables because there are three different things:
 *
 *   capital_calls        the ask: what it is for, and the date the money
 *                        has to be in by. One deadline per call.
 *   capital_call_items   the premiums it covers, frozen at the moment the
 *                        call went out. A premium that later moves does
 *                        not rewrite a notice already sent.
 *   capital_call_lines   what each investor owes, and where it has got to.
 *
 * The line's state is deliberately two-sided. An investor saying they have
 * sent the money and the office seeing it arrive are different facts, and
 * collapsing them into one would mean either trusting a claim as a receipt
 * or giving the investor no way to say anything at all.
 * ====================================================================== */

CREATE TABLE IF NOT EXISTS capital_calls (
  id            SERIAL PRIMARY KEY,
  reference     TEXT NOT NULL DEFAULT '',      -- e.g. "CC-2026-03"
  title         TEXT NOT NULL DEFAULT '',
  fund_id       INTEGER REFERENCES funds(id) ON DELETE SET NULL,
  due_date      DATE NOT NULL,                 -- money to be received by
  covers_from   DATE,                          -- the premium window it was raised over
  covers_to     DATE,
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'Open',  -- Open | Closed | Cancelled
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capital_calls_status ON capital_calls (status, due_date);

CREATE TABLE IF NOT EXISTS capital_call_items (
  id            SERIAL PRIMARY KEY,
  call_id       INTEGER NOT NULL REFERENCES capital_calls(id) ON DELETE CASCADE,
  policy_id     INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  -- Copied rather than joined: the notice has to keep saying what it said.
  policy_number TEXT NOT NULL DEFAULT '',
  carrier_name  TEXT NOT NULL DEFAULT '',
  insured_name  TEXT NOT NULL DEFAULT '',
  due_date      DATE,
  amount        NUMERIC(16,2) NOT NULL DEFAULT 0,   -- whole-policy premium
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_capital_call_items ON capital_call_items (call_id);

CREATE TABLE IF NOT EXISTS capital_call_lines (
  id             SERIAL PRIMARY KEY,
  call_id        INTEGER NOT NULL REFERENCES capital_calls(id) ON DELETE CASCADE,
  investor_id    INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  amount         NUMERIC(16,2) NOT NULL DEFAULT 0,
  -- What the investor said, and what the office saw. Two facts, not one.
  marked_paid_at TIMESTAMPTZ,
  marked_paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  marked_note    TEXT NOT NULL DEFAULT '',
  confirmed_at   TIMESTAMPTZ,
  confirmed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  waived_at      TIMESTAMPTZ,
  UNIQUE (call_id, investor_id)
);
CREATE INDEX IF NOT EXISTS idx_capital_call_lines ON capital_call_lines (call_id);
CREATE INDEX IF NOT EXISTS idx_capital_call_lines_inv ON capital_call_lines (investor_id);

/* The premium a carrier statement says is next, recorded when the statement
   is in hand rather than on a separate trip through the policy form. */
ALTER TABLE policy_values ADD COLUMN IF NOT EXISTS next_premium_due    DATE;
ALTER TABLE policy_values ADD COLUMN IF NOT EXISTS next_premium_amount NUMERIC(16,2);

/* Carried interest is a term of the operating agreement, and not every
   entity has one — some books are managed for a fee instead. So the rate
   belongs to the owning entity rather than to the application. Zero means
   the investors in that entity keep the whole profit.

   Ten by default, which is what the existing books were built on. A policy
   held in no entity at all carries none: there is no agreement to charge
   under, and showing an investor less than they are owed on the strength of
   an assumption is the wrong way to be wrong. */
ALTER TABLE funds ADD COLUMN IF NOT EXISTS carry_pct NUMERIC(6,3) NOT NULL DEFAULT 10;

/* ---------------------------------------------------------------------
    How each person arranges a screen.

    Preferences, not data: which columns somebody wants on the policies
    grid and in what order. Keyed to the user, so two people looking at
    the same book can lay it out differently, and dropped with the account.

    Deliberately a name/value pair rather than a column per setting — a
    layout is the user's business, and the shape of one changes as screens
    do. The value is checked against the field catalogue before it is
    stored, so nothing arbitrary can be parked here.
   --------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

/* ---------------------------------------------------------------------
    Where somebody signs in from, and what they should be told about it.

    The realistic breach here is not a clever attack on the application; it
    is a password that has been phished or reused. The one signal that
    produces is a sign-in from somewhere the account has never been used
    before — so every sign-in is fingerprinted and, when the fingerprint is
    new, the account holder is told the next time they look at a screen.

    Deliberately coarse. The address is kept as a network prefix (the last
    octet dropped, or the last 80 bits of an IPv6 address), which is enough
    to tell "your usual office" from "somewhere else entirely" and is not a
    log of where an employee physically is. The browser is recorded as a
    family — Chrome on macOS — not as the full user-agent string.
   --------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS login_locations (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sign_ins    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_login_locations_user ON login_locations (user_id);

/* Things somebody needs to be told, rather than things the system needs to
   remember — which is why these are separate from the audit log. A notice is
   addressed to one person, it is shown to them until they have seen it, and
   it says what to do about it. */
CREATE TABLE IF NOT EXISTS security_notices (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- new_location | bulk_export
  detail     TEXT NOT NULL DEFAULT '',
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_security_notices_user
  ON security_notices (user_id, seen_at, created_at DESC);

/* ---------------------------------------------------------------------
    Signing on behalf of an entity.

    A company, trust or IRA cannot hold a pen. When the party to an
    agreement is one, two things have to be on the signature line: the
    entity, which is the party, and the human being signing for it, in the
    capacity that gives them the authority to. "Kestrel Holdings LLC" alone
    is not a signature; "Ellen Ward, Managing Member" alone binds Ellen.

    `party_type` is copied from the investor record when the party is put
    on the agreement, and then left alone. The requirement has to be fixed
    at the moment the document is drawn, not re-read from a record somebody
    might edit while it is out for signature.
   --------------------------------------------------------------------- */
ALTER TABLE agreement_signers ADD COLUMN IF NOT EXISTS party_type TEXT NOT NULL DEFAULT 'Individual';
ALTER TABLE agreement_signers ADD COLUMN IF NOT EXISTS signed_by_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE agreement_signers ADD COLUMN IF NOT EXISTS signed_by_title TEXT NOT NULL DEFAULT '';

/* The manager is the firm, which is itself an entity — so an agreement drawn
   before this existed gets the same treatment as one drawn after it. */
UPDATE agreement_signers SET party_type = 'Entity'
 WHERE role = 'Manager' AND party_type = 'Individual';

/* ---------------------------------------------------------------------
    A password somebody else chose.

    When the office opens an investor's account for them, staff type the
    first password and then have to tell the investor what it is — down a
    phone line, in an email, on a note. That password is known to at least
    two people from the moment it exists, so it is a way in rather than a
    credential, and it is marked as one: the account cannot do anything
    until the investor has replaced it with something only they know.

    Off for an account that set its own password — a self-registration, or
    anybody changing their own.
   --------------------------------------------------------------------- */
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

/* ---------------------------------------------------------------------
    Email that has to go out.

    A queue rather than a call in the middle of a request, for two
    reasons. The provider being slow or down must not make signing in
    slow or impossible — email is a courtesy, and the work in front of
    somebody is not. And a message that fails to send should be visible
    and retried rather than lost in a log line nobody reads.

    Rows are kept after sending. "Did the investor get the capital call"
    is a question somebody will ask, and the answer wants a record.
   --------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS email_outbox (
  id           SERIAL PRIMARY KEY,
  to_email     TEXT NOT NULL,
  to_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  body_html    TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'Queued',  -- Queued | Sent | Failed | Skipped
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  provider_id  TEXT NOT NULL DEFAULT '',
  next_try_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
  ON email_outbox (status, next_try_at) WHERE status = 'Queued';

/* What each person wants to hear about.
   A row exists only where somebody has switched something OFF — the
   default for every kind is on, and a table of rows saying "yes" for
   everybody would have to be backfilled every time a kind is added. */
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
