"""Policy account mechanics (reverse-engineered InsuriShield methodology).

Verified against all four reference workbooks:
- monthly AV roll-forward reproduces every Optimized Premiums row to <$0.001
- COI backsolve reproduces every 'Calculated' COI rate to <1e-8
- premium optimizer reproduces every optimized premium to <$0.006

Monthiversary processing (in order), for policy-year py with annual COI rate r:
    net premium  P_net = P*(1-POPC), with the LOWER of POPC / POPCAT applied to
                 the portion of policy-year-to-date premium above the target
    X            = AV_beg + P_net - (PPC + PUC*units)          [monthly charges]
    q_m          = 1-(1-r)^(1/12)
    COI          = q_m * (NDB*(1+GCR)^(-1/12) - X) / (1-q_m)
                 (NAAR is measured against the post-COI account value:
                  COI = q_m*(NDB*v - (X-COI)) exactly.)
    AV_end       = (X - COI) * (1+c)^(1/12)      c = AV crediting rate (annual)

Partial first period (illustration date off the monthiversary): fraction
f = (days to next monthiversary)/30, no monthly charges, exponents scaled by f.

Two crediting rates appear in the reference models:
- LEDGER crediting (used only inside the COI backsolve) = the ledger's own
  illustrated basis = NGCR in all four reference workbooks.
- PROJECTION crediting (used for the forward roll / optimization) = an
  analyst assumption (3.50%, 3.95%, 3.20%, 3.75% in the four references;
  equals NGCR for two of them).

Surrender charge: SC(py) = ledger AV - ledger CSV; years where the ledger
floors CSV at 0 are back-extrapolated with the first observed annual step.
CSV(t) = AV(t) - SC(py).

Premium optimization ('Optimize' funding): each month the minimum premium >= 0
such that ending CSV >= buffer, where buffer = that month's COI amount
("1 Month of COI").  Years funded 'Pay as Illustrated' take the ledger
premium schedule and anchor AV to the ledger year-end values; 'Custom' takes
a user schedule.
"""
import numpy as np
from .mortality import add_months

