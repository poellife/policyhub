/* =====================================================================
   Scenarios on a deal, and which one the investors are shown.

   A life settlement is priced off a life expectancy and a price, and
   neither is a fact. Every real conversation about a deal is therefore
   conditional — "at 72 we are fine, at 90 it is thin" — and the only
   way to see that used to be to edit the deal, read the figures, and
   edit it back, leaving the record saying something nobody believed for
   as long as it took.

   So: named variants beside the deal, each solved by the same engine,
   and one of them nominated as the case an investor is shown.

   Three things are under test.
     - A scenario is a lens, never an edit: the deal's own columns are
       untouched by any of it.
     - The chosen one reaches an investor everywhere the figures appear
       — the deal, the list behind it, and the one-pager, including the
       copy a member of staff downloads to send out.
     - Nobody but an administrator decides which one that is, and the
       rest of the set is never shown to an investor at all.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'OPPSCEN';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const call = (c) => (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const api = call(cookie);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const invCookie = await login(INVESTOR1.email, INVESTOR1.password);
const inv = call(invCookie);
const me = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: invCookie } })))
  .investor.id;

const mgrCookie = await login(MANAGER1.email, MANAGER1.password);
const mgr = call(mgrCookie);
const fund = ((await json(await mgr('/funds'))) || [])[0];
if (!fund) { console.log('  FAIL  the manager has an owner entity'); process.exit(1); }

const BASE_LE = 72;
const BASE_PRICE = 300000;
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 2000000, fund_id: fund.id, status: 'Open',
  insured_last_name: `${PREFIX}One`, insured_first_name: 'Ada', insured_dob: '1942-03-02',
  insured_gender: 'F', insured_state: 'MI',
  le_months: BASE_LE, le_provider: '21st Services', le_date: '2026-02-02',
  asking_price: BASE_PRICE, annual_premium: 40000 } }));
await api(`/opportunities/${deal.id}/shares`, { method: 'PUT', body: { investor_ids: [me] } });

const baseRate = (await json(await api(`/opportunities/${deal.id}`))).analysis?.base?.rate;
check('the deal as it stands solves to a rate', Number.isFinite(Number(baseRate)),
  String(baseRate));

console.log('A SCENARIO IS A SET OF DIFFERENT NUMBERS, NOT A DIFFERENT DEAL');
const longer = await json(await api(`/opportunities/${deal.id}/scenarios`, { method: 'POST',
  body: { name: 'If he lives to 90 months', le_months: 90,
    note: 'The cardiology reads better than 21st allowed for.' } }));
check('one can be added', !!longer?.id, JSON.stringify(longer?.error));
const cheaper = await json(await api(`/opportunities/${deal.id}/scenarios`, { method: 'POST',
  body: { name: 'If we get him to 260', asking_price: 260000 } }));
check('and another', !!cheaper?.id, JSON.stringify(cheaper?.error));

const empty = await api(`/opportunities/${deal.id}/scenarios`, { method: 'POST',
  body: { name: 'Same as the deal' } });
check('one that changes nothing is refused', empty.status === 400, String(empty.status));

const withScen = await json(await api(`/opportunities/${deal.id}`));
check('both are on the deal', (withScen.scenarios || []).length === 2,
  String((withScen.scenarios || []).length));
check('the deal’s own figures are untouched by either',
  Number(withScen.le_months) === BASE_LE && Number(withScen.asking_price) === BASE_PRICE,
  `${withScen.le_months} / ${withScen.asking_price}`);

const sLonger = withScen.scenarios.find((s) => s.id === longer.id);
const sCheaper = withScen.scenarios.find((s) => s.id === cheaper.id);
check('each is solved by the same engine the deal goes through',
  Number.isFinite(Number(sLonger.analysis?.base?.rate))
  && Number.isFinite(Number(sCheaper.analysis?.base?.rate)),
  `${sLonger.analysis?.base?.rate} | ${sCheaper.analysis?.base?.rate}`);
check('a longer wait pays less than the deal does',
  Number(sLonger.analysis.base.rate) < Number(baseRate),
  `${sLonger.analysis.base.rate} vs ${baseRate}`);
check('and a lower price pays more',
  Number(sCheaper.analysis.base.rate) > Number(baseRate),
  `${sCheaper.analysis.base.rate} vs ${baseRate}`);
check('a field left empty is read from the deal',
  sLonger.asking_price === null && Number(sCheaper.le_months ?? BASE_LE) === BASE_LE,
  `${sLonger.asking_price} / ${sCheaper.le_months}`);

const renamed = await api(`/opportunities/${deal.id}/scenarios/${longer.id}`,
  { method: 'PUT', body: { le_months: 96, name: 'If he lives to 96 months' } });
check('a scenario can be corrected', renamed.status === 200, String(renamed.status));
const after = await json(await api(`/opportunities/${deal.id}`));
check('and the new figure is the one solved',
  Number(after.scenarios.find((s) => s.id === longer.id).le_months) === 96);

console.log('\nUNTIL ONE IS CHOSEN, AN INVESTOR SEES THE DEAL AS IT STANDS');
const plain = await json(await inv(`/opportunities/${deal.id}`));
check('their figures are the deal’s', Number(plain.le_months) === BASE_LE
  && Number(plain.asking_price) === BASE_PRICE, `${plain.le_months} / ${plain.asking_price}`);
check('and the set is not sent to them at all', plain.scenarios === undefined
  && !JSON.stringify(plain).includes('cardiology'), JSON.stringify(plain.scenarios));

console.log('\nAND WHEN ONE IS CHOSEN IT IS THE ONE THEY SEE');
const pick = await api(`/opportunities/${deal.id}/scenarios/shown`, { method: 'PUT',
  body: { scenario_id: cheaper.id } });
check('an administrator can nominate one', pick.status === 200, String(pick.status));
const shown = await json(await inv(`/opportunities/${deal.id}`));
check('the price they are quoted is the scenario’s',
  Number(shown.asking_price) === 260000, String(shown.asking_price));
/* Compared against their OWN earlier figure rather than against the
   desk's: an investor's rate is net of the carry and the desk's is
   gross, so the two are different numbers for the same case by design.
   What has to be true is that theirs moved, and moved the right way. */
