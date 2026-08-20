/* =====================================================================
   The dashboard and the Premiums page must agree.

   A premium reaches an investor from either of two places: a next-due date
   the carrier put on the policy, or a premium somebody here posted to the
   schedule. Whoever has to fund it does not care which table it came from.

   The Portfolio card used to read only the first of those, so a book
   funded entirely from posted schedules — which is what any import
   without a next-due column produces — said "no premium dates are
   scheduled" on the dashboard while the Premiums page one click away
   listed every one of them.

   So this drives a book with one of each and asserts the two screens show
   the same dates and the same money.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'PREMDUE';
const FUND = 'PREMDUEF';
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
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const inv = await login(INVESTOR1.email, INVESTOR1.password);
const me = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: inv } }))).investor.id;

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(`/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  for (const f of ((await json(await api('/funds'))) || []).filter((x) => x.code === FUND))
    await api(`/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();

const make = async (tag, extra) => {
  const p = await json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Duebank Life', product_type: 'UL',
    fund_code: FUND, face_amount: 2000000, premium_mode: 'Annual',
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', dob: '1937-05-05',
    ...extra } }));
  await api(`/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: me, pct: 50, acquired_on: iso(-200) } });
  return p;
};

/* One with a carrier next-due date and no schedule. One with a schedule and
   no next-due date — the shape an import produces, and the one that used to
   vanish from the dashboard. */
const carrierDated = await make('CARRIERDATE', {
  premium_required: 40000, next_premium_due: iso(20) });
const scheduleOnly = await make('SCHEDULEONLY', { premium_required: 60000 });
for (const d of [40, 405]) {
  const r = await api(`/policies/${scheduleOnly.id}/reminders`, { method: 'POST', body: {
    due_date: iso(d), kind: 'Premium', amount: 60000, note: 'Annual premium' } });
  if (r.status !== 201) console.log('   (schedule row refused:', r.status, await r.text(), ')');
}

const svc = await json(await fetch(`${BASE}/api/servicing?fund=${FUND}`, { headers: { Cookie: inv } }));
check('the API carries a carrier-dated premium', (svc.upcoming || []).length >= 1,
  String((svc.upcoming || []).length));
check('and a posted schedule', (svc.scheduled || []).filter((r) => r.kind === 'Premium').length >= 1,
  String((svc.scheduled || []).length));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]|429/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', INVESTOR1.email); await p.fill('#password', INVESTOR1.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 15000 });
await p.waitForTimeout(1500);

/** The dates and amounts a card is showing, as plain strings. */
const readCard = async (heading) => p.evaluate((h) => {
  const card = [...document.querySelectorAll('.card')]
    .find((c) => c.querySelector('h2')?.textContent.trim() === h);
  if (!card) return null;
  return [...card.querySelectorAll('tbody tr')].map((tr) => {
    const td = [...tr.querySelectorAll('td')].map((x) => x.textContent.trim());
    return td.length >= 4 ? { due: td[0], policy: td[2], share: td[3] } : null;
  }).filter(Boolean);
}, heading);

console.log('THE PORTFOLIO CARD');
const dash = await readCard('Premiums coming up');
check('is not empty when premiums are only on a schedule',
  Array.isArray(dash) && dash.length > 0,
  dash === null ? 'card missing' : `${(dash || []).length} rows`);
check('and lists the schedule-only policy, which is the one that used to vanish',
  (dash || []).some((r) => /SCHEDULEONLY/.test(r.policy)),
  (dash || []).map((r) => r.policy).join(' | '));
check('alongside the carrier-dated one',
  (dash || []).some((r) => /CARRIERDATE/.test(r.policy)));
await p.screenshot({ path: `${S}/pd1-dashboard.png`, fullPage: true });

console.log('\nAND THE PREMIUMS PAGE');
await p.goto(`${BASE}/#/servicing`);
await p.waitForSelector('table.data', { timeout: 12000 });
await p.waitForTimeout(1200);
const page = await readCard('Premiums coming up');
check('shows both as well', (page || []).length >= 2, String((page || []).length));

const cents = (v) => String(v).replace(/\.00$/, '');
const key = (r) => `${r.due}|${r.policy.replace(/\s+/g, ' ')}|${cents(r.share)}`;
const firstEight = (page || []).filter((r) => r.due >= '').slice(0, 8);
check('the dashboard rows are the first of the page rows, verbatim',
  (dash || []).every((d, i) => firstEight[i] && key(firstEight[i]) === key(d)),
  `${(dash || []).map(key).join(' / ')}  vs  ${firstEight.map(key).join(' / ')}`);
check('with the same money against the same dates',
  (dash || []).every((d) => (page || []).some((x) => x.due === d.due
    && cents(x.share) === cents(d.share))),
  (dash || []).map((d) => `${d.due} ${d.share}`).join(' | '));
await p.screenshot({ path: `${S}/pd2-premiums.png`, fullPage: true });

console.log('\nTHE NEXT-DUE TILE READS FROM THE SAME LIST');
await p.goto(`${BASE}/#/dashboard`);
await p.waitForSelector('.kpi-row', { timeout: 12000 });
await p.waitForTimeout(1200);
const tile = await p.evaluate(() => {
  const el = [...document.querySelectorAll('.stat')]
    .find((s) => /next premium/i.test(s.querySelector('.label')?.textContent || ''));
  return el ? { value: el.querySelector('.value')?.textContent.trim(),
                note: el.querySelector('.note')?.textContent.trim() } : null;
});
check('the tile names a date rather than a dash',
  tile && tile.value && tile.value !== '—', JSON.stringify(tile));
check('and it is the first date in the card below it',
  tile && dash?.[0] && tile.value === dash[0].due,
  `${tile?.value} vs ${dash?.[0]?.due}`);

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL PREMIUM DUES CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
