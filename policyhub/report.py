"""One/two-page PDF pricing report in the Poel Capital style: headline price,
key metrics, and the annual minimum (optimized) premium schedule through the
insured's age at the selected life expectancy."""
import datetime as dt
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle, Paragraph,
                                Spacer, HRFlowable)
from reportlab.lib.styles import ParagraphStyle

INK = colors.HexColor('#0a0a0a')
MUTE = colors.HexColor('#737373')
RULE = colors.HexColor('#e5e5e5')
SOFT = colors.HexColor('#fafafa')
HILITE = colors.HexColor('#fef3c7')

P = lambda **kw: ParagraphStyle('x', **kw)
S_LOGO  = P(fontName='Helvetica-Bold', fontSize=15, textColor=INK)
S_TAG   = P(fontName='Courier', fontSize=7.5, textColor=MUTE)
S_LABEL = P(fontName='Courier', fontSize=7.5, textColor=MUTE, spaceBefore=6)
S_BIG   = P(fontName='Helvetica-Bold', fontSize=34, textColor=INK, leading=40, spaceAfter=2)
S_SUB   = P(fontName='Helvetica', fontSize=10, textColor=MUTE)
S_BODY  = P(fontName='Helvetica', fontSize=8.5, textColor=INK, leading=12)
S_FINE  = P(fontName='Helvetica', fontSize=7, textColor=MUTE, leading=9.5)
S_H2    = P(fontName='Helvetica-Bold', fontSize=11, textColor=INK, spaceBefore=10)

def _age(dob, on):
    a = on.year - dob.year
    if (on.month, on.day) < (dob.month, dob.day): a -= 1
    return a

