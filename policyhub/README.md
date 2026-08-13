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
| **Maturities** | Policies that have paid out or are waiting to. Death benefit matured, proceeds received, capital invested, realized gain and IRR, with a per-policy claim record. |
| **Return / IRR** | Date-exact internal rate of return on every policy — hypothetical while in force, exact once the cheque is recorded — plus a portfolio IRR on the dashboard. |
| **Insureds** | Separate first and last name fields, DOB, current age, gender, state, life expectancy, policy counts, date of death. Searchable, editable, exportable. |
| **Import** | CSV upload with automatic column matching, preview before commit, and per-row error reporting. Three importers: policies (+ current values), value snapshots, transactions. |
| **Reports** | Six print-ready documents with a per-report cost-basis toggle: **portfolio summary**, **policy schedule** (landscape), **premium forecast**, **policy fact sheets** (one page each), and two return reports — **in force** and **realized**. |
| **Investors** | Directory of investors with position counts and their share of death benefit, capital invested and cash value. Each investor has a page listing every position and its percentage. |
| **Settings** | Password change, **owner entities**, user management — add, edit, suspend, reactivate, delete, reset a password (admin) — and a full activity log. |

**Owner entities** are managed in Settings — create, rename, annotate, and see each
one's policy count, death benefit and capital invested. A policy's owner is chosen
from a dropdown on the policy form, which also offers inline creation so a new
entity can be added without leaving the dialog. Renaming an entity updates every
policy pointing at it; deleting one is refused while any policy still references
it, so policies can't be orphaned.

## Maturities

A policy leaves the active portfolio the moment its date of death is recorded on
the insured — nothing has to be marked by hand. Which death counts depends on
the product:

- **SUL (survivorship / second-to-die)** — the carrier pays only after the
  **last** insured has died. A first death is recorded and the policy stays in
  the active book, because that is the truth about when money arrives.
- **Everything else** — the first recorded death matures it.

Once matured, the policy drops out of the dashboard totals, the servicing
calendar, the alerts, the premium forecast and the policies grid, and appears on
the **Maturities** register instead. It is still reachable: its own page opens
normally and the grid's status filter will show it again.

The register carries, per policy, the maturity date, death benefit, capital
invested, proceeds received and the date they arrived, plus the realized gain.
**Record proceeds** takes what the carrier actually paid, which is often not the
death benefit — a loan balance or interest adjustment moves it. Until an amount
is entered the claim reads *Awaiting*, and the totals separate benefit matured
from benefit collected so an unpaid claim is never mistaken for cash in hand.

Realized gain is proceeds less every dollar in that policy's ledger — acquisition
cost, premiums, fees, servicing, commissions. It is shown only for claims that
have actually been paid; an outstanding claim would otherwise read as a total
loss of its basis.

**It reverses.** Clearing the date of death returns the policy to the active book
and discards any proceeds recorded against the claim, so a date typed into the
wrong record is a mistake you can simply undo. Adding another life to a matured
survivorship policy does the same, since the carrier is no longer at its last
death. Policies already marked **Sold** or **Lapsed** are left alone: a sold
policy is somebody else's claim, and a lapsed one pays nothing.

The rule lives in a database trigger rather than in the route that happens to
write the date, so it applies identically whether the death arrives through the
insured dialog, the API, or a CSV import. `scripts/maturity-test.mjs` sets death
dates every one of those ways and asserts the same outcome each time.

An investor login gets the same register as **Realized**, weighted to their
percentage, so their lifetime picture stays complete without inflating the
active book.

## Return and IRR

Every policy has a **Return / IRR** tab. It solves the internal rate of return
from the policy's dated cash flows — the day each premium actually left and the
day money actually came back — over a 365-day year. That is Excel's XIRR
convention, so any figure here reconciles against a spreadsheet.

Two questions get answered:

- **While the policy is in force** — "what would I have made if the insured died
  this morning?" The carrier's current death benefit is dropped in at today's
  date against the real ledger. It is labelled as the hypothetical it is.
- **Once the claim is settled** — the exact realized return, using the cheque
  that actually arrived on the day it actually cleared.

**The calculator.** On the same tab, three fields: the final date of death, the
exact death benefit cheque, and the date it cleared. The rate, the profit and the
difference against the hypothetical update as you type, before anything is saved.
Saving does both steps in order — writes the date of death to the insured record,
which is what moves the policy to Maturities, then records the proceeds.

The browser and the server run the **same solver from the same file**
(`public/irr.js`, imported by `src/api.js`), so the number on screen while you
type is the number that gets stored. `scripts/irr-ui-test.mjs` asserts exactly
that, comparing what the browser displayed against what the server computed
after saving.

