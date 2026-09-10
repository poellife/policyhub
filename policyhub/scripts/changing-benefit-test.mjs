/* =====================================================================
   A death benefit that does not sit still.

   Most policies pay one figure whenever the insured dies, and the three
   LE scenarios are the same trade priced at three dates. An
   increasing-benefit policy is not: the benefit collected two years late
   is a different number from the one collected at life expectancy, and
   the return moves with it rather than only with the premium drag.

   What has to hold:

     the flag decides, not the data -- a figure typed on a level policy
       must not quietly change what it is worth;
     the benefit in force on a date is the last one dated on or before
       it, and `face_amount` covers the stretch before the first row;
     past the end of the schedule the last figure is held LEVEL. Assuming
       it keeps rising invents revenue into the late scenario, which is
       the scenario a decision actually rests on;
     a blank year means "unchanged", not "zero";
     the list and the detail agree, because two different rates for the
       same deal is worse than none;
     and every screen that prints a benefit prints the one that scenario
       collects -- including the PDF, which used to print the face amount
       three times.

   Idempotent: fixtures use a fixed prefix and are removed first.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'CDBT';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

/* A close in the past and an LE report dated with it, so every maturity
   date is fixed rather than moving with the day the suite is run. */
const CLOSE = '2026-03-01';
const make = async (suffix, body = {}) => json(await api(admin, '/opportunities', {
  method: 'POST',
  body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Rising Life', product_type: 'UL',
    face_amount: 4000000, insured_last_name: 'Steppe', insured_first_name: 'Ivo',
    insured_dob: '1948-06-15', insured_gender: 'M', insured_state: 'VA',
    le_months: 108, le_provider: 'ITM21st', le_date: '2026-01-01',
    asking_price: 900000, annual_premium: 70000,
    expected_close: CLOSE, offer_closes_on: '2027-06-30',
    fund_id: lcg1.id, ...body },
}));

/* Twelve years, the benefit stepping 250,000 each anniversary. */
const ladder = (n = 12, step = 250000) => Array.from({ length: n }, (_, i) => ({
  due_date: `${2026 + i}-03-01`, amount: 70000, death_benefit: 4000000 + step * i,
}));

const post = (id, rows) => api(admin, `/opportunities/${id}/premium-schedule`,
  { method: 'POST', body: { rows } });

const at = (an, months) => an.scenarios.find((s) => s.offset_months === months);

/* ------------------------------------------------------------------ *
 * The flag decides
 * ------------------------------------------------------------------ */
console.log('A FIGURE NOBODY ASKED FOR CHANGES NOTHING');
const level = await make('LEVEL');
await post(level.id, ladder());
const levelDetail = await json(await api(admin, `/opportunities/${level.id}`));
check('the schedule stored the benefit figures',
  levelDetail.premiums.every((p) => Number(p.death_benefit) > 0),
  `${levelDetail.premiums.length} rows`);
check('but the deal is not flagged, so nothing reads them',
  levelDetail.changing_death_benefit === false);
check('and every scenario still collects the face amount',
  levelDetail.analysis.scenarios.every((s) => near(s.death_benefit, 4000000)),
  levelDetail.analysis.scenarios.map((s) => s.death_benefit).join(' / '));
check('the analysis says the benefit does not move',
  levelDetail.analysis.benefit_changes === false);

/* The same deal, the same rows, one tick box different. */
await api(admin, `/opportunities/${level.id}`,
  { method: 'PUT', body: { changing_death_benefit: true } });
const flipped = await json(await api(admin, `/opportunities/${level.id}`));
check('ticking the box is the whole difference',
  flipped.analysis.benefit_changes === true
  && !near(at(flipped.analysis, 0).death_benefit, 4000000),
  `${at(flipped.analysis, 0).death_benefit}`);
check('and untickng it puts the deal back exactly as it was',
  await (async () => {
    await api(admin, `/opportunities/${level.id}`,
      { method: 'PUT', body: { changing_death_benefit: false } });
    const back = await json(await api(admin, `/opportunities/${level.id}`));
    return near(back.analysis.base.rate, levelDetail.analysis.base.rate, 1e-9);
  })());

/* ------------------------------------------------------------------ *
 * The benefit in force
 * ------------------------------------------------------------------ */
console.log('\nEACH FIGURE STANDS UNTIL THE NEXT ONE');
const rise = await make('RISE', { changing_death_benefit: true });
await post(rise.id, ladder());
const d = await json(await api(admin, `/opportunities/${rise.id}`));
const an = d.analysis;

check('three scenarios still, on three dates', an.scenarios.length === 3
  && an.scenarios[0].matures_on < an.scenarios[1].matures_on
  && an.scenarios[1].matures_on < an.scenarios[2].matures_on,
  an.scenarios.map((s) => s.matures_on).join(' < '));

/* LE is 108 months from 2026-01-01 → 2035-01-01. The anniversary in
   force on that day is 2034-03-01, the ninth row: 4,000,000 + 8×250,000. */
check('at life expectancy it collects the figure in force that year',
  near(at(an, 0).death_benefit, 4000000 + 250000 * 8),
  `${at(an, 0).death_benefit} on ${at(an, 0).matures_on}`);
