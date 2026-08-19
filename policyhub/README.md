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
| **Import** | Drop in any number of CSV files and Excel workbooks at once. Every sheet is read, every row is classified, and the whole dump — policies, insureds, additional lives, value history and the full ledger — loads in one pass. Column names are matched automatically; nothing is written until you have seen the preview. Three single-purpose importers remain for piecemeal updates. |
| **Reports** | Six print-ready documents with a per-report cost-basis toggle: **portfolio summary**, **policy schedule** (landscape), **premium forecast**, **policy fact sheets** (one page each), and two return reports — **in force** and **realized**. |
| **Opportunities** | Policies being offered rather than owned. Managers and above post the terms, the premium schedule and the LE, choose which investors see each one, and confirm the requests that come back. Investors see what is left, what the return looks like at life expectancy and two years either side, and can ask for a percentage. |
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

### The realized rate at the top of the register

The headline IRR is **what the book has actually returned**: only claims the
carrier has paid, each inflow dated the day the money arrived. It is the same
calculation every paid row below it shows, done once over all of them together
— one rate solved on the combined dated flows, not an average of the per-policy
rates, which would weight a $50k position the same as a $5m one.

Outstanding claims are deliberately **not** folded in at today's date. A claim
that has not been paid has had no time to run, so treating it as collected today
flatters the rate — on a book with 2 of 23 claims paid the two figures came out
at 23.0% and 13.2%. That projection is still worth having, so it sits under the
headline, named for what it is: *"13.21% with the other 21 assumed collected
today"*. With every claim paid the two are identical, because there is nothing
left to assume, and the note says so.

Until anything has been paid the tile reads *IRR if collected today* rather than
*Realized IRR*, because there is no realized rate to report.

`scripts/realized-irr-test.mjs` checks the rate against an independently written
XIRR solver — a check that used the application's own solver would only prove it
was consistent with itself — and that recording, then clearing, a cheque moves
the figure both ways.

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

## The managing partner's ten per cent

Carried interest, on every case. The investor's capital comes back first —
every dollar of acquisition cost, premium, fee, servicing and commission — and
what is left over is split **90/10** between the investor and the managing
partner. `CARRY_PCT` in `public/irr.js` is the whole configuration.

**Investors are shown their figures net; staff see the book gross.** Nothing in
the portal names the deduction, annotates a figure with it, or labels a column
"before fees" — an investor knows the terms from the operating agreement, and a
screen that keeps pointing at them is not stating a position, it is arguing a
case. `scripts/carry-test.mjs` scans every investor-facing payload for the words
and asserts they are absent.

Three properties, each of them a way of getting it wrong:

- **It comes off the profit, never the basis.** An investor who put in $320,000
  and whose share of the claim is $500,000 pays carry on $180,000, not on
  $500,000, and is shown $482,000.
- **A case that lost money pays nothing.** Ten per cent of a negative profit
  would hand the investor *more* than they lost, which is not a fee arrangement.
  A losing case reads identically to them and to us.
- **It is per case.** A loss on one policy does not shelter the gain on another,
  so a policy's own figures never move because something else in the book
  matured.

### Where it is applied

Two chokepoints, which is what keeps a dozen screens consistent:

- `flowsAfterCarry()` in `public/irr.js` takes the whole deduction off the final
  inflow of a policy's cash flows. Every IRR, profit and multiple in the
  application is solved from those flows, so the rate an investor is quoted is
  the rate on the money they receive. It comes off the last inflow rather than
  being spread, because that is the payment it is actually withheld from —
  moving it earlier would change the dates the rate is solved over.
- `afterCarry()` in `src/api.js` is the same arithmetic in SQL, for the figures
  that are summed in the database rather than solved from flows: a death benefit
  and a claim paid, on the policies grid, the policy page, the Portfolio totals,
  the Maturities register and the statements.

Carry is linear in the size of a holding, so it makes no difference whether the
share weighting happens before or after. That is what lets the same rule be
applied in SQL on whole-policy columns in one place and in JavaScript on an
investor's own flows in another, and still agree to the cent — which
`carry-test.mjs` checks by comparing the two against arithmetic worked out by
hand, and the rate against an independently written XIRR solver.

