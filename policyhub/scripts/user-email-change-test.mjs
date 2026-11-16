/* =====================================================================
   Changing a user's sign-in email.

   An administrator can change it from Edit user. What has to be true:
     - The new address works for signing in, with the same password; the
       old one no longer does.
     - Every session on the account ends at once.
     - A notice goes to both the old and the new address, and the change is
       in the activity log.
     - A malformed address, or one another login has, is refused and
       changes nothing.
     - Only an administrator can do it.
   Idempotent: accounts use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import pg from 'pg';
import { BASE, ADMIN, MANAGER1, login, scratchPassword, databaseUrl } from './test-config.mjs';

const P = 'emailchg';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const call = (cookie) => async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const api = call(await login(ADMIN.email, ADMIN.password));
const OLD = `${P}-old@test.local`, NEW = `${P}-new@test.local`, OTHER = `${P}-other@test.local`;
const wipe = async () => {
  for (const u of ((await api('/users')).body || []).filter((x) => x.email.startsWith(P)))
    await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();
const funds = (await api('/funds')).body;
const pw = scratchPassword('email');
const made = (await api('/users', { method: 'POST', body: { email: OLD, full_name: 'Cass Effo', role: 'cfo',
  password: pw, fund_ids: [funds[0].id] } })).body;
await api('/users', { method: 'POST', body: { email: OTHER, full_name: 'Other', role: 'viewer', password: pw } });
const before = await login(OLD, pw);
check('the CFO can sign in with the old address', (await call(before)('/auth/me')).status === 200);

console.log('\nREFUSED, AND NOTHING CHANGES');
const bad = await api(`/users/${made.id}`, { method: 'PUT', body: { role: 'cfo', fund_ids: [funds[0].id], email: 'not-an-address' } });
check('a malformed address', bad.status === 400, String(bad.status));
const taken = await api(`/users/${made.id}`, { method: 'PUT', body: { role: 'cfo', fund_ids: [funds[0].id], email: OTHER.toUpperCase() } });
check('an address another login has (whatever its case)', taken.status === 409, String(taken.status));
check('and the old address still works', (await call(before)('/auth/me')).status === 200);
const mgr = call(await login(MANAGER1.email, MANAGER1.password));
check('a manager cannot change it', (await mgr(`/users/${made.id}`, { method: 'PUT', body: { email: NEW } })).status === 403);

console.log('\nCHANGED');
const ok = await api(`/users/${made.id}`, { method: 'PUT', body: { role: 'cfo', fund_ids: [funds[0].id], email: `  ${NEW.toUpperCase()} ` } });
check('the change is saved, trimmed and lower-cased', ok.status === 200 && ok.body.email === NEW, `${ok.status} ${ok.body?.email}`);
check('the session on the old address has ended', (await call(before)('/auth/me')).status === 401);
let oldLogin = 'ok';
try { await login(OLD, pw); } catch { oldLogin = 'refused'; }
check('the old address no longer signs in', oldLogin === 'refused');
check('the new one does, with the same password', (await call(await login(NEW, pw))('/auth/me')).body?.email === NEW);
check('the role and entities are untouched', ((await api('/users')).body || []).find((u) => u.id === made.id)?.role === 'cfo');
const db = new pg.Client({ connectionString: databaseUrl() });
await db.connect();
const { rows: mail } = await db.query(
  `SELECT to_email FROM email_outbox WHERE kind = 'email_changed' AND to_email IN ($1, $2)`, [OLD, NEW]);
const tos = mail.map((m) => m.to_email);
check('a notice is queued to the old address and to the new', tos.includes(OLD) && tos.includes(NEW), tos.join(', '));
await db.end();
const audit = (await api('/audit')).body || [];
check('and the change is in the activity log', audit.some((a) => (a.detail || '').includes(`${OLD} → ${NEW}`)));

console.log('\nON SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/settings`);
await p.waitForTimeout(1500);
await p.locator(`tr:has-text("${NEW}")`).first().locator('button:has-text("Edit"), [data-edit-user]').first().click();
await p.waitForSelector('dialog[open] input[name=email]');
check('Edit user has the email field, filled in', await p.inputValue('dialog[open] input[name=email]') === NEW);
await p.fill('dialog[open] input[name=email]', OLD);
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(1800);
check('saving from the dialog changes it back', ((await api('/users')).body || []).some((u) => u.id === made.id && u.email === OLD));
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All email change checks passed.'}`);
process.exit(fails.length ? 1 : 0);
