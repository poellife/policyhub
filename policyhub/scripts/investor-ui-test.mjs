import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1 } from './test-config.mjs';
const S='/home/claude/shots';
const fails=[]; const errs=[];
const check=(n,ok,x='')=>{console.log(`${ok?'  PASS':'  FAIL'}  ${n}${x?` — ${x}`:''}`); if(!ok)fails.push(n);};
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});

async function session(email, pass) {
  const ctx = await br.newContext({viewport:{width:1500,height:1000}});
  const p = await ctx.newPage();
  p.on('pageerror',e=>errs.push(`${email}: ${e.message}`));
  p.on('console',m=>m.type()==='error'&&!/40[0134]/.test(m.text())&&errs.push(`${email}: ${m.text()}`));
  await p.goto(BASE);
  await p.fill('#email',email); await p.fill('#password',pass);
  await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row',{timeout:12000});
  return p;
}

console.log('STAFF VIEW');
const staff = await session(ADMIN.email,ADMIN.password);
const staffNav = await staff.$$eval('.nav a', a=>a.map(x=>x.textContent.trim()));
check('staff nav has Investors + Import', staffNav.includes('Investors') && staffNav.includes('Import'), staffNav.join('/'));
await staff.goto(`${BASE}/#/investors`);
await staff.waitForFunction(()=>document.querySelector('h1')?.textContent==='Investors');
await staff.waitForTimeout(600);
// Count against the API rather than a fixed number: the fixture book grows
// as suites add investors, and a screen that lists every one of them is what
// is actually being checked.
const allInvestors = await staff.evaluate(() => fetch('/api/investors').then((r) => r.json()));
check('investors directory lists every investor',
  (await staff.locator('table.data tbody tr').count()) === allInvestors.length,
  `${await staff.locator('table.data tbody tr').count()} rows for ${allInvestors.length} investors`);
await staff.screenshot({path:`${S}/i1-investors.png`,fullPage:true});

await staff.click('table.data tbody tr:first-child');
await staff.waitForTimeout(900);
check('investor detail shows positions', (await staff.locator('.main').textContent()).includes('Positions'));
await staff.screenshot({path:`${S}/i2-investor-detail.png`,fullPage:true});

// cap table on a policy
// Find a policy that actually has more than one holder rather than assuming
// the first row does — allocations move around as other suites run.
const shared = await staff.evaluate(async () => {
  const ps = await fetch('/api/policies').then((r) => r.json());
  for (const p of ps) {
    const d = await fetch(`/api/policies/${p.id}`).then((r) => r.json());
    if ((d.owners || []).length >= 2) return { id: p.id, names: d.owners.map((o) => o.name) };
  }
  return null;
});
check('a policy with two holders exists', shared !== null, shared ? shared.names.join(', ') : 'none');
await staff.goto(`${BASE}/#/policy/${shared.id}`); await staff.waitForSelector('.tabs');
await staff.waitForTimeout(700);
const capText = await staff.locator('.main').textContent();
check('policy shows the ownership cap table', capText.includes('Ownership'));
check('cap table shows both holders', shared.names.every((n) => capText.includes(n)),
  shared.names.join(', '));
await staff.screenshot({path:`${S}/i3-policy-ownership.png`,fullPage:true});

console.log('\nINVESTOR VIEW');
const inv = await session(INVESTOR1.email,INVESTOR1.password);
const invNav = await inv.$$eval('.nav a', a=>a.map(x=>x.textContent.trim()));
check('investor nav hides staff sections',
  !invNav.includes('Investors') && !invNav.includes('Import') && !invNav.includes('Insureds'), invNav.join('/'));
check('investor nav is portfolio-oriented', invNav.includes('Portfolio') && invNav.includes('My policies'));
const heading = await inv.locator('h1').textContent();
check('dashboard is framed as their portfolio', heading.includes('Your portfolio'), heading);
await inv.screenshot({path:`${S}/i4-investor-dashboard.png`,fullPage:true});