**Nothing they pay in is touched.** Capital invested, premiums due and the
servicing calendar are the same numbers for everybody. Carry never reduces a
bill.

**Opportunities are quoted the way they will pay.** The scenario table an
investor weighs up before committing is net, so the deal they agree to is the
deal they get.

---

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

- **The inflow lands on the day the claim was funded**, not the date of death.
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

## Deleting policies, a lot at once

Imports are why this exists. A file loaded with the wrong owner column, or
twice, leaves rows that have to come out, and doing that one at a time — typing
each policy number into a confirmation box — is how somebody gives up half way
and leaves the book worse than either extreme.

It is the most destructive thing in the application, so:

- **Administrators only.** A portfolio manager can delete a policy in their own
  entity one at a time from its own page; nobody clears a shelf but an admin.
  Managers are not shown the tick boxes at all, and the API refuses them.
- **All or nothing**, inside one transaction. If any policy in the batch has
  already been deleted by somebody else the whole thing is refused and nothing
  is removed — a bulk delete that half worked is worse than one that did not run.
- **The confirmation carries the count** — `DELETE 12` — so a phrase typed for
  one selection cannot authorise a different one.
- **What goes with them is counted and shown first**: ledger entries, value
  snapshots, investor allocations and the documents filed against those
  policies. The last two are the ones nobody expects, and documents do not come
  back.
- **One audit entry per policy**, in the same shape a single deletion writes, each
  marked as part of a batch.

The selection lives on the Policies grid and survives searching, filtering and
sorting — pick three from one carrier, search for another, pick two more. When
some of what you have picked is no longer on screen the bar says so, because a
count of five above three rows is alarming otherwise. **Select all** means all of
what you are looking at, not the whole book.

Capped at 500 per call, which keeps one transaction bounded.

`scripts/bulk-delete-test.mjs` and `scripts/bulk-delete-ui-test.mjs` cover who
may do it, what it refuses to be asked, the all-or-nothing rule, and that a
selection survives a search.

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
- The investor directory is filtered to the investors assigned to their entities,
  the investors holding positions in their entities, and any granted to them by
  name; investor login details are withheld. Somebody visible for a relationship
  rather than a holding reads as zero positions — sight of the person is not
  sight of their book

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

## Opportunities

A place to introduce a policy to investors before anybody owns it.

An opportunity is **its own record, not a policy**. A deal that may never
close must not reach the dashboard, the IRR reports or the maturities
register, and keeping it separate means no query has to remember to exclude
it. When it funds, one click creates the policy, records the purchase price in
the ledger and writes the cap table from the confirmed allocations — nothing
is re-keyed.

### What an investor sees

Only what has been shared with them. An opportunity that is not on their list
returns "not found", not "forbidden" — the second answer would confirm it
exists. The **Opportunities** tab in their menu carries a count of offers they
have not yet answered, which is the first thing they will notice on signing in.

Each offer shows the policy terms, the asking price as a percentage of face,
the posted premium schedule with their own share of each payment, and:

**Return if the insured lives to…** — three columns. Two years early, at life
expectancy, and two years late. Life expectancy is a median, not a promise:
around half of insureds outlive it, and every extra month is another premium
paid and another month of waiting. The late column is the one worth
underwriting against, so it is given equal weight rather than hidden in a
footnote. The estimate runs from the **date of the LE report**, not from today
— an estimate written two years ago has already spent two years of itself.

Premiums beyond the end of the posted schedule are continued at the same
annual rate rather than assumed to stop, and the analysis says so.

### Scarcity that is real

Each card shows what is left, what is taken, and a bar that fills as the
offer goes. Under 25% remaining, or a deadline inside a week, the card is
marked urgent and the bar changes colour. None of it is decoration: every
figure is the live number.

**A request holds its percentage immediately.** The moment one investor asks
for 65%, every other investor sees 35% available. That is what makes the
scarcity honest rather than theatrical. It becomes an allocation only when a
manager confirms it; declining releases it straight back.

