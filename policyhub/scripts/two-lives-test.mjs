/* =====================================================================
   Two insureds, and the estimate that decides the price.

   A survivorship policy pays on the SECOND death. So a deal with two
   lives is not one life with a note attached: the money does not arrive
   until both estimates have run out, and the wait is what the price is
   built on.

   What has to hold:

     the maturity is the LATER of the two, compared as DATES and never as
       month counts -- each estimate is counted from its own report, and a
       seventy-month report written this year outlasts an eighty-month one
       written two years ago;
     a second life with no report date is not a candidate, because there
       is nothing to count from and inventing a date would put a maturity
       on the record that no document supports;
     the screen and the one-pagers all name the life that is driving it;
     a deal with one insured behaves exactly as it always did;
     and clearing the second insured really clears it, or the deal goes
       on being priced off somebody the form no longer shows.

   The fixture is the Sommers file, because it is real and because it is
   the case that catches the mistake: Gerald's estimate is 36 months and
   Judith's is 71, both written on the same day, so the later date is
   hers -- and a second, invented pair with the dates apart proves the
   comparison is on dates rather than on months.

   Idempotent: fixtures use a fixed prefix and are removed first.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'TWOLIFE';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

/* The Sommers deal, as the documents state it. */
const SOMMERS = {
  carrier_name: 'Pacific Life', product_type: 'SUL',
  face_amount: 10000000, asking_price: 2200000, annual_premium: 313481,
  expected_close: '2026-10-01',
  insured_last_name: 'Sommers', insured_first_name: 'Gerald',
  insured_dob: '1941-08-08', insured_gender: 'M', insured_state: 'IL',
  le_months: 36, le_provider: '21st', le_date: '2026-08-26',
  insured2_last_name: 'Sommers', insured2_first_name: 'Judith',
  insured2_dob: '1943-01-24', insured2_gender: 'F', insured2_state: 'IL',
  insured2_le_months: 71, insured2_le_provider: '21st', insured2_le_date: '2026-08-26',
};

const make = async (suffix, body = {}) => json(await api(admin, '/opportunities', {
  method: 'POST', body: { policy_number: `${PREFIX}-${suffix}`, fund_id: lcg1.id,
    ...SOMMERS, ...body } }));
const at = (an, months) => an.scenarios.find((s) => s.offset_months === months);

/* ------------------------------------------------------------------ *
 * One life still behaves as it always did
 * ------------------------------------------------------------------ */
console.log('AN ORDINARY DEAL IS UNTOUCHED BY ANY OF THIS');
const single = await make('ONE', {
  insured2_last_name: '', insured2_first_name: '', insured2_dob: null,
  insured2_gender: '', insured2_state: '', insured2_le_months: null,
  insured2_le_provider: '', insured2_le_date: null });
const one = (await json(await api(admin, `/opportunities/${single.id}`))).analysis;
check('it is not a survivorship deal', one.survivorship === false);
check('there is one life on it', (one.lives || []).length === 1);
check('nothing is driving anything', one.driving_life === null);
/* 36 months from 2026-08-26 is 2029-08-26. */
check('and the maturity is that life’s estimate, as before',
  at(one, 0).matures_on === '2029-08-26', at(one, 0).matures_on);

/* ------------------------------------------------------------------ *
 * Two lives
 * ------------------------------------------------------------------ */
console.log('\nTWO LIVES: THE MONEY WAITS FOR THE SECOND DEATH');
const both = await make('SOMMERS');
const two = (await json(await api(admin, `/opportunities/${both.id}`))).analysis;

check('the deal reads as survivorship', two.survivorship === true);
check('with both lives on it', (two.lives || []).length === 2,
  (two.lives || []).map((l) => `${l.n}:${l.initials} ${l.le_months}mo`).join(' | '));
check('each carrying its own provider and report date',
  two.lives[0].le_date === '2026-08-26' && two.lives[1].le_date === '2026-08-26'
  && two.lives[1].le_provider === '21st');
check('and its own age',
  two.lives[0].dob === '1941-08-08' && two.lives[1].dob === '1943-01-24');

/* Gerald 36 mo from 2026-08-26 → 2029-08-26. Judith 71 mo → 2032-07-26. */
check('the maturity is the later of the two, not the first life’s',
  at(two, 0).matures_on === '2032-07-26', at(two, 0).matures_on);
check('and the screen is told which life it is waiting on',
  two.driving_life?.n === 2 && at(two, 0).driving_life === 2,
  `life ${two.driving_life?.n}`);
