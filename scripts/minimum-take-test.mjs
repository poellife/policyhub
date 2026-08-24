/* =====================================================================
   The smallest slice anybody may take.

   A life settlement is a long, hands-on position: years of premium calls
   and servicing against one policy. Ten small holders cost more to
   administer than the tickets are worth, so ten per cent is the floor.

   The floor has one exception, and it is the whole reason this file
   exists. If fewer than ten points are left, the floor drops to whatever
   remains — otherwise a deal that sold 94% would sit at 94% forever,
   which is a worse outcome than no floor at all.

   Checked against the API rather than the screen: a rule about what the
   firm will accept has to hold for anything that can reach the route.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'MINTAKE';
const FLOOR = 10;
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);
const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;
const funds = await json(await api(admin, '/funds'));

const wipe = async () => {
  for (const o of ((await json(await api(admin, '/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/opportunities/${o.id}`, { method: 'DELETE' });
  for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=`))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
};
await wipe();

const make = async (suffix) => {
  const o = await json(await api(admin, '/opportunities', { method: 'POST', body: {
    policy_number: `${PREFIX}-${suffix}`, carrier_name: 'Floor Life', product_type: 'UL',
    face_amount: 3000000, insured_last_name: 'Minimum', insured_first_name: 'Isla',
    insured_dob: '1940-06-04', insured_gender: 'F', insured_state: 'MI',
    le_months: 72, le_provider: 'AVS', le_date: '2026-02-01',
    asking_price: 640000, annual_premium: 52000,
    expected_close: '2026-10-31', offer_closes_on: '2027-08-31',
    fund_id: funds.find((f) => f.code === 'LCG1').id } }));
  await api(admin, `/opportunities/${o.id}/shares`,
    { method: 'PUT', body: { investor_ids: [me1, me2] } });
  return o;
};
const take = (who, id, pct) => api(who, `/opportunities/${id}/commit`,
  { method: 'POST', body: { pct } });
const seen = async (who, id) => json(await api(who, `/opportunities/${id}`));

console.log('TEN PER CENT IS THE FLOOR');
const o = await make('1');
const view = await seen(inv1, o.id);
check('the offer says so itself, rather than leaving the portal to guess',
  Number(view.min_commitment_pct) === FLOOR, String(view.min_commitment_pct));
check('and the list says the same thing',
  Number(((await json(await api(inv1, '/opportunities'))) || [])
    .find((x) => x.id === o.id)?.min_commitment_pct) === FLOOR);

for (const pct of [0.5, 5, 9.99]) {
  const r = await take(inv1, o.id, pct);
  const body = await json(r);
  check(`${pct}% is refused`, r.status === 400 && /smallest share/i.test(body?.error || ''),
    `${r.status} ${body?.error || ''}`);
}
check('and nothing was recorded for them',
  !(await seen(inv1, o.id)).my_commitment);

const exact = await take(inv1, o.id, FLOOR);
check('exactly ten per cent is accepted', exact.status === 201, String(exact.status));
check('and so is more than ten', (await take(inv2, o.id, 25)).status === 201);
check('the two of them hold 35% between them',
  Number((await seen(admin, o.id)).taken_pct) === 35,
  String((await seen(admin, o.id)).taken_pct));

console.log('\nREDUCING A HOLDING IS HELD TO THE SAME FLOOR');
check('an investor cannot cut their own request to 4%',
  (await take(inv1, o.id, 4)).status === 400);
check('their existing request is untouched',
  Number((await seen(inv1, o.id)).my_commitment.pct) === FLOOR,
  String((await seen(inv1, o.id)).my_commitment.pct));
check('but they can cut it to exactly ten', (await take(inv1, o.id, FLOOR)).status === 201);
check('and their own live request does not count against their own floor',
  Number((await seen(inv1, o.id)).min_commitment_pct) === FLOOR,
  String((await seen(inv1, o.id)).min_commitment_pct));

console.log('\nTHE LAST SLICE IS TAKEN WHOLE');
/* Investor two takes it up to 94%, leaving six — less than the floor.
   The rule has to bend here or the deal never fills. */
const o2 = await make('2');
await take(inv2, o2.id, 94);
const left = await seen(inv1, o2.id);
check('six per cent is left', Number(left.remaining_pct) === 6, String(left.remaining_pct));
check('and the floor drops to exactly that',
  Number(left.min_commitment_pct) === 6, String(left.min_commitment_pct));
const short = await json(await take(inv1, o2.id, 3));
check('half of what is left is still refused',
  /taken whole/i.test(short?.error || ''), short?.error);
check('the message says what to ask for instead',
  /ask for 6%/.test(short?.error || ''), short?.error);
check('and the whole remainder is accepted',
  (await take(inv1, o2.id, 6)).status === 201);
check('which fills the offer', Number((await seen(admin, o2.id)).remaining_pct) === 0);

console.log('\nA FRACTIONAL REMAINDER READS PROPERLY');
const o3 = await make('3');
await take(inv2, o3.id, 93.75);
const frac = await seen(inv1, o3.id);
check('the floor is the exact remainder, not a rounded one',
  Number(frac.min_commitment_pct) === 6.25, String(frac.min_commitment_pct));
const msg = await json(await take(inv1, o3.id, 6));
check('and the message quotes it without inventing decimals',
  /6\.25%/.test(msg?.error || '') && !/6\.2500/.test(msg?.error || ''), msg?.error);
check('the exact remainder is accepted', (await take(inv1, o3.id, 6.25)).status === 201);

console.log('\nTHE FLOOR IS THE INVESTOR’S, NOT THE MANAGER’S');
/* A manager confirming a request is making a commercial decision, and a
   small allocation agreed off-platform is theirs to record. */
const o4 = await make('4');
await take(inv1, o4.id, 20);
const c = (await seen(admin, o4.id)).commitments.find((x) => x.investor_id === me1);
check('a manager can confirm a request as it stands',
  (await api(admin, `/opportunity-commitments/${c.id}`,
    { method: 'PUT', body: { status: 'Confirmed' } })).status === 200);

console.log('\nA DECLINED REQUEST RELEASES WHAT IT HELD');
const o5 = await make('5');
await take(inv1, o5.id, 95);
const held = (await seen(admin, o5.id)).commitments.find((x) => x.investor_id === me1);
check('five per cent is left, so the floor is five',
  Number((await seen(inv2, o5.id)).min_commitment_pct) === 5,
  String((await seen(inv2, o5.id)).min_commitment_pct));
await api(admin, `/opportunity-commitments/${held.id}`,
  { method: 'PUT', body: { status: 'Declined' } });
check('once declined, the whole offer is open again',
  Number((await seen(inv2, o5.id)).remaining_pct) === 100);
check('and the floor is back to ten',
  Number((await seen(inv2, o5.id)).min_commitment_pct) === FLOOR,
  String((await seen(inv2, o5.id)).min_commitment_pct));

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL MINIMUM TAKE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
