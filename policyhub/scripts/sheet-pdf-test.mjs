/* =====================================================================
   The one-pager as a downloaded file.

   The browser will not save a PDF without a dialog and an argument about
   margins, so a one-press download has to be drawn on the server — the
   same reason /reports/pdf exists. What is under test is that the file
   is a real PDF, that it is the same document as the screen, and above
   all that it carries the same two rules the HTML sheet carries:
   landscape, and initials rather than a name.

   The last one matters most. This is the copy that leaves the building,
   and a second implementation of a document is exactly where a rule
   quietly stops being applied.

   Idempotent: one fixture deal with a distinctive name, removed first
   and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'PDFSH';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);

const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const FIRST = 'Zephaniah';
const LAST = 'Quillfeather';

const opp = await json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Discreet Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: LAST, insured_first_name: FIRST,
  insured_dob: '1948-03-11', insured_gender: 'F', insured_state: 'MI',
  le_months: 108, le_provider: 'ITM21st', le_date: '2026-04-01',
  asking_price: 900000, annual_premium: 70000,
  expected_close: '2026-11-30', offer_closes_on: '2027-05-31', fund_id: lcg1.id,
  /* An en-dash and an em-dash on purpose: WinAnsi has no glyph for
     either, and text written without transliteration comes out as a gap
     rather than as a dash. That is how "ages 67-69" became "ages 6769". */
  thesis: 'A three-year premium holiday at ages 67–69 — worth having.',
  impairments: 'Oncology: metastatic disease\nCardiovascular: prior MI',
  underwriter_note: 'Records complete through March 2026.' } }));

const grab = async (cookie, query = '') => {
  const r = await fetch(`${BASE}/api/opportunities/${opp.id}/sheet.pdf${query}`,
    { headers: { Cookie: cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type') || '',
    disp: r.headers.get('content-disposition') || '', buf, text: buf.toString('latin1') };
};

/* ------------------------------------------------------------------ *
 * It is a file
 * ------------------------------------------------------------------ */
console.log('IT COMES BACK AS A FILE, NOT A PAGE');
const pdf = await grab(admin, '?share=100&interest=both');
check('the request succeeds', pdf.status === 200, String(pdf.status));
check('and it is a PDF', pdf.type === 'application/pdf', pdf.type);
check('served as an attachment, so the browser saves it rather than showing it',
  /^attachment;/.test(pdf.disp), pdf.disp);
check('named for the deal, not "sheet.pdf"',
  /filename="PDFSH-1-one-pager\.pdf"/.test(pdf.disp), pdf.disp);
check('and it really is a PDF, header and trailer',
  pdf.text.startsWith('%PDF-') && pdf.text.trimEnd().endsWith('%%EOF'));

const pageCount = (t) =>
  (t.split('/Type /Page').length - 1) - (t.split('/Type /Pages').length - 1);
check('with pages in it', pageCount(pdf.text) >= 1, `${pageCount(pdf.text)} pages`);

console.log('\nAND IT PRINTS LANDSCAPE');
const boxes = [...pdf.text.matchAll(/\/MediaBox \[([^\]]+)\]/g)]
  .map((m) => m[1].trim().split(/\s+/).map(Number));
check('every page is wider than it is tall',
  boxes.length > 0 && boxes.every((b) => b[2] > b[3]), JSON.stringify(boxes[0]));
check('and it is Letter on its side — 792 by 612 points',
  boxes[0][2] === 792 && boxes[0][3] === 612, JSON.stringify(boxes[0]));

/* ------------------------------------------------------------------ *
 * The name is not in it
 * ------------------------------------------------------------------ */
console.log('\nTHE NAME IS NOT IN THE FILE');
check('the surname appears nowhere in the bytes', !pdf.text.includes(LAST));
check('nor the given name', !pdf.text.includes(FIRST));
check('but the initials do', pdf.text.includes('Z.Q.'));
check('and it says the omission is deliberate',
  /IDENTIFIED BY INITIALS/i.test(pdf.text));

console.log('\nTHE FIGURES ARE THE SAME ONES THE SCREEN HAS');
const detail = await json(await api(admin, `/opportunities/${opp.id}`));
const atLe = detail.analysis.scenarios.find((s) => s.offset_months === 0);
const pct = (r) => `${(r * 100).toFixed(2)}%`;
check('the simple rate at life expectancy is on it', pdf.text.includes(pct(atLe.rate)),
  pct(atLe.rate));
check('and the compounding one, because "both" was asked for',
  pdf.text.includes(pct(atLe.compound_rate)), pct(atLe.compound_rate));
check('the death benefit is on it', pdf.text.includes('4,000,000.00'));
check('and the purchase price', pdf.text.includes('900,000.00'));

const simpleOnly = await grab(admin, '?share=100&interest=simple');
check('asking for simple leaves the compounding figure out',
  simpleOnly.text.includes(pct(atLe.rate)) && !simpleOnly.text.includes(pct(atLe.compound_rate)));
const cmpOnly = await grab(admin, '?share=100&interest=compound');
check('and asking for compounded leaves the simple one out',
  cmpOnly.text.includes(pct(atLe.compound_rate)) && !cmpOnly.text.includes(pct(atLe.rate)));

console.log('\nCHARACTERS WINANSI HAS NO GLYPH FOR ARE TRANSLITERATED, NOT DROPPED');
check('an en-dash between two ages survives as a dash',
  /ages 67-69/.test(pdf.text), (pdf.text.match(/ages 6[^)]{0,6}/) || [''])[0]);