check('the shorter estimate does not decide it',
  at(two, 0).matures_on > '2029-08-26');

check('waiting longer costs more in premiums than the one-life reading',
  at(two, 0).premiums_paid > at(one, 0).premiums_paid,
  `${at(two, 0).premiums_paid} vs ${at(one, 0).premiums_paid}`);
check('and the return is lower for it, which is the entire point',
  at(two, 0).rate < at(one, 0).rate,
  `${(at(two, 0).rate * 100).toFixed(2)}% vs ${(at(one, 0).rate * 100).toFixed(2)}%`);

check('the three scenarios still move in order',
  at(two, -24).matures_on < at(two, 0).matures_on
  && at(two, 0).matures_on < at(two, 24).matures_on,
  two.scenarios.map((s) => s.matures_on).join(' < '));

/* ------------------------------------------------------------------ *
 * Dates, not months
 * ------------------------------------------------------------------ */
console.log('\nCOMPARED AS DATES, WHICH IS NOT THE SAME AS COMPARED AS MONTHS');
/* Life one: 84 months from January 2025 → January 2032.
   Life two: 72 months from September 2026 → September 2032.
   The SHORTER estimate has the LATER date, and it is the one that counts. */
const apart = await make('APART', {
  le_months: 84, le_date: '2025-01-01',
  insured2_le_months: 72, insured2_le_date: '2026-09-01' });
const skew = (await json(await api(admin, `/opportunities/${apart.id}`))).analysis;
check('the life with fewer months can still be the later one',
  skew.driving_life?.n === 2 && skew.lives[1].le_months < skew.lives[0].le_months,
  `${skew.lives[0].le_months}mo → ${skew.lives[0].matures_on} vs ${
    skew.lives[1].le_months}mo → ${skew.lives[1].matures_on}`);
check('and the maturity is that later date',
  at(skew, 0).matures_on === '2032-09-01', at(skew, 0).matures_on);
check('taking the bigger month count would have been wrong by nine months',
  at(skew, 0).matures_on !== '2032-01-01');

/* ------------------------------------------------------------------ *
 * A second life with nothing to count from
 * ------------------------------------------------------------------ */
console.log('\nA SECOND LIFE WITH NO REPORT DATE IS NOT A CANDIDATE');
const undated = await make('UNDATED', { insured2_le_date: null });
const un = (await json(await api(admin, `/opportunities/${undated.id}`))).analysis;
check('the life is still shown, because the person is on the deal',
  (un.lives || []).length === 2);
check('but it has no date its estimate runs out',
  un.lives[1].matures_on === null);
check('so the maturity falls back to the life that does have one',
  at(un, 0).matures_on === '2029-08-26', at(un, 0).matures_on);
check('and nothing claims to be driving it',
  un.driving_life === null || un.driving_life.n === 1);

/* ------------------------------------------------------------------ *
 * Clearing it
 * ------------------------------------------------------------------ */
console.log('\nCLEARING THE SECOND INSURED REALLY CLEARS IT');
await api(admin, `/opportunities/${both.id}`, { method: 'PUT', body: {
  insured2_last_name: '', insured2_first_name: '', insured2_dob: null,
  insured2_gender: '', insured2_state: '', insured2_le_months: null,
  insured2_le_provider: '', insured2_le_date: null } });
const cleared = (await json(await api(admin, `/opportunities/${both.id}`))).analysis;
check('the deal stops being survivorship', cleared.survivorship === false);
check('and prices off the remaining life again',
  at(cleared, 0).matures_on === '2029-08-26', at(cleared, 0).matures_on);
check('the rate goes back to the one-life figure',
  Math.abs(at(cleared, 0).rate - at(one, 0).rate) < 1e-9);

/* ------------------------------------------------------------------ *
 * The list and the detail
 * ------------------------------------------------------------------ */
console.log('\nTHE LIST AND THE DETAIL AGREE');
const listed = ((await json(await api(admin, '/opportunities'))) || [])
  .find((x) => x.id === apart.id);
check('the list reads both lives too, rather than only the first',
  listed.matures_on === at(skew, 0).matures_on,
  `${listed.matures_on} vs ${at(skew, 0).matures_on}`);
check('so the rate on the list is the rate on the deal',
  Math.abs(listed.rate_at_le - at(skew, 0).rate) < 1e-9,
  `${listed.rate_at_le} vs ${at(skew, 0).rate}`);

