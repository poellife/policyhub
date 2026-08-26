# Extracting a case from a carrier illustration

A carrier illustration (in-force or new-business) is the source document for
the policy side of the valuation. This guide maps its contents onto the case
schema in `scripts/engine/case.py`. Extract carefully — a wrong column or
basis here is the number-one source of bad valuations.

## 1. Header / narrative pages

| Case field | Where to find it |
|---|---|
| `name` | Build as "<Carrier short> <PolicyNo> $<Face>M <Insured last name>" |
| `gender`, `smoker` | Insured details block ("Male, Preferred Non-Tobacco" -> `Male`, `Non-Smoker`) |
| `dob` | Insured details; if only an age is given, see "Missing DOB" below |
| `face` | Face / specified amount |
| `policy_date` | Policy date / issue date — this anchors the monthiversary grid and policy years |
| `id_date` | The illustration's "as of" / preparation date |
| `vd` | Valuation date — normally today or the user's chosen pricing date (ask if unclear) |
| `maturity_age` | Maturity / coverage-to age (usually 120 or 121) |
| `illustration_mode` | Premium mode of the illustrated outlay: Annual / Semi-Annual / Quarterly / Monthly |
| `av_at_id` | Current account value for an in-force illustration (0 for new business) |

## 2. The ledger (annual values table)

Find the year-by-year table with premium outlay, death benefit, account
value, and cash surrender value. Critical rules:

- **Use the CURRENT (non-guaranteed illustrated) basis columns**, not the
  guaranteed and not a midpoint. The COI backsolve runs at the current
  crediting rate (NGCR) and must see the AV illustrated on that same basis.
- One `ledger` entry per policy year: `prem` (annual outlay), `ndb` (net
  death benefit), `av` (year-END account value), `csv` (year-END cash
  surrender value).
- In-force illustrations start at the current policy year — keep the
  illustration's own policy-year numbering (e.g. first row = policy year 7).
- Ledger rows after the policy lapses on the illustrated basis (AV = 0)
  carry no information; stop there.
- If CSV is floored at 0 in early years while AV > 0, that is normal
  (surrender charge exceeds AV) — record the 0; the engine back-extrapolates
  the surrender-charge schedule from the first CSV-positive years.

## 3. Crediting rates and charges

| Ledger field | Where to find it |
|---|---|
| `gcr` | Guaranteed minimum crediting / interest rate (policy guarantees page) |
| `ngcr` | Current / illustrated crediting rate (assumptions page; the rate the current-basis ledger was run at) |
| `popc` | Premium load / percent-of-premium expense charge (as a fraction, 0.06 for 6%) |
| `ppc` | Per-policy charge in $ per MONTH (an annual figure / 12) |
| `puc` | Per-unit charge in $ per $1,000 of face per MONTH |
| `popcat`, `popcat_t` | Premium load above the target premium (percent) and the target premium ($/policy year), when the product has one |

Charges often vary by policy year (e.g. a per-unit charge that grades off
after year 10) — capture them per year when the illustration shows a
schedule; otherwise repeat the same values on every ledger row.

**When the charge pages are missing** (common in summary-only
illustrations): set `popc`, `ppc`, `puc` to 0 and tell the user. The COI
backsolve then absorbs all expenses into the COI rates, which keeps the
ledger reproduction exact; the main side effect is that optimized premiums
lose the premium-load gross-up (understated by roughly the premium load,
typically 4-8% of premium). Offer to refine if the user can provide the
product's charge structure.

## 4. Missing DOB

If the illustration gives only an issue age or current age, anchor a
synthetic DOB to the policy anniversary: birthday = policy date's
month/day, year chosen so the age-last-birthday at the valuation date is
right. Note: illustration ages are often age-nearest-birthday — the
reference model treated an ANB age as ALB age minus one (a 75 ANB insured
was run at ALB issue age 74). State the assumption in the output.

## 5. What is NOT in the illustration

These come from the user (ask, or apply the stated defaults):

- Health: Mean LE50 (months) from the LE report, or a mortality multiplier.
- Target IRR (default 15%) or purchase price.
- Projection crediting rate (default NGCR).
- Funding plan overrides / custom premium schedule (default rule in SKILL.md).
- Any manually-adjusted COI years (only relevant when reproducing an
  existing InsuriShield file; `extract_case` picks those up automatically).

