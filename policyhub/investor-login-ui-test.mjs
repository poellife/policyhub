/* =====================================================================
   Setting an investor up, on one screen.

   The point of the change is that the person opening the account can
   finish the job: record and login together, the way a self-registration
   arrives. What is worth checking on screen is that it does not get in
   the way of the ordinary case — most new investors are added without a
   login, and that form should not be a wall of password boxes — and that
   the investor's first sign-in lands somewhere that explains itself.

   Idempotent: its own investor and login, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'INVUI';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, { ...o,
  body: o.body && JSON.stringify(o.body),
  headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const EMAIL = `${PREFIX.toLowerCase()}@test.local`;
const wipe = async () => {
  for (const u of ((await json(await api('/users'))) || []))
    if (u.email === EMAIL) await api(`/users/${u.id}`, { method: 'DELETE' });
  for (const i of ((await json(await api('/investors'))) || []))
    if (String(i.name).startsWith(PREFIX)) await api(`/investors/${i.id}`, { method: 'DELETE' });
};
await wipe();

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (who) => {
  const p = await (await br.newContext({ viewport: { width: 1500, height: 1050 } })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/40[0139]|429/.test(m.text()) && errs.push(m.text()));
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row', { timeout: 20000 });
  return p;
};
const p = await open(ADMIN);
await p.goto(`${BASE}/#/investors`);
await p.waitForSelector('#newInvestorBtn');
await p.waitForTimeout(700);
await p.click('#newInvestorBtn');
await p.waitForSelector('dialog input[name=name]');

console.log('THE FORM DOES NOT LEAD WITH PASSWORDS');
check('a login is offered but not assumed',
  (await p.locator('#wantLogin').count()) === 1
  && !(await p.isChecked('#wantLogin')));
check('and the boxes for it are out of the way until asked for',
  await p.locator('#loginFields').isHidden());

console.log('\nASKING FOR ONE');
await p.fill('dialog input[name=name]', `${PREFIX} Hartley Trust`);
await p.fill('dialog input[name=email]', EMAIL);
await p.check('#wantLogin');
await p.waitForTimeout(300);
check('the fields appear', await p.locator('#loginFields').isVisible());
check('the sign-in address starts from the one already typed',
  (await p.inputValue('dialog input[name=login_email]')) === EMAIL,
  await p.inputValue('dialog input[name=login_email]'));
await p.click('#suggestPw');
const pw = await p.inputValue('dialog input[name=login_password]');
check('a password can be suggested rather than invented', pw.length >= 10, pw);
check('it is readable — it has to be read out to somebody',
  (await p.getAttribute('dialog input[name=login_password]', 'type')) === 'text');
check('and they are made to change it by default',
  await p.isChecked('dialog input[name=must_change_password]'));
await p.screenshot({ path: `${S}/new-investor-login.png` });

await p.click('dialog button[type=submit]');
await p.waitForTimeout(2000);
check('the investor is created and on the list',
  (await p.locator('.main').textContent()).includes(`${PREFIX} Hartley Trust`));
const created = ((await json(await api(`/investors?search=${PREFIX}`))) || [])[0];
check('with the login on the record', created?.login_email === EMAIL, created?.login_email);

console.log('\nOPENING THE FORM AGAIN OFFERS NO SECOND LOGIN');
await p.reload();
await p.waitForSelector('table.data tbody tr');
await p.waitForTimeout(900);
await p.click(`[data-edit-investor="${created.id}"]`);
await p.waitForSelector('dialog input[name=name]');
check('it says how they sign in',
  (await p.locator('dialog').textContent()).includes(EMAIL));
check('and does not offer to open another', (await p.locator('#wantLogin').count()) === 0);
await p.click('dialog #dlgCancel');

console.log('\nTHE INVESTOR’S FIRST SIGN-IN');
const them = await (await br.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
them.on('pageerror', (e) => errs.push(e.message));
await them.goto(BASE);
await them.fill('#email', EMAIL);
await them.fill('#password', pw);
await them.click('button[type=submit]');
await them.waitForSelector('#firstPwForm', { timeout: 20000 });
const words = (await them.locator('.login-card').textContent()).replace(/\s+/g, ' ');
/* The heading is broken across two lines, so its text runs together when it
   is read back — match on the words rather than on the spacing. */
check('they are asked for a password of their own',
  /Choose\s*your password/i.test(words), words.slice(0, 60));
check('and told why', /somebody\s+else knows it/i.test(words), words.slice(0, 150));
check('the portal itself is not open behind it',
  (await them.locator('.nav a').count()) === 0);
await them.screenshot({ path: `${S}/first-password.png` });

await them.fill('#curPw', pw);
await them.fill('#newPw', 'a-password-of-my-own');
await them.click('#firstPwForm button');
await them.waitForSelector('.kpi-row', { timeout: 20000 });
check('setting one opens the portal',
  /portfolio/i.test(await them.locator('h1').first().textContent()));
check('and the menu is there', (await them.locator('.nav a').count()) > 3);

await them.reload();
await them.waitForSelector('.kpi-row', { timeout: 20000 });
check('it does not ask again on the next visit',
  (await them.locator('#firstPwForm').count()) === 0);

console.log('\nA MANAGER CAN DO THE SAME');
const mgr = await open(MANAGER1);
await mgr.goto(`${BASE}/#/investors`);
await mgr.waitForSelector('#newInvestorBtn');
await mgr.waitForTimeout(700);
await mgr.click('#newInvestorBtn');
await mgr.waitForSelector('dialog input[name=name]');
check('the login section is offered to them too',
  (await mgr.locator('#wantLogin').count()) === 1);
await mgr.click('dialog #dlgCancel');

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL INVESTOR SETUP SCREEN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
