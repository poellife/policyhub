"""No-lapse-guarantee (NLG) shadow-account minimum premiums.

For NLG policies (guaranteed-basis illustrations with zero account values) the
true minimum funding is NOT the illustration's level premium: it is the
smallest premium stream that keeps the policy contract's *no-lapse guarantee
value* (a shadow fund defined in the Lapse Protection rider) above zero on
every monthly date.

The rider data pages give everything needed to compute it:
- the no-lapse premium load (percent of each premium)
- a monthly administrative charge
- a table of no-lapse monthly insurance rates per $1,000 of no-lapse net
  amount at risk, by attained age (issue age + completed contract years)
- the no-lapse interest rate(s) credited daily to the shadow fund

Convention (calibrated against a carrier-sourced minimum-premium schedule for
Pru UL Protector; reproduces it to ~0.05% rms across 28 policy years):
- minimum premiums are solved MONTHLY (level within each policy year), on the
  contract monthly dates, whatever the buyer's payment frequency; quarterly /
  annual buyers pay each modal block's monthly minimums grouped at the block's
  first monthly date
- the net amount at risk is measured against the fund BEFORE that month's
  premium (NAAR = NDB - fund_begin)
- each policy year ends holding a buffer of one month's deduction at the
  CURRENT year's rate (the "1 Month of COI" convention); no buffer after the
  final year
- interest accrues daily between monthly dates

Mechanics per monthly date (on the contract-date day of each month):
    fund += premium_paid * (1 - premium_load)          [when a payment is due]
    fund -= monthly_charge + rate(age)/1000 * (NDB - fund_begin)
    fund *= (1 + daily)^days_to_next_monthly_date
"""
import datetime as dt
from .mortality import add_months

PAY_BLOCKS = {'Monthly': 1, 'Quarterly': 3, 'Semi-Annual': 6, 'Annual': 12}


def _norm(nlg):
    """Coerce a JSON-loaded nlg block into working types."""
    cd = nlg['contract_date']
    if isinstance(cd, str):
        cd = dt.datetime.strptime(cd, '%Y-%m-%d').date()
    elif isinstance(cd, dt.datetime):
        cd = cd.date()
    rates = {int(k): float(v) for k, v in nlg['coi_per_1000'].items()}
    interest = [(int(t), float(r)) for t, r in (nlg.get('interest') or [[9999, 0.0]])]
    return dict(
        contract_date=cd,
        issue_age=int(nlg['issue_age']),
        premium_load=float(nlg.get('premium_load') or 0.0),
        monthly_charge=float(nlg.get('monthly_charge') or 0.0),
        interest=sorted(interest),
        rates=rates,
        fund_at_vd=float(nlg.get('fund_at_vd') or 0.0),
        ndb=float(nlg['ndb']) if nlg.get('ndb') else None,
    )


def _daily(interest, contract_year):
    for through, rate in interest:
        if contract_year <= through:
            return (1.0 + rate)**(1.0/365.0) - 1.0
    return (1.0 + interest[-1][1])**(1.0/365.0) - 1.0


def _rate(rates, age):
    if age in rates: return rates[age]
    return rates[max(rates)] if age > max(rates) else rates[min(rates)]


