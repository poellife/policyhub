"""Probabilistic valuation layer (reproduces the workbook 'Results' sheet).

Cash flow at month-row i (dates on the policy monthiversary grid, A = months
since valuation date):
    PCF(i) = [S(i-3) - S(i-2)] * NDB(i-3)     for A(i) >= 3   (2-month NDB
             collection lag: deaths in the month starting at row i-3 are
             collected at row i)
           - S(i) * (Premium(i) + PurchasePrice(i))
Pre-valuation-date rows contribute nothing (seller's period).  The table runs
3 rows past the last premium-schedule row so the lag tail is collected.

IRR mode:   Price = sum PCF(i) / (1+IRR)^(A(i)/12)
Price mode: IRR = XIRR (actual/365, dated at each row's start date) of the
            PCF stream with the purchase price inserted at the VD row.
"""
import numpy as np, datetime as dt
from .mortality import mean_le, median_le

def build_results(op_rows, vd, S, irr=None, price=None, lag_rows=3):
    """op_rows: output of build_premium_schedule (or extracted OP table rows
    as dicts with keys start, prem, ndb).  S: survival at month starts from VD.
    Exactly one of irr (percent, e.g. 15.0) / price must be given."""
    n = len(op_rows)
    vd_idx = next(i for i, r in enumerate(op_rows) if r['start'] == vd)
    rows = []
    def surv(i):
        t = i - vd_idx
        return 1.0 if t < 0 else float(S[t])
    dates = [r['start'] for r in op_rows]
    from .mortality import add_months
    for k in range(lag_rows):
        dates.append(add_months(dates[-1], 1))
    irr_frac = (irr/100.0) if irr is not None else 0.0
    out = []
    cum_pcf = 0.0
    for i in range(n + lag_rows):
        A = i - vd_idx
        D = 0.0
        if price is not None and A == 0:
            D = price
        db = 0.0
        if A >= 3 and i-3 < n:
            db = (surv(i-3) - surv(i-2)) * op_rows[i-3]['ndb']
        prem = op_rows[i]['prem'] if i < n else 0.0
        pcf = 0.0 if A < 0 else db - surv(i)*(prem + D)
        disc = pcf / (1.0+irr_frac)**(A/12.0)
        cum_pcf += pcf if A >= 0 else 0.0
        out.append(dict(period=A, date=dates[i], pcf=pcf, disc=disc, S=surv(i),
                        prem=prem, ndb=op_rows[i]['ndb'] if i < n else None))
    res = dict(rows=out, vd_idx=vd_idx, n_op=n)
    res['price'] = sum(r['disc'] for r in out)          # meaningful in IRR mode
    # supporting metrics
    res['prob_maturity'] = surv(n)                       # S at row after last OP row
    # breakeven: cumulative negative cash outlay vs NDB
    outlay0 = max(res['price'], 0.0) if irr is not None else max(price or 0.0, 0.0)
    tnc = 0.0; breakeven = None
    for i in range(vd_idx, n):
        if i == vd_idx: tnc = outlay0
        tnc += op_rows[i]['prem']
        if op_rows[i]['ndb'] - tnc < 0:
            breakeven = surv(i); break
    res['breakeven_risk'] = 1.0 if outlay0 < 0 else (res['prob_maturity'] if breakeven is None else breakeven)
    Sarr = np.array([surv(i) for i in range(0, n + lag_rows)][vd_idx:])
    res['mean_le'] = mean_le(np.array(S[:max(len(S), 1)]))
    res['median_le'] = median_le(np.array(S))
    return res

def xnpv(rate, values, dates):
    d0 = dates[0]
    return sum(v / (1.0+rate)**((d-d0).days/365.0) for v, d in zip(values, dates))

def xirr(values, dates, guess=0.1):
    lo, hi = -0.9999, 100.0
    flo = xnpv(lo+1e-9, values, dates)
    fhi = xnpv(hi, values, dates)
    if flo*fhi > 0: return float('nan')
    for _ in range(200):
        mid = 0.5*(lo+hi)
        fm = xnpv(mid, values, dates)
        if fm == 0: return mid
        if (fm > 0) == (flo > 0): lo, flo = mid, fm
        else: hi = mid
    return 0.5*(lo+hi)

def price_at_irr(op_rows, vd, S, irr_pct):
    return build_results(op_rows, vd, S, irr=irr_pct)['price']

def irr_at_price(op_rows, vd, S, price):
    res = build_results(op_rows, vd, S, price=price)
    rows = [r for r in res['rows'] if r['period'] >= 0]
    values = [r['pcf'] for r in rows]
    dates = [r['date'] for r in rows]
    return xirr(values, dates)