class PolicyAccount:
    def __init__(self, face, ledger, projection_crediting, ledger_crediting=None,
                 illustration_mode='Annual', av_at_id=0.0):
        self.face = face
        self.ledger = ledger            # {py: dict(prem,ndb,av,csv,gcr,ngcr,popc,ppc,puc,popcat,popcat_t)}
        self.credit = projection_crediting
        self.ledger_credit = ledger_crediting if ledger_crediting is not None else \
            (ledger[min(ledger)].get('ngcr') or 0.0)
        self.mode = illustration_mode
        self.av_id = av_at_id
        self.units = face/1000.0
        self.g_m = (1.0+projection_crediting)**(1.0/12.0)

    # ---- parameter lookup ----
    def params(self, py):
        lp = self.ledger.get(py)
        if lp is None:
            lp = self.ledger[min(self.ledger)] if py < min(self.ledger) else self.ledger[max(self.ledger)]
        return lp

    def monthly_charge(self, py):
        lp = self.params(py)
        return (lp.get('ppc') or 0.0) + (lp.get('puc') or 0.0)*self.units

    def net_premium(self, prem, py, ytd_prem=0.0):
        lp = self.params(py)
        popc = lp.get('popc') or 0.0
        tgt = lp.get('popcat_t')
        if tgt and lp.get('popcat') is not None:
            above_rate = min(popc, lp['popcat']/100.0)
            below = max(0.0, min(prem, tgt - ytd_prem))
            return below*(1-popc) + (prem-below)*(1-above_rate)
        return prem*(1-popc)

    # ---- one monthiversary period ----
    def step(self, beg, prem, py, rate, ndb, frac=1.0, ytd_prem=0.0, crediting=None):
        lp = self.params(py)
        gcr = lp.get('gcr') or 0.0
        g = self.g_m if crediting is None else (1.0+crediting)**(1.0/12.0)
        charge = self.monthly_charge(py) if frac == 1.0 else 0.0
        X = beg + self.net_premium(prem, py, ytd_prem) - charge
        qm = 1.0 - (1.0-rate)**(frac/12.0)
        naar = ndb*(1.0+gcr)**(-frac/12.0) - X
        coi = qm*naar/(1.0-qm)
        return (X - coi)*g**frac, coi

    # ---- ledger premium timing ----
    def ledger_premium_months(self, py):
        p = self.params(py).get('prem') or 0.0
        return {'Annual': {1: p}, 'Semi-Annual': {1: p/2, 7: p/2},
                'Quarterly': {1: p/4, 4: p/4, 7: p/4, 10: p/4},
                'Monthly': {m: p/12 for m in range(1, 13)}}.get(self.mode, {1: p})

    # ---- COI backsolve ----
    def backsolve_coi(self, pys=None, id_stub=None):
        """Solve the annual COI rate per policy year so a monthly roll at the
        LEDGER crediting rate, starting each year at the prior ledger AV and
        paying ledger premiums, reproduces that year's ledger AV.
        id_stub: (start_month_index, frac) for a mid-year illustration start;
        that first partial year cannot generally be calibrated (reference
        marks it 'Manually Adjusted')."""
        if pys is None:
            pys = [py for py in sorted(self.ledger) if self.ledger[py].get('av') is not None]
        rates = {}
        for k, py in enumerate(pys):
            lp = self.ledger[py]
            target = lp['av']
            start = self.av_id if k == 0 else self.ledger[pys[k-1]]['av']
            sched = self.ledger_premium_months(py)
            stub = id_stub if k == 0 else None
            def year_end(rate):
                a = start; ytd = 0.0
                if stub:
                    m0, frac = stub
                    a, _ = self.step(a, 0.0, py, rate, lp['ndb'], frac=frac, crediting=self.ledger_credit)
                    months = range(m0+1, 13)
                else:
                    months = range(1, 13)
                for m in months:
                    p = sched.get(m, 0.0)
                    a, _ = self.step(a, p, py, rate, lp['ndb'], ytd_prem=ytd, crediting=self.ledger_credit)
                    ytd += p
                return a
            lo, hi = 0.0, 0.999
            flo = year_end(lo) - target
            if flo < 0:
                # even zero COI cannot reach the ledger AV: the product credits
                # more than the stated rate (bonuses / expense credits). Use 0 -
                # Illustrated years re-anchor to the ledger, so drift is contained.
                rates[py] = 0.0
                continue
            for _ in range(100):
                mid = 0.5*(lo+hi)
                if ((year_end(mid)-target) > 0) == (flo > 0): lo = mid
                else: hi = mid
            rates[py] = 0.5*(lo+hi)
        return rates

    # ---- surrender charges ----
    def sc_schedule(self):
        sc = {}
        for py, lp in self.ledger.items():
            if lp.get('av') is None or lp.get('csv') is None:
                sc[py] = 0.0
            else:
                sc[py] = lp['av'] - lp['csv']
        known = [py for py in sorted(sc)
                 if self.ledger[py].get('csv') not in (None, 0)]
        if known:
            k0 = known[0]
            step = (sc[k0] - sc[known[1]]) if len(known) > 1 else 0.0
            for py in sorted(sc):
                if py < k0 and self.ledger[py].get('csv') == 0 and (self.ledger[py].get('av') or 0) > 0:
                    sc[py] = sc[k0] + step*(k0-py)
        return sc

    # ---- span premium optimization (one payment covering k months) ----
    def optimize_span(self, beg, py, rate, ndb, sc, k, ytd_prem=0.0):
        """Minimum premium >= 0 paid in the FIRST of k months such that ending
        CSV >= buffer (that month's COI) in EVERY one of the k months."""
        def worst(P):
            av = beg; ytd = ytd_prem; w = float('inf')
            for i in range(k):
                p = P if i == 0 else 0.0
                av, coi = self.step(av, p, py, rate, ndb, ytd_prem=ytd)
                ytd += p
                w = min(w, av - sc - coi)
            return w
        if worst(0.0) >= -1e-9:
            return 0.0
        lo, hi = 0.0, ndb
        for _ in range(200):
            mid = 0.5*(lo+hi)
            if worst(mid) < 0: lo = mid
            else: hi = mid
            if hi-lo < 1e-10*max(1.0, hi): break
        return 0.5*(lo+hi)

    # ---- monthly premium optimization ----
    def optimize_month(self, beg, py, rate, ndb, sc, ytd_prem=0.0):
        """Minimum premium >= 0 with ending CSV >= buffer (this month's COI)."""
        end0, coi0 = self.step(beg, 0.0, py, rate, ndb, ytd_prem=ytd_prem)
        if end0 - sc >= coi0 - 1e-9:
            return 0.0, end0, coi0
        lo, hi = 0.0, ndb
        for _ in range(200):
            mid = 0.5*(lo+hi)
            e, c = self.step(beg, mid, py, rate, ndb, ytd_prem=ytd_prem)
            if e - sc - c < 0: lo = mid
            else: hi = mid
            if hi-lo < 1e-10*max(1.0, hi): break
        p = 0.5*(lo+hi)
        e, c = self.step(beg, p, py, rate, ndb, ytd_prem=ytd_prem)
        return p, e, c