await inv.goto(`${BASE}/#/policies`); await inv.waitForSelector('table.data tbody tr'); await inv.waitForTimeout(500);
check('investor sees only their two policies', (await inv.locator('table.data tbody tr').count())===2);
check('My share column present', (await inv.locator('th[data-key="my_pct"]').count())===1);
check('no New policy button', (await inv.locator('#newPolicyBtn').count())===0);
await inv.screenshot({path:`${S}/i5-investor-policies.png`,fullPage:true});

/* There is no longer a way to see the whole policy: an investor's figures are
   their own, always, and the screen says so rather than offering a choice. */
check('no full-policy toggle is offered', (await inv.locator('[data-share]').count()) === 0);
check('the screen states the basis instead',
  (await inv.locator('.share-note').count()) === 1,
  (await inv.locator('.share-note').textContent().catch(() => 'absent')));
check('and the heading says every figure is their share',
  /every figure is your share/i.test(await inv.locator('.page-head .sub').textContent()));

// The totals must be the sum of the scaled rows, not of the whole policies.
const tfoot = await inv.locator('table.data tfoot').textContent();
const shown = Number(tfoot.match(/\$([\d,]+\.\d\d)/)[1].replace(/,/g, ''));
const whole = await inv.evaluate(async () => {
  const ps = await fetch('/api/policies').then((r) => r.json());
  return ps.reduce((s, p) => s + (Number(p.face_amount) || 0), 0);
});
check('the totals are scaled, not the whole policies', shown < whole,
  `${shown} < ${whole}`);
await inv.screenshot({path:`${S}/i6-investor-share.png`,fullPage:true});

await inv.click('table.data tbody tr:first-child'); await inv.waitForSelector('.tabs');
await inv.waitForTimeout(700);
const invDetail = await inv.locator('.main').textContent();
check('investor sees "Your position" not the cap table', invDetail.includes('Your position'));
check('investor cannot see co-owners', !invDetail.includes('M. Okonkwo'));
check('no edit or delete buttons', (await inv.locator('#editBtn').count())===0 && (await inv.locator('#deletePolicyBtn').count())===0);
await inv.screenshot({path:`${S}/i7-investor-policy.png`,fullPage:true});

console.log('\nEVERY FIGURE ON A POLICY IS THEIR SHARE, AND SAYS SO');
const openId = await inv.evaluate(() => fetch('/api/policies').then((r) => r.json()).then((x) => x[0].id));
const full = await inv.evaluate(async (id) => {
  // What the record actually holds, before any scaling.
  const p = await fetch(`/api/policies/${id}`).then((r) => r.json());
  return { pct: Number(p.my_pct), face: Number(p.face_amount),
           cost: Number(p.acquisition_cost) || 0, invested: Number(p.total_invested) || 0,
           premium: Number(p.premium_required) || 0 };
}, openId);
await inv.goto(`${BASE}/#/policy/${openId}`); await inv.waitForSelector('.tabs');
await inv.waitForTimeout(800);
const detailText = (await inv.locator('.main').textContent()).replace(/\s+/g, ' ');
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
// Some cards render whole dollars, some to the cent; match on the digits.
const anyMoney = (hay, n) => hay.includes(money(n))
  || hay.includes(money(n).replace(/\.00$/, ''));

check('a banner states the percentage they own',
  (await inv.locator('.share-banner').count()) === 1,
  (await inv.locator('.share-banner').textContent().catch(() => 'absent')).replace(/\s+/g, ' ').slice(0, 120));
check('and says the figures are that share, not the policy',
  /is your .* share, not the whole policy/i.test(
    await inv.locator('.share-banner').textContent()));
check('the death benefit is scaled', anyMoney(detailText, full.face * full.pct / 100),
  `expected ${money(full.face * full.pct / 100)} at ${full.pct}% of ${money(full.face)}`);
check('and the whole-policy death benefit is nowhere on the page',
  !anyMoney(detailText, full.face), money(full.face));