### Conventions

- **The inflow lands on the day the cheque cleared**, not the date of death.
  Carriers take weeks to pay and that delay is a real cost to the return. On a
  five-year hold, a 76-day collection lag is worth about 1.5 points of IRR.
- **Policy loans are excluded.** A loan is repaid out of the death benefit, so
  counting it as income would double it against the proceeds.
- **A lapse is a loss, not a blank.** No death benefit is assumed, so no rate is
  invented — but the capital lost is still reported.
- **A rate is never fabricated.** Cash that only ever went out has no IRR;
  the answer is "—", not zero.

### The two return reports

**Return — policies in force** and **Return — realized** are the printable form of
all this. Both carry headline tiles, an IRR-by-policy chart, owner-entity
subtotals, the full ranking, and a methodology note stating exactly what was
assumed.

Three things they do deliberately:

- **Rates are capital-weighted, never averaged.** An entity's IRR is solved from
  the combined flows of its policies. The simple mean of the individual rates is
  printed beside it, because the gap between the two is itself information — on
  the sample book the mean reads 29.6% against a weighted 17.6%, which is what a
  few small positions with outsized rates do to an average.
- **Nothing is silently dropped.** A "Not in this report" table names every
  policy the basis excludes, with its status and capital, so the ranking is never
  mistaken for the whole book.
- **Assumptions are marked on the figure, not buried.** An unpaid claim shows the
  death benefit with a `*` and is counted as collected today; the tile splits
  cash received from cash assumed.

The IRR-by-policy chart is anchored at zero, so a losing position runs left of
the line in the status colour with a signed label — direction, colour and number
all carry the sign, never colour alone.

### Where else it appears

- **Dashboard** — portfolio IRR if every remaining policy matured today.
- **Maturities** — an IRR column, and one rate across every matured policy's
  combined flows. That is a true portfolio IRR, not an average of the rows: a
  $5m position counts for more than a $50k one.
- **Investor logins** — the same rates. Scaling every flow by a percentage
  leaves the rate unchanged, so an investor's IRR on a policy equals the
  sponsor's; only the dollars beside it are theirs.

Rates that need reading with care are marked with a **\***: an unpaid claim
assumed collected today, a holding period under 90 days (annualising a few weeks
produces a headline nobody should quote), or cash flows that change direction
more than once, where more than one rate can satisfy the equation.

**Deleting a policy** is admin-only and requires typing the policy number to confirm.
It cascades to the policy's value snapshots, ledger entries and additional-insured
links, so the audit entry written beforehand captures the policy number, carrier,
insured, face amount, capital invested and the number of rows destroyed — the
activity log is the only record that survives. Setting the status to Sold, Matured
or Lapsed is the non-destructive alternative: it drops the policy out of the
dashboard, alerts and reports while keeping its history.

## Roles

| Role | Sees | Can change | Settings |
|---|---|---|---|
| **admin** | everything | everything, including other users | yes |
| **editor** | everything | everything except users and deletes | yes |
| **viewer** | everything | nothing | password only |
| **manager** | only their owning entities | everything inside them, including import, maturities and delete | **no** — password only |
| **investor** | only policies they hold a share of | nothing | password only |

### Portfolio managers

A manager is attached to one or more **owning entities** and works inside them as
though the rest of the book did not exist. They get the full internal interface —
dashboard, policies, servicing, insureds, investors, reports, CSV import — with
every query filtered to their entities.

They cannot reach the Settings surface at all: no owner-entity administration, no
user management, no activity log. They keep an **Account** tab for changing their
own password, since locking that out would leave them unable to rotate it.

The boundary is enforced in SQL and in route middleware, not by hiding buttons:

- Reads are filtered by `fund_id` on every list, detail, analytics and report query
- Per-policy writes go through a scope check on the policy's entity
- A manager cannot create a policy in another entity, nor move one of theirs out
- CSV import is checked row by row; a row whose Owner is outside their entities is
  rejected with that reason, and a policy that currently belongs to another entity
  cannot be overwritten
- The investor directory is filtered to investors holding positions in their
  entities, and investor login details are withheld

`scripts/manager-security-test.mjs` attempts each of these directly against the
API and asserts every cross-entity attempt fails.

Entity assignments are read from the database on each request rather than baked
into the session token, so changing a manager's entities takes effect immediately
instead of at their next sign-in.

## Managing accounts

Settings → Users lists every login with its role, its investor or entity
attachment, its status and its last sign-in. Each row offers **Edit**, **Suspend**
(or **Reactivate**) and **Delete**.

