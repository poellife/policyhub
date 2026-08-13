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
check('investors directory lists all three', (await staff.locator('table.data tbody tr').count())===3);
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

// the share toggle
const mineText = await inv.locator('table.data tfoot').textContent();
await inv.click('[data-share="full"]'); await inv.waitForTimeout(700);
const fullText = await inv.locator('table.data tfoot').textContent();
check('toggle changes the totals', mineText !== fullText);
const mineDB = Number(mineText.match(/\$([\d,]+\.\d\d)/)[1].replace(/,/g,''));
const fullDB = Number(fullText.match(/\$([\d,]+\.\d\d)/)[1].replace(/,/g,''));
check('my share is smaller than full policy', mineDB < fullDB, `${mineDB} < ${fullDB}`);
await inv.screenshot({path:`${S}/i6-investor-full-toggle.png`,fullPage:true});
await inv.click('[data-share="mine"]'); await inv.waitForTimeout(600);

await inv.click('table.data tbody tr:first-child'); await inv.waitForSelector('.tabs');
await inv.waitForTimeout(700);
const invDetail = await inv.locator('.main').textContent();
check('investor sees "Your position" not the cap table', invDetail.includes('Your position'));
check('investor cannot see co-owners', !invDetail.includes('M. Okonkwo'));
check('no edit or delete buttons', (await inv.locator('#editBtn').count())===0 && (await inv.locator('#deletePolicyBtn').count())===0);
await inv.screenshot({path:`${S}/i7-investor-policy.png`,fullPage:true});

await inv.goto(`${BASE}/#/settings`); await inv.waitForSelector('#pwForm'); await inv.waitForTimeout(500);
const setTxt = await inv.locator('.main').textContent();
check('investor settings shows only password', setTxt.includes('Change your password') && !setTxt.includes('Owner entities') && !setTxt.includes('Activity log'));

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await br.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nALL INVESTOR UI CHECKS PASSED');
process.exit(fails.length?1:0);
