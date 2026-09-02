"""Render the report JSON into the branded Poel Life PDF (ReportLab).

House style (from poel_report_template.py): navy #1f3a5f, accent #2e6f8e, POEL LIFE masthead
on the cover, navy running header on content pages, footer disclaimer + page numbers,
warm-beige disclaimer/caveat boxes, salmon dominant-condition flag box.
"""
from __future__ import annotations

from datetime import date
from xml.sax.saxutils import escape

from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (BaseDocTemplate, Frame, NextPageTemplate, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

NAVY = HexColor("#1f3a5f"); ACC = HexColor("#2e6f8e"); SLATE = HexColor("#33455c")
MUT = HexColor("#5b6b7b"); RULE = HexColor("#c4d0db"); LROW = HexColor("#f5f8fa")
WARNB = HexColor("#fbf4e8"); WARND = HexColor("#d9b873")
DOMB = HexColor("#f6e9e6"); DOMD = HexColor("#c98e80")
ESTB = HexColor("#e9f1f5"); ESTD = ACC

PW, PH = letter
M = 0.85 * inch
W = PW - 2 * M

S = {}
S["body"] = ParagraphStyle("body", fontName="Helvetica", fontSize=9.6, leading=13.6, textColor=SLATE, alignment=TA_JUSTIFY, spaceAfter=6)
S["bodyl"] = ParagraphStyle("bodyl", parent=S["body"], alignment=TA_LEFT)
S["bullet"] = ParagraphStyle("bullet", parent=S["bodyl"], leftIndent=12, bulletIndent=2, spaceAfter=2)
S["h1"] = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=13.5, leading=17, textColor=NAVY, spaceBefore=14, spaceAfter=4)
S["h2"] = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=10.8, leading=14, textColor=ACC, spaceBefore=9, spaceAfter=3)
S["small"] = ParagraphStyle("small", fontName="Helvetica", fontSize=8.2, leading=11.2, textColor=MUT)
S["cell"] = ParagraphStyle("cell", fontName="Helvetica", fontSize=8.8, leading=12, textColor=SLATE)
S["cellb"] = ParagraphStyle("cellb", parent=S["cell"], fontName="Helvetica-Bold")
S["cellw"] = ParagraphStyle("cellw", parent=S["cell"], textColor=white)
S["est"] = ParagraphStyle("est", fontName="Helvetica-Bold", fontSize=11.5, leading=15.5, textColor=NAVY, alignment=TA_LEFT)
S["cover_title"] = ParagraphStyle("ct", fontName="Helvetica-Bold", fontSize=15, leading=19, textColor=NAVY, spaceAfter=10)

FOOTER = ("Summary of medical records for planning/underwriting use — not a medical record, diagnosis, or medical advice, "
          "and not authored by the treating physicians. LE figure is an actuarial approximation, not a prediction.")


def P(text: str, style="body") -> Paragraph:
    return Paragraph(escape(str(text or "")), S[style])


def rule(color=RULE, th=0.8, before=2, after=6):
    t = Table([[""]], colWidths=[W], rowHeights=[th])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), th, color)]))
    return [Spacer(1, before), t, Spacer(1, after)]


def box(paras: list[str], bg, bd, pad=8, style="body"):
    inner = [[Paragraph(p, S[style])] for p in paras]
    t = Table(inner, colWidths=[W - 2 * pad])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg), ("BOX", (0, 0), (-1, -1), 1, bd),
        ("LEFTPADDING", (0, 0), (-1, -1), pad), ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("TOPPADDING", (0, 0), (-1, 0), pad), ("BOTTOMPADDING", (0, -1), (-1, -1), pad)]))
    return t