if (full.cost) {
  // Read the row itself rather than scanning the page: a coincidence elsewhere
  // (two acquisition entries making the scaled total equal the raw cost) would
  // otherwise fail a card that is perfectly correct.
  const acqCard = (await inv.locator('.card', { hasText: 'Acquisition & premium' })
    .textContent()).replace(/\s+/g, ' ');
  check('the acquisition cost is scaled', anyMoney(acqCard, full.cost * full.pct / 100),
    `${money(full.cost * full.pct / 100)} in: ${acqCard.slice(0, 110)}`);
  check('not the whole purchase price', !anyMoney(acqCard, full.cost), money(full.cost));
} else {
  check('the acquisition cost is scaled', true, 'none recorded');
  check('not the whole purchase price', true, 'none recorded');
}

console.log('\nNO CASH OR ACCOUNT VALUES ANYWHERE');
/* Account value, cash surrender value and cost of insurance are how a policy
   is administered. An investor holds a percentage of a death benefit and is
   never going to surrender the contract, so these only invite a question
   nobody can act on — and a cash value beside a purchase price reads like a
   valuation, which it is not. */
const CASHY = /cash surrender|account value|cost of insurance|coverage runway/i;
check('not on the policy page', !CASHY.test(detailText), (detailText.match(CASHY) || [''])[0]);
check('and there is no value-history tab',
  (await inv.locator('.tabs button', { hasText: 'Value history' }).count()) === 0,
  (await inv.$$eval('.tabs button', (b) => b.map((x) => x.textContent.trim()))).join('/'));
check('asking for it by hand does not open it', await (async () => {
  await inv.goto(`${BASE}/#/policy/${openId}?tab=values`);
  await inv.waitForSelector('.tabs'); await inv.waitForTimeout(700);
  return !CASHY.test((await inv.locator('.main').textContent()));
})());
await inv.goto(`${BASE}/#/policies`); await inv.waitForSelector('table.data'); await inv.waitForTimeout(700);
check('not a column on their policy list',
  !CASHY.test(await inv.locator('table.data thead').textContent()),
  await inv.locator('table.data thead').textContent());
await inv.goto(`${BASE}/#/dashboard`); await inv.waitForSelector('.kpi-row'); await inv.waitForTimeout(800);
check('and not a tile on their portfolio',
  !CASHY.test(await inv.locator('.kpi-row').textContent()),
  await inv.locator('.kpi-row').textContent().then((t) => t.replace(/\s+/g, ' ').slice(0, 150)));
check('staff still have them', await staff.evaluate(async () => {
  const r = await fetch('/api/analytics/summary').then((x) => x.json());
  return r.totals.total_csv !== undefined;
}));
await inv.goto(`${BASE}/#/policy/${openId}`); await inv.waitForSelector('.tabs'); await inv.waitForTimeout(700);

console.log('\nTHEIR SERVICING TAB IS DATES, NOT SERVICING WORK');
await inv.locator('.tabs button', { hasText: 'Premiums' }).first().click();
await inv.waitForTimeout(800);
const svcTab = (await inv.locator('.main .card').first().textContent()).replace(/\s+/g, ' ');
check('it lists the premiums coming up', /Premiums coming up/i.test(svcTab), svcTab.slice(0, 120));
check('with their share beside the full policy figure',
  /Your share/i.test(svcTab) && /Full policy/i.test(svcTab));
check('with no lapse-risk commentary',
  !/cost of insurance|Coverage runway|No value update/i.test(svcTab), svcTab.slice(0, 200));
check('no follow-up schedule', !/Follow-up schedule/i.test(svcTab));
check('and nothing to schedule or log',
  (await inv.locator('#scheduleStepBtn').count()) === 0
  && (await inv.locator('#logPremiumBtn').count()) === 0);
await inv.screenshot({ path: `${S}/i8-investor-servicing.png`, fullPage: true });

