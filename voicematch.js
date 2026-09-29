/* ============ VOICE MATCH ============
   "Does this sound like the parent's recording of the same word?"

   We deliberately do NOT ask a speech recogniser what word it is — that forces the
   audio through a modern-Israeli-Hebrew language model that has never met שָׁוְעָתָם
   and does not expect an Ashkenazi accent. Comparing two recordings of the same word
   needs no vocabulary at all.

   The pipeline is the classic one: MFCCs describe what a sound IS (rather than who
   said it), and dynamic time warping lets a slow reading line up against a quick one.
   Everything runs on the device — no upload, no API, works offline.

   The honest weakness: the reference is an adult and the reader is a child, and
   cross-speaker matching is harder than same-speaker. Cepstral mean/variance
   normalisation and dropping the energy coefficient help; the calibration screen
   (Parental Controls → Voice → "Test the robot's ear") is there to measure whether
   what's left is good enough, rather than to assume it is.
*/
const VM = { sr: 16000, frame: 400, hop: 160, fft: 512, mels: 26, ceps: 13, loHz: 60, hiHz: 7000 };

/* ---------- FFT (iterative radix-2, in place on re/im pairs) ---------- */
function vmFFT(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/* ---------- mel filterbank ---------- */
const vmMel = hz => 2595 * Math.log10(1 + hz / 700);
const vmHz = mel => 700 * (Math.pow(10, mel / 2595) - 1);
let VM_BANK = null;
function vmBank() {
  if (VM_BANK) return VM_BANK;
  const bins = VM.fft / 2 + 1, lo = vmMel(VM.loHz), hi = vmMel(VM.hiHz);
  const pts = [];
  for (let i = 0; i < VM.mels + 2; i++) pts.push(Math.floor((VM.fft + 1) * vmHz(lo + (hi - lo) * i / (VM.mels + 1)) / VM.sr));
  const bank = [];
  for (let m = 1; m <= VM.mels; m++) {
    const f = new Float32Array(bins);
    for (let k = pts[m - 1]; k < pts[m]; k++) if (pts[m] > pts[m - 1]) f[k] = (k - pts[m - 1]) / (pts[m] - pts[m - 1]);
    for (let k = pts[m]; k < pts[m + 1]; k++) if (pts[m + 1] > pts[m]) f[k] = (pts[m + 1] - k) / (pts[m + 1] - pts[m]);
    bank.push(f);
  }
  return VM_BANK = bank;
}

/* ---------- mono + resample to 16k ---------- */
function vmMono(buf) {
  const ch = buf.numberOfChannels, n = buf.length, src = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) src[i] += d[i] / ch; }
  if (Math.abs(buf.sampleRate - VM.sr) < 1) return src;
  const ratio = buf.sampleRate / VM.sr, out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    out[i] = (src[i0] || 0) * (1 - f) + (src[i0 + 1] || 0) * f;
  }
  return out;
}

/* ---------- signal -> MFCC frames ---------- */
function vmMFCC(sig) {
  // pre-emphasis lifts the quieter high frequencies that carry consonants
  const s = new Float32Array(sig.length);
  for (let i = sig.length - 1; i > 0; i--) s[i] = sig[i] - 0.97 * sig[i - 1];
  s[0] = sig[0];

  const win = new Float32Array(VM.frame);
  for (let i = 0; i < VM.frame; i++) win[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (VM.frame - 1));

  const bank = vmBank(), bins = VM.fft / 2 + 1, frames = [], energy = [];
  for (let off = 0; off + VM.frame <= s.length; off += VM.hop) {
    const re = new Float32Array(VM.fft), im = new Float32Array(VM.fft);
    let e = 0;
    for (let i = 0; i < VM.frame; i++) { const v = s[off + i] * win[i]; re[i] = v; e += v * v; }
    energy.push(Math.log(e + 1e-10));
    vmFFT(re, im);
    const pow = new Float32Array(bins);
    for (let k = 0; k < bins; k++) pow[k] = (re[k] * re[k] + im[k] * im[k]) / VM.fft;
    const mel = new Float32Array(VM.mels);
    for (let m = 0; m < VM.mels; m++) { let sum = 0; const f = bank[m]; for (let k = 0; k < bins; k++) sum += f[k] * pow[k]; mel[m] = Math.log(sum + 1e-10); }
    // DCT-II, keeping coefficients 1..12 — dropping c0 throws away loudness,
    // which is exactly the part that differs between a parent and a child.
    const c = new Float32Array(VM.ceps - 1);
    for (let j = 1; j < VM.ceps; j++) { let sum = 0; for (let m = 0; m < VM.mels; m++) sum += mel[m] * Math.cos(Math.PI * j * (m + 0.5) / VM.mels); c[j - 1] = sum; }
    frames.push(c);
  }
  return { frames, energy };
}

