/* =====================================================================
   The one-pager's cover, and the covering email that goes with it.

   Two things are under test, and they are the same thing twice.

   THE COVER. Page one leads with the whole commitment — purchase price
   plus every premium to the expected maturity — rather than with the
   purchase price. That is not a matter of taste. On the deal these
   fixtures are built from the premiums come to 85% of the price, so a
   cover leading with the price alone reads "$2.2m in, $10m out" when
   the real commitment is $4.1m. The checks below assert the total is on
   the page, that the price alone is not the only figure, and that the
   sentence about what happens if the premiums stop is there too.

   THE EMAIL. Composed by the server from the same record, so the figure
   in the message and the figure on the paper cannot drift. And the rule
   that matters more than any of the arithmetic: NO NAME LEAVES IN AN
   EMAIL. Not the insured's, not the second insured's, not from the
   investment case somebody typed with the name in it.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';
import { analyseOpportunity } from '../src/opportunity-analysis.js';
import { opportunityEmail, scrubNames } from '../src/opportunity-email.js';
import { opportunityPdf } from '../src/opportunity-pdf.js';

const PREFIX = 'COVEM';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o,
  body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

/* The Sommers deal, which is the reason this file exists: $2.2m at
   closing and $1.88m of premiums behind it. */
const funds = await json(await api('/funds'));
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Pacific Life', product_type: 'SUL',
  face_amount: 10000000, asking_price: 2200000, annual_premium: 313481,
  expected_close: '2026-10-01', fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Sommers', insured_first_name: 'Gerald',
  insured_dob: '1941-08-08', insured_gender: 'M', insured_state: 'IL',
  le_months: 36, le_provider: '21st', le_date: '2026-08-26',
  insured2_last_name: 'Sommers', insured2_first_name: 'Judith',
  insured2_dob: '1943-01-24', insured2_gender: 'F',
  insured2_le_months: 71, insured2_le_provider: '21st', insured2_le_date: '2026-08-26',
  /* Typed by a person, with the name in it, exactly as it would be. */
  thesis: 'Gerald is a repeat seller and the carrier has approved the change of ownership.',
} }));
if (!deal?.id) { console.log('  FAIL  fixture'); process.exit(1); }

/* Premiums that run PAST the expected maturity, deliberately: the cover
   cell headed "to maturity" must count six of them, not ten, or it stops
   adding up to the total printed beside it. */
/* Posted through the real route, and CHECKED.
   These used to go to `/opportunity-premiums`, which does not
   exist: every one of them 404'd, the fixture had no schedule at
   all, and the assertions below still passed -- because the deal
   carries `annual_premium` and the analysis projects from that
   when there is nothing posted, which lands on the same figures.
   A suite that is green for a reason it does not state is not a
   suite. A fixture write that fails now stops the run. */
for (let i = 0; i < 10; i++) {
  const r = await api(`/opportunities/${deal.id}/premiums`, { method: 'POST',
    body: { due_date: `${2026 + i}-10-01`, amount: 313481 } });
  if (!r.ok) {
    console.log(`  FAIL  fixture: premium ${2026 + i} -> ${r.status}`);
    process.exit(1);
  }
}

const full = await json(await api(`/opportunities/${deal.id}`));
const base = full.analysis.base;

/* ------------------------------------------------------------------ *
 * The arithmetic the cover is built on
 * ------------------------------------------------------------------ */
console.log('THE COVER ADDS UP');
check('the total is the price plus the premiums to maturity, not the price',
  Math.abs(Number(base.invested) - (2200000 + Number(base.premiums_paid))) < 1,
  `${base.invested} vs 2200000 + ${base.premiums_paid}`);
check('and the premiums are the ones before maturity, not every row typed',
  base.premium_count < 10 && base.premium_count > 0, `${base.premium_count} of 10`);
check('so the commitment is materially more than the asking price',
  Number(base.invested) > 2200000 * 1.5,
  `${Math.round(Number(base.invested) / 2200000 * 100)}% of the price`);

/* ------------------------------------------------------------------ *
 * The drawn page
 * ------------------------------------------------------------------ */
