/* =====================================================================
   User administration: suspend, reactivate, delete, edit a manager's
   entities, and admin-initiated password reset.

   The point of most of these checks is *immediacy*. The session cookie is
   a 12-hour JWT, so if authorisation were read from the token, suspending
   someone would do nothing until tomorrow. Every check below holds a
   cookie that was issued BEFORE the change and asserts the change bites
   on the very next request.

   Idempotent: the throwaway account is removed at the start of each run.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, scratchPassword } from './test-config.mjs';
const TEMP = 'temp-user-test@example.com';
const PW1 = scratchPassword('probe');
const PW2 = scratchPassword('probe-reset');

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const tryLogin = async (email, password) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return r.status;
};
const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');
const lcg2 = funds.find((f) => f.code === 'LCG2');

/* ----------------------------- setup -------------------------------- */
let users = await json(await api(admin, '/users'));
const stale = users.find((u) => u.email === TEMP);
if (stale) await api(admin, `/users/${stale.id}`, { method: 'DELETE' });

console.log('THE USER LIST CARRIES WHAT THE EDITOR NEEDS');
users = await json(await api(admin, '/users'));
const pm1Row = users.find((u) => u.email === MANAGER1.email);
check('manager row lists its entity ids', Array.isArray(pm1Row.fund_ids) && pm1Row.fund_ids.length === 1,
  JSON.stringify(pm1Row.fund_ids));
check('manager row lists its entity codes', pm1Row.fund_codes === 'LCG1', pm1Row.fund_codes);
check('every row reports a status', users.every((u) => typeof u.is_active === 'boolean'));

console.log('\nCREATE, SUSPEND, REACTIVATE');
const created = await api(admin, '/users', { method: 'POST',
  body: { email: TEMP, password: PW1, full_name: 'Temp Tester', role: 'viewer' } });
check('admin can create a viewer', created.status === 201, `status ${created.status}`);
const temp = await json(created);

const tempCookie = await login(TEMP, PW1);
check('the new account can read', (await api(tempCookie, '/policies')).status === 200);

const susp = await api(admin, `/users/${temp.id}`, { method: 'PUT',
  body: { full_name: 'Temp Tester', role: 'viewer', is_active: false } });
check('admin can suspend', susp.status === 200, `status ${susp.status}`);

const afterSusp = await api(tempCookie, '/policies');
check('an already-open session is cut off at once', afterSusp.status === 401, `status ${afterSusp.status}`);
check('and says why', /suspend/i.test((await json(afterSusp))?.error || ''), (await json(await api(tempCookie, '/policies')))?.error);
check('a suspended account cannot sign back in', (await tryLogin(TEMP, PW1)) === 401);

const react = await api(admin, `/users/${temp.id}`, { method: 'PUT',
  body: { full_name: 'Temp Tester', role: 'viewer', is_active: true } });
check('admin can reactivate', react.status === 200, `status ${react.status}`);
check('the same cookie works again', (await api(tempCookie, '/policies')).status === 200);

console.log('\nROLE CHANGES APPLY TO A LIVE SESSION');
await api(admin, `/users/${temp.id}`, { method: 'PUT',
  body: { full_name: 'Temp Tester', role: 'editor', is_active: true } });
const asEditor = await api(tempCookie, '/policies/1', { method: 'PUT', body: { notes: 'promoted' } });
check('promotion to editor lets an open session write', asEditor.status === 200, `status ${asEditor.status}`);
await api(admin, `/users/${temp.id}`, { method: 'PUT',
  body: { full_name: 'Temp Tester', role: 'viewer', is_active: true } });
const asViewer = await api(tempCookie, '/policies/1', { method: 'PUT', body: { notes: 'demoted' } });
check('demotion to viewer blocks the same session', asViewer.status === 403, `status ${asViewer.status}`);

console.log('\nEDITING A MANAGER\'S ENTITIES');
const pmCookie = await login(MANAGER1.email, MANAGER1.password);
const before = await json(await api(pmCookie, '/policies'));
const grant = await api(admin, `/users/${pm1Row.id}`, { method: 'PUT',
  body: { full_name: pm1Row.full_name, role: 'manager', is_active: true,
          fund_ids: [lcg1.id, lcg2.id] } });
check('admin can add an entity', grant.status === 200, `status ${grant.status}`);
const widened = await json(await api(pmCookie, '/policies'));
check('the manager sees the new entity immediately', widened.length > before.length,
  `${before.length} → ${widened.length}`);
check('and it really is the second book', widened.some((p) => p.fund_code === 'LCG2'));

const revoke = await api(admin, `/users/${pm1Row.id}`, { method: 'PUT',
  body: { full_name: pm1Row.full_name, role: 'manager', is_active: true, fund_ids: [lcg1.id] } });
