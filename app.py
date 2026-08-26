#!/usr/bin/env python3
"""Life-Settlement Valuation web app.

Upload a case JSON or an InsuriShield workbook (or, with ANTHROPIC_API_KEY
set, a carrier illustration PDF), choose the health / IRR inputs, and get the
purchase price plus a downloadable interactive Excel workbook.

Run locally:   python app.py            (http://localhost:8000)
Production:    gunicorn -w 2 -t 300 -b 127.0.0.1:8000 app:app
Optional env:  APP_USER / APP_PASSWORD  -> HTTP basic auth
               ANTHROPIC_API_KEY        -> enables PDF illustration extraction
"""
import os, io, json, re, uuid, tempfile, traceback, datetime as dt
from flask import Flask, request, send_file, render_template_string, abort, Response
from engine.case import Case, extract_case
from engine.runner import run_case
from engine.workbook import build_workbook

APP_VERSION = 'v4.20'
import threading
HEAVY = threading.Semaphore(1)   # one engine/workbook build at a time (memory cap)
app = Flask(__name__)
JOBS_DIR = os.environ.get('JOBS_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jobs'))
os.makedirs(JOBS_DIR, exist_ok=True)

# ------------------------- basic auth (optional) -------------------------
@app.before_request
def _auth():
    if request.path == '/robots.txt': return   # crawlers must be able to read the ban
    user, pw = os.environ.get('APP_USER'), os.environ.get('APP_PASSWORD')
    if not user: return
    a = request.authorization
    if not (a and a.username == user and a.password == pw):
        return Response('Auth required', 401, {'WWW-Authenticate': 'Basic realm="valuation"'})

# ------------------------- keep search engines out ------------------------
@app.after_request
def _noindex(resp):
    resp.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    return resp

@app.route('/robots.txt')
def robots():
    return Response('User-agent: *\nDisallow: /\n', mimetype='text/plain')

PAGE = """
<!doctype html><html><head><meta charset="utf-8"><title>Poel Capital — Policy Valuation</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
 :root{--bg:#ffffff;--bg-soft:#fafafa;--ink:#0a0a0a;--ink-soft:#1a1a1a;--mute:#737373;
       --mute-light:#a3a3a3;--rule:#e5e5e5;--highlight:#fef3c7;--good:#10b981}
 *{box-sizing:border-box}
 body{font-family:'Manrope',-apple-system,sans-serif;max-width:880px;margin:0 auto;
      padding:0 24px 64px;color:var(--ink);background:var(--bg);letter-spacing:-0.01em}
 .topbar{display:flex;justify-content:space-between;align-items:center;padding:28px 0 8px}
 .logo{font-weight:700;font-size:18px;letter-spacing:-0.02em;color:var(--ink);
       display:flex;align-items:center;gap:8px;text-decoration:none}
 .logo-dot{width:6px;height:6px;background:var(--ink);border-radius:50%}
 .tag{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mute);
      text-transform:uppercase;letter-spacing:0.05em}
 h1{font-size:clamp(32px,5vw,52px);font-weight:600;line-height:0.98;
    letter-spacing:-0.04em;margin:28px 0 6px}
 h1 .light{font-weight:300;color:var(--mute)}
 .card{background:var(--bg);border:1px solid var(--rule);border-radius:16px;
       padding:28px 32px;margin:20px 0}
 label{display:block;margin:14px 0 6px;font-family:'JetBrains Mono',monospace;
       font-size:11px;color:var(--mute);text-transform:uppercase;letter-spacing:0.05em}
 input,select{padding:12px 14px;border:1px solid var(--rule);border-radius:10px;
       font-family:inherit;font-size:15px;width:15rem;background:var(--bg);color:var(--ink)}
 input:focus,select:focus{outline:none;border-color:var(--ink)}
 input[type=file]{width:100%;background:var(--bg-soft)}
 button{display:inline-flex;align-items:center;gap:10px;margin-top:22px;
       background:var(--ink);color:var(--bg);border:none;border-radius:100px;
       padding:16px 28px;font-family:inherit;font-size:14px;font-weight:500;
       letter-spacing:-0.01em;cursor:pointer;transition:all .25s ease}
 button:hover{opacity:.85} button:disabled{opacity:.5;cursor:wait}
 .row{display:flex;gap:2.5rem;flex-wrap:wrap}
 .muted{color:var(--mute);font-size:13px;line-height:1.5}
 table{border-collapse:collapse;margin:14px 0;width:100%}
 td{padding:9px 4px;border-bottom:1px solid var(--rule);font-size:14px}
 td:first-child{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mute);
       text-transform:uppercase;letter-spacing:0.05em}
 .big{font-size:clamp(40px,6vw,64px);font-weight:700;line-height:1;
      letter-spacing:-0.04em;margin:6px 0 4px}
 .err{color:#a01212;white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:12px}
 a.btn{display:inline-block;margin:14px 12px 0 0;background:var(--ink);color:var(--bg);
      text-decoration:none;border-radius:100px;padding:13px 24px;font-size:14px;font-weight:500}
 a.btn.alt{background:transparent;color:var(--ink);border:1px solid var(--rule)}
 .dlbtn{display:inline-block;margin:14px 0 0 0;background:var(--ink);color:var(--bg);
   border:0;border-radius:100px;padding:13px 24px;font-size:14px;font-weight:500;
   font-family:inherit;cursor:pointer}
 .dlbtn:hover{opacity:.85}
 #progress{display:none;margin-top:22px;padding:16px 20px;background:var(--bg-soft);
      border:1px solid var(--rule);border-radius:12px;font-size:14px}
 #clock{font-family:'JetBrains Mono',monospace;color:var(--mute);font-size:12px}
 #bar-track{margin-top:14px;height:8px;background:var(--rule);border-radius:100px;overflow:hidden}
 #bar-fill{height:100%;width:0%;background:var(--ink);border-radius:100px;
   transition:width .9s ease;position:relative}
 #bar-fill::after{content:'';position:absolute;inset:0;
   background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);
   animation:shimmer 1.6s infinite}
 @keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
 #dropzone,#dropzone2{position:relative;border:1.5px dashed var(--rule);border-radius:12px;
   background:var(--bg-soft);padding:34px 20px;text-align:center;cursor:pointer;
   transition:all .2s ease;outline:none}
 #dropzone:hover,#dropzone:focus,#dropzone2:hover,#dropzone2:focus{border-color:var(--mute-light)}
 #dropzone.drag,#dropzone2.drag{border-color:var(--ink);background:var(--highlight)}
 #dropzone.hasfile,#dropzone2.hasfile{border-style:solid;border-color:var(--ink);background:var(--bg)}
 #dropzone input[type=file],#dropzone2 input[type=file]{position:absolute;inset:0;width:100%;height:100%;
   opacity:0;cursor:pointer}
 #dropzone2{padding:18px 16px}
 .dz-title{font-weight:600;font-size:15px;margin-bottom:4px}
 .dz-title.sm{font-size:13.5px;font-weight:500}
 .dz-name{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:500;
   word-break:break-all;margin-right:10px}
 .mono{font-family:'JetBrains Mono',monospace}
</style></head><body>
{% if not embed %}
<div class="topbar">
 <a class="logo" href="https://poelcapital.com"><span class="logo-dot"></span>Poel Capital</a>
 <span style="display:flex;gap:18px;align-items:center">
   <a class="tag" style="text-decoration:none" href="/valuations">Valuation history</a>
   <span class="tag">Internal &middot; Pricing Desk &middot; {{version}}</span>
 </span>
</div>
{% if not history %}<h1>Policy valuation.<br><span class="light">Priced in minutes.</span></h1>
{% else %}<h1>Valuation history.<br><span class="light">Every run, on file.</span></h1>{% endif %}
{% endif %}
{% if has_result %}
<div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
  <div>
    <b>Pricing complete.</b>
    <div class="muted" style="margin-top:4px">Download the report, workbook, and case JSON below. Start fresh to price another policy.</div>
  </div>
  <a class="btn" style="margin:0" href="/">Price another policy &#8594;</a>
</div>
{% elif not history %}
<div class="card"><form id="valform" method="post" action="/value" enctype="multipart/form-data">
 <div id="formfields">
 <label>Policy documents</label>
 <div id="dropzone" tabindex="0">
   <input type="file" name="files" id="fileinput" multiple accept=".pdf,.xlsx,.json">
   <div id="dz-idle">
     <div class="dz-title">Drag &amp; drop all documents here</div>
     <div class="muted">illustration &middot; policy contract &middot; annual statement &middot; LE report &mdash; together, or click to browse</div>
   </div>
   <div id="dz-file" style="display:none;text-align:left"></div>
 </div>
 <div class="muted" style="margin-top:8px">Upload everything you have in one go: the in-force illustration (required for a new pricing),
 the policy contract (charges &amp; surrender schedule), the latest annual statement (current account value), and LE reports (life expectancy, applied automatically) &mdash; each document is
 identified automatically and improves accuracy. A case JSON or InsuriShield workbook can be uploaded alone to re-price a saved case.</div>
 <div class="row">
  <div><label>Health input</label>
   <select name="health_type"><option>Mean LE50</option><option>Mortality Multiplier</option></select>
   <label>Health value (months or %)</label><input name="health_value" placeholder="e.g. 90"></div>
  <div><label>Valuation input</label>
   <select name="val_type"><option>IRR</option><option>Purchase Price</option></select>
   <label>Value (% or $)</label><input name="val_value" placeholder="e.g. 15"></div>
  <div><label>Projection crediting % (blank = NGCR)</label>
   <input name="crediting" placeholder="e.g. 3.5">
   <label>Buyer payment frequency</label>
   <select name="pay_freq"><option selected>Quarterly</option><option>Monthly</option><option>Annual</option></select></div>
  <div><label>LE report date (optional)</label>
   <input name="le_date" placeholder="YYYY-MM-DD"></div>
  <div><label>Insured DOB override (optional)</label>
   <input name="dob" placeholder="YYYY-MM-DD"></div>
  <div><label>Valuation date (optional)</label>
   <input name="vd" placeholder="YYYY-MM-DD &middot; default today"></div>
  <div><label>Current account value (optional)</label>
   <input name="av_now" placeholder="from latest statement"></div>
  <div><label>AV as-of date</label>
   <input name="av_date" placeholder="YYYY-MM-DD"></div>
  <div><label>Current-year premium</label>
   <select name="curr_prem"><option selected>Paid by seller</option><option>Due at purchase</option></select></div>
  <div><label>Pricing convention</label>
   <select name="convention"><option selected>Colva-match</option><option>InsuriShield classic</option></select></div>
 </div>
 <div class="muted" style="margin-top:14px">Leave health/valuation blank to use the values saved in the uploaded file (case JSON / InsuriShield only).</div>
 <button id="runbtn">Run valuation
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7H13M13 7L7 1M13 7L7 13" stroke="currentColor" stroke-width="1.6"/></svg>
 </button>
 </div><!-- /formfields -->
 <div id="runsummary" style="display:none;font-size:14px"></div>
 <div id="progress">
   <div style="display:flex;justify-content:space-between;align-items:baseline">
     <b>Pricing in progress</b> <span id="clock"></span>
   </div>
   <div id="bar-track"><div id="bar-fill"></div></div>
   <div id="stage" style="margin-top:10px;font-size:14px"></div>
   <div id="stay" style="margin-top:10px;padding:10px 14px;background:var(--highlight);
        border-radius:8px;font-size:13px;font-weight:600">
     &#9888;&#65039; Keep this tab open &mdash; pricing takes 2&ndash;5 minutes. Closing or refreshing the page cancels the run.
   </div>
 </div>
</form></div>
{% endif %}
{{ body|safe }}
<script>
if(!document.getElementById('valform')){/* results view: no form on page */}
else {
(function(){
  var dz=document.getElementById('dropzone'), inp=document.getElementById('fileinput');
  if(!dz||!inp) return;
  var store=new DataTransfer();
  function render(){
    inp.files=store.files;
    var box=document.getElementById('dz-file'), idle=document.getElementById('dz-idle');
    if(!store.files.length){ dz.classList.remove('hasfile'); idle.style.display='block'; box.style.display='none'; return; }
    dz.classList.add('hasfile'); idle.style.display='none'; box.style.display='block';
    var html='';
    for(var i=0;i<store.files.length;i++){
      var f=store.files[i];
      html+='<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">'
          +'<span class="dz-name mono">'+f.name+'</span>'
          +'<span class="muted">('+(f.size/1024/1024).toFixed(2)+' MB) '
          +'<a href="#" data-i="'+i+'" class="dz-rm" style="text-decoration:underline">remove</a></span></div>';
    }
    html+='<div class="muted" style="margin-top:6px;text-align:center">drop more files to add them</div>';
    box.innerHTML=html;
    Array.prototype.forEach.call(box.querySelectorAll('.dz-rm'),function(a){
      a.addEventListener('click',function(e){
        e.preventDefault(); e.stopPropagation();
        var keep=new DataTransfer();
        for(var j=0;j<store.files.length;j++){ if(j!=+a.dataset.i) keep.items.add(store.files[j]); }
        store=keep; render();
      });
    });
  }
  function addFiles(fl){
    for(var i=0;i<fl.length;i++){
      var f=fl[i], dup=false;
      for(var j=0;j<store.files.length;j++){
        if(store.files[j].name===f.name && store.files[j].size===f.size){ dup=true; break; }
      }
      if(!dup) store.items.add(f);
    }
    render();
  }
  inp.addEventListener('change', function(){ addFiles(inp.files); });
  ['dragenter','dragover'].forEach(function(ev){
    dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.add('drag');});
  });
  ['dragleave','drop'].forEach(function(ev){
    dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.remove('drag');});
  });
  dz.addEventListener('drop', function(e){ addFiles(e.dataTransfer.files); });
  ['dragover','drop'].forEach(function(ev){
    document.body.addEventListener(ev,function(e){
      if(e.target.closest && e.target.closest('#dropzone')) return;
      e.preventDefault();
      if(ev==='drop' && e.dataTransfer.files.length){
        addFiles(e.dataTransfer.files);
        dz.scrollIntoView({behavior:'smooth',block:'center'});
      }
    });
  });
})();
document.getElementById('valform').addEventListener('submit', function(){
  var b=document.getElementById('runbtn'); b.disabled=true;
  var fl=document.getElementById('fileinput').files, names=[], isPdf=false;
  for(var i=0;i<fl.length;i++){ names.push(fl[i].name); if(/\.pdf$/i.test(fl[i].name)) isPdf=true; }
  var hv=document.querySelector('input[name=health_value]').value,
      ht=document.querySelector('select[name=health_type]').value,
      vv=document.querySelector('input[name=val_value]').value,
      vt=document.querySelector('select[name=val_type]').value;
  var pf=document.querySelector('select[name=pay_freq]').value;
  var recap='<span class="tag">Pricing</span><div style="margin-top:6px" class="dz-name mono">'+names.join('  +  ')+'</div>'
    +'<div class="muted" style="margin-top:4px">'+ht+(hv?(' = '+hv):' (from file)')+' &middot; '+vt+(vv?(' = '+vv):' (from file)')+' &middot; '+pf+' payments</div>';
  setTimeout(function(){
    document.getElementById('formfields').style.display='none';
    var rs=document.getElementById('runsummary'); rs.innerHTML=recap; rs.style.display='block';
  },0);
  var stages = isPdf ? [
      [0,   'Uploading the illustration\u2026'],
      [8,   'Claude is reading the ledger, charges, and insured details\u2026'],
      [75,  'Backsolving cost-of-insurance rates from the ledger\u2026'],
      [115, 'Optimizing the premium schedule month by month\u2026'],
      [150, 'Building survival curves and pricing the cash flows\u2026'],
      [190, 'Generating the Excel workbook\u2026'],
      [240, 'Finishing up \u2014 almost there\u2026']
    ] : [
      [0,   'Uploading the file\u2026'],
      [4,   'Backsolving cost-of-insurance rates from the ledger\u2026'],
      [20,  'Optimizing the premium schedule month by month\u2026'],
      [40,  'Building survival curves and pricing the cash flows\u2026'],
      [60,  'Generating the Excel workbook\u2026'],
      [110, 'Finishing up \u2014 almost there\u2026']
    ];
  var tau = isPdf ? 110 : 40;   // seconds; bar approaches 95% on this timescale
  document.getElementById('progress').style.display='block';
  document.getElementById('progress').scrollIntoView({behavior:'smooth',block:'nearest'});
  var t0=Date.now();
  setInterval(function(){
    var t=(Date.now()-t0)/1000;
    var m=Math.floor(t/60), sec=Math.round(t%60);
    document.getElementById('clock').textContent=(m?m+'m ':'')+sec+'s elapsed';
    var pct=95*(1-Math.exp(-t/tau));
    document.getElementById('bar-fill').style.width=pct.toFixed(1)+'%';
    var label=stages[0][1];
    for(var i=0;i<stages.length;i++){ if(t>=stages[i][0]) label=stages[i][1]; }
    document.getElementById('stage').textContent=label;
  },900);
});
}
</script>
</body></html>"""

