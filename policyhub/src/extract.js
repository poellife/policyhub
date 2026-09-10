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

  /* Read the body once, as text, and try to make JSON of it afterwards.
     A failing upstream does not always answer in JSON — a missing route
     answers in HTML — and asking for .json() first throws away the only
     evidence of what actually happened. */
  const raw = await res.text().catch(() => '');
  let out = null;
  try { out = JSON.parse(raw); } catch { /* not JSON, which is itself a clue */ }

  if (!res.ok) {
    /* Say which end is wrong. "Could not be read" sent somebody looking at
       their PDF when the answer was that the other service had not been
       deployed yet. */
    if (res.status === 404)
      throw bad(503, 'The valuation service has no document reader yet. Its own update — '
        + 'the one that adds /api/extract — has not been deployed. Deploy it and try again.');
    if (res.status === 401 || res.status === 403)
      throw bad(503, 'The valuation service refused this server’s credentials. Check that '
        + 'VALUATION_USER and VALUATION_PASSWORD here match APP_USER and APP_PASSWORD there.');
    if (res.status === 502 || res.status === 503 || res.status === 504)
      throw bad(503, out?.error
        || 'The valuation service is not answering. It may be starting up — try again in a minute.');
    throw bad(422, out?.error
      || `The documents could not be read — the valuation service answered ${res.status}`
         + `${raw ? `: ${raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}` : '.'}`);
  }
  if (!out)
    throw bad(502, 'The valuation service answered, but not with a reading. '
      + 'It may be running an older build.');

  const p = out.policy || {};
  const med = out.medical || {};
  const les = [...(out.le_reports || [])].filter((x) => x && x.mean_le50_months).sort(byDate);

  /* ---------------------------------------------------------------- *
   * Two reports, two questions
   *
   * A pair of life-expectancy reports means one of two things, and they
   * are opposite: two providers' opinions on ONE person, or one opinion
   * each on TWO people. Reading a survivorship pair as two opinions
   * prices the deal off one life and ignores the other; reading two
   * opinions as two people invents an insured who does not exist.
   *
   * The reports themselves say which. An underwriter writes the name of
   * the person they examined at the top of the certificate, so reports
   * carrying the same surname and forename are about the same person and
   * reports carrying different names are not. Compared on the name
   * rather than on anything cleverer because that is the fact the
   * document actually states.
   *
   * When the names cannot be told apart -- one report with no name on
   * it, or a reading that lost them -- the pair is treated as two
   * opinions, which is what the application has always assumed and the
   * safer of the two mistakes: an extra opinion sits unused on the form,
   * where a phantom second insured would silently push every maturity
   * date out.
   * ---------------------------------------------------------------- */
  const whose = (le) => `${lastOf(le?.insured_name || '')} ${firstOf(le?.insured_name || '')}`
    .trim().toLowerCase().replace(/[^a-z ]/g, '');

  /* Coerced, not merely truthy. `a && b` where b is an empty string
     yields an empty string, and an empty string travelling out of here as
     `two_lives` is a value the screen has to guess about. */
  const namedPair = !!(les.length >= 2 && whose(les[0]) && whose(les[1]));
  const twoPeople = namedPair && whose(les[0]) !== whose(les[1]);

  /* On a survivorship pair, the first life is the one the ILLUSTRATION
     names first where it says so, and otherwise the older report. Which
     of the two is "first" changes nothing about the arithmetic -- the
     analysis takes the later date whichever order they sit in -- but a
     form that lists them the way the contract does is one less thing for
     somebody to reconcile. */
  const primaryName = `${String(p.insured_last || '')} ${String(p.insured_first || '')}`
    .trim().toLowerCase().replace(/[^a-z ]/g, '');
  const ordered = twoPeople && primaryName && whose(les[1]) === primaryName
    ? [les[1], les[0]] : les;

  const [le1, le2] = ordered;
  const second = twoPeople ? le2 : null;      // a person
  const opinion = twoPeople ? null : le2;     // a second opinion on le1

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
    le_months_2: opinion?.mean_le50_months ? Math.round(Number(opinion.mean_le50_months)) : null,
    le_provider_2: String(opinion?.provider || '').trim(),

    /* The second life on a survivorship contract, filled only when the
       reports name two different people. Everything about them comes off
       their own certificate -- their estimate is counted from their own
       report date, not from the first life's. */
    insured2_last_name: second?.insured_name ? lastOf(second.insured_name) : '',
    insured2_first_name: second?.insured_name ? firstOf(second.insured_name) : '',
    insured2_dob: iso(second?.dob),
    insured2_gender: letter(second?.gender),
    insured2_le_months: second?.mean_le50_months
      ? Math.round(Number(second.mean_le50_months)) : null,
    insured2_le_provider: String(second?.provider || '').trim(),
    insured2_le_date: iso(second?.report_date),

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
    /* So the summary can say "two insureds" rather than leaving somebody
       to notice that six extra boxes filled themselves in. */
    two_lives: twoPeople,
    premiums: Array.isArray(out.premium_schedule) ? out.premium_schedule : [],
    read: out.read || [],
    roles: out.source_roles || {},
    runs: out.illustration_runs || [],
    le_reports: les,
    notes: String(out.notes || '').trim(),
  };
}

/* "Cleves Delp" -> last "Delp", first "Cleves". "Delp, Cleves" reads the
   other way round; both turn up on LE reports.
 *
 * A middle name goes nowhere. Certificates are written out in full --
 * "Gerald James Sommers", "Judith Mary Sommers" -- and a first-name box
 * holding "Gerald James" reads as a mistake on every screen it appears
 * on, and in the deal's own title. The full name is on the certificate,
 * which is where it belongs; this form wants the name people use. */
function lastOf(name) {
  const s = String(name).trim();
  if (s.includes(',')) return s.split(',')[0].trim();
  const parts = s.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : s;
}
function firstOf(name) {
  const s = String(name).trim();
  const given = s.includes(',')
    ? s.split(',').slice(1).join(' ').trim()
    : (s.split(/\s+/).length > 1 ? s.split(/\s+/).slice(0, -1).join(' ') : '');
  return given.split(/\s+/)[0] || '';
}