**Nobody learns who else is in.** An investor sees the total taken and nothing
more — no names, no count, consistent with the rule that a co-owner is never
visible on a shared policy. `scripts/opportunity-test.mjs` asserts that no
other investor's name appears anywhere in the payload.

**Two people cannot take the same slice.** A request is written inside a
transaction that locks the opportunity row, so two investors clicking at the
same instant cannot between them take 130% of a policy. The suite fires two
simultaneous 60% requests at the same offer and asserts exactly one succeeds.

An investor changing a request they already hold is not blocked by their own
percentage — someone holding 82% can reduce it to 40%, and the difference is
released to everybody else.

### The minimum share

**Ten per cent is the smallest slice an investor may take.** A life settlement
is a long, hands-on position — years of premium calls, servicing and paperwork
against one policy — and a cap table of twenty two-per-cent holders costs more
to administer than the small tickets are worth. The figure lives in one place,
`MIN_COMMITMENT_PCT` in `src/api.js`.

**The last slice is the exception.** If fewer than ten points are left, the
floor drops to exactly what remains, and that remainder has to be taken whole.
A floor that could leave a deal permanently six per cent short would be a worse
rule than no floor at all. So the effective minimum is `min(10, what is left)`,
and it is sent to the browser as `min_commitment_pct` on every opportunity
rather than written into the page — the portal can never state a floor the API
would then refuse.

On screen the input carries the range as its `min` and its placeholder, the
hint underneath reads *Minimum 10%, up to 100%* — or *Only 6% is left, and the
last slice is taken whole* — and typing less disables the request button and
says why, without a round trip. The figures still restate at whatever is typed,
because somebody entering 4 to see what 4 would cost should see it.

The floor binds investors, not staff. A manager confirming a request is making
a commercial decision and is not held to it.

`scripts/minimum-take-test.mjs` and `scripts/minimum-take-ui-test.mjs` cover
the floor, the last-slice exception, a fractional remainder, reducing an
existing request, and what a declined request releases.

### Who can do what

| | Post & edit | Choose who sees it | Confirm requests | Fund it | Take a share |
|---|---|---|---|---|---|
| admin | yes | yes | yes | yes | no |
| editor | yes | yes | yes | no | no |
| manager | yes, inside their entities | yes | yes | yes | no |
| viewer | no | no | no | no | no |
| investor | no | no | no | no | yes |

A manager sees only opportunities belonging to their own owner entities and
cannot create one anywhere else — the same boundary that governs policies.

## Fractional ownership and the investor portal

An owning **entity** (LCG1, LCG2) holds a policy on paper. **Investors** hold
economic percentages of it. Both are recorded: a policy's Overview tab carries an
ownership cap table showing each investor's share, the dollar value of that share,
and any unallocated remainder. Allocations are refused if they would push a policy
past 100%.

### The tax number is not asked for at sign-up

A K-1 cannot be issued without a Social Security number or an EIN, but an
account can be opened without one — and a stranger's first minute on the site,
typing into a form belonging to a firm they have no reason to trust yet, is the
worst possible moment to ask. So the registration form does not.

It arrives afterwards, from either side:

- **The investor**, on their own Account page, over a session that has already
  been authenticated. `PUT /me/tax-id` fills a blank and does not replace one:
  once a number is on file, changing it goes through the office. An investor
  account is the one most likely to be phished, and a quietly altered tax number
  sends somebody else's K-1 to the wrong place. The panel says so, and points at
  the telephone.
- **An administrator**, in the Edit investor dialog, which can both set and
  replace it.

Neither route reads it back to an investor. `GET /investors/:id/tax-id` stays
administrators only and stays audited; the Account page shows the last four
digits and nothing more, because an investor knows their own number and reading
it back answers nothing.

A number sent to `POST /register` anyway is still accepted and encrypted
properly — silently discarding one somebody deliberately supplied would be worse
than storing it — it is simply never required.

### Whose client they are

Each investor can be assigned to an owner entity, which is the relationship
rather than the money: it says which desk looks after them. **Only an
administrator can set it** — the Edit dialog shows a manager the entity as a
fact with a note saying who decides it, and a manager who submits a `fund_id`
anyway has it silently dropped while the rest of their edit goes through.

