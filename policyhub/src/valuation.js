/* =====================================================================
   Policy Valuation, served through this application.

   The valuation model is a separate program — Python, its own repository,
   its own service — and it stays that way. Actuarial code that produces a
   purchase price is not something to rewrite in another language for the
   sake of tidiness: the failure mode of a translation error is a number
   that looks right and is not, on a document somebody acts on.

   What is joined is the DOOR. Requests to /valuation are answered by this
   server, which checks the reader is a signed-in administrator here and
   then asks the valuation service on their behalf. Three things follow
   from that, and they are the whole point:

     - one address. It is a page of this application, on this domain,
       reached from the menu rather than from a second bookmark.
     - one sign-in. The valuation service keeps its own basic-auth
       credentials, but they are held HERE, in the environment, and sent
       server to server. The browser never sees them and nobody types a
       second password.
     - one gate. The valuation service is no longer something you can
       reach by knowing its address: it is reached by having an
       administrator's session on this application.

   What is deliberately NOT joined: no data crosses. This proxies bytes.
   A valuation does not read a policy from this database and a price does
   not get filed against one — those would be a real integration, worth
   doing on purpose rather than as a side effect of sharing a domain.
   ===================================================================== */

import { authenticate, requireRole } from './auth.js';
import { audit } from './db.js';
import { describeOrigin } from './security.js';

const PREFIX = '/valuation';

/* Long, because a valuation is arithmetic over a mortality table and a
   premium stream and genuinely takes a while — the service itself runs a
   300-second worker timeout, so anything shorter here would cut off work
   that was going to succeed. */
const TIMEOUT_MS = 300000;

/* An upload is a carrier illustration: a PDF, a workbook, a case file.
   Bounded because this buffers the body before forwarding it. */
const MAX_UPLOAD = 26 * 1024 * 1024;

const base = () => String(process.env.VALUATION_URL || '').replace(/\/+$/, '');

/**
 * The credentials the valuation service asks for, held here rather than
 * given out. If they are not set, nothing is sent and the service is left
 * to decide — which is correct when it has no basic auth configured.
 */
const upstreamAuth = () => {
  const user = process.env.VALUATION_USER;
  const pass = process.env.VALUATION_PASSWORD;
  return user
    ? `Basic ${Buffer.from(`${user}:${pass || ''}`).toString('base64')}`
    : null;
};

/* ------------------------------------------------------------------ *
 * Rewriting the pages
 * ------------------------------------------------------------------ */

/**
 * The valuation app writes its links as absolute paths — href="/",
 * action="/value", href="/download/<job>/report". Correct at the root of
 * its own service, and wrong here, where it lives one level down: every
 * one of them would leave the valuation app and land on a screen of this
 * one.
 *
 * There are eleven of them and they are all in server-rendered markup, so
 * this is a rewrite of a known set rather than a guess. Left alone:
 * anchors (#), data: URLs, anything absolute (https://…) and anything
 * protocol-relative (//fonts.googleapis.com) — hence the (?!/).
 */
