/* =====================================================================
   Mortality Watch, end to end.

   Runs its own copy of the server, pointed at three stand-ins it starts
   itself: a search API answering like Brave, an obituary site with a
   listing page, notices and a feed, and a mail provider that writes
   down what it is sent. So a whole sweep runs for real -- searches,
   page fetches, scoring, filing, the email -- without the internet.

   What has to be true:
     - The people watched are the portal's own insureds on live
       policies; a joint insured is two people, neither given the shared
       date of birth; a matured policy's insured is not searched.
     - A sweep files what scores 50+ and drops what conflicts; it never
       files the same notice for the same person twice, dismissed or not.
     - The email goes to administrators, in initials, with no notice
       addresses in it.
     - Confirming marks the notice and stops the search -- and does NOT
       write a date of death on the insured.
     - A vendor file is scored the moment it is uploaded.
     - Administrators only.

   Idempotent: fixtures are prefixed, removed first and last, and the
   sources it switches off are switched back on.
   ===================================================================== */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ADMIN, MANAGER1, INVESTOR1, login as loginAt } from './test-config.mjs';
import { pool } from '../src/db.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 3427;
const WEB_PORT = 3428;
const BASE = `http://localhost:${APP_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const PREFIX = 'MWTEST';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* Surnames nobody else in a test database will have, so the stand-in
   search answers only for these people. */
const KOW = 'Kowalskyte';
const ENG = 'Englerova';
const WHIT = 'Whitcombery';

/* ------------------------------------------------------------------ *
 * The stand-in web: a search API, an obituary site, a mail provider.
 * ------------------------------------------------------------------ */
const searches = [];
const mail = [];
const PEGGY_OBIT = `<html><head><script>var tracker = 1;</script></head><body>
  <nav>Home | Obituaries</nav>
  <h1>Margaret Ann (Novak) ${KOW} Obituary</h1>
  <p>Margaret Ann ${KOW}, of Dearborn, Michigan, passed away on October 21, 2026.</p>
  <p>She was born April 12, 1938 in Toledo. Wife of the late Walter; mother of Linda.</p>
  </body></html>`;
const NAMESAKE_OBIT = `<html><body><h1>Margaret ${KOW}</h1>
  <p>Margaret ${KOW}, 54, of Dearborn, MI died October 1, 2026.</p></body></html>`;
const CLAIRE_OBIT = `<html><body><h1>Claire ${ENG} Obituary (2026) - Delray Beach, FL</h1>
  <p>Claire ${ENG}, 97, passed away August 24, 2026. Born May 14, 1929.
  She was predeceased by her beloved husband Moe in 2021.</p></body></html>`;
const LISTING = `<html><body><h2>Recent notices</h2><ul>
  <li><a href="/obit/claire">Claire ${ENG}</a></li>
  <li><a href="/obit/unrelated">Somebody Else</a></li>
  <li><a href="javascript:alert(1)">Not a link</a></li></ul></body></html>`;
const FEED = `<?xml version="1.0"?><rss><channel><title>Notices</title>
  <item><title><![CDATA[Somebody Else]]></title><link>${WEB}/obit/unrelated</link>
  <description>Somebody Else died.</description></item></channel></rss>`;

const web = http.createServer((req, res) => {
  const u = new URL(req.url, WEB);
  const send = (code, body, type = 'text/html') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
  };
  if (u.pathname === '/brave') {
    searches.push({ q: u.searchParams.get('q'), key: req.headers['x-subscription-token'] });
    const q = u.searchParams.get('q') || '';
    const results = [];
    if (q.includes(KOW) && q.includes('-obituary')) {
      /* A signs-of-life search: a birthday page, which counts, and a
         memorial page, which reads as a death notice and must not. */
      results.push({ title: `Margaret Ann ${KOW} celebrates 88th birthday`, url: `${WEB}/life/peggy`,
        description: `Margaret Ann ${KOW} of Dearborn turned 88 this month.`, age: '2026-10-12' });
      results.push({ title: `${KOW} family memorial`, url: `${WEB}/life/memorial`,
        description: `In loving memory — the ${KOW} family of Dearborn.` });
    } else if (q.includes(KOW)) {
      results.push({ title: `Margaret Ann ${KOW} Obituary - Dearborn, MI`, url: `${WEB}/obit/peggy`,
        description: `Margaret Ann ${KOW} of Dearborn passed away October 21, 2026.` });
      results.push({ title: `Margaret ${KOW}`, url: `${WEB}/obit/namesake`,
        description: `Margaret ${KOW}, 54, of Dearborn` });
    }
    return send(200, JSON.stringify({ web: { results } }), 'application/json');
  }
  if (u.pathname === '/life/peggy') return send(200, `<html><body><h1>Margaret Ann ${KOW} celebrates 88th birthday</h1>
    <p>Margaret Ann ${KOW}, 88, of Dearborn, Michigan, celebrated with her daughter Linda on October 12.</p></body></html>`);
  if (u.pathname === '/life/memorial') return send(200, `<p>In loving memory of the ${KOW} family of Dearborn, MI.</p>`);
  if (u.pathname === '/obit/peggy') return send(200, PEGGY_OBIT);
  if (u.pathname === '/obit/namesake') return send(200, NAMESAKE_OBIT);
  if (u.pathname === '/obit/claire') return send(200, CLAIRE_OBIT);
  if (u.pathname === '/obit/unrelated') return send(200, '<p>Somebody Else died.</p>');
  if (u.pathname === '/listing') return send(200, LISTING);
  if (u.pathname === '/feed.xml') return send(200, FEED, 'application/rss+xml');
  if (u.pathname === '/emails') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { mail.push(JSON.parse(raw)); } catch { /* ignore */ }
      send(200, JSON.stringify({ id: `m${mail.length}` }), 'application/json');
    });
    return undefined;
  }
  return send(404, 'not found');
});
await new Promise((r) => { web.listen(WEB_PORT, r); });

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    NODE_ENV: 'development',
    SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    APP_URL: BASE,
    MW_SCHEDULE: 'off',
    MW_ALLOW_PRIVATE_FETCH: '1',
    MW_MIN_INTERVAL_MS: '0',
    MW_BRAVE_URL: `${WEB}/brave`,
    BRAVE_API_KEY: 'stub-brave-key',
    RESEND_API_KEY: 'stub-mail-key',
    MAIL_API_URL: `${WEB}/emails`,
    MAIL_FROM: 'Poel Capital Portal <notices@example.test>',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ }
  await sleep(500);
}

const login = (e, p) => loginAt(e, p, BASE);
const cookie = await login(ADMIN.email, ADMIN.password);
const call = (c) => (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const api = call(cookie);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

let restoreSources = [];
const testStart = new Date();
const wipe = async () => {
  const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(`/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  await pool.query('DELETE FROM insureds WHERE last_name = ANY($1) OR last_name LIKE $2',
    [[KOW, ENG, WHIT], `${PREFIX}%`]);
  await pool.query(`DELETE FROM watch_sources WHERE name LIKE $1`, [`${PREFIX}%`]);
};

