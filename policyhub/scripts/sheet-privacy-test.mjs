/* =====================================================================
   The one-pager carries initials, never a name.

   This is the one document in the application that leaves the building.
   It carries a life expectancy, an age, a state and the list of
   diagnoses driving that expectancy — which makes it a medical file, and
   a medical file with a name on it is a different object from one
   without. The recipients have signed for it and they still do not need
   to know who she is.

   So the test is deliberately blunt: take the insured's actual first and
   last name and assert that neither string appears anywhere in the
   rendered document. Not in the heading, not in the deal terms, not in
   the footer, not in a title attribute. If a future change puts the name
   back on the page in a way nobody thought of, this fails.

   Idempotent: one fixture deal with a distinctive name, removed first
   and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'PRIVSH';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, { ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: admin, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const funds = await json(await api('/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

/* Names chosen so that a partial match cannot pass by accident: neither
   appears inside a carrier, a product type, a month or a number. */
const FIRST = 'Zephaniah';
const LAST = 'Quillfeather';

const opp = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Discreet Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: LAST, insured_first_name: FIRST,
  insured_dob: '1948-03-11', insured_gender: 'F', insured_state: 'MI',
  le_months: 96, le_provider: 'ITM21st', le_date: '2026-04-01',
  asking_price: 900000, annual_premium: 70000,
  expected_close: '2026-11-30', offer_closes_on: '2027-05-31', fund_id: lcg1.id,
  impairments: 'Oncology: metastatic disease\nCardiovascular: prior MI',
  underwriter_note: 'Records complete through March 2026.' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1400, height: 1200 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/opportunity/${opp.id}/sheet-100`);
await p.waitForSelector('.rpt-sheet', { timeout: 20000 });
await p.waitForTimeout(900);

/* The whole document, markup included — a name in a tooltip or an aria
   label is still a name on the page. */
const sheetHtml = await p.locator('.rpt-sheet').innerHTML();
const sheetText = await p.locator('.rpt-sheet').innerText();

console.log('THE NAME IS NOT ON THE DOCUMENT');
check('the surname appears nowhere in the sheet', !sheetHtml.includes(LAST));
check('nor the given name', !sheetHtml.includes(FIRST));
check('not even in an attribute, a title or a label',
  !new RegExp(`${FIRST}|${LAST}`, 'i').test(sheetHtml));

console.log('\nBUT THE INSURED IS STILL IDENTIFIED');
check('the heading carries the initials', /\bZ\.Q\.\B|\bZ\.Q\./.test(sheetText),
  sheetText.split('\n').find((l) => /Z\.Q/.test(l)) || sheetText.slice(0, 80));
/* One line, whitespace collapsed: the key-value table puts the label and
   the value in separate cells and innerText spaces them generously. */
const flat = sheetText.replace(/\s+/g, ' ');
check('and so does the deal terms row',
  /INSURED Z\.Q\./i.test(flat),
  (flat.match(/INSURED[^A-Z]{0,40}/) || [''])[0]);
check('with the age and sex beside it, which identify nobody',
  /INSURED Z\.Q\. · 7[0-9] · F/i.test(flat),
  (flat.match(/INSURED[^A-Z]{0,30}/) || [''])[0]);

console.log('\nAND IT SAYS THE OMISSION IS DELIBERATE');
check('the confidentiality line explains the initials',
  /identified by initials/i.test(sheetText),
  (sheetText.match(/Confidential[^\n]*/i) || [''])[0].slice(0, 130));

console.log('\nTHE REST OF THE SHEET IS UNCHANGED');
check('the medical picture is still there — it is what the reader is weighing',
  /metastatic disease/i.test(sheetText));
check('and the figures', /\$4,000,000/.test(sheetText) && /\$900,000/.test(sheetText));
check('and the carrier and policy number, which are the deal’s identity',
  /Discreet Life/i.test(sheetText) && sheetText.includes(`${PREFIX}-1`));

/* ------------------------------------------------------------------ *
 * The page it prints on
 *
 * The sheet prints landscape, and the check is the real thing: the PDF
 * the browser would produce from the Save-as-PDF button, measured. A
 * MediaBox of 792x612 points is Letter on its side; 612x792 is not.
 * ------------------------------------------------------------------ */
console.log('\nAND IT PRINTS LANDSCAPE');
await p.emulateMedia({ media: 'print' });
const pdf = await p.pdf({ preferCSSPageSize: true, printBackground: true });
const boxes = [...pdf.toString('latin1').matchAll(/\/MediaBox \[([^\]]+)\]/g)]
  .map((m) => m[1].trim().split(/\s+/).map(Number));
const landscape = boxes.filter((b) => b[2] > b[3]);
check('every page is wider than it is tall',
  boxes.length > 0 && landscape.length === boxes.length,
  JSON.stringify(boxes[0]));
check('and it is Letter, on its side — 792 by 612 points',
  boxes[0] && Math.round(boxes[0][2]) === 792 && Math.round(boxes[0][3]) === 612,
  JSON.stringify(boxes[0]));
await p.emulateMedia({ media: 'screen' });

console.log('\nTHE NAME IS STILL THERE INSIDE THE APPLICATION');
await p.goto(`${BASE}/#/opportunity/${opp.id}`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(700);
check('staff working the deal see who it is',
  (await p.locator('h1').innerText()).includes(LAST),
  await p.locator('h1').innerText());

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All one-pager privacy checks passed.'}`);
process.exit(fails.length ? 1 : 0);
