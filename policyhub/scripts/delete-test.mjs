import { chromium } from 'playwright';
import { BASE, ADMIN } from './test-config.mjs';
const fails=[]; const errs=[];
const check=(n,ok,x='')=>{console.log(`${ok?'  PASS':'  FAIL'}  ${n}${x?` — ${x}`:''}`); if(!ok)fails.push(n);};

const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await b.newPage({viewport:{width:1500,height:1000}});
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>m.type()==='error'&&!/401|400 \(Bad/.test(m.text())&&errs.push(m.text()));
p.on('dialog',d=>d.accept());

await p.goto(BASE);
await p.fill('#email',ADMIN.email); await p.fill('#password',ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row',{timeout:10000});

// Create a throwaway policy so the test is repeatable and destroys nothing real.
await p.goto(`${BASE}/#/policies`); await p.waitForSelector('#newPolicyBtn');
await p.click('#newPolicyBtn'); await p.waitForSelector('dialog[open]');
await p.fill('dialog input[name="policy_number"]','DEL-TEST-1');
await p.fill('dialog input[name="carrier_name"]','Test Carrier Co');
await p.fill('dialog input[name="insured_last_name"]','Deleteme');
await p.fill('dialog input[name="insured_first_name"]','Temp');
await p.fill('dialog input[name="face_amount"]','1000000');
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1200);

await p.fill('#searchInput','DEL-TEST-1'); await p.waitForTimeout(700);
const found = await p.locator('table.data tbody tr').count();
check('throwaway policy created', found===1, `${found} row`);
await p.click('table.data tbody tr:first-child');
await p.waitForSelector('.tabs');

// add a snapshot + a transaction so cascade counts are non-zero
await p.click('.tabs button[data-tab="values"]'); await p.waitForTimeout(500);
await p.click('#addValueBtn'); await p.waitForSelector('dialog[open]');
await p.fill('dialog input[name="as_of_date"]','2026-08-01');
await p.fill('dialog input[name="account_value"]','5000');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(900);
await p.click('.tabs button[data-tab="transactions"]'); await p.waitForTimeout(500);
await p.click('#addTxnBtn'); await p.waitForSelector('dialog[open]');
await p.fill('dialog input[name="amount"]','1234');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(900);

console.log('\nDELETE DIALOG');
check('delete button visible to admin', await p.isVisible('#deletePolicyBtn'));
await p.click('#deletePolicyBtn'); await p.waitForSelector('dialog[open]');
const dlg = await p.locator('dialog').textContent();
check('dialog states what will be destroyed', dlg.includes('Value snapshots') && dlg.includes('Ledger entries'));
check('dialog offers the archive alternative', dlg.includes('Sold, Matured or Lapsed'));

console.log('\nWRONG CONFIRMATION');
await p.fill('dialog input[name="confirm"]','wrong-text');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(700);
check('wrong confirmation is rejected', await p.isVisible('dialog .error-box'));
const stillThere = await p.request.get(`${BASE}/api/policies?search=DEL-TEST-1`);
check('policy survives a failed confirmation', (await stillThere.json()).length===1);

console.log('\nSERVER-SIDE GUARD');
const bad = await p.request.fetch(`${BASE}/api/policies/${(await stillThere.json())[0].id}`,
  {method:'DELETE', data:{confirm:'nope'}});
check('API rejects a mismatched confirmation', bad.status()===400, `status ${bad.status()}`);
const noBody = await p.request.fetch(`${BASE}/api/policies/${(await stillThere.json())[0].id}`, {method:'DELETE'});
check('API rejects a missing confirmation', noBody.status()===400, `status ${noBody.status()}`);

console.log('\nCORRECT CONFIRMATION');
await p.fill('dialog input[name="confirm"]','DEL-TEST-1');
await p.click('dialog button[type=submit]');
await p.waitForTimeout(1600);
const after = await p.request.get(`${BASE}/api/policies?search=DEL-TEST-1`);
check('policy is gone', (await after.json()).length===0);
check('redirected to the policy list', p.url().includes('#/policies'));

console.log('\nAUDIT TRAIL');
await p.goto(`${BASE}/#/settings`); await p.waitForSelector('#pwForm'); await p.waitForTimeout(800);
const audit = await p.locator('.card').filter({hasText:'Activity log'}).textContent();
check('deletion recorded in activity log', audit.includes('DEL-TEST-1') && audit.includes('delete'));
check('audit captures cascade counts', /value snapshots/.test(audit) && /transactions/.test(audit));

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await b.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nALL DELETE CHECKS PASSED');
process.exit(fails.length?1:0);
