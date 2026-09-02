"""Offline tests: PDF rendering, extraction (text + OCR), and the API flow with a mocked analyst.
Run: python -m pytest tests -q   (no ANTHROPIC_API_KEY needed)"""
import json, os, subprocess, time
from pathlib import Path
import pytest

HERE = Path(__file__).parent
FIX = json.loads((HERE / "fixture_report.json").read_text())


def _make_pdf(path: Path, scanned: bool):
    from reportlab.pdfgen import canvas
    text = ["POEL TEST RECORDS — patient: initials A.B.", "Creatinine 2.1 mg/dL, eGFR 33", "PSA 0.24 ng/mL, ECOG 1"]
    c = canvas.Canvas(str(path)); c.setFont("Helvetica", 14)
    for i in range(3):
        for j, t in enumerate(text): c.drawString(72, 700 - 30 * j, f"Page {i+1}: {t}")
        c.showPage()
    c.save()
    if scanned:  # rasterise to images and rebuild an image-only PDF
        subprocess.run(["pdftoppm", "-png", "-r", "120", str(path), str(path.with_suffix(""))], check=True)
        imgs = sorted(path.parent.glob(path.stem + "-*.png"))
        from reportlab.lib.pagesizes import letter
        c = canvas.Canvas(str(path), pagesize=letter)
        for im in imgs: c.drawImage(str(im), 0, 0, *letter); c.showPage()
        c.save()


def test_render_pdf(tmp_path):
    from app.report import build_pdf
    out = build_pdf(FIX, str(tmp_path / "r.pdf"))
    txt = subprocess.run(["pdftotext", out, "-"], capture_output=True, text=True).stdout
    assert "POEL LIFE" in txt and "A.B." in txt and "Rule R6" in txt and "3–6 years" in txt
    assert "Page 3" in txt


def test_extract_text_pdf(tmp_path):
    from app.extract import extract_pdf
    p = tmp_path / "t.pdf"; _make_pdf(p, scanned=False)
    ex = extract_pdf(p)
    assert ex.pages == 3 and not ex.ocr_used and "PAGE 3" in ex.text and "eGFR 33" in ex.text


def test_extract_scanned_pdf_ocr(tmp_path):
    from app.extract import extract_pdf
    p = tmp_path / "s.pdf"; _make_pdf(p, scanned=True)
    ex = extract_pdf(p)
    assert ex.ocr_used and ex.ocr_pages == 3 and "PSA 0.24" in ex.text and ex.warnings


def test_api_flow(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_API_KEY", "k"); monkeypatch.setenv("DATA_DIR", str(tmp_path / "cases"))
    import importlib, app.main as main; importlib.reload(main)
    monkeypatch.setattr(main.analyze, "analyze", lambda text, **kw: json.loads(json.dumps(FIX)))
    from fastapi.testclient import TestClient
    c = TestClient(main.app)
    p = tmp_path / "t.pdf"; _make_pdf(p, scanned=False)
    assert c.post("/api/cases", files={"files": ("t.pdf", p.read_bytes(), "application/pdf")}).status_code == 401
    r = c.post("/api/cases", headers={"X-API-Key": "k"}, files={"files": ("t.pdf", p.read_bytes(), "application/pdf")},
               data={"mode": "full"})
    assert r.status_code == 200; cid = r.json()["id"]
    for _ in range(50):
        s = c.get(f"/api/cases/{cid}", headers={"X-API-Key": "k"}).json()
        if s["status"] in ("done", "error"): break
        time.sleep(0.2)
    assert s["status"] == "done", s
    assert s["filename"] == "AB_Medical_Summary_and_LE_Analysis.pdf" and s["summary"]["central_years"] == 4.2
    pdf = c.get(f"/api/cases/{cid}/report.pdf?api_key=k"); assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    assert not (tmp_path / "cases" / cid / "uploads").exists()   # records purged after extraction
    assert c.delete(f"/api/cases/{cid}", headers={"X-API-Key": "k"}).status_code == 200
