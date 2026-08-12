# Poel Capital — Policy Portfolio

Life settlement portfolio management — policies, insureds, monthly carrier values,
premium ledger, servicing calendar, and portfolio analytics.

Built as a conventional server application: **Node.js + Express + PostgreSQL**, with a
dependency-free browser front end. No external CDNs, no third-party analytics, no data
leaves your database.

---

## What's in it

| Area | What it does |
|---|---|
| **Dashboard** | Total death benefit, capital invested, cash surrender value, monthly cost-of-insurance run rate, open alerts. Cumulative capital-deployed trend and death benefit by carrier. |
| **Policies** | Sortable, filterable grid mirroring your existing CRM columns — policy #, insured, DOB, age, carrier, issue date, face, death benefit, owner, premium, AV, CSV, COI, invested, last withdrawal, values-as-of, status. Column totals in the footer. CSV export. |
| **Policy detail** | Overview with **all lives insured** (survivorship / second-to-die policies carry two or more), **value history** (AV/CSV, COI and death benefit charts + full snapshot table), **transactions** (premium/acquisition ledger with totals by type and a cost-basis-vs-death-benefit comparison), **servicing** (premium schedule, one-click premium logging, next-due advance). |
| **Servicing** | Alerts ranked by severity, and upcoming premiums grouped by month with monthly totals. |
| **Insureds** | Separate first and last name fields, DOB, current age, gender, state, life expectancy, policy counts, date of death. Searchable, editable, exportable. |
| **Import** | CSV upload with automatic column matching, preview before commit, and per-row error reporting. Three importers: policies (+ current values), value snapshots, transactions. |
| **Reports** | Four print-ready documents with a per-report cost-basis toggle: **portfolio summary**, **policy schedule** (landscape), **premium forecast**, and **policy fact sheets** (one page each). |
| **Investors** | Directory of investors with position counts and their share of death benefit, capital invested and cash value. Each investor has a page listing every position and its percentage. |
| **Settings** | Password change, **owner entities**, user management (admin), and a full activity log. |

**Owner entities** are managed in Settings — create, rename, annotate, and see each
one's policy count, death benefit and capital invested. A policy's owner is chosen
from a dropdown on the policy form, which also offers inline creation so a new
entity can be added without leaving the dialog. Renaming an entity updates every
policy pointing at it; deleting one is refused while any policy still references
it, so policies can't be orphaned.

**Deleting a policy** is admin-only and requires typing the policy number to confirm.
It cascades to the policy's value snapshots, ledger entries and additional-insured
links, so the audit entry written beforehand captures the policy number, carrier,
insured, face amount, capital invested and the number of rows destroyed — the
activity log is the only record that survives. Setting the status to Sold, Matured
or Lapsed is the non-destructive alternative: it drops the policy out of the
dashboard, alerts and reports while keeping its history.

## Fractional ownership and the investor portal

An owning **entity** (LCG1, LCG2) holds a policy on paper. **Investors** hold
economic percentages of it. Both are recorded: a policy's Overview tab carries an
ownership cap table showing each investor's share, the dollar value of that share,
and any unallocated remainder. Allocations are refused if they would push a policy
past 100%.

A user account with the role **investor** is tied to one investor record and sees
only the policies that investor holds a piece of. That restriction is enforced in
SQL on every read endpoint, not by hiding buttons — `scripts/investor-security-test.mjs`
attempts cross-investor access directly against the API and asserts every attempt
fails.

What an investor login gets:

- **Portfolio** — dashboard totals weighted by their ownership percentage
- **My policies** — only their positions, with a *My share / Full policy* toggle
  that rescales every figure on the page
- **Premiums** — their share of upcoming premium obligations
- **Statements** — the same four reports, scoped and weighted to their holdings
- **Account** — password change only

What they cannot reach, by role and by query: other investors' positions, the
investor directory, owner entities, the user list, the activity log, CSV import,
and every write endpoint including on policies they do hold. On a policy shared
with another investor they see only their own cap-table line — never a co-owner's
name or percentage.

Insured details (name, date of birth, life expectancy) and cost basis (acquisition
cost, capital invested) **are** visible to investors, as configured.

### Alert rules

- **Critical** — premium past due, or account value covers under 3 months of cost of insurance
- **Serious** — account value covers 3–6 months of cost of insurance
- **Warning** — premium due within 14 days
- **Info** — premium due within 45 days, no value update in 120+ days, or no snapshot on file

---

## Data model

```
users            login accounts (bcrypt hashes, roles: admin / editor / viewer)
funds            owning entity: code, full legal name, notes (LCG2, LCG3, …)
insureds         person: DOB, gender, state, life expectancy, date of death
policies         carrier, policy #, product type (UL/SUL/VUL/IUL/GUL/Term/WL), face,
                 issue date, premium schedule, acquisition
policy_insureds  additional lives on a policy (joint / survivorship / secondary);
                 the primary insured stays on policies.insured_id
policy_values    one row per as-of date: AV, CSV, COI, death benefit, loan, last withdrawal
transactions     dated ledger: acquisition cost, premium payment, fee, withdrawal, …
investors        investor of record: name, legal name, type, contact, tax id last 4
policy_investors fractional allocation: policy + investor + percentage; a policy's
                 allocations may total under 100% but never over
users.investor_id ties a login to an investor; that session is scoped to their book
audit_log        who changed what, when
```

