/* =====================================================================
   Why two reports over different selections can be the same document.

   Once several entities can be chosen at once, this happens: pick three,
   generate a realized-return report, add a fourth that holds nothing
   matured, generate again — and the two files are identical but for the
   line naming the entities. The filter worked. There was simply nothing
   in the fourth on this basis.

   That is correct and it is baffling, and somebody comparing the two
   reasonably concludes the picker is broken. The arithmetic does not need
   changing; the document needs to say so.

   So: an entity asked for that put nothing in the table is named under
   it, with what it does hold — "no policies at all" and "policies, none
   of them matured" being different facts that lead to different actions.
   And what the basis itself leaves out is printed too, which the server
   had been computing for exactly this purpose and the document had never
   shown.

   Idempotent: its own entity and policies, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login, pickEntities, offeredEntities } from './test-config.mjs';

const PREFIX = 'CONTRIB';
const CODE = 'ZZCONTRIB';
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
  for (const st of ['', 'Inforce', 'Matured', 'Lapsed', 'Sold', 'Pending'])
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX))
        await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  for (const f of ((await json(await api('/funds'))) || []))
    if (f.code === CODE) await api(`/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();

/* An entity that holds a live policy and nothing settled — which is the
   shape that produced the confusion. */
await api('/funds', { method: 'POST', body: { code: CODE, name: 'Contribution Test' } });
await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: `${PREFIX} Assurance`, product_type: 'UL',
  fund_code: CODE, face_amount: 2000000, status: 'Inforce',
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Pat', dob: '1941-01-01' } });

const codes = ((await json(await api('/funds'))) || []).map((f) => f.code);
const others = codes.filter((c) => c !== CODE);

console.log('THE TWO REQUESTS THAT LOOK THE SAME');
const realized = async (list) =>
  await json(await api(`/reports/returns?basis=realized&fund=${encodeURIComponent(list.join(','))}`));
const without = await realized(others);
const withIt = await realized([...others, CODE]);
check('adding an entity with nothing matured changes no row',
  withIt.rows.length === without.rows.length,
  `${without.rows.length} either way`);
check('and no entity subtotal',
  withIt.byFund.map((f) => f.fund_code).join(',')
    === without.byFund.map((f) => f.fund_code).join(','),
  withIt.byFund.map((f) => f.fund_code).join(','));
check('and not one figure',
  Number(withIt.portfolio.profit) === Number(without.portfolio.profit));

console.log('\nSO THE SERVER SAYS WHICH ONE IT WAS');
const named = (withIt.emptyFunds || []).find((f) => f.fund_code === CODE);
check('the entity that contributed nothing is named', !!named, JSON.stringify(named));
check('with how many policies it actually holds', named?.policies === 1,
  String(named?.policies));
check('and how many of those are matured — which is the answer', named?.matured === 0,
  String(named?.matured));
check('an entity that did contribute is not named',
  !(withIt.emptyFunds || []).some((f) => others.includes(f.fund_code)
    && withIt.byFund.some((b) => b.fund_code === f.fund_code)));
check('and asking for nothing in particular names nothing',
  ((await json(await api('/reports/returns?basis=realized')))?.emptyFunds || []).length === 0);

/* On the live-book basis the same entity does contribute, so it must not
   be named there. A note that appears on every report is noise. */
const active = await json(await api(
  `/reports/returns?basis=active&fund=${encodeURIComponent([...others, CODE].join(','))}`));
check('on the in-force report it contributes and is not named',
  active.byFund.some((f) => f.fund_code === CODE)
  && !(active.emptyFunds || []).some((f) => f.fund_code === CODE),
  active.byFund.map((f) => f.fund_code).join(','));

/* ------------------------------ on paper ----------------------------- */
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/reports`); await p.waitForSelector('#rptGenerate');
await p.waitForTimeout(800);
await pickEntities(p, await offeredEntities(p));
await p.click('.rpt-choice:has(input[value="return-realized"])');
await p.waitForTimeout(300);
await p.click('#rptGenerate'); await p.waitForSelector('.rpt-sheet', { timeout: 40000 });
await p.waitForTimeout(1500);

console.log('\nAND SO DOES THE DOCUMENT');
const body = (await p.locator('.rpt-sheet').textContent()).replace(/\s+/g, ' ');
check('the report names the entity that put nothing in it',
  new RegExp(`${CODE} was included in this selection`).test(body),
  (body.match(new RegExp(`${CODE}[^.]*\\\\.`)) || ['not said'])[0].slice(0, 120));
check('and says what it does hold, so the reader knows which it is',
  /none of them matured/.test(body),
  (body.match(/it holds [^.]*\./) || ['not said'])[0].slice(0, 100));
/* The row is the answer, not the footnote: an entity omitted from the
   table is indistinguishable from a filter that was ignored. */
const entityRows = await p.$$eval('.rpt-table tbody tr', (rs) =>
  rs.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
check('the entity table carries a row for it, at zero',
  entityRows.some((r) => r.startsWith(CODE) && / 0 /.test(r)),
  entityRows.find((r) => r.startsWith(CODE)) || 'no row for it');
check('and it is marked as the empty one rather than read as a real figure',
  (await p.locator('.rpt-table tbody tr.rpt-zero').count()) >= 1);
check('the document also says what the basis leaves out',
  /Not in this table:/.test(body),
  (body.match(/Not in this table:[^.]*\./) || ['not said'])[0].slice(0, 130));
check('written the way a person says it, not the way it is stored',
  !/policies inforce/.test(body) && /in force/.test(body),
  (body.match(/Not in this table:[^.]*\./) || [''])[0].slice(0, 90));
check('and why a realized report is the shorter list',
  /claims the carrier has recorded as paid/.test(body));
await p.screenshot({ path: `${S}/ec1-realized-notes.png`, fullPage: true });

/* The in-force report covers this entity, so it must not carry the note. */
await p.click('.rpt-choice:has(input[value="return-active"])');
await p.waitForTimeout(300);
await p.click('#rptGenerate'); await p.waitForSelector('.rpt-sheet', { timeout: 40000 });
await p.waitForTimeout(1500);
const live = (await p.locator('.rpt-sheet').textContent()).replace(/\s+/g, ' ');
check('the in-force report does not name it, because it is in the table',
  !new RegExp(`${CODE} was included`).test(live));
check('but still says what that basis leaves out', /Not in this table:/.test(live),
  (live.match(/Not in this table:[^.]*\./) || ['not said'])[0].slice(0, 120));

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await wipe();
console.log(fails.length
  ? `\n${fails.length} ENTITY CONTRIBUTION CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL ENTITY CONTRIBUTION CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
