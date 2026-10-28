/* =====================================================================
   Mortality Watch — death-notice monitoring for the active book.

   A port of the standalone Python tool of the same name into the
   portal, so it watches the insureds the portal already holds rather
   than a CSV export of them that drifts. The scoring rubric is carried
   over exactly — a 75 means the same thing here as it did there, and
   the Python tool's own test cases are this module's tests.

   Three layers, in this file, top to bottom:

     extract   dates, ages and places out of free-text notices.
               Conservative: anything not clearly stated is null, and the
               scorer treats unknown as zero points rather than guessing.
     score     how likely one notice refers to one person.
     sources   where notices come from: a search API, an obituary feed,
               a listing page, or a vendor's death file.

   The sweep that ties them to the database is at the bottom, and the
   routes that drive it from the Mortality Watch tab are in api.js.

   AN OBITUARY IS A LEAD, NEVER PROOF. Nothing here writes a date of
   death onto an insured. A confirmed match stops the person being
   searched and says so on the tab; the date of death is entered by hand,
   on the insured, once a certificate or the carrier confirms it.
   ===================================================================== */

import dns from 'node:dns/promises';
import net from 'node:net';
import { q, pool } from './db.js';

/* ------------------------------------------------------------------ *
 * extract
 * ------------------------------------------------------------------ */

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MONTHS = Object.fromEntries(MONTH_NAMES.map((m, i) => [m.slice(0, 3), i + 1]));

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|'
  + 'sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE_RE = `${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`;
