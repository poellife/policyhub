/* =====================================================================
   The post.

   Email is a courtesy, and the work in front of somebody is not — so
   every message is written to an outbox inside the request that causes
   it and sent afterwards by a worker. That is the design, and these are
   the ways it can quietly stop being true:

     - a provider that is slow or down makes the application slow or
       down. It must not: queueing is a row, and it never throws.
     - a message that fails disappears into a log line. It must be
       retried, and then be visible.
     - a message that fails for a reason that will not change — a bad
       address, an unverified domain — is retried forever.
     - somebody who switched a kind off gets it anyway. Or worse:
       somebody who cannot switch a security alert off, does.
     - a password, or somebody else's figures, end up in an inbox.

   Sent against a stub of the provider on this machine rather than the
   real one, so it can check what would actually go over the wire.
   ===================================================================== */
import http from 'node:http';
import { BASE, ADMIN, login, databaseUrl } from './test-config.mjs';

const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

/* A provider that does whatever the test tells it to. */
const received = [];
let behaviour = { status: 200, body: { id: 'stub-1' } };
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    received.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
    res.writeHead(behaviour.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(behaviour.body));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const port = stub.address().port;

// The module under test opens its own pool; give it the same database.
process.env.DATABASE_URL = databaseUrl();
process.env.MAIL_API_URL = `http://127.0.0.1:${port}/emails`;
process.env.RESEND_API_KEY = 'test-key-not-real';
process.env.MAIL_FROM = 'PolicyHub <notices@example.test>';
process.env.APP_URL = 'https://portal.example.test';

const { queueMail, sendMail, flushMail, mailReady, MAIL_KINDS, TEMPLATES } =
  await import('../src/mail.js');
const { q } = await import('../src/db.js');

const admin = await login(ADMIN.email, ADMIN.password);
const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: admin } })).json();

const TO = 'mail-test@example.test';
const wipe = () => q('DELETE FROM email_outbox WHERE to_email = $1', [TO]);
const clearPrefs = () => q('DELETE FROM notification_prefs WHERE user_id = $1', [me.id]);
await wipe(); await clearPrefs();
const outbox = async () => (await q(
  'SELECT * FROM email_outbox WHERE to_email = $1 ORDER BY id', [TO])).rows;

console.log('QUEUEING NEVER GETS IN THE WAY');
check('it says it is configured', mailReady());
const queued = await queueMail({ to: TO, kind: 'portal_open',
  subject: 'Ready', text: 'Your account is ready.' });
check('a message goes to the outbox, not down the wire', !!queued.id && received.length === 0,
  `${received.length} sent so far`);
check('and it is waiting', (await outbox())[0].status === 'Queued');
check('a kind nobody defined is refused rather than sent',
  !!(await queueMail({ to: TO, kind: 'invented', subject: 'x', text: 'y' })).error);
/* Every template must be a kind the queue will actually accept. These were
   two lists, and `test` was on one of them — so the Send-me-a-test button
   answered "unknown mail kind test" instead of sending anything. */
const unqueueable = [];
for (const kind of Object.keys(TEMPLATES)) {
  const r = await queueMail({ to: TO, kind, subject: 'shape check', text: 'shape check' });
  if (r.error) unqueueable.push(`${kind}: ${r.error}`);
}
check('every template is a kind the queue accepts', unqueueable.length === 0,
  unqueueable.join(' · '));
await q(`DELETE FROM email_outbox WHERE to_email = $1 AND subject = 'shape check'`, [TO]);
check('and no address at all is simply skipped',
  (await queueMail({ to: '', kind: 'portal_open', subject: 'x', text: 'y' })).skipped === 'no address');

console.log('\nAND THEN IT GOES');
/* The outbox is shared with whatever else has run against this database, so
   every assertion here is about THIS message rather than about the queue
   being empty. */
const mine = () => received.filter((r) => r.body.to[0] === TO);
/* Drain rather than flush once: the outbox is shared with everything else
   that has run against this database, and the worker takes them oldest
   first. */
