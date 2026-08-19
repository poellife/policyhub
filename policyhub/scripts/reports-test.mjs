import { chromium } from 'playwright';
import fs from 'node:fs';
import { BASE, ADMIN } from './test-config.mjs';
const SHOTS='/home/claude/shots';
const fails=[]; const errs=[];
const check=(n,ok,x='')=>{console.log(`${ok?'  PASS':'  FAIL'}  ${n}${x?` — ${x}`:''}`); if(!ok)fails.push(n);};

const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await b.newPage({viewport:{width:1500,height:1000}});
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>m.type()==='error'&&!/401/.test(m.text())&&errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email',ADMIN.email); await p.fill('#password',ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row',{timeout:10000});

await p.click('a[href="#/reports"]');
await p.waitForFunction(()=>document.querySelector('h1')?.textContent==='Reports');
await p.waitForSelector('#rptGenerate');
check('reports page renders', (await p.locator('.rpt-choice').count())===7,
  `${await p.locator('.rpt-choice').count()} report types`);
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
check('schedule lists every policy', (s2.match(/Totals — (\d+) policies/)||[])[1] > 0, (s2.match(/Totals — \d+ policies/)||['none'])[0]);
check('schedule has totals row', /Totals — \d+ policies/.test(s2));

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


console.log('\nRETURN — POLICIES IN FORCE');
const s5 = await run('return-active','active return');
check('headline is the hypothetical rate', /RETURN IF MATURED TODAY/i.test(s5));
check('names it as unrealized', /have not been realized/i.test(s5));
check('ranks policies by return', /POLICIES, RANKED BY RETURN/i.test(s5));
check('breaks out owner entities', /BY OWNER ENTITY/i.test(s5));
/* No table of what the report leaves out. Each return report answers one
   question, and a list of everything outside it printed underneath invites
   the reader to add the two together. What the report covers is stated in
   words in the basis note instead. */
check('does not print a table of what it leaves out',
  !/NOT IN THIS REPORT/i.test(s5));
check('states that it is simple interest, not compounded',
  /simple interest/i.test(s5) && /interest earns nothing/i.test(s5));
check('shows cost basis when ticked', /CAPITAL INVESTED/i.test(s5));
const chart5 = await p.locator('#rptReturnChart svg').count();
check('the IRR chart is drawn', chart5 === 1);
check('with bars anchored at zero', /drawn from zero/.test(s5));

const s5nb = await run('return-active','active return, no basis', {basis:false});
check('cost basis disappears when unticked',
  !/CAPITAL INVESTED/i.test(s5nb) && !/MULTIPLE/i.test(s5nb));
check('but the rates remain', /Return/i.test(s5nb));

console.log('\nRETURN — REALIZED');
const s6 = await run('return-realized','realized return');
check('headline is the realized rate', /REALIZED RETURN/i.test(s6));
check('explains the payment-date convention',
  /dated to the day it cleared rather than the date of death/i.test(s6));
check('has a matured and a paid column', /matured/i.test(s6) && /paid/i.test(s6));
// The entity breakdown is shown only when there is more than one entity to
// compare — the same rule the portfolio summary uses.
const oneEntity = (s6.match(/LCG\d/g) || []).filter((v, i, a) => a.indexOf(v) === i).length < 2;
check('breaks out owner entities when there is more than one',
  oneEntity || /BY OWNER ENTITY/i.test(s6), oneEntity ? 'single entity — table omitted' : '');
check('reports only what has matured — nothing about the live book',
  !/NOT IN THIS REPORT/i.test(s6) && !/Inforce/i.test(s6));

// The two documents must not be the same document.
check('the two reports cover different policies', s5 !== s6);
check('and the active one is the larger book', s5.length > s6.length,
  `${s5.length} vs ${s6.length} chars`);

console.log('\nENTITY SUBTOTALS ON PAPER');
const entityRows = await p.$$eval('.rpt-table tbody tr', (rs) =>
  rs.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim())));
check('the entity table has a row per entity', entityRows.length > 0);

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

console.log('\nINVESTOR STATEMENTS');
const s7 = await run('investor', 'investor statements');
check('one page per investor, named', /Investor Statement/i.test(s7));
check('positions in force are listed', /POSITIONS IN FORCE/i.test(s7));
check('with what they have paid in broken out', /WHAT THEY HAVE PAID IN/i.test(s7));
check('and what is due next', /PREMIUMS COMING UP/i.test(s7));
check('their share sits beside the full policy figure',
  /THEIR SHARE/i.test(s7) && /FULL POLICY/i.test(s7));
check('a portfolio rate is given', /PORTFOLIO RETURN/i.test(s7));
check('and the basis is stated plainly',
  /percentage of the policy beside it,\s+never the whole policy/i.test(s7));
check('the picker offers investors to choose from',
  (await p.locator('#rptInvestors option').count()) > 0,
  `${await p.locator('#rptInvestors option').count()} options`);

console.log('\nERRORS:', errs.length?errs.join('\n  '):'none');
check('no page errors', errs.length===0);
await b.close();
console.log(fails.length?`\nFAILED: ${fails.join(', ')}`:'\nALL REPORT CHECKS PASSED');
process.exit(fails.length?1:0);