let lastSummary = null;
const whitPerson = () => (lastSummary?.people || []).find((p) => p.name === `Harold ${WHIT}`) || { id: -1 };
const sweep = async () => {
  const started = await json(await api('/mortality-watch/run', { method: 'POST' }));
  if (started?.finished) return started.finished;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = await json(await api('/mortality-watch/status'));
    if (!s.running) return s.last;
  }
  throw new Error('the sweep did not finish');
};

try {
  await wipe();
  const funds = await json(await api('/funds'));
  const policy = async (tag, extra) => json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    fund_code: funds[0].code, face_amount: 2000000, ...extra } }));

  const peggyPol = await policy('PEGGY', { insured_first_name: 'Margaret Ann',
    insured_last_name: KOW, dob: '1938-04-12', issue_state: 'MI' });
  const jointPol = await policy('ENGLER', { insured_first_name: 'Moe And Claire',
    insured_last_name: ENG, dob: '1926-03-22', product_type: 'SUL' });
  const whitPol = await policy('WHIT', { insured_first_name: 'Harold', insured_last_name: WHIT,
    dob: '1941-09-30' });
  const gonePol = await policy('GONE', { insured_first_name: 'Matured', insured_last_name: `${PREFIX}Gone`,
    dob: '1930-01-01', status: 'Matured' });
  check('(fixtures)', !!peggyPol?.id && !!jointPol?.id && !!whitPol?.id && !!gonePol?.id,
    JSON.stringify([peggyPol, jointPol].map((p) => p?.error || p?.id)));

  console.log('WHO IS WATCHED COMES FROM THE PORTAL');
  let d = await json(await api('/mortality-watch'));
  const ours = (x) => d.people.filter((p) => p.name.includes(x));
  const peggy = ours(KOW)[0];
  check('an insured on a live policy is on the watch list', !!peggy && peggy.in_book,
    JSON.stringify(peggy?.name));
  check('with the date of birth from the insured record',
    String(peggy?.dob || '').startsWith('1938-04-12'), String(peggy?.dob));
  const eng = ours(ENG);
  check('a joint insured is two people',
    eng.length === 2 && eng.some((p) => p.name === `Moe ${ENG}`) && eng.some((p) => p.name === `Claire ${ENG}`),
    JSON.stringify(eng.map((p) => p.name)));
  check('neither is given the shared date of birth', eng.every((p) => !p.dob),
    JSON.stringify(eng.map((p) => p.dob)));
  check('and each is flagged as needing their own', eng.every((p) => /date of birth/.test(p.needs_attention)));
  check('each is recorded as the other’s spouse',
    eng.find((p) => p.name.startsWith('Claire'))?.family === 'Spouse: Moe', eng.map((p) => p.family).join(' | '));
  const gone = d.people.find((p) => p.name.includes(`${PREFIX}Gone`));
  check('the insured of a matured policy is not searched', !gone || !gone.in_book,
    JSON.stringify(gone && { in_book: gone.in_book }));

  /* The details the scorer leans on, as an administrator would type them. */
  const put = await api(`/mortality-watch/people/${peggy.id}`, { method: 'PUT', body: {
    aka: 'Peggy; née Novak', city: 'Dearborn', state: 'mi', prior_residence: 'Toledo, OH',
    family: 'Spouse: Walter; children: Linda' } });
  check('the watch record takes the extra details', put.status === 200, String(put.status));
  check('and a state is stored as its code', (await json(await api('/mortality-watch')))
    .people.find((p) => p.id === peggy.id)?.state === 'MI');

  console.log('\nSOURCES ARE CONFIGURED ON THE TAB');
  restoreSources = d.sources.filter((s) => s.enabled).map((s) => s.id);
  for (const id of restoreSources)
    await api(`/mortality-watch/sources/${id}`, { method: 'PUT', body: { enabled: false } });
  const s1 = await json(await api('/mortality-watch/sources', { method: 'POST', body: {
    kind: 'web_search', name: `${PREFIX} search`, options: { provider: 'brave', max_queries: 3 } } }));
  const s2 = await json(await api('/mortality-watch/sources', { method: 'POST', body: {
    kind: 'page', name: `${PREFIX} listing`, options: { url: `${WEB}/listing` } } }));
  const s3 = await json(await api('/mortality-watch/sources', { method: 'POST', body: {
    kind: 'rss', name: `${PREFIX} feed`, options: { url: `${WEB}/feed.xml` }, states: 'fl, NY, xx1' } }));
  const s4 = await json(await api('/mortality-watch/sources', { method: 'POST', body: {
    kind: 'life_search', name: `${PREFIX} signs of life`, options: { provider: 'brave' } } }));
  check('a signs-of-life search can be added, two searches a person by default',
    !!s4?.id && s4.options?.max_queries === 2, JSON.stringify(s4?.options || s4));
  check('a search, a listing page and a feed can be added', !!s1?.id && !!s2?.id && !!s3?.id,
    JSON.stringify([s1, s2, s3].map((s) => s?.error || s?.id)));
  check('states are cleaned to two-letter codes', JSON.stringify(s3.states) === '["FL","NY"]',
    JSON.stringify(s3.states));
  check('an address that is not a web address is refused',
    (await api('/mortality-watch/sources', { method: 'POST', body: {
      kind: 'page', name: `${PREFIX} bad`, options: { url: 'javascript:alert(1)' } } })).status === 400);
  check('an unknown kind is refused',
    (await api('/mortality-watch/sources', { method: 'POST', body: {
      kind: 'carrier_pigeon', name: `${PREFIX} bad` } })).status === 400);
  d = await json(await api('/mortality-watch'));
  check('the key is reported as present, without its value',
    d.providers.brave.key === true && !JSON.stringify(d).includes('stub-brave-key'));
  check('and the tab can say what a sweep will cost', d.estimate > 0, String(d.estimate));

  console.log('\nA SWEEP');
  searches.length = 0;
  mail.length = 0;
  const run1 = await sweep();
  check('it runs to the end', !!run1?.finished_at || Array.isArray(run1?.filed), JSON.stringify(run1).slice(0, 160));
  check('the search API was asked, with the key', searches.length > 0
    && searches.every((x) => x.key === 'stub-brave-key'), String(searches.length));
  check('for the person by name and place', searches.some((x) => x.q === `"Margaret ${KOW}" obituary Dearborn MI`),
    searches.slice(0, 3).map((x) => x.q).join(' | '));
  check('and by maiden name', searches.some((x) => x.q.includes('"Novak"')));
  d = await json(await api('/mortality-watch'));
  const pPeggy = d.pending.filter((m) => m.person_id === peggy.id);
  check('the true notice is filed at 100',
    pPeggy.length === 1 && pPeggy[0].score === 100 && pPeggy[0].source_url.endsWith('/obit/peggy'),
    JSON.stringify(pPeggy.map((m) => [m.score, m.source_url])));
  check('with the date of death read from it', String(pPeggy[0]?.obit_dod).startsWith('2026-10-21'),
    String(pPeggy[0]?.obit_dod));
  check('and the reasons it scored what it did',
    (pPeggy[0]?.factors || []).some((f) => f.label === 'Spouse Walter named' && f.hit));
  check('the 54-year-old namesake is thrown out, not filed',
    !d.pending.some((m) => m.source_url.endsWith('/obit/namesake')));
  const claire = eng.find((p) => p.name.startsWith('Claire'));
  const pClaire = d.pending.filter((m) => m.person_id === claire.id);
  check('a notice found by following a listing page is filed', pClaire.length === 1
    && pClaire[0].score === 53 && pClaire[0].source_name === `${PREFIX} listing`,
    JSON.stringify(pClaire.map((m) => [m.score, m.source_name])));
  check('the person is now under review',
    d.people.find((p) => p.id === peggy.id)?.status === 'under_review');
  check('the deal’s policies come with it, to say what is at stake',
    (pPeggy[0]?.policies || []).some((p) => p.policy_number === `${PREFIX}-PEGGY`));

  console.log('\nSIGNS OF LIFE ARE FILED APART FROM DEATH NOTICES');
  const life = d.life_pending.filter((m) => m.person_id === peggy.id);
  check('a recent public mention is filed as a sign of life', life.length === 1
    && life[0].source_url.endsWith('/life/peggy') && life[0].score >= 75,
    JSON.stringify(life.map((m) => [m.score, m.source_url])));
  check('and not in the death queue', !d.pending.some((m) => m.source_url.includes('/life/')));
  check('a page that reads as a death notice is never filed as a sign of life',
    !d.life_pending.some((m) => m.source_url.endsWith('/life/memorial')));

  console.log('\nTHE EMAIL');
  /* Read from the outbox rather than waited for: the portal's mail worker
     sends within a minute, and what matters here is what it was given. */
  const { rows: queued } = await pool.query(
    `SELECT e.to_email, e.subject, e.body_text AS text FROM email_outbox e
      WHERE e.kind = 'mortality_alert' AND e.created_at >= $1 ORDER BY e.id`, [testStart]);
  const { rows: admins } = await pool.query(
    "SELECT email FROM users WHERE role = 'admin' AND is_active = TRUE AND email <> ''");
  const alert = queued[0];
  check('administrators are emailed, every one of them', !!alert
    && admins.every((a) => queued.some((m) => m.to_email === a.email)),
  `${queued.length} queued for ${admins.length} admins`);
  check('saying how many are likely', /1 likely match/.test(alert?.subject || ''), alert?.subject);
  check('in initials', /M\.K\. — 100, likely/.test(alert?.text || ''), (alert?.text || '').slice(0, 200));
  check('never the name', !new RegExp(`${KOW}|${ENG}|Margaret|Claire`).test(`${alert?.subject}\n${alert?.text}`));
  check('and it mentions the sign of life waiting', /public mention/.test(alert?.text || ''));
  check('and never the notice’s own address', !(alert?.text || '').includes('/obit/'));

  console.log('\nTHE SAME NOTICE IS NEVER FILED TWICE');
  const before = (await json(await api('/mortality-watch'))).pending.length;
  await sweep();
  check('a second sweep files nothing new',
    (await json(await api('/mortality-watch'))).pending.length === before);

  const dis = await api(`/mortality-watch/matches/${pClaire[0].id}/dismiss`, { method: 'POST',
    body: { note: 'Different Claire — born 1929, ours was not' } });
  check('a notice can be dismissed', dis.status === 200, String(dis.status));
  d = await json(await api('/mortality-watch'));
  check('and the person goes back to plain watching',
    d.people.find((p) => p.id === claire.id)?.status === 'active');
  await sweep();
  check('and a dismissed notice stays dismissed',
    !(await json(await api('/mortality-watch'))).pending.some((m) => m.person_id === claire.id));

  console.log('\nCONFIRMING IS A DECISION, NOT A DATE OF DEATH');
  const conf = await json(await api(`/mortality-watch/matches/${pPeggy[0].id}/confirm`, {
    method: 'POST', body: { note: 'Called the daughter' } }));
  check('a notice can be confirmed', conf?.ok === true, JSON.stringify(conf));
  d = await json(await api('/mortality-watch'));
  check('the person is marked confirmed', d.people.find((p) => p.id === peggy.id)?.status === 'confirmed');
  const { rows: ins } = await pool.query('SELECT date_of_death FROM insureds WHERE id = $1',
    [peggy.insured_id]);
  check('and the insured has NO date of death written on it', ins[0]?.date_of_death === null,
    String(ins[0]?.date_of_death));
  const pol = await json(await api(`/policies/${peggyPol.id}`));
  check('so the policy is still in the active book', pol.status === 'Inforce', pol.status);
  const checkedAt = d.people.find((p) => p.id === peggy.id)?.last_checked;
  searches.length = 0;
  await sweep();
  check('and a confirmed person is not searched again',
    !searches.some((x) => x.q.includes(KOW))
    && (await json(await api('/mortality-watch'))).people.find((p) => p.id === peggy.id)?.last_checked === checkedAt);
  const re = await api(`/mortality-watch/matches/${pPeggy[0].id}/reopen`, { method: 'POST' });
  check('a decision made by mistake can be reopened', re.status === 200
    && (await json(await api('/mortality-watch'))).pending.some((m) => m.id === pPeggy[0].id));
  check('a decided notice cannot be decided twice',
    (await api(`/mortality-watch/matches/${pClaire[0].id}/confirm`, { method: 'POST', body: {} })).status === 409);

  console.log('\nPROOF OF LIFE');
  check('a sign of life cannot be "confirmed" as a death',
    (await api(`/mortality-watch/matches/${life[0].id}/confirm`, { method: 'POST', body: {} })).status === 400);
  check('accepting one needs the date it shows them alive',
    (await api(`/mortality-watch/matches/${life[0].id}/accept-life`, { method: 'POST', body: {} })).status === 400);
  const acc = await api(`/mortality-watch/matches/${life[0].id}/accept-life`, { method: 'POST',
    body: { observed_on: '2026-10-25', note: 'Birthday party' } });
  check('it is accepted as proof of life', acc.status === 200, String(acc.status));
  d = await json(await api('/mortality-watch'));
  check('and becomes their last confirmed alive date',
    String(d.people.find((p) => p.id === peggy.id)?.last_alive?.observed_on).startsWith('2026-10-25'),
    JSON.stringify(d.people.find((p) => p.id === peggy.id)?.last_alive));
  const dn = d.pending.find((m) => m.id === pPeggy[0].id);
  check('which the death notice for her now shows, dated after the death it reports',
    String(dn?.last_alive?.observed_on).startsWith('2026-10-25') && String(dn?.obit_dod).startsWith('2026-10-21'),
    JSON.stringify([dn?.last_alive, dn?.obit_dod]));
  check('it cannot be accepted twice',
    (await api(`/mortality-watch/matches/${life[0].id}/accept-life`, { method: 'POST',
      body: { observed_on: '2026-10-25' } })).status === 409);
  await api(`/mortality-watch/matches/${life[0].id}/reopen`, { method: 'POST' });
  check('reopening it takes the evidence back off',
    !(await json(await api('/mortality-watch'))).people.find((p) => p.id === peggy.id)?.last_alive);
  await api(`/mortality-watch/matches/${life[0].id}/accept-life`, { method: 'POST',
    body: { observed_on: '2026-10-25' } });

  const ev = (body) => api(`/mortality-watch/people/${claire.id}/evidence`, { method: 'POST', body });
  check('evidence can be recorded by hand', (await ev({ kind: 'call_contact', observed_on: '2026-10-27',
    note: 'Spoke with her son' })).status === 201);
  check('not with a date in the future', (await ev({ kind: 'call_contact', observed_on: '2099-01-01' })).status === 400);
  check('not as a "web mention", which only the sweep files',
    (await ev({ kind: 'web_mention', observed_on: '2026-10-27' })).status === 400);
  check('not with a link that is not a web address',
    (await ev({ kind: 'seen_online', observed_on: '2026-10-27', source_url: 'javascript:alert(1)' })).status === 400);
  const hist = await json(await api(`/mortality-watch/people/${claire.id}/evidence`));
  check('and the history says who recorded what', hist.length === 1 && !!hist[0].recorded_by_name
    && hist[0].kind === 'call_contact', JSON.stringify(hist.map((h) => [h.kind, h.recorded_by_name])));

  console.log('\nOVERDUE FOR PROOF OF LIFE');
  check('the warning cannot be set below a week',
    (await api('/mortality-watch/settings', { method: 'PUT', body: { life_overdue_days: 3 } })).status === 400);
  check('it can be set', (await api('/mortality-watch/settings', { method: 'PUT',
    body: { life_overdue_days: 30 } })).status === 200);
  const moe = eng.find((p) => p.name.startsWith('Moe'));
  await pool.query("UPDATE watch_people SET created_at = now() - interval '60 days', overdue_notified_at = NULL WHERE id = $1", [moe.id]);
  d = await json(await api('/mortality-watch'));
  lastSummary = d;
  check('somebody watched for 60 days with nothing recorded is overdue', d.people.find((p) => p.id === moe.id)?.overdue === true);
  check('somebody with evidence from last week is not', d.people.find((p) => p.id === claire.id)?.overdue === false);
  check('somebody only just added is not, however empty their record',
    d.people.find((p) => p.id === whitPerson().id)?.overdue === false);
  const t2 = new Date();
  await sweep();
  const { rows: od } = await pool.query(
    "SELECT subject, body_text FROM email_outbox WHERE kind = 'mortality_alert' AND created_at >= $1", [t2]);
  check('the next sweep emails that they are overdue, in initials',
    od.some((m) => /No proof of life in over 30 days/.test(m.body_text) && /M\.E\. — nothing recorded yet/.test(m.body_text)),
    (od[0]?.body_text || 'no email').slice(0, 200));
  const t3 = new Date();
  await sweep();
  const { rows: od2 } = await pool.query(
    "SELECT body_text FROM email_outbox WHERE kind = 'mortality_alert' AND created_at >= $1", [t3]);
  check('and says so once, not every morning', !od2.some((m) => /M\.E\./.test(m.body_text)),
    String(od2.length));
  await api(`/mortality-watch/people/${moe.id}/evidence`, { method: 'POST',
    body: { kind: 'tracking_form', observed_on: new Date().toISOString().slice(0, 10) } });
  check('recording evidence clears it',
    (await json(await api('/mortality-watch'))).people.find((p) => p.id === moe.id)?.overdue === false);

  console.log('\nA VENDOR FILE IS SCORED ON ARRIVAL');
  const whit = d.people.find((p) => p.name === `Harold ${WHIT}`);
  await api(`/mortality-watch/people/${whit.id}`, { method: 'PUT',
    body: { city: 'Sarasota', state: 'FL' } });
  const csv = 'FNAME,MNAME,LNAME,BORN,DIED,CITY,ST,REC\n'
    + `HAROLD,J,${WHIT.toUpperCase()},09/30/1941,10/02/2026,SARASOTA,FL,V-1\n`
    + `HAROLD,,${WHIT.toUpperCase()},03/15/1952,09/11/2026,AKRON,OH,V-2\n`;
  const noMap = await json(await api('/mortality-watch/vendor-file', { method: 'POST',
    body: { csv, filename: 'delivery.csv' } }));
  check('a file whose columns are named differently is refused, saying what it has',
    /no last_name or first_name column/.test(noMap?.error || '') && /FNAME/.test(noMap?.error || ''),
    noMap?.error);
  const vf = await json(await api('/mortality-watch/vendor-file', { method: 'POST', body: {
    csv, filename: 'delivery.csv', source_name: `${PREFIX} vendor`,
    columns: { first_name: 'FNAME', middle_name: 'MNAME', last_name: 'LNAME', dob: 'BORN',
      dod: 'DIED', city: 'CITY', state: 'ST', reference: 'REC' } } }));
  check('with the columns named, it is read', vf?.records === 2, JSON.stringify(vf));
  const pW = (await json(await api('/mortality-watch'))).pending.filter((m) => m.person_id === whit.id);
  check('the right Harold is filed as likely — name, exact birth date, city',
    pW.length === 1 && pW[0].score === 88,
    JSON.stringify(pW.map((m) => [m.score, m.source_url])));
  check('the one born in 1952 is thrown out', !pW.some((m) => m.source_url.endsWith('V-2')));

  console.log('\nA ONE-OFF LOOKUP SAVES NOTHING');
  const count = (await pool.query('SELECT COUNT(*)::int AS n FROM watch_matches')).rows[0].n;
  const look = await json(await api('/mortality-watch/check', { method: 'POST', body: {
    name: `Margaret Ann ${KOW}`, dob: '1938-04-12', city: 'Dearborn', state: 'MI',
    aka: 'née Novak', family: 'Spouse: Walter' } }));
  check('it returns scored results', (look?.results || []).some((r) => r.score === 100),
    JSON.stringify((look?.results || []).map((r) => [r.score, r.discarded_reason])));
  check('including what it threw out, and why',
    (look?.results || []).some((r) => r.discarded_reason === 'age_conflict'));
  check('and files nothing', (await pool.query('SELECT COUNT(*)::int AS n FROM watch_matches')).rows[0].n === count);

  console.log('\nTYPING A DATE OF BIRTH CLEARS THE FLAG');
  await api(`/mortality-watch/people/${claire.id}`, { method: 'PUT', body: { dob: '1929-05-14' } });
  check('the joint insured’s flag goes once the date is in',
    (await json(await api('/mortality-watch'))).people.find((p) => p.id === claire.id)?.needs_attention === '');

  console.log('\nADMINISTRATORS ONLY');
  const mgr = call(await login(MANAGER1.email, MANAGER1.password));
  const inv = call(await login(INVESTOR1.email, INVESTOR1.password));
  for (const [who, c] of [['a manager', mgr], ['an investor', inv]]) {
    const r = await Promise.all([c('/mortality-watch'), c('/mortality-watch/run', { method: 'POST' }),
      c('/mortality-watch/check', { method: 'POST', body: { name: 'A B' } }),
      c(`/mortality-watch/matches/${pPeggy[0].id}/confirm`, { method: 'POST', body: {} })]);
    check(`${who} is refused every route`, r.every((x) => x.status === 403),
      r.map((x) => x.status).join(','));
  }

  console.log('\nON THE SCREEN');
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await br.newContext({ viewport: { width: 1400, height: 1200 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
  p.on('dialog', (dlg) => dlg.accept());
  const signIn = async (who) => {
    await ctx.clearCookies();
    await p.goto(BASE);
    await p.fill('#email', who.email);
    await p.fill('#password', who.password);
    await p.click('button[type=submit]');
    await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });
  };
  await signIn(ADMIN);
  check('administrators have the tab in the menu',
    (await p.locator('nav a, .nav a, header a').allInnerTexts()).some((t) => /Mortality Watch/.test(t)));
  await p.goto(`${BASE}/#/mortality`);
  await p.waitForSelector('.mw-match', { timeout: 20000 });
  const page = (await p.locator('.main, body').first().innerText()).replace(/\s+/g, ' ');
  check('the queue shows the notice with its score', /100/.test(page) && new RegExp(KOW).test(page),
    page.slice(0, 200));
  check('and the reasons as ticks', await p.locator('.mw-factor.hit').count() > 0);
  check('and says plainly that confirming is not a date of death', /does not record a death/i.test(page));
  check('a death notice shows proof of life dated after the death it reports',
    /after the date of death in this notice/i.test(page));
  check('the people list has a last-confirmed-alive column', /Last confirmed alive/i.test(page));
  check('the joint insured is listed as needing a date of birth', /Joint insured/.test(page) || /date of birth/.test(page));
  await p.locator(`[data-mw-confirm="${pPeggy[0].id}"]`).click();
  await p.waitForSelector('dialog[open]', { timeout: 10000 });
  check('confirming explains what it does and does not do',
    /does not record a death|not\s+record a death/i.test(await p.locator('dialog[open]').innerText()));
  await p.click('dialog[open] button[type=submit]');
  await p.waitForTimeout(1500);
  check('and moves the notice out of the queue',
    await p.locator(`[data-mw-confirm="${pPeggy[0].id}"]`).count() === 0);
  await signIn(MANAGER1);
  check('a manager has no such tab',
    !(await p.locator('nav a, .nav a, header a').allInnerTexts()).some((t) => /Mortality Watch/.test(t)));
  check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
  await br.close();
} catch (e) {
  check('the suite ran to the end', false, `${e.stack}\n${serverLog.slice(-800)}`);
} finally {
  await api('/mortality-watch/settings', { method: 'PUT', body: { life_overdue_days: 90 } }).catch(() => {});
  for (const id of restoreSources)
    await api(`/mortality-watch/sources/${id}`, { method: 'PUT', body: { enabled: true } }).catch(() => {});
  await wipe().catch(() => {});
  server.kill();
  web.close();
  await pool.end();
}

console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All Mortality Watch checks passed.'}`);
process.exit(fails.length ? 1 : 0);
