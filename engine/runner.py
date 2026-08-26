"""End-to-end valuation: Case -> COI rates -> premium schedule -> survival ->
price / IRR and supporting metrics."""
import numpy as np, datetime as dt
from .mortality import (annual_q_series, survival_curve, solve_mm_for_le,
                        mean_le, median_le, add_months, age_alb,
                        normalize_gender, normalize_smoker)
from .policy import PolicyAccount, build_premium_schedule
from .valuation import build_results, irr_at_price

def month_index(policy_date, on):
    pm = 0
    while add_months(policy_date, pm+1) <= on:
        pm += 1
    return pm

def snap_to_monthiversary(policy_date, d):
    """The schedule lives on policy monthiversaries; a valuation date between
    them is snapped FORWARD to the next monthiversary (itself if aligned)."""
    pm = month_index(policy_date, d)
    cand = add_months(policy_date, pm)
    if cand < d:
        cand = add_months(policy_date, pm+1)
    return cand

def selected_survival(qa, health_type, health_value):
    """Survival curve for the selected health input, replicating the workbook's
    25-point multiplier interpolation for non-grid multipliers."""
    if health_type == 'Mean LE50':
        mm = solve_mm_for_le(qa, health_value)
        return survival_curve(qa, mm), mm
    mm = health_value
    lo = int(np.floor(mm/25.0)*25); hi = int(np.ceil(mm/25.0)*25)
    if lo == hi or lo < 1:
        return survival_curve(qa, mm), mm
    Slo, Shi = survival_curve(qa, lo), survival_curve(qa, hi)
    S = ((25.0-(mm-lo))*Slo + (25.0-(hi-mm))*Shi)/25.0
    return S, mm