RESULT = """
<div class="card">
 <span class="tag">{{name}}</span>
 {% if mode == 'IRR' %}
   <div class="big">${{price}}</div>
   <div class="muted">Purchase price at {{val}}% IRR</div>
 {% else %}
   <div class="big">{{irr}}%</div>
   <div class="muted">Implied IRR at ${{val}} purchase price</div>
 {% endif %}
 <table>
  <tr><td>Health input</td><td>{{health}}</td></tr>
  <tr><td>Implied multiplier / mean LE</td><td>{{mm}}% &middot; {{mean_le}} months (median {{med_le}})</td></tr>
  <tr><td>Breakeven risk</td><td>{{be}}</td></tr>
  <tr><td>P(survive to schedule end)</td><td>{{pm}}</td></tr>
  <tr><td>Buyer premiums, year 1 / total</td><td>${{p1}} / ${{ptot}}</td></tr>
  <tr><td>Projection crediting</td><td>{{cred}}%</td></tr>
  <tr><td>Buyer payment frequency</td><td>{{payfreq}}</td></tr>
 </table>
 <div style="display:flex;flex-wrap:wrap;gap:0 12px;align-items:center">
 <form method="post" action="/regen/report" style="display:inline">
   <input type="hidden" name="case_b64" value="{{case_b64}}">
   <input type="hidden" name="job" value="{{job}}">
   <button class="dlbtn" type="submit">Download pricing report (.pdf)</button></form>
 <form method="post" action="/regen/workbook" style="display:inline">
   <input type="hidden" name="case_b64" value="{{case_b64}}">
   <input type="hidden" name="job" value="{{job}}">
   <button class="dlbtn" type="submit">Download workbook (.xlsx)</button></form>
 <a class="btn alt" download="{{case_fn}}" href="data:application/json;base64,{{case_b64}}">Download case JSON</a>
 </div>
 <div class="muted" style="margin-top:8px">Downloads rebuild themselves if the server has restarted &mdash; a rebuilt workbook can take up to a minute; the PDF a few seconds.</div>
 {% if crosscheck %}
 <div style="margin-top:16px;padding:12px 16px;border-radius:10px;font-size:13.5px;
      background:{{'#ecfdf5' if crosscheck.ok else ('#fef2f2' if crosscheck.ok == False else 'var(--bg-soft)')}};
      border:1px solid {{'#a7f3d0' if crosscheck.ok else ('#fecaca' if crosscheck.ok == False else 'var(--rule)')}}">
   <b>{% if crosscheck.ok %}&#10003;{% elif crosscheck.ok == False %}&#9888;&#65039;{% else %}&#8505;&#65039;{% endif %}</b>
   {{crosscheck.verdict}}
   {% if crosscheck.mismatches %}<ul style="margin:6px 0 0 18px;padding:0">
     {% for m in crosscheck.mismatches %}<li>{{m}}</li>{% endfor %}</ul>{% endif %}
 </div>
 {% endif %}
 {% if completeness %}
 <div style="margin-top:16px;padding:14px 16px;border-radius:10px;background:var(--bg-soft);
      border:1px solid var(--rule)">
  <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px">
    <b style="font-size:14px">Input completeness</b>
    <span class="muted" style="font-size:12.5px">{{comp_head}}</span>
  </div>
  <table style="margin-top:8px;font-size:13px">
  {% for c in completeness %}
   <tr>
    <td style="white-space:nowrap;vertical-align:top;padding-right:10px">
      <span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;
        background:{{'#10b981' if c.status=='ok' else ('#f59e0b' if c.status=='warn' else '#ef4444')}}"></span>{{c.label}}</td>
    <td style="white-space:nowrap;vertical-align:top;padding-right:10px" class="muted">{{c.source}}</td>
    <td style="vertical-align:top">{{c.note}}</td>
   </tr>
  {% endfor %}
  </table>
 </div>
 {% endif %}
 {% if ledger_rows %}
 <details style="margin-top:14px">
  <summary class="tag" style="cursor:pointer">Extracted ledger ({{ledger_rows|length}} policy years) &mdash; click to review</summary>
  <div style="max-height:300px;overflow:auto;margin-top:8px">
  <table><tr><td>YEAR</td><td style="text-align:right">PREMIUM</td><td style="text-align:right">NDB</td><td style="text-align:right">ACCOUNT VALUE</td><td style="text-align:right">CSV</td></tr>
  {% for py, prem, ndb, av, csv in ledger_rows %}
  <tr><td>{{py}}</td><td style="text-align:right">{{'{:,.0f}'.format(prem or 0)}}</td><td style="text-align:right">{{'{:,.0f}'.format(ndb or 0)}}</td><td style="text-align:right">{{'{:,.0f}'.format(av or 0)}}</td><td style="text-align:right">{{'{:,.0f}'.format(csv or 0)}}</td></tr>
  {% endfor %}</table></div>
 </details>
 {% endif %}
 {% if notes %}<div class="muted" style="margin-top:14px">Assumptions: {{notes}}</div>{% endif %}
</div>"""

PAGE_BUDGET = 95        # the extraction API accepts at most 100 PDF pages per request
TOKEN_BUDGET = 160_000  # documents' share of the 200K context (prompt + output need the rest)
BYTE_BUDGET = 18_000_000  # raw PDF bytes per request: base64 inflates by 4/3 and the
                          # API rejects requests over ~32MB, so 18MB raw ≈ 24MB encoded
                          # leaves room for the prompt (scanned PDFs hit this first)