const NUMDATE_RE = '(\\d{1,2})/(\\d{1,2})/(\\d{4})';

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase, strip accents and punctuation noise for comparisons. */
export function fold(s) {
  const t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return t.toLowerCase().replace(/[^a-z0-9,/\- ]+/g, ' ').replace('  ', ' ');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
export function unescapeHtml(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Readable text out of an HTML page: no scripts, no navigation, line breaks kept. */
export function htmlToText(raw) {
  let s = String(raw || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|nav|footer|header)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(?:p|br|div|li|h1|h2|h3|tr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = unescapeHtml(s);
  return s.replace(/\n\s*\n+/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/** An ISO date string, or null if the parts are not a real date. */
function mkdate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseNamed(m) {
  const key = m[1].toLowerCase().replace(/\.$/, '');
  const month = key.startsWith('sept') ? 9 : MONTHS[key.slice(0, 3)];
  return mkdate(Number(m[3]), month, Number(m[2]));
}

/** Every date in the text with its character position. */
export function allDates(text) {
  const found = [];
  for (const m of String(text).matchAll(new RegExp(DATE_RE, 'gi'))) {
    const d = parseNamed(m);
    if (d) found.push([m.index, d]);
  }
  for (const m of String(text).matchAll(new RegExp(NUMDATE_RE, 'g'))) {
    const d = mkdate(Number(m[3]), Number(m[1]), Number(m[2]));
    if (d) found.push([m.index, d]);
  }
  return found.sort((a, b) => a[0] - b[0]);
}

export function findDob(text) {
  let m = new RegExp(`\\bborn\\b[^.]{0,40}?${DATE_RE}`, 'i').exec(text);
  if (m) return parseNamed(new RegExp(DATE_RE, 'i').exec(m[0]));
  m = new RegExp(`\\bborn\\b[^.]{0,40}?${NUMDATE_RE}`, 'i').exec(text);
  if (m) return mkdate(Number(m[3]), Number(m[1]), Number(m[2]));
  // "(April 12, 1938 - October 21, 2026)"
  m = new RegExp(`${DATE_RE}\\s*[-–—~]\\s*${DATE_RE}`, 'i').exec(text);
  if (m) return allDates(m[0])[0]?.[1] ?? null;
  return null;
}

export function findDod(text) {
  let m = new RegExp('\\b(?:passed away|died|passed|entered (?:into )?(?:eternal )?rest|went home to be with)'
    + `\\b[^.]{0,60}?(${DATE_RE}|${NUMDATE_RE})`, 'i').exec(text);
  if (m) {
    const ds = allDates(m[1]);
    if (ds.length) return ds[0][1];
  }
  m = new RegExp(`${DATE_RE}\\s*[-–—~]\\s*${DATE_RE}`, 'i').exec(text);
  if (m) {
    const ds = allDates(m[0]);
    if (ds.length >= 2) return ds[1][1];
  }
  return null;
}

/** '(1938 - 2026)' or '1938–2026' — birth and death years. */
export function findBirthYearRange(text) {
  const m = /\b(19\d{2}|20\d{2})\s*[-–—~]\s*(20\d{2})\b/.exec(text);
  if (m && Number(m[1]) < Number(m[2])) return [Number(m[1]), Number(m[2])];
  return null;
}

export function findAge(text) {
  for (const pat of [/\bage[ds]?\s*:?\s*(\d{2,3})\b/i, /\bat the age of\s+(\d{2,3})\b/i,
    /,\s*(\d{2,3}),\s*(?:of|formerly of|passed|died)\b/i, /\b(\d{2,3})\s+years? old\b/i]) {
    const m = pat.exec(text);
    if (m && Number(m[1]) >= 18 && Number(m[1]) <= 115) return Number(m[1]);
  }
  return null;
}

export function mentionsState(text, state) {
  if (!state) return false;
  const st = String(state).toUpperCase();
  const full = STATES[st];
  if (full && new RegExp(`\\b${reEscape(full)}\\b`, 'i').test(text)) return true;
  // Two-letter codes collide with words (IN, OR, ME) — only count "City, ST" form.
  return new RegExp(`[A-Za-z]+,\\s*${reEscape(st)}\\b`).test(text);
}

export function mentionsCity(text, city, state = null) {
  if (!city) return false;
  const t = fold(text);
  const c = fold(city).trim();
  if (!new RegExp(`\\b${reEscape(c)}\\b`).test(t)) return false;
  if (!state) return true;
  // Require the state near the city, so "Springfield" doesn't match every Springfield.
  const st = String(state).toUpperCase();
  const full = fold(STATES[st] || st).trim();
  const near = new RegExp(`\\b${reEscape(c)}\\b[ ,]{1,3}(${reEscape(st.toLowerCase())}|${reEscape(full)})\\b`)
    .test(t);
  return near || (mentionsState(text, state) && t.length < 4000);
}

/** 'Toledo, OH' -> ['Toledo', 'OH']; 'Toledo OH' also works. */
export function parsePrior(prior) {
  const p = String(prior || '').trim();
  if (!p) return ['', ''];
  const m = /^(.+?)[,\s]+([A-Za-z]{2})$/.exec(p);
  return m ? [m[1].trim(), m[2].toUpperCase()] : [p, ''];
}

/* ------------------------------------------------------------------ *
 * The person being watched
 *
 * Built from a watch_people row. `name` is the full legal name, "First
 * Middle Last"; the rest are the details the scorer leans on, held on
 * the watch record because the portal's insured record does not carry
 * them.
 * ------------------------------------------------------------------ */
export function person(row) {
  const name = String(row.name || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const aka = String(row.aka || '');
  const akaEntries = aka.split(';').map((a) => a.trim()).filter(Boolean);
  const maiden = [];
  for (const a of akaEntries) {
    const low = a.toLowerCase();
    for (const prefix of ['née ', 'nee ', 'maiden ', 'born '])
      if (low.startsWith(prefix)) maiden.push(a.slice(prefix.length).trim());
  }
  const familyNames = (...labels) => {
    const out = [];
    for (const part of String(row.family || '').split(';')) {
      if (!part.includes(':')) continue;
      const i = part.indexOf(':');
      const label = part.slice(0, i).trim().toLowerCase();
      if (!labels.some((l) => label.startsWith(l))) continue;
      for (const n of part.slice(i + 1).split(/,|\band\b|&/))
        if (n.trim()) out.push(n.trim().split(/\s+/)[0]);
    }
    return out;
  };
  const maidenLow = maiden.map((m) => m.toLowerCase());
  return {
    id: row.id ?? null,
    name,
    dob: row.dob ? String(row.dob instanceof Date ? row.dob.toISOString() : row.dob).slice(0, 10) : null,
    city: String(row.city || ''),
    state: String(row.state || '').toUpperCase(),
    prior_residence: String(row.prior_residence || ''),
    first: parts[0] || '',
    last: parts[parts.length - 1] || '',
    middles: parts.slice(1, -1),
    maiden_names: maiden,
    spouse_names: familyNames('spouse', 'husband', 'wife', 'partner'),
    children_names: familyNames('child', 'son', 'daughter', 'kids'),
    nicknames: akaEntries.filter((a) => !maidenLow.some((m) => a.toLowerCase().endsWith(m))
      && !a.trim().includes(' ')),
  };
}

/* ------------------------------------------------------------------ *
 * score
 *
 *   Name, up to 40   full legal name incl. middle or maiden name 40 ·
 *                    first + last 28 · nickname or initial + last 18.
 *                    No surname match -> discard.
 *   Birth, up to 35  exact date of birth 35 · birth year or stated age
 *                    consistent 20. A stated age, birth year or birth date
 *                    that conflicts -> discard.
 *   Place, up to 25  current city 25 · same state or prior-residence city
 *                    15 · prior-residence state 8.
 *   Family, up to 25 spouse named 25 · a child named 10 (cap 25).
 *
 * Capped at 100. 75+ likely · 50–74 possible · below 50 dropped.
 * ------------------------------------------------------------------ */

export const LIKELY = 75;
export const POSSIBLE = 50;

// Common English given-name variants. Keys and values are lowercase.
export const NICKNAMES = {
  margaret: ['peggy', 'maggie', 'meg', 'marge', 'margie', 'greta', 'madge'],
  elizabeth: ['liz', 'beth', 'betty', 'betsy', 'libby', 'eliza', 'lisa', 'bess'],
  william: ['bill', 'billy', 'will', 'willie', 'liam'],
  robert: ['bob', 'bobby', 'rob', 'robbie', 'bert'],
  richard: ['dick', 'rick', 'rich', 'richie'],
  james: ['jim', 'jimmy', 'jamie'],
  john: ['jack', 'johnny'],
  joseph: ['joe', 'joey'],
  charles: ['charlie', 'chuck', 'chas'],
  thomas: ['tom', 'tommy'],
  edward: ['ed', 'eddie', 'ted', 'ned'],
  harold: ['hal', 'harry'],
  henry: ['hank', 'harry'],
  bernard: ['bernie'],
  walter: ['walt', 'wally'],
  eugene: ['gene'],
  lawrence: ['larry'],
  leonard: ['len', 'lenny'],
  anthony: ['tony'],
  francis: ['frank', 'fran'],
  frederick: ['fred', 'freddie'],
  albert: ['al', 'bert'],
  alfred: ['al', 'fred'],
  raymond: ['ray'],
  donald: ['don', 'donnie'],
  ronald: ['ron', 'ronnie'],
  gerald: ['jerry', 'gerry'],
  kenneth: ['ken', 'kenny'],
  dorothy: ['dot', 'dottie', 'dolly'],
  patricia: ['pat', 'patty', 'trish'],
  barbara: ['barb', 'babs'],
  katherine: ['kate', 'kathy', 'katie', 'kay'],
  catherine: ['cathy', 'kate', 'katie', 'kay'],
  dolores: ['dee', 'lola'],
  evelyn: ['evie', 'eve', 'lyn'],
  virginia: ['ginny', 'ginger'],
  frances: ['fran', 'frannie'],
  theodore: ['ted', 'teddy', 'theo'],
  susan: ['sue', 'susie'],
  deborah: ['debbie', 'deb'],
  eleanor: ['ellie', 'nell', 'nora'],
  helen: ['nell', 'nellie'],
  mary: ['mae', 'molly', 'polly', 'mamie'],
  ann: ['annie', 'nan', 'nancy'],
  anne: ['annie', 'nan', 'nancy'],
};

function variants(first) {
  const f = first.toLowerCase();
  const out = new Set(NICKNAMES[f] || []);
  for (const [full, nicks] of Object.entries(NICKNAMES)) if (nicks.includes(f)) out.add(full);
  return out;
}

const tokens = (s) => fold(s).split(/[\s,-]+/).filter(Boolean);

function ageOn(dob, on) {
  const [y, m, d] = dob.split('-').map(Number);
  const [y2, m2, d2] = on.split('-').map(Number);
  return y2 - y - ((m2 < m || (m2 === m && d2 < d)) ? 1 : 0);
}

const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m - 1][0].toUpperCase()}${MONTH_NAMES[m - 1].slice(1)} ${d}, ${y}`;
};

const today = () => new Date().toISOString().slice(0, 10);

export const tierOf = (r) => (r.discarded_reason ? 'discarded'
  : r.score >= LIKELY ? 'likely' : r.score >= POSSIBLE ? 'possible' : 'low');

/**
 * How likely `cand` is a notice about `p`.
 *
 * `cand` is { url, source_name, title, text, published, name, dob, dod,
 * city, state } -- the last five set only by a source that already knows
 * them, like a vendor file. Dates are ISO strings.
 */
export function score(p, cand, on = today()) {
  const result = (s, factors, extra = {}) => ({ score: s, factors, discarded_reason: null,
    dod: null, obit_name: null, place: null, ...extra });
  const discard = (reason, label) => result(0, [{ label, hit: false, points: 0 }],
    { discarded_reason: reason });

  const text = `${cand.title || ''}\n${cand.text || ''}`;
  const nameZone = cand.name || `${cand.title || ''} ${(cand.text || '').slice(0, 400)}`;
  const toks = new Set(tokens(nameZone));
  const factors = [];

  // ---- Name ------------------------------------------------------------
  const surnames = [p.last, ...p.maiden_names];
  if (!surnames.some((s) => toks.has(fold(s).trim()))) return discard('surname', 'Surname not found');
  const first = fold(p.first).trim();
  const nicks = new Set([...variants(first), ...p.nicknames.map((n) => fold(n).trim())]);
  const middles = p.middles.map((m) => fold(m).trim());
  const maidenPresent = p.maiden_names.some((m) => toks.has(fold(m).trim()))
    && toks.has(fold(p.last).trim());
  const middlePresent = middles.some((m) => toks.has(m) || (m.length > 0 && toks.has(m[0])));

  let namePts;
  let label;
  const nickHit = [...toks].filter((t) => nicks.has(t)).sort();
  if (toks.has(first) && (middlePresent || maidenPresent)) {
    namePts = 40; label = `Full name${maidenPresent ? ' + maiden name' : ''}`;
  } else if (toks.has(first)) {
    namePts = 28; label = 'First + last name';
  } else if (nickHit.length) {
    namePts = 18; label = `Nickname '${nickHit[0][0].toUpperCase()}${nickHit[0].slice(1)}'`;
  } else if (toks.has(first.slice(0, 1))) {
    namePts = 18; label = 'First initial + last name';
  } else {
    return discard('first_name', 'First name differs');
  }
  factors.push({ label, hit: true, points: namePts });
  if (middles.length && !middlePresent && !maidenPresent)
    factors.push({ label: 'No middle name given', hit: false, points: 0 });

  // ---- Birth -----------------------------------------------------------
  const dod = cand.dod || findDod(text);
  const ref = dod || on;
  let birthPts = 0;
  const cDob = cand.dob || findDob(text);
  if (!p.dob) {
    factors.push({ label: `${cDob ? `Born ${longDate(cDob)} — ` : ''}no DOB on file to compare`,
      hit: false, points: 0 });
  } else if (cDob) {
    if (cDob === p.dob) {
      birthPts = 35;
      factors.push({ label: `Born ${longDate(p.dob)}`, hit: true, points: 35 });
    } else if (cDob.slice(0, 4) === p.dob.slice(0, 4)) {
      birthPts = 20;
      factors.push({ label: `Birth year ${cDob.slice(0, 4)}, different day`, hit: true, points: 20 });
    } else {
      return discard('dob_conflict', `Born ${cDob}, not a match`);
    }
  } else {
    const yr = findBirthYearRange(text);
    const age = findAge(text);
    const dobYear = Number(p.dob.slice(0, 4));
    if (yr) {
      if (Math.abs(yr[0] - dobYear) <= 1) {
        birthPts = 20;
        factors.push({ label: `Birth year ${yr[0]}`, hit: true, points: 20 });
      } else {
        return discard('year_conflict', `Birth year ${yr[0]} conflicts`);
      }
    } else if (age !== null) {
      const expected = ageOn(p.dob, ref);
      if (Math.abs(age - expected) <= 1) {
        birthPts = 20;
        factors.push({ label: `Age ${age}, consistent`, hit: true, points: 20 });
      } else {
        return discard('age_conflict', `Age ${age}, expected ${expected}`);
      }
    } else {
      factors.push({ label: 'No age or birth date', hit: false, points: 0 });
    }
  }

  // ---- Place -----------------------------------------------------------
  let placePts = 0;
  let placeLabel = null;
  const [priorCity, priorState] = parsePrior(p.prior_residence);
  const cCity = cand.city || null;
  const cState = cand.state || null;
  if (cCity || cState) { // structured source
    const st = String(cState || '').toUpperCase();
    if (cCity && fold(cCity) === fold(p.city) && st === p.state) {
      placePts = 25; placeLabel = `${p.city}, ${p.state}`;
    } else if (st === p.state) {
      placePts = 15; placeLabel = `Same state (${p.state})`;
    } else if (priorCity && cCity && fold(cCity) === fold(priorCity)) {
      placePts = 15; placeLabel = `Prior residence ${priorCity}`;
    } else if (priorState && st === priorState) {
      placePts = 8; placeLabel = `Prior state (${priorState})`;
    }
  } else if (mentionsCity(text, p.city, p.state)) {
    placePts = 25; placeLabel = `${p.city}, ${p.state}`;
  } else {
    const prior = priorCity && mentionsCity(text, priorCity, priorState);
    if (mentionsState(text, p.state) || prior) {
      placePts = 15;
      placeLabel = prior ? `Prior residence ${priorCity}` : `Same state (${p.state})`;
    } else if (priorState && mentionsState(text, priorState)) {
      placePts = 8; placeLabel = `Prior state (${priorState})`;
    }
  }
  factors.push({ label: placeLabel || 'Place not mentioned', hit: !!placeLabel, points: placePts });

  // ---- Family ----------------------------------------------------------
  let familyPts = 0;
  const body = new Set(tokens(text));
  for (const sp of p.spouse_names) {
    if (body.has(fold(sp).trim())) {
      familyPts = 25;
      factors.push({ label: `Spouse ${sp} named`, hit: true, points: 25 });
      break;
    }
  }
  const kids = p.children_names.filter((c) => body.has(fold(c).trim()));
  if (kids.length && familyPts < 25) {
    familyPts = Math.min(25, familyPts + 10);
    factors.push({ label: `Child ${kids[0]} named`, hit: true, points: 10 });
  }
  if ((p.spouse_names.length || p.children_names.length) && !familyPts)
    factors.push({ label: 'No family names on file found', hit: false, points: 0 });

  const place = (cCity ? `${cCity}, ${cState}` : cState) || placeLabel;
  return result(Math.min(100, namePts + birthPts + placePts + familyPts), factors, {
    dod,
    obit_name: (cand.name || String(cand.title || '').split(' Obituary')[0].split(' - ')[0].trim())
      .slice(0, 120),
    place,
  });
}

/* ------------------------------------------------------------------ *
 * Fetching other people's web pages
 *
 * An administrator can add any address as a source, and a listing page
 * hands over links to wherever it likes -- so this is a server fetching
 * URLs it was given. Two guards, both on every request:
 *
 *   No private addresses. Loopback, link-local (the cloud metadata
 *   service lives there), and the private ranges are refused after the
 *   name is resolved, so a link to http://169.254.169.254 or to a name
 *   that resolves inside the network does not reach it. Tests switch
 *   this off with MW_ALLOW_PRIVATE_FETCH=1, and nothing else does.
 *
 *   Politeness. One request per host per second, a timeout, and a cap
 *   on how much of a page is read.
 * ------------------------------------------------------------------ */

const USER_AGENT = 'PolicyHub-MortalityWatch/1.0 (life-settlement servicing)';
const lastCall = new Map();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const low = ip.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc')
    || low.startsWith('fd') || low.startsWith('::ffff:') && privateAddress(low.slice(7));
}

async function assertPublic(url) {
  if (process.env.MW_ALLOW_PRIVATE_FETCH === '1') return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address)))
    throw new Error(`refusing to fetch a private address (${host})`);
}

/* One request per host per second. MW_MIN_INTERVAL_MS lowers it for the
   test suite, whose stand-in sites are all one local host. */
const POLITE_MS = () => {
  const v = Number(process.env.MW_MIN_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1000;
};

export async function httpGet(rawUrl, { params = null, headers = {}, timeoutMs = 20000,
  minIntervalMs = POLITE_MS(), maxBytes = 3_000_000 } = {}) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`not a web address: ${rawUrl}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  await assertPublic(url);
  const wait = minIntervalMs - (Date.now() - (lastCall.get(url.host) || 0));
  if (wait > 0) await sleep(wait);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    /* Redirects are followed by hand so each hop is checked against the
       same private-address rule; fetch's own following would not be. */
    let res;
    let at = url;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(at, { headers: { 'User-Agent': USER_AGENT, ...headers },
        redirect: 'manual', signal: ctl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        at = new URL(res.headers.get('location'), at);
        await assertPublic(at);
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= maxBytes) { await reader.cancel(); break; }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString('utf8');
  } finally {
    clearTimeout(timer);
    lastCall.set(url.host, Date.now());
  }
}

const httpJson = async (url, opts) => JSON.parse(await httpGet(url, opts));

/* ------------------------------------------------------------------ *
 * sources
 *
 * Each kind takes its settings from a watch_sources row and offers
 * `begin()` (once per sweep: fetch a feed, a listing page), `search(p)`
 * (notices that might be about one person) and `end()`. They are held in
 * the database and edited on the tab, rather than in a config file,
 * because Render's disk is not somewhere a file survives a deploy.
 * ------------------------------------------------------------------ */

const surnamesOf = (p) => [fold(p.last).trim(), ...p.maiden_names.map((m) => fold(m).trim())];
const hasSurname = (text, p) => {
  const t = fold(text);
  return surnamesOf(p).some((s) => s && new RegExp(`\\b${reEscape(s)}\\b`).test(t));
};

/** The search queries for one person, most specific first. */
export function buildQueries(p, maxQueries = 5) {
  const by = p.dob ? p.dob.slice(0, 4) : '';
  const place = [p.city, p.state].filter(Boolean).join(' ');
  const qs = [`"${p.first} ${p.last}" obituary ${place}`.trim()];
  if (p.middles.length) qs.push(`"${p.first} ${p.middles[0]} ${p.last}" obituary ${by}`.trim());
  else if (by) qs.push(`"${p.first} ${p.last}" obituary ${by}`);
  for (const maiden of p.maiden_names) qs.push(`"${p.first}" "${maiden}" "${p.last}" obituary`);
  for (const nick of p.nicknames) qs.push(`"${nick} ${p.last}" obituary ${p.state}`.trim());
  if (p.prior_residence) qs.push(`"${p.first} ${p.last}" obituary ${p.prior_residence}`);
  for (const sp of p.spouse_names.slice(0, 1)) qs.push(`"${p.first} ${p.last}" "${sp}" obituary`);
  return [...new Set(qs)].slice(0, maxQueries);
}

export const PROVIDERS = {
  brave: { env: 'BRAVE_API_KEY', label: 'Brave Search' },
  google_cse: { env: 'GOOGLE_API_KEY', label: 'Google Programmable Search' },
  serpapi: { env: 'SERPAPI_KEY', label: 'SerpAPI' },
};

/* The provider addresses, overridable so a test can stand one up
   locally. Never set in production. */
const ENDPOINT = {
  brave: () => process.env.MW_BRAVE_URL || 'https://api.search.brave.com/res/v1/web/search',
  google_cse: () => process.env.MW_GOOGLE_URL || 'https://www.googleapis.com/customsearch/v1',
  serpapi: () => process.env.MW_SERPAPI_URL || 'https://serpapi.com/search.json',
};

export const keyPresent = (provider) => !!process.env[PROVIDERS[provider]?.env || ''];

class WebSearch {
  constructor(row, log) {
    const o = row.options || {};
    this.name = row.name;
    this.log = log;
    this.provider = o.provider || 'brave';
    this.key = process.env[PROVIDERS[this.provider]?.env || ''] || '';
    this.cx = o.cx || '';
    this.domains = Array.isArray(o.domains) ? o.domains.filter(Boolean) : [];
    this.maxResults = Number(o.max_results) || 8;
    this.maxQueries = Number(o.max_queries) || (this.domains.length ? 2 : 5);
    this.fetchPages = o.fetch_pages !== false;
    this.maxFetch = Number(o.max_fetch) || 4;
    this.freshnessDays = Number(o.freshness_days) || 120;
    this.queries = 0;
  }

  async begin() {
    if (!this.key) this.log(`${this.name}: no ${PROVIDERS[this.provider]?.env || 'API'} key on the server, so this source found nothing`);
  }

  async query(text) {
    const qtext = this.domains.length
      ? `${text} (${this.domains.map((d) => `site:${d}`).join(' OR ')})` : text;
    this.queries += 1;
    if (this.provider === 'brave') {
      const to = today();
      const from = new Date(Date.now() - this.freshnessDays * 864e5).toISOString().slice(0, 10);
      const data = await httpJson(ENDPOINT.brave(), {
        params: { q: qtext, count: this.maxResults, freshness: `${from}to${to}` },
        headers: { 'X-Subscription-Token': this.key, Accept: 'application/json' } });
      return (data.web?.results || []).map((r) => ({ title: r.title || '', url: r.url,
        snippet: r.description || '', date: r.age || null }));
    }
    if (this.provider === 'google_cse') {
      const data = await httpJson(ENDPOINT.google_cse(), {
        params: { q: qtext, key: this.key, cx: this.cx, num: Math.min(10, this.maxResults),
          dateRestrict: `d${this.freshnessDays}` } });
      return (data.items || []).map((r) => ({ title: r.title || '', url: r.link,
        snippet: r.snippet || '', date: null }));
    }
    if (this.provider === 'serpapi') {
      const data = await httpJson(ENDPOINT.serpapi(), {
        params: { q: qtext, api_key: this.key, num: this.maxResults } });
      return (data.organic_results || []).map((r) => ({ title: r.title || '', url: r.link,
        snippet: r.snippet || '', date: r.date || null }));
    }
    throw new Error(`unknown search provider ${this.provider}`);
  }

  async search(p) {
    if (!this.key) return [];
    const hits = new Map();
    for (const qtext of buildQueries(p, this.maxQueries)) {
      try {
        for (const r of await this.query(qtext)) if (r.url && !hits.has(r.url)) hits.set(r.url, r);
      } catch (e) {
        this.log(`${this.name}: a query failed (${e.message})`);
      }
    }
    const surnames = surnamesOf(p);
    const out = [];
    let fetched = 0;
    for (const [url, r] of hits) {
      const blob = fold(`${r.title} ${r.snippet}`);
      if (!surnames.some((s) => s && blob.includes(s))) continue;
      let text = r.snippet;
      if (this.fetchPages && fetched < this.maxFetch) {
        try {
          text = `${text}\n${htmlToText(await httpGet(url)).slice(0, 20000)}`;
          fetched += 1;
        } catch { /* the snippet alone is still worth scoring */ }
      }
      out.push({ url, source_name: this.name, title: r.title, text, published: r.date });
    }
    return out;
  }

  async end() {}
}

/** Pull <tag>…</tag> text out of an XML fragment, CDATA unwrapped. */
const xmlText = (block, tag) => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return '';
  return unescapeHtml(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
};

class Rss {
  constructor(row, log) {
    const o = row.options || {};
    this.name = row.name;
    this.url = o.url;
    this.fetchPages = o.fetch_pages !== false;
    this.log = log;
    this.items = [];
  }

  async begin() {
    this.items = [];
    let xml;
    try { xml = await httpGet(this.url); } catch (e) {
      this.log(`${this.name}: feed unavailable (${e.message})`);
      return;
    }
    for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      this.items.push({ title: xmlText(m[1], 'title'), url: xmlText(m[1], 'link'),
        text: htmlToText(xmlText(m[1], 'description')), date: xmlText(m[1], 'pubDate') || null });
    }
    for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
      const link = /<link\b[^>]*href="([^"]*)"/i.exec(m[1]);
      this.items.push({ title: xmlText(m[1], 'title'), url: link ? unescapeHtml(link[1]) : '',
        text: htmlToText(xmlText(m[1], 'summary') || xmlText(m[1], 'content')),
        date: xmlText(m[1], 'updated') || null });
    }
  }

  async search(p) {
    const out = [];
    for (const it of this.items) {
      if (!hasSurname(it.title, p)) continue;
      let { text } = it;
      if (this.fetchPages && it.url) {
        try { text += `\n${htmlToText(await httpGet(it.url)).slice(0, 20000)}`; } catch { /* keep the summary */ }
      }
      out.push({ url: it.url || `${this.url}#${it.title}`, source_name: this.name,
        title: it.title, text, published: it.date });
    }
    return out;
  }

  async end() {}
}