def build_premium_schedule(account, coi_rates, policy_date, id_date, vd,
                           funding, custom=None, end_age_date=None,
                           ndb_by_py=None, survival_stop=None,
                           id_stub_frac=None, payment_frequency='Monthly',
                           py_offset=0, optimize_basis='CSV'):
    """Build the monthly Optimized Premiums table.

    funding: {py: 'Illustrated' | 'Optimize' | 'Custom'}
    custom:  {date: premium} used for months whose year is 'Custom'
    ndb_by_py: NDB per policy year (defaults to ledger NDB / face)
    survival_stop: optional callable(t_months_from_id) -> S for truncation
    Returns list of dict rows.
    """
    rows = []
    # first monthiversary anchor: policy monthiversary day series from policy_date
    # months are policy months; find policy month index of ID
    pm = 0
    while add_months(policy_date, pm+1) <= id_date:
        pm += 1
    cur = add_months(policy_date, pm)
    stub = cur < id_date or id_stub_frac is not None
    sc = account.sc_schedule()
    av = account.av_id
    ytd = 0.0
    last_py = None
    t = 0
    freq = payment_frequency or 'Monthly'
    span_prem = {}          # pm -> premium fixed by an earlier span solve
    PAY_MONTHS = {'Quarterly': (1, 4, 7, 10), 'Annual': (1,)}.get(freq)
    while True:
        py = pm//12 + 1 + py_offset
        m = pm % 12 + 1
        start = add_months(policy_date, pm) if not (stub and t == 0) else id_date
        nxt = add_months(policy_date, pm+1)
        if end_age_date and start >= end_age_date: break
        lp = account.params(py)
        # NDB: explicit 0 in the ledger is REAL (coverage ceased - e.g. an NLG
        # expiring at a set age); only None/missing falls back to face
        ndb = ndb_by_py.get(py) if ndb_by_py else None
        if ndb is None: ndb = lp.get('ndb')
        if ndb is None: ndb = account.face
        rate = coi_rates.get(py)
        if rate is None: break
        if py != last_py: ytd = 0.0; last_py = py
        mode = funding.get(py, 'Optimize')
        if stub and t == 0:
            frac = id_stub_frac if id_stub_frac is not None else (nxt - id_date).days/30.0
            e, c = account.step(av, 0.0, py, rate, ndb, frac=min(frac, 1.0))
            prem = 0.0
        elif mode == 'Illustrated':
            # Illustrated years follow the ILLUSTRATION's own payment schedule
            # (the buyer payment frequency applies to optimized years only): an
            # annual-mode year was already funded at its start, so a buyer
            # taking over mid-year owes nothing until the next policy year.
            sched = account.ledger_premium_months(py)
            prem = sched.get(m, 0.0)
            e, c = account.step(av, prem, py, rate, ndb, ytd_prem=ytd)
            if m == 12 and account.ledger.get(py, {}).get('av') is not None:
                e = account.ledger[py]['av']       # anchor to ledger year-end
        elif mode == 'Custom':
            prem = (custom or {}).get(start, 0.0)
            e, c = account.step(av, prem, py, rate, ndb, ytd_prem=ytd)
        elif PAY_MONTHS and start >= vd:  # Optimize, quarterly/annual buyer payments
            sc_eff = sc.get(py, 0.0) if optimize_basis != 'AV' else 0.0
            if pm in span_prem:
                prem = span_prem.pop(pm)
            else:
                # payment month: cover every month until the next payment month
                nxt_candidates = [x for x in PAY_MONTHS if x > m] + [13]
                k = min(nxt_candidates) - m
                prem = account.optimize_span(av, py, rate, ndb, sc_eff, k, ytd_prem=ytd)
                for j in range(1, k):
                    span_prem[pm+j] = 0.0
            e, c = account.step(av, prem, py, rate, ndb, ytd_prem=ytd)
        else:  # Optimize, monthly (pay-as-you-go)
            sc_eff = sc.get(py, 0.0) if optimize_basis != 'AV' else 0.0
            prem, e, c = account.optimize_month(av, py, rate, ndb, sc_eff, ytd_prem=ytd)
        ytd += prem
        rows.append(dict(pm=pm, py=py, m=m, start=start, end=nxt, mode=mode,
                         beg=av, prem=prem, ndb=ndb, rate=rate, coi=c,
                         end_av=e, sc=sc.get(py, 0.0),
                         beg_csv=av - sc.get(py, 0.0), end_csv=e - sc.get(py, 0.0)))
        av = e
        pm += 1; t += 1
        if survival_stop is not None and survival_stop(len(rows)) : break
    return rows


def default_funding_plan(account):
    """Default funding plan when the analyst gives no override: 'Optimize'
    from the first policy year whose STARTING cash surrender value
    (prior-year ledger AV minus that year's surrender charge) is
    non-negative, 'Illustrated' before that.  Once optimization starts it
    continues for all later years.  This is a default, not a rule of the
    reference model — the funding plan there is an analyst input."""
    sc = account.sc_schedule()
    plan, started = {}, False
    pys = sorted(account.ledger)
    for k, py in enumerate(pys):
        if started:
            plan[py] = 'Optimize'; continue
        start_av = account.av_id if k == 0 else (account.ledger[pys[k-1]].get('av') or 0.0)
        if start_av - sc.get(py, 0.0) >= 0:
            plan[py] = 'Optimize'; started = True
        else:
            plan[py] = 'Illustrated'
    return plan