const drain = async () => {
  let last = { sent: 0 };
  for (let i = 0; i < 40; i++) {
    last = await flushMail({ limit: 100 });
    if (!last.waiting) break;
  }
  return last;
};
const out = await drain();
check('the worker sends what is due', out.sent >= 1, JSON.stringify(out));
check('the provider got ours', mine().length === 1, `${mine().length} of ${received.length}`);
const sentOne = mine()[0];
check('with our key', sentOne.auth === 'Bearer test-key-not-real');
check('from the address we configured',
  sentOne.body.from === 'PolicyHub <notices@example.test>', sentOne.body.from);
check('addressed to the right person', sentOne.body.to[0] === TO);
check('as text and as HTML — a mail client that will not render one shows the other',
  !!sentOne.body.text && /<html/i.test(sentOne.body.html || ''));
check('the row is marked sent, with what the provider called it',
  (await outbox())[0].status === 'Sent' && (await outbox())[0].provider_id === 'stub-1');
const settled = mine().length;
await drain();
check('and sending again does not send it twice', mine().length === settled,
  `${mine().length} vs ${settled}`);

console.log('\nA PROVIDER HAVING A BAD DAY');
await wipe();
behaviour = { status: 503, body: { message: 'upstream unavailable' } };
await queueMail({ to: TO, kind: 'portal_open', subject: 'Ready', text: 'Again.' });
const bad = await flushMail();
check('a failure is counted rather than thrown', bad.failed === 1, JSON.stringify(bad));
let row = (await outbox())[0];
check('the message stays queued for another go', row.status === 'Queued', row.status);
check('the reason is kept', /upstream unavailable/.test(row.last_error), row.last_error);
check('and it is not tried again immediately',
  new Date(row.next_try_at) > new Date(), row.next_try_at);
check('nothing is retried before its time', (await flushMail()).sent === 0);

console.log('\nA FAILURE THAT WILL NOT CHANGE');
/* A bad address or an unverified domain fails identically in five minutes.
   Retrying it forever hides it; giving up makes it visible. */
await wipe();
behaviour = { status: 422, body: { message: 'domain is not verified' } };
await queueMail({ to: TO, kind: 'portal_open', subject: 'Ready', text: 'Nope.' });
await flushMail();
row = (await outbox())[0];
check('it is given up on at once', row.status === 'Failed', row.status);
check('after one attempt, not five', row.attempts === 1, String(row.attempts));
check('and the reason is on the record', /not verified/.test(row.last_error));

console.log('\nTOO MANY TRIES');
await wipe();
behaviour = { status: 500, body: { message: 'boom' } };
await queueMail({ to: TO, kind: 'portal_open', subject: 'Ready', text: 'Keep trying.' });
for (let i = 0; i < 6; i++) {
  await q(`UPDATE email_outbox SET next_try_at = now() WHERE to_email = $1`, [TO]);
  await flushMail();
}
row = (await outbox())[0];
check('a message that never gets through is eventually given up on',
  row.status === 'Failed', row.status);
check('after a bounded number of attempts', row.attempts === 5, String(row.attempts));

console.log('\nWHAT SOMEBODY ASKED NOT TO HEAR');
await wipe(); await clearPrefs();
behaviour = { status: 200, body: { id: 'stub-2' } };
/* A kind somebody can actually express an opinion about. The one-off kinds
   — your account is open, your registration arrived — are sent before anybody
   could have set a preference, so there is nothing to obey. */
await q(`INSERT INTO notification_prefs (user_id, kind, enabled) VALUES ($1,'capital_call',FALSE)`,
  [me.id]);
const off = await queueMail({ to: TO, userId: me.id, kind: 'capital_call',
  subject: 'Called', text: 'Should not go.' });
check('it is not sent', off.skipped === 'switched off', JSON.stringify(off));
check('but it is recorded as not sent, rather than vanishing',
  (await outbox())[0].status === 'Skipped');
const before = received.length;
await flushMail();
check('and the worker does not pick it up later', received.length === before);

console.log('\nWHAT NOBODY MAY SWITCH OFF');
/* An administrator does not get to stop hearing that somebody signed in from
   a new country, or that the book was exported. */
