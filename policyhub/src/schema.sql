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
--  Convenience view: each policy with its most recent value snapshot
-- ---------------------------------------------------------------------
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
