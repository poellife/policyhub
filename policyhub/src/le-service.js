/* =====================================================================
   The life-expectancy report service, reached from here.

   A third program, on its own service: medical records in, a Poel Life
   Medical Summary & Estimated Life-Expectancy Analysis out. The same
   arrangement as the valuation model — the credentials live in this
   application's environment and are sent server to server, so the
   browser never holds the key and the reader signs in once, here.

   Two things about it shape everything below.

   IT IS SLOW AND IT IS A JOB. Extraction, OCR of scanned pages, the
   analysis and the render take minutes, sometimes half an hour on a
   thousand-page package. So a case is created and then polled: this
   module posts the records, gets an id, and is asked about that id until
   it says done. Nothing here blocks on a report.

   IT FORGETS. Finished reports are purged on its own timer — a day, by
   default. What is kept HERE is the headline and nothing else: initials,
   age, the central estimate, the range, the confidence, the one-line
   summary. The PDF is fetched through this application while the service
   still holds it and is never stored, because a medical summary at rest
   in the portfolio database is a different kind of object from a figure
   about one, and the figure is what the book actually needs.
   ===================================================================== */

const CREATE_TIMEOUT = 180000;   // uploading a large APS, not analysing it
const POLL_TIMEOUT = 20000;      // a status read is a file read on the far side
const PDF_TIMEOUT = 60000;
const MAX_TOTAL = 200 * 1024 * 1024;   // the service's own MAX_UPLOAD_MB default

export const LE_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];

const base = () => String(process.env.LE_SERVICE_URL || '').replace(/\/+$/, '');

/** Configured or not. Lets a screen say so rather than fail on the click. */
export const leConfigured = () => !!base() && !!process.env.LE_SERVICE_KEY;

const headers = () => {
  const key = process.env.LE_SERVICE_KEY || '';
  return key ? { 'X-API-Key': key } : {};
};

/** A failure written to be read. See the note in extract.js. */
const bad = (status, message) =>
  Object.assign(new Error(message), { status, expose: true });

const notConfigured = () => bad(503,
  'Life-expectancy reports are not configured on this server. Set LE_SERVICE_URL and '
  + 'LE_SERVICE_KEY to the address and access key of the report service.');

/**
 * Say which end went wrong.
 *
 * "The report could not be run" sends somebody looking at their records
 * when the answer was that the key is wrong or the service is asleep.
 */
async function readOrThrow(res, what) {
  const raw = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(raw); } catch { /* not JSON, which is itself a clue */ }
  if (res.ok) return body;

  if (res.status === 401 || res.status === 403)
    throw bad(503, 'The report service refused this server’s access key. Check that '
      + 'LE_SERVICE_KEY here matches APP_API_KEY there.');
  /* Our sentence, not theirs. The service's own 404 detail is "Unknown
     case.", which is true and tells the reader nothing about why a
     report they ran yesterday has gone. */
  if (res.status === 404)
    throw bad(404, 'That report is no longer on the report service. Finished reports are '
      + 'purged after a day; the figures are still on file here.');
  if (res.status === 409)
    throw bad(409, 'That report is not finished yet.');
  if (res.status === 413)
    throw bad(413, body?.detail || 'Those records are larger than the service accepts.');
  if (res.status >= 500)
    throw bad(503, 'The report service is not answering. It may be starting up — '
      + 'try again in a minute.');
  throw bad(422, body?.detail
    || `${what} failed — the report service answered ${res.status}${
      raw ? `: ${raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}` : '.'}`);
}

/**
 * Hand the records over and get a case id back.
 *
 * Returns immediately: the service queues the work and this application
 * polls for it. Nothing about the records is kept on this side — the
 * buffers came from an upload held in memory and go out of scope here.
 */
