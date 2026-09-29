// AI weekly summary for parents.
// Everything here is optional: with no AI_API_KEY set, enabled() is false and the
// rest of the app behaves exactly as it did before.
//
// Privacy note: the child's NAME IS NEVER SENT to the model. The prompt uses the
// token {{NAME}} and we substitute the real name locally on the way out.
const fs = require('fs');
const path = require('path');

/* ---------- word list (same ids the client builds: w0001, w0002, ...) ---------- */
const WORDS = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'words_min.json'), 'utf8'));
    return raw.map(([h, t, l], i) => ({ id: 'w' + String(i + 1).padStart(4, '0'), h, t, lvl: l }));
  } catch (e) { console.error('ai: words_min.json not readable —', e.message); return []; }
})();
const BY_ID = {}; for (const w of WORDS) BY_ID[w.id] = w;

/* ---------- the same 16 phonics features the report uses ---------- */
const SKILL_FEATS = [
  ['Kamatz — the "aw" sound', h => /ָ/.test(h)],
  ['Patach — the "ah" sound', h => /ַ/.test(h)],
  ['Tzeirei — the "ay" sound', h => /ֵ/.test(h)],
  ['Segol — the "eh" sound', h => /ֶ/.test(h)],
  ['Sheva', h => /ְ/.test(h)],
  ['Chirik — the "ee" sound', h => /ִ/.test(h)],
  ['Cholam — the "oh" sound', h => /[ֹֺ]/.test(h)],
  ['Shuruk & Kubutz — the "oo" sound', h => /ֻ/.test(h) || /וּ/.test(h)],
  ['Chataf (short) vowels', h => /[ֱ-ֳ]/.test(h)],
  ['Shin vs Sin dots', h => /שׂ/.test(h)],
  ['Veis — ב without a dagesh ("v")', h => /ב(?!ּ)/.test(h)],
  ['Chaf — כ without a dagesh ("kh")', h => /[ך]|כ(?!ּ)/.test(h)],
  ['Fey — פ without a dagesh ("f")', h => /[ף]|פ(?!ּ)/.test(h)],
  ['Sav — ת without a dagesh ("s")', h => /ת(?!ּ)/.test(h)],
  ['Final letters (ם ן ץ ף ך)', h => /[םןץףך]/.test(h)],
  ['Longer words (5+ letters)', h => h.replace(/[^א-ת]/g, '').length >= 5],
];

const SUBJECT_LABEL = { kriah: 'kriah', siddur: 'siddur', tehillim: 'Tehillim', chumash: 'Chumash', mishna: 'Mishnayos', gemara: 'Gemara' };

