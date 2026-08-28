/* =====================================================================
   Drafting an operating agreement, sending it, and signing it.

   The thing that makes an electronic signature worth anything is not
   the typing — it is that the text cannot move underneath it. So the
   checks here are mostly about that: the wording is frozen when the
   agreement goes out, a signature records which text it was against,
   editing an issued agreement is refused, and recalling one says out
   loud that the signatures are being torn up.

   The rest is who may do what: a manager drafts and sends, a member
   signs their own line and nobody else's, and the executed copy lands
   in each member's own document cabinet.

   Runs end to end through the browser as well as the API, because the
   sign box is the part a person actually uses.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'AGREE';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const admin = await login(ADMIN.email, ADMIN.password);
const inv1 = await login(INVESTOR1.email, INVESTOR1.password);
const inv2 = await login(INVESTOR2.email, INVESTOR2.password);
const call = (c, p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const a of ((await json(await call(admin, '/agreements'))) || [])
    .filter((x) => String(x.title).startsWith(PREFIX))) {
    if (a.status !== 'Draft') await call(admin, `/agreements/${a.id}/recall`, { method: 'POST' });
    await call(admin, `/agreements/${a.id}`, { method: 'DELETE' });
  }
  for (const d of ((await json(await call(admin, `/documents?search=${PREFIX}`))) || [])
    .filter((x) => String(x.title).startsWith(PREFIX)))
    await call(admin, `/documents/${d.id}`, { method: 'DELETE' });
};
await wipe();

const investors = await json(await call(admin, '/investors'));
const funds = await json(await call(admin, '/funds'));
const me1 = (await json(await call(inv1, '/auth/me')))?.investor_id
  ?? investors.find((i) => /one/i.test(i.name))?.id;
const me2 = (await json(await call(inv2, '/auth/me')))?.investor_id
  ?? investors.find((i) => /two/i.test(i.name))?.id;
const name1 = investors.find((i) => i.id === me1).name;
const name2 = investors.find((i) => i.id === me2).name;

console.log('DRAFTING IT');
const TERMS = {
  llc_name: `${PREFIX} HOLDINGS 9 LLC`, state: 'Delaware', effective_date: '2026-09-01',
  principal_office: '5049 Bluebell Avenue, Valley Village, CA 91607',
  insured_name: 'Cleves Delp', policy_product: 'Indexed Universal Life',
  policy_number: 'IUL1077194', manager_name: 'Alan Spiegel',
  pref_return_pct: 15, member_split_pct: 75, majority_pct: 75,
  bank_name: 'Wells Fargo Bank, N.A.', account_number: '1819977842',
  wire_routing: '121000248', wire_memo: 'AGREE9 Initial Capital',
};
const made = await json(await call(admin, '/agreements', { method: 'POST', body: {
  title: `${PREFIX} Holdings 9`, fund_id: funds[0].id, terms: TERMS } }));
check('a draft is created', !!made?.id, JSON.stringify(made).slice(0, 90));

const draft = await json(await call(admin, `/agreements/${made.id}`));
check('it renders the whole standard form', draft.blocks.length > 90, `${draft.blocks.length} blocks`);
const text = draft.blocks.map((b) => b.text || '').join(' ');
check('with the LLC named throughout', (text.match(new RegExp(TERMS.llc_name, 'g')) || []).length >= 3);
check('the state of formation carried into the governing law clause',
  /laws of the State of Delaware/.test(text));
check('the preferred return where the waterfall needs it', /15% internal rate of return/.test(text));
check('and the carry split stated both ways',
  /75% to the Members/.test(text) && /25% to the Manager/.test(text));
check('the policy it was formed to hold is identified',
  /Indexed Universal Life insurance policy number IUL1077194/.test(text));
check('a draft has no frozen text yet', draft.body_hash === null, String(draft.body_hash));

console.log('\nIT WILL NOT GO OUT HALF-FINISHED');
const noMembers = await json(await call(admin, `/agreements/${made.id}/issue`, { method: 'POST' }));
check('sending it with no members is refused', /at least one member/i.test(noMembers.error || ''),
  noMembers.error);

const blankOne = await json(await call(admin, '/agreements', { method: 'POST', body: {
  title: `${PREFIX} Nameless`, terms: { effective_date: '2026-09-01' } } }));
const missing = await json(await call(admin, `/agreements/${blankOne.id}/issue`, { method: 'POST' }));
check('and so is one with the blanks still in it', /Still to fill in/.test(missing.error || ''),
  missing.error);
await call(admin, `/agreements/${blankOne.id}`, { method: 'DELETE' });

console.log('\nTHE MEMBERS');
await call(admin, `/agreements/${made.id}/signers`, { method: 'PUT', body: { signers: [
  { role: 'Manager', name: 'Alan Spiegel' },
  { role: 'Member', investor_id: me1, name: name1, email: 'one@example.com',
    address: '2 Oak Street, Southfield MI', contribution: 53000, pct: 20 },
  { role: 'Member', investor_id: me2, name: name2, email: 'two@example.com',
    address: '9 Elm Road, Lakewood NJ', contribution: 212000, pct: 80 },
] } });
const withMembers = await json(await call(admin, `/agreements/${made.id}`));
check('three parties are on it', withMembers.signers.length === 3);
const schedule = withMembers.blocks.find((b) => b.type === 'table'
  && (b.columns || []).includes('Initial Contribution'));
check('Schedule 1 lists them with their contributions', schedule.rows.length === 3,
  JSON.stringify(schedule.rows));
check('and totals the capital', schedule.rows[2][1] === '$265,000.00', schedule.rows[2][1]);
check('and the interests', schedule.rows[2][2] === '100%', schedule.rows[2][2]);

console.log('\nBEFORE IT IS SENT, NOBODY ELSE CAN SEE IT');
check('an investor cannot read a draft',
  (await call(inv1, `/agreements/${made.id}`)).status === 404);
check('and it is not in their list',
  ((await json(await call(inv1, '/agreements'))) || []).every((a) => a.id !== made.id));

console.log('\nSENDING IT FREEZES THE TEXT');
const issued = await json(await call(admin, `/agreements/${made.id}/issue`, { method: 'POST' }));
check('it goes out to both members', issued.sent_to === 2, String(issued.sent_to));
check('and the text is fingerprinted', /^[0-9a-f]{64}$/.test(issued.body_hash || ''),
  String(issued.body_hash).slice(0, 20));

const edit = await json(await call(admin, `/agreements/${made.id}`, { method: 'PUT', body: {
  terms: { ...TERMS, pref_return_pct: 8 } } }));
check('editing it now is refused', /already gone out/.test(edit.error || ''), edit.error);
const reparty = await json(await call(admin, `/agreements/${made.id}/signers`, { method: 'PUT',
  body: { signers: [{ role: 'Member', investor_id: me1, name: name1, pct: 100 }] } }));
check('and so is quietly changing who is on it', /Recall/.test(reparty.error || ''), reparty.error);

console.log('\nWHAT A MEMBER SEES');
const seen = await json(await call(inv1, `/agreements/${made.id}`));
check('the member can now read it', seen?.id === made.id);
check('all of it, not a summary', seen.blocks.length === withMembers.blocks.length);
check('their own line is pointed out', seen.me?.investor_id === me1 || seen.me?.name === name1,
  JSON.stringify(seen.me || {}).slice(0, 80));
check('the other member is on the Schedule they are signing',
  seen.signers.length === 3, `${seen.signers.length}`);
check('but not that member’s email or notice address',
  seen.signers.every((s) => s.email === undefined && s.address === undefined));

console.log('\nSIGNING IT');
const wrongPerson = await json(await call(inv1, `/agreements/${made.id}/sign`, { method: 'POST',
  body: { signed_name: name2, agreed: true, body_hash: seen.body_hash } }));
check('you cannot sign in somebody else’s name', /Sign as/.test(wrongPerson.error || ''),
  wrongPerson.error);
const unticked = await json(await call(inv1, `/agreements/${made.id}/sign`, { method: 'POST',
  body: { signed_name: name1, body_hash: seen.body_hash } }));
check('nor without saying you mean it', /Tick the box/.test(unticked.error || ''), unticked.error);
const staleText = await json(await call(inv1, `/agreements/${made.id}/sign`, { method: 'POST',
  body: { signed_name: name1, agreed: true, body_hash: 'f'.repeat(64) } }));
check('nor against a version of the text that is not this one',
  /changed since this page was opened/.test(staleText.error || ''), staleText.error);

const signed1 = await json(await call(inv1, `/agreements/${made.id}/sign`, { method: 'POST',
  body: { signed_name: name1, agreed: true, body_hash: seen.body_hash } }));
check('the first member signs', signed1.ok === true && signed1.executed === false,
  JSON.stringify(signed1));
check('twice is refused', /already signed/.test(
  (await json(await call(inv1, `/agreements/${made.id}/sign`, { method: 'POST',
    body: { signed_name: name1, agreed: true } })))?.error || ''));

const afterOne = await json(await call(admin, `/agreements/${made.id}`));
const line1 = afterOne.signers.find((s) => s.investor_id === me1);
check('the signature records what was typed', line1.signed_name === name1, line1.signed_name);
check('when it happened', !!line1.signed_at);
check('where from', !!line1.signed_ip, line1.signed_ip);
check('and which text it was against',
  line1.signed_hash === afterOne.body_hash, `${line1.signed_hash}`.slice(0, 16));
check('the agreement is still out for signature', afterOne.status === 'Out for signature');

console.log('\nTHE LAST SIGNATURE EXECUTES IT');
await call(inv2, `/agreements/${made.id}/sign`, { method: 'POST',
  body: { signed_name: name2, agreed: true, body_hash: issued.body_hash } });
const done = await json(await call(admin, `/agreements/${made.id}/sign`, { method: 'POST',
  body: { signed_name: 'Alan Spiegel', agreed: true, body_hash: issued.body_hash } }));
check('the manager signs last and it executes', done.executed === true, JSON.stringify(done));
const executed = await json(await call(admin, `/agreements/${made.id}`));
check('the status says so', executed.status === 'Executed');
check('with the moment it happened', !!executed.executed_at);
check('and the text never moved', executed.body_hash === issued.body_hash);

console.log('\nTHE EXECUTED COPY IS FILED');
const docs1 = ((await json(await call(inv1, '/documents'))) || [])
  .filter((d) => String(d.title).startsWith(PREFIX));
const docs2 = ((await json(await call(inv2, '/documents'))) || [])
  .filter((d) => String(d.title).startsWith(PREFIX));
check('the first member has their copy', docs1.length === 1, `${docs1.length}`);
check('the second has theirs', docs2.length === 1, `${docs2.length}`);
check('filed as an LLC agreement', docs1[0]?.category === 'LLC Agreement', docs1[0]?.category);
check('as a PDF', /\.pdf$/.test(docs1[0]?.file_name || ''), docs1[0]?.file_name);
check('and it is their own copy, not a shared row', docs1[0].id !== docs2[0].id);

const pdfRes = await call(inv1, `/agreements/${made.id}/pdf`);
const pdf = Buffer.from(await pdfRes.arrayBuffer());
check('the agreement downloads as a PDF',
  pdfRes.headers.get('content-type') === 'application/pdf'
  && pdf.subarray(0, 5).toString() === '%PDF-', `${pdf.length} bytes`);
check('big enough to be the whole document', pdf.length > 20000, `${pdf.length} bytes`);
check('and it will not be sniffed into something else',
  pdfRes.headers.get('x-content-type-options') === 'nosniff');

console.log('\nWHAT CANNOT BE UNDONE QUIETLY');
const recall = await json(await call(admin, `/agreements/${made.id}/recall`, { method: 'POST' }));
check('an executed agreement cannot be pulled back', /fully executed/.test(recall.error || ''),
  recall.error);
const del = await json(await call(admin, `/agreements/${made.id}`, { method: 'DELETE' }));
check('nor deleted', /Only a draft/.test(del.error || ''), del.error);
const voided = await json(await call(admin, `/agreements/${made.id}/void`, { method: 'POST',
  body: { reason: 'Superseded by the restatement' } }));
check('voiding it is the way, and it needs a reason', voided.ok === true);
check('a void with no reason is refused', /Say why/.test(
  (await json(await call(admin, `/agreements/${made.id}/void`, { method: 'POST', body: {} })))?.error || ''));
const gone = await json(await call(admin, `/agreements/${made.id}`));
check('the signatures survive the void', gone.signed_count === 3, `${gone.signed_count}`);
check('and it says why it is no longer in force',
  /Superseded/.test(gone.void_reason), gone.void_reason);

/* --------------------------- on screen ---------------------------- */
console.log('\nON SCREEN');
const fresh = await json(await call(admin, '/agreements', { method: 'POST', body: {
  title: `${PREFIX} Screen`, fund_id: funds[0].id,
  terms: { ...TERMS, llc_name: `${PREFIX} SCREEN LLC` } } }));
