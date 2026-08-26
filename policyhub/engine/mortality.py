"""Survival-curve engine (reverse-engineered InsuriShield methodology).

Verified against all four reference workbooks' SC-MM-FI grids to ~1e-9.

Methodology (as reproduced from the InsuriShield workbooks):
- Base table: 2015 VBT smoker-distinct select & ultimate (SOA), ALB basis,
  loaded from the local pymort table bundle (IDs 3265-3272).
- The insured is treated as *newly selected at the valuation date*: issue age
  = attained age (ALB) on the valuation date; select duration then advances on
  each subsequent BIRTHDAY (attained-age change at the monthly start date),
  not on the valuation-date anniversary.  After the 25-year select period the
  ultimate column applies; beyond the ultimate table's last age the last rate
  carries forward.
- Mortality improvement factor MI (default 0.5%) is applied as a single flat
  multiplier (1-MI) on every rate.  (In the reference workbooks, valued in
  2026 with a 2015 table, the observed factor is exactly (1-MI)^1; a
  compounding interpretation could not be distinguished and the flat form
  reproduces all grids exactly.)
- Mortality multiplier MM (percent) scales the ANNUAL rate: x = q_annual*MM/100.
- Monthly mortality: q_m = 1-(1-x)^(1/12).  When x >= 1 the reference
  implementation falls back to q_m = 0.2 (reproduced here for parity).
- Survival S(0)=1 at the valuation date; S(t+1) = S(t)*(1-q_m(t)).
- Mean LE (months) = 0.5 + sum_{t>=1} S(t);  Median LE = interpolated month
  where S crosses 0.5.
- "Mean LE50" input: MM is solved so the curve's mean LE equals the target.
  (The reference solver carries ~±0.005-month tolerance; ours solves to 1e-7,
  which can move a valuation by ~0.001%.)
"""
import numpy as np, datetime as dt
from functools import lru_cache

TABLE_IDS = {('Male','Non-Smoker','ALB'):3269, ('Female','Non-Smoker','ALB'):3270,
             ('Male','Smoker','ALB'):3271, ('Female','Smoker','ALB'):3272,
             ('Male','Non-Smoker','ANB'):3265, ('Female','Non-Smoker','ANB'):3266,
             ('Male','Smoker','ANB'):3267, ('Female','Smoker','ANB'):3268}

MONTHLY_Q_FALLBACK = 0.2      # reference behavior when q_annual*MM >= 1
SELECT_YEARS = 25

def normalize_gender(g):
    g = (g or '').strip().lower()
    if g.startswith('f'): return 'Female'
    if g.startswith('m'): return 'Male'
    raise ValueError(f'Unrecognized gender: {g!r} (need Male or Female)')

def normalize_smoker(sm):
    """Map carrier class labels to the table's Smoker / Non-Smoker split.
    Anything containing 'non' (non-smoker, non-tobacco, NT...) is Non-Smoker;
    an explicit smoker/tobacco label is Smoker; unlabeled underwriting classes
    (Preferred Best, Preferred, Standard Plus, Super Preferred...) are
    non-tobacco classes at essentially every carrier -> Non-Smoker.
    Returns (normalized, was_mapped)."""
    raw = (sm or '').strip()
    t = raw.lower().replace('-', ' ')
    if t in ('non smoker', 'nonsmoker'): return 'Non-Smoker', False
    if t == 'smoker': return 'Smoker', False
    if 'non' in t or t in ('nt', 'ntb', 'nn'): return 'Non-Smoker', True
    if 'smok' in t or 'tobacco' in t or t in ('tb', 'sp t'): return 'Smoker', True
    return 'Non-Smoker', True   # class label like 'Preferred Best' -> non-tobacco

