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

/* The recording starts when the context does, so that is the zero the
   subtitle file is written against. Every line records when it appeared and
   when it left, and the .srt is written from those numbers rather than from
   an estimate — a subtitle that drifts is worse than none. */
const T0 = Date.now();
const at = () => Date.now() - T0;
const subtitles = [];

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
  /* Subtitles, not chips: wide enough for a sentence, two lines when a
     sentence needs two, and legible over a white table at a glance. The
     same words go out as an .srt beside the film, so a player that shows
     its own captions says exactly what is burned in. */
  #vidCap {
    position: fixed; left: 50%; bottom: 44px; transform: translateX(-50%) translateY(10px);
    z-index: 99998; background: rgba(10,10,10,.90); color: #fff;
    padding: 14px 30px; border-radius: 14px; font-family: 'Inter Tight', system-ui, sans-serif;
    font-size: 24px; font-weight: 500; letter-spacing: -0.01em; line-height: 1.35;
    max-width: 1180px; text-align: center; text-wrap: balance;
    opacity: 0; transition: opacity 300ms ease, transform 300ms ease;
    box-shadow: 0 10px 40px rgba(0,0,0,.22); pointer-events: none;
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

/**
 * A subtitle. Shown on screen and written to the file.
 *
 * `hold` is how long the words stay up, which is decided by how long they
 * take to read rather than by how long the animation underneath runs — the
 * two are separated so that slowing a scroll does not silently speed up the
 * reading.
 */
async function caption(text, hold = 2400) {
  await furnish();
  const start = at();
  await p.evaluate((t) => {
    const c = document.getElementById('vidCap');
    c.textContent = t; c.classList.add('on');
  }, text);
  await wait(hold);
  subtitles.push({ text, start, end: at() });
  await p.evaluate(() => document.getElementById('vidCap').classList.remove('on'));
  await wait(260);
}

/** A subtitle that stays up while something else happens underneath it. */
async function say(text) {
  await furnish();
  const start = at();
  await p.evaluate((t) => {
    const c = document.getElementById('vidCap');
    c.textContent = t; c.classList.add('on');
  }, text);
  return async () => {
    subtitles.push({ text, start, end: at() });
    await p.evaluate(() => document.getElementById('vidCap').classList.remove('on'));
  };
}

/* A full-screen card is a subtitle too, as far as somebody reading is
   concerned — it is the words on screen at that second. */
const cardSub = (title, sub, start, end) =>
  subtitles.push({ text: sub ? `${title} — ${sub}` : title, start, end });

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

/* ------------------------------ the film -----------------------------
 *
 * Spoken to the person who might invest, not about them. The claim being
 * made is a simple one — you can see everything, at any hour, without
 * asking anybody — so the film is mostly the application answering
 * questions before they are asked: what do I hold, what is it worth
 * today, what has actually come back, what is being asked of me, and
 * what is next.
 *
 * About two minutes. Each beat holds long enough to read the line and
 * see the figure it is about.
 * -------------------------------------------------------------------- */

await p.goto(BASE);
await p.waitForSelector('#loginForm');
await wait(500);

let t = at();
await card('Poel Capital · Investor access', 'Your money, in plain sight',
  'Everything you hold, what it has returned, and what is being asked of you — '
  + 'up to the minute, whenever you want to look.', 4200);
cardSub('Your money, in plain sight',
  'Everything you hold and what it has returned — up to the minute.', t, at());

