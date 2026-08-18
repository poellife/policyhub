/* =====================================================================
   Documents.

   A filing cabinet is only useful if it is also trustworthy, and the one
   thing that must never happen here is a K-1 reaching the wrong person.
   So most of this is about who can see what: an investor sees only what
   is addressed to them AND marked shared, a manager sees the firm's
   papers and their own entities', and a draft stays a draft.

   The rest is the boring, load-bearing kind of correctness — the bytes
   that come out are the bytes that went in, and a stored file cannot be
   talked into executing in somebody's browser.

   Idempotent: fixtures are prefixed and removed first and last.
   ===================================================================== */
import { createHash, randomBytes } from 'node:crypto';
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'DOCTEST';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const admin = await login(ADMIN.email, ADMIN.password);
const pm1 = await login(MANAGER1.email, MANAGER1.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);

const me1 = (await json(await api(inv1, '/auth/me'))).investor.id;
const me2 = (await json(await api(inv2, '/auth/me'))).investor.id;
const funds = await json(await api(admin, '/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1');
const lcg2 = funds.find((f) => f.code === 'LCG2');

const wipe = async () => {
  for (const d of ((await json(await api(admin, '/documents'))) || [])
    .filter((x) => String(x.title).startsWith(PREFIX)))
    await api(admin, `/documents/${d.id}`, { method: 'DELETE' });
};
await wipe();

/** Post a document the way the browser does: multipart, one file. */
const post = async (cookie, { title, bytes, name = 'agreement.pdf', ...fields }) => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
  fd.append('title', title);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fetch(`${BASE}/api/documents`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
};

console.log('POSTING ONE');
const body = randomBytes(4096);
const sum = createHash('sha256').update(body).digest('hex');
const made = await post(admin, {
  title: `${PREFIX} LLC Agreement`, bytes: body, name: 'LCG1 Operating Agreement.pdf',
  category: 'LLC Agreement', doc_year: 2026, notes: 'Executed 12 March' });
check('an admin can post a document', made.status === 201, `status ${made.status}`);
const firmDoc = await json(made);

const listed = (await json(await api(admin, '/documents'))) || [];
const row = listed.find((d) => d.id === firmDoc.id);
check('it appears in the cabinet', !!row);
check('with its title, category and year',
  row.title === `${PREFIX} LLC Agreement` && row.category === 'LLC Agreement' && row.doc_year === 2026);
check('and the size it actually is', row.byte_size === 4096, String(row.byte_size));
check('the list never carries the bytes', row.content === undefined);
check('who posted it is recorded', !!row.uploaded_by_name, row.uploaded_by_name);

console.log('\nTHE BYTES COME BACK UNCHANGED');
const dl = await fetch(`${BASE}/api/documents/${firmDoc.id}/download`, { headers: { Cookie: admin } });
check('a download succeeds', dl.status === 200, `status ${dl.status}`);
const got = Buffer.from(await dl.arrayBuffer());
check('byte for byte', createHash('sha256').update(got).digest('hex') === sum,
  `${got.length} bytes`);
check('served as an attachment, never inline',
  /^attachment;/.test(dl.headers.get('content-disposition') || ''),
  dl.headers.get('content-disposition'));
check('with the file name, path stripped',
  /filename="LCG1 Operating Agreement.pdf"/.test(dl.headers.get('content-disposition') || ''));
check('and told not to sniff a type', dl.headers.get('x-content-type-options') === 'nosniff');
check('the type comes from the extension, not the upload',
  dl.headers.get('content-type')?.startsWith('application/pdf'),
  dl.headers.get('content-type'));

console.log('\nWHAT MAY BE STORED');
const script = await post(admin, {
  title: `${PREFIX} nope`, bytes: Buffer.from('<script>alert(1)</script>'), name: 'evil.html' });
check('an html file is refused outright', script.status === 400, `status ${script.status}`);
check('and says what is accepted', /Accepted:/.test((await json(script))?.error || ''));
const svg = await post(admin, {
  title: `${PREFIX} nope2`, bytes: Buffer.from('<svg onload="alert(1)"/>'), name: 'x.svg' });
check('so is an svg', svg.status === 400);
const empty = await post(admin, {
  title: `${PREFIX} nope3`, bytes: Buffer.alloc(0), name: 'blank.pdf' });
check('an empty file is refused', empty.status === 400);

console.log('\nA K-1 IS NOT SHARED UNTIL IT IS SHARED');
const draft = await json(await post(admin, {
  title: `${PREFIX} K-1 2025`, bytes: randomBytes(1024), name: 'k1-2025.pdf',
  category: 'K-1', doc_year: 2025, investor_id: me1, shared: 'false' }));
check('an investor cannot see a draft addressed to them',
  !((await json(await api(inv1, '/documents'))) || []).some((d) => d.id === draft.id));
check('nor download it', (await fetch(`${BASE}/api/documents/${draft.id}/download`,
  { headers: { Cookie: inv1 } })).status === 404);

await api(admin, `/documents/${draft.id}`, { method: 'PUT', body: {
  title: `${PREFIX} K-1 2025`, category: 'K-1', doc_year: 2025,
  investor_id: me1, shared: true } });
check('sharing it puts it in their hands',
  ((await json(await api(inv1, '/documents'))) || []).some((d) => d.id === draft.id));
check('and they can download it',
  (await fetch(`${BASE}/api/documents/${draft.id}/download`, { headers: { Cookie: inv1 } })).status === 200);
check('the other investor still cannot see it',
  !((await json(await api(inv2, '/documents'))) || []).some((d) => d.id === draft.id));
check('nor download it by guessing the id',
  (await fetch(`${BASE}/api/documents/${draft.id}/download`, { headers: { Cookie: inv2 } })).status === 404);

console.log('\nAN INVESTOR SEES ONLY THEIR OWN SHELF');
const invSees = (await json(await api(inv1, '/documents'))) || [];
check('the firm-wide agreement is not theirs', !invSees.some((d) => d.id === firmDoc.id));
check('everything they see is addressed to them',
  invSees.every((d) => d.investor_id === me1 && d.shared === true),
  invSees.map((d) => `${d.investor_id}/${d.shared}`).join(' '));
check('an investor cannot post one',
  (await post(inv1, { title: `${PREFIX} sneaky`, bytes: randomBytes(64) })).status === 403);
check('nor edit one', (await api(inv1, `/documents/${draft.id}`,
  { method: 'PUT', body: { title: 'mine now' } })).status === 403);
check('nor delete one',
  (await api(inv1, `/documents/${draft.id}`, { method: 'DELETE' })).status === 403);

console.log('\nA MANAGER SEES THEIR OWN ENTITIES');
const ownEntity = await json(await post(admin, {
  title: `${PREFIX} LCG1 side letter`, bytes: randomBytes(512), name: 'side.pdf',
  category: 'Correspondence', fund_id: lcg1.id }));
const otherEntity = await json(await post(admin, {
  title: `${PREFIX} LCG2 side letter`, bytes: randomBytes(512), name: 'side2.pdf',
  category: 'Correspondence', fund_id: lcg2.id }));
const pmSees = (await json(await api(pm1, '/documents'))) || [];
check('the firm-wide agreement reaches every member of staff',
  pmSees.some((d) => d.id === firmDoc.id));
check('so does their own entity\'s letter', pmSees.some((d) => d.id === ownEntity.id));
check('the other entity\'s does not', !pmSees.some((d) => d.id === otherEntity.id));
check('and cannot be downloaded either',
  (await fetch(`${BASE}/api/documents/${otherEntity.id}/download`,
    { headers: { Cookie: pm1 } })).status === 404);
check('a manager cannot post into an entity that is not theirs',
  (await post(pm1, { title: `${PREFIX} nope4`, bytes: randomBytes(64),
    fund_id: lcg2.id })).status === 403);
check('but can post into their own',
  (await post(pm1, { title: `${PREFIX} pm note`, bytes: randomBytes(64),
    fund_id: lcg1.id })).status === 201);

console.log('\nSEARCH AND CATEGORIES');
const k1s = (await json(await api(admin, '/documents?category=K-1'))) || [];
check('filtering by category works', k1s.every((d) => d.category === 'K-1') && k1s.length >= 1,
  `${k1s.length} found`);
const found = (await json(await api(admin, `/documents?search=${encodeURIComponent('side letter')}`))) || [];
check('search finds by title', found.some((d) => d.id === ownEntity.id));
const cats = await json(await api(admin, '/documents/categories'));
check('the category list is published', Array.isArray(cats) && cats.includes('K-1'),
  (cats || []).join(', '));

console.log('\nDELETING');
check('an editor cannot delete',
  (await api(pm1, `/documents/${otherEntity.id}`, { method: 'DELETE' })).status === 404);
check('an admin can',
  (await api(admin, `/documents/${otherEntity.id}`, { method: 'DELETE' })).status === 200);
check('and it is gone',
  (await fetch(`${BASE}/api/documents/${otherEntity.id}/download`,
    { headers: { Cookie: admin } })).status === 404);

console.log('\nUNAUTHENTICATED');
for (const path of ['/documents', `/documents/${firmDoc.id}/download`]) {
  const r = await fetch(`${BASE}/api${path}`);
  check(`GET ${path} needs a session`, r.status === 401, `status ${r.status}`);
}

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL DOCUMENT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