console.log('\nTHE PREMIUMS SCREEN');
await inv.goto(`${BASE}/#/servicing`); await inv.waitForTimeout(1000);
const svcPage = (await inv.locator('.main').textContent()).replace(/\s+/g, ' ');
check('it is called Premiums', /Premiums/.test(await inv.locator('h1').textContent()));
check('there is no alerts card', !/Alerts/i.test(svcPage), svcPage.slice(0, 160));
check('it says the amounts are their share', /amounts are your share/i.test(svcPage));
check('and every date shown is still ahead', await inv.evaluate(() => {
  const today = new Date().toISOString().slice(0, 10);
  return [...document.querySelectorAll('table.data tbody tr td:first-child')]
    .map((td) => td.textContent.trim())
    .filter(Boolean)
    .every((d) => {
      const [m, dd, y] = d.split('/');
      return `${y}-${m}-${dd}` >= today;
    });
}));
await inv.screenshot({ path: `${S}/i9-investor-premiums.png`, fullPage: true });

console.log('\nTHEIR STATEMENTS ARE THEIR SHARE TOO');
await inv.goto(`${BASE}/#/reports`); await inv.waitForSelector('#rptGenerate');
await inv.waitForTimeout(600);
check('the section is called Statements', /Statements/.test(await inv.locator('h1').textContent()));
check('with no owner-entity picker', !(await inv.locator('#rptFund').isVisible().catch(() => false)));

// The policy schedule is built from raw records, so it is the one that would
// leak whole-policy figures if the scaling were missed.
await inv.click('.rpt-choice:has(input[value="schedule"])');
await inv.click('#rptGenerate');
await inv.waitForSelector('.rpt-sheet', { timeout: 20000 });
await inv.waitForTimeout(1200);
const sched = (await inv.locator('.rpt-output').textContent()).replace(/\s+/g, ' ');
check('it states the basis on the page', /Every figure in this report is your share/i.test(sched),
  sched.slice(0, 200));
check('naming the percentage', /\d+(\.\d+)?%/.test(
  await inv.locator('.rpt-basis').textContent()),
  await inv.locator('.rpt-basis').textContent());
const schedFace = await inv.evaluate(async () => {
  const ps = await fetch('/api/policies?fund=&status=').then((r) => r.json());
  return {
    whole: ps.reduce((s, p) => s + (Number(p.face_amount) || 0), 0),
    mine: ps.reduce((s, p) => s + (Number(p.face_amount) || 0) * (Number(p.my_pct) || 0) / 100, 0),
  };
});
check('the totals are their share', anyMoney(sched, schedFace.mine),
  `${money(schedFace.mine)} of ${money(schedFace.whole)}`);
check('and not the whole book', !anyMoney(sched, schedFace.whole),
  money(schedFace.whole));
check('the statement drops the carrier-value columns too',
  !/\bAV\b|\bCSV\b|\bCOI\b/.test(await inv.locator('.rpt-sheet thead').textContent()),
  await inv.locator('.rpt-sheet thead').textContent());

// A fact sheet is the most detailed thing an investor can print.
await inv.click('.rpt-choice:has(input[value="factsheet"])');
await inv.click('#rptGenerate');
await inv.waitForSelector('.rpt-sheet', { timeout: 25000 });
await inv.waitForTimeout(1500);
const facts = (await inv.locator('.rpt-output').textContent()).replace(/\s+/g, ' ');
check('nor does the fact sheet carry cash or account values',
  !/cash surrender|account value|coverage runway|recent carrier values/i.test(facts),
  (facts.match(/cash surrender|account value|coverage runway|recent carrier values/i) || [''])[0]);
check('it states the basis as well', /Every figure in this report is your share/i.test(facts));
await inv.screenshot({ path: `${S}/i10-investor-statement.png`, fullPage: true });

await inv.goto(`${BASE}/#/settings`); await inv.waitForSelector('#pwForm'); await inv.waitForTimeout(500);
const setTxt = await inv.locator('.main').textContent();
check('investor settings shows only password', setTxt.includes('Change your password') && !setTxt.includes('Owner entities') && !setTxt.includes('Activity log'));

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await br.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nALL INVESTOR UI CHECKS PASSED');
process.exit(fails.length?1:0);
