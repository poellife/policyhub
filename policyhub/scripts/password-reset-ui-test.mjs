/* =====================================================================
   Forgotten passwords, on screen.

   The API suite proves the rules. What is under test here is whether an
   investor who cannot get in can actually find the way out of that —
   which is the whole point of the feature and the part no server test
   can answer.

   Three things in particular:

     the way in is on the sign-in card, where somebody staring at a
       password box will look, not buried in a help page;
     a link that has gone stale says so ON ARRIVAL, before a password is
       chosen and typed twice;
     and the screen never says whether an address has an account, because
       the server never does either.

   Idempotent: the probe account uses a fixed prefix and is removed first
   and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, scratchPassword, login, databaseUrl } from './test-config.mjs';
import pg from 'pg';

const PREFIX = 'pwreset-ui';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const db = new pg.Pool({ connectionString: databaseUrl() });
const wipe = async () => {
  for (const u of ((await json(await api('/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX)))
    await api(`/users/${u.id}`, { method: 'DELETE' });
  await db.query('DELETE FROM email_outbox WHERE to_email LIKE $1', [`${PREFIX}%`]);
  await db.query("DELETE FROM login_attempts WHERE ident LIKE 'reset-%'");
};
await wipe();

const email = `${PREFIX}-1@test.local`;
const oldPassword = scratchPassword('ui-old');
const probe = await json(await api('/users', { method: 'POST',
  body: { email, password: oldPassword, full_name: 'Reset Probe', role: 'viewer' } }));

const tokenFor = async (addr) => {
  const { rows } = await db.query(
    `SELECT body_text FROM email_outbox WHERE to_email = $1 AND kind = 'password_reset'
      ORDER BY id DESC LIMIT 1`, [addr]);
  return /https?:\/\/\S+\/#\/reset\/(\S+)/.exec(rows[0]?.body_text || '')?.[1] || null;
};

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));

/* ------------------------------------------------------------------ *
 * Finding it
 * ------------------------------------------------------------------ */
console.log('IT IS WHERE SOMEBODY STUCK AT THE PASSWORD BOX WILL LOOK');
await p.goto(BASE);
await p.waitForSelector('#loginForm', { timeout: 20000 });
check('the sign-in card offers it', await p.locator('#forgotLink').count() === 1);
check('in words a person would use',
  /forgotten your password/i.test(await p.locator('#forgotLink').innerText()),
  (await p.locator('#forgotLink').innerText()).trim());

await p.click('#forgotLink');
await p.waitForSelector('#forgotForm', { timeout: 20000 });
check('and it opens without signing in first',
  await p.locator('#forgotEmail').count() === 1);
check('the screen says the link is short-lived and single use',
  /works once/i.test(await p.locator('.login-card').innerText())
  && /an hour/i.test(await p.locator('.login-card').innerText()));
check('and that a password is never emailed',
  /never sent by email/i.test(await p.locator('.login-card').innerText()));

/* ------------------------------------------------------------------ *
 * Asking
 * ------------------------------------------------------------------ */
console.log('\nASKING SAYS THE SAME THING WHOEVER YOU ARE');
await p.fill('#forgotEmail', `${PREFIX}-nobody@test.local`);
await p.click('#forgotForm button[type=submit]');
await p.waitForSelector('#forgotMsg .notice-box', { timeout: 20000 });
const blandMiss = (await p.locator('#forgotMsg').innerText()).replace(/\s+/g, ' ').trim();
check('an address with no account is not told so',
  /if there is an account/i.test(blandMiss)
  && !/no account|not found|does not exist/i.test(blandMiss), blandMiss.slice(0, 60));
check('and the form goes away, so a second press cannot retire the link '
  + 'the first one sent', await p.locator('#forgotForm').count() === 0);

/* Already on this hash, so `goto` would be a no-op — the browser treats
   an identical fragment as no navigation at all and the page never
   redraws. Reloaded rather than nudged. */
