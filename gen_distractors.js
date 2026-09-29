/* Build-time AI: generate wrong answers for the words the rule engine can't cover.
 *
 * The app's own kriah rules (KRIAH_SLIPS in app_template.html) already produce three
 * real misreadings for most words. This script fills the gap for the rest — words
 * where no rule applies, so the game falls back to random words.
 *
 * Run it once, review the output by eye, and commit distractors.json. It costs
 * nothing at runtime: the result ships as static data, and no model is ever between
 * a child and the screen.
 *
 *   AI_API_KEY=sk-ant-... node gen_distractors.js            # generate
 *   AI_API_KEY=sk-ant-... node gen_distractors.js --limit 20 # try a small batch first
 *
 * Output: distractors.json  ->  { "w0123": ["par","bar","pahr"], ... }
 */
const fs = require('fs');

const KEY = process.env.AI_API_KEY;
if (!KEY) { console.error('Set AI_API_KEY first (see the header of this file).'); process.exit(1); }
const MODEL = process.env.AI_MODEL || 'claude-3-5-haiku-latest';
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? parseInt(process.argv[i + 1], 10) : 0; })();
const OUT = 'distractors.json';

const WORDS = JSON.parse(fs.readFileSync('words_min.json', 'utf8'))
  .map(([h, t, l], i) => ({ id: 'w' + String(i + 1).padStart(4, '0'), h, t, lvl: l }));

/* the same gating the app uses — only words with no rule-based misreading need help */
const SLIPS = [
  [/ָ/, 'aw'], [/ַ/, 'ah'], [/ֵ/, 'ay'], [/ֶ/, 'eh'], [/ִ/, 'ee'],
  [/[ֹֺ]/, 'o'], [/וּ/, 'oo'], [/ת(?!ּ)/, 's'], [/תּ/, 't'],
  [/ב(?!ּ)/, 'v'], [/בּ/, 'b'], [/[ך]|כ(?!ּ)/, 'ch'], [/כּ/, 'k'],
  [/[ף]|פ(?!ּ)/, 'f'], [/פּ/, 'p'], [/שׂ/, 's'], [/שׁ/, 'sh'],
];
function ruleCount(w) {
  let n = 0;
  for (const [re, sound] of SLIPS) if (re.test(w.h) && w.t.includes(sound)) n++;
  if (/ְ/.test(w.h) && w.t.includes('-')) n++;
  return n;
}
const needy = WORDS.filter(w => ruleCount(w) < 3);
const todo = LIMIT ? needy.slice(0, LIMIT) : needy;
console.log(needy.length + ' of ' + WORDS.length + ' words have fewer than 3 rule-based misreadings; generating for ' + todo.length + '.');

const SYSTEM = `You help build a Hebrew reading (kriah) practice game for children learning with Ashkenazi pronunciation.

For each Hebrew word you are given the correct transliteration. Produce exactly 3 WRONG transliterations that a child might genuinely say if they misread that specific word.

Rules:
- Every wrong answer must be a plausible misreading of THAT word: a vowel confused for a similar one, a letter read with or without its dagesh, a sheva swallowed or added, a syllable stressed wrongly. Never random syllables.
- Keep the same transliteration style as the correct answer, including hyphens between syllables and the same conventions (aw for kamatz, ay for tzeirei, ch for chaf, s for sav, tz for tzadi).
- The wrong answers must be clearly different from the correct one and from each other.
- Never output the correct answer.
- Reply with JSON only: an array of objects {"id": "...", "wrong": ["...","...","..."]}. No prose, no code fence.`;

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(batch) {
  const list = batch.map(w => ({ id: w.id, hebrew: w.h, correct: w.t }));
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(list) }] })
  });
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  return JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
}

(async () => {
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const batches = chunk(todo.filter(w => !out[w.id]), 25);
  let done = 0, kept = 0, rejected = 0;
  for (const batch of batches) {
    let rows;
    try { rows = await ask(batch); }
    catch (e) { console.error('batch failed (' + e.message + ') — skipping'); await sleep(2000); continue; }
    for (const row of rows || []) {
      const w = WORDS.find(x => x.id === row.id); if (!w) continue;
      // never trust the model blindly: drop anything equal to the answer or duplicated
      const wrong = [...new Set((row.wrong || []).map(s => String(s).trim()).filter(s => s && s !== w.t))];
      if (wrong.length >= 3) { out[w.id] = wrong.slice(0, 3); kept++; } else rejected++;
    }
    done += batch.length;
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log('  ' + done + '/' + todo.length + ' … kept ' + kept + ', rejected ' + rejected);
    await sleep(400);
  }
  console.log('\nWrote ' + OUT + ' with ' + Object.keys(out).length + ' words.');
  console.log('Spot-check a few, then run: node build_app.js');
  const sample = Object.keys(out).slice(0, 8);
  for (const id of sample) { const w = WORDS.find(x => x.id === id); console.log('  ' + w.h + '  ' + w.t + '  →  ' + out[id].join(' , ')); }
})();