class ListingPage {
  constructor(row, log) {
    this.name = row.name;
    this.url = (row.options || {}).url;
    this.log = log;
    this.links = [];
  }

  async begin() {
    this.links = [];
    let html;
    try { html = await httpGet(this.url); } catch (e) {
      this.log(`${this.name}: listing page unavailable (${e.message})`);
      return;
    }
    for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      try { this.links.push([new URL(unescapeHtml(m[1]), this.url).href, text]); } catch { /* not a link */ }
    }
  }

  async search(p) {
    const out = [];
    const seen = new Set();
    for (const [href, text] of this.links) {
      if (seen.has(href) || !(hasSurname(text, p) || hasSurname(href.replace(/-/g, ' '), p))) continue;
      seen.add(href);
      let body = '';
      try { body = htmlToText(await httpGet(href)).slice(0, 20000); } catch { /* score the link text */ }
      out.push({ url: href, source_name: this.name, title: text, text: body });
    }
    return out;
  }

  async end() {}
}

/** "2026-10-02", "10/02/2026" or "20261002" to ISO; anything else null. */
export function parseLooseDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return mkdate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return mkdate(+m[3], +m[1], +m[2]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return mkdate(+m[1], +m[2], +m[3]);
  return null;
}

export const VENDOR_FIELDS = ['first_name', 'middle_name', 'last_name', 'dob', 'dod', 'city',
  'state', 'reference'];

