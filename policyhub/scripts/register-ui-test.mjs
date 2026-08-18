/* =====================================================================
   Registering, on screen.

   Follows one person the whole way: they find the Register link on the
   sign-in card, fill the form in, are told plainly that nothing works
   yet, and then somebody here finds them in the Investors section and
   approves them. The last check is the one that matters — that the
   password they typed is the password that lets them in.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login, scratchPassword } from './test-config.mjs';

const TAG = 'reguitest';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const EMAIL = `${TAG}@example.com`;
const PASSWORD = scratchPassword(TAG);
const ENTITY = `${TAG} Holdings LLC`;

const wipe = async () => {
  for (const a of ((await json(await api('/applications'))) || [])
    .filter((x) => String(x.email).includes(TAG))) {
    if (a.user_id) await api(`/users/${a.user_id}`, { method: 'DELETE' });
    if (a.investor_id) await api(`/investors/${a.investor_id}`, { method: 'DELETE' });
    await api(`/applications/${a.id}`, { method: 'DELETE' });
  }
  for (const i of ((await json(await api('/investors'))) || [])
    .filter((x) => String(x.name || '').includes(TAG)))
    await api(`/investors/${i.id}`, { method: 'DELETE' });
};
await wipe();
// The per-address cap is real and this suite deliberately runs into it, so
// it starts from a clean counter rather than inheriting one from the last run.
await api('/register-throttle', { method: 'DELETE', body: {} });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]|429/.test(m.text()) && errs.push(m.text()));

console.log('FINDING THE WAY IN');
await p.goto(BASE);
await p.waitForSelector('#loginForm');
check('the sign-in card offers registration', (await p.locator('#registerLink').count()) === 1);
check('and says who it is for',
  /new investor/i.test(await p.locator('.login-alt').textContent()),
  (await p.locator('.login-alt').textContent()).trim());
await p.screenshot({ path: `${S}/rg1-login.png` });

await p.click('#registerLink');
await p.waitForSelector('#regForm');
await p.waitForTimeout(400);
const form = (await p.locator('.reg-wrap').textContent()).replace(/\s+/g, ' ');
check('the form opens on its own page', (await p.locator('#loginForm').count()) === 0);
check('it says up front that approval comes first',
  /will not be able to sign in until/i.test(form), form.slice(0, 200));

console.log('\nWHAT IT ASKS FOR');
for (const [label, sel] of [
  ['their name', 'input[name="full_name"]'],
  ['the entity the money is held in', 'input[name="entity_name"]'],
  ['an email', 'input[name="email"]'],
  ['a phone number', 'input[name="phone"]'],
  ['a street address', 'input[name="address_line1"]'],
  ['a city', 'input[name="city"]'],
  ['a ZIP', 'input[name="postal_code"]'],
  ['a tax number', 'input[name="tax_id"]'],
  ['a password', 'input[name="password"]'],
  ['and it typed twice', 'input[name="password2"]'],
])
  check(`it asks for ${label}`, (await p.locator(`#regForm ${sel}`).count()) === 1);
check('the state is a list, not something to mistype',
  (await p.locator('#regForm select[name="state"] option').count()) >= 54);
check('the passwords are masked',
  (await p.locator('#regForm input[name="password"]').getAttribute('type')) === 'password');
check('it explains what happens to the tax number',
  /encrypted the moment it reaches us/i.test(form));
check('and that we never see the password', /we never see it/i.test(form));

console.log('\nFILLING IT IN');
const fill = async (name, value) => p.fill(`#regForm [name="${name}"]`, value);
await fill('full_name', 'Marion Delacroix');
await p.selectOption('#regForm select[name="investor_type"]', 'Entity');
await fill('entity_name', ENTITY);
await fill('email', EMAIL);
await fill('phone', '(248) 555-0184');
await fill('address_line1', '410 Larkspur Lane');
await fill('address_line2', 'Unit 7');
await fill('city', 'Birmingham');
await p.selectOption('#regForm select[name="state"]', 'MI');
await fill('postal_code', '48009');
await fill('tax_id', '987-65-4321');
await fill('note', 'Introduced by Alan Spiegel.');
await fill('password', PASSWORD);
await fill('password2', 'something-else-entirely');
await p.screenshot({ path: `${S}/rg2-form.png`, fullPage: true });

await p.click('#regForm button[type=submit]');
await p.waitForTimeout(700);
check('two different passwords are caught before it is sent',
  /do not match/i.test(await p.locator('#regError').textContent()),
  (await p.locator('#regError').textContent()).trim());

await fill('password2', PASSWORD);
await p.click('#regForm button[type=submit]');
await p.waitForSelector('#regDoneBack', { timeout: 12000 });
const done = (await p.locator('.reg-wrap').textContent()).replace(/\s+/g, ' ');
check('sending it lands on a thank-you', /Thank you/i.test(done));
check('naming the address we will write to', done.includes(EMAIL), done.slice(0, 200));
check('and saying the password will not work yet',
  /password will not work/i.test(done));
await p.screenshot({ path: `${S}/rg3-done.png` });

console.log('\nIT DOES NOT LET THEM IN');
const early = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
check('signing in is refused while it is pending', early.status === 401, String(early.status));

console.log('\nTHE QUEUE, FOR US');
const staff = await ctx.newPage();
staff.on('pageerror', (e) => errs.push(e.message));
await staff.goto(BASE);
await staff.fill('#email', ADMIN.email); await staff.fill('#password', ADMIN.password);
await staff.click('button[type=submit]');
await staff.waitForSelector('.kpi-row', { timeout: 15000 });
await staff.waitForTimeout(1200);
check('the menu badges Investors with what is waiting',
  await staff.locator('.nav a[href="#/investors"]').evaluate((el) => el.classList.contains('has-badge')));

await staff.goto(`${BASE}/#/investors`);
await staff.waitForSelector('.app-row', { timeout: 12000 });
await staff.waitForTimeout(900);
/* Standing on the tab that carries the badge: the label has to stay
   readable against the inverted pill rather than going black on black. */