await q(`INSERT INTO notification_prefs (user_id, kind, enabled) VALUES ($1,'new_location',FALSE)
         ON CONFLICT (user_id, kind) DO UPDATE SET enabled = FALSE`, [me.id]);
const forced = await queueMail({ to: TO, userId: me.id, kind: 'new_location',
  subject: 'New sign-in', text: 'Somewhere new.' });
check('a security alert goes anyway', !!forced.id, JSON.stringify(forced));
check('the kinds that cannot be switched off are the security ones',
  MAIL_KINDS.filter((k) => k.forced).map((k) => k.kind).sort().join(',')
    === 'bulk_export,new_location',
  MAIL_KINDS.filter((k) => k.forced).map((k) => k.kind).join(','));
await clearPrefs();

console.log('\nWHAT IS NEVER IN AN EMAIL');
/* Email is not a place we control. It gets somebody to the portal; it does
   not carry what the portal is protecting. */
/* Every template is handed a password, a tax number and an insured's name,
   and none of them may come out the other side. Checked by handing them the
   values rather than by looking for the words — "change your password" is a
   sentence we want, and a pattern match on "password" would ban it. */
const POISON = { password: 'SECRET-PASSWORD-9', tax_id: '123-45-6789',
  insured: 'Eugene Kohn', login_password: 'SECRET-PASSWORD-9' };
const everything = MAIL_KINDS.map((k) => TEMPLATES[k.kind]({
  ...POISON,
  name: 'Ada Ellsworth', label: 'Chrome on macOS · 71.12.34.x', when: '2026-08-20 10:00',
  actor: 'Test Admin', detail: 'exported 17 rows of policies', email: 'ada@example.test',
  title: 'LCG1 Fund LLC', parties: '3 members', who: 'Ada Ellsworth', outstanding: 2,
})).map((m) => `${m.subject}\n${m.text}`).join('\n\n');
check('a password handed to a template never comes out of one',
  !everything.includes('SECRET-PASSWORD-9'));
check('nor a tax number', !/\b\d{3}-\d{2}-\d{4}\b/.test(everything));
check('nor an insured’s name', !everything.includes('Eugene Kohn'));
check('the portal-open message says the password is NOT in it',
  /not in this email/i.test(TEMPLATES.portal_open({ name: 'A', email: 'a@b.test' }).text));
/* One link, and it goes to the front door. A deep link into a portal that
   requires signing in costs a step and teaches nothing — and a deep link that
   is wrong reads as a broken product rather than a broken setting. */
const links = MAIL_KINDS.map((k) => ({ kind: k.kind,
  urls: (TEMPLATES[k.kind]({ name: 'A', email: 'a@b.test', label: 'x', when: 'y', actor: 'z',
    detail: 'd', title: 't', parties: 'p', who: 'w', outstanding: 0, amount: '$1.00',
    due: 'd', policies: 1, headline: 'h', investor: 'i', pct: '5%', entity: 'e' }).text
    .match(/https?:\/\/\S+/g) || []) }));
/* One kind deliberately carries none: somebody who has just registered
   cannot sign in yet, and a link that lands them on a login screen they will
   be refused by is worse than no link. */
const NO_LINK = new Set(['registration_received']);
check('every message somebody can act on carries a way in',
  links.filter((l) => !NO_LINK.has(l.kind)).every((l) => l.urls.length >= 1),
  links.filter((l) => !NO_LINK.has(l.kind) && !l.urls.length).map((l) => l.kind).join(', '));
check('and the one that cannot be acted on yet carries none',
  links.find((l) => l.kind === 'registration_received').urls.length === 0);
check('and it is the sign-in screen, not a page inside the portal',
  links.every((l) => l.urls.every((u) => u.replace(/[.,)]+$/, '') === 'https://portal.example.test')),
  links.flatMap((l) => l.urls).filter((u) => u !== 'https://portal.example.test').join(' · '));

console.log('\nA LINK NOBODY CAN FOLLOW');
/* The address was left as the example from the README on the first
   deployment, so every message pointed at https://your-policyhub-url. It is
   said out loud at startup and on the Settings screen rather than discovered
   by an investor clicking it. */