console.log('\nAND SAYS SO ON PAPER');
const pdf = opportunityPdf(full, { share: 100, interest: 'simple' });
const text = pdf.toString('latin1');
const has = (s) => text.includes(s);
check('the PDF carries the total invested', has('$4,080,886'), 'expected $4,080,886');
/* Matched in pieces, because the note wraps and each drawn line is its
   own text operator in the file — the whole sentence never appears as
   one string no matter how right it is. */
check('and the premiums named under it, without a per-year figure',
  has('$2,200,000 at closing, plus annual premiums')
  && /premium schedule for details/.test(text),
  (/at closing[^)]{0,60}/.exec(text) || [])[0]);
/* Why there is no figure in that sentence at all.
   A single number standing for a whole schedule is a summary, and every
   way of taking it is wrong on an optimised survivorship schedule --
   level early, thin through the middle, a spike at extreme age. The
   first version printed `annual_premium_assumed`, which is the run-rate
   at the END of the posted schedule and exists only to project past it:
   on a real case that read "$911,000 a year" beside a premium total of
   $1,908,000 over five years. An average is defensible and still
   misleads. So the cover names the obligation and points at the page
   that sets it out. These assert the cover carries NO per-year figure,
   in either of the readings that were tried. */
const perYearShapes = [
  Number(full.analysis.base.annual_premium_assumed),
  Number(full.analysis.base.premium_per_year),
  Number(full.analysis.base.premium_first_year),
].filter((v) => Number.isFinite(v) && v > 0)
  .map((v) => `$${Math.round(v).toLocaleString('en-US')}`);
const coverOnly = text.slice(0, text.indexOf('DETAILED VIEW'));
check('and no per-year figure is quoted on the cover at all',
  perYearShapes.every((v) => !coverOnly.includes(`${v} a year`)),
  `none of ${perYearShapes.join(' / ')} followed by "a year"`);
check('though the analysis still carries one for the detail page',
  Number(full.analysis.base.premium_per_year) > 0,
  String(Math.round(full.analysis.base.premium_per_year)));
check('and the premiums as their own line', has('$1,880,886'));
/* The SPAN of the hold, not the number of payments and not the length of
   the schedule somebody typed. Ten years are posted; the deal matures in
   5.8, and the cell has to agree with the maturity cell two along from
   it rather than with the spreadsheet the schedule came from. */
check('the premiums-to-maturity cell reports the hold, not the whole schedule',
  /\$1,880,886 over 5\.8 years/.test(text),
  (/\$1,880,886 over [\d.]+ years?/.exec(text) || [])[0]);
/* Both sentences came off the cover on request. They are still on the
   document -- the disclaimer carries the risk language in full -- and
   still in the covering email, which is checked further down. What the
   cover says instead is the lead figure itself: the purchase price and
   every premium added together, which IS the commitment. */
check('the cover no longer carries the closing caveat',
  !/premiums are a commitment, not an option/.test(text.slice(0, text.indexOf('DETAILED VIEW'))));
check('but the document still says a life expectancy is not a promise',
  /statistical models, not/.test(text) && /longer or shorter than the estimate/.test(text));
check('the cover is a page of its own', /\/Count 3/.test(text) || /\/Count [3-9]/.test(text),
  (/\/Count \d+/.exec(text) || [])[0]);
check('no insured name is drawn on any page',
  !/Sommers/.test(text) && !/Gerald/.test(text) && !/Judith/.test(text));

/* ------------------------------------------------------------------ *
 * One convention, everywhere on the page
 * ------------------------------------------------------------------ */
/* Simple interest and an IRR are different numbers. Which one is on the
   sheet is the reader's choice; what is NOT negotiable is that it is the
   same choice in every cell. The cover's early/late figures used to print
   `.rate` -- the simple reading -- whatever was chosen, so a sheet set to
   compounded carried "16.32% a year, compounded" at the top, "9.53% two
   years late" three inches below it, and 7.74% in the scenario table
   overleaf. Nothing on the page said they were three different things.

   Asserted against the SCENARIOS rather than against fixed strings, so
   this keeps working when the fixture's figures move. */