def _est_tokens(b, pages):
    """Rough token cost of a PDF in the extraction request: ~1,600/page of
    imagery plus the text layer at ~4 characters per token."""
    import pdfplumber
    chars = 0
    sample = 0
    try:
        with pdfplumber.open(io.BytesIO(b)) as p:
            sample = min(len(p.pages), 8)
            for pg in p.pages[:sample]:
                chars += len(pg.extract_text() or '')
                try: pg.flush_cache()
                except Exception: pass
    except Exception:
        pass
    per_page_chars = (chars / sample) if sample else 1500
    return int(pages * (1600 + per_page_chars/4.0))

def _page_count(b):
    import pdfplumber
    try:
        with pdfplumber.open(io.BytesIO(b)) as p:
            return len(p.pages)
    except Exception:
        return max(1, len(b)//3000)             # rough fallback estimate

def _guess_role(fn, b):
    """Cheap local role guess (filename + first-pages text) used ONLY to
    prioritize documents when the batch exceeds the API page limit."""
    name = fn.lower()
    if 'illus' in name or 'inforce' in name or 'in-force' in name: return 'illustration'
    if re.search(r'(^|[^a-z])le([^a-z]|$)', name) or 'life expectancy' in name \
            or any(p in name for p in ('lsi','avs','fasano','21st','predictive','isc')):
        return 'le_report'
    if 'statement' in name or 'stmt' in name: return 'statement'
    if 'policy' in name or 'contract' in name: return 'contract'
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(b)) as p:
            t = ' '.join((pg.extract_text() or '') for pg in p.pages[:3]).lower()
        if 'life expectancy' in t or 'mortality report' in t: return 'le_report'
        if 'illustration' in t: return 'illustration'
        if 'statement' in t: return 'statement'
        if 'endorsement' in t or 'contract data' in t or 'schedule of benefits' in t: return 'contract'
    except Exception:
        pass
    return 'unknown'

def _first_pages(b, n):
    """First n pages of a PDF as new PDF bytes (pypdfium2)."""
    import pypdfium2 as pdfium
    src = pdfium.PdfDocument(b)
    dst = pdfium.PdfDocument.new()
    dst.import_pages(src, pages=list(range(min(n, len(src)))))
    buf = io.BytesIO()
    dst.save(buf)
    dst.close(); src.close()
    return buf.getvalue()

def _fit_page_budget(docs, token_budget=TOKEN_BUDGET, byte_budget=None):
    """Keep documents whole within the API page, context-token AND request-byte
    budgets (the API rejects requests over ~32MB; base64 inflates PDFs by 4/3),
    prioritizing illustrations, then the policy contract, then statements.
    Returns (docs_to_send, note) — note is '' when nothing was dropped."""
    if byte_budget is None: byte_budget = BYTE_BUDGET
    counts = {fn: _page_count(b) for fn, b in docs}
    toks = {fn: _est_tokens(b, counts[fn]) for fn, b in docs}
    sizes = {fn: len(b) for fn, b in docs}
    if sum(counts.values()) <= PAGE_BUDGET and sum(toks.values()) <= token_budget \
            and sum(sizes.values()) <= byte_budget:
        return docs, ''
    prio = {'illustration': 0, 'le_report': 1, 'contract': 2, 'statement': 3, 'unknown': 4}
    order = sorted(docs, key=lambda d: (prio.get(_guess_role(*d), 3), counts[d[0]]))
    picked, used_p, used_t, used_b, omitted = [], 0, 0, 0, []
    for fn, b in order:
        if used_p + counts[fn] <= PAGE_BUDGET and used_t + toks[fn] <= token_budget \
                and used_b + sizes[fn] <= byte_budget:
            picked.append(fn); used_p += counts[fn]; used_t += toks[fn]; used_b += sizes[fn]
        else:
            omitted.append(f'{fn} ({counts[fn]} pages, {sizes[fn]//1_000_000}MB)')
    kept = [(fn, b) for fn, b in docs if fn in picked]   # original order
    if not kept:                                          # one giant document
        fn, b = order[0]
        per_page_tok = toks[fn]/max(1, counts[fn])
        per_page_byte = sizes[fn]/max(1, counts[fn])
        n_allowed = max(5, min(PAGE_BUDGET, int(token_budget/per_page_tok),
                               int(byte_budget/per_page_byte)))
        try:
            return [(fn, _first_pages(b, n_allowed))], (
                f' {fn} has {counts[fn]} pages - only the first {n_allowed} were '
                f'extracted (API size limit); if the ledger sits beyond that, upload a '
                f'version containing just the illustration pages;')
        except Exception:
            raise ValueError(
                f'{fn} has {counts[fn]} pages, above the extraction size limit. '
                f'Upload a shorter version containing the illustration ledger '
                f'and summary pages.')
    note = (f' the documents total {sum(counts.values())} PDF pages '
            f'(~{sum(toks.values())//1000}K tokens), above the extraction size limit - '
            f'kept whole: ' + ', '.join(fn for fn, _ in kept) + '; NOT extracted: '
            + ', '.join(omitted) + ' (re-run with fewer/shorter documents if an '
            'omitted file matters);')
    return kept, note