check('admin can remove an entity', revoke.status === 200, `status ${revoke.status}`);
const narrowed = await json(await api(pmCookie, '/policies'));
check('the manager loses it immediately', narrowed.length === before.length,
  `${widened.length} → ${narrowed.length}`);
check('nothing from the removed entity is left', narrowed.every((p) => p.fund_code === 'LCG1'));
const foreign = widened.find((p) => p.fund_code === 'LCG2');
check('a policy from the removed entity 404s on the old cookie',
  (await api(pmCookie, `/policies/${foreign.id}`)).status === 404);

const noFunds = await api(admin, `/users/${pm1Row.id}`, { method: 'PUT',
  body: { full_name: pm1Row.full_name, role: 'manager', is_active: true, fund_ids: [] } });
check('a manager with no entities is refused', noFunds.status === 400, `status ${noFunds.status}`);
const stillThere = (await json(await api(admin, '/users'))).find((u) => u.id === pm1Row.id);
check('and the refusal left their access untouched', stillThere.fund_codes === 'LCG1',
  stillThere.fund_codes);

console.log('\nGUARDS');
const me = users.find((u) => u.email === ADMIN.email);
check('cannot suspend yourself',
  (await api(admin, `/users/${me.id}`, { method: 'PUT',
    body: { role: 'admin', is_active: false } })).status === 400);
check('cannot demote yourself',
  (await api(admin, `/users/${me.id}`, { method: 'PUT',
    body: { role: 'viewer', is_active: true } })).status === 400);
check('cannot delete yourself',
  (await api(admin, `/users/${me.id}`, { method: 'DELETE' })).status === 400);
check('still an admin afterwards',
  (await json(await api(admin, '/users'))).find((u) => u.id === me.id).role === 'admin');
check('investor role without an investor is refused',
  (await api(admin, `/users/${temp.id}`, { method: 'PUT',
    body: { role: 'investor', is_active: true, investor_id: '' } })).status === 400);
check('editing a user who does not exist 404s',
  (await api(admin, '/users/999999', { method: 'PUT', body: { role: 'viewer' } })).status === 404);

console.log('\nONLY ADMINS MAY DO ANY OF THIS');
const investor = await login(INVESTOR1.email, INVESTOR1.password);
for (const [who, cookie] of [['manager', pmCookie], ['investor', investor]]) {
  for (const [method, path] of [['PUT', `/users/${temp.id}`], ['DELETE', `/users/${temp.id}`],
                                ['POST', `/users/${temp.id}/password`]]) {
    const r = await api(cookie, path, { method, body: { role: 'admin', password: 'hijackedpassword' } });
    check(`${who} ${method} ${path.replace(String(temp.id), ':id')} rejected`, r.status === 403,
      `status ${r.status}`);
  }
}
check('the target account is untouched',
  (await json(await api(admin, '/users'))).find((u) => u.id === temp.id).role === 'viewer');

console.log('\nADMIN PASSWORD RESET');
check('a short password is refused',
  (await api(admin, `/users/${temp.id}/password`, { method: 'POST', body: { password: 'short' } })).status === 400);
check('reset accepted',
  (await api(admin, `/users/${temp.id}/password`, { method: 'POST', body: { password: PW2 } })).status === 200);
check('the old password no longer works', (await tryLogin(TEMP, PW1)) === 401);
const reset = await tryLogin(TEMP, PW2);
check('the new password works', reset === 200, `status ${reset}`);

console.log('\nDELETION');
const liveCookie = await login(TEMP, PW2);
check('the account is usable right before deletion', (await api(liveCookie, '/policies')).status === 200);
const auditBefore = (await json(await api(admin, '/audit'))).length;
const del = await api(admin, `/users/${temp.id}`, { method: 'DELETE' });
check('admin can delete a login', del.status === 200, `status ${del.status}`);
const afterDel = await api(liveCookie, '/policies');
check('their open session dies at once', afterDel.status === 401, `status ${afterDel.status}`);
check('and says the account is gone', /no longer exists/i.test((await json(afterDel))?.error || ''));
check('they cannot sign in', (await tryLogin(TEMP, PW2)) === 401);
check('the account is off the list',
  !(await json(await api(admin, '/users'))).some((u) => u.email === TEMP));
const auditAfter = await json(await api(admin, '/audit'));
check('the activity log survived the deletion', auditAfter.length >= auditBefore,
  `${auditBefore} → ${auditAfter.length}`);
check('the deletion itself is logged',
  auditAfter.some((a) => a.entity === 'user' && a.action === 'delete' && a.detail.includes(TEMP)));

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL USER ADMIN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
