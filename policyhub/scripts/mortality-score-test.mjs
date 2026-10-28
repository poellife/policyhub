/* =====================================================================
   Mortality Watch scoring, against the original tool's own cases.

   The rubric was carried over from the standalone Python tool so that a
   75 means the same thing in both. These are that tool's tests, case for
   case and point for point; if any of them moves, the port has drifted.
   No server, no database rows — the scorer is pure.
   ===================================================================== */
import './test-config.mjs';
import {
  score, person, tierOf, findDob, findDod, findAge, mentionsState, splitJoint, buildQueries,
  htmlToText, parseLooseDate, VendorFile, httpGet, localHour, localDay,
} from '../src/mortality-watch.js';
import { pool } from '../src/db.js';

const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const TODAY = '2026-10-28';
const PEGGY = person({ id: 1, name: 'Margaret Ann Kowalski', aka: 'Peggy; née Novak',
  dob: '1938-04-12', city: 'Dearborn', state: 'MI', prior_residence: 'Toledo, OH',
  family: 'Spouse: Walter; children: Linda' });
const cand = (title, text, extra = {}) => ({ url: 'https://example.com/x', source_name: 'test',
  title, text, ...extra });

console.log('THE ORIGINAL TOOL’S CASES');
{
  const r = score(PEGGY, cand('Margaret Ann (Novak) Kowalski Obituary - Dearborn, MI',
    'Margaret Ann Kowalski, of Dearborn, Michigan, passed away on October 21, 2026. '
    + 'She was born April 12, 1938 in Toledo. Wife of the late Walter; mother of Linda.'), TODAY);
  check('a full match scores 100 and is likely', r.score === 100 && tierOf(r) === 'likely',
    `${r.score} ${JSON.stringify(r.factors.map((f) => f.label))}`);
  check('and carries the date of death', r.dod === '2026-10-21', r.dod);
}
{
  const r = score(PEGGY, cand('Peggy Kowalski',
    'Peggy Kowalski, 88, of Livonia, Michigan died October 21, 2026.'), TODAY);
  check('nickname + age + state is 53, possible', r.score === 53 && tierOf(r) === 'possible',
    `${r.score} ${JSON.stringify(r.factors.map((f) => `${f.label}:${f.points}`))}`);
}
{
  const r = score(PEGGY, cand('Margaret Kowalski',
    'Margaret Kowalski, 54, of Dearborn, MI died October 1, 2026.'), TODAY);
  check('a conflicting age discards it', r.discarded_reason === 'age_conflict', r.discarded_reason);
}
{
  const r = score(PEGGY, cand('Margaret Smith Obituary', 'Dearborn, MI'), TODAY);
  check('a wrong surname discards it', r.discarded_reason === 'surname', r.discarded_reason);
}
{
  const r = score(PEGGY, cand('Margaret Kowalski Obituary (1938 - 2026) - Toledo, OH', ''), TODAY);
  check('a birth-year range from a prior residence is 63', r.score === 63,
    `${r.score} ${JSON.stringify(r.factors.map((f) => `${f.label}:${f.points}`))}`);
}
{
  const claire = person({ id: 2, name: 'Claire Engler', dob: null, city: '', state: '',
    family: 'Spouse: Moe' });
  const r = score(claire, cand('Claire Engler Obituary (2026) - Delray Beach, FL',
    'Claire Engler, 97, passed away August 24, 2026. Born May 14, 1929. '
    + 'She was predeceased by her beloved husband Moe in 2021.'), TODAY);
  check('a spouse lifts a sparse record to 53', r.score === 53, String(r.score));
  check('and it says there was no birth date to compare',
    r.factors.some((f) => f.label.includes('no DOB on file')));
}
{
  const bernard = person({ id: 3, name: 'Bernard Leo Feinstein', dob: '1936-07-04',
    city: 'Boca Raton', state: 'FL' });
  const r = score(bernard, { url: 'vendor://x', source_name: 'vendor', title: 'BERNARD L FEINSTEIN',
    name: 'BERNARD L FEINSTEIN', dob: '1936-07-04', dod: '2026-10-02', city: 'BOCA RATON',
    state: 'FL', text: '' }, TODAY);
  check('a structured vendor record scores 100', r.score === 100, String(r.score));
}
check('a two-letter state needs the "City, ST" form',
  !mentionsState('He was IN the garden', 'IN') && mentionsState('of Carmel, IN', 'IN')
  && mentionsState('lived in Indiana', 'IN'));
{
  const t = 'John Doe (March 3, 1940 – September 9, 2026) of Ames, Iowa';
  check('dates of birth and death are read from a range',
    findDob(t) === '1940-03-03' && findDod(t) === '2026-09-09', `${findDob(t)} ${findDod(t)}`);
  check('an age is read', findAge('died peacefully at the age of 86') === 86);
}