def nlg_min_premiums(nlg_raw, face, vd, frequency='Quarterly', maturity_age=121,
                     buffer_months=1.0):
    """Minimum premiums keeping the no-lapse fund in force from the valuation
    date to attained age `maturity_age`.

    Returns (schedule, annual) where schedule is {payment_date: amount} at the
    requested buyer frequency and annual is {policy_year: total_premium}."""
    p = _norm(nlg_raw)
    cd, ia = p['contract_date'], p['issue_age']
    ndb = p['ndb'] or face
    load, madm = p['premium_load'], p['monthly_charge']

    def deduction(age, fund):
        return madm + _rate(p['rates'], age)/1000.0*(ndb - fund)

    def sim_year(F0, months, age, cy, P):
        """Level monthly premium P on every monthly date of the year."""
        F, ok = F0, True
        d_rate = _daily(p['interest'], cy)
        for i, d in enumerate(months):
            F_begin = F
            F += P*(1.0 - load)
            F -= deduction(age, F_begin)          # NAAR on the pre-premium fund
            if F < -1e-6: ok = False
            nxt = months[i+1] if i+1 < len(months) else add_months(d, 1)
            F *= (1.0 + d_rate)**((nxt - d).days)
        return F, ok

    def solve_year(F0, months, age, cy, target_end):
        lo, hi = 0.0, max(1.0, 4.0*ndb/1000.0*_rate(p['rates'], age))
        Fh, okh = sim_year(F0, months, age, cy, hi)
        while (Fh < target_end or not okh) and hi < ndb:
            hi *= 2.0
            Fh, okh = sim_year(F0, months, age, cy, hi)
        for _ in range(80):
            mid = 0.5*(lo + hi)
            F, ok = sim_year(F0, months, age, cy, mid)
            if F < target_end or not ok: lo = mid
            else: hi = mid
        F, _ = sim_year(F0, months, age, cy, hi)
        return hi, F

    # first monthly date on/after VD
    pm = 0
    while add_months(cd, pm) < vd:
        pm += 1
    block = PAY_BLOCKS.get(frequency, 3)
    schedule, annual = {}, {}
    F = p['fund_at_vd']
    end_pm = (maturity_age - ia)*12
    while pm < end_pm:
        py = pm//12 + 1                           # = contract year
        age = ia + pm//12
        pm_year_end = py*12
        months = [add_months(cd, i) for i in range(pm, pm_year_end)]
        # one month's deduction at the CURRENT year's rate; none after last year
        buf = buffer_months*deduction(age, 0.0) if pm_year_end < end_pm else 0.0
        P, F = solve_year(F, months, age, py, buf)
        if P > 0:
            # group this year's monthly minimums into modal payments: the block
            # containing each month is paid, in full, at the block's first
            # monthly date (paying earlier than the monthly solution keeps the
            # fund strictly higher, so the schedule remains in force)
            for j, d in enumerate(months):
                mo = pm + j - (py-1)*12           # 0-based month within the policy year
                anchor_mo = (mo//block)*block
                anchor = add_months(cd, (py-1)*12 + anchor_mo)
                if anchor < months[0]: anchor = months[0]
                schedule[anchor] = schedule.get(anchor, 0.0) + P
            annual[py] = P*len(months)
        pm = pm_year_end
    return schedule, annual


def reconstruct_nlg_fund(nlg_raw, face, history, vd):
    """Rebuild the no-lapse (rider) fund from issue to the valuation date from
    a premium payment history [{'date': 'YYYY-MM-DD'|date, 'amount': $}, ...].

    Mechanics per the rider data pages: each payment credits net of the
    premium load and (optionally) a sales-expense charge applied to the first
    `sales_load.cap` dollars of cumulative premium at `sales_load.rate`;
    monthly deductions are the flat charge, an optional per-1000-of-face
    charge active until `per_1000_until`, and the rider COI on the no-lapse
    NAAR; interest accrues daily at the rider schedule."""
    p = _norm(nlg_raw)
    sales = nlg_raw.get('sales_load') or {}
    s_rate = float(sales.get('rate') or 0.0)
    s_cap = float(sales.get('cap') or 0.0)
    per1000 = float(nlg_raw.get('monthly_per_1000') or 0.0)
    pu = nlg_raw.get('per_1000_until')
    if isinstance(pu, str):
        pu = dt.datetime.strptime(pu, '%Y-%m-%d').date()
    elif isinstance(pu, dt.datetime):
        pu = pu.date()
    ndb = p['ndb'] or float(face)
    prems = {}
    for h in history or []:
        hd = h.get('date')
        if isinstance(hd, str):
            hd = dt.datetime.strptime(hd[:10], '%Y-%m-%d').date()
        elif isinstance(hd, dt.datetime):
            hd = hd.date()
        if hd is None: continue
        prems[hd] = prems.get(hd, 0.0) + float(h.get('amount') or 0.0)
    fund = 0.0; cum = 0.0
    d = p['contract_date']
    while d < vd:
        nxt = add_months(d, 1)
        months = (d.year - p['contract_date'].year)*12 + (d.month - p['contract_date'].month)
        cy = months // 12 + 1
        pay = sum(a for hd, a in prems.items() if d <= hd < nxt)
        if pay > 0:
            sales_chg = s_rate * max(0.0, min(pay, s_cap - cum))
            cum += pay
            fund += pay * (1.0 - p['premium_load']) - sales_chg
        beg = fund
        adm = p['monthly_charge'] + (per1000/1000.0*float(face) if (pu and d < pu) else 0.0)
        age = p['issue_age'] + cy - 1
        fund -= adm + _rate(p['rates'], age)/1000.0 * max(0.0, ndb - beg)
        fund *= (1.0 + _daily(p['interest'], cy))**((nxt - d).days)
        d = nxt
    return fund
