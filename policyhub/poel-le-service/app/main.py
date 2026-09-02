"""Poel Life — records-based LE report service (FastAPI).

POST /api/cases            multipart: files[] (PDF/DOCX/TXT), mode=full|summary, initials (optional)
GET  /api/cases/{id}       job status + progress log (+ report meta when done)
GET  /api/cases/{id}/report.pdf
GET  /api/cases/{id}/report.json
DELETE /api/cases/{id}     purge a case immediately
GET  /healthz

Auth: every /api route requires header `X-API-Key: <APP_API_KEY>` (or ?api_key=). The bundled
upload page at / asks for the key once and keeps it in the browser session.
Records are deleted from disk as soon as text is extracted (KEEP_UPLOADS=0), and finished reports
are purged after RETENTION_HOURS.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from . import analyze, extract, report as pdfreport

DATA_DIR = Path(os.getenv("DATA_DIR", "/tmp/poel_cases"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
APP_API_KEY = os.getenv("APP_API_KEY", "")
RETENTION_HOURS = float(os.getenv("RETENTION_HOURS", "24"))
KEEP_UPLOADS = os.getenv("KEEP_UPLOADS", "0") == "1"
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "200"))
ALLOWED = {".pdf", ".docx", ".txt", ".md"}

app = FastAPI(title="Poel Life LE Report Service", version="1.0")
_lock = threading.Lock()


# ------------------------------------------------------------------ auth
def require_key(x_api_key: str | None = Header(default=None), api_key: str | None = Query(default=None)):
    if not APP_API_KEY:
        raise HTTPException(500, "Server misconfigured: APP_API_KEY is not set.")
    supplied = x_api_key or api_key or ""
    if not secrets.compare_digest(supplied, APP_API_KEY):
        raise HTTPException(401, "Invalid or missing API key.")


# ------------------------------------------------------------------ job store (one JSON per case)
def _case_dir(cid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{20}", cid):
        raise HTTPException(404, "Unknown case.")
    return DATA_DIR / cid


def _state_path(cid: str) -> Path:
    return _case_dir(cid) / "state.json"


def _read(cid: str) -> dict:
    p = _state_path(cid)
    if not p.exists():
        raise HTTPException(404, "Unknown case.")
    return json.loads(p.read_text())


def _write(cid: str, state: dict):
    with _lock:
        _state_path(cid).write_text(json.dumps(state, indent=1))


def _log(cid: str, msg: str, **fields):
    s = _read(cid)
    s["log"].append({"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "msg": msg})
    s.update(fields)
    _write(cid, s)


def _purge_expired():
    cutoff = time.time() - RETENTION_HOURS * 3600
    for d in DATA_DIR.iterdir():
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


# ------------------------------------------------------------------ pipeline
def run_case(cid: str):
    d = _case_dir(cid)
    try:
        s = _read(cid)
        files = [d / "uploads" / f for f in s["files"]]
        _log(cid, "Extracting text from records…", status="extracting")
        ex = extract.extract_many(files, progress=lambda m: _log(cid, m))
        if not KEEP_UPLOADS:
            shutil.rmtree(d / "uploads", ignore_errors=True)
        (d / "records.txt").write_text(ex.text, encoding="utf8")
        _log(cid, f"Extracted {ex.pages} pages, {ex.chars:,} characters"
                  + (f" ({ex.ocr_pages} pages via OCR)" if ex.ocr_used else ""),
             status="analyzing", pages=ex.pages, ocr_used=ex.ocr_used)
        if ex.chars < 200:
            raise RuntimeError("No readable text was found in the uploaded records.")

        rep = analyze.analyze(ex.text, summary_only=(s["mode"] == "summary"),
                              ocr_warning=" ".join(ex.warnings), initials_override=s.get("initials", ""),
                              progress=lambda m: _log(cid, m))
        if ex.warnings:
            rep.setdefault("verification_notes", []).insert(0, " ".join(ex.warnings))
        (d / "report.json").write_text(json.dumps(rep, indent=1))
        if not KEEP_UPLOADS:
            (d / "records.txt").unlink(missing_ok=True)

        _log(cid, "Rendering PDF…", status="rendering")
        ini = rep["meta"].get("initials", "XX").replace(".", "").replace(" ", "") or "XX"
        fname = f"{ini}_Medical_Summary_and_LE_Analysis.pdf"
        pdfreport.build_pdf(rep, str(d / "report.pdf"))
        le = rep.get("le") or {}
        _log(cid, "Done.", status="done", filename=fname, finished_at=datetime.now(timezone.utc).isoformat(),
             summary={"initials": rep["meta"].get("initials"), "sex": rep["meta"].get("sex"),
                      "age": rep["meta"].get("age"), "one_liner": rep["meta"].get("summary_of_summary"),
                      "central_years": le.get("central_years"), "range_low": le.get("range_low_years"),
                      "range_high": le.get("range_high_years"), "path": le.get("path"),
                      "confidence": le.get("confidence"), "usage": rep.get("_usage")})
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        _log(cid, f"Error: {e}", status="error", error=str(e))
    finally:
        _purge_expired()


# ------------------------------------------------------------------ routes
@app.get("/healthz")
def healthz():
    return {"ok": True, "model": analyze.MODEL, "retention_hours": RETENTION_HOURS}


@app.post("/api/cases", dependencies=[Depends(require_key)])
async def create_case(background: BackgroundTasks, files: list[UploadFile] = File(...),
                      mode: str = Form("full"), initials: str = Form("")):
    if mode not in ("full", "summary"):
        raise HTTPException(400, "mode must be 'full' or 'summary'.")
    cid = secrets.token_hex(10)
    d = DATA_DIR / cid
    (d / "uploads").mkdir(parents=True)
    names, total = [], 0
    for i, f in enumerate(files):
        ext = Path(f.filename or "").suffix.lower()
        if ext not in ALLOWED:
            shutil.rmtree(d, ignore_errors=True)
            raise HTTPException(400, f"Unsupported file type '{ext}'. Upload PDF, DOCX or TXT.")
        safe = f"{i:02d}_{re.sub(r'[^A-Za-z0-9._-]', '_', Path(f.filename).name)}"
        data = await f.read()
        total += len(data)
        if total > MAX_UPLOAD_MB * 1024 * 1024:
            shutil.rmtree(d, ignore_errors=True)
            raise HTTPException(413, f"Upload exceeds {MAX_UPLOAD_MB} MB.")
        (d / "uploads" / safe).write_bytes(data)
        names.append(safe)
    state = {"id": cid, "status": "queued", "mode": mode, "initials": initials.strip(),
             "files": names, "created_at": datetime.now(timezone.utc).isoformat(), "log": []}
    _write(cid, state)
    background.add_task(run_case, cid)
    return {"id": cid, "status": "queued"}


@app.get("/api/cases/{cid}", dependencies=[Depends(require_key)])
def get_case(cid: str):
    s = _read(cid)
    return {k: v for k, v in s.items() if k not in ("files",)}


@app.get("/api/cases/{cid}/report.pdf", dependencies=[Depends(require_key)])
def get_pdf(cid: str):
    s = _read(cid)
    if s.get("status") != "done":
        raise HTTPException(409, "Report not ready.")
    return FileResponse(_case_dir(cid) / "report.pdf", media_type="application/pdf", filename=s["filename"])


@app.get("/api/cases/{cid}/report.json", dependencies=[Depends(require_key)])
def get_json(cid: str):
    s = _read(cid)
    if s.get("status") != "done":
        raise HTTPException(409, "Report not ready.")
    return JSONResponse(json.loads((_case_dir(cid) / "report.json").read_text()))


@app.delete("/api/cases/{cid}", dependencies=[Depends(require_key)])
def delete_case(cid: str):
    _read(cid)
    shutil.rmtree(_case_dir(cid), ignore_errors=True)
    return {"deleted": cid}


@app.get("/", response_class=HTMLResponse)
def index():
    return (Path(__file__).parent / "static" / "index.html").read_text(encoding="utf8")
