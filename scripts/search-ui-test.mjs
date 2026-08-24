/* =====================================================================
   Typing in a search box.

   This was reported as "I can only type one letter and then it resets",
   and that is exactly what it did. Every pause in typing redrew the whole
   page — the frame, the menu, the badges, the search box itself — so the
   element being typed into was destroyed and rebuilt underneath the
   person. The letter survived, because the box is rebuilt from the term;
   the FOCUS did not, so the next letter went nowhere.

   Three things are checked, and each is a separate way it broke:

     - the caret stays in the box, at the end of what was typed, for
       somebody typing slowly enough that every letter is its own search.
     - what is typed while an answer is on its way is not thrown away when
       that answer lands.
     - answers that arrive out of order do not win. A search for "han" that
       comes back after a search for "hancock" must not put its rows on the
       screen, because the box says "hancock".

   And one that is about the feel rather than correctness: a keystroke
   should cost one request, not five.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0139]|429/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('table.data tbody tr', { timeout: 15000 });
await p.waitForTimeout(900);

const box = () => p.inputValue('#searchInput');
const where = () => p.evaluate(() => ({
  id: document.activeElement?.id, caret: document.activeElement?.selectionStart }));
const rows = () => p.locator('table.data tbody tr').count();

console.log('TYPING SLOWLY, ONE LETTER AT A TIME');
/* Half a second between letters, which is an ordinary pace and is longer
   than the debounce — so every single letter is its own search, which is the
   case that used to fall apart on the second one. */
const all = await rows();
await p.click('#searchInput');
for (const ch of 'hancock') {
  await p.keyboard.type(ch);
  await p.waitForTimeout(500);
}
await p.waitForTimeout(900);
check('every letter arrived', (await box()) === 'hancock', JSON.stringify(await box()));
const at = await where();
check('the caret is still in the box', at.id === 'searchInput', at.id);
check('and at the end of the word, not back at the start', at.caret === 7, String(at.caret));
const narrowed = await rows();
check('the list narrowed to the carrier', narrowed > 0 && narrowed < all,
  `${narrowed} of ${all}`);

console.log('\nAND CARRIES ON FROM WHERE IT IS');
await p.keyboard.type(' life');
await p.waitForTimeout(900);
check('more letters go into the same box', (await box()) === 'hancock life',
  JSON.stringify(await box()));
for (let i = 0; i < 5; i++) await p.keyboard.press('Backspace');
await p.waitForTimeout(900);
check('and backspace takes them out again', (await box()) === 'hancock');
check('with the earlier results back', (await rows()) === narrowed,
  `${await rows()} vs ${narrowed}`);
check('the caret has not jumped', (await where()).caret === 7);

console.log('\nA SLOW ANSWER DOES NOT SWALLOW WHAT COMES AFTER IT');
/* Hold the request open and keep typing through it. What is in the box when
   the answer lands is the newest thing the person said, and it wins. */
await p.route('**/api/policies*', async (route) => {
  await new Promise((r) => setTimeout(r, 1200));
  route.continue();
});
await p.fill('#searchInput', '');
await p.waitForTimeout(1600);
await p.click('#searchInput');
await p.keyboard.type('han');
await p.waitForTimeout(420);          // the search for "han" is now in flight
await p.keyboard.type('cock');        // and this is typed while it is out
await p.waitForTimeout(3200);
check('nothing typed during the wait is lost', (await box()) === 'hancock',
  JSON.stringify(await box()));
check('the caret survives it too', (await where()).caret === 7);
check('and the rows are the ones for what the box actually says',
  (await rows()) === narrowed, `${await rows()} vs ${narrowed}`);
await p.unroute('**/api/policies*');

console.log('\nAN ANSWER THAT ARRIVES LATE DOES NOT WIN');
/* The first request is held far longer than the second. Without a guard the
   stale one lands last and puts its rows on screen under a box that says
   something else — the worst version of this bug, because it looks like an
   answer. */
let seen = 0;
await p.route('**/api/policies*', async (route) => {
  seen++;
  await new Promise((r) => setTimeout(r, seen === 1 ? 2500 : 200));
  route.continue();
});
await p.fill('#searchInput', '');
await p.waitForTimeout(1200);
await p.click('#searchInput');
await p.keyboard.type('han');
await p.waitForTimeout(400);
await p.keyboard.type('cock');
await p.waitForTimeout(3600);
check('the box still says what was typed', (await box()) === 'hancock');
check('and the slow answer for the earlier term was thrown away',
  (await rows()) === narrowed, `${await rows()} rows against ${narrowed} for "hancock"`);
await p.unroute('**/api/policies*');

console.log('\nA KEYSTROKE COSTS ONE REQUEST');
/* Searching used to go through the full redraw: the menu badges, the security
   notices and the entity list all refetched for every letter. */
const urls = [];
const watch = (r) => { if (r.url().includes('/api/')) urls.push(new URL(r.url()).pathname); };
p.on('request', watch);
await p.fill('#searchInput', '');
await p.waitForTimeout(1400);
urls.length = 0;
await p.click('#searchInput');
await p.keyboard.type('lincoln');
await p.waitForTimeout(1400);
p.off('request', watch);
check('one search, one request', urls.filter((u) => u === '/api/policies').length === 1,
  urls.join(' · ') || 'none');
check('the menu counts are not refetched for a letter',
  !urls.some((u) => /summary|applications|agreements/.test(u)), urls.join(' · '));
check('nor are the security notices', !urls.some((u) => u.includes('notices')));

console.log('\nTHE SAME EVERYWHERE ELSE');
for (const [route, id, term] of [
  ['insureds', '#insuredSearch', 'wolfe'],
  ['investors', '#investorSearch', 'test'],
]) {
  await p.goto(`${BASE}/#/${route}`);
  await p.waitForSelector(id, { timeout: 15000 });
  await p.waitForTimeout(900);
  await p.click(id);
  for (const ch of term) {
    await p.keyboard.type(ch);
    await p.waitForTimeout(450);
  }
  await p.waitForTimeout(900);
  check(`${route}: every letter arrived`, (await p.inputValue(id)) === term,
    JSON.stringify(await p.inputValue(id)));
  const w = await where();
  check(`${route}: the caret stayed put`, w.id === id.slice(1) && w.caret === term.length,
    `${w.id} at ${w.caret}`);
}

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL SEARCH CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