def kv_table(rows, kw=1.85 * inch):
    data = [[P(k, "cellb"), P(v, "cell")] for k, v in rows]
    t = Table(data, colWidths=[kw, W - kw])
    t.setStyle(TableStyle([
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [white, LROW]), ("GRID", (0, 0), (-1, -1), 0.5, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return t


def grid_table(header, rows, widths):
    data = [[P(h, "cellw") for h in header]] + [[P(c, "cell") for c in r] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, LROW]),
        ("GRID", (0, 0), (-1, -1), 0.5, RULE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return t


def bullets(items):
    return [Paragraph(escape(str(i)), S["bullet"], bulletText="•") for i in items]


def _footer(c, doc):
    c.saveState()
    c.setStrokeColor(RULE); c.setLineWidth(0.6)
    c.line(M, 0.62 * inch, PW - M, 0.62 * inch)
    c.setFont("Helvetica", 6.8); c.setFillColor(MUT)
    cut = FOOTER.rfind(" ", 0, 150)
    c.drawString(M, 0.48 * inch, FOOTER[:cut]); c.drawString(M, 0.37 * inch, FOOTER[cut + 1:])
    c.setFont("Helvetica-Bold", 8); c.setFillColor(NAVY)
    c.drawRightString(PW - M, 0.42 * inch, "Page %d" % doc.page)
    c.restoreState()


def _cover(c, doc, meta):
    c.saveState()
    c.setFillColor(NAVY); c.rect(0, PH - 2.35 * inch, PW, 2.35 * inch, stroke=0, fill=1)
    c.setFillColor(white); c.setFont("Helvetica-Bold", 26); c.drawString(M, PH - 1.05 * inch, "POEL LIFE")
    c.setFillColor(ACC); c.rect(M, PH - 1.22 * inch, 1.7 * inch, 0.045 * inch, stroke=0, fill=1)
    c.setFillColor(white); c.setFont("Helvetica-Bold", 15.5)
    c.drawString(M, PH - 1.62 * inch, meta["title"])
    c.setFillColor(HexColor("#cfdae6")); c.setFont("Helvetica", 10)
    c.drawString(M, PH - 1.92 * inch, "Confidential records-based review — de-identified working copy")
    c.setFont("Helvetica", 9)
    c.drawRightString(PW - M, PH - 1.05 * inch, "Generated: %s" % meta["gen"])
    c.drawRightString(PW - M, PH - 1.22 * inch, "Subject: %s" % meta["ini"])
    c.restoreState()
    _footer(c, doc)


def build_pdf(report: dict, path: str) -> str:
    m = report["meta"]
    le = report.get("le")
    ini = m.get("initials") or "—"
    meta = {"ini": ini, "gen": date.today().strftime("%B %d, %Y"),
            "title": "Medical Summary & Estimated Life-Expectancy Analysis" if le else "Medical Summary"}

    doc = BaseDocTemplate(path, pagesize=letter, leftMargin=M, rightMargin=M, topMargin=0.9 * inch,
                          bottomMargin=0.85 * inch, title="%s Medical Summary and LE Analysis" % ini,
                          author="Poel Life", subject="Confidential — de-identified")
    cover_fr = Frame(M, 0.85 * inch, W, PH - 2.35 * inch - 1.15 * inch, id="cf")
    body_fr = Frame(M, 0.85 * inch, W, PH - 0.9 * inch - 0.85 * inch - 0.35 * inch, id="bf")

    def _hdr(c, d):
        c.saveState()
        c.setFillColor(NAVY); c.rect(0, PH - 0.52 * inch, PW, 0.52 * inch, stroke=0, fill=1)
        c.setFillColor(white); c.setFont("Helvetica-Bold", 10.5); c.drawString(M, PH - 0.34 * inch, "POEL LIFE")
        c.setFillColor(HexColor("#cfdae6")); c.setFont("Helvetica", 8.6)
        c.drawRightString(PW - M, PH - 0.34 * inch, "Medical Summary & LE Analysis  |  %s  |  Confidential" % ini)
        c.restoreState(); _footer(c, d)

    doc.addPageTemplates([PageTemplate(id="cover", frames=[cover_fr], onPage=lambda c, d: _cover(c, d, meta)),
                          PageTemplate(id="body", frames=[body_fr], onPage=_hdr)])

    st = []
    # ---------------- cover
    st.append(Spacer(1, 6))
    st.append(kv_table([
        ("Proposed insured", f"{ini} (name withheld)"),
        ("Sex / DOB / age", f"{m.get('sex','')} • {m.get('dob','')} • {m.get('age','')} years"),
        ("Identifiers", "MRN on file • SSN on file (masked)"),
        ("Residence", m.get("state", "")),
        ("Source records", m.get("source_records", "")),
        ("Most recent data", m.get("most_recent_data", "")),
        ("Document purpose", "Consolidated clinical summary" + (" + rubric-based LE estimate" if le else "")),
    ]))
    st.append(Spacer(1, 10))
    disc = ("<b>Important — please read.</b> A plain-language synthesis of medical records for planning and underwriting. "
            "It is not a medical record, diagnosis, or medical advice, and was not authored by the treating physicians. ")
    if le:
        disc += ("The LE section applies the Poel Life LE Estimation Rubric (v2.0); it is an epidemiological/actuarial "
                 "approximation, not a prediction, and was not prepared by a licensed actuary, physician, or medical underwriter. ")
    if report.get("verification_notes"):
        disc += "Portions of the source may have been read by OCR — verify critical values against the source before any decision."
    st.append(box([disc], WARNB, WARND))
    st.append(Spacer(1, 8))
    sections = ["1. Overview", "2. Problem List"] + \
               [f"{i+3}. {s['title'].split(' (')[0]}" for i, s in enumerate(report.get("systems", []))]
    n = len(sections)
    sections += [f"{n+1}. Medications", f"{n+2}. Social/Family"] + ([f"{n+3}. LE Analysis"] if le else [])
    st.append(Paragraph("<b>Contents:</b> " + " • ".join(escape(s) for s in sections), S["small"]))
    st.append(NextPageTemplate("body")); st.append(PageBreak())

    # ---------------- overview
    st.append(P("1. Patient Overview", "h1")); st += rule()
    st.append(P(report["overview"].get("narrative", "")))
    kf = report["overview"].get("key_facts") or []
    if kf:
        st.append(kv_table(kf)); st.append(Spacer(1, 6))

    st.append(P("2. Allergies & Active Problem List", "h1")); st += rule()
    st.append(Paragraph("<b>Allergies:</b> " + escape(report.get("allergies") or "None documented."), S["bodyl"]))
    st += bullets(report.get("problem_list") or [])

    sec = 3
    for s in report.get("systems", []):
        st.append(P(f"{sec}. {s['title']}", "h1")); st += rule()
        if s.get("narrative"):
            st.append(P(s["narrative"]))
        tl = s.get("timeline") or []
        if tl:
            st.append(grid_table(["Date", "Event"], tl, [1.2 * inch, W - 1.2 * inch])); st.append(Spacer(1, 6))
        st += bullets(s.get("bullets") or [])
        sec += 1

    st.append(P(f"{sec}. Current Medications", "h1")); st += rule()
    meds = report.get("medications") or []
    if meds:
        st.append(grid_table(["Medication", "Dose", "Purpose"], meds, [2.3 * inch, 1.5 * inch, W - 3.8 * inch]))
    else:
        st.append(P("No current medication list documented."))
    sec += 1

    st.append(P(f"{sec}. Social & Family History", "h1")); st += rule()
    st += bullets(report.get("social_family") or [])
    sec += 1

    # ---------------- LE
    if le:
        st.append(P(f"{sec}. Estimated Life-Expectancy Analysis", "h1")); st += rule()
        st.append(Paragraph("<b>Method.</b> " + escape(le.get("method", "")), S["body"]))
        st.append(P("Baseline", "h2")); st.append(P(le.get("baseline", "")))
        if le.get("dominant"):
            st.append(box(["<b>Dominant-condition trigger (Rule R6).</b> " + escape(le["dominant"])], DOMB, DOMD))
            st.append(Spacer(1, 6))
        st.append(P("Factor review", "h2"))
        st.append(grid_table(["Factor", "Direction", "Weight", "Rationale"], le.get("factors") or [],
                             [1.7 * inch, 0.75 * inch, 0.75 * inch, W - 3.2 * inch]))
        st.append(Spacer(1, 6))
        if le.get("modules"):
            st.append(P("Disease-specific modules", "h2")); st += bullets(le["modules"])
        st.append(P("Estimate", "h2"))
        st.append(P(le.get("computation", "")))
        st.append(box([escape(le.get("estimate", ""))], ESTB, ESTD, style="est"))
        st.append(Spacer(1, 6))
        st.append(Paragraph("<b>Key swing factors:</b>", S["bodyl"]))
        st += bullets([f"Downside: {le.get('swing_downside','')}", f"Upside: {le.get('swing_upside','')}"])
        st.append(Spacer(1, 4))
        st.append(Paragraph("<b>Accuracy note.</b> " + escape(le.get("accuracy_note", "")) +
                            f" (Model confidence for this profile: {escape(le.get('confidence',''))}.)", S["body"]))
        st.append(box(["<b>Caveats.</b> " + escape(le.get("caveat", "")) +
                       " Excludes unpredictable events; assumes records reflect current status. Not prepared by a "
                       "licensed actuary, physician, or medical underwriter — confirm with a qualified professional "
                       "before any decision."], WARNB, WARND))

    vn = report.get("verification_notes") or []
    if vn:
        st.append(P("Values to verify against source", "h2")); st += bullets(vn)

    doc.build(st)
    return path