await call(admin, `/agreements/${fresh.id}/signers`, { method: 'PUT', body: { signers: [
  { role: 'Manager', name: 'Alan Spiegel' },
  { role: 'Member', investor_id: me1, name: name1, contribution: 100000, pct: 100 },
] } });
await call(admin, `/agreements/${fresh.id}/issue`, { method: 'POST' });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', INVESTOR1.email); await p.fill('#password', INVESTOR1.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });
await p.waitForTimeout(1200);

const nav = p.locator('.nav a[href="#/agreements"]');
check('a member gets an Agreements tab', (await nav.count()) === 1);
check('badged with what is waiting on them',
  await nav.evaluate((el) => el.classList.contains('has-badge')));

await p.goto(`${BASE}/#/agreements`); await p.waitForSelector('table.data');
await p.waitForTimeout(800);
const listText = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the agreement is listed', listText.includes(`${PREFIX} SCREEN LLC`), listText.slice(0, 150));
check('with a line saying it needs signing', /waiting for your signature/i.test(listText));
await p.screenshot({ path: `${S}/ag1-list.png`, fullPage: true });

await p.locator('tr[data-id]').first().click();
await p.waitForSelector('.doc-sheet', { timeout: 10000 });
await p.waitForTimeout(700);
const page = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the whole document is on the page, not a summary',
  /IN WITNESS WHEREOF/.test(page) && /ARBITRATION/i.test(page) && /WIRE TRANSFER/i.test(page));