def build_pdf(case, res, path, notes='', sens=None, completeness=None):
    from engine.mortality import add_months
    doc = SimpleDocTemplate(path, pagesize=letter, topMargin=0.55*inch,
                            bottomMargin=0.55*inch, leftMargin=0.7*inch,
                            rightMargin=0.7*inch,
                            title=f'{case.name} — Valuation Report')
    el = []

    # header
    hdr = Table([[Paragraph('&#9679;&nbsp;&nbsp;Poel Capital', S_LOGO),
                  Paragraph('POLICY VALUATION REPORT<br/>'
                            + dt.date.today().strftime('%B %d, %Y').upper(), S_TAG)]],
                colWidths=[4.4*inch, 2.7*inch])
    hdr.setStyle(TableStyle([('ALIGN', (1, 0), (1, 0), 'RIGHT'),
                             ('VALIGN', (0, 0), (-1, -1), 'TOP')]))
    el.append(hdr)
    el.append(Spacer(1, 6))
    el.append(HRFlowable(width='100%', thickness=1, color=INK))
    el.append(Spacer(1, 12))

    # headline
    el.append(Paragraph(case.name.upper(), S_TAG))
    if case.valuation_type == 'IRR':
        el.append(Paragraph(f"${res['price']:,.0f}", S_BIG))
        el.append(Paragraph(f"Purchase price at {case.valuation_value:g}% IRR", S_SUB))
    else:
        el.append(Paragraph(f"{res['irr']:.2f}%", S_BIG))
        el.append(Paragraph(f"Implied IRR at ${case.valuation_value:,.0f} purchase price", S_SUB))
    el.append(Spacer(1, 10))

    # key metrics
    dob = case.effective_dob
    buyer = [r for r in res['schedule'] if r['start'] >= case.vd]
    le_months = res['mean_le']
    le_date = add_months(case.vd, int(round(le_months)))
    le_age = _age(dob, le_date)
    rows = []
    if getattr(case, 'insured_name', None):
        rows.append(('CLIENT / INSURED', case.insured_name))
    if getattr(case, 'illustration_name', None):
        rows.append(('SOURCE ILLUSTRATION', case.illustration_name))
    rows += [
        ('HEALTH INPUT', f"{case.health_type} = {case.health_value:g}"
         + (' months' if case.health_type == 'Mean LE50' else '%')),
        ('IMPLIED MULTIPLIER / MEAN LE', f"{res['mm']:.1f}%  ·  {res['mean_le']:.1f} months"
         f" (median {res['median_le']:.1f})"),
        ('LE DATE / AGE AT LE', f"{le_date.strftime('%b %Y')}  ·  age {le_age}"),
        ('INSURED', f"{case.gender}, {case.smoker}, age {_age(dob, case.vd)} at valuation"),
        ('FACE / NDB', f"${case.face:,.0f}"),
        ('VALUATION DATE', case.vd.strftime('%B %d, %Y')),
        ('BREAKEVEN RISK', f"{res['breakeven_risk']:.4g}"),
        ('BUYER PREMIUMS  YR 1 / TOTAL', f"${sum(r['prem'] for r in buyer[:12]):,.0f}"
         f"  /  ${sum(r['prem'] for r in buyer):,.0f}"),
        ('PROJECTION CREDITING', f"{case.projection_crediting*100:.2f}%"),
        ('PREMIUM FREQUENCY', f"{getattr(case, 'payment_frequency', 'Monthly')} (buyer payments from valuation date)"),
        ('MORTALITY BASIS', f"{case.survival_table} S&U, MI {case.mi*100:.1f}%, "
         f"NDB lag {case.ndb_lag_months} mo"),
    ]
    t = Table([[Paragraph(a, S_LABEL), Paragraph(b, S_BODY)] for a, b in rows],
              colWidths=[2.5*inch, 4.6*inch])
    t.setStyle(TableStyle([
        ('LINEBELOW', (0, 0), (-1, -2), 0.4, RULE),
        ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE')]))
    el.append(t)

    # sensitivity / confidence band
    grid = sens if sens is not None else None
    if grid is None:
        try:
            from engine.runner import sensitivity_grid
            grid = sensitivity_grid(case, res)
        except Exception:
            grid = None
    if grid:
        el.append(Spacer(1, 10))
        el.append(Paragraph('Sensitivity &mdash; Confidence Band', S_H2))
        el.append(Paragraph(
            'The point estimate inherits the confidence of the LE input. Each price '
            'below is a full engine re-run; the LE row holds the target IRR of '
            f"{grid['base_irr']:g}% and the IRR row holds the base health input.", S_FINE))
        if grid.get('le'):
            hdr_r = [Paragraph('LE (months)', S_LABEL)] + [
                Paragraph(('<b>%g</b>' if le == grid.get('base_le') else '%g') % le, S_BODY)
                for le, _ in grid['le']]
            val_r = [Paragraph(f"Price @ {grid['base_irr']:g}%", S_LABEL)] + [
                Paragraph(('<b>$%s</b>' if le == grid.get('base_le') else '$%s')
                          % f'{p:,.0f}', S_BODY) for le, p in grid['le']]
            ts = Table([hdr_r, val_r], colWidths=[1.5*inch] + [1.12*inch]*len(grid['le']))
            ts.setStyle(TableStyle([('LINEBELOW', (0, 0), (-1, 0), 0.4, RULE),
                ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
            el.append(ts)
            el.append(Spacer(1, 4))
        if grid.get('irr'):
            hdr_r = [Paragraph('Target IRR', S_LABEL)] + [
                Paragraph(('<b>%g%%</b>' if irr == grid.get('base_irr') else '%g%%') % irr,
                          S_BODY) for irr, _ in grid['irr']]
            val_r = [Paragraph('Price', S_LABEL)] + [
                Paragraph(('<b>$%s</b>' if irr == grid.get('base_irr') else '$%s')
                          % f'{p:,.0f}', S_BODY) for irr, p in grid['irr']]
            ts = Table([hdr_r, val_r], colWidths=[1.5*inch] + [1.12*inch]*len(grid['irr']))
            ts.setStyle(TableStyle([('LINEBELOW', (0, 0), (-1, 0), 0.4, RULE),
                ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
            el.append(ts)

    # input completeness (green / amber / red source confidence)
    if completeness:
        DOT = {'ok': '#10b981', 'warn': '#f59e0b', 'miss': '#ef4444'}
        el.append(Spacer(1, 10))
        el.append(Paragraph('Input Completeness', S_H2))
        n_ok = sum(1 for c in completeness if c.get('status') == 'ok')
        el.append(Paragraph(
            f"{n_ok} of {len(completeness)} pricing inputs fully sourced. Green = from a "
            'document or entered directly; amber = usable but could be tightened; red = '
            'missing and material.', S_FINE))
        crows = []
        for c in completeness:
            dot = DOT.get(c.get('status'), '#9ca3af')
            crows.append([
                Paragraph(f'<font color="{dot}">&#9679;</font>&nbsp;&nbsp;'
                          + str(c.get('label', '')), S_LABEL),
                Paragraph(str(c.get('source', '')), S_FINE),
                Paragraph(str(c.get('note', '')), S_FINE)])
        tc = Table(crows, colWidths=[1.9*inch, 1.0*inch, 4.2*inch])
        tc.setStyle(TableStyle([
            ('LINEBELOW', (0, 0), (-1, -2), 0.4, RULE),
            ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('VALIGN', (0, 0), (-1, -1), 'TOP')]))
        el.append(tc)

    # illustration runs considered (multi-illustration uploads)
    runs = getattr(case, 'source_runs', None) or []
    if runs:
        el.append(Paragraph('ILLUSTRATION RUNS CONSIDERED', S_LABEL))
        for r_ in runs:
            mark = '&#9679; CHOSEN:' if r_.get('chosen') else '&#9675;'
            txt = f"{mark} {r_.get('label','')} &mdash; {r_.get('source','')}"
            if r_.get('date'): txt += f", dated {r_['date']}"
            if r_.get('chosen') and r_.get('reason'): txt += f". {r_['reason']}"
            el.append(Paragraph(txt, S_FINE))

    # annual premium schedule through age at LE
    if res.get('nlg_contract'):
        el.append(Paragraph('Minimum No-Lapse Guarantee Premiums (annual, through age at LE)', S_H2))
        el.append(Paragraph(
            'Minimum premiums that keep the no-lapse guarantee value above zero, computed '
            'from the policy contract\'s Lapse Protection rider (premium loads, monthly '
            'charges, no-lapse COI rates and interest), with a one-month buffer. The '
            'highlighted row contains the selected life expectancy.', S_FINE))
    else:
        el.append(Paragraph('Minimum Optimized Premiums (annual, through age at LE)', S_H2))
        el.append(Paragraph(
            'Minimum annual premiums that keep the policy in force under the optimized '
            'funding plan. The highlighted row contains the selected life expectancy.', S_FINE))
    el.append(Spacer(1, 4))
    hdr_row = ['POLICY YEAR', 'PERIOD', 'AGE', 'ANNUAL PREMIUM', 'CUMULATIVE']
    data = [hdr_row]
    cum = 0.0
    le_row_idx = None
    by_py = {}
    for r in buyer:
        by_py.setdefault(r['py'], []).append(r)
    for py in sorted(by_py):
        yr = by_py[py]
        start, end = yr[0]['start'], yr[-1]['end']
        if start > le_date:
            break
        prem = sum(r['prem'] for r in yr)
        cum += prem
        age0 = _age(dob, start)
        data.append([str(py), f"{start.strftime('%b %Y')} – {end.strftime('%b %Y')}",
                     str(age0), f"${prem:,.0f}", f"${cum:,.0f}"])
        if start <= le_date <= end:
            le_row_idx = len(data) - 1
    tp = Table(data, colWidths=[0.9*inch, 2.2*inch, 0.7*inch, 1.6*inch, 1.7*inch],
               repeatRows=1)
    style = [
        ('FONTNAME', (0, 0), (-1, 0), 'Courier'), ('FONTSIZE', (0, 0), (-1, 0), 7),
        ('TEXTCOLOR', (0, 0), (-1, 0), MUTE),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'), ('FONTSIZE', (0, 1), (-1, -1), 8.5),
        ('ALIGN', (3, 0), (-1, -1), 'RIGHT'), ('ALIGN', (2, 0), (2, -1), 'CENTER'),
        ('LINEBELOW', (0, 0), (-1, 0), 0.8, INK),
        ('LINEBELOW', (0, 1), (-1, -2), 0.4, RULE),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, SOFT]),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
    ]
    if le_row_idx:
        style += [('BACKGROUND', (0, le_row_idx), (-1, le_row_idx), HILITE),
                  ('FONTNAME', (0, le_row_idx), (-1, le_row_idx), 'Helvetica-Bold')]
    tp.setStyle(TableStyle(style))
    el.append(tp)
    el.append(Paragraph(
        f"Cumulative minimum premiums through the LE date ({le_date.strftime('%b %Y')}, "
        f"age {le_age}): <b>${cum:,.0f}</b>. Premiums beyond the LE date continue per the "
        f"optimized schedule in the accompanying workbook; expected (survival-weighted) "
        f"premium cost is reflected in the price above.", S_BODY))

    # assumptions / disclaimer
    el.append(Spacer(1, 10))
    el.append(HRFlowable(width='100%', thickness=0.5, color=RULE))
    if notes:
        el.append(Paragraph('EXTRACTION & ASSUMPTION NOTES', S_LABEL))
        el.append(Paragraph(notes[:1200], S_FINE))
    el.append(Paragraph(
        'Methodology: 2015 VBT smoker-distinct ALB select & ultimate mortality, newly selected '
        'at the valuation date; COI rates backsolved from the carrier illustration ledger at the '
        'ledger crediting basis; monthly premium optimization holding CSV at a one-month-of-COI '
        'buffer; probabilistic cash flows with NDB collection lag, discounted at the target IRR. '
        'Internal pricing work product of Poel Capital — not an offer, valuation opinion, or '
        'investment advice. Non-guaranteed policy elements are subject to carrier change.', S_FINE))
    doc.build(el)
