/* =====================================================================
   Reading an opportunity off its documents.

   The reading itself is the valuation service's job and costs real money
   to exercise, so it is stood in for here by a stub that answers the way
   that service answers. What is under test is everything on this side of
   that call, which is where the mistakes would be:

     - the mapping. An LE report and an illustration disagree about who
       the insured is and when they were born, and the rule is that the
       underwriter wins — they verified identity, the illustration was
       keyed in by somebody.
     - the silences. A field the documents did not state must come back
       absent, not blank-but-present and not guessed, so the form shows
       what still needs a person.
     - the door. An investor cannot read documents, nothing is stored,
       and a service that is not configured says so in a sentence.

   Idempotent: it stands up its own stub on an ephemeral port and takes
   it down again.
   ===================================================================== */
import http from 'node:http';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

/* ------------------------- the stand-in service ---------------------- */
/* What the valuation service returns for one illustration and two LE
   reports that disagree with it. Deliberately awkward: the illustration
   has the name and date of birth slightly wrong, the newer LE report is
   second in the list, and several fields are simply absent. */
let lastRequest = null;
const ANSWER = {
  policy: {
    carrier: 'Lincoln National', policy_number: 'IUL1077194', product_type: 'IUL',
    face_amount: 11000000,
    insured_last: 'Delp', insured_first: 'Cleves', insured_state: 'oh',
    dob: '1958-06-01', gender: 'Male', smoker: 'Non-Smoker',
    account_value: 412000.55, cash_surrender_value: 388000, values_as_of: '2026-05-01',
    annual_premium: 220273,
  },
  medical: {
    impairments: ['Cardiovascular: CAD with five stents (2023)', '  ', 'Hepatic: fatty liver'],
    mitigating: ['Sustained 60 lb weight loss'],
    underwriter_note: 'Mortality risk is higher than at prior underwriting.',
    records_through: '2026-04-30',
  },
  le_reports: [
    { provider: 'Polaris', mean_le50_months: 195, report_date: '2025-11-02',
      insured_name: 'Cleves Delp', dob: '1958-06-14', gender: 'Male' },
    { provider: 'Predictive', mean_le50_months: 193, report_date: '2026-05-01',
      insured_name: 'Delp, Cleves', dob: '1958-06-14', gender: 'Male' },
  ],
  premium_schedule: [
    { due_date: '2026-10-26', amount: 220273 },
    { due_date: '2027-10-26', amount: 245091 },
  ],
  source_roles: { 'illustration.pdf': 'illustration', 'polaris.pdf': 'le_report' },
  illustration_runs: [{ source: 'illustration.pdf', chosen: true, label: 'level to 102' }],
  notes: 'Ledger taken from the current-assumptions run.',
  read: ['illustration.pdf', 'polaris.pdf'],
};

let reply = { status: 200, body: ANSWER };
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastRequest = {
      url: req.url, method: req.method,
      auth: req.headers.authorization || '',
      bytes: Buffer.concat(chunks).length,
      type: req.headers['content-type'] || '',
    };
    /* A body given as a string is sent as-is — an HTML 404 page, a bare
       "Auth required" — because that is what a real upstream sends when it
       fails, and handling only JSON is how the diagnosis got lost. */
    const isText = typeof reply.body === 'string';
    res.writeHead(reply.status, {
      'Content-Type': isText ? 'text/html' : 'application/json' });
    res.end(isText ? reply.body : JSON.stringify(reply.body));
  });
});
await new Promise((done) => stub.listen(0, '127.0.0.1', done));
const port = stub.address().port;

process.env.VALUATION_URL = `http://127.0.0.1:${port}`;
process.env.VALUATION_USER = 'stubuser';
process.env.VALUATION_PASSWORD = 'stubpass';

const { readDocuments } = await import('../src/extract.js');
const pdf = (name, size = 2048) => ({ originalname: name, buffer: Buffer.alloc(size, 7) });

/* ------------------------------------------------------------------ *
 * The mapping
 * ------------------------------------------------------------------ */
console.log('WHAT THE DOCUMENTS SAY BECOMES WHAT THE FORM HOLDS');
const got = await readDocuments([pdf('illustration.pdf'), pdf('polaris.pdf')]);
const f = got.fields;