check('two years early it collects two steps less',
  near(at(an, -24).death_benefit, 4000000 + 250000 * 6),
  `${at(an, -24).death_benefit} on ${at(an, -24).matures_on}`);
check('two years late, two steps more',
  near(at(an, 24).death_benefit, 4000000 + 250000 * 10),
  `${at(an, 24).death_benefit} on ${at(an, 24).matures_on}`);
check('so the three scenarios are three different policies, not one',
  new Set(an.scenarios.map((s) => s.death_benefit)).size === 3);

check('the return is solved on the figure that scenario collects, not the face amount',
  at(an, 0).rate > 0 && !near(at(an, 0).rate, levelDetail.analysis.base.rate, 1e-6),
  `${(at(an, 0).rate * 100).toFixed(2)}% vs level ${(levelDetail.analysis.base.rate * 100).toFixed(2)}%`);
check('profit moves with it', at(an, 0).profit > levelDetail.analysis.base.profit);

/* ------------------------------------------------------------------ *
 * Before the first row, and after the last
 * ------------------------------------------------------------------ */
console.log('\nBEFORE THE SCHEDULE STARTS, AND AFTER IT ENDS');
/* A schedule that starts late: the face amount is what the policy pays
   until the first figure says otherwise. */
const late = await make('LATESTART', { changing_death_benefit: true, le_months: 24 });
await post(late.id, [
  { due_date: '2026-03-01', amount: 70000, death_benefit: null },
  { due_date: '2027-03-01', amount: 70000, death_benefit: null },
  { due_date: '2032-03-01', amount: 70000, death_benefit: 9000000 },
]);
const lateAn = (await json(await api(admin, `/opportunities/${late.id}`))).analysis;
check('a blank year pays what the year before pays, not zero',
  near(at(lateAn, 0).death_benefit, 4000000),
  `${at(lateAn, 0).death_benefit} on ${at(lateAn, 0).matures_on}`);
check('and a blank row is stored as absent rather than as a figure',
  (await json(await api(admin, `/opportunities/${late.id}`)))
    .premiums.filter((p) => p.death_benefit === null).length === 2);

/* A schedule that ends before the late scenario matures. */
const short = await make('SHORT', { changing_death_benefit: true });
await post(short.id, ladder(4));   // last row 2029-03-01, LE is 2035
const shortAn = (await json(await api(admin, `/opportunities/${short.id}`))).analysis;
const lastFigure = 4000000 + 250000 * 3;
check('past the end of the schedule the last figure is held level',
  near(at(shortAn, 0).death_benefit, lastFigure)
  && near(at(shortAn, 24).death_benefit, lastFigure),
  `${at(shortAn, 0).death_benefit} / ${at(shortAn, 24).death_benefit}`);
check('and the analysis says so, so a screen can warn',
  shortAn.scenarios.every((s) => s.benefit_held_level === true));
check('it is not extrapolated — inventing growth into the late scenario is the '
  + 'one thing this must not do',
  at(shortAn, 24).death_benefit < 4000000 + 250000 * 12);

/* ------------------------------------------------------------------ *
 * One figure, not two
 *
 * The benefit lives in two places that both claim to be what the policy
 * pays now -- the field on the deal, and the first row of the schedule.
 * They are the same fact. Left to drift, editing one leaves the other on
 * screen, which is how a one-pager came to print a figure nobody
 * recognised.
 * ------------------------------------------------------------------ */
console.log('\nEDITING EITHER RECORD MOVES THE OTHER');
const sync = await make('SYNC', { changing_death_benefit: true });
await post(sync.id, ladder());
const read = async () => {
  const x = await json(await api(admin, `/opportunities/${sync.id}`));
  return { face: Number(x.face_amount), year1: Number(x.premiums[0].death_benefit),
    scen: x.analysis.scenarios.map((v) => v.death_benefit) };
};
const before = await read();
check('to start with they agree', near(before.face, before.year1),
  `${before.face} / ${before.year1}`);

await api(admin, `/opportunities/${sync.id}`,
  { method: 'PUT', body: { face_amount: 6000000 } });
const afterDeal = await read();
check('retyping the benefit on the deal moves year one of the schedule with it',
  near(afterDeal.face, 6000000) && near(afterDeal.year1, 6000000),
  `${afterDeal.face} / ${afterDeal.year1}`);
check('and leaves the later years alone, because those are the carrier\u2019s own figures',
  afterDeal.scen.join() === before.scen.join(), afterDeal.scen.join(' / '));

await post(sync.id, ladder(12, 300000).map((r, i) => ({ ...r,
  death_benefit: 8000000 + 300000 * i })));
const afterSched = await read();
check('and retyping the schedule moves the deal\u2019s headline figure to match — '
  + 'which is the bug that started this',
  near(afterSched.face, 8000000) && near(afterSched.year1, 8000000),
  `${afterSched.face} / ${afterSched.year1}`);
check('the scenarios follow the schedule too',
  afterSched.scen.every((v, i) => v > before.scen[i]), afterSched.scen.join(' / '));

