/* =====================================================================
   Opening an account, on screen.

   The API suite proves the invitation works. What is under test here is
   the thing that was actually asked for: that an administrator filling
   in this form is never made to invent a password for somebody else.

   So the first check is a negative one — there is no required password
   box — and the rest is that the escape hatch for somebody with no
   working mailbox is still there, behind a tick, saying plainly why it
   is the worse option.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'INVUI';
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

const wipe = async () => {
  for (const u of ((await json(await api('/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX.toLowerCase())))
    await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1500, height: 1150 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/settings`);
await p.waitForSelector('#addUserBtn', { timeout: 20000 });
await p.click('#addUserBtn');
await p.waitForSelector('dialog[open] input[name=email]', { timeout: 20000 });
const dlg = p.locator('dialog[open]');

console.log('THE FORM DOES NOT ASK FOR A PASSWORD');
check('there is no required password box',
  await dlg.locator('input[name=password][required]').count() === 0);
check('the password field is hidden until it is asked for',
  await dlg.locator('#pwSelf').isVisible() === false);
const text = (await dlg.innerText()).replace(/\s+/g, ' ');
check('and the form says what will happen instead',
  /emailed a link to choose their own password/i.test(text), text.slice(0, 160));
check('it says the link works once and how long it lasts',
  /works once/i.test(text) && /seven days/i.test(text));
check('and that nobody here ever knows it',
  /nobody here ever knows it/i.test(text));

console.log('\nBUT IT OFFERS THE ESCAPE HATCH, NAMED FOR WHAT IT IS');
check('there is a tick box for setting one by hand',
  await dlg.locator('#setPwSelf').count() === 1);
check('and it says when that is the right answer',
  /only if they have no working mailbox/i.test(text));
await dlg.locator('#setPwSelf').check();
await p.waitForTimeout(200);
check('ticking it reveals the field',
  await dlg.locator('#pwSelf').isVisible() === true);
check('with the warning about what you have taken on',
  /you both know it/i.test((await dlg.locator('#pwSelf').innerText())));
await dlg.locator('#setPwSelf').uncheck();
await p.waitForTimeout(200);
check('unticking hides it again',
  await dlg.locator('#pwSelf').isVisible() === false);

console.log('\nAND CREATING ONE SENDS THE INVITATION');
const email = `${PREFIX.toLowerCase()}-one@example.test`;
await dlg.locator('input[name=email]').fill(email);
await dlg.locator('input[name=full_name]').fill('Invited By Screen');
await dlg.locator('select[name=role]').selectOption('viewer');
await dlg.locator('button[type=submit]').click();
await p.waitForTimeout(2200);
check('the screen says where the invitation went',
  /invitation sent/i.test(await p.locator('body').innerText())
  || /invitation sent/i.test(await p.locator('.toast, #toast').innerText().catch(() => '')),
  (await p.locator('body').innerText()).match(/Invitation[^\n]*/)?.[0] || '');

const made = ((await json(await api('/users'))) || []).find((u) => u.email === email);
check('the account exists', !!made, made?.email);
/* The box was never filled in, so the account must have been invited
   rather than given a password by the browser sending an empty one. */
check('and it was invited, not given a blank password',
  made?.must_change_password === true, String(made?.must_change_password));

/* ------------------------------------------------------------------ *
 * And the row says so, with the button the dialog promised
 * ------------------------------------------------------------------ */
console.log('\nTHE ROW SHOWS AN INVITED ACCOUNT AS INVITED');
await p.goto(`${BASE}/#/settings`);
await p.waitForSelector('#addUserBtn', { timeout: 20000 });
await p.waitForTimeout(700);
/* Scoped to the Users card. The address also appears in the activity
   log further down the same page, and an unscoped row locator matches
   half a dozen of them. */
const usersCard = p.locator('.card:has(h2:text-is("Users"))');
const row = usersCard.locator(`tr:has-text("${email}")`);
check('the account is on the list', await row.count() === 1);
const rowText = (await row.innerText()).replace(/\s+/g, ' ');
check('marked Invited rather than Active — it has never been used',
  /Invited/.test(rowText) && !/\bActive\b/.test(rowText), rowText.slice(0, 120));
check('and never signed in', /never/i.test(rowText));
check('with a button to send another, as the dialog promised',
  await row.locator('[data-invite-user]').count() === 1,
  await row.locator('[data-invite-user]').innerText().catch(() => 'missing'));

/* Read off the toast itself rather than off the page. "Works once,
   lasts an hour" is also the hint under the reset button in the edit
   dialog, and a body-wide match would pass whether or not anything was
   sent. */
const toastText = p.locator('.toast');
await row.locator('[data-invite-user]').click();
await toastText.first().waitFor({ timeout: 10000 });
const said = await toastText.first().innerText();
check('pressing it says where it went and how long it lasts',
  /Sent to/i.test(said) && new RegExp(email, 'i').test(said) && /lasts/i.test(said),
  said);
await p.waitForTimeout(1500);
/* And a fresh invitation really is outstanding — a toast is not proof. */
const outstanding = ((await json(await api('/users'))) || [])
  .find((u) => u.email === email);
check('and a live invitation is outstanding afterwards',
  !!outstanding?.invite_expires_at, String(outstanding?.invite_expires_at));

/* An account that has been used is not offered an invitation — there is
   nothing to invite them to. */
const active = usersCard.locator(`tr:has-text("${ADMIN.email}")`).first();
check('an account already in use is offered no invitation',
  await active.locator('[data-invite-user]').count() === 0);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All invitation UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
