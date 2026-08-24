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
  /* The one line that asks the viewer to do something. Held back from the
     body copy so it reads as an instruction rather than as more prose. */
  #vidCard .cta {
    margin-top: 30px; font-size: 22px; font-weight: 600; color: #0a0a0a;
    letter-spacing: -0.01em; opacity: 0; transition: opacity 420ms ease;
  }
  #vidCard .cta.on { opacity: 1; }
  /* Swapping one card's words for the next: the TYPE fades, the card does
     not. Fading the card itself shows the application through it for a
     quarter of a second, which is the flash the closing titles used to
     have — a transition that reads as a fault. */
  #vidCard .mark, #vidCard .eyebrow, #vidCard h1, #vidCard h2 {
    transition: opacity 240ms ease;
  }
  #vidCard.swap .mark, #vidCard.swap .eyebrow,
  #vidCard.swap h1, #vidCard.swap h2, #vidCard.swap .cta { opacity: 0; }
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
      card.innerHTML = '<div class="mark"></div><div class="eyebrow"></div><h1></h1>'
        + '<h2></h2><div class="cta"></div>';
      document.body.appendChild(card);
    }
  });
}

/**
 * A full-screen brand card, held for `hold` ms.
 *
 * `keep` is what stops the flash. Two cards in a row used to fade the first
 * one out, hold on whatever page happened to be underneath for half a
 * second, and fade the second one in — so the closing titles were
 * interrupted by a glimpse of the statements screen. With `keep` the card
 * stays up and only its words change, which is what a title sequence
 * actually does.
 */
async function card(eyebrow, title, sub, hold = 2600, { keep = false, cta = '' } = {}) {
  await furnish();
  await hideCursor();
  await p.evaluate(([e, t, s, k]) => {
    const c = document.getElementById('vidCard');
    const already = c.classList.contains('on');
    const set = () => {
      c.querySelector('.eyebrow').textContent = e;
      c.querySelector('h1').textContent = t;
      c.querySelector('h2').textContent = s;
      const cta = c.querySelector('.cta');
      cta.textContent = k;
      cta.classList.toggle('on', !!k);
    };
    if (already) {
      // The card stays exactly where it is; only its words change.
      c.classList.add('swap');
      setTimeout(() => { set(); c.classList.remove('swap'); }, 250);
    } else {
      set();
      c.classList.remove('swap');
      c.classList.add('on');
    }
  }, [eyebrow, title, sub, cta]);
  await wait(hold);
  if (keep) return;
  await p.evaluate(() => {
    const c = document.getElementById('vidCard');
    c.classList.remove('swap');
    c.classList.remove('on');
  });
  await wait(560);
}

/** Fade a card that was held open with `keep` back out to the page. */
async function closeCard() {
  await p.evaluate(() => {
    const c = document.getElementById('vidCard');
    if (!c) return;
    c.classList.remove('swap');
    c.classList.remove('on');
  });
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
  await wait(hold);
  subtitles.push({ text, start, end: at() });
  await wait(260);
}

/** A subtitle that stays up while something else happens underneath it. */
async function say(text) {
  await furnish();
  const start = at();
  return async () => { subtitles.push({ text, start, end: at() }); };
}

/* A full-screen card is a subtitle too, as far as somebody reading captions
   is concerned — it is the words on screen at that second, and a caption
   track that goes silent through the titles has lost them. Marked as a card
   so the burned-in version can leave it out: the card is already saying it
   in 58-point type, and repeating it along the bottom is noise. */
const cardSub = (title, sub, start, end) =>
  subtitles.push({ text: sub ? `${title} — ${sub}` : title, start, end, card: true });

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

/* The recorder starts rolling the moment the page exists, which is a second
   or so before anything has been asked to appear on it — so the first thing
   the film showed was the sign-in screen painting itself, with the title
   card arriving on top of it afterwards. A veil, installed before the
   document's own scripts run, holds a plain white frame until the title is
   up and we take it away deliberately. */
await p.addInitScript(() => {
  try { if (sessionStorage.getItem('vidVeil')) return; } catch { /* no storage yet */ }
  const veil = document.createElement('div');
  veil.id = 'vidVeil';
  veil.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99990;pointer-events:none';
  const put = () => {
    (document.documentElement || document).appendChild(veil);
    try { sessionStorage.setItem('vidVeil', '1'); } catch { /* fine */ }
  };
  if (document.documentElement) put();
  else document.addEventListener('readystatechange', put, { once: true });
});

await p.goto(BASE);
await p.waitForSelector('#loginForm', { state: 'attached' });
await wait(300);

