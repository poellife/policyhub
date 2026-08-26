/* =====================================================================
   The studio: everything a walkthrough recording needs that is not the
   walkthrough itself.

   Cards, captions, the pointer and the easing were written for the first
   film and are wanted unchanged by every one after it — so they live here
   rather than being copied, which is how two films end up with two
   slightly different pointers and nobody notices until they are cut
   together.

   `makeStudio` binds them to one page and one clock and hands them back.
   The caller supplies the beats; this supplies the furniture.
   ===================================================================== */

/**
 * @param p     the Playwright page being recorded
 * @param T0    the millisecond the recording context was created — every
 *              subtitle is timed against this and nothing else
 */
export function makeStudio(p, T0) {
  const wait = (ms) => p.waitForTimeout(ms);
  const at = () => Date.now() - T0;
  const subtitles = [];

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

  /* ---------------------------- chapters -----------------------------
     A how-to is watched twice: once through, and afterwards one part at a
     time by somebody who has forgotten how a capital call works. So every
     chapter records where it began, and the cut is made from those marks
     rather than from a stopwatch held against the finished file.
     ------------------------------------------------------------------ */
  const chapters = [];

  /** Open a chapter on a full-screen card. Closes the one before it. */
  async function chapter(n, title, sub, hold = 3400) {
    if (chapters.length) chapters[chapters.length - 1].end = at();
    const start = at();
    await card(`Chapter ${n}`, title, sub, hold, { keep: true });
    cardSub(title, sub, start, at());
    await closeCard();
    chapters.push({ n, title, sub, start, end: null });
  }

  /** Close the last chapter without opening another. */
  const endChapter = () => {
    if (chapters.length) chapters[chapters.length - 1].end = at();
  };

  return { wait, at, subtitles, chapters, furnish, card, closeCard, caption, say,
           cardSub, point, hideCursor, glide, chapter, endChapter };
}

/* --------------------------- the subtitle file ----------------------- */

export const stamp = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const h = String(Math.floor(t / 3600000)).padStart(2, '0');
  const m = String(Math.floor(t / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(t / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(t % 1000).padStart(3, '0')}`;
};

/** No cue shorter than it can be read, and none overlapping the next. */
export const tidy = (list) => list
  .filter((c) => c.text && c.end > c.start)
  .sort((a, b) => a.start - b.start)
  .map((c, i, all) => {
    const next = all[i + 1];
    let end = Math.max(c.end, c.start + 1200);
    if (next && end > next.start - 60) end = Math.max(c.start + 700, next.start - 60);
    return { ...c, end };
  });

export const srtOf = (list, offset = 0) => list.map((c, i) =>
  `${i + 1}\n${stamp(c.start - offset)} --> ${stamp(c.end - offset)}\n${c.text}\n`).join('\n');