/**
 * A vendor's death file, uploaded on the tab.
 *
 * Not a source in a sweep: a delivery is scored against everybody the
 * moment it arrives, because that is when somebody is looking at it.
 * `rows` are the CSV's records as objects keyed by its own headers;
 * `columns` maps our field names to them where the vendor names them
 * differently.
 */
export class VendorFile {
  constructor(name, rows, columns = {}, fileLabel = 'upload') {
    this.name = name;
    const lower = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [String(k).trim().toLowerCase(), String(v ?? '').trim()]));
    const col = Object.fromEntries(VENDOR_FIELDS.map((f) =>
      [f, String(columns[f] || f).trim().toLowerCase()]));
    this.rows = rows.map((r, i) => {
      const l = lower(r);
      const out = Object.fromEntries(VENDOR_FIELDS.map((f) => [f, l[col[f]] || '']));
      out._ref = `vendor://${fileLabel}#row${i + 2}`;
      return out;
    });
  }

  async begin() {}

  async search(p) {
    return this.rows.filter((r) => hasSurname(r.last_name, p)).map((r) => {
      const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
      return {
        url: r.reference ? `vendor://${this.name}/${r.reference}` : r._ref,
        source_name: this.name, title: name, name,
        text: `${name} died ${r.dod} in ${r.city}, ${r.state}`,
        dob: parseLooseDate(r.dob), dod: parseLooseDate(r.dod),
        city: r.city || null, state: r.state || null,
      };
    });
  }

  async end() {}
}

