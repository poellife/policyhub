/* =====================================================================
   A stand-in for the life-expectancy report service.

   The real one costs real money and takes minutes, so the tests talk to
   this instead. It answers the way app/main.py answers -- the same
   status names in the same order, the same `summary` block, the same
   401 without a key -- so what is under test is everything on this side
   of that call, which is where the mistakes would be.

   Exported rather than run: a suite starts it, points nothing at it (the
   server under test already has LE_SERVICE_URL), and stops it.
   ===================================================================== */
import http from 'node:http';

const KEY = 'le-stub-key';

/* The stages the real service reports, in order. A case walks one step
   per poll so a test can watch it move without waiting minutes. */
const STAGES = ['queued', 'extracting', 'analyzing', 'rendering', 'done'];

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  + '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  + '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n'
  + 'trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');

export function startLeStub(port = 5077) {
  const cases = new Map();
  let failNext = false;
  let stallAt = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/healthz') return send(200, { ok: true, model: 'stub' });

    const key = req.headers['x-api-key'] || url.searchParams.get('api_key') || '';
    if (key !== KEY) return send(401, { detail: 'Invalid or missing API key.' });

    if (req.method === 'POST' && url.pathname === '/api/cases') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        const id = Math.random().toString(16).slice(2, 12).padEnd(20, '0').slice(0, 20);
        cases.set(id, { id, step: 0, mode: /name="mode"\r?\n\r?\nsummary/.test(body)
          ? 'summary' : 'full', bytes: chunks.reduce((n, c) => n + c.length, 0),
        files: (body.match(/filename="/g) || []).length,
        fail: failNext });
        failNext = false;
        send(200, { id, status: 'queued' });
      });
      return undefined;
    }

    const m = /^\/api\/cases\/([a-f0-9]{20})(\/report\.(pdf|json))?$/.exec(url.pathname);
    if (!m) return send(404, { detail: 'Unknown case.' });
    const c = cases.get(m[1]);
    if (!c) return send(404, { detail: 'Unknown case.' });

    if (req.method === 'DELETE') { cases.delete(c.id); return send(200, { deleted: c.id }); }

    const stage = c.fail && c.step >= 2 ? 'error' : STAGES[Math.min(c.step, STAGES.length - 1)];
    if (m[2]) {
      if (stage !== 'done') return send(409, { detail: 'Report not ready.' });
      if (m[3] === 'pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end(PDF);
      }
      return send(200, { meta: { initials: 'A.B.' }, le: { central_years: 4.2 } });
    }

    /* Advance a step per poll, unless the test has parked it. */
    if (stage !== 'done' && stage !== 'error' && stallAt !== stage) c.step += 1;

    const out = { id: c.id, status: stage, mode: c.mode, log: leLog(c, stage) };
    if (stage === 'error') out.error = 'No readable text was found in the uploaded records.';
    if (stage === 'done') {
      out.filename = 'AB_Medical_Summary_and_LE_Analysis.pdf';
      out.pages = 240;
      out.ocr_used = true;
      out.summary = { initials: 'A.B.', sex: 'Male', age: 81,
        one_liner: '81M, metastatic prostate on ADT, progressive stage 3b CKD.',
        central_years: 4.2, range_low: 3, range_high: 6,
        path: 'dominant', confidence: 'lower' };
    }
    return send(200, out);
  });

  /* The service talks while it works, and PolicyHub shows what it says,
     so the stub has to talk too -- in the same words, because the screen
     reads the OCR line to turn "it is running" into "page 120 of 240".
     Worded from a real run's output. */
  function leLog(c, stage) {
    const t = (n) => new Date(Date.UTC(2026, 8, 2, 14, 26, 53 + n)).toISOString();
    const at = leStageRank(stage);
    const out = [];
    if (at >= 1) {
      out.push({ t: t(0), msg: 'Extracting text from records…' });
      out.push({ t: t(0), msg: 'Scanned document detected (0/240 pages with text). Running OCR…' });
      /* Counted out loud, sixty at a time, the way the real one does. */
      const through = Math.min(240, c.ocr = (c.ocr || 0) + 60);
      out.push({ t: t(1), msg: `OCR pages ${through - 59}–${through} of 240` });
    }
    if (at >= 2) {
      out.push({ t: t(36), msg: 'Extracted 240 pages, 512,400 characters (240 pages via OCR)' });
      out.push({ t: t(36), msg: 'Analyzing records and scoring under Rubric v2.0…' });
    }
    if (at >= 3) out.push({ t: t(94), msg: 'Rendering report…' });
    if (stage === 'done') out.push({ t: t(101), msg: 'Report ready.' });
    if (stage === 'error') out.push({ t: t(40), msg: 'Error: no readable text was found.' });
    return out;
  }
  const leStageRank = (s) => (s === 'error' ? 2 : Math.max(0, STAGES.indexOf(s)));

  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({
    server,
    /* The next case created will fail partway, so a suite can prove the
       failure is reported rather than swallowed. */
    failNext: () => { failNext = true; },
    stallAt: (s) => { stallAt = s; },
    close: () => new Promise((r) => server.close(r)),
  })));
}