def _pdfs_to_case(docs):
    """Extract a case from one or more policy PDFs — an in-force illustration
    (required: source of the annual ledger) plus, optionally, the policy
    contract (governs charges/dates) and the most recent annual statement
    (current account value) — via the Anthropic API. The model identifies
    each document's role itself; returns (case, notes, roles)."""
    import anthropic, base64
    guide = open(os.path.join(os.path.dirname(__file__), 'references',
                              'illustration_extraction.md')).read()
    example = open(os.path.join(os.path.dirname(__file__), 'cases', 'rossi.json')).read()
    client = anthropic.Anthropic()
    def _content_for(docs_f):
        content = []
        for i, (fn, raw) in enumerate(docs_f, 1):
            content.append({"type": "text",
                            "text": f'DOCUMENT {i} of {len(docs_f)} — filename: "{fn}"'})
            content.append({"type": "document",
                            "source": {"type": "base64", "media_type": "application/pdf",
                                       "data": base64.b64encode(raw).decode()}})
        content.append(_INSTR)
        return content
    _INSTR = ({"type": "text", "text":
        "The documents above all relate to ONE life-insurance policy. FIRST identify each "
        "document's role: 'illustration' (an in-force / carrier illustration containing the "
        "annual projection ledger), 'contract' (the policy contract / policy specification "
        "pages), 'statement' (an annual or quarterly policy statement showing the current "
        "account value), or 'other'. Report the roles in a top-level key '_source_roles' "
        "mapping each filename (exactly as given above) to its role. THEN extract ONE case "
        "JSON (schema below) for the policy, combining the documents as follows:\n"
        "- The annual LEDGER comes from the illustration (current / non-guaranteed basis), "
        "per the extraction guide.\n"
        "- MULTIPLE ILLUSTRATION RUNS: if the documents contain more than one illustration "
        "run (separate PDFs of the same policy, or several runs bundled in one PDF), "
        "evaluate them all and CHOOSE THE BEST ONE for the ledger, preferring in order: "
        "(1) a current-assumptions run with real account values over a guaranteed-basis "
        "run, (2) the most recent illustration / policy-values date, (3) premiums carried "
        "furthest (to maturity is ideal), (4) a level premium pattern over an irregular "
        "one, (5) more ledger years (better COI calibration). Report EVERY run in a "
        "top-level key '_illustration_runs': a list of objects "
        "{\"source\": filename, \"label\": short description like 'level $501,181/yr to "
        "age 102', \"date\": the run's illustration/policy-values date, \"chosen\": "
        "true/false, \"reason\": one sentence (for the chosen run)}. Exactly ONE run must "
        "have chosen=true, and the case ledger MUST come from that run. Include this key "
        "even when there is only one run.\n"
        "- Some illustrations print several bases side by side (e.g. 'Guaranteed Basis' / "
        "'Basis #1' / 'Basis #2', or 'Guaranteed' / 'Midpoint' / 'Current'). Take Account "
        "Value, Cash Surrender Value and Death Benefit from the CURRENT-COI basis columns "
        "(e.g. Basis #1), NEVER from the guaranteed columns - guaranteed columns are often "
        "all zero even when the policy has real account value. A policy is only an NLG "
        "zero-AV case if the current-basis account values are zero too.\n"
        "- WARNING: some PDFs have a corrupted text layer (text extracts as garbled "
        "characters). Read every value from the RENDERED PAGE as it appears visually; if "
        "the text seems garbled, trust the visual table layout only and say so in "
        "_extraction_notes.\n"
        "- If the header states a current Cash Surrender Value / Account Value as of the "
        "illustration date, use it for av_at_id.\n"
        "- The 'Premium Outlay' / 'Planned Premium' column IS the ledger premium: "
        "transcribe each year's printed outlay exactly; never return 0 for a year whose "
        "printed outlay is non-zero.\n"
        "- LEDGER ROW ALIGNMENT: each ledger entry must come from ONE printed row - the "
        "Year, Age, Premium Outlay, Account Value, CSV and Death Benefit that appear "
        "TOGETHER on that row. Key entries by the PRINTED policy-year numbers exactly; "
        "never invent years that are not printed and never pair one year's premium with "
        "another year's account value. SELF-CHECK before answering: in any year with "
        "zero premium outlay the account value cannot GROW faster than the credited "
        "interest - if your draft ledger shows that, you misaligned rows; re-read the "
        "table and fix it.\n"
        "- CSV: when the illustration prints a cash surrender value equal to the account "
        "value, transcribe that value - do not output 0 (0 is only correct when the "
        "printed CSV is 0).\n"
        "- Include each ledger row's printed insured age as 'age' in that row's dict "
        "(used to sanity-check the DOB). The header 'Age' of an in-force illustration is "
        "AMBIGUOUS (issue age vs current age): derive the DOB so the LEDGER's year/age "
        "columns are consistent (e.g. policy year 18 showing age 92 on a 2007 policy "
        "means the insured turns 92 in policy year 18, so the header age was the issue "
        "age). State which interpretation you used in _extraction_notes.\n"
        f"- Set 'vd' (valuation date) to today, {dt.date.today().isoformat()}, not the "
        "illustration date, unless a document explicitly dictates a valuation date.\n"
        "- LAPSE BASIS: read the illustration's lapse/termination language. Set "
        "'optimize_basis' to 'CSV' when the policy may terminate when the CASH SURRENDER "
        "value is insufficient (most products), or 'AV' when termination depends only on "
        "the ACCOUNT value (surrender charges never cause lapse there). Default 'CSV' "
        "when unclear.\n"
        "- LE REPORTS: a document may be a LIFE EXPECTANCY REPORT from an LE underwriter "
        "(LSI, AVS, Fasano, 21st Services, ISC, Predictive Resources, etc.). Give it role "
        "'le_report'. LE reports NEVER contribute ledger data. Report every LE report in a "
        "top-level key '_le_reports': a list of objects {\"provider\": name, "
        "\"report_date\": YYYY-MM-DD (the evaluation/report date), \"mean_le50_months\": "
        "the MEAN LE50 in months, \"median_le_months\": median if stated else null, "
        "\"mortality_multiplier_pct\": the mortality rating percent if stated else null, "
        "\"insured_name\": as printed, \"dob\": YYYY-MM-DD if printed else null, "
        "\"gender\": Male/Female if printed, \"smoker\": Non-Smoker/Smoker if printed}. "
        "When the report prints the LE in years, convert to months. If the LE report's DOB, "
        "gender or smoking status conflicts with the illustration, PREFER THE LE REPORT "
        "(underwriters verify identity) and note the conflict in _extraction_notes.\n"
        "- SURVIVORSHIP: if the policy insures TWO lives (survivorship / second-to-die / "
        "'SUL' / joint-life products), set a top-level key '_survivorship': true AND a "
        "top-level 'insured2' object {\"name\": full name, \"gender\": Male/Female, "
        "\"smoker\": Non-Smoker/Smoker, \"dob\": YYYY-MM-DD or null, \"deceased\": "
        "true/false (true ONLY if a document states that insured has died)}. The case's "
        "main gender/smoker/dob fields hold the OTHER insured; when one insured is "
        "deceased, the SURVIVING insured must be the main one and the deceased one goes "
        "in insured2. The ledger extracts normally.\n"
        "- PREMIUM-REQUIREMENT NO-LAPSE GUARANTEE: if the policy has an NLG rider that "
        "keeps it in force to a stated age as long as a premium requirement is met (e.g. "
        "'No Lapse Guarantee Premium Requirement: $242,301.42 annually', guarantee 'will "
        "not terminate before age 78'), set a top-level 'nlg_requirement' object "
        "{\"annual\": amount, \"to_age\": age} and note it. This is DIFFERENT from the "
        "zero-AV 'nlg' shadow-fund block, which stays reserved for guaranteed-basis "
        "policies with no account values.\n"
        "- If a CONTRACT is present it GOVERNS the charge structure (premium expense charge "
        "-> popc, monthly per-policy fee -> ppc, per-unit charge -> puc, target premium and "
        "above-target load -> popcat_t/popcat), the guaranteed crediting rate (gcr), the "
        "policy date, DOB/issue age, and maturity age; the annual ledger values still come "
        "from the illustration. Note in _extraction_notes that charges came from the "
        "contract and whether they are guaranteed-maximum basis. If the contract contains "
        "a LAPSE PROTECTION / NO-LAPSE GUARANTEE RIDER (e.g. Prudential ICC17 PLI 540 "
        "'Rider to Provide Lapse Protection'), ALWAYS extract the rider data into a "
        "top-level 'nlg' object per section 7 of the extraction guide - contract_date, "
        "issue_age, premium_load (the no-lapse ADMIN charge percent only), monthly_charge "
        "(the flat monthly dollar charge), interest schedule [[through_year, rate],...], "
        "and the FULL coi_per_1000 table keyed by ATTAINED AGE (issue_age + contract_year "
        "- 1) - EVEN WHEN the illustration shows real account values (the app prices the "
        "rider funding path as an alternative). Add 'sales_load': {\"rate\": pct, "
        "\"cap\": $} when the rider states a separate sales-expense charge with a premium "
        "allocation cap, and 'monthly_per_1000' + 'per_1000_until' (YYYY-MM-DD) when the "
        "rider's monthly admin includes a per-1000-of-face component that later drops. "
        "Set policy_date to the contract date when a rider is present.\n"
        "- PREMIUM / TRANSACTION HISTORY: a document listing the policy's premium "
        "payments gets role 'premium_history'. Report a top-level '_premium_history': "
        "[{\"date\": YYYY-MM-DD, \"amount\": $}, ...] with EVERY payment listed. "
        "Separately, if ANY document states total premiums paid to date and/or the "
        "current billed premium and billing frequency, report '_premiums_summary': "
        "{\"total\": $, \"as_of\": YYYY-MM-DD, \"billed\": $ or null, \"frequency\": "
        "'Monthly'|'Quarterly'|'Semi-Annual'|'Annual' or null}.\n"
        "- If a STATEMENT is present and its statement date is MORE RECENT than the "
        "illustration's current/prepared date, anchor the valuation to it: set av_at_id to "
        "the statement's ending account/accumulation value and id_date to the statement "
        "date, and say so in _extraction_notes. Also use the statement to confirm the "
        "current death benefit and crediting rate. If the statement is OLDER than the "
        "illustration date, ignore its values and note that instead.\n"
        "Follow the extraction guide exactly (current/non-guaranteed basis ledger; charges; "
        "monthly PPC/PUC units). Output ONLY the JSON object, no commentary. Use null for "
        "unknown optional fields, 0 for missing charges, and include a top-level key "
        "'_extraction_notes' (string) listing anything missing or assumed. "
        "IMPORTANT: the example below is a DIFFERENT policy - take every value from THESE "
        "documents only; set projection_crediting to null (never copy it from the example) "
        "and set funding to {} unless a document itself dictates a funding plan. "
        "Also include 'insured_name' (the insured/client full name as printed) and "
        "'illustration_name' (the illustration title or product name as printed). "
        "'smoker' must be EXACTLY 'Non-Smoker' or 'Smoker' (map class labels like "
        "'Preferred Best'/'Standard NT' to Non-Smoker, tobacco classes to Smoker); "
        "'gender' must be exactly 'Male' or 'Female'.\n\n"
        "EXTRACTION GUIDE:\n" + guide + "\n\nEXAMPLE CASE JSON:\n" + example})
    # size-fit the documents, then call the API - if the context is still too
    # large (token estimates are rough), retry with progressively tighter budgets
    msg = None
    budget_note = ''
    last_err = None
    for scale in (1.0, 0.6, 0.35):
        docs_f, budget_note = _fit_page_budget(docs, token_budget=int(TOKEN_BUDGET*scale),
                                               byte_budget=int(BYTE_BUDGET*scale))
        try:
            msg = client.messages.create(
                model=os.environ.get('EXTRACTION_MODEL', 'claude-sonnet-4-5'),
                max_tokens=8000,
                messages=[{"role": "user", "content": _content_for(docs_f)}])
            break
        except (anthropic.BadRequestError,
                getattr(anthropic, 'RequestTooLargeError', anthropic.BadRequestError)) as e:
            # BadRequestError 'prompt is too long' = token overflow;
            # RequestTooLargeError (HTTP 413) = request BYTES overflow
            if 'too long' in str(e).lower() or 'too large' in str(e).lower() \
                    or 'request_too_large' in str(e).lower():
                last_err = e
                _log(f'extraction request too large at scale {scale}; retrying tighter...')
                continue
            raise
    if msg is None:
        raise ValueError(
            'The uploaded documents are too large for extraction even after trimming. '
            'Upload fewer or shorter PDFs - the illustration pages with the annual '
            'ledger are what matter most. (' + str(last_err)[:160] + ')')
    text = msg.content[0].text.strip()
    text = text[text.find('{'): text.rfind('}')+1]
    d = json.loads(text)
    if d.pop('_survivorship', False):
        d['survivorship'] = True
    notes = budget_note + (d.pop('_extraction_notes', '') or '')
    roles = d.pop('_source_roles', {}) or {}
    runs = d.pop('_illustration_runs', []) or []
    le_reports = [x for x in (d.pop('_le_reports', []) or []) if isinstance(x, dict)]
    prem_hist = [x for x in (d.pop('_premium_history', []) or []) if isinstance(x, dict)]
    prem_sum = d.pop('_premiums_summary', None) or None
    d.pop('source_runs', None)          # runs travel separately, not via the schema
    # fill schema defaults -- treating explicit nulls from the extraction the
    # same as missing keys (Claude returns null for anything it can't find)
    defaults = dict(insured_name=None, illustration_name=None, payment_frequency='Quarterly',
                    optimize_basis='CSV', nlg_requirement=None,
                    survivorship=False, insured2=None,
                    funding={}, custom_premiums={}, coi_overrides={}, mi=0.005,
                    survival_table='2015 ALB', ndb_lag_months=2, health_type='Mean LE50',
                    health_value=100.0, valuation_type='IRR', valuation_value=15.0,
                    maturity_age=121, illustration_mode='Annual', av_at_id=0.0)
    for k, v in defaults.items():
        if d.get(k) is None: d[k] = v
    # MI and lag are house assumptions, not document fields - extraction must not set them
    d['mi'] = 0.005
    d['ndb_lag_months'] = 2
    for k in ('n_schedule_months', 'ledger_crediting', 'projection_crediting'):
        d.setdefault(k, None)
    if not d.get('ledger'):
        raise ValueError('No ledger rows were extracted from the PDF -- the illustration may '
                         'be image-only/scanned or use an unusual layout. ' + (notes or ''))
    # drop ledger rows with no AV and coerce null charges to 0
    clean = {}
    for py, lp in d['ledger'].items():
        if lp is None or lp.get('av') is None: continue
        for f_ in ('prem','ndb','csv','gcr','ngcr','popc','ppc','puc'):
            if lp.get(f_) is None and f_ not in ('csv',): lp[f_] = 0.0
        clean[py] = lp
    d['ledger'] = clean
    if d.get('dob') is None:
        raise ValueError('The insured date of birth was not found in the illustration. '
                         'Add it to the PDF cover page, or build a case JSON with a dob. '
                         + (notes or ''))
    if d.get('projection_crediting') in (None, 0):
        d['projection_crediting'] = next(iter(d['ledger'].values())).get('ngcr') or 0.04
    tmp = os.path.join(JOBS_DIR, f'extract-{uuid.uuid4().hex}.json')
    json.dump(d, open(tmp, 'w'))
    return Case.from_json(tmp), notes, roles, runs, le_reports, prem_hist, prem_sum

def _self_diagnose(case, err, notes, jd):
    """When the engine refuses a case, hand the case DATA + error back to Claude
    to diagnose the way a desk analyst would. Returns (repaired_case | None,
    diagnosis_text). Only extraction-level data repairs are allowed - the model
    may not invent financial figures, and the engine code is never modified."""
    import anthropic, json as _json
    cj_path = os.path.join(jd, 'diagnose-in.json')
    case.to_json(cj_path)
    case_json = open(cj_path).read()
    prompt = (
        'You are the built-in diagnostician of a life-settlement valuation engine. '
        'The engine refused to price the case below. Decide whether this is an '
        'EXTRACTION ARTIFACT that can be repaired in the case data alone.\n\n'
        f'ENGINE ERROR:\n{err}\n\n'
        f'EXTRACTION NOTES:\n{notes[:2000]}\n\n'
        f'CASE JSON:\n{case_json}\n\n'
        'Common repairable artifacts: leading/trailing ledger years padded with '
        'zeros that the source document never showed (drop those years); av_at_id '
        'of 0 when the ledger implies a positive starting account value; a premium '
        'column shifted by one row against the account values; a valuation date or '
        'policy date inconsistent with the ledger year numbering; an implausible '
        'mi/crediting misread. STRICT RULES: never invent premiums, account values, '
        'death benefits or dates that are not implied by the data already present; '
        'when the real fix needs the source document re-read or user input, say so '
        'instead of guessing. A no-lapse-guarantee policy whose ledger shows zero '
        'premiums with the death benefit persisting after the account value '
        'exhausts is VALID (prepaid NLG) - keep it intact.\n\n'
        'Respond with ONLY a JSON object: {"diagnosis": "<one or two sentences, '
        'plain English, for the analyst>", "repairable": true|false, '
        '"case": <the FULL corrected case JSON with the same schema, or null>}')
    try:
        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=os.environ.get('EXTRACTION_MODEL', 'claude-sonnet-4-5'),
            max_tokens=16384,
            messages=[{'role': 'user', 'content': prompt}])
        txt = ''.join(b.text for b in msg.content if getattr(b, 'type', '') == 'text')
        m = re.search(r'\{.*\}', txt, re.S)
        out = _json.loads(m.group(0))
        diagnosis = str(out.get('diagnosis') or 'no diagnosis produced')
        if not out.get('repairable') or not isinstance(out.get('case'), dict):
            return None, diagnosis
        fixed_path = os.path.join(jd, 'diagnose-out.json')
        _json.dump(out['case'], open(fixed_path, 'w'))
        return Case.from_json(fixed_path), diagnosis
    except Exception as e:
        return None, f'self-diagnosis itself failed ({e}) - the original error stands'