const REWRITE = /(\s(?:href|action|src)=")\/(?!\/)/g;

/* The same job for a stylesheet: url(/static/x) in an inline style block
   would otherwise ask this application for a file it does not have. All
   three quote forms, and the same exclusions. */
const REWRITE_CSS = /(url\(\s*['"]?)\/(?!\/)/g;

/**
 * And the same job for anything the page asks for after it has loaded.
 *
 * Today the valuation app's two scripts only touch the DOM, so this
 * changes nothing. It is here for the version that does not: the moment
 * somebody adds a fetch('/api/value') over there, that call would arrive
 * at THIS application's root instead of the valuation service, and the
 * failure would be a page that quietly stops working with no clue as to
 * why. A path is prefixed only when it is same-origin, absolute, and not
 * already inside the door -- a cross-origin URL, a relative one and a
 * protocol-relative one are all left exactly as they are.
 *
 * Runs before the app's own scripts, which sit further down the document.
 */
const SHIM = `<script>(function(){var P=${JSON.stringify(PREFIX)};
function fix(u){if(typeof u!=='string')return u;
if(u.charAt(0)!=='/'||u.charAt(1)==='/')return u;
if(u===P||u.indexOf(P+'/')===0)return u;return P+u;}
var f=window.fetch;if(f)window.fetch=function(i,o){
try{if(typeof i==='string')return f.call(this,fix(i),o);
if(i&&typeof i==='object'&&typeof i.url==='string'){
var q=new URL(i.url,location.href);
if(q.origin===location.origin&&fix(q.pathname)!==q.pathname)
return f.call(this,new Request(fix(q.pathname)+q.search,i),o);}}catch(e){}
return f.call(this,i,o);};
var X=window.XMLHttpRequest&&window.XMLHttpRequest.prototype.open;
if(X)window.XMLHttpRequest.prototype.open=function(){var a=[].slice.call(arguments);
a[1]=fix(a[1]);return X.apply(this,a);};})();</script>`;

/** A way back. It is a page of this application; it should say so. */
const BAR = `<div style="display:flex;align-items:center;gap:12px;padding:10px 24px;
  border-bottom:1px solid #e5e5e5;background:#fafafa;font:500 13px/1.4 -apple-system,
  BlinkMacSystemFont,'Segoe UI',sans-serif">
  <a href="/#/dashboard" style="color:#0a0a0a;text-decoration:none;display:flex;
    align-items:center;gap:7px">&#8592; Poel Capital &middot; Policy Portfolio</a>
  <span style="color:#a3a3a3">/</span>
  <span style="color:#737373">Policy Valuation</span>
</div>`;

/* Exported so the rewrite can be checked on its own, without a valuation
   service running: which links move, which are left alone, and that the
   way back is put in exactly once. */
export const dressPage = (html) => html
  .replace(REWRITE, `$1${PREFIX}/`)
  .replace(REWRITE_CSS, `$1${PREFIX}/`)
  .replace(/<body>/i, `<body>${SHIM}${BAR}`);

/* ------------------------------------------------------------------ *
 * The proxy
 * ------------------------------------------------------------------ */

/** Read the request body whole, refusing anything implausible. */
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      reject(Object.assign(new Error('too large'), { tooLarge: true }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

/* Headers worth passing on. An allow-list rather than a block-list: the
   one header that must never travel is the browser's own Authorization,
   and a list of exclusions is a list somebody forgets to add to. */
const FORWARD = ['accept', 'accept-language', 'content-type'];

const page = (title, body) => `<!doctype html><meta charset="utf-8">
<title>${title}</title><meta name="robots" content="noindex, nofollow">
<div style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  max-width:520px;margin:14vh auto;padding:0 24px;color:#0a0a0a">
  <h1 style="font-size:22px;margin:0 0 12px">${title}</h1>
  <p style="color:#45484d;margin:0 0 20px">${body}</p>
  <a href="/#/dashboard" style="color:#0a0a0a">&#8592; Back to the portfolio</a>
</div>`;

/**
 * The same session check the rest of the application uses, answering in
 * HTML instead of JSON.
 *
 * `authenticate` and `requireRole` refuse by calling res.json, which is
 * right for an API and useless to somebody who typed an address into a
 * browser: they would be looking at a line of JSON. This intercepts that
 * one call — not the status, not the middleware — and turns a refusal into
 * either the sign-in screen or a sentence.
 *
 * Deliberately a wrapper around the real check rather than a second
 * implementation of it: a copy of the session rules is a copy that drifts,
 * and the direction it drifts in is "still lets somebody in".
 */
const refuseInHtml = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    res.json = json;
    if (res.statusCode === 401) return res.redirect(302, '/#/dashboard');
    if (res.statusCode >= 400)
      return res.type('html').send(page(
        res.statusCode === 403 ? 'Not your screen' : 'Not right now',
        body?.error || 'Policy Valuation is an administrator’s tool.'));
    return json(body);
  };
  next();
};

export function mountValuation(app) {
  app.use(PREFIX, refuseInHtml, ...authenticate, requireRole('admin'),
    async (req, res, next) => {
    const target = base();
    if (!target)
      return res.status(503).type('html').send(page('Not configured yet',
        'This server has no VALUATION_URL set, so there is nowhere to send you. '
        + 'Set it in the environment and restart.'));

    if (!['GET', 'HEAD', 'POST'].includes(req.method))
      return res.status(405).type('html').send(page('Not something this does',
        'The valuation service is only ever read from or posted to.'));

    let body = null;
    if (req.method === 'POST') {
      try {
        body = await readBody(req);
      } catch (e) {
        return res.status(e.tooLarge ? 413 : 400).type('html').send(page(
          e.tooLarge ? 'That file is too big' : 'That upload did not arrive',
          e.tooLarge ? 'The largest illustration this will carry is 25 MB.'
            : 'Try it again.'));
      }
    }

    const headers = {};
    for (const h of FORWARD) if (req.headers[h]) headers[h] = req.headers[h];
    const auth = upstreamAuth();
    if (auth) headers.Authorization = auth;
    /* So the service can log who it was working for, and so its own logs
       are not a list of one address. */
    headers['X-Forwarded-For'] = req.ip;
    headers['X-Forwarded-Proto'] = req.protocol;
    headers['X-Poel-User'] = String(req.user?.email || '');

    /* Producing a valuation is work, and work somebody paid for should be
       on the record like an export is. Reads are not logged: opening the
       screen is not an event. */
    if (req.method === 'POST' && /^\/(value|regen|api\/value)/.test(req.url))
      await audit(req.user.uid, 'valuation', null, 'create',
        `ran the valuation model (${req.url.split('?')[0]}) · ${describeOrigin(req)}`)
        .catch(() => {});

    let upstream;
    try {
      upstream = await fetch(`${target}${req.url}`, {
        method: req.method, headers, body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      /* Detail to the log, a sentence to the reader: the address of an
         internal service and the shape of its failure are not theirs. */
      console.error('[valuation] upstream failed:', err?.message);
      return res.status(502).type('html').send(page('The valuation service did not answer',
        err?.name === 'TimeoutError'
          ? 'It was still working after five minutes, so this gave up. A very long '
            + 'premium stream can do that — try a shorter horizon.'
          : 'It may be starting up, which takes a moment on a free instance. '
            + 'Try again shortly.'));
    }

    /* A 401 from upstream means the credentials held here are wrong or
       missing. Never pass its WWW-Authenticate on: the browser would put
       up a password box for a service the reader has no password for, and
       typing anything into it would be a mystery either way. */
    if (upstream.status === 401)
      return res.status(502).type('html').send(page('The valuation service refused this server',
        'Its username and password are held here, in VALUATION_USER and '
        + 'VALUATION_PASSWORD, and it did not accept them.'));

    /* Its redirects point at its own root; they have to be brought under
       this prefix or they walk out of the valuation app. */
    const loc = upstream.headers.get('location');
    if (loc && loc.startsWith('/') && !loc.startsWith('//'))
      return res.redirect(upstream.status, `${PREFIX}${loc}`);

    const type = upstream.headers.get('content-type') || '';
    res.status(upstream.status);
    if (type) res.type(type);
    for (const h of ['content-disposition', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    /* Its pages are a different program's markup: Google Fonts and inline
       styles, neither of which this application's own policy admits. The
       carve-out is for this path and nothing else. */
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; "
      + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
      + 'font-src https://fonts.gstatic.com; '
      + "script-src 'self' 'unsafe-inline'; object-src 'none'; "
      + "base-uri 'none'; frame-ancestors 'none'");

    if (/text\/html/i.test(type)) {
      res.send(dressPage(await upstream.text()));
      return;
    }
    /* Everything else — a workbook, a PDF, a JSON reply — goes through
       untouched. */
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  });
}