`policy_latest` is a view joining each policy to its most recent value snapshot and
its invested-to-date totals — it's what the grid and dashboard read from.

A policy's **coverage runway** is account value ÷ monthly cost of insurance. **Invested
to date** is the sum of acquisition cost, premium payments, fees, servicing and
commission rows in the ledger.

---

## Running it locally

Requires Node 20+ and PostgreSQL 13+.

```bash
npm install
cp .env.example .env          # then edit .env
npm start
```

Open http://localhost:3000 and sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
from your `.env`. The schema is created automatically on first run.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/dbname` |
| `SESSION_SECRET` | yes | Long random string. Changing it signs everyone out. |
| `ADMIN_EMAIL` | first run | Seeds the first admin account |
| `ADMIN_PASSWORD` | first run | Minimum 10 characters. Change after first login. |
| `ADMIN_NAME` | no | Display name |
| `NODE_ENV` | production | Enables secure cookies and HSTS |
| `PORT` | no | Defaults to 3000 |

Once the first admin exists, `ADMIN_*` is ignored — add further users in Settings.

---

## Importing data

Column headers are matched case- and punctuation-insensitively, so your existing
export headers work as-is: `Policy #`, `Primary Insured`, `Basic Face`, `Premium
Required`, `AV`, `CSV`, `COI`, `Date Of Last Withdrawal`, `Values As Of`, and so on.
Unrecognised columns are listed in the preview and skipped.

**Policies import** doubles as the monthly value update: if the file carries AV / CSV /
COI columns, a value snapshot is written for the "as of" date alongside the policy
record. Re-importing the same file updates policies in place rather than duplicating
them — matching is on policy number + carrier.

Templates are downloadable from the Import screen, or from
`/api/import/template/{policies|values|transactions}`.

`scripts/make-demo-csv.js` regenerates the fictional sample files in `demo/` if you
want to try the app before loading real data.

---

## Reports

Reports render as documents in the browser and are saved with the browser's own
**Save as PDF**. That keeps typography, charts and spacing identical to the screen
and avoids running headless Chrome on the server — which would not fit in a
512 MB instance alongside the app.

| Report | Contents |
|---|---|
| Portfolio summary | Tile strip of headline figures, death benefit by carrier chart, and composition tables by carrier, product type and owner, each with % of book |
| Policy schedule | Every policy as a landscape table with column totals — the formatted version of the grid |
| Premium forecast | 12/24/36/60-month projection by month with running capital requirement, optional payment-level detail, and an explicit list of policies that *could not* be projected |
| Policy fact sheet | One page per policy: headline tiles, policy terms, premium and servicing, all lives insured, AV/CSV history chart and recent carrier values |

**Cost basis toggle.** Every report can be generated with or without acquisition
cost, capital invested and benefit multiple, so the same document serves an
internal review and an outside party. The confidentiality line at the top states
which version it is.

The premium forecast holds the current premium constant at each policy's stated
mode. Cost of insurance on universal life rises with insured age, so later years
understate the true requirement — the report says so on its face rather than
implying false precision. Policies missing a premium amount or a next-due date
are listed separately and excluded from the totals rather than silently dropped.

## Number formatting

Stat tiles, table totals and every money figure in the interface and reports show
the exact amount to the cent — `$1,940,000.00`, never `$1.9M`. Rounded display on a
book of record hides the number people actually need to reconcile against.

The one exception is **chart axes and bar labels**, which stay in compact form
(`$20M`, `$150K`). Exact values there would collide and be unreadable, and an axis
tick is a scale reference rather than a figure anyone reconciles. Hover any point
for the precise value.

## Design

The interface follows the Poel Capital visual system: monochrome and high
contrast, hairline rules rather than shadows, mono uppercase micro-labels, and
pill-shaped actions. Inter Tight is self-hosted from `public/fonts` — no CDN, no
external requests, consistent with the Content-Security-Policy below.

Charts use a one-hue, two-shade ramp (near-black to mid gray) rather than a
categorical hue set, since every chart shows at most two related measures. The
pair clears 3:1 surface contrast in both light and dark, with separation far
above the legibility floor, and every chart is backed by a data table. Status
colours stay chromatic — a lapse warning must never depend on gray alone.

## Security

- Passwords hashed with bcrypt (cost 12); never stored or logged in plain text
- Session cookie is `httpOnly`, `sameSite=lax`, and `secure` in production; 12-hour expiry
- Failed logins throttled to 8 attempts per 15 minutes per email + IP
- Every API route except health and login requires a session; writes require `admin` or `editor`
- All SQL is parameterised — no string-built queries
- Content-Security-Policy blocks external scripts; the app loads no third-party assets
- Every create, update, delete, import and login is written to `audit_log`

**Operational responsibilities that are yours, not the app's:** run it over HTTPS,
keep `SESSION_SECRET` and `DATABASE_URL` out of version control, enable automatic
database backups at your host, and remove users promptly when access should end.

---

## Testing

```bash
node scripts/e2e.mjs
```

Drives a real browser through login, the grid, sorting, search, policy detail tabs,
snapshot and transaction creation, CSV import, dark mode, mobile layout, and
unauthenticated-access checks.
