/* =====================================================================
   The user-administration interface: the Users card, the edit dialog,
   and the suspend / reactivate / delete buttons.

   The API suite already proves the rules hold. This one proves the
   screen actually reaches them — that the entity multi-select arrives
   pre-selected with what the manager currently holds, that deselecting
   one and saving takes it away, and that a suspended row reads as such.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, scratchPassword } from './test-config.mjs';
const S = '/home/claude/shots';
const TEMP = 'ui-temp-user@example.com';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
p.on('dialog', (d) => d.accept());          // confirm() prompts

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });

const usersCard = () => p.locator('.card', { has: p.locator('h2', { hasText: 'Users' }) });
const rowFor = (email) => usersCard().locator('tbody tr', { hasText: email });
const gotoSettings = async () => {
  await p.goto(`${BASE}/#/settings`);
  await usersCard().locator('tbody tr').first().waitFor();
  await p.waitForTimeout(300);
};
await gotoSettings();

// Clean up anything a previous run left behind.
if (await rowFor(TEMP).count()) {
  await rowFor(TEMP).locator('[data-del-user]').click();
  await p.waitForTimeout(700); await gotoSettings();
}

console.log('THE USERS CARD');
check('every row shows a status badge',
  (await usersCard().locator('tbody tr .badge').count()) ===
  (await usersCard().locator('tbody tr').count()));
const self = rowFor(ADMIN.email);
check('your own row offers Edit', (await self.locator('[data-edit-user]').count()) === 1);
check('your own row has no Suspend button', (await self.locator('[data-toggle-user]').count()) === 0);
check('your own row has no Delete button', (await self.locator('[data-del-user]').count()) === 0);
check('other rows have all three',
  (await rowFor(MANAGER1.email).locator('button').count()) === 3);
await p.screenshot({ path: `${S}/u1-users-card.png`, fullPage: true });

console.log('\nEDITING A MANAGER\'S ENTITIES');
await rowFor(MANAGER1.email).locator('[data-edit-user]').click();
await p.waitForSelector('dialog[open]');
await p.waitForTimeout(400);
check('the dialog names the account',
  (await p.locator('.dialog-head').textContent()).includes(MANAGER1.email));
check('the entity picker is shown for a manager',
  await p.locator('#fundPick').isVisible());
check('the investor picker is hidden', !(await p.locator('#investorPick').isVisible()));
const preselected = await p.$$eval('select[name=fund_ids] option:checked', (o) => o.map((x) => x.textContent.trim()));
check('it arrives pre-selected with what they hold', preselected.length === 1 && preselected[0].startsWith('LCG1'),
  preselected.join('/'));
await p.screenshot({ path: `${S}/u2-edit-manager.png`, fullPage: true });

// Grant every entity there is.
const allFundValues = await p.$$eval('select[name=fund_ids] option', (o) => o.map((x) => x.value));
await p.selectOption('select[name=fund_ids]', allFundValues);
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1200);
await gotoSettings();
check('the table shows both entities',
  (await rowFor(MANAGER1.email).textContent()).includes('LCG1, LCG2'),
  (await rowFor(MANAGER1.email).textContent()).trim().replace(/\s+/g, ' '));

// Take LCG2 back off.
await rowFor(MANAGER1.email).locator('[data-edit-user]').click();
await p.waitForSelector('dialog[open]'); await p.waitForTimeout(400);
const lcg1Value = await p.$eval('select[name=fund_ids] option:nth-child(1)', (o) => o.value);
await p.selectOption('select[name=fund_ids]', [lcg1Value]);
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1200);
await gotoSettings();
const back = (await rowFor(MANAGER1.email).textContent());
check('deselecting removes the entity', back.includes('LCG1') && !back.includes('LCG2'),
  back.trim().replace(/\s+/g, ' '));

console.log('\nROLE SWITCHING INSIDE THE DIALOG');
await rowFor(INVESTOR1.email).locator('[data-edit-user]').click();
await p.waitForSelector('dialog[open]'); await p.waitForTimeout(400);
check('an investor account shows the investor picker', await p.locator('#investorPick').isVisible());
const chosen = await p.$eval('select[name=investor_id]', (s) => s.selectedOptions[0].textContent.trim());
check('with their investor already chosen', chosen.length > 0 && chosen !== 'Choose an investor…', chosen);
await p.selectOption('select[name=role]', 'manager');
check('switching to manager reveals the entity picker', await p.locator('#fundPick').isVisible());
check('and hides the investor picker', !(await p.locator('#investorPick').isVisible()));
await p.selectOption('select[name=role]', 'investor');
check('switching back restores it', await p.locator('#investorPick').isVisible());
await p.locator('#dlgCancel').click();
await p.waitForTimeout(400);
check('cancelling changed nothing',
  (await rowFor(INVESTOR1.email).textContent()).includes('investor'));

console.log('\nGIVING A MANAGER ACCESS TO AN INVESTOR');
/* A manager can always reach whoever already holds a position in their
   entities. This is the other half: an admin naming investors the manager may
   take a new deal to, so they never have to key in a second copy of a client
   the firm already has. */
