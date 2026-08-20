import { chromium } from 'playwright';
import { BASE, ADMIN } from './test-config.mjs';
const S='/home/claude/shots';
const errs=[]; const fails=[];
const check=(n,ok,x='')=>{console.log(`${ok?'  PASS':'  FAIL'}  ${n}${x?` — ${x}`:''}`); if(!ok)fails.push(n);};
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await br.newPage({viewport:{width:1400,height:950}});
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>m.type()==='error'&&!/401/.test(m.text())&&errs.push(m.text()));
await p.goto(BASE); await p.waitForSelector('#loginForm');
await p.fill('#email',ADMIN.email); await p.fill('#password',ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row',{timeout:10000});
await p.waitForTimeout(600);
check('empty dashboard renders', await p.isVisible('.kpi-row'));
await p.screenshot({path:`${S}/e1-empty-dashboard.png`,fullPage:true});
// Import is reached from Settings now rather than from the menu, so it is
// navigated to by hash like any other page rather than clicked in the nav.
for (const [route,label] of [['policies','Policies'],['servicing','Servicing calendar'],['insureds','Insureds'],['documents','Documents'],['settings','Settings'],['import','Import data']]) {
  await p.goto(`${BASE}/#/dashboard`); await p.waitForTimeout(200);
  await p.goto(`${BASE}/#/${route}`);
  await p.waitForFunction(t=>document.querySelector('h1')?.textContent===t,label,{timeout:8000});
  await p.waitForTimeout(400);
  check(`empty ${route} renders`, await p.isVisible('h1'));
}
await p.screenshot({path:`${S}/e2-empty-settings.png`,fullPage:true});
// create a policy by hand on an empty DB
await p.goto(`${BASE}/#/dashboard`); await p.waitForTimeout(200);
await p.goto(`${BASE}/#/policies`);
await p.waitForFunction(()=>document.querySelector('h1')?.textContent==='Policies');
await p.click('#newPolicyBtn'); await p.waitForSelector('dialog[open]');
await p.fill('dialog input[name="policy_number"]','TEST-001');
await p.fill('dialog input[name="carrier_name"]','Test Carrier');
await p.fill('dialog input[name="insured_last_name"]','Doe');
await p.fill('dialog input[name="insured_first_name"]','Jane');
await p.fill('dialog input[name="dob"]','1940-05-05');
await p.fill('dialog input[name="face_amount"]','1000000');
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1500);
// Assert the policy that was just created is on the grid, rather than that it
// is the only row: this suite is written for an empty database but is also run
// against the shared fixture book, where a fixed count means nothing.
const made = p.locator('table.data tbody tr', { hasText: 'TEST-001' });
check('manual policy creation works', (await made.count())===1,
  `${await made.count()} matching of ${await p.locator('table.data tbody tr').count()} rows`);
await p.screenshot({path:`${S}/e3-first-policy.png`,fullPage:true});
// Leave the book as it was found.
await p.evaluate(async () => {
  const list = await fetch('/api/policies?search=TEST-001').then((r) => r.json());
  for (const x of list.filter((y) => y.policy_number === 'TEST-001'))
    await fetch(`/api/policies/${x.id}`, { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'TEST-001' }) });
});

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await br.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nEMPTY-STATE CHECKS PASSED');
process.exit(fails.length?1:0);
