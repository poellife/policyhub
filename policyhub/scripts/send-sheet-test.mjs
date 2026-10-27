/* =====================================================================
   Emailing the one-pager from the portal, PDF attached.

   The covering note used to be composed here and sent from somebody's
   own mail client, with the sheet downloaded and attached by hand —
   three steps outside the application, and the one that went wrong
   (attaching last week's sheet) was the one it could not see.

   This suite runs its own copy of the server, pointed at a stand-in for
   the mail provider that writes down every request it receives, so what
   is checked is exactly what would leave the building: the recipient,
   the subject, the words, the reply-to, and the PDF itself.

   What has to be true:
     - The investor gets the sheet attached, as a real PDF, with the
       words the sender edited, and replies come back to the sender.
     - The deal is shared with them as it is sent, so the link works,
       and the send is recorded on the deal.
     - A preview goes to the sender only, shares nothing, records nothing.
     - The insured's name never leaves in an email, however it got typed
       in — and an investor who shares a surname is not mistaken for him.
     - Only investors the sender may write to, only staff who may edit
       deals, only an open deal.
     - The note quotes the same figures as the sheet, scenario and all.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ADMIN, MANAGER1, INVESTOR1, login as loginAt } from './test-config.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'SENDSHEET';
const APP_PORT = 3417;
const MAIL_PORT = 3418;
const BASE = `http://localhost:${APP_PORT}`;
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* ------------------------------------------------------------------ *
 * The stand-in mail provider. Answers like Resend does, keeps a copy.
 * ------------------------------------------------------------------ */
const inbox = [];
/* The newest message to an address. The server's own worker also sends
   whatever else is waiting in the shared test outbox, so a message is
   found by who it was for, never by where it landed in the list. */
const lastTo = (addr) => inbox.filter((m) => (m.to || [])[0] === addr).at(-1) || {};
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { inbox.push({ auth: req.headers.authorization, ...JSON.parse(raw) }); } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `stub-${inbox.length}` }));
  });
});
await new Promise((r) => { provider.listen(MAIL_PORT, r); });

/* ------------------------------------------------------------------ *
 * Our own server, with mail switched on and aimed at the stand-in.
 * ------------------------------------------------------------------ */
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    NODE_ENV: 'development',
    SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    RESEND_API_KEY: 'stub-key',
    MAIL_API_URL: `http://localhost:${MAIL_PORT}/emails`,
    MAIL_FROM: 'Poel Capital Portal <notices@example.test>',
    APP_URL: BASE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stop = async () => { server.kill(); provider.close(); await sleep(300); };
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ }
  await sleep(500);
}

const login = (email, password) => loginAt(email, password, BASE);
const cookie = await login(ADMIN.email, ADMIN.password);
const call = (c) => (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: c, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const api = call(cookie);
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
  for (const i of ((await json(await api('/investors'))) || [])
    .filter((x) => String(x.name).startsWith(PREFIX)))
    await api(`/investors/${i.id}`, { method: 'DELETE', body: { confirm: i.name } });
};

