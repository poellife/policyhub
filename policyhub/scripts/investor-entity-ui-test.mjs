/* =====================================================================
   The investor record, on screen.

   Two things are being watched. First, that an administrator can correct
   anything the investor typed into the registration form — people move
   house, and a wrong ZIP on a K-1 is a real problem — and can say whose
   client they are. Second, that a manager opening the same record is
   shown the entity and the tax number as facts, with no way to change
   either: assigning yourself a client is not an edit, it is a transfer.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';

const PREFIX = 'ENTUI';
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

const wipe = async () => {
  for (const i of ((await json(await api('/investors'))) || [])
    .filter((x) => String(x.name).startsWith(PREFIX)))
    await api(`/investors/${i.id}`, { method: 'DELETE' });
};
await wipe();

const funds = await json(await api('/funds'));
const mine = funds.find((f) => f.code === 'LCG1');
const NAME = `${PREFIX} Willoughby Trust`;
const made = await json(await api('/investors', { method: 'POST', body: {
  name: NAME, investor_type: 'Trust', email: `${PREFIX.toLowerCase()}@example.com`,
  phone: '(248) 555-0170', address_line1: '18 Old Woodward',
  city: 'Birmingham', state: 'MI', postal_code: '48009', tax_id: '345-67-8901' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]|429/.test(m.text()) && errs.push(m.text()));

const signIn = async (page, who) => {
  await page.goto(BASE);
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.kpi-row', { timeout: 15000 });
};

console.log('THE LIST SAYS WHOSE CLIENT EACH ONE IS');
await signIn(p, ADMIN);
await p.goto(`${BASE}/#/investors`);
await p.waitForSelector('table.data', { timeout: 12000 });
await p.waitForTimeout(900);
const heads = await p.locator('table.data thead th').allTextContents();
check('there is an Entity column', heads.includes('Entity'), heads.join(' · '));
const row = p.locator(`tr[data-investor="${made.id}"]`);
check('an unassigned one says so plainly',
  /unassigned/i.test(await row.textContent()), (await row.textContent()).replace(/\s+/g, ' ').slice(0, 90));
check('and the page counts how many are still unassigned',
  /not assigned to an entity/i.test(await p.locator('.page-head .sub').textContent()),
  (await p.locator('.page-head .sub').textContent()).trim());
check('the entity picker is on this page too', (await p.locator('#entityFilter').count()) === 1);

console.log('\nEVERYTHING THEY TYPED IS EDITABLE');
await row.locator('[data-edit-investor]').click();
await p.waitForSelector('dialog[open]');
await p.waitForTimeout(400);
const dlg = p.locator('dialog[open]');
for (const [label, name, value] of [
  ['the street address', 'address_line1', '18 Old Woodward'],
  ['the city', 'city', 'Birmingham'],
  ['the ZIP', 'postal_code', '48009'],
  ['the phone number', 'phone', '(248) 555-0170'],
  ['the email', 'email', `${PREFIX.toLowerCase()}@example.com`],
])
  check(`${label} comes back prefilled`,
    (await dlg.locator(`[name="${name}"]`).inputValue()) === value,
    await dlg.locator(`[name="${name}"]`).inputValue());
check('the state is a list, not something to mistype',
  (await dlg.locator('select[name="state"]').inputValue()) === 'MI'
  && (await dlg.locator('select[name="state"] option').count()) >= 54);
check('the tax number is not written into the box',
  (await dlg.locator('[name="tax_id"]').inputValue()) === '');
check('but the box says the last four are on file',
  /ending 8901/.test(await dlg.locator('[name="tax_id"]').getAttribute('placeholder')),
  await dlg.locator('[name="tax_id"]').getAttribute('placeholder'));
await p.screenshot({ path: `${S}/ie1-edit.png`, fullPage: true });

console.log('\nSEEING THE WHOLE NUMBER IS A DELIBERATE ACT');
await dlg.locator('#revealInvTax').click();
await p.waitForTimeout(1000);
check('an administrator can ask for it',
  (await dlg.locator('[name="tax_id"]').inputValue()) === '345-67-8901',
  await dlg.locator('[name="tax_id"]').inputValue());
check('and the link is spent once used', (await dlg.locator('#revealInvTax').count()) === 0);
const audit = await json(await api('/audit'));
check('with the reading written down',
  (audit || []).some((r) => r.entity === 'investor' && /revealed tax id/i.test(r.detail || '')));

console.log('\nSAYING WHOSE CLIENT THEY ARE');
check('the entity is a list of the entities on file',
  (await dlg.locator('select[name="fund_id"] option').count()) >= funds.length + 1);
await dlg.locator('select[name="fund_id"]').selectOption(String(mine.id));
await dlg.locator('[name="address_line1"]').fill('221 Cranbrook Road');
await dlg.locator('[name="postal_code"]').fill('48304');
await dlg.locator('button[type=submit]').click();
await p.waitForTimeout(1800);
const after = await json(await api(`/investors/${made.id}`));
check('the move is saved', after.address_line1 === '221 Cranbrook Road'
  && after.postal_code === '48304', `${after.address_line1} ${after.postal_code}`);
check('so is the entity', after.fund_code === 'LCG1', after.fund_code);
check('and the tax number survived being shown and saved back',
  after.tax_id_last4 === '8901', after.tax_id_last4);
await p.goto(`${BASE}/#/investors`); await p.waitForTimeout(1200);
check('the row now names the entity',
  /LCG1/.test(await p.locator(`tr[data-investor="${made.id}"]`).textContent()));
await p.screenshot({ path: `${S}/ie2-assigned.png`, fullPage: true });

console.log('\nWHAT THE MANAGER SEES');
const mgrCtx = await br.newContext({ viewport: { width: 1400, height: 1000 } });
const m = await mgrCtx.newPage();
m.on('pageerror', (e) => errs.push(e.message));
await signIn(m, MANAGER1);
await m.goto(`${BASE}/#/investors`);
await m.waitForSelector('table.data', { timeout: 12000 });
await m.waitForTimeout(900);
const mgrRow = m.locator(`tr[data-investor="${made.id}"]`);
check('their new client is on the manager’s list', (await mgrRow.count()) === 1);
check('with the entity against them and nothing held yet',
  /LCG1/.test(await mgrRow.textContent()), (await mgrRow.textContent()).replace(/\s+/g, ' ').slice(0, 100));
await mgrRow.locator('[data-edit-investor]').click();
await m.waitForSelector('dialog[open]');
await m.waitForTimeout(400);
const mdlg = m.locator('dialog[open]');
check('the manager can still correct the address',
  (await mdlg.locator('[name="address_line1"]').inputValue()) === '221 Cranbrook Road');
check('but the entity is shown as a fact, not a choice',
  (await mdlg.locator('select[name="fund_id"]').count()) === 0
  && /LCG1/.test(await mdlg.textContent()));
check('and it says who does decide it',
  /set by an administrator/i.test(await mdlg.textContent()));
check('the tax number is masked with no way to reveal it',
  (await mdlg.locator('[name="tax_id"]').count()) === 0
  && /••/.test(await mdlg.locator('.app-tax').textContent()),
  (await mdlg.locator('.app-tax').textContent()).trim());
await m.screenshot({ path: `${S}/ie3-manager.png`, fullPage: true });
await mdlg.locator('[name="phone"]').fill('(248) 555-0199');
await mdlg.locator('button[type=submit]').click();
await m.waitForTimeout(1600);
const afterMgr = await json(await api(`/investors/${made.id}`));
check('their edit goes through', afterMgr.phone === '(248) 555-0199', afterMgr.phone);
check('and the entity is exactly where the administrator left it',
  afterMgr.fund_code === 'LCG1', afterMgr.fund_code);

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL INVESTOR RECORD UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
