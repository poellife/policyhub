# Poel Life — Records-Based LE Report Service

A small web service that turns an insured's medical records into the Poel Life
**Medical Summary & Estimated Life-Expectancy Analysis** PDF — the same pipeline the Claude
Project runs by hand (ingest → OCR if needed → Rubric v2.0 scoring → branded ReportLab PDF), packaged
so your platform can call it.

```
upload records (PDF/DOCX/TXT)
      │
      ▼
 extract.py   pdftotext; OCR fallback (pdftoppm + tesseract) for scanned pages, page markers kept
      │
      ▼
 analyze.py   Claude API — system prompt = playbook + Rubric v2.0 + worked examples;
              the model must answer via a JSON-schema tool call, so output is always well-formed
      │
      ▼
 report.py    ReportLab, house style (navy masthead, factor table, salmon R6 box, caveat boxes)
      │
      ▼
 {INITIALS}_Medical_Summary_and_LE_Analysis.pdf  (+ report.json for your own UI)
```

## 1. Deploy on Render (GitHub → Render)

1. Copy this folder into your repo (e.g. `services/poel-le/`) or push it as its own repo.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` defines a Docker web service with a
   5 GB disk mounted at `/data`. (If the folder is a sub-directory, set **Root Directory** to it.)
3. Set the two secrets in the Render dashboard:
   - `ANTHROPIC_API_KEY` — your key from console.anthropic.com.
   - `APP_API_KEY` — Render generates one; copy it, your main app sends it as `X-API-Key`.
4. Deploy. `GET https://<service>.onrender.com/healthz` should return `{"ok": true, ...}`.
5. Open `https://<service>.onrender.com/` — the built-in upload page. Paste the access key, drop an
   APS, click **Run case**.

Plan notes: the `starter` plan (512 MB) is fine for digital PDFs. OCR of a 1,000-page scanned APS
takes 15–30 minutes and is happier on `standard`. Free-tier services sleep and would lose
in-flight jobs — don't use the free tier for this.

### Run locally
```bash
cp .env.example .env            # fill in the keys
docker build -t poel-le . && docker run --env-file .env -p 8000:8000 poel-le
# or without Docker (needs poppler-utils + tesseract installed):
pip install -r requirements.txt && uvicorn app.main:app --reload
```

## 2. API (what your LCG app calls)

All `/api` routes need `X-API-Key: <APP_API_KEY>` (or `?api_key=` for browser downloads).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/cases` | multipart: `files` (one or more), `mode` = `full` (default) or `summary`, `initials` (optional override). Returns `{"id": ..., "status": "queued"}` immediately. |
| `GET` | `/api/cases/{id}` | status (`queued → extracting → analyzing → rendering → done` / `error`), progress `log`, and when done a `summary` block (initials, age, central LE, range, path, confidence) + `filename`. |
| `GET` | `/api/cases/{id}/report.pdf` | the branded PDF. |
| `GET` | `/api/cases/{id}/report.json` | the structured report (every section + the LE block with `computation`, `factors`, `modules`). Use this to show results inside your own UI or store them on the case record. |
| `DELETE` | `/api/cases/{id}` | purge now (otherwise auto-purged after `RETENTION_HOURS`). |

### Example — from a Node/Express or Next.js backend
```js
const form = new FormData();
form.append("files", new Blob([pdfBuffer], { type: "application/pdf" }), "aps.pdf");
form.append("mode", "full");
const r = await fetch(`${process.env.POEL_LE_URL}/api/cases`, {
  method: "POST", headers: { "X-API-Key": process.env.POEL_LE_KEY }, body: form });
const { id } = await r.json();
// poll
let s;
do { await new Promise(t => setTimeout(t, 4000));
     s = await (await fetch(`${POEL_LE_URL}/api/cases/${id}`, { headers: { "X-API-Key": KEY } })).json();
} while (!["done", "error"].includes(s.status));
// then stream /api/cases/{id}/report.pdf to the user, and store s.summary on the case
```

### Example — from Python
```python
import requests, time
r = requests.post(f"{URL}/api/cases", headers={"X-API-Key": KEY},
                  files=[("files", open("aps.pdf", "rb"))], data={"mode": "full"})
cid = r.json()["id"]
while (s := requests.get(f"{URL}/api/cases/{cid}", headers={"X-API-Key": KEY}).json())["status"] not in ("done", "error"):
    time.sleep(4)
open(s["filename"], "wb").write(requests.get(f"{URL}/api/cases/{cid}/report.pdf", headers={"X-API-Key": KEY}).content)
```

Keep `APP_API_KEY` server-side in your LCG app; never put it in browser JavaScript. Your app's own
login is what gates who can run cases — this service only trusts the key.

## 3. Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required |
| `APP_API_KEY` | — | required; shared secret for `/api` |
| `ANTHROPIC_MODEL` | `claude-opus-5` | analyst model. `claude-sonnet-5` is ~3–5× cheaper; validate against the back-test set before switching. |
| `ANTHROPIC_CHUNK_MODEL` | same as model | model for the condensation pass on very large files |
| `CHUNK_CHARS` | `600000` | records above this size are condensed chunk-by-chunk first |
| `MAX_OUTPUT_TOKENS` | `16000` | report size ceiling |
| `RETENTION_HOURS` | `24` | finished reports are deleted after this |
| `KEEP_UPLOADS` | `0` | `1` keeps the raw records + extracted text on disk (debugging only) |
| `MAX_UPLOAD_MB` | `200` | |
| `OCR_DPI` / `OCR_CHUNK_PAGES` | `200` / `20` | OCR rasterisation settings |
| `DATA_DIR` | `/tmp/poel_cases` | case storage (Render disk at `/data`) |

## 4. The knowledge files (how to update the model)

`app/knowledge/` holds the three documents the analyst reads on every case:
`playbook.md` (process + de-identification + disclaimers), `rubric_v2.md` (authoritative scoring),
`worked_example.md`. When you recalibrate the rubric in the Claude Project, copy the new text over
these files and redeploy — nothing else needs to change. The system prompt is cache-marked, so the
rubric tokens are cheap on repeated cases.

`app/analyze.py::REPORT_SCHEMA` is the contract between the model and the PDF. Add a field there
and render it in `app/report.py` if you want new sections.

## 5. Privacy & compliance checklist

- Records are deleted from disk the moment text extraction finishes; extracted text is deleted once
  the report is written; reports auto-purge after `RETENTION_HOURS`. Only initials appear in output.
- Put the service behind HTTPS (Render does this) and keep `APP_API_KEY` secret.
- Medical records are PHI. Before production use: sign Anthropic's BAA (available on eligible
  plans — the API does not train on your data, but a BAA formalises it), confirm Render's HIPAA
  posture / BAA for the plan you're on, restrict who in your LCG app can trigger cases, and log
  access. Consider a private network between your app and this service.
- Every report carries the mandatory disclaimers: not a medical record or advice; LE is an
  actuarial approximation, not a prediction; not prepared by a licensed actuary/physician/underwriter.

## 6. Tests
```bash
python -m pytest tests -q      # offline: PDF render, text + OCR extraction, API flow (mocked analyst)
```
A live smoke test: set `ANTHROPIC_API_KEY`, then
`python -c "from app.analyze import analyze; import json; print(json.dumps(analyze(open('records.txt').read()), indent=1))"`.

## 7. Costs (rough)
Opus 5 at $5/M input, $25/M output: a 300-page digital APS (~150k tokens) runs about $1–1.50 per
full report; a 1,200-page package about $3–4 plus a few minutes of OCR CPU. Sonnet 5 is roughly a
third of that.