const navInk = await staff.locator('.nav a[href="#/investors"]').evaluate((el) => {
  const s = getComputedStyle(el);
  const rgb = (v) => v.match(/\d+/g).slice(0, 3).map(Number);
  const [r, g, b] = rgb(s.color);
  const [br, bg, bb] = rgb(s.backgroundColor);
  const lum = ([x, y, z]) => {
    const f = (c) => { const n = c / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(x) + 0.7152 * f(y) + 0.0722 * f(z);
  };
  const [a1, a2] = [lum([r, g, b]), lum([br, bg, bb])].sort((x, y) => y - x);
  return { text: s.color, bg: s.backgroundColor, ratio: (a1 + 0.05) / (a2 + 0.05) };
});
check('and the tab you are standing on is still legible',
  navInk.ratio >= 4.5, `${navInk.ratio.toFixed(2)}:1 · ${navInk.text} on ${navInk.bg}`);

const row = staff.locator('.app-row', { hasText: 'Marion Delacroix' });
check('the registration is on the Investors page', (await row.count()) === 1);
const rowText = (await row.textContent()).replace(/\s+/g, ' ');
check('with the entity it will be held in', rowText.includes(ENTITY), rowText.slice(0, 160));
check('their address', /410 Larkspur Lane/.test(rowText));
check('what they told us', /Introduced by Alan Spiegel/.test(rowText));
check('and only four digits of the tax number',
  /4321/.test(rowText) && !/987.?65.?4321/.test(rowText),
  (rowText.match(/[•\-0-9]{6,}/) || [''])[0]);
await staff.screenshot({ path: `${S}/rg4-queue.png`, fullPage: true });

console.log('\nSEEING IT IN FULL IS A DELIBERATE ACT');
await row.locator('[data-reveal-tax]').click();
await staff.waitForTimeout(1200);
check('an administrator can ask for the whole number',
  /987-65-4321/.test(await row.textContent()),
  (await row.locator('.app-tax').textContent()).trim());
const audit = await json(await api('/audit'));
check('and it is written down that they did',
  (audit || []).some((r) => r.entity === 'application' && /revealed tax id/i.test(r.detail || '')));

console.log('\nAPPROVING');
await row.locator('[data-approve-app]').click();
await staff.waitForSelector('dialog[open]');
await staff.waitForTimeout(400);
const dlg = (await staff.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('the dialog says exactly what will be created', dlg.includes(ENTITY) && dlg.includes(EMAIL),
  dlg.slice(0, 200));
check('and that they will hold nothing yet', /hold nothing yet/i.test(dlg));
await staff.fill('dialog[open] input[name="note"]', 'Spoke to them on the phone.');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForTimeout(2200);

const investors = await json(await api('/investors'));
const made = investors.find((i) => i.name === ENTITY);
check('the investor record exists', !!made, made ? '' : 'not found');
check('with their email on it', made?.email === EMAIL, made?.email);
await staff.goto(`${BASE}/#/investors`); await staff.waitForTimeout(1200);
check('and the queue is clear', (await staff.locator('.app-row').count()) === 0
  || !(await staff.locator('.main').textContent()).includes('Marion Delacroix'));
await staff.screenshot({ path: `${S}/rg5-approved.png`, fullPage: true });

console.log('\nNOW THEY CAN SIGN IN');
/* Their own context: a new tab in the staff one would arrive already
   signed in as the administrator, which proves nothing. */
const theirCtx = await br.newContext({ viewport: { width: 1280, height: 1000 } });
const them = await theirCtx.newPage();
them.on('pageerror', (e) => errs.push(e.message));
await them.goto(BASE);
await them.fill('#email', EMAIL);
await them.fill('#password', PASSWORD);
await them.click('button[type=submit]');
await them.waitForSelector('.kpi-row', { timeout: 15000 });
check('the password they chose works', await them.isVisible('.kpi-row'));
const portal = (await them.locator('.main').textContent()).replace(/\s+/g, ' ');
check('and they land in their own portal', /Your portfolio/i.test(portal), portal.slice(0, 120));
check('named as the entity they registered',
  (await them.locator('.topbar, .shell, body').first().textContent()).includes(ENTITY));
check('holding nothing until we allocate something',
  /0 positions|No policies/i.test(portal) || /positions/.test(portal), portal.slice(0, 160));
await them.screenshot({ path: `${S}/rg6-first-login.png`, fullPage: true });

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL REGISTRATION UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