function dayKeysBack(n, from) {
  const out = []; const d = from ? new Date(from) : new Date();
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
const r1 = x => Math.round(x * 10) / 10;
const pct = x => Math.round(x * 100);

/* ---------- turn one family's state blob into a compact set of facts ---------- */
function buildDigest(state) {
  if (!state || typeof state !== 'object') return null;
  const stats = state.stats || {}, acc = state.acc || {}, time = state.time || {};
  const settings = state.settings || {};

  // --- practice minutes, this week vs the week before
  const wk = dayKeysBack(7), prev = dayKeysBack(7, Date.now() - 7 * 864e5);
  const mins = ks => Math.round(ks.reduce((s, k) => s + (+time[k] || 0), 0) / 60);
  const daysOn = ks => ks.filter(k => (+time[k] || 0) > 0).length;
  const accOf = ks => { let n = 0, c = 0, s = 0; for (const k of ks) { const a = acc[k]; if (a && a.n) { n += a.n; c += a.c; s += (a.s || 0); } } return { n, c, s }; };
  const aW = accOf(wk), aP = accOf(prev);

  // --- per-word signals
  const rows = [];
  for (const [id, st] of Object.entries(stats)) {
    const w = BY_ID[id]; if (!w || !st || !st.n) continue;
    rows.push({ w, n: st.n, life: st.c / st.n, now: typeof st.r === 'number' ? st.r : 0.5 });
  }
  const shortW = x => ({ heb: x.w.h, say: x.w.t });
  const struggling = rows.filter(x => x.n >= 3 && x.now < 0.5).sort((a, b) => a.now - b.now).slice(0, 8).map(shortW);
  const slipping = rows.filter(x => x.n >= 4 && x.life - x.now >= 0.25).sort((a, b) => (b.life - b.now) - (a.life - a.now)).slice(0, 5).map(shortW);
  const improving = rows.filter(x => x.n >= 4 && x.now - x.life >= 0.2 && x.now >= 0.5).sort((a, b) => (b.now - b.life) - (a.now - a.life)).slice(0, 5).map(shortW);

  // --- phonics skills, measured against the child's own average
  const attempted = rows.filter(x => x.n >= 2);
  let N = 0, C = 0; for (const x of attempted) { N += x.n; C += Math.round(x.life * x.n); }
  const skills = { ready: N >= 30, weak: [], strong: [] };
  if (skills.ready) {
    const overall = C / N;
    for (const [name, test] of SKILL_FEATS) {
      let n = 0, c = 0, words = 0;
      for (const x of attempted) if (test(x.w.h)) { n += x.n; c += Math.round(x.life * x.n); words++; }
      if (words >= 4 && n >= 12) {
        const delta = c / n - overall;
        const row = { skill: name, accuracy: pct(c / n), vsHisAverage: pct(delta), words };
        if (delta <= -0.07) skills.weak.push(row);
        else if (delta >= 0.07) skills.strong.push(row);
      }
    }
    skills.weak.sort((a, b) => a.vsHisAverage - b.vsHisAverage);
    skills.strong.sort((a, b) => b.vsHisAverage - a.vsHisAverage);
    skills.weak = skills.weak.slice(0, 3); skills.strong = skills.strong.slice(0, 2);
    skills.overallAccuracy = pct(overall);
  } else skills.answersStillNeeded = 30 - N;

  // --- where the time went this week
  const subj = {};
  for (const [k, d] of Object.entries(state.timeAct || {})) if (wk.includes(k))
    for (const [b, v] of Object.entries(d || {})) subj[SUBJECT_LABEL[b] || b] = (subj[SUBJECT_LABEL[b] || b] || 0) + Math.round((+v || 0) / 60);

  const d = {
    goalMinutesPerDay: +settings.goalMin || 15,
    thisWeek: { minutes: mins(wk), daysPracticed: daysOn(wk) },
    weekBefore: { minutes: mins(prev), daysPracticed: daysOn(prev) },
    minutesBySubjectThisWeek: subj,
    struggling, slipping, improving, skills,
  };
  if (aW.n >= 10) { d.thisWeek.accuracy = pct(aW.c / aW.n); d.thisWeek.answers = aW.n; if (aW.s) d.thisWeek.secondsPerAnswer = r1(aW.s / aW.n); }
  if (aP.n >= 10) { d.weekBefore.accuracy = pct(aP.c / aP.n); if (aP.s) d.weekBefore.secondsPerAnswer = r1(aP.s / aP.n); }

  // nothing worth writing about
  if (!d.thisWeek.minutes && !d.weekBefore.minutes && !struggling.length) return null;
  return d;
}

/* ---------- the model call ---------- */
function enabled() { return !!process.env.AI_API_KEY; }

let MODEL_CACHE = null;
async function pickModel() {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (MODEL_CACHE) return MODEL_CACHE;
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=50', {
      headers: { 'x-api-key': process.env.AI_API_KEY, 'anthropic-version': '2023-06-01' }
    });
    if (r.ok) {
      const j = await r.json();
      const ids = (j.data || []).map(m => m.id);
      // prefer the cheapest current small model, else whatever is newest
      MODEL_CACHE = ids.find(x => /haiku/i.test(x)) || ids[0] || null;
    }
  } catch (e) { console.error('ai: model list failed —', e.message); }
  return MODEL_CACHE || 'claude-3-5-haiku-latest';
}

const SYSTEM = [
  'You write the weekly progress note for a parent using My Torah Helper, an app where children practise kriah (Hebrew reading), siddur, Chumash, Mishnayos and Gemara.',
  'You are given measured statistics about one child. Write 4 to 6 short sentences to the parent.',
  '',
  'Rules:',
  '- Refer to the child only as {{NAME}} — write that token literally, it gets replaced.',
  '- Use the actual numbers you are given. Never invent a number, a word, or a skill that is not in the data.',
  '- Say one specific thing worth praising and one specific thing to work on this week. If the data supports naming Hebrew words to drill, name two or three of them.',
  '- "vsHisAverage" is percentage points relative to this child\'s own overall accuracy, not other children. Compare him only to himself.',
  '- If he practised very little this week, be kind about it and suggest one small concrete step. Never guilt the parent.',
  '- Plain warm English, no headings, no bullet points, no emoji, no markdown. Write it as a short paragraph a busy parent reads in fifteen seconds.',
  '- Do not give halachic rulings or religious instruction. You are reporting on reading practice only.',
].join('\n');

async function generate(digest) {
  if (!enabled()) return { off: true };
  const model = await pickModel();
  const body = {
    model, max_tokens: 400, system: SYSTEM,
    messages: [{ role: 'user', content: 'Here is this week\'s data for one child:\n\n' + JSON.stringify(digest, null, 1) }]
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.AI_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error('anthropic ' + r.status + ': ' + t.slice(0, 300)); }
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!text) throw new Error('anthropic returned no text');
  return { text, model };
}

/* week key like 2026-W36 — the cache/send unit */
function weekKey(d) {
  const t = d ? new Date(d) : new Date();
  const day = (t.getUTCDay() + 6) % 7;            // Monday = 0
  t.setUTCDate(t.getUTCDate() - day + 3);          // nearest Thursday
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function withName(text, name) { return String(text).replace(/\{\{\s*NAME\s*\}\}/g, (name || '').trim() || 'your child'); }

module.exports = { WORDS, buildDigest, generate, enabled, weekKey, withName, pickModel };