An assignment can be made at the moment a registration is approved, so a new
investor appears on the right manager's list before they hold anything at all.
The Investors page counts how many are still unassigned and filters by entity
from the same picker used on the Dashboard.

Everything the investor typed into the registration form — name, legal name,
email, telephone, the full mailing address and the tax number — is editable
afterwards by an administrator. The tax number never comes back to the browser
in the ordinary course of things; the dialog shows only the last four digits
with a *Show the number in full* link, and using it is written to the audit log.
Managers can correct the contact details but cannot read or replace the tax
number. `scripts/investor-entity-test.mjs` and `scripts/investor-entity-ui-test.mjs`
cover all of this.

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
opportunities    a policy being offered: terms, LE, asking price, deadline
opportunity_premiums   the premium schedule as offered
opportunity_shares     which investors may see an opportunity
opportunity_commitments  who asked for what percentage, and whether it was confirmed
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

### One upload for everything

**Everything — full data dump** is the default. Drop in as many files as you
like, CSV or Excel, and the whole lot is read together.

**Excel workbooks are read tab by tab.** Every visible sheet becomes part of the
import; hidden working tabs are left alone. Dates come through as dates — Excel
stores them as serial numbers with a format attached, and both the 1900 and 1904
epochs are handled — so a premium dated 4/9/2020 lands as 2020-04-09 rather than
as 43930. A title line above the header is skipped rather than mistaken for the
header.

**A premium tab named after its policy is understood.** The common shape — one
tab per policy, holding nothing but a Date column and a Premium column, with the
policy number only in the tab's name — is recognised: the policy number is taken
from the sheet name, the rows are read as premium payments, and a trailing Total
row is treated as the footer it is. The preview says so in as many words:
*"read as premium history for policy WB-1001, 1 total row ignored"*.

There is no Excel library behind this. A workbook is a ZIP of XML, and the
reader in `src/xlsx.js` is about two hundred lines of Node's own `zlib` — which
keeps the dependency tree, and `npm audit`, exactly where the security review
left them.

Within a file, each row carries a **Record Type** saying what it is:

| Record Type | What the row does |
|---|---|
| `Policy` | Creates or updates a policy, its primary insured, and — from any AV/CSV/COI columns — a value snapshot. An acquisition cost seeds the ledger. |
| `Insured` | Updates a person: life expectancy, gender, state, smoker, date of death. |
| `Life` | Attaches an additional life to a policy — survivorship, joint, secondary. |
| `Value` | A dated carrier snapshot against an existing policy. |
| `Transaction` | A dated ledger entry — premium, fee, withdrawal, commission. |

Columns are the union of all five; a row leaves blank whatever it doesn't need.

**Order does not matter, and neither does which file a row is in.** Everything
uploaded is pooled and sorted into dependency order before anything is written —
policies first (which create their insureds), then person detail, then additional
lives, then values, then the ledger. A transaction can sit at the top of one file
and the policy it belongs to in another, and both still land.

**The Record Type column is optional.** Without it each row is classified by its
shape: a dated amount with a type is a transaction, an as-of date with values is
a snapshot, a carrier and a face amount is a policy. Inference only fires on
unambiguous evidence — anything doubtful is refused by line number with a message
saying to add the column, because guessing wrong on a book of record is worse
than asking.

**Nothing is written until you've seen the classification.** The preview lists
every file and sheet found with its row count, reports how many rows were read as
each type, says whether that came from your column or from the shape of the rows,
and names anything it could not classify. Every message carries the file, the tab
and the line — "line 12" on its own would be useless once several files are in
play.

**Re-running the same file is safe.** A ledger row identical to one already on
file — same policy, date, type and amount — is skipped and counted, so a second
upload cannot double your capital invested and halve every IRR computed from it.
Policies and snapshots update in place rather than duplicating. If a policy
genuinely took two identical payments on the same day, tick **Allow duplicate
ledger rows**.