**Edit** changes the display name, the role, the status, and — for a manager —
the set of owner entities they may work inside. The entity picker opens
pre-selected with what they currently hold; whatever is highlighted when you save
becomes their complete access, so removing an entity is simply deselecting it. A
manager must keep at least one. Switching the role to *investor* swaps the picker
for the investor list. The dialog also carries an optional password field, for
resetting the password of someone who has lost theirs.

**Suspending** keeps the account and its history but closes it. **Deleting**
removes the login; their entries in the activity log survive, attributed to the
deleted account rather than erased.

Both take effect on the suspended user's *next request*, not at their next
sign-in. Role, status and entity access are re-read from the database on every
API call rather than trusted from the 12-hour session cookie, so an open browser
tab is cut off within a click — which is the behaviour you want the day someone
leaves. The same is true in reverse: promote someone and their existing session
gains the new permissions immediately.

Three things are refused outright: suspending your own account, demoting your own
account out of admin, and deleting your own account. Each would let the last
administrator lock everyone out, so they're rejected server-side and the controls
are absent from your own row. `scripts/user-admin-test.mjs` proves each of these
against the API, holding a cookie issued *before* the change to confirm the
immediacy.

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
users            login accounts (bcrypt; roles: admin / editor / viewer / manager / investor)
user_funds       which owning entities a portfolio manager may work inside
funds            owning entity: code, full legal name, notes (LCG2, LCG3, …)
insureds         person: DOB, gender, state, life expectancy, date of death
policies         carrier, policy #, product type (UL/SUL/VUL/IUL/GUL/Term/WL), face,
                 issue date, premium schedule, acquisition, maturity date and
                 proceeds received
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

IRR is computed in `public/irr.js` — one implementation, loaded by the browser
and imported by the server, so the two can never drift apart.

`policy_maturity_date(policy_id)` is the maturity rule as a SQL function, and
`apply_policy_maturity(policy_id)` applies it. Triggers on `insureds`,
`policy_insureds` and `policies` call it whenever a death date, a life or a
product type changes, and every startup reconciles the whole book — which also
backfills a database created before these columns existed.

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
| `SESSION_SECRET` | **yes in production** | 32+ random characters. Production will not start without it. Changing it signs everyone out. |
| `ADMIN_EMAIL` | first run | Seeds the first admin account |
| `ADMIN_PASSWORD` | **first run in production** | Minimum 10 characters. No default exists. |
| `ADMIN_NAME` | no | Display name |
| `NODE_ENV` | production | Secure cookies, HSTS, generic error responses |
| `PORT` | no | Defaults to 3000 |
| `PGSSLROOTCERT` / `PGSSLROOTCERT_PEM` | no | CA certificate for the database, as a path or inline |
| `PGSSLMODE` | no | `no-verify` accepts an unverifiable database certificate |
| `PGSSL` | no | `true` / `false` forces database TLS on or off |

Once the first admin exists, `ADMIN_*` is ignored — add further users in Settings.

In development, leaving `SESSION_SECRET` and `ADMIN_PASSWORD` unset is fine: the
app generates a per-process signing key and a random admin password, printing
the password once at startup.

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
| Return — policies in force | IRR on every live policy as if it matured today. Ranked best to worst, with an IRR-by-policy chart, owner-entity subtotals and the capital-weighted book rate. Landscape. |
| Return — realized | The same for matured policies, using the cheque that actually arrived on the day it cleared. Landscape. |

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
- Failed logins throttled in the database — 8 per account and 30 per IP address
  per 15 minutes — so the limit survives a restart and is shared across instances
- Every API route except health and login requires a session; writes require `admin`, `editor` or `manager`
- All SQL is parameterised — no string-built queries
- Content-Security-Policy blocks external scripts; the app loads no third-party assets
- Every create, update, delete, import and login is written to `audit_log`

### Sessions can actually be revoked

A signed cookie that carries a role is only as current as the last time somebody
checked. So on **every** request the app re-reads the account: role, active
status, entity access and a `token_version` counter.

- Suspending or deleting an account ends its open sessions on the next click
- A role change applies at once, in both directions
- Changing a password bumps `token_version`, which retires every cookie issued
  before it — including one already stolen. The browser that made the change is
  handed a fresh cookie, so that person is not signed out of their own session.
- An admin password reset does the same, which is the case that matters most:
  the reason for resetting is usually that someone else may hold the old one

`requireAuth` (verify the cookie) and `loadScope` (re-read the account) are
exported as a single `authenticate` pair precisely so no route can put a role
check between them and end up authorising against a stale token.

### No default secrets