check('the policy number comes across', f.policy_number === 'IUL1077194', f.policy_number);
check('and the carrier', f.carrier_name === 'Lincoln National', f.carrier_name);
check('and the product type', f.product_type === 'IUL', f.product_type);
check('and the death benefit as a number', f.face_amount === 11000000, String(f.face_amount));
check('the state is upper-cased to the two letters the form stores',
  f.insured_state === 'OH', f.insured_state);
check('the carrier values come across with their date',
  f.account_value === 412000.55 && f.values_as_of === '2026-05-01',
  `${f.account_value} @ ${f.values_as_of}`);

console.log('\nTHE UNDERWRITER WINS ON WHO THE INSURED IS');
check('the date of birth is the LE report’s, not the illustration’s',
  f.insured_dob === '1958-06-14', f.insured_dob);
check('the gender is stored as the letter the form uses', f.insured_gender === 'M',
  f.insured_gender);
check('a name written "Delp, Cleves" splits the right way round',
  f.insured_last_name === 'Delp' && f.insured_first_name === 'Cleves',
  `${f.insured_last_name} / ${f.insured_first_name}`);

console.log('\nTHE NEWER LIFE EXPECTANCY LEADS');
check('the most recent report is the first LE',
  f.le_months === 193 && f.le_provider === 'Predictive', `${f.le_provider} ${f.le_months}`);
check('with its own report date', f.le_date === '2026-05-01', f.le_date);
check('and the older one is the second', f.le_months_2 === 195 && f.le_provider_2 === 'Polaris',
  `${f.le_provider_2} ${f.le_months_2}`);

console.log('\nTHE MEDICAL PICTURE ARRIVES AS BULLETS');
check('one impairment per line', f.impairments.split('\n').length === 2, JSON.stringify(f.impairments));
check('and a blank line in the middle is dropped, not printed',
  !/\n\s*\n/.test(f.impairments), JSON.stringify(f.impairments));
check('mitigating factors come too', /weight loss/.test(f.mitigating), f.mitigating);
check('so does the underwriter’s own sentence',
  /prior underwriting/.test(f.underwriter_note), f.underwriter_note);
check('and the date the records run to', f.records_through === '2026-04-30', f.records_through);

console.log('\nTHE PREMIUM SCHEDULE COMES WHOLE');
check('every posted payment is carried', got.premiums.length === 2, String(got.premiums.length));
check('with dates and amounts intact',
  got.premiums[0].due_date === '2026-10-26' && got.premiums[1].amount === 245091,
  JSON.stringify(got.premiums));

console.log('\nWHAT THE DOCUMENTS DID NOT SAY IS LEFT ALONE');
check('no asking price is invented — it is what you agreed, not what a PDF says',
  !('asking_price' in f), String(f.asking_price));
check('and no owner entity is chosen for you', !('fund_id' in f));
reply = { status: 200, body: { policy: {}, medical: {}, le_reports: [], read: ['x.pdf'] } };
const sparse = await readDocuments([pdf('x.pdf')]);
check('a document that yields nothing yields no fields, not empty ones',
  Object.keys(sparse.fields).length === 0, JSON.stringify(sparse.fields));
check('and no premium schedule', sparse.premiums.length === 0);
reply = { status: 200, body: ANSWER };

console.log('\nTHE CALL ITSELF');
/* Read again with both documents, so what is inspected below is the call
   this section is about rather than whichever one happened to run last. */
await readDocuments([pdf('illustration.pdf'), pdf('polaris.pdf')]);
check('it goes to the extraction endpoint', lastRequest.url === '/api/extract', lastRequest.url);
check('carrying the service’s own credentials, not the browser’s',
  lastRequest.auth === `Basic ${Buffer.from('stubuser:stubpass').toString('base64')}`,
  lastRequest.auth.slice(0, 12));
check('as multipart, with the files in it',
  /multipart\/form-data/.test(lastRequest.type) && lastRequest.bytes > 4000,
  `${lastRequest.type} ${lastRequest.bytes}b`);

