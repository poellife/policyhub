/* =====================================================================
   Two honest answers, and a choice between them.

   A book of policies has two returns and they are not rivals.

     Capital-weighted — total profit over total dollar-years. A $10m
       position counts for ten times a $1m one, and eight years for more
       than eight months. What the money did.

     Equal-weighted — every policy's own rate counted once, whatever it
       is attached to. How the cases did.

   This suite holds three things. That the choice reaches every screen
   and every report rather than one tile. That it survives signing out,
   because a setting you have to make every morning is not a setting.
   And — the one that matters — that choosing does not change any figure
   except which of the two is on display: both are computed on the server
   from the same flows and travel together, so no document can ever
   disagree with the database about either.

   The words are the industry's. Deliberately not "simple", which this
   application already spends on simple interest as against compounded:
   one word carrying two axes on the same tile is how somebody quotes the
   wrong number.

   Idempotent: its own policies, removed first and last, and it puts back
   whatever basis the test administrator had before it ran.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login, pickEntities } from './test-config.mjs';
import { fmtRate } from '../public/irr.js';

const PREFIX = 'RATEBASIS';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
const pct = (r) => (r == null ? '—' : fmtRate(r));

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
};
await wipe();

const before = (await json(await api('/me/prefs')))?.rate_basis || null;
const restore = async () => {
  if (before) await api('/me/prefs/rate_basis', { method: 'PUT', body: before });
  else await api('/me/prefs/rate_basis', { method: 'DELETE' });
};
await api('/me/prefs/rate_basis', { method: 'DELETE' });

/* The same fixture as the weighting suite: twenty to one in size, four to
   one in rate, so the two answers are far enough apart that no screen can
   be showing one while claiming the other. */
