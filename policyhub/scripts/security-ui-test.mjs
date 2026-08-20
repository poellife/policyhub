/* =====================================================================
   The three controls, on screen.

   The server decides all of this; what is checked here is that the person
   is actually told. A control nobody sees is a log entry, not a control:

     - the notice about a sign-in from somewhere new has to be in front of
       them, above the work, and say what to do about it;
     - it has to stay until they say they have seen it, and then go for
       good rather than reappearing on the next page;
     - the export button has to be absent for everybody who may not export,
       and the pages themselves must otherwise be unchanged.

   Idempotent: its own scratch account, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login, scratchPassword } from './test-config.mjs';

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

const EMAIL = 'security-ui@test.local';
const wipe = async () => {
  for (const u of ((await json(await api('/users'))) || []))
    if (u.email === EMAIL) await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();
const pw = scratchPassword('secui');
const probe = await json(await api('/users', { method: 'POST', body: {
  email: EMAIL, password: pw, full_name: 'Security Screen', role: 'admin' } }));

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604.1';

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (who, ua) => {
  const ctx = await br.newContext({ viewport: { width: 1500, height: 1000 }, userAgent: ua });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/40[0139]|429/.test(m.text()) && errs.push(m.text()));
  await p.goto(BASE);
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row', { timeout: 20000 });
  await p.waitForTimeout(900);
  return p;
};
const me = { email: EMAIL, password: pw };

console.log('THE FIRST SIGN-IN IS NOT AN ALARM');
const first = await open(me, MAC);
check('nothing across the top', (await first.locator('.security-bar').count()) === 0);

console.log('\nA SIGN-IN FROM SOMEWHERE NEW IS');
const p = await open(me, PHONE);
check('a notice is in front of them', (await p.locator('.security-bar').count()) === 1);
const words = (await p.locator('.security-bar').textContent()).replace(/\s+/g, ' ');
check('it says what happened in plain words',
  /New sign-in from a place this account has not been used before/.test(words));
check('names the browser and the network', /Safari on iOS · 127\.0\.0\.x/.test(words), words.slice(0, 120));
check('and says what to do about it', /change your password/i.test(words));
check('it also says where they are now, so they can compare',
  /You are on Safari on iOS/.test(words));
check('it sits above the work, not inside it',
  await p.evaluate(() => {
    const bar = document.querySelector('.security-bar').getBoundingClientRect();
    const main = document.querySelector('#main').getBoundingClientRect();
    return bar.bottom <= main.top + 1;
  }));
await p.screenshot({ path: `${S}/security-banner.png` });

console.log('\nAND IT LEADS SOMEWHERE');
await p.click('#secPassword');
await p.waitForTimeout(1200);
check('the change-password button opens the form', (await p.locator('#pwForm').count()) === 1,
  p.url());

console.log('\nIT STAYS UNTIL IT IS ACKNOWLEDGED');
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr');
await p.waitForTimeout(900);
check('still there after moving around', (await p.locator('.security-bar').count()) === 1);
await p.click('#secSeen');
await p.waitForTimeout(800);
check('gone once acknowledged', (await p.locator('.security-bar').count()) === 0);
await p.reload();
await p.waitForSelector('table.data tbody tr');
await p.waitForTimeout(1100);
check('and it stays gone', (await p.locator('.security-bar').count()) === 0);

console.log('\nEXPORTING IS AN ADMINISTRATOR’S BUTTON');
const seen = async (page, route, sel) => {
  await page.goto(`${BASE}/#/${route}`);
  await page.waitForSelector('h1', { timeout: 15000 });
  await page.waitForTimeout(1200);
  return page.locator(sel).count();
};
check('an admin has it on the policies grid', (await seen(p, 'policies', '#exportBtn')) === 1);
check('and on insureds', (await seen(p, 'insureds', '#exportInsuredsBtn')) === 1);
check('and on the maturities register', (await seen(p, 'maturities', '#exportMaturitiesBtn')) === 1);

const mgr = await open(MANAGER1, MAC);
check('a manager has none of them',
  (await seen(mgr, 'policies', '#exportBtn')) === 0
  && (await seen(mgr, 'insureds', '#exportInsuredsBtn')) === 0
  && (await seen(mgr, 'maturities', '#exportMaturitiesBtn')) === 0);
check('but the grid itself is unchanged for them',
  (await mgr.locator('table.data thead th').count()) > 5);
const inv = await open(INVESTOR1, MAC);
check('nor has an investor', (await seen(inv, 'policies', '#exportBtn')) === 0);
check('though their policies are all still there',
  (await inv.locator('table.data tbody tr').count()) > 0);

console.log('\nAND PRESSING IT IS RECORDED');
const before = ((await json(await api('/audit'))) || [])
  .filter((r) => /exported/.test(r.detail || '')).length;
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr');
await p.waitForTimeout(600);
await p.click('#exportBtn');
await p.waitForTimeout(1400);
const after = ((await json(await api('/audit'))) || [])
  .filter((r) => /exported/.test(r.detail || '')).length;
check('the audit trail gained an entry', after === before + 1, `${before} → ${after}`);

console.log('\nWHAT SETTINGS SHOWS');
await p.goto(`${BASE}/#/settings`);
await p.waitForSelector('h1');
await p.waitForTimeout(1500);
const cards = await p.$$eval('.card h2', (h) => h.map((x) => x.textContent.trim()));
check('everybody gets a list of where they have signed in',
  cards.some((c) => /where you have signed in/i.test(c)), cards.join(' · '));
check('an admin also gets the firm’s security notices',
  cards.some((c) => /security notices/i.test(c)));
const places = await p.$$eval('.card:has(h2:text-is("Where you have signed in")) tbody tr td',
  (td) => td.map((x) => x.textContent.trim()));
check('with both browsers this account has used',
  places.join(' ').includes('Safari on iOS') && places.join(' ').includes('Chrome on macOS'),
  places.slice(0, 4).join(' · '));
await p.screenshot({ path: `${S}/security-settings.png`, fullPage: true });

const invSettings = await open(INVESTOR1, PHONE);
await invSettings.goto(`${BASE}/#/settings`);
await invSettings.waitForSelector('h1');
await invSettings.waitForTimeout(1400);
const invCards = await invSettings.$$eval('.card h2', (h) => h.map((x) => x.textContent.trim()));
check('an investor sees their own sign-ins',
  invCards.some((c) => /where you have signed in/i.test(c)), invCards.join(' · '));
check('but not the firm’s notices',
  !invCards.some((c) => /security notices/i.test(c)));

check('no page errors anywhere', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL SECURITY SCREEN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