/* ---------- drop the silence at each end ---------- */
function vmTrim(mf) {
  const e = mf.energy; if (!e.length) return mf.frames;
  const max = Math.max(...e), min = Math.min(...e), thr = min + (max - min) * 0.25;
  let a = 0, b = e.length - 1;
  while (a < b && e[a] < thr) a++;
  while (b > a && e[b] < thr) b--;
  a = Math.max(0, a - 3); b = Math.min(e.length - 1, b + 3);       // keep a little air
  return mf.frames.slice(a, b + 1);
}

/* ---------- normalise away the speaker's average voice ---------- */
function vmNorm(frames) {
  if (!frames.length) return frames;
  const d = frames[0].length, mean = new Float32Array(d), sd = new Float32Array(d);
  for (const f of frames) for (let i = 0; i < d; i++) mean[i] += f[i] / frames.length;
  for (const f of frames) for (let i = 0; i < d; i++) sd[i] += (f[i] - mean[i]) ** 2 / frames.length;
  for (let i = 0; i < d; i++) sd[i] = Math.sqrt(sd[i]) || 1;
  return frames.map(f => { const o = new Float32Array(d); for (let i = 0; i < d; i++) o[i] = (f[i] - mean[i]) / sd[i]; return o; });
}

function vmFeatures(audioBuffer) { return vmNorm(vmTrim(vmMFCC(vmMono(audioBuffer)))); }

/* ---------- dynamic time warping ---------- */
function vmDTW(A, B) {
  const n = A.length, m = B.length;
  if (!n || !m) return Infinity;
  // The band must follow the DIAGONAL, not the line i=j: a child reading twice as
  // slowly makes one sequence much longer, and a band centred on i=j then excludes
  // the end corner entirely and every distance comes back as infinity.
  const band = Math.max(12, Math.floor(Math.max(n, m) * 0.3));     // a reading can be slower, not reordered
  const slope = m / n;
  const d = A[0].length;
  let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const centre = Math.round(i * slope);
    const lo = Math.max(1, centre - band), hi = Math.min(m, centre + band);
    for (let j = lo; j <= hi; j++) {
      let s = 0; const a = A[i - 1], b = B[j - 1];
      for (let k = 0; k < d; k++) { const x = a[k] - b[k]; s += x * x; }
      const cost = Math.sqrt(s);
      cur[j] = cost + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
  }
  const path = (n + m) / 2;
  return prev[m] / path;                                           // per-frame distance, so length doesn't skew it
}

/* ---------- public: decode + compare ---------- */
let VM_CTX = null;
function vmCtx() { return VM_CTX || (VM_CTX = new (window.AudioContext || window.webkitAudioContext)()); }
async function vmDecode(arrayBuffer) { return await vmCtx().decodeAudioData(arrayBuffer.slice(0)); }
const VM_CACHE = {};
async function vmParentFeatures(id) {
  if (VM_CACHE[id]) return VM_CACHE[id];
  const r = await fetch(API + '/audio/' + id + '?family=' + encodeURIComponent(familyCode()) + '&v=' + (REC.v || 0));
  if (!r.ok) throw new Error('no recording for ' + id);
  return VM_CACHE[id] = vmFeatures(await vmDecode(await r.arrayBuffer()));
}
/* lower = more alike */
async function vmCompare(childFeatures, id) { return vmDTW(childFeatures, await vmParentFeatures(id)); }
