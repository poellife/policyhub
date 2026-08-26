# Policy Valuation App

Life-settlement valuation engine (COI backsolve, optimized premiums, 2015 VBT
survival curves, probabilistic IRR pricing) behind a small Flask web UI.

- Upload a case JSON, an InsuriShield workbook, or (with ANTHROPIC_API_KEY
  set) a carrier illustration PDF -> price, metrics, and a downloadable
  interactive Excel workbook.
- JSON API: POST a case JSON to /api/value.
- Deploy: push to GitHub, then Render "New + -> Blueprint" on this repo
  (render.yaml configures everything). Set APP_USER / APP_PASSWORD env vars.
  See README-DEPLOY.md for details and a Docker/self-hosted alternative.

Run locally: pip install -r requirements.txt && python app.py
