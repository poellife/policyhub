import { chromium } from 'playwright';
import fs from 'node:fs';
const SHOTS='/home/claude/shots';
const fails=[]; const errs=[];
const check=(n,ok,x='')=>{console.log(`${ok?'  PASS':'  FAIL'}  ${n}${x?` — ${x}`:''}`); if(!ok)fails.push(n);};

const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await b.newPage({viewport:{width:1500,height:1000}});
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>m.type()==='error'&&!/401/.test(m.text())&&errs.push(m.text()));

await p.goto('http://localhost:3000');
await p.fill('#email','JP@poelcapital.com'); await p.fill('#password','poelcapital2026');
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row',{timeout:10000});

await p.click('a[href="#/reports"]');
await p.waitForFunction(()=>document.querySelector('h1')?.textContent==='Reports');
await p.waitForSelector('#rptGenerate');
check('reports page renders', (await p.locator('.rpt-choice').count())===4);
await p.screenshot({path:`${SHOTS}/r0-reports-picker.png`,fullPage:true});

const run = async (type, label, opts={}) => {
  await p.click(`.rpt-choice:has(input[value="${type}"])`);
  if (opts.basis===false) await p.uncheck('#rptBasis'); else await p.check('#rptBasis');
  await p.click('#rptGenerate');
  await p.waitForSelector('.rpt-sheet',{timeout:20000});
  await p.waitForTimeout(900);
  const txt = await p.locator('.rpt-output').textContent();
  check(`${label} generated`, txt.includes('Poel Capital'), `${txt.length} chars`);
  await p.screenshot({path:`${SHOTS}/r-${type}.png`,fullPage:true});
  // real PDF through the print stylesheet
  await p.emulateMedia({media:'print'});
  await p.pdf({path:`/home/claude/shots/pdf-${type}.pdf`, printBackground:true,
               format:'Letter', landscape: type==='schedule',
               margin:{top:'0.55in',bottom:'0.55in',left:'0.55in',right:'0.55in'}});
  await p.emulateMedia({media:'screen'});
  return txt;
};

console.log('\nPORTFOLIO SUMMARY');
const s1 = await run('summary','portfolio summary');
check('summary shows benefit multiple', s1.includes('Benefit multiple'));
check('summary shows carrier breakdown', s1.includes('By carrier'));

console.log('\nCOST BASIS TOGGLE');
await p.uncheck('#rptBasis');
await p.click('#rptGenerate'); await p.waitForTimeout(1200);
const noBasis = await p.locator('.rpt-output').textContent();
check('cost basis hidden when unticked',
  !noBasis.includes('Capital invested') && !noBasis.includes('Benefit multiple'));
check('current values still shown', noBasis.includes('Cash surrender value'));

console.log('\nPOLICY SCHEDULE');
const s2 = await run('schedule','policy schedule');
check('schedule lists every policy', (s2.match(/MassMutual|John Hancock|Genworth/g)||[]).length>=3);
check('schedule has totals row', s2.includes('Totals — 12 policies'));

console.log('\nPREMIUM FORECAST');
const s3 = await run('forecast','premium forecast');
check('forecast shows 12-month requirement', s3.includes('Next 12 months'));
check('forecast states its basis', s3.includes('Basis of projection'));

console.log('\nFACT SHEETS');
await p.click('.rpt-choice:has(input[value="factsheet"])');
await p.waitForTimeout(300);
await p.selectOption('#rptPolicies', [{index:0},{index:1}]);
await p.check('#rptBasis');
await p.click('#rptGenerate');
await p.waitForSelector('.rpt-sheet',{timeout:20000});
await p.waitForTimeout(1200);
const sheets = await p.locator('.rpt-sheet').count();
check('one sheet per selected policy', sheets===2, `${sheets} sheets`);
const s4 = await p.locator('.rpt-output').textContent();
check('fact sheet lists lives insured', s4.includes('Lives insured'));
check('fact sheet shows policy terms', s4.includes('Policy terms'));
await p.screenshot({path:`${SHOTS}/r-factsheet.png`,fullPage:true});
await p.emulateMedia({media:'print'});
await p.pdf({path:'/home/claude/shots/pdf-factsheet.pdf', printBackground:true, format:'Letter',
             margin:{top:'0.55in',bottom:'0.55in',left:'0.55in',right:'0.55in'}});
await p.emulateMedia({media:'screen'});

console.log('\nPRINT LAYOUT');
await p.emulateMedia({media:'print'});
const hidden = await p.evaluate(()=>{
  const vis = el => el && getComputedStyle(el).display !== 'none';
  return { topbar: vis(document.querySelector('.topbar')),
           controls: vis(document.querySelector('.no-print')),
           sheet: vis(document.querySelector('.rpt-sheet')) };
});
check('app chrome hidden in print', !hidden.topbar && !hidden.controls);
check('report body visible in print', hidden.sheet);
await p.emulateMedia({media:'screen'});

for (const f of fs.readdirSync(SHOTS).filter(f=>f.startsWith('pdf-'))) {
  const kb = Math.round(fs.statSync(`${SHOTS}/${f}`).size/1024);
  console.log(`  ${f}: ${kb} KB`);
  if (kb < 5) fails.push(`${f} suspiciously small`);
}

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await b.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nALL REPORT CHECKS PASSED');
process.exit(fails.length?1:0);