/* The name first, then the door. Whoever is watching should know whose
   portal this is before they are shown a login box — a film that opens on
   a password field has asked for something before it has said hello. */
let t = at();
await card('Poel Capital', 'Investor Portal',
  'Everything you hold, what it has returned, and what is being asked of you — '
  + 'up to the minute, whenever you want to look.', 4400, { keep: true });
cardSub('Poel Capital Investor Portal',
  'Everything you hold and what it has returned — up to the minute.', t, at());
/* Taken away underneath the card, so the sign-in screen is simply there when
   the title lifts rather than arriving as a second event. */
await p.evaluate(() => document.getElementById('vidVeil')?.remove());
await closeCard();

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

/* ------------------------------ closing -----------------------------
 *
 * Two cards, one background. `keep` holds the white card up between them
 * so the words change and nothing else does — the earlier cut dropped
 * back to the statements screen for half a second in between, which read
 * as a fault in the film rather than as a transition.
 */
await hideCursor();
await glide(0, 700);
await wait(400);

t = at();
await card('', 'Nothing you have to ask for',
  'It is your money. The portal is simply where it is all written down — '
  + 'open at any hour, current to the minute.', 4600, { keep: true });
cardSub('Nothing you have to ask for',
  'It is your money — open at any hour, current to the minute.', t, at());

t = at();
await card('', 'Poel Capital',
  'Life settlement portfolio management · Southfield, Michigan', 4600,
  { keep: true, cta: 'Visit poelcapital.com to learn more' });
cardSub('Poel Capital · Life settlement portfolio management',
  'Visit poelcapital.com to learn more', t, at());
/* Held to the last frame. Fading the card out here would end the film on
   whatever page was behind it, which is the flash all over again. */
await wait(900);

await ctx.close();
await br.close();

const file = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
fs.renameSync(`${OUT}/${file}`, `${OUT}/raw.webm`);

/* ---------------------------- the subtitles --------------------------- */
/* Written from the times the lines were actually on the screen, not from a
   guess at reading speed. Two small corrections: a line that overlaps the
   next is trimmed to end where the next begins, and a line too brief to
   read is given a floor of 1.2 seconds — a caption track that flashes is
   unreadable. */
const stamp = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const h = String(Math.floor(t / 3600000)).padStart(2, '0');
  const m = String(Math.floor(t / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(t / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(t % 1000).padStart(3, '0')}`;
};

const tidy = (list) => list
  .filter((c) => c.text && c.end > c.start)
  .sort((a, b) => a.start - b.start)
  .map((c, i, all) => {
    const next = all[i + 1];
    let end = Math.max(c.end, c.start + 1200);
    if (next && end > next.start - 60) end = Math.max(c.start + 700, next.start - 60);
    return { ...c, end };
  });

const srtOf = (list) => list.map((c, i) =>
  `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');

/* Two tracks from one set of timings.
   The full one is the caption file that ships beside the film — it includes
   the title cards, because somebody reading captions rather than hearing
   them still needs to know what the titles said. The burn-in track leaves
   the cards out: they are already on screen in 58-point type, and printing
   them along the bottom as well just covers the picture twice. */
const all = tidy(subtitles);
const burnCues = tidy(subtitles.filter((c) => !c.card));
fs.writeFileSync(`${OUT}/investor-portal.srt`, srtOf(all));
fs.writeFileSync(`${OUT}/investor-portal.burned.srt`, srtOf(burnCues));

/* ------------------------------- the files ---------------------------- */
/* The recording is clean — no captions are drawn into the page — so the
   plain cut is the master and the subtitled one is the same frames with
   the track burned over them. Rendering both from one take is the only
   way they can be frame-for-frame the same film; recording twice would
   drift, and the two versions would not match. */
const { execFileSync } = await import('node:child_process');
const { burn } = await import('./burn-subtitles.mjs');

const CLEAN = `${OUT}/investor-portal.mp4`;
const SUBBED = `${OUT}/investor-portal-subtitled.mp4`;

/* 30fps because the recorder's frame rate varies; faststart because the
   commonest way this gets watched is a click in a mail client. */
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${OUT}/raw.webm`,
  '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', CLEAN], { stdio: 'inherit' });

burn(CLEAN, SUBBED, burnCues);

const seconds = Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', CLEAN]).toString().trim());

console.log(`recorded ${seconds.toFixed(1)}s`);
console.log(`  ${CLEAN}`);
console.log(`  ${SUBBED}  (${burnCues.length} burned-in lines)`);
console.log(`  ${OUT}/investor-portal.srt  (${all.length} cues, titles included)`);
