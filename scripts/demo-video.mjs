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
import { makeStudio, tidy, srtOf } from './video-kit.mjs';

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

/* The recording starts when the context does, so that is the zero the
   subtitle file is written against. Every line records when it appeared and
   when it left, and the .srt is written from those numbers rather than from
   an estimate — a subtitle that drifts is worse than none. */
const T0 = Date.now();

/* --------------------------- the furniture --------------------------- */

/** Brand cards and captions live in one injected stylesheet. */
/* The furniture — cards, captions, pointer, easing — lives in the studio
   so that this film and the how-to share one of each rather than two that
   have drifted apart. The beats below are all that is particular to this
   film. */
const { wait, at, subtitles, furnish, card, closeCard, caption, say, cardSub,
        point, hideCursor, glide } = makeStudio(p, T0);

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