check('including the Schedule they are signing up to', /\$100,000\.00/.test(page));
check('and the signature blocks are drawn',
  (await p.locator('.doc-sig').count()) >= 2, `${await p.locator('.doc-sig').count()} blocks`);
check('with nothing written on them yet',
  (await p.locator('.doc-sig-mark').first().textContent()).trim() === '');
await p.screenshot({ path: `${S}/ag2-document.png`, fullPage: true });

await p.click('#signBtn');
await p.waitForSelector('dialog[open] input[name="signed_name"]');
await p.waitForTimeout(400);
const dlgText = (await p.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('the box says who they are signing as', dlgText.includes(name1), dlgText.slice(0, 120));
check('and what is being recorded',
  /record the moment you sign/.test(dlgText) && /fingerprint/.test(dlgText));
await p.fill('dialog[open] input[name="signed_name"]', name1);
await p.check('dialog[open] input[name="agreed"]');
await p.screenshot({ path: `${S}/ag3-signbox.png`, fullPage: true });
await p.click('dialog[open] button[type=submit]');
await p.waitForTimeout(2000);

const signedPage = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the signature appears on the document', signedPage.includes('Signed electronically'),
  signedPage.slice(signedPage.indexOf('IN WITNESS'), signedPage.indexOf('IN WITNESS') + 240));
check('the parties table shows it as signed', /Signed/.test(signedPage));
check('and the sign button is gone', (await p.locator('#signBtn').count()) === 0);
check('one signature still outstanding is named',
  /Waiting on Alan Spiegel/.test(signedPage), signedPage.slice(0, 200));
await p.screenshot({ path: `${S}/ag4-signed.png`, fullPage: true });

console.log(`\nERRORS: ${errs.length ? errs.join(' | ') : 'none'}`);
check('no page errors', errs.length === 0);

await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL AGREEMENT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