export async function createCase(files, { mode = 'full', initials = '' } = {}) {
  if (!leConfigured()) throw notConfigured();
  const usable = (files || []).filter((f) =>
    LE_EXTENSIONS.some((e) => String(f.originalname || '').toLowerCase().endsWith(e)));
  if (!usable.length)
    throw bad(400, 'Upload the records as PDF, DOCX or TXT.');
  const total = usable.reduce((n, f) => n + f.buffer.length, 0);
  if (total > MAX_TOTAL)
    throw bad(413, 'Those records come to more than 200 MB together.');

  const form = new FormData();
  for (const f of usable)
    form.append('files', new Blob([f.buffer]), f.originalname);
  form.append('mode', mode === 'summary' ? 'summary' : 'full');
  if (initials) form.append('initials', initials);

  let res;
  try {
    res = await fetch(`${base()}/api/cases`, {
      method: 'POST', body: form, headers: headers(),
      signal: AbortSignal.timeout(CREATE_TIMEOUT),
    });
  } catch (e) {
    throw bad(504, e.name === 'TimeoutError'
      ? 'Uploading the records took too long. Try the APS on its own rather than the '
        + 'whole file.'
      : 'The report service could not be reached, so nothing was sent.');
  }
  const body = await readOrThrow(res, 'Starting the report');
  if (!body?.id) throw bad(502, 'The report service did not return a case id.');
  return { caseId: String(body.id), status: String(body.status || 'queued') };
}

/** Where a case has got to, and its headline once it is done. */
export async function caseStatus(caseId) {
  if (!leConfigured()) throw notConfigured();
  let res;
  try {
    res = await fetch(`${base()}/api/cases/${encodeURIComponent(caseId)}`,
      { headers: headers(), signal: AbortSignal.timeout(POLL_TIMEOUT) });
  } catch {
    /* A poll that cannot reach the service is not an error worth failing a
       screen over: the case is still running over there and the row on
       this side keeps whatever it last knew. */
    return null;
  }
  if (res.status === 404) return { status: 'expired' };
  return readOrThrow(res, 'Reading the report status');
}

/** The finished PDF, while the service still has it. */
export async function casePdf(caseId) {
  if (!leConfigured()) throw notConfigured();
  let res;
  try {
    res = await fetch(`${base()}/api/cases/${encodeURIComponent(caseId)}/report.pdf`,
      { headers: headers(), signal: AbortSignal.timeout(PDF_TIMEOUT) });
  } catch (e) {
    throw bad(504, e.name === 'TimeoutError'
      ? 'Fetching the report took too long.'
      : 'The report service could not be reached.');
  }
  if (!res.ok) await readOrThrow(res, 'Fetching the report');
  return Buffer.from(await res.arrayBuffer());
}

/** Tell the service to forget a case now rather than on its own timer. */
export async function purgeCase(caseId) {
  if (!leConfigured()) return false;
  try {
    const res = await fetch(`${base()}/api/cases/${encodeURIComponent(caseId)}`,
      { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(POLL_TIMEOUT) });
    return res.ok || res.status === 404;
  } catch { return false; }
}

/* The statuses the service reports, in the order they happen. Anything
   else is treated as still running, so a new stage added over there does
   not read here as a fault. */
export const LE_TERMINAL = ['done', 'error', 'expired'];
export const leRunning = (s) => !LE_TERMINAL.includes(String(s || ''));

/**
 * The headline, and only the headline.
 *
 * Everything this application stores about a report comes through here,
 * so what is kept is one short list in one place rather than a decision
 * repeated at every call site.
 */
export function headline(state) {
  const s = state?.summary || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    initials: String(s.initials || '').slice(0, 12),
    sex: String(s.sex || '').slice(0, 12),
    age: Number.isInteger(Number(s.age)) ? Number(s.age) : null,
    one_liner: String(s.one_liner || '').slice(0, 600),
    central_years: num(s.central_years),
    range_low_years: num(s.range_low),
    range_high_years: num(s.range_high),
    path: String(s.path || '').slice(0, 120),
    confidence: String(s.confidence || '').slice(0, 40),
    pages: Number.isInteger(Number(state?.pages)) ? Number(state.pages) : null,
    ocr_used: !!state?.ocr_used,
    filename: String(state?.filename || '').slice(0, 200),
  };
}
