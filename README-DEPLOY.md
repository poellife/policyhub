# Deploying the Life-Settlement Valuation web app

A small Flask app around the verified valuation engine. Upload a case JSON,
an InsuriShield workbook, or (with a Claude API key) a carrier illustration
PDF -> get the price, metrics, and a downloadable interactive Excel workbook.
There is also a JSON API at POST /api/value for programmatic use.

## Option A - Docker (recommended)

On any server with Docker:

    unzip insurishield_webapp.zip && cd insurishield_webapp
    docker build -t lsv .
    docker run -d --restart unless-stopped -p 8000:8000 \
      -e APP_USER=jonathan -e APP_PASSWORD='choose-a-strong-password' \
      -e ANTHROPIC_API_KEY=sk-ant-...   `# optional: enables PDF extraction` \
      --name lsv lsv

The app is now at http://your-server:8000. Put it behind HTTPS (below).

## Option B - plain Python + systemd

    unzip insurishield_webapp.zip -d /opt && cd /opt/insurishield_webapp
    python3 -m venv venv && venv/bin/pip install -r requirements.txt
    APP_USER=jonathan APP_PASSWORD=... venv/bin/gunicorn -w 1 --threads 2 --max-requests 25 --max-requests-jitter 5 -t 300 -b 127.0.0.1:8000 app:app

systemd unit (/etc/systemd/system/lsv.service):

    [Unit]
    Description=Life-settlement valuation app
    After=network.target
    [Service]
    WorkingDirectory=/opt/insurishield_webapp
    Environment=APP_USER=jonathan
    Environment=APP_PASSWORD=choose-a-strong-password
    # Environment=ANTHROPIC_API_KEY=sk-ant-...
    ExecStart=/opt/insurishield_webapp/venv/bin/gunicorn -w 1 --threads 2 --max-requests 25 --max-requests-jitter 5 -t 300 -b 127.0.0.1:8000 app:app
    Restart=always
    [Install]
    WantedBy=multi-user.target

    sudo systemctl enable --now lsv

## HTTPS / nginx

    server {
      listen 443 ssl;
      server_name valuation.yourdomain.com;
      # ssl_certificate ...; ssl_certificate_key ...;   (certbot works fine)
      client_max_body_size 25m;
      location / { proxy_pass http://127.0.0.1:8000; proxy_read_timeout 300; }
    }

## Notes

- Set APP_USER/APP_PASSWORD - policy data is sensitive; do not run this open.
- PDF illustration extraction calls the Anthropic API server-side (the PDF is
  sent to Anthropic); review the extraction notes it returns and spot-check
  the ledger before relying on a price. Without an API key, upload the case
  JSON or an InsuriShield workbook instead - those paths are fully local.
- Generated workbooks recalculate automatically when opened in Excel.
- The gunicorn timeout is 300s because a full run (COI backsolve + LE-grid
  build for the workbook) takes ~30-90s; the JSON API without a workbook is
  a few seconds.
- API example:
    curl -X POST -H 'Content-Type: application/json' \
      --data @cases/rossi.json https://valuation.yourdomain.com/api/value

## Valuation history - persistent disk on Render (IMPORTANT)

v4.16 adds /valuations - a history of every run with snapshot metrics and
re-downloadable PDF / Excel / case JSON, plus a JSON feed at /api/valuations
(same basic-auth login) and an iframe-friendly view at /valuations?embed=1
for embedding in the main Poel Capital site.

Render's default disk is EPHEMERAL: every deploy or restart wipes it, taking
the history with it. To make history durable:

1. Render dashboard -> your service -> "Disks" -> Add Disk
   - Name: valuations,  Mount Path: /var/data,  Size: 1 GB (plenty)
2. Service -> Environment -> add:  JOBS_DIR = /var/data/jobs
3. Save; the service redeploys. All future runs (and their downloads)
   survive restarts and deploys.

Note: adding a disk requires a paid Render instance type. Without the disk
everything still works - history simply resets on each deploy.

## Embedding history in the main Poel Capital app

Either link to https://<this-service>/valuations, or embed:

    <iframe src="https://<this-service>/valuations?embed=1"
            style="width:100%;height:700px;border:0"></iframe>

or fetch JSON server-side with the app's basic-auth credentials:

    GET https://<this-service>/api/valuations
    -> {"valuations": [{job, ts, name, insured, face, price, irr, mean_le,
                        prem_y1, be_risk, convention, ...}, ...]}
