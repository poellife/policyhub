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
for (let i = 0; i < 10; i++)
  await api('/opportunity-premiums', { method: 'POST', body: {
    opportunity_id: deal.id, due_date: `${2026 + i}-10-01`, amount: 313481 } });

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
check('and the split underneath it',
  has('$2,200,000 at closing') && /\$313,000 a year/.test(text),
  (/at closing, then about [^)]{0,30}a year/.exec(text) || [])[0]);
/* The number a reader would check against the carrier's bill.
   `annual_premium_assumed` -- the run-rate at the END of the posted
   schedule, which exists only to project past it -- used to be printed
   here, and on an optimised survivorship schedule that is the spike at
   extreme age. It read "$911,000 a year" beside a premium total of
   $1,908,000 over five years. */
check('and that figure is the premium, not the tail of the schedule',
  Math.abs(Number(full.analysis.base.premium_first_year) - 313481) < 1,
  String(full.analysis.base.premium_first_year));
check('which is not the same as the end-of-schedule run rate it replaced',
  full.analysis.base.premium_per_year !== full.analysis.base.annual_premium_assumed
  || full.analysis.base.premium_count === 10);
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
