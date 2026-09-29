#!/usr/bin/env node
/* Replay a test-lab bundle against the matcher.
 *
 *   node labreplay.js voicelab-XXXX.json [voicematch.js ...]
 *
 * The bundle holds every calibration attempt (the child's or parent's clip, plus
 * which word it was meant to be) and the family's reference recordings. This
 * decodes them all with ffmpeg and re-runs the comparison locally, so a change to
 * voicematch.js can be judged on real readings — the same attempts, scored again —
 * instead of on a fresh round of testing by hand. Give it several matcher files and
 * it scores each one on the identical data.
 */
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');

function loadMatcher(file) {
  const src = fs.readFileSync(file, 'utf8');
  const mod = {};
  new Function('module', 'exports', 'window', 'API', 'familyCode', 'REC',
    src + '\nmodule.exports={vmFeatures,vmDTW};')(mod, {}, {}, '', () => '', {});
  return mod.exports;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'labreplay-'));
function decode(b64, mime) {
  const ext = (mime || '').includes('mp4') ? 'm4a' : (mime || '').includes('wav') ? 'wav' : 'webm';
  const src = path.join(TMP, 'in.' + ext), out = path.join(TMP, 'out.wav');
  fs.writeFileSync(src, Buffer.from(b64, 'base64'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ac', '1', '-ar', '16000', out]);
  return readWav(out);
}
function readWav(p) {
  const b = fs.readFileSync(p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { sr: b.readUInt32LE(off + 12) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + sz);
    off += 8 + sz + (sz & 1);
  }
  const n = data.length / 2, f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = data.readInt16LE(i * 2) / 32768;
  return { numberOfChannels: 1, length: n, sampleRate: fmt.sr, getChannelData: () => f };
}

const bundle = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const matchers = process.argv.slice(3);
if (!matchers.length) matchers.push(path.join(__dirname, 'voicematch.js'));

const attempts = (bundle.attempts || []).filter(a => a.audio);
const refIds = Object.keys(bundle.reference || {});
console.log(`\n${attempts.length} attempts · ${refIds.length} reference recordings · family ${bundle.family}`);
if (!attempts.length) { console.log('Nothing to replay.'); process.exit(0); }

const audio = {};
for (const a of attempts) { try { audio['A:' + a.id] = decode(a.audio, a.mime); } catch (e) { console.log('  ! could not decode attempt ' + a.id + ': ' + e.message); } }
for (const id of refIds) { try { audio['R:' + id] = decode(bundle.reference[id].audio, bundle.reference[id].mime); } catch (e) { console.log('  ! could not decode reference ' + id); } }

const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const median = xs => xs.length ? xs.slice().sort((a, b) => a - b)[xs.length >> 1] : null;
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

for (const file of matchers) {
  const { vmFeatures, vmDTW } = loadMatcher(file);
  const F = {};
  const feats = k => (k in F) ? F[k] : (F[k] = audio[k] ? vmFeatures(audio[k]) : null);

  const byTag = {};
  for (const a of attempts) {
    const mine = feats('A:' + a.id); if (!mine) continue;
    // score against exactly the words this attempt was originally scored against,
    // so a change to the matcher is the only thing that differs
    let rows = []; try { rows = JSON.parse(a.rows || '[]'); } catch (e) {}
    const ids = rows.map(r => r.id).filter(id => audio['R:' + id]);
    if (ids.length < 2 || !ids.includes(a.word)) continue;
    const d = {};
    for (const id of ids) { const f = feats('R:' + id); d[id] = f ? vmDTW(mine, f) : Infinity; }
    const target = d[a.word];
    const wrong = ids.filter(i => i !== a.word).map(i => d[i]);
    const best = Math.min(...wrong);
    const rank = 1 + wrong.filter(x => x < target).length;
    const t = (a.tag || 'untagged') + (a.truth === 'wrong' ? ' · said another word' : '');
    (byTag[t] = byTag[t] || []).push({ rank, target, best, gap: best - target, was: a.rank, heb: a.heb, truth: a.truth });
  }

  const all = Object.values(byTag).flat();
  console.log('\n=== ' + path.basename(file) + ' ===');
  if (!all.length) { console.log('  nothing replayable (the reference recordings for these words are missing)'); continue; }
  const line = (label, rs) => {
    // for deliberately-wrong readings, "success" is the target NOT coming first
    const wrongSet = rs.length && rs[0].truth === 'wrong';
    const wins = rs.filter(r => wrongSet ? r.rank !== 1 : r.rank === 1);
    console.log('  ' + label.padEnd(14) +
      ((wrongSet ? 'rejected ' : 'rank-1 ') + pct(wins.length, rs.length) + '%').padEnd(15) +
      ('(' + wins.length + '/' + rs.length + ')').padEnd(9) +
      'median gap ' + (median(wins.map(r => r.gap)) || 0).toFixed(3) +
      '   avg right ' + mean(rs.map(r => r.target)).toFixed(2) +
      '   avg wrong ' + mean(rs.map(r => r.best)).toFixed(2) +
      '   separation ' + (mean(rs.map(r => r.best)) - mean(rs.map(r => r.target))).toFixed(3));
  };
  for (const t of Object.keys(byTag)) line(t, byTag[t]);
  const readings = all.filter(r => r.truth !== 'wrong');
  if (Object.keys(byTag).length > 1 && readings.length) line('ALL readings', readings);
  const moved = all.filter(r => r.was && r.rank !== r.was).length;
  console.log('  ' + moved + ' of ' + all.length + ' attempts changed rank versus what the app recorded at the time');
  const bad = readings.filter(r => r.rank > 1).sort((a, b) => b.rank - a.rank).slice(0, 6);
  if (bad.length) console.log('  worst: ' + bad.map(r => r.heb + ' (' + r.rank + ')').join('  '));
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