const back = (years) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};
const FOUR = back(4);
for (const [n, b] of [[1, { face: 10000000, cost: 5000000 }],
                      [2, { face: 500000, cost: 100000 }]]) {
  const p = await json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${n}`, carrier_name: `${PREFIX} Assurance`,
    product_type: 'UL', fund_code: 'LCG1', face_amount: b.face, status: 'Inforce',
    insured_last_name: `${PREFIX}${n}`, insured_first_name: 'Pat', dob: '1939-04-04' } }));
  await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: FOUR, txn_type: 'Acquisition Cost', amount: b.cost } });
}

console.log('BOTH FIGURES COME DOWN TOGETHER');
/* Nothing is recomputed when the choice changes, because there is nothing
   left to compute: every endpoint that reports a book rate reports both. */
const endpoints = [
  ['the dashboard', '/analytics/summary?fund=LCG1', (d) => d.rate],
  ['the maturities register', '/maturities?fund=LCG1', (d) => d.portfolio],
  ['the returns report', '/reports/returns?basis=active&fund=LCG1', (d) => d.portfolio],
];
for (const [name, path, pick] of endpoints) {
  const a = pick(await json(await api(path)));
  check(`${name} sends the capital-weighted rate`, a?.rate != null, pct(a?.rate));
  check(`${name} sends the equal-weighted one beside it`, a?.mean_rate != null, pct(a?.mean_rate));
  check(`${name} says how many rates that is an average of`,
    Number.isInteger(a?.rated_count) && a.rated_count > 0, String(a?.rated_count));
  check(`${name} has them genuinely different on this book`,
    Math.abs(a.rate - a.mean_rate) > 0.02, `${pct(a.rate)} against ${pct(a.mean_rate)}`);
  /* The compounded figure is a pair with the simple one, not a separate
     question. Both readings of it come down too, or a screen ends up
     quoting an equal-weighted return against a capital-weighted IRR. */
  check(`${name} sends both readings of the compounded figure`,
    a?.compound_rate != null && a?.mean_compound_rate != null,
    `${pct(a?.compound_rate)} against ${pct(a?.mean_compound_rate)}`);
}
const ret = await json(await api('/reports/returns?basis=active&fund=LCG1'));
const lcg1 = (ret.byFund || []).find((f) => f.fund_code === 'LCG1');
check('and so does every entity subtotal', lcg1?.rate != null && lcg1?.mean_rate != null,
  `${pct(lcg1?.rate)} against ${pct(lcg1?.mean_rate)}`);

console.log('\nTHE EQUAL-WEIGHTED FIGURE IS THE AVERAGE OF THE ROWS');
const rated = (ret.rows || []).filter((r) => r.rate != null);
const byHand = rated.reduce((s, r) => s + r.rate, 0) / rated.length;
check('it is the mean of the policy rates on the same report',
  near(ret.portfolio.mean_rate, byHand, 1e-9),
  `${pct(ret.portfolio.mean_rate)} against ${pct(byHand)}`);
check('counted over the policies that have a rate, not all of them',
  ret.portfolio.rated_count === rated.length,
  `${ret.portfolio.rated_count} of ${(ret.rows || []).length}`);

console.log('\nWHAT THE SETTING WILL ACCEPT');
const put = async (body) => (await api('/me/prefs/rate_basis', { method: 'PUT', body })).status;
check('capital-weighted is a basis', await put({ basis: 'weighted' }) === 200);
check('equal-weighted is a basis', await put({ basis: 'simple' }) === 200);
check('anything else is refused rather than stored', await put({ basis: 'whatever' }) === 400);
check('and so is something that is not a setting at all', await put(['simple']) === 400);
check('it comes back as it was stored',
  (await json(await api('/me/prefs')))?.rate_basis?.basis === 'simple');
await api('/me/prefs/rate_basis', { method: 'DELETE' });

/* ------------------------------ on screen ---------------------------- */
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));

const signIn = async (who = ADMIN) => {
  await p.goto(BASE);
  await p.fill('#email', who.email); await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row', { timeout: 20000 });
  await p.waitForTimeout(700);
};
await signIn();
await pickEntities(p, ['LCG1']);

const returnTile = () => p.locator('.stat').filter({ hasText: 'Portfolio return' }).first();
const tileRate = async () => (await returnTile().locator('.value').textContent()).trim();
const tileNote = async () => (await returnTile().locator('.note').last().textContent())
  .replace(/\s+/g, ' ').trim();

console.log('\nTHE CONTROL, AND WHAT IT SAYS');
check('the dashboard offers the choice', (await p.locator('#rateBasis').count()) === 1);
check('and starts capital-weighted, which is what "portfolio return" means',
  (await p.locator('#rateBasis').inputValue()) === 'weighted');
const options = (await p.locator('#rateBasis option').allTextContents()).map((t) => t.trim());
check('named the way the industry names them, not "simple"',
  options.join('|') === 'Capital-weighted|Equal-weighted', options.join(' | '));
const weightedShown = await tileRate();
check('the tile says which of the two it is showing',
  /capital-weighted/.test(await tileNote()), await tileNote());
check('and what the other one reads, so the gap needs no second screen',
  /equal-weighted \d/.test(await tileNote()), await tileNote());
check('the interest convention is spelled out now that a second axis sits beside it',
  /simple interest/.test(await returnTile().locator('.label').textContent()),
  (await returnTile().locator('.label').textContent()).trim());

await p.selectOption('#rateBasis', 'simple');
await p.waitForTimeout(1600);
const equalShown = await tileRate();
check('choosing equal-weighted changes the figure', equalShown !== weightedShown,
  `${weightedShown} → ${equalShown}`);
check('and the tile now names that one', /equal-weighted/.test(await tileNote()),
  await tileNote());
check('with the capital-weighted figure printed beside it — the one it was',
  (await tileNote()).includes(weightedShown.replace('%', '')), await tileNote());
await p.screenshot({ path: `${S}/rb1-dashboard.png`, fullPage: false });

console.log('\nTHE COMPOUNDED FIGURE MOVES WITH IT');
/* Switching the weighting has to move both numbers on the tile. One of
   them staying put is the reader quoting two different books off one
   line, with nothing on screen to say so. */
const compoundShown = async () => {
  const note = await tileNote();
  const m = /([\d.]+%) compounded/.exec(note);
  return m ? m[1] : null;
};
const equalCompound = await compoundShown();
check('the tile carries a compounded figure', equalCompound !== null, await tileNote());
await p.selectOption('#rateBasis', 'weighted');
await p.waitForTimeout(1600);
const weightedCompound = await compoundShown();
check('and it changes with the weighting, like the figure above it',
  weightedCompound !== null && weightedCompound !== equalCompound,
  `${equalCompound} equal-weighted, ${weightedCompound} capital-weighted`);
check('the simple figure went back too', (await tileRate()) === weightedShown,
  `${await tileRate()} against ${weightedShown}`);
await p.selectOption('#rateBasis', 'simple');
await p.waitForTimeout(1600);
check('and back again gives the same pair, not a third answer',
  (await tileRate()) === equalShown && (await compoundShown()) === equalCompound,
  `${await tileRate()} · ${await compoundShown()}`);

console.log('\nAND IT IS THE SAME CHOICE ON EVERY TAB');
for (const [route, name] of [['maturities', 'maturities'], ['reports', 'reports']]) {
  await p.goto(`${BASE}/#/${route}`);
  await p.waitForSelector('#rateBasis', { timeout: 20000 });
  await p.waitForTimeout(1200);
  check(`${name} offers it too, still on equal-weighted`,
    (await p.locator('#rateBasis').inputValue()) === 'simple');
}

