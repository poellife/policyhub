/* =====================================================================
   Records the investor walkthrough.

   The whole thing is the real application driven by a real login — no
   mock-ups, no stitched screenshots. Cards and captions are injected
   into the page rather than added afterwards so they carry the same
   typeface and the same restraint as the product itself, and so the
   pacing is decided here rather than in an edit.

   Deliberately silent. A voice-over dates the moment somebody changes a
   label; captions can be re-recorded in a minute.
   ===================================================================== */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { BASE } from './test-config.mjs';
import { DEMO } from './demo-video-seed.mjs';

const OUT = '/home/claude/video';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const W = 1600, H = 900;
const br = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
});
const ctx = await br.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  reducedMotion: 'no-preference',
});
const p = await ctx.newPage();
const wait = (ms) => p.waitForTimeout(ms);

/* --------------------------- the furniture --------------------------- */

/** Brand cards and captions live in one injected stylesheet. */
const FURNITURE = `
  #vidCard {
    position: fixed; inset: 0; z-index: 99999; display: flex;
    flex-direction: column; align-items: center; justify-content: center;
    background: #ffffff; opacity: 0; transition: opacity 520ms ease;
    font-family: 'Inter Tight', system-ui, sans-serif; text-align: center;
    /* Decorative only. Left clickable it swallows every click behind it, and
       the whole point is that the application underneath is really running. */
    pointer-events: none;
  }
  #vidCard.on { opacity: 1; }
  #vidCard .mark { width: 10px; height: 10px; border-radius: 50%; background: #0a0a0a; margin-bottom: 26px; }
  #vidCard h1 { margin: 0; font-size: 58px; font-weight: 700; letter-spacing: -0.04em; color: #0a0a0a; }
  #vidCard h2 { margin: 18px 0 0; font-size: 20px; font-weight: 400; color: #5c5c5c; letter-spacing: -0.01em; max-width: 720px; line-height: 1.5; }
  #vidCard .eyebrow {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.18em; color: #8f8f8f; margin-bottom: 20px;
  }
  #vidCap {
    position: fixed; left: 50%; bottom: 46px; transform: translateX(-50%) translateY(10px);
    z-index: 99998; background: rgba(10,10,10,.93); color: #fff;
    padding: 15px 26px; border-radius: 999px; font-family: 'Inter Tight', system-ui, sans-serif;
    font-size: 19px; font-weight: 500; letter-spacing: -0.01em; white-space: nowrap;
    opacity: 0; transition: opacity 380ms ease, transform 380ms ease;
    box-shadow: 0 8px 30px rgba(0,0,0,.18); pointer-events: none;
  }
  #vidCap.on { opacity: 1; transform: translateX(-50%) translateY(0); }
  #vidCursor {
    position: fixed; z-index: 99997; width: 22px; height: 22px; margin: -11px 0 0 -11px;
    border-radius: 50%; background: rgba(10,10,10,.14);
    border: 1.5px solid rgba(10,10,10,.5); pointer-events: none;
    transition: left 620ms cubic-bezier(.4,0,.2,1), top 620ms cubic-bezier(.4,0,.2,1), transform 160ms ease;
    opacity: 0;
  }
  #vidCursor.on { opacity: 1; }
  #vidCursor.tap { transform: scale(.62); background: rgba(10,10,10,.34); }
`;

async function furnish() {
  await p.addStyleTag({ content: FURNITURE }).catch(() => {});
  await p.evaluate(() => {
    if (!document.getElementById('vidCap')) {
      const cap = document.createElement('div'); cap.id = 'vidCap';
      document.body.appendChild(cap);
      const cur = document.createElement('div'); cur.id = 'vidCursor';
      document.body.appendChild(cur);
      const card = document.createElement('div'); card.id = 'vidCard';
      card.innerHTML = '<div class="mark"></div><div class="eyebrow"></div><h1></h1><h2></h2>';
      document.body.appendChild(card);
    }
  });
}

/** A full-screen brand card, held for `hold` ms, then faded out. */
async function card(eyebrow, title, sub, hold = 2600) {
  await furnish();
  await p.evaluate(([e, t, s]) => {
    const c = document.getElementById('vidCard');
    c.querySelector('.eyebrow').textContent = e;
    c.querySelector('h1').textContent = t;
    c.querySelector('h2').textContent = s;
    c.classList.add('on');
  }, [eyebrow, title, sub]);
  await wait(hold);
  await p.evaluate(() => document.getElementById('vidCard').classList.remove('on'));
  await wait(560);
}

async function caption(text, hold = 2400) {
  await furnish();
  await p.evaluate((t) => {
    const c = document.getElementById('vidCap');
    c.textContent = t; c.classList.add('on');
  }, text);
  await wait(hold);
  await p.evaluate(() => document.getElementById('vidCap').classList.remove('on'));
  await wait(320);
}

