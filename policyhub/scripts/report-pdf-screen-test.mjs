/* =====================================================================
   A report's Download PDF is the report on the screen.

   Built in the browser from the sheet as drawn -- same tiles, same tables,
   same type -- paginated at row boundaries. What has to be true:
     - The download is a real PDF, Letter, portrait or landscape as the
       report prints, with one page per screen's worth and more for more.
     - It is pictures of the sheet (so it looks like the screen), and it
       does not go through the old server-side table renderer.
     - Under the page's content security policy, with no errors.
     - Still recorded, and still an administrator's.

   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'RPTPDF';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const admin = await login(ADMIN.email, ADMIN.password);
const api = async (p, o = {}) => { const r = await fetch(`${BASE}/api${p}`, { ...o,
  body: o.body ? JSON.stringify(o.body) : undefined, headers: { Cookie: admin, 'Content-Type': 'application/json' } });
  try { return await r.json(); } catch { return null; } };
const wipe = async () => {
  for (const x of ((await api('/policies?status=')) || []).filter((y) => String(y.policy_number).startsWith(PREFIX)))
    await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
};
await wipe();
for (let i = 0; i < 45; i++)
  await api('/policies', { method: 'POST', body: { policy_number: `${PREFIX}-${i}`, carrier_name: 'Paper Life',
    product_type: 'UL', fund_code: i % 2 ? 'LCG1' : 'LCG2', face_amount: 1000000 + i * 100000,
    insured_last_name: `Pagewright${i}`, insured_first_name: 'Ida', dob: `${1930 + (i % 25)}-03-0${1 + (i % 9)}` } });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (who) => {
  const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/401/.test(m.text()) && errs.push(m.text()));
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row', { timeout: 20000 });
  await p.goto(`${BASE}/#/reports`);
  await p.waitForSelector('#rptGenerate', { timeout: 20000 });
  return p;
};
const p = await open(ADMIN);
const serverPdf = [];
p.on('request', (r) => { if (r.url().includes('/api/reports/pdf')) serverPdf.push(r.url()); });
const pdfOf = async (type) => {
  await p.click(`.rpt-choice:has(input[value="${type}"])`);
  await p.click('#rptGenerate');
  await p.waitForSelector('.rpt-sheet', { timeout: 20000 });
  await p.waitForTimeout(1000);
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 90000 }), p.click('#rptPdf')]);
  const path = await dl.path();
  const fs = await import('node:fs');
  return { name: dl.suggestedFilename(), text: fs.readFileSync(path).toString('latin1') };
};
const pages = (t) => (t.match(/\/Type \/Page\b/g) || []).length;
const box = (t) => (t.match(/\/MediaBox \[([^\]]+)\]/) || [])[1]?.trim().split(/\s+/).map(Number);

console.log('A PORTRAIT REPORT');
const age = await pdfOf('age');
check('it downloads as a PDF', age.text.startsWith('%PDF-') && /\.pdf$/.test(age.name), age.name);
check('Letter portrait', JSON.stringify(box(age.text)?.slice(2).map(Math.round)) === '[612,792]', JSON.stringify(box(age.text)));
check('45 policies run to more than one page', pages(age.text) >= 2, `${pages(age.text)} pages`);
check('drawn as pictures of the sheet', /\/Subtype \/Image/.test(age.text));

console.log('\nA LANDSCAPE REPORT');
const sch = await pdfOf('schedule');
check('Letter landscape', JSON.stringify(box(sch.text)?.slice(2).map(Math.round)) === '[792,612]', JSON.stringify(box(sch.text)));

console.log('\nHOW IT WAS MADE');
check('not by the old server-side table renderer', serverPdf.length === 0, serverPdf.join(', '));
const audit = (await api('/audit')) || [];
check('and each download is recorded', audit.some((a) => /reports/i.test(`${a.detail || ''} ${a.entity || ''}`)));
check('no errors, content security policy included', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log('\nSTILL AN ADMINISTRATOR’S');
const m = await open(MANAGER1);
await m.click('.rpt-choice:has(input[value="valuation"])');
await m.click('#rptGenerate');
await m.waitForSelector('.rpt-sheet', { timeout: 20000 });
let alerted = '';
m.on('dialog', async (d) => { alerted = d.message(); await d.dismiss(); });
let downloaded = false;
m.on('download', () => { downloaded = true; });
await m.click('#rptPdf');
await m.waitForTimeout(2500);
check('a manager is told to ask, and nothing downloads', !downloaded && /administrator/i.test(alerted), alerted);
await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All report PDF checks passed.'}`);
process.exit(fails.length ? 1 : 0);