@lru_cache(maxsize=None)
def load_table(gender, smoker, basis='ALB'):
    gender = normalize_gender(gender)
    smoker, _ = normalize_smoker(smoker)
    from pymort import MortXML
    x = MortXML.from_id(TABLE_IDS[(gender, smoker, basis)])
    sel = {(int(ia), int(dur)): float(v) for (ia, dur), v in x.Tables[0].Values['vals'].items()}
    ult = {int(a): float(v) for a, v in x.Tables[1].Values['vals'].items()}
    return sel, ult, max(ult)

def add_months(d, n):
    y = d.year + (d.month-1+n)//12
    m = (d.month-1+n) % 12 + 1
    day = d.day
    while True:
        try: return dt.date(y, m, day)
        except ValueError: day -= 1

def age_alb(dob, on):
    a = on.year - dob.year
    if (on.month, on.day) < (dob.month, dob.day): a -= 1
    return a

def annual_q_series(dob, vd, gender, smoker, n_months, mi=0.005, basis='ALB'):
    """Improved (pre-multiplier) annual q for each monthly period start after VD."""
    if mi is None: mi = 0.005
    sel, ult, ult_max = load_table(gender, smoker, basis)
    issue_age = age_alb(dob, vd)
    out = np.empty(n_months)
    for t in range(n_months):
        att = age_alb(dob, add_months(vd, t))
        dur = att - issue_age + 1
        if dur <= SELECT_YEARS and (issue_age, dur) in sel:
            q = sel[(issue_age, dur)]
        else:
            q = ult.get(att, ult[ult_max])
        out[t] = q * (1.0 - mi)
    return out

def survival_curve(qa, mm):
    """S at month starts (S[0]=1) for annual-q series `qa` and multiplier `mm` (%)."""
    x = qa * mm / 100.0
    with np.errstate(invalid='ignore'):
        qm = np.where(x >= 1.0, MONTHLY_Q_FALLBACK, 1.0 - np.abs(1.0 - x)**(1.0/12.0))
    S = np.empty(len(qa)+1); S[0] = 1.0
    S[1:] = np.cumprod(1.0 - qm)
    return S

def mean_le(S):
    return S[1:].sum() + 0.5

def median_le(S):
    idx = int(np.argmax(S < 0.5))
    if S[idx] >= 0.5: return float('nan')
    lo, hi = S[idx-1], S[idx]
    return (idx-1) + (lo-0.5)/(lo-hi)

def solve_mm_for_le(qa, target_le_months, lo=0.01, hi=500000.0):
    f = lambda mm: mean_le(survival_curve(qa, mm)) - target_le_months
    flo = f(lo)
    if f(hi) > 0:
        raise ValueError(
            f'A mean LE of {target_le_months:g} months is unreachable even at the maximum '
            f'mortality multiplier - the base mortality inputs are broken (check DOB, '
            f'gender/smoker, and the mortality improvement factor).')
    if flo < 0:
        raise ValueError(
            f'A mean LE of {target_le_months:g} months exceeds what near-zero mortality '
            f'allows for this insured/horizon - check the LE input and DOB.')
    for _ in range(200):
        mid = 0.5*(lo+hi)
        fm = f(mid)
        if abs(hi-lo) < 1e-7*max(1.0, mid): break
        if (fm > 0) == (flo > 0): lo, flo = mid, fm
        else: hi = mid
    return 0.5*(lo+hi)

def mm_grid(qa, mm_min=50, mm_max=1500, step=25):
    """Survival grid across mortality multipliers (like sheet SC-MM-FI)."""
    mms = list(range(mm_min, mm_max+1, step))
    S = np.column_stack([survival_curve(qa, mm) for mm in mms])
    return mms, S

def le_grid(qa, le_min=5, le_max=None):
    """Survival grid across integer mean-LE targets (like sheet SC-LE-FI).
    le_max defaults to floor(mean LE at MM=50)."""
    if le_max is None:
        le_max = int(np.floor(mean_le(survival_curve(qa, 50))))
    les = list(range(le_min, le_max+1))
    mms = [solve_mm_for_le(qa, le) for le in les]
    S = np.column_stack([survival_curve(qa, mm) for mm in mms])
    return les, mms, S
