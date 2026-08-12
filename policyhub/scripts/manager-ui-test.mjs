import { chromium } from 'playwright';
const B='http://localhost:3400', S='/home/claude/shots';
const fails=[]; const errs=[];
const check=(n,ok,x='')=>{console.log(`${ok?'  PASS':'  FAIL'}  ${n}${x?` — ${x}`:''}`); if(!ok)fails.push(n);};
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
async function session(email,pass){
  const ctx=await br.newContext({viewport:{width:1500,height:1000}});
  const p=await ctx.newPage();
  p.on('pageerror',e=>errs.push(`${email}: ${e.message}`));
  p.on('console',m=>m.type()==='error'&&!/40[0134]/.test(m.text())&&errs.push(`${email}: ${m.text()}`));
  await p.goto(B); await p.fill('#email',email); await p.fill('#password',pass);
  await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row',{timeout:12000});
  return p;
}

console.log('MANAGER NAVIGATION');
const pm = await session('pm1@example.com','managerpass1');
const nav = await pm.$$eval('.nav a', a=>a.map(x=>x.textContent.trim()));
check('no Settings tab, only Account', !nav.includes('Settings') && nav.includes('Account'), nav.join('/'));
check('has the working sections',
  ['Dashboard','Policies','Servicing','Insureds','Investors','Reports','Import'].every(n=>nav.includes(n)), nav.join('/'));
const bar = await pm.locator('.topbar-right').textContent();
check('top bar shows their entity', bar.includes('LCG1'), bar.trim());
await pm.screenshot({path:`${S}/m1-manager-dashboard.png`,fullPage:true});

console.log('\nSCOPED DATA');
await pm.goto(`${B}/#/policies`); await pm.waitForSelector('table.data tbody tr'); await pm.waitForTimeout(500);
const rows = await pm.locator('table.data tbody tr').count();
check('sees only their entity\'s policies', rows === 5, `${rows} rows`);
const grid = await pm.locator('table.data').textContent();
check('no other entity appears in the grid', !grid.includes('LCG2'));
await pm.screenshot({path:`${S}/m2-manager-policies.png`,fullPage:true});

console.log('\nWRITE CONTROLS PRESENT');
check('New policy button present', (await pm.locator('#newPolicyBtn').count())===1);
await pm.click('table.data tbody tr:first-child'); await pm.waitForSelector('.tabs'); await pm.waitForTimeout(600);
check('Edit policy present', (await pm.locator('#editBtn').count())===1);
check('Delete policy present', (await pm.locator('#deletePolicyBtn').count())===1);
check('Add investor present', (await pm.locator('#addOwnerBtn').count())===1);
check('Add insured present', (await pm.locator('#addLifeBtn').count())===1);
await pm.screenshot({path:`${S}/m3-manager-policy.png`,fullPage:true});

// actually perform an edit
await pm.click('#editBtn'); await pm.waitForSelector('dialog[open]');
await pm.fill('dialog textarea[name="notes"]', 'Reviewed by portfolio manager');
await pm.click('dialog button[type=submit]'); await pm.waitForTimeout(1200);
check('manager edit persists', (await pm.locator('.main').textContent()).includes('Reviewed by portfolio manager'));

console.log('\nSETTINGS IS UNREACHABLE');
await pm.goto(`${B}/#/settings`); await pm.waitForTimeout(1200);
const settingsTxt = await pm.locator('#main').textContent();
check('account page has no admin panels',
  !settingsTxt.includes('Owner entities') && !settingsTxt.includes('Activity log') && !settingsTxt.includes('Add user'),
  settingsTxt.slice(0,90).replace(/\s+/g,' '));
check('account page still allows a password change', settingsTxt.includes('Change your password'));

console.log('\nIMPORT IS AVAILABLE');
await pm.goto(`${B}/#/import`); await pm.waitForSelector('#dropzone');
check('import screen reachable', await pm.isVisible('#dropzone'));

console.log('\nINVESTORS SCOPED');
await pm.goto(`${B}/#/investors`);
await pm.waitForFunction(()=>document.querySelector('h1')?.textContent==='Investors');
await pm.waitForTimeout(600);
const invRows = await pm.locator('table.data tbody tr').count();
check('investor directory is scoped', invRows >= 1 && invRows < 3, `${invRows} investors`);
await pm.screenshot({path:`${S}/m4-manager-investors.png`,fullPage:true});

console.log('\nADMIN STILL SEES EVERYTHING');
const admin = await session('t@x.com','testtesttest');
const anav = await admin.$$eval('.nav a', a=>a.map(x=>x.textContent.trim()));
check('admin keeps Settings', anav.includes('Settings'));
await admin.goto(`${B}/#/settings`); await admin.waitForSelector('#pwForm'); await admin.waitForTimeout(700);
const usersTbl = await admin.locator('.card').filter({hasText:'Users'}).textContent();
check('user list shows manager entities', usersTbl.includes('LCG1'), usersTbl.replace(/\s+/g,' ').slice(0,140));
await admin.screenshot({path:`${S}/m5-admin-users.png`,fullPage:true});

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await br.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nALL MANAGER UI CHECKS PASSED');
process.exit(fails.length?1:0);