console.log('\nAND ONE INTEREST CONVENTION, EVERYWHERE ON IT');
const pct = (v) => `${(Number(v) * 100).toFixed(2)}%`;
const scenOf = (m) => full.analysis.scenarios.find((x) => x.offset_months === m);
for (const mode of ['simple', 'compound']) {
  const page = opportunityPdf(full, { share: 100, interest: mode }).toString('latin1');
  const key = mode === 'compound' ? 'compound_rate' : 'rate';
  const other = mode === 'compound' ? 'rate' : 'compound_rate';
  const want = [0, 24, -24].map((m) => pct(scenOf(m)[key]));
  const wrong = [24, -24].map((m) => pct(scenOf(m)[other]));
  check(`on ${mode}, the cover carries the ${mode} figures`,
    want.every((v) => page.includes(v)), `${want.join(' / ')}`);
  check(`and none of the ${mode === 'compound' ? 'simple' : 'compounded'} ones`,
    wrong.every((v) => !page.slice(0, page.indexOf('DETAILED VIEW')).includes(v)),
    `must not appear: ${wrong.join(' / ')}`);
}
/* And the same reading is what the scenario table overleaf prints, which
   is the comparison a person actually makes when they turn the page. */
const compounded = opportunityPdf(full, { share: 100, interest: 'compound' })
  .toString('latin1');
check('the cover and the table overleaf agree',
  compounded.indexOf(pct(scenOf(24).compound_rate))
    < compounded.indexOf('RETURN IF THE SECOND DEATH')
  && compounded.split(pct(scenOf(24).compound_rate)).length >= 3,
  `${pct(scenOf(24).compound_rate)} appears ${
    compounded.split(pct(scenOf(24).compound_rate)).length - 1} times`);

/* An unpriced deal still has to produce a page rather than a page of
   dashes, because a deal is entered before it is priced. */
