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
