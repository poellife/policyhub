/* =====================================================================
   The investor how-to.

   Different film from the walkthrough. That one is an argument — here is
   what the portal is and why you would want it. This one assumes the
   argument is won and the person is signed in for the first time with a
   question in front of them: what do I do here?

   So it is taught rather than shown. Every chapter opens on a card, does
   one thing end to end at a pace somebody can follow, and says what the
   figures mean rather than admiring them. It is the real application
   driven by a real investor login against invented people, which is the
   only way a how-to stays true: a mocked-up screen teaches somebody a
   button that is not there.

   Silent, with captions. A voice-over dates the day somebody changes a
   label; a caption file is re-recorded in a minute. The chapters are cut
   out as their own files at the end, because a how-to is watched once
   through and afterwards one part at a time.
   ===================================================================== */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BASE } from './test-config.mjs';
import { DEMO } from './demo-video-seed.mjs';
import { makeStudio, tidy, srtOf } from './video-kit.mjs';
import { burn } from './burn-subtitles.mjs';

const OUT = '/home/claude/howto';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(`${OUT}/chapters`, { recursive: true });

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
const T0 = Date.now();
const { wait, at, subtitles, chapters, furnish, card, closeCard, caption, say,
        cardSub, point, hideCursor, glide, chapter, endChapter } = makeStudio(p, T0);

/* Held over the page until the title card is up, so the film does not open
   on the sign-in screen painting itself. */
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

/* ------------------------------- title ------------------------------- */
let t = at();
await card('Poel Capital', 'Using your investor portal',
  'Nine short chapters. What every screen is for, and what to do on it.',
  4600, { keep: true });
cardSub('Using your investor portal',
  'Nine short chapters — what every screen is for, and what to do on it.', t, at());
await p.evaluate(() => document.getElementById('vidVeil')?.remove());
await closeCard();

/* ============================ 1 · signing in ========================== */
await chapter(1, 'Signing in',
  'Your own login. Nobody sees your book but you and the office.');

let done = await say('Your portal lives at portal.poelcapital.com. '
  + 'Bookmark it — there is no other address, and nobody will ever send you a different one.');
await wait(4600);
await done();

done = await say('Sign in with the email address the office holds for you.');
await point('#email');
await p.fill('#email', '');
await p.type('#email', DEMO.email, { delay: 46 });
await done();

done = await say('The first password is one we set for you. '
  + 'The portal makes you replace it before it will let you do anything else.');
await point('#password');
await p.type('#password', DEMO.password, { delay: 38 });
await done();

await caption('If you ever cannot get in, call the office. We reset it, '
  + 'and you choose your own on the way back in.', 4400);

