/* =====================================================================
   Taking a report away.

   Three files, one reading of the table on screen. That is the point:
   the CSV, the workbook and the PDF all come from what the reader is
   looking at, including whichever columns they arranged, so none of
   them can quietly say something the document does not.

   The other half of this suite is that all three are exports. An export
   is an administrator's act, it is recorded, and every other
   administrator hears about it — a download that slipped past that
   would be a hole in the one control that covers somebody walking off
   with the book.

   Idempotent: its own policy, removed first and last.
   ===================================================================== */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'RPTDL';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const st of ['', 'Inforce', 'Lapsed', 'Matured', 'Sold', 'Pending'])
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX))
        await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();
/* A carrier whose name is one unbreakable word, and a figure with cents:
   between them they are what a file has to carry faithfully. */
const policy = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Albritton/brighthouse/Metlife',
  product_type: 'UL', fund_code: 'LCG1', face_amount: 18220665,
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Hugh & Evelyn',
  dob: '1931-03-03' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1100 },
  acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
p.on('dialog', (d) => { errs.push(`alert: ${d.message()}`); d.accept(); });

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 15000 });
await p.goto(`${BASE}/#/reports`); await p.waitForSelector('#rptGenerate');
await p.waitForTimeout(600);

console.log('THE BUTTONS');
check('nothing can be downloaded before a report is built',
  await p.locator('#rptPdf').isDisabled() && await p.locator('#rptCsv').isDisabled()
  && await p.locator('#rptXlsx').isDisabled());
await p.click('.rpt-choice:has(input[value="schedule"])'); await p.waitForTimeout(300);
await p.click('#rptGenerate'); await p.waitForSelector('.rpt-sheet', { timeout: 25000 });
await p.waitForTimeout(1200);
check('and all three are offered once it is', !(await p.locator('#rptPdf').isDisabled())
  && !(await p.locator('#rptCsv').isDisabled()) && !(await p.locator('#rptXlsx').isDisabled()));
check('Save as PDF is now Download PDF',
  (await p.locator('#rptPdf').textContent()).trim() === 'Download PDF');
check('and printing is still there for the document as it appears',
  (await p.locator('#rptPrint').textContent()).trim().startsWith('Print'));

const headers = await p.$$eval('.rpt-output thead th', (t) => t.map((x) => x.textContent.trim()));
const bodyRows = await p.locator('.rpt-output tbody tr').count();

const grab = async (selector) => {
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 25000 }),
    p.click(selector),
  ]);
  const path = `/tmp/${download.suggestedFilename()}`;
  await download.saveAs(path);
  return { path, name: download.suggestedFilename() };
};

console.log('\nAS A CSV');
const csv = await grab('#rptCsv');
const text = fs.readFileSync(csv.path, 'utf8');
check('it downloads without a dialog', fs.existsSync(csv.path), csv.name);
check('named for the report and the date it was run',
  /^policy-schedule-\d{4}-\d\d-\d\d\.csv$/.test(csv.name), csv.name);
check('with a byte order mark, so Excel reads it as UTF-8',
  text.charCodeAt(0) === 0xfeff);
const csvLines = text.replace(/^﻿/, '').trim().split('\n');
check('the header row is the columns on screen',
  csvLines[0] === headers.map((h) => `"${h}"`).join(','),
  csvLines[0].slice(0, 90));
check('and there is a line per row, plus the totals',
  csvLines.length === bodyRows + 2, `${csvLines.length} lines for ${bodyRows} rows`);
check('the long carrier name survives whole',
  text.includes('Albritton/brighthouse/Metlife'));