console.log('\nWHAT THE PORTAL ADDS');
{
  const s = splitJoint('Moe And Claire', 'Engler');
  check('a joint insured is split into two people',
    s.length === 2 && s[0].name === 'Moe Engler' && s[1].name === 'Claire Engler',
    JSON.stringify(s));
  check('a single insured is one', splitJoint('Margaret', 'Kowalski').length === 1);
}
{
  const qs = buildQueries(PEGGY, 5);
  check('the search queries lead with name and place',
    qs[0] === '"Margaret Kowalski" obituary Dearborn MI', qs[0]);
  check('and include the maiden name', qs.some((x) => x.includes('"Novak"')), qs.join(' | '));
  check('and stop at the limit', buildQueries(PEGGY, 2).length === 2);
}
check('page text drops scripts and keeps line breaks',
  htmlToText('<p>Margaret</p><script>var x=1</script><p>Kowalski &amp; family</p>')
    === 'Margaret\nKowalski & family',
  JSON.stringify(htmlToText('<p>Margaret</p><script>var x=1</script><p>Kowalski &amp; family</p>')));
check('vendor dates in three shapes',
  parseLooseDate('2026-10-02') === '2026-10-02' && parseLooseDate('10/02/2026') === '2026-10-02'
  && parseLooseDate('20261002') === '2026-10-02' && parseLooseDate('2026-02-30') === null);
{
  /* The original tool's vendor case: Feinstein matches; the Whitcomb
     record, born 1952, conflicts with the insured's DOB and is discarded. */
  const vf = new VendorFile('Vendor', [
    { first_name: 'BERNARD', middle_name: 'L', last_name: 'FEINSTEIN', dob: '07/04/1936',
      dod: '10/02/2026', city: 'BOCA RATON', state: 'FL', reference: 'SAMPLE-0001' },
    { first_name: 'HAROLD', middle_name: '', last_name: 'WHITCOMB', dob: '03/15/1952',
      dod: '09/11/2026', city: 'AKRON', state: 'OH', reference: 'SAMPLE-0002' }]);
  const bernard = person({ name: 'Bernard Leo Feinstein', dob: '1936-07-04', city: 'Boca Raton', state: 'FL' });
  const harold = person({ name: 'Harold James Whitcomb', aka: 'Hal', dob: '1941-09-30',
    city: 'Sarasota', state: 'FL', prior_residence: 'Grand Rapids, MI' });
  const b = (await vf.search(bernard)).map((c) => score(bernard, c, TODAY));
  const h = (await vf.search(harold)).map((c) => score(harold, c, TODAY));
  check('the vendor file finds Feinstein at 100', b.length === 1 && b[0].score === 100,
    JSON.stringify(b.map((x) => x.score)));
  check('and discards Whitcomb on his birth date', h.length === 1 && !!h[0].discarded_reason,
    JSON.stringify(h.map((x) => x.discarded_reason)));
}

console.log('\nTHE DAILY CLOCK IS THE OFFICE’S, NOT THE SERVER’S');
/* 3am UTC on the 28th is still the evening of the 27th in Michigan, so a
   server in UTC must not think the office's day has turned over. */
check('the day is read in the office’s time zone',
  localDay('America/Detroit', new Date('2026-10-28T03:00:00Z')) === '2026-10-27',
  localDay('America/Detroit', new Date('2026-10-28T03:00:00Z')));
check('and so is the hour', localHour('America/Detroit', new Date('2026-10-28T10:30:00Z')) === 6,
  String(localHour('America/Detroit', new Date('2026-10-28T10:30:00Z'))));

console.log('\nTHE SERVER WILL NOT FETCH ITS OWN NETWORK');
/* An administrator can add any address as a source, and a listing page
   links wherever it likes. Neither may make the server read loopback,
   the cloud metadata address, or a private range. */
delete process.env.MW_ALLOW_PRIVATE_FETCH;
for (const [label, u] of [['loopback', 'http://127.0.0.1:9/'], ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
  ['a private range', 'http://10.0.0.5/'], ['localhost by name', 'http://localhost:9/'],
  ['IPv6 loopback', 'http://[::1]:9/']]) {
  let err = '';
  try { await httpGet(u, { timeoutMs: 2000, minIntervalMs: 0 }); } catch (e) { err = e.message; }
  check(`refused: ${label}`, /private address/.test(err), err);
}
{
  let err = '';
  try { await httpGet('file:///etc/passwd'); } catch (e) { err = e.message; }
  check('and anything that is not a web address', /not a web address/.test(err), err);
}

await pool.end();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All mortality scoring checks passed.'}`);
process.exit(fails.length ? 1 : 0);