There is no fallback signing key and no default admin password. In production
the app **refuses to start** if `SESSION_SECRET` is missing or shorter than 32
characters, and refuses to seed the first admin without `ADMIN_PASSWORD`. In
development it generates both, prints the admin password once, and warns that
sessions will not survive a restart.

### Database TLS

The database certificate is **verified**, not merely accepted. Encrypting a
connection without checking who is on the other end stops a passive eavesdropper
but not an active one. Provide the CA with `PGSSLROOTCERT` (path) or
`PGSSLROOTCERT_PEM` (inline).

`PGSSLMODE=no-verify` turns verification off and logs a warning every start. It
is the right setting for Render's internal database endpoint — a private-network
hop whose certificate comes from a CA the public trust store cannot see — and
wrong for anything crossing the open internet.

### Untrusted data

Policy data arrives by CSV from other people's systems, so it is treated as
hostile everywhere it is rendered:

- Chart tooltips escape every interpolated value. A carrier named
  `<img onerror=…>` draws as text.
- CSV export prefixes any cell starting `=`, `+`, `-`, `@`, tab or carriage
  return with `'`, so a crafted carrier name cannot become a live formula when
  the export is opened in Excel or Sheets
- Route parameters must be integers before any query runs, so a malformed id
  returns "Not found" rather than a Postgres message naming the column type
- Uploads are capped at 5 MB and 25,000 rows, restricted to admin/editor/manager,
  and limited to one at a time per account — parsing is synchronous, and a 512 MB
  instance should not be knocked over by somebody holding down Upload

### Error responses

In production a server fault returns `Something went wrong. Quote reference
<id>.` and nothing else; the full error, with the request that caused it, goes
to the server log under that reference. Outside production the detail comes
back, because that is where somebody is trying to fix it.

**Operational responsibilities that are yours, not the app's:** run it over HTTPS,
keep `SESSION_SECRET` and `DATABASE_URL` out of version control, enable automatic
database backups at your host, remove users promptly when access should end, and
run `npm audit` in your build environment.

---

## Testing

No password that works anywhere is stored in this repository. The suites read
their accounts from the environment; `scripts/seed-test-accounts.mjs` creates
those accounts on a throwaway database with freshly generated passwords and
writes them to a git-ignored `.env.test`:

```bash
createdb policyhub_test
DATABASE_URL=postgres://…/policyhub_test node scripts/seed-test-accounts.mjs
DATABASE_URL=postgres://…/policyhub_test npm start &
node scripts/e2e.mjs
```

The seeder refuses to run against `NODE_ENV=production` or a `DATABASE_URL` that
looks hosted. Every suite is idempotent and asserts relationships rather than
fixed counts, so they can be re-run against a database other suites have
changed.

`e2e.mjs` drives a real browser through login, the grid, sorting, search, policy
detail tabs, snapshot and transaction creation, CSV import, dark mode, mobile
layout, and unauthenticated-access checks.

The rest of `scripts/` splits into two kinds. The `*-security-test.mjs` files talk
to the API directly with `fetch`, deliberately bypassing the interface, and assert
that every forbidden request fails — that's where the authorisation rules are
actually proven. The `*-ui-test.mjs` files drive a browser and assert the screens
reach those rules correctly.

| Script | Covers |
|---|---|
| `e2e.mjs` | the main interface end to end |
| `entity-test.mjs` | owner entities: create, rename, reassign, delete guard |
| `delete-test.mjs` | policy deletion, cascade, confirmation and audit entry |
| `reports-test.mjs` | all four reports, both cost-basis modes, print layout |
| `investor-security-test.mjs` | investor scoping — cross-investor reads and every write |
| `investor-ui-test.mjs` | the investor portal, share toggle and hidden navigation |
| `manager-security-test.mjs` | manager scoping — cross-entity reads, writes, import, Settings |
| `manager-ui-test.mjs` | the manager interface and its missing Settings tab |
| `user-admin-test.mjs` | suspend, reactivate, delete, entity editing, password reset, self-guards |
| `user-admin-ui-test.mjs` | the Users card and the edit dialog |
| `maturity-test.mjs` | the survivorship rule, auto-transition both ways, removal from every active view, proceeds, scoping |
| `maturity-ui-test.mjs` | recording a death through the interface and the register it produces |
| `irr-test.mjs` | the solver against Excel's documented example and an independently written secant solver, then the API |
| `irr-ui-test.mjs` | the calculator, and that the browser and server produce the identical rate |
| `hardening-test.mjs` | session revocation, middleware ordering, import limits, CSV escaping, error opacity, throttling, headers |

Each is idempotent — they clean up after themselves and can be re-run against the
same database.