check('and an em-dash does not swallow the words either side',
  /holiday at ages 67-69 -- worth having/.test(pdf.text),
  (pdf.text.match(/holiday at[^)]{0,40}/) || [''])[0]);

/* ------------------------------------------------------------------ *
 * Participation
 * ------------------------------------------------------------------ */
console.log('\nA PARTICIPATION SHEET IS SCALED, NOT RELABELLED');
const tenth = await grab(admin, '?share=10&interest=simple');
check('10% of a $900,000 price is what it asks for', tenth.text.includes('90,000.00'));
check('and 10% of the benefit is what it offers', tenth.text.includes('400,000.00'));
check('it says which share it is', /10% participation/.test(tenth.text));
check('a nonsense share falls back to the whole policy rather than refusing',
  (await grab(admin, '?share=-4')).text.includes('900,000.00'));

/* ------------------------------------------------------------------ *
 * Who may take it
 * ------------------------------------------------------------------ */
console.log('\nWHO MAY TAKE A COPY');
await api(admin, `/opportunities/${opp.id}/shares`, {
  method: 'PUT', body: { investor_ids: [me1] } });
check('an investor the deal was shared with may download it',
  (await grab(inv1, '')).status === 200);
check('an investor it was not shared with cannot',
  (await grab(inv2, '')).status === 404, String((await grab(inv2, '')).status));
check('a manager in the entity may', (await grab(pm1, '')).status === 200);

const anon = await fetch(`${BASE}/api/opportunities/${opp.id}/sheet.pdf`);
check('and nobody signed out gets anything', anon.status === 401 || anon.status === 403,
  String(anon.status));

console.log('\nAND IT IS RECORDED');
const log = await json(await api(admin, '/audit?limit=40'));
const rows = Array.isArray(log) ? log : (log?.rows || log?.entries || []);
check('the audit log has rows to read', rows.length > 0, String(rows.length));
check('and the download left a line in it',
  rows.some((r) => /downloaded the one-pager/i.test(JSON.stringify(r))),
  (rows.find((r) => /one-pager/i.test(JSON.stringify(r)))?.detail || '').slice(0, 90));
check('the line names the deal, not the insured',
  !JSON.stringify(rows).includes(LAST));

await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All one-pager PDF checks passed.'}`);
process.exit(fails.length ? 1 : 0);
