/* =====================================================================
   PolicyHub — front end
   ===================================================================== */

import { lineChart, barChart, fmtMoney, fmtExact, seriesColor, hideTip } from './charts.js';
import { reportsView, buildOpportunitySheet, wireReports } from './reports.js';
// The agreement's clauses live in one file, read by the browser for preview
// and by the server for the PDF. See public/agreement-template.js.
import { AGREEMENT_FIELDS, FIELD_SECTIONS } from './agreement-template.js';
import { analyzeFlows, fmtRate, today as irrToday } from './irr.js';
// The build this page was served from. The server reports the same
// constant on /auth/me; if the two differ the deployment is half updated.
import { BUILD } from './build.js';
import { POLICY_FIELDS, POLICY_GROUPS, arrangeFields, packArrangement }
  from './policy-fields.js';

/* ------------------------------- api --------------------------------- */

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body instanceof FormData ? opts.body
      : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    state.user = null;
    render();
    throw new Error('Please sign in again');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------ state -------------------------------- */

const state = {
  user: null,
  route: 'dashboard',
  params: {},
  policies: [],
  /* Which owner entities the staff screens are narrowed to, and to what
     status. An array rather than one code: see the entity filter below. */
  filters: { search: '', status: '', funds: [] },
  /* The view this person asked to be remembered, as it came back from the
     server, so the picker can say whether what is on screen is it. */
  viewDefault: null,
  /* How policy returns are combined into a book return: 'weighted' or
     'simple'. See rateToggle below. Saved against the account the moment
     it changes, because it is a way of reading rather than a filter. */
  rateBasis: 'weighted',
  insuredSearch: '',
  investorSearch: '',
  investors: [],
  sort: { key: 'insured_last', dir: 1 },
  funds: [],
  oppCount: 0,        // drives the badge in the menu
  showDecided: false, // whether the registration queue shows decided ones too
  /* Whether the servicing page lists cancelled capital calls. A cancelled
     call stays on the record — it is part of what was asked and withdrawn —
     but it is not work, so it is off the page until somebody asks for it. */
  showCancelledCalls: false,
  // Which column the Maturities register is ordered by, and which way.
  matSort: { key: 'matured_on', dir: -1 },
  /* Policies ticked for deletion. A Set of ids rather than a flag on each
     row, so a selection survives sorting, searching and filtering — you can
     pick three from a carrier search, change the search, and pick two more. */
  selected: new Set(),
  /* Opportunities ticked for deletion, on the same principle as `selected`
     above: a Set of ids, so a selection survives showing and hiding the
     closed ones. */
  oppSelected: new Set(),
  /* How this person has arranged the policies grid: which columns, in what
     order. Loaded once at sign-in and saved back whenever it changes, so it
     follows them from one machine to the next rather than living in this
     browser. Null means they have never arranged it — the catalogue's
     defaults. */
  policyCols: null,
};

/**
 * How this person has arranged their screens, fetched once at sign-in.
 *
 * A failure here is not a failure to sign in — they get the default grid,
 * which is what they had before there was such a thing as an arrangement.
 */
async function loadPrefs() {
  try {
    const prefs = await api('/me/prefs');
    state.policyCols = prefs?.policy_columns || null;
    state.reportCols = prefs?.report_columns || null;
    applyViewDefault(prefs?.view_defaults || null);
    state.rateBasis = prefs?.rate_basis?.basis === 'simple' ? 'simple' : 'weighted';
  } catch {
    state.policyCols = null;
  }
}

/**
 * Refresh the opportunity count behind the menu badge.
 *
 * Fire-and-forget: the shell has already painted, so this patches the badge
 * in place rather than holding up the page for a count.
 */
async function refreshOppCount() {
  try {
    const s = await api('/opportunities/summary');
    const next = Number(s.undecided) || 0;
    if (next === state.oppCount) return;
    state.oppCount = next;
    const link = document.querySelector('.nav a[href="#/opportunities"]');
    if (!link) return;
    link.querySelector('.nav-badge')?.remove();
    link.classList.toggle('has-badge', next > 0);
    if (next > 0) link.insertAdjacentHTML('beforeend', `<span class="nav-badge">${next}</span>`);
  } catch { /* a badge is not worth an error */ }
}

/* An agreement waiting for a signature is the one thing in the portal that
   is actually blocking somebody, so it gets the same treatment. */
async function refreshAgreementCount() {
  if (!isInvestorUser()) return;
  try {
    const list = await api('/agreements');
    const next = list.filter((a) => a.status === 'Out for signature' && !a.my_signed_at).length;
    const link = document.querySelector('.nav a[href="#/agreements"]');
    if (!link) return;
    link.querySelector('.nav-badge')?.remove();
    link.classList.toggle('has-badge', next > 0);
    if (next > 0) link.insertAdjacentHTML('beforeend', `<span class="nav-badge">${next}</span>`);
  } catch { /* same */ }
}

/* And on the other side of the same idea: somebody who has registered and
   is waiting to hear back. The badge sits on Investors, which is where the
   decision gets made. */
async function refreshApplicationCount() {
  if (isInvestorUser()) return;
  try {
    const { pending } = await api('/applications/summary');
    const link = document.querySelector('.nav a[href="#/investors"]');
    if (!link) return;
    link.querySelector('.nav-badge')?.remove();
    link.classList.toggle('has-badge', pending > 0);
    if (pending > 0)
      link.insertAdjacentHTML('beforeend', `<span class="nav-badge">${pending}</span>`);
  } catch { /* same */ }
}

/**
 * The average age of the lives an entity is exposed to.
 *
 * Averaged over distinct people rather than over policies, and only over
 * the ones whose date of birth is on file — an unknown birthday counted
 * as zero would drag the mean somewhere impossible. When some are
 * missing the cell says so, because "87.9" over four of nine lives is a
 * different claim from "87.9" over all nine.
 */
function avgAgeCell(f) {
  const lives = Number(f.lives_count) || 0;
  const dated = Number(f.lives_with_dob) || 0;
  if (!f.avg_insured_age)
    return `<td class="num muted">${lives ? 'no dates of birth' : '—'}</td>`;
  const partial = dated < lives;
  return `<td class="num"${partial
    ? ` title="Averaged over the ${dated} of ${lives} lives with a date of birth on file"` : ''}
    >${Number(f.avg_insured_age).toFixed(1)}${
    partial ? ` <span class="muted">(${dated} of ${lives} dated)</span>` : ''}</td>`;
}

/* ------------------------- the entity filter -------------------------
 * One selection, shared by every staff screen that offers it: the
 * dashboard, policies, insureds, servicing and maturities. Choosing LCG1
 * on the dashboard and then opening Servicing shows LCG1's servicing —
 * a per-page filter that silently resets is how somebody ends up reading
 * one entity's totals beside another's alerts.
 *
 * Several at once, not one. Somebody who runs two entities together reads
 * them together, and the alternative — look at one, write the number down,
 * look at the other, add them up by hand — is how a total ends up wrong.
 * Nothing selected still means the whole book, which is what a person
 * means by "all", so the empty selection and the complete one agree.
 *
 * Investors never see it. They hold percentages of policies, not
 * entities, and the entity is not theirs to know about.
 * ------------------------------------------------------------------- */

/** The codes chosen, in the order the entities are listed. */
const entityCodes = () => (isInvestorUser() ? [] : (state.filters.funds || []));

/* What goes on the wire: comma separated, blank for the whole book. Every
   filtered endpoint reads it the same way, so one code and five are the
   same request with a different list in it. */
const entityParam = () => entityCodes().join(',');
const entityQuery = () => (entityParam() ? `fund=${encodeURIComponent(entityParam())}` : '');

/**
 * The selection said in words, for a page's subheading.
 *
 * Named rather than counted while the list is short enough to read — "LCG1
 * and LCG2 only" tells somebody what they are looking at; "2 entities"
 * makes them open the picker to find out.
 */
const entityWords = (codes) => {
  if (!codes.length) return '';
  if (codes.length === 1) return codes[0];
  if (codes.length === 2) return `${codes[0]} and ${codes[1]}`;
  if (codes.length === 3) return `${codes[0]}, ${codes[1]} and ${codes[2]}`;
  return `${codes.length} entities`;
};
const entityLabel = () => entityWords(entityCodes());

/** Whether what is on screen is what this person asked to be remembered. */
const viewIsDefault = () => {
  const d = state.viewDefault;
  if (!d) return false;
  const a = [...entityCodes()].sort().join(',');
  const b = [...(d.funds || [])].sort().join(',');
  return a === b && (d.status || '') === (state.filters.status || '');
};

/**
 * The picker itself, for a page heading. Empty for anyone who may not use it.
 *
 * A button and a list of tick boxes rather than a multiple <select>: a
 * native multi-select needs ctrl-click to add a second entity and shows
 * one row at a time on a laptop, which makes choosing two a thing people
 * do by accident and undo by accident.
 */
const entityPicker = (funds) => (isInvestorUser() ? '' : `
  <div class="entity-pick" id="entityPick">
    <button type="button" class="head-select entity-btn" id="entityBtn"
            aria-haspopup="true" aria-expanded="false">
      <span>${entityCodes().length ? esc(entityLabel()) : 'All entities'}</span>
      <span class="entity-caret" aria-hidden="true">▾</span>
    </button>
    <div class="entity-menu" id="entityMenu" role="group" aria-label="Owner entities" hidden>
      <label class="entity-opt entity-all">
        <input type="checkbox" id="entityAll" ${entityCodes().length ? '' : 'checked'}>
        <span><strong>All entities</strong></span>
      </label>
      <div class="entity-list">
        ${(funds || []).map((f) => `
          <label class="entity-opt">
            <input type="checkbox" class="entity-one" value="${esc(f.code)}" ${
              entityCodes().includes(f.code) ? 'checked' : ''}>
            <span>${esc(f.code)}${f.name && f.name !== f.code
              ? ` <span class="muted">— ${esc(f.name)}</span>` : ''}</span>
          </label>`).join('')}
      </div>
      <div class="entity-foot">
        ${viewIsDefault()
    ? `<span class="entity-saved">This is your default view</span>
           <button type="button" class="btn-link" id="entityForget">Forget it</button>`
    : `<button type="button" class="btn-link" id="entityRemember">Remember this view</button>${
      state.viewDefault ? `
           <button type="button" class="btn-link" id="entityRestore">Back to my default</button>` : ''}`}
      </div>
    </div>
  </div>`);

/**
 * Wire it up. Call from a view's `after`.
 *
 * `soft` for screens that can repaint without refetching everything —
 * the policies grid filters in place, the dashboard has to ask the server
 * for another set of totals.
 */
const wireEntityPicker = ({ soft = false } = {}) => {
  const pick = $('#entityPick');
  if (!pick) return;
  const menu = $('#entityMenu', pick);
  const btn = $('#entityBtn', pick);

  /* Ticking a box does not reload the page. Choosing three entities is one
     decision, and refetching the dashboard between the first tick and the
     third would show two sets of totals nobody asked for. The list is read
     when the menu closes, and only then, and only if it changed. */
  const before = entityParam();
  const pending = () => [...pick.querySelectorAll('.entity-one:checked')].map((b) => b.value);

  /* Clicking anywhere else closes it. The document listener exists only
     while the menu is open and is taken off again when it shuts, so a
     screen repainted forty times does not leave forty of them behind. */
  const away = () => open(false);
  const open = (yes) => {
    menu.hidden = !yes;
    btn.setAttribute('aria-expanded', yes ? 'true' : 'false');
    pick.classList.toggle('open', yes);
    if (yes) document.addEventListener('click', away);
    else document.removeEventListener('click', away);
    if (yes) return;
    const now = pending();
    if (now.join(',') === before) return;
    state.filters.funds = now;
    render(soft ? { soft: true } : undefined);
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); open(menu.hidden); });
  menu.addEventListener('click', (e) => e.stopPropagation());
  pick.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });

  /* The button says what is chosen while the menu is still open, so the
     reader can see the answer forming without closing it to check. */
  const label = $('#entityBtn span', pick);
  const restate = () => {
    const codes = pending();
    label.textContent = codes.length ? entityWords(codes) : 'All entities';
    $('#entityAll', pick).checked = codes.length === 0;
  };

  $('#entityAll', pick)?.addEventListener('change', () => {
    pick.querySelectorAll('.entity-one').forEach((b) => { b.checked = false; });
    restate();
  });
  pick.querySelectorAll('.entity-one').forEach((box) =>
    box.addEventListener('change', restate));

  /* Remembering reads the boxes as they stand, so a person can tick two
     entities and make that their view in one visit to the menu. */
  const settle = () => { state.filters.funds = pending(); };
  $('#entityRemember', pick)?.addEventListener('click', () => {
    settle(); menu.hidden = true; document.removeEventListener('click', away); rememberView();
  });
  $('#entityForget', pick)?.addEventListener('click', () => {
    menu.hidden = true; document.removeEventListener('click', away); forgetView();
  });
  $('#entityRestore', pick)?.addEventListener('click', () => {
    menu.hidden = true;
    document.removeEventListener('click', away);
    state.filters.funds = [...(state.viewDefault.funds || [])];
    state.filters.status = state.viewDefault.status || '';
    render();
  });
};

/* --------------------------- how rates combine -----------------------
 * A book of policies has two honest returns and they answer different
 * questions.
 *
 *   Capital-weighted -- total profit over total dollar-years. A $10m
 *     position counts for ten times a $1m one, and a policy held eight
 *     years for more than one held eight months. It is what the money
 *     did, and it is the default, because that is what a figure headed
 *     "portfolio return" is normally taken to mean.
 *
 *   Equal-weighted -- the plain average of the policies' own rates, each
 *     counted once. It is how the cases did, which is a real question:
 *     it is the one to ask about underwriting rather than about capital.
 *
 * Deliberately NOT called "simple", even though that is the plain word
 * for it: this application already uses "simple" for simple interest as
 * against compounded, and one word carrying two axes at once on the same
 * tile is how somebody reads the wrong number. The words on the control
 * are the ones the rest of the industry uses.
 *
 * Both figures are computed and sent regardless, so switching costs no
 * request and can never make a document disagree with the database.
 * ------------------------------------------------------------------- */

const rateBasis = () => (state.rateBasis === 'simple' ? 'simple' : 'weighted');
const BASIS_WORDS = {
  weighted: 'capital-weighted',
  simple: 'equal-weighted',
};

/**
 * The rate to show, out of a pooled analysis.
 *
 * Falls back to the weighted figure whenever there is no average to be
 * had -- a single policy, or an older payload that predates the choice --
 * so a screen can call this without knowing which it is holding.
 */
const bookRate = (a) => {
  if (!a) return null;
  if (rateBasis() === 'simple' && a.mean_rate !== undefined && a.mean_rate !== null)
    return a.mean_rate;
  return a.rate ?? null;
};

/** The other one, for the note that says what it would read instead. */
const otherRate = (a) => {
  if (!a) return null;
  return rateBasis() === 'simple' ? (a.rate ?? null) : (a.mean_rate ?? null);
};

/**
 * The compounded figure, on the same basis as the simple one beside it.
 *
 * The two are a pair. Switching the weighting has to move both or the
 * line reads as two different books -- an equal-weighted return with a
 * capital-weighted IRB next to it, and nothing on screen to say they
 * disagree.
 */
const bookCompound = (a) => {
  if (!a) return null;
  if (rateBasis() === 'simple'
    && a.mean_compound_rate !== undefined && a.mean_compound_rate !== null)
    return a.mean_compound_rate;
  return a.compound_rate ?? null;
};

/**
 * A line saying which of the two is on screen and what the other reads.
 *
 * Printed rather than hidden behind the control: the gap between them is
 * the whole reason there is a choice, and somebody who can see both at
 * once never has to wonder which they are quoting.
 */
const basisNote = (a, { count } = {}) => {
  if (!showsBothRates() || !a || bookRate(a) === null) return '';
  const here = BASIS_WORDS[rateBasis()];
  const other = otherRate(a);
  const n = count ?? a.rated_count;
  const of = rateBasis() === 'simple' && n
    ? ` across ${n} ${n === 1 ? 'rate' : 'rates'}` : '';
  return other === null || other === undefined
    ? `${here}${of}`
    : `${here}${of} · ${BASIS_WORDS[rateBasis() === 'simple' ? 'weighted' : 'simple']} ${
      fmtRate(other)}`;
};

/** The control. Staff only, like the compounded figure beside it. */
const rateToggle = () => (!showsBothRates() ? '' : `
  <select id="rateBasis" class="head-select" aria-label="How policy returns are combined">
    <option value="weighted" ${rateBasis() === 'weighted' ? 'selected' : ''}
      >Capital-weighted</option>
    <option value="simple" ${rateBasis() === 'simple' ? 'selected' : ''}
      >Equal-weighted</option>
  </select>`);

/** Wire it up. Call from a view's `after`, like the entity picker. */
const wireRateToggle = () => {
  $('#rateBasis')?.addEventListener('change', async (e) => {
    state.rateBasis = e.target.value === 'simple' ? 'simple' : 'weighted';
    render();
    /* Saved after the screen has already changed. A setting about how to
       read a number is not worth a modal if the save fails, but it is
       worth saying so -- otherwise it silently reverts tomorrow. */
    try {
      await api('/me/prefs/rate_basis', { method: 'PUT', body: { basis: state.rateBasis } });
    } catch (err) { toast(`That was not saved: ${err.message}`); }
  });
};

/* ------------------------- the remembered view -----------------------
 * Somebody who works in one entity should not have to say so every
 * morning. What is stored is the entity selection and the status the
 * policies grid is set to — the two things that make a screen "mine" —
 * against the account rather than the browser, so it follows them to
 * whichever machine they sign in from.
 *
 * Asked for rather than assumed. Remembering every selection silently
 * would mean that looking at one entity for a minute quietly changes what
 * you see for good, and there would be no way to look without changing.
 * ------------------------------------------------------------------- */

/** What the stored view looks like, cleaned of anything odd. */
const viewFrom = (pref) => (pref && typeof pref === 'object' && !Array.isArray(pref)
  ? {
    funds: (Array.isArray(pref.funds) ? pref.funds : []).filter((c) => typeof c === 'string'),
    status: typeof pref.status === 'string' ? pref.status : '',
  }
  : null);

/**
 * Put the remembered view back. Sign-in only.
 *
 * Restoring it later — after a repaint, say — would mean the application
 * arguing with a choice the reader made a moment ago.
 */
function applyViewDefault(pref) {
  state.viewDefault = viewFrom(pref);
  if (!state.viewDefault || isInvestorUser()) return;
  state.filters.funds = [...state.viewDefault.funds];
  state.filters.status = state.viewDefault.status || '';
}

async function rememberView() {
  const view = { funds: entityCodes(), status: state.filters.status || '' };
  state.viewDefault = view;
  try {
    await api('/me/prefs/view_defaults', { method: 'PUT', body: view });
    toast(view.funds.length
      ? `${entityLabel()} is what you will see when you sign in`
      : 'The whole book is what you will see when you sign in');
  } catch (err) {
    state.viewDefault = null;
    toast(`That was not saved: ${err.message}`);
  }
  render();
}

async function forgetView() {
  state.viewDefault = null;
  try {
    await api('/me/prefs/view_defaults', { method: 'DELETE' });
    toast('Signing in will show you the whole book again');
  } catch (err) { toast(`That was not cleared: ${err.message}`); }
  render();
}

/** Entities, fetched once per session and kept on state. */
const loadFunds = async () => {
  if (isInvestorUser()) return [];
  if (!state.funds.length) state.funds = await api('/funds').catch(() => []);
  return state.funds;
};

/* ----------------------------- helpers ------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (v, dp = 0) => (v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : fmtMoney(v, dp));

const fmtDate = (d) => {
  if (!d) return '<span class="muted">—</span>';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  return `${m}/${day}/${y}`;
};
/* A timestamp, in the reader's own zone. Used where the moment matters —
   when something was shared, when a decision was taken — rather than just
   the day it happened. */
const fmtDateTime = (t) => {
  if (!t) return '<span class="muted">—</span>';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return fmtDate(t);
  return d.toLocaleString('en-US',
    { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};
/* M / F / Joint, spelled the way a reader expects. A survivorship policy
   covers two lives, so "Joint" is a real answer rather than missing data. */
const SEX_WORDS = { M: 'Male', F: 'Female', Joint: 'Joint' };
const sexLabel = (g) => {
  const v = String(g || '').trim();
  if (!v) return '<span class="muted">—</span>';
  const key = v.length === 1 ? v.toUpperCase() : v;
  return esc(SEX_WORDS[key] || v);
};
/** The compact form, for beside a name: "F · 87". */
const sexAndAge = (g, dob) => {
  const parts = [];
  const v = String(g || '').trim();
  if (v) parts.push(v.length === 1 ? v.toUpperCase() : v);
  const age = ageFrom(dob);
  if (age != null) parts.push(String(age));
  return parts.join(' · ');
};
const dash = '<span class="muted">—</span>';
const dateInput = (d) => (d ? String(d).slice(0, 10) : '');
const today = () => new Date().toISOString().slice(0, 10);

function ageFrom(dob, at) {
  if (!dob) return null;
  const b = new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  const n = at ? new Date(`${String(at).slice(0, 10)}T00:00:00`) : new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a;
}

const insuredName = (p) =>
  p.display_name || `${p.insured_first || ''} ${p.insured_last || ''}`.trim() || '—';

/**
 * What a capital call is about, in one cell.
 *
 * The title on every premium call is the same words, so a list of them says
 * nothing about which policies each one covers. The lives do. Two names
 * fit; past that it says how many more, and the whole list is one click
 * away in the call itself.
 *
 * The names arrive from the API already reduced to initials for an
 * investor, so this does not have to know who is reading.
 */
function coveredBy(call) {
  const items = call?.covers || [];
  if (!items.length) return '<span class="muted">—</span>';
  const names = [...new Set(items
    .map((i) => String(i.insured_name || '').trim())
    .filter(Boolean))];
  if (!names.length) return `<span class="muted">${items.length} ${
    items.length === 1 ? 'policy' : 'policies'}</span>`;
  const shown = names.slice(0, 2).map(esc).join(', ');
  return names.length > 2
    ? `${shown} <span class="muted">+${names.length - 2} more</span>` : shown;
}

const statusBadge = (s) =>
  `<span class="badge ${esc(String(s || '').toLowerCase())}"><span class="dot"></span>${esc(s || 'Unknown')}</span>`;

/**
 * Said plainly, wherever an investor is looking at money.
 *
 * This used to be a toggle between "my share" and "full policy". It is not
 * any more: the full-policy figure is not theirs and showing it invited the
 * one mistake that matters — reading somebody else's number as your own. So
 * this states what the figures are instead of offering a choice about it.
 */
function shareToggle(pct) {
  if (!isInvestorUser()) return '';
  return `<div class="share-note">${pct != null
    ? `Your share · <strong>${fmtPct(pct)}</strong>`
    : 'Your share'}</div>`;
}
function wireShareToggle() { /* nothing to wire — it is a label, not a control */ }

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function formValues(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) {
    // A multi-select contributes several entries under one name.
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    else out[k] = v;
  }
  // Always send multi-selects as arrays, even with a single selection.
  form.querySelectorAll('select[multiple]').forEach((sel) => {
    out[sel.name] = [...sel.selectedOptions].map((o) => o.value);
  });
  // The commas were only ever for the reader.
  form.querySelectorAll('input[data-money]').forEach((el) => {
    if (typeof out[el.name] === 'string') out[el.name] = out[el.name].replace(/,/g, '');
  });
  return out;
}

/**
 * One CSV cell, quoted and made inert.
 *
 * Excel and Sheets treat a cell beginning =, +, - or @ as a formula, so a
 * carrier or insured name imported from someone else's file could execute on
 * open. Prefixing a single quote makes the spreadsheet show the text and
 * evaluate nothing; the quote is not part of the value once opened. Leading
 * tabs and carriage returns get the same treatment because they slip past a
 * naive check on the first character.
 */
const csvCell = (value) => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/**
 * Download an array of objects as CSV — an administrator's act.
 *
 * The likeliest way this data leaves the building is not a stolen database;
 * it is one signed-in person pressing Export and walking off with the book.
 * So the server is asked first, and it records what was taken and tells every
 * other administrator. If it says no, no file is written.
 *
 * What this does not do is make copying impossible — anybody who can read a
 * screen can retype it, and anybody who can call the API can page through it.
 * It makes the easy path privileged, and it makes the record exist.
 */
async function exportCsv(filename, rows, columns, kind) {
  try {
    await api('/exports', { method: 'POST', body: {
      kind: kind || filename.replace(/\.csv$/, ''),
      rows: rows.length,
      scope: [entityParam(), state.filters?.status, state.filters?.search]
        .filter(Boolean).join(' · '),
    } });
  } catch (err) {
    alert(err.message === 'You do not have permission to do that'
      ? 'Exporting the book is an administrator’s job. Everything here is on '
        + 'screen, and a report can be printed from Reports.'
      : `That export was not recorded, so nothing was downloaded: ${err.message}`);
    return;
  }
  writeCsv(filename, rows, columns);
}

/** The file itself. Separated so that nothing can write one without asking. */
function writeCsv(filename, rows, columns) {
  const head = columns.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) =>
    columns.map((c) => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(',')
  ).join('\n');
  // The BOM makes Excel read it as UTF-8 rather than the local code page.
  const blob = new Blob([`﻿${head}\n${body}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Wire a search box.
 *
 * One helper for all of them, because they were three copies of the same four
 * lines and had already drifted apart: how long to wait, whether an unchanged
 * term refetches, and whether the page is redrawn whole or under the menu.
 *
 * 300ms is long enough that an ordinary typist finishes a word before anything
 * is fetched, and short enough that a pause feels like an answer.
 */
function wireSearch(selector, apply) {
  const el = $(selector);
  if (!el) return;
  let timer;
  let last = el.value;
  el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const term = el.value;
      // Backspacing to where you already were is not a new search.
      if (term === last) return;
      last = term;
      apply(term);
      render({ soft: true });
    }, 300);
  });
}

/**
 * The first thing somebody sees when the office set their password.
 *
 * A password typed by staff and read down a telephone is known to at least
 * two people from the moment it exists, so it is a way in rather than a
 * credential. The account can do nothing until it is replaced — the server
 * refuses every other route — and this is the screen that says so, rather
 * than letting somebody meet a wall of 409s.
 */
function firstPasswordView() {
  return `
  <div class="login-wrap">
    <div class="card login-card">
      <div class="card-body">
        <div class="login-brand"><span class="brand-mark"></span>Poel Capital</div>
        <div class="login-head">Choose<br><span class="dim">your password.</span></div>
        <div class="login-sub">${esc(state.user?.name || state.user?.email || '')}</div>
        <div class="notice-box" style="margin-top:14px">
          The password you were given was set up for you by the office, so somebody
          else knows it. Choose one only you know and the portal opens.
        </div>
        <div id="firstPwError"></div>
        <form id="firstPwForm">
          <div class="field">
            <label for="curPw">The password you were given</label>
            <input id="curPw" name="currentPassword" type="password"
                   autocomplete="current-password" required autofocus>
          </div>
          <div class="field">
            <label for="newPw">Your own password (10 characters or more)</label>
            <input id="newPw" name="newPassword" type="password" minlength="10"
                   autocomplete="new-password" required>
          </div>
          <button class="primary" type="submit" style="width:100%;margin-top:6px">
            Set it and continue</button>
        </form>
        <div class="login-alt"><span>Not you?</span>
          <a href="#" id="firstPwOut">Sign out</a></div>
      </div>
    </div>
  </div>`;
}

function wireFirstPassword() {
  $('#firstPwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#firstPwForm button');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Setting it…';
    try {
      await api('/auth/password', { method: 'POST', body: formValues(e.target) });
      state.user = await api('/auth/me');
      await loadPrefs();
      location.hash = '#/dashboard';
      toast('That is your password now');
      await render();
    } catch (err) {
      $('#firstPwError').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Set it and continue';
    }
  });
  $('#firstPwOut').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    render();
  });
}

/* ------------------------------ router ------------------------------- */

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [route, id, extra] = h.split('/');
  return { route: route || 'dashboard', params: { id, extra } };
}

export function closeAllDialogs() {
  document.querySelectorAll('dialog').forEach((d) => { d.close(); d.remove(); });
}

window.addEventListener('hashchange', () => {
  closeAllDialogs();
  const { route, params } = parseHash();
  state.route = route;
  state.params = params;
  hideTip();
  render();
});

const go = (hash) => { location.hash = hash; };

/* ------------------------------ shell -------------------------------- */

const PRODUCT_TYPES = ['', 'UL', 'SUL', 'VUL', 'IUL', 'GUL', 'Term', 'WL', 'Other'];
const PRODUCT_LABELS = {
  UL: 'Universal Life', SUL: 'Survivorship Universal Life', VUL: 'Variable Universal Life',
  IUL: 'Indexed Universal Life', GUL: 'Guaranteed Universal Life',
  Term: 'Term', WL: 'Whole Life', Other: 'Other',
};

const STAFF_NAV = [
  ['dashboard', 'Dashboard'],
  ['policies', 'Policies'],
  ['insureds', 'Insureds'],
  ['servicing', 'Servicing'],
  ['maturities', 'Maturities'],
  ['opportunities', 'Opportunities'],
  ['investors', 'Investors'],
  ['documents', 'Documents'],
  ['reports', 'Reports'],
  // What the firm earns. Administrators only — a portfolio manager runs a
  // book, and what the managing partner takes out of it is not theirs to
  // read. Filtered out of the menu below rather than merely refused on
  // arrival, so it is never a tab that answers 403.
  ['carry', 'Carried interest'],
  /* A separate application, and a page of this one.
   *
   * The third element is a path rather than a route: the valuation model
   * is a different program on a different service, reached through
   * /valuation, which this server answers by checking the reader is an
   * administrator here and then asking it on their behalf. So it is one
   * address and one sign-in, and the menu can link to it plainly.
   *
   * It is still a whole other application, not a screen of this one, so
   * the menu keeps it visibly apart -- and no figure crosses between them.
   *
   * Administrators only, filtered out below the same way carried interest
   * is: absent from the menu rather than a tab that refuses on arrival. */
  ['valuation', 'Policy Valuation', '/valuation'],
  // Importing is a setup job rather than a daily one, so it sits under
  // Settings with the other things you do occasionally. The route is
  // unchanged, and the dashboard still offers it directly.
  ['settings', 'Settings'],
];

/** Menu entries an administrator has and nobody else does. */
const ADMIN_ONLY_NAV = ['carry'];

/* Policy Valuation is not a rank, it is a grant: an administrator has it,
   and anybody else has it only if one gave it to them by name. So the menu
   asks the account rather than the role. */
const mayValue = () => !!state.user?.can_value;

// An investor sees only their own holdings; the staff-only sections are absent
// from the menu and refused by the server regardless.
const INVESTOR_NAV = [
  ['dashboard', 'Portfolio'],
  ['policies', 'My policies'],
  ['opportunities', 'Opportunities'],
  ['agreements', 'Agreements'],
  ['servicing', 'Premiums'],
  ['maturities', 'Realized'],
  ['reports', 'Statements'],
  ['settings', 'Account'],
];

// A portfolio manager works inside their own entities. They get no Settings tab
// — no owner entities, no user management, no activity log — but they still need
// somewhere to change their own password, so that becomes "Account".
const MANAGER_NAV = STAFF_NAV
  .filter(([r]) => !ADMIN_ONLY_NAV.includes(r))
  /* Keep the whole entry. An earlier version rebuilt each one as [r, label]
     and dropped the third element, which is what makes Policy Valuation a
     path rather than a route -- so a manager who had been granted it got a
     menu item pointing at a screen that does not exist. */
  .map((e) => (e[0] === 'settings' ? ['settings', 'Account'] : e));
/* Policy Valuation stays in this list on purpose: navItems takes it out
   again unless the account holds the grant, which is the only place that
   question can be answered. */

const isInvestorUser = () => state.user?.role === 'investor';
const isManagerUser  = () => state.user?.role === 'manager';
/**
 * A keyboard shortcut that belongs to the screen currently rendered.
 *
 * One listener on the document, and each render replaces what it points
 * at. Adding a listener per render instead would leave the previous
 * screen's shortcuts still firing — the Maturities page paging through
 * policies, and getting worse every time somebody navigated.
 */
/**
 * The two rates, and why both are shown.
 *
 * Every return in here is solved twice from the same dated cash flows.
 *
 *   simple      profit divided by dollar-years — what a dollar earned per
 *               year it was actually out, which is how a life settlement is
 *               quoted and how the office's own workbook computes it.
 *   compounded  the IRR, which is what somebody comparing this against a
 *               bond or a fund will reach for.
 *
 * On a policy held four years they can differ by half again, and a figure
 * labelled only "return" is an invitation to assume it is whichever one
 * flatters the reader's expectation. Staff see both, side by side, named.
 * An investor's screens keep the simple rate alone: it is the one their
 * statements and agreements are written in, and two rates on a page with
 * no explanation is worse than one that is labelled.
 */
const showsBothRates = () => !isInvestorUser();
const compoundNote = (a) => (!showsBothRates() || !a || bookCompound(a) == null
  ? '' : `${fmtRate(bookCompound(a))} compounded`);

let screenKeys = null;
const onKey = (fn) => { screenKeys = fn; };
document.addEventListener('keydown', (e) => screenKeys?.(e));

const canEditData    = () => ['admin', 'editor', 'manager'].includes(state.user?.role);

/**
 * Every premium an investor is going to be asked for, as one list.
 *
 * There are two sources and they are equally real: a next-due date the
 * carrier put on the policy, and a premium somebody here posted to the
 * schedule. Whoever has to fund it does not care which table it came out
 * of, so they are merged and sorted by date.
 *
 * Shared rather than written twice. The Portfolio page used to read only the
 * carrier dates, so a book funded entirely from posted schedules — which is
 * what an import without a next-due column produces — showed "no premium
 * dates are scheduled" on the dashboard and a full list one click away.
 * Two cards with the same title disagreeing is worse than either being wrong.
 */
function premiumDues(svc) {
  const name = (r) => r.display_name
    || `${r.insured_first || ''} ${r.insured_last || ''}`.trim();
  /* One source, and only one: what somebody put on the servicing calendar.
     The policy record's annual premium and carrier due date describe the
     policy — they are not a bill, and reading them here meant the same
     payment showed up twice at two different figures. */
  return (svc.scheduled || [])
    .filter((r) => r.kind === 'Premium')
    .map((r) => ({
      date: String(r.due_date).slice(0, 10),
      policy_id: r.id, policy_number: r.policy_number, carrier_name: r.carrier_name,
      insured: name(r), sex: sexAndAge(r.insured_gender, r.insured_dob),
      amount: Number(r.amount) || 0, amount_full: Number(r.amount_full) || 0,
      source: 'scheduled', note: r.note,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

const isAdminUser    = () => state.user?.role === 'admin';

/**
 * The menu this person is served.
 *
 * The role picks the list; the Policy Valuation entry is then taken out of
 * whichever list it lands in unless this account has been granted it. Done
 * as a last pass over every branch rather than inside one of them, because
 * the manager's menu is built once at load and cannot ask about an account
 * that has not signed in yet — which is exactly how a tab nobody was
 * granted ends up on a manager's screen.
 */
const navItems = () => {
  const list = isInvestorUser() ? INVESTOR_NAV
    : isManagerUser() ? MANAGER_NAV
    // An editor or viewer is staff but not an administrator.
    : state.user?.role === 'admin' ? STAFF_NAV
      : STAFF_NAV.filter(([r]) => !ADMIN_ONLY_NAV.includes(r));
  return mayValue() ? list : list.filter(([r]) => r !== 'valuation');
};

/* Display multiplier.
 *
 * An investor owns a percentage of a policy, not a policy, and every figure
 * they are shown is scaled to that percentage — always, with no way to switch
 * it off. A screen that shows an investor an $800,000 acquisition cost when
 * they paid $200,000 of it is not a different view of the same truth; it is a
 * number they will act on and be wrong about. Staff always see the whole
 * policy, because their job is the whole policy.
 *
 * The one thing never scaled is a date. */
const shareFactor = (p) =>
  isInvestorUser() && p?.my_pct != null ? Number(p.my_pct) / 100 : 1;
const scaled = (v, p) =>
  v === null || v === undefined || v === '' ? null : Number(v) * shareFactor(p);

function shell(inner) {
  const active = state.route === 'policy' ? 'policies'
    : state.route === 'investor' ? 'investors'
    : state.route === 'opportunity' ? 'opportunities' : state.route;
  return `
    <div class="topbar">
      <div class="brand"><span class="brand-mark"></span>Poel Capital</div>
      <div class="brand-divider"></div>
      <div class="brand-sub">Policy Portfolio</div>
      <nav class="nav">
        ${navItems().map(([r, label, external]) => {
          /* Another application, on this domain. It leaves the portfolio
             — a real page load, not a route — so it is set apart from the
             tabs and never marked active; but it does not leave the SITE,
             so it does not open a tab and needs none of the rel values a
             link to another host would. */
          if (external) return `<a href="${esc(external)}" class="nav-out">${label}</a>`;
          // The count is the point of the badge: an investor should be able
          // to tell at a glance that something is waiting for them.
          const badge = r === 'opportunities' && state.oppCount > 0
            ? `<span class="nav-badge">${state.oppCount}</span>` : '';
          return `<a href="#/${r}" class="${active === r ? 'active' : ''}${
            badge ? ' has-badge' : ''}">${label}${badge}</a>`;
        }).join('')}
      </nav>
      <div class="topbar-right">
        <button class="btn-sm btn-icon" id="themeBtn" title="Toggle light / dark">◐</button>
        <span class="muted who" style="font-size:13px">${esc(
          isInvestorUser() && state.user.investor
            ? state.user.investor.name
            : isManagerUser() && state.user.funds?.length
              ? `${state.user.name || state.user.email} · ${state.user.funds.map((f) => f.code).join(', ')}`
              : state.user?.name || state.user?.email || '')}</span>
        <button class="btn-sm" id="logoutBtn">Sign out</button>
      </div>
    </div>
    ${buildBanner()}
    <div id="securityBanner"></div>
    <div class="main" id="main">${inner}</div>`;
}

/**
 * "This page and this server are not the same build."
 *
 * A deployment that updates the browser files without updating the server
 * -- or the other way round -- produces errors that look like bugs and are
 * not: a button whose route does not exist yet, an export the API has
 * never heard of. Both have happened here, and both cost a round trip to
 * diagnose, because the only thing on screen was a status code.
 *
 * So the application checks itself. The server puts its build on
 * /auth/me, the page carries its own, and when they disagree it says so
 * in the one place nobody can miss, in terms that name the action:
 * hard-reload first, because a cached page explains most of it, and if
 * that does not settle it then the deployment did not finish.
 *
 * A server too old to report a build at all is the same problem said
 * differently -- no answer is a stronger signal than a different one.
 */
function buildBanner() {
  const theirs = state.user?.build;
  if (theirs === BUILD) return '';
  return `
    <div class="security-bar warn" id="buildBanner">
      <span class="security-mark" aria-hidden="true">!</span>
      <div class="security-text">
        <div><strong>This page and the server are running different builds.</strong>
          Something on screen may ask for a route the server does not have, and
          fail with a bare error code.</div>
        <div class="muted" style="font-size:12.5px;margin-top:3px">
          This page is <strong>${esc(BUILD)}</strong>; the server ${theirs
    ? `is <strong>${esc(theirs)}</strong>`
    : 'is old enough that it does not report one'}.
          Reload with a hard refresh first. If it still says this, the last
          deployment updated some files and not others.</div>
      </div>
      <div class="spacer"></div>
      <button class="btn-sm" id="buildReload">Hard reload</button>
    </div>`;
}

/**
 * "You signed in from somewhere new."
 *
 * The one thing a phished password reliably produces is a sign-in from a
 * place the account has never been used. Telling the account holder is the
 * whole control — so it is a banner across the top of the application, not a
 * line in a log nobody opens, and it names the browser and the network so
 * they can tell at a glance whether it was them on their phone or somebody
 * else entirely.
 *
 * An administrator additionally hears when anybody exports the book.
 */
async function showSecurityNotices() {
  if (!$('#securityBanner')) return;
  let data;
  try {
    data = await api('/me/notices');
  } catch {
    return;                        // never let this get in the way of the work
  }
  /* Re-read the slot after the await. A navigation during the round trip
     replaces the shell, and writing into the old one puts a banner on a node
     that is no longer on the page — with handlers bound to nothing. */
  const bar = $('#securityBanner');
  if (!bar) return;
  if (!data.unseen?.length) { bar.innerHTML = ''; return; }

  const wording = (n) => (n.kind === 'new_location'
    ? `<strong>New sign-in from a place this account has not been used before.</strong>
       ${esc(n.detail)} · ${fmtDateTime(n.created_at)}.
       If that was not you, change your password now — doing so signs out every
       other browser at once.`
    : `<strong>${esc(n.detail)}</strong> · ${fmtDateTime(n.created_at)}.`);

  /* At most three across the top, whatever is waiting. A fortnight away and
     a busy book can leave twenty notices, and a banner twenty lines deep
     stops being a warning and becomes the page — the rest are on Settings,
     which is where a list belongs. */
  const SHOWN = 3;
  const shown = data.unseen.slice(0, SHOWN);
  const rest = data.unseen.length - shown.length;

  bar.innerHTML = `
    <div class="security-bar">
      <span class="security-mark" aria-hidden="true">!</span>
      <div class="security-text">
        ${shown.map((n) => `<div>${wording(n)}</div>`).join('')}
        ${rest ? `<div class="muted" style="font-size:12.5px;margin-top:3px">
          and ${rest} more — the whole list is on
          <a href="#/settings">Settings</a>.</div>` : ''}
        <div class="muted" style="font-size:12px;margin-top:4px">
          You are on ${esc(data.here)} right now.</div>
      </div>
      <div class="spacer"></div>
      ${data.unseen.some((n) => n.kind === 'new_location')
        ? '<button class="btn-sm" id="secPassword">Change password</button>' : ''}
      <button class="btn-sm" id="secSeen">That was expected</button>
    </div>`;

  /* Straight to the form rather than a dialog of its own: changing a password
     is the recommended action here, and it lives on one page already. */
  $('#secPassword', bar)?.addEventListener('click', () => {
    go('#/settings');
    setTimeout(() => $('#pwForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
  });
  $('#secSeen', bar)?.addEventListener('click', async () => {
    bar.innerHTML = '';
    try {
      await api('/me/notices/seen', { method: 'POST', body: { ids: data.unseen.map((n) => n.id) } });
    } catch { /* it will simply be shown again next time */ }
  });
}

/* ------------------------------- login ------------------------------- */

function loginView() {
  return `
  <div class="login-wrap">
    <div class="card login-card">
      <div class="card-body">
        <div class="login-brand"><span class="brand-mark"></span>Poel Capital</div>
        <div class="login-head">Policy<br><span class="dim">Portfolio.</span></div>
        <div class="login-sub">Life Settlements</div>
        <div id="loginError">${state.signedOutReason
          ? `<div class="notice-box">${esc(state.signedOutReason)}</div>` : ''}</div>
        <form id="loginForm">
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" required autofocus>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button class="primary" type="submit" style="width:100%;margin-top:6px">Sign in</button>
        </form>
        <div class="login-alt">
          <span>New investor?</span>
          <a href="#/register" id="registerLink">Register for access</a>
        </div>
        <div class="login-meta">
          <span>Index — 001</span><span>Southfield, MI</span>
        </div>
      </div>
    </div>
  </div>`;
}

function wireLogin() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginForm button');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Signing in…';
    try {
      await api('/auth/login', { method: 'POST', body: formValues(e.target) });
      // The login response is minimal; /auth/me carries the scope details the
      // interface needs (investor name, manager entities).
      state.user = await api('/auth/me');
      state.signedOutReason = null;
      noteActivity();
      if (!state.user.must_change_password) await loadPrefs();
      location.hash = '#/dashboard';
      await render();
    } catch (err) {
      $('#loginError').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

/* --------------------------- registration ---------------------------- */

/**
 * The form a prospective investor fills in themselves.
 *
 * It asks for everything the firm needs to open a relationship and issue
 * a K-1, and nothing else. Two things are said plainly on the page rather
 * than buried: that the account does not work until somebody here approves
 * it, and what happens to the tax number — because a stranger being asked
 * for a Social Security number over the internet is entitled to know.
 */
const REGISTER_TYPES = ['Individual', 'Joint', 'Entity', 'Trust', 'IRA', 'Other'];

function registerView() {
  return `
  <div class="reg-wrap">
    <div class="reg-head">
      <div class="login-brand"><span class="brand-mark"></span>Poel Capital</div>
      <h1>Register for access</h1>
      <p>Tell us who you are and choose a password. We will review your details and open your
        account &mdash; you will not be able to sign in until we have.</p>
    </div>

    <div class="card">
      <div class="card-body">
        <div id="regError"></div>
        <form id="regForm" autocomplete="on">

          <div class="dlg-section">About you</div>
          <div class="field-row">
            <div class="field"><label for="rf_name">Full legal name *</label>
              <input id="rf_name" name="full_name" required autocomplete="name"></div>
            <div class="field"><label for="rf_type">Investing as</label>
              <select id="rf_type" name="investor_type">
                ${REGISTER_TYPES.map((t) => `<option>${t}</option>`).join('')}
              </select></div>
          </div>
          <div class="field"><label for="rf_entity">Entity, trust or IRA name</label>
            <input id="rf_entity" name="entity_name"
                   placeholder="Leave blank if you are investing in your own name">
            <span class="muted" style="font-size:12px">This is the name the position will be
              held in, and the name on your statements.</span></div>

          <div class="field-row">
            <div class="field"><label for="rf_email">Email *</label>
              <input id="rf_email" name="email" type="email" required autocomplete="email"></div>
            <div class="field"><label for="rf_phone">Phone *</label>
              <input id="rf_phone" name="phone" required autocomplete="tel"></div>
          </div>

          <div class="dlg-section">Where you live</div>
          <div class="field"><label for="rf_a1">Street address *</label>
            <input id="rf_a1" name="address_line1" required autocomplete="address-line1"></div>
          <div class="field"><label for="rf_a2">Apartment, suite or unit</label>
            <input id="rf_a2" name="address_line2" autocomplete="address-line2"></div>
          <div class="field-row">
            <div class="field"><label for="rf_city">City *</label>
              <input id="rf_city" name="city" required autocomplete="address-level2"></div>
            ${stateField('State *', 'state', '')}
            <div class="field"><label for="rf_zip">ZIP *</label>
              <input id="rf_zip" name="postal_code" required autocomplete="postal-code"></div>
          </div>
          <div class="field"><label for="rf_country">Country</label>
            <input id="rf_country" name="country" value="United States" autocomplete="country-name"></div>

          ${/* No tax number here. It is needed eventually — a K-1 cannot be
               issued without one — but not to open an account, and a
               stranger's first minute on the site is the worst moment to ask
               for it. It is collected afterwards, on their own record, once
               there is a relationship. */''}

          <div class="dlg-section">Your password</div>
          <div class="field-row">
            <div class="field"><label for="rf_pw">Choose a password *</label>
              <input id="rf_pw" name="password" type="password" required minlength="10"
                     autocomplete="new-password"></div>
            <div class="field"><label for="rf_pw2">Type it again *</label>
              <input id="rf_pw2" name="password2" type="password" required minlength="10"
                     autocomplete="new-password"></div>
          </div>
          <span class="muted" style="font-size:12px">At least 10 characters. We never see it
            &mdash; it is hashed before it is stored, so nobody here can read it or tell it to
            you if you forget it.</span>

          <div class="field" style="margin-top:16px">
            <label for="rf_note">Anything you would like us to know</label>
            <textarea id="rf_note" name="note" rows="3"
              placeholder="How you heard about us, who introduced you, what you are looking for"></textarea>
          </div>

          <button class="primary" type="submit" style="width:100%;margin-top:8px">
            Send for approval</button>
        </form>

        <div class="login-alt">
          <span>Already have an account?</span>
          <a href="#/login" id="backToLogin">Sign in</a>
        </div>
      </div>
    </div>

    <p class="reg-foot">For accredited investors only. Sending this form is not an application
      to purchase a security and does not create any obligation on either side.</p>
  </div>`;
}

function wireRegister() {
  const form = $('#regForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#regForm button[type=submit]');
    const v = formValues(form);
    const fail = (msg) => {
      $('#regError').innerHTML = `<div class="error-box">${esc(msg)}</div>`;
      $('#regError').scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    // Checked here as well as on the server, because being told the two
    // passwords differ *after* a round trip is a poor way to find out.
    if (v.password !== v.password2) return fail('The two passwords do not match.');
    delete v.password2;

    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Sending…';
    try {
      await api('/register', { method: 'POST', body: v });
      $('#app').innerHTML = registerDoneView(v.email);
      $('#regDoneBack')?.addEventListener('click', () => { location.hash = '#/login'; });
    } catch (err) {
      fail(err.message);
      btn.disabled = false;
      btn.textContent = 'Send for approval';
    }
  });
}

/* The same answer whether or not that mailbox is already known here — the
   form must not become a way of finding out who our investors are. */
const registerDoneView = (email) => `
  <div class="reg-wrap">
    <div class="card" style="margin-top:60px">
      <div class="card-body" style="text-align:center;padding:44px 34px">
        <div class="login-brand" style="justify-content:center"><span class="brand-mark"></span>Poel Capital</div>
        <h1 style="font-size:26px;margin:18px 0 10px">Thank you.</h1>
        <p style="color:var(--text-secondary);font-size:14px;line-height:1.65;max-width:430px;margin:0 auto">
          Your details are with us. Somebody will review them and open your account, and we will
          be in touch at <strong>${esc(email)}</strong>. Until then your password will not work,
          which is expected rather than a fault.</p>
        <button class="primary" id="regDoneBack" style="margin-top:24px">Back to sign in</button>
      </div>
    </div>
  </div>`;

/* ----------------------------- dashboard ----------------------------- */

async function dashboardView() {
  /* The dashboard can be narrowed to one owner entity. It is the same
     filter on both calls, so the headline figures and the alerts below
     them are always describing the same book — a dashboard where the
     numbers and the warnings disagree about their scope is worse than
     one with no filter at all. Investors do not see it: they hold
     percentages of policies, not entities. */
  const staff = !isInvestorUser();
  const suffix = entityQuery() ? `?${entityQuery()}` : '';
  const [sum, svc, funds] = await Promise.all([
    api(`/analytics/summary${suffix}`),
    api(`/servicing${suffix}`),
    loadFunds(),
  ]);
  const t = sum.totals;
  const critical = svc.alerts.filter((a) => a.severity === 'critical').length;
  const annualPremium = Number(t.monthly_coi) * 12;
  // What an investor is shown instead of servicing alerts: what is coming and
  // what their part of it costs.
  const todayIso = today();
  /* The same list the Premiums page builds, so the card on the dashboard and
     the page it links to can never disagree about what is owed. */
  const upcomingMine = premiumDues(svc).filter((d) => d.date >= todayIso);
  const nextDue = upcomingMine[0] || null;
  // What an investor is shown where the carrier mechanics used to be: the
  // spread between what they have put in and what the policies would pay.
  const gain = Number(t.total_death_benefit) - Number(t.total_invested);
  const multiple = Number(t.total_invested) > 0
    ? Number(t.total_death_benefit) / Number(t.total_invested) : null;

  const html = `
    <div class="page-head">
      <div>
        <h1>${isInvestorUser() ? 'Your portfolio' : 'Portfolio dashboard'}</h1>
        <div class="sub">${t.policy_count} ${t.policy_count === 1 ? 'position' : isInvestorUser() ? 'positions' : 'active policies'}${
          !isInvestorUser() && entityLabel() ? ` in ${esc(entityLabel())}` : ''}${
          isInvestorUser() ? ' · figures reflect your ownership percentage' : ''}</div>
      </div>
      <div class="spacer"></div>
      ${rateToggle()}
      ${entityPicker(funds)}
      ${isInvestorUser() ? '' : '<a class="btn" href="#/import">Import data</a>'}
      <a class="btn btn-primary" href="#/policies">${isInvestorUser() ? 'My policies' : 'View policies'}</a>
    </div>

    <div class="kpi-row">
      <div class="stat">
        <div class="label">Total death benefit</div>
        <div class="value hero">${fmtExact(t.total_death_benefit)}</div>
        <div class="note">Face at issue ${fmtExact(t.total_face)}</div>
      </div>
      <div class="stat">
        <div class="label">Capital invested</div>
        <div class="value">${fmtExact(t.total_invested)}</div>
        <div class="note">${fmtExact(t.total_acquisition)} acquisition · ${fmtExact(t.total_premiums)} premiums</div>
      </div>
      <div class="stat">
        <div class="label">Average insured age</div>
        <div class="value">${sum.avgInsuredAge
          ? Number(sum.avgInsuredAge).toFixed(1)
          : '<span class="muted">—</span>'}</div>
        <div class="note">${sum.lives
          ? `across ${sum.lives} ${sum.lives === 1 ? 'life' : 'lives'}${
              sum.livesWithDob < sum.lives
                ? ` · ${sum.lives - sum.livesWithDob} with no date of birth` : ''}`
          : 'no lives on the book'}</div>
      </div>
      ${isInvestorUser() ? `
      <div class="stat">
        <div class="label">Unrealized gain</div>
        <div class="value" style="${gain >= 0 ? '' : 'color:var(--critical)'}">${fmtExact(gain)}</div>
        <div class="note">death benefit less capital invested${multiple ? ` · ${multiple.toFixed(2)}×` : ''}</div>
      </div>` : `
      <div class="stat">
        <div class="label">Cash surrender value</div>
        <div class="value">${fmtExact(t.total_csv)}</div>
        <div class="note">Account value ${fmtExact(t.total_av)}</div>
      </div>
      <div class="stat">
        <div class="label">Cost of insurance</div>
        <div class="value">${fmtExact(t.monthly_coi)}<span style="font-size:15px;color:var(--text-muted)">/mo</span></div>
        <div class="note">≈ ${fmtExact(annualPremium)} per year</div>
      </div>`}
      ${sum.carry ? `
      <div class="stat">
        ${/* Ours. An investor is never sent this block, so the tile cannot
             appear on their dashboard by accident. */''}
        <div class="label">Carried interest</div>
        <div class="value">${fmtExact(sum.carry.total)}</div>
        <div class="note">if every policy matured today · ${sum.carry.policies}
          ${sum.carry.policies === 1 ? 'policy' : 'policies'}${
          sum.carry.policies_without_carry
            ? ` · ${sum.carry.policies_without_carry} charge none` : ''}</div>
      </div>` : ''}
      <div class="stat">
        <div class="label">Portfolio return${showsBothRates() ? ' · simple interest' : ''}</div>
        <div class="value">${fmtRate(bookRate(sum.rate))}</div>
        ${''/* Which of the two ways of combining the policies is on the
               tile, and what the other reads. Printed rather than left to
               the control in the heading: the gap between them is the
               reason there is a choice. */}
        <div class="note">${compoundNote(sum.rate)
          ? `${compoundNote(sum.rate)} · ` : ''}${sum.rate?.days
          ? `if every policy matured today · ${(sum.rate.days / 365).toFixed(1)} yr span`
          : 'no dated cash flows yet'}${basisNote(sum.rate)
          ? ` · ${basisNote(sum.rate)}` : ''}</div>
      </div>
      ${isInvestorUser() ? `
      <div class="stat">
        <div class="label">Next premium due</div>
        <div class="value">${nextDue ? fmtDate(nextDue.date) : '—'}</div>
        <div class="note">${nextDue ? `${money(nextDue.amount)} · your share` : 'nothing scheduled'}</div>
      </div>` : `
      <div class="stat">
        <div class="label">Needs attention</div>
        <div class="value" style="${critical ? 'color:var(--critical)' : ''}">${svc.alerts.length}</div>
        <div class="note">${critical} critical</div>
      </div>`}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Capital deployed over time</h2>
          <div class="spacer"></div>
          <span class="muted" style="font-size:12px">cumulative</span></div>
        <div class="card-body"><div id="chartCapital"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Death benefit by carrier</h2></div>
        <div class="card-body"><div id="chartCarrier"></div></div>
      </div>
    </div>

    ${isInvestorUser() ? `
    <div class="card">
      <div class="card-head"><h2>Premiums coming up</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">your share</span>
        <a href="#/servicing" style="font-size:13px;margin-left:12px">See all →</a></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Due</th><th>Insured</th><th>Policy</th><th class="num">Your share</th></tr></thead>
        <tbody>${upcomingMine.length === 0
          ? '<tr><td colspan="4"><div class="empty">No premium dates are scheduled on your policies.</div></td></tr>'
          : upcomingMine.slice(0, 8).map((r) => `<tr class="clickable" data-id="${r.policy_id}">
              <td class="strong">${fmtDate(r.date)}</td>
              <td>${esc(r.insured)}${r.sex ? ` <span class="muted">· ${esc(r.sex)}</span>` : ''}</td>
              <td class="secondary">${esc(r.carrier_name || '')} ${esc(r.policy_number || '')}</td>
              <td class="num">${money(r.amount)}</td>
            </tr>`).join('')}</tbody>
      </table></div>
    </div>` : `
    <div class="card">
      <div class="card-head"><h2>Alerts</h2><div class="spacer"></div>
        <a href="#/servicing" style="font-size:13px">Open servicing calendar →</a></div>
      <div class="card-body flush">
        ${svc.alerts.length === 0
          ? '<div class="empty">Nothing needs attention right now.</div>'
          : svc.alerts.slice(0, 12).map(alertRow).join('')}
      </div>
    </div>`}`;

  return {
    html,
    after: () => {
      wireEntityPicker();
      wireRateToggle();
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`)));
      lineChart($('#chartCapital'), {
        points: sum.capitalDeployed.map((r) => ({
          x: `${r.month}-01`,
          label: new Date(`${r.month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
          tooltipTitle: new Date(`${r.month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
          values: { cumulative: r.cumulative },
          extra: [{ name: 'Paid this month', value: r.monthly }],
        })),
        series: [{ key: 'cumulative', name: 'Cumulative invested' }],
        height: 220,
      });
      barChart($('#chartCarrier'), {
        rows: sum.byCarrier.slice(0, 8).map((c) => ({
          label: c.carrier_name || 'Unassigned',
          value: Number(c.face),
          note: `${c.n} ${c.n === 1 ? 'policy' : 'policies'}`,
          seriesName: 'Face amount',
        })),
      });
    },
  };
}

const SEV_ICON = { critical: '!', serious: '!', warning: '!', info: 'i' };

function alertRow(a) {
  return `
    <div class="alert-row">
      <span class="sev ${esc(a.severity)}"><span class="ic">${SEV_ICON[a.severity]}</span></span>
      <div>
        <div class="who"><a href="#/policy/${a.id}">${esc(a.insured)}</a>
          <span class="muted" style="font-weight:400"> · ${esc(a.carrier_name)} ${esc(a.policy_number)}</span></div>
        <div class="meta">${esc(a.reason)}</div>
      </div>
      <div class="spacer"></div>
      <div style="text-align:right">
        ${''/* Only a scheduled item carries a figure. The rest of these are
               lapse risk and stale carrier data — putting the policy's annual
               premium beside them read as an amount that was due. */}
        <div style="font-variant-numeric:tabular-nums;font-weight:600">${
          a.scheduled && a.amount ? fmtExact(a.amount) : ''}</div>
        <div class="meta">${a.scheduled ? `${fmtDate(a.due_date)} · scheduled` : ''}</div>
      </div>
    </div>`;
}

/* ------------------------------ policies ----------------------------- */

/* The cells, one renderer per TYPE rather than one per field.
 *
 * The catalogue in `policy-fields.js` says what each field IS; this says
 * what that looks like in a table cell. Adding a field is a line there and
 * nothing here — which is the point, because the grid now offers every
 * column a policy has rather than the twenty somebody chose in advance.
 *
 * Money is share-weighted for an investor by `scaled`, dates are formatted
 * once, and a few fields that are genuinely their own thing — status,
 * product type, the share percentage — keep a renderer of their own. */
const CELL = {
  text: (p, f) => (p[f.key] === null || p[f.key] === undefined || p[f.key] === ''
    ? dash : esc(String(p[f.key]))),
  strong: (p, f) => `<span class="strong">${esc(p[f.key] ?? '')}</span>`,
  date: (p, f) => (p[f.key] ? fmtDate(p[f.key]) : dash),
  money: (p, f) => money(scaled(p[f.key], p), 2),
  int: (p, f) => (p[f.key] === null || p[f.key] === undefined || p[f.key] === ''
    ? dash : Number(p[f.key]).toLocaleString('en-US')),
  age: (p) => ageFrom(p.insured_dob) ?? dash,
  sex: (p) => sexLabel(p.insured_gender),
  owner: (p) => esc(p.fund_code || p.owner_account || '—'),
  product: (p) => (p.product_type
    ? `<span title="${esc(PRODUCT_LABELS[p.product_type] || p.product_type)}">${
        esc(p.product_type)}</span>`
    : dash),
  status: (p) => statusBadge(p.status),
  pct: (p, f) => `<span class="strong">${Number(p[f.key] || 0).toFixed(
    Number(p[f.key]) % 1 ? 4 : 0)}%</span>`,
};
/** Numbers line up right; everything else reads left. */
const NUM_TYPES = new Set(['money', 'int', 'age', 'pct']);
/** Sorting needs the value, not the markup — and for money, the share of it. */
const SORT_VALUE = {
  age: (p) => ageFrom(p.insured_dob),
  money: (p, f) => Number(scaled(p[f.key], p)) || 0,
  int: (p, f) => (p[f.key] == null || p[f.key] === '' ? null : Number(p[f.key])),
  pct: (p, f) => Number(p[f.key]),
};

/** A catalogue entry, turned into a column the grid can draw. */
const asColumn = (f) => ({
  ...f,
  cls: NUM_TYPES.has(f.type) ? 'num' : '',
  value: (p) => (SORT_VALUE[f.type] ? SORT_VALUE[f.type](p, f) : p[f.key]),
  cell: (p) => (CELL[f.type] || CELL.text)(p, f),
});

/** Every column this person may see, arranged the way they arranged it. */
/* Reports is imported by this module, so it cannot import back. What it
   needs from here — the column catalogue as this person has arranged it,
   and the picker to change it — is handed over once at load instead. */
wireReports({
  columns: () => reportFieldList(),
  pick: (opts) => openColumnsDialog(opts),
  save: (fields) => saveReportColumns(fields),
  reset: () => resetReportColumns(),
  /* Reports had an owner picker of its own. It is the same question every
     other screen asks, and two controls for it meant a person could look
     at LCG1 all morning and print LCG2 without noticing. */
  entityPicker: (funds) => entityPicker(funds),
  wireEntityPicker: () => wireEntityPicker(),
  entityCodes: () => entityCodes(),
  /* A printed document has to be readable on the same basis as the screen
     it was generated from, so the reports share the control rather than
     keeping an idea of their own about how rates combine. */
  rateToggle: () => rateToggle(),
  wireRateToggle: () => wireRateToggle(),
  rateBasis: () => rateBasis(),
});

const policyFieldList = () =>
  arrangeFields(state.policyCols, { investor: isInvestorUser() });

/** The same catalogue, arranged for the Policy Schedule report instead. */
const reportFieldList = () =>
  arrangeFields(state.reportCols, { investor: isInvestorUser(), forReport: true });

/** The ones actually on the grid. */
const policyColumns = () => policyFieldList().filter((f) => f.visible).map(asColumn);

/** Store the arrangement and redraw. Saving is fire-and-forget: the screen
    has already changed, and a failed save is worth a line in the console
    rather than a modal in the way of the work. */
async function savePolicyColumns(fields) {
  state.policyCols = packArrangement(fields);
  render();
  try {
    await api('/me/prefs/policy_columns', { method: 'PUT', body: state.policyCols });
  } catch (e) {
    console.warn('column arrangement not saved:', e.message);
  }
}

async function saveReportColumns(fields) {
  state.reportCols = packArrangement(fields);
  try {
    await api('/me/prefs/report_columns', { method: 'PUT', body: state.reportCols });
  } catch (e) {
    console.warn('report columns not saved:', e.message);
  }
}

async function resetReportColumns() {
  state.reportCols = null;
  try {
    await api('/me/prefs/report_columns', { method: 'DELETE' });
  } catch (e) {
    console.warn('report columns not reset:', e.message);
  }
}

async function resetPolicyColumns() {
  state.policyCols = null;
  render();
  try {
    await api('/me/prefs/policy_columns', { method: 'DELETE' });
  } catch (e) {
    console.warn('column arrangement not reset:', e.message);
  }
}

/**
 * Choose the columns, and their order.
 *
 * Two ways to move one, because they suit different hands: drag a row, or
 * use the arrows. The arrows matter — dragging is awkward on a trackpad,
 * impossible from a keyboard, and this list is forty rows long.
 *
 * The list is the order. Hiding a column does not move it, so switching one
 * back on puts it back where it was rather than at the end.
 */
/**
 * The column picker, serving whichever surface asked for it.
 *
 * The grid and the Policy Schedule report are arranged from the same
 * catalogue and by the same dialog, remembered separately. One dialog
 * because "which columns, in what order" is one question however it is
 * asked, and two implementations of it would drift.
 */
function openColumnsDialog({
  fields: given = null,
  title = 'Columns',
  blurb = null,
  onApply = savePolicyColumns,
  onReset = resetPolicyColumns,
  where = 'on the grid',
} = {}) {
  const fields = given || policyFieldList();
  const row = (f, i) => `
    <li class="col-pick" draggable="true" data-key="${f.key}" data-i="${i}">
      <span class="grip" aria-hidden="true">⋮⋮</span>
      <label class="col-pick-label">
        <input type="checkbox" data-show="${f.key}" ${f.visible ? 'checked' : ''}>
        <span class="col-pick-name">${esc(f.header)}</span>
        <span class="muted col-pick-group">${esc(f.group)}</span>
      </label>
      <button type="button" class="btn-sm" data-move="up" data-key="${f.key}"
        aria-label="Move ${esc(f.header)} left">↑</button>
      <button type="button" class="btn-sm" data-move="down" data-key="${f.key}"
        aria-label="Move ${esc(f.header)} right">↓</button>
    </li>`;

  const body = `
    <p class="muted" style="font-size:12.5px;margin:0 0 10px">
      ${blurb || `Tick a field to put it ${where}. Drag a row, or use the arrows, to change
      the order — the order here is the order left to right. Yours alone: it follows
      your login, and nobody else's screen moves.`}
    </p>
    <div class="toolbar" style="margin-bottom:8px">
      <input class="grow" id="colSearch" placeholder="Find a field…">
      <button type="button" class="btn-sm" id="colAll">Show all</button>
      <button type="button" class="btn-sm" id="colNone">Hide all</button>
      <button type="button" class="btn-sm" id="colReset">Back to default</button>
    </div>
    <ul class="col-pick-list" id="colList">${fields.map(row).join('')}</ul>
    <div class="muted" style="font-size:12px;margin-top:8px" id="colCount"></div>`;

  const dlg = openDialog(title, body, async () => {
    await onApply(read());
  }, 'Apply');

  const list = $('#colList', dlg);
  const keys = () => [...list.querySelectorAll('li')].map((li) => li.dataset.key);
  const read = () => keys().map((k) => ({
    ...fields.find((f) => f.key === k),
    visible: $(`input[data-show="${k}"]`, dlg).checked,
  }));
  const tally = () => {
    const on = read().filter((f) => f.visible).length;
    $('#colCount', dlg).textContent =
      `${on} of ${fields.length} ${on === 1 ? 'column' : 'columns'} ${where}`;
  };
  tally();

  list.addEventListener('change', tally);
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const li = btn.closest('li');
    if (btn.dataset.move === 'up') li.previousElementSibling?.before(li);
    else li.nextElementSibling?.after(li);
    li.scrollIntoView({ block: 'nearest' });
  });

  /* Drag to reorder. The row being dragged is marked rather than moved, and
     the drop lands it before or after whichever row the pointer is over,
     depending on which half it is in — dropping "on" a row is ambiguous. */
  let dragging = null;
  list.addEventListener('dragstart', (e) => {
    dragging = e.target.closest('li');
    dragging?.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without something on the transfer.
    e.dataTransfer.setData('text/plain', dragging?.dataset.key || '');
  });
  list.addEventListener('dragend', () => {
    dragging?.classList.remove('dragging');
    dragging = null;
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const over = e.target.closest('li');
    if (!over || !dragging || over === dragging) return;
    const box = over.getBoundingClientRect();
    if (e.clientY < box.top + box.height / 2) over.before(dragging);
    else over.after(dragging);
  });

  $('#colSearch', dlg).addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    list.querySelectorAll('li').forEach((li) => {
      const f = fields.find((x) => x.key === li.dataset.key);
      const hit = !term || `${f.header} ${f.group} ${f.key}`.toLowerCase().includes(term);
      li.style.display = hit ? '' : 'none';
    });
  });
  const setAll = (on) => {
    list.querySelectorAll('input[data-show]').forEach((box) => {
      // Only what is in front of them — a search then "hide all" should not
      // switch off forty fields they cannot see.
      if (box.closest('li').style.display !== 'none') box.checked = on;
    });
    tally();
  };
  $('#colAll', dlg).addEventListener('click', () => setAll(true));
  $('#colNone', dlg).addEventListener('click', () => setAll(false));
  $('#colReset', dlg).addEventListener('click', async () => {
    dlg.close(); dlg.remove();
    await onReset();
  });
  return dlg;
}

function sortPolicies(rows) {
  const { key, dir } = state.sort;
  const col = policyColumns().find((c) => c.key === key);
  const val = (r) => (col?.value ? col.value(r) : r[key]);
  return [...rows].sort((a, b) => {
    const av = val(a), bv = val(b);
    if (av === null || av === undefined || av === '') return 1;
    if (bv === null || bv === undefined || bv === '') return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * dir;
  });
}

async function policiesView() {
  const [policies, funds] = await Promise.all([
    api(`/policies?search=${encodeURIComponent(state.filters.search)}&status=${encodeURIComponent(state.filters.status)}&fund=${encodeURIComponent(entityParam())}`),
    isInvestorUser() ? Promise.resolve([])
      : state.funds.length ? Promise.resolve(state.funds) : api('/funds'),
  ]);
  state.policies = policies;
  state.funds = funds;
  const rows = sortPolicies(policies);

  /* Only an administrator clears a shelf. A manager can still delete a policy
     in their own entity one at a time, which is the deliberate act this is
     not. */
  const canBulkDelete = isAdminUser();
  if (!canBulkDelete) state.selected.clear();
  const shownIds = rows.map((p) => p.id);
  const ticked = shownIds.filter((id) => state.selected.has(id));
  const allShownTicked = shownIds.length > 0 && ticked.length === shownIds.length;
  // Anything picked and then filtered away still counts, and is said so.
  const offScreen = state.selected.size - ticked.length;

  /* Totalled from whichever money columns are actually on the grid, rather
     than from a list kept beside it — otherwise adding a column leaves the
     footer a cell out of step with the figures above it. */
  const cols = policyColumns();
  const totals = {};
  for (const c of cols.filter((x) => x.total))
    totals[c.key] = rows.reduce((sum, p) => sum + (Number(scaled(p[c.key], p)) || 0), 0);

  const html = `
    <div class="page-head">
      <div><h1>${isInvestorUser() ? 'My policies' : 'Policies'}</h1>
        <div class="sub">${rows.length} of ${policies.length ? policies.length : 0} shown${
          entityLabel() ? ` · ${esc(entityLabel())} only` : ''}${
          isInvestorUser() ? ' · every figure is your share of each policy' : ''}</div></div>
      <div class="spacer"></div>
      ${shareToggle()}
      <button id="columnsBtn">Columns</button>
      ${isAdminUser() ? '<button id="exportBtn">Export CSV</button>' : ''}
      ${canEditData() ? '<button class="primary" id="newPolicyBtn">New policy</button>' : ''}
    </div>

    <div class="toolbar">
      <input class="grow" id="searchInput" placeholder="Search policy #, insured, carrier…" value="${esc(state.filters.search)}">
      <select id="statusFilter">
        <option value="">All statuses</option>
        ${['Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending']
          .map((s) => `<option ${state.filters.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      ${entityPicker(funds)}
    </div>

    ${canBulkDelete && state.selected.size ? `
    <div class="bulk-bar" id="bulkBar">
      <strong>${state.selected.size} ${state.selected.size === 1 ? 'policy' : 'policies'} selected</strong>
      ${offScreen > 0 ? `<span class="muted">${offScreen} of them not on screen — the search
        and filters above do not clear a selection</span>` : ''}
      <div class="spacer"></div>
      <button class="btn-sm" id="clearTicks">Clear selection</button>
      <button class="btn-danger" id="bulkDeleteBtn">Delete ${state.selected.size} ${
        state.selected.size === 1 ? 'policy' : 'policies'}</button>
    </div>` : ''}

    <div class="card">
      <div class="table-wrap sticky-head">
        <table class="data">
          <thead><tr>${canBulkDelete ? `<th class="tick">
            <input type="checkbox" id="tickAll" aria-label="Select every policy shown"
              ${allShownTicked ? 'checked' : ''}></th>` : ''}${cols.map((c) =>
            `<th class="sortable ${c.cls || ''}" data-key="${c.key}" draggable="true"
              title="Click to sort · drag to move">${c.header}${
              state.sort.key === c.key ? `<span class="arrow">${state.sort.dir === 1 ? '↑' : '↓'}</span>` : ''}</th>`
          ).join('')}</tr></thead>
          <tbody>
            ${/* No columns is its own empty state, and it has to win over "no
                  policies" — otherwise a grid with rows and no columns draws
                  seventeen blank lines and looks broken rather than switched
                  off. */''}
            ${rows.length === 0 || cols.length === 0
              ? `<tr><td colspan="${(cols.length || 1) + (canBulkDelete ? 1 : 0)}"><div class="empty">${
                  cols.length === 0
                    ? 'Every column is switched off. Use <strong>Columns</strong>, above, to bring some back.'
                    : 'No policies yet. Import a CSV or add one manually.'
                }</div></td></tr>`
              : rows.map((p) => `<tr class="clickable ${
                  state.selected.has(p.id) ? 'ticked' : ''}" data-id="${p.id}">${
                  canBulkDelete ? `<td class="tick"><input type="checkbox" data-tick="${p.id}"
                    aria-label="Select ${esc(p.policy_number)}"
                    ${state.selected.has(p.id) ? 'checked' : ''}></td>` : ''}${
                  cols.map((c) => `<td class="${c.cls || ''}">${c.cell(p)}</td>`).join('')
                }</tr>`).join('')}
          </tbody>
          ${rows.length && cols.length ? `<tfoot><tr>${(() => {
            /* Built from the same column list as the head, so hiding or
               moving a column can never leave the footer one cell out of step
               with the figures above it. */
            const first = cols.findIndex((c) => c.key in totals);
            if (first === -1)
              return `<td colspan="${cols.length + (canBulkDelete ? 1 : 0)}">Totals — ${
                rows.length} ${rows.length === 1 ? 'policy' : 'policies'}</td>`;
            return cols.map((c, i) => {
              if (i === 0) return `<td colspan="${first + (canBulkDelete ? 1 : 0)}">Totals — ${
                rows.length} ${rows.length === 1 ? 'policy' : 'policies'}</td>`;
              if (i < first) return '';
              return c.key in totals
                ? `<td class="num">${fmtExact(totals[c.key])}</td>`
                : '<td></td>';
            }).join('');
          })()}</tr></tfoot>` : ''}
        </table>
      </div>
    </div>`;

  return {
    html,
    after: () => {
      wireSearch('#searchInput', (term) => { state.filters.search = term; });
      $('#statusFilter').addEventListener('change', (e) => {
        state.filters.status = e.target.value; render({ soft: true }); });
      wireEntityPicker({ soft: true });
      $('#columnsBtn').addEventListener('click', () => openColumnsDialog());

      /* A heading does two jobs: click it to sort, drag it to move the column.
         `moved` keeps the drop from also registering as a click, which would
         re-sort the grid the moment you finished rearranging it. */
      let dragKey = null;
      let moved = false;
      document.querySelectorAll('th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
          if (moved) { moved = false; return; }
          const key = th.dataset.key;
          state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
          render();
        });
        th.addEventListener('dragstart', (e) => {
          dragKey = th.dataset.key;
          th.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', dragKey);
        });
        th.addEventListener('dragend', () => {
          th.classList.remove('dragging');
          document.querySelectorAll('th.drop-here').forEach((x) => x.classList.remove('drop-here'));
          dragKey = null;
        });
        th.addEventListener('dragover', (e) => {
          if (!dragKey || th.dataset.key === dragKey) return;
          e.preventDefault();
          th.classList.add('drop-here');
        });
        th.addEventListener('dragleave', () => th.classList.remove('drop-here'));
        th.addEventListener('drop', (e) => {
          e.preventDefault();
          th.classList.remove('drop-here');
          if (!dragKey || th.dataset.key === dragKey) return;
          moved = true;
          const fields = policyFieldList();
          const from = fields.findIndex((f) => f.key === dragKey);
          const to = fields.findIndex((f) => f.key === th.dataset.key);
          if (from === -1 || to === -1) return;
          const [lifted] = fields.splice(from, 1);
          fields.splice(to, 0, lifted);
          savePolicyColumns(fields);
        });
      });
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', (e) => {
          // A tick is not a navigation. Without this, choosing a policy to
          // delete opens it instead.
          if (e.target.closest('td.tick')) return;
          go(`#/policy/${tr.dataset.id}`);
        }));

      /* Ticking re-renders, because the bar, the totals and the header box
         all read from the same selection — patching them by hand is how one
         of them ends up saying something different from the others. */
      document.querySelectorAll('[data-tick]').forEach((box) =>
        box.addEventListener('change', () => {
          const id = Number(box.dataset.tick);
          if (box.checked) state.selected.add(id); else state.selected.delete(id);
          render();
        }));
      $('#tickAll')?.addEventListener('change', (e) => {
        // "All" means all of what you are looking at, not all of the book.
        for (const id of shownIds)
          if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
        render();
      });
      $('#clearTicks')?.addEventListener('click', () => { state.selected.clear(); render(); });
      $('#bulkDeleteBtn')?.addEventListener('click', () => openBulkDeleteDialog());

      $('#exportBtn')?.addEventListener('click', () => {
        // The export has to obey the same two rules as the screen: an
        // investor's figures are their share, and the carrier mechanics are
        // not theirs to have. A spreadsheet outlives the page it came from.
        const mine = isInvestorUser();
        const f = (r) => shareFactor(r);
        const cash = (key) => ({ header: key, get: (r) => Number(r[key === 'AV' ? 'account_value'
          : key === 'CSV' ? 'cash_surrender_value' : 'cost_of_insurance'] || 0) * f(r) });
        exportCsv(mine ? 'my-policies.csv' : 'policies.csv', rows, [
          { header: 'Policy Number', key: 'policy_number' },
          { header: 'Last Name', key: 'insured_last' },
          { header: 'First Name', key: 'insured_first' },
          { header: 'DOB', key: 'insured_dob' },
          { header: 'Sex', key: 'insured_gender' },
          { header: 'Carrier Name', key: 'carrier_name' },
          { header: 'Product Type', key: 'product_type' },
          { header: 'Issue Date', key: 'issue_date' },
          ...(mine ? [{ header: 'Your Share %', key: 'my_pct' }] : []),
          { header: 'Basic Face', get: (r) => Number(r.face_amount || 0) * f(r) },
          { header: 'Death Benefit', get: (r) => Number(r.death_benefit ?? r.face_amount ?? 0) * f(r) },
          ...(mine ? [] : [{ header: 'Owner', key: 'fund_code' }]),
          { header: 'Premium Required', get: (r) => Number(r.premium_required || 0) * f(r) },
          { header: 'Premium Mode', key: 'premium_mode' },
          { header: 'Next Premium Due', key: 'next_premium_due' },
          ...(mine ? [] : [
            { header: 'Values As Of', key: 'value_as_of' },
            cash('AV'), cash('CSV'), cash('COI'),
          ]),
          { header: 'Total Invested', get: (r) => Number(r.total_invested || 0) * f(r) },
          ...(mine ? [] : [{ header: 'Date Of Last Withdrawal', key: 'date_of_last_withdrawal' }]),
          { header: 'Status', key: 'status' },
        ], 'policies');
      });
      $('#newPolicyBtn')?.addEventListener('click', () => openPolicyDialog());
      wireShareToggle();
    },
  };
}

/* --------------------------- policy detail --------------------------- */

let detailTab = 'overview';

async function policyView() {
  const p = await api(`/policies/${state.params.id}`);
  const values = [...p.values].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  // Only fetched when the tab is open — it replays the whole ledger.
  const irrData = detailTab === 'return' ? await api(`/policies/${p.id}/irr`) : null;
  /* Same rule: only when the tab is open, and only for the people the
     Premium optimization screen exists for at all. */
  const streams = detailTab === 'servicing' && mayOptimize()
    ? await api(`/premium-streams?policy_id=${p.id}`).catch(() => []) : null;
  const age = ageFrom(p.insured_dob);
  const coi = Number(p.cost_of_insurance) || 0;
  const av = Number(p.account_value) || 0;
  const monthsCovered = coi > 0 ? av / coi : null;

  /* One policy at a time, in the order the grid is in.
   *
   * The book is worked through case by case — open one, read it, move on —
   * and going back to the list to find your place each time is the whole
   * job. So the neighbours come from the same sorted, filtered list the
   * grid shows: if you searched for a carrier, next means the next one of
   * that carrier's. Landing here from a link or a reload has no list to
   * walk, so one is fetched. */
  if (!state.policies.length && !isInvestorUser())
    state.policies = await api(
      `/policies?search=${encodeURIComponent(state.filters.search)}`
      + `&status=${encodeURIComponent(state.filters.status)}`
      + `&fund=${encodeURIComponent(entityParam())}`).catch(() => []);
  const walk = sortPolicies(state.policies || []);
  const here = walk.findIndex((x) => x.id === p.id);
  const prev = here > 0 ? walk[here - 1] : null;
  const next = here >= 0 && here < walk.length - 1 ? walk[here + 1] : null;

  // Value history is entirely account value, cash surrender value and cost of
  // insurance — carrier administration, not investment performance. There is
  // nothing left of the tab once those are taken out, so it goes.
  const tabs = [['overview', 'Overview'],
                ...(isInvestorUser() ? [] : [['values', 'Value history']]),
                ['transactions', 'Transactions'], ['return', 'Return'],
                ['servicing', isInvestorUser() ? 'Premiums' : 'Servicing']];

  const html = `
    <div class="page-head">
      <div>
        <div class="sub policy-walk">
          <a href="#/policies">← All policies</a>
          ${here >= 0 ? `
            <button class="btn-sm" id="prevPolicyBtn" ${prev ? '' : 'disabled'}
              title="${prev ? esc(`${insuredName(prev)} · ${prev.policy_number}`)
                : 'This is the first one'}">← Previous</button>
            <button class="btn-sm" id="nextPolicyBtn" ${next ? '' : 'disabled'}
              title="${next ? esc(`${insuredName(next)} · ${next.policy_number}`)
                : 'This is the last one'}">Next →</button>
            <span class="muted">${here + 1} of ${walk.length}</span>` : ''}
        </div>
        ${''/* The date of birth belongs beside the name: everything on this
               page — the life expectancy, the premium, the price — turns on
               how old this person is, and reading it off a tile further down
               is a step nobody should have to take. */}
        <h1>${esc(insuredName(p))}${p.insured_dob
          ? ` <span class="h1-dob">${fmtDate(p.insured_dob)}${
              age == null ? '' : ` · ${age}`}</span>` : ''}</h1>
        <div class="sub">${esc(p.carrier_name)} · Policy ${esc(p.policy_number)}
          ${p.fund_code ? `· ${esc(p.fund_code)}` : ''} · ${statusBadge(p.status)}</div>
      </div>
      <div class="spacer"></div>
      ${shareToggle(p.my_pct)}
      ${['admin', 'manager'].includes(state.user.role)
        ? '<button id="offerPolicyBtn">Offer to investors</button>' : ''}
      ${['admin', 'manager'].includes(state.user.role) ? '<button class="btn-danger" id="deletePolicyBtn">Delete policy</button>' : ''}
      ${canEditData() && p.insured_id ? '<button id="editInsuredBtn">Edit insured</button>' : ''}
      ${canEditData() ? '<button class="primary" id="editBtn">Edit policy</button>' : ''}
    </div>

    ${isInvestorUser() && p.my_pct != null ? `
    <div class="share-banner">
      You own <strong>${fmtPct(p.my_pct)}</strong> of this policy. Every figure on this page —
      the death benefit, what has been invested, the premium, the cash value and the return —
      is <strong>your ${fmtPct(p.my_pct)} share</strong>, not the whole policy.
    </div>` : ''}

    ${p.matured_on ? `
    <div class="card" style="border-left:3px solid var(--text-primary)">
      <div class="card-body">
        <div class="label" style="margin-bottom:6px">Matured</div>
        <div style="font-size:15px">
          This policy left the active portfolio on <strong>${fmtDate(p.matured_on)}</strong> and
          appears in <a href="#/maturities">Maturities</a>.
          ${p.proceeds_amount != null
            ? `Proceeds of <strong>${fmtExact(scaled(p.proceeds_amount, p))}</strong> were received${
                p.proceeds_received_on ? ` on ${fmtDate(p.proceeds_received_on)}` : ''}.`
            : 'The claim has not been recorded as paid yet.'}
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">
          Driven by the date of death on the insured record — clearing it returns the
          policy to the active book.</div>
      </div>
    </div>` : ''}

    <div class="kpi-row">
      <div class="stat"><div class="label">Death benefit</div>
        <div class="value">${fmtExact(scaled(p.death_benefit ?? p.face_amount, p))}</div>
        <div class="note">Face at issue ${fmtExact(scaled(p.face_amount, p))}</div></div>
      <div class="stat"><div class="label">Invested to date</div>
        <div class="value">${fmtExact(scaled(p.total_invested, p))}</div>
        <div class="note">${fmtExact(scaled(p.total_acquisition, p))} acquisition · ${fmtExact(scaled(p.total_premiums, p))} premium</div></div>
      ${isInvestorUser() ? `
      <div class="stat"><div class="label">Your position</div>
        <div class="value">${p.my_pct != null ? fmtPct(p.my_pct) : '—'}</div>
        <div class="note">acquired ${p.acquisition_date ? fmtDate(p.acquisition_date) : '—'}</div></div>` : `
      <div class="stat"><div class="label">Cash surrender value</div>
        <div class="value">${fmtExact(scaled(p.cash_surrender_value, p))}</div>
        <div class="note">AV ${fmtExact(scaled(p.account_value, p))} · as of ${p.value_as_of ? fmtDate(p.value_as_of) : '—'}</div></div>`}
      <div class="stat"><div class="label">Insured age</div>
        <div class="value">${age ?? '—'}</div>
        <div class="note">${p.insured_dob ? `Born ${fmtDate(p.insured_dob)}` : 'No date of birth on file'}</div></div>
      ${isInvestorUser() ? `
      <div class="stat"><div class="label">Next premium due</div>
        <div class="value" style="font-size:22px">${nextPremium(p) ? fmtDate(nextPremium(p).date) : '—'}</div>
        <div class="note">${nextPremium(p)
          ? (nextPremium(p).amount
              ? `${fmtExact(scaled(nextPremium(p).amount, p))} · your share`
              : 'amount not set yet')
          : 'nothing scheduled'}</div></div>` : `
      <div class="stat"><div class="label">Coverage runway</div>
        <div class="value" style="${monthsCovered !== null && monthsCovered < 6 ? 'color:var(--critical)' : ''}">${
          monthsCovered === null ? '—' : `${monthsCovered.toFixed(1)}<span style="font-size:15px;color:var(--text-muted)"> mo</span>`}</div>
        <div class="note">Account value ÷ monthly COI</div></div>`}
    </div>

    <div class="tabs">
      ${tabs.map(([k, label]) =>
        `<button data-tab="${k}" class="${detailTab === k ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="tabBody">${renderDetailTab(p, values, monthsCovered, irrData, streams)}</div>`;

  return {
    html,
    after: () => {
      $('#prevPolicyBtn')?.addEventListener('click', () => prev && go(`#/policy/${prev.id}`));
      $('#nextPolicyBtn')?.addEventListener('click', () => next && go(`#/policy/${next.id}`));
      /* Left and right walk the book too — but not while somebody is typing
         in a field or reading a dialog, which is the other thing arrow keys
         do. */
      onKey((e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (document.querySelector('dialog[open]')) return;
        const el = document.activeElement;
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
        const to = e.key === 'ArrowLeft' ? prev : next;
        if (to) { e.preventDefault(); go(`#/policy/${to.id}`); }
      });

      document.querySelectorAll('.tabs button').forEach((b) =>
        b.addEventListener('click', () => { detailTab = b.dataset.tab; render(); }));
      wireShareToggle();
      $('#editBtn')?.addEventListener('click', () => openPolicyDialog(p));
      $('#deletePolicyBtn')?.addEventListener('click', () => openDeletePolicyDialog(p));
      $('#offerPolicyBtn')?.addEventListener('click', () => {
        openOfferDialog(p).catch((e) => alert(e.message));
      });
      $('#editInsuredBtn')?.addEventListener('click', async () => {
        const ins = await api(`/insureds/${p.insured_id}`);
        openInsuredDialog(ins);
      });
      wireDetailTab(p, values, irrData);
    },
  };
}

function renderDetailTab(p, values, monthsCovered, irrData, streams) {
  if (detailTab === 'values') return isInvestorUser() ? overviewTab(p) : valuesTab(p, values);
  if (detailTab === 'transactions') return transactionsTab(p);
  if (detailTab === 'return') return returnTab(p, irrData);
  if (detailTab === 'servicing') return servicingTab(p, monthsCovered, streams);
  return overviewTab(p, values);
}

function overviewTab(p) {
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const dash = '<span class="muted">—</span>';
  const extras = p.additionalInsureds || [];

  const lifeRow = (i, isPrimary, linkId) => `
    <tr>
      <td class="strong">${esc(i.last_name || '—')}</td>
      <td>${esc(i.first_name || '')}</td>
      <td>${isPrimary
            ? '<span class="badge inforce"><span class="dot"></span>Primary</span>'
            : `<span class="badge">${esc(i.role || 'Joint')}</span>`}</td>
      <td>${fmtDate(i.dob)}</td>
      <td class="num">${ageFrom(i.dob) ?? '—'}</td>
      <td>${sexLabel(i.gender)}</td>
      <td class="num">${i.le_months ?? '—'}</td>
      <td>${i.date_of_death ? fmtDate(i.date_of_death) : dash}</td>
      <td>${!canEditData() ? '' : `
        <button class="btn-sm" data-edit-life="${i.id}">Edit</button>
        ${isPrimary ? '' : `<button class="btn-sm btn-danger" data-remove-life="${linkId}">Remove</button>`}`}
      </td>
    </tr>`;

  const owners = p.owners || [];
  const allocated = owners.reduce((sum, o) => sum + Number(o.pct), 0);
  const unallocated = Math.max(0, 100 - allocated);
  const dbFull = Number(p.death_benefit ?? p.face_amount) || 0;
  const invFull = Number(p.total_invested) || 0;

  const ownershipCard = `
  <div class="card">
    <div class="card-head"><h2>${isInvestorUser() ? 'Your position' : 'Ownership'}</h2>
      <div class="spacer"></div>
      ${!canEditData() ? '' : `<span class="muted" style="font-size:12px">
        ${allocated.toFixed(allocated % 1 ? 4 : 0)}% allocated${
          unallocated > 0.000001 ? ` · ${unallocated.toFixed(unallocated % 1 ? 4 : 0)}% unallocated` : ''}</span>
      <button class="btn-sm primary" id="addOwnerBtn" ${unallocated <= 0.000001 ? 'disabled title="Fully allocated"' : ''}>Add investor</button>`}
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Investor</th><th>Type</th><th class="num">Share</th>
          <th class="num">Death benefit</th><th class="num">Invested</th>
          <th>Acquired</th>${isInvestorUser() ? '' : '<th></th>'}</tr></thead>
        <tbody>
          ${owners.length === 0
            ? `<tr><td colspan="${isInvestorUser() ? 6 : 7}"><div class="empty">No investors allocated yet.</div></td></tr>`
            : owners.map((o) => `<tr>
                <td class="strong">${esc(o.name)}</td>
                <td class="secondary">${esc(o.investor_type || '')}</td>
                <td class="num strong">${Number(o.pct).toFixed(Number(o.pct) % 1 ? 4 : 0)}%</td>
                <td class="num">${money(dbFull * Number(o.pct) / 100, 2)}</td>
                <td class="num">${money(invFull * Number(o.pct) / 100, 2)}</td>
                <td>${o.acquired_on ? fmtDate(o.acquired_on) : '<span class="muted">—</span>'}</td>
                ${!canEditData() ? '' : `<td>
                  <button class="btn-sm" data-edit-owner="${o.id}" data-pct="${o.pct}"
                    data-name="${esc(o.name)}" data-acq="${o.acquired_on || ''}">Edit</button>
                  <button class="btn-sm btn-danger" data-del-owner="${o.id}" data-name="${esc(o.name)}">Remove</button>
                </td>`}
              </tr>`).join('')}
          ${!isInvestorUser() && unallocated > 0.000001 ? `<tr class="muted">
            <td>Unallocated</td><td></td>
            <td class="num">${unallocated.toFixed(unallocated % 1 ? 4 : 0)}%</td>
            <td class="num">${money(dbFull * unallocated / 100, 2)}</td>
            <td class="num">${money(invFull * unallocated / 100, 2)}</td>
            <td colspan="2"></td></tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>`;

  return `
  ${ownershipCard}
  <div class="card">
    <div class="card-head"><h2>Lives insured</h2><div class="spacer"></div>
      ${canEditData() ? '<button class="btn-sm primary" id="addLifeBtn">Add insured</button>' : ''}</div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>Last name</th><th>First name</th><th>Role</th><th>Date of birth</th>
          <th class="num">Age</th><th>Sex</th><th class="num">LE (months)</th>
          <th>Date of death</th><th></th>
        </tr></thead>
        <tbody>
          ${p.insured_id
            ? lifeRow({ id: p.insured_id, last_name: p.insured_last, first_name: p.insured_first,
                        dob: p.insured_dob, gender: p.insured_gender, le_months: p.le_months,
                        date_of_death: p.date_of_death },
                      true)
            : '<tr><td colspan="9"><div class="empty">No insured recorded on this policy.</div></td></tr>'}
          ${extras.map((i) => lifeRow(i, false, i.link_id)).join('')}
        </tbody>
      </table>
    </div>
    ${extras.length ? '' : `<div class="card-body" style="border-top:1px solid var(--grid);padding-top:13px">
      <span class="muted" style="font-size:12.5px">Survivorship and second-to-die policies cover two lives —
      add the second one here.</span></div>`}
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h2>Policy</h2></div>
      <div class="card-body"><dl class="kv">
        ${row('Policy number', esc(p.policy_number))}
        ${row('Unique case ID', esc(p.unique_case_id) || dash)}
        ${row('Carrier', esc(p.carrier_name))}
        ${row('Plan name', esc(p.plan_name) || dash)}
        ${row('Product type', p.product_type
            ? `${esc(p.product_type)} <span class="muted">${esc(PRODUCT_LABELS[p.product_type] || '')}</span>`
            : dash)}
        ${row('Issue date', fmtDate(p.issue_date))}
        ${row('Issue age', p.issue_age ?? dash)}
        ${row('Issue state', esc(p.issue_state) || dash)}
        ${row('Face amount', money(scaled(p.face_amount, p)))}
        ${row('Owner / fund', esc(p.fund_code || '—'))}
        ${row('Owner account', esc(p.owner_account) || dash)}
        ${row('Beneficiary', esc(p.beneficiary) || dash)}
        ${row('Status', statusBadge(p.status))}
      </dl></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Acquisition &amp; premium</h2></div>
      <div class="card-body"><dl class="kv">
        ${row('Acquired', fmtDate(p.acquisition_date))}
        ${row('Acquisition cost', money(scaled(p.acquisition_cost, p)))}
        ${row('Total invested', money(scaled(p.total_invested, p)))}
        ${row('Next premium due', nextPremium(p)
          ? `${fmtDate(nextPremium(p).date)}${nextPremium(p).amount
              ? ` <span class="muted">· ${money(scaled(nextPremium(p).amount, p))}</span>` : ''}`
          : '<span class="muted">nothing scheduled</span>')}
        ${row('Premium on the policy', `${money(scaled(p.premium_required, p))} <span class="muted">${esc(p.premium_mode || '')} · reference</span>`)}
        ${row('Grace period', `${p.grace_period_days || 61} days`)}
        ${row('Values as of', fmtDate(p.value_as_of))}
        ${row('Case files', p.documents_url
          ? `<a class="ext-link" href="${esc(p.documents_url)}" target="_blank" rel="noopener noreferrer">
               Open the folder <span aria-hidden="true">&#8599;</span></a>`
          : dash)}
      </dl>
      ${p.notes ? `<div style="margin-top:16px"><label>Notes</label><div class="secondary">${esc(p.notes)}</div></div>` : ''}
      </div>
    </div>
  </div>`;
}

function openOwnerDialog(p, existing) {
  const owners = p.owners || [];
  const taken = owners.reduce((sum, o) => sum + Number(o.pct), 0)
    - (existing ? Number(existing.pct) : 0);
  const available = Math.max(0, 100 - taken);

  const body = `
    ${existing ? `<div class="field"><label>Investor</label>
      <div class="strong">${esc(existing.name)}</div></div>`
      : `<div class="field"><label>Investor *</label>
      <select name="investor_id" required>
        <option value="">Choose an investor…</option>
        ${state.investors
          .filter((i) => !owners.some((o) => o.investor_id === i.id))
          .map((i) => `<option value="${i.id}">${esc(i.name)}${i.investor_type ? ` — ${esc(i.investor_type)}` : ''}</option>`).join('')}
      </select></div>`}
    <div class="field-row">
      ${inputField(`Percentage * <span class="muted">(${available.toFixed(4)}% available)</span>`,
        'pct', existing ? existing.pct : '', 'number', `step=0.0001 min=0.0001 max=${available} required`)}
      ${inputField('Acquired on', 'acquired_on', existing?.acquired_on || '', 'date')}
    </div>
    ${inputField('Notes', 'notes', existing?.notes || '')}`;

  openDialog(existing ? 'Edit allocation' : 'Allocate to an investor', body, async (v) => {
    if (existing) await api(`/policy-investors/${existing.id}`, { method: 'PUT', body: v });
    else await api(`/policies/${p.id}/investors`, { method: 'POST', body: v });
    toast(existing ? 'Allocation updated' : 'Investor allocated');
  }, existing ? 'Save' : 'Allocate');
}

function openAddLifeDialog(p) {
  const body = `
    <div class="field-row">
      ${inputField('Last name *', 'insured_last_name', '', 'text', 'required')}
      ${inputField('First name', 'insured_first_name')}
      ${inputField('Date of birth', 'dob', '', 'date')}
    </div>
    <div class="field-row">
      ${selectField('Role', 'role', 'Joint', ['Joint', 'Survivorship', 'Secondary', 'Other'])}
      ${selectField('Gender', 'gender', '', ['', 'M', 'F'])}
      ${inputField('Life expectancy (months)', 'le_months', '', 'number')}
    </div>
    <div class="field">
      <span class="muted" style="font-size:12px">
        Matched against existing insureds on last name + first name + date of birth.
        If no one matches, a new insured record is created.
      </span>
    </div>`;

  openDialog('Add insured to this policy', body, async (v) => {
    await api(`/policies/${p.id}/insureds`, { method: 'POST', body: v });
    toast('Insured added to policy');
  }, 'Add insured');
}

function valuesTab(p, values) {
  return `
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h2>Account value &amp; cash surrender value</h2></div>
      <div class="card-body"><div id="chartAvCsv"></div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Monthly cost of insurance</h2></div>
      <div class="card-body"><div id="chartCoi"></div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Death benefit</h2></div>
    <div class="card-body"><div id="chartDb"></div></div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Recorded snapshots</h2><div class="spacer"></div>
      ${canEditData() ? '<button class="btn-sm primary" id="addValueBtn">Add snapshot</button>' : ''}</div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>As of</th><th class="num">Account value</th><th class="num">Cash surrender</th>
          <th class="num">Cost of insurance</th><th class="num">Death benefit</th>
          <th class="num">Loan</th><th>Last withdrawal</th><th>Source</th><th></th>
        </tr></thead>
        <tbody>
          ${values.length === 0
            ? '<tr><td colspan="9"><div class="empty">No snapshots yet. Add one or import a CSV.</div></td></tr>'
            : [...values].reverse().map((v) => `<tr>
                <td class="strong">${fmtDate(v.as_of_date)}</td>
                <td class="num">${money(scaled(v.account_value, p), 2)}</td>
                <td class="num">${money(scaled(v.cash_surrender_value, p), 2)}</td>
                <td class="num">${money(scaled(v.cost_of_insurance, p), 2)}</td>
                <td class="num">${money(scaled(v.death_benefit, p))}</td>
                <td class="num">${money(scaled(v.loan_balance, p), 2)}</td>
                <td>${fmtDate(v.date_of_last_withdrawal)}</td>
                <td class="muted">${esc(v.source)}</td>
                <td style="white-space:nowrap">${canEditData() ? `
                  <button class="btn-sm" data-edit-value="${v.id}">Edit</button>
                  <button class="btn-sm btn-danger" data-del-value="${v.id}">Delete</button>` : ''}</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function transactionsTab(p) {
  /* The ledger is the policy's, but an investor paid a percentage of every
     line in it. Showing the gross figure to somebody who put up an eighth of
     it is the same mistake as showing them the whole death benefit. */
  const f = shareFactor(p);
  const byType = {};
  for (const t of p.transactions) byType[t.txn_type] = (byType[t.txn_type] || 0) + Number(t.amount) * f;
  const total = p.transactions.reduce((s, t) => s + Number(t.amount) * f, 0);

  return `
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h2>Totals by type</h2>${isInvestorUser() && p.my_pct != null
        ? `<div class="spacer"></div><span class="muted" style="font-size:12px">your ${
            fmtPct(p.my_pct)} share</span>` : ''}</div>
      <div class="card-body">
        ${Object.keys(byType).length === 0 ? '<div class="empty">No transactions yet</div>' : `
        <table class="data">
          <tbody>${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
            `<tr><td>${esc(k)}</td><td class="num strong">${fmtExact(v)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td>Total invested</td><td class="num">${fmtExact(total)}</td></tr></tfoot>
        </table>`}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Cost basis vs death benefit</h2></div>
      <div class="card-body"><div id="chartBasis"></div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Ledger</h2><div class="spacer"></div>
      ${isInvestorUser() && p.my_pct != null
        ? `<span class="muted" style="font-size:12px">every amount is your ${fmtPct(p.my_pct)} share</span>` : ''}
      ${canEditData() ? '<button class="btn-sm primary" id="addTxnBtn">Add transaction</button>' : ''}</div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th><th>Remarks</th><th>Source</th><th></th></tr></thead>
        <tbody>
          ${p.transactions.length === 0
            ? '<tr><td colspan="6"><div class="empty">No transactions recorded.</div></td></tr>'
            : p.transactions.map((t) => `<tr>
                <td class="strong">${fmtDate(t.txn_date)}</td>
                <td>${esc(t.txn_type)}</td>
                <td class="num">${money(Number(t.amount) * f, 2)}</td>
                <td class="secondary">${esc(t.remarks)}</td>
                <td class="muted">${esc(t.source)}</td>
                <td class="row-actions">${canEditData() ? `
                  <button class="btn-sm" data-edit-txn="${t.id}">Edit</button>
                  <button class="btn-sm btn-danger" data-del-txn="${t.id}">Delete</button>` : ''}</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/**
 * The soonest premium actually coming on a policy.
 *
 * Read from the servicing schedule and nowhere else. The carrier date and
 * annual figure on the policy form describe the policy as it was written;
 * what has to be paid, and when, is what somebody entered on the servicing
 * tab. Two sources meant the page could show a date the calendar did not
 * have and a figure the capital call did not use.
 */
function nextPremium(p) {
  const todayIso = today();
  const options = (p.reminders || [])
    .filter((r) => r.kind === 'Premium' && !r.done_at
      && String(r.due_date).slice(0, 10) >= todayIso)
    .map((r) => ({ date: String(r.due_date).slice(0, 10), scheduled: true,
                   amount: Number(r.amount) || 0, note: r.note || '' }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return options[0] || null;
}

function servicingTab(p, monthsCovered, streams) {
  /* An investor gets the dates and what their share of each will cost, and
     nothing else. Lapse risk, stale carrier data and the follow-up work are
     the manager's job; an investor reading "account value covers 2.4 months"
     on a policy they hold 8% of has been handed an alarm they cannot act on. */
  if (isInvestorUser()) {
    const f = shareFactor(p);
    // Every premium date on this policy's servicing schedule. That schedule
    // is the whole list — nothing here is inferred from the policy record.
    const planned = (p.reminders || [])
      .filter((r) => r.kind === 'Premium' && !r.done_at)
      .map((r) => ({ date: String(r.due_date).slice(0, 10), amount: Number(r.amount) * f,
                     full: Number(r.amount), note: r.note, scheduled: true }));
    const all = [...planned].sort((a, b) => (a.date < b.date ? -1 : 1));

    return `
    <div class="card">
      <div class="card-head"><h2>Premiums coming up</h2><div class="spacer"></div>
        ${p.my_pct != null ? `<span class="muted" style="font-size:12px">your ${
          fmtPct(p.my_pct)} share</span>` : ''}</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Due</th><th class="num">Your share</th>
          <th class="num">Full policy</th><th></th></tr></thead>
        <tbody>${all.length === 0
          ? '<tr><td colspan="4"><div class="empty">No premium dates are scheduled on this policy at the moment.</div></td></tr>'
          : all.map((r) => `<tr>
              <td class="strong">${fmtDate(r.date)}</td>
              <td class="num strong">${money(r.amount)}</td>
              <td class="num muted">${money(r.full)}</td>
              <td class="secondary">${r.scheduled
                ? `<span class="muted">scheduled${r.note ? ` · ${esc(r.note)}` : ''}</span>`
                : `<span class="muted">${esc(p.premium_mode || 'next due')}</span>`}</td>
            </tr>`).join('')}</tbody>
      </table></div>
      <div class="card-body" style="border-top:1px solid var(--grid)">
        <span class="muted" style="font-size:12.5px;line-height:1.6">
          These are the premium dates entered on this policy's servicing schedule; amounts
          are estimates until the payment is made. Your column is ${p.my_pct != null
            ? fmtPct(p.my_pct) : 'your percentage'} of the full policy premium beside it.</span>
      </div>
    </div>`;
  }

  const steps = p.reminders || [];
  const open = steps.filter((r) => !r.done_at);
  const done = steps.filter((r) => r.done_at);
  /* Counted from the servicing schedule, which is where a premium that has
     to be paid is recorded. An overdue one is an entry nobody has marked
     done, not a date left behind on the policy form. */
  const overdue = open
    .filter((r) => r.kind === 'Premium' && String(r.due_date).slice(0, 10) < today())
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  const soonest = nextPremium(p);
  const days = (iso) =>
    Math.round((new Date(`${iso}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000);
  const notes = [];
  if (overdue)
    notes.push(['critical',
      `Premium was due ${Math.abs(days(String(overdue.due_date).slice(0, 10)))} days ago`]);
  else if (soonest)
    notes.push([days(soonest.date) <= 14 ? 'warning' : 'info',
      `Premium due in ${days(soonest.date)} days`]);
  if (monthsCovered !== null && monthsCovered < 3)
    notes.push(['critical', `Account value covers only ${monthsCovered.toFixed(1)} months of cost of insurance`]);
  else if (monthsCovered !== null && monthsCovered < 6)
    notes.push(['serious', `Account value covers ${monthsCovered.toFixed(1)} months of cost of insurance`]);

  return `
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h2>Premium schedule</h2></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Next due</dt><dd>${soonest
            ? `${fmtDate(soonest.date)}${soonest.amount
                ? ` <span class="muted">· ${money(scaled(soonest.amount, p))}</span>` : ''}`
            : '<span class="muted">nothing scheduled</span>'}</dd>
          ${''/* Reference, not an obligation: what the policy was written to
                 take. Nothing on the servicing calendar is derived from it. */}
          <dt>Premium on the policy</dt><dd>${money(scaled(p.premium_required, p))}
            <span class="muted">${esc(p.premium_mode || '')} · reference</span></dd>
          <dt>Grace period</dt><dd>${p.grace_period_days || 61} days</dd>
          <dt>Last withdrawal</dt><dd>${fmtDate(p.date_of_last_withdrawal)}</dd>
          <dt>Values as of</dt><dd>${fmtDate(p.value_as_of)}</dd>
        </dl>
        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          ${canEditData() ? `<button class="btn-sm primary" id="logPremiumBtn">Log premium payment</button>
          <button class="btn-sm" id="scheduleStepBtn">Schedule next step</button>` : ''}
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Follow-up schedule</h2><div class="spacer"></div>
        ${open.length ? `<span class="muted" style="font-size:12px">${open.length} outstanding</span>` : ''}</div>
      <div class="card-body flush">
        ${notes.map(([sev, text]) => `
          <div class="alert-row">
            <span class="sev ${sev}"><span class="ic">${SEV_ICON[sev]}</span></span>
            <div><div class="who">${esc(text)}</div></div>
          </div>`).join('')}

        ${open.map((r) => stepRow(r)).join('')}

        ${notes.length === 0 && open.length === 0
          ? `<div class="empty">Nothing outstanding.${canEditData()
              ? ' Use <strong>Schedule next step</strong> to put a premium or a follow-up on the calendar.' : ''}</div>`
          : ''}
      </div>
      ${done.length ? `<div class="card-body" style="border-top:1px solid var(--grid)">
        <details><summary class="muted" style="font-size:12px;cursor:pointer">${
          done.length} completed</summary>
        <div style="margin-top:10px">${done.map((r) => stepRow(r)).join('')}</div>
        </details></div>` : ''}
    </div>
  </div>

  ${streams === null ? '' : premiumOptimizationCard(p, streams)}`;
}

/**
 * The premium optimizations filed against this policy, on the policy.
 *
 * The same material as the Servicing → Premium optimization screen, in
 * the place somebody actually reaches for it: they are deciding what to
 * schedule on THIS policy, and the servicing firm's stream is the thing
 * they are deciding against. The whole card takes a dropped workbook.
 */
function premiumOptimizationCard(p, streams) {
  const label = p.policy_number || 'this policy';
  return `
  <div class="card" id="policyStreams" data-drop-policy="${p.id}"
       data-drop-label="${esc(label)}" style="margin-top:16px">
    <div class="card-head"><h2>Premium optimization</h2>
      <span class="muted" style="font-size:12px;margin-left:10px">reference · not a bill</span>
      <div class="spacer"></div>
      <button class="btn-sm primary" id="policyStreamUpload">Upload one</button>
    </div>
    ${!streams.length ? `
    <div class="card-body">
      <div class="dropzone" id="policyStreamDrop" style="padding:26px 18px">
        <div style="font-weight:600;margin-bottom:4px">Drop a premium optimization here,
          or click to choose</div>
        <div class="muted" style="font-size:12.5px">The workbook a servicing firm sends back —
          the smallest premiums that keep this policy in force. It is read and shown back
          before anything is saved, and it changes nothing about what is due.</div>
        <input type="file" id="policyStreamFile" accept=".xlsx,.xls,.csv" style="display:none">
      </div>
    </div>` : `
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Uploaded</th><th>Stream</th><th>Covers</th>
        <th class="num">Payments</th><th class="num">Next 12 months</th>
        <th>From the file</th><th></th></tr></thead>
      <tbody>${streams.map((s, i) => `<tr>
        <td class="${i === 0 ? 'strong' : 'muted'}">${fmtDate(s.uploaded_at)}${
          i === 0 && streams.length > 1 ? ' <span class="badge">latest</span>' : ''}</td>
        <td class="strong">${esc(s.premium_type || 'not stated')}</td>
        <td class="secondary">${fmtDate(s.first_due)} — ${fmtDate(s.last_due)}</td>
        <td class="num">${s.payments}</td>
        <td class="num strong">${fmtExact(s.next_12mo)}</td>
        <td class="secondary">${esc(s.file_name || '')}${s.uploaded_by
          ? ` <span class="muted">· ${esc(s.uploaded_by)}</span>` : ''}</td>
        <td style="white-space:nowrap">
          <button class="btn-sm" data-stream="${s.id}">Open</button>
          <button class="btn-sm danger" data-drop-stream="${s.id}">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${streams[0].comments ? `<div class="card-body" style="border-top:1px solid var(--grid)">
      <span class="muted" style="font-size:12.5px;line-height:1.6">
        <strong>From the servicing firm:</strong> ${esc(streams[0].comments)}</span></div>` : ''}`}
  </div>`;
}

/** Wiring shared by the policy card and the Servicing screen's list. */
function wireStreamRows(root = document) {
  const guard = (el, fn) => el.addEventListener('click', async (e) => {
    try { await fn(e); } catch (err) { alert(err?.message || 'That did not work.'); }
  });
  root.querySelectorAll('[data-stream]').forEach((b) =>
    guard(b, () => openStreamDialog(Number(b.dataset.stream))));
  root.querySelectorAll('[data-drop-stream]').forEach((b) =>
    guard(b, async () => {
      if (!confirm('Remove this premium optimization? The file is not kept — you would '
        + 'have to upload it again.')) return;
      await api(`/premium-streams/${b.dataset.dropStream}`, { method: 'DELETE' });
      toast('Removed');
      render();
    }));
  root.querySelectorAll('[data-drop-policy]').forEach((card) =>
    dropOpensUpload(card, { policyId: Number(card.dataset.dropPolicy),
      policyLabel: card.dataset.dropLabel }));
}

/**
 * One line of the follow-up schedule.
 *
 * A premium and a piece of work read differently on purpose: the premium
 * carries a figure because somebody has to find the money, the follow-up
 * carries only words because there is nothing to find. Both say how far
 * away they are, since "March" means nothing without today beside it.
 */
function stepRow(r) {
  const d = daysUntil(r.due_date);
  const isDone = !!r.done_at;
  const sev = isDone ? 'info' : d < 0 ? 'critical' : d <= 14 ? 'warning' : 'info';
  const when = isDone ? `done ${fmtDate(String(r.done_at).slice(0, 10))}`
    : d < 0 ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`
      : d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`;
  return `
    <div class="alert-row step-row ${isDone ? 'step-done' : ''}" data-step="${r.id}">
      <span class="sev ${sev}"><span class="ic">${SEV_ICON[sev]}</span></span>
      <div style="flex:1;min-width:0">
        <div class="who">${r.kind === 'Premium'
          ? `Premium${r.amount ? ` · about ${fmtExact(r.amount)}` : ''}` : 'Follow-up'}</div>
        <div class="meta">${fmtDate(r.due_date)} · ${esc(when)}${
          r.note ? ` · ${esc(r.note)}` : ''}${
          isDone && r.done_by_name ? ` · ${esc(r.done_by_name)}` : ''}</div>
      </div>
      ${canEditData() ? `<div style="white-space:nowrap;display:flex;gap:6px">
        <button class="btn-sm" data-step-done="${r.id}" data-to="${isDone ? 'false' : 'true'}"
          >${isDone ? 'Reopen' : 'Done'}</button>
        ${isDone ? '' : `<button class="btn-sm" data-step-edit="${r.id}">Edit</button>`}
        <button class="btn-sm btn-danger" data-step-del="${r.id}">Remove</button>
      </div>` : ''}
    </div>`;
}

/* ------------------------------ return ------------------------------- */

/**
 * Internal rate of return on this policy, and a calculator for the one
 * number that matters at the end: what the cheque actually was and when it
 * cleared. Both figures are solved from dated cash flows — the day each
 * premium left and the day the money came back — so they answer the same
 * question the office's own calculation workbook asks, and can be checked
 * against one line for line.
 */
function returnTab(p, d) {
  if (!d) return '<div class="empty"><span class="spin"></span></div>';
  const r = d.result;
  const settled = d.settled;
  const dash = '<span class="muted">—</span>';

  const caveats = [];
  if (r.short_period) caveats.push(
    'This position is under three months old. The rate is still shown, but annualising ' +
    'a few weeks stretches them over a whole year and produces an extreme number — the ' +
    'profit and the multiple beside it are the figures to quote.');
  if (r.extreme && !r.short_period) caveats.push(
    `The rate is very large because it is annualised: ${r.multiple ? `${r.multiple.toFixed(2)}×` : 'this return'} `
    + `over ${r.days.toLocaleString('en-US')} days works out at that pace if it were repeated `
    + 'for a whole year, which is a long way from here. Nothing is wrong with the arithmetic — '
    + 'but over a period this short the multiple and the profit are the figures to quote.');
  if (r.ambiguous) caveats.push(
    'Cash flows change direction more than once (a withdrawal between premiums, ' +
    'for example), so more than one rate can satisfy the equation. The one shown ' +
    'is the first root above −100%.');
  if (!settled && r.rate !== null) caveats.push(
    d.status === 'Matured'
      ? 'The claim has not been recorded as paid, so this assumes the death benefit ' +
        'is collected today. Enter the cheque below for the exact figure.'
      : 'This is a hypothetical: it assumes the insured died today and the carrier ' +
        'paid the current death benefit immediately, with no further premiums.');

  const flowRows = r.flows.map((f) => `
    <tr>
      <td class="strong">${fmtDate(f.date)}</td>
      <td>${esc(f.label || '')}${f.actual === false
        ? ' <span class="badge grace"><span class="dot"></span>Assumed</span>' : ''}</td>
      <td class="num" style="color:${f.amount < 0 ? 'var(--critical)' : 'var(--success-text)'}">
        ${fmtExact(f.amount)}</td>
    </tr>`).join('');

  return `
    <div class="kpi-row">
      <div class="stat">
        <div class="label">${settled ? 'Realized return' : d.status === 'Matured' ? 'Return if collected today' : 'Return if matured today'}${
          showsBothRates() ? ' · simple' : ''}</div>
        <div class="value hero">${fmtRate(r.rate)}</div>
        <div class="note">${r.days.toLocaleString('en-US')} days · ${r.years.toFixed(2)} years held${
          r.multiple ? `<br>${r.multiple.toFixed(2)}× over the period, not annualised` : ''}</div>
      </div>
      ${''/* The same cash flows, compounded. Its own tile rather than a
             footnote: it is a different number and the difference matters,
             so it gets a label of its own and cannot be misread as the one
             beside it. */}
      ${showsBothRates() && r.compound_rate != null ? `
      <div class="stat">
        <div class="label">Compounded (IRR)</div>
        <div class="value hero">${fmtRate(r.compound_rate)}</div>
        <div class="note">the same dated cash flows, solved as an internal rate of
          return rather than as simple interest on dollar-years</div>
      </div>` : ''}
      <div class="stat">
        <div class="label">Capital invested</div>
        <div class="value">${fmtExact(r.invested)}</div>
        <div class="note">first outlay ${r.first_flow ? fmtDate(r.first_flow) : '—'}</div>
      </div>
      <div class="stat">
        <div class="label">${settled ? 'Proceeds received' : 'Proceeds assumed'}</div>
        <div class="value">${fmtExact(r.returned)}</div>
        <div class="note">${settled
          ? `funded ${d.proceeds_received_on ? fmtDate(d.proceeds_received_on) : '—'}`
          : `death benefit as of ${fmtDate(d.as_of)}`}</div>
      </div>
      <div class="stat">
        <div class="label">Profit</div>
        <div class="value" style="color:${r.profit >= 0 ? 'var(--success-text)' : 'var(--critical)'}">${fmtExact(r.profit)}</div>
        <div class="note">${r.multiple ? `${r.multiple.toFixed(2)}× capital` : '—'}</div>
      </div>
    </div>

    ${caveats.length ? `<div class="card"><div class="card-body">
      ${caveats.map((c) => `<div class="muted" style="font-size:12.5px;margin-bottom:6px">${c}</div>`).join('')}
    </div></div>` : ''}

    ${canEditData() ? `
    <div class="card">
      <div class="card-head"><h2>Settle the claim</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">figures update as you type</span></div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>Final date of death</label>
            <input type="date" id="calcDod" value="${esc(dateInput(d.matured_on) || '')}">
            <span class="muted" style="font-size:12px">Saved to the insured record, which is what
              moves the policy to Maturities.</span></div>
          <div class="field"><label>Death benefit cheque</label>
            <input type="number" step="0.01" min="0" id="calcAmount"
              value="${d.proceeds_amount ?? ''}" placeholder="${Number(d.death_benefit).toFixed(2)}">
            <span class="muted" style="font-size:12px">Exact amount received, after any loan
              or interest adjustment.</span></div>
          <div class="field"><label>Date funded</label>
            <input type="date" id="calcPaid" value="${esc(dateInput(d.proceeds_received_on) || '')}">
            <span class="muted" style="font-size:12px">The return is measured to this date —
              collection lag is a real cost.</span></div>
        </div>

        <div class="kpi-row" style="margin-top:4px">
          <div class="stat">
            <div class="label">Exact return</div>
            <div class="value hero" id="calcIrr">${dash}</div>
            <div class="note" id="calcNote">Enter a cheque amount and date</div>
          </div>
          <div class="stat">
            <div class="label">Profit</div>
            <div class="value" id="calcProfit">${dash}</div>
            <div class="note" id="calcMultiple">—</div>
          </div>
          <div class="stat">
            <div class="label">Against the assumption</div>
            <div class="value" id="calcDelta">${dash}</div>
            <div class="note">vs ${fmtRate(r.rate)} shown above</div>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="primary" id="calcSave">Save the settlement</button>
          <button id="calcReset">Reset</button>
        </div>
        <div id="calcMsg" style="margin-top:10px"></div>
      </div>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h2>Cash flows</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">every figure dated to the day it moved</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Item</th><th class="num">Amount</th></tr></thead>
        <tbody id="flowRows">${flowRows || '<tr><td colspan="3"><div class="empty">No ledger entries yet. Add the acquisition cost and premiums on the Transactions tab.</div></td></tr>'}</tbody>
        <tfoot><tr><td colspan="2">Net</td>
          <td class="num">${fmtExact(r.profit)}</td></tr></tfoot>
      </table></div>
    </div>

    <div class="card"><div class="card-body">
      <span class="muted" style="font-size:12px">
        The return is simple interest, not compounded: every dollar earns the rate for
        exactly as long as it is outstanding and the interest itself earns nothing, which
        is the convention the operating agreements are written in. Policy loans
        are excluded: a loan is repaid out of the death benefit, so counting it as
        income would double it against the proceeds.</span>
    </div></div>`;
}

function wireReturnTab(p, d) {
  if (!d || !canEditData()) return;
  const amountEl = $('#calcAmount'), paidEl = $('#calcPaid'), dodEl = $('#calcDod');
  if (!amountEl) return;

  const recalc = () => {
    const amount = Number(amountEl.value);
    const paid = paidEl.value || dodEl.value || irrToday();
    if (!amount || amount <= 0) {
      $('#calcIrr').textContent = '—';
      $('#calcProfit').textContent = '—';
      $('#calcMultiple').textContent = '—';
      $('#calcDelta').textContent = '—';
      $('#calcNote').textContent = 'Enter a cheque amount and date';
      return;
    }
    // Same solver the server uses — one implementation, so the number on
    // screen while typing is the number that gets saved.
    const a = analyzeFlows([...d.ledger, { date: paid, amount, label: 'Death benefit received' }]);
    $('#calcIrr').textContent = fmtRate(a.rate);
    $('#calcProfit').textContent = fmtExact(a.profit);
    $('#calcProfit').style.color = a.profit >= 0 ? 'var(--success-text)' : 'var(--critical)';
    $('#calcMultiple').textContent = a.multiple ? `${a.multiple.toFixed(2)}× capital` : '—';
    $('#calcNote').textContent = `${a.days} days · ${a.years.toFixed(2)} years held`;
    const base = d.result.rate;
    const delta = base === null || a.rate === null ? null : a.rate - base;
    $('#calcDelta').textContent = delta === null ? '—'
      : `${delta >= 0 ? '+' : '−'}${fmtRate(Math.abs(delta))}`;
    $('#calcDelta').style.color = delta === null ? '' : delta >= 0 ? 'var(--success-text)' : 'var(--critical)';
  };

  [amountEl, paidEl, dodEl].forEach((el) => el.addEventListener('input', recalc));
  recalc();

  $('#calcReset').addEventListener('click', () => {
    amountEl.value = d.proceeds_amount ?? '';
    paidEl.value = dateInput(d.proceeds_received_on) || '';
    dodEl.value = dateInput(d.matured_on) || '';
    recalc();
  });

  $('#calcSave').addEventListener('click', async (e) => {
    const msg = $('#calcMsg');
    /* Compared against what the box was filled with, not against whether it
       has anything in it now. Emptying the field is the whole way back out
       of Maturities — a date typed into the wrong policy has to be
       removable, and testing the new value for truthiness silently ignored
       exactly that edit. */
    const was = dateInput(d.matured_on) || '';
    const now = dodEl.value || '';
    const clearing = was && !now;

    if (clearing && !confirm(
      'Clear the date of death?\n\n'
      + 'This policy returns to the active book, and any proceeds recorded '
      + 'against the claim are discarded. If this person is insured on other '
      + 'policies, those come back too.')) return;

    e.target.disabled = true;
    try {
      // The date of death has to land first: it is what matures the policy,
      // and proceeds are refused on one that has not.
      if (now !== was) {
        if (!p.insured_id) throw new Error('This policy has no insured on file to record a death against.');
        await api(`/insureds/${p.insured_id}`, { method: 'PUT', body: { date_of_death: now || null } });
      }
      /* Nothing to settle on a policy that is no longer matured, and the
         proceeds route rightly refuses one — so it is not called rather
         than called and apologised for. The database has already discarded
         the old figures. */
      if (!clearing && (amountEl.value !== '' || paidEl.value)) {
        await api(`/policies/${p.id}/proceeds`, { method: 'PUT', body: {
          proceeds_amount: amountEl.value === '' ? null : amountEl.value,
          proceeds_received_on: paidEl.value || null,
        } });
      }
      if (clearing) {
        toast('Date of death cleared');
        location.hash = `#/policy/${p.id}`;
        render();
        return;
      }
      msg.innerHTML = '<div class="ok-box">Settlement saved.</div>';
      toast('Settlement saved');
      render();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
}

function wireDetailTab(p, values, irrData) {
  if (detailTab === 'overview') {
    $('#addOwnerBtn')?.addEventListener('click', async () => {
      if (!state.investors.length) state.investors = await api('/investors');
      if (!state.investors.length) {
        alert('Add an investor first, under Investors.');
        return;
      }
      openOwnerDialog(p, null);
    });
    document.querySelectorAll('[data-edit-owner]').forEach((b) =>
      b.addEventListener('click', () => openOwnerDialog(p, {
        id: Number(b.dataset.editOwner), pct: b.dataset.pct,
        name: b.dataset.name, acquired_on: b.dataset.acq,
      })));
    document.querySelectorAll('[data-del-owner]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`Remove ${b.dataset.name} from this policy?`)) return;
        await api(`/policy-investors/${b.dataset.delOwner}`, { method: 'DELETE' });
        toast('Allocation removed');
        render();
      }));
    $('#addLifeBtn')?.addEventListener('click', () => openAddLifeDialog(p));
    document.querySelectorAll('[data-edit-life]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ins = await api(`/insureds/${b.dataset.editLife}`);
        openInsuredDialog(ins);
      }));
    document.querySelectorAll('[data-remove-life]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Remove this person from the policy? The insured record itself is kept.')) return;
        await api(`/policy-insureds/${b.dataset.removeLife}`, { method: 'DELETE' });
        toast('Removed from policy');
        render();
      }));
  }

  if (detailTab === 'values') {
    const points = values.map((v) => ({
      x: v.as_of_date,
      tooltipTitle: fmtDate(v.as_of_date).replace(/<[^>]+>/g, ''),
      values: {
        av: v.account_value, csv: v.cash_surrender_value,
        coi: v.cost_of_insurance, db: v.death_benefit,
      },
    }));
    lineChart($('#chartAvCsv'), {
      points, series: [{ key: 'av', name: 'Account value' }, { key: 'csv', name: 'Cash surrender value' }],
      valueFmt: (v) => fmtMoney(v, 2),
    });
    lineChart($('#chartCoi'), {
      points, series: [{ key: 'coi', name: 'Cost of insurance' }],
      valueFmt: (v) => fmtMoney(v, 2),
    });
    lineChart($('#chartDb'), { points, series: [{ key: 'db', name: 'Death benefit' }], height: 180 });

    $('#addValueBtn')?.addEventListener('click', () => openValueDialog(p));
    document.querySelectorAll('[data-edit-value]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = (p.values || []).find((x) => String(x.id) === b.dataset.editValue);
        if (v) openValueDialog(p, v);
      }));
    document.querySelectorAll('[data-del-value]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Delete this snapshot?')) return;
        await api(`/values/${b.dataset.delValue}`, { method: 'DELETE' });
        toast('Snapshot deleted');
        render();
      }));
  }

  if (detailTab === 'transactions') {
    const db = Number(p.death_benefit ?? p.face_amount) || 0;
    barChart($('#chartBasis'), {
      rows: [
        { label: 'Death benefit', value: db, seriesName: 'Amount' },
        { label: 'Invested to date', value: Number(p.total_invested) || 0, seriesName: 'Amount' },
        { label: 'Cash surrender value', value: Number(p.cash_surrender_value) || 0, seriesName: 'Amount' },
      ],
      height: 110,
    });
    $('#addTxnBtn')?.addEventListener('click', () => openTxnDialog(p));
    document.querySelectorAll('[data-edit-txn]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = (p.transactions || []).find((x) => String(x.id) === b.dataset.editTxn);
        if (t) openTxnDialog(p, {}, t);
      }));
    document.querySelectorAll('[data-del-txn]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Delete this transaction?')) return;
        await api(`/transactions/${b.dataset.delTxn}`, { method: 'DELETE' });
        toast('Transaction deleted');
        render();
      }));
  }

  if (detailTab === 'return') wireReturnTab(p, irrData);

  if (detailTab === 'servicing') {
    $('#logPremiumBtn')?.addEventListener('click', () =>
      /* Prefilled from what was scheduled, not from the policy form — the
         figure somebody is about to confirm should be the one they were
         asked to find. */
      openTxnDialog(p, { txn_type: 'Premium Payment', amount: nextPremium(p)?.amount || '' }));
    $('#scheduleStepBtn')?.addEventListener('click', () => openStepDialog(p));

    document.querySelectorAll('[data-step-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        const r = (p.reminders || []).find((x) => String(x.id) === b.dataset.stepEdit);
        if (r) openStepDialog(p, r);
      }));

    document.querySelectorAll('[data-step-done]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/policy-reminders/${b.dataset.stepDone}`,
          { method: 'PUT', body: { done: b.dataset.to === 'true' } });
        toast(b.dataset.to === 'true' ? 'Marked done' : 'Reopened');
        render();
      }));

    document.querySelectorAll('[data-step-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/policy-reminders/${b.dataset.stepDel}`, { method: 'DELETE' });
        toast('Removed from the schedule');
        render();
      }));

    /* The premium optimizations filed against this policy. The card takes a
       dropped workbook anywhere on it, and the upload is bound to THIS
       policy rather than to whatever number the file happens to carry. */
    const label = p.policy_number || 'this policy';
    onClick('#policyStreamUpload',
      () => openStreamUploadDialog({ policyId: p.id, policyLabel: label }));
    attachDropZone($('#policyStreamDrop'), $('#policyStreamFile'),
      (f) => openStreamUploadDialog({ policyId: p.id, policyLabel: label, file: f }));
    wireStreamRows();
  }
}

/* ------------------------------ dialogs ------------------------------ */

/**
 * A button that opens something which has to fetch first.
 *
 * A click handler returning a rejected promise fails silently: the browser
 * logs it and the person sees a button that did nothing, which is
 * indistinguishable from a broken one. Anything async behind a button goes
 * through here so a failure says so.
 */
function onClick(selector, handler, root = document) {
  const el = root.querySelector(selector);
  if (!el) return;
  el.addEventListener('click', async (e) => {
    try {
      await handler(e);
    } catch (err) {
      console.error(selector, err);
      alert(err?.message || 'That did not work. Try again, or reload the page.');
    }
  });
}

function openDialog(title, bodyHtml, onSubmit, submitLabel = 'Save') {
  /* A dialog with nothing to submit is a dialog for reading. It gets one
     button, and that button says Close rather than Cancel — there is
     nothing to cancel. */
  const readOnly = typeof onSubmit !== 'function';
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <form method="dialog" id="dlgForm">
      <div class="dialog-head">${esc(title)}</div>
      <div class="dialog-body"><div id="dlgError"></div>${bodyHtml}</div>
      <div class="dialog-foot">
        <button type="button" id="dlgCancel">${readOnly ? 'Close' : 'Cancel'}</button>
        ${readOnly ? '' : `<button type="submit" class="primary">${esc(submitLabel)}</button>`}
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  // Escape / backdrop dismissal should also drop it from the DOM.
  dlg.addEventListener('close', () => dlg.remove());
  $('#dlgCancel', dlg).addEventListener('click', () => { dlg.close(); dlg.remove(); });
  $('#dlgForm', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (readOnly) { dlg.close(); dlg.remove(); return; }
    const btn = $('button[type=submit]', dlg);
    btn.disabled = true;
    const hashBefore = location.hash;
    try {
      await onSubmit(formValues(e.target));
      dlg.close(); dlg.remove();
      // If the handler navigated (e.g. after deleting the record being viewed),
      // the hashchange listener re-renders — rendering here too would refetch
      // the row that no longer exists.
      if (location.hash === hashBefore) render();
    } catch (err) {
      $('#dlgError', dlg).innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });
  return dlg;
}

const inputField = (label, name, value = '', type = 'text', extra = '') =>
  `<div class="field"><label>${label}</label>
   <input name="${name}" type="${type}" value="${esc(value ?? '')}" ${extra}></div>`;

/* The fifty states, DC and the territories a policy can actually be issued
   in. A typed state is a typo waiting to happen — and it is the field every
   carrier and provider matches on. */
const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
  ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
  ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['PR', 'Puerto Rico'], ['VI', 'U.S. Virgin Islands'], ['GU', 'Guam'],
];

/**
 * A state picker that never loses what is already on the record. Older data
 * may hold a full state name or something a person typed by hand; that value
 * is kept as its own option rather than silently replaced with a blank the
 * first time somebody opens the form to change something else.
 */
const stateField = (label, name, value) => {
  const v = String(value ?? '').trim();
  const known = US_STATES.some(([code]) => code === v);
  return `<div class="field"><label>${label}</label><select name="${name}">
    <option value=""${v ? '' : ' selected'}>—</option>
    ${v && !known ? `<option value="${esc(v)}" selected>${esc(v)}</option>` : ''}
    ${US_STATES.map(([code, full]) =>
      `<option value="${code}"${code === v ? ' selected' : ''}>${code} — ${full}</option>`).join('')}
   </select></div>`;
};

/**
 * A money field that puts the commas in as you type.
 *
 * It is a text input rather than a number one, because a number input will
 * not hold a comma — the browser simply discards the value. The grouping is
 * cosmetic: the commas are stripped again on submit, and the server strips
 * them a second time, so nothing downstream ever sees them.
 */
const moneyField = (label, name, value = '', extra = '') =>
  `<div class="field"><label>${label}</label>
   <input name="${name}" type="text" inputmode="decimal" data-money
          value="${esc(groupDigits(value == null ? '' : String(value)))}"
          autocomplete="off" ${extra}></div>`;

/** "1250000.5" -> "1,250,000.5". Anything that is not a digit, a dot or a
    leading minus is dropped; a second dot is dropped too. */
function groupDigits(raw) {
  const text = String(raw ?? '');
  const negative = /^\s*-/.test(text);
  let body = text.replace(/[^\d.]/g, '');
  const dot = body.indexOf('.');
  if (dot !== -1) body = `${body.slice(0, dot + 1)}${body.slice(dot + 1).replace(/\./g, '')}`;
  let [whole = '', decimals] = body.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (!grouped && decimals === undefined) return negative && text.trim() === '-' ? '-' : '';
  return `${negative ? '-' : ''}${grouped}${decimals === undefined ? '' : `.${decimals}`}`;
}

/* Re-group after every keystroke, then put the caret back where the typist
   left it — counted in digits rather than characters, since inserting a
   comma to their left would otherwise shunt it one place. */
function regroupWhileTyping(el) {
  const caret = el.selectionStart ?? el.value.length;
  const significantBefore = (el.value.slice(0, caret).match(/[\d.]/g) || []).length;
  el.value = groupDigits(el.value);
  let seen = 0;
  let position = significantBefore === 0 ? 0 : el.value.length;
  for (let i = 0; i < el.value.length; i++) {
    if (/[\d.]/.test(el.value[i])) seen++;
    if (seen === significantBefore) { position = i + 1; break; }
  }
  try { el.setSelectionRange(position, position); } catch { /* not a text input */ }
}

document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.hasAttribute('data-money'))
    regroupWhileTyping(e.target);
});

const selectField = (label, name, value, options) =>
  `<div class="field"><label>${label}</label><select name="${name}">
    ${options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
   </select></div>`;

async function openPolicyDialog(p = null) {
  if (!state.funds.length) state.funds = await api('/funds');
  const body = `
    <div class="field-row">
      ${inputField('Policy number *', 'policy_number', p?.policy_number, 'text', 'required')}
      ${inputField('Carrier *', 'carrier_name', p?.carrier_name, 'text', 'required')}
    </div>
    <div class="field-row">
      ${inputField('Insured last name', 'insured_last_name', p?.insured_last)}
      ${inputField('Insured first name', 'insured_first_name', p?.insured_first)}
      ${inputField('Date of birth', 'dob', dateInput(p?.insured_dob), 'date')}
      ${selectField('Sex', 'gender', p?.insured_gender || '', ['', 'M', 'F', 'Joint'])}
    </div>
    <div class="field" style="margin-top:-4px">
      <span class="muted" style="font-size:12px">
        Matches an existing insured on last name + first name + date of birth, or creates a new one.
        To correct spelling or add life-expectancy details, use <strong>Edit insured</strong> instead.
      </span>
    </div>
    <div class="field-row">
      ${selectField('Product type', 'product_type', p?.product_type || '', PRODUCT_TYPES)}
      ${moneyField('Face amount', 'face_amount', p?.face_amount)}
      ${''/* A manager may only file a policy under one of the entities an
             administrator has put in their hands. Creating an entity is not
             theirs to do — and an entity they created would not be one they
             were assigned, so the policy would vanish the moment they saved
             it. So they are offered their own entities and nothing else,
             rather than an option that fails on Save. */}
      <div class="field">
        <label>Owner entity${isManagerUser() ? ' *' : ''}</label>
        <select name="fund_code" id="fundSelect" ${isManagerUser() ? 'required' : ''}>
          ${isManagerUser()
            ? `<option value="">— Choose one —</option>`
            : '<option value="">— No owner —</option>'}
          ${state.funds.map((f) => `<option value="${esc(f.code)}" ${p?.fund_code === f.code ? 'selected' : ''}>
            ${esc(f.code)}${f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
          ${isManagerUser() ? '' : '<option value="__new__">+ Add a new entity…</option>'}
        </select>
        ${isManagerUser() && !state.funds.length ? `<span class="muted" style="font-size:12px">
          No owner entity has been assigned to you yet. An administrator has to do that
          on Settings before you can file a policy.</span>` : ''}
      </div>
    </div>
    <div class="field" id="newFundWrap" style="display:none">
      <div class="field-row">
        ${inputField('New entity code', 'new_fund_code', '', 'text', 'placeholder="e.g. LCG4"')}
        ${inputField('Full legal name', 'new_fund_name', '', 'text', 'placeholder="Optional"')}
      </div>
    </div>
    <div class="field-row">
      ${inputField('Issue date', 'issue_date', dateInput(p?.issue_date), 'date')}
      ${stateField('Issue state', 'issue_state', p?.issue_state)}
      ${inputField('Owner account', 'owner_account', p?.owner_account)}
    </div>
    <div class="field-row">
      ${moneyField('Premium required', 'premium_required', p?.premium_required)}
      ${selectField('Premium mode', 'premium_mode', p?.premium_mode || 'Annual',
        ['Monthly', 'Quarterly', 'Semi-Annual', 'Annual'])}
      ${inputField('Next premium due', 'next_premium_due', dateInput(p?.next_premium_due), 'date')}
    </div>
    <div class="field-row">
      ${inputField('Acquisition date', 'acquisition_date', dateInput(p?.acquisition_date), 'date')}
      ${moneyField('Acquisition cost', 'acquisition_cost', p?.acquisition_cost)}
      ${selectField('Status', 'status', p?.status || 'Inforce',
        ['Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'])}
    </div>
    ${inputField('Case files link', 'documents_url', p?.documents_url, 'url',
      'placeholder="Dropbox, SharePoint or any folder link"')}
    <div class="field" style="margin-top:-4px"><span class="muted" style="font-size:12px">
      Anyone who can see this policy — including the investors who own a piece of it — gets
      this link. Who may actually open the folder is decided by the folder's own sharing
      settings, not here.</span></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(p?.notes || '')}</textarea></div>`;

  const dlg = openDialog(p ? 'Edit policy' : 'New policy', body, async (v) => {
    if (v.fund_code === '__new__') {
      const code = String(v.new_fund_code || '').trim();
      if (!code) throw new Error('Give the new entity a code, or pick an existing owner');
      await api('/funds', { method: 'POST', body: { code, name: v.new_fund_name } });
      state.funds = await api('/funds');
      v.fund_code = code;
    }
    delete v.new_fund_code; delete v.new_fund_name;
    if (p) await api(`/policies/${p.id}`, { method: 'PUT', body: v });
    else await api('/policies', { method: 'POST', body: v });
    toast(p ? 'Policy updated' : 'Policy created');
  });

  const sel = $('#fundSelect', dlg);
  sel.addEventListener('change', () => {
    const isNew = sel.value === '__new__';
    $('#newFundWrap', dlg).style.display = isNew ? '' : 'none';
    if (isNew) $('input[name=new_fund_code]', dlg).focus();
  });
}

function openEntityDialog(f, onSaved) {
  const isNew = !f?.id;
  const carryNow = f?.id ? Number(f.carry_pct) || 0 : 10;
  const body = `
    <div class="field-row">
      ${inputField('Code *', 'code', f?.code, 'text', 'required placeholder="e.g. LCG2"')}
      ${inputField('Full legal name', 'name', f?.name, 'text', 'placeholder="e.g. Life Capital Group 2, LLC"')}
    </div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(f?.notes || '')}</textarea></div>

    <div class="dlg-section">Carried interest</div>
    ${/* A term of the operating agreement, and not every entity has one —
         some books are managed for a fee. Zero is not a special case, it is
         this field with nothing in it. */''}
    <div class="field-row">
      <div class="field">
        <label>Does this entity pay it?</label>
        <select name="charges_carry" id="entCharges">
          <option value="true" ${carryNow > 0 ? 'selected' : ''}>Yes — a share of the profit</option>
          <option value="false" ${carryNow > 0 ? '' : 'selected'}>No — managed for a fee</option>
        </select>
      </div>
      <div class="field" id="entPctWrap" style="${carryNow > 0 ? '' : 'display:none'}">
        <label>Share of the profit</label>
        <input name="carry_pct" type="number" step="0.001" min="0" max="100"
               value="${carryNow > 0 ? carryNow : 10}">
        <span class="muted" style="font-size:12px">Per cent, taken from the profit on each
          case after the investor's capital is returned.</span>
      </div>
    </div>
    <span class="muted" style="font-size:12px">
      The code is what appears in the policy grid and reports. Renaming it updates every
      policy that points at this entity — nothing is reassigned.
      ${f?.id ? `Changing the carried interest changes what every investor in this entity is
      shown, on every screen, immediately. It is written to the activity log.` : ''}
    </span>`;

  const dlg = openDialog(isNew ? 'New owner entity' : 'Edit owner entity', body, async (v) => {
    if (v.charges_carry === 'false') v.carry_pct = 0;
    delete v.charges_carry;
    if (isNew) await api('/funds', { method: 'POST', body: v });
    else await api(`/funds/${f.id}`, { method: 'PUT', body: v });
    state.funds = await api('/funds');
    toast(isNew ? 'Entity created' : 'Entity updated');
    onSaved?.();
  }, isNew ? 'Create entity' : 'Save');

  // The percentage only means anything if they pay one.
  $('#entCharges', dlg)?.addEventListener('change', (e) => {
    $('#entPctWrap', dlg).style.display = e.target.value === 'true' ? '' : 'none';
  });
  return dlg;
}

function openDeletePolicyDialog(p) {
  const vals = (p.values || []).length;
  const txns = (p.transactions || []).length;
  const lives = (p.additionalInsureds || []).length;

  const body = `
    <p style="margin:0 0 14px;font-size:14px">
      This permanently deletes <strong>${esc(p.policy_number)}</strong>
      (${esc(p.carrier_name)}) and everything recorded against it.
    </p>
    <table class="data" style="margin-bottom:16px">
      <tbody>
        <tr><td>Insured</td><td class="strong">${esc(insuredName(p))}</td></tr>
        <tr><td>Death benefit</td><td class="strong">${money(scaled(p.death_benefit ?? p.face_amount, p))}</td></tr>
        <tr><td>Value snapshots</td><td class="strong">${vals}</td></tr>
        <tr><td>Ledger entries</td><td class="strong">${txns}</td></tr>
        ${lives ? `<tr><td>Additional lives</td><td class="strong">${lives}</td></tr>` : ''}
        <tr><td>Capital invested</td><td class="strong">${money(scaled(p.total_invested, p))}</td></tr>
      </tbody>
    </table>
    <div class="error-box" style="margin-bottom:16px">
      This cannot be undone. The value history and premium ledger go with it.
    </div>
    <p style="margin:0 0 14px;font-size:13px" class="secondary">
      If the policy ended rather than being entered by mistake, use
      <strong>Edit policy</strong> and set the status to Sold, Matured or Lapsed instead —
      that drops it out of the dashboard and reports but keeps the history.
    </p>
    ${inputField(`Type <b>${esc(p.policy_number)}</b> to confirm`, 'confirm', '', 'text',
      'required autocomplete=off')}`;

  openDialog('Delete policy', body, async (v) => {
    if (String(v.confirm || '').trim() !== String(p.policy_number))
      throw new Error('That does not match the policy number');
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: v.confirm } });
    toast(`Deleted ${p.policy_number}`);
    location.hash = '#/policies';
  }, 'Delete permanently');
}

/**
 * Deleting a batch.
 *
 * Everything that will go is counted by the server first and shown here —
 * including the documents filed against those policies, which are the part
 * nobody expects and the part that does not come back.
 *
 * The confirmation carries the count, so a phrase typed for one selection
 * cannot authorise a different one.
 */
async function openBulkDeleteDialog() {
  const ids = [...state.selected];
  let tally;
  try {
    tally = await api('/policies/bulk-delete/preview', { method: 'POST', body: { ids } });
  } catch (err) { alert(err.message); return; }

  if (tally.missing?.length) {
    // Somebody else has been working too. Drop them and say so.
    for (const id of tally.missing) state.selected.delete(id);
    if (!tally.count) { toast('Those policies have already been deleted'); render(); return; }
  }

  /* Policy number, who is insured, and how big it is. Enough to recognise a
     row as one you meant to pick; carrier and status are noise at this
     moment and they cost the money column its last two digits. */
  const list = tally.policies.map((p) => `<tr>
      <td class="strong">${esc(p.policy_number)}</td>
      <td>${esc([p.last_name, p.first_name].filter(Boolean).join(', '))}</td>
      <td class="dlg-amt">${money(p.face_amount)}</td>
    </tr>`).join('');

  const body = `
    <p style="margin:0 0 14px;font-size:14px">
      This permanently deletes <strong>${tally.count}
      ${tally.count === 1 ? 'policy' : 'policies'}</strong> and everything recorded against them.
    </p>
    <div class="dlg-scroll">
      <table class="data dlg-list"><tbody>${list}</tbody></table>
    </div>
    <table class="data" style="margin-bottom:16px"><tbody>
      <tr><td>Death benefit</td><td class="strong">${fmtExact(tally.face_amount)}</td></tr>
      <tr><td>Capital invested</td><td class="strong">${fmtExact(tally.invested)}</td></tr>
      <tr><td>Ledger entries</td><td class="strong">${tally.transactions}</td></tr>
      <tr><td>Value snapshots</td><td class="strong">${tally.values}</td></tr>
      ${tally.holders ? `<tr><td>Investor allocations</td>
        <td class="strong">${tally.holders}</td></tr>` : ''}
      ${tally.documents ? `<tr><td>Documents filed against them</td>
        <td class="strong">${tally.documents}</td></tr>` : ''}
    </tbody></table>
    <div class="error-box" style="margin-bottom:16px">
      This cannot be undone. ${tally.holders
        ? `${tally.holders} investor ${tally.holders === 1 ? 'allocation goes' : 'allocations go'} with
           ${tally.count === 1 ? 'it' : 'them'} — those positions disappear from the investors' own
           portfolios. `
        : ''}${tally.documents
        ? `${tally.documents} uploaded ${tally.documents === 1 ? 'document is' : 'documents are'}
           deleted too. `
        : ''}Every deletion is written to the activity log.
    </div>
    <p style="margin:0 0 14px;font-size:13px" class="secondary">
      If these policies ended rather than being entered by mistake, set each status to Sold,
      Matured or Lapsed instead — that drops them out of the dashboard and reports but keeps
      the history.
    </p>
    ${inputField(`Type <b>${esc(tally.confirm_phrase)}</b> to confirm`, 'confirm', '', 'text',
      'required autocomplete=off')}`;

  openDialog(`Delete ${tally.count} ${tally.count === 1 ? 'policy' : 'policies'}`, body,
    async (v) => {
      if (String(v.confirm || '').trim() !== tally.confirm_phrase)
        throw new Error(`That does not match. Type ${tally.confirm_phrase}.`);
      const out = await api('/policies/bulk-delete',
        { method: 'POST', body: { ids: tally.policies.map((p) => p.id), confirm: v.confirm } });
      state.selected.clear();
      toast(`Deleted ${out.deleted} ${out.deleted === 1 ? 'policy' : 'policies'}`);
      render();
    }, `Delete ${tally.count === 1 ? 'it' : 'them all'} permanently`);
}

function openInsuredDialog(ins, onSaved) {
  const isNew = !ins?.id;
  const body = `
    <div class="field-row">
      ${inputField('Last name *', 'last_name', ins?.last_name ?? ins?.insured_last, 'text', 'required')}
      ${inputField('First name', 'first_name', ins?.first_name ?? ins?.insured_first)}
    </div>
    ${inputField('Display name', 'display_name', ins?.display_name, 'text',
      'placeholder="Optional — for joint or survivorship policies, e.g. Dean &amp; Cheryl Wolfe"')}
    <div class="field-row">
      ${inputField('Date of birth', 'dob', dateInput(ins?.dob ?? ins?.insured_dob), 'date')}
      ${selectField('Gender', 'gender', ins?.gender || '', ['', 'M', 'F', 'Joint'])}
      ${stateField('State', 'state', ins?.state)}
    </div>
    <div class="field-row">
      ${selectField('Smoker', 'smoker', ins?.smoker || '', ['', 'Non-Smoker', 'Smoker', 'Unknown'])}
      ${inputField('Life expectancy (months)', 'le_months', ins?.le_months, 'number')}
      ${inputField('LE provider', 'le_provider', ins?.le_provider)}
    </div>
    <div class="field-row">
      ${inputField('LE report date', 'le_date', dateInput(ins?.le_date), 'date')}
      ${inputField('Date of death', 'date_of_death', dateInput(ins?.date_of_death), 'date')}
    </div>
    <div class="field" style="margin-top:-6px">
      <span class="muted" style="font-size:12px">
        Entering a date of death moves this person's policies out of the active
        portfolio and into <strong>Maturities</strong>. A survivorship policy waits
        for the second death, since a second-to-die contract pays nothing on the
        first. Clearing the date puts the policy back.</span>
    </div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(ins?.notes || '')}</textarea></div>`;

  openDialog(isNew ? 'New insured' : 'Edit insured', body, async (v) => {
    if (isNew) {
      await api('/insureds', { method: 'POST', body: v });
      toast('Insured created');
    } else {
      const cleared = !!dateInput(ins?.date_of_death) && !v.date_of_death;
      const saved = await api(`/insureds/${ins.id}`, { method: 'PUT', body: v });
      /* Say plainly what the date did — in both directions. A policy
         vanishing from the grid needs explaining, and so does one
         reappearing in it. */
      const moved = (saved.policies || []).filter((p) => p.matured);
      const back = (saved.policies || []).filter((p) => !p.matured);
      toast(moved.length
        ? `Insured updated — ${moved.map((p) => p.policy_number).join(', ')} moved to Maturities`
        : cleared && back.length
          ? `Date of death cleared — ${back.map((p) => p.policy_number).join(', ')} back in the active book`
          : 'Insured updated');
    }
    onSaved?.();
  });
}

/**
 * A carrier statement, typed in.
 *
 * Editing rather than only adding, because a statement filed under the
 * wrong month or a figure fat-fingered is a correction to that row, not a
 * reason to delete it and lose that it was ever there.
 *
 * The next premium is on this screen because it is on the statement. It is
 * the same piece of paper, read at the same sitting, and making somebody
 * close this dialog and open a different one on a different tab to enter a
 * figure they are already looking at is how schedules end up empty. What it
 * writes is a scheduled premium on the servicing calendar — the one place
 * a premium due is read from — so entering it here and entering it there
 * are the same act.
 */
function openValueDialog(p, existing = null) {
  const editing = !!existing;
  const money0 = (v) => (v === null || v === undefined || v === '' ? '' : v);
  const body = `
    ${inputField('As of date *', 'as_of_date',
      editing ? dateInput(existing.as_of_date) : today(), 'date', 'required')}
    <div class="field-row">
      ${moneyField('Account value (AV)', 'account_value', money0(existing?.account_value))}
      ${moneyField('Cash surrender value (CSV)', 'cash_surrender_value',
        money0(existing?.cash_surrender_value))}
    </div>
    <div class="field-row">
      ${moneyField('Cost of insurance (COI)', 'cost_of_insurance',
        money0(existing?.cost_of_insurance))}
      ${moneyField('Death benefit', 'death_benefit',
        editing ? money0(existing.death_benefit) : (p.death_benefit ?? p.face_amount))}
    </div>
    <div class="field-row">
      ${moneyField('Loan balance', 'loan_balance', money0(existing?.loan_balance))}
      ${inputField('Date of last withdrawal', 'date_of_last_withdrawal',
        dateInput(existing?.date_of_last_withdrawal), 'date')}
    </div>
    ${inputField('Notes', 'notes', existing?.notes || '')}

    <div class="dlg-section">The next premium, as the statement gives it</div>
    <div class="field-row">
      ${inputField('Next premium due', 'next_premium_due', '', 'date')}
      ${moneyField('Amount', 'next_premium_amount', '')}
    </div>
    <span class="muted" style="font-size:12px">
      Optional, and only recorded if you give both. This goes on the policy's servicing
      calendar, which is the only thing the premium forecast and a capital call read —
      entering it here and entering it under <strong>Schedule next step</strong> are the
      same act. Leave it blank if the statement does not say.
    </span>`;

  openDialog(editing ? 'Edit value snapshot' : 'Add value snapshot', body, async (v) => {
    const due = String(v.next_premium_due || '').trim();
    const amount = String(v.next_premium_amount || '').replace(/,/g, '').trim();
    if ((due && !amount) || (amount && !due))
      throw new Error('A scheduled premium needs both a date and an amount. '
        + 'Clear both if the statement does not give them.');
    delete v.next_premium_due; delete v.next_premium_amount;

    if (editing) await api(`/values/${existing.id}`, { method: 'PUT', body: v });
    else await api(`/policies/${p.id}/values`, { method: 'POST', body: v });

    if (due && amount) {
      await api(`/policies/${p.id}/reminders`, { method: 'POST', body: {
        kind: 'Premium', due_date: due, amount,
        note: `Per the carrier statement of ${fmtDate(v.as_of_date)}` } });
      toast(editing ? 'Snapshot updated · premium scheduled' : 'Snapshot saved · premium scheduled');
    } else {
      toast(editing ? 'Snapshot updated' : 'Snapshot saved');
    }
  }, editing ? 'Save' : 'Add');
}

/**
 * Put something on the calendar against this policy.
 *
 * Two things go on it. A premium expected at some future date, with an
 * estimate of what it will be — an illustration that steps up in year nine
 * is a cash-flow fact worth knowing about in year eight. And anything else
 * that has a date attached and no figure: chase the change-of-ownership
 * form, refresh the LE report, call the carrier about the grace period.
 *
 * The amount is an estimate and says so. What was actually paid belongs in
 * the transaction ledger, which is a different act with a different button.
 */
function openStepDialog(p, existing = null) {
  const editing = !!existing;
  const kind = existing?.kind || 'Premium';
  /* A date to correct rather than a blank box: a year on from the last
     premium already scheduled, or a year from today if this is the first.
     The AMOUNT is deliberately not suggested — every figure the calendar,
     the forecast and a capital call use comes from this field, so it has to
     be one somebody typed while looking at the carrier's statement, not the
     policy form's annual figure carried in by default. */
  const lastScheduled = (p.reminders || [])
    .filter((r) => r.kind === 'Premium')
    .map((r) => dateInput(r.due_date))
    .sort()
    .pop();
  const suggestedDate = existing ? dateInput(existing.due_date)
    : addMonthsIso(lastScheduled || today(), 12);

  const dlg = openDialog(editing ? 'Edit this step' : 'Schedule next step', `
    <div class="field">
      <label>What is it</label>
      <div class="step-kind">
        <label class="rpt-choice ${kind === 'Premium' ? 'selected' : ''}">
          <input type="radio" name="kind" value="Premium" ${kind === 'Premium' ? 'checked' : ''}>
          <strong>Premium payment</strong>
          <span class="muted" style="display:block;font-size:12px;margin-top:3px">
            A premium you expect to pay on this date, with an estimate of the amount.</span>
        </label>
        <label class="rpt-choice ${kind === 'Reminder' ? 'selected' : ''}">
          <input type="radio" name="kind" value="Reminder" ${kind === 'Reminder' ? 'checked' : ''}>
          <strong>Reminder</strong>
          <span class="muted" style="display:block;font-size:12px;margin-top:3px">
            Anything else with a date on it — chase a form, refresh an LE, call the carrier.</span>
        </label>
      </div>
    </div>

    <div class="field-row">
      ${inputField('Date', 'due_date', suggestedDate, 'date', 'required')}
      <div class="field" id="stepAmountField">
        <label>Estimated amount</label>
        <input name="amount" type="text" inputmode="decimal" data-money autocomplete="off"
               value="${esc(groupDigits(String(existing?.amount ?? '')))}">
      </div>
    </div>

    <div class="field"><label id="stepNoteLabel">Note</label>
      <textarea name="note" rows="3"
        placeholder="Step-up per the carrier illustration">${esc(existing?.note || '')}</textarea>
    </div>

    <span class="muted" style="font-size:12px">
      This goes on the Servicing calendar and stays there until somebody marks it done.
      A premium entered here is the only thing the calendar, the premium forecast and a
      capital call read — nothing is taken from the annual figure on the policy form.
      The amount is an estimate; what was actually paid is recorded with
      <strong>Log premium payment</strong>, which is a different thing and belongs in
      the ledger.
    </span>
  `, async (v) => {
    const body = { due_date: v.due_date, kind: v.kind, amount: v.amount, note: v.note };
    if (editing) await api(`/policy-reminders/${existing.id}`, { method: 'PUT', body });
    else await api(`/policies/${p.id}/reminders`, { method: 'POST', body });
    toast(editing ? 'Schedule updated' : 'Added to the schedule');
  }, editing ? 'Save' : 'Add to the schedule');

  const sync = () => {
    const isPremium = $('input[name=kind]:checked', dlg).value === 'Premium';
    $('#stepAmountField', dlg).style.display = isPremium ? '' : 'none';
    $('#stepNoteLabel', dlg).textContent = isPremium ? 'Note' : 'What is the reminder for *';
    $('textarea[name=note]', dlg).placeholder = isPremium
      ? 'Step-up per the carrier illustration'
      : 'Chase the change-of-ownership form with the carrier';
    dlg.querySelectorAll('.step-kind .rpt-choice').forEach((el) =>
      el.classList.toggle('selected', el.querySelector('input').checked));
  };
  dlg.querySelectorAll('input[name=kind]').forEach((el) => el.addEventListener('change', sync));
  sync();
  return dlg;
}

/**
 * Add a ledger entry, or correct one.
 *
 * The same dialog for both. An entry that is wrong is usually wrong in
 * one field, and the way to fix that is to open it and change that field
 * -- not to delete the row and retype four of them from memory, which is
 * how a correction turns into a second mistake.
 *
 * `existing` is the row being corrected; without it this adds a new one.
 */
function openTxnDialog(p, preset = {}, existing = null) {
  const from = existing || preset;
  const body = `
    ${existing ? `<p class="dlg-note">Every return figure on this policy is worked out
      from this ledger, so a change here moves the rate on the policy, on its entity and
      on the book. What changed is recorded against your name.</p>` : ''}
    <div class="field-row">
      ${inputField('Date *', 'txn_date',
        String(from.txn_date || today()).slice(0, 10), 'date', 'required')}
      ${selectField('Type *', 'txn_type', from.txn_type || 'Premium Payment',
        ['Premium Payment', 'Acquisition Cost', 'Withdrawal', 'Loan', 'Fee', 'Commission', 'Servicing', 'Other'])}
    </div>
    ${moneyField('Amount *', 'amount', from.amount ?? '', 'required')}
    ${inputField('Remarks', 'remarks', existing ? (existing.remarks || '') : '')}`;

  openDialog(existing ? 'Edit transaction' : 'Add transaction', body, async (v) => {
    if (existing) {
      await api(`/transactions/${existing.id}`, { method: 'PUT', body: v });
      toast('Transaction updated');
    } else {
      await api(`/policies/${p.id}/transactions`, { method: 'POST', body: v });
      toast('Transaction saved');
    }
  });
}

/* ------------------------- premium optimization ----------------------- *
 * A servicing firm is paid to work out the smallest premium stream that
 * keeps a policy in force to maturity and sends back a workbook. This is
 * where those land.
 *
 * Reference, and it says so on the page. Nothing filed here changes what
 * is due, what the forecast says, or what a capital call asks for — a
 * premium that has to be paid is still an entry somebody makes on the
 * calendar. This is what they read while deciding what to put there.
 * ------------------------------------------------------------------ */

async function premiumOptimizationView() {
  const streams = await api('/premium-streams').catch(() => []);

  /* Grouped by policy, newest first inside each. A stream is dated advice
     and the previous one is how you see what changed, so both stay. */
  const byPolicy = new Map();
  for (const s of streams) {
    if (!byPolicy.has(s.policy_id)) byPolicy.set(s.policy_id, []);
    byPolicy.get(s.policy_id).push(s);
  }

  const html = `
    <div class="page-head">
      <div><h1>Servicing calendar</h1>
        <div class="sub">${streams.length
          ? `${streams.length} premium optimization${streams.length === 1 ? '' : 's'} on file
             across ${byPolicy.size} ${byPolicy.size === 1 ? 'policy' : 'policies'}`
          : 'No premium optimizations on file yet'}</div></div>
      <div class="spacer"></div>
      <button class="primary" id="uploadStreamBtn">Upload a premium optimization</button>
    </div>

    ${servicingTabs()}

    <div class="notice-box" style="margin-bottom:14px">
      <strong>Reference only.</strong> These are premium streams a servicing firm worked
      out — the smallest premiums that keep each policy in force. Nothing here is an
      obligation: it does not change what is due, the premium forecast, or what a capital
      call asks for. Those still come from what somebody enters on a policy's
      <strong>Servicing</strong> tab. This is what you read while deciding what to put there.
    </div>

    ${!streams.length ? `
    <div class="card" id="streamEmptyDrop"><div class="card-body">
      <div class="dropzone" id="streamPageDrop" style="padding:34px 20px">
        <div style="font-weight:600;margin-bottom:4px">Drop a premium optimization here,
          or click to choose</div>
        <div class="muted" style="font-size:12.5px">The workbook a servicing firm sends back —
          a header naming the policy, then a dated table of premiums running to maturity.
          Both .xlsx and .csv are read, and the policy is matched by the number in the file.</div>
        <input type="file" id="streamPageFile" accept=".xlsx,.xls,.csv" style="display:none">
      </div>
    </div></div>` : [...byPolicy.entries()].map(([policyId, list]) => {
      const top = list[0];
      return `
      <div class="card" data-drop-policy="${policyId}"
           data-drop-label="${esc(top.on_policy_number || '')}">
        <div class="card-head">
          <h2>${esc(top.on_insured || top.insured_name || 'Unnamed')}</h2>
          <span class="muted" style="font-size:12px;margin-left:10px">${
            esc(top.on_carrier || top.carrier_name || '')} ${esc(top.on_policy_number)}${
            top.fund_code ? ` · ${esc(top.fund_code)}` : ''}</span>
          <div class="spacer"></div>
          <button class="btn-sm" data-open-policy="${policyId}">Open the policy</button>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Uploaded</th><th>Stream</th><th>Covers</th>
            <th class="num">Payments</th><th class="num">Next 12 months</th>
            <th>From the file</th><th></th></tr></thead>
          <tbody>${list.map((s, i) => `<tr>
            <td class="${i === 0 ? 'strong' : 'muted'}">${fmtDate(s.uploaded_at)}${
              i === 0 && list.length > 1 ? ' <span class="badge">latest</span>' : ''}</td>
            <td class="strong">${esc(s.premium_type || 'not stated')}</td>
            <td class="secondary">${fmtDate(s.first_due)} — ${fmtDate(s.last_due)}</td>
            <td class="num">${s.payments}</td>
            <td class="num strong">${fmtExact(s.next_12mo)}</td>
            <td class="secondary">${esc(s.file_name || '')}${s.uploaded_by
              ? ` <span class="muted">· ${esc(s.uploaded_by)}</span>` : ''}</td>
            <td style="white-space:nowrap">
              <button class="btn-sm" data-stream="${s.id}">Open</button>
              <button class="btn-sm danger" data-drop-stream="${s.id}">Remove</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${top.comments ? `<div class="card-body" style="border-top:1px solid var(--grid)">
          <span class="muted" style="font-size:12.5px;line-height:1.6">
            <strong>From the servicing firm:</strong> ${esc(top.comments)}</span></div>` : ''}
      </div>`;
    }).join('')}`;

  return {
    html,
    after: () => {
      wireServicingTabs();
      onClick('#uploadStreamBtn', () => openStreamUploadDialog());
      /* Drop a workbook on the card for a policy and it is filed against
         that policy; drop it on the empty page and the number in the file
         decides. Either way the reading and the confirm still happen. */
      wireStreamRows();
      attachDropZone($('#streamPageDrop'), $('#streamPageFile'),
        (f) => openStreamUploadDialog({ file: f }));
      document.querySelectorAll('[data-open-policy]').forEach((b) =>
        b.addEventListener('click', () => go(`#/policy/${b.dataset.openPolicy}`)));
    },
  };
}

/** The year table, with the months inside a year one click away. */
function streamYears(years) {
  let running = 0;
  return `
    <div class="table-wrap" style="max-height:340px;overflow:auto">
    <table class="data">
      <thead><tr><th>Year</th><th class="num">Payments</th><th class="num">Premium</th>
        <th class="num">Cumulative</th><th></th></tr></thead>
      <tbody>${years.map((y) => {
        running += y.total;
        return `
        <tr>
          <td class="strong">${esc(y.year)}</td>
          <td class="num muted">${y.payments}</td>
          <td class="num strong">${fmtExact(y.total)}</td>
          <td class="num muted">${fmtExact(running)}</td>
          ${''/* type=button, or the dialog's form submits and the whole
                 thing closes the first time somebody opens a year. */}
          <td><button type="button" class="btn-sm" data-year="${esc(y.year)}">Months</button></td>
        </tr>
        <tr class="year-months" data-months="${esc(y.year)}" style="display:none">
          <td colspan="5" style="padding:0">
            <table class="data" style="margin:0"><tbody>${y.rows.map((r) => `<tr>
              <td style="padding-left:26px">${fmtDate(r.due_date)}</td>
              ${''/* To the cent: these figures are the point of the document,
                     and 40,848.50 rounded to 40,849 is not the same advice. */}
              <td class="num">${fmtExact(r.amount)}</td>
              <td class="num muted">${r.death_benefit == null ? '' : fmtExact(r.death_benefit)}</td>
            </tr>`).join('')}</tbody></table>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

async function openStreamDialog(id) {
  const s = await api(`/premium-streams/${id}`);
  const row = (label, value) => value === '' || value == null ? ''
    : `<dt>${label}</dt><dd>${value}</dd>`;
  const dlg = openDialog(
    `${s.on_insured || s.insured_name || 'Premium optimization'} — ${
      s.premium_type || 'premium optimization'}`, `
    <div class="notice-box" style="margin-bottom:12px">
      Reference. Nothing on this page changes what is due or what anybody is asked for.
    </div>
    <dl class="kv">
      ${row('Policy', `${esc(s.on_policy_number)}${s.policy_number
        && s.policy_number !== s.on_policy_number
          ? ` <span class="muted">· the file says ${esc(s.policy_number)}</span>` : ''}`)}
      ${row('Carrier', esc(s.carrier_name || ''))}
      ${row('Face amount', s.face_amount == null ? '' : fmtExact(s.face_amount))}
      ${row('Effective', s.effective_date ? fmtDate(s.effective_date) : '')}
      ${row('Runs to', s.maturity_date ? fmtDate(s.maturity_date) : '')}
      ${row('Premium type', esc(s.premium_type || ''))}
      ${row('Payments', `${s.payments} · ${fmtExact(s.total)} in total`)}
      ${row('From', `${esc(s.file_name || 'a file')}${s.uploaded_by_name
        ? `, uploaded by ${esc(s.uploaded_by_name)}` : ''} on ${fmtDate(s.uploaded_at)}`)}
      ${row('Note', esc(s.note || ''))}
    </dl>
    ${s.comments ? `<div class="field" style="margin-top:10px">
      <label>What the servicing firm said</label>
      <div class="muted" style="font-size:13px;line-height:1.6">${esc(s.comments)}</div>
    </div>` : ''}
    <div class="dlg-section">Year by year</div>
    ${streamYears(s.years)}`, null, null);

  dlg.querySelectorAll('[data-year]').forEach((b) =>
    b.addEventListener('click', () => {
      const months = dlg.querySelector(`[data-months="${b.dataset.year}"]`);
      const open = months.style.display !== 'none';
      months.style.display = open ? 'none' : '';
      b.textContent = open ? 'Months' : 'Hide';
    }));
}

/**
 * A drop target that is also a click target.
 *
 * Dragging a file onto the thing it belongs to is how everybody expects
 * this to work, and clicking is how everybody who has just been handed a
 * file dialog expects it to work. Both, on the same element, everywhere
 * one of these appears.
 */
function attachDropZone(zone, input, onFile) {
  if (!zone) return;
  zone.addEventListener('click', () => input?.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  input?.addEventListener('change', () => {
    const file = input.files?.[0];
    /* Clearing it means choosing the SAME file again still fires, which
       matters when somebody fixes the spreadsheet and tries once more. */
    input.value = '';
    if (file) onFile(file);
  });
}

/**
 * A card that accepts a dropped file even though the drop zone is not
 * visible on it — the whole card is the target.
 *
 * Used on the policy's Servicing tab and on the Premium optimization
 * list: the natural gesture is to drag the workbook onto the policy it
 * is about, not to go looking for a button first.
 */
function dropOpensUpload(el, opts = {}) {
  if (!el) return;
  const on = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    el.classList.add('drop-target');
  };
  el.addEventListener('dragover', on);
  el.addEventListener('dragenter', on);
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    el.classList.remove('drop-target');
    if (!file) return;
    e.preventDefault();
    openStreamUploadDialog({ ...opts, file });
  });
}

/**
 * Upload one.
 *
 * Two steps on purpose. A premium optimization is a document about ONE
 * policy, and filing it against the wrong one would put somebody else's
 * numbers in front of whoever is deciding what to fund — so the file is
 * read first, and what it says is shown back with the policy it matched
 * before anything is written.
 *
 * Opened from a policy's Servicing tab, the destination is that policy
 * and the reading still happens — if the file names a different policy,
 * that is said plainly rather than quietly overridden.
 */
function openStreamUploadDialog({ policyId = null, policyLabel = '', file: dropped = null } = {}) {
  let read = null;
  let file = null;
  /* Only fetched when the number in the file matches nothing — which is the
     uncommon case, and not worth a round trip on every upload. */
  let pickable = [];

  const summary = () => {
    if (!read) return '';
    const h = read.header;
    const onThisPolicy = policyId && read.match?.id === Number(policyId);
    const wrongPolicy = policyId && !onThisPolicy;
    return `
      <div class="dlg-section">What the file says</div>
      <dl class="kv">
        <dt>Insured</dt><dd>${esc(h.insured_name || '—')}</dd>
        <dt>Policy number</dt><dd>${esc(h.policy_number || '—')}</dd>
        <dt>Carrier</dt><dd>${esc(h.carrier_name || '—')}</dd>
        <dt>Premium type</dt><dd>${esc(h.premium_type || 'not stated')}</dd>
        <dt>Premiums</dt><dd>${read.summary.count} payments, ${
          fmtDate(read.summary.first)} to ${fmtDate(read.summary.last)}</dd>
        <dt>Next 12 months</dt><dd class="strong">${fmtExact(read.summary.next_12mo)}</dd>
      </dl>
      ${read.problems.length ? `<div class="notice-box" style="margin-top:10px">
        ${read.problems.length} row${read.problems.length === 1 ? '' : 's'} could not be read
        and ${read.problems.length === 1 ? 'was' : 'were'} left out — usually a total or a
        footnote. First: ${esc(read.problems[0].text)}</div>` : ''}
      ${policyId ? `
        <input type="hidden" name="policy_id" value="${policyId}">
        ${wrongPolicy ? `<div class="error-box" style="margin-top:10px">
          This file names <strong>${esc(h.policy_number || '(no policy number)')}</strong>, which
          is not ${esc(policyLabel || 'this policy')}. It will still be filed here — check it is
          the right file before you do.</div>`
        : `<div class="notice-box" style="margin-top:10px">
          Filed against <strong>${esc(policyLabel || 'this policy')}</strong>, which is the policy
          the file names.</div>`}`
      : !read.matched ? `<div class="error-box" style="margin-top:10px">
        ${read.ambiguous
          ? 'More than one policy carries that number, so this cannot be filed automatically.'
          : `No policy of yours has the number ${esc(h.policy_number || '(none given)')}.`}
        Choose the policy it belongs to below.</div>
        <div class="field"><label>Policy *</label>
          <select name="policy_id" id="streamPolicy" required>
            <option value="">— choose —</option>
            ${pickable.map((p) => `<option value="${p.id}">${
              esc(p.policy_number)} — ${esc(p.display_name
                || `${p.insured_first || ''} ${p.insured_last || ''}`.trim())}</option>`).join('')}
          </select></div>`
      : `<div class="notice-box" style="margin-top:10px">
        Matches <strong>${esc(read.match.policy_number)}</strong> —
        ${esc(read.match.insured_name || '')}${read.match.fund_code
          ? ` · ${esc(read.match.fund_code)}` : ''}. It will be filed against that policy.
        <input type="hidden" name="policy_id" value="${read.match.id}"></div>`}`;
  };

  const dlg = openDialog(policyLabel
    ? `Premium optimization for ${policyLabel}` : 'Upload a premium optimization', `
    <div class="field">
      <label>File *</label>
      <div class="dropzone" id="streamDrop" style="padding:26px 18px">
        <div style="font-weight:600;margin-bottom:4px" id="streamDropName">
          Drop the workbook here, or click to choose</div>
        <div class="muted" style="font-size:12.5px">The file as it arrived from the servicing
          firm — .xlsx or .csv, up to 15 MB.</div>
        <input type="file" id="streamFile" accept=".xlsx,.xls,.csv" style="display:none">
      </div>
    </div>
    ${inputField('Who produced it', 'source', '', 'text',
      'placeholder="e.g. ITM TwentyFirst"')}
    <div class="field"><label>Note</label>
      <input name="note" type="text" placeholder="Optional — why this one, what changed"></div>
    <div id="streamSummary"></div>
  `, async (v) => {
    if (!file) throw new Error('Choose a file.');
    if (!read) throw new Error('Wait for the file to be read.');
    const target = $('#streamPolicy', dlg)?.value
      || dlg.querySelector('input[name=policy_id]')?.value;
    if (!target) throw new Error('Choose the policy this belongs to.');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('policy_id', target);
    fd.append('source', v.source || '');
    fd.append('note', v.note || '');
    const res = await fetch('/api/premium-streams', { method: 'POST', body: fd,
      credentials: 'same-origin' });
    if (!res.ok) {
      let msg = 'Upload failed.';
      try { msg = (await res.json()).error || msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    const saved = await res.json();
    toast(`Filed ${saved.count} dated premiums`);
    render();
  }, 'File it');

  const readChosen = async (chosen) => {
    file = chosen;
    read = null;
    $('#streamDropName', dlg).textContent = chosen.name;
    $('#streamSummary', dlg).innerHTML = '<div class="empty"><span class="spin"></span></div>';
    try {
      const fd = new FormData();
      fd.append('file', chosen);
      const res = await fetch('/api/premium-streams/preview', { method: 'POST', body: fd,
        credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || 'That file could not be read.');
      read = body;
      if (!policyId && !read.matched) pickable = await api('/policies').catch(() => []);
      $('#streamSummary', dlg).innerHTML = summary();
    } catch (err) {
      $('#streamSummary', dlg).innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  };

  attachDropZone($('#streamDrop', dlg), $('#streamFile', dlg), readChosen);
  // Dropped onto a card rather than chosen here: read it straight away.
  if (dropped) readChosen(dropped);
}

/* ----------------------------- servicing ----------------------------- */

/* Which half of Servicing is on screen.
   A module variable rather than the URL, like the policy detail tabs: the
   page is one screen with two things on it, not two addresses. */
let svcTab = 'calendar';

/** Who may see the premium optimizations at all. */
const mayOptimize = () => ['admin', 'manager'].includes(state.user?.role);

const servicingTabs = () => (!mayOptimize() ? '' : `
  <div class="tabs" id="svcTabs">
    <button data-svctab="calendar" class="${svcTab === 'calendar' ? 'active' : ''}">Calendar</button>
    <button data-svctab="optimization" class="${svcTab === 'optimization' ? 'active' : ''}">Premium optimization</button>
  </div>`);

const wireServicingTabs = () => {
  document.querySelectorAll('#svcTabs button').forEach((b) =>
    b.addEventListener('click', () => { svcTab = b.dataset.svctab; render(); }));
};

async function servicingView() {
  if (svcTab === 'optimization' && mayOptimize()) return premiumOptimizationView();
  const mayRaise = !isInvestorUser() && ['admin', 'manager'].includes(state.user.role);
  const [svc, funds, calls, dupes] = await Promise.all([
    api(`/servicing${entityQuery() ? `?${entityQuery()}` : ''}`),
    loadFunds(),
    api('/capital-calls').catch(() => []),
    /* Calls raised more than once before this was fixed. New ones fold into
       the open call by themselves; these are the ones already on the page. */
    mayRaise ? api('/capital-calls/duplicates').catch(() => ({ groups: [] }))
      : Promise.resolve({ groups: [] }),
  ]);
  const dupeGroups = dupes.groups || [];
  /* Cancelled calls stay on the record but off the page. After folding
     duplicates in, the copies are cancelled rather than deleted — leaving
     them in the list would mean the fix appeared to change nothing. */
  const shownCalls = calls.filter((c) => c.status !== 'Cancelled' || state.showCancelledCalls);
  const cancelledCount = calls.length - calls.filter((c) => c.status !== 'Cancelled').length;
  const investor = isInvestorUser();
  // An investor is shown what is still to come. A date that has already
  // passed is a servicing matter — somebody is chasing it — and putting it
  // on an investor's screen reads as a bill they have missed.
  const upcoming = svc.upcoming.filter((r) => r.next_premium_due
    && (!investor || String(r.next_premium_due).slice(0, 10) >= today()));
  const grouped = {};
  for (const r of upcoming) {
    const key = String(r.next_premium_due).slice(0, 7);
    (grouped[key] ||= []).push(r);
  }

  const duesForInvestor = investor ? premiumDues(svc) : [];
  /* Every dated row above, added up — the total is of what is on the page
     rather than of an arbitrary window, so the footer and the list agree. */
  const dueTotal = duesForInvestor.reduce((sum, d) => sum + d.amount, 0);
  const html = `
    <div class="page-head">
      <div><h1>${investor ? 'Premiums' : 'Servicing calendar'}</h1>
        <div class="sub">${investor
          ? `${duesForInvestor.length} upcoming premium ${
              duesForInvestor.length === 1 ? 'date' : 'dates'} · amounts are your share`
          : `${svc.alerts.length} open ${svc.alerts.length === 1 ? 'alert' : 'alerts'} ·
             ${upcoming.length} scheduled premium ${upcoming.length === 1 ? 'payment' : 'payments'}${
             (svc.scheduled || []).length ? ` · ${svc.scheduled.length} follow-up${
               svc.scheduled.length === 1 ? '' : 's'} outstanding` : ''}`}${
             !investor && entityLabel() ? ` · ${esc(entityLabel())} only` : ''}</div></div>
      <div class="spacer"></div>
      ${entityPicker(funds)}
      ${shareToggle()}
      ${!investor && ['admin', 'manager'].includes(state.user.role)
        ? '<button class="primary" id="raiseCallBtn">Raise a capital call</button>' : ''}
    </div>

    ${servicingTabs()}

    ${/* What has been asked for, and what has come back. A premium schedule
          says when the carrier wants the money; a call says when the office
          needs it in the account, which is the date an investor can act on. */''}
    ${dupeGroups.length ? `
    <div class="notice-box" style="margin-bottom:14px">
      <strong>${dupeGroups.length === 1 ? 'One ask has' : `${dupeGroups.length} asks have`}
      been raised more than once.</strong>
      ${dupeGroups.map((g) => `${g.calls.length} identical calls for ${
        esc(g.calls[0].title || 'a capital call')} due ${fmtDate(g.calls[0].due_date)}`).join('; ')}.
      Combining keeps the earliest one and moves every investor onto it — including anybody
      who has already said they paid — and cancels the copies.
      <div style="margin-top:9px"><button class="btn-sm" id="combineCallsBtn">Combine them</button></div>
    </div>` : ''}

    ${shownCalls.length || cancelledCount ? `
    <div class="card">
      <div class="card-head"><h2>Capital calls</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">${
          calls.filter((c) => c.status === 'Open').length} open</span>${cancelledCount ? `
        <button class="btn-sm" id="toggleCancelledCalls" style="margin-left:10px">${
          state.showCancelledCalls ? 'Hide' : 'Show'} ${cancelledCount} cancelled</button>` : ''}</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Called</th><th>What for</th><th>Covers</th><th>Money in by</th>
          ${investor ? '<th class="num">Your share</th><th>You</th>'
            : '<th class="num">Asked</th><th class="num">Received</th><th>Parties</th>'}
          <th></th></tr></thead>
        <tbody>${shownCalls.map((c) => `<tr>
          <td class="muted">${fmtDate(c.created_at)}</td>
          <td class="strong">${esc(c.title || 'Capital call')}${c.fund_code
            ? ` <span class="muted">· ${esc(c.fund_code)}</span>` : ''}</td>
          ${''/* Which lives it is about. Two calls with the same title, the
                 same date and different policies are otherwise
                 indistinguishable on this list. */}
          <td class="secondary">${coveredBy(c)}</td>
          <td>${fmtDate(c.due_date)}${c.status !== 'Open'
            ? ` <span class="badge">${esc(c.status)}</span>` : ''}</td>
          ${investor ? `
            <td class="num strong">${fmtExact(c.my_amount || 0)}</td>
            <td>${c.my_confirmed_at
              ? '<span class="badge inforce"><span class="dot"></span>Received</span>'
              : c.my_marked_at
                ? '<span class="badge grace"><span class="dot"></span>You said sent</span>'
                : '<span class="badge lapsed"><span class="dot"></span>Outstanding</span>'}</td>`
            : `
            <td class="num">${fmtExact(c.total)}</td>
            <td class="num">${fmtExact(c.collected)}${Number(c.collected) < Number(c.total)
              ? `<span class="muted"> · ${Math.round(
                  (Number(c.collected) / Number(c.total || 1)) * 100)}% in</span>` : ''}</td>
            <td class="muted">${c.parties}</td>`}
          <td><button class="btn-sm" data-call="${c.id}">Open</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}

    ${investor ? '' : `
    <div class="card">
      <div class="card-head"><h2>Alerts</h2></div>
      <div class="card-body flush">
        ${svc.alerts.length === 0
          ? '<div class="empty">Nothing needs attention.</div>'
          : svc.alerts.map(alertRow).join('')}
      </div>
    </div>`}

    ${investor ? `
    <div class="card">
      <div class="card-head"><h2>Premiums coming up</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">your share</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Due</th><th>Insured</th><th>Policy</th>
          <th class="num">Your share</th><th class="num">Full policy</th><th></th></tr></thead>
        <tbody>${duesForInvestor.length === 0
          ? '<tr><td colspan="6"><div class="empty">No premium dates are scheduled on your policies at the moment.</div></td></tr>'
          : duesForInvestor.map((d) => `<tr class="clickable" data-id="${d.policy_id}">
              <td class="strong">${fmtDate(d.date)}</td>
              <td>${esc(d.insured)}${d.sex
                ? ` <span class="muted">· ${esc(d.sex)}</span>` : ''}</td>
              <td class="secondary">${esc(d.carrier_name || '')} ${esc(d.policy_number || '')}</td>
              <td class="num strong">${money(d.amount)}</td>
              <td class="num muted">${money(d.amount_full)}</td>
              <td class="muted">${d.source === 'scheduled'
                ? `scheduled${d.note ? ` · ${esc(d.note)}` : ''}` : esc(d.source)}</td>
            </tr>`).join('')}</tbody>
        ${duesForInvestor.length ? `<tfoot><tr>
          <td colspan="3">Total due</td>
          <td class="num">${fmtExact(dueTotal)}</td><td colspan="2"></td>
        </tr></tfoot>` : ''}
      </table></div>
      <div class="card-body" style="border-top:1px solid var(--grid)">
        <span class="muted" style="font-size:12.5px;line-height:1.6">
          These are the premium dates on your policies' servicing schedules; amounts are
          estimates until the payment is made and can move. Your column is your percentage
          of the full policy premium beside it.</span>
      </div>
    </div>` : `
    <div class="card">
      <div class="card-head"><h2>Upcoming premiums</h2></div>
      <div class="card-body flush">
        ${Object.keys(grouped).length === 0
          ? `<div class="empty">Nothing is scheduled. Premium dates and amounts come from
               <strong>Schedule next step</strong> on a policy's Servicing tab — that entry is
               the only thing this calendar, the forecast and a capital call read.</div>`
          : Object.entries(grouped).sort().map(([month, rows]) => `
            <div style="padding:11px 16px;border-bottom:1px solid var(--grid);background:var(--page)">
              <strong>${new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong>
              <span class="muted"> · ${rows.length} due ·
                ${fmtExact(rows.reduce((s, r) => s + (Number(r.premium_required) || 0), 0))}</span>
            </div>
            <div class="table-wrap"><table class="data"><tbody>
              ${rows.map((r) => `<tr class="clickable" data-id="${r.id}">
                <td class="strong">${fmtDate(r.next_premium_due)}</td>
                <td>${esc(r.display_name || `${r.insured_first || ''} ${r.insured_last || ''}`.trim())}</td>
                <td class="secondary">${esc(r.carrier_name)} ${esc(r.policy_number)}</td>
                <td class="num">${money(r.premium_required)}</td>
                <td class="muted">${esc(r.premium_mode || '')}</td>
              </tr>`).join('')}
            </tbody></table></div>`).join('')}
      </div>
    </div>`}`;

  return {
    html,
    after: () => {
      wireEntityPicker();
      wireRateToggle();
      wireServicingTabs();
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`)));
      onClick('#raiseCallBtn', () => openRaiseCallDialog());
      onClick('#toggleCancelledCalls', () => {
        state.showCancelledCalls = !state.showCancelledCalls;
        render();
      });
      onClick('#combineCallsBtn', async () => {
        const total = dupeGroups.reduce((n, g) => n + g.calls.length - 1, 0);
        if (!confirm(`Fold ${total} duplicate call${total === 1 ? '' : 's'} into the `
          + `original${dupeGroups.length === 1 ? '' : 's'}? The copies are cancelled, not `
          + 'deleted, and every investor line moves across.')) return;
        let folded = 0;
        for (const g of dupeGroups) {
          const [keep, ...rest] = g.calls;
          const r = await api(`/capital-calls/${keep.id}/absorb`,
            { method: 'POST', body: { ids: rest.map((c) => c.id) } });
          folded += r.folded || 0;
        }
        toast(`${folded} duplicate call${folded === 1 ? '' : 's'} folded in`);
        render();
      });
      document.querySelectorAll('[data-call]').forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await openCallDialog(Number(b.dataset.call));
          } catch (err) { alert(err.message); }
        }));
    },
  };
}

/**
 * Raising one.
 *
 * The window decides which premiums are covered, and everything else follows
 * from it: who holds those policies, and therefore who is asked for what. The
 * figures are shown before anything is sent, because a capital call is the
 * one message where being wrong costs somebody else money.
 */
async function openRaiseCallDialog() {
  const soon = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  let draft = null;
  let mode = 'premiums';
  /* Who is actually going to be asked. Held here rather than read off the
     boxes at submit time, so it survives switching between the two sources
     and back — and so an investor deselected on purpose stays deselected. */
  let excluded = new Set();

  const people = () => (draft?.investors || []).filter((i) => !excluded.has(i.investor_id));
  const asked = () => people().reduce((n, i) => n + i.amount, 0);

  const investorList = (d) => {
    if (!d.investors?.length) return `<div class="error-box">
      ${mode === 'premiums'
        ? 'Nobody holds a share of those policies, so there is nobody to ask. Set the cap table on each policy first.'
        : 'Nobody has been confirmed for that deal yet. Confirm the requests on the opportunity first — a request is not an allocation, and asking somebody for money against a share nobody has granted them is how a call becomes an argument.'}
    </div>`;
    return `
    <div class="dlg-section">Who gets asked</div>
    <div class="dlg-scroll" style="max-height:200px">
      <table class="data dlg-list"><tbody>${d.investors.map((i) => `<tr>
        <td style="width:26px"><input type="checkbox" data-ask="${i.investor_id}"
          ${excluded.has(i.investor_id) ? '' : 'checked'}
          aria-label="Ask ${esc(i.name)}"></td>
        <td class="strong">${esc(i.name)}</td>
        <td>${i.pct != null ? `${fmtPct(i.pct)} of it`
          : `${i.policies} ${i.policies === 1 ? 'policy' : 'policies'}`}</td>
        <td class="dlg-amt">${fmtExact(i.amount)}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    ${d.unconfirmed?.length ? `<div class="notice-box" style="margin-top:10px">
      ${d.unconfirmed.map((u) => esc(u.name)).join(', ')}
      ${d.unconfirmed.length === 1 ? 'has asked for a piece but has not been confirmed'
        : 'have asked for pieces but have not been confirmed'}, so
      ${d.unconfirmed.length === 1 ? 'they are' : 'they are'} not on this call. Confirm
      ${d.unconfirmed.length === 1 ? 'them' : 'them'} on the opportunity first if you want
      ${d.unconfirmed.length === 1 ? 'them' : 'them'} included.</div>` : ''}
    <div class="field-row" style="margin-top:10px">
      <div class="field"><label>Being asked for</label>
        <div class="strong" style="padding:4px 0" id="askedTotal">${fmtExact(asked())}</div></div>
      <div class="field"><label>Not being called</label>
        <div class="strong" style="padding:4px 0" id="notCalled">${
          fmtExact((d.total || 0) - asked())}</div>
        <span class="muted" style="font-size:12px">Anybody unticked is simply not asked.
          Their share is not moved onto anybody else.</span></div>
    </div>`;
  };

  const summary = (d) => {
    if (!d) return '<div class="empty"><span class="spin"></span></div>';
    if (d.error) return `<div class="error-box">${esc(d.error)}</div>`;
    if (mode === 'premiums' && !d.items?.length) return `
      <div class="notice-box">
        Nothing is scheduled inside that window, so there is nothing to call for.
        Widen it above — or, if premiums are missing rather than absent, put them on the
        policy's Servicing tab with <strong>Schedule next step</strong>. A capital call is
        raised from those entries and their amounts, and from nothing else.
      </div>`;
    if (mode === 'acquisition' && !d.items?.length) return `
      <div class="notice-box">Choose which deal the money is for.</div>`;
    return `
    <div class="field-row">
      <div class="field"><label>${mode === 'acquisition' ? 'Purchase price' : 'Premiums covered'}</label>
        <div class="strong" style="padding:6px 0">${mode === 'acquisition'
          ? fmtExact(d.total)
          : `${d.items.length} · ${fmtExact(d.total)}`}</div></div>
      <div class="field"><label>Held by investors</label>
        <div class="strong" style="padding:6px 0">${fmtExact(
          (d.investors || []).reduce((n, i) => n + i.amount, 0))}</div></div>
    </div>
    ${d.unallocated > 0.005 ? `<div class="notice-box" style="margin-bottom:12px">
      ${fmtExact(d.unallocated)} of this is on percentages nobody holds — the house's own
      share. Nobody is asked for it.</div>` : ''}
    ${investorList(d)}`;
  };

  /* The dialog opens FIRST and fetches afterwards. Fetching first meant that
     anything going wrong rejected inside a click handler with nowhere to show
     itself, and the button simply did nothing when pressed. */
  const dlg = openDialog('Raise a capital call', `
    <div class="field">
      <label>What the money is for</label>
      <div class="rpt-picker" id="callMode">
        <label class="rpt-choice selected">
          <input type="radio" name="callFor" value="premiums" checked>
          <span class="rpt-choice-name">Premiums falling due</span>
          <span class="rpt-choice-blurb">Every premium scheduled inside a window, split by
            who holds each policy.</span>
        </label>
        <label class="rpt-choice">
          <input type="radio" name="callFor" value="acquisition">
          <span class="rpt-choice-name">Buying a policy</span>
          <span class="rpt-choice-blurb">The purchase price of a deal, split by what each
            investor has been confirmed for.</span>
        </label>
      </div>
    </div>

    ${/* The date the money is needed by belongs to the call, not to one of
          its two sources — it was inside the premium block, so choosing an
          acquisition hid the only field that decides when to pay. */''}
    <div class="field-row">
      <div class="field" id="premiumControls"><label>Premiums due within</label>
        <select id="callDays">
          ${[[14, 'the next 2 weeks'], [30, 'the next 30 days'], [60, 'the next 60 days'],
             [90, 'the next 90 days'], [180, 'the next 6 months'], [365, 'the next year']]
            .map(([v, label]) => `<option value="${v}" ${v === 30 ? 'selected' : ''}>${label}</option>`).join('')}
        </select></div>
      <div class="field" id="acquisitionControls" style="display:none"><label>Which deal</label>
        <select id="callOpp"><option value="">— choose —</option></select></div>
      ${inputField('Money in by', 'due_date', soon(14), 'date', 'required')}
    </div>
    ${inputField('What to call it', 'title', 'Premium capital call', 'text', 'required')}
    <div class="field"><label>Anything they should know</label>
      <textarea name="note" rows="2" placeholder="Optional — goes in the notice"></textarea></div>
    <div id="callSummary">${summary(null)}</div>
    <span class="muted" style="font-size:12px">Everybody asked is emailed their own figure
      and this date. Nobody is told what anybody else was asked for.</span>
  `, async (v) => {
    if (!draft?.items?.length) throw new Error('There is nothing to call for yet.');
    if (!people().length) throw new Error('Nobody is selected, so there is nobody to ask.');
    if (!v.due_date) throw new Error('Give the date the money has to be in by.');
    const made = await api('/capital-calls', { method: 'POST', body: {
      title: v.title, note: v.note, due_date: v.due_date,
      purpose: mode === 'acquisition' ? 'Acquisition' : 'Premiums',
      items: draft.items,
      /* For an acquisition the split comes with the request: the thing being
         bought has no cap table yet, because nobody owns it. */
      ...(mode === 'acquisition'
        ? { lines: draft.investors.map((i) => ({ investor_id: i.investor_id, amount: i.amount })) }
        : {}),
      investor_ids: people().map((i) => i.investor_id),
    } });
    /* Raised twice. The server folded it into the call already open rather
       than writing a second one, and says so — otherwise the toast reads
       like a fresh ask and somebody goes looking for a row that is not
       there. */
    if (made.merged)
      toast(made.added
        ? `That call was already open — ${made.added} ${made.added === 1
            ? 'investor was' : 'investors were'} added to it${
            made.notified ? ` and emailed` : ''}`
        : 'That exact call is already open, so nothing was sent again');
    else
      toast(`Called ${fmtExact(made.total)} from ${made.lines.length} ${
        made.lines.length === 1 ? 'investor' : 'investors'}${
        made.notified ? ` · ${made.notified} emailed` : ''}`);
  }, 'Raise it');

  const paint = () => {
    if (!dlg.isConnected) return;
    $('#callSummary', dlg).innerHTML = summary(draft);
    dlg.querySelectorAll('[data-ask]').forEach((box) =>
      box.addEventListener('change', () => {
        const id = Number(box.dataset.ask);
        if (box.checked) excluded.delete(id); else excluded.add(id);
        $('#askedTotal', dlg).textContent = fmtExact(asked());
        $('#notCalled', dlg).textContent = fmtExact((draft.total || 0) - asked());
      }));
  };

  const loadPremiums = async (days) => {
    $('#callSummary', dlg).innerHTML = summary(null);
    try {
      draft = await api(`/capital-calls/draft?days=${days}`
        + `&fund=${encodeURIComponent(entityParam())}`);
    } catch (err) { draft = { error: err.message, items: [], investors: [] }; }
    excluded = new Set();
    paint();
  };
  const loadAcquisition = async (oppId) => {
    if (!oppId) { draft = { items: [], investors: [] }; paint(); return; }
    $('#callSummary', dlg).innerHTML = summary(null);
    try {
      draft = await api(`/capital-calls/draft/acquisition?opportunity_id=${oppId}`);
      const box = $('input[name=title]', dlg);
      if (!box.dataset.touched) box.value = `Acquisition — ${draft.opportunity.label}`;
    } catch (err) { draft = { error: err.message, items: [], investors: [] }; }
    excluded = new Set();
    paint();
  };

  $('input[name=title]', dlg).addEventListener('input', (e) => {
    e.target.dataset.touched = '1';
  });
  $('#callDays', dlg).addEventListener('change', (e) => loadPremiums(e.target.value));
  $('#callOpp', dlg).addEventListener('change', (e) => loadAcquisition(e.target.value));

  dlg.querySelectorAll('input[name=callFor]').forEach((radio) =>
    radio.addEventListener('change', async () => {
      mode = radio.value;
      dlg.querySelectorAll('#callMode .rpt-choice').forEach((el) =>
        el.classList.toggle('selected', el.querySelector('input').checked));
      $('#premiumControls', dlg).style.display = mode === 'premiums' ? '' : 'none';
      $('#acquisitionControls', dlg).style.display = mode === 'premiums' ? 'none' : '';
      if (mode === 'premiums') {
        $('input[name=title]', dlg).value = 'Premium capital call';
        delete $('input[name=title]', dlg).dataset.touched;
        return loadPremiums($('#callDays', dlg).value);
      }
      /* The deals worth calling for: open, priced, and with somebody
         confirmed against them. */
      draft = null; paint();
      try {
        const { opportunities } = await api('/capital-calls/draft/acquisition');
        $('#callOpp', dlg).innerHTML = '<option value="">— choose —</option>'
          + opportunities.map((o) => `<option value="${o.id}">${
            esc([o.insured_last_name, o.insured_first_name].filter(Boolean).join(', ')
              || o.policy_number)} · ${esc(o.carrier_name || '')} · ${
            fmtExact(o.asking_price)}${o.parties ? ` · ${o.parties} confirmed` : ' · nobody confirmed'}
            </option>`).join('');
      } catch (err) {
        draft = { error: err.message, items: [], investors: [] };
        paint();
      }
    }));

  loadPremiums(30);
  return dlg;
}

/** One call: what it covers, who owes what, and where each of them has got to. */
async function openCallDialog(id) {
  const c = await api(`/capital-calls/${id}`);
  const investor = isInvestorUser();
  const canConfirm = !investor && canEditData();

  const body = `
    <div class="field-row">
      <div class="field"><label>Money in by</label>
        <div class="strong" style="padding:6px 0">${fmtDate(c.due_date)}</div></div>
      <div class="field"><label>${investor ? 'Your share' : 'Called'}</label>
        <div class="strong" style="padding:6px 0">${fmtExact(
          investor ? (c.me?.amount || 0) : c.total)}</div></div>
      ${investor ? '' : `<div class="field"><label>Received</label>
        <div class="strong" style="padding:6px 0">${fmtExact(c.collected)}</div></div>`}
    </div>
    ${c.note ? `<div class="notice-box" style="margin-bottom:14px">${esc(c.note)}</div>` : ''}

    <div class="dlg-section">What it covers</div>
    <div class="dlg-scroll" style="max-height:170px">
      <table class="data dlg-list"><tbody>${c.items.map((i) => `<tr>
        <td class="strong">${esc(i.insured_name || i.policy_number)}</td>
        <td>${esc(i.carrier_name)} · ${fmtDate(i.due_date)}</td>
        <td class="dlg-amt">${fmtExact(i.amount)}</td>
      </tr>`).join('')}</tbody></table>
    </div>

    ${investor ? `
      <div class="dlg-section">Your line</div>
      ${c.me?.confirmed_at
        ? `<div class="ok-box">Received ${fmtDateTime(c.me.confirmed_at)}. Nothing outstanding.</div>`
        : c.me?.marked_paid_at
          ? `<div class="notice-box">You told us on ${fmtDateTime(c.me.marked_paid_at)} that this
             had been sent. The office will confirm it when it lands.</div>`
          : `<p style="font-size:14px">Once you have sent it, say so here. It tells the office
             to look for it; it is not a receipt until they confirm it.</p>
             <div class="field"><label>Anything to note</label>
               <input name="note" placeholder="Wired 20 August, ref …"></div>`}`
      : `
      <div class="dlg-section">Who was asked</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Investor</th><th class="num">Share</th><th>Where it has got to</th>
          ${canConfirm ? '<th></th>' : ''}</tr></thead>
        <tbody>${c.lines.map((l) => `<tr>
          <td class="strong">${esc(l.investor_name)}</td>
          <td class="num">${fmtExact(l.amount)}</td>
          <td>${l.confirmed_at
            ? `<span class="badge inforce"><span class="dot"></span>Received</span>
               <span class="muted"> ${fmtDateTime(l.confirmed_at)}</span>`
            : l.waived_at ? '<span class="badge">Waived</span>'
            : l.marked_paid_at
              ? `<span class="badge grace"><span class="dot"></span>Says sent</span>
                 <span class="muted"> ${fmtDateTime(l.marked_paid_at)}${
                   l.marked_note ? ` · ${esc(l.marked_note)}` : ''}</span>`
              : '<span class="badge lapsed"><span class="dot"></span>Outstanding</span>'}</td>
          ${canConfirm ? `<td style="white-space:nowrap">
            ${l.confirmed_at
              ? `<button type="button" class="btn-sm" data-line="${l.id}" data-do="unconfirm">Undo</button>`
              : `<button type="button" class="btn-sm" data-line="${l.id}" data-do="confirm">Received</button>
                 <button type="button" class="btn-sm" data-line="${l.id}" data-do="waive">Waive</button>`}
          </td>` : ''}
        </tr>`).join('')}</tbody>
      </table></div>`}`;

  const dlg = openDialog(c.title || 'Capital call', body, async (v) => {
    if (investor && !c.me?.marked_paid_at && !c.me?.confirmed_at)
      await api(`/capital-calls/${id}/paid`, { method: 'POST', body: { note: v.note } });
  }, investor && !c.me?.marked_paid_at && !c.me?.confirmed_at ? 'I have sent it' : 'Close');

  dlg.querySelectorAll('[data-line]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/capital-calls/${id}/lines/${b.dataset.line}`,
          { method: 'PUT', body: { action: b.dataset.do } });
        dlg.close(); dlg.remove();
        render();
      } catch (err) { alert(err.message); b.disabled = false; }
    }));
  return dlg;
}

/* --------------------------- opportunities --------------------------- */

/* The standing minimum an investor may take. The server is the authority —
   every opportunity carries its own `min_commitment_pct`, which is lower only
   when fewer points than this are left. This is the fallback and the thing the
   "last slice" wording is measured against. */
const MIN_TAKE_PCT = 10;

const OPP_STATUSES = ['Open', 'Passed', 'Closed', 'Withdrawn'];

/** Days until a date, or null. Negative means it has passed. */
function daysUntil(iso) {
  if (!iso) return null;
  const then = Date.UTC(...String(iso).slice(0, 10).split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
  const now = new Date();
  const today0 = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((then - today0) / 86400000);
}

function deadlineChip(o) {
  const d = daysUntil(o.offer_closes_on);
  if (d === null) return '';
  if (d < 0) return '<span class="opp-deadline closed">Offer closed</span>';
  if (d === 0) return '<span class="opp-deadline soon">Closes today</span>';
  return `<span class="opp-deadline ${d <= 7 ? 'soon' : ''}">Closes in ${d} day${d === 1 ? '' : 's'}</span>`;
}

const oppName = (o) =>
  `${o.insured_last_name || ''}${o.insured_first_name ? `, ${o.insured_first_name}` : ''}`.trim()
  || o.policy_number || 'Untitled opportunity';

/** The taken/remaining bar — the scarcity signal, straight from the data. */
function remainingBar(o) {
  const taken = Number(o.taken_pct) || 0;
  const remaining = Math.max(0, 100 - taken);
  const tight = remaining > 0 && remaining <= 25;
  return `
    <div>
      <div class="opp-remaining">
        <strong style="${remaining === 0 ? 'color:var(--text-muted)'
          : tight ? 'color:var(--serious)' : ''}">${
          remaining === 0 ? 'Fully spoken for' : `${fmtPct(remaining)} still available`}</strong>
        ${taken > 0 ? `<span class="muted">${fmtPct(taken)} taken</span>` : ''}
      </div>
      <div class="opp-bar ${tight ? 'urgent' : ''}"><span style="width:${Math.min(100, taken)}%"></span></div>
    </div>`;
}

const fmtPct = (v) => {
  const n = Number(v) || 0;
  return `${n % 1 ? n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : n}%`;
};

async function opportunitiesView() {
  const rows = await api('/opportunities');
  const staff = !isInvestorUser();
  const live = rows.filter((o) => o.status === 'Open');
  const passed = rows.filter((o) => o.status === 'Passed');
  const rest = rows.filter((o) => !['Open', 'Passed'].includes(o.status));
  const funded = rest.filter((o) => o.status === 'Funded');
  // What is live is the working list. A deal that has been funded is now a
  // policy and belongs in the portfolio, not on a marketplace; the rest are
  // decisions already taken. They stay one click away rather than in the way.
  const showAll = !!state.oppShowAll;
  const archived = rest.length + passed.length;

  const card = (o) => {
    const remaining = Math.max(0, 100 - (Number(o.taken_pct) || 0));
    const d = daysUntil(o.offer_closes_on);
    const urgent = o.status === 'Open' && ((d !== null && d >= 0 && d <= 7) || (remaining > 0 && remaining <= 25));
    const gone = o.status !== 'Open' || remaining === 0;
    return `
    <div class="opp-card ${o.status === 'Open' ? 'live' : ''} ${urgent ? 'urgent' : ''} ${gone ? 'gone' : ''} ${
      o.status === 'Passed' ? 'passed' : ''}"
         data-opp="${o.id}">
      <div class="opp-head">
        ${isAdminUser() ? `<label class="opp-tick" title="Choose for deletion">
          <input type="checkbox" data-opp-tick="${o.id}"
            aria-label="Select ${esc(oppName(o))}"
            ${state.oppSelected.has(o.id) ? 'checked' : ''}></label>` : ''}
        <div>
          <div class="opp-title">${esc(oppName(o))}</div>
          <div class="opp-sub">${esc(o.carrier_name || '—')}
            ${o.policy_number ? `· ${esc(o.policy_number)}` : ''}
            ${o.product_type ? `· ${esc(o.product_type)}` : ''}
            ${o.insured_dob ? `· age ${ageFrom(o.insured_dob) ?? '—'}` : ''}
            ${o.insured_state ? `· ${esc(o.insured_state)}` : ''}
            ${staff && o.fund_code ? `· ${esc(o.fund_code)}` : ''}</div>
        </div>
        <div class="spacer"></div>
        <div style="text-align:right">
          ${o.status === 'Open' ? deadlineChip(o)
            : `<span class="opp-deadline closed">${esc(o.status)}</span>`}
          ${staff ? `<div class="muted" style="font-size:12px;margin-top:6px">
            shared with ${o.shared_with ?? 0} investor${o.shared_with === 1 ? '' : 's'}</div>` : ''}
          ${o.my_pct ? `<div style="font-size:12px;margin-top:6px">
            <span class="badge inforce"><span class="dot"></span>You: ${fmtPct(o.my_pct)} ${esc(o.my_status || '')}</span>
          </div>` : ''}
        </div>
      </div>

      <div class="opp-figures">
        <div><div class="label">Death benefit</div>
          <div class="value">${fmtExact(o.face_amount)}</div></div>
        <div><div class="label">Asking price</div>
          <div class="value">${fmtExact(o.asking_price)}</div>
          <div class="note">${o.face_amount && o.asking_price
            ? `${(Number(o.asking_price) / Number(o.face_amount) * 100).toFixed(1)}% of face` : ''}</div></div>
        <div><div class="label">Return at life expectancy</div>
          <div class="value">${fmtRate(o.rate_at_le)}</div>
          <div class="note">${o.le_months ? `LE ${o.le_months} months` : 'no LE on file'}</div></div>
        <div><div class="label">Projected maturity</div>
          <div class="value" style="font-size:16px">${o.matures_on ? fmtDate(o.matures_on) : '—'}</div>
          <div class="note">at life expectancy</div></div>
      </div>

      <div style="padding:15px 20px">
        ${remainingBar(o)}
        <div style="margin-top:13px;display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn ${o.status === 'Open' && remaining > 0 ? 'btn-primary' : ''}"
             href="#/opportunity/${o.id}">${
            isInvestorUser()
              ? (o.my_pct ? 'Review your request' : remaining > 0 ? 'Look at this' : 'View details')
              : 'Open'}</a>
        </div>
      </div>
    </div>`;
  };

  const html = `
    <div class="page-head">
      <div><h1>Opportunities</h1>
        <div class="sub">${isInvestorUser()
          ? `${live.length} ${live.length === 1 ? 'offer is' : 'offers are'} open to you`
          : `${live.length} open · ${funded.length} funded${
              rest.length - funded.length ? ` · ${rest.length - funded.length} closed` : ''}${
              passed.length ? ` · ${passed.length} passed` : ''}`}</div></div>
      <div class="spacer"></div>
      ${staff && archived ? `<button id="oppShowAll" ${showAll ? 'class="active-toggle"' : ''}>${
        showAll ? 'Hide closed' : `Show all (${archived})`}</button>` : ''}
      ${canEditData() && !isInvestorUser()
        ? '<button class="primary" id="newOppBtn">New opportunity</button>' : ''}
    </div>

    ${/* Clearing a shelf is an administrator's act. A manager can still delete
          one at a time from its own page, which is the deliberate act this is
          not. */''}
    ${isAdminUser() && state.oppSelected.size ? `
    <div class="bulk-bar" id="oppBulkBar">
      <strong>${state.oppSelected.size} ${
        state.oppSelected.size === 1 ? 'opportunity' : 'opportunities'} selected</strong>
      ${(() => {
        const onScreen = [...live, ...(showAll ? [...rest, ...passed] : [])]
          .filter((o) => state.oppSelected.has(o.id)).length;
        const off = state.oppSelected.size - onScreen;
        return off > 0 ? `<span class="muted">${off} of them not on screen — showing and
          hiding the closed ones does not clear a selection</span>` : '';
      })()}
      <div class="spacer"></div>
      <button class="btn-sm" id="oppClearTicks">Clear selection</button>
      <button class="btn-danger" id="oppBulkDeleteBtn">Delete ${state.oppSelected.size} ${
        state.oppSelected.size === 1 ? 'opportunity' : 'opportunities'}</button>
    </div>` : ''}

    ${live.length === 0 ? `
      <div class="card"><div class="card-body"><div class="empty">
        ${isInvestorUser()
          ? 'Nothing is being offered to you right now. This is where new policies will appear.'
          : archived
            ? `Nothing is open at the moment. ${archived} ${archived === 1 ? 'deal has' : 'deals have'}
               been funded, closed or passed on — use <strong>Show all</strong> to see them.`
            : 'No opportunities yet. Create one and choose which investors get to see it.'}
      </div></div></div>` : ''}

    ${live.map(card).join('')}

    ${showAll && rest.length ? `<div class="eyebrow" style="margin:26px 0 6px;color:var(--text-muted)">
      No longer open</div>
      ${funded.length ? `<div class="muted" style="font-size:12.5px;margin-bottom:12px">
        ${funded.length === 1 ? 'One deal is' : `${funded.length} deals are`} funded — those policies
        are in the portfolio now, with the confirmed investors on the cap table.</div>` : ''}
      ${rest.map(card).join('')}` : ''}

    ${showAll && passed.length ? `<div class="eyebrow" style="margin:26px 0 6px;color:var(--text-muted)">
      Passed on</div>
      <div class="muted" style="font-size:12.5px;margin-bottom:12px">
        Kept on file and visible only to administrators. Open one and choose
        <strong>Reopen</strong> to put it back on everybody's list.</div>
      ${passed.map(card).join('')}` : ''}`;

  return {
    html,
    after: () => {
      $('#newOppBtn')?.addEventListener('click', () => openOpportunityDialog(null));
      $('#oppShowAll')?.addEventListener('click', () => {
        state.oppShowAll = !state.oppShowAll;
        render();
      });
      document.querySelectorAll('.opp-card').forEach((c) =>
        c.addEventListener('click', (e) => {
          // A tick is not a navigation. Without this, choosing a deal to
          // delete opens it instead.
          if (e.target.closest('a,button,.opp-tick')) return;
          go(`#/opportunity/${c.dataset.opp}`);
        }));
      /* Ticking re-renders, because the bar and the cards read from the same
         selection — patching one by hand is how it ends up saying something
         the other disagrees with. */
      document.querySelectorAll('[data-opp-tick]').forEach((box) =>
        box.addEventListener('change', () => {
          const id = Number(box.dataset.oppTick);
          if (box.checked) state.oppSelected.add(id); else state.oppSelected.delete(id);
          render();
        }));
      $('#oppClearTicks')?.addEventListener('click', () => {
        state.oppSelected.clear();
        render();
      });
      $('#oppBulkDeleteBtn')?.addEventListener('click', () => openBulkDeleteOppsDialog());
    },
  };
}

/* ------------------------- one opportunity --------------------------- */

async function opportunityView() {
  const o = await api(`/opportunities/${state.params.id}`);
  const staff = !isInvestorUser();
  const remaining = Math.max(0, 100 - (Number(o.taken_pct) || 0));
  const a = o.analysis;
  const mine = o.my_commitment;
  // What THIS investor may ask for. Their own live request is already
  // inside the taken figure, so it has to be added back — otherwise
  // somebody holding 82% appears unable to reduce it to 40%.
  const myHeld = mine && ['Requested', 'Confirmed'].includes(mine.status) ? Number(mine.pct) : 0;
  const myMax = Math.min(100, remaining + myHeld);
  /* The floor comes from the server rather than being written here, so the
     page can never state a minimum the API would then refuse — including on
     the last slice, where the floor drops to whatever is left. */
  const myMin = Math.min(Number(o.min_commitment_pct ?? MIN_TAKE_PCT), myMax);
  // The floor only drops below the standing minimum when that is all there is.
  const lastSlice = myMin < MIN_TAKE_PCT - 1e-9;
  const canTake = isInvestorUser() && o.status === 'Open'
    && (daysUntil(o.offer_closes_on) === null || daysUntil(o.offer_closes_on) >= 0);

  /* An investor working out whether to take a slice needs the figures at
     that slice, not at 100% — the whole point of typing 25 is to find out
     what 25 costs. Money cells carry their full-policy value in
     `data-full` and are restated the moment the percentage changes, so
     the schedule, the scenarios and the outlay all move together and
     none of them can be left describing a different share from the
     others. Dates, years, multiples and the rate are not scaled: they do
     not depend on how much of the policy you own. */
  const shareCell = (full, cls = '') => `<td class="num ${cls}" data-full="${Number(full) || 0}"
    >${fmtExact(full)}</td>`;

  const scenarioTable = () => {
    if (!a.priced) return `<div class="empty">
      An asking price and death benefit are needed before a return can be worked out.</div>`;
    const cell = (s, fn) => `<td class="num ${s.offset_months === 0 ? 'at-le' : ''}">${fn(s)}</td>`;
    return `
      <div class="table-wrap"><table class="data scenario-table">
        <thead><tr><th></th>
          ${a.scenarios.map((s) => `<th class="num ${s.offset_months === 0 ? 'at-le' : ''}">${
            s.offset_months === 0 ? 'At life expectancy'
              : s.offset_months < 0 ? `${-s.offset_months} months early`
              : `${s.offset_months} months late`}</th>`).join('')}
        </tr></thead>
        <tbody>
          <tr><td class="strong">Maturity date</td>
            ${a.scenarios.map((s) => cell(s, (x) => fmtDate(x.matures_on))).join('')}</tr>
          <tr><td class="strong">Years held</td>
            ${a.scenarios.map((s) => cell(s, (x) => x.years.toFixed(1))).join('')}</tr>
          <tr><td class="strong">Premiums paid</td>
            ${a.scenarios.map((s) => shareCell(s.premiums_paid,
              s.offset_months === 0 ? 'at-le' : '')).join('')}</tr>
          <tr><td class="strong">Total invested</td>
            ${a.scenarios.map((s) => shareCell(s.invested,
              s.offset_months === 0 ? 'at-le' : '')).join('')}</tr>
          <tr><td class="strong">Profit</td>
            ${a.scenarios.map((s) => shareCell(s.profit,
              s.offset_months === 0 ? 'at-le' : '')).join('')}</tr>
          <tr><td class="strong">Multiple</td>
            ${a.scenarios.map((s) => cell(s, (x) => `${x.multiple.toFixed(2)}×`)).join('')}</tr>
          <tr><td class="strong">Return</td>
            ${a.scenarios.map((s) => `<td class="num strong ${s.offset_months === 0 ? 'at-le' : ''}"
              style="font-size:16px">${fmtRate(s.rate)}</td>`).join('')}</tr>
        </tbody>
      </table></div>`;
  };

  const projected = a.scenarios.some((s) => s.projected_beyond_schedule > 0);

  const html = `
    <div class="page-head">
      <div>
        <div class="sub"><a href="#/opportunities">← All opportunities</a></div>
        <h1>${esc(oppName(o))}</h1>
        <div class="sub">${esc(o.carrier_name || '—')}
          ${o.policy_number ? `· Policy ${esc(o.policy_number)}` : ''}
          ${o.product_type ? `· ${esc(o.product_type)}` : ''}
          ${staff && o.fund_code ? `· ${esc(o.fund_code)}` : ''}
          · ${o.status === 'Open' ? deadlineChip(o) : `<span class="opp-deadline closed">${esc(o.status)}</span>`}</div>
      </div>
      <div class="spacer"></div>
      ${staff && canEditData() ? `
        <button id="editOppBtn">Edit</button>
        <button id="scheduleBtn">Premium schedule</button>
        <button id="sheetBtn">One-pager</button>
        <button id="shareOppBtn">Share with investors</button>
        ${o.status === 'Passed'
          ? '<button id="reopenOppBtn">Reopen</button>'
          : o.status === 'Funded' ? ''
            : '<button id="passOppBtn">Pass</button>'}
        ${['admin', 'manager'].includes(state.user.role) && o.status !== 'Funded'
          ? '<button class="primary" id="fundOppBtn">Fund it</button>' : ''}
        ${['admin', 'manager'].includes(state.user.role) && o.status === 'Funded'
          ? '<button id="unfundOppBtn">Send back to opportunities</button>' : ''}
        ${['admin', 'manager'].includes(state.user.role)
          ? '<button class="btn-danger" id="deleteOppBtn">Delete</button>' : ''}` : ''}
    </div>

    <div class="opp-card ${o.status === 'Open' ? 'live' : ''}" style="margin-bottom:22px">
      <div class="opp-figures">
        <div><div class="label">Death benefit</div><div class="value">${fmtExact(o.face_amount)}</div></div>
        <div><div class="label">Asking price</div><div class="value">${fmtExact(o.asking_price)}</div>
          <div class="note">${o.face_amount && o.asking_price
            ? `${(Number(o.asking_price) / Number(o.face_amount) * 100).toFixed(1)}% of face` : ''}</div></div>
        <div><div class="label">Life expectancy</div>
          <div class="value">${o.le_months ? `${o.le_months} mo` : '—'}</div>
          <div class="note">${o.le_provider ? `${esc(o.le_provider)} · ` : ''}${
            o.le_date ? `report ${fmtDate(o.le_date)}` : ''}</div></div>
        <div><div class="label">Insured</div>
          <div class="value" style="font-size:16px">${ageFrom(o.insured_dob) ?? '—'}${
            o.insured_gender ? ` · ${esc(o.insured_gender)}` : ''}</div>
          <div class="note">${o.insured_dob ? `born ${fmtDate(o.insured_dob)}` : ''}${
            o.insured_state ? ` · ${esc(o.insured_state)}` : ''}</div></div>
        <div><div class="label">Expected close</div>
          <div class="value" style="font-size:16px">${o.expected_close ? fmtDate(o.expected_close) : '—'}</div></div>
      </div>
      <div style="padding:16px 20px">${remainingBar(o)}</div>

      ${canTake && myMax > 0 ? `
      <div class="opp-take">
        <div class="field-row">
          <div class="field" style="margin:0;max-width:260px">
            <label>Percentage you want</label>
            <input type="number" id="takePct" step="0.01" min="${myMin}" max="${myMax}"
              value="${mine ? Number(mine.pct) : ''}"
              placeholder="${fmtPct(myMin)} to ${fmtPct(myMax)}">
            <span class="muted" style="font-size:12px">${lastSlice
              ? `Only ${fmtPct(myMax)} is left, and the last slice is taken whole.`
              : `Minimum ${fmtPct(myMin)}, up to ${fmtPct(myMax)}.`}${
              myHeld ? ` You hold ${fmtPct(myHeld)}; changing this replaces it.` : ''}</span>
          </div>
          <div class="take-figures">
            <div><div class="label">Purchase price</div>
              <div class="value" id="takeCost">—</div></div>
            <div><div class="label">Premiums to life expectancy</div>
              <div class="value" id="takePremiums">—</div></div>
            <div><div class="label">Total outlay</div>
              <div class="value strong" id="takeOutlay">—</div></div>
            <div><div class="label">Profit at life expectancy</div>
              <div class="value" id="takeProfit">—</div></div>
          </div>
        </div>
        <div class="take-go">
          <button class="primary" id="takeBtn">${
            mine && mine.status === 'Requested' ? 'Update your request' : 'Request this share'}</button>
          <span class="muted" style="font-size:12px">
            Every figure on this page — the premium schedule, the scenarios and the outlay above
            — restates at the percentage you type, before you request anything.
            A request then holds that percentage straight away, so what other investors see as
            available drops immediately. It becomes an allocation once Poel Capital confirms it.
            The return is not affected by how much you take — a rate has no size.
          </span>
        </div>
        <div id="takeMsg" style="margin-top:10px"></div>
      </div>` : ''}

      ${mine ? `
      <div class="opp-take">
        <strong>Your request: ${fmtPct(mine.pct)} · ${esc(mine.status)}</strong>
        <div class="muted" style="font-size:12.5px;margin-top:4px">
          ${mine.status === 'Requested'
            ? 'Waiting on Poel Capital to confirm. You can change or withdraw it until then.'
            : mine.status === 'Confirmed'
              ? 'Confirmed. This will appear in your portfolio once the policy is funded.'
              : mine.status === 'Declined'
                ? 'This request was declined.' : 'You withdrew this request.'}
        </div>
        ${mine.status === 'Requested'
          ? '<button class="btn-sm btn-danger" id="withdrawBtn" style="margin-top:10px">Withdraw my request</button>' : ''}
      </div>` : ''}
    </div>

    ${isInvestorUser() ? `
    <div class="share-banner" id="shareBanner">
      Figures below are for the <strong>whole policy</strong>.</div>` : ''}

    <div class="card">
      <div class="card-head"><h2>Return if the insured lives to…</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">life expectancy, and two years either side</span></div>
      <div class="card-body flush">${scenarioTable()}</div>
      <div class="card-body">
        <span class="muted" style="font-size:12px">
          Life expectancy is a median, not a promise — around half of insureds outlive it, and
          every extra month is another premium paid and another month of waiting. That is why
          the late column is here: it is the case worth underwriting against.
          ${a.le_from ? `The estimate runs from ${fmtDate(a.le_from)}, the date of the LE report,
          not from today.` : ''}
          ${projected ? 'Premiums beyond the posted schedule are continued at the same annual rate.' : ''}
          The return is simple interest over actual days — no compounding — the same
          convention the operating agreements use.
        </span>
      </div>
    </div>

    ${staff && (o.account_value != null || o.cash_surrender_value != null) ? `
    <div class="card">
      <div class="card-head"><h2>Carrier values</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">${o.values_as_of
          ? `as of ${fmtDate(o.values_as_of)}` : 'date not stated'}</span></div>
      <div class="card-body"><dl class="kv">
        <dt>Account value</dt><dd class="num">${o.account_value == null
          ? '<span class="muted">—</span>' : fmtExact(o.account_value)}</dd>
        <dt>Cash surrender value</dt><dd class="num">${o.cash_surrender_value == null
          ? '<span class="muted">—</span>' : fmtExact(o.cash_surrender_value)}</dd>
        ${o.cash_surrender_value && o.asking_price ? `
        <dt>Asking price over surrender</dt>
        <dd class="num">${fmtExact(Number(o.asking_price) - Number(o.cash_surrender_value))}
          <span class="muted">${(Number(o.asking_price) / Number(o.cash_surrender_value)).toFixed(1)}×</span></dd>` : ''}
        ${o.account_value && o.annual_premium ? `
        <dt>Account value covers</dt>
        <dd class="num">${(Number(o.account_value) / (Number(o.annual_premium) / 12)).toFixed(1)}
          <span class="muted">months of premium</span></dd>` : ''}
      </dl></div>
      <div class="card-body" style="border-top:1px solid var(--grid)">
        <span class="muted" style="font-size:12.5px">Surrender value is what the seller could
        take from the carrier today, so a price near it is a price the seller can refuse.
        Internal — investors do not see this card.</span>
      </div>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h2>Premium schedule</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">${o.premiums.length} posted payment${
          o.premiums.length === 1 ? '' : 's'}</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Due</th><th class="num">Amount</th>${
          isInvestorUser() ? '<th class="num">Your share</th>' : ''}<th>Notes</th>
          ${staff && canEditData() ? '<th></th>' : ''}</tr></thead>
        <tbody>${o.premiums.length === 0
          ? `<tr><td colspan="5"><div class="empty">No schedule posted.${
              o.annual_premium ? ` The analysis assumes ${fmtExact(o.annual_premium)} a year.` : ''}</div></td></tr>`
          : o.premiums.map((p) => `<tr>
              <td class="strong">${fmtDate(p.due_date)}</td>
              <td class="num">${fmtExact(p.amount)}</td>
              ${isInvestorUser()
                ? shareCell(p.amount).replace('<td class="num "', '<td class="num strong"') : ''}
              <td class="secondary">${esc(p.notes || '')}</td>
              ${staff && canEditData()
                ? `<td style="white-space:nowrap">
                     <button class="btn-sm" data-edit-prem="${p.id}">Edit</button>
                     <button class="btn-sm btn-danger" data-del-prem="${p.id}">Remove</button></td>` : ''}
            </tr>`).join('')}</tbody>
        ${o.premiums.length ? `<tfoot><tr><td>Total posted</td>
          <td class="num">${fmtExact(o.premiums.reduce((s, p) => s + Number(p.amount), 0))}</td>
          ${isInvestorUser()
            ? shareCell(o.premiums.reduce((s, p) => s + Number(p.amount), 0)) : ''}
          <td></td>${staff && canEditData() ? '<td></td>' : ''}
        </tr></tfoot>` : ''}
      </table></div>
    </div>

    ${(o.impairments || o.mitigating || o.underwriter_note) ? `
    <div class="card">
      <div class="card-head"><h2>Life expectancy and the medical picture</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">${
          [o.le_provider && `${esc(o.le_provider)} ${o.le_months || '—'} mo`,
           o.le_months_2 && `${esc(o.le_provider_2 || 'second report')} ${o.le_months_2} mo`]
            .filter(Boolean).join(' · ')}${
          o.records_through ? ` · records through ${fmtDate(o.records_through)}` : ''}</span></div>
      <div class="card-body">
        <div class="grid-2">
          <div>
            ${o.impairments ? `<div class="eyebrow" style="color:var(--text-muted);margin-bottom:8px"
              >Factors driving mortality</div>${oppBullets(o.impairments)}` : ''}
            ${o.mitigating ? `<div class="eyebrow" style="color:var(--text-muted);margin:16px 0 8px"
              >Mitigating factors</div>${oppBullets(o.mitigating)}` : ''}
          </div>
          <div>
            ${o.underwriter_note ? `<div class="opp-callout">
              <div class="eyebrow" style="color:var(--text-muted);margin-bottom:8px">Underwriter assessment</div>
              <div style="font-size:13.5px;line-height:1.6;white-space:pre-wrap">${esc(o.underwriter_note)}</div>
            </div>` : ''}
            ${o.le_months_2 ? `<div class="muted" style="font-size:12.5px;line-height:1.6;margin-top:14px">
              Two independent life-expectancy reports are on file
              (${esc(o.le_provider || 'first')} ${o.le_months || '—'} months,
              ${esc(o.le_provider_2 || 'second')} ${o.le_months_2} months). The analysis above runs
              on ${o.le_months || '—'} months. Reports that agree are worth more than one that
              simply sounds good.</div>` : ''}
          </div>
        </div>
      </div>
    </div>` : ''}

    ${o.thesis ? `<div class="card">
      <div class="card-head"><h2>Investment case</h2></div>
      <div class="card-body">${oppBullets(o.thesis)}</div>
    </div>` : ''}

    ${o.notes ? `<div class="card"><div class="card-head"><h2>Notes</h2></div>
      <div class="card-body"><div style="font-size:14px;white-space:pre-wrap">${esc(o.notes)}</div></div></div>` : ''}

    ${staff ? `
    <div class="card">
      <div class="card-head"><h2>Investor interest</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">${fmtPct(o.taken_pct)} spoken for ·
          ${fmtPct(o.confirmed_pct)} confirmed</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Investor</th><th class="num">Share</th><th class="num">Cost</th>
          <th>Status</th><th>Requested</th>${canEditData() ? '<th></th>' : ''}</tr></thead>
        <tbody>${(o.commitments || []).length === 0
          ? '<tr><td colspan="6"><div class="empty">Nobody has asked for a piece yet.</div></td></tr>'
          : o.commitments.map((c) => `<tr class="${['Declined', 'Withdrawn'].includes(c.status) ? 'row-muted' : ''}">
              <td class="strong">${esc(c.investor_name)}</td>
              <td class="num">${fmtPct(c.pct)}</td>
              <td class="num">${fmtExact(Number(o.asking_price || 0) * Number(c.pct) / 100)}</td>
              <td>${c.status === 'Confirmed'
                    ? '<span class="badge inforce"><span class="dot"></span>Confirmed</span>'
                    : c.status === 'Requested'
                      ? '<span class="badge grace"><span class="dot"></span>Requested</span>'
                      : `<span class="badge">${esc(c.status)}</span>`}</td>
              <td class="muted">${new Date(c.requested_at).toLocaleDateString('en-US')}</td>
              ${canEditData() ? `<td style="white-space:nowrap">${c.status === 'Requested'
                ? `<button class="btn-sm primary" data-decide="${c.id}" data-to="Confirmed">Confirm</button>
                   <button class="btn-sm" data-decide="${c.id}" data-to="Declined">Decline</button>` : ''}</td>` : ''}
            </tr>`).join('')}</tbody>
      </table></div>
      <div class="card-body" style="border-top:1px solid var(--grid)">
        <span class="muted" style="font-size:12px">
          A request holds its percentage from the moment it is made, so the availability
          investors see is always honest. Declining one releases it back.
        </span>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Shared with</h2><div class="spacer"></div>
        ${canEditData() ? '<button class="btn-sm" id="shareOppBtn2">Change who can see this</button>' : ''}</div>
      ${(o.shares || []).length === 0
        ? '<div class="card-body"><div class="empty">Not shared with anybody yet — no investor can see this.</div></div>'
        : `<div class="table-wrap"><table class="data">
            <thead><tr><th>Investor</th><th>Shared on</th><th>Shared by</th><th>Asked for</th></tr></thead>
            <tbody>${o.shares.map((sh) => {
              const c = (o.commitments || []).filter((x) => x.investor_id === sh.investor_id
                && !['Declined', 'Withdrawn'].includes(x.status));
              const took = c.reduce((sum, x) => sum + Number(x.pct || 0), 0);
              return `<tr>
                <td class="strong">${esc(sh.name)}</td>
                <td>${fmtDateTime(sh.shared_at)}</td>
                <td class="secondary">${esc(sh.shared_by_name || '—')}</td>
                <td class="${took ? '' : 'muted'}">${took ? fmtPct(took) : 'nothing yet'}</td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`}
    </div>` : ''}`;

  return {
    html,
    after: () => {
      $('#editOppBtn')?.addEventListener('click', () => openOpportunityDialog(o));
      $('#scheduleBtn')?.addEventListener('click', () => openScheduleDialog(o));
      $('#sheetBtn')?.addEventListener('click', () => openSheetDialog(o));
      $('#passOppBtn')?.addEventListener('click', () => openPassDialog(o));
      $('#deleteOppBtn')?.addEventListener('click', () => openDeleteOppDialog(o));
      $('#reopenOppBtn')?.addEventListener('click', async () => {
        await api(`/opportunities/${o.id}`, { method: 'PUT', body: { status: 'Open' } });
        toast('Back on the list'); render();
      });
      $('#shareOppBtn')?.addEventListener('click', () => openShareDialog(o));
      $('#shareOppBtn2')?.addEventListener('click', () => openShareDialog(o));
      $('#fundOppBtn')?.addEventListener('click', () => {
        openFundDialog(o).catch((e) => alert(e.message));
      });
      $('#unfundOppBtn')?.addEventListener('click', () => {
        openReopenDialog(o).catch((e) => alert(e.message));
      });

      document.querySelectorAll('[data-del-prem]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/opportunity-premiums/${b.dataset.delPrem}`, { method: 'DELETE' });
          toast('Payment removed'); render();
        }));

      document.querySelectorAll('[data-edit-prem]').forEach((b) =>
        b.addEventListener('click', () => {
          const p = o.premiums.find((x) => String(x.id) === b.dataset.editPrem);
          if (p) openPremiumDialog(o, p);
        }));

      document.querySelectorAll('[data-decide]').forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await api(`/opportunity-commitments/${b.dataset.decide}`,
              { method: 'PUT', body: { status: b.dataset.to } });
            toast(b.dataset.to === 'Confirmed' ? 'Allocation confirmed' : 'Request declined');
            render();
          } catch (err) { alert(err.message); }
        }));

      /* Restate the page at whatever percentage is in the box.
         Every money figure that depends on the size of the position is
         marked with its full-policy value, so one function moves the
         schedule, the scenarios and the outlay together — there is no
         way for one of them to be left showing a different share. */
      const scaled = document.querySelectorAll('[data-full]');
      const banner = $('#shareBanner');
      const applyShare = (pct) => {
        const factor = pct > 0 ? pct / 100 : 1;
        scaled.forEach((td) => {
          td.textContent = fmtExact(Number(td.dataset.full) * factor);
          td.classList.toggle('at-my-share', pct > 0);
        });
        if (banner) {
          banner.innerHTML = pct > 0
            ? `Every figure below is <strong>your ${fmtPct(pct)}</strong> of this policy${
                myHeld && Math.abs(pct - myHeld) < 1e-9 ? ', the share you hold' : ''}.`
            : 'Figures below are for the <strong>whole policy</strong>. '
              + 'Enter the percentage you want above and they restate as your share.';
          banner.classList.toggle('at-share', pct > 0);
        }
      };

      // Live cost as the investor types a percentage.
      const pctEl = $('#takePct');
      if (pctEl) {
        const base = a.base;
        /* Below the minimum the figures still restate — somebody typing 4 to
           see what 4 would cost should see it — but the request is refused,
           and the refusal says so before they click rather than after. */
        const tooSmall = (pct) => pct > 0 && pct < myMin - 1e-9;
        const recalc = () => {
          const pct = Number(pctEl.value);
          const ok = pct > 0 && pct <= myMax + 1e-9;
          const at = (v) => (ok ? fmtExact(Number(v || 0) * pct / 100) : '—');
          $('#takeCost').textContent = at(o.asking_price);
          $('#takePremiums').textContent = base ? at(base.premiums_paid) : '—';
          $('#takeOutlay').textContent = base ? at(base.invested) : '—';
          $('#takeProfit').textContent = base ? at(base.profit) : '—';
          applyShare(ok ? pct : 0);
          $('#takeBtn').disabled = !ok || tooSmall(pct);
          $('#takeMsg').innerHTML = pct > myMax + 1e-9
            ? `<div class="error-box">Only ${fmtPct(myMax)} is available to you${
                myHeld ? `, including the ${fmtPct(myHeld)} you already hold` : ''}.</div>`
            : tooSmall(pct)
              ? `<div class="error-box">${lastSlice
                  ? `Only ${fmtPct(myMax)} is left, and the last slice has to be taken whole — ask for ${fmtPct(myMin)}.`
                  : `The smallest share we can take is ${fmtPct(myMin)}.`}</div>`
              : '';
        };
        pctEl.addEventListener('input', recalc);
        recalc();

        $('#takeBtn').addEventListener('click', async () => {
          const pct = Number(pctEl.value);
          if (!pct || pct <= 0) { $('#takeMsg').innerHTML = '<div class="error-box">Enter a percentage.</div>'; return; }
          if (pct < myMin - 1e-9) { recalc(); return; }
          try {
            await api(`/opportunities/${o.id}/commit`, { method: 'POST', body: { pct } });
            toast(`Requested ${fmtPct(pct)}`);
            refreshOppCount();
            render();
          } catch (err) {
            $('#takeMsg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
          }
        });
      } else if (isInvestorUser()) {
        // No box to type in — they already hold a confirmed slice, or the
        // offer has closed. Show the page at whatever they actually have.
        applyShare(myHeld);
      }

      $('#withdrawBtn')?.addEventListener('click', async () => {
        if (!confirm('Withdraw your request for this opportunity?')) return;
        try {
          await api(`/opportunities/${o.id}/commit`, { method: 'DELETE' });
          toast('Request withdrawn');
          refreshOppCount();
          render();
        } catch (err) { alert(err.message); }
      });
    },
  };
}

/* --------------------------- opportunity dialogs --------------------- */

async function openOpportunityDialog(o) {
  if (!state.funds.length) { try { state.funds = await api('/funds'); } catch { /* scoped out */ } }
  const isNew = !o?.id;
  /* Filled in by the reader below, posted after the opportunity exists —
     a schedule has nowhere to attach until then. */
  let readPremiums = [];
  const dlg = openDialog(isNew ? 'New opportunity' : `Edit ${oppName(o)}`, `
    ${isNew ? `
    <div class="read-drop" id="readDrop">
      <input type="file" id="readFiles" accept="application/pdf,.pdf" multiple hidden>
      <div class="read-drop-face" id="readFace">
        <strong>Read it off the documents</strong>
        <span>Drop the illustration and any life-expectancy reports here, or
          <button type="button" class="btn-link" id="readBrowse">choose files</button>.
          They are read, the form below fills in, and the files are discarded.</span>
      </div>
      <div class="read-drop-busy" id="readBusy" hidden>
        <span class="read-spin"></span>
        <span id="readBusyText">Reading…</span>
      </div>
      <div id="readOut"></div>
    </div>` : ''}
    <div class="field-row">
      ${inputField('Policy number', 'policy_number', o?.policy_number)}
      ${inputField('Carrier', 'carrier_name', o?.carrier_name)}
      ${selectField('Product type', 'product_type', o?.product_type || '', PRODUCT_TYPES)}
    </div>
    <div class="field-row">
      ${inputField('Insured last name *', 'insured_last_name', o?.insured_last_name, 'text', 'required')}
      ${inputField('First name', 'insured_first_name', o?.insured_first_name)}
      ${inputField('Date of birth', 'insured_dob', dateInput(o?.insured_dob), 'date')}
    </div>
    <div class="field-row">
      ${selectField('Gender', 'insured_gender', o?.insured_gender || '', ['', 'M', 'F', 'Joint'])}
      ${stateField('State', 'insured_state', o?.insured_state)}
      ${inputField('Life expectancy (months)', 'le_months', o?.le_months, 'number')}
    </div>
    <div class="field-row">
      ${inputField('LE provider', 'le_provider', o?.le_provider)}
      ${inputField('LE report date', 'le_date', dateInput(o?.le_date), 'date')}
      ${moneyField('Death benefit', 'face_amount', o?.face_amount)}
    </div>
    <div class="field" style="margin-top:-4px"><span class="muted" style="font-size:12px">
      Life expectancy is counted from the report date, not from today — an estimate written
      two years ago has already used two years of itself.</span></div>
    <div class="field-row">
      ${moneyField('Asking price', 'asking_price', o?.asking_price)}
      ${moneyField('Annual premium', 'annual_premium', o?.annual_premium)}
      <div class="field"><label>Owner entity</label>
        <select name="fund_id">
          <option value="">—</option>
          ${state.funds.map((f) => `<option value="${f.id}" ${
            Number(o?.fund_id) === Number(f.id) ? 'selected' : ''}>${esc(f.code)}</option>`).join('')}
        </select></div>
    </div>
    <div class="field-row">
      ${moneyField('Account value', 'account_value', o?.account_value)}
      ${moneyField('Cash surrender value', 'cash_surrender_value', o?.cash_surrender_value)}
      ${inputField('Carrier values as of', 'values_as_of', dateInput(o?.values_as_of), 'date')}
    </div>
    <div class="field" style="margin-top:-4px"><span class="muted" style="font-size:12px">
      From the carrier's current statement. Account value is what keeps the policy in force;
      cash surrender value is what the seller would get for walking away, which is the floor
      under any price worth discussing.</span></div>
    <div class="field-row">
      ${inputField('Expected close', 'expected_close', dateInput(o?.expected_close), 'date')}
      ${inputField('Offer closes on', 'offer_closes_on', dateInput(o?.offer_closes_on), 'date')}
      ${isNew ? '' : selectField('Status', 'status', o?.status || 'Open', OPP_STATUSES)}
    </div>
    <div class="field"><label>Notes for investors</label>
      <textarea name="notes" rows="3">${esc(o?.notes || '')}</textarea></div>

    <div class="dlg-section">For the one-pager</div>
    <div class="field-row">
      ${inputField('Second LE provider', 'le_provider_2', o?.le_provider_2)}
      ${inputField('Second LE (months)', 'le_months_2', o?.le_months_2, 'number')}
      ${inputField('Medical records through', 'records_through', dateInput(o?.records_through), 'date')}
    </div>
    <div class="field"><label>Medical factors behind the life expectancy</label>
      <textarea name="impairments" rows="5" placeholder="One per line — Cardiovascular: CAD s/p 5 stents (2023)…">${esc(o?.impairments || '')}</textarea>
      <span class="muted" style="font-size:12px">One bullet per line. Printed as written.</span></div>
    <div class="field"><label>Mitigating factors</label>
      <textarea name="mitigating" rows="3" placeholder="One per line">${esc(o?.mitigating || '')}</textarea></div>
    <div class="field"><label>Underwriter assessment</label>
      <textarea name="underwriter_note" rows="3">${esc(o?.underwriter_note || '')}</textarea></div>
    <div class="field"><label>Investment case</label>
      <textarea name="thesis" rows="5" placeholder="One per line">${esc(o?.thesis || '')}</textarea>
      <span class="muted" style="font-size:12px">
        These four boxes are judgements, so they are printed exactly as typed and never
        generated. The price, premiums, life expectancy and every rate on the sheet come
        from the record itself.</span></div>
  `, async (v) => {
    if (v.fund_id === '') delete v.fund_id;
    if (isNew) {
      const made = await api('/opportunities', { method: 'POST', body: v });
      /* The illustration's ledger, as the schedule the one-pager prints.
         Failing here must not lose the opportunity that was just created —
         the schedule can be posted again from its own dialog. */
      if (readPremiums.length) {
        try {
          await api(`/opportunities/${made.id}/premium-schedule`,
            { method: 'POST', body: { rows: readPremiums } });
        } catch (e) {
          toast(`Created, but the premium schedule did not save: ${e.message}`);
        }
      }
      toast(readPremiums.length
        ? `Opportunity created with ${readPremiums.length} scheduled payment${
          readPremiums.length === 1 ? '' : 's'}`
        : 'Opportunity created');
      go(`#/opportunity/${made.id}`);
    } else {
      await api(`/opportunities/${o.id}`, { method: 'PUT', body: v });
      toast('Opportunity updated');
    }
  }, isNew ? 'Create' : 'Save');

  if (isNew) wireDocumentReader(dlg, (rows) => { readPremiums = rows; });
}

/**
 * The document reader on the New opportunity dialog.
 *
 * Everything it fills is an ordinary form field afterwards: nothing is
 * locked, nothing is submitted, and a value it could not find is left
 * blank rather than guessed at, so what still needs a person is visible.
 */
function wireDocumentReader(dlg, onPremiums) {
  const zone = $('#readDrop', dlg);
  if (!zone) return;
  const input = $('#readFiles', dlg);
  const face = $('#readFace', dlg);
  const busy = $('#readBusy', dlg);
  const busyText = $('#readBusyText', dlg);
  const out = $('#readOut', dlg);

  const setField = (name, value) => {
    const el = dlg.querySelector(`[name="${name}"]`);
    if (!el || value === undefined || value === null || value === '') return false;
    if (el.tagName === 'SELECT') {
      /* A product type or a state the list has never seen still belongs on
         the form — as its own option, so it is visible and correctable
         rather than silently dropped back to blank. */
      if (![...el.options].some((op) => op.value === String(value)))
        el.add(new Option(String(value), String(value)));
      el.value = String(value);
    } else if (el.hasAttribute('data-money')) {
      el.value = groupDigits(String(value));
    } else {
      el.value = String(value);
    }
    el.classList.add('field-read');
    return true;
  };

  const read = async (fileList) => {
    const chosen = [...fileList].filter((f) => /\.pdf$/i.test(f.name));
    if (!chosen.length) {
      out.innerHTML = '<div class="error-box">Only PDFs can be read.</div>';
      return;
    }
    face.hidden = true; busy.hidden = false; out.innerHTML = '';
    busyText.textContent = `Reading ${chosen.length} document${chosen.length === 1 ? '' : 's'}…`;
    /* A long illustration is minutes, and a progress bar that lies is worse
       than none — so the wait says what it is doing and how long it takes. */
    const started = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      busyText.textContent = `Reading ${chosen.length} document${
        chosen.length === 1 ? '' : 's'}… ${s}s — a long illustration takes a minute or two.`;
    }, 1000);

    const body = new FormData();
    for (const f of chosen) body.append('files', f, f.name);
    try {
      const got = await api('/opportunities/extract', { method: 'POST', body });
      const filled = Object.entries(got.fields || {})
        .filter(([k, v]) => setField(k, v)).length;
      onPremiums(got.premiums || []);
      out.innerHTML = readSummary(got, filled);
    } catch (e) {
      out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    } finally {
      clearInterval(tick);
      busy.hidden = true; face.hidden = false;
      input.value = '';
    }
  };

  $('#readBrowse', dlg)?.addEventListener('click', () => input.click());
  input.addEventListener('change', () => input.files.length && read(input.files));
  for (const ev of ['dragenter', 'dragover'])
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); });
  for (const ev of ['dragleave', 'drop'])
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files;
    if (f?.length) read(f);
  });
}

/** What was read, said plainly enough to check against the paperwork. */
function readSummary(got, filled) {
  const ROLE = {
    illustration: 'in-force illustration', contract: 'policy contract',
    statement: 'carrier statement', le_report: 'life-expectancy report', other: 'not recognised',
  };
  const files = (got.read || []).map((fn) => `<li><strong>${esc(fn)}</strong>
    <span class="muted">— ${esc(ROLE[got.roles?.[fn]] || 'read')}</span></li>`).join('');
  const les = (got.le_reports || []).map((r) => `<li>${esc(r.provider || 'LE report')}
    — ${esc(String(r.mean_le50_months || '?'))} months${
    r.report_date ? `, report ${esc(String(r.report_date))}` : ''}</li>`).join('');
  return `
    <div class="read-result">
      <div class="read-result-head">${filled} field${filled === 1 ? '' : 's'} filled in${
        got.premiums?.length ? ` · ${got.premiums.length} premium payments scheduled` : ''}</div>
      ${files ? `<ul class="read-list">${files}</ul>` : ''}
      ${les ? `<div class="read-sub">Life expectancy</div><ul class="read-list">${les}</ul>` : ''}
      ${got.notes ? `<div class="read-note">${esc(got.notes)}</div>` : ''}
      <div class="read-check">Check every figure against the documents before you post it.
        The price is not read from anything — it is what you agreed.</div>
    </div>`;
}

/** Months added to a YYYY-MM-DD date, clamped to the end of the month. */
function addMonthsIso(iso, months) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/**
 * The premium schedule, entered a year at a time.
 *
 * A carrier illustration does not step up smoothly — cost of insurance rises
 * with age, the policy is optimised somewhere in the middle, and the numbers
 * jump. No single growth rate reproduces that, so every year is its own field
 * and gets typed as it is written. The fill button is there for the common
 * case where the early years really are level; it only ever writes into the
 * boxes, which are then yours to correct.
 */
/** One bullet per line — the same text the one-pager prints, on screen. */
function oppBullets(text) {
  const items = String(text || '')
    .split('\n').map((l) => l.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean);
  return items.length
    ? `<ul class="opp-bullets">${items.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
}

function openScheduleDialog(o) {
  const start = dateInput(o.premiums?.[0]?.due_date) || dateInput(o.expected_close) || today();
  const seed = (o.premiums || []).length
    ? o.premiums.map((p) => ({ due: dateInput(p.due_date), amount: Number(p.amount), notes: p.notes || '' }))
    : Array.from({ length: 10 }, (_, n) => ({
        due: addMonthsIso(start, 12 * n),
        amount: Number(o.annual_premium) || '',
        notes: '',
      }));

  const rowHtml = (r) => `
    <tr class="prem-row">
      <td class="prem-year"></td>
      <td><input type="date" class="prem-due" value="${esc(r.due || '')}" required></td>
      <td><input type="text" inputmode="decimal" data-money class="prem-amt num"
                 value="${r.amount === '' || r.amount == null ? '' : esc(groupDigits(String(r.amount)))}"
                 placeholder="0.00" autocomplete="off"></td>
      <td><input type="text" class="prem-note" value="${esc(r.notes || '')}" placeholder="optional"></td>
      <td><button type="button" class="btn-sm btn-danger prem-del" title="Remove this year">✕</button></td>
    </tr>`;

  const dlg = openDialog('Premium schedule', `
    <div class="prem-grid">
      <table class="data">
        <thead><tr><th style="width:56px">Year</th><th style="width:150px">Due</th>
          <th class="num" style="width:130px">Amount</th><th>Notes</th><th style="width:44px"></th></tr></thead>
        <tbody id="premRows">${seed.map(rowHtml).join('')}</tbody>
        <tfoot><tr><td colspan="2" class="strong">Total</td>
          <td class="num strong" id="premTotal">—</td><td colspan="2"></td></tr></tfoot>
      </table>
    </div>
    <div class="prem-tools">
      <button type="button" class="btn-sm" id="premAdd">Add a year</button>
      <div class="spacer"></div>
      <label class="prem-fill">Fill blanks from year one, rising
        <input type="number" step="0.1" id="premGrowth" value="0" style="width:64px"> % a year
        <button type="button" class="btn-sm" id="premFill">Fill</button>
      </label>
    </div>
    <span class="muted" style="font-size:12px">
      Every payment is written exactly as entered — nothing is rounded or interpolated on
      save. Saving replaces the posted schedule with what is in this table, so removing a
      row here removes the payment. Years beyond the last one are carried into the return
      analysis at the same annual rate.
    </span>
  `, async () => {
    const rows = [...dlg.querySelectorAll('.prem-row')].map((tr) => ({
      due_date: tr.querySelector('.prem-due').value,
      amount: tr.querySelector('.prem-amt').value.replace(/,/g, ''),
      notes: tr.querySelector('.prem-note').value,
    })).filter((r) => r.due_date || r.amount !== '');
    if (!rows.length) throw new Error('Enter at least one payment, or remove the schedule instead.');
    const blank = rows.findIndex((r) => r.amount === '');
    if (blank >= 0) throw new Error(`Year ${blank + 1} has no amount. Enter 0 if nothing is due.`);
    const res = await api(`/opportunities/${o.id}/premium-schedule`, { method: 'POST', body: { rows } });
    toast(`${res.written} payment${res.written === 1 ? '' : 's'} saved`);
  }, 'Save schedule');

  dlg.classList.add('wide');
  const body = $('#premRows', dlg);
  const renumber = () => {
    [...body.querySelectorAll('.prem-row')].forEach((tr, i) => {
      tr.querySelector('.prem-year').textContent = i + 1;
    });
    const total = [...body.querySelectorAll('.prem-amt')]
      .reduce((s, el) => s + (Number(el.value.replace(/,/g, '')) || 0), 0);
    $('#premTotal', dlg).textContent = total ? fmtExact(total) : '—';
  };
  const wire = (tr) => {
    tr.querySelector('.prem-del').addEventListener('click', () => { tr.remove(); renumber(); });
    tr.querySelector('.prem-amt').addEventListener('input', renumber);
  };
  [...body.querySelectorAll('.prem-row')].forEach(wire);

  $('#premAdd', dlg).addEventListener('click', () => {
    const rows = [...body.querySelectorAll('.prem-row')];
    const lastDue = rows.length ? rows[rows.length - 1].querySelector('.prem-due').value : '';
    const lastAmt = rows.length ? rows[rows.length - 1].querySelector('.prem-amt').value : '';
    body.insertAdjacentHTML('beforeend', rowHtml({
      due: lastDue ? addMonthsIso(lastDue, 12) : start, amount: lastAmt, notes: '' }));
    const added = body.lastElementChild;
    wire(added);
    renumber();
    added.querySelector('.prem-amt').focus();
  });

  $('#premFill', dlg).addEventListener('click', () => {
    const amts = [...body.querySelectorAll('.prem-amt')];
    const base = Number((amts[0]?.value || '').replace(/,/g, ''));
    if (!base) { amts[0]?.focus(); return; }
    const growth = Number($('#premGrowth', dlg).value) || 0;
    amts.forEach((el, i) => {
      if (i === 0 || el.value !== '') return;
      el.value = groupDigits((Math.round(base * (1 + growth / 100) ** i * 100) / 100).toFixed(2));
    });
    renumber();
  });

  renumber();
  return dlg;
}

/** Correct a single posted payment without reopening the whole schedule. */
function openPremiumDialog(o, p) {
  openDialog('Edit payment', `
    <div class="field-row">
      ${inputField('Due', 'due_date', dateInput(p.due_date), 'date', 'required')}
      ${moneyField('Amount', 'amount', p.amount, 'required')}
    </div>
    ${inputField('Notes', 'notes', p.notes || '')}
    <span class="muted" style="font-size:12px">
      Changes only this payment. To rework the whole schedule use <strong>Premium schedule</strong>.
    </span>
  `, async (v) => {
    await api(`/opportunity-premiums/${p.id}`, { method: 'PUT', body: v });
    toast('Payment updated');
  }, 'Save');
}

/**
 * Which participation the one-pager is written for.
 *
 * The same deal reads differently at 10% than at 100% — the numbers an
 * investor cares about are their own — so the percentage is chosen before
 * the sheet is built rather than after. The rate of return is identical
 * either way, which the sheet says on its face.
 */
function openSheetDialog(o) {
  const held = (o.commitments || []).filter((c) => ['Requested', 'Confirmed'].includes(c.status));
  openDialog(`One-pager — ${oppName(o)}`, `
    ${inputField('Participation offered (%)', 'share', 100, 'number', 'step=0.01 min=0.01 max=100 required')}
    ${held.length ? `<span class="muted" style="font-size:12px">
      Already spoken for: ${held.map((c) => `${esc(c.investor_name)} ${fmtPct(c.pct)}`).join(', ')}.
      </span>` : ''}
    <span class="muted" style="font-size:12px">
      At 100% the sheet shows the whole policy. Below that it shows the full premium and that
      participation's share side by side, with the cost and death benefit for that slice.
      The return is the same at any percentage — every cash flow scales together.
      ${!o.impairments && !o.thesis ? '<br><br><strong>Nothing has been written for the medical '
        + 'or investment-case sections yet.</strong> Use <strong>Edit</strong> to add them, or '
        + 'the sheet will print with the numbers alone.' : ''}
    </span>
  `, async (v) => {
    const share = Number(v.share);
    if (!(share > 0 && share <= 100)) throw new Error('Enter a percentage between 0 and 100.');
    go(`#/opportunity/${o.id}/sheet-${String(share).replace('.', '_')}`);
  }, 'Build it');
}

/**
 * Passing on a deal.
 *
 * Not the same as deleting it: the price we would not pay, the medical file
 * and the reasoning are all worth having when the same policy comes round
 * again six months later at a different number. So it stays on file and
 * leaves everybody's list — including, if a manager passes it, their own.
 * Only an administrator can see it afterwards, or put it back.
 */
function openPassDialog(o) {
  const held = (o.commitments || []).filter((c) => ['Requested', 'Confirmed'].includes(c.status));
  const admin = state.user.role === 'admin';
  openDialog(`Pass on ${oppName(o)}`, `
    <p style="margin:0 0 14px;font-size:14px">
      This keeps the record — price, premium schedule, life expectancy, medical file and
      everything written for the one-pager — and takes it off the list.
    </p>
    ${held.length ? `<div class="error-box" style="margin-bottom:14px">
      ${held.length} investor${held.length === 1 ? '' : 's'} still ${held.length === 1 ? 'has' : 'have'} a
      request against this (${held.map((c) => `${esc(c.investor_name)} ${fmtPct(c.pct)}`).join(', ')}).
      Passing hides it from them without answering. Decline the request${held.length === 1 ? '' : 's'}
      first if they are owed a decision.</div>` : ''}
    ${admin ? '' : `<div class="error-box" style="margin-bottom:14px">
      Only administrators can see a passed opportunity. Once you pass this, it leaves your
      list too and you will need an administrator to bring it back.</div>`}
    <div class="field"><label>Why (optional)</label>
      <textarea name="reason" rows="3" placeholder="LE too long for the price, carrier declined the change of ownership…"></textarea>
      <span class="muted" style="font-size:12px">Added to the notes with today's date, so the
        reasoning is still there the next time this policy is offered.</span></div>
  `, async (v) => {
    const reason = String(v.reason || '').trim();
    const body = { status: 'Passed' };
    if (reason) body.notes = `${o.notes ? `${o.notes}\n\n` : ''}Passed ${fmtDate(today())}: ${reason}`;
    await api(`/opportunities/${o.id}`, { method: 'PUT', body });
    toast('Passed');
    go('#/opportunities');
  }, 'Pass on it');
}

/**
 * Clearing a shelf of them.
 *
 * The same shape as the policy version, and deliberately so — the count
 * typed out, what goes named before it goes, and the softer answer offered
 * first. What differs is what is actually at stake: an opportunity carries
 * no ledger and no cap table, so the thing worth warning about is the
 * people. A deal shared with eleven investors, two of whom have asked for a
 * piece, disappears from their screens with no explanation unless somebody
 * gives them one.
 */
async function openBulkDeleteOppsDialog() {
  const ids = [...state.oppSelected];
  let tally;
  try {
    tally = await api('/opportunities/bulk-delete/preview', { method: 'POST', body: { ids } });
  } catch (err) { alert(err.message); return; }

  if (tally.missing?.length) {
    // Somebody else has been working too. Drop them and say so.
    for (const id of tally.missing) state.oppSelected.delete(id);
    if (!tally.count) { toast('Those opportunities have already been deleted'); render(); return; }
  }

  /* Three columns, like the policy version: who, where from, how big. The
     status rides with the carrier rather than taking a column of its own —
     a fourth column costs the money its last digits at this width. */
  const list = tally.opportunities.map((o) => `<tr>
      <td class="strong">${esc([o.insured_last_name, o.insured_first_name]
        .filter(Boolean).join(', ') || o.policy_number || '—')}</td>
      <td>${esc(o.carrier_name || '—')}${o.status !== 'Open'
        ? ` <span class="muted">· ${esc(o.status)}</span>` : ''}</td>
      <td class="dlg-amt">${money(o.face_amount)}</td>
    </tr>`).join('');

  const body = `
    <p style="margin:0 0 14px;font-size:14px">
      This permanently deletes <strong>${tally.count}
      ${tally.count === 1 ? 'opportunity' : 'opportunities'}</strong>, their premium schedules,
      who they were shared with and any requests against them.
    </p>
    <div class="dlg-scroll">
      <table class="data dlg-list"><tbody>${list}</tbody></table>
    </div>
    <table class="data" style="margin-bottom:16px"><tbody>
      <tr><td>Shared with investors</td><td class="strong">${tally.shares}</td></tr>
      <tr><td>Requests outstanding or confirmed</td><td class="strong">${tally.requests}</td></tr>
      <tr><td>Premium schedule rows</td><td class="strong">${tally.premiums}</td></tr>
    </tbody></table>
    ${tally.requests ? `<div class="error-box" style="margin-bottom:16px">
      ${tally.requests} investor ${tally.requests === 1 ? 'request has' : 'requests have'} been
      made against ${tally.count === 1 ? 'this deal' : 'these deals'}. Deleting removes
      ${tally.count === 1 ? 'it' : 'them'} from those investors' screens without a word — tell
      them first, or use <strong>Pass</strong>, which keeps the record and the reason.
    </div>` : ''}
    ${tally.funded ? `<div class="error-box" style="margin-bottom:16px">
      ${tally.funded === 1 ? 'One of these was funded' : `${tally.funded} of these were funded`}
      and became ${tally.funded === 1 ? 'a policy' : 'policies'}. The
      ${tally.funded === 1 ? 'policy stays' : 'policies stay'} in the portfolio, but the record of
      where ${tally.funded === 1 ? 'it' : 'they'} came from — the asking price, the LE, who was
      offered what — goes.
    </div>` : ''}
    <p style="margin:0 0 14px;font-size:13px" class="secondary">
      If you are simply not doing these deals, <strong>Pass</strong> on each is the better answer:
      it keeps the price and the medical file for next time, and only an administrator sees them.
    </p>
    ${inputField(`Type <b>${esc(tally.confirm_phrase)}</b> to confirm`, 'confirm', '', 'text',
      'required autocomplete=off')}`;

  openDialog(`Delete ${tally.count} ${tally.count === 1 ? 'opportunity' : 'opportunities'}`, body,
    async (v) => {
      if (String(v.confirm || '').trim() !== tally.confirm_phrase)
        throw new Error(`Type ${tally.confirm_phrase} exactly to confirm.`);
      const out = await api('/opportunities/bulk-delete', { method: 'POST', body: {
        ids: tally.opportunities.map((o) => o.id), confirm: v.confirm.trim() } });
      state.oppSelected.clear();
      toast(`${out.deleted} deleted`);
      refreshOppCount();
    }, `Delete ${tally.count}`);
}

/** Deleting it outright — the record and everything hanging off it. */
function openDeleteOppDialog(o) {
  const label = o.policy_number || o.insured_last_name || String(o.id);
  const held = (o.commitments || []).length;
  openDialog(`Delete ${oppName(o)}`, `
    <p style="margin:0 0 14px;font-size:14px">
      This removes the opportunity, its premium schedule, who it was shared with and
      ${held} investor request${held === 1 ? '' : 's'}. It cannot be undone.
      ${o.policy_id ? 'The policy it was funded into stays in the portfolio.' : ''}
    </p>
    <div class="error-box" style="margin-bottom:14px">
      If you are simply not doing this deal, <strong>Pass</strong> is the better answer — it
      keeps the price and the medical file for next time and only an administrator sees it.
    </div>
    ${inputField(`Type <strong>${esc(label)}</strong> to confirm`, 'confirm', '', 'text', 'required autocomplete=off')}
  `, async (v) => {
    if (String(v.confirm).trim() !== label) throw new Error(`Type ${label} exactly to confirm.`);
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
    toast('Opportunity deleted');
    go('#/opportunities');
  }, 'Delete it');
}

/** The one-pager itself: rendered, then printed by the browser. */
async function opportunitySheetView() {
  const o = await api(`/opportunities/${state.params.id}`);
  const share = Number(String(state.params.extra || '').replace(/^sheet-/, '').replace('_', '.')) || 100;
  setSheetOrientation();
  return {
    html: `
      <div class="page-head no-print">
        <div><a class="back" href="#/opportunity/${o.id}">← Back to the opportunity</a>
          <h1>One-pager</h1>
          <div class="sub">${esc(oppName(o))}${share < 100 ? ` · ${share}% participation` : ''}</div></div>
        <div class="spacer"></div>
        <button class="primary" id="sheetPrint">Save as PDF</button>
      </div>
      <div class="rpt-hint no-print">
        In the print dialog choose <strong>Save as PDF</strong>. Set Margins to
        <strong>Default</strong>, turn <strong>off</strong> "Headers and footers", and tick
        <strong>Background graphics</strong> so the rules and shading come through.
      </div>
      <div class="rpt-output">${buildOpportunitySheet(o, { share })}</div>`,
    after: () => { $('#sheetPrint')?.addEventListener('click', () => window.print()); },
  };
}

/** The sheet is portrait; the schedule reports set this to landscape. */
function setSheetOrientation() {
  let tag = document.getElementById('printPageStyle');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'printPageStyle';
    document.head.appendChild(tag);
  }
  tag.textContent = '@page { size: Letter portrait; margin: 0.5in; }';
}

async function openShareDialog(o) {
  const investors = await api('/investors');
  const current = new Set((o.shares || []).map((s) => s.investor_id));
  openDialog(`Share ${oppName(o)}`, `
    <div class="field">
      <label>Investors who can see this</label>
      <select name="investor_ids" multiple size="${Math.min(12, Math.max(4, investors.length))}">
        ${investors.map((i) => `<option value="${i.id}" ${current.has(i.id) ? 'selected' : ''}
          >${esc(i.name)}</option>`).join('')}
      </select>
      <span class="muted" style="font-size:12px">
        Hold ⌘ or Ctrl to pick several. An investor sees nothing that is not selected here,
        and the count beside "Opportunities" in their menu is what they will notice first.
        Somebody who has already asked for a piece cannot be removed until their request
        is declined.</span>
    </div>
  `, async (v) => {
    const res = await api(`/opportunities/${o.id}/shares`, { method: 'PUT', body: {
      investor_ids: v.investor_ids || [] } });
    toast(`Shared with ${res.shared_with} investor${res.shared_with === 1 ? '' : 's'}`);
  }, 'Save');
}

async function openFundDialog(o) {
  const confirmed = (o.commitments || []).filter((c) => c.status === 'Confirmed');
  const pct = confirmed.reduce((s, c) => s + Number(c.pct), 0);
  // Policy numbers are unique across the portfolio, and the commonest way to
  // lose a minute here is funding a deal that was also keyed in by hand.
  // Better to say so before the button than after it.
  const clash = o.policy_number
    ? (await api(`/policies?search=${encodeURIComponent(o.policy_number)}`).catch(() => []))
        .find((p) => String(p.policy_number).toLowerCase() === String(o.policy_number).toLowerCase())
    : null;
  openDialog(`Fund ${oppName(o)}`, `
    ${clash ? `<div class="error-box" style="margin-bottom:14px">
      Policy ${esc(clash.policy_number)} is already in the portfolio — ${esc(clash.carrier_name || 'no carrier')}${
        clash.insured_last ? `, ${esc(clash.insured_last)}` : ''}. This will
      <strong>link</strong> the opportunity to that policy and mark it funded rather than
      creating a second one. Nothing on the existing policy is overwritten; only the
      ${confirmed.length} confirmed allocation${confirmed.length === 1 ? '' : 's'} ${
        confirmed.length === 1 ? 'is' : 'are'} added to its cap table.</div>` : ''}
    <p style="margin:0 0 14px;font-size:14px">
      ${clash ? `This marks the opportunity funded against
        <a href="#/policy/${clash.id}">policy ${esc(clash.policy_number)}</a>, which stays exactly
        as it is.` : `This creates the policy in the portfolio, records
      <strong>${fmtExact(o.asking_price)}</strong> as its acquisition cost, and writes the
      cap table from the ${confirmed.length} confirmed allocation${confirmed.length === 1 ? '' : 's'}
      (${fmtPct(pct)} of the policy).`}
    </p>
    ${confirmed.length === 0 ? `<div class="error-box" style="margin-bottom:14px">
      Nothing has been confirmed yet. The policy will be created with an empty cap table.</div>` : ''}
    ${!o.policy_number || !o.carrier_name ? `<div class="error-box" style="margin-bottom:14px">
      A policy number and carrier are required before funding.</div>` : ''}
    ${clash ? '' : inputField('Acquisition date', 'acquisition_date',
      dateInput(o.expected_close) || today(), 'date')}
    <span class="muted" style="font-size:12px">
      Requests still waiting on a decision are not carried over — confirm them first if they
      should be. The opportunity stays on file, marked Funded, linked to the new policy.
    </span>
  `, async (v) => {
    const res = await api(`/opportunities/${o.id}/fund`,
      { method: 'POST', body: { ...v, link: clash ? true : undefined } });
    toast(res.linked
      ? `Linked to the existing policy · ${res.allocations} allocation${res.allocations === 1 ? '' : 's'} added`
      : `Policy created with ${res.allocations} allocation${res.allocations === 1 ? '' : 's'}`);
    go(`#/policy/${res.policy_id}`);
  }, clash ? 'Link and mark funded' : 'Create the policy');
}

/**
 * Sending a funded deal back to the list.
 *
 * The moment this exists for: a deal was marked funded, and then one of the
 * investors who had confirmed backs out. The money never moved, so the
 * policy the funding created has to come off the books, and the piece that
 * investor was holding has to go back in front of everybody else.
 *
 * Two things are made plain before the button is pressed. What the delete
 * would destroy, counted by the server rather than guessed at here — and
 * what percentage actually returns to available, recomputed as the boxes
 * are ticked, because that is the number the next conversation starts from.
 */
async function openReopenDialog(o) {
  const chk = await api(`/opportunities/${o.id}/reopen-check`);
  const live = (o.commitments || [])
    .filter((c) => ['Requested', 'Confirmed'].includes(c.status));
  const losses = chk.losses || [];
  const held = live.reduce((sum, c) => sum + Number(c.pct), 0);

  const row = (c) => `
    <label class="entity-opt">
      <input type="checkbox" name="backing_out" value="${c.investor_id}">
      <span>${esc(c.investor_name)}
        <span class="pick-sub">${c.status === 'Confirmed'
          ? 'Confirmed' : 'Requested, not yet decided'}</span></span>
      <span class="pick-pct">${fmtPct(Number(c.pct))}</span>
    </label>`;

  const dlg = openDialog(`Send ${oppName(o)} back to the list`, `
    <p style="margin:0 0 14px;font-size:14px">
      ${chk.unwinds_policy
        ? `Policy <strong>${esc(chk.policy_number)}</strong> comes out of the portfolio,
           along with the acquisition cost and the cap table written when it was funded.
           The purchase never completed, so the book of record should not say it did.`
        : chk.policy_id
          ? `Policy <strong>${esc(chk.policy_number)}</strong> <strong>stays</strong> in the
             portfolio. It was already on the books and this deal was linked to it rather
             than the creator of it, so it is not this opportunity's to delete.`
          : 'The policy behind this opportunity is no longer in the portfolio.'}
      The opportunity goes back to <strong>Open</strong>, and every investor who stays in
      keeps their position exactly as it is.
    </p>
    ${losses.length ? `<div class="error-box" style="margin-bottom:14px">
      This policy has picked up ${esc(losses.join(', '))} since it was funded.
      ${chk.paid_since ? `That is <strong>${fmtExact(chk.paid_since)}</strong> of movement
        in the ledger. ` : ''}All of it goes with the policy, and none of it comes back.
    </div>` : ''}
    <div class="field">
      <label>Who is backing out</label>
      ${live.length
        ? `<div class="pick-list">${live.map(row).join('')}</div>`
        : '<div class="muted" style="font-size:13px">Nobody is holding a piece of this deal.</div>'}
      <span class="muted" style="font-size:12px" id="freedNote"></span>
    </div>
    ${inputField('New closing date for the offer (optional)', 'offer_closes_on', '', 'date')}
    ${inputField('Note against the withdrawal (optional)', 'notes', '', 'text',
      'autocomplete=off')}
    ${chk.needs_confirm
      ? inputField(`Type <strong>${esc(chk.policy_number)}</strong> to confirm`,
        'confirm', '', 'text', 'required autocomplete=off')
      : ''}
  `, async (v) => {
    if (chk.needs_confirm && String(v.confirm).trim() !== String(chk.policy_number))
      throw new Error(`Type ${chk.policy_number} exactly to confirm.`);
    const res = await api(`/opportunities/${o.id}/reopen`, { method: 'POST', body: {
      backing_out: [].concat(v.backing_out || []),
      confirm: v.confirm, notes: v.notes, offer_closes_on: v.offer_closes_on } });
    toast(res.withdrew
      ? `Back on the list · ${fmtPct(res.freed_pct)} released · ${
        fmtPct(res.remaining_pct)} available`
      : `Back on the list · ${fmtPct(res.remaining_pct)} available`);
  }, 'Send it back');

  /* The freed figure, live. The consequence of ticking a box belongs on the
     screen before the button is pressed, not in the toast afterwards. */
  const note = $('#freedNote', dlg);
  const paint = () => {
    const freed = [...dlg.querySelectorAll('input[name=backing_out]:checked')]
      .reduce((sum, b) => sum
        + Number(live.find((c) => String(c.investor_id) === b.value)?.pct || 0), 0);
    note.innerHTML = freed
      ? `${fmtPct(freed)} is released — <strong>${fmtPct(Math.max(0, 100 - held + freed))
        }</strong> of the policy goes back on offer.`
      : `Nothing selected. ${fmtPct(Math.max(0, 100 - held))} is available as it stands.`;
  };
  dlg.querySelectorAll('input[name=backing_out]').forEach((b) =>
    b.addEventListener('change', paint));
  paint();
}

/**
 * Offering a policy that was never an opportunity.
 *
 * A policy keyed straight into the portfolio has no opportunity behind
 * it, so when an investor backs out there is nothing to send back. This
 * builds the offer the deal never had, from the policy's own record, and
 * carries the investors who are staying across at the percentages they
 * already hold — so the share on offer is the freed one, not the whole
 * policy.
 *
 * Unlike undoing a funding, what happens to the policy is a question.
 * The application did not create this one and cannot know whether the
 * purchase is collapsing or one investor is simply leaving, so it stays
 * unless somebody says otherwise.
 */
async function openOfferDialog(p) {
  const chk = await api(`/policies/${p.id}/offer-check`);
  const owners = chk.owners || [];
  const held = Number(chk.held_pct) || 0;

  if (chk.existing_offer) {
    openDialog(`${oppNameFromPolicy(p)} is already on offer`, `
      <p style="margin:0;font-size:14px">
        Policy <strong>${esc(chk.policy_number)}</strong> already has an offer on the
        Opportunities list. Take the freed share off
        <a href="#/opportunity/${chk.existing_offer.id}">that offer</a> rather than starting
        a second one — two live offers for one policy is how the same share gets promised
        to two people.
      </p>`);
    return;
  }

  const row = (o) => `
    <label class="entity-opt">
      <input type="checkbox" name="backing_out" value="${o.investor_id}">
      <span>${esc(o.name)}<span class="pick-sub">holds this today</span></span>
      <span class="pick-pct">${fmtPct(o.pct)}</span>
    </label>`;

  const dlg = openDialog(`Offer ${esc(chk.insured || chk.policy_number)} to investors`, `
    <p style="margin:0 0 14px;font-size:14px">
      This puts policy <strong>${esc(chk.policy_number)}</strong> on the Opportunities list,
      built from what is already on its record — the carrier, the death benefit, the insured,
      the premium and what was paid for it. Investors who stay are carried across at the
      percentage they hold today, so what is on offer is the share that came free.
    </p>
    <div class="field">
      <label>Who is backing out</label>
      ${owners.length
        ? `<div class="pick-list">${owners.map(row).join('')}</div>`
        : '<div class="muted" style="font-size:13px">Nobody is on this policy\\u2019s cap table yet.</div>'}
      <span class="muted" style="font-size:12px" id="freedNote"></span>
    </div>
    ${moneyField('Asking price for the whole policy', 'asking_price', chk.asking_price ?? '')}
    ${inputField('Offer closes on (optional)', 'offer_closes_on', '', 'date')}
    <div class="field">
      <label>The policy itself</label>
      <label class="entity-opt"><input type="radio" name="policy_fate" value="keep" checked>
        <span>Keep it in the portfolio<span class="pick-sub">The holding is real; only the
          freed share is being reoffered.</span></span></label>
      <label class="entity-opt"><input type="radio" name="policy_fate" value="remove">
        <span>Take it out of the portfolio<span class="pick-sub">The purchase is not
          going ahead. The policy and its ledger go with it.</span></span></label>
    </div>
    <div id="removeWarn" hidden>
      ${chk.losses?.length ? `<div class="error-box" style="margin-bottom:14px">
        Removing it destroys ${esc(chk.losses.join(', '))}${chk.paid_since
          ? ` — <strong>${fmtExact(chk.paid_since)}</strong> of movement in the ledger` : ''},
        and none of it comes back.</div>` : `<div class="error-box" style="margin-bottom:14px">
        Removing it takes the policy out of the portfolio for good.</div>`}
      ${chk.needs_confirm
        ? inputField(`Type <strong>${esc(chk.policy_number)}</strong> to confirm`,
          'confirm', '', 'text', 'autocomplete=off')
        : ''}
    </div>
  `, async (v) => {
    const remove = v.policy_fate === 'remove';
    if (remove && chk.needs_confirm && String(v.confirm || '').trim() !== String(chk.policy_number))
      throw new Error(`Type ${chk.policy_number} exactly to confirm.`);
    const res = await api(`/policies/${p.id}/offer`, { method: 'POST', body: {
      backing_out: [].concat(v.backing_out || []),
      remove_policy: remove, confirm: v.confirm,
      asking_price: v.asking_price, offer_closes_on: v.offer_closes_on } });
    toast(res.withdrew
      ? `On the list · ${fmtPct(res.freed_pct)} released · ${
        fmtPct(res.remaining_pct)} available`
      : `On the list · ${fmtPct(res.remaining_pct)} available`);
    go(`#/opportunity/${res.opportunity_id}`);
  }, 'Put it on the list');

  const note = $('#freedNote', dlg);
  const warn = $('#removeWarn', dlg);
  const paint = () => {
    const freed = [...dlg.querySelectorAll('input[name=backing_out]:checked')]
      .reduce((sum, b) => sum
        + Number(owners.find((o) => String(o.investor_id) === b.value)?.pct || 0), 0);
    note.innerHTML = freed
      ? `${fmtPct(freed)} comes free — <strong>${fmtPct(Math.max(0, 100 - held + freed))
        }</strong> of the policy goes on offer.`
      : `Nothing selected. ${fmtPct(Math.max(0, 100 - held))} is unheld and would go on offer.`;
    warn.hidden = dlg.querySelector('input[name=policy_fate]:checked')?.value !== 'remove';
  };
  dlg.querySelectorAll('input[name=backing_out], input[name=policy_fate]')
    .forEach((b) => b.addEventListener('change', paint));
  paint();
}

/** A policy said the way the Opportunities screens say an insured. */
const oppNameFromPolicy = (p) =>
  [p.insured_last, p.insured_first].filter(Boolean).join(', ') || p.policy_number || 'This policy';

/* ---------------------------- maturities ----------------------------- */

/**
 * The register of policies that have paid out, or are waiting to.
 *
 * Nothing lands here by hand: recording a date of death moves the policy out
 * of the active book automatically. On a survivorship policy that means the
 * *second* death, since a second-to-die contract pays nothing on the first.
 */
/**
 * The Maturities table, as one list of columns.
 *
 * Header, cells, totals and sort key all come from the same definition, so a
 * column cannot be added to one and forgotten in another — which is how a
 * totals row ends up one cell out of step with the figures above it.
 *
 * `value` is what the column sorts on: the number behind a formatted figure,
 * or the raw string behind a name. Sorting on what is printed would put
 * $1,000,000 before $9.
 */
function maturityColumns(m, investorView) {
  const f = (r) => shareFactor(r);
  const benefit = (r) => Number(r.death_benefit || 0) * f(r);
  const basis = (r) => Number(r.total_invested || 0) * f(r);
  const paid = (r) => (r.proceeds_amount == null ? null : Number(r.proceeds_amount) * f(r));
  const gain = (r) => (paid(r) == null ? null : paid(r) - basis(r));
  const dash = '<span class="muted">—</span>';

  return [
    { key: 'matured_on', header: 'Matured', value: (r) => r.matured_on || '',
      cell: (r) => `<span class="strong">${fmtDate(r.matured_on)}</span>` },
    /* First and last in their own columns: the register is read by surname,
       and a single "Surname, Forename" cell cannot be sorted by either. */
    { key: 'insured_last', header: 'Last name', value: (r) => r.insured_last || '',
      cell: (r) => `${esc(r.insured_last || '')}${r.lives_count > 1
        ? ` <span class="muted" style="font-size:12px">+${r.lives_count - 1}</span>` : ''}` },
    { key: 'insured_first', header: 'First name', value: (r) => r.insured_first || '',
      cell: (r) => esc(r.insured_first || '') },
    { key: 'policy_number', header: 'Policy #', cls: 'secondary',
      value: (r) => r.policy_number || '', cell: (r) => esc(r.policy_number || '') },
    { key: 'carrier_name', header: 'Carrier', value: (r) => r.carrier_name || '',
      cell: (r) => esc(r.carrier_name || '') },
    { key: 'product_type', header: 'Type', value: (r) => r.product_type || '',
      cell: (r) => esc(r.product_type || '—') },
    ...(investorView ? [] : [{ key: 'fund_code', header: 'Owner',
      value: (r) => r.fund_code || '', cell: (r) => esc(r.fund_code || '—') }]),
    { key: 'death_benefit', header: 'Death benefit', cls: 'num', total: 'total_death_benefit',
      value: benefit, cell: (r) => fmtExact(benefit(r)) },
    { key: 'total_invested', header: 'Invested', cls: 'num', total: 'total_invested',
      value: basis, cell: (r) => fmtExact(basis(r)) },
    { key: 'proceeds_amount', header: 'Proceeds', cls: 'num', total: 'total_proceeds',
      value: (r) => paid(r), cell: (r) => (paid(r) == null
        ? '<span class="badge grace"><span class="dot"></span>Awaiting</span>' : fmtExact(paid(r))) },
    { key: 'proceeds_received_on', header: 'Funded', value: (r) => r.proceeds_received_on || '',
      cell: (r) => (r.proceeds_received_on ? fmtDate(r.proceeds_received_on) : dash) },
    { key: 'gain', header: 'Gain', cls: 'num', value: (r) => gain(r),
      cell: (r) => (gain(r) == null ? dash
        : `<span style="color:${gain(r) >= 0 ? 'var(--success-text)' : 'var(--critical)'}">${
            fmtExact(gain(r))}</span>`) },
    { key: 'rate', header: investorView ? 'Return' : 'Return · simple', cls: 'num',
      value: (r) => r.rate,
      cell: (r) => `<span title="${paid(r) == null
        ? 'Provisional — assumes the death benefit is collected today'
        : r.rate_short ? 'Held under 90 days — an annualised rate is unreliable here'
        : r.rate_ambiguous ? 'Cash flows change direction more than once; more than one rate can satisfy the equation'
        : `${r.rate_days} days held`}">${fmtRate(r.rate)}${
        r.rate != null && (paid(r) == null || r.rate_short || r.rate_ambiguous)
          ? '<span class="muted"> *</span>' : ''}</span>` },
    /* Beside it rather than instead of it, and sortable on its own: a
       register ordered by simple return and one ordered by compounded
       return are not the same list, and which one somebody wants depends
       on the question they came with. */
    ...(investorView ? [] : [{ key: 'compound_rate', header: 'Return · compounded',
      cls: 'num', value: (r) => r.compound_rate,
      cell: (r) => `<span class="muted" title="Internal rate of return on the same dated cash flows">${
        fmtRate(r.compound_rate)}</span>` }]),
  ];
}

/** Sort by whichever column was clicked, blanks last whichever way it runs. */
function sortMaturities(rows, cols) {
  const { key, dir } = state.matSort;
  const col = cols.find((c) => c.key === key);
  if (!col) return rows;
  return [...rows].sort((a, b) => {
    const av = col.value(a), bv = col.value(b);
    const aEmpty = av === null || av === undefined || av === '';
    const bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * dir;
  });
}

/**
 * What the firm earns, in one place.
 *
 * The investor's screens have this deducted and never name it. Here it is
 * the subject: what each entity's agreement charges, what the profit on
 * each case is, and what the two come to.
 *
 * Earned and projected are never added together. Earned is carried interest
 * on claims the carrier has actually paid; projected is what a case would
 * produce if it settled today. Both are real, but only one is money, and a
 * single figure mixing them reports cash that has not arrived.
 */
async function carryView() {
  const status = state.carryStatus || 'all';
  const [d, funds] = await Promise.all([
    api(`/carry?status=${status}&fund=${encodeURIComponent(entityParam())}`),
    state.funds.length ? Promise.resolve(state.funds) : api('/funds'),
  ]);
  state.funds = funds;
  const t = d.totals;
  const money = (n) => fmtExact(n);

  const html = `
    <div class="page-head">
      <div><h1>Carried interest</h1>
        <div class="sub">${t.policies} ${t.policies === 1 ? 'policy' : 'policies'}${
          t.charged < t.policies
            ? ` · ${t.policies - t.charged} in entities that charge none` : ''}${
          entityLabel() ? ` · ${esc(entityLabel())} only` : ''}</div></div>
      <div class="spacer"></div>
      <select id="carryStatus" class="head-select">
        ${[['all', 'All policies'], ['active', 'Still running'], ['matured', 'Matured']]
          .map(([v, label]) =>
            `<option value="${v}" ${status === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      ${entityPicker(funds)}
      ${d.rows.length && isAdminUser() ? '<button id="exportCarryBtn">Export CSV</button>' : ''}
    </div>

    <div class="kpi-row">
      <div class="stat">
        <div class="label">Earned</div>
        <div class="value hero">${money(t.earned)}</div>
        <div class="note">on claims the carrier has paid</div>
      </div>
      <div class="stat">
        <div class="label">Still to come</div>
        <div class="value">${money(t.projected)}</div>
        <div class="note">if every remaining case settled today</div>
      </div>
      <div class="stat">
        <div class="label">Both together</div>
        <div class="value">${money(t.earned + t.projected)}</div>
        <div class="note">only the first of the two is money</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>By owner entity</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">the rate is a term of each agreement</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Entity</th><th class="num">Rate</th><th class="num">Policies</th>
          <th class="num">Capital in</th><th class="num">Profit</th>
          <th class="num">Earned</th><th class="num">Still to come</th>
          <th class="num">Total</th></tr></thead>
        <tbody>${d.byFund.length === 0
          ? '<tr><td colspan="8"><div class="empty">Nothing to report.</div></td></tr>'
          : d.byFund.map((f) => `<tr>
              <td class="strong">${esc(f.fund_code)}</td>
              <td class="num">${f.carry_pct > 0
                ? fmtPct(f.carry_pct) : '<span class="muted">none</span>'}</td>
              <td class="num">${f.policies}</td>
              <td class="num">${money(f.basis)}</td>
              <td class="num">${money(f.gross_profit)}</td>
              <td class="num strong">${money(f.earned)}</td>
              <td class="num secondary">${money(f.projected)}</td>
              <td class="num">${money(f.earned + f.projected)}</td>
            </tr>`).join('')}</tbody>
        ${d.byFund.length ? `<tfoot><tr>
          <td colspan="5">All entities</td>
          <td class="num">${money(t.earned)}</td>
          <td class="num">${money(t.projected)}</td>
          <td class="num">${money(t.earned + t.projected)}</td>
        </tr></tfoot>` : ''}
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>By policy</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">largest first</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Last name</th><th>First name</th><th>Policy #</th><th>Carrier</th>
          <th>Owner</th><th>Status</th><th class="num">Rate</th>
          <th class="num">Capital in</th><th class="num">Comes back</th>
          <th class="num">Profit</th><th class="num">Carried interest</th>
          <th class="num">To investors</th></tr></thead>
        <tbody>${d.rows.length === 0
          ? '<tr><td colspan="12"><div class="empty">No policies match.</div></td></tr>'
          : d.rows.map((r) => `<tr class="clickable" data-id="${r.id}">
              <td class="strong">${esc(r.insured_last || '')}</td>
              <td>${esc(r.insured_first || '')}</td>
              <td class="secondary">${esc(r.policy_number)}</td>
              <td>${esc(r.carrier_name || '')}</td>
              <td>${esc(r.fund_code || '—')}</td>
              <td>${r.earned
                ? '<span class="badge good"><span class="dot"></span>Earned</span>'
                : `<span class="muted">${esc(r.status)}</span>`}</td>
              <td class="num">${r.carry_pct > 0
                ? fmtPct(r.carry_pct) : '<span class="muted">none</span>'}</td>
              <td class="num">${money(r.basis)}</td>
              <td class="num">${money(r.gross_return)}</td>
              <td class="num">${money(r.gross_profit)}</td>
              <td class="num strong">${r.carry ? money(r.carry) : '<span class="muted">—</span>'}</td>
              <td class="num secondary">${money(r.net_profit)}</td>
            </tr>`).join('')}</tbody>
      </table></div>
      <div class="card-body">
        <span class="muted" style="font-size:12.5px">
          The investors' capital comes back first — acquisition cost, premiums, fees,
          servicing and commissions — and what is left is split at the rate in each
          entity's agreement. <strong>Earned</strong> means the carrier has paid; every
          other row is what would be due if that case settled today, which is why the two
          are never added into one figure. A case that lost money carries none, and an
          entity managed for a fee charges none.
        </span>
      </div>
    </div>`;

  return {
    html,
    after: () => {
      wireEntityPicker();
      wireRateToggle();
      $('#carryStatus').addEventListener('change', (e) => {
        state.carryStatus = e.target.value;
        render();
      });
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`)));
      $('#exportCarryBtn')?.addEventListener('click', () =>
        exportCsv('carried-interest.csv', d.rows, [
          { header: 'Last Name', key: 'insured_last' },
          { header: 'First Name', key: 'insured_first' },
          { header: 'Policy #', key: 'policy_number' },
          { header: 'Carrier', key: 'carrier_name' },
          { header: 'Owner', key: 'fund_code' },
          { header: 'Status', key: 'status' },
          { header: 'Earned', get: (r) => (r.earned ? 'Yes' : 'No') },
          { header: 'Rate %', key: 'carry_pct' },
          { header: 'Capital In', key: 'basis' },
          { header: 'Comes Back', key: 'gross_return' },
          { header: 'Profit', key: 'gross_profit' },
          { header: 'Carried Interest', key: 'carry' },
          { header: 'To Investors', key: 'net_profit' },
        ], 'carried-interest'));
    },
  };
}

async function maturitiesView() {
  const [m, funds] = await Promise.all([
    api(`/maturities${entityQuery() ? `?${entityQuery()}` : ''}`),
    loadFunds(),
  ]);
  const t = m.totals;
  const matCols = maturityColumns(m, isInvestorUser());
  const rows = sortMaturities(m.rows, matCols);
  const investorView = isInvestorUser();

  // Realized position: what came in against what went in. Only meaningful once
  // the carrier has actually paid, so unpaid claims are excluded from the gain
  // rather than counted as a loss of the whole basis.
  const collected = rows.filter((r) => r.proceeds_amount != null);
  const collectedBasis = collected.reduce((s, r) => s + (Number(r.total_invested) || 0) * (shareFactor(r) || 1), 0);
  const gain = Number(t.total_proceeds) - collectedBasis;
  const multiple = collectedBasis > 0 ? Number(t.total_proceeds) / collectedBasis : null;
  const paidCount = collected.length;
  const unpaidCount = rows.length - paidCount;

  /* Which figure the tile leads with is this person's standing choice --
     see rateToggle. Both come down from the server on the same object, so
     the two can never disagree and switching costs no request. */

  const nameOf = (r) =>
    esc(r.display_name || `${r.insured_first || ''} ${r.insured_last || ''}`.trim() || '—');

  const html = `
    <div class="page-head">
      <div><h1>${investorView ? 'Realized' : 'Maturities'}</h1>
        <div class="sub">${rows.length} matured ${rows.length === 1 ? 'policy' : 'policies'} ·
          ${t.paid_count} paid · ${rows.length - t.paid_count} awaiting payment${
          !investorView && entityLabel() ? ` · ${esc(entityLabel())} only` : ''}</div></div>
      <div class="spacer"></div>
      ${rateToggle()}
      ${entityPicker(funds)}
      ${shareToggle()}
      ${rows.length && isAdminUser() ? '<button id="exportMaturitiesBtn">Export CSV</button>' : ''}
    </div>

    ${rows.length === 0 ? `
      <div class="card"><div class="card-body">
        <div class="empty">
          No policies have matured.<br>
          <span class="muted" style="font-size:13px">
            A policy moves here on its own once a date of death is recorded on the
            insured. Survivorship policies wait for the second death.</span>
        </div>
      </div></div>` : `

    <div class="kpi-row">
      <div class="stat">
        <div class="label">Death benefit matured</div>
        <div class="value hero">${fmtExact(t.total_death_benefit)}</div>
        <div class="note">${fmtExact(t.outstanding_benefit)} not yet collected</div>
      </div>
      <div class="stat">
        <div class="label">Proceeds received</div>
        <div class="value">${fmtExact(t.total_proceeds)}</div>
        <div class="note">${t.paid_count} of ${rows.length} ${t.paid_count === 1 ? 'claim' : 'claims'} paid</div>
      </div>
      <div class="stat">
        <div class="label">Capital invested</div>
        <div class="value">${fmtExact(t.total_invested)}</div>
        <div class="note">${fmtExact(collectedBasis)} against paid claims</div>
      </div>
      <div class="stat">
        <div class="label">Realized gain</div>
        <div class="value" style="color:${gain >= 0 ? 'var(--success-text)' : 'var(--critical)'}">${fmtExact(gain)}</div>
        <div class="note">${multiple ? `${multiple.toFixed(2)}× on capital collected` : 'no claims paid yet'}</div>
      </div>
      <div class="stat">
        ${/* The headline is what the book has actually returned: claims the
             carrier has paid, each dated the day the money arrived, exactly
             as the paid rows below are worked out. An outstanding claim is
             not folded in at today's date — it has had no time to run, so it
             would flatter the rate. That projection is still here, under the
             figure and named for what it is. */''}
        <div class="label">${paidCount ? 'Realized return' : 'Return if collected today'}${
          showsBothRates() ? ' · simple interest' : ''}</div>
        <div class="value">${fmtRate(bookRate(paidCount ? m.realized : m.portfolio))}</div>
        ${showsBothRates() && compoundNote(paidCount ? m.realized : m.portfolio)
          ? `<div class="note">${compoundNote(paidCount ? m.realized : m.portfolio)}</div>` : ''}
        <div class="note">${paidCount
          ? `${paidCount} paid ${paidCount === 1 ? 'claim' : 'claims'}, each dated when it was
             received${unpaidCount ? ` · ${fmtRate(bookRate(m.portfolio))} with the other ${
               unpaidCount} assumed collected today` : ''}`
          : `no claims paid yet — every one of the ${rows.length} is assumed collected today`}${
          basisNote(paidCount ? m.realized : m.portfolio)
            ? ` · ${basisNote(paidCount ? m.realized : m.portfolio)}` : ''}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Matured policies</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">sorted by ${
          esc((matCols.find((c) => c.key === state.matSort.key) || {}).header || '')
        }, ${state.matSort.dir === 1 ? 'low to high' : 'high to low'} · click a heading to change it</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${matCols.map((c) => `<th class="sortable ${c.cls || ''}" data-mat-key="${c.key}">${
            c.header}${state.matSort.key === c.key
              ? `<span class="arrow">${state.matSort.dir === 1 ? '↑' : '↓'}</span>` : ''}</th>`).join('')}
          ${canEditData() ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${rows.map((r) => `<tr class="clickable" data-id="${r.id}">${
          matCols.map((c) => `<td class="${c.cls || ''}">${c.cell(r)}</td>`).join('')}${
          canEditData() ? `<td><button class="btn-sm" data-proceeds="${r.id}"
            >${r.proceeds_amount == null ? 'Record proceeds' : 'Edit'}</button></td>` : ''}
        </tr>`).join('')}</tbody>
        <tfoot><tr>${(() => {
          /* Built from the same column list as the head, so a column added to
             one cannot leave the other a cell out of step. */
          const totals = {
            total_death_benefit: t.total_death_benefit, total_invested: t.total_invested,
            total_proceeds: t.total_proceeds, gain,
            rate: bookRate(m.portfolio),
          };
          const first = matCols.findIndex((c) => c.total || c.key === 'gain'
            || c.key === 'rate');
          return matCols.map((c, i) => {
            if (i === 0) return `<td colspan="${first}">Totals — ${rows.length}
              ${rows.length === 1 ? 'policy' : 'policies'}</td>`;
            if (i < first) return '';
            if (c.key === 'rate') return `<td class="num">${fmtRate(totals.rate)}</td>`;
            const v = totals[c.total || c.key];
            return v === null || v === undefined
              ? '<td></td>' : `<td class="num">${fmtExact(v)}</td>`;
          }).join('') + (canEditData() ? '<td></td>' : '');
        })()}</tr></tfoot>
      </table></div>
    </div>

    <div class="card"><div class="card-body">
      <span class="muted" style="font-size:12px">
        Gain compares proceeds against every dollar in the ledger for that policy —
        acquisition cost, premiums, fees, servicing and commissions — and is shown
        only once the claim has been paid. A policy returns to the active book if
        its date of death is removed.<br>
        The return is simple interest over actual days — every dollar earns for exactly
        as long as it is outstanding, and the interest earns nothing. The figure at the
        top is the whole book's <strong>total profit divided by its total dollar-years</strong>,
        each policy measured against its own settlement date and then added together. That
        weights by capital and by time, so a $5m position held eight years counts for far
        more than a $50k one held eight months. The plain average of the rates is printed
        beside it, and the gap between the two is itself information: it is what a few
        small cases with outsized rates do to an average. A <strong>*</strong> marks a rate
        that needs reading with care — an unpaid claim assumed collected today, a
        holding period under 90 days, or flows that change direction more than once.
        Hover it for the reason.</span>
    </div></div>`}`;

  return {
    html,
    after: () => {
      wireShareToggle();
      wireEntityPicker();
      wireRateToggle();
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          go(`#/policy/${tr.dataset.id}`);
        }));
      document.querySelectorAll('[data-proceeds]').forEach((b) =>
        b.addEventListener('click', () =>
          openProceedsDialog(rows.find((r) => r.id === Number(b.dataset.proceeds)))));
      document.querySelectorAll('th[data-mat-key]').forEach((th) =>
        th.addEventListener('click', () => {
          const key = th.dataset.matKey;
          /* Clicking the column you are already on turns it round; a new one
             starts high-to-low, which is what somebody scanning a money
             column almost always wants first. */
          state.matSort = { key, dir: state.matSort.key === key ? -state.matSort.dir : -1 };
          render();
        }));
      $('#exportMaturitiesBtn')?.addEventListener('click', () =>
        exportCsv('maturities.csv', rows, [
          { header: 'Matured', key: 'matured_on' },
          { header: 'Last Name', key: 'insured_last' },
          { header: 'First Name', key: 'insured_first' },
          { header: 'Policy #', key: 'policy_number' },
          { header: 'Carrier', key: 'carrier_name' },
          { header: 'Product', key: 'product_type' },
          { header: 'Owner', key: 'fund_code' },
          { header: 'Death Benefit', get: (r) => Number(r.death_benefit || 0) * shareFactor(r) },
          { header: 'Capital Invested', get: (r) => Number(r.total_invested || 0) * shareFactor(r) },
          { header: 'Proceeds', get: (r) => r.proceeds_amount == null ? '' : Number(r.proceeds_amount) * shareFactor(r) },
          { header: 'Date Funded', key: 'proceeds_received_on' },
          { header: 'Gain', get: (r) => (r.proceeds_amount == null ? ''
            : (Number(r.proceeds_amount) - Number(r.total_invested || 0)) * shareFactor(r)) },
          { header: 'Return % (simple)',
            get: (r) => (r.rate == null ? '' : (r.rate * 100).toFixed(4)) },
          { header: 'Return % (compounded)',
            get: (r) => (r.compound_rate == null ? '' : (r.compound_rate * 100).toFixed(4)) },
          { header: 'Days Held', key: 'rate_days' },
        ], 'maturities'));
    },
  };
}

function openProceedsDialog(r) {
  if (!r) return;
  openDialog(`Proceeds — ${r.policy_number}`, `
    <div class="field"><span class="muted" style="font-size:12px">
      ${esc(r.carrier_name)} · matured ${fmtDate(r.matured_on)} ·
      death benefit ${fmtExact(r.death_benefit)}</span></div>
    <div class="field-row">
      ${moneyField('Gross proceeds received', 'proceeds_amount', r.proceeds_amount)}
      ${inputField('Date funded', 'proceeds_received_on', dateInput(r.proceeds_received_on), 'date')}
    </div>
    <span class="muted" style="font-size:12px">
      Enter what the carrier actually paid, which may differ from the death benefit
      after any loan balance or interest adjustment. Leave the amount blank to mark
      the claim as still outstanding.</span>
  `, async (v) => {
    await api(`/policies/${r.id}/proceeds`, { method: 'PUT', body: {
      proceeds_amount: v.proceeds_amount === '' ? null : v.proceeds_amount,
      proceeds_received_on: v.proceeds_received_on || null,
    } });
    toast(v.proceeds_amount === '' ? 'Claim marked outstanding' : 'Proceeds recorded');
  }, 'Save');
}

/* ----------------------------- insureds ------------------------------ */

async function insuredsView() {
  const [rows, funds] = await Promise.all([
    api(`/insureds?search=${encodeURIComponent(state.insuredSearch)}&${entityQuery()}`),
    loadFunds(),
  ]);
  const dated = rows.filter((i) => i.dob && !i.date_of_death).map((i) => ageFrom(i.dob));
  const avgAge = dated.length
    ? Math.round((dated.reduce((a, b) => a + b, 0) / dated.length) * 10) / 10 : null;
  const html = `
    <div class="page-head">
      <div><h1>Insureds</h1>
        <div class="sub">${rows.length} ${rows.length === 1 ? 'person' : 'people'}${
          entityLabel() ? ` in ${esc(entityLabel())}` : ''}${
          avgAge ? ` · average age ${avgAge}` : ''}</div></div>
      <div class="spacer"></div>
      ${entityPicker(funds)}
      ${isAdminUser() ? '<button id="exportInsuredsBtn">Export CSV</button>' : ''}
      ${canEditData() ? '<button class="primary" id="newInsuredBtn">New insured</button>' : ''}
    </div>

    <div class="toolbar">
      <input class="grow" id="insuredSearch" placeholder="Search by name…" value="${esc(state.insuredSearch)}">
    </div>

    <div class="card"><div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>Last name</th><th>First name</th><th>Display name</th>
          <th>Date of birth</th><th class="num">Age</th><th>Gender</th><th>State</th>
          <th class="num">LE (months)</th><th class="num">Policies</th>
          <th>Date of death</th><th></th>
        </tr></thead>
        <tbody>${rows.length === 0
          ? '<tr><td colspan="11"><div class="empty">No insureds yet. They are created automatically when you import policies.</div></td></tr>'
          : rows.map((i) => `<tr>
              <td class="strong">${esc(i.last_name || '—')}</td>
              <td>${esc(i.first_name || '—')}</td>
              <td class="secondary">${esc(i.display_name || '')}</td>
              <td>${fmtDate(i.dob)}</td>
              <td class="num">${ageFrom(i.dob) ?? '—'}</td>
              <td>${esc(i.gender || '—')}</td>
              <td>${esc(i.state || '—')}</td>
              <td class="num">${i.le_months ?? '—'}</td>
              <td class="num">${i.policy_count}</td>
              <td>${i.date_of_death ? fmtDate(i.date_of_death) : '<span class="muted">—</span>'}</td>
              <td>${canEditData() ? `<button class="btn-sm" data-edit-insured="${i.id}">Edit</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div></div>`;

  return {
    html,
    after: () => {
      wireEntityPicker();
      wireRateToggle();
      wireSearch('#insuredSearch', (term) => { state.insuredSearch = term; });
      $('#newInsuredBtn')?.addEventListener('click', () => openInsuredDialog(null));
      document.querySelectorAll('[data-edit-insured]').forEach((b) =>
        b.addEventListener('click', async () => {
          const ins = await api(`/insureds/${b.dataset.editInsured}`);
          openInsuredDialog(ins);
        }));
      $('#exportInsuredsBtn')?.addEventListener('click', () =>
        exportCsv('insureds.csv', rows, [
          { header: 'Last Name', key: 'last_name' },
          { header: 'First Name', key: 'first_name' },
          { header: 'Display Name', key: 'display_name' },
          { header: 'DOB', key: 'dob' },
          { header: 'Age', get: (r) => ageFrom(r.dob) ?? '' },
          { header: 'Gender', key: 'gender' },
          { header: 'State', key: 'state' },
          { header: 'LE Months', key: 'le_months' },
          { header: 'LE Provider', key: 'le_provider' },
          { header: 'Policies', key: 'policy_count' },
          { header: 'Date Of Death', key: 'date_of_death' },
        ], 'insureds'));
    },
  };
}

/* ----------------------------- investors ----------------------------- */

const INVESTOR_TYPES = ['Individual', 'Entity', 'Trust', 'IRA', 'Other'];

/* ------------------------ registration queue ------------------------- */

const APPLICATION_BADGES = {
  Pending: 'badge grace', Approved: 'badge inforce', Declined: 'badge lapsed',
};

/** One registration, with everything needed to decide on it in one line. */
function applicationRow(a) {
  const decided = a.status !== 'Pending';
  const canDecide = ['admin', 'manager'].includes(state.user.role);
  const isAdmin = state.user.role === 'admin';
  const address = [a.address_line1, a.address_line2, a.city,
    [a.state, a.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return `
  <div class="app-row ${decided ? 'row-muted' : ''}">
    <div class="who">
      <div class="name">${esc(a.full_name)}
        ${a.entity_name ? `<span class="muted" style="font-weight:400"> · ${esc(a.entity_name)}</span>` : ''}
        <span style="margin-left:8px">${
          `<span class="${APPLICATION_BADGES[a.status] || 'badge'}"><span class="dot"></span>${esc(a.status)}</span>`}</span>
      </div>
      <div class="meta">
        ${esc(a.investor_type)} · ${esc(a.email)} · ${esc(a.phone || 'no phone')}<br>
        ${esc(address) || '<span class="muted">no address given</span>'}<br>
        <span class="app-tax" id="tax-${a.id}">${esc(a.tax_id_masked || '—')}</span>
        ${isAdmin && !decided && a.tax_id_masked
          ? `<button class="btn-sm" data-reveal-tax="${a.id}" style="margin-left:8px">Show in full</button>` : ''}
        · registered ${fmtDateTime(a.submitted_at)}
        ${a.note ? `<br><span style="font-style:italic">&ldquo;${esc(a.note)}&rdquo;</span>` : ''}
        ${decided ? `<br><span class="muted">${esc(a.status)} ${fmtDateTime(a.decided_at)}${
          a.decided_by_name ? ` by ${esc(a.decided_by_name)}` : ''}${
          a.decision_note ? ` · ${esc(a.decision_note)}` : ''}</span>` : ''}
      </div>
    </div>
    <div class="acts">
      ${!decided && canDecide ? `
        <button class="btn-sm primary" data-approve-app="${a.id}">Approve</button>
        <button class="btn-sm" data-decline-app="${a.id}">Decline</button>` : ''}
      ${a.investor_id ? `<a class="btn-sm" href="#/investor/${a.investor_id}">Open</a>` : ''}
    </div>
  </div>`;
}

function openApproveDialog(a) {
  if (!a) return;
  const name = a.entity_name || a.full_name;
  openDialog(`Approve ${a.full_name}`, `
    <p style="margin-top:0">This creates an investor record called
      <strong>${esc(name)}</strong> and a login for <strong>${esc(a.email)}</strong>, using the
      password they chose. They will be able to sign in immediately.</p>
    <div class="dlg-section">What gets created</div>
    <dl class="kv">
      <dt>Investor</dt><dd>${esc(name)} <span class="muted">${esc(a.investor_type)}</span></dd>
      <dt>Contact</dt><dd>${esc(a.full_name)} · ${esc(a.phone || '—')}</dd>
      <dt>Address</dt><dd>${esc([a.address_line1, a.address_line2, a.city,
        [a.state, a.postal_code].filter(Boolean).join(' '), a.country]
        .filter(Boolean).join(', '))}</dd>
      <dt>Tax ID</dt><dd class="app-tax">${esc(a.tax_id_masked || '—')}</dd>
    </dl>
    <div class="dlg-section">Who looks after them</div>
    <div class="field"><label>Owner entity</label>
      <select name="fund_id">
        <option value="">— decide later —</option>
        ${(state.funds || []).map((f) => `<option value="${f.id}">${esc(f.code)}${
          f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
      </select>
      <span class="muted" style="font-size:12px">The manager of that entity will see them in
        their investor list straight away, before they hold anything. It can be changed later
        from the investor's own record.</span></div>
    ${inputField('Note (optional)', 'note', '', 'text',
      'placeholder="Anything worth recording about the decision"')}
    <span class="muted" style="font-size:12px">They hold nothing yet. Allocate them to policies
      from the policy itself, or share an opportunity with them.</span>
  `, async (v) => {
    const r = await api(`/applications/${a.id}/approve`, { method: 'POST', body: v });
    toast(`${r.name} can now sign in`);
    refreshApplicationCount();
  }, 'Approve and create the account');
}

function openDeclineApplicationDialog(a) {
  if (!a) return;
  openDialog(`Decline ${a.full_name}`, `
    <p style="margin-top:0">No account is created and they cannot sign in. The registration
      stays on the record, so there is an answer to "did anyone ever get back to them".</p>
    ${inputField('Why', 'note', '', 'text',
      'placeholder="Not accredited · duplicate of an existing account · no longer interested"')}
    <span class="muted" style="font-size:12px">The password they chose is discarded. If they
      register again later it is a fresh application.</span>
  `, async (v) => {
    await api(`/applications/${a.id}/decline`, { method: 'POST', body: v });
    toast('Declined');
    refreshApplicationCount();
  }, 'Decline');
}

async function investorsView() {
  const [rows, applications, funds] = await Promise.all([
    api(`/investors?search=${encodeURIComponent(state.investorSearch)}&${entityQuery()}`),
    // A registration nobody has looked at is somebody sitting on the other
    // end waiting, so it is fetched with the list rather than hidden behind
    // a tab. Viewers cannot see the queue and the call simply returns none.
    api(`/applications${state.showDecided ? '' : '?status=Pending'}`).catch(() => []),
    loadFunds(),
  ]);
  state.investors = rows;
  const canEditNow = canEditData();
  const canDecide = ['admin', 'manager'].includes(state.user.role);
  const pending = applications.filter((a) => a.status === 'Pending');

  const totals = rows.reduce((a, r) => ({
    db: a.db + Number(r.death_benefit || 0),
    inv: a.inv + Number(r.invested || 0),
    pos: a.pos + Number(r.position_count || 0),
  }), { db: 0, inv: 0, pos: 0 });

  const html = `
    <div class="page-head">
      <div><h1>Investors</h1>
        <div class="sub">${rows.length} ${rows.length === 1 ? 'investor' : 'investors'} · ${
          totals.pos} positions${entityLabel() ? ` · ${esc(entityLabel())} only` : ''}${
          rows.filter((r) => !r.fund_code).length
            ? ` · ${rows.filter((r) => !r.fund_code).length} not assigned to an entity` : ''}</div></div>
      <div class="spacer"></div>
      ${entityPicker(funds)}
      ${canEditNow ? '<button class="primary" id="newInvestorBtn">New investor</button>' : ''}
    </div>

    ${applications.length ? `
    <div class="card ${pending.length ? 'card-attention' : ''}">
      <div class="card-head"><h2>Waiting for approval</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">${pending.length
          ? `${pending.length} ${pending.length === 1 ? 'person has' : 'people have'} registered`
          : 'nothing outstanding'}</span>
        <button class="btn-sm" id="appShowAll" style="margin-left:12px">${
          state.showDecided ? 'Hide decided' : 'Show decided'}</button></div>
      <div class="card-body flush">
        ${applications.length === 0
          ? '<div class="empty">No registrations waiting.</div>'
          : applications.map(applicationRow).join('')}
      </div>
      <div class="card-body" style="border-top:1px solid var(--grid)">
        <span class="muted" style="font-size:12.5px">Approving creates the investor record and
          the login from what they typed, with the password they chose — there is nothing to
          send them. Nobody can sign in until somebody here approves them.</span>
      </div>
    </div>` : ''}

    <div class="toolbar">
      <input class="grow" id="investorSearch" placeholder="Search by name or email…" value="${esc(state.investorSearch)}">
    </div>

    <div class="card"><div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>Name</th><th>Type</th><th>Entity</th><th>Legal name</th><th>Email</th>
          <th class="num">Positions</th><th class="num">Death benefit</th>
          <th class="num">Invested</th><th class="num">Cash value</th><th></th>
        </tr></thead>
        <tbody>${rows.length === 0
          ? '<tr><td colspan="10"><div class="empty">No investors yet.</div></td></tr>'
          : rows.map((r) => `<tr class="clickable" data-investor="${r.id}">
              <td class="strong">${esc(r.name)}</td>
              <td>${esc(r.investor_type || '')}</td>
              <td>${r.fund_code
                ? esc(r.fund_code)
                : '<span class="muted">unassigned</span>'}</td>
              <td class="secondary">${esc(r.legal_name || '')}</td>
              <td class="secondary">${esc(r.email || '')}</td>
              <td class="num">${r.position_count}</td>
              <td class="num">${money(r.death_benefit, 2)}</td>
              <td class="num">${money(r.invested, 2)}</td>
              <td class="num">${money(r.csv, 2)}</td>
              ${''/* Delete lives here as well as on the investor's own page.
                     Removing somebody is a thing you decide while looking at
                     the list they should not be on, and a person who cannot
                     find it on the list concludes it cannot be done. It opens
                     the same dialog either way, so the footprint, the refusal
                     and the typed name are identical. */}
              <td class="row-actions">${canEditNow
    ? `<button class="btn-sm" data-edit-investor="${r.id}">Edit</button>` : ''}${
    isAdminUser() ? `
                <button class="btn-sm btn-danger" data-del-investor="${r.id}">Delete</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
        ${rows.length ? `<tfoot><tr>
          <td colspan="5">Totals</td>
          <td class="num">${totals.pos}</td>
          <td class="num">${fmtExact(totals.db)}</td>
          <td class="num">${fmtExact(totals.inv)}</td>
          <td colspan="2"></td>
        </tr></tfoot>` : ''}
      </table>
    </div></div>`;

  return {
    html,
    after: () => {
      wireSearch('#investorSearch', (term) => { state.investorSearch = term; });
      wireEntityPicker();
      wireRateToggle();
      $('#newInvestorBtn')?.addEventListener('click', () => openInvestorDialog(null));
      $('#appShowAll')?.addEventListener('click', () => {
        state.showDecided = !state.showDecided; render();
      });
      document.querySelectorAll('[data-approve-app]').forEach((b) =>
        b.addEventListener('click', () => openApproveDialog(
          applications.find((a) => a.id === Number(b.dataset.approveApp)))));
      document.querySelectorAll('[data-decline-app]').forEach((b) =>
        b.addEventListener('click', () => openDeclineApplicationDialog(
          applications.find((a) => a.id === Number(b.dataset.declineApp)))));
      document.querySelectorAll('[data-reveal-tax]').forEach((b) =>
        b.addEventListener('click', async () => {
          const cell = $(`#tax-${b.dataset.revealTax}`);
          b.disabled = true;
          try {
            const r = await api(`/applications/${b.dataset.revealTax}/tax-id`);
            cell.textContent = r.tax_id.replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3');
            b.remove();
          } catch (err) { alert(err.message); b.disabled = false; }
        }));
      document.querySelectorAll('[data-del-investor]').forEach((b) =>
        b.addEventListener('click', (e) => {
          /* The row is a link to the investor; the button is not. */
          e.stopPropagation();
          const inv = rows.find((r) => r.id === Number(b.dataset.delInvestor));
          if (inv) openDeleteInvestorDialog(inv);
        }));
      document.querySelectorAll('[data-edit-investor]').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          openInvestorDialog(rows.find((r) => r.id === Number(b.dataset.editInvestor)));
        }));
      document.querySelectorAll('[data-investor]').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/investor/${tr.dataset.investor}`)));
    },
  };
}

async function investorView() {
  const inv = await api(`/investors/${state.params.id}`);
  const pos = inv.positions || [];
  const t = pos.reduce((a, p) => {
    const f = Number(p.pct) / 100;
    a.db += (Number(p.death_benefit ?? p.face_amount) || 0) * f;
    a.inv += (Number(p.total_invested) || 0) * f;
    a.csv += (Number(p.cash_surrender_value) || 0) * f;
    a.prem += (Number(p.premium_required) || 0) * f;
    return a;
  }, { db: 0, inv: 0, csv: 0, prem: 0 });

  const html = `
    <div class="page-head">
      <div>
        <div class="sub"><a href="#/investors">← All investors</a></div>
        <h1>${esc(inv.name)}</h1>
        <div class="sub">${esc(inv.investor_type || '')}${inv.legal_name ? ` · ${esc(inv.legal_name)}` : ''}${inv.email ? ` · ${esc(inv.email)}` : ''}</div>
      </div>
      <div class="spacer"></div>
      <button id="editInvestorBtn">Edit investor</button>
      ${isAdminUser() ? `<button class="btn-sm" id="deactivateInvestorBtn">${
        inv.is_active === false ? 'Make active' : 'Make inactive'}</button>
        <button class="btn-danger" id="deleteInvestorBtn">Delete</button>` : ''}
    </div>

    <div class="kpi-row">
      <div class="stat"><div class="label">Positions</div><div class="value">${pos.length}</div>
        <div class="note">${inv.logins.length} login${inv.logins.length === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="label">Death benefit</div><div class="value">${fmtExact(t.db)}</div>
        <div class="note">Their share</div></div>
      <div class="stat"><div class="label">Capital invested</div><div class="value">${fmtExact(t.inv)}</div>
        <div class="note">Their share</div></div>
      <div class="stat"><div class="label">Cash value</div><div class="value">${fmtExact(t.csv)}</div>
        <div class="note">Their share</div></div>
      <div class="stat"><div class="label">Annual premium</div><div class="value">${fmtExact(t.prem)}</div>
        <div class="note">Their share</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Positions</h2></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Policy</th><th>Insured</th><th>Carrier</th><th class="num">Share</th>
          <th class="num">Death benefit</th><th class="num">Invested</th>
          <th class="num">Cash value</th><th>Acquired</th><th>Status</th></tr></thead>
        <tbody>${pos.length === 0
          ? '<tr><td colspan="9"><div class="empty">No positions yet.</div></td></tr>'
          : pos.map((p) => { const f = Number(p.pct) / 100; return `<tr class="clickable" data-id="${p.id}">
              <td class="strong">${esc(p.policy_number)}</td>
              <td>${esc(p.display_name || `${p.insured_last || ''}${p.insured_first ? ', ' + p.insured_first : ''}`)}</td>
              <td>${esc(p.carrier_name)}</td>
              <td class="num strong">${Number(p.pct).toFixed(Number(p.pct) % 1 ? 4 : 0)}%</td>
              <td class="num">${money((Number(p.death_benefit ?? p.face_amount) || 0) * f, 2)}</td>
              <td class="num">${money((Number(p.total_invested) || 0) * f, 2)}</td>
              <td class="num">${money((Number(p.cash_surrender_value) || 0) * f, 2)}</td>
              <td>${p.acquired_on ? fmtDate(p.acquired_on) : '<span class="muted">—</span>'}</td>
              <td>${statusBadge(p.status)}</td>
            </tr>`; }).join('')}
        </tbody>
        ${pos.length ? `<tfoot><tr><td colspan="4">Totals</td>
          <td class="num">${fmtExact(t.db)}</td><td class="num">${fmtExact(t.inv)}</td>
          <td class="num">${fmtExact(t.csv)}</td><td colspan="2"></td></tr></tfoot>` : ''}
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Portal logins</h2></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Email</th><th>Name</th><th>Active</th><th>Last sign-in</th></tr></thead>
        <tbody>${inv.logins.length === 0
          ? '<tr><td colspan="4"><div class="empty">No login yet. Create one under Settings → Users with the role “investor”.</div></td></tr>'
          : inv.logins.map((u) => `<tr>
              <td class="strong">${esc(u.email)}</td><td>${esc(u.full_name || '')}</td>
              <td>${u.is_active ? 'Yes' : 'No'}</td>
              <td class="muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString('en-US') : 'never'}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  return {
    html,
    after: () => {
      $('#editInvestorBtn').addEventListener('click', () => openInvestorDialog(inv));
      onClick('#deactivateInvestorBtn', async () => {
        await api(`/investors/${inv.id}`, { method: 'PUT', body: {
          name: inv.name, is_active: inv.is_active === false } });
        toast(inv.is_active === false ? 'Active again' : 'Made inactive');
        render();
      });
      onClick('#deleteInvestorBtn', () => openDeleteInvestorDialog(inv));
      document.querySelectorAll('tr.clickable[data-id]').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`)));
    },
  };
}

/**
 * Everything on an investor's record, including what they typed into the
 * registration form themselves — people move house and change their
 * telephone number, and a record nobody can correct stops being a record.
 *
 * Two fields are an administrator's alone. The entity decides which
 * manager sees this client, and the tax number is the one field here that
 * is encrypted; letting anybody else set either would quietly undo the
 * reason they are treated differently in the first place.
 */
/**
 * A first password worth reading down a telephone.
 *
 * Three short words and a number rather than a line of noise: it survives
 * being spoken, written on a note and typed back in, which a password that
 * has to be dictated actually has to do. It is also temporary by design —
 * the account cannot do anything until the investor replaces it — so the
 * bar is "not guessable in a day", not "resists an offline attack".
 */
function suggestPassword() {
  const words = ['harbour', 'lantern', 'meadow', 'compass', 'thistle', 'quarry', 'beacon',
    'juniper', 'anchor', 'marble', 'crimson', 'walnut', 'orchard', 'falcon', 'ledger',
    'copper', 'willow', 'tundra', 'saffron', 'granite'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const a = pick();
  let b = pick(); while (b === a) b = pick();
  let c = pick(); while (c === a || c === b) c = pick();
  return `${a}-${b}-${c}-${Math.floor(Math.random() * 90 + 10)}`;
}

/**
 * Deleting an investor.
 *
 * Not like deleting a policy. A policy is a thing the firm owns; an investor
 * is somebody it has a relationship with, who may have a signature on an
 * executed document and money in an account. So this shows the whole
 * footprint first, and where a record would be rewritten it does not offer
 * the choice at all — it offers the right one instead.
 */
async function openDeleteInvestorDialog(inv) {
  const f = await api(`/investors/${inv.id}/footprint`);

  const rows = [
    ['Positions held', f.positions],
    ['Capital invested', fmtExact(f.invested), true],
    ['Death benefit held', fmtExact(f.death_benefit), true],
    ['Portal logins', f.logins],
    ['Capital call lines', f.calls],
    ['Opportunity requests', f.commitments],
    ['Opportunities shared with them', f.shares],
    ['Documents filed against them', f.documents],
    ['Draft agreements naming them', f.agreements],
  ].filter(([, v]) => v && v !== '$0.00');

  const footprint = `
    <table class="data" style="margin-bottom:16px"><tbody>${
      rows.length
        ? rows.map(([label, value]) => `<tr><td>${label}</td>
            <td class="num strong">${value}</td></tr>`).join('')
        : '<tr><td colspan="2" class="muted">Nothing is attached to this record at all.</td></tr>'
    }</tbody></table>`;

  if (f.keeps_records) {
    /* No delete button on this dialog. The answer is not "are you sure" — it
       is that this is the wrong thing to do, and here is the right one. */
    return openDialog(`${inv.name} cannot be deleted`, `
      <p style="margin:0 0 14px;font-size:14px">
        ${esc(inv.name)} has ${[
          f.signed_agreements ? `signed ${f.signed_agreements} agreement${
            f.signed_agreements === 1 ? '' : 's'} that went out` : '',
          f.paid_calls ? `paid ${f.paid_calls} capital call${
            f.paid_calls === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}.
      </p>
      <div class="error-box" style="margin-bottom:16px">
        Deleting them would take a signature off an executed document, or make money
        arrive from nobody. Neither is a tidy-up; both are a rewrite of what happened.
      </div>
      ${footprint}
      <p style="margin:0;font-size:14px">Making them <strong>inactive</strong> does what you
        probably want: every figure and every signature stays exactly where it is, and they
        drop off the lists you work from.</p>
    `, async () => {
      await api(`/investors/${inv.id}`, { method: 'PUT', body: {
        name: inv.name, is_active: false } });
      toast('Made inactive');
      go('#/investors');
    }, 'Make them inactive');
  }

  return openDialog(`Delete ${inv.name}`, `
    <p style="margin:0 0 14px;font-size:14px">
      This permanently deletes <strong>${esc(inv.name)}</strong> and everything attached to
      the record. It cannot be undone.
    </p>
    ${footprint}
    ${f.positions ? `<div class="error-box" style="margin-bottom:16px">
      ${f.positions} ${f.positions === 1 ? 'position goes' : 'positions go'} with them —
      ${fmtExact(f.invested)} of capital invested disappears from the cap tables of the
      policies they are on. The policies themselves stay; their share simply becomes
      unallocated.</div>` : ''}
    ${f.logins ? `<div class="notice-box" style="margin-bottom:16px">
      Their portal login is deleted too. An investor account attached to nobody could still
      sign in, which is worse than no account.</div>` : ''}
    <p style="margin:0 0 14px;font-size:13px" class="secondary">
      If they are simply not a client any more, <strong>Make inactive</strong> is the better
      answer — it keeps every figure and drops them off the lists.
    </p>
    ${inputField(`Type <b>${esc(inv.name)}</b> to confirm`, 'confirm', '', 'text',
      'required autocomplete=off')}
  `, async (v) => {
    if (String(v.confirm || '').trim() !== inv.name)
      throw new Error(`Type ${inv.name} exactly to confirm.`);
    await api(`/investors/${inv.id}`, { method: 'DELETE', body: { confirm: v.confirm.trim() } });
    toast(`${inv.name} deleted`);
    go('#/investors');
  }, 'Delete them');
}

function openInvestorDialog(inv) {
  const isNew = !inv?.id;
  const isAdmin = state.user.role === 'admin';
  const funds = state.funds || [];
  /* An investor who registers themselves arrives with a login already, and
     nobody here ever knew the password. One the office opens an account for
     has neither, so it is set up on this screen rather than in a second trip
     through Settings that a manager could not make at all. */
  const mayOpenLogin = ['admin', 'manager'].includes(state.user.role);
  const hasLogin = !!inv?.login_email;
  const body = `
    <div class="field-row">
      ${inputField('Name *', 'name', inv?.name, 'text', 'required')}
      ${selectField('Type', 'investor_type', inv?.investor_type || 'Individual', INVESTOR_TYPES)}
    </div>
    ${inputField('Full legal name', 'legal_name', inv?.legal_name, 'text',
      'placeholder="As it appears on the purchase agreement"')}

    <div class="dlg-section">How to reach them</div>
    <div class="field-row">
      ${inputField('Email', 'email', inv?.email, 'email')}
      ${inputField('Phone', 'phone', inv?.phone)}
    </div>
    ${inputField('Street address', 'address_line1', inv?.address_line1)}
    ${inputField('Apartment, suite or unit', 'address_line2', inv?.address_line2)}
    <div class="field-row">
      ${inputField('City', 'city', inv?.city)}
      ${stateField('State', 'state', inv?.state)}
      ${inputField('ZIP', 'postal_code', inv?.postal_code)}
    </div>
    ${inputField('Country', 'country', inv?.country || 'United States')}

    <div class="dlg-section">${isAdmin ? 'Administrator only' : 'On file'}</div>
    ${isAdmin ? `
    <div class="field-row">
      <div class="field">
        <label>Owner entity</label>
        <select name="fund_id">
          <option value="">— not assigned —</option>
          ${funds.map((f) => `<option value="${f.id}" ${
            Number(inv?.fund_id) === Number(f.id) ? 'selected' : ''}>${esc(f.code)}${
            f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
        </select>
        <span class="muted" style="font-size:12px">Whose client they are. The manager of that
          entity sees them in their investor list straight away, before they hold anything.</span>
      </div>
      <div class="field">
        <label>Tax ID</label>
        <input name="tax_id" inputmode="numeric" autocomplete="off" maxlength="14"
               placeholder="${inv?.tax_id_last4
                 ? `on file, ending ${esc(inv.tax_id_last4)}` : 'not on file'}">
        <span class="muted" style="font-size:12px">${inv?.id && inv?.tax_id_last4
          ? '<a href="#" id="revealInvTax">Show the number in full</a> · '
          : ''}Typing a new one replaces it. It is encrypted; only the last four digits are
          shown afterwards.</span>
      </div>
    </div>` : `
    <div class="field-row">
      <div class="field"><label>Owner entity</label>
        <div class="strong" style="padding:7px 0">${esc(inv?.fund_code || '—')}</div>
        <span class="muted" style="font-size:12px">Set by an administrator.</span></div>
      <div class="field"><label>Tax ID</label>
        <div class="strong app-tax" style="padding:7px 0">${
          inv?.tax_id_last4 ? esc(maskTaxIdClient(inv.tax_id_last4, inv.investor_type)) : '—'}</div>
        <span class="muted" style="font-size:12px">Only an administrator can change it.</span></div>
    </div>`}

    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(inv?.notes || '')}</textarea></div>

    ${mayOpenLogin && !hasLogin ? `
    <div class="dlg-section">Portal access</div>
    <label class="dlg-check">
      <input type="checkbox" id="wantLogin" name="create_login" value="yes">
      <span>${isNew ? 'Give them a login now' : 'Open a login for them now'} — they can sign in
        and see their own positions, statements and agreements.</span>
    </label>
    <div id="loginFields" style="display:none">
      <div class="field-row">
        ${inputField('Sign-in email', 'login_email', inv?.email, 'email',
          'autocomplete=off placeholder="they sign in with this"')}
        <div class="field">
          <label>First password</label>
          <div style="display:flex;gap:6px">
            <input name="login_password" type="text" autocomplete="off" minlength="10"
                   class="grow" placeholder="at least 10 characters">
            <button type="button" class="btn-sm" id="suggestPw">Suggest</button>
          </div>
          <span class="muted" style="font-size:12px">Shown as you type, because you have to
            read it out to them.</span>
        </div>
      </div>
      <label class="dlg-check">
        <input type="checkbox" name="must_change_password" value="yes" checked>
        <span>Make them choose their own password the first time they sign in.
          <span class="muted">Leave this on unless they are with you and typing it
          themselves — a password you set is one you know.</span></span>
      </label>
    </div>` : ''}
    ${hasLogin ? `
    <div class="dlg-section">Portal access</div>
    <div class="field">
      <div class="strong" style="padding:2px 0">${esc(inv.login_email)}</div>
      <span class="muted" style="font-size:12px">They already sign in with this address.
        ${isAdmin ? 'A password reset is on Settings → Users.'
          : 'An administrator can reset the password from Settings.'}</span>
    </div>` : ''}`;

  const dlg = openDialog(isNew ? 'New investor' : 'Edit investor', body, async (v) => {
    // An untouched tax box must not be read as "clear it".
    if (!String(v.tax_id || '').trim()) delete v.tax_id;

    const wantsLogin = v.create_login === 'yes';
    const login = wantsLogin
      ? { login_email: String(v.login_email || '').trim(),
          login_password: String(v.login_password || ''),
          must_change_password: v.must_change_password === 'yes' }
      : {};
    if (wantsLogin) {
      if (!login.login_email) throw new Error('Give them an address to sign in with.');
      if (login.login_password.length < 10)
        throw new Error('A password must be at least 10 characters.');
    }
    /* The login fields are never sent as investor columns, whether or not one
       was asked for — an unticked box must not write an empty password
       anywhere. */
    delete v.create_login; delete v.login_email;
    delete v.login_password; delete v.must_change_password;

    if (isNew) {
      const made = await api('/investors', { method: 'POST', body: { ...v, ...login } });
      toast(made.login_email ? `Investor created · signs in as ${made.login_email}`
        : 'Investor created');
    } else {
      await api(`/investors/${inv.id}`, { method: 'PUT', body: v });
      if (wantsLogin) {
        await api(`/investors/${inv.id}/login`, { method: 'POST', body: login });
        toast(`Investor updated · signs in as ${login.login_email}`);
      } else {
        toast('Investor updated');
      }
    }
    state.investors = await api('/investors');
  }, isNew ? 'Create investor' : 'Save');

  /* The fields appear only once somebody asks for a login, so the form is not
     a wall of password boxes for the ordinary case of adding a record. */
  const loginBox = $('#wantLogin', dlg);
  loginBox?.addEventListener('change', () => {
    const fields = $('#loginFields', dlg);
    fields.style.display = loginBox.checked ? '' : 'none';
    if (!loginBox.checked) return;
    /* Start from the address already typed above. Somebody filling this in
       has just written where to reach them, and asking for it twice is how
       the two end up different. */
    const signIn = $('input[name=login_email]', dlg);
    if (!signIn.value.trim()) signIn.value = $('input[name=email]', dlg)?.value.trim() || '';
    (signIn.value.trim() ? $('input[name=login_password]', dlg) : signIn).focus();
  });
  $('#suggestPw', dlg)?.addEventListener('click', () => {
    $('input[name=login_password]', dlg).value = suggestPassword();
  });

  $('#revealInvTax', dlg)?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/investors/${inv.id}/tax-id`);
      const box = $('input[name=tax_id]', dlg);
      box.value = r.tax_id.replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3');
      e.target.replaceWith(document.createTextNode('Shown above. '));
    } catch (err) { alert(err.message); }
  });
  return dlg;
}

/** "•••-••-6789", the same shape the server prints on an application. */
const maskTaxIdClient = (last4, kind = '') => (last4
  ? (/ein|entity|trust/i.test(kind) ? `••-•••${last4}` : `•••-••-${last4}`) : '');

/* ------------------------------ import ------------------------------- */

const IMPORT_TYPES = [
  ['master', 'Everything — full data dump (recommended)',
   'Drop in as many files as you like, CSV or Excel. Every sheet of a workbook is read, each row is worked out for what it is, and the whole lot is loaded in dependency order — so a transaction can sit in a different file from the policy it belongs to and still land.'],
  ['policies', 'Policies (and current values)',
   'Your monthly CRM export. Creates or updates policies, and records a value snapshot from any AV / CSV / COI columns.'],
  ['values', 'Value snapshots only',
   'Adds AV / CSV / COI / death benefit for an "as of" date against policies that already exist.'],
  ['transactions', 'Transactions',
   'Premium payments, acquisition costs, fees and withdrawals against existing policies.'],
];

function importView() {
  const html = `
    <div class="page-head"><div><h1>Import data</h1>
      <div class="sub">Upload CSV files or Excel workbooks — as many at once as you like. Column names are matched automatically: "Policy #", "Basic Face", "AV", "CSV", "COI" and the rest of your export headers are all recognised.</div></div></div>

    <div class="card">
      <div class="card-body">
        <div class="field">
          <label>What are you importing?</label>
          <select id="importType">
            ${IMPORT_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
          <div class="muted" id="typeHint" style="margin-top:6px;font-size:12.5px">${IMPORT_TYPES[0][2]}</div>
        </div>

        <div class="field">
          <label>"Values as of" date <span class="muted" style="font-weight:400">— used for rows with no date column</span></label>
          <input type="date" id="asOfDate" value="${today()}">
        </div>

        <div class="field">
          <label style="display:flex;align-items:center;gap:8px;text-transform:none;font-family:var(--font);font-size:13.5px;letter-spacing:0;color:var(--text-primary)">
            <input type="checkbox" id="allowDupes" style="width:auto;margin:0">
            Allow duplicate ledger rows
          </label>
          <span class="muted" style="font-size:12px">
            Off by default: a transaction identical to one already on file — same policy,
            date, type and amount — is skipped and counted, so re-running a file cannot
            double your capital invested and halve every return. Tick this only if the policy
            genuinely took two identical payments on the same day.</span>
        </div>

        ${state.user.role === 'admin' || state.user.role === 'editor' ? `
        <div class="field" style="margin-top:14px">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">
            <input type="checkbox" id="replaceLedger" style="width:auto;margin:0">
            Replace the ledger on every policy in this file
          </label>
          <span class="muted" style="font-size:12px">
            For when the file <em>is</em> the record rather than an addition to it — a premium
            workbook the office actually runs on, against an export that turned out to be
            patchy. Every policy with a transaction row in the upload has its existing ledger
            cleared first, so the result says exactly what the file says. Policies not named in
            the file are untouched, and every clearance is written to the activity log with the
            number of rows and their total. <strong>This deletes transactions.</strong></span>
        </div>` : ''}

        <div class="dropzone" id="dropzone">
          <div style="font-weight:600;margin-bottom:4px">Drop files here, or click to choose</div>
          <div class="muted" style="font-size:12.5px">
            CSV or Excel · up to 20 files · 5 MB each · 25,000 rows in total</div>
          <input type="file" id="fileInput" multiple
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style="display:none">
        </div>

        <div style="margin-top:10px">
          <a href="#" data-template="master"><strong>Download the master template</strong></a> ·
          <a href="#" data-template="policies">policies</a> ·
          <a href="#" data-template="values">values</a> ·
          <a href="#" data-template="transactions">transactions</a>
        </div>
      </div>
    </div>

    <div id="importResult"></div>`;

  return {
    html,
    after: () => {
      const typeSel = $('#importType');
      typeSel.addEventListener('change', () => {
        $('#typeHint').textContent = IMPORT_TYPES.find((t) => t[0] === typeSel.value)[2];
      });

      const dz = $('#dropzone');
      const fi = $('#fileInput');
      dz.addEventListener('click', () => fi.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('over');
        if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
      });
      fi.addEventListener('change', () => {
        const chosen = [...fi.files];
        // Clearing the input means choosing the SAME files again still fires a
        // change event — otherwise a second run after fixing something in the
        // spreadsheet appears to do nothing at all.
        fi.value = '';
        if (chosen.length) handleFiles(chosen);
      });

      document.querySelectorAll('[data-template]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          window.location = `/api/import/template/${a.dataset.template}`;
        }));
    },
  };
}

async function handleFiles(files) {
  const type = $('#importType').value;
  const out = $('#importResult');
  const label = files.length === 1 ? esc(files[0].name) : `${files.length} files`;
  out.innerHTML = `<div class="card"><div class="card-body"><span class="spin"></span> Reading ${label}…</div></div>`;

  const build = () => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('type', type);
    return fd;
  };

  // A row's origin is a file, a tab and a line — printing only the line
  // number would be useless once more than one file is in play.
  const origin = (e) => [e.file, e.sheet, e.line ? `line ${e.line}` : null]
    .filter(Boolean).map(esc).join(' · ');

  try {
    const preview = await api('/import/preview', { method: 'POST', body: build() });

    out.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Preview — ${label}</h2><div class="spacer"></div>
          <span class="muted">${preview.rowCount} rows</span></div>
        <div class="card-body">
          ${preview.sources?.length > 1 || preview.sources?.[0]?.sheet ? `
          <div style="margin-bottom:14px">
            <label>Files and sheets found</label>
            <div class="table-wrap"><table class="data">
              <thead><tr><th>File</th><th>Sheet</th><th class="num">Rows</th><th></th></tr></thead>
              <tbody>${preview.sources.map((s) => `<tr>
                <td class="strong">${esc(s.file)}</td>
                <td>${s.sheet ? esc(s.sheet) : '<span class="muted">—</span>'}</td>
                <td class="num">${s.rows}</td>
                <td class="secondary">${s.note ? esc(s.note) : ''}</td>
              </tr>`).join('')}</tbody>
            </table></div>
          </div>` : ''}

          ${preview.byType ? `
          <div style="margin-bottom:14px">
            <div style="margin-bottom:8px"><strong>What each row was read as</strong>
              <span class="muted" style="font-size:12px">${preview.declared
                ? '— from your Record Type column'
                : '— worked out from the shape of each row'}</span></div>
            <div class="kpi-row" style="margin:0">
              ${[['policy', 'Policies'], ['insured', 'Insured updates'], ['life', 'Additional lives'],
                 ['value', 'Value snapshots'], ['transaction', 'Transactions'],
                 ['premium', 'Future premiums']].map(([k, l]) => `
                <div class="stat"><div class="label">${l}</div>
                  <div class="value">${preview.byType[k]}</div></div>`).join('')}
              ${preview.byType.unclassified ? `<div class="stat">
                <div class="label">Unreadable</div>
                <div class="value" style="color:var(--critical)">${preview.byType.unclassified}</div></div>` : ''}
            </div>
            ${preview.problems?.length ? `
              <div class="error-box" style="margin-top:12px">
                <strong>${preview.byType.unclassified} row${preview.byType.unclassified === 1 ? '' : 's'}
                cannot be classified and will be skipped:</strong>
                <ul style="margin:8px 0 0;padding-left:20px">
                  ${preview.problems.slice(0, 8).map((pr) =>
                    `<li>${origin(pr)} — ${esc(pr.message)}</li>`).join('')}
                </ul>
              </div>` : ''}
          </div>` : ''}

          <div style="margin-bottom:12px">
            <div style="margin-bottom:6px"><strong>Matched columns:</strong>
              <span class="secondary">${preview.recognised.map(esc).join(', ') || 'none'}</span></div>
            ${preview.unrecognised.length ? `<div><strong>Ignored columns:</strong>
              <span class="muted">${preview.unrecognised.map(esc).join(', ')}</span></div>` : ''}
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr>${preview.recognised.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
              <tbody>${preview.sample.map((r) =>
                `<tr>${preview.recognised.map((c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px">
            <button class="primary" id="runImportBtn">Import ${preview.rowCount} rows</button>
            <button id="cancelImportBtn">Cancel</button>
          </div>
        </div>
      </div>`;

    $('#cancelImportBtn').addEventListener('click', () => { out.innerHTML = ''; });
    $('#runImportBtn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.innerHTML = '<span class="spin"></span> Importing…';
      const fd2 = build();
      fd2.append('asOfDate', $('#asOfDate').value);
      fd2.append('allowDuplicates', $('#allowDupes').checked ? 'true' : 'false');
      fd2.append('replaceLedger', $('#replaceLedger')?.checked ? 'true' : 'false');
      try {
        const res = await api('/import/run', { method: 'POST', body: fd2 });
        out.innerHTML = `
          <div class="card"><div class="card-body">
            <div class="ok-box">Imported ${res.rowCount} rows from ${label}</div>
            <dl class="kv">
              <dt>Records created</dt><dd>${res.created}</dd>
              <dt>Records updated</dt><dd>${res.updated}</dd>
              <dt>Value snapshots written</dt><dd>${res.values}</dd>
              ${res.skipped ? `<dt>Duplicate ledger rows skipped</dt><dd>${res.skipped}</dd>` : ''}
              ${res.removed ? `<dt>Ledger rows replaced</dt><dd>${res.removed}</dd>` : ''}
              <dt>Rows with errors</dt><dd>${res.errors.length}</dd>
            </dl>
            ${res.byType ? `<div style="margin-top:12px">
              <label>By record type</label>
              <span class="secondary">${Object.entries(res.byType)
                .filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ')}</span>
            </div>` : ''}
            ${res.removed ? `<div class="muted" style="margin-top:10px;font-size:12.5px">
              ${res.removed} existing ledger row${res.removed === 1 ? '' : 's'} on the policies
              named in this file ${res.removed === 1 ? 'was' : 'were'} cleared before the file's
              own rows were written, so those ledgers now say exactly what the file says. Every
              clearance is in the activity log.</div>` : ''}
            ${res.skipped ? `<div class="muted" style="margin-top:10px;font-size:12.5px">
              ${res.skipped} ledger row${res.skipped === 1 ? ' was' : 's were'} already on file
              and skipped, so nothing was double-counted. Tick "Allow duplicate ledger rows"
              above if they were genuinely separate payments.</div>` : ''}
            ${res.errors.length ? `<div style="margin-top:14px">
              <label>Errors</label>
              <div class="table-wrap"><table class="data">
                <thead><tr><th>Where</th><th>Problem</th></tr></thead>
                <tbody>${res.errors.slice(0, 60).map((er) =>
                  `<tr><td>${origin(er)}</td><td>${esc(er.message)}</td></tr>`).join('')}</tbody>
              </table></div></div>` : ''}
            <div style="margin-top:14px"><a class="btn btn-primary" href="#/policies">View policies</a></div>
          </div></div>`;
      } catch (err) {
        out.innerHTML = `<div class="card"><div class="card-body">
          <div class="error-box">${esc(err.message)}</div></div></div>`;
      }
    });
  } catch (err) {
    out.innerHTML = `<div class="card"><div class="card-body">
      <div class="error-box">${esc(err.message)}</div></div></div>`;
  }
}


/* ------------------------------ settings ----------------------------- */

/* ----------------------------- documents ----------------------------- */

const DOC_CATEGORIES = [
  'LLC Agreement', 'Subscription Agreement', 'K-1', 'Tax', 'Statement',
  'Policy Document', 'Correspondence', 'Other',
];

/** Bytes as a person would say them. */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
}

/** The search box only appears once the cabinet is big enough to need it. */
function docFiltered(docs) {
  const f = state.docFilter || {};
  const term = String(f.search || '').toLowerCase();
  return docs.filter((d) => {
    if (f.category && d.category !== f.category) return false;
    if (!term) return true;
    return [d.title, d.file_name, d.notes, d.investor_name, d.category]
      .some((v) => String(v || '').toLowerCase().includes(term));
  });
}

/**
 * Download through fetch rather than a plain link.
 *
 * The session is a cookie, so a link would work — but it would also open a
 * new tab that shows an error page as raw JSON if anything is wrong, and
 * say nothing useful when a document has been unshared underneath you.
 * This keeps the failure inside the application.
 */
async function downloadDocument(id, fallbackName = 'document') {
  const res = await fetch(`/api/documents/${id}/download`, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = 'That document could not be downloaded.';
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const disp = res.headers.get('Content-Disposition') || '';
  const named = /filename="([^"]+)"/.exec(disp)?.[1] || fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = named;
  document.body.appendChild(a); a.click(); a.remove();
  // Revoke on the next tick: revoking synchronously races the download in
  // some browsers and produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Post a document, or correct one already posted.
 *
 * Who it is for is the only question that matters here, so it is asked
 * plainly rather than hidden behind a set of optional fields: the firm, an
 * owning entity, or one investor. Sharing is a separate, explicit tick,
 * because a K-1 exists for weeks before anybody should see it.
 */
function openDocumentDialog(existing, funds, investors, onSaved) {
  const editing = !!existing;
  const thisYear = new Date().getFullYear();
  const target = editing
    ? (existing.investor_id ? 'investor' : existing.fund_id ? 'fund' : 'firm')
    : 'firm';

  const dlg = openDialog(editing ? `Edit ${existing.title}` : 'Upload a document', `
    ${editing ? '' : `
    <div class="field">
      <label>File *</label>
      <input type="file" name="file" required
             accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.rtf,.png,.jpg,.jpeg,.gif,.tif,.tiff,.zip">
      <span class="muted" style="font-size:12px">Up to 15 MB. PDF, Word, Excel, PowerPoint,
        images and zip archives.</span>
    </div>`}

    <div class="field-row">
      ${inputField('Title', 'title', existing?.title || '', 'text',
        editing ? 'required' : 'placeholder="Leave blank to use the file name"')}
      <div class="field"><label>Category</label>
        <select name="category">
          ${DOC_CATEGORIES.map((c) => `<option ${
            (existing?.category || 'LLC Agreement') === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select></div>
      ${inputField('Year', 'doc_year', existing?.doc_year ?? '', 'number',
        `min=1990 max=${thisYear + 2} placeholder="${thisYear - 1}"`)}
    </div>

    <div class="dlg-section">Who it is for</div>
    <div class="field">
      <div class="step-kind">
        <label class="rpt-choice ${target === 'firm' ? 'selected' : ''}">
          <input type="radio" name="target" value="firm" ${target === 'firm' ? 'checked' : ''}>
          <strong>The whole firm</strong>
          <span class="muted" style="display:block;font-size:12px;margin-top:3px">
            Every member of staff can see it. No investor can.</span>
        </label>
        <label class="rpt-choice ${target === 'fund' ? 'selected' : ''}">
          <input type="radio" name="target" value="fund" ${target === 'fund' ? 'checked' : ''}>
          <strong>An owner entity</strong>
          <span class="muted" style="display:block;font-size:12px;margin-top:3px">
            Follows the entity — its managers see it, others do not.</span>
        </label>
        <label class="rpt-choice ${target === 'investor' ? 'selected' : ''}">
          <input type="radio" name="target" value="investor" ${target === 'investor' ? 'checked' : ''}>
          <strong>One investor</strong>
          <span class="muted" style="display:block;font-size:12px;margin-top:3px">
            A K-1, a statement, a signed subscription.</span>
        </label>
      </div>
    </div>

    <div class="field" id="docFundField" style="display:none">
      <label>Owner entity</label>
      <select name="fund_id">
        ${funds.map((f) => `<option value="${f.id}" ${
          Number(existing?.fund_id) === Number(f.id) ? 'selected' : ''}>${esc(f.code)}${
          f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
      </select>
    </div>

    <div class="field" id="docInvestorField" style="display:none">
      <label>Investor</label>
      <select name="investor_id">
        ${investors.map((i) => `<option value="${i.id}" ${
          Number(existing?.investor_id) === Number(i.id) ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
      </select>
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;text-transform:none;
                    font-family:var(--font);font-size:13.5px;letter-spacing:0;color:var(--text-primary)">
        <input type="checkbox" name="shared" ${existing?.shared ? 'checked' : ''}
               style="width:auto;margin:0"> Share it with them now
      </label>
      <span class="muted" style="font-size:12px">
        Until this is ticked the document is staff-only, so a draft can sit here safely.
        Once ticked it appears under Documents when they sign in.</span>
    </div>

    <div class="field"><label>Notes</label>
      <input name="notes" value="${esc(existing?.notes || '')}"
             placeholder="Executed 12 March, countersigned"></div>
  `, async (v) => {
    const chosen = dlg.querySelector('input[name=target]:checked').value;
    const body = {
      title: v.title, category: v.category, doc_year: v.doc_year, notes: v.notes,
      fund_id: chosen === 'fund' ? v.fund_id : '',
      investor_id: chosen === 'investor' ? v.investor_id : '',
      shared: chosen === 'investor' && v.shared === 'on',
    };
    if (editing) {
      await api(`/documents/${existing.id}`, { method: 'PUT', body });
      toast('Document updated');
    } else {
      const input = dlg.querySelector('input[type=file]');
      const file = input.files?.[0];
      if (!file) throw new Error('Choose a file to upload.');
      if (file.size > 15 * 1024 * 1024)
        throw new Error(`That file is ${fmtBytes(file.size)}. The limit is 15 MB.`);
      const fd = new FormData();
      fd.append('file', file);
      for (const [k, val] of Object.entries(body)) fd.append(k, val === null ? '' : String(val));
      const res = await fetch('/api/documents', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) {
        let msg = 'Upload failed.';
        try { msg = (await res.json()).error || msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      toast('Document posted');
    }
    onSaved?.();
  }, editing ? 'Save' : 'Upload');

  const sync = () => {
    const chosen = dlg.querySelector('input[name=target]:checked').value;
    $('#docFundField', dlg).style.display = chosen === 'fund' ? '' : 'none';
    $('#docInvestorField', dlg).style.display = chosen === 'investor' ? '' : 'none';
    dlg.querySelectorAll('.step-kind .rpt-choice').forEach((el) =>
      el.classList.toggle('selected', el.querySelector('input').checked));
  };
  dlg.querySelectorAll('input[name=target]').forEach((el) => el.addEventListener('change', sync));
  sync();
  return dlg;
}

async function settingsView() {
  const isAdmin = state.user.role === 'admin';
  const canEdit = ['admin', 'editor'].includes(state.user.role);
  // Anything beyond the password panel is off-limits to scoped accounts.
  const accountOnly = isInvestorUser() || isManagerUser();
  const investorUser = accountOnly;
  const [users, audit, funds, docs, investors, myPlaces, firmNotices, mail, mailHealth]
    = await Promise.all([
    isAdmin ? api('/users') : Promise.resolve([]),
    isAdmin ? api('/audit') : Promise.resolve([]),
    accountOnly ? Promise.resolve([]) : api('/funds'),
    // Staff read the cabinet on the Documents tab; here it is only an
    // investor's own copies, on the one page they have for them.
    isInvestorUser() ? api('/documents').catch(() => []) : Promise.resolve([]),
    isInvestorUser() ? Promise.resolve([]) : api('/investors').catch(() => []),
    // Everybody can see where their own account has been used. Only an
    // administrator sees the firm's.
    api('/security/locations').catch(() => []),
    isAdmin ? api('/security/notices').catch(() => []) : Promise.resolve([]),
    api('/me/notifications').catch(() => null),
    isAdmin ? api('/mail/health').catch(() => null) : Promise.resolve(null),
  ]);
  state.funds = funds;
  const canPost = ['admin', 'editor', 'manager'].includes(state.user.role);

  const html = `
    <div class="page-head"><div><h1>${accountOnly ? 'Account' : 'Settings'}</h1>
      <div class="sub">Signed in as ${esc(state.user.email)}${
        isInvestorUser() && state.user.investor ? ` · ${esc(state.user.investor.name)}`
        : isManagerUser() && state.user.funds?.length ? ` · manager of ${state.user.funds.map((f) => esc(f.code)).join(', ')}`
        : ` (${esc(state.user.role)})`}</div></div></div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Change your password</h2></div>
        <div class="card-body">
          <div id="pwMsg"></div>
          <form id="pwForm">
            ${inputField('Current password', 'currentPassword', '', 'password', 'required autocomplete=current-password')}
            ${inputField('New password (10+ characters)', 'newPassword', '', 'password', 'required minlength=10 autocomplete=new-password')}
            <button class="primary" type="submit">Update password</button>
          </form>
        </div>
      </div>

      ${/* Not asked for at sign-up, so this is where it arrives — from the
           person it belongs to, over a session that has already been
           authenticated. Filling a blank only: once a number is on file,
           changing it goes through the office. */''}
      ${isInvestorUser() ? `
      <div class="card">
        <div class="card-head"><h2>Tax reporting</h2></div>
        <div class="card-body">
          <div id="taxMsg"></div>
          ${state.user.investor?.tax_id_last4 ? `
            <p style="margin:0 0 6px;font-size:14px">
              Tax number on file, ending
              <strong>${esc(state.user.investor.tax_id_last4)}</strong>.</p>
            <span class="muted" style="font-size:12.5px">Stored encrypted; only these four
              digits are ever displayed, and every time anyone here reads the full number it
              goes to the activity log. To correct it, call the office &mdash; a tax number
              cannot be changed from this screen, because it decides where your K&#8209;1
              goes.</span>` : `
            <p style="margin:0 0 10px;font-size:14px">
              We do not have a tax number for you yet. It is needed to issue your
              K&#8209;1 &mdash; you can add it here whenever it suits you.</p>
            <form id="taxForm">
              ${inputField('Social Security number or Tax ID (EIN)', 'tax_id', '', 'text',
                'required autocomplete=off inputmode=numeric maxlength=14 placeholder="123-45-6789"')}
              <span class="muted" style="font-size:12.5px;display:block;margin:-6px 0 12px">
                It is encrypted the moment it reaches us, only the last four digits are ever
                displayed afterwards, and nobody here can read the whole number without it
                being written to the activity log.</span>
              <button class="primary" type="submit">Save it</button>
            </form>`}
        </div>
      </div>` : ''}

      ${isInvestorUser() ? '' : `
      <div class="card">
        <div class="card-head"><h2>Import data</h2><div class="spacer"></div>
          <a class="btn btn-sm" href="#/import">Open the importer</a></div>
        <div class="card-body">
          <span class="muted" style="font-size:13px">Load policies, insureds, carrier statements,
          transactions and future premiums from a spreadsheet — one file or several. Every import
          is previewed before anything is written, and re-importing the same file changes nothing,
          so it is safe to run twice.</span>
        </div>
      </div>`}

      ${/* What lands in somebody's inbox, decided by them. A notice on a
             screen only helps a person who is looking at the screen. */''}
      ${mail ? `
      <div class="card">
        <div class="card-head"><h2>Email</h2><div class="spacer"></div>
          <span class="muted" style="font-size:12px">${esc(mail.email)}</span></div>
        <div class="card-body">
          ${mail.sending ? '' : `<div class="notice-box" style="margin-bottom:14px">
            The portal is not set up to send email yet, so these are what
            <em>would</em> be sent. ${isAdmin
              ? 'Add <code>RESEND_API_KEY</code> and <code>MAIL_FROM</code> to the service and restart.'
              : 'An administrator has to finish setting it up.'}</div>`}
          <div id="mailPrefs">
            ${mail.kinds.map((k) => `
              <label class="dlg-check" style="margin:0 0 12px">
                <input type="checkbox" data-mail="${k.kind}" ${k.enabled ? 'checked' : ''}
                  ${k.forced ? 'disabled' : ''}>
                <span>${esc(k.label)}
                  <span class="muted" style="display:block;font-size:12px">${esc(k.note)}${
                    k.forced ? ' Always sent — it is the one that matters when it is not you.'
                      : ''}</span></span>
              </label>`).join('')}
          </div>
          <div id="mailMsg"></div>
          <button class="btn-sm" id="saveMailPrefs">Save what I hear about</button>
          ${isAdmin ? '<button class="btn-sm" id="testMail">Send me a test</button>' : ''}
        </div>
      </div>` : ''}

      ${isAdmin && mailHealth ? `
      <div class="card">
        <div class="card-head"><h2>The post</h2><div class="spacer"></div>
          <span class="muted" style="font-size:12px">${mailHealth.configured
            ? esc(mailHealth.from || 'sending') : 'not configured'}</span></div>
        ${mailHealth.from_problem ? `<div class="card-body" style="padding-bottom:0">
          <div class="error-box">${esc(mailHealth.from_problem)}</div></div>` : ''}
        ${mailHealth.link_problem ? `<div class="card-body" style="padding-bottom:0">
          <div class="error-box">${esc(mailHealth.link_problem)}</div></div>` : `
          <div class="card-body" style="padding-bottom:0">
            <span class="muted" style="font-size:12px">Every message links to
              <strong>${esc(mailHealth.link || '—')}</strong> — the sign-in screen, never a
              page inside the portal, so nobody meets a login form where they expected the
              thing they were told about.</span></div>`}
        <div class="table-wrap"><table class="data">
          <tbody>
            <tr><td>Sent</td><td class="num strong">${mailHealth.counts?.Sent || 0}</td></tr>
            <tr><td>Waiting to go</td><td class="num strong">${mailHealth.counts?.Queued || 0}</td></tr>
            <tr><td>Given up on</td><td class="num strong">${mailHealth.counts?.Failed || 0}</td></tr>
            <tr><td>Not sent — switched off by the recipient</td>
              <td class="num">${mailHealth.counts?.Skipped || 0}</td></tr>
          </tbody>
        </table></div>
        ${mailHealth.failures?.length ? `
        <div class="card-body" style="border-top:1px solid var(--grid)">
          <div class="eyebrow" style="margin-bottom:8px">What went wrong</div>
          ${mailHealth.failures.map((f) => `<div class="muted" style="font-size:12.5px">
            ${fmtDateTime(f.created_at)} · ${esc(f.kind)} → ${esc(f.to_email)} ·
            ${esc(f.last_error)}</div>`).join('')}
        </div>` : ''}
        <div class="card-body" style="border-top:1px solid var(--grid);padding-top:12px">
          <span class="muted" style="font-size:12px">
            Email is queued inside the request that causes it and sent afterwards, so a
            provider being slow never makes the portal slow. A message that fails is retried
            with a widening gap and then shown here rather than disappearing.</span>
        </div>
      </div>` : ''}

      ${/* Where this account has been used. Shown to everybody, including
             investors, because the person best placed to spot a sign-in they
             did not make is the person whose account it is. */''}
      <div class="card">
        <div class="card-head"><h2>Where you have signed in</h2><div class="spacer"></div>
          <span class="muted" style="font-size:12px">last 50</span>
          ${myPlaces.length ? '<button class="btn-sm" id="forgetPlaces">Start this list again</button>' : ''}</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Browser and network</th><th class="num">Sign-ins</th>
            <th>First</th><th>Most recent</th></tr></thead>
          <tbody>${myPlaces.length === 0
            ? '<tr><td colspan="4"><div class="empty">Nothing recorded yet.</div></td></tr>'
            : myPlaces.map((l) => `<tr>
              <td class="strong">${esc(l.label)}</td>
              <td class="num">${l.sign_ins}</td>
              <td class="muted">${fmtDateTime(l.first_seen)}</td>
              <td>${fmtDateTime(l.last_seen)}</td>
            </tr>`).join('')}</tbody>
        </table></div>
        <div class="card-body" style="border-top:1px solid var(--grid);padding-top:12px">
          <span class="muted" style="font-size:12px">
            The address is kept as a network, not a full address — enough to tell your
            office from somewhere else, and not a record of where you are. A sign-in from
            a network this account has not used before puts a notice across the top of
            the screen. If you see one you did not make, change your password: it ends
            every other session at once.<br><br>
            If something in front of the application changes — a new office, or a service
            in the way that answers from a different machine each time — every recorded
            place can become the wrong shape at once. <strong>Start this list again</strong>
            clears them: the next sign-in counts as a first one and raises nothing.</span>
        </div>
      </div>

      ${isAdmin ? `
      <div class="card">
        <div class="card-head"><h2>Security notices</h2><div class="spacer"></div>
          <span class="muted" style="font-size:12px">the firm · last 90 days</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>When</th><th>What</th><th>Account</th><th>Seen</th></tr></thead>
          <tbody>${firmNotices.length === 0
            ? '<tr><td colspan="4"><div class="empty">Nothing to report.</div></td></tr>'
            : firmNotices.slice(0, 60).map((n) => `<tr>
              <td class="strong">${fmtDateTime(n.created_at)}</td>
              <td>${n.kind === 'new_location'
                ? '<span class="badge grace"><span class="dot"></span>New location</span>'
                : '<span class="badge inforce"><span class="dot"></span>Export</span>'}
                <span class="muted"> ${esc(n.detail)}</span></td>
              <td>${esc(n.user_name || n.user_email)}</td>
              <td class="muted">${n.seen_at ? fmtDateTime(n.seen_at) : 'not yet'}</td>
            </tr>`).join('')}</tbody>
        </table></div>
        <div class="card-body" style="border-top:1px solid var(--grid);padding-top:12px">
          <span class="muted" style="font-size:12px">
            Exporting the book is an administrator's act: it is recorded with what it
            contained and every other administrator is told. Nobody below admin has the
            button, and the server refuses the request as well as hiding it.</span>
        </div>
      </div>` : ''}

      ${isAdmin ? `
      <div class="card">
        <div class="card-head"><h2>Users</h2><div class="spacer"></div>
          <button class="btn-sm primary" id="addUserBtn">Add user</button></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Investor / entities</th>
            <th>Status</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>${users.map((u) => `<tr class="${u.is_active ? '' : 'row-muted'}">
            <td class="strong">${esc(u.email)}</td><td>${esc(u.full_name)}</td>
            <td>${esc(u.role)}</td>
            <td class="secondary">${esc(u.investor_name || u.fund_codes || '')}${
              u.investor_names ? `<div class="muted" style="font-size:11.5px;margin-top:3px"
                >+ ${esc(u.investor_names)}</div>` : ''}</td>
            <td>${u.is_active
                  ? '<span class="badge inforce"><span class="dot"></span>Active</span>'
                  : '<span class="badge lapsed"><span class="dot"></span>Suspended</span>'}</td>
            <td class="muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString('en-US') : 'never'}</td>
            <td style="white-space:nowrap">
              <button class="btn-sm" data-edit-user="${u.id}">Edit</button>
              ${u.id === state.user.id ? '' : `
                <button class="btn-sm" data-toggle-user="${u.id}" data-active="${u.is_active}"
                  data-email="${esc(u.email)}">${u.is_active ? 'Suspend' : 'Reactivate'}</button>
                <button class="btn-sm btn-danger" data-del-user="${u.id}"
                  data-email="${esc(u.email)}">Delete</button>`}
            </td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="card-body" style="border-top:1px solid var(--grid);padding-top:12px">
          <span class="muted" style="font-size:12px">
            Suspending takes effect immediately — an open session is ended on the next click.
            Deleting removes the login but keeps everything they did in the audit trail below.</span>
        </div>
      </div>` : ''}
    </div>

    ${investorUser ? '' : `
    <div class="card">
      <div class="card-head"><h2>Owner entities</h2><div class="spacer"></div>
        ${canEdit ? '<button class="btn-sm primary" id="addEntityBtn">New entity</button>' : ''}</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Code</th><th>Full legal name</th><th>Carried interest</th>
          <th class="num">Policies</th>
          <th class="num">Lives</th><th class="num">Avg age</th>
          <th class="num">Death benefit</th><th class="num">Invested</th><th>Notes</th><th></th></tr></thead>
        <tbody>${funds.length === 0
          ? '<tr><td colspan="10"><div class="empty">No entities yet.</div></td></tr>'
          : funds.map((f) => `<tr>
              <td class="strong">${esc(f.code)}</td>
              <td>${esc(f.name && f.name !== f.code ? f.name : '')}</td>
              <td>${Number(f.carry_pct) > 0
                ? `${fmtPct(f.carry_pct)} of profit`
                : '<span class="muted">none — fee only</span>'}</td>
              <td class="num">${f.policy_count}</td>
              <td class="num">${f.lives_count || 0}</td>
              ${avgAgeCell(f)}
              <td class="num">${fmtExact(f.total_death_benefit)}</td>
              <td class="num">${fmtExact(f.total_invested)}</td>
              <td class="secondary">${esc(f.notes || '')}</td>
              <td>${canEdit ? `<button class="btn-sm" data-edit-entity="${f.id}">Edit</button>
                   <button class="btn-sm btn-danger" data-del-entity="${f.id}" data-code="${esc(f.code)}"
                     ${f.policy_count ? 'disabled title="Reassign its policies first"' : ''}>Delete</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`}

    ${isInvestorUser() ? documentsCard(docs, canPost) : ''}

    ${isAdmin ? `
    <div class="card">
      <div class="card-head"><h2>Activity log</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">most recent 300 events</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
        <tbody>${audit.length === 0 ? '<tr><td colspan="5"><div class="empty">No activity yet.</div></td></tr>'
          : audit.map((a) => `<tr>
            <td>${new Date(a.created_at).toLocaleString('en-US')}</td>
            <td>${esc(a.email || '—')}</td><td>${esc(a.action)}</td>
            <td>${esc(a.entity)}${a.entity_id ? ` #${a.entity_id}` : ''}</td>
            <td class="secondary">${esc(a.detail)}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}`;

  return {
    html,
    after: () => {
      wireDocumentsCard(docs, funds, investors);

      $('#forgetPlaces')?.addEventListener('click', async () => {
        if (!confirm('Clear every recorded sign-in place for your account? The next sign-in '
          + 'will be treated as your first and will not raise a notice.')) return;
        await api('/security/locations', { method: 'DELETE' });
        toast('Cleared');
        render();
      });

      $('#saveMailPrefs')?.addEventListener('click', async () => {
        const kinds = {};
        document.querySelectorAll('[data-mail]').forEach((box) => {
          if (!box.disabled) kinds[box.dataset.mail] = box.checked;
        });
        try {
          await api('/me/notifications', { method: 'PUT', body: { kinds } });
          $('#mailMsg').innerHTML = '<div class="ok-box">Saved.</div>';
        } catch (err) {
          $('#mailMsg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        }
      });
      $('#testMail')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const out = await api('/mail/test', { method: 'POST' });
          $('#mailMsg').innerHTML = `<div class="ok-box">Sent to ${esc(out.to)}${
            out.failed ? ' — but the provider refused it; see The post below.' : ''}</div>`;
        } catch (err) {
          $('#mailMsg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        }
        e.target.disabled = false;
      });

      $('#pwForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/auth/password', { method: 'POST', body: formValues(e.target) });
          $('#pwMsg').innerHTML = '<div class="ok-box">Password updated.</div>';
          e.target.reset();
        } catch (err) {
          $('#pwMsg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        }
      });
      $('#taxForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api('/me/tax-id', { method: 'PUT', body: formValues(e.target) });
          // Re-read rather than patch: the panel it becomes is a different one.
          state.user.investor.tax_id_last4 = r.tax_id_last4;
          toast('Tax number saved');
          render();
        } catch (err) {
          $('#taxMsg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        }
      });
      document.querySelectorAll('[data-edit-user]').forEach((b) =>
        b.addEventListener('click', () =>
          openUserDialog(users.find((u) => u.id === Number(b.dataset.editUser)), funds, render)));
      document.querySelectorAll('[data-toggle-user]').forEach((b) =>
        b.addEventListener('click', async () => {
          const wasActive = b.dataset.active === 'true';
          if (!confirm(`${wasActive ? 'Suspend' : 'Reactivate'} ${b.dataset.email}?`)) return;
          const u = users.find((x) => x.id === Number(b.dataset.toggleUser));
          try {
            await api(`/users/${u.id}`, { method: 'PUT', body: {
              full_name: u.full_name, role: u.role, is_active: !wasActive,
              investor_id: u.investor_id, fund_ids: u.fund_ids || [] } });
            toast(wasActive ? 'Account suspended' : 'Account reactivated');
            render();
          } catch (err) { alert(err.message); }
        }));
      document.querySelectorAll('[data-del-user]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm(`Permanently delete the login for ${b.dataset.email}?\n\nTheir activity log entries are kept.`)) return;
          try {
            await api(`/users/${b.dataset.delUser}`, { method: 'DELETE' });
            toast('Login deleted');
            render();
          } catch (err) { alert(err.message); }
        }));
      $('#addEntityBtn')?.addEventListener('click', () => openEntityDialog(null, render));
      document.querySelectorAll('[data-edit-entity]').forEach((b) =>
        b.addEventListener('click', () =>
          openEntityDialog(funds.find((f) => f.id === Number(b.dataset.editEntity)), render)));
      document.querySelectorAll('[data-del-entity]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm(`Delete the entity "${b.dataset.code}"?`)) return;
          try {
            await api(`/funds/${b.dataset.delEntity}`, { method: 'DELETE' });
            state.funds = await api('/funds');
            toast('Entity deleted');
            render();
          } catch (err) { alert(err.message); }
        }));

      $('#addUserBtn')?.addEventListener('click', async () => {
        if (!state.investors.length) {
          try { state.investors = await api('/investors'); } catch { /* viewer */ }
        }
        const dlg = openDialog('Add user', `
          ${inputField('Email *', 'email', '', 'email', 'required')}
          ${inputField('Full name', 'full_name')}
          ${inputField('Password (10+ characters) *', 'password', '', 'password', 'required minlength=10')}
          ${selectField('Role', 'role', 'editor', ['admin', 'editor', 'viewer', 'manager', 'investor'])}
          <div class="field" id="fundPick" style="display:none">
            <label>Owner entities *</label>
            <select name="fund_ids" multiple size="${Math.min(5, Math.max(2, funds.length))}">
              ${funds.map((f) => `<option value="${f.id}">${esc(f.code)}${f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
            </select>
            <span class="muted" style="font-size:12px">
              Hold ⌘ or Ctrl to pick several. This manager gets full access to the policies
              in these entities, and no access to Settings.</span>
          </div>
          <div class="field" id="grantPick" style="display:none">
            <label>Investors they may work with</label>
            <select name="investor_ids" multiple size="${Math.min(8, Math.max(3, state.investors.length))}">
              ${state.investors.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}
            </select>
            <span class="muted" style="font-size:12px">
              Investors they can take an opportunity to, or allocate a policy to, before there
              is any holding to go on. Anyone already holding inside their entities is
              reachable without this. Can be changed later.</span>
          </div>
          <div class="field" id="investorPick" style="display:none">
            <label>Investor *</label>
            <select name="investor_id">
              <option value="">Choose an investor…</option>
              ${state.investors.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}
            </select>
            <span class="muted" style="font-size:12px">
              This login will see only the policies this investor holds a share of.</span>
          </div>
        `, async (v) => {
          await api('/users', { method: 'POST', body: v });
          toast('User created');
        }, 'Create user');

        const roleSel = $('select[name=role]', dlg);
        const sync = () => {
          $('#investorPick', dlg).style.display = roleSel.value === 'investor' ? '' : 'none';
          $('#fundPick', dlg).style.display = roleSel.value === 'manager' ? '' : 'none';
          $('#grantPick', dlg).style.display = roleSel.value === 'manager' ? '' : 'none';
        };
        roleSel.addEventListener('change', sync);
        sync();
      });
    },
  };
}

/* --------------------------- user editing ---------------------------- */

/**
 * Edit an existing login: name, role, status, and — for a manager — exactly
 * which owner entities they may work inside. Entity access is replaced with
 * whatever is selected here, so removing one is simply deselecting it.
 * The password field is optional and goes to a separate endpoint, since a
 * reset is a different act from an account change and is audited as such.
 */
async function openUserDialog(u, funds, onSaved) {
  if (!u) return;
  if (!state.investors.length) {
    try { state.investors = await api('/investors'); } catch { /* not fatal */ }
  }
  const self = u.id === state.user.id;
  const held = (u.fund_ids || []).map(Number);
  const granted = (u.granted_investor_ids || []).map(Number);

  const dlg = openDialog(`Edit ${u.email}`, `
    ${inputField('Full name', 'full_name', u.full_name)}
    <div class="field-row">
      <div class="field"><label>Role</label>
        <select name="role" ${self ? 'disabled' : ''}>
          ${['admin', 'editor', 'viewer', 'manager', 'investor'].map((r) =>
            `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Status</label>
        <select name="is_active" ${self ? 'disabled' : ''}>
          <option value="true" ${u.is_active ? 'selected' : ''}>Active</option>
          <option value="false" ${u.is_active ? '' : 'selected'}>Suspended</option>
        </select>
      </div>
    </div>
    ${self ? `<div class="field" style="margin-top:-4px">
      <span class="muted" style="font-size:12px">
        You cannot change your own role or suspend yourself. Ask another administrator.</span>
    </div>` : ''}

    ${''/* Policy Valuation is a different application, handed to people by
           name. Not offered for an administrator, who has it anyway, nor
           for an investor, who may never have it.

           High in the dialog on purpose: it is one line, and it used to sit
           under two full-height multi-selects where it was below the fold
           and nobody could find it. */}
    <div class="field" id="valuePick" style="display:none">
      <label>Tools</label>
      <label class="dlg-check" style="margin:0">
        <input type="checkbox" name="can_value" ${u.can_value ? 'checked' : ''}>
        <span>May use <strong>Policy Valuation</strong> — the pricing model, which
          says what the firm would pay for a policy. It is a separate application
          reached from the menu; nothing in this portfolio changes when somebody
          runs one. Every run is recorded against their name.</span>
      </label>
    </div>

    <div class="field" id="fundPick" style="display:none">
      <label>Owner entities *</label>
      <select name="fund_ids" multiple size="${Math.min(5, Math.max(2, funds.length))}">
        ${funds.map((f) => `<option value="${f.id}" ${held.includes(Number(f.id)) ? 'selected' : ''}
          >${esc(f.code)}${f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
      </select>
      <span class="muted" style="font-size:12px">
        Hold ⌘ or Ctrl to pick several. Whatever is highlighted when you save becomes their
        complete access — deselect an entity to take it away. Changes apply immediately,
        including to a session they already have open.</span>
    </div>

    <div class="field" id="grantPick" style="display:none">
      <label>Investors they may work with</label>
      <select name="granted_investor_ids" multiple size="${Math.min(8, Math.max(3, state.investors.length))}">
        ${state.investors.map((i) => `<option value="${i.id}" ${
          granted.includes(Number(i.id)) ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
      </select>
      <span class="muted" style="font-size:12px">
        Anyone already holding a position in their entities is reachable anyway — this is for
        investors they should be able to take a new opportunity to, or allocate a policy to,
        before there is any holding to go on. Without it they would have to key in a second
        copy of a client the firm already has. It only lets them <em>name</em> the investor;
        it does not open up holdings outside their entities.</span>
    </div>

    <div class="field" id="investorPick" style="display:none">
      <label>Investor *</label>
      <select name="investor_id">
        <option value="">Choose an investor…</option>
        ${state.investors.map((i) =>
          `<option value="${i.id}" ${Number(i.id) === Number(u.investor_id) ? 'selected' : ''}
            >${esc(i.name)}</option>`).join('')}
      </select>
      <span class="muted" style="font-size:12px">
        This login sees only the policies this investor holds a share of.</span>
    </div>

    ${inputField('Set a new password (optional, 10+ characters)', 'password', '', 'password',
      'minlength=10 autocomplete=new-password')}
  `, async (v) => {
    // A disabled select submits nothing, so fall back to the record's own values.
    await api(`/users/${u.id}`, { method: 'PUT', body: {
      full_name: v.full_name,
      role: self ? u.role : v.role,
      is_active: self ? u.is_active : v.is_active === 'true',
      investor_id: v.investor_id || null,
      fund_ids: v.fund_ids || [],
      investor_ids: v.granted_investor_ids || [],
      can_value: !!v.can_value,
    } });
    if (v.password) await api(`/users/${u.id}/password`, { method: 'POST', body: { password: v.password } });
    toast(v.password ? 'Account updated and password reset' : 'Account updated');
    onSaved?.();
  }, 'Save changes');

  const roleSel = $('select[name=role]', dlg);
  const sync = () => {
    $('#investorPick', dlg).style.display = roleSel.value === 'investor' ? '' : 'none';
    $('#fundPick', dlg).style.display = roleSel.value === 'manager' ? '' : 'none';
    $('#grantPick', dlg).style.display = roleSel.value === 'manager' ? '' : 'none';
    /* An administrator has it inherently and an investor may never have
       it, so the choice is only meaningful for the roles in between. */
    $('#valuePick', dlg).style.display =
      ['manager', 'editor', 'viewer'].includes(roleSel.value) ? '' : 'none';
  };
  roleSel.addEventListener('change', sync);
  sync();
}

/* ------------------------- the document cabinet ----------------------
 * One card, rendered in two places: on the Documents tab for staff, and
 * on an investor's Account page, which is the only screen they have for
 * it. Shared as a function rather than copied, so what an investor sees
 * cannot drift from what was filed.
 * ------------------------------------------------------------------- */

function documentsCard(docs, canPost) {
  return `
<div class="card">
  <div class="card-head"><h2>Documents</h2><div class="spacer"></div>
    ${docs.length ? `<span class="muted" style="font-size:12px">${docs.length} on file</span>` : ''}
    ${canPost ? '<button class="btn-sm primary" id="addDocBtn" style="margin-left:12px">Upload document</button>' : ''}</div>

  ${docs.length > 6 ? `<div class="card-body" style="border-bottom:1px solid var(--grid)">
    <div class="toolbar" style="margin:0">
      <input class="grow" id="docSearch" placeholder="Search title, file name, investor…"
             value="${esc(state.docFilter?.search || '')}">
      <select id="docCategory">
        <option value="">All categories</option>
        ${DOC_CATEGORIES.map((c) => `<option ${state.docFilter?.category === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
    </div>
  </div>` : ''}

  <div class="table-wrap"><table class="data">
    <thead><tr><th>Document</th><th>Category</th><th class="num">Year</th>
      ${isInvestorUser() ? '' : '<th>Who it is for</th>'}
      <th class="num">Size</th><th>Added</th><th></th></tr></thead>
    <tbody>${docFiltered(docs).length === 0
      ? `<tr><td colspan="7"><div class="empty">${isInvestorUser()
          ? 'Nothing has been shared with you yet. Statements, K-1s and agreements will appear here.'
          : canPost
            ? 'No documents yet. Post the LLC agreement, subscription documents, K-1s — anything the fund runs on.'
            : 'No documents yet.'}</div></td></tr>`
      : docFiltered(docs).map((d) => `<tr>
          <td class="strong"><a href="#" data-doc-get="${d.id}">${esc(d.title)}</a>
            <div class="muted" style="font-size:11.5px">${esc(d.file_name)}${
              d.notes ? ` · ${esc(d.notes)}` : ''}</div></td>
          <td>${esc(d.category)}</td>
          <td class="num">${d.doc_year || '—'}</td>
          ${isInvestorUser() ? '' : `<td class="secondary">${
            d.investor_name
              ? `${esc(d.investor_name)} ${d.shared
                  ? '<span class="badge inforce"><span class="dot"></span>shared</span>'
                  : '<span class="badge">staff only</span>'}`
              : d.fund_code ? esc(d.fund_code) : '<span class="muted">whole firm</span>'}</td>`}
          <td class="num muted">${fmtBytes(d.byte_size)}</td>
          <td class="muted">${new Date(d.created_at).toLocaleDateString('en-US')}${
            d.uploaded_by_name ? `<div style="font-size:11.5px">${esc(d.uploaded_by_name)}</div>` : ''}</td>
          <td style="white-space:nowrap">
            <button class="btn-sm" data-doc-get="${d.id}">Download</button>
            ${canPost ? `<button class="btn-sm" data-doc-edit="${d.id}">Edit</button>` : ''}
            ${['admin', 'manager'].includes(state.user.role)
              ? `<button class="btn-sm btn-danger" data-doc-del="${d.id}">Delete</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
  </table></div>

  ${isInvestorUser() ? '' : `<div class="card-body" style="border-top:1px solid var(--grid)">
    <span class="muted" style="font-size:12px">
      A document with nobody named against it is visible to every member of staff. Name an
      owner entity and it follows that entity; name an investor and it is theirs —
      but only once <strong>shared</strong> is ticked, so a draft K-1 can sit here safely
      until it is ready to go out. Files are held in the database and travel with your
      backups. Up to 15 MB each.</span>
  </div>`}
</div>`;
}

/** The handlers for that card. Call from a view's `after`. */
function wireDocumentsCard(docs, funds, investors) {
  $('#addDocBtn')?.addEventListener('click', () =>
    openDocumentDialog(null, funds, investors, render));

  document.querySelectorAll('[data-doc-get]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      const d = docs.find((x) => x.id === Number(b.dataset.docGet));
      try { await downloadDocument(b.dataset.docGet, d?.file_name); }
      catch (err) { alert(err.message); }
    }));

  document.querySelectorAll('[data-doc-edit]').forEach((b) =>
    b.addEventListener('click', () =>
      openDocumentDialog(docs.find((x) => x.id === Number(b.dataset.docEdit)),
        funds, investors, render)));

  document.querySelectorAll('[data-doc-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const d = docs.find((x) => x.id === Number(b.dataset.docDel));
      if (!confirm(`Delete "${d?.title}"?\n\nThe file is removed for good.`)) return;
      try {
        await api(`/documents/${b.dataset.docDel}`, { method: 'DELETE' });
        toast('Document deleted');
        render();
      } catch (err) { alert(err.message); }
    }));

  let docTimer;
  $('#docSearch')?.addEventListener('input', (e) => {
    clearTimeout(docTimer);
    docTimer = setTimeout(() => {
      state.docFilter = { ...(state.docFilter || {}), search: e.target.value };
      render();
    }, 250);
  });
  $('#docCategory')?.addEventListener('change', (e) => {
    state.docFilter = { ...(state.docFilter || {}), category: e.target.value };
    render();
  });
}

/* --------------------------- agreements ---------------------------- */

/* The operating agreement, on screen.
 *
 * The document is rendered from the same template the server renders to
 * PDF, so what a member reads here is what they sign and what they get
 * back afterwards — down to the words. Nothing is summarised for them. */

const AGREEMENT_BADGES = {
  Draft: 'badge',
  'Out for signature': 'badge grace',
  Executed: 'badge inforce',
  Void: 'badge lapsed',
};
const agreementBadge = (s) =>
  `<span class="${AGREEMENT_BADGES[s] || 'badge'}"><span class="dot"></span>${esc(s)}</span>`;

/** The blocks, as a page you can read. */
function agreementSheet(blocks) {
  return `<div class="doc-sheet">${blocks.map((b) => {
    switch (b.type) {
      case 'title': return `<h1 class="doc-title">${esc(b.text)}</h1>`;
      case 'subtitle': return `<div class="doc-subtitle${
        b.align === 'left' ? ' left' : ''}">${esc(b.text)}</div>`;
      case 'heading': return `<h2 class="doc-h">${esc(b.text)}</h2>`;
      case 'subhead': return `<h3 class="doc-sub">${esc(b.text)}</h3>`;
      case 'para': return `<p class="doc-p">${esc(b.text)}</p>`;
      case 'bullet': return `<p class="doc-bullet">${esc(b.text)}</p>`;
      case 'numbered': return `<p class="doc-num"><span>${b.n}.</span>${esc(b.text)}</p>`;
      case 'table': return `<table class="doc-table">
        ${(b.columns || []).some(Boolean)
          ? `<thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : ''}
        <tbody>${(b.rows || []).map((r, i) => `<tr class="${
          b.footerRow && i === b.rows.length - 1 ? 'doc-total' : ''}">${
          r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      case 'signature': return `<div class="doc-sig">
        <div class="doc-sig-mark">${b.signed
          ? esc(b.signed.signed_name || b.caption) : ''}</div>
        <div class="doc-sig-rule"></div>
        <div class="doc-sig-name">${esc(b.caption)}</div>
        ${/* An entity is bound by the person who signed for it, so the block
              says both. Unsigned, these are the lines somebody would fill in
              with a pen; signed, they are who did. */''}
        ${b.entity ? `<div class="doc-sig-by">${b.signed
          ? `By: ${esc(b.signed.signed_by_name || '—')}${b.signed.signed_by_title
              ? ` · ${esc(b.signed.signed_by_title)}` : ''}`
          : 'By: ____________________&nbsp;&nbsp;Title: ____________________'}</div>` : ''}
        <div class="doc-sig-note">${b.signed
          ? `Signed electronically ${fmtDateTime(b.signed.signed_at)} · IP ${
              esc(b.signed.signed_ip || 'not recorded')}`
          : 'Date: ____________________'}</div></div>`;
      case 'pagebreak': return '<div class="doc-break"></div>';
      case 'spacer': return `<div style="height:${Number(b.size) || 8}px"></div>`;
      default: return '';
    }
  }).join('')}</div>`;
}

/* ---------------------------- documents ------------------------------
 * The paperwork side of the firm, on one tab: the operating agreements
 * being drafted and signed, and the cabinet everything is filed in.
 * They were under Settings, which is the wrong place for work somebody
 * does weekly — Settings is for things you change once.
 *
 * Investors keep their own copies on their Account page and their own
 * Agreements tab; this is the staff view of both.
 * ------------------------------------------------------------------- */

async function documentsView() {
  const canPost = ['admin', 'editor', 'manager'].includes(state.user.role);
  const [docs, agreements, funds, investors] = await Promise.all([
    api('/documents').catch(() => []),
    api('/agreements').catch(() => []),
    loadFunds(),
    api('/investors').catch(() => []),
  ]);
  const live = agreements.filter((a) => a.status === 'Out for signature');

  const html = `
    <div class="page-head">
      <div><h1>Documents</h1>
        <div class="sub">${agreements.length} operating agreement${
          agreements.length === 1 ? '' : 's'}${live.length
          ? ` · ${live.length} out for signature` : ''} · ${docs.length} file${
          docs.length === 1 ? '' : 's'} on record</div></div>
      <div class="spacer"></div>
      ${canEditData() ? '<button class="primary" id="newAgreementBtn">New agreement</button>' : ''}
    </div>

    <div class="card">
      <div class="card-head"><h2>Operating agreements</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">${live.length
          ? `${live.length} waiting on signatures` : 'nothing out for signature'}</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Agreement</th><th>Effective</th><th>Entity</th>
          <th class="num">Members</th><th class="num">Signed</th><th>Status</th><th></th></tr></thead>
        <tbody>${agreements.length === 0
          ? `<tr><td colspan="7"><div class="empty">No agreements yet.${canEditData()
              ? ' Draft one from the standard form — the clauses are fixed, you fill in the blanks.'
              : ''}</div></td></tr>`
          : agreements.map((a) => `<tr class="clickable" data-agreement="${a.id}">
              <td class="strong">${esc(a.llc_name || a.title || '—')}</td>
              <td>${fmtDate(a.effective_date)}</td>
              <td>${esc(a.fund_code || '—')}</td>
              <td class="num">${a.member_count}</td>
              <td class="num">${a.signed_count}<span class="muted"> of ${
                a.party_count ?? a.member_count}</span></td>
              <td>${agreementBadge(a.status)}</td>
              <td class="muted">${a.executed_at ? `executed ${fmtDate(a.executed_at)}`
                : a.issued_at ? `sent ${fmtDate(a.issued_at)}` : `drafted ${fmtDate(a.created_at)}`}</td>
            </tr>`).join('')}</tbody>
      </table></div>
      <div class="card-body" style="border-top:1px solid var(--grid)">
        <span class="muted" style="font-size:12.5px">Draft from the standard form, send it to the
        members, and collect signatures in their own portals. An executed agreement is filed
        below automatically, one private copy per member.</span>
      </div>
    </div>

    ${documentsCard(docs, canPost)}`;

  return {
    html,
    after: () => {
      wireDocumentsCard(docs, funds, investors);
      $('#newAgreementBtn')?.addEventListener('click', () => openAgreementDialog(null));
      document.querySelectorAll('[data-agreement]').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/agreement/${tr.dataset.agreement}`)));
    },
  };
}

async function agreementsView() {
  const investor = isInvestorUser();
  const list = await api('/agreements');
  const waiting = list.filter((a) => a.status === 'Out for signature' && !a.my_signed_at);

  const row = (a) => `<tr class="clickable" data-id="${a.id}">
    <td class="strong">${esc(a.llc_name || a.title || '—')}</td>
    <td>${fmtDate(a.effective_date)}</td>
    ${investor ? '' : `<td>${esc(a.fund_code || '—')}</td>`}
    <td class="num">${a.member_count}</td>
    <td class="num">${a.signed_count}</td>
    <td>${agreementBadge(a.status)}</td>
    <td class="muted">${a.executed_at ? `executed ${fmtDate(a.executed_at)}`
      : a.issued_at ? `sent ${fmtDate(a.issued_at)}` : `drafted ${fmtDate(a.created_at)}`}</td>
  </tr>`;

  const html = `
    <div class="page-head">
      <div><h1>${investor ? 'Agreements' : 'Operating agreements'}</h1>
        <div class="sub">${investor
          ? 'The LLC agreements you are a party to. Read one in full before you sign it.'
          : 'Draft from the standard form, send it to the members, and collect signatures here.'}</div></div>
      <div class="spacer"></div>
      ${!investor && canEditData()
        ? '<button class="btn-primary" id="newAgreementBtn">New agreement</button>' : ''}
    </div>

    ${waiting.length && investor ? `<div class="alert-row severity-warning" style="margin-bottom:18px">
      <div><div class="title">${waiting.length} agreement${waiting.length === 1 ? '' : 's'
        } waiting for your signature</div>
        <div class="meta">Open one to read it and sign.</div></div></div>` : ''}

    <div class="card">
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Agreement</th><th>Effective</th>${investor ? '' : '<th>Entity</th>'}
          <th class="num">Members</th><th class="num">Signed</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.length === 0
          ? `<tr><td colspan="7"><div class="empty">${investor
              ? 'Nothing here yet. An agreement appears once it is sent to you.'
              : 'No agreements yet. Start one from the standard form.'}</div></td></tr>`
          : list.map(row).join('')}</tbody>
      </table></div>
    </div>`;

  return {
    html,
    after: () => {
      $('#newAgreementBtn')?.addEventListener('click', () => openAgreementDialog(null));
      document.querySelectorAll('tr[data-id]').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/agreement/${tr.dataset.id}`)));
    },
  };
}

async function agreementView() {
  const a = await api(`/agreements/${state.params.id}`);
  const investor = isInvestorUser();
  const staff = !investor;
  const me = a.me || null;
  const canSign = a.status === 'Out for signature'
    && (investor ? me && !me.signed_at
      : canEditData() && a.signers.some((s) => s.role === 'Manager' && !s.signed_at));
  const outstanding = a.signers.filter((s) => !s.signed_at);

  const partyRow = (s) => `<tr class="${s.signed_at ? '' : 'row-muted'}">
    <td class="strong">${esc(s.name || '—')}${s.is_me ? ' <span class="muted">· you</span>' : ''}${
      /* An entity is bound by whoever signed for it, so the register of
         parties says who that was — or, before signing, that one is needed. */
      s.party_type && s.party_type !== 'Individual' ? `<div class="muted" style="font-size:11.5px">${
        s.signed_at
          ? `by ${esc(s.signed_by_name || '—')}${s.signed_by_title ? `, ${esc(s.signed_by_title)}` : ''}`
          : `${esc(s.party_type.toLowerCase())} · signs through a person`}</div>` : ''}</td>
    <td>${s.role === 'Manager' ? '<span class="badge">Manager</span>' : 'Member'}</td>
    <td class="num">${s.contribution == null ? dash : fmtExact(s.contribution)}</td>
    <td class="num">${s.pct == null ? dash : fmtPct(s.pct)}</td>
    <td>${s.signed_at
      ? `<span class="badge inforce"><span class="dot"></span>Signed</span>`
      : s.declined_at ? '<span class="badge lapsed"><span class="dot"></span>Declined</span>'
        : '<span class="badge grace"><span class="dot"></span>Waiting</span>'}</td>
    <td class="muted">${s.signed_at ? fmtDateTime(s.signed_at)
      : s.declined_at ? `${fmtDateTime(s.declined_at)}${
          s.decline_note ? ` · ${esc(s.decline_note)}` : ''}` : ''}</td>
    ${staff ? `<td class="muted" style="font-size:12px">${s.signed_ip ? esc(s.signed_ip) : ''}</td>` : ''}
  </tr>`;

  const html = `
    <div class="page-head">
      <div><a class="back" href="#/agreements">← All agreements</a>
        <h1>${esc(a.terms?.llc_name || a.title || 'Operating agreement')}</h1>
        <div class="sub">${agreementBadge(a.status)}
          ${a.fund_code ? ` · ${esc(a.fund_code)}` : ''}
          ${a.terms?.effective_date ? ` · effective ${fmtDate(a.terms.effective_date)}` : ''}
          · ${a.signed_count} of ${a.signers.length} signed</div></div>
      <div class="spacer"></div>
      <a class="btn" href="/api/agreements/${a.id}/pdf" target="_blank" rel="noopener">Download PDF</a>
      ${staff && canEditData() ? `
        ${a.status === 'Draft' ? `
          <button id="editAgreementBtn">Edit details</button>
          <button id="partiesBtn">Members</button>
          <button class="primary" id="issueBtn">Send for signature</button>` : ''}
        ${a.status === 'Out for signature' ? '<button id="recallBtn">Recall to draft</button>' : ''}
        ${a.status !== 'Void' && a.status !== 'Draft' ? '<button class="btn-danger" id="voidBtn">Void</button>' : ''}
        ${a.status === 'Draft' && state.user.role === 'admin'
          ? '<button class="btn-danger" id="deleteAgreementBtn">Delete draft</button>' : ''}` : ''}
    </div>

    ${a.status === 'Void' ? `<div class="error-box" style="margin-bottom:18px">
      This agreement was voided. ${esc(a.void_reason)}</div>` : ''}

    ${canSign ? `
    <div class="card" style="margin-bottom:18px;border-color:var(--warning)">
      <div class="card-head"><h2>Sign this agreement</h2></div>
      <div class="card-body">
        <p class="secondary" style="margin-top:0">
          Read the whole document below first. Typing your name and pressing the button is your
          signature: it has the same effect as signing on paper, and the portal records the time,
          your address and a fingerprint of the exact text you are signing.</p>
        <div id="signMsg"></div>
        <button class="primary" id="signBtn">Read and sign</button>
        ${investor ? '<button id="declineBtn" style="margin-left:8px">I am not signing</button>' : ''}
      </div>
    </div>` : ''}

    ${a.status === 'Out for signature' && outstanding.length && !canSign ? `
    <div class="card" style="margin-bottom:18px">
      <div class="card-body"><span class="muted">Waiting on ${
        outstanding.map((s) => esc(s.name)).join(', ')}.</span></div>
    </div>` : ''}

    <div class="card" style="margin-bottom:18px">
      <div class="card-head"><h2>Parties</h2><div class="spacer"></div>
        ${a.body_hash ? `<span class="muted" style="font-size:12px">document ${
          esc(a.body_hash.slice(0, 16))}</span>` : ''}</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Party</th><th>Role</th><th class="num">Contribution</th>
          <th class="num">Interest</th><th>Signature</th><th>When</th>
          ${staff ? '<th>From</th>' : ''}</tr></thead>
        <tbody>${a.signers.length === 0
          ? '<tr><td colspan="7"><div class="empty">Nobody has been added yet.</div></td></tr>'
          : a.signers.map(partyRow).join('')}</tbody>
      </table></div>
      ${staff && a.status === 'Draft' ? `<div class="card-body" style="border-top:1px solid var(--grid)">
        <span class="muted" style="font-size:12.5px">The Manager is taken from the details;
        members are added under <strong>Members</strong>. Once this goes out for signature the
        text is frozen and neither can change without recalling it.</span></div>` : ''}
    </div>

    <div class="card">
      <div class="card-head"><h2>The agreement</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">as it will be executed</span></div>
      <div class="card-body">${agreementSheet(a.blocks)}</div>
    </div>`;

  return {
    html,
    after: () => {
      $('#editAgreementBtn')?.addEventListener('click', () => openAgreementDialog(a));
      $('#partiesBtn')?.addEventListener('click', () => openPartiesDialog(a));
      $('#issueBtn')?.addEventListener('click', () => openIssueDialog(a));
      $('#signBtn')?.addEventListener('click', () => openSignDialog(a));
      $('#declineBtn')?.addEventListener('click', () => openDeclineDialog(a));
      $('#recallBtn')?.addEventListener('click', () => openRecallDialog(a));
      $('#voidBtn')?.addEventListener('click', () => openVoidDialog(a));
      $('#deleteAgreementBtn')?.addEventListener('click', async () => {
        if (!confirm('Delete this draft? Nothing has been sent, so nothing is lost but the typing.'))
          return;
        await api(`/agreements/${a.id}`, { method: 'DELETE' });
        toast('Draft deleted');
        go('#/agreements');
      });
    },
  };
}

/** The blanks. Grouped the way the document reads rather than alphabetically. */
async function openAgreementDialog(a) {
  const isNew = !a?.id;
  if (!state.funds.length) state.funds = await api('/funds').catch(() => []);
  const policies = await api('/policies').catch(() => []);
  const terms = a?.terms || {};

  const field = (f) => {
    const value = terms[f.key] ?? (isNew ? f.default ?? '' : '');
    const label = `${f.label}${f.required ? ' *' : ''}`;
    if (f.type === 'state') return stateField(label, `t_${f.key}`, value);
    if (f.type === 'date') return inputField(label, `t_${f.key}`, dateInput(value), 'date',
      f.required ? 'required' : '');
    if (f.type === 'pct' || f.type === 'int')
      return inputField(label, `t_${f.key}`, value, 'number', 'step=0.01');
    return inputField(label, `t_${f.key}`, value, 'text',
      f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '');
  };

  const body = `
    <div class="field-row">
      <div class="field"><label>Owner entity</label>
        <select name="fund_id">
          <option value="">— None —</option>
          ${state.funds.map((f) => `<option value="${f.id}" ${
            Number(a?.fund_id) === Number(f.id) ? 'selected' : ''}>${esc(f.code)}${
            f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
        </select></div>
      <div class="field"><label>Policy it holds</label>
        <select name="policy_id" id="agrPolicy">
          <option value="">— Not in the portfolio yet —</option>
          ${policies.map((p) => `<option value="${p.id}" ${
            Number(a?.policy_id) === Number(p.id) ? 'selected' : ''}
            data-insured="${esc(`${p.insured_first || ''} ${p.insured_last || ''}`.trim())}"
            data-product="${esc(PRODUCT_LABELS[p.product_type] || p.product_type || '')}"
            data-number="${esc(p.policy_number || '')}"
            >${esc(p.policy_number)} — ${esc(p.carrier_name || '')}</option>`).join('')}
        </select></div>
    </div>
    ${FIELD_SECTIONS.map(([key, heading]) => `
      <div class="dlg-section">${heading}</div>
      <div class="field-row" style="flex-wrap:wrap">
        ${AGREEMENT_FIELDS.filter((f) => (f.section || '') === key).map(field).join('')}
      </div>`).join('')}
    <div class="field" style="margin-top:-4px"><span class="muted" style="font-size:12px">
      The clauses themselves are fixed — these are the only things that change between one
      agreement and the next. Naming the insured is optional: leave it blank and the purpose
      clause identifies the policy by number alone.</span></div>`;

  const dlg = openDialog(isNew ? 'New operating agreement' : 'Agreement details', body, async (v) => {
    const out = {};
    for (const f of AGREEMENT_FIELDS) out[f.key] = v[`t_${f.key}`] ?? '';
    const payload = {
      title: out.llc_name || 'Operating agreement',
      fund_id: v.fund_id || null, policy_id: v.policy_id || null, terms: out,
    };
    if (!String(out.llc_name || '').trim()) throw new Error('Give the LLC its full name');
    if (isNew) {
      const made = await api('/agreements', { method: 'POST', body: payload });
      toast('Draft created');
      go(`#/agreement/${made.id}`);
    } else {
      await api(`/agreements/${a.id}`, { method: 'PUT', body: payload });
      toast('Agreement updated');
    }
  }, isNew ? 'Create draft' : 'Save');

  dlg.classList.add('wide');
  // Picking a policy fills in what the purpose clause needs, once.
  $('#agrPolicy', dlg).addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt || !opt.value) return;
    const set = (name, value) => {
      const el = $(`input[name="${name}"]`, dlg);
      if (el && !el.value) el.value = value;
    };
    set('t_insured_name', opt.dataset.insured || '');
    set('t_policy_product', opt.dataset.product || '');
    set('t_policy_number', opt.dataset.number || '');
  });
  return dlg;
}

/** Who is on it, what they are putting in, and what they get. */
async function openPartiesDialog(a) {
  const investors = await api('/investors');
  const members = (a.signers || []).filter((s) => s.role !== 'Manager');
  const seed = members.length ? members : [{}];

  const rowHtml = (m = {}) => `
    <tr class="party-row">
      <td><select class="party-investor">
        <option value="">— Not an investor on file —</option>
        ${investors.map((i) => `<option value="${i.id}" ${
          Number(m.investor_id) === Number(i.id) ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
      </select></td>
      <td><input type="text" class="party-name" value="${esc(m.name || '')}"
                 placeholder="As it should appear"></td>
      ${/* A company, trust or IRA signs through a person, and the signature
            line has to ask for one. Taken from the investor record, shown here
            so it can be corrected — a legal name is not always recognisable as
            one, and a signature that binds the wrong party is invisible until
            somebody tries to enforce it. */''}
      <td><select class="party-type">
        ${['Individual', 'Entity', 'Trust', 'IRA', 'Other'].map((t) => `<option value="${t}" ${
          (m.party_type || 'Individual') === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select></td>
      <td><input type="text" class="party-email" value="${esc(m.email || '')}" placeholder="email"></td>
      <td><input type="text" class="party-address" value="${esc(m.address || '')}"
                 placeholder="Notice address"></td>
      <td><input type="text" inputmode="decimal" data-money class="party-contribution num"
                 value="${esc(groupDigits(String(m.contribution ?? '')))}" placeholder="0.00"></td>
      <td><input type="number" step="0.0001" class="party-pct num"
                 value="${m.pct ?? ''}" placeholder="%"></td>
      <td><button type="button" class="btn-sm btn-danger party-del" title="Remove">✕</button></td>
    </tr>`;

  const dlg = openDialog('Members of the LLC', `
    <div class="prem-grid">
      <table class="data">
        <thead><tr><th style="width:180px">Investor</th><th>Name on the agreement</th>
          <th style="width:110px">Signs as</th>
          <th style="width:150px">Email</th><th>Notice address</th>
          <th class="num" style="width:120px">Contribution</th>
          <th class="num" style="width:90px">Interest %</th><th style="width:44px"></th></tr></thead>
        <tbody id="partyRows">${seed.map(rowHtml).join('')}</tbody>
        <tfoot><tr><td colspan="5" class="strong">Total</td>
          <td class="num strong" id="partyCapital">—</td>
          <td class="num strong" id="partyPct">—</td><td></td></tr></tfoot>
      </table>
    </div>
    <div class="prem-tools">
      <button type="button" class="btn-sm" id="partyAdd">Add a member</button>
      <div class="spacer"></div>
      <span class="muted" style="font-size:12px" id="partyWarn"></span>
    </div>
    <span class="muted" style="font-size:12px">
      Membership interests should total 100%. Nothing here is enforced against the portfolio —
      the agreement is the agreement, and the cap table on the policy is set separately.
      <strong>Signs as</strong> decides what the signature line asks for: anything other than
      an individual has to be signed by a named person, in the capacity that gives them the
      authority to bind it.
    </span>
  `, async () => {
    const rows = [...dlg.querySelectorAll('.party-row')].map((tr) => ({
      investor_id: tr.querySelector('.party-investor').value || null,
      role: 'Member',
      name: tr.querySelector('.party-name').value.trim()
        || tr.querySelector('.party-investor').selectedOptions[0]?.textContent.trim() || '',
      email: tr.querySelector('.party-email').value.trim(),
      address: tr.querySelector('.party-address').value.trim(),
      contribution: tr.querySelector('.party-contribution').value.replace(/,/g, ''),
      pct: tr.querySelector('.party-pct').value,
      party_type: tr.querySelector('.party-type').value,
    })).filter((r) => r.name || r.investor_id);
    if (!rows.length) throw new Error('Add at least one member');

    // The Manager signs too, and their name comes from the agreement itself.
    const manager = String(a.terms?.manager_name || '').trim();
    /* The manager's kind is left to the server to work out from the name —
       "Poel Capital LLC" signs through a person, "Alan Spiegel" is one. */
    const signers = manager ? [{ role: 'Manager', name: manager }, ...rows] : rows;
    await api(`/agreements/${a.id}/signers`, { method: 'PUT', body: { signers } });
    toast(`${rows.length} member${rows.length === 1 ? '' : 's'} saved`);
  }, 'Save members');

  dlg.classList.add('wide');
  const body = $('#partyRows', dlg);
  const recalc = () => {
    const rows = [...body.querySelectorAll('.party-row')];
    const capital = rows.reduce((s, tr) =>
      s + (Number(tr.querySelector('.party-contribution').value.replace(/,/g, '')) || 0), 0);
    const pct = rows.reduce((s, tr) => s + (Number(tr.querySelector('.party-pct').value) || 0), 0);
    $('#partyCapital', dlg).textContent = capital ? fmtExact(capital) : '—';
    $('#partyPct', dlg).textContent = pct ? `${Number(pct.toFixed(4))}%` : '—';
    $('#partyWarn', dlg).textContent = pct && Math.abs(pct - 100) > 0.0001
      ? `Interests total ${Number(pct.toFixed(4))}%, not 100%.` : '';
  };
  const wire = (tr) => {
    tr.querySelector('.party-del').addEventListener('click', () => { tr.remove(); recalc(); });
    tr.querySelector('.party-contribution').addEventListener('input', recalc);
    tr.querySelector('.party-pct').addEventListener('input', recalc);
    tr.querySelector('.party-investor').addEventListener('change', (e) => {
      const nameEl = tr.querySelector('.party-name');
      if (!nameEl.value) nameEl.value = e.target.selectedOptions[0]?.value
        ? e.target.selectedOptions[0].textContent.trim() : '';
      recalc();
    });
  };
  [...body.querySelectorAll('.party-row')].forEach(wire);
  $('#partyAdd', dlg).addEventListener('click', () => {
    body.insertAdjacentHTML('beforeend', rowHtml());
    wire(body.lastElementChild);
    recalc();
  });
  recalc();
  return dlg;
}

function openIssueDialog(a) {
  const members = a.signers.filter((s) => s.role !== 'Manager');
  openDialog('Send for signature', `
    <p style="margin-top:0">This freezes the text. ${members.length
      ? `${members.length} member${members.length === 1 ? '' : 's'} will find it in their portal:`
      : 'No members have been added yet.'}</p>
    ${members.length ? `<ul class="dlg-list">${members.map((s) =>
      `<li>${esc(s.name)}${s.investor_id ? '' : ' <span class="muted">— no portal account, '
        + 'so they will need a copy sent to them</span>'}</li>`).join('')}</ul>` : ''}
    <span class="muted" style="font-size:12.5px">
      From this point the wording cannot be edited. If something needs to change you can recall
      it, which clears any signatures already given — a member should never be bound to words
      that moved after they read them.</span>
  `, async () => {
    const res = await api(`/agreements/${a.id}/issue`, { method: 'POST' });
    toast(`Sent to ${res.sent_to} member${res.sent_to === 1 ? '' : 's'}`);
  }, 'Send it');
}

const CAPACITIES = {
  Entity: ['Manager', 'Managing Member', 'Member', 'President', 'Vice President',
           'Secretary', 'Treasurer', 'Partner', 'Attorney-in-fact'],
  Trust: ['Trustee', 'Co-Trustee', 'Successor Trustee', 'Attorney-in-fact'],
  IRA: ['Custodian', 'Account holder', 'Authorised signatory'],
  Other: ['Authorised signatory', 'Attorney-in-fact'],
};

function openSignDialog(a) {
  const me = a.me || a.signers.find((s) => s.role === 'Manager');
  /* A company, trust or IRA cannot hold a pen. Where the party is one, the
     signature needs both halves — the entity, which is what is bound, and the
     person signing for it in the capacity that gives them the authority. */
  const entity = !!me?.party_type && me.party_type !== 'Individual';
  const kind = me?.party_type === 'Trust' ? 'a trust'
    : me?.party_type === 'IRA' ? 'an account' : 'an entity';
  const capacities = CAPACITIES[me?.party_type] || CAPACITIES.Entity;

  openDialog('Sign this agreement', `
    <p style="margin-top:0">You are signing as <strong>${esc(me?.name || '')}</strong>${
      me?.pct != null ? `, holding ${fmtPct(me.pct)}` : ''}${
      me?.contribution != null ? ` for a contribution of ${fmtExact(me.contribution)}` : ''}.</p>
    ${entity ? `<div class="notice-box">
      ${esc(me?.name || '')} is ${kind}, so both go on the signature line: the name it is
      drawn in, and you — the person signing for it, in the capacity that gives you the
      authority to. Signing your own name alone would bind you rather than ${esc(me?.name || '')}.
    </div>` : ''}
    ${inputField(entity ? `Type the name of ${esc(me?.name || 'the party')}` : 'Type your full name',
      'signed_name', '', 'text',
      `required autocomplete=off placeholder="${esc(me?.name || '')}"`)}
    ${entity ? `
      ${inputField('Your name — the person signing on its behalf', 'signed_by_name', '', 'text',
        'required autocomplete=off placeholder="Ellen Ward"')}
      <div class="field"><label>Your capacity</label>
        <input name="signed_by_title" list="capacityList" required autocomplete="off"
               placeholder="${esc(capacities[0])}">
        <datalist id="capacityList">
          ${capacities.map((c) => `<option value="${esc(c)}"></option>`).join('')}
        </datalist></div>` : ''}
    <label class="dlg-check">
      <input type="checkbox" name="agreed" value="yes" required>
      <span>I have read this operating agreement in full and I intend this to be my signature.
        I agree to sign electronically.</span>
    </label>
    <span class="muted" style="font-size:12px">
      The portal will record the moment you sign, the address you signed from, and a fingerprint
      of the exact text — ${esc(String(a.body_hash || '').slice(0, 16))} — so the document you
      signed can be told apart from any other version later.</span>
  `, async (v) => {
    await api(`/agreements/${a.id}/sign`, { method: 'POST', body: {
      signed_name: v.signed_name, agreed: v.agreed === 'yes', body_hash: a.body_hash,
      signed_by_name: v.signed_by_name, signed_by_title: v.signed_by_title } });
    toast('Signed');
  }, 'Sign');
}

function openDeclineDialog(a) {
  openDialog('Not signing', `
    <p style="margin-top:0">This tells the manager you are not signing. It does not delete
      anything, and you can still sign later if the position changes.</p>
    <div class="field"><label>Anything you want them to know</label>
      <textarea name="note" rows="3" placeholder="Optional"></textarea></div>
  `, async (v) => {
    await api(`/agreements/${a.id}/decline`, { method: 'POST', body: { note: v.note } });
    toast('The manager has been told');
  }, 'Send');
}

function openRecallDialog(a) {
  const signed = a.signers.filter((s) => s.signed_at).length;
  openDialog('Recall to draft', `
    <p style="margin-top:0">This puts the agreement back into draft so the details can change.</p>
    ${signed ? `<div class="error-box">${signed} signature${signed === 1 ? '' : 's'} will be
      cleared. Anyone who has already signed will have to read it again and sign the new
      version.</div>` : ''}
  `, async () => {
    const res = await api(`/agreements/${a.id}/recall`, { method: 'POST' });
    toast(res.cleared ? `Back to draft · ${res.cleared} signature(s) cleared` : 'Back to draft');
  }, 'Recall it');
}

function openVoidDialog(a) {
  openDialog('Void this agreement', `
    <p style="margin-top:0">A voided agreement stays on the record with its signatures intact —
      it is simply marked as no longer in force. Use this rather than deleting when something
      has actually been signed.</p>
    ${inputField('Why', 'reason', '', 'text', 'required placeholder="Superseded by the 2027 restatement"')}
  `, async (v) => {
    await api(`/agreements/${a.id}/void`, { method: 'POST', body: { reason: v.reason } });
    toast('Voided');
  }, 'Void it');
}

/* ------------------------------ render ------------------------------- */

const VIEWS = {
  dashboard: dashboardView,
  policies: policiesView,
  policy: policyView,
  servicing: servicingView,
  opportunities: opportunitiesView,
  opportunity: () => (String(state.params.extra || '').startsWith('sheet-')
    ? opportunitySheetView() : opportunityView()),
  maturities: maturitiesView,
  carry: carryView,
  insureds: insuredsView,
  investors: investorsView,
  investor: investorView,
  documents: documentsView,
  reports: () => reportsView(api, state),
  import: importView,
  // An investor has an Agreements tab of their own; for staff the list
  // lives on the Documents tab, so an old link lands there rather than on
  // a second page showing the same thing.
  agreements: () => (isInvestorUser() ? agreementsView() : documentsView()),
  agreement: agreementView,
  settings: settingsView,
};

/* Which render is the current one.
 *
 * Typing produces a request per pause, and they do not necessarily come back
 * in the order they were sent — a search for "a" can land after a search for
 * "abc" and put the wrong rows on screen. Every render takes a number; when
 * one finishes it checks whether it is still the newest, and if it is not it
 * throws its own result away. */
let renderToken = 0;

/**
 * Keep the caret where it was.
 *
 * A render replaces the contents of the page, which destroys whatever the
 * person was typing in — the element goes, and with it the focus and the
 * cursor position. Search boxes re-render as you type, so without this the
 * first letter lands, the results arrive, and the box is no longer yours:
 * exactly the "type one letter and it resets" that made searching unusable.
 *
 * Matched on the element's id, which every box that survives a render has.
 */
function rememberFocus() {
  const el = document.activeElement;
  if (!el || !el.id || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return null;
  let start = null, end = null;
  // Not every input type allows a selection to be read; a number box throws.
  try { start = el.selectionStart; end = el.selectionEnd; } catch { /* no caret */ }
  return { id: el.id, start, end, value: el.value };
}

function restoreFocus(f) {
  if (!f) return;
  const el = document.getElementById(f.id);
  if (!el || el === document.activeElement) return;
  /* Anything typed while the results were on their way belongs to the person,
     not to the value the page was built from. */
  if (f.value !== undefined && el.value !== f.value && document.hasFocus()) el.value = f.value;
  el.focus({ preventScroll: true });
  if (f.start !== null) { try { el.setSelectionRange(f.start, f.end); } catch { /* no caret */ } }
}

/**
 * `soft` redraws the page under the menu without rebuilding the shell.
 *
 * Searching used to go through the full path: the whole frame torn down and
 * rebuilt, the menu badges and the security notices refetched, and the search
 * box replaced — three extra requests and a flicker for every letter typed.
 * A filter changes what is in the table and nothing else, so it redraws that.
 */
async function render({ soft = false } = {}) {
  screenKeys = null;
  const app = $('#app');

  if (!state.user) {
    /* Signed out, there are exactly two things a person can be doing:
       signing in, or asking for an account. The register form is a
       separate screen rather than a panel on the login card, because it
       is long and because somebody filling it in is not half-way through
       signing in. */
    if (state.route === 'register') {
      app.innerHTML = registerView();
      wireRegister();
      return;
    }
    app.innerHTML = loginView();
    wireLogin();
    return;
  }

  /* Before any of the application: an account whose password was set by
     somebody else has exactly one thing it may do. */
  if (state.user.must_change_password) {
    app.innerHTML = firstPasswordView();
    wireFirstPassword();
    return;
  }

  const view = VIEWS[state.route] || dashboardView;
  const token = ++renderToken;
  const focus = rememberFocus();

  if (!soft || !$('#main')) {
    app.innerHTML = shell('<div class="empty"><span class="spin"></span></div>');
    wireShell();
    showSecurityNotices();
    refreshOppCount();
    refreshAgreementCount();
    refreshApplicationCount();
  }

  try {
    const out = await view();
    // A newer render started while this one was fetching: its answer wins.
    if (token !== renderToken) return;
    const result = typeof out === 'string' ? { html: out } : out;
    /* Read the caret again right before the swap rather than trusting what it
       was when the request went out — anything typed while the results were on
       their way is in the live box, and it is the newest thing the person
       said. On a full render the box is already gone, so the earlier reading
       stands. */
    const focusNow = rememberFocus() || focus;
    $('#main').innerHTML = result.html;
    result.after?.();
    restoreFocus(focusNow);
    fitStatValues();
  } catch (err) {
    if (token !== renderToken || !state.user) return;
    $('#main').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    restoreFocus(focus);
  }
}

/**
 * A headline figure that will not fit its tile.
 *
 * The KPI numbers are deliberately set on one line — a death benefit broken
 * across two lines at a comma reads as two numbers. But "one line" and "always
 * fits" are not the same promise, and a book with a $5,262,941,081 face amount
 * in it silently lost its last three digits off the right-hand edge, which is
 * the one failure a number on a dashboard must never have. So anything too wide
 * is stepped down until it fits, and only then.
 */
function fitStatValues() {
  for (const el of document.querySelectorAll('.stat .value')) {
    el.style.fontSize = '';
    const room = el.parentElement.clientWidth
      - parseFloat(getComputedStyle(el.parentElement).paddingLeft || 0)
      - parseFloat(getComputedStyle(el.parentElement).paddingRight || 0);
    if (!room) continue;
    let size = parseFloat(getComputedStyle(el).fontSize);
    // 13px is where the figure stops being a headline; below that it should
    // look wrong, because a number that long in a tile this size is wrong.
    while (el.scrollWidth > el.clientWidth + 1 && size > 13) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }
}

/* The tiles are flexible, so the room a figure has changes with the window.
   Refitting on resize keeps the promise at every width, not just the one the
   page happened to load at. */
window.addEventListener('resize', fitStatValues);

function wireShell() {
  $('#buildReload')?.addEventListener('click', () => location.reload(true));
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    state.user = null;
    render();
  });
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('ph-theme', next);
    render();
  });
}

/* ------------------------------- boot -------------------------------- */

/* ------------------------------ idle ---------------------------------- *
 * An hour without activity and the session is over.
 *
 * The server enforces this on its own — the session cookie carries an hour's
 * expiry and is reissued as somebody works — so a browser that declines to
 * run this timer is still signed out on its next request. This half exists so
 * that a screen left open does not sit there looking signed in, and so the
 * person is told why rather than meeting a bare login form.
 *
 * "Activity" is deliberately a real interaction. A page that merely happens to
 * be open, or a chart animating, is not somebody at the desk.
 * -------------------------------------------------------------------- */
const IDLE_LIMIT_MS = 60 * 60 * 1000;
const IDLE_WARN_MS = 5 * 60 * 1000;      // a warning five minutes before
let lastActivity = Date.now();
let idleWarned = false;

function noteActivity() {
  lastActivity = Date.now();
  if (idleWarned) {
    idleWarned = false;
    $('#idleWarning')?.remove();
  }
}
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
  window.addEventListener(ev, noteActivity, { passive: true });

async function signOutIdle() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
  state.user = null;
  state.signedOutReason =
    'Signed out after an hour without activity. Please sign in again.';
  $('#idleWarning')?.remove();
  render();
}

setInterval(() => {
  if (!state.user) return;
  const idle = Date.now() - lastActivity;
  if (idle >= IDLE_LIMIT_MS) return void signOutIdle();
  if (idle >= IDLE_LIMIT_MS - IDLE_WARN_MS && !idleWarned) {
    idleWarned = true;
    const bar = document.createElement('div');
    bar.id = 'idleWarning';
    bar.className = 'security-bar warn';
    bar.innerHTML = `
      <span class="security-mark" aria-hidden="true">!</span>
      <div class="security-text">This session will close in about five minutes
        without activity. Anything typed and not saved will be lost.</div>
      <div class="spacer"></div>
      <button class="btn-sm" id="idleStay">I am still here</button>`;
    $('#securityBanner')?.after(bar);
    $('#idleStay')?.addEventListener('click', () => {
      noteActivity();
      // Touch the server too, so its clock slides forward with ours.
      api('/auth/me').catch(() => {});
    });
  }
}, 30 * 1000);

(async function boot() {
  const saved = localStorage.getItem('ph-theme');
  if (saved) document.documentElement.dataset.theme = saved;

  const { route, params } = parseHash();
  state.route = route;
  state.params = params;

  try {
    state.user = await api('/auth/me');
    await loadPrefs();
  } catch {
    state.user = null;
  }
  render();
})();

/**
 * Charts are drawn to the width available, so a genuine width change means
 * redrawing them. Everything else about a resize is irrelevant, and a
 * re-render is destructive: it replaces the DOM, so anything half typed —
 * a settlement amount, a snapshot figure — would silently vanish.
 *
 * Hence two guards. Height-only changes are ignored (a phone's address bar
 * collapsing, a screenshot tool extending the page), and a form with
 * unsaved input in it is left alone entirely.
 */
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(window.__phResize);
  window.__phResize = setTimeout(() => {
    if (!state.user || !['dashboard', 'policy'].includes(state.route)) return;
    const active = document.activeElement;
    if (active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
    const dirty = [...document.querySelectorAll('#main input, #main select, #main textarea')]
      .some((f) => (f.type === 'checkbox' || f.type === 'radio'
        ? f.checked !== f.defaultChecked
        : f.value !== f.defaultValue));
    if (dirty) return;
    render();
  }, 250);
});
