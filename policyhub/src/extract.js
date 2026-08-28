/* =====================================================================
   Reading a deal off its own paperwork.

   Posting an opportunity means typing a policy number, a carrier, a face
   amount, two life expectancies, a premium schedule and four paragraphs
   of medical history off a stack of PDFs that already say all of it. It
   takes twenty minutes and every one of those fields is a chance to
   transpose a digit.

   The valuation service already reads these documents — it has to, to
   price them — so this does not build a second reader. It posts the
   PDFs to that service, server to server, over the credentials this
   application already holds for it, and maps what comes back onto the
   opportunity form.

   Two things it deliberately does not do:

     - it does not save anything. What comes back is handed to the
       screen, the person checks it, and the opportunity is created by
       the ordinary route with the ordinary rules. Nothing here writes
       to the database.
     - it does not keep the documents. They are read and dropped. Life
       expectancy reports are medical records, and the portal holds the
       summary somebody approved, not the file it came from.
   ===================================================================== */

const TIMEOUT_MS = 300000;          // reading a long illustration is minutes, not seconds
const MAX_TOTAL = 25 * 1024 * 1024; // the valuation service's own request ceiling

const base = () => String(process.env.VALUATION_URL || '').replace(/\/+$/, '');

const upstreamAuth = () => {
  const user = process.env.VALUATION_USER;
  const pass = process.env.VALUATION_PASSWORD;
  return user ? `Basic ${Buffer.from(`${user}:${pass || ''}`).toString('base64')}` : null;
};

/** A failure a person can act on, not a stack trace.
 *
 * `expose` says the message was written to be read. Without it the error
 * handler treats anything outside the 4xx range as a fault and returns a
 * reference number, which is the right default and the wrong answer for
 * "that service is not configured yet". */
const bad = (status, message) =>
  Object.assign(new Error(message), { status, expose: true });

/* 'Male' -> 'M'. The opportunity form stores the letter; the extractor
   reports the word, because that is what an illustration prints. */
const letter = (g) => {
  const s = String(g || '').trim().toUpperCase();
  if (s.startsWith('M')) return 'M';
  if (s.startsWith('F')) return 'F';
  return '';
};

const iso = (v) => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/** One bullet per line, which is how the one-pager reads these fields. */
const bullets = (list) => (Array.isArray(list) ? list : [])
  .map((x) => String(x || '').trim())
  .filter(Boolean)
  .join('\n');

/**
 * Which LE report to believe first.
 *
 * The most recent one: an estimate is a reading of the records as they
 * stood, and the newer reading has seen more of them. Ties keep the
 * order the documents arrived in.
 */
const byDate = (a, b) => String(b.report_date || '').localeCompare(String(a.report_date || ''));

/**
 * Post the documents to the valuation service and map the answer onto the
 * fields of an opportunity.
 *
 * Returns { fields, premiums, read, roles, runs, notes } — never a record.
 */
export async function readDocuments(files) {
  const target = base();
  if (!target)
    throw bad(503, 'Document reading is not configured on this server: VALUATION_URL is unset.');

  const pdfs = files.filter((f) => /\.pdf$/i.test(f.originalname || ''));
  if (!pdfs.length)
    throw bad(400, 'Upload the illustration, and any life-expectancy reports, as PDFs.');
  const total = pdfs.reduce((n, f) => n + f.buffer.length, 0);
  if (total > MAX_TOTAL)
    throw bad(413, 'Those documents come to more than 25 MB together. '
      + 'Upload the illustration pages and the LE reports rather than the whole file.');

  const form = new FormData();
  for (const f of pdfs)
    form.append('files', new Blob([f.buffer], { type: 'application/pdf' }), f.originalname);

  const headers = {};
  const auth = upstreamAuth();
  if (auth) headers.Authorization = auth;

  let res;
  try {
    res = await fetch(`${target}/api/extract`, {
      method: 'POST', body: form, headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw bad(504, e.name === 'TimeoutError'
      ? 'Reading the documents took too long. A shorter illustration — the ledger and '
        + 'summary pages — is read in under a minute.'
      : 'The valuation service could not be reached, so the documents were not read.');
  }

  const out = await res.json().catch(() => null);
  if (!res.ok)
    throw bad(res.status === 503 ? 503 : 422,
      out?.error || 'The documents could not be read.');

  const p = out.policy || {};
  const med = out.medical || {};
  const les = [...(out.le_reports || [])].filter((x) => x && x.mean_le50_months).sort(byDate);
  const [le1, le2] = les;

  /* The LE report wins on identity. Underwriters verify who they are
     writing about; an illustration prints whatever was keyed into it. */
  const dob = iso(le1?.dob) || iso(p.dob);
  const gender = letter(le1?.gender || p.gender);

  const fields = {
    policy_number: String(p.policy_number || '').trim(),
    carrier_name: String(p.carrier || '').trim(),
    product_type: String(p.product_type || '').trim(),
    face_amount: num(p.face_amount),

    insured_last_name: String(le1?.insured_name ? lastOf(le1.insured_name) : p.insured_last || '').trim()
      || String(p.insured_last || '').trim(),
    insured_first_name: String(le1?.insured_name ? firstOf(le1.insured_name) : p.insured_first || '').trim()
      || String(p.insured_first || '').trim(),
    insured_dob: dob,
    insured_gender: gender,
    insured_state: String(p.insured_state || '').trim().toUpperCase().slice(0, 2),

    le_months: le1?.mean_le50_months ? Math.round(Number(le1.mean_le50_months)) : null,
    le_provider: String(le1?.provider || '').trim(),
    le_date: iso(le1?.report_date),
    le_months_2: le2?.mean_le50_months ? Math.round(Number(le2.mean_le50_months)) : null,
    le_provider_2: String(le2?.provider || '').trim(),

    annual_premium: num(p.annual_premium),
    account_value: num(p.account_value),
    cash_surrender_value: num(p.cash_surrender_value),
    values_as_of: iso(p.values_as_of),

    impairments: bullets(med.impairments),
    mitigating: bullets(med.mitigating),
    underwriter_note: String(med.underwriter_note || '').trim(),
    records_through: iso(med.records_through),
  };

  /* Nothing is guessed at. A field the documents did not state comes back
     empty, so the person filling the form can see what still needs them. */
  for (const [k, v] of Object.entries(fields))
    if (v === '' || v === null || v === undefined) delete fields[k];

  return {
    fields,
    premiums: Array.isArray(out.premium_schedule) ? out.premium_schedule : [],
    read: out.read || [],
    roles: out.source_roles || {},
    runs: out.illustration_runs || [],
    le_reports: les,
    notes: String(out.notes || '').trim(),
  };
}

/* "Cleves Delp" -> last "Delp", first "Cleves". "Delp, Cleves" reads the
   other way round; both turn up on LE reports. */
function lastOf(name) {
  const s = String(name).trim();
  if (s.includes(',')) return s.split(',')[0].trim();
  const parts = s.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : s;
}
function firstOf(name) {
  const s = String(name).trim();
  if (s.includes(',')) return s.split(',').slice(1).join(' ').trim();
  const parts = s.split(/\s+/);
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
}