await p.reload();
await p.waitForSelector('#forgotForm', { timeout: 20000 });
await p.fill('#forgotEmail', email);
await p.click('#forgotForm button[type=submit]');
await p.waitForSelector('#forgotMsg .notice-box', { timeout: 20000 });
const blandHit = (await p.locator('#forgotMsg').innerText()).replace(/\s+/g, ' ').trim();
check('a real address gets word for word the same answer', blandHit === blandMiss);

const token = await tokenFor(email);
check('and a link is actually on its way', !!token);

/* ------------------------------------------------------------------ *
 * A link that has gone stale
 * ------------------------------------------------------------------ */
console.log('\nA DEAD LINK SAYS SO ON ARRIVAL, NOT AFTER TYPING');
await p.goto(`${BASE}/#/reset/${'z'.repeat(43)}`);
await p.waitForSelector('.login-card', { timeout: 20000 });
check('an unknown link draws no password form at all',
  await p.locator('#resetForm').count() === 0);
check('it says what went wrong',
  /did not work/i.test(await p.locator('.login-card').innerText()));
check('and offers the way to another one', await p.locator('#askAgain').count() === 1);
await p.click('#askAgain');
await p.waitForSelector('#forgotForm', { timeout: 20000 });
check('which lands back on the request form', await p.locator('#forgotEmail').count() === 1);

/* ------------------------------------------------------------------ *
 * Using it
 * ------------------------------------------------------------------ */
console.log('\nFOLLOWING THE LINK');
await p.goto(`${BASE}/#/reset/${token}`);
await p.waitForSelector('#resetForm', { timeout: 20000 });
check('a good link draws the form',
  await p.locator('#resetPw').count() === 1 && await p.locator('#resetPw2').count() === 1);
check('and says whose account it is, so somebody with three mailboxes need not guess',
  (await p.locator('.login-card').innerText()).includes(email));
check('it warns that other sessions will be signed out',
  /signs out anything else/i.test(await p.locator('.login-card').innerText()));

const newPassword = scratchPassword('ui-new');
await p.fill('#resetPw', newPassword);
await p.fill('#resetPw2', 'not-the-same-at-all');
await p.click('#resetForm button[type=submit]');
await p.waitForTimeout(500);
check('two that do not match are caught before anything is sent',
  /do not match/i.test(await p.locator('#resetMsg').innerText()));

await p.fill('#resetPw2', newPassword);
await p.click('#resetForm button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 25000 });
check('a matching pair sets it and signs them straight in — no second typing',
  /#\/dashboard/.test(p.url()), p.url());

/* And the old one really is gone. */
const oldTry = await fetch(`${BASE}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: oldPassword }) });
check('the password they had forgotten no longer works', oldTry.status === 401);

/* ------------------------------------------------------------------ *
 * The office sending one
 * ------------------------------------------------------------------ */
console.log('\nAND THE OFFICE CAN SEND ONE WITHOUT READING ANYTHING ALOUD');
const staff = await ctx.browser().newContext({ viewport: { width: 1400, height: 1050 } });
const s = await staff.newPage();
s.on('pageerror', (e) => errs.push(e.message));
await s.goto(BASE);
await s.fill('#email', ADMIN.email);
await s.fill('#password', ADMIN.password);
await s.click('button[type=submit]');
await s.waitForSelector('.kpi-row', { timeout: 20000 });
await s.goto(`${BASE}/#/settings`);
await s.waitForTimeout(1500);
const row = s.locator('tr', { hasText: email }).first();
await row.locator('button:has-text("Edit"), a:has-text("Edit")').first().click();
await s.waitForSelector('#sendResetBtn', { timeout: 20000 });
check('the user dialog offers to email a link',
  await s.locator('#sendResetBtn').count() === 1);
check('and says why that beats setting one by hand',
  /nothing is spoken aloud/i.test(await s.locator('#sendResetMsg').innerText()));
await s.click('#sendResetBtn');
await s.waitForTimeout(2000);
check('sending it says where it went',
  (await s.locator('#sendResetMsg').innerText()).includes(email),
  (await s.locator('#sendResetMsg').innerText()).replace(/\s+/g, ' ').slice(0, 90));
check('and a second link really was issued',
  (await tokenFor(email)) !== token);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
await db.end();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All password reset UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