export const SOURCE_KINDS = {
  web_search: { label: 'Web search', make: (row, log) => new WebSearch(row, log) },
  rss: { label: 'RSS / Atom feed', make: (row, log) => new Rss(row, log) },
  page: { label: 'Listing page', make: (row, log) => new ListingPage(row, log) },
};

/** About how many paid searches one sweep costs, for the tab to say before it runs. */
export function estimateQueries(rows, people) {
  let n = 0;
  for (const r of rows) {
    if (!r.enabled || r.kind !== 'web_search') continue;
    const o = r.options || {};
    const states = (r.states || []).map((s) => s.toUpperCase());
    const max = Number(o.max_queries) || ((o.domains || []).length ? 2 : 5);
    for (const p of people) {
      if (states.length && !states.includes(String(p.state || '').toUpperCase())) continue;
      n += Math.min(max, buildQueries(person(p), max).length);
    }
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * Who is watched
 *
 * Everybody insured under a policy still in the active book whose date
 * of death has not been entered. Read from the portal on every sweep, so
 * a new policy is watched from the next morning and a matured one drops
 * out by itself.
 *
 * A joint insured is one row in the portal -- "Moe And Claire Engler" --
 * and two people to an obituary. It is split into one watch record each,
 * and neither is given the insured's date of birth: that date belongs to
 * one of them, and the scorer DISCARDS a notice whose birth date
 * conflicts with the record, so guessing would throw away the right
 * notice for the other person. The tab asks for each date instead.
 * ------------------------------------------------------------------ */

const ACTIVE_STATUSES = ['Inforce', 'Grace', 'Pending'];

export function splitJoint(first, last) {
  const f = String(first || '').trim();
  const l = String(last || '').trim();
  const parts = f.split(/\s+(?:and|&)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [{ name: [f, l].filter(Boolean).join(' '), joint: false }];
  const titleCase = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return parts.map((pt) => ({ name: titleCase(`${pt} ${l}`.trim()), joint: true }));
}

/**
 * Bring watch_people up to date with the book. Creates a record for an
 * insured who has none, marks records whose insured has left the book,
 * and never overwrites what somebody typed on the tab.
 */
export async function syncPeople() {
  const { rows: ins } = await q(
    `SELECT i.id, i.first_name, i.last_name, i.display_name, i.dob, i.state, i.gender,
            i.date_of_death,
            EXISTS (SELECT 1 FROM policies p WHERE p.insured_id = i.id
                     AND p.status = ANY($1)) AS in_book
       FROM insureds i`, [ACTIVE_STATUSES]);
  const { rows: have } = await q('SELECT insured_id, slot FROM watch_people');
  const known = new Set(have.map((r) => `${r.insured_id}:${r.slot}`));
  let created = 0;
  for (const i of ins) {
    if (!i.in_book || i.date_of_death) continue;
    let first = i.first_name;
    let last = i.last_name;
    /* An insured keyed only by display name, "Moe And Claire Engler",
       with no first name: the last word is the surname. */
    if (!first && !last && i.display_name) {
      const words = String(i.display_name).trim().split(/\s+/);
      last = words.pop();
      first = words.join(' ');
    }
    const ppl = splitJoint(first, last);
    for (const [k, pp] of ppl.entries()) {
      if (!pp.name || known.has(`${i.id}:${k + 1}`)) continue;
      const other = ppl.filter((x, j) => j !== k).map((x) => x.name.split(/\s+/)[0]);
      await q(
        `INSERT INTO watch_people (insured_id, slot, name, dob, state, family, needs_attention)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (insured_id, slot) DO NOTHING`,
        [i.id, k + 1, pp.name, pp.joint ? null : i.dob, i.state || '',
          pp.joint && other.length ? `Spouse: ${other.join(', ')}` : '',
          pp.joint ? 'Joint insured — add this person’s own date of birth' : '']);
      created += 1;
    }
  }
  return { created };
}

/** The people a sweep searches: in the book, still alive on the record, switched on. */
export async function watchedPeople() {
  await syncPeople();
  const { rows } = await q(
    `SELECT w.*, i.first_name AS insured_first, i.last_name AS insured_last
       FROM watch_people w
       JOIN insureds i ON i.id = w.insured_id
      WHERE w.watching AND w.status <> 'confirmed' AND i.date_of_death IS NULL
        AND EXISTS (SELECT 1 FROM policies p WHERE p.insured_id = i.id AND p.status = ANY($1))
      ORDER BY w.last_checked NULLS FIRST, w.name`, [ACTIVE_STATUSES]);
  return rows;
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

let running = null;   // the run in progress in THIS process, for the tab to poll
export const currentRun = () => running;

/**
 * Score a set of notices for one person and file what clears the bar.
 * Returns the matches it filed. Shared by the sweep and by a vendor
 * upload, so the two cannot disagree about what a 75 is.
 */
async function fileMatches(p, row, cands, seen, known, on) {
  const filed = [];
  for (const c of cands) {
    if (!c.url || seen.has(c.url) || known.has(c.url)) continue;
    seen.add(c.url);
    const r = score(p, c, on);
    if (r.discarded_reason || r.score < POSSIBLE) continue;
    const { rows } = await q(
      `INSERT INTO watch_matches (person_id, source_url, source_name, obit_name, obit_dod,
                                  obit_place, score, factors, excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (person_id, source_url) DO NOTHING RETURNING id`,
      [row.id, c.url.slice(0, 2000), c.source_name, r.obit_name, r.dod, r.place, r.score,
        JSON.stringify(r.factors), String(c.text || '').slice(0, 600)]);
    if (!rows[0]) continue;
    filed.push({ id: rows[0].id, person_id: row.id, insured_id: row.insured_id, name: p.name,
      score: r.score, obit_dod: r.dod, obit_place: r.place });
  }
  if (filed.length)
    await q(`UPDATE watch_people SET status = 'under_review' WHERE id = $1 AND status = 'active'`,
      [row.id]);
  return filed;
}

/**
 * One sweep: every watched person against every enabled source.
 *
 * One at a time across the whole service: a Postgres advisory lock, so
 * two instances, or the daily timer and somebody pressing Run now,
 * cannot both be searching the same book and filing the same notices.
 *
 * `onDone(result)` is called with what was filed, which is how the
 * daily email is sent without this module knowing about mail.
 */
export async function runSweep({ trigger = 'manual', userId = null, onDone = null,
  on = today() } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('mortality_watch')) AS ok"))
      .rows[0].ok;
    if (!locked) return { busy: true };
    const people = await watchedPeople();
    const { rows: srcRows } = await q('SELECT * FROM watch_sources WHERE enabled ORDER BY id');
    const errors = [];
    const log = (m) => { if (errors.length < 200) errors.push(m); };
    const { rows: run } = await q(
      `INSERT INTO watch_runs (trigger, triggered_by, total) VALUES ($1,$2,$3) RETURNING id`,
      [trigger, userId, people.length]);
    const runId = run[0].id;
    running = { id: runId, total: people.length, checked: 0, started_at: new Date().toISOString() };

    const sources = srcRows.filter((r) => SOURCE_KINDS[r.kind]).map((r) => ({
      row: r, states: (r.states || []).map((s) => s.toUpperCase()),
      impl: SOURCE_KINDS[r.kind].make(r, log) }));
    for (const s of sources) {
      try { await s.impl.begin(); } catch (e) { log(`${s.row.name}: ${e.message}`); }
    }

    const filed = [];
    for (const row of people) {
      const p = person(row);
      const { rows: k } = await q('SELECT source_url FROM watch_matches WHERE person_id = $1', [row.id]);
      const known = new Set(k.map((x) => x.source_url));
      const seen = new Set();
      for (const s of sources) {
        if (s.states.length && !s.states.includes(p.state)) continue;
        let cands = [];
        try { cands = await s.impl.search(p); } catch (e) {
          log(`${s.row.name} / ${p.name}: ${e.message}`);
          continue;
        }
        filed.push(...await fileMatches(p, row, cands, seen, known, on));
      }
      await q('UPDATE watch_people SET last_checked = now() WHERE id = $1', [row.id]);
      running.checked += 1;
      await q('UPDATE watch_runs SET checked = $1 WHERE id = $2', [running.checked, runId]);
    }
    for (const s of sources) {
      try { await s.impl.end(); } catch (e) { log(`${s.row.name}: ${e.message}`); }
    }
    const queries = sources.reduce((n, s) => n + (s.impl.queries || 0), 0);
    await q(
      `UPDATE watch_runs SET finished_at = now(), new_matches = $1, errors = $2::jsonb,
              queries = $3 WHERE id = $4`,
      [filed.length, JSON.stringify(errors), queries, runId]);
    const result = { id: runId, checked: people.length, filed, errors, queries };
    if (onDone) {
      try { await onDone(result); } catch (e) { console.error('[mortality] after the sweep:', e.message); }
    }
    return result;
  } finally {
    running = null;
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('mortality_watch'))").catch(() => {});
    client.release();
  }
}

/** Score an uploaded vendor file against everybody watched, now. */
export async function runVendorFile({ name, rows, columns, fileLabel, userId = null,
  onDone = null, on = today() }) {
  const people = await watchedPeople();
  const src = new VendorFile(name, rows, columns, fileLabel);
  const { rows: run } = await q(
    `INSERT INTO watch_runs (trigger, triggered_by, total) VALUES ('vendor_file',$1,$2) RETURNING id`,
    [userId, people.length]);
  const filed = [];
  for (const row of people) {
    const p = person(row);
    const { rows: k } = await q('SELECT source_url FROM watch_matches WHERE person_id = $1', [row.id]);
    filed.push(...await fileMatches(p, row, await src.search(p), new Set(),
      new Set(k.map((x) => x.source_url)), on));
  }
  await q(`UPDATE watch_runs SET finished_at = now(), checked = total, new_matches = $1,
                  errors = '[]'::jsonb WHERE id = $2`, [filed.length, run[0].id]);
  const result = { id: run[0].id, checked: people.length, filed, errors: [], records: src.rows.length };
  if (onDone) {
    try { await onDone(result); } catch (e) { console.error('[mortality] after the vendor file:', e.message); }
  }
  return result;
}

/**
 * A one-off lookup: somebody not on the book, or a name checked by hand.
 * Runs the enabled sources and scores what they find. Nothing is saved.
 */
export async function checkOnce(input, on = today()) {
  const p = person(input);
  if (!p.last) throw new Error('A name is needed.');
  const { rows: srcRows } = await q('SELECT * FROM watch_sources WHERE enabled ORDER BY id');
  const notes = [];
  const log = (m) => notes.push(m);
  const out = [];
  const seen = new Set();
  for (const r of srcRows) {
    if (!SOURCE_KINDS[r.kind]) continue;
    const states = (r.states || []).map((s) => s.toUpperCase());
    if (states.length && !states.includes(p.state)) continue;
    const impl = SOURCE_KINDS[r.kind].make(r, log);
    try {
      await impl.begin();
      for (const c of await impl.search(p)) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        const s = score(p, c, on);
        out.push({ url: c.url, source_name: c.source_name, title: c.title, ...s, tier: tierOf(s) });
      }
    } catch (e) { log(`${r.name}: ${e.message}`); }
  }
  out.sort((a, b) => b.score - a.score);
  return { results: out, notes };
}

