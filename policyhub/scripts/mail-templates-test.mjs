/* =====================================================================
   The wording of the automated messages, owned by the office.

   Every message has a default written in src/mail.js. Good defaults,
   and also in a file nobody at the firm can open: "change this email to
   say X" cost a code change and a deployment, which is a silly price
   for a sentence.

   So an override table, empty by default. What has to be true of it:

     - Nothing changes until somebody changes something. A kind with no
       row behaves exactly as it did before this existed.
     - The starting point is the real wording. The default offered for
       editing is got by running the actual template, not transcribed by
       hand, so it cannot drift from what is being sent.
     - A line whose field has no value for a particular message is
       dropped from that message, so an optional figure never leaves a
       sentence with a hole in it.
     - Administrators only. These are the words the firm says to its
       investors in writing.

   Idempotent: the kinds it touches are reverted first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const KIND = 'opportunity_shared';
const SPARE = 'capital_call';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const call = (c) => (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const api = call(cookie);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const k of [KIND, SPARE]) await api(`/mail-templates/${k}`, { method: 'DELETE' });
};
await wipe();

const list = async () => (await json(await api('/mail-templates')));
const one = async (kind) => (await list()).templates.find((t) => t.kind === kind);

console.log('THE DEFAULTS ARE THE REAL WORDING, WITH THE FIELDS STILL IN THEM');
const all = await list();
check('every message is on the list', (all.templates || []).length >= 18,
  String((all.templates || []).length));
const t = await one(KIND);
check('each carries a label somebody can recognise it by', !!t.label && t.label !== KIND,
  t.label);
check('and the fields it has to work with',
  t.fields.includes('headline') && t.fields.includes('rate'), t.fields.join(','));
check('the default subject is the one in the source',
  t.default.subject === 'A new opportunity: {{headline}}', t.default.subject);
check('and the body has its placeholders, not a specimen',
  /\{\{headline\}\}/.test(t.default.body) && /\{\{link\}\}/.test(t.default.body),
  t.default.body.slice(0, 90));
check('including the clauses that are only sometimes taken',
  /\{\{rate\}\}/.test(t.default.body) && /\{\{closes\}\}/.test(t.default.body));
check('nothing is overridden to begin with', t.custom === null, JSON.stringify(t.custom));
check('and a specimen value comes with each field',
  !!all.samples[KIND]?.headline, JSON.stringify(all.samples[KIND]));

console.log('\nONE CAN BE REWRITTEN, AND IT IS WHAT GOES OUT');
const SUBJ = 'Poel Capital — a case for you: {{headline}}';
const BODY = '{{name}},\n\nWe have a case we think is worth your time: {{headline}}.\n\n'
  + 'At life expectancy it works out at {{rate}}.\n'
  + 'The offer closes on {{closes}}.\n\n'
  + 'Everything is on your portal. {{link}}';
const saved = await api(`/mail-templates/${KIND}`, { method: 'PUT',
  body: { subject: SUBJ, body: BODY } });
check('it saves', saved.status === 200, String(saved.status));
const after = await one(KIND);
check('and comes back as the office’s own', after.custom?.subject === SUBJ,
  String(after.custom?.subject));
check('signed by whoever wrote it', !!after.custom?.updated_by_name,
  String(after.custom?.updated_by_name));
check('with the default still a click away', after.default.subject.includes('{{headline}}'));

/* The proof that matters: that `sendMail` uses it. `compose` is the one
   function that chooses between the office's wording and the
   application's, and every message in the application goes through it,
   so proving this is proving all of them. The server's own cache is
   dropped first -- this test is a second process and holds its own. */
const { compose, forgetTemplates } = await import('../src/mail.js');
forgetTemplates();
const made = await compose(KIND, { name: 'Ada', headline: 'Northbank · $2m',
  rate: '14.2%', closes: '31 October 2026' });
check('and it is what the application would send',
  made.custom === true && made.subject === 'Poel Capital — a case for you: Northbank · $2m',
  made.subject);
check('with the body the office wrote, not the one it ships with',
  /case we think is worth your time/.test(made.text), made.text.slice(0, 80));

const inv = call(await login(INVESTOR1.email, INVESTOR1.password));
check('an investor cannot read the wording screen',
  (await inv('/mail-templates')).status === 403);
const mgr = call(await login(MANAGER1.email, MANAGER1.password));
check('nor can a manager', (await mgr('/mail-templates')).status === 403);
check('nor write to it',
  (await mgr(`/mail-templates/${KIND}`, { method: 'PUT',
    body: { subject: 'x', body: 'y' } })).status === 403);

console.log('\nAND A LINE WHOSE FIGURE IS MISSING IS LEFT OUT ALTOGETHER');
/* Sent to the signed-in administrator, as a specimen, which is the one
   path that renders a template end to end without needing a real deal. */
const spec = await api(`/mail-templates/${KIND}/test`, { method: 'POST',
  body: { subject: SUBJ, body: BODY } });
check('a specimen can be posted to yourself', [200, 503].includes(spec.status),
  String(spec.status));

/* The rule itself, checked directly on the renderer rather than through
   the post: a draft whose optional field is blank loses that line. */
const { render } = await import('../src/mail.js');
const full = render(BODY, { name: 'Ada', headline: 'Northbank · $2m', rate: '14.2%',
  closes: '31 October 2026' });
check('every line survives when every figure is there',
  /works out at 14\.2%/.test(full) && /closes on 31 October/.test(full), full.slice(0, 120));
const thin = render(BODY, { name: 'Ada', headline: 'Northbank · $2m', rate: '', closes: '' });
check('and the two optional ones vanish when they are not',
  !/works out at/.test(thin) && !/closes on/.test(thin), thin);
check('leaving the rest reading properly, with no hole in it',
  /case we think is worth your time/.test(thin) && !/\n\n\n/.test(thin), JSON.stringify(thin));

console.log('\nAND REVERTING PUTS THE APPLICATION’S WORDS BACK');
const gone = await api(`/mail-templates/${KIND}`, { method: 'DELETE' });
check('it reverts', gone.status === 200, String(gone.status));
check('and the kind is plain again', (await one(KIND)).custom === null);
forgetTemplates();
const plain = await compose(KIND, { name: 'Ada', headline: 'Northbank · $2m',
  rate: '14.2%', closes: '31 October 2026' });
check('and the application is back on its own words',
  plain.custom === false && plain.subject === 'A new opportunity: Northbank · $2m',
  plain.subject);

console.log('\nTHE SMALL REFUSALS');
check('an unknown message cannot be written to',
  (await api('/mail-templates/not_a_message', { method: 'PUT',
    body: { subject: 'a', body: 'b' } })).status === 404);
check('and half a message is refused rather than half-saved',
  (await api(`/mail-templates/${SPARE}`, { method: 'PUT',
    body: { subject: 'Only a subject', body: '  ' } })).status === 400);
check('so the kind is still on its default', (await one(SPARE)).custom === null);

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All mail wording checks passed.'}`);
process.exit(fails.length ? 1 : 0);
