/* =====================================================================
   Burning the caption track into a copy of the film.

   Kept apart from the recording for two reasons. The obvious one is that
   restyling a subtitle should not mean driving the browser through two
   minutes of the application again. The other is that the plain cut and
   the subtitled cut have to be the same film — same frames, same
   timings, same everything but the words along the bottom — and the only
   way to guarantee that is to render both from one take.

   ASS rather than force_style over an .srt. Handing libass an .srt makes
   it invent a script resolution — 384×288 — and every size and margin is
   then scaled by whatever the real frame happens to be, so a 21-point
   font lands at 65 and a caption meant for the bottom of the screen
   arrives two thirds of the way up it. Writing the ASS ourselves means
   PlayRes matches the video and a point is a point.
   ===================================================================== */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Inter Tight, unpacked from the woff2 the application itself serves, so the
   burned-in words are set in the same face as everything behind them.
   libass cannot read woff2, hence the conversion. */
export const FONT_DIR = '/home/claude/vidfonts';
const FONT_NAME = 'Inter Tight SemiBold';

/** Centiseconds, which is what ASS counts in. */
const assTime = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t / 60000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const c = Math.round((t % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    + `.${String(c).padStart(2, '0')}`;
};

/**
 * Colours are &HAABBGGRR, and the alpha runs backwards: 00 is opaque and
 * FF is invisible. Getting that the wrong way round is what turns a solid
 * caption plate into a grey smear over the picture.
 */
const WHITE = '&H00FFFFFF';
const PLATE = '&H140A0A0A';   // #0a0a0a at ~92% opacity

/**
 * @param cues  [{ start, end, text }] in milliseconds
 * @param size  { width, height } of the video the captions will sit on
 */
export function assFrom(cues, { width = 1600, height = 900 } = {}) {
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,'
      + ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,'
      + ' BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    /* BorderStyle 3 draws an opaque plate in OutlineColour, padded by
       Outline. Square rather than rounded — libass has no radius — but a
       solid plate is the point: this film is almost entirely white
       screens, and outlined type on white is unreadable. */
    `Style: Cap,${FONT_NAME},30,${WHITE},${WHITE},${PLATE},${PLATE},`
      + '0,0,0,0,100,100,0,0,3,11,0,2,210,210,50,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = cues.map((c) => {
    const text = String(c.text)
      .replace(/\\/g, '')
      .replace(/\{|\}/g, '')          // braces are override blocks in ASS
      .replace(/\r?\n/g, '\\N')
      .trim();
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${text}`;
  });
  return `${[...head, ...lines].join('\n')}\n`;
}

/**
 * Render `input` again with `cues` burned over it.
 *
 * A re-encode rather than a filter on the original take, because the two
 * files then differ only in the captions — one master, two cuts.
 */
export function burn(input, output, cues, opts = {}) {
  const size = probeSize(input);
  const assPath = `${output.replace(/\.mp4$/, '')}.ass`;
  fs.writeFileSync(assPath, assFrom(cues, size));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input,
    '-vf', `ass=${assPath}:fontsdir=${opts.fontsDir || FONT_DIR}`,
    '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output,
  ], { stdio: 'inherit' });
  if (!opts.keepAss) fs.rmSync(assPath, { force: true });
  return output;
}

export function probeSize(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim();
  const [width, height] = out.split('x').map(Number);
  return { width, height };
}

/** Parse an .srt back into cues, so this can be run on its own. */
export function cuesFromSrt(text) {
  const ms = (s) => {
    const m = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})/.exec(s);
    return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + Number(m[4].padEnd(3, '0')) : 0;
  };
  return text.split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const timing = lines.find((l) => l.includes('-->'));
    if (!timing) return null;
    const [from, to] = timing.split('-->');
    return { start: ms(from), end: ms(to),
      text: lines.slice(lines.indexOf(timing) + 1).join('\n') };
  }).filter(Boolean);
}

/* Run directly to restyle without re-recording:
     node scripts/burn-subtitles.mjs clean.mp4 burn.srt out.mp4          */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, srt, output] = process.argv.slice(2);
  if (!input || !srt || !output) {
    console.error('usage: node scripts/burn-subtitles.mjs <in.mp4> <cues.srt> <out.mp4>');
    process.exit(2);
  }
  burn(input, output, cuesFromSrt(fs.readFileSync(srt, 'utf8')), { keepAss: true });
  console.log(`burned ${srt} into ${output}`);
}

export { root };