## 6. Quick schema example

```json
{
 "name": "MOO BU4995838 $5M Rossi",
 "face": 5000000.0, "gender": "Female", "smoker": "Non-Smoker",
 "dob": "1957-01-07", "policy_date": "2024-12-06",
 "id_date": "2024-12-06", "vd": "2026-05-06",
 "maturity_age": 120, "illustration_mode": "Quarterly", "av_at_id": 0.0,
 "ledger": {"1": {"prem": 99750, "ndb": 5000000, "av": 67430, "csv": 0,
                   "gcr": 0.02, "ngcr": 0.0553, "popc": 0.04, "ppc": 5,
                   "puc": 0.3726, "popcat": 7.5, "popcat_t": 232835}},
 "projection_crediting": 0.035,
 "funding": {"1": "Optimize"},
 "health_type": "Mean LE50", "health_value": 90.0,
 "valuation_type": "IRR", "valuation_value": 15.0
}
```

See `references/example_case_rossi.json` for a full multi-year case.

## 7. NLG policies: extract the Lapse Protection rider (`nlg` block)

If the illustration is guaranteed-basis with all-zero account values (a
no-lapse-guarantee policy kept in force by its NLG rider) AND a policy
contract is among the uploaded documents, find the rider titled "Rider to
Provide Lapse Protection" / "No-Lapse Guarantee" and its RIDER DATA pages,
and add a top-level `nlg` object to the case JSON. The valuation engine uses
it to compute the TRUE minimum premiums (the smallest premiums that keep the
no-lapse shadow fund above zero), which are materially different from the
illustration's level premium schedule.

```json
"nlg": {
  "contract_date": "2008-06-10",
  "issue_age": 75,
  "premium_load": 0.0375,
  "monthly_charge": 10.0,
  "interest": [[20, 0.055], [9999, 0.0585]],
  "coi_per_1000": {"75": 1.31314, "76": 1.42468, "...": 0},
  "fund_at_vd": 0.0
}
```

- `contract_date`: the CONTRACT DATE from the contract data pages (as changed
  by any endorsement) — this drives the monthly dates and attained ages. Also
  set the case's `policy_date` to this date when a contract is present.
- `issue_age`: the insured's issue age printed on the contract data pages.
- `premium_load`: the no-lapse ADMINISTRATIVE charge percent of premium ONLY
  (e.g. "subtract a no-lapse administrative charge of 3.75% of the premium
  paid" -> 0.0375). Do NOT add the no-lapse charge for sales expenses: its
  base is the original segment allocation amount and carrier minimum-premium
  schedules confirm it is not levied on minimum-premium funding. Mention the
  sales-expense rate in _extraction_notes instead.
- `monthly_charge`: the CURRENTLY applicable monthly no-lapse charge in
  dollars (per-$1,000 component x face/1000 + flat component, using the last
  step of the change schedule). E.g. "$0.00 per $1,000 plus $10.00" -> 10.0.
- `interest`: no-lapse interest rates as [through_contract_year, annual_rate]
  pairs, e.g. 5.5% during the first 20 contract years then 5.85% ->
  [[20, 0.055], [9999, 0.0585]].
- `coi_per_1000`: the FULL "Table of No-Lapse Monthly Insurance Rates per
  $1,000 of No-Lapse Net Amount at Risk" keyed by attained age. Transcribe
  every age exactly.
- `fund_at_vd`: current no-lapse guarantee value if a document states it;
  otherwise 0 (the conservative in-force boundary).

If no contract is uploaded (or it has no such rider), omit `nlg` — the engine
then prices the illustration's own premium schedule and says so.

### 7b. Rider extraction when account values are real (v4.20)

The Lapse Protection rider block (section 7) must be extracted from the policy
contract WHENEVER the rider exists - not only for guaranteed-basis zero-AV
illustrations. Policies like Pru Founders Plus carry real account values AND an
overfunded rider; the app prices both funding paths and keeps the better one.
Optional nlg fields: sales_load {rate, cap} (sales-expense charge on the first
`cap` dollars of cumulative premium), monthly_per_1000 + per_1000_until (a
per-1000-of-face monthly admin component that later drops to zero). Premium /
transaction history documents get role 'premium_history' and feed
'_premium_history' / '_premiums_summary', from which the app reconstructs the
rider fund at the valuation date.