/** Move the on-screen pointer to an element, then click it for real. */
async function point(selector, { click = true, nth = 0 } = {}) {
  const box = await p.locator(selector).nth(nth).boundingBox();
  if (!box) return;
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  await p.evaluate(([cx, cy]) => {
    const c = document.getElementById('vidCursor');
    c.classList.add('on'); c.style.left = `${cx}px`; c.style.top = `${cy}px`;
  }, [x, y]);
  await wait(700);
  if (click) {
    await p.evaluate(() => document.getElementById('vidCursor').classList.add('tap'));
    await wait(170);
    await p.evaluate(() => document.getElementById('vidCursor').classList.remove('tap'));
    await p.locator(selector).nth(nth).click();
  }
}
const hideCursor = () => p.evaluate(() => {
  document.getElementById('vidCursor')?.classList.remove('on');
}).catch(() => {});

/** Ease a long page down so the eye can follow it. */
async function glide(to, ms = 1500) {
  await p.evaluate(([target, dur]) => new Promise((done) => {
    const from = window.scrollY, delta = target - from, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      window.scrollTo(0, from + delta * (k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
      k < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  }), [to, ms]);
}

/* ------------------------------ the film ----------------------------- */

await p.goto(BASE);
await p.waitForSelector('#loginForm');
await wait(400);
await card('Poel Capital · Policy Portfolio', 'Your investor access',
  'Your positions, your returns, and the opportunities we bring to you — in one place, whenever you want to look.', 3400);

await caption('Your own secure login', 2000);
await point('#email');
await p.fill('#email', '');
await p.type('#email', DEMO.email, { delay: 55 });
await point('#password');
await p.type('#password', DEMO.password, { delay: 45 });
await wait(300);
await point('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 15000 });
await hideCursor();
await wait(1400);

await caption('You land on your portfolio — only what you own', 3000);
await glide(320, 1400);
await wait(1600);
await glide(0, 900);

await caption('Every figure is your share of each policy', 2600);
await point('.nav a[href="#/policies"]');
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await hideCursor();
await wait(1500);
await glide(260, 1300);
await wait(1900);
await glide(0, 800);

await point('table.data tbody tr', { nth: 0 });
await p.waitForSelector('.share-banner', { timeout: 12000 });
await hideCursor();
await wait(900);
await caption('The percentage you own is stated on the page', 3000);
await glide(300, 1400);
await wait(1500);
await glide(0, 900);

await caption('Your return, solved on the dates money actually moved', 2400);
await point('.tabs button', { nth: 2 });
await wait(2400);
await hideCursor();
await glide(280, 1300);
await wait(1800);
await glide(0, 900);

await caption('Every premium coming — yours beside the full policy', 2600);
await point('.tabs button', { nth: 3 });
await wait(3000);
await hideCursor();

await card('Opportunities', 'New deals, brought to you',
  'You see what is still available, the analysis behind it, and take the percentage you want.', 3000);

await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('.opp-card', { timeout: 12000 });
await furnish();
await wait(1500);
await caption('You see an offer the moment it is shared with you', 2600);
await point('.opp-card a.btn', { nth: 0 });
await p.waitForSelector('.scenario-table', { timeout: 12000 });
await hideCursor();
await wait(1300);

await caption('The rate at life expectancy — and two years either side', 3000);
await glide(420, 1500);
await wait(2400);

await caption('The medical picture behind the estimate', 2800);
await glide(1150, 1700);
await wait(2400);

await glide(2000, 1600);
await wait(1800);
await caption('You ask for the percentage you want', 2600);
const take = p.locator('#takePct');
if (await take.count()) {
  await point('#takePct');
  await p.fill('#takePct', '');
  await p.type('#takePct', '15', { delay: 150 });
  await wait(1300);
  await hideCursor();
  await wait(900);
}
await glide(0, 1100);

await card('Statements', 'On your share, always',
  'Print-ready documents that quote the percentage you hold — never the whole policy.', 2800);

await p.goto(`${BASE}/#/reports`);
await p.waitForSelector('#rptGenerate', { timeout: 12000 });
await furnish();
await wait(1000);
await point('.rpt-choice', { nth: 1 });
await wait(400);
await point('#rptGenerate');
await p.waitForSelector('.rpt-sheet', { timeout: 25000 });
await hideCursor();
await wait(1400);
await caption('Every figure in the document is your share', 2800);
await glide(520, 1700);
await wait(2200);
await glide(0, 900);

await card('', 'Poel Capital',
  'Policy portfolio management, built for life settlements.', 3200);
await wait(400);

await ctx.close();
await br.close();

const file = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
fs.renameSync(`${OUT}/${file}`, `${OUT}/raw.webm`);
console.log(`recorded ${OUT}/raw.webm`);