console.log('\nAND IT IS STILL THERE TOMORROW');
await ctx.clearCookies();
await signIn();
check('signing in again keeps the basis',
  (await p.locator('#rateBasis').inputValue()) === 'simple');
/* Back to the same entity as well: the basis is remembered, the entity
   filter is not unless somebody asked for it, and comparing the figure
   across two different books would prove nothing. */
await pickEntities(p, ['LCG1']);
check('and the dashboard leads with that figure', (await tileRate()) === equalShown,
  `${await tileRate()} against ${equalShown}`);

console.log('\nON A DOCUMENT, IT IS NAMED');
await p.goto(`${BASE}/#/reports`); await p.waitForSelector('#rptGenerate');
await p.waitForTimeout(700);
await p.click('.rpt-choice:has(input[value="return-active"])'); await p.waitForTimeout(300);
await p.click('#rptGenerate'); await p.waitForSelector('.rpt-sheet', { timeout: 40000 });
await p.waitForTimeout(1500);
const rptTile = async () => (await p.locator('.rpt-tile').first().textContent())
  .replace(/\s+/g, ' ').trim();
check('the report tile says the basis on its face', /equal-weighted/.test(await rptTile()),
  await rptTile());
const body = (await p.locator('.rpt-sheet').textContent()).replace(/\s+/g, ' ');
check('and the note under it explains what that means',
  /each policy.s own\s*rate counted once/i.test(body) || /counted once/.test(body),
  (body.match(/[^.]*counted once[^.]*\./) || ['not explained'])[0].slice(0, 120));
check('and prints both figures, so the document can be checked either way',
  /capital-weighted and .* equal-weighted/.test(body),
  (body.match(/The same policies read[^.]*\./) || ['not printed'])[0].slice(0, 120));
await p.screenshot({ path: `${S}/rb2-report.png`, fullPage: true });

/* Changing the basis with a report on screen rebuilds it. Clearing it
   would be the application deciding the reader meant something else. */
await p.selectOption('#rateBasis', 'weighted');
await p.waitForTimeout(4000);
check('switching rebuilds the report rather than clearing it',
  (await p.locator('.rpt-sheet').count()) > 0);
check('and it comes back capital-weighted', /capital-weighted/.test(await rptTile()),
  await rptTile());

console.log('\nAN INVESTOR IS NOT ASKED TO CHOOSE');
/* Their statements are written in one convention. A second figure on an
   investor's screen raises a question the screen cannot answer. */
const mgr = await login(MANAGER1.email, MANAGER1.password);
const mine = await (await fetch(`${BASE}/api/me/prefs`, { headers: { Cookie: mgr } })).json();
check('a manager may hold the setting like anybody else', typeof mine === 'object');
await ctx.clearCookies();
await p.goto(BASE);
check('and the control is staff-only on screen',
  (await p.locator('#rateBasis').count()) === 0);

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
await restore();
await wipe();
console.log(fails.length
  ? `\n${fails.length} RATE BASIS CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL RATE BASIS CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
