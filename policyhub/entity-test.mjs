import { chromium } from 'playwright';
import { BASE, ADMIN } from './test-config.mjs';
const fails=[]; const errs=[]; const check=(n,ok,x='')=>{console.log(`${ok?'  PASS':'  FAIL'}  ${n}${x?` — ${x}`:''}`); if(!ok)fails.push(n);};
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await b.newPage({viewport:{width:1500,height:1000}});
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>m.type()==='error'&&!/40[0139]/.test(m.text())&&errs.push(m.text()));
p.on('dialog',d=>d.accept());

await p.goto(BASE);
await p.fill('#email',ADMIN.email); await p.fill('#password',ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row',{timeout:10000});

console.log('\nENTITY LIST IN SETTINGS');
await p.goto(`${BASE}/#/settings`); await p.waitForSelector('#pwForm'); await p.waitForTimeout(800);
const card = p.locator('.card').filter({hasText:'Owner entities'});
check('entities card present', await card.count()===1);
const txt = await card.textContent();
check('shows policy counts and totals',
  txt.includes('LCG1') && /\$[\d,]+\.\d\d/.test(txt), txt.trim().slice(0, 80).replace(/\s+/g, ' '));

console.log('\nCREATE');
await p.click('#addEntityBtn'); await p.waitForSelector('dialog[open]');
await p.fill('dialog input[name="code"]','TESTCO');
await p.fill('dialog input[name="name"]','Test Holdings LLC');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(1300);
const afterAdd = await p.locator('.card').filter({hasText:'Owner entities'}).textContent();
check('new entity appears', afterAdd.includes('TESTCO') && afterAdd.includes('Test Holdings LLC'));

console.log('\nDELETE GUARD');
const lcg2Del = p.locator('[data-del-entity][data-code="LCG2"]');
check('delete disabled for an entity in use', await lcg2Del.isDisabled());
const testDel = p.locator('[data-del-entity][data-code="TESTCO"]');
check('delete enabled for an unused entity', await testDel.isEnabled());

console.log('\nASSIGN OWNER ON A POLICY');
await p.goto(`${BASE}/#/policies`); await p.waitForSelector('table.data tbody tr');
await p.click('table.data tbody tr:first-child'); await p.waitForSelector('.tabs');
await p.click('#editBtn'); await p.waitForSelector('dialog[open]');
const opts = await p.locator('#fundSelect option').allTextContents();
check('owner is a dropdown of entities', opts.some(o=>o.includes('TESTCO')), opts.length+' options');
check('dropdown offers inline creation', opts.some(o=>o.includes('Add a new entity')));
await p.selectOption('#fundSelect','TESTCO');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(1400);
const detail = await p.locator('.main').textContent();
check('policy now shows the new owner', detail.includes('TESTCO'));

console.log('\nINLINE CREATION FROM THE POLICY DIALOG');
await p.click('#editBtn'); await p.waitForSelector('dialog[open]');
await p.selectOption('#fundSelect','__new__');
await p.waitForTimeout(300);
check('new-entity fields revealed', await p.isVisible('dialog input[name="new_fund_code"]'));
await p.fill('dialog input[name="new_fund_code"]','INLINE1');
await p.fill('dialog input[name="new_fund_name"]','Created Inline LLC');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(1600);
const detail2 = await p.locator('.main').textContent();
check('inline-created entity is assigned', detail2.includes('INLINE1'));
const funds = await (await p.request.get(`${BASE}/api/funds`)).json();
check('inline entity persisted with its name',
  funds.some(f=>f.code==='INLINE1' && f.name==='Created Inline LLC'));

console.log('\nCLEARING THE OWNER');
await p.click('#editBtn'); await p.waitForSelector('dialog[open]');
await p.selectOption('#fundSelect','');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(1400);
const cleared = await (await p.request.get(`${BASE}/api/policies?search=`)).json();
const target = cleared.find(x=>x.policy_number);
check('owner can be cleared back to none',
  (await (await p.request.get(`${BASE}/api/funds`)).json()).find(f=>f.code==='INLINE1').policy_count===0);

// restore + clean up
await p.click('#editBtn'); await p.waitForSelector('dialog[open]');
await p.selectOption('#fundSelect','LCG2');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
for (const code of ['TESTCO','INLINE1']) {
  const f = (await (await p.request.get(`${BASE}/api/funds`)).json()).find(x=>x.code===code);
  if (f) await p.request.fetch(`${BASE}/api/funds/${f.id}`,{method:'DELETE'});
}

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await b.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nALL ENTITY CHECKS PASSED');
process.exit(fails.length?1:0);