/* A schedule that starts after the close says nothing about today, so
   the figure on the deal is left to cover that stretch on its own. */
const gap = await make('GAP', { changing_death_benefit: true, expected_close: '2026-03-01' });
await post(gap.id, [{ due_date: '2030-03-01', amount: 70000, death_benefit: 9000000 }]);
check('a schedule that starts later does not overwrite the benefit today',
  near(Number((await json(await api(admin, `/opportunities/${gap.id}`))).face_amount), 4000000));

/* And none of it touches a level deal. Its own fixture, so the sheet
   checked further down is still the one that was set up for it. */
const flat = await make('FLAT');
await post(flat.id, ladder());
await api(admin, `/opportunities/${flat.id}`, { method: 'PUT', body: { face_amount: 4400000 } });
const flatBack = await json(await api(admin, `/opportunities/${flat.id}`));
check('a level deal is untouched by any of this',
  near(Number(flatBack.face_amount), 4400000)
  && near(Number(flatBack.premiums[0].death_benefit), 4000000),
  `${flatBack.face_amount} / ${flatBack.premiums[0].death_benefit}`);

/* ------------------------------------------------------------------ *
 * The list and the detail
 * ------------------------------------------------------------------ */
console.log('\nTHE LIST AND THE DETAIL AGREE');
const listed = ((await json(await api(admin, '/opportunities'))) || [])
  .find((x) => x.id === rise.id);
check('the list reads the same benefit schedule the detail does',
  near(listed.rate_at_le, an.base.rate, 1e-9),
  `${listed.rate_at_le} vs ${an.base.rate}`);
check('and the same maturity date', listed.matures_on === an.base.matures_on);

/* ------------------------------------------------------------------ *
 * What the schedule will and will not accept
 * ------------------------------------------------------------------ */
console.log('\nWHAT THE SCHEDULE REFUSES');
const neg = await post(rise.id, [
  { due_date: '2026-03-01', amount: 70000, death_benefit: -1 }]);
check('a negative benefit is refused rather than stored', neg.status === 400,
  String(neg.status));
check('and the schedule that was already there is untouched',
  (await json(await api(admin, `/opportunities/${rise.id}`))).premiums.length === 12);

const huge = await post(rise.id, [
  { due_date: '2026-03-01', amount: 70000, death_benefit: '999999999999999999' }]);
check('so is a figure past what the column can hold', huge.status === 400,
  String(huge.status));

const zeroed = await post(rise.id, [
  ...ladder(2), { due_date: '2028-03-01', amount: 70000, death_benefit: 0 }]);
check('zero is accepted, because a lapsed benefit is a real figure', zeroed.ok);
await post(rise.id, ladder());

/* ------------------------------------------------------------------ *
 * The one-pager
 * ------------------------------------------------------------------ */
console.log('\nTHE ONE-PAGER PRINTS WHAT EACH SCENARIO COLLECTS');
const money = (n) => Number(n).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pdfRes = await api(admin, `/opportunities/${rise.id}/sheet.pdf?interest=both`);
check('the sheet is produced', pdfRes.ok && pdfRes.headers.get('content-type') === 'application/pdf');
const pdf = Buffer.from(await pdfRes.arrayBuffer()).toString('latin1');
/* The PDF's text is written as literal strings, so the figures are
   readable without parsing the page tree. */
const inPdf = (s) => pdf.includes(s.replace(/,/g, '\\054'))
  || pdf.includes(s) || pdf.includes(s.replace(/,/g, ''));

for (const s of an.scenarios)
  check(`the ${s.offset_months === 0 ? 'at-LE' : `${s.offset_months} month`} row prints `
    + `${money(s.death_benefit)}`, inPdf(money(s.death_benefit)));
check('so the three rows are not the same number three times — which is what '
  + 'the sheet printed before',
  new Set(an.scenarios.map((s) => money(s.death_benefit))).size === 3);

/* A level deal must be untouched by all of this. */
const levelPdf = Buffer.from(
  await (await api(admin, `/opportunities/${level.id}/sheet.pdf`)).arrayBuffer()).toString('latin1');
check('a level policy still prints its face amount in every row',
  levelPdf.includes('4\\054000\\054000.00') || levelPdf.includes('4,000,000.00'));

/* ------------------------------------------------------------------ *
 * An investor's share
 * ------------------------------------------------------------------ */
console.log('\nA SHARE OF A RISING BENEFIT IS STILL A SHARE');
const me = (await json(await api(inv1, '/auth/me'))).investor.id;
await api(admin, `/opportunities/${rise.id}/shares`, { method: 'PUT', body: { investor_ids: [me] } });
const seen = await json(await api(inv1, `/opportunities/${rise.id}`));
check('an investor shown the deal sees the schedule too', seen?.id === rise.id);
check('and the benefit they are quoted is the whole policy, scaled on the screen',
  near(seen.analysis.base.death_benefit, an.base.death_benefit),
  `${seen.analysis.base.death_benefit}`);
check('not the face amount', !near(seen.analysis.base.death_benefit, 4000000));

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All changing death benefit checks passed.'}`);
process.exit(fails.length ? 1 : 0);