await rowFor(MANAGER1.email).locator('[data-edit-user]').click();
await p.waitForSelector('dialog[open]'); await p.waitForTimeout(500);
check('a manager account shows the entity picker', await p.locator('#fundPick').isVisible());
check('and an investor-access picker beside it', await p.locator('#grantPick').isVisible());
const grantHelp = (await p.locator('#grantPick').textContent()).replace(/\s+/g, ' ');
check('which explains what it is for', /before there is any holding/i.test(grantHelp), grantHelp.slice(0, 120));
check('and says it does not open up holdings',
  /does not open up holdings/i.test(grantHelp));

const options = await p.$$eval('select[name=granted_investor_ids] option',
  (o) => o.map((x) => ({ v: x.value, t: x.textContent.trim() })));
check('every investor is listed to choose from', options.length >= 2, `${options.length} options`);
await p.selectOption('select[name=granted_investor_ids]', options[0].v);
await p.locator('dialog[open] button[type=submit]').click();
await p.waitForTimeout(1500); await gotoSettings();
const mgrRow = (await rowFor(MANAGER1.email).textContent()).replace(/\s+/g, ' ');
check('the grant shows on their row', mgrRow.includes(options[0].t), mgrRow.slice(0, 140));

await rowFor(MANAGER1.email).locator('[data-edit-user]').click();
await p.waitForSelector('dialog[open]'); await p.waitForTimeout(500);
const still = await p.$eval('select[name=granted_investor_ids]',
  (s) => [...s.selectedOptions].map((o) => o.textContent.trim()));
check('and comes back selected when reopened', still.includes(options[0].t), still.join(','));
// Deselecting everything revokes it, which is the only way to take one away.
await p.selectOption('select[name=granted_investor_ids]', []);
await p.locator('dialog[open] button[type=submit]').click();
await p.waitForTimeout(1500); await gotoSettings();
check('deselecting takes it away again',
  !(await rowFor(MANAGER1.email).textContent()).includes(options[0].t));

console.log('\nYOUR OWN ROW IS LOCKED DOWN');
await self.locator('[data-edit-user]').click();
await p.waitForSelector('dialog[open]'); await p.waitForTimeout(300);
check('role select is disabled on your own account',
  await p.locator('dialog[open] select[name=role]').isDisabled());
check('status select is disabled too',
  await p.locator('dialog[open] select[name=is_active]').isDisabled());
await p.locator('#dlgCancel').click(); await p.waitForTimeout(300);

console.log('\nSUSPEND, REACTIVATE, DELETE');
await usersCard().locator('.card-head button').click();      // Add user
await p.waitForSelector('dialog[open]'); await p.waitForTimeout(300);
await p.fill('input[name=email]', TEMP);
await p.fill('input[name=full_name]', 'UI Temp');
await p.fill('input[name=password]', scratchPassword('ui-probe'));
await p.selectOption('select[name=role]', 'viewer');
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1200); await gotoSettings();
check('the new user appears', (await rowFor(TEMP).count()) === 1);
check('and reads as Active', (await rowFor(TEMP).textContent()).includes('Active'));

await rowFor(TEMP).locator('[data-toggle-user]').click();
await p.waitForTimeout(1200); await gotoSettings();
check('suspending flips the badge', (await rowFor(TEMP).textContent()).includes('Suspended'));
check('the row is dimmed', (await rowFor(TEMP).getAttribute('class')).includes('row-muted'));
check('the button now offers Reactivate',
  (await rowFor(TEMP).locator('[data-toggle-user]').textContent()) === 'Reactivate');
await p.screenshot({ path: `${S}/u3-suspended.png`, fullPage: true });

await rowFor(TEMP).locator('[data-toggle-user]').click();
await p.waitForTimeout(1200); await gotoSettings();
check('reactivating flips it back', (await rowFor(TEMP).textContent()).includes('Active'));

await rowFor(TEMP).locator('[data-del-user]').click();
await p.waitForTimeout(1200); await gotoSettings();
check('deleting removes the row', (await rowFor(TEMP).count()) === 0);

console.log('\nPAGE ERRORS');
check('no uncaught errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL USER ADMIN UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