let done = await say('Your own login. Nobody sees your book but you and us.');
await point('#email');
await p.fill('#email', '');
await p.type('#email', DEMO.email, { delay: 45 });
await point('#password');
await p.type('#password', DEMO.password, { delay: 38 });
await done();
await wait(200);
await point('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 15000 });
await hideCursor();
await wait(1400);

/* ---------------------------- what you hold ------------------------- */
await caption('You land on your own portfolio — and only ever your own.', 3000);
done = await say('Every figure here is your share, valued as of today.');
await glide(300, 1500);
await wait(3000);
await done();
await glide(0, 900);

await caption('The return is worked out from the dates money actually moved.', 3400);

await point('.nav a[href="#/policies"]');
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await hideCursor();
await wait(1300);
done = await say('Every policy you are in, with the percentage you own beside it.');
await glide(240, 1400);
await wait(2800);
await done();
await glide(0, 800);

await point('table.data tbody tr', { nth: 0 });
await p.waitForSelector('.share-banner', { timeout: 12000 });
await hideCursor();
await wait(1200);
await caption('Open one and the page states your share before anything else.', 3200);

done = await say('Every dollar in and out — the price paid, and every premium since.');
await point('.tabs button', { nth: 2 });
await wait(1600);
await glide(320, 1400);
await wait(3000);
await done();
await glide(0, 800);

/* -------------------------- what came back -------------------------- */
await p.goto(`${BASE}/#/maturities`);
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await furnish();
await wait(1200);
done = await say('When a policy pays out, you see the cheque and the day it arrived.');
await wait(3400);
await done();
await caption('Not a projection. What actually came back, and what it returned.', 3400);

/* --------------------------- what is asked -------------------------- */
await p.goto(`${BASE}/#/servicing`);
await p.waitForSelector('h1', { timeout: 12000 });
await furnish();
await wait(1300);
done = await say('Premiums coming, months ahead — your share, not the whole policy.');
await glide(300, 1400);
await wait(2800);
await done();
await glide(0, 800);

const callBtn = p.locator('[data-call]').first();
if (await callBtn.count()) {
  done = await say('When money is called for, you are told the amount and the date.');
  await point('[data-call]', { nth: 0 });
  await p.waitForSelector('dialog', { timeout: 8000 });
  await hideCursor();
  await wait(3200);
  await done();
  await caption('You tell us it has been sent. We confirm when it lands.', 3000);
  await p.locator('dialog #dlgCancel').click().catch(() => {});
  await wait(500);
}

/* ---------------------------- agreements ---------------------------- */
await p.goto(`${BASE}/#/agreements`);
await p.waitForSelector('h1', { timeout: 12000 });
await furnish();
await wait(1200);
done = await say('The agreements you are party to — read and signed in the portal.');
await wait(3400);
await done();

/* --------------------------- opportunities -------------------------- */
await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('.opp-card', { timeout: 12000 });
await furnish();
await wait(800);
await caption('New deals appear the moment we put one in front of you.', 3000);

await point('.opp-card a.btn', { nth: 0 });
await p.waitForSelector('.scenario-table', { timeout: 12000 });
await hideCursor();
await wait(900);
done = await say('The return if it runs to life expectancy — and either side of it.');
await glide(430, 1500);
await wait(3000);
await done();

done = await say('The medical picture behind the estimate, in full.');
await glide(1150, 1600);
await wait(3000);
await done();

await glide(2000, 1500);
await wait(600);
done = await say('You take the percentage you want. No minimum you have not agreed.');
const take = p.locator('#takePct');
if (await take.count()) {
  await point('#takePct');
  await p.fill('#takePct', '');
  await p.type('#takePct', '15', { delay: 130 });
  await wait(2000);
  await hideCursor();
}
await done();
await glide(0, 1000);

/* ---------------------------- statements ---------------------------- */
await p.goto(`${BASE}/#/reports`);
await p.waitForSelector('#rptGenerate', { timeout: 12000 });
await furnish();
await wait(1200);
done = await say('Statements you can print or keep — on your share, never the whole book.');
await point('.rpt-choice', { nth: 1 });
await wait(300);
await point('#rptGenerate');
await p.waitForSelector('.rpt-sheet', { timeout: 25000 });
await hideCursor();
await wait(2100);
await done();
done = await say('Every figure in the document is the one on the screen behind it.');
await glide(520, 1700);
await wait(3000);
await done();
await glide(0, 900);

/* ------------------------------ closing ----------------------------- */
t = at();
await card('', 'Nothing you have to ask for',
  'It is your money. The portal is simply where it is all written down — '
  + 'open at any hour, current to the minute.', 4600);
cardSub('Nothing you have to ask for',
  'It is your money — open at any hour, current to the minute.', t, at());

t = at();
await card('', 'Poel Capital', 'Life settlement portfolio management · Southfield, Michigan', 3200);
cardSub('Poel Capital', 'Life settlement portfolio management', t, at());
await wait(600);

await ctx.close();
await br.close();

const file = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
fs.renameSync(`${OUT}/${file}`, `${OUT}/raw.webm`);

/* ---------------------------- the subtitles --------------------------- */
/* Written from the times the lines were actually on the screen, not from a
   guess at reading speed. Two small corrections: a line that overlaps the
   next is trimmed to end where the next begins, and a line too brief to
   read is given a floor of 1.2 seconds — the burned-in caption has already
   gone by then, but a caption track that flashes is unreadable. */
const stamp = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const h = String(Math.floor(t / 3600000)).padStart(2, '0');
  const m = String(Math.floor(t / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(t / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(t % 1000).padStart(3, '0')}`;
};

const cues = subtitles
  .filter((c) => c.text && c.end > c.start)
  .sort((a, b) => a.start - b.start)
  .map((c, i, all) => {
    const next = all[i + 1];
    let end = Math.max(c.end, c.start + 1200);
    if (next && end > next.start - 60) end = Math.max(c.start + 700, next.start - 60);
    return { ...c, end };
  });

const srt = cues.map((c, i) =>
  `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
fs.writeFileSync(`${OUT}/investor-portal.srt`, srt);

/* ------------------------------- the file ----------------------------- */
/* webm is what the recorder produces; mp4 is what plays everywhere a person
   might open it — a phone, a mail client, a slide. The re-encode is also the
   only chance to fix the frame rate, which the recorder varies. */
const { execFileSync } = await import('node:child_process');
execFileSync('ffmpeg', [
  '-y', '-i', `${OUT}/raw.webm`,
  '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
  `${OUT}/investor-portal.mp4`,
], { stdio: 'inherit' });

const seconds = Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', `${OUT}/investor-portal.mp4`,
]).toString().trim());

console.log(`recorded ${OUT}/investor-portal.mp4 — ${seconds.toFixed(1)}s, `
  + `${cues.length} subtitles`);