/* ------------------------------------------------------------------ *
 * Neither name leaves the building
 *
 * `analysis` travels to an investor with the rest of the deal, and every
 * other field they are shown has been through the scrubbing that turns a
 * name into initials. A convenience copy of the full name assembled
 * inside the analysis goes out beside them untouched -- which is exactly
 * what happened the first time this was written, and what the privacy
 * suite caught.
 * ------------------------------------------------------------------ */
console.log('\nTHE ANALYSIS CARRIES INITIALS, NEVER NAMES');
const shown = await make('SHARED');
const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
/* Shared with the investor who is actually going to open it, not with
   whichever record happens to sort first. */
const me = (await json(await api(invCookie, '/auth/me'))).investor.id;
await api(admin, `/opportunities/${shown.id}/shares`,
  { method: 'PUT', body: { investor_ids: [me] } });

const staffRaw = await (await api(admin, `/opportunities/${shown.id}`)).text();
const staffAn = JSON.parse(staffRaw).analysis;
check('even for staff, the lives carry no assembled full name',
  (staffAn.lives || []).every((l) => !('name' in l)),
  JSON.stringify(staffAn.lives?.[0] || {}).slice(0, 90));
check('they carry initials, which is what the paper prints',
  staffAn.lives[0].initials === 'GS' && staffAn.lives[1].initials === 'JS',
  `${staffAn.lives[0].initials} / ${staffAn.lives[1].initials}`);

/* And through the door an investor actually comes in by. */
const invRaw = await (await fetch(`${BASE}/api/opportunities/${shown.id}`,
  { headers: { Cookie: invCookie } })).text();
check('an investor shown the deal sees no surname anywhere in it',
  !/Sommers/i.test(invRaw), (/.{0,40}Sommers.{0,40}/i.exec(invRaw) || [''])[0]);
check('nor either forename',
  !/Gerald/i.test(invRaw) && !/Judith/i.test(invRaw),
  (/.{0,40}(Gerald|Judith).{0,40}/i.exec(invRaw) || [''])[0]);
check('but the second life is still there as a person',
  JSON.parse(invRaw).analysis?.lives?.length === 2);
const invSeen = JSON.parse(invRaw);
check('and reads as one — their own initial, not the first insured’s',
  invSeen.insured_first_name === 'G.' && invSeen.insured_last_name === 'S.'
  && invSeen.insured2_first_name === 'J.' && invSeen.insured2_last_name === 'S.',
  `${invSeen.insured_first_name}${invSeen.insured_last_name} / ${
    invSeen.insured2_first_name}${invSeen.insured2_last_name}`);
check('an ordinary deal gains no phantom second insured from the mask',
  await (async () => {
    await api(admin, `/opportunities/${shown.id}`, { method: 'PUT', body: {
      insured2_last_name: '', insured2_first_name: '' } });
    const plain = await (await fetch(`${BASE}/api/opportunities/${shown.id}`,
      { headers: { Cookie: invCookie } })).json();
    return plain.insured2_first_name === '' && plain.insured2_last_name === '';
  })());

/* ------------------------------------------------------------------ *
 * The paper
 * ------------------------------------------------------------------ */
console.log('\nBOTH LIVES ARE ON THE ONE-PAGER, AND NEITHER NAME IS');
const pdfRes = await api(admin, `/opportunities/${both.id}/sheet.pdf`);
check('a one-pager is produced', pdfRes.ok);

/* `both` has just been cleared, so the survivorship sheet is the other. */
const sheetRes = await api(admin, `/opportunities/${apart.id}/sheet.pdf`);
const pdf = Buffer.from(await sheetRes.arrayBuffer()).toString('latin1');
check('it says there are two lives', /two lives|second death/i.test(pdf));
check('and says the return is modelled on the later estimate',
  /runs out later/i.test(pdf));
check('and says it is not a joint life expectancy — because it is not',
  /not a joint life expectancy/i.test(pdf));
check('neither insured is named in full',
  !/Sommers/i.test(pdf) && !/Gerald/i.test(pdf) && !/Judith/i.test(pdf));
check('they are initials', /G\.S\./.test(pdf) && /J\.S\./.test(pdf),
  (/[A-Z]\.[A-Z]\. & [A-Z]\.[A-Z]\./.exec(pdf) || ['not found'])[0]);

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All two-life checks passed.'}`);
process.exit(fails.length ? 1 : 0);