def run_case(case, coi_rates=None):
    # align the valuation date to the policy monthiversary grid
    vd0 = case.vd
    case.vd = snap_to_monthiversary(case.policy_date, case.vd)
    vd_snapped = (case.vd != vd0)
    # sanity: mortality improvement is a small fraction (0.005 = 0.5%); an
    # out-of-range value (e.g. 1.0 misread from a document) zeroes mortality
    if case.mi is None or not (0.0 <= case.mi <= 0.10):
        case.mi = 0.005
    # NLG-only illustration: account values all ~zero means the policy rides a
    # no-lapse guarantee - there are no account mechanics to calibrate. Price it
    # on the illustration's premium schedule directly (custom funding).
    nlg_mode = False
    nlg_contract = False
    nlg_error = None
    terminal = []
    avs = [lp.get('av') or 0.0 for lp in case.ledger.values()]
    prems = {py: (lp.get('prem') or 0.0) for py, lp in case.ledger.items()}
    # prepaid no-lapse guarantee: the illustration shows ZERO premium outlay in
    # every year, yet the death benefit persists for 2+ years AFTER the account
    # value hits zero. Only an already-funded NLG can do that (e.g. Penn Mutual
    # GPUL with the requirement met): the correct premium schedule is $0 and the
    # coverage simply ends when the guarantee does.
    _small_av = max(1000.0, 0.001*case.face)
    nlg_carry = [py for py, lp in case.ledger.items()
                 if (lp.get('av') or 0.0) <= _small_av
                 and (lp.get('ndb') or 0.0) > 0 and (lp.get('prem') or 0.0) <= 0]
    nlg_prepaid = (not any(v > 0 for v in prems.values())
                   and len(nlg_carry) >= 2
                   and not case.custom_premiums and not getattr(case, 'nlg', None))
    if not avs or max(avs) <= _small_av or nlg_prepaid:
        if not nlg_prepaid and not any(v > 0 for v in prems.values()) \
                and not getattr(case, 'nlg', None) and not case.custom_premiums:
            raise ValueError(
                'The extracted ledger has neither account values nor premiums - '
                'nothing to price from. If this is a no-lapse-guarantee policy, upload '
                'the POLICY CONTRACT together with the illustration: the app can compute '
                'the minimum premiums from the contract\'s Lapse Protection / No-Lapse '
                'Guarantee rider even when the illustration shows no premium outlay. '
                'Otherwise request a current-assumptions in-force illustration from the '
                'carrier.')
        nlg_mode = True
        case.funding = {py: 'Custom' for py in case.ledger}
        if getattr(case, 'nlg', None):
            # contract rider data takes precedence over any previously stored
            # custom schedule (delete the 'nlg' block from the case JSON to
            # price a hand-entered premium schedule instead)
            # policy-contract Lapse Protection rider data available: compute the
            # true minimum premiums from the no-lapse shadow account instead of
            # taking the illustration's (level) premium schedule
            from .nlg import nlg_min_premiums
            try:
                freq = getattr(case, 'payment_frequency', 'Quarterly') or 'Quarterly'
                sched, nlg_annual = nlg_min_premiums(
                    case.nlg, case.face, case.vd, frequency=freq,
                    maturity_age=case.maturity_age or 121)
                if sched:
                    # remap payment dates onto the policy monthiversary grid the
                    # projection rows live on (identical when policy_date is the
                    # contract date, as it should be)
                    remapped = {}
                    for d, amt in sched.items():
                        pmi = month_index(case.policy_date, d)
                        key = add_months(case.policy_date, pmi)
                        if key < case.vd: key = case.vd
                        remapped[key] = remapped.get(key, 0.0) + amt
                    case.custom_premiums = remapped
                    nlg_contract = True
            except Exception as e:
                nlg_error = str(e)                # fall back to the ledger schedule
        if not nlg_prepaid and not case.custom_premiums \
                and not any(v > 0 for v in prems.values()):
            raise ValueError(
                'This is a no-lapse-guarantee policy with no premiums in the '
                'illustration ledger, and the contract rider data could not produce '
                'a minimum-premium schedule'
                + (f' ({nlg_error})' if nlg_error else '')
                + '. Check the Lapse Protection rider extraction, or supply a '
                'custom_premiums schedule in the case JSON.')
        if not case.custom_premiums:
            # convert the ledger's annual NLG premiums into dated payments from
            # the valuation date forward, honoring the buyer payment frequency
            freq = getattr(case, 'payment_frequency', 'Annual') or 'Annual'
            pay_m = {'Quarterly': (1, 4, 7, 10), 'Monthly': tuple(range(1, 13))}.get(freq, (1,))
            sched = {}
            for py in sorted(case.ledger):
                p = prems.get(py) or 0.0
                if p <= 0: continue
                y0 = add_months(case.policy_date, (py-1)*12)
                if add_months(case.policy_date, py*12) <= case.vd:
                    continue                      # seller's years
                if y0 <= case.vd:                 # partial current year: pay at VD
                    sched[case.vd] = sched.get(case.vd, 0.0) + p
                    continue
                for m in pay_m:
                    sched[add_months(y0, m-1)] = p/len(pay_m)
            case.custom_premiums = sched
        # zero COI in NLG mode; when contract rider data is present, extend the
        # projection through maturity even if the extracted ledger is shorter
        pys = set(case.ledger)
        if nlg_contract and getattr(case, 'nlg', None):
            py_max = int(case.maturity_age or 121) - int(case.nlg['issue_age'])
            pys |= set(range(min(pys) if pys else 1, py_max + 1))
        coi_rates = {py: 0.0 for py in pys}
        case.funding = {py: 'Custom' for py in pys}
    # sanity: a ledger whose account value grows materially in years with zero
    # premium outlay is physically impossible - the premium column was misread
    if not nlg_mode:
        prev_av, bad = case.av_at_id, []
        for py in sorted(case.ledger):
            lp = case.ledger[py]
            av, prem = lp.get('av'), (lp.get('prem') or 0.0)
            if av is None: continue
            cr = max(lp.get('gcr') or 0.0, lp.get('ngcr') or 0.0) + 0.06
            thresh = max(5000.0, 0.01*case.face)
            # only flag growth from a KNOWN positive base: a jump from 0/None
            # usually means the starting AV (or leading ledger years) simply
            # weren't in the document, not that the premium column was misread
            if prem <= 0 and prev_av and prev_av > 0 \
                    and av > prev_av*(1.0+cr) + thresh:
                bad.append(py)
            prev_av = av
        if bad:
            raise ValueError(
                f'The extracted ledger is internally inconsistent: account values grow in '
                f'policy years {bad[:6]} even though those years show zero premium outlay. '
                f'The Premium Outlay column was almost certainly misread from the '
                f'illustration - re-run the valuation (extraction is not deterministic), '
                f'or fix the "prem" values in the case JSON and re-upload it.')
    case.gender = normalize_gender(case.gender)
    smoker0 = case.smoker
    case.smoker, smoker_mapped = normalize_smoker(case.smoker)
    dob = case.effective_dob
    # sanity: reconcile the DOB against the ages printed on the ledger rows
    # (in-force headers often print issue age or current age ambiguously)
    dob_shifted_from = None
    row_ages = {py: lp.get('age') for py, lp in case.ledger.items()
                if isinstance(lp.get('age'), (int, float)) and lp.get('age')}
    if row_ages:
        diffs = []
        for py, a in row_ages.items():
            start = add_months(case.policy_date, (py-1)*12)
            diffs.append(int(a) - age_alb(dob, start))
        off = round(sum(diffs)/len(diffs))
        if abs(off) >= 2 and all(abs(d - off) <= 1 for d in diffs):
            try:
                dob = dob.replace(year=dob.year - off)
            except ValueError:                    # Feb 29
                dob = dob.replace(year=dob.year - off, day=28)
            dob_shifted_from = case.dob
            case.dob = dob
    account = PolicyAccount(case.face, case.ledger, case.projection_crediting,
                            ledger_crediting=case.ledger_crediting,
                            illustration_mode=case.illustration_mode,
                            av_at_id=case.av_at_id)
    # --- COI rates ---
    if coi_rates is None and nlg_mode:
        coi_rates = {py: 0.0 for py in case.ledger}
    if coi_rates is None:
        stub = None
        pm_id = month_index(case.policy_date, case.id_date)
        cur = add_months(case.policy_date, pm_id)
        if cur < case.id_date:
            nxt = add_months(case.policy_date, pm_id+1)
            stub = (pm_id % 12 + 1, (nxt - case.id_date).days/30.0)
        coi_rates = account.backsolve_coi(id_stub=stub)
        # High backsolved rates are legitimate in the ledger's FINAL year or in a
        # year whose account value collapses to near zero (the illustration's
        # lapse year) - the policy is genuinely being consumed by charges there.
        # An impossible rate in an INTERIOR, non-collapsing year is the signature
        # of misaligned extraction and is refused.
        last_py = max(coi_rates) if coi_rates else 0
        crazy, terminal = [], []
        for py, rt in coi_rates.items():
            if rt < 0.6 or py in case.coi_overrides:
                continue
            av_t = (case.ledger.get(py) or {}).get('av') or 0.0
            prev = ((case.ledger.get(py-1) or {}).get('av')
                    if (py-1) in case.ledger else case.av_at_id) or 0.0
            collapse = prev > 0 and av_t <= 0.05*prev
            if py == last_py or collapse:
                terminal.append(py)
            else:
                crazy.append(py)
        if crazy:
            raise ValueError(
                f'COI calibration failed for policy year(s) {crazy}: the backsolved rate '
                f'hit an impossible level (>=60%/yr) in a mid-ledger year whose account '
                f'value is not collapsing. This almost always means the extracted ledger '
                f'rows are misaligned (a premium paired with the wrong year\'s account '
                f'value). Re-run the valuation - extraction is not deterministic - or '
                f'review and fix the ledger in the case JSON.')
        coi_rates.update(case.coi_overrides)
    # --- premium-requirement no-lapse guarantee (e.g. Equitable NLG rider) ---
    # While active (insured under to_age), the CSV lapse floor is waived as long
    # as cumulative premiums meet the annual requirement, so the true minimum in
    # those years is the requirement catch-up, not the CSV-buffer optimum.
    # Auto-align policy-year numbering (needed by the schedule builds below)
    py_offset = 0
    first_py = month_index(case.policy_date, case.id_date)//12 + 1
    if coi_rates and first_py not in coi_rates:
        py_offset = min(coi_rates) - first_py
    # buyer owes the current policy-year premium at close (instead of the
    # default assumption that the seller paid it at the year start)
    cyp_applied = False
    if getattr(case, 'current_year_premium_due', False) and not nlg_mode:
        pyv = month_index(case.policy_date, case.vd)//12 + 1 + py_offset
        lpv = case.ledger.get(pyv)
        if lpv and (lpv.get('prem') or 0) > 0:
            case.funding[pyv] = 'Custom'
            case.custom_premiums[case.vd] = case.custom_premiums.get(case.vd, 0.0) \
                + float(lpv['prem'])
            cyp_applied = True
    nlg_req_applied = False
    if not nlg_mode and getattr(case, 'nlg_requirement', None):
        req = case.nlg_requirement
        R = float(req.get('annual') or 0.0)
        to_age = int(req.get('to_age') or 0)
        if R > 0 and to_age > 0:
            # While the rider is active the true minimum each year is the CHEAPER
            # of (a) the cumulative NLG premium requirement (CSV floor waived) and
            # (b) the CSV-basis optimized minimum. Once (b) is cheaper the NLG is
            # abandoned permanently (the requirement is continuous), matching the
            # InsuriShield convention (NLG premiums early, optimize thereafter).
            freq_ = getattr(case, 'payment_frequency', 'Monthly') or 'Monthly'
            basis_ = getattr(case, 'optimize_basis', 'CSV') or 'CSV'
            def _build(f, cu):
                return build_premium_schedule(
                    account, coi_rates, case.policy_date, case.id_date, case.vd,
                    f, custom=cu, id_stub_frac=None, payment_frequency=freq_,
                    py_offset=py_offset, optimize_basis=basis_)
            base_f = dict(case.funding); base_c = dict(case.custom_premiums)
            cum = 0.0
            years = []
            for py in sorted(case.ledger):
                y0 = add_months(case.policy_date, (py-1)*12)
                if age_alb(dob, y0) >= to_age:
                    break
                if y0 < case.vd:
                    base_f[py] = 'Illustrated'      # seller-funded / straddling year
                    cum += case.ledger[py].get('prem') or 0.0
                elif y0 in base_c:                  # analyst-supplied premium
                    base_f[py] = 'Custom'
                    cum += base_c[y0]
                else:
                    years.append(py)
            pay_m = {'Quarterly': (1, 4, 7, 10), 'Monthly': tuple(range(1, 13)),
                     'Semi-Annual': (1, 7)}.get(freq_, (1,))
            for k in range(len(years) + 1):
                f = dict(base_f); cu = dict(base_c); c2 = cum
                for py in years[:k]:                # NLG-funded years
                    y0 = add_months(case.policy_date, (py-1)*12)
                    need = max(0.0, R*py - c2)
                    f[py] = 'Custom'
                    dates = [add_months(y0, m-1) for m in pay_m]
                    dates = [d_ for d_ in dates if d_ >= case.vd] or [max(case.vd, y0)]
                    for d_ in dates:                # spread at the buyer frequency
                        cu[d_] = cu.get(d_, 0.0) + need/len(dates)
                    c2 += need
                for py in years[k:]:                # candidate switch to CSV optimize
                    f[py] = 'Optimize'
                if k == len(years):                 # NLG through the whole period
                    case.funding, case.custom_premiums = f, cu
                    nlg_req_applied = True
                    break
                rows_t = _build(f, cu)
                py_t = years[k]
                tot = sum(r['prem'] for r in rows_t if r['py'] == py_t)
                if tot <= max(0.0, R*py_t - c2) + 1e-6:
                    case.funding, case.custom_premiums = f, cu
                    nlg_req_applied = (k > 0)
                    break
    # --- premium schedule ---
    # Auto-align policy-year numbering: the schedule derives policy years from
    # policy_date, the COI rates are keyed by the ledger's own numbering. When
    # they disagree (common when an in-force illustration's policy_date was
    # taken as a recent date), shift to the ledger's numbering.
    py_offset = 0
    first_py = month_index(case.policy_date, case.id_date)//12 + 1
    if coi_rates and first_py not in coi_rates:
        py_offset = min(coi_rates) - first_py
    rows = build_premium_schedule(
        account, coi_rates, case.policy_date, case.id_date, case.vd,
        case.funding, custom=case.custom_premiums,
        id_stub_frac=None,
        payment_frequency=getattr(case, 'payment_frequency', 'Monthly'),
        py_offset=py_offset,
        optimize_basis=getattr(case, 'optimize_basis', 'CSV') or 'CSV')
    if case.n_schedule_months:
        rows = rows[:case.n_schedule_months]
    if not rows:
        raise ValueError(
            f'No projection could be built: the schedule starts in policy year {first_py+py_offset} '
            f'but COI rates exist only for years {min(coi_rates)}-{max(coi_rates)}. '
            f'Check that policy_date ({case.policy_date}) is the ORIGINAL policy issue date and that '
            f'the ledger policy-year numbering matches the illustration.')
    if case.vd < rows[0]['start']:
        # valuation date before the illustration start: value as of the schedule start
        case.vd = rows[0]['start']
        vd_snapped = True
    if case.vd > rows[-1]['start']:
        raise ValueError(
            f'Valuation date {case.vd} is beyond the end of the projection '
            f'({rows[-1]["start"]}). The ledger/COI rates cover policy years '
            f'{min(coi_rates)}-{max(coi_rates)} ({rows[0]["start"]} to {rows[-1]["end"]}). '
            f'Either the valuation date is wrong in the case, or the extracted ledger is '
            f'missing later policy years - check the source illustration.')
    if nlg_mode and not nlg_prepaid:
        tot_buyer = sum(r['prem'] for r in rows if r['start'] >= case.vd)
        if tot_buyer <= 0:
            raise ValueError(
                'NLG pricing produced a zero premium schedule - the custom premium '
                'dates do not align with the policy monthiversary grid (policy_date '
                f'{case.policy_date}). Check policy_date/contract date and the '
                'custom_premiums dates in the case JSON.')
    # --- survival ---
    # Horizon: long enough for stable mean-LE / LE-solve (to age 130), and at
    # least the schedule length + lag (the reference grids run ~80 years).
    vd_idx = next(i for i, r in enumerate(rows) if r['start'] == case.vd)
    n_to_130 = max(1, (130 - age_alb(dob, case.vd))*12 + 12)
    n_months = max(len(rows) - vd_idx + 8, n_to_130)
    qa = annual_q_series(dob, case.vd, case.gender, case.smoker, n_months, mi=case.mi)
    def _curve_for(dob_, gender_, smoker_, htype_, hval_, ledate_):
        """Single-life survival curve from the VD, honoring the LE-aging
        convention. Returns (S, mm, le_aged, aging_used)."""
        qa_ = annual_q_series(dob_, case.vd, gender_, smoker_, n_months, mi=case.mi)
        if htype_ == 'Mean LE50' and ledate_ and ledate_ != case.vd:
            k = int(round((case.vd - ledate_).days / 30.4375))
            aging = getattr(case, 'le_aging', 'condition') or 'condition'
            qa_le_ = annual_q_series(dob_, ledate_, gender_, smoker_,
                                     n_months + max(k, 0) + 12, mi=case.mi)
            mm_ = solve_mm_for_le(qa_le_, hval_)
            if aging == 'condition' and k > 0:
                # Colva convention: condition the report-date curve on
                # survival to the VD - S_aged(t) = S(k+t)/S(k)
                S_le_ = survival_curve(qa_le_, mm_)
                return (S_le_[k:] / S_le_[k])[:n_months+1], mm_, ledate_, 'condition'
            # InsuriShield classic: rebuild the q-series at the VD's
            # attained age and apply the solved multiplier
            return survival_curve(qa_, mm_)[:n_months+1], mm_, ledate_, 'rebuild'
        S_, mm_ = selected_survival(qa_, htype_, hval_)
        return S_[:n_months+1], mm_, None, None

    def _pd(x):
        if x is None or isinstance(x, dt.date): return x
        return dt.datetime.strptime(str(x)[:10], '%Y-%m-%d').date()

    ins2 = getattr(case, 'insured2', None)
    # joint curve only when the second insured is alive AND has its own health
    # input; with a single LE entered, the desk convention is to price on that
    # one curve (the LE belongs to the longer-lived insured - the payout at
    # the second death tracks that life)
    joint = bool(getattr(case, 'survivorship', False) and ins2
                 and not (ins2 or {}).get('deceased')
                 and (ins2 or {}).get('health_value') is not None)
    S, mm, le_aged, le_aging_used = _curve_for(
        dob, case.gender, case.smoker, case.health_type, case.health_value,
        getattr(case, 'le_date', None))
    mm2 = None
    if joint:
        from .mortality import normalize_gender as _ng, normalize_smoker as _ns
        dob2 = _pd(ins2.get('dob'))
        if dob2 is None:
            raise ValueError('Survivorship policy: the second insured has no DOB - '
                             'add it to insured2 in the case (or upload a document '
                             'that states it).')
        h2t = ins2.get('health_type') or 'Mortality Multiplier'
        h2v = float(ins2.get('health_value') or 100.0)
        S2, mm2, _, _ = _curve_for(dob2, _ng(ins2.get('gender') or 'Male'),
                                   _ns(ins2.get('smoker') or 'Non-Smoker')[0],
                                   h2t, h2v, _pd(ins2.get('le_date')))
        import numpy as _np
        L = min(len(S), len(S2))
        # joint last-survivor: the policy pays on the SECOND death
        S = 1.0 - (1.0 - _np.asarray(S[:L]))*(1.0 - _np.asarray(S2[:L]))
    # --- valuation ---
    if case.valuation_type == 'IRR':
        res = build_results(rows, case.vd, S, irr=case.valuation_value)
        res['irr'] = case.valuation_value
    else:
        res = build_results(rows, case.vd, S, price=case.valuation_value)
        res['irr'] = irr_at_price(rows, case.vd, S, case.valuation_value)*100.0
        res['price'] = case.valuation_value
    res['mm'] = mm
    res['vd_snapped_from'] = vd0 if (vd_snapped or case.vd != vd0) else None
    res['py_offset'] = py_offset
    res['smoker_mapped_from'] = smoker0 if smoker_mapped else None
    res['dob_shifted_from'] = dob_shifted_from
    res['nlg_requirement_applied'] = nlg_req_applied
    res['coi_terminal_years'] = terminal
    res['le_aged_from'] = le_aged
    res['le_aging'] = le_aging_used
    res['survivorship_joint'] = joint
    res['mm2'] = mm2
    res['insured2_deceased'] = bool(getattr(case, 'survivorship', False)
                                    and (ins2 or {}).get('deceased'))
    res['survivorship_single_le'] = bool(getattr(case, 'survivorship', False)
                                         and not joint
                                         and not res['insured2_deceased'])
    res['current_year_premium_due'] = cyp_applied
    res['nlg_mode'] = nlg_mode
    res['nlg_prepaid'] = nlg_prepaid
    res['nlg_contract'] = nlg_contract
    res['nlg_error'] = nlg_error
    res['mean_le'] = mean_le(S)
    res['median_le'] = median_le(S)
    res['coi_rates'] = coi_rates
    res['schedule'] = rows
    res['qa'] = qa
    res['S'] = S
    return res