`scripts/master-import-test.mjs` covers all of this against
`demo/sample-workbook.xlsx` — a workbook with a title row, a hidden tab, two
per-policy premium tabs with Total footers, plus loose CSVs alongside it:
classification, dependency ordering across files, inference, refusals,
file-and-tab-accurate errors, re-run safety, and that a portfolio manager
importing a policy for another entity is still rejected.

Limits: 20 files an upload, 5 MB each, 25,000 rows in total.

### Column matching

Column headers are matched case- and punctuation-insensitively, so your existing
export headers work as-is: `Policy #`, `Primary Insured`, `Basic Face`, `Premium
Required`, `AV`, `CSV`, `COI`, `Date Of Last Withdrawal`, `Values As Of`, and so on.
Unrecognised columns are listed in the preview and skipped.

**Policies import** doubles as the monthly value update: if the file carries AV / CSV /
COI columns, a value snapshot is written for the "as of" date alongside the policy
record. Re-importing the same file updates policies in place rather than duplicating
them — matching is on policy number + carrier.

Templates are downloadable from the Import screen, or from
`/api/import/template/{master|policies|values|transactions}`. The master template
is a working file — it contains one example of every record type and imports
cleanly as-is.

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
| `master-import-test.mjs` | one-file import: classification, dependency ordering, inference, refusals, re-run safety, scoping |
| `opportunity-test.mjs` | sharing, privacy between investors, the race for the last slice, decisions, deadlines, LE scenarios, funding |
| `opportunity-ui-test.mjs` | the menu badge, the scarcity bar, the scenario table, and taking a share |
| `irr-test.mjs` | the solver against Excel's documented example and an independently written secant solver, then the API |
| `irr-ui-test.mjs` | the calculator, and that the browser and server produce the identical rate |
| `hardening-test.mjs` | session revocation, middleware ordering, import limits, CSV escaping, error opacity, throttling, headers |
| `carry-test.mjs` | the ten per cent: arithmetic by hand, no carry on a loss, no netting between cases, and that nothing in the portal names it |
| `premium-dues-test.mjs` | that the Portfolio card and the Premiums page show the same dates and the same money |
| `bulk-delete-test.mjs` | who may clear a shelf, what it refuses, and that a refused batch removes nothing |
| `bulk-delete-ui-test.mjs` | the tick column, a selection surviving a search, and what the dialog says first |
| `realized-irr-test.mjs` | the realized rate over paid claims only, against an independent XIRR solver |
| `minimum-take-test.mjs` | the ten per cent floor, the last slice taken whole, and who it binds |
| `minimum-take-ui-test.mjs` | the range on the input, the reason shown before clicking, and the wording when under ten is left |
| `register-test.mjs` | self-registration: what the form refuses, that it never says whether an address is already a client, tax-number encryption, approving and declining |
| `register-ui-test.mjs` | one person from the Register link to their first sign-in, and the approval queue on the Investors page |
| `investor-entity-test.mjs` | assigning an investor to an entity, who may set it, and that it grants sight of the person and not of their book |
| `investor-entity-ui-test.mjs` | the investor record on screen: every registration field editable, the entity picker, the tax-number reveal, and what a manager is shown instead |
| `investor-report-test.mjs` | the investor's own statements, scoped and weighted |
| `entity-view-test.mjs` | filtering the Dashboard, Insureds, Servicing and Maturities by entity, and the arithmetic that follows |
| `agreement-test.mjs` | drafting an operating agreement, issuing it, signing it in the portal, and the hash that freezes the text |
| `documents-test.mjs` | uploading, scoping, downloading and deleting documents |
| `documents-ui-test.mjs` | the Documents tab, its filters and the download it produces |
| `entry-ui-test.mjs` | the entry forms: the state list, comma grouping while typing, and the carrier-value fields |
| `privacy-test.mjs` | that an investor is shown initials rather than an insured's name, everywhere |
| `schedule-test.mjs` / `schedule-ui-test.mjs` | premium schedules and what they put on screen |
| `sample-import-test.mjs` | the ten-policy sample workbook, loaded in one upload |
| `readability-test.mjs` | contrast and legibility across the interface, light and dark |

Each is idempotent — they clean up after themselves and can be re-run against the
same database.