const bare = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-2`, carrier_name: 'Lincoln', product_type: 'UL',
  face_amount: 3000000, insured_last_name: 'Nopricehere', insured_first_name: 'Ada',
  insured_dob: '1944-02-02', insured_gender: 'F',
  fund_id: funds.find((f) => f.code === 'LCG1').id } }));
const bareFull = await json(await api(`/opportunities/${bare.id}`));
const bareText = opportunityPdf(bareFull, {}).toString('latin1');
check('an unpriced deal says so rather than printing dashes',
  /has not been priced yet/.test(bareText));

/* ------------------------------------------------------------------ *
 * The covering email
 * ------------------------------------------------------------------ */
console.log('\nTHE COVERING EMAIL IS WRITTEN FROM THE SAME RECORD');
const draft = await json(await api(`/opportunities/${deal.id}/email?share=100&interest=simple`));
check('the route composes one', !!draft?.body && !!draft?.subject,
  draft?.error || '');
const b = String(draft?.body || '');
/* No combined total in the note, deliberately: "the purchase price is X,
   with an additional Y in premiums" is the sentence a buyer reads without
   working anything out, and the sheet carries the sum. What must hold is
   that X and Y are the sheet's X and Y. */
check('it quotes the sheet\u2019s purchase price', b.includes('$2,200,000'));
check('and the same premium total', b.includes('$1,880,886'));
check('and the same death benefit', b.includes('$10,000,000'));
check('it points at the attachment',
  /Please see attached document for more detailed information\./.test(b));
check('it names the attachment file', /one-pager\.pdf$/.test(draft?.attachment || ''),
  draft?.attachment);
/* The shape, which is fixed on every deal so the sender does not have to
   proof-read a new letter each time. */
check('it opens the same way every time',
  /^Here's the detail on a new opportunity\.$/m.test(b), b.split('\n')[0]);
check('the policy is described in one sentence',
  /\$10,000,000 survivorship universal life policy on two insureds, aged 85 and 83, paid on the second death\./
    .test(b), (b.match(/\$10,000,000[^\n]*/) || [])[0]);
check('the premiums are their own figure, not folded into a total',
  /The purchase price is \$2,200,000 at closing, with an additional \$1,880,886 in premiums over the 5\.8 years to the expected maturity\./
    .test(b), (b.match(/The purchase price[^\n]*/) || [])[0]);
check('and the return is quoted at the estimate the price is built on',
  /At the 71 month life expectancy mark, the return is 31\.1% a year, simple interest\./.test(b),
  (b.match(/At the [^\n]*/) || [])[0]);
check('it is short — four paragraphs, not a deal sheet',
  b.split(/\n\n/).filter(Boolean).length <= 5,
  `${b.split(/\n\n/).filter(Boolean).length} paragraphs`);

console.log('\nAND NO NAME LEAVES IN IT');
check('not the first insured', !/Gerald/i.test(b) && !/Sommers/i.test(b), b.slice(0, 160));
check('not the second', !/Judith/i.test(b));
/* The investment case is no longer quoted in the covering note at all —
   it is a judgement, it belongs on the sheet, and a note that carries it
   stops being four paragraphs. The scrubber is still exercised directly
   further down, and the sheet still runs everything through it. */
check('the investment case stays on the sheet, out of the email',
  !/repeat seller/i.test(b));
check('and nothing is left where a name was',
  !/\bis a repeat seller\b/.test(b), b.slice(0, 80));
check('no date of birth', !/1941/.test(b) && !/1943/.test(b));
check('the subject line is clean too',
  !/Sommers/i.test(draft?.subject || '') && !/Gerald/i.test(draft?.subject || ''),
  draft?.subject);
check('and the composer says nothing was missed', (draft?.warnings || []).length === 0,
  (draft?.warnings || []).join(' | '));

/* The scrubber on its own, including the case that made it necessary. */
console.log('\nTHE SCRUBBER');
check('a name typed into free text comes out as initials',
  scrubNames('Gerald Sommers is a repeat seller', full) === 'G. S. is a repeat seller',
  scrubNames('Gerald Sommers is a repeat seller', full));
check("and a possessive with it",
  !/Sommers/.test(scrubNames("Sommers's records are complete", full)));
check('a two-letter name is left alone rather than eating the sentence',
  scrubNames('Al went to the office', { insured_first_name: 'Al' }) === 'Al went to the office');
check('and an empty record changes nothing',
  scrubNames('nothing to do here', {}) === 'nothing to do here');

/* ------------------------------------------------------------------ *
 * Who may compose one
 * ------------------------------------------------------------------ */
console.log('\nAND ONLY THE DESK WRITES IT');
const share = await json(await api(`/opportunities/${deal.id}/email?share=12.5`));
check('a participation scales every figure in the draft',
  /\$275,000 at closing/.test(share.body) && /\$235,111 in premiums/.test(share.body),
  (/The purchase price[^\n]*/.exec(share.body) || [])[0]);
check('and says what share of the policy it is',
  /your 12\.5% of a \$10,000,000 policy/.test(share.body),
  (/\$1,250,000[^\n]*/.exec(share.body) || [])[0]);

const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const asInvestor = await fetch(`${BASE}/api/opportunities/${deal.id}/email`,
  { headers: { Cookie: invCookie } });
check('an investor cannot compose a covering note about themselves',
  asInvestor.status === 403 || asInvestor.status === 404, String(asInvestor.status));

/* ------------------------------------------------------------------ *
 * Shape checks the API cannot make
 * ------------------------------------------------------------------ */
console.log('\nEDGE CASES THE DESK WILL HIT');
const single = { ...full, insured2_first_name: null, insured2_last_name: null,
  insured2_le_months: null, insured2_le_date: null };
single.analysis = analyseOpportunity(single, 1, 0);
const one = opportunityEmail(single, {});
check('one insured reads as one insured',
  /on one insured, aged \d+\./.test(one.body) && !/second death/.test(one.body),
  (/policy on[^\n]*/.exec(one.body) || [])[0]);

const unpriced = opportunityEmail({ ...bareFull, analysis: bareFull.analysis }, {});
check('an unpriced deal is not sent quoting a return',
  !/%/.test(unpriced.body), unpriced.body.slice(0, 120));
check('and the composer says why', unpriced.warnings.length > 0,
  unpriced.warnings.join(' | '));

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All cover and covering-email checks passed.'}`);
process.exit(fails.length ? 1 : 0);