@app.route('/')
def index():
    return render_template_string(PAGE, version=APP_VERSION, body='', pdf_ok=bool(os.environ.get('ANTHROPIC_API_KEY')))

def _crosscheck_ledger(pdf_path, case):
    """Independently re-read the PDF's annual ledger with a deterministic
    table parser (no AI) and compare against the Claude extraction."""
    try:
        from ledger_check import parse_illustration_pdf
        parsed = parse_illustration_pdf(pdf_path)
        if not parsed.rows:
            return {'verdict': 'independent parser could not read a ledger table '
                               '(layout not machine-readable) - no cross-check available',
                    'ok': None, 'mismatches': []}
        # Column-order-independent check: carrier layouts vary too much to trust
        # positional column mapping, so instead verify that every material value
        # the AI extracted for a year actually APPEARS somewhere on that year's
        # printed row (any column, 0.5% tolerance). Catches misaligned/invented
        # values without false-alarming on column order.
        det = {int(y): [v for v in vals if v is not None]
               for y, vals in (parsed.row_values or {}).items()}
        mismatches, checked = [], 0
        for py, lp in sorted(case.ledger.items()):
            rowvals = det.get(py)
            if not rowvals: continue
            for fld in ('prem', 'ndb', 'av', 'csv'):
                cv = lp.get(fld)
                if cv is None or abs(cv) < 1.0: continue   # zeros match trivially
                checked += 1
                tol = max(1.0, 0.005*abs(cv))
                if not any(abs(dv - cv) <= tol for dv in rowvals):
                    mismatches.append(f'year {py} {fld}: extracted {cv:,.0f} '
                                      f'not found on that year\'s printed row')
        if checked == 0:
            return {'verdict': 'independent parser found a table but no comparable values',
                    'ok': None, 'mismatches': []}
        if len(mismatches) > max(2, 0.05*checked):
            return {'verdict': f'ledger cross-check: {len(mismatches)} of {checked} extracted values '
                               f'could not be found on the corresponding printed rows - review the '
                               f'extracted ledger before relying on this price',
                    'ok': False, 'mismatches': mismatches[:12]}
        if mismatches:
            return {'verdict': f'ledger cross-check: {checked-len(mismatches)} of {checked} extracted '
                               f'values verified on the printed rows ({len(mismatches)} not located - '
                               f'likely rounding or parsing gaps)', 'ok': True,
                    'mismatches': mismatches[:6]}
        return {'verdict': f'ledger cross-check passed: every extracted value was located on its '
                           f'printed row ({checked} values across {len(det)} ledger years)',
                'ok': True, 'mismatches': []}
    except Exception as e:
        return {'verdict': f'cross-check unavailable ({e})', 'ok': None, 'mismatches': []}

def _log(*a):
    print('[valuation]', dt.datetime.now().strftime('%H:%M:%S'), *a, flush=True)