const { appUrlProblem } = await import('../src/mail.js');
const realUrl = process.env.APP_URL;
for (const [value, expect] of [['', true], ['not-a-url', true],
  ['https://your-policyhub-url', true], ['https://portal.example.test', false]]) {
  process.env.APP_URL = value;
  check(`${value || '(nothing)'} is ${expect ? 'called out' : 'accepted'}`,
    !!appUrlProblem() === expect, appUrlProblem() || 'fine');
}
process.env.APP_URL = realUrl;

console.log('\nOVER THE WIRE');
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, { ...o,
  body: o.body && JSON.stringify(o.body),
  headers: { Cookie: admin, 'Content-Type': 'application/json' } });
const prefs = await (await api('/me/notifications')).json();
check('somebody is shown only the kinds addressed to them',
  prefs.kinds.every((k) => k.who !== 'investor'), prefs.kinds.map((k) => k.who).join(','));
check('a forced kind is shown as on and not offered as a choice',
  prefs.kinds.filter((k) => k.forced).every((k) => k.enabled));
check('switching one off sticks',
  (await api('/me/notifications', { method: 'PUT',
    body: { kinds: { agreement_signed: false } } })).status === 200
  && (await (await api('/me/notifications')).json())
      .kinds.find((k) => k.kind === 'agreement_signed').enabled === false);
check('switching a forced one off does not',
  (await api('/me/notifications', { method: 'PUT',
    body: { kinds: { new_location: false } } })).status === 200
  && (await (await api('/me/notifications')).json())
      .kinds.find((k) => k.kind === 'new_location').enabled === true);
await clearPrefs();

const health = await (await api('/mail/health')).json();
check('an administrator can see whether the post is going out',
  typeof health.configured === 'boolean' && typeof health.counts === 'object');
check('and nothing in that report is the contents of a message',
  !JSON.stringify(health).match(/body_text|body_html/));

console.log('\nTHE BUTTON THAT PROVES IT');
/* The whole path, through a server of its own started with a key: sign in,
   press the button, and see the message arrive at the provider. Worth the
   trouble because this is the exact path that broke — every piece below it
   was tested, and the route on top still answered "unknown mail kind test".
   A 503 when no key is set is not the same as a 200 when one is. */
const { spawn } = await import('node:child_process');
const PORT = 3411 + (process.pid % 40);
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT),
    SESSION_SECRET: 'mail-test-secret-mail-test-secret-0123',
    RESEND_API_KEY: 'test-key-not-real',
    MAIL_API_URL: `http://127.0.0.1:${port}/emails`,
    MAIL_FROM: 'PolicyHub <notices@example.test>',
    APP_URL: 'https://portal.example.test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const up = await new Promise((resolve) => {
  const bail = setTimeout(() => resolve(false), 25000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('running')) { clearTimeout(bail); resolve(true); }
  });
});
check('a server with a key set starts', up);
if (up) {
  const own = `http://127.0.0.1:${PORT}`;
  const cookie = await login(ADMIN.email, ADMIN.password, own);
  const before = received.length;
  const r = await fetch(`${own}/api/mail/test`, { method: 'POST', headers: { Cookie: cookie } });
  const body = await r.json();
  check('the test button works rather than refusing its own message',
    r.status === 200, `${r.status} ${JSON.stringify(body)}`);
  check('and it actually reached the provider', received.length > before,
    `${received.length - before} arrived`);
  const last = received[received.length - 1];
  check('addressed to whoever pressed it', last?.body?.to?.[0] === ADMIN.email,
    last?.body?.to?.[0]);
  check('saying what it is for',
    /test/i.test(last?.body?.subject || ''), last?.body?.subject);
  check('the reply says where it went', body.to === ADMIN.email, body.to);
  await q(`DELETE FROM email_outbox WHERE kind = 'test' AND to_email = $1`, [ADMIN.email]);
}
server.kill();

await wipe(); await clearPrefs();
stub.close();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL MAIL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