def sensitivity_grid(case, res=None, le_deltas=(-24, -12, 0, 12, 24),
                     irrs=(12.0, 15.0, 17.0, 20.0, 25.0)):
    """Confidence band around a priced case: price across LE shifts (at the
    case's target IRR) and across IRRs (at the case's health input). Full
    engine re-runs, so every convention (aging, NLG, optimization) is honored.
    Returns {'le': [(le_months, price)], 'irr': [(irr_pct, price)],
             'base_irr': x, 'base_le': y} or None on failure."""
    import copy as _copy
    try:
        base_irr = float(case.valuation_value) if case.valuation_type == 'IRR' \
            else round(float((res or {}).get('irr', 15.0)), 1)
        out_le, out_irr = [], []
        if case.health_type == 'Mean LE50':
            base_le = float(case.health_value)
            for dl in le_deltas:
                le = base_le + dl
                if le < 6: continue
                if dl == 0 and res is not None and case.valuation_type == 'IRR':
                    out_le.append((le, res['price']))   # base run already priced
                    continue
                c = _copy.deepcopy(case)
                c.health_value = le
                c.valuation_type, c.valuation_value = 'IRR', base_irr
                out_le.append((le, run_case(c)['price']))
        else:
            base_le = None
        # the premium schedule and survival curve do not depend on the IRR, so
        # the IRR row re-discounts the base run directly (cheap and exact)
        if res is not None and 'schedule' in res and 'S' in res:
            for irr in sorted(set([float(x) for x in irrs] + [base_irr])):
                r = build_results(res['schedule'], case.vd, res['S'], irr=irr)
                out_irr.append((irr, r['price']))
        else:
            for irr in sorted(set([float(x) for x in irrs] + [base_irr])):
                c = _copy.deepcopy(case)
                c.valuation_type, c.valuation_value = 'IRR', float(irr)
                out_irr.append((irr, run_case(c)['price']))
        return dict(le=out_le, irr=out_irr, base_irr=base_irr, base_le=base_le)
    except Exception:
        return None