try {
  await wipe();

  const me = await json(await api('/auth/me'));
  const adminEmail = me.user?.email || me.email || ADMIN.email;
  const funds = await json(await api('/funds'));
  const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];

  /* The insured is a Coleman. So is one of the investors -- which is the
     case the name check has to get right in both directions. */
  const deal = await json(await api('/opportunities', { method: 'POST', body: {
    policy_number: `${PREFIX}-1`, carrier_name: 'Northbank Life', product_type: 'UL',
    face_amount: 2000000, fund_id: lcg1.id, status: 'Open',
    insured_last_name: 'Coleman', insured_first_name: 'James', insured_dob: '1942-03-02',
    insured_gender: 'M', insured_state: 'MI',
    le_months: 72, le_provider: '21st Services', le_date: '2026-02-02',
    asking_price: 300000, annual_premium: 40000 } }));
  check('(fixture deal)', !!deal?.id, JSON.stringify(deal).slice(0, 120));

  const namesake = await json(await api('/investors', { method: 'POST', body: {
    name: `${PREFIX} Ada Coleman`, email: 'ada.coleman@example.test', fund_id: lcg1.id } }));
  const nomail = await json(await api('/investors', { method: 'POST', body: {
    name: `${PREFIX} No Address`, fund_id: lcg1.id } }));
  check('(fixture investors)', !!namesake?.id && !!nomail?.id,
    JSON.stringify(namesake).slice(0, 120));

  console.log('THE DRAFT OFFERS EVERY INVESTOR THE SENDER MAY WRITE TO');
  const draft = await json(await api(`/opportunities/${deal.id}/email?share=100`));
  check('the draft comes back', !!draft?.subject && !!draft?.body, JSON.stringify(draft).slice(0, 120));
  check('it says mail is switched on', draft.mail_ready === true);
  const ada = (draft.recipients || []).find((r) => r.id === namesake.id);
  check('an investor not yet shown the deal is on the list', !!ada && ada.shown === false,
    JSON.stringify(ada));
  check('with the address the email will go to', ada?.email === 'ada.coleman@example.test');
  check('the draft names nobody', !/James|Coleman/.test(`${draft.subject}\n${draft.body}`),
    draft.body.slice(0, 200));

  console.log('\nA PREVIEW GOES TO THE SENDER AND NOWHERE ELSE');
  inbox.length = 0;
  const pv = await json(await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { preview: true, subject: draft.subject, body: draft.body, share: 100 } }));
  check('it is accepted and goes out straight away', pv?.ok && pv.status === 'Sent',
    JSON.stringify(pv));
  const pvMail = lastTo(pv?.to);
  check('to the sender’s own address', pv?.to === adminEmail && !!pvMail.subject,
    `${pv?.to} / ${adminEmail}`);
  check('marked as a preview', /^\[Preview\]/.test(pvMail.subject || ''), pvMail.subject);
  check('with the PDF attached', pvMail.attachments?.[0]?.filename?.endsWith('.pdf'),
    JSON.stringify(pvMail.attachments?.map((a) => a.filename)));
  const afterPv = await json(await api(`/opportunities/${deal.id}`));
  check('and nothing is shared', !(afterPv.shares || []).some((x) => x.investor_id === namesake.id));
  check('nor recorded as sent', (afterPv.sends || []).length === 0,
    String((afterPv.sends || []).length));

  console.log('\nSENDING IT FOR REAL');
  inbox.length = 0;
  const edited = `${ada.name},\n\nHere is the Northbank case we discussed on Tuesday.\n\n`
    + 'Jonathan';
  const sent = await json(await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { investor_id: namesake.id, subject: 'The Northbank case', body: edited, share: 25 } }));
  check('it goes', sent?.ok && sent.status === 'Sent', JSON.stringify(sent));
  const mail = lastTo('ada.coleman@example.test');
  check('to the investor’s address', mail.to?.[0] === 'ada.coleman@example.test',
    JSON.stringify(mail.to));
  check('with the subject as edited', mail.subject === 'The Northbank case', mail.subject);
  check('and the words as edited', (mail.text || '').includes('we discussed on Tuesday'),
    (mail.text || '').slice(0, 120));
  check('from the firm', /Poel Capital/.test(mail.from || ''), mail.from);
  check('with replies coming back to the sender', mail.reply_to === adminEmail, mail.reply_to);
  const pdf = Buffer.from(mail.attachments?.[0]?.content || '', 'base64');
  check('the attachment is a real PDF', pdf.subarray(0, 5).toString() === '%PDF-',
    pdf.subarray(0, 8).toString());
  check('named for the deal', mail.attachments?.[0]?.filename === `${PREFIX}-1-one-pager.pdf`,
    mail.attachments?.[0]?.filename);
  check('and the provider was asked with the key', mail.auth === 'Bearer stub-key');

  const afterSend = await json(await api(`/opportunities/${deal.id}`));
  check('the deal is now shared with them, so the link works',
    (afterSend.shares || []).some((x) => x.investor_id === namesake.id));
  const rec = (afterSend.sends || [])[0];
  check('and the send is recorded on the deal', rec?.investor_id === namesake.id
    && rec.mail_status === 'Sent' && Number(rec.share_pct) === 25, JSON.stringify(rec));

  console.log('\nTHE INSURED’S NAME NEVER LEAVES IN AN EMAIL');
  for (const [label, text] of [
    ['his surname in the message', `${ada.name},\n\nThis is the Coleman file.`],
    ['his surname in lower case', `${ada.name},\n\nthe coleman policy`],
    ['his first name', `${ada.name},\n\nJames is 84.`],
  ]) {
    const r = await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
      body: { investor_id: namesake.id, subject: 'A case', body: text } });
    check(`refused: ${label}`, r.status === 400, String(r.status));
  }
  const r2 = await json(await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { investor_id: namesake.id, subject: 'James Coleman', body: 'See attached.' } }));
  check('and in the subject, saying which word it found',
    /names the insured/.test(r2?.error || '') && (r2?.names || []).includes('Coleman'),
    JSON.stringify(r2));
  /* "Ms Coleman" could be either of them. Refused, and told how to say
     it so it is unmistakably hers. */
  const r3 = await json(await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { investor_id: namesake.id, subject: 'A case', body: 'Dear Ms Coleman,\n\nSee attached.' } }));
  check('a surname alone, which could be either of theirs, is refused',
    /names the insured/.test(r3?.error || ''), JSON.stringify(r3));
  check('with the advice to write her name in full', /write it in full/.test(r3?.error || ''),
    r3?.error);
  const okFirst = await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { investor_id: namesake.id, subject: 'A case', body: `${ada.name},\n\nWe will call you.` } });
  check('a first name used as an ordinary word is not mistaken for him',
    okFirst.status === 200, String(okFirst.status));
  check('and writing to Ada Coleman by name is not mistaken for naming James Coleman',
    sent?.ok === true);

  console.log('\nTHE SMALL REFUSALS');
  const noAddr = await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { investor_id: nomail.id, subject: 'A case', body: 'See attached.' } });
  check('an investor with no address on file', noAddr.status === 400, String(noAddr.status));
  const nobody = await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { subject: 'A case', body: 'See attached.' } });
  check('nobody chosen', nobody.status === 400, String(nobody.status));
  const empty = await api(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
    body: { investor_id: namesake.id, subject: '', body: '' } });
  check('an empty message', empty.status === 400, String(empty.status));

  const closed = await json(await api('/opportunities', { method: 'POST', body: {
    policy_number: `${PREFIX}-2`, carrier_name: 'Northbank Life', fund_id: lcg1.id,
    insured_last_name: 'Other', status: 'Closed' } }));
  const toClosed = await api(`/opportunities/${closed.id}/send-sheet`, { method: 'POST',
    body: { investor_id: namesake.id, subject: 'A case', body: 'See attached.' } });
  check('a closed deal, whose link would lead nowhere', toClosed.status === 409,
    String(toClosed.status));
  const pvClosed = await api(`/opportunities/${closed.id}/send-sheet`, { method: 'POST',
    body: { preview: true, subject: 'A case', body: 'See attached.' } });
  check('though a preview of it is fine', pvClosed.status === 200, String(pvClosed.status));

  const inv = call(await login(INVESTOR1.email, INVESTOR1.password));
  check('an investor cannot send one',
    (await inv(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
      body: { preview: true, subject: 'x', body: 'y' } })).status === 403);

  /* A manager may send, but only to investors he may write to. */
  const mgr = call(await login(MANAGER1.email, MANAGER1.password));
  const mgrDraft = await json(await mgr(`/opportunities/${deal.id}/email`));
  const outsider = (await json(await api('/investors')))
    .find((i) => !(mgrDraft?.recipients || []).some((r) => r.id === i.id));
  if (outsider) {
    const r = await mgr(`/opportunities/${deal.id}/send-sheet`, { method: 'POST',
      body: { investor_id: outsider.id, subject: 'A case', body: 'See attached.' } });
    check('a manager cannot send to an investor outside his book', r.status === 404,
      String(r.status));
  } else {
    console.log('  (skipped — the manager can write to every investor in this database)');
  }

  console.log('\nTHE NOTE QUOTES WHAT THE SHEET QUOTES');
  const scen = await json(await api(`/opportunities/${deal.id}/scenarios`, { method: 'POST',
    body: { name: 'At 260', asking_price: 260000 } }));
  await api(`/opportunities/${deal.id}/scenarios/shown`, { method: 'PUT',
    body: { scenario_id: scen.id } });
  const scenDraft = await json(await api(`/opportunities/${deal.id}/email?share=100`));
  check('with a scenario chosen, the note quotes its price',
    /260,000/.test(scenDraft.body) && !/300,000/.test(scenDraft.body),
    scenDraft.body.match(/\$[\d,]+/g)?.join(' '));

  console.log('\nON THE SCREEN');
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await br.newContext({ viewport: { width: 1450, height: 1200 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE);
  await p.fill('#email', ADMIN.email);
  await p.fill('#password', ADMIN.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row, .page-head', { timeout: 20000 });
  await p.goto(`${BASE}/#/opportunity/${deal.id}/sheet-100`);
  await p.waitForSelector('#mailTo', { timeout: 20000 });
  check('the one-pager screen offers to send it', await p.locator('#mailSend').count() === 1);
  check('the recipient list starts on nobody', (await p.locator('#mailTo').inputValue()) === '');
  await p.click('#mailSend');
  await p.waitForTimeout(500);
  check('pressing Send with nobody chosen says so rather than sending',
    /Choose who to send it to/.test(await p.locator('#mailResult').innerText()));
  await p.selectOption('#mailTo', String(namesake.id));
  await p.waitForTimeout(200);
  check('choosing them puts their name at the top of the message',
    (await p.locator('#mailBody').inputValue()).startsWith(`${ada.name},`),
    (await p.locator('#mailBody').inputValue()).slice(0, 60));
  const before = inbox.filter((m) => (m.to || [])[0] === 'ada.coleman@example.test').length;
  await p.click('#mailSend');
  await p.waitForSelector('#mailResult .ok-box', { timeout: 15000 });
  const said = await p.locator('#mailResult').innerText();
  check('and Send sends it, there and then', /Sent to/.test(said) && !/queued/i.test(said)
    && inbox.filter((m) => (m.to || [])[0] === 'ada.coleman@example.test').length === before + 1
    && lastTo('ada.coleman@example.test').attachments?.length === 1, said);

  await p.goto(`${BASE}/#/opportunity/${deal.id}`);
  await p.waitForSelector('.page-head', { timeout: 20000 });
  await p.waitForTimeout(900);
  const hist = (await p.locator('.card:has(h2:text-is("One-pager emailed"))').innerText())
    .replace(/\s+/g, ' ');
  check('the deal lists who was emailed it', hist.includes(ada.name) && /Sent/i.test(hist),
    hist.slice(0, 200));
  check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
  await br.close();
} catch (e) {
  check('the suite ran to the end', false, `${e.message}\n${serverLog.slice(-600)}`);
} finally {
  await wipe().catch(() => {});
  await stop();
}

console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All one-pager email checks passed.'}`);
process.exit(fails.length ? 1 : 0);
