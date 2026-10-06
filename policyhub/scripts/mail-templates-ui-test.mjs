/* =====================================================================
   The wording screen.

   The API suite proves what is stored and what is sent. What is under
   test here is the one fear this screen exists to answer: that somebody
   edits a message and first sees what it looks like when an investor
   reads it. So the preview is filled in with specimen values, sits
   beside the box rather than behind a button, and moves as you type.

   And that the screen is an administrator's — these are the words the
   firm says to its investors in writing.

   Idempotent: the kind it touches is reverted first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const KIND = 'opportunity_shared';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const wipe = async () => { await api(`/mail-templates/${KIND}`, { method: 'DELETE' }); };
await wipe();

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1250 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
let answer = true;
p.on('dialog', (d) => (answer ? d.accept() : d.dismiss()));
const signIn = async (who) => {
  await ctx.clearCookies();
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });
};

await signIn(ADMIN);
await p.goto(`${BASE}/#/emails/${KIND}`);
await p.waitForSelector('#mailBody', { timeout: 20000 });
await p.waitForTimeout(700);

console.log('EVERY MESSAGE IS LISTED, AND ONE OF THEM IS OPEN');
check('the list names more than a dozen of them',
  await p.locator('.mail-row').count() >= 15, String(await p.locator('.mail-row').count()));
check('and the one asked for is the one open',
  (await p.locator('.page-head, .card-head').first().innerText()).length > 0
  && /A new opportunity/.test(await p.locator('#mailSubject').inputValue()),
  await p.locator('#mailSubject').inputValue());
check('the box holds the real wording, placeholders and all',
  /\{\{headline\}\}/.test(await p.locator('#mailBody').inputValue()),
  (await p.locator('#mailBody').inputValue()).slice(0, 80));
check('and the fields it has are offered as chips',
  await p.locator('.chip').count() >= 4, String(await p.locator('.chip').count()));

console.log('\nTHE PREVIEW IS FILLED IN, AND MOVES AS YOU TYPE');
const pv = () => p.locator('#pvBody').innerText();
check('a specimen is already in it rather than a row of braces',
  /Northbank Life/.test(await pv()) && !/\{\{/.test(await pv()),
  (await pv()).slice(0, 120));
await p.fill('#mailSubject', 'Poel Capital — a case for you: {{headline}}');
await p.fill('#mailBody',
  '{{name}},\n\nA case we think is worth your time: {{headline}}.\n\n'
  + 'At life expectancy it works out at {{rate}}.\n\nEverything is on your portal. {{link}}');
await p.waitForTimeout(400);
check('the subject follows what is typed',
  /Poel Capital — a case for you: Northbank Life/.test(await p.locator('#pvSubject').innerText()),
  await p.locator('#pvSubject').innerText());
check('and so does the body, with the figures put in',
  /works out at 14\.2%/.test(await pv()), (await pv()).slice(0, 180));
check('and the portal address where the link goes',
  (await pv()).includes(new URL(BASE).origin), (await pv()).slice(-90));

console.log('\nA FIELD CAN BE DROPPED IN WITHOUT TYPING BRACES');
await p.locator('#mailBody').click();
await p.keyboard.press('End');
await p.locator('.chip[data-field="closes"]').click();
await p.waitForTimeout(300);
check('the chip puts the field in the box',
  /\{\{closes\}\}/.test(await p.locator('#mailBody').inputValue()));
check('and the preview resolves it straight away',
  /31 October 2026/.test(await pv()), (await pv()).slice(-80));

console.log('\nSAVING MAKES IT THE OFFICE’S WORDING');
await p.click('#mailSave');
await p.waitForTimeout(2200);
const head = (await p.locator('.card').first().innerText()).replace(/\s+/g, ' ');
check('the screen says the wording is now yours', /your wording/i.test(head), head.slice(0, 200));
check('and offers to put the default back',
  await p.locator('#mailRevert').count() === 1);
const row = await p.locator('.mail-row.on').innerText();
check('and the list marks it so you can see which have been changed',
  /your wording/i.test(row), row.replace(/\s+/g, ' '));

console.log('\nAND REVERTING IS ONE BUTTON');
await p.click('#mailRevert');
await p.waitForTimeout(2200);
check('the application’s words are back in the box',
  /A new opportunity/.test(await p.locator('#mailSubject').inputValue()),
  await p.locator('#mailSubject').inputValue());
check('and nothing claims to be yours any more',
  await p.locator('#mailRevert').count() === 0);

console.log('\nIT IS AN ADMINISTRATOR’S SCREEN');
await signIn(MANAGER1);
await p.goto(`${BASE}/#/emails/${KIND}`);
await p.waitForTimeout(1500);
check('a manager gets no editor', await p.locator('#mailBody').count() === 0);
check('and is told plainly why',
  /administrator/i.test(await p.locator('.main, body').first().innerText()));

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All mail wording UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