await point('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 15000 });
await hideCursor();
await wait(1400);

await caption('You are in. Everything from here is your own book and nobody else’s.', 3800);

await caption('A session closes itself after an hour untouched, and after twelve hours '
  + 'whatever you are doing. That is deliberate.', 4600);

await caption('If your account signs in from a network it has not used before, '
  + 'a notice appears across the top of the screen.', 4400);
await caption('If that was not you, change your password. Doing so ends every other '
  + 'session at once — including whoever else was in.', 4800);

done = await say('Two small things worth knowing. This switches between light and dark.');
await point('#themeBtn');
await wait(1600);
await point('#themeBtn');
await wait(1400);
await hideCursor();
await done();

done = await say('And this signs you out. On a shared computer, use it.');
await point('#logoutBtn', { click: false });
await wait(2600);
await hideCursor();
await done();

/* ========================== 2 · your portfolio ======================== */
await chapter(2, 'Your portfolio',
  'The first screen after you sign in, and the only one you need most days.');

await caption('One rule governs this entire page, and every page after it: '
  + 'every figure is YOUR share. Not the whole policy — yours.', 5200);

done = await say('Six figures across the top. Worth taking one at a time.');
await wait(2800);
await done();

done = await say('Total death benefit: what the policies you are in would pay out, '
  + 'at your percentage of each.');
await point('.kpi-row .stat', { nth: 0, click: false });
await wait(4000);
await done();

done = await say('Capital invested: what has actually left your account. '
  + 'The purchase price, and every premium since — split underneath.');
await point('.kpi-row .stat', { nth: 1, click: false });
await wait(4400);
await done();

done = await say('Average insured age, across the lives you are exposed to — '
  + 'counted per person, not per policy.');
await point('.kpi-row .stat', { nth: 2, click: false });
await wait(3800);
await done();

done = await say('Unrealized gain: the death benefit less what you have put in, '
  + 'and the multiple that represents.');
await point('.kpi-row .stat', { nth: 3, click: false });
await wait(4000);
await done();

done = await say('Portfolio return: what you would have made if every policy '
  + 'matured today.');
await point('.kpi-row .stat', { nth: 4, click: false });
await wait(3600);
await done();

await caption('It is worked out from the dates money actually moved — never from an '
  + 'average of percentages. A big policy counts for more than a small one.', 5400);

done = await say('And the next premium due, with your share of it and the date.');
await point('.kpi-row .stat', { nth: 5, click: false });
await wait(3600);
await done();
await hideCursor();

done = await say('Below that, capital deployed over time. Every step is money going out.');
await glide(320, 1600);
await wait(3600);
await done();

done = await say('Beside it, where the death benefit sits by carrier — '
  + 'so concentration in one insurer is visible rather than buried.');
await wait(4200);
await done();

done = await say('And the premiums coming up: each one your share, with the date it '
  + 'is due and the policy it belongs to.');
await glide(680, 1500);
await wait(4200);
await done();
await glide(0, 900);

/* =========================== 3 · your policies ======================== */
await chapter(3, 'Your policies',
  'Everything you hold, and what sits behind each one.');

await point('.nav a[href="#/policies"]');
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await hideCursor();
await wait(1300);

done = await say('One row per policy, with the percentage you own beside it.');
await wait(3200);
await done();

done = await say('Only policies you are in appear here. '
  + 'There is no view of the whole book for anybody but the office.');
await wait(4200);
await done();

done = await say('Any heading sorts by that column. Click it again to reverse it.');
await point('table.data thead th', { nth: 3 });
await wait(1800);
await point('table.data thead th', { nth: 3 });
await wait(1600);
await hideCursor();
await done();

done = await say('The totals along the bottom are the totals of what is shown, '
  + 'so they follow whatever you have filtered to.');
await glide(300, 1400);
await wait(3800);
await done();
await glide(0, 800);

await point('table.data tbody tr', { nth: 0 });
await p.waitForSelector('.share-banner', { timeout: 12000 });
await hideCursor();
await wait(1300);

done = await say('Open one and the page states your share before it states anything '
  + 'else — because every number below it is that share.');
await wait(4400);
await done();

done = await say('The top of the page is the policy itself: the carrier, the insured, '
  + 'the death benefit and what is due next.');
await wait(4000);
await done();

done = await say('The tabs across the middle are its history. '
  + 'Values is what the carrier has reported, statement by statement.');
await point('.tabs button', { nth: 1 });
await wait(1600);
await glide(300, 1300);
await wait(3400);
await done();
await glide(0, 700);

done = await say('Account value is what keeps the contract alive. '
  + 'Cash surrender value is what walking away would be worth.');
await wait(4200);
await done();

done = await say('And the ledger is every dollar in and out — the price paid on the day '
  + 'it was paid, and every premium since.');
await point('.tabs button', { nth: 2 });
await wait(1600);
await glide(340, 1400);
await wait(4000);
await done();

await caption('This is where the return figure comes from. Not a model — '
  + 'these rows, with these dates.', 4200);
await glide(0, 800);

/* ==================== 4 · premiums and capital calls ================== */
await chapter(4, 'Premiums and capital calls',
  'What is coming, and what to do when money is actually asked for.');

await p.goto(`${BASE}/#/servicing`);
await p.waitForSelector('h1', { timeout: 12000 });
await furnish();
await wait(1300);

done = await say('Premiums shows what is due across everything you hold, '
  + 'months ahead, at your share.');
await wait(3800);
await done();

done = await say('These are estimates until they are paid — read from the carrier '
  + 'statement or the illustration, whichever is newer.');
await glide(300, 1400);
await wait(4400);
await done();
await glide(0, 800);

await caption('Seeing a premium here does not mean you owe it today. '
  + 'It means it is coming, and roughly what it will be.', 4600);

const callBtn = p.locator('[data-call]').first();
if (await callBtn.count()) {
  done = await say('A capital call is different. That is money actually being asked '
    + 'for, with a date it is needed by.');
  await wait(4000);
  await done();

  done = await say('Open it and you get the amount, the date, and the wiring instructions.');
  await point('[data-call]', { nth: 0 });
  await p.waitForSelector('dialog', { timeout: 8000 });
  await hideCursor();
  await wait(4000);
  await done();

  await caption('Send the wire from your own bank. The portal never moves money '
    + 'and never asks for your bank details.', 4800);
  await caption('Then tell it you have sent it. That is a note to us, not a payment.', 4200);
  await caption('So a call has three states you can see: asked for, sent by you, '
    + 'and confirmed received by the office.', 4800);
  await p.locator('dialog #dlgCancel').click().catch(() => {});
  await wait(700);
} else {
  await caption('When money is called for it appears here, with the amount and the date '
    + 'it is needed by.', 4000);
}

/* ========================== 5 · opportunities ========================= */
await chapter(5, 'Opportunities',
  'How a new deal reaches you, and how to take part in one.');

await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('.opp-card', { timeout: 12000 });
await furnish();
await wait(1000);

done = await say('A number beside Opportunities in the menu means something is '
  + 'waiting on you.');
await wait(3400);
await done();

done = await say('You only ever see deals put in front of you by name. '
  + 'There is no list of everything we are looking at.');
await wait(4200);
await done();

done = await say('The card shows the deal in outline, how much of it is still '
  + 'available, and when the offer closes.');
await wait(4200);
await done();

await point('.opp-card a.btn', { nth: 0 });
await p.waitForSelector('.scenario-table', { timeout: 12000 });
await hideCursor();
await wait(1000);

done = await say('Inside, the deal in figures: the death benefit, the asking price, '
  + 'and the life expectancy the whole case rests on.');
await wait(4400);
await done();

done = await say('Where there are two independent life expectancy reports, '
  + 'both are shown. They are not averaged into one.');
await wait(4200);
await done();

done = await say('Then the return if it runs exactly to life expectancy — '
  + 'and what it becomes either side of that.');
await glide(430, 1500);
await wait(4200);
await done();

await caption('Nothing here is a projection of what we hope. It is the same arithmetic '
  + 'run against three different outcomes, including the bad one.', 5200);

done = await say('Below that, the premium schedule the price is built on, '
  + 'year by year.');
await glide(800, 1500);
await wait(3800);
await done();

done = await say('Then the medical picture the estimate rests on, in full — '
  + 'including what argues against the case.');
await glide(1200, 1600);
await wait(4400);
await done();

done = await say('And our reasoning for bringing it to you, written out, '
  + 'so you can disagree with it.');
await glide(1600, 1400);
await wait(3800);
await done();

await glide(2100, 1500);
await wait(700);
done = await say('At the bottom you say what percentage you want.');
const take = p.locator('#takePct');
if (await take.count()) {
  await point('#takePct');
  await p.fill('#takePct', '');
  await p.type('#takePct', '15', { delay: 130 });
  await wait(2200);
  await hideCursor();
}
await done();

await caption('The figure remaining updates as other people commit, '
  + 'so what you see left is really left.', 4400);
await caption('Asking holds that share while the office confirms it. It stays a request '
  + 'until we confirm it — and you can withdraw it before then.', 5400);
await caption('Nothing you do on this screen is binding. The agreement is what binds, '
  + 'and that comes next.', 4400);
await glide(0, 1000);

/* ============================ 6 · agreements ========================= */
await chapter(6, 'Agreements',
  'Reading and signing, without paper or a second website.');

await p.goto(`${BASE}/#/agreements`);
await p.waitForSelector('h1', { timeout: 12000 });
await furnish();
await wait(1300);

done = await say('Every agreement you are party to, and whether it is waiting '
  + 'on your signature.');
await wait(3600);
await done();

done = await say('The count beside Agreements in the menu is how many are waiting.');
await wait(3200);
await done();

const row = p.locator('tr[data-id]').first();
if (await row.count()) {
  await point('tr[data-id]', { nth: 0 });
  await p.waitForSelector('#signBtn', { timeout: 12000 }).catch(() => {});
  await hideCursor();
  await wait(1500);

  done = await say('Open it and the whole document is on the screen. '
    + 'Not a summary of it — the document.');
  await wait(4000);
  await done();

  done = await say('Your contribution and your percentage are in it, '
    + 'stated as figures rather than left to a schedule somewhere else.');
  await glide(420, 1500);
  await wait(4400);
  await done();
  await glide(900, 1400);
  await wait(3000);
  await glide(0, 900);

  const signBtn = p.locator('#signBtn');
  if (await signBtn.count()) {
    done = await say('Read and sign puts your name on it here.');
    await point('#signBtn');
    await p.waitForSelector('dialog', { timeout: 8000 });
    await hideCursor();
    await wait(3800);
    await done();
    await caption('You type your name, and the portal records the moment and the '
      + 'network it came from. That is what makes it a signature.', 5000);
    await caption('A countersigned copy comes back to this same page '
      + 'once the manager has signed too.', 4200);
    await p.locator('dialog #dlgCancel').click().catch(() => {});
    await wait(700);
  }
}

/* ============================= 7 · realized ========================== */
await chapter(7, 'Realized',
  'What has actually paid out, and what it actually returned.');

await p.goto(`${BASE}/#/maturities`);
await p.waitForSelector('table.data tbody tr', { timeout: 12000 });
await furnish();
await wait(1300);

done = await say('When a policy pays, it moves off your policies list and lands here.');
await wait(3400);
await done();

done = await say('With the death benefit, what you had invested, the proceeds that '
  + 'actually arrived, and the day they arrived.');
await wait(4400);
await done();

done = await say('And the return between them.');
await wait(2600);
await done();

await caption('This is the one screen with no estimate anywhere on it. '
  + 'What went in, what came back, and nothing in between.', 4800);

done = await say('A policy that has matured but not yet paid shows as awaiting, '
  + 'rather than being counted early.');
await wait(4000);
await done();

/* ============================ 8 · statements ========================= */
await chapter(8, 'Statements',
  'Documents you can keep, print, or hand to an accountant.');

await p.goto(`${BASE}/#/reports`);
await p.waitForSelector('#rptGenerate', { timeout: 12000 });
await furnish();
await wait(1300);

done = await say('Six statements. Each one says underneath it what it is for.');
await wait(3600);
await done();

done = await say('Portfolio summary is the one-page overview — '
  + 'the document you would hand somebody.');
await point('.rpt-choice', { nth: 0 });
await wait(2600);
await done();

done = await say('Policy schedule is the full inventory. Premium forecast is what is '
  + 'coming, month by month.');
await point('.rpt-choice', { nth: 1 });
await wait(2200);
await point('.rpt-choice', { nth: 2 });
await wait(2400);
await done();

done = await say('And the two return statements: one on policies still in force, '
  + 'one on what has actually been realized.');
await point('.rpt-choice', { nth: 4 });
await wait(2200);
await point('.rpt-choice', { nth: 5 });
await wait(2400);
await hideCursor();
await done();

done = await say('Set the date it should read as at — useful when an accountant '
  + 'wants it as at year end rather than today.');
await point('#rptAsOf', { click: false }).catch(() => {});
await wait(3400);
await hideCursor();
await done();

await point('.rpt-choice', { nth: 0 });
await wait(400);
await point('#rptGenerate');
await p.waitForSelector('.rpt-sheet', { timeout: 25000 });
await hideCursor();
await wait(2000);

done = await say('It builds on the screen first, so you can read it before you '
  + 'commit it to a file.');
await glide(520, 1700);
await wait(3600);
await done();
await glide(0, 900);

done = await say('Then take it as a PDF to keep, a CSV or an Excel file to work with, '
  + 'or send it straight to a printer.');
await point('#rptPdf', { click: false }).catch(() => {});
await wait(1600);
await point('#rptCsv', { click: false }).catch(() => {});
await wait(1600);
await point('#rptXlsx', { click: false }).catch(() => {});
await wait(1800);
await hideCursor();
await done();

await caption('Every statement is your share and only your share. There is no version '
  + 'of these that shows anybody else’s book.', 4800);

/* =========================== 9 · your account ======================== */
await chapter(9, 'Your account',
  'Your password, your tax number, and what we email you about.');

await p.goto(`${BASE}/#/settings`);
await p.waitForSelector('h1', { timeout: 12000 });
await furnish();
await wait(1400);

done = await say('Four panels. On the left, your password.');
await wait(2800);
await done();

done = await say('Change it whenever you like. Doing so signs out every other session '
  + 'immediately — which is the fastest thing you can do if you are worried.');
await wait(5000);
await done();

done = await say('In the middle, your tax number. It is needed to issue your K-1.');
await wait(3400);
await done();

done = await say('It is encrypted the moment it reaches us, only the last four digits '
  + 'are ever shown again, and nobody here can read the whole number without that '
  + 'being written into the activity log.');
await wait(6000);
await done();

await caption('It fills a blank; it does not replace one. Once a number is on file, '
  + 'changing it goes through the office deliberately.', 4800);

done = await say('On the right, what we email you about: an agreement waiting, '
  + 'a capital call, a new opportunity.');
await wait(4200);
await done();

done = await say('A sign-in from somewhere new is always sent and cannot be turned off. '
  + 'It is the one that matters when it was not you.');
await wait(4600);
await done();

done = await say('And at the bottom, every place your account has been signed in from.');
await glide(440, 1500);
await wait(3600);
await done();

done = await say('The network, not the address — enough to tell your own office from '
  + 'somewhere else, and not a record of where you have been.');
await wait(4600);
await done();

await caption('If you do not recognise a row here, change your password. '
  + 'That is the whole procedure.', 4200);
await glide(0, 900);
endChapter();

/* ============================== closing ============================== */
await hideCursor();
await wait(400);

t = at();
await card('', 'That is all of it',
  'Nine screens, and nothing you have to ask anybody for. '
  + 'Open at any hour, current to the minute.', 4600, { keep: true });
cardSub('That is all of it',
  'Nine screens, and nothing you have to ask anybody for.', t, at());

t = at();
await card('', 'Poel Capital',
  'Questions about anything in this film — call the office, or reply to any '
  + 'message the portal sends you.', 4600, { keep: true });
cardSub('Poel Capital',
  'Questions about anything here — call the office, or reply to any message the portal sends.',
  t, at());
await closeCard();
await wait(700);

/* ------------------------------- render ------------------------------ */
await ctx.close();
await br.close();

const file = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
fs.renameSync(`${OUT}/${file}`, `${OUT}/raw.webm`);

const all = tidy(subtitles);
const burnCues = tidy(subtitles.filter((c) => !c.card));
fs.writeFileSync(`${OUT}/investor-how-to.srt`, srtOf(all));

const CLEAN = `${OUT}/investor-how-to-clean.mp4`;
const FULL = `${OUT}/investor-how-to.mp4`;

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${OUT}/raw.webm`,
  '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', CLEAN], { stdio: 'inherit' });

burn(CLEAN, FULL, burnCues);

const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
  'format=duration', '-of', 'default=nw=1:nk=1', FULL]).toString().trim());

/* ------------------------------ chapters ----------------------------- */
/* Cut from the marks the recording took, not from a stopwatch held against
   the finished file. Re-encoded rather than stream-copied: a copy snaps to
   the nearest keyframe, which is how a chapter ends up opening on the last
   second of the one before it. */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const index = [];
for (const c of chapters) {
  const end = (c.end ?? at()) / 1000;
  const start = c.start / 1000;
  const name = `${String(c.n).padStart(2, '0')}-${slug(c.title)}.mp4`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-to', String(end),
    '-i', FULL, '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    `${OUT}/chapters/${name}`], { stdio: 'inherit' });
  /* Each clip gets its own caption file, retimed to its own zero — a track
     still counting from the start of the full film is useless on a clip. */
  const cues = tidy(subtitles.filter((s2) => s2.start >= c.start && s2.start < (c.end ?? at())));
  fs.writeFileSync(`${OUT}/chapters/${name.replace(/\.mp4$/, '.srt')}`,
    srtOf(cues, c.start));
  index.push({ ...c, file: `chapters/${name}`, seconds: end - start });
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
fs.writeFileSync(`${OUT}/chapters.txt`,
  index.map((c) => `${mmss(c.start / 1000).padStart(6)}  ${c.n}. ${c.title} — ${c.sub}`).join('\n')
  + '\n');

console.log(`\nrecorded ${mmss(seconds)}  (${seconds.toFixed(1)}s)`);
console.log(`  ${FULL}`);
console.log(`  ${OUT}/investor-how-to.srt  (${all.length} cues)`);
for (const c of index)
  console.log(`  ${c.file.padEnd(42)} ${mmss(c.seconds)}`);