def rider_variant_case(case):
    """A copy of the case funded on the Lapse Protection rider instead of the
    account: zero-AV ledger through maturity so run_case enters the NLG path
    and solves the rider minimum premiums from case.nlg. Returns None when the
    case has no usable rider data."""
    import copy as _copy
    nlg = getattr(case, 'nlg', None)
    if not nlg or not nlg.get('fund_at_vd') or not nlg.get('coi_per_1000'):
        return None
    c = _copy.deepcopy(case)
    issue_age = int(nlg.get('issue_age') or 0)
    mat = int(case.maturity_age or 121)
    py_lo = min(case.ledger) if case.ledger else 1
    py_hi = max(mat - issue_age, max(case.ledger) if case.ledger else 1)
    ndbs = {py: (case.ledger.get(py) or {}).get('ndb') for py in (case.ledger or {})}
    ngcr0 = next(iter(case.ledger.values())).get('ngcr') if case.ledger else None
    c.ledger = {py: dict(prem=0.0, ndb=float(ndbs.get(py) or case.face),
                         av=0.0, csv=0.0, gcr=0.0,
                         ngcr=ngcr0 or case.projection_crediting,
                         popc=None, ppc=None, puc=None, popcat=None, popcat_t=None)
                for py in range(py_lo, py_hi + 1)}
    c.custom_premiums = {}
    c.funding = {}
    return c
