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
  has('$2,200,000 at closing') && /313,481 a year/.test(text));
check('and the premiums as their own line', has('$1,880,886'));
check('the premiums-to-maturity cell counts 6 years, not 10',
  /\$1,880,886 over 6 years/.test(text), (/\$1,880,886 over \d+ years?/.exec(text) || [])[0]);
check('the page says what happens if the premiums stop',
  /premiums are a commitment, not an option/.test(text));
check('and that a life expectancy is a median',
  /median, not a promise/.test(text));
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
check('it quotes the same total the sheet does', b.includes('$4,080,886'));
check('and the same purchase price', b.includes('$2,200,000'));
check('and the same premium total', b.includes('$1,880,886'));
check('and the same death benefit', b.includes('$10,000,000'));
check('it points at the attachment',
  /attached one-pager/i.test(b) && /attachment/i.test(b));
check('it names the attachment file', /one-pager\.pdf$/.test(draft?.attachment || ''),
  draft?.attachment);
check('it says the premiums are a commitment',
  /commitment, not an option/.test(b));
check('and that a life expectancy is a median', /median, not a promise/.test(b));
check('it carries the two-years-either-side rates',
  /two years early/.test(b) && /two years late/.test(b));

console.log('\nAND NO NAME LEAVES IN IT');
check('not the first insured', !/Gerald/i.test(b) && !/Sommers/i.test(b), b.slice(0, 160));
check('not the second', !/Judith/i.test(b));
check('not out of the investment case either, which had the name typed in it',
  /repeat seller/i.test(b) && !/Gerald/i.test(b));
check('the initials are there instead', /G\./.test(b) && /J\./.test(b));
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
  /\$510,111/.test(share.body) || /\$510,110/.test(share.body),
  (/What you put in is ([^:]+):/.exec(share.body) || [])[1]);
check('and says what share is being offered', /12\.5%/.test(share.body));

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
  /on one insured/.test(one.body) && !/second death/.test(one.body));

const unpriced = opportunityEmail({ ...bareFull, analysis: bareFull.analysis }, {});
check('an unpriced deal is not sent quoting a return',
  !/%/.test(unpriced.body), unpriced.body.slice(0, 120));
check('and the composer says why', unpriced.warnings.length > 0,
  unpriced.warnings.join(' | '));

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All cover and covering-email checks passed.'}`);
process.exit(fails.length ? 1 : 0);
