const fs=require('fs');
const terser=require('terser');
const YEAR=new Date().getFullYear();
const BANNER=`My Torah Helper — © ${YEAR} My Torah Helper LLC. All rights reserved.
 This application, its source code, its curated Hebrew content (word lists, tefillos,
 mishnayos, chumash, tehillim and translations) and its design are proprietary works.
 Copying, republishing, redistributing or creating derivative works from any part of
 this file is prohibited without written permission. See ${'https://mytorahhelper.com/terms.html'}`;

/* Minify only the DEPLOYED copy. app_template.html stays the readable master. */
async function minifyPage(html){
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if(!m) throw new Error('minify: could not find the app script block');
  const out = await terser.minify(m[1], {
    ecma: 2020,
    // toplevel names are referenced from inline onclick= handlers in generated
    // HTML strings, so they must NEVER be renamed or dropped.
    compress: { toplevel: false, unused: false, passes: 2, drop_debugger: true },
    mangle:   { toplevel: false },
    format:   { comments: false, preamble: '/*!\n ' + BANNER + '\n*/' }
  });
  if(out.error) throw out.error;
  if(!out.code || out.code.length < 50000) throw new Error('minify: output looks wrong (' + (out.code||'').length + ' chars)');
  let page = html.slice(0, m.index) + '<script>' + out.code + '</script>\n</body>' + html.slice(m.index + m[0].length);
  // strip build-time HTML comments and CSS comments, keep the licence banner
  page = page.replace(/<!--(?!\[if)(?!\s*!)[\s\S]*?-->/g, '');
  page = page.replace(/<style>([\s\S]*?)<\/style>/g, (_, css) =>
    '<style>' + css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*/g, '') + '</style>');
  return page;
}

const words=fs.readFileSync('words_min.json','utf8');
const stamp=new Date().toISOString().slice(0,16).replace('T',' ')+' UTC';
const raw=fs.readFileSync('app_template.html','utf8').replace('/*BUILD_STAMP*/', stamp).replace('/*WORDS_JSON*/', words).replace('/*GEMARA_JSON*/', fs.readFileSync('gemara_min.json','utf8')).replace('/*TEFILLOS_JSON*/', fs.readFileSync('tefillos.json','utf8')).replace('/*MISHNA_JSON*/', fs.readFileSync('mishnayos.json','utf8')).replace('/*MWBW_JSON*/', fs.readFileSync('mishna_wbw.json','utf8')).replace('/*DISTRACT_JSON*/', fs.existsSync('distractors.json')?fs.readFileSync('distractors.json','utf8'):'null').replace('/*VOICEMATCH_JS*/', fs.readFileSync('voicematch.js','utf8'));
/* The standard-voice recorder needs the very Rashi letters the app uses, in the
   same order, or the recording ids would not line up. Lift them out of the one
   place they are written so the two cannot drift apart. */
{
  const m = raw.match(/const RLETTERS = (\[[\s\S]*?\n\])\.map\(/);
  if(!m) throw new Error('build: could not find RLETTERS');
  const letters = eval(m[1]).map(([h,n]) => [h,n]);
  if(letters.length < 20) throw new Error('build: RLETTERS looks wrong (' + letters.length + ')');
  fs.writeFileSync('render-app/rashi_min.json', JSON.stringify(letters));
}
/* The coach's thirty lines, for the recording page — the same list the app uses,
   so a hired reader is never given a line the app will not play. */
{
  const m = raw.match(/const COACH_LINES=(\[[\s\S]*?\]);/);
  if(!m) throw new Error('build: could not find COACH_LINES');
  const lines = eval(m[1]);
  if(!Array.isArray(lines) || lines.length < 10) throw new Error('build: COACH_LINES looks wrong');
  fs.writeFileSync('render-app/coach_min.json', JSON.stringify(lines));
}
// artifact copy: no cloud (external scripts blocked there)
fs.writeFileSync('kriah-coach.html', raw.replace('/*FIREBASE_CONFIG*/','const FIREBASE_CONFIG = null;'));
const cfgBlock = `// ===================== PASTE YOUR FIREBASE CONFIG BELOW =====================
// Firebase console -> Project settings -> Your apps -> Web app -> "firebaseConfig".
// Replace null with the object, e.g.  const FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "...", ... };
const FIREBASE_CONFIG = null;
// ============================================================================`;
const tpl = raw.replace('/*FIREBASE_CONFIG*/', cfgBlock);
function liftMeta(t){ const i=t.indexOf('<link rel="preconnect"'); return i>0 ? {meta:t.slice(0,i), body:t.slice(i)} : {meta:'', body:t}; }
const head='<!doctype html>\n<!-- Uriel\'s Kriah Game. To turn on online sync, search for PASTE YOUR FIREBASE CONFIG below. -->\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="theme-color" content="#E9EDF3">\n<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>\n<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"></script>\n</head>\n<body>\n';
{ const m=liftMeta(tpl); fs.writeFileSync('index.html', head.replace('</head>', m.meta+'</head>')+m.body+'\n</body>\n</html>\n'); }
console.log('built', tpl.length);

// ---- Render build: own API instead of Firebase ----
const apiSync = fs.readFileSync('sync_api.js','utf8');
const start = raw.indexOf('/* ============ CLOUD SYNC (Firebase) ============ */');
const end = raw.indexOf('/* ============ STATE ============ */');
const renderTpl = raw.slice(0,start) + apiSync + raw.slice(end);
const renderHead='<!doctype html>\n<!--!\n'+BANNER+'\n-->\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="theme-color" content="#E9EDF3">\n<link rel="icon" href="/logo-icon.png">\n</head>\n<body>\n';
(async () => {
  const m = liftMeta(renderTpl);
  const full = renderHead.replace('</head>', m.meta + '</head>') + m.body + '\n</body>\n</html>\n';
  const min = await minifyPage(full);
  fs.writeFileSync('render-app/public/index.html', min);
  console.log('render build ok', renderTpl.includes('firebase') ? 'WARNING firebase text remains' : '',
    '| readable', full.length, '-> minified', min.length,
    '(' + Math.round(100 - 100 * min.length / full.length) + '% smaller)');
  // keep an un-minified copy for my own debugging; it is NOT deployed
  fs.writeFileSync('render_readable.html', full);
})().catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