@app.route('/value', methods=['POST'])
def value():
    try:
        ufs = [uf for uf in request.files.getlist('files') if uf and uf.filename]
        # back-compat with the old two-field form (v3.3 and earlier)
        for legacy in ('file', 'contract'):
            uf = request.files.get(legacy)
            if uf and uf.filename: ufs.append(uf)
        uploads = [(uf.filename, uf.read()) for uf in ufs]
        if not uploads:
            raise ValueError('No files were uploaded — drop the illustration PDF (plus, '
                             'optionally, the policy contract and latest annual statement).')
        notes = ''
        crosscheck = None
        le_reports = []
        roles = {}
        prem_hist, prem_sum = [], None
        job = uuid.uuid4().hex[:12]
        _log(f'job {job}: received ' + ', '.join(f'{fn} ({len(b):,} bytes)' for fn, b in uploads))
        jd = os.path.join(JOBS_DIR, job); os.makedirs(jd, exist_ok=True)
        ext = lambda fn: os.path.splitext(fn)[1].lower()
        jsons = [(fn, b) for fn, b in uploads if ext(fn) == '.json']
        xlsxs = [(fn, b) for fn, b in uploads if ext(fn) == '.xlsx']
        pdfs  = [(fn, b) for fn, b in uploads if ext(fn) == '.pdf']
        unknown = [fn for fn, b in uploads if ext(fn) not in ('.json', '.xlsx', '.pdf')]
        if unknown:
            notes += f" ignored unsupported file(s): {', '.join(unknown)};"
        primary_name = (jsons or xlsxs or pdfs or uploads)[0][0]
        is_case_file = bool(jsons or xlsxs)   # survives the later del of the upload lists
        if jsons:
            fn0, raw = jsons[0]
            p = os.path.join(jd, 'case.json'); open(p, 'wb').write(raw)
            case = Case.from_json(p)
            if len(uploads) > 1:
                notes += ' a case JSON was uploaded, so it fully defines the case — other files ignored;'
        elif xlsxs:
            fn0, raw = xlsxs[0]
            p = os.path.join(jd, 'input.xlsx'); open(p, 'wb').write(raw)
            cred_in = request.form.get('crediting', '').strip()
            case = extract_case(p, os.path.splitext(fn0)[0],
                                float(cred_in)/100 if cred_in else 0.0)
            if not cred_in:
                case.projection_crediting = case.ledger[min(case.ledger)].get('ngcr') or 0.04
                notes += f' projection crediting defaulted to NGCR {case.projection_crediting:.2%};'
            if pdfs:
                notes += ' an InsuriShield workbook was uploaded, so its ledger defines the case — PDFs ignored;'
        elif pdfs:
            if not os.environ.get('ANTHROPIC_API_KEY'):
                raise ValueError('PDF extraction requires ANTHROPIC_API_KEY to be set in the '
                                 'Render service environment (Environment tab), then redeploy. '
                                 'Alternatively upload a case JSON or InsuriShield .xlsx.')
            saved = {}
            for i, (fn, b) in enumerate(pdfs, 1):
                sp = os.path.join(jd, f'doc{i}.pdf'); open(sp, 'wb').write(b)
                saved[fn] = sp
            _log(f'job {job}: sending {len(pdfs)} PDF(s) to Claude for extraction + document classification...')
            case, notes_x, roles, runs, le_reports, prem_hist, prem_sum = _pdfs_to_case(pdfs)
            case.source_runs = [r for r in runs if isinstance(r, dict)]
            chosen = next((r for r in case.source_runs if r.get('chosen')), None)
            if len(case.source_runs) > 1 and chosen:
                notes += (f" {len(case.source_runs)} illustration runs considered; priced on: "
                          f"{chosen.get('label','?')} ({chosen.get('source','?')})"
                          + (f" - {chosen.get('reason','')}" if chosen.get('reason') else '') + ';')
            if roles:
                notes += ' documents read as: ' + ', '.join(
                    f'{fn} = {r}' for fn, r in roles.items()) + ';'
                if any('contract' in str(r).lower() for r in roles.values()):
                    notes += (' charge schedule/dates read from the policy contract '
                              '(contract governs; contract charges are guaranteed-basis);')
            notes += ' ' + notes_x
            today = dt.date.today()
            if case.vd and case.vd < today:
                notes += f' valuation date advanced from {case.vd} (extracted) to today;'
                case.vd = today
            _log(f'job {job}: extraction done ({len(case.ledger)} ledger years). notes: {notes[:200]}')
            # cross-check target: the CHOSEN run's PDF, else the PDF identified
            # as the illustration (fallback: largest)
            ill = [fn for fn, r in roles.items()
                   if 'illustration' in str(r).lower() and fn in saved]
            if chosen and chosen.get('source') in saved:
                ill = [chosen['source']] + [f for f in ill if f != chosen['source']]
            target = saved[ill[0]] if ill else \
                saved[max(saved, key=lambda fn: os.path.getsize(saved[fn]))]
            del uploads, pdfs, jsons, xlsxs, ufs
            import gc; gc.collect()
            if os.path.getsize(target) > 25_000_000:
                crosscheck = {'verdict': 'PDF too large for the independent parser - '
                              'cross-check skipped; review the extracted ledger table below',
                              'ok': None, 'mismatches': []}
            else:
                with HEAVY:
                    crosscheck = _crosscheck_ledger(target, case)
                gc.collect()
            if crosscheck: _log(f'job {job}: ledger cross-check: {crosscheck["verdict"]}')
            if not case.funding:
                from engine.policy import PolicyAccount, default_funding_plan
                acc = PolicyAccount(case.face, case.ledger, case.projection_crediting,
                                    illustration_mode=case.illustration_mode, av_at_id=case.av_at_id)
                case.funding = default_funding_plan(acc)
                notes += ' funding plan defaulted (illustrated until CSV supports optimization);'
        else:
            raise ValueError('Unsupported file type — upload .pdf documents (illustration, '
                             'policy contract, annual statement), a case .json, or an '
                             'InsuriShield .xlsx')
        if not getattr(case, 'illustration_name', None):
            case.illustration_name = primary_name
        # form overrides
        hv = request.form.get('health_value', '').strip()
        if hv:
            case.health_type = request.form.get('health_type', 'Mean LE50')
            case.health_value = float(hv)
        vv = request.form.get('val_value', '').strip()
        if vv:
            case.valuation_type = request.form.get('val_type', 'IRR')
            case.valuation_value = float(vv.replace(',', '').replace('$', ''))
        cred = request.form.get('crediting', '').strip()
        if cred and not primary_name.lower().endswith('.xlsx'):
            case.projection_crediting = float(cred)/100
        case.payment_frequency = request.form.get('pay_freq', 'Quarterly') or 'Quarterly'
        # pricing convention: Colva-match (default) = MI 0, survival-conditioned
        # LE aging; InsuriShield classic = MI 0.5%, rebuild-at-VD aging
        conv = request.form.get('convention', 'Colva') or 'Colva'
        if conv.startswith('InsuriShield'):
            case.le_aging = 'rebuild'
            case.mi = 0.005
            notes += ' InsuriShield-classic convention (MI 0.5%, rebuild-at-VD LE aging);'
        else:
            case.le_aging = 'condition'
            case.mi = 0.0
            notes += ' Colva-match convention (MI 0, survival-conditioned LE aging);'
        # manual case-fact overrides (beat anything extracted from the documents)
        def _pdate(field):
            v = (request.form.get(field) or '').strip()
            try:
                return dt.datetime.strptime(v, '%Y-%m-%d').date() if v else None
            except ValueError:
                raise ValueError(f'{field}: could not read date {v!r} - use YYYY-MM-DD')
        dob_in = _pdate('dob')
        if dob_in:
            case.dob = dob_in
            notes += f' DOB set manually to {dob_in};'
        led_in = _pdate('le_date')
        if led_in:
            case.le_date = led_in
            notes += f' LE interpreted as of its report date {led_in} and aged to the valuation date;'
        vd_in = _pdate('vd')
        if vd_in:
            case.vd = vd_in
            notes += f' valuation date set manually to {vd_in};'
        av_in = (request.form.get('av_now') or '').replace(',', '').replace('$', '').strip()
        avd_in = _pdate('av_date')
        if av_in and avd_in:
            case.av_at_id = float(av_in)
            case.id_date = avd_in
            notes += f' account value anchored manually: ${float(av_in):,.0f} as of {avd_in};'
        elif av_in or avd_in:
            notes += ' account-value override ignored (need BOTH the value and its as-of date);'
        if (request.form.get('curr_prem') or '').startswith('Due'):
            case.current_year_premium_due = True
            notes += ' current policy-year premium treated as due at purchase (buyer pays at VD);'
        # survivorship: a report naming the SECOND insured attaches to insured2
        # (enables the true joint curve); everything else flows to the primary.
        # With a single LE (typed or one report), the desk convention applies:
        # that LE is the operative life and pricing runs on its single curve.
        if getattr(case, 'survivorship', False) and case.insured2 and le_reports:
            n2 = (case.insured2.get('name') or '').lower()
            n1 = (case.insured_name or '').lower()
            for lr in list(le_reports):
                rn = (lr.get('insured_name') or '').lower()
                if not (n2 and rn): continue
                hit2 = any(w in rn for w in n2.split() if len(w) > 2)
                hit1 = any(w in rn for w in n1.split() if len(w) > 2)
                if hit2 and not hit1:
                    case.insured2['health_type'] = 'Mean LE50'
                    case.insured2['health_value'] = float(lr['mean_le50_months'])
                    if lr.get('report_date'):
                        case.insured2['le_date'] = lr['report_date']
                    le_reports.remove(lr)
                    notes += (f" second-insured LE: {lr.get('provider','?')} "
                              f"{lr.get('mean_le50_months','?')}mo as of "
                              f"{lr.get('report_date','?')} ({lr.get('insured_name','')});")
        # apply uploaded LE report(s) unless the user typed a health value
        if le_reports and not hv:
            try:
                if len(le_reports) == 1:
                    lr = le_reports[0]
                    case.health_type = 'Mean LE50'
                    case.health_value = float(lr['mean_le50_months'])
                    if lr.get('report_date') and not led_in:
                        case.le_date = dt.datetime.strptime(lr['report_date'], '%Y-%m-%d').date()
                    notes += (f" LE taken from the uploaded {lr.get('provider','LE')} report: "
                              f"{case.health_value:g} months as of {lr.get('report_date','?')};")
                else:
                    # several reports: solve each report's multiplier at its own
                    # date and price on the average multiplier (desk convention)
                    from engine.mortality import annual_q_series as _aqs, solve_mm_for_le as _smm
                    mms = []
                    for lr in le_reports:
                        rd = dt.datetime.strptime(lr['report_date'], '%Y-%m-%d').date()
                        qa_ = _aqs(case.effective_dob, rd, case.gender, case.smoker, 500, mi=case.mi)
                        mms.append(_smm(qa_, float(lr['mean_le50_months'])))
                    case.health_type = 'Mortality Multiplier'
                    case.health_value = sum(mms)/len(mms)
                    case.le_date = None
                    notes += (' ' + str(len(le_reports)) + ' LE reports uploaded ('
                              + ', '.join(f"{lr.get('provider','?')} {lr.get('mean_le50_months','?')}mo"
                                          for lr in le_reports)
                              + f') - priced on the average implied multiplier {case.health_value:.0f}%;')
                if le_reports[0].get('dob') and not dob_in:
                    case.dob = dt.datetime.strptime(le_reports[0]['dob'], '%Y-%m-%d').date()
                    notes += f' DOB taken from the LE report: {case.dob};'
            except Exception as e:
                notes += f' LE report could not be applied automatically ({e}) - enter the LE manually;'
        # Lapse Protection rider: rebuild the no-lapse fund from premium history
        # so the rider funding path can be priced as an alternative
        rider_note = None
        if getattr(case, 'nlg', None) and not case.nlg.get('fund_at_vd'):
            hist = list(prem_hist or [])
            if not hist and prem_sum and prem_sum.get('total'):
                # synthesize a level payment pattern from the stated totals
                try:
                    step = {'Monthly': 1, 'Quarterly': 3, 'Semi-Annual': 6,
                            'Annual': 12}.get(prem_sum.get('frequency') or 'Quarterly', 3)
                    billed = float(prem_sum.get('billed') or 0) or \
                        float(prem_sum['total'])/max(1, 8*12//step)
                    from engine.mortality import add_months as _am
                    cd0 = case.nlg.get('contract_date')
                    if isinstance(cd0, str):
                        cd0 = dt.datetime.strptime(cd0, '%Y-%m-%d').date()
                    tot, dpay = 0.0, cd0
                    while tot < float(prem_sum['total']) - 1:
                        amt = min(billed, float(prem_sum['total']) - tot)
                        hist.append({'date': dpay.isoformat(), 'amount': amt})
                        tot += amt; dpay = _am(dpay, step)
                    rider_note = (f" rider fund rebuilt from stated totals "
                                  f"(${float(prem_sum['total']):,.0f} paid, level "
                                  f"{prem_sum.get('frequency','Quarterly')} pattern assumed);")
                except Exception as e:
                    _log(f'job {job}: premium-summary synthesis failed ({e})')
            if hist:
                try:
                    from engine.nlg import reconstruct_nlg_fund
                    case.nlg['fund_at_vd'] = reconstruct_nlg_fund(
                        case.nlg, case.face, hist, case.vd)
                    notes += (f' Lapse Protection rider fund reconstructed from the premium '
                              f'history: ${case.nlg["fund_at_vd"]:,.0f} as of the valuation date;'
                              + (rider_note or ''))
                except Exception as e:
                    notes += f' rider fund reconstruction failed ({e});'
        # run
        _log(f'job {job}: running engine (COI backsolve + premium optimization + pricing)...')
        try:
            with HEAVY:
                res = run_case(case)
        except ValueError as engine_err:
            # self-diagnosis: hand the failing case + error back to Claude the way
            # an analyst would - repair extraction-level DATA problems and retry
            # once. The engine code itself is never changed.
            if not os.environ.get('ANTHROPIC_API_KEY'):
                raise
            _log(f'job {job}: engine refused ({engine_err}); running self-diagnosis...')
            fixed, diagnosis = _self_diagnose(case, str(engine_err), notes, jd)
            if fixed is None:
                raise ValueError(f'{engine_err}\n\nSELF-DIAGNOSIS: {diagnosis}')
            case = fixed
            notes += (f' SELF-DIAGNOSED: the engine initially refused ("{str(engine_err)[:160]}...") '
                      f'- {diagnosis} The repaired case priced on retry; review the '
                      f'ledger table and case JSON below before relying on this run;')
            with HEAVY:
                res = run_case(case)
        # rider-funding alternative: when the contract's Lapse Protection rider
        # data (with a fund value) is present and the base run priced on account
        # mechanics, price the rider path too and keep the better funding
        if getattr(case, 'nlg', None) and case.nlg.get('fund_at_vd') \
                and not res.get('nlg_mode'):
            from engine.runner import rider_variant_case
            varc = rider_variant_case(case)
            if varc is not None:
                try:
                    with HEAVY:
                        vres = run_case(varc)
                    better = (vres['price'] > res['price']) if case.valuation_type == 'IRR' \
                        else (vres['irr'] > res['irr'])
                    a, b = ((res['price'], vres['price']) if case.valuation_type == 'IRR'
                            else (res['irr'], vres['irr']))
                    fmt = (lambda x: f'${x:,.0f}') if case.valuation_type == 'IRR' \
                        else (lambda x: f'{x:.2f}% IRR')
                    if better:
                        notes += (f' FUNDING: priced on the Lapse Protection RIDER minimum '
                                  f'premiums ({fmt(vres["price"] if case.valuation_type=="IRR" else vres["irr"])}), '
                                  f'which beat CSV-based optimization ({fmt(a)}) - the rider '
                                  f'carries the policy so the cash-surrender floor does not '
                                  f'bind; guarantee-backed, not crediting-dependent;')
                        case, res = varc, vres
                    else:
                        notes += (f' FUNDING: CSV-based optimization ({fmt(a)}) kept - the '
                                  f'Lapse Protection rider path priced lower ({fmt(b)});')
                except Exception as e:
                    notes += f' rider funding path could not be priced ({e}) - CSV optimization kept;'
        if res.get('vd_snapped_from'):
            notes += (f" valuation date moved from {res['vd_snapped_from']} to {case.vd}"
                      f" (aligned to the policy schedule);")
        if res.get('nlg_contract'):
            notes += (' NLG policy: minimum premiums computed from the policy contract\'s Lapse '
                      'Protection rider (no-lapse shadow fund held just above zero with a one-month '
                      'buffer) - typically cheaper early and rising with age, unlike the '
                      'illustration\'s level premium;')
        elif res.get('nlg_prepaid'):
            last_cov = max((py for py, lp in case.ledger.items() if (lp.get('ndb') or 0) > 0),
                           default=None)
            notes += (' PREPAID no-lapse guarantee: the illustration shows zero premium outlay in '
                      'every year while the death benefit persists after the account value '
                      'exhausts - the NLG requirement is already met, so NO further premiums are '
                      'due and the valuation carries no premium outflows. Coverage runs through '
                      + (f'policy year {last_cov}' if last_cov else 'the last illustrated year')
                      + ' and ends when the guarantee expires - deaths after that pay nothing, '
                      'which the survival-weighted value already reflects;')
        elif res.get('nlg_mode'):
            notes += (' NLG policy: the illustration is guaranteed-basis with zero account values '
                      '(no-lapse guarantee in force), so the policy was priced on the illustration\'s '
                      'premium schedule directly - no COI calibration or premium optimization applies. '
                      'Upload the policy contract too: its Lapse Protection rider lets the app compute '
                      'the true minimum no-lapse premiums, which are usually lower;')
            if res.get('nlg_error'):
                notes += f" (contract rider data was present but unusable: {res['nlg_error']});"
        if res.get('survivorship_joint'):
            i2 = case.insured2 or {}
            notes += (f" SURVIVORSHIP: priced on the joint last-survivor 2015 VBT curve "
                      f"(second insured {i2.get('name','?')}, "
                      f"{i2.get('health_type','MM')} = {i2.get('health_value','?')});")
        elif res.get('insured2_deceased'):
            notes += (f" SURVIVORSHIP: second insured "
                      f"{(case.insured2 or {}).get('name','?')} is deceased - priced as a "
                      f"single life on the surviving insured;")
        elif res.get('survivorship_single_le'):
            notes += (' SURVIVORSHIP: one LE supplied - priced on that single curve per '
                      'desk convention (the LE belongs to the longer-lived insured; the '
                      'second-death payout tracks that life). Upload an LE report for the '
                      'other insured to price the true joint curve;')
        if res.get('smoker_mapped_from'):
            notes += (f" smoking status read as {res['smoker_mapped_from']!r}, treated as"
                      f" {case.smoker} (class labels map to non-tobacco);")
        if res.get('nlg_requirement_applied'):
            nr = case.nlg_requirement or {}
            notes += (f" no-lapse guarantee premium requirement applied: minimum funding is "
                      f"${nr.get('annual',0):,.0f}/yr (cumulative) through age {nr.get('to_age','?')} "
                      f"with the CSV lapse floor waived, then CSV-based optimization;")
        if res.get('coi_terminal_years'):
            notes += (f" policy year(s) {res['coi_terminal_years']} show the account collapsing "
                      f"in the source ledger (terminal/lapse years) - COI calibrated to the "
                      f"collapse, which is normal for final illustrated years;")
        if res.get('dob_shifted_from'):
            notes += (f" DOB corrected from {res['dob_shifted_from']} to {case.dob} so the "
                      f"insured's age matches the ages printed on the illustration ledger;")
        if res.get('py_offset'):
            notes += (f" policy-year numbering aligned to the ledger"
                      f" (offset {res['py_offset']:+d});")
        # --- input completeness card ---
        rolevals = [str(r).lower() for r in roles.values()]
        has_ill = any('illustration' in r for r in rolevals) or is_case_file
        has_con = any('contract' in r for r in rolevals)
        has_stm = any('statement' in r for r in rolevals)
        coi_yrs = sorted(res.get('coi_rates') or [])
        ill_age_mo = max(0, (case.vd - case.id_date).days // 30) if case.id_date else None
        comp = []
        def _c(label, status, source, note):
            comp.append(dict(label=label, status=status, source=source, note=note))
        ill_note = (f"policy years {coi_yrs[0]}–{coi_yrs[-1]} calibrated; "
                    if coi_yrs else '') + (f"illustration dated {case.id_date}" if case.id_date else '')
        if has_ill and ill_age_mo is not None and ill_age_mo > 12:
            _c('Ledger / COI calibration', 'warn', 'illustration',
               ill_note + f" — {ill_age_mo} months old at the valuation date; "
               "COI beyond the illustrated years is extrapolated. A fresh in-force "
               "illustration or the carrier's COI schedule would firm up late-year premiums.")
        elif has_ill:
            _c('Ledger / COI calibration', 'ok',
               'case file' if is_case_file else 'illustration', ill_note)
        else:
            _c('Ledger / COI calibration', 'miss', '—',
               'no illustration identified in the upload — pricing is running on '
               'whatever ledger could be recovered; upload the in-force illustration.')
        if has_con:
            _c('Policy contract', 'ok', 'contract',
               'premium loads, charges, surrender schedule, lapse basis and any '
               'no-lapse rider read from the contract (contract governs).')
        else:
            _c('Policy contract', 'warn', 'not uploaded',
               'charges implied from the illustration only — upload the policy '
               'contract to firm up minimum premiums, the lapse test (AV vs CSV) '
               'and no-lapse rider mechanics.')
        if getattr(case, 'nlg', None):
            if res.get('nlg_mode') and case.nlg.get('fund_at_vd'):
                _c('Funding basis', 'ok', 'rider',
                   'priced on the Lapse Protection rider minimum premiums '
                   f"(rider fund ${case.nlg.get('fund_at_vd', 0):,.0f} at valuation) — "
                   'guarantee-backed; confirm the fund value with a carrier quote or '
                   'full transaction history.')
            elif case.nlg.get('fund_at_vd'):
                _c('Funding basis', 'ok', 'account',
                   'CSV-based optimization priced better than the rider path here — '
                   'both were computed; see the run notes.')
            else:
                _c('Funding basis', 'warn', 'rider data incomplete',
                   'the contract has a Lapse Protection rider but no fund value could '
                   'be reconstructed — upload the premium/transaction history (or a '
                   'document stating total premiums paid) to price the rider path.')
        if res.get('dob_shifted_from'):
            _c('Insured DOB', 'warn', 'auto-corrected',
               f"documents said {res['dob_shifted_from']} but the ledger ages imply "
               f"{case.dob} — using {case.dob}; confirm against the policy/application.")
        elif dob_in:
            _c('Insured DOB', 'ok', 'manual', f'entered as {case.dob}.')
        elif le_reports and le_reports[0].get('dob'):
            _c('Insured DOB', 'ok', 'LE report', f'{case.dob} from the LE report.')
        else:
            _c('Insured DOB', 'ok', 'documents', f'{case.dob}.')
        if av_in and avd_in:
            _c('Current account value', 'ok', 'manual',
               f'${float(av_in):,.0f} as of {avd_in} (entered).')
        elif has_stm:
            _c('Current account value', 'ok', 'statement',
               f'anchored at ${case.av_at_id:,.0f} as of {case.id_date}.')
        elif ill_age_mo is not None and ill_age_mo > 6:
            _c('Current account value', 'warn', 'illustration',
               f'${case.av_at_id:,.0f} as of {case.id_date} — {ill_age_mo} months '
               'stale; upload the latest annual statement or enter the current AV.')
        else:
            _c('Current account value', 'ok', 'illustration',
               f'${case.av_at_id:,.0f} as of {case.id_date}.')
        if le_reports and not hv:
            lr0 = le_reports[0]
            aged = (f", aged to the valuation date ({res.get('le_aging') or 'condition'} convention)"
                    if res.get('le_aged_from') else '')
            _c('Life expectancy', 'ok', 'LE report',
               f"{lr0.get('provider','?')} {lr0.get('mean_le50_months','?')} months "
               f"as of {lr0.get('report_date','?')}{aged}."
               + (f' {len(le_reports)} reports averaged via implied multipliers.'
                  if len(le_reports) > 1 else ''))
        elif hv:
            aged = (f" (solved at {case.le_date}, aged to VD)"
                    if res.get('le_aged_from') else '')
            _c('Life expectancy', 'ok', 'manual',
               f'{case.health_type} = {case.health_value:g}{aged}.')
        elif is_case_file:
            _c('Life expectancy', 'ok', 'case file',
               f'{case.health_type} = {case.health_value:g} from the uploaded case/workbook.')
        else:
            _c('Life expectancy', 'miss', '—',
               'no LE report or health input — priced at the saved/default health '
               'value. The LE is the single largest value driver; upload an LE report.')
        if getattr(case, 'survivorship', False):
            i2 = case.insured2 or {}
            if res.get('survivorship_joint'):
                _c('Survivorship', 'ok', 'documents',
                   f"joint last-survivor curve; second insured {i2.get('name','?')} "
                   f"({i2.get('health_type','MM')} = {i2.get('health_value','?')}).")
            elif res.get('insured2_deceased'):
                _c('Survivorship', 'ok', 'documents',
                   f"second insured {i2.get('name','?')} deceased - single-life pricing "
                   'on the survivor. Obtain the death certificate for the file.')
            else:
                _c('Survivorship', 'warn', 'single LE',
                   'priced on one LE (assigned to the longer-lived insured, desk '
                   'convention) - an LE report for the other insured enables the true '
                   'joint curve, which prices LOWER.')
        if has_stm:
            _c('In-force status', 'ok', 'statement',
               'statement uploaded — still obtain written carrier verification of '
               'coverage and premium history through closing.')
        else:
            _c('In-force status', 'warn', 'not verifiable',
               'no document can prove the policy is currently in force or that premiums '
               'are paid to date — require carrier verification of coverage before funding.')
        _c('Deal terms', 'ok', 'run form',
           f"VD {case.vd}{' (defaulted to today)' if not vd_in and not is_case_file else ''}, "
           f"{case.valuation_type} {case.valuation_value:g}, {case.payment_frequency} payments, "
           f"{'Colva-match' if getattr(case,'le_aging','condition')=='condition' else 'InsuriShield classic'} convention.")
        n_ok = sum(1 for c in comp if c['status'] == 'ok')
        comp_head = (f"{n_ok} of {len(comp)} pricing inputs fully sourced — "
                     + (f"{len(comp)-n_ok} could be tightened" if n_ok < len(comp)
                        else 'nothing outstanding'))
        _log(f'job {job}: priced; computing sensitivity band...')
        from engine.runner import sensitivity_grid
        sens = sensitivity_grid(case, res)
        _log(f'job {job}: building workbook...')
        case.to_json(os.path.join(jd, 'case.json'))
        # snapshot record for the valuation-history page
        try:
            buyer_s = [r for r in res['schedule'] if r['start'] >= case.vd]
            json.dump(dict(
                job=job, ts=dt.datetime.now().isoformat(timespec='seconds'),
                name=case.name, insured=case.insured_name or '',
                face=case.face, vd=case.vd.isoformat(),
                mode=case.valuation_type, value=case.valuation_value,
                price=res['price'], irr=res['irr'],
                health=f"{case.health_type} = {case.health_value:g}",
                mean_le=res['mean_le'], mm=res['mm'],
                be_risk=res['breakeven_risk'],
                prem_y1=sum(r['prem'] for r in buyer_s[:12]),
                prem_total=sum(r['prem'] for r in buyer_s),
                convention=('Colva-match' if getattr(case, 'le_aging', 'condition') == 'condition'
                            else 'InsuriShield classic'),
                nlg=bool(res.get('nlg_mode')), prepaid=bool(res.get('nlg_prepaid')),
            ), open(os.path.join(jd, 'summary.json'), 'w'))
        except Exception as e:
            _log(f'job {job}: could not write history summary ({e})')
        with HEAVY:
            json.dump(comp, open(os.path.join(jd, 'completeness.json'), 'w'))
            wb, _ = build_workbook(case, 'x', res=res, sens=sens, completeness=comp)
            wb.save(os.path.join(jd, 'valuation.xlsx'))
            del wb
            import gc; gc.collect()
        from report import build_pdf
        build_pdf(case, res, os.path.join(jd, 'report.pdf'), notes=notes, sens=sens, completeness=comp)
        _log(f'job {job}: done. price/irr = {res["price"]:,.2f} / {res["irr"]:.2f}')
        if crosscheck:
            notes += ' ' + crosscheck['verdict'] + ';'
        # ledger preview rows for the results page
        ledger_rows = [(py, lp.get('prem'), lp.get('ndb'), lp.get('av'), lp.get('csv'))
                       for py, lp in sorted(case.ledger.items())]
        buyer = [r for r in res['schedule'] if r['start'] >= case.vd]
        import base64, re as _re
        case_b64 = base64.b64encode(open(os.path.join(jd, 'case.json'), 'rb').read()).decode()
        case_fn = _re.sub(r'[^A-Za-z0-9._-]+', '_', case.name)[:60] + '_case.json'
        body = render_template_string(RESULT,
            name=case.name, mode=case.valuation_type,
            val=f'{case.valuation_value:,.2f}'.rstrip('0').rstrip('.'),
            price=f"{res['price']:,.2f}", irr=f"{res['irr']:.2f}",
            health=f"{case.health_type} = {case.health_value:g}",
            mm=f"{res['mm']:.1f}", mean_le=f"{res['mean_le']:.1f}", med_le=f"{res['median_le']:.1f}",
            be=f"{res['breakeven_risk']:.4g}", pm=f"{res['prob_maturity']:.4g}",
            p1=f"{sum(r['prem'] for r in buyer[:12]):,.0f}",
            ptot=f"{sum(r['prem'] for r in buyer):,.0f}",
            cred=f"{case.projection_crediting*100:.2f}",
            payfreq=getattr(case, 'payment_frequency', 'Monthly'), job=job, notes=notes,
            case_b64=case_b64, case_fn=case_fn,
            crosscheck=crosscheck, ledger_rows=ledger_rows,
            completeness=comp, comp_head=comp_head)
        return render_template_string(PAGE, version=APP_VERSION, body=body, has_result=True,
                                      pdf_ok=bool(os.environ.get('ANTHROPIC_API_KEY')))
    except Exception as e:
        _log('ERROR:', repr(e))
        traceback.print_exc()
        err = f'<div class="card err">Error: {e}\n\n{traceback.format_exc(limit=3)}</div>'
        return render_template_string(PAGE, version=APP_VERSION, body=err,
                                      pdf_ok=bool(os.environ.get('ANTHROPIC_API_KEY'))), 400

HISTORY = """
<div class="card">
 <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
  <span class="tag">{{runs|length}} valuation{{'' if runs|length==1 else 's'}} on file</span>
  <span style="display:flex;gap:14px;align-items:center">
    <input id="q" placeholder="filter by name / insured" style="width:16rem;padding:9px 12px">
    {% if not embed %}<a class="btn alt" style="margin:0;padding:9px 18px" href="/">Price a policy &#8594;</a>{% endif %}
  </span>
 </div>
 {% if not runs %}
 <div class="muted" style="margin-top:16px">No valuations yet - runs appear here automatically the moment they finish.
 If this list is empty after a redeploy, the service has no persistent disk: add one in Render (see the deploy README)
 so history survives restarts.</div>
 {% else %}
 <div style="overflow-x:auto"><table id="histtable" style="min-width:900px">
  <tr>
   <td>Date</td><td>Policy / Insured</td><td style="text-align:right">Face</td>
   <td style="text-align:right">Value @ target</td><td style="text-align:right">Mean LE</td>
   <td style="text-align:right">Prem yr 1</td><td style="text-align:right">BE risk</td>
   <td>Convention</td><td>Files</td><td></td>
  </tr>
  {% for r in runs %}
  <tr class="hrow" data-k="{{(r.name ~ ' ' ~ r.insured)|lower}}">
   <td style="white-space:nowrap">{{r.ts[:10]}}</td>
   <td><b style="font-size:13.5px">{{r.name[:58]}}</b>{% if r.insured %}<br><span class="muted">{{r.insured}}</span>{% endif %}
       {% if r.prepaid %}<br><span class="tag">prepaid NLG</span>{% elif r.nlg %}<br><span class="tag">NLG</span>{% endif %}</td>
   <td style="text-align:right">{{'{:,.0f}'.format(r.face) if r.face else '&mdash;'|safe}}</td>
   <td style="text-align:right;white-space:nowrap">{% if r.price is not none %}<b>${{'{:,.0f}'.format(r.price)}}</b>
       <br><span class="muted">{% if r.mode=='IRR' %}@ {{'{:g}'.format(r.value)}}% IRR{% else %}IRR {{'{:.1f}'.format(r.irr)}}%{% endif %}</span>
       {% else %}&mdash;{% endif %}</td>
   <td style="text-align:right">{{'{:.0f}'.format(r.mean_le) ~ ' mo' if r.mean_le is not none else '&mdash;'|safe}}</td>
   <td style="text-align:right">{{'{:,.0f}'.format(r.prem_y1) if r.prem_y1 is not none else '&mdash;'|safe}}</td>
   <td style="text-align:right">{{'{:.1%}'.format(r.be_risk) if r.be_risk is not none else '&mdash;'|safe}}</td>
   <td style="white-space:nowrap"><span class="muted">{{r.convention or '&mdash;'|safe}}</span></td>
   <td style="white-space:nowrap">
     <a href="/download/{{r.job}}/report">pdf</a> &middot;
     <a href="/download/{{r.job}}/workbook">xlsx</a> &middot;
     <a href="/download/{{r.job}}/case">json</a></td>
   <td><form method="post" action="/valuations/del/{{r.job}}" onsubmit="return confirm('Remove this run from history? Its files are deleted too.')"
        style="display:inline"><button type="submit" style="all:unset;cursor:pointer;color:var(--mute);font-size:15px;padding:2px 6px" title="delete">&times;</button></form></td>
  </tr>
  {% endfor %}
 </table></div>
 <div class="muted" style="margin-top:10px">Downloads rebuild themselves from the saved case if the server restarted since
 the run. JSON feed for other Poel systems: <span class="mono">GET /api/valuations</span> (same login).</div>
 {% endif %}
</div>
<script>
var q=document.getElementById('q');
if(q)q.addEventListener('input',function(){var v=q.value.toLowerCase();
  document.querySelectorAll('.hrow').forEach(function(r){r.style.display=r.dataset.k.indexOf(v)>=0?'':'none';});});
</script>"""

def _history_runs():
    runs = []
    try:
        for j in os.listdir(JOBS_DIR):
            jd = os.path.join(JOBS_DIR, j)
            if not os.path.isdir(jd): continue
            sp = os.path.join(jd, 'summary.json')
            cp = os.path.join(jd, 'case.json')
            if os.path.exists(sp):
                try:
                    runs.append(json.load(open(sp)))
                    continue
                except Exception: pass
            if os.path.exists(cp):     # pre-history run: minimal record from the case
                try:
                    c = json.load(open(cp))
                    runs.append(dict(job=j,
                        ts=dt.datetime.fromtimestamp(os.path.getmtime(cp)).isoformat(timespec='seconds'),
                        name=c.get('name') or j, insured=c.get('insured_name') or '',
                        face=c.get('face'), vd=c.get('vd'), mode=c.get('valuation_type'),
                        value=c.get('valuation_value'), price=None, irr=None, health=None,
                        mean_le=None, mm=None, be_risk=None, prem_y1=None, prem_total=None,
                        convention=None, nlg=False, prepaid=False))
                except Exception: pass
    except FileNotFoundError:
        pass
    runs.sort(key=lambda r: r.get('ts') or '', reverse=True)
    return runs

@app.route('/valuations')
def valuations():
    embed = bool(request.args.get('embed'))
    body = render_template_string(HISTORY, runs=_history_runs(), embed=embed)
    return render_template_string(PAGE, version=APP_VERSION, body=body, history=True,
                                  embed=embed, has_result=False,
                                  pdf_ok=bool(os.environ.get('ANTHROPIC_API_KEY')))

@app.route('/api/valuations')
def api_valuations():
    return {'valuations': _history_runs()}

@app.route('/valuations/del/<job>', methods=['POST'])
def valuations_del(job):
    import shutil
    jd = os.path.join(JOBS_DIR, os.path.basename(job))
    if os.path.isdir(jd): shutil.rmtree(jd, ignore_errors=True)
    from flask import redirect
    return redirect('/valuations')

@app.route('/download/<job>/<kind>')
def download(job, kind):
    fn = {'workbook': 'valuation.xlsx', 'case': 'case.json', 'report': 'report.pdf'}.get(kind)
    if not fn: abort(404)
    jd = os.path.join(JOBS_DIR, os.path.basename(job))
    p = os.path.join(jd, fn)
    cj = os.path.join(jd, 'case.json')
    if not os.path.exists(p) and kind in ('workbook', 'report') and os.path.exists(cj):
        # server restarted since the run wiped the file -- rebuild it from the case
        _log(f'job {job}: {fn} missing, regenerating from case.json...')
        case = Case.from_json(cj)
        with HEAVY:
            res = run_case(case)
            from engine.runner import sensitivity_grid
            sens = sensitivity_grid(case, res)
            compx = None
            cxp = os.path.join(jd, 'completeness.json')
            if os.path.exists(cxp):
                try: compx = json.load(open(cxp))
                except Exception: compx = None
            if kind == 'workbook':
                wb, _ = build_workbook(case, 'x', res=res, sens=sens, completeness=compx)
                wb.save(p)
                del wb
            else:
                from report import build_pdf
                build_pdf(case, res, p, sens=sens, completeness=compx)
            import gc; gc.collect()
    if not os.path.exists(p):
        msg = ('<div class="card"><b>This result has expired.</b>'
               '<div class="muted" style="margin-top:8px">The server restarted since this valuation ran '
               '(deploys clear temporary storage). Re-run the valuation &mdash; or, if you saved the case '
               'JSON, drop it on the home page and the workbook regenerates in seconds.</div>'
               '<a class="btn" href="/" style="margin-top:16px">Back to valuation</a></div>')
        return render_template_string(PAGE, version=APP_VERSION, body=msg, has_result=True,
                                      pdf_ok=bool(os.environ.get('ANTHROPIC_API_KEY'))), 410
    stem = {'workbook': 'Valuation_Model', 'report': 'Pricing_Report', 'case': 'case'}[kind]
    return send_file(p, as_attachment=True,
                     download_name=f'{stem}_{job}{os.path.splitext(fn)[1]}')

@app.route('/regen/<kind>', methods=['POST'])
def regen(kind):
    import base64
    fn = {'workbook': 'valuation.xlsx', 'report': 'report.pdf'}.get(kind)
    if not fn: abort(404)
    job = os.path.basename(request.form.get('job', '') or uuid.uuid4().hex[:12])
    jd = os.path.join(JOBS_DIR, job); os.makedirs(jd, exist_ok=True)
    p = os.path.join(jd, fn)
    if not os.path.exists(p):
        _log(f'regen {job}: rebuilding {fn} from embedded case...')
        cj = os.path.join(jd, 'case.json')
        with open(cj, 'wb') as fh:
            fh.write(base64.b64decode(request.form['case_b64']))
        case = Case.from_json(cj)
        with HEAVY:
            res = run_case(case)
            from engine.runner import sensitivity_grid
            sens = sensitivity_grid(case, res)
            compx = None
            cxp = os.path.join(jd, 'completeness.json')
            if os.path.exists(cxp):
                try: compx = json.load(open(cxp))
                except Exception: compx = None
            if kind == 'workbook':
                wb, _ = build_workbook(case, 'x', res=res, sens=sens, completeness=compx)
                wb.save(p)
                del wb
            else:
                from report import build_pdf
                build_pdf(case, res, p, sens=sens, completeness=compx)
            import gc; gc.collect()
    stem = {'workbook': 'Valuation_Model', 'report': 'Pricing_Report'}[kind]
    return send_file(p, as_attachment=True,
                     download_name=f'{stem}_{job}{os.path.splitext(fn)[1]}')

@app.route('/api/value', methods=['POST'])
def api_value():
    """JSON API: POST a case JSON body, get price/metrics back."""
    try:
        tmp = os.path.join(JOBS_DIR, f'api-{uuid.uuid4().hex}.json')
        open(tmp, 'w').write(request.get_data(as_text=True))
        case = Case.from_json(tmp)
        with HEAVY:
            res = run_case(case)
        return {'name': case.name, 'valuation_type': case.valuation_type,
                'price': res['price'], 'irr': res['irr'], 'multiplier_pct': res['mm'],
                'mean_le_months': res['mean_le'], 'median_le_months': res['median_le'],
                'breakeven_risk': res['breakeven_risk'], 'prob_survive_to_end': res['prob_maturity']}
    except Exception as e:
        return {'error': str(e)}, 400

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8000)), debug=False)