/* ------------------------------------------------------------------ *
 * The daily timer
 *
 * Checks every fifteen minutes whether today's sweep has run, and runs
 * it once the clock has passed the hour set (6am Eastern unless told
 * otherwise). Asking the database rather than remembering in memory
 * means a restart at 7am does not skip the day, and two instances do
 * not both run it -- the advisory lock above settles that.
 *
 * MW_SCHEDULE=off turns it off (the test server does).
 * ------------------------------------------------------------------ */

export function localHour(tz, at = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
    .format(at);
  return Number(h) % 24;
}

export function localDay(tz, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit',
    day: '2-digit' }).format(at);
}

export const scheduleSettings = () => ({
  enabled: String(process.env.MW_SCHEDULE || 'on').toLowerCase() !== 'off',
  hour: Number.isFinite(Number(process.env.MW_RUN_HOUR)) && process.env.MW_RUN_HOUR !== ''
    ? Number(process.env.MW_RUN_HOUR) : 6,
  tz: process.env.MW_TIMEZONE || 'America/Detroit',
});

/** Has a scheduled sweep already started today, in the office's time zone? */
export async function ranToday(tz, at = new Date()) {
  const { rows } = await q(
    `SELECT started_at FROM watch_runs WHERE trigger = 'schedule'
      ORDER BY started_at DESC LIMIT 1`);
  return !!rows[0] && localDay(tz, new Date(rows[0].started_at)) === localDay(tz, at);
}

export function startMortalitySchedule({ onDone, everyMs = 15 * 60_000 } = {}) {
  const cfg = scheduleSettings();
  if (!cfg.enabled) {
    console.log('[mortality] daily sweep is switched off (MW_SCHEDULE=off)');
    return null;
  }
  const tick = async () => {
    try {
      if (localHour(cfg.tz) < cfg.hour) return;
      if (await ranToday(cfg.tz)) return;
      await runSweep({ trigger: 'schedule', onDone });
    } catch (e) {
      console.error('[mortality] scheduled sweep:', e.message);
    }
  };
  const handle = setInterval(tick, everyMs);
  handle.unref?.();
  setTimeout(tick, 60_000).unref?.();
  return handle;
}