check('figures are figures, not "$1,234.00"',
  /,18220665,|,18220665$/m.test(text.replace(/"/g, '')),
  (text.match(/1822066\d[^,\n]*/) || ['not found'])[0]);

console.log('\nAS A WORKBOOK');
const xlsx = await grab('#rptXlsx');
const buf = fs.readFileSync(xlsx.path);
check('it downloads too', buf.length > 0, `${xlsx.name}, ${buf.length} bytes`);
check('and is a real zip, which is what an xlsx is',
  buf[0] === 0x50 && buf[1] === 0x4b, `${buf[0].toString(16)} ${buf[1].toString(16)}`);
const parts = buf.toString('latin1');
check('carrying the parts Excel looks for',
  parts.includes('xl/workbook.xml') && parts.includes('xl/worksheets/sheet1.xml')
  && parts.includes('[Content_Types].xml'));
check('with the figures written as numbers rather than text',
  /<v>18220665<\/v>/.test(parts));
check('and the header row set apart', /<c r="A1" s="1"/.test(parts));

console.log('\nAS A PDF');
const pdf = await grab('#rptPdf');
const bytes = fs.readFileSync(pdf.path);
check('one press and it is on disk — no print dialog',
  bytes.length > 1000, `${pdf.name}, ${bytes.length} bytes`);
check('and it is a PDF', bytes.subarray(0, 5).toString() === '%PDF-');
const pdfText = bytes.toString('latin1');
check('landscape, which is the shape of a schedule', /MediaBox \[0 0 792 612\]/.test(pdfText));
check('on the letterhead', pdfText.includes('Poel Capital'));
check('naming the report', /Policy schedule/i.test(pdfText));
check('and carrying the rows, not just a header',
  pdfText.includes(PREFIX), PREFIX);
/* A heading too long for its column wraps, so it is two text operators
   and never appears whole in the file. One that fits does. */
check('with the column headings on it',
  /CARRIER/.test(pdfText) && /OWNER/.test(pdfText) && /STATUS/.test(pdfText));
check('and figures grouped the way the screen groups them',
  /18,220,665/.test(pdfText));
await p.screenshot({ path: `${S}/rd1-reports.png`, fullPage: true });

/* ------------------------------------------------------------------ *
 * A report of many tables
 *
 * An investor statement is one page per investor and a fact sheet one per
 * policy: the same two or three headings, over and over. Both of the ways
 * of taking those away used to break quietly, which is the worst way for
 * them to break -- a file arrives, it looks like the document, and it is
 * not the document.
 * ------------------------------------------------------------------ */
console.log('\nA REPORT OF MANY TABLES');
await p.click('.rpt-choice:has(input[value="investor"])');
await p.waitForTimeout(300);
await p.click('#rptGenerate'); await p.waitForSelector('.rpt-sheet', { timeout: 40000 });
await p.waitForTimeout(1500);
const onScreen = await p.locator('.rpt-output table.rpt-table').count();
check('the statement is more than one table', onScreen > 1, `${onScreen} tables`);

const manyPdf = await grab('#rptPdf');
const manyBytes = fs.readFileSync(manyPdf.path);
const manyText = manyBytes.toString('latin1');
check('the PDF is drawn', manyBytes.subarray(0, 5).toString() === '%PDF-',
  `${manyPdf.name}, ${manyBytes.length} bytes`);
check('its subtitle counts the whole document, not the first table',
  new RegExp(`${onScreen} tables`).test(manyText),
  (manyText.match(/\d+ tables[^)]*/) || ['no count on it'])[0]);

const manyXlsx = await grab('#rptXlsx');
const wbNames = [...fs.readFileSync(manyXlsx.path).toString('latin1')
  .matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
check('the workbook has a tab per table', wbNames.length === onScreen,
  `${wbNames.length} tabs for ${onScreen} tables`);
/* Two tabs may not share a name. Excel does not say which one is the
   duplicate -- it refuses the file and reports "a problem with some
   content" -- so this is the difference between a workbook and nothing. */
check('and no two of them share a name, which Excel will not open',
  new Set(wbNames).size === wbNames.length,
  `${new Set(wbNames).size} distinct of ${wbNames.length}`);
check('with the person named on the tab, not just the section',
  wbNames.some((n) => n.includes(' - ')), wbNames[0]);
check('and none longer than Excel allows',
  wbNames.every((n) => n.length <= 31),
  String(Math.max(...wbNames.map((n) => n.length))));
for (const f of [manyPdf.path, manyXlsx.path]) fs.rmSync(f, { force: true });

/* How far the drawer actually goes, asked of it directly rather than
   through whatever happens to be in this database. It used to take
   twenty-four tables and silently drop the rest, so a statement for sixty
   investors arrived three pages long and looking complete. */
console.log('\nNOTHING IS DROPPED ON THE WAY TO PAPER');
const sheetsOf = (n, rows = 1) => Array.from({ length: n }, (_, i) => ({
  name: `Table ${i + 1}`, columns: [{ header: 'a' }, { header: 'b' }],
  rows: Array.from({ length: rows }, () => ['x', 'y']),
}));
const drawn = async (body) => {
  const r = await api('/reports/pdf', { method: 'POST', body });
  if (r.status !== 200) return { status: r.status, pages: 0, text: '' };
  const text = Buffer.from(await r.arrayBuffer()).toString('latin1');
  return { status: 200, pages: Number((/\/Count (\d+)/.exec(text) || [])[1] || 0), text };
};
const small = await drawn({ title: 'x', sheets: sheetsOf(10) });
const big = await drawn({ title: 'x', sheets: sheetsOf(120) });
check('ten tables draw', small.status === 200 && small.pages > 0, `${small.pages} pages`);
check('and a hundred and twenty draw too', big.status === 200, String(big.status));
check('twelve times the tables is many times the pages, not the same three',
  big.pages > small.pages * 6, `${small.pages} pages for 10, ${big.pages} for 120`);
/* Section headings are drawn in capitals, as they are on screen. */
check('and the last table is on it as well as the first',
  /TABLE 1\b/.test(big.text) && /TABLE 120\b/.test(big.text),
  /TABLE 120\b/.test(big.text) ? 'the first and the hundred and twentieth'
    : 'the last one is missing');

console.log('\nAND ONE TOO BIG TO DRAW IS REFUSED, NOT SHORTENED');
const tooBig = async (body) => {
  const r = await api('/reports/pdf', { method: 'POST', body });
  return { status: r.status, error: (await json(r))?.error || '' };
};
const many = await tooBig({ title: 'x', sheets: sheetsOf(401) });
check('four hundred and one tables is refused', many.status === 400, many.error.slice(0, 80));
check('and the refusal says the document on screen is still whole',
  /nothing has been left out/i.test(many.error), many.error.slice(0, 110));
const deep = await tooBig({ title: 'x', sheets: sheetsOf(10, 2500) });
check('and so is a report of more rows than it will draw', deep.status === 400,
  deep.error.slice(0, 80));
check('which says how many rows that was, so the number is not a mystery',
  /25,000/.test(deep.error), deep.error.slice(0, 110));
const wide = await tooBig({ title: 'x', sheets: [{
  columns: Array.from({ length: 61 }, (_, i) => ({ header: `c${i}` })), rows: [] }] });
check('a table wider than it will draw is refused too', wide.status === 400,
  wide.error.slice(0, 80));
check('and says where to switch columns off', /columns/i.test(wide.error),
  wide.error.slice(0, 110));
/* The ceiling has to be above a real book, or refusing is just a
   different way of not producing the document. */
const real = await tooBig({ title: 'x', sheets: sheetsOf(300, 40) });
check('a book-sized report is well inside it', real.status === 200,
  `${real.status} for 300 tables of 40 rows`);

console.log('\nEVERY ONE OF THEM IS AN EXPORT');
const log = await json(await api('/audit?limit=40'));
const mine = (log.rows || log || []).filter((e) =>
  /export/i.test(e.entity || '') || /export/i.test(e.detail || ''));
check('the download is recorded in the activity log',
  mine.some((e) => /reports/i.test(e.detail || '')),
  (mine[0]?.detail || 'nothing recorded').slice(0, 90));
check('and the PDF separately, since it is drawn server-side',
  mine.some((e) => /as PDF/i.test(e.detail || '')),
  (mine.find((e) => /as PDF/i.test(e.detail || ''))?.detail || 'not recorded').slice(0, 90));

console.log('\nAND AN EXPORT IS AN ADMINISTRATOR’S ACT');
const mgr = await login(MANAGER1.email, MANAGER1.password);
check('a manager cannot record one',
  (await fetch(`${BASE}/api/exports`, { method: 'POST',
    headers: { Cookie: mgr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'reports', rows: 1 }) })).status === 403);
check('nor ask the server to draw them a PDF',
  (await fetch(`${BASE}/api/reports/pdf`, { method: 'POST',
    headers: { Cookie: mgr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', sheets: [{ columns: [{ header: 'a' }], rows: [['b']] }] }),
  })).status === 403);
check('and a request with no table in it is refused rather than drawn empty',
  (await api('/reports/pdf', { method: 'POST', body: { title: 'x', sheets: [] } })).status === 400);

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
for (const f of [csv.path, xlsx.path, pdf.path]) fs.rmSync(f, { force: true });
await wipe();
console.log(fails.length
  ? `\n${fails.length} REPORT DOWNLOAD CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL REPORT DOWNLOAD CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