console.log('\nWHEN IT CANNOT BE DONE');
let err = await readDocuments([{ originalname: 'notes.txt', buffer: Buffer.alloc(10) }])
  .then(() => null, (e) => e);
check('a file that is not a PDF is refused before anything is sent',
  err?.status === 400 && /PDF/i.test(err.message), err?.message);

reply = { status: 503, body: { error: 'Document reading is not configured on this service.' } };
err = await readDocuments([pdf('a.pdf')]).then(() => null, (e) => e);
check('a service with no key configured says so, in a sentence',
  err?.status === 503 && /not configured/i.test(err.message), err?.message);

reply = { status: 422, body: { error: 'The uploaded documents are too large for extraction.' } };
err = await readDocuments([pdf('a.pdf')]).then(() => null, (e) => e);
check('and a refusal from the reader is passed on as written',
  err?.status === 422 && /too large/.test(err.message), err?.message);

/* The failure that actually turned up in use: PolicyHub deployed, the
   valuation service not yet, so the route simply is not there. The old
   message said "the documents could not be read", which sent somebody to
   look at their PDF. It has to name the other end. */
reply = { status: 404, body: '<!doctype html><title>404 Not Found</title><h1>Not Found</h1>' };
err = await readDocuments([pdf('a.pdf')]).then(() => null, (e) => e);
check('a service without the reader says the service needs deploying, not the PDF',
  /has no document reader yet/i.test(err?.message || ''), err?.message);
check('and does not blame the document', !/could not be read/i.test(err?.message || ''),
  err?.message);

reply = { status: 401, body: 'Auth required' };
err = await readDocuments([pdf('a.pdf')]).then(() => null, (e) => e);
check('a credential mismatch names the two settings to compare',
  /VALUATION_USER/.test(err?.message || '') && /APP_USER/.test(err?.message || ''),
  err?.message);

reply = { status: 500, body: '<html><body><p>Internal Server Error</p></body></html>' };
err = await readDocuments([pdf('a.pdf')]).then(() => null, (e) => e);
check('an HTML fault carries its status and its words, with the tags stripped',
  /answered 500/.test(err?.message || '') && /Internal Server Error/.test(err?.message || '')
  && !/</.test(err?.message || ''), err?.message);

reply = { status: 200, body: 'not json at all' };
err = await readDocuments([pdf('a.pdf')]).then(() => null, (e) => e);
check('a success that is not a reading is reported as an older build',
  /older build/i.test(err?.message || ''), err?.message);

reply = { status: 200, body: ANSWER };

err = await readDocuments([pdf('huge.pdf', 26 * 1024 * 1024)]).then(() => null, (e) => e);
check('more than the reader will take is refused here, not there',
  err?.status === 413, err?.message);

stub.close();

/* ------------------------------------------------------------------ *
 * The door, against the real server
 * ------------------------------------------------------------------ */
console.log('\nWHO MAY READ DOCUMENTS');
const admin = await login(ADMIN.email, ADMIN.password);
const inv = await login(INVESTOR1.email, INVESTOR1.password);
const post = (cookie, body) => fetch(`${BASE}/api/opportunities/extract`,
  { method: 'POST', headers: { Cookie: cookie }, body });

const one = () => {
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.alloc(1024, 7)], { type: 'application/pdf' }), 'a.pdf');
  return fd;
};
check('an investor cannot', (await post(inv, one())).status === 403);
check('a signed-out visitor cannot',
  (await fetch(`${BASE}/api/opportunities/extract`, { method: 'POST', body: one() })).status === 401);

const empty = await post(admin, new FormData());
check('and an upload with no documents in it is refused', empty.status === 400,
  String(empty.status));

/* The server under test points at the local valuation service, which has
   no API key — so the honest answer is that reading is not configured,
   and it must arrive as that sentence rather than as a stack trace. */
const real = await post(admin, one());
const realBody = await real.json().catch(() => ({}));
check('against the real service, an unconfigured reader is reported plainly',
  [422, 503, 504].includes(real.status) && !/\.js:\d+|at Object/.test(JSON.stringify(realBody)),
  `${real.status} ${realBody.error || ''}`);

console.log(fails.length
  ? `\n${fails.length} EXTRACT CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL EXTRACT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
