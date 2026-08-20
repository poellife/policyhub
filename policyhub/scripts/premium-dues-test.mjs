/* =====================================================================
   The dashboard and the Premiums page must agree — and must agree with
   the servicing calendar, which is the only place either of them reads.

   A premium an investor will be asked to fund is an entry somebody made
   on a policy's servicing tab, with the amount they entered there. The
   annual figure and carrier due date on the policy form describe how the
   policy was written; they are not a bill, and no screen that says money
   is due may read them. Two sources meant one payment appearing twice at
   two different figures.

   So this drives a book with one policy scheduled and one carrying only
   a policy-form premium, and asserts both screens show the first, agree
   with each other to the cent, and show nothing at all for the second.
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

/* One carrying nothing but policy-form figures — an annual premium and a
   carrier date next month. Nothing is owed on it until somebody schedules
   something, and it must appear on neither screen. One with a schedule and
   no next-due date at all — the shape an import produces, and the only one
   that is really due. */
const formOnly = await make('FORMONLY', {
  premium_required: 40000, next_premium_due: iso(20) });
const scheduled = await make('SCHEDULED', { premium_required: 60000 });
for (const d of [40, 405]) {
  const r = await api(`/policies/${scheduled.id}/reminders`, { method: 'POST', body: {
    due_date: iso(d), kind: 'Premium', amount: 60000, note: 'Annual premium' } });
  if (r.status !== 201) console.log('   (schedule row refused:', r.status, await r.text(), ')');
}

const svc = await json(await fetch(`${BASE}/api/servicing?fund=${FUND}`, { headers: { Cookie: inv } }));
const ours = (rows) => (rows || []).filter((r) =>
  String(r.policy_number || '').startsWith(PREFIX));
check('the API carries the scheduled premiums', ours(svc.upcoming).length === 2,
  String(ours(svc.upcoming).length));
check('and every one of them is a schedule entry',
  ours(svc.scheduled).filter((r) => r.kind === 'Premium').length === 2,
  String(ours(svc.scheduled).length));
check('the policy with only a form figure owes nothing',
  !ours(svc.upcoming).some((r) => /FORMONLY/.test(r.policy_number)),
  ours(svc.upcoming).map((r) => r.policy_number).join(', '));

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
check('and lists the scheduled policy, which is the one that used to vanish',
  (dash || []).some((r) => /SCHEDULED/.test(r.policy)),
  (dash || []).map((r) => r.policy).join(' | '));
check('and never the one whose only figure is on the policy form',
  !(dash || []).some((r) => /FORMONLY/.test(r.policy)),
  (dash || []).map((r) => r.policy).join(' | '));
await p.screenshot({ path: `${S}/pd1-dashboard.png`, fullPage: true });

console.log('\nAND THE PREMIUMS PAGE');
await p.goto(`${BASE}/#/servicing`);
await p.waitForSelector('table.data', { timeout: 12000 });
await p.waitForTimeout(1200);
const page = await readCard('Premiums coming up');
check('shows every scheduled date', (page || []).length >= 2, String((page || []).length));
check('and still nothing for the unscheduled policy',
  !(page || []).some((r) => /FORMONLY/.test(r.policy)),
  (page || []).map((r) => r.policy).join(' | '));

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
