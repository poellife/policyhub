/* =====================================================================
   The application checking that it is all one build.

   Twice now a deployment has landed with new browser files against an
   older API, and twice the only thing on screen was a status code: an
   export the server had never heard of, and an Edit button whose route
   did not exist. Neither is a bug in the thing that failed, and neither
   could be told apart from one without asking somebody.

   So both halves carry the same constant and the page says so when they
   disagree. That is the whole feature, and what makes it worth having is
   that it fails loudly on the state that used to fail quietly.

   Nothing here needs a fixture: it is a fact about the code, the wire and
   the page.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';
import { BUILD } from '../public/build.js';

const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

console.log('THE CONSTANT');
check('there is one, and it is a string worth printing',
  typeof BUILD === 'string' && BUILD.length > 0 && BUILD.length <= 40, BUILD);

console.log('\nTHE SERVER REPORTS IT');
for (const [who, acct] of [['an administrator', ADMIN], ['an investor', INVESTOR1]]) {
  const c = await login(acct.email, acct.password);
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: c } })).json();
  check(`${who} is told which build is answering`, me.build === BUILD,
    `${me.build} against ${BUILD}`);
}

console.log('\nAND IT IS NOT HANDED TO STRANGERS');
/* A version number is a small thing to leak, but it is the first thing
   somebody probing a host asks for, and there is no reason for it to be
   readable without signing in. */
const out = await fetch(`${BASE}/api/auth/me`);
check('a caller who has not signed in gets no build number', out.status === 401,
  String(out.status));

/* ------------------------------ on screen ---------------------------- */
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.waitForTimeout(900);

console.log('\nWHEN THEY AGREE, IT SAYS NOTHING');
check('a matched deployment shows no banner',
  (await p.locator('#buildBanner').count()) === 0);

console.log('\nWHEN THEY DO NOT, IT SAYS SO');
/* The state that used to be invisible, forced: the page is told the
   server answered with a different build. Everything after this is what
   somebody would actually see on a half-finished deployment. */
await p.addInitScript(() => {
  const orig = window.fetch;
  window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    if (String(url).includes('/api/auth/me') && res.ok) {
      const body = await res.clone().json();
      return new Response(JSON.stringify({ ...body, build: 'an-older-build' }), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return res;
  };
});
await p.reload();
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.waitForTimeout(900);

check('the banner is there', (await p.locator('#buildBanner').count()) === 1);
const text = (await p.locator('#buildBanner').textContent()).replace(/\s+/g, ' ').trim();
check('it says the two halves differ', /different builds/i.test(text), text.slice(0, 80));
check('it names the build the page is', text.includes(BUILD), BUILD);
check('and the build the server is', /an-older-build/.test(text));
check('it says what to do first', /hard refresh/i.test(text));
check('and what it means if that does not work',
  /some files and not others/i.test(text), text.slice(-90));
check('with a button to do it', (await p.locator('#buildReload').count()) === 1);
check('the application still works underneath it — this is a warning, not a wall',
  (await p.locator('.kpi-row .stat').count()) > 0);
await p.screenshot({ path: '/home/claude/shots/bm1-mismatch.png' });

/* A server old enough to predate the marker is the same fault, and the
   banner has to survive being told nothing at all rather than throwing. */
await p.addInitScript(() => {
  const orig = window.fetch;
  window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    if (String(url).includes('/api/auth/me') && res.ok) {
      const body = await res.clone().json();
      delete body.build;
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return res;
  };
});
await p.reload();
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.waitForTimeout(900);
const older = (await p.locator('#buildBanner').textContent()).replace(/\s+/g, ' ').trim();
check('a server that reports no build at all is caught too',
  (await p.locator('#buildBanner').count()) === 1);
check('and described as what it is, rather than as a blank',
  /does not report one/i.test(older), older.slice(0, 110));

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
console.log(fails.length
  ? `\n${fails.length} BUILD MARKER CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL BUILD MARKER CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