check('and the rate they are quoted moves with it',
  Number(shown.analysis.base.rate) > Number(plain.analysis.base.rate),
  `${shown.analysis.base.rate} vs ${plain.analysis.base.rate}`);
check('they are told which case this is', shown.scenario_shown?.name === 'If we get him to 260',
  JSON.stringify(shown.scenario_shown));
check('but still not the others', shown.scenarios === undefined
  && !JSON.stringify(shown).includes('cardiology'));
check('and the deal itself has not moved an inch',
  Number((await json(await api(`/opportunities/${deal.id}`))).asking_price) === BASE_PRICE);

const theirList = (await json(await inv('/opportunities')))
  .find((x) => x.id === deal.id);
check('the list behind it agrees with the page',
  Math.abs(Number(theirList.rate_at_le) - Number(shown.analysis.base.rate)) < 0.5,
  `${theirList.rate_at_le} vs ${shown.analysis.base.rate}`);

console.log('\nAND THE PAPER THAT GOES OUT IS BUILT ON IT TOO');
const sheet = await api(`/opportunities/${deal.id}/sheet.pdf`);
check('the desk’s own one-pager still downloads', sheet.status === 200, String(sheet.status));
const text = Buffer.from(await sheet.arrayBuffer()).toString('latin1');
check('and quotes the scenario’s price, not the deal’s',
  text.includes('260,000') && !text.includes('300,000'),
  `${text.includes('260,000')} / ${text.includes('300,000')}`);

console.log('\nPUTTING THEM BACK ON THE DEAL IS ONE CALL');
await api(`/opportunities/${deal.id}/scenarios/shown`, { method: 'PUT',
  body: { scenario_id: null } });
const back = await json(await inv(`/opportunities/${deal.id}`));
check('they are on the deal’s own figures again',
  Number(back.asking_price) === BASE_PRICE && !back.scenario_shown,
  `${back.asking_price} / ${JSON.stringify(back.scenario_shown)}`);

console.log('\nONLY ONE AT A TIME, AND ONLY AN ADMINISTRATOR DECIDES');
await api(`/opportunities/${deal.id}/scenarios/shown`, { method: 'PUT',
  body: { scenario_id: longer.id } });
await api(`/opportunities/${deal.id}/scenarios/shown`, { method: 'PUT',
  body: { scenario_id: cheaper.id } });
const marked = (await json(await api(`/opportunities/${deal.id}`)))
  .scenarios.filter((s) => s.shown_to_investors);
check('nominating a second one stands the first down', marked.length === 1,
  String(marked.length));
check('and it is the one just chosen', marked[0]?.id === cheaper.id);

const mgrPick = await mgr(`/opportunities/${deal.id}/scenarios/shown`, { method: 'PUT',
  body: { scenario_id: longer.id } });
check('a manager cannot change what is offered', mgrPick.status === 403, String(mgrPick.status));
const mgrAdd = await mgr(`/opportunities/${deal.id}/scenarios`, { method: 'POST',
  body: { name: 'Manager’s try', le_months: 60 } });
check('though he may try numbers out, which is the work', mgrAdd.status === 201,
  String(mgrAdd.status));
const invAdd = await inv(`/opportunities/${deal.id}/scenarios`, { method: 'POST',
  body: { name: 'Investor’s try', asking_price: 1 } });
check('an investor may not', invAdd.status === 403, String(invAdd.status));

console.log('\nAND DELETING THE CHOSEN ONE PUTS THEM BACK, RATHER THAN BREAKING');
await api(`/opportunities/${deal.id}/scenarios/${cheaper.id}`, { method: 'DELETE' });
const afterDel = await json(await inv(`/opportunities/${deal.id}`));
check('the investor is on the deal’s figures',
  Number(afterDel.asking_price) === BASE_PRICE && !afterDel.scenario_shown,
  String(afterDel.asking_price));
const missing = await api(`/opportunities/${deal.id}/scenarios/${cheaper.id}`,
  { method: 'DELETE' });
check('and deleting it twice is a plain not-found', missing.status === 404,
  String(missing.status));

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All opportunity scenario checks passed.'}`);
process.exit(fails.length ? 1 : 0);
