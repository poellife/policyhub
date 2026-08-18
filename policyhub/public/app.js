/* =====================================================================
   PolicyHub — front end
   ===================================================================== */

import { lineChart, barChart, fmtMoney, fmtExact, seriesColor, hideTip } from './charts.js';
import { reportsView, buildOpportunitySheet } from './reports.js';
import { analyzeFlows, fmtIrr, today as irrToday } from './irr.js';

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
  filters: { search: '', status: '', fund: '' },
  insuredSearch: '',
  investorSearch: '',
  investors: [],
  sort: { key: 'insured_last', dir: 1 },
  funds: [],
  oppCount: 0,        // drives the badge in the menu
};

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

/** Download an array of objects as CSV. */
function exportCsv(filename, rows, columns) {
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
  ['reports', 'Reports'],
  ['import', 'Import'],
  ['settings', 'Settings'],
];

// An investor sees only their own holdings; the staff-only sections are absent
// from the menu and refused by the server regardless.
const INVESTOR_NAV = [
  ['dashboard', 'Portfolio'],
  ['policies', 'My policies'],
  ['opportunities', 'Opportunities'],
  ['servicing', 'Premiums'],
  ['maturities', 'Realized'],
  ['reports', 'Statements'],
  ['settings', 'Account'],
];

// A portfolio manager works inside their own entities. They get no Settings tab
// — no owner entities, no user management, no activity log — but they still need
// somewhere to change their own password, so that becomes "Account".
const MANAGER_NAV = STAFF_NAV.map(([r, label]) =>
  r === 'settings' ? ['settings', 'Account'] : [r, label]);

const isInvestorUser = () => state.user?.role === 'investor';
const isManagerUser  = () => state.user?.role === 'manager';
const canEditData    = () => ['admin', 'editor', 'manager'].includes(state.user?.role);
const navItems = () =>
  isInvestorUser() ? INVESTOR_NAV : isManagerUser() ? MANAGER_NAV : STAFF_NAV;

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
        ${navItems().map(([r, label]) => {
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
        <span class="muted" style="font-size:13px">${esc(
          isInvestorUser() && state.user.investor
            ? state.user.investor.name
            : isManagerUser() && state.user.funds?.length
              ? `${state.user.name || state.user.email} · ${state.user.funds.map((f) => f.code).join(', ')}`
              : state.user?.name || state.user?.email || '')}</span>
        <button class="btn-sm" id="logoutBtn">Sign out</button>
      </div>
    </div>
    <div class="main" id="main">${inner}</div>`;
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
        <div id="loginError"></div>
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
      location.hash = '#/dashboard';
      await render();
    } catch (err) {
      $('#loginError').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

/* ----------------------------- dashboard ----------------------------- */

async function dashboardView() {
  const [sum, svc] = await Promise.all([api('/analytics/summary'), api('/servicing')]);
  const t = sum.totals;
  const critical = svc.alerts.filter((a) => a.severity === 'critical').length;
  const annualPremium = Number(t.monthly_coi) * 12;
  // What an investor is shown instead of servicing alerts: what is coming and
  // what their part of it costs.
  const todayIso = today();
  const upcomingMine = (svc.upcoming || [])
    .filter((r) => r.next_premium_due && String(r.next_premium_due).slice(0, 10) >= todayIso)
    .sort((a, b) => String(a.next_premium_due).localeCompare(String(b.next_premium_due)));
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
        <div class="sub">${t.policy_count} ${t.policy_count === 1 ? 'position' : isInvestorUser() ? 'positions' : 'active policies'}
          · average insured age ${sum.avgInsuredAge ? Math.round(sum.avgInsuredAge) : '—'}${
          isInvestorUser() ? ' · figures reflect your ownership percentage' : ''}</div>
      </div>
      <div class="spacer"></div>
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
      <div class="stat">
        <div class="label">Portfolio IRR</div>
        <div class="value">${fmtIrr(sum.irr?.irr)}</div>
        <div class="note">${sum.irr?.days
          ? `if every policy matured today · ${(sum.irr.days / 365).toFixed(1)} yr span`
          : 'no dated cash flows yet'}</div>
      </div>
      ${isInvestorUser() ? `
      <div class="stat">
        <div class="label">Next premium due</div>
        <div class="value">${nextDue ? fmtDate(nextDue.next_premium_due) : '—'}</div>
        <div class="note">${nextDue ? `${fmtExact(nextDue.premium_required)} · your share` : 'nothing scheduled'}</div>
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
          : upcomingMine.slice(0, 8).map((r) => `<tr class="clickable" data-id="${r.id}">
              <td class="strong">${fmtDate(r.next_premium_due)}</td>
              <td>${esc(r.display_name || `${r.insured_first || ''} ${r.insured_last || ''}`.trim())}</td>
              <td class="secondary">${esc(r.carrier_name)} ${esc(r.policy_number)}</td>
              <td class="num">${fmtExact(r.premium_required)}</td>
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
        <div style="font-variant-numeric:tabular-nums;font-weight:600">${
          a.scheduled ? (a.amount ? fmtExact(a.amount) : '')
            : (a.premium_required ? fmtExact(a.premium_required) : '')}</div>
        <div class="meta">${a.scheduled
          ? `${fmtDate(a.due_date)} · scheduled`
          : (a.next_premium_due ? fmtDate(a.next_premium_due) : '')}</div>
      </div>
    </div>`;
}

/* ------------------------------ policies ----------------------------- */

const POLICY_COLUMNS = [
  { key: 'policy_number', header: 'Policy #', cell: (p) => `<span class="strong">${esc(p.policy_number)}</span>` },
  { key: 'insured_last', header: 'Last name', cell: (p) => esc(p.insured_last || '—') },
  { key: 'insured_first', header: 'First name', cell: (p) => esc(p.insured_first || '—') },
  { key: 'insured_dob', header: 'DOB', cell: (p) => fmtDate(p.insured_dob) },
  { key: 'age', header: 'Age', cls: 'num', value: (p) => ageFrom(p.insured_dob), cell: (p) => ageFrom(p.insured_dob) ?? '—' },
  { key: 'carrier_name', header: 'Carrier', cell: (p) => esc(p.carrier_name) },
  { key: 'product_type', header: 'Type', cell: (p) =>
      p.product_type ? `<span title="${esc(PRODUCT_LABELS[p.product_type] || p.product_type)}">${esc(p.product_type)}</span>` : '<span class="muted">—</span>' },
  { key: 'issue_date', header: 'Issued', cell: (p) => fmtDate(p.issue_date) },
  { key: 'face_amount', header: 'Face', cls: 'num', cell: (p) => money(scaled(p.face_amount, p), 2) },
  { key: 'death_benefit', header: 'Death benefit', cls: 'num',
    cell: (p) => money(scaled(p.death_benefit ?? p.face_amount, p), 2) },
  { key: 'fund_code', header: 'Owner', cell: (p) => esc(p.fund_code || p.owner_account || '—') },
  { key: 'premium_required', header: 'Premium', cls: 'num', cell: (p) => money(scaled(p.premium_required, p), 2) },
  { key: 'account_value', header: 'AV', cls: 'num', cell: (p) => money(scaled(p.account_value, p), 2) },
  { key: 'cash_surrender_value', header: 'CSV', cls: 'num', cell: (p) => money(scaled(p.cash_surrender_value, p), 2) },
  { key: 'cost_of_insurance', header: 'COI', cls: 'num', cell: (p) => money(scaled(p.cost_of_insurance, p), 2) },
  { key: 'total_invested', header: 'Invested', cls: 'num', cell: (p) => money(scaled(p.total_invested, p), 2) },
  { key: 'date_of_last_withdrawal', header: 'Last w/d', cell: (p) => fmtDate(p.date_of_last_withdrawal) },
  { key: 'value_as_of', header: 'Values as of', cell: (p) => fmtDate(p.value_as_of) },
  { key: 'status', header: 'Status', cell: (p) => statusBadge(p.status) },
];

/** Investors get an extra column showing what proportion of each policy is theirs. */
const MY_SHARE_COLUMN = {
  key: 'my_pct', header: 'My share', cls: 'num',
  value: (p) => Number(p.my_pct),
  cell: (p) => `<span class="strong">${Number(p.my_pct).toFixed(Number(p.my_pct) % 1 ? 4 : 0)}%</span>`,
};
/* Account value, cash surrender value and cost of insurance are how a policy
   is administered, not how an investment performs. An investor is not going to
   surrender the policy — they hold a percentage of a death benefit — so these
   invite a question nobody can act on, and a cash value quoted next to a
   purchase price reads like a valuation, which it is not. They are staff
   columns. */
const CARRIER_MECHANICS = [
  'account_value', 'cash_surrender_value', 'cost_of_insurance',
  // Dated by the same carrier statements, and meaningless without them.
  'value_as_of', 'date_of_last_withdrawal',
];

const policyColumns = () =>
  isInvestorUser()
    ? [...POLICY_COLUMNS.slice(0, 1), MY_SHARE_COLUMN, ...POLICY_COLUMNS.slice(1)]
        .filter((c) => !CARRIER_MECHANICS.includes(c.key))
    : POLICY_COLUMNS;

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
    api(`/policies?search=${encodeURIComponent(state.filters.search)}&status=${encodeURIComponent(state.filters.status)}&fund=${encodeURIComponent(state.filters.fund)}`),
    isInvestorUser() ? Promise.resolve([])
      : state.funds.length ? Promise.resolve(state.funds) : api('/funds'),
  ]);
  state.policies = policies;
  state.funds = funds;
  const rows = sortPolicies(policies);

  const totals = rows.reduce((acc, p) => {
    const f = shareFactor(p);
    acc.face += (Number(p.face_amount) || 0) * f;
    acc.db += (Number(p.death_benefit ?? p.face_amount) || 0) * f;
    acc.av += (Number(p.account_value) || 0) * f;
    acc.csv += (Number(p.cash_surrender_value) || 0) * f;
    acc.coi += (Number(p.cost_of_insurance) || 0) * f;
    acc.prem += (Number(p.premium_required) || 0) * f;
    acc.inv += (Number(p.total_invested) || 0) * f;
    return acc;
  }, { face: 0, db: 0, av: 0, csv: 0, coi: 0, prem: 0, inv: 0 });

  const html = `
    <div class="page-head">
      <div><h1>${isInvestorUser() ? 'My policies' : 'Policies'}</h1>
        <div class="sub">${rows.length} of ${policies.length ? policies.length : 0} shown${
          isInvestorUser() ? ' · every figure is your share of each policy' : ''}</div></div>
      <div class="spacer"></div>
      ${shareToggle()}
      <button id="exportBtn">Export CSV</button>
      ${canEditData() ? '<button class="primary" id="newPolicyBtn">New policy</button>' : ''}
    </div>

    <div class="toolbar">
      <input class="grow" id="searchInput" placeholder="Search policy #, insured, carrier…" value="${esc(state.filters.search)}">
      <select id="statusFilter">
        <option value="">All statuses</option>
        ${['Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending']
          .map((s) => `<option ${state.filters.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <select id="fundFilter" style="${isInvestorUser() ? 'display:none' : ''}">
        <option value="">All owners</option>
        ${funds.map((f) => `<option ${state.filters.fund === f.code ? 'selected' : ''}>${esc(f.code)}</option>`).join('')}
      </select>
    </div>

    <div class="card">
      <div class="table-wrap sticky-head">
        <table class="data">
          <thead><tr>${policyColumns().map((c) =>
            `<th class="sortable ${c.cls || ''}" data-key="${c.key}">${c.header}${
              state.sort.key === c.key ? `<span class="arrow">${state.sort.dir === 1 ? '↑' : '↓'}</span>` : ''}</th>`
          ).join('')}</tr></thead>
          <tbody>
            ${rows.length === 0
              ? `<tr><td colspan="${policyColumns().length}"><div class="empty">No policies yet. Import a CSV or add one manually.</div></td></tr>`
              : rows.map((p) => `<tr class="clickable" data-id="${p.id}">${
                  policyColumns().map((c) => `<td class="${c.cls || ''}">${c.cell(p)}</td>`).join('')
                }</tr>`).join('')}
          </tbody>
          ${rows.length ? `<tfoot><tr>
            <td colspan="${isInvestorUser() ? 9 : 8}">Totals — ${rows.length} policies</td>
            <td class="num">${fmtExact(totals.face)}</td>
            <td class="num">${fmtExact(totals.db)}</td>
            <td></td>
            <td class="num">${fmtExact(totals.prem)}</td>
            ${isInvestorUser() ? '' : `<td class="num">${fmtExact(totals.av)}</td>
            <td class="num">${fmtExact(totals.csv)}</td>
            <td class="num">${fmtExact(totals.coi)}</td>`}
            <td class="num">${fmtExact(totals.inv)}</td>
            <td colspan="3"></td>
          </tr></tfoot>` : ''}
        </table>
      </div>
    </div>`;

  return {
    html,
    after: () => {
      let timer;
      $('#searchInput').addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.filters.search = e.target.value; render(); }, 250);
      });
      $('#statusFilter').addEventListener('change', (e) => { state.filters.status = e.target.value; render(); });
      $('#fundFilter')?.addEventListener('change', (e) => { state.filters.fund = e.target.value; render(); });
      document.querySelectorAll('th.sortable').forEach((th) =>
        th.addEventListener('click', () => {
          const key = th.dataset.key;
          state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
          render();
        }));
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`)));
      $('#exportBtn').addEventListener('click', () => {
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
        ]);
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
  const age = ageFrom(p.insured_dob);
  const coi = Number(p.cost_of_insurance) || 0;
  const av = Number(p.account_value) || 0;
  const monthsCovered = coi > 0 ? av / coi : null;

  // Value history is entirely account value, cash surrender value and cost of
  // insurance — carrier administration, not investment performance. There is
  // nothing left of the tab once those are taken out, so it goes.
  const tabs = [['overview', 'Overview'],
                ...(isInvestorUser() ? [] : [['values', 'Value history']]),
                ['transactions', 'Transactions'], ['return', 'Return / IRR'],
                ['servicing', isInvestorUser() ? 'Premiums' : 'Servicing']];

  const html = `
    <div class="page-head">
      <div>
        <div class="sub"><a href="#/policies">← All policies</a></div>
        <h1>${esc(insuredName(p))}</h1>
        <div class="sub">${esc(p.carrier_name)} · Policy ${esc(p.policy_number)}
          ${p.fund_code ? `· ${esc(p.fund_code)}` : ''} · ${statusBadge(p.status)}</div>
      </div>
      <div class="spacer"></div>
      ${shareToggle(p.my_pct)}
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
          ? `${fmtExact(scaled(p.premium_required, p))} · your share`
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
    <div id="tabBody">${renderDetailTab(p, values, monthsCovered, irrData)}</div>`;

  return {
    html,
    after: () => {
      document.querySelectorAll('.tabs button').forEach((b) =>
        b.addEventListener('click', () => { detailTab = b.dataset.tab; render(); }));
      wireShareToggle();
      $('#editBtn')?.addEventListener('click', () => openPolicyDialog(p));
      $('#deletePolicyBtn')?.addEventListener('click', () => openDeletePolicyDialog(p));
      $('#editInsuredBtn')?.addEventListener('click', async () => {
        const ins = await api(`/insureds/${p.insured_id}`);
        openInsuredDialog(ins);
      });
      wireDetailTab(p, values, irrData);
    },
  };
}

function renderDetailTab(p, values, monthsCovered, irrData) {
  if (detailTab === 'values') return isInvestorUser() ? overviewTab(p) : valuesTab(p, values);
  if (detailTab === 'transactions') return transactionsTab(p);
  if (detailTab === 'return') return returnTab(p, irrData);
  if (detailTab === 'servicing') return servicingTab(p, monthsCovered);
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
          <th class="num">Age</th><th class="num">LE (months)</th><th>Date of death</th><th></th>
        </tr></thead>
        <tbody>
          ${p.insured_id
            ? lifeRow({ id: p.insured_id, last_name: p.insured_last, first_name: p.insured_first,
                        dob: p.insured_dob, le_months: p.le_months, date_of_death: p.date_of_death },
                      true)
            : '<tr><td colspan="8"><div class="empty">No insured recorded on this policy.</div></td></tr>'}
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
        ${row('Premium required', `${money(scaled(p.premium_required, p))} <span class="muted">${esc(p.premium_mode || '')}</span>`)}
        ${row('Next premium due', nextPremium(p)
          ? `${fmtDate(nextPremium(p).date)}${nextPremium(p).scheduled
              ? ' <span class="muted">scheduled</span>' : ''}`
          : fmtDate(null))}
        ${row('Grace period', `${p.grace_period_days || 61} days`)}
        ${row('Values as of', fmtDate(p.value_as_of))}
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
                <td>${canEditData() ? `<button class="btn-sm btn-danger" data-del-value="${v.id}">Delete</button>` : ''}</td>
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
                <td>${canEditData() ? `<button class="btn-sm btn-danger" data-del-txn="${t.id}">Delete</button>` : ''}</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/**
 * The soonest premium actually coming on a policy.
 *
 * A policy carries one next-due date from the carrier, but a premium put on
 * the follow-up schedule by hand is just as real and may fall sooner. Whoever
 * is reading the page wants the earlier of the two, and wants to know which
 * kind it is.
 */
function nextPremium(p) {
  const todayIso = today();
  const options = [];
  if (p.next_premium_due && String(p.next_premium_due).slice(0, 10) >= todayIso)
    options.push({ date: String(p.next_premium_due).slice(0, 10), scheduled: false });
  for (const r of p.reminders || [])
    if (r.kind === 'Premium' && !r.done_at && String(r.due_date).slice(0, 10) >= todayIso)
      options.push({ date: String(r.due_date).slice(0, 10), scheduled: true });
  options.sort((a, b) => (a.date < b.date ? -1 : 1));
  // Nothing ahead: fall back to the carrier date so a lapsed one still shows.
  return options[0]
    || (p.next_premium_due ? { date: String(p.next_premium_due).slice(0, 10), scheduled: false } : null);
}

function servicingTab(p, monthsCovered) {
  /* An investor gets the dates and what their share of each will cost, and
     nothing else. Lapse risk, stale carrier data and the follow-up work are
     the manager's job; an investor reading "account value covers 2.4 months"
     on a policy they hold 8% of has been handed an alarm they cannot act on. */
  if (isInvestorUser()) {
    const f = shareFactor(p);
    // Anything scheduled by hand joins the carrier's own next-due date, so the
    // investor sees one list of what is coming rather than two half-lists.
    const planned = (p.reminders || [])
      .filter((r) => r.kind === 'Premium' && !r.done_at)
      .map((r) => ({ date: String(r.due_date).slice(0, 10), amount: Number(r.amount) * f,
                     full: Number(r.amount), note: r.note, scheduled: true }));
    const carrier = p.next_premium_due
      ? [{ date: String(p.next_premium_due).slice(0, 10),
           amount: Number(p.premium_required || 0) * f,
           full: Number(p.premium_required || 0), note: '', scheduled: false }]
      : [];
    const all = [...carrier, ...planned].sort((a, b) => (a.date < b.date ? -1 : 1));

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
          Amounts beyond the next carrier date are estimates from the policy illustration and
          will move. Your column is ${p.my_pct != null ? fmtPct(p.my_pct) : 'your percentage'}
          of the full policy premium beside it.</span>
      </div>
    </div>`;
  }

  const steps = p.reminders || [];
  const open = steps.filter((r) => !r.done_at);
  const done = steps.filter((r) => r.done_at);
  const due = p.next_premium_due
    ? Math.round((new Date(`${p.next_premium_due}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000)
    : null;
  const notes = [];
  if (due !== null && due < 0) notes.push(['critical', `Premium was due ${Math.abs(due)} days ago`]);
  else if (due !== null && due <= 14) notes.push(['warning', `Premium due in ${due} days`]);
  else if (due !== null) notes.push(['info', `Premium due in ${due} days`]);
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
          <dt>Premium required</dt><dd>${money(scaled(p.premium_required, p))}</dd>
          <dt>Mode</dt><dd>${esc(p.premium_mode || '—')}</dd>
          <dt>Next due</dt><dd>${nextPremium(p)
            ? `${fmtDate(nextPremium(p).date)}${nextPremium(p).scheduled
                ? ' <span class="muted">scheduled</span>' : ''}`
            : fmtDate(null)}</dd>
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
  </div>`;
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

/* ---------------------------- return / IRR --------------------------- */

/**
 * Internal rate of return on this policy, and a calculator for the one
 * number that matters at the end: what the cheque actually was and when it
 * cleared. Both figures are solved from dated cash flows — the day each
 * premium left and the day the money came back — so they answer the same
 * question a spreadsheet's XIRR would, and can be checked against one.
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
  if (r.ambiguous) caveats.push(
    'Cash flows change direction more than once (a withdrawal between premiums, ' +
    'for example), so more than one rate can satisfy the equation. The one shown ' +
    'is the first root above −100%.');
  if (!settled && r.irr !== null) caveats.push(
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
        <div class="label">${settled ? 'Realized IRR' : d.status === 'Matured' ? 'IRR if collected today' : 'IRR if matured today'}</div>
        <div class="value hero">${fmtIrr(r.irr)}</div>
        <div class="note">${r.days} days · ${r.years.toFixed(2)} years held</div>
      </div>
      <div class="stat">
        <div class="label">Capital invested</div>
        <div class="value">${fmtExact(r.invested)}</div>
        <div class="note">first outlay ${r.first_flow ? fmtDate(r.first_flow) : '—'}</div>
      </div>
      <div class="stat">
        <div class="label">${settled ? 'Proceeds received' : 'Proceeds assumed'}</div>
        <div class="value">${fmtExact(r.returned)}</div>
        <div class="note">${settled
          ? `received ${d.proceeds_received_on ? fmtDate(d.proceeds_received_on) : '—'}`
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
          <div class="field"><label>Date the cheque cleared</label>
            <input type="date" id="calcPaid" value="${esc(dateInput(d.proceeds_received_on) || '')}">
            <span class="muted" style="font-size:12px">The IRR is measured to this date —
              collection lag is a real cost.</span></div>
        </div>

        <div class="kpi-row" style="margin-top:4px">
          <div class="stat">
            <div class="label">Exact IRR</div>
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
            <div class="note">vs ${fmtIrr(r.irr)} shown above</div>
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
        IRR is solved on actual dates over a 365-day year — the same convention as
        Excel's XIRR, so these figures reconcile against a spreadsheet. Policy loans
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
    $('#calcIrr').textContent = fmtIrr(a.irr);
    $('#calcProfit').textContent = fmtExact(a.profit);
    $('#calcProfit').style.color = a.profit >= 0 ? 'var(--success-text)' : 'var(--critical)';
    $('#calcMultiple').textContent = a.multiple ? `${a.multiple.toFixed(2)}× capital` : '—';
    $('#calcNote').textContent = `${a.days} days · ${a.years.toFixed(2)} years held`;
    const base = d.result.irr;
    const delta = base === null || a.irr === null ? null : a.irr - base;
    $('#calcDelta').textContent = delta === null ? '—'
      : `${delta >= 0 ? '+' : '−'}${fmtIrr(Math.abs(delta))}`;
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
    e.target.disabled = true;
    try {
      // The date of death has to land first: it is what matures the policy,
      // and proceeds are refused on one that has not.
      if (dodEl.value && dodEl.value !== dateInput(d.matured_on)) {
        if (!p.insured_id) throw new Error('This policy has no insured on file to record a death against.');
        await api(`/insureds/${p.insured_id}`, { method: 'PUT', body: { date_of_death: dodEl.value } });
      }
      if (amountEl.value !== '' || paidEl.value) {
        await api(`/policies/${p.id}/proceeds`, { method: 'PUT', body: {
          proceeds_amount: amountEl.value === '' ? null : amountEl.value,
          proceeds_received_on: paidEl.value || null,
        } });
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
      openTxnDialog(p, { txn_type: 'Premium Payment', amount: p.premium_required }));
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
  }
}

/* ------------------------------ dialogs ------------------------------ */

function openDialog(title, bodyHtml, onSubmit, submitLabel = 'Save') {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <form method="dialog" id="dlgForm">
      <div class="dialog-head">${esc(title)}</div>
      <div class="dialog-body"><div id="dlgError"></div>${bodyHtml}</div>
      <div class="dialog-foot">
        <button type="button" id="dlgCancel">Cancel</button>
        <button type="submit" class="primary">${esc(submitLabel)}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  // Escape / backdrop dismissal should also drop it from the DOM.
  dlg.addEventListener('close', () => dlg.remove());
  $('#dlgCancel', dlg).addEventListener('click', () => { dlg.close(); dlg.remove(); });
  $('#dlgForm', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
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
    </div>
    <div class="field" style="margin-top:-4px">
      <span class="muted" style="font-size:12px">
        Matches an existing insured on last name + first name + date of birth, or creates a new one.
        To correct spelling or add life-expectancy details, use <strong>Edit insured</strong> instead.
      </span>
    </div>
    <div class="field-row">
      ${selectField('Product type', 'product_type', p?.product_type || '', PRODUCT_TYPES)}
      ${inputField('Face amount', 'face_amount', p?.face_amount, 'number', 'step=0.01')}
      <div class="field">
        <label>Owner entity</label>
        <select name="fund_code" id="fundSelect">
          <option value="">— No owner —</option>
          ${state.funds.map((f) => `<option value="${esc(f.code)}" ${p?.fund_code === f.code ? 'selected' : ''}>
            ${esc(f.code)}${f.name && f.name !== f.code ? ` — ${esc(f.name)}` : ''}</option>`).join('')}
          <option value="__new__">+ Add a new entity…</option>
        </select>
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
      ${inputField('Owner account', 'owner_account', p?.owner_account)}
    </div>
    <div class="field-row">
      ${inputField('Premium required', 'premium_required', p?.premium_required, 'number', 'step=0.01')}
      ${selectField('Premium mode', 'premium_mode', p?.premium_mode || 'Annual',
        ['Monthly', 'Quarterly', 'Semi-Annual', 'Annual'])}
      ${inputField('Next premium due', 'next_premium_due', dateInput(p?.next_premium_due), 'date')}
    </div>
    <div class="field-row">
      ${inputField('Acquisition date', 'acquisition_date', dateInput(p?.acquisition_date), 'date')}
      ${inputField('Acquisition cost', 'acquisition_cost', p?.acquisition_cost, 'number', 'step=0.01')}
      ${selectField('Status', 'status', p?.status || 'Inforce',
        ['Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'])}
    </div>
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
  const body = `
    <div class="field-row">
      ${inputField('Code *', 'code', f?.code, 'text', 'required placeholder="e.g. LCG2"')}
      ${inputField('Full legal name', 'name', f?.name, 'text', 'placeholder="e.g. Life Capital Group 2, LLC"')}
    </div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(f?.notes || '')}</textarea></div>
    <span class="muted" style="font-size:12px">
      The code is what appears in the policy grid and reports. Renaming it updates every
      policy that points at this entity — nothing is reassigned.
    </span>`;

  openDialog(isNew ? 'New owner entity' : 'Edit owner entity', body, async (v) => {
    if (isNew) await api('/funds', { method: 'POST', body: v });
    else await api(`/funds/${f.id}`, { method: 'PUT', body: v });
    state.funds = await api('/funds');
    toast(isNew ? 'Entity created' : 'Entity updated');
    onSaved?.();
  }, isNew ? 'Create entity' : 'Save');
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
      ${inputField('State', 'state', ins?.state)}
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
      const saved = await api(`/insureds/${ins.id}`, { method: 'PUT', body: v });
      // Say plainly what recording a death did, rather than leaving someone to
      // wonder why a policy vanished from the grid.
      const matured = (saved.policies || []).filter((p) => p.matured);
      toast(matured.length
        ? `Insured updated — ${matured.map((p) => p.policy_number).join(', ')} moved to Maturities`
        : 'Insured updated');
    }
    onSaved?.();
  });
}

function openValueDialog(p) {
  const body = `
    ${inputField('As of date *', 'as_of_date', today(), 'date', 'required')}
    <div class="field-row">
      ${inputField('Account value (AV)', 'account_value', '', 'number', 'step=0.01')}
      ${inputField('Cash surrender value (CSV)', 'cash_surrender_value', '', 'number', 'step=0.01')}
    </div>
    <div class="field-row">
      ${inputField('Cost of insurance (COI)', 'cost_of_insurance', '', 'number', 'step=0.01')}
      ${inputField('Death benefit', 'death_benefit', p.death_benefit ?? p.face_amount, 'number', 'step=0.01')}
    </div>
    <div class="field-row">
      ${inputField('Loan balance', 'loan_balance', '', 'number', 'step=0.01')}
      ${inputField('Date of last withdrawal', 'date_of_last_withdrawal', '', 'date')}
    </div>
    ${inputField('Notes', 'notes')}`;

  openDialog('Add value snapshot', body, async (v) => {
    await api(`/policies/${p.id}/values`, { method: 'POST', body: v });
    toast('Snapshot saved');
  });
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
  // Default to a year out at the stated premium — the commonest case by far,
  // and a sensible thing to correct rather than a blank form to fill in.
  const suggestedDate = existing ? dateInput(existing.due_date)
    : addMonthsIso(dateInput(p.next_premium_due) || today(),
      { Monthly: 1, Quarterly: 3, 'Semi-Annual': 6, Annual: 12 }[p.premium_mode] || 12);

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
        <input name="amount" type="number" step="0.01" min="0"
               value="${esc(existing?.amount ?? p.premium_required ?? '')}">
      </div>
    </div>

    <div class="field"><label id="stepNoteLabel">Note</label>
      <textarea name="note" rows="3"
        placeholder="Step-up per the carrier illustration">${esc(existing?.note || '')}</textarea>
    </div>

    <span class="muted" style="font-size:12px">
      This goes on the Servicing calendar and stays there until somebody marks it done.
      The amount is an estimate — what was actually paid is recorded with
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

function openTxnDialog(p, preset = {}) {
  const body = `
    <div class="field-row">
      ${inputField('Date *', 'txn_date', today(), 'date', 'required')}
      ${selectField('Type *', 'txn_type', preset.txn_type || 'Premium Payment',
        ['Premium Payment', 'Acquisition Cost', 'Withdrawal', 'Loan', 'Fee', 'Commission', 'Servicing', 'Other'])}
    </div>
    ${inputField('Amount *', 'amount', preset.amount ?? '', 'number', 'step=0.01 required')}
    ${inputField('Remarks', 'remarks')}`;

  openDialog('Add transaction', body, async (v) => {
    await api(`/policies/${p.id}/transactions`, { method: 'POST', body: v });
    toast('Transaction saved');
  });
}

/* ----------------------------- servicing ----------------------------- */

async function servicingView() {
  const svc = await api('/servicing');
  // An investor is shown what is still to come. A date that has already
  // passed is a servicing matter — somebody is chasing it — and putting it
  // on an investor's screen reads as a bill they have missed.
  const upcoming = svc.upcoming.filter((r) => r.next_premium_due
    && (!isInvestorUser() || String(r.next_premium_due).slice(0, 10) >= today()));
  const grouped = {};
  for (const r of upcoming) {
    const key = String(r.next_premium_due).slice(0, 7);
    (grouped[key] ||= []).push(r);
  }

  const investor = isInvestorUser();
  const html = `
    <div class="page-head">
      <div><h1>${investor ? 'Premiums' : 'Servicing calendar'}</h1>
        <div class="sub">${investor
          ? `${upcoming.length} upcoming premium ${upcoming.length === 1 ? 'date' : 'dates'} · amounts are your share`
          : `${svc.alerts.length} open ${svc.alerts.length === 1 ? 'alert' : 'alerts'} ·
             ${upcoming.length} scheduled premium ${upcoming.length === 1 ? 'payment' : 'payments'}${
             (svc.scheduled || []).length ? ` · ${svc.scheduled.length} follow-up${
               svc.scheduled.length === 1 ? '' : 's'} outstanding` : ''}`}</div></div>
      <div class="spacer"></div>
      ${shareToggle()}
    </div>

    ${investor ? '' : `
    <div class="card">
      <div class="card-head"><h2>Alerts</h2></div>
      <div class="card-body flush">
        ${svc.alerts.length === 0
          ? '<div class="empty">Nothing needs attention.</div>'
          : svc.alerts.map(alertRow).join('')}
      </div>
    </div>`}

    <div class="card">
      <div class="card-head"><h2>Upcoming premiums</h2>${investor ? `<div class="spacer"></div>
        <span class="muted" style="font-size:12px">amounts shown are your share</span>` : ''}</div>
      <div class="card-body flush">
        ${Object.keys(grouped).length === 0
          ? `<div class="empty">${investor
              ? 'No premium dates are scheduled on your policies at the moment.'
              : 'No premium due dates recorded. Add them on each policy.'}</div>`
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
    </div>`;

  return {
    html,
    after: () => document.querySelectorAll('tr.clickable').forEach((tr) =>
      tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`))),
  };
}

/* --------------------------- opportunities --------------------------- */

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
        <div><div class="label">IRR at life expectancy</div>
          <div class="value">${fmtIrr(o.irr_at_le)}</div>
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
          if (e.target.closest('a,button')) return;
          go(`#/opportunity/${c.dataset.opp}`);
        }));
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
  const canTake = isInvestorUser() && o.status === 'Open'
    && (daysUntil(o.offer_closes_on) === null || daysUntil(o.offer_closes_on) >= 0);

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
            ${a.scenarios.map((s) => cell(s, (x) => fmtExact(x.premiums_paid))).join('')}</tr>
          <tr><td class="strong">Total invested</td>
            ${a.scenarios.map((s) => cell(s, (x) => fmtExact(x.invested))).join('')}</tr>
          <tr><td class="strong">Profit</td>
            ${a.scenarios.map((s) => cell(s, (x) => fmtExact(x.profit))).join('')}</tr>
          <tr><td class="strong">Multiple</td>
            ${a.scenarios.map((s) => cell(s, (x) => `${x.multiple.toFixed(2)}×`)).join('')}</tr>
          <tr><td class="strong">IRR</td>
            ${a.scenarios.map((s) => `<td class="num strong ${s.offset_months === 0 ? 'at-le' : ''}"
              style="font-size:16px">${fmtIrr(s.irr)}</td>`).join('')}</tr>
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
          <div class="field" style="margin:0">
            <label>Percentage you want</label>
            <input type="number" id="takePct" step="0.01" min="0.01" max="${myMax}"
              value="${mine ? Number(mine.pct) : ''}" placeholder="up to ${fmtPct(myMax)}">
            ${myHeld ? `<span class="muted" style="font-size:12px">
              You hold ${fmtPct(myHeld)}; changing this replaces it.</span>` : ''}
          </div>
          <div class="field" style="margin:0">
            <label>Your cost at that share</label>
            <div id="takeCost" style="font-size:19px;font-weight:600;padding:7px 0">—</div>
          </div>
          <div class="field" style="margin:0">
            <label>Your profit at LE</label>
            <div id="takeProfit" style="font-size:19px;font-weight:600;padding:7px 0">—</div>
          </div>
          <div class="field" style="margin:0">
            <button class="primary" id="takeBtn" style="width:100%">${
              mine && mine.status === 'Requested' ? 'Update your request' : 'Request this share'}</button>
          </div>
        </div>
        <div class="muted" style="font-size:12px">
          A request holds the percentage straight away, so what other investors see as
          available drops immediately. It becomes an allocation once Poel Capital confirms it.
          The IRR is not affected by how much you take — a rate has no size.
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
          IRR is solved on the actual date of every cash flow over a 365-day year — the same
          convention as Excel’s XIRR.
        </span>
      </div>
    </div>

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
              ${isInvestorUser() ? `<td class="num">${mine
                ? fmtExact(Number(p.amount) * Number(mine.pct) / 100) : '—'}</td>` : ''}
              <td class="secondary">${esc(p.notes || '')}</td>
              ${staff && canEditData()
                ? `<td style="white-space:nowrap">
                     <button class="btn-sm" data-edit-prem="${p.id}">Edit</button>
                     <button class="btn-sm btn-danger" data-del-prem="${p.id}">Remove</button></td>` : ''}
            </tr>`).join('')}</tbody>
        ${o.premiums.length ? `<tfoot><tr><td>Total posted</td>
          <td class="num">${fmtExact(o.premiums.reduce((s, p) => s + Number(p.amount), 0))}</td>
          ${isInvestorUser() ? '<td></td>' : ''}<td></td>${staff && canEditData() ? '<td></td>' : ''}
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
          ${(o.shares || []).length
            ? `Shared with ${o.shares.map((s) => esc(s.name)).join(', ')}.`
            : 'Not shared with anybody yet — no investor can see this.'}
        </span>
      </div>
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
      $('#fundOppBtn')?.addEventListener('click', () => {
        openFundDialog(o).catch((e) => alert(e.message));
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

      // Live cost as the investor types a percentage.
      const pctEl = $('#takePct');
      if (pctEl) {
        const base = a.base;
        const recalc = () => {
          const pct = Number(pctEl.value);
          const ok = pct > 0 && pct <= myMax + 1e-9;
          $('#takeCost').textContent = ok
            ? fmtExact(Number(o.asking_price || 0) * pct / 100) : '—';
          $('#takeProfit').textContent = ok && base ? fmtExact(base.profit * pct / 100) : '—';
          $('#takeMsg').innerHTML = pct > myMax + 1e-9
            ? `<div class="error-box">Only ${fmtPct(myMax)} is available to you${
                myHeld ? `, including the ${fmtPct(myHeld)} you already hold` : ''}.</div>` : '';
        };
        pctEl.addEventListener('input', recalc);
        recalc();

        $('#takeBtn').addEventListener('click', async () => {
          const pct = Number(pctEl.value);
          if (!pct || pct <= 0) { $('#takeMsg').innerHTML = '<div class="error-box">Enter a percentage.</div>'; return; }
          try {
            await api(`/opportunities/${o.id}/commit`, { method: 'POST', body: { pct } });
            toast(`Requested ${fmtPct(pct)}`);
            refreshOppCount();
            render();
          } catch (err) {
            $('#takeMsg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
          }
        });
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
  openDialog(isNew ? 'New opportunity' : `Edit ${oppName(o)}`, `
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
      ${inputField('State', 'insured_state', o?.insured_state)}
      ${inputField('Life expectancy (months)', 'le_months', o?.le_months, 'number')}
    </div>
    <div class="field-row">
      ${inputField('LE provider', 'le_provider', o?.le_provider)}
      ${inputField('LE report date', 'le_date', dateInput(o?.le_date), 'date')}
      ${inputField('Death benefit', 'face_amount', o?.face_amount, 'number', 'step=0.01')}
    </div>
    <div class="field" style="margin-top:-4px"><span class="muted" style="font-size:12px">
      Life expectancy is counted from the report date, not from today — an estimate written
      two years ago has already used two years of itself.</span></div>
    <div class="field-row">
      ${inputField('Asking price', 'asking_price', o?.asking_price, 'number', 'step=0.01')}
      ${inputField('Annual premium', 'annual_premium', o?.annual_premium, 'number', 'step=0.01')}
      <div class="field"><label>Owner entity</label>
        <select name="fund_id">
          <option value="">—</option>
          ${state.funds.map((f) => `<option value="${f.id}" ${
            Number(o?.fund_id) === Number(f.id) ? 'selected' : ''}>${esc(f.code)}</option>`).join('')}
        </select></div>
    </div>
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
      toast('Opportunity created');
      go(`#/opportunity/${made.id}`);
    } else {
      await api(`/opportunities/${o.id}`, { method: 'PUT', body: v });
      toast('Opportunity updated');
    }
  }, isNew ? 'Create' : 'Save');
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
      <td><input type="number" step="0.01" min="0" class="prem-amt num"
                 value="${r.amount === '' || r.amount == null ? '' : esc(r.amount)}"
                 placeholder="0.00"></td>
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
      row here removes the payment. Years beyond the last one are carried into the IRR
      analysis at the same annual rate.
    </span>
  `, async () => {
    const rows = [...dlg.querySelectorAll('.prem-row')].map((tr) => ({
      due_date: tr.querySelector('.prem-due').value,
      amount: tr.querySelector('.prem-amt').value,
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
      .reduce((s, el) => s + (Number(el.value) || 0), 0);
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
    const base = Number(amts[0]?.value);
    if (!base) { amts[0]?.focus(); return; }
    const growth = Number($('#premGrowth', dlg).value) || 0;
    amts.forEach((el, i) => {
      if (i === 0 || el.value !== '') return;
      el.value = (Math.round(base * (1 + growth / 100) ** i * 100) / 100).toFixed(2);
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
      ${inputField('Amount', 'amount', p.amount, 'number', 'step=0.01 min=0 required')}
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
      The IRR is the same at any percentage — every cash flow scales together.
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

/* ---------------------------- maturities ----------------------------- */

/**
 * The register of policies that have paid out, or are waiting to.
 *
 * Nothing lands here by hand: recording a date of death moves the policy out
 * of the active book automatically. On a survivorship policy that means the
 * *second* death, since a second-to-die contract pays nothing on the first.
 */
async function maturitiesView() {
  const m = await api('/maturities');
  const t = m.totals;
  const rows = m.rows;
  const investorView = isInvestorUser();

  // Realized position: what came in against what went in. Only meaningful once
  // the carrier has actually paid, so unpaid claims are excluded from the gain
  // rather than counted as a loss of the whole basis.
  const collected = rows.filter((r) => r.proceeds_amount != null);
  const collectedBasis = collected.reduce((s, r) => s + (Number(r.total_invested) || 0) * (shareFactor(r) || 1), 0);
  const gain = Number(t.total_proceeds) - collectedBasis;
  const multiple = collectedBasis > 0 ? Number(t.total_proceeds) / collectedBasis : null;

  const nameOf = (r) =>
    esc(r.display_name || `${r.insured_first || ''} ${r.insured_last || ''}`.trim() || '—');

  const html = `
    <div class="page-head">
      <div><h1>${investorView ? 'Realized' : 'Maturities'}</h1>
        <div class="sub">${rows.length} matured ${rows.length === 1 ? 'policy' : 'policies'} ·
          ${t.paid_count} paid · ${rows.length - t.paid_count} awaiting payment</div></div>
      <div class="spacer"></div>
      ${shareToggle()}
      ${rows.length ? '<button id="exportMaturitiesBtn">Export CSV</button>' : ''}
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
        <div class="label">${t.paid_count > 0 ? 'Realized IRR' : 'IRR if collected today'}</div>
        <div class="value">${fmtIrr(m.portfolio?.irr)}</div>
        <div class="note">${t.paid_count === rows.length
          ? 'all claims paid · dated cash flows'
          : `${rows.length - t.paid_count} claim${rows.length - t.paid_count === 1 ? '' : 's'} still assumed collected today`}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Matured policies</h2><div class="spacer"></div>
        <span class="muted" style="font-size:12px">most recent first</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Matured</th><th>Insured</th><th>Policy #</th><th>Carrier</th>
          <th>Type</th>${investorView ? '' : '<th>Owner</th>'}
          <th class="num">Death benefit</th><th class="num">Invested</th>
          <th class="num">Proceeds</th><th>Received</th><th class="num">Gain</th>
          <th class="num">IRR</th>
          ${canEditData() ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${rows.map((r) => {
          const f = shareFactor(r);
          const benefit = Number(r.death_benefit || 0) * f;
          const basis = Number(r.total_invested || 0) * f;
          const paid = r.proceeds_amount == null ? null : Number(r.proceeds_amount) * f;
          const g = paid == null ? null : paid - basis;
          return `<tr class="clickable" data-id="${r.id}">
            <td class="strong">${fmtDate(r.matured_on)}</td>
            <td>${nameOf(r)}${r.lives_count > 1
                 ? ` <span class="muted" style="font-size:12px">+${r.lives_count - 1}</span>` : ''}</td>
            <td class="secondary">${esc(r.policy_number)}</td>
            <td>${esc(r.carrier_name)}</td>
            <td>${esc(r.product_type || '—')}</td>
            ${investorView ? '' : `<td>${esc(r.fund_code || '—')}</td>`}
            <td class="num">${fmtExact(benefit)}</td>
            <td class="num">${fmtExact(basis)}</td>
            <td class="num">${paid == null
              ? '<span class="badge grace"><span class="dot"></span>Awaiting</span>' : fmtExact(paid)}</td>
            <td>${r.proceeds_received_on ? fmtDate(r.proceeds_received_on) : '<span class="muted">—</span>'}</td>
            <td class="num" ${g == null ? '' : `style="color:${g >= 0 ? 'var(--success-text)' : 'var(--critical)'}"`}>
              ${g == null ? '<span class="muted">—</span>' : fmtExact(g)}</td>
            <td class="num ${paid == null ? 'secondary' : ''}" title="${
              paid == null ? 'Provisional — assumes the death benefit is collected today'
              : r.irr_short ? 'Held under 90 days — an annualised rate is unreliable here'
              : r.irr_ambiguous ? 'Cash flows change direction more than once; more than one rate can satisfy the equation'
              : `${r.irr_days} days held`}">
              ${fmtIrr(r.irr)}${r.irr != null && (paid == null || r.irr_short || r.irr_ambiguous)
                ? '<span class="muted"> *</span>' : ''}</td>
            ${canEditData() ? `<td><button class="btn-sm" data-proceeds="${r.id}"
                 >${r.proceeds_amount == null ? 'Record proceeds' : 'Edit'}</button></td>` : ''}
          </tr>`;
        }).join('')}</tbody>
        <tfoot><tr>
          <td colspan="${investorView ? 5 : 6}">Totals — ${rows.length}
            ${rows.length === 1 ? 'policy' : 'policies'}</td>
          <td class="num">${fmtExact(t.total_death_benefit)}</td>
          <td class="num">${fmtExact(t.total_invested)}</td>
          <td class="num">${fmtExact(t.total_proceeds)}</td>
          <td></td>
          <td class="num">${fmtExact(gain)}</td>
          <td class="num">${fmtIrr(m.portfolio?.irr)}</td>
          ${canEditData() ? '<td></td>' : ''}
        </tr></tfoot>
      </table></div>
    </div>

    <div class="card"><div class="card-body">
      <span class="muted" style="font-size:12px">
        Gain compares proceeds against every dollar in the ledger for that policy —
        acquisition cost, premiums, fees, servicing and commissions — and is shown
        only once the claim has been paid. A policy returns to the active book if
        its date of death is removed.<br>
        IRR is solved on the actual date of every cash flow over a 365-day year, the
        same convention as Excel's XIRR. The portfolio figure combines every matured
        policy's flows into one series rather than averaging the rates, so a large
        position counts for more than a small one. A <strong>*</strong> marks a rate
        that needs reading with care — an unpaid claim assumed collected today, a
        holding period under 90 days, or flows that change direction more than once.
        Hover it for the reason.</span>
    </div></div>`}`;

  return {
    html,
    after: () => {
      wireShareToggle();
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          go(`#/policy/${tr.dataset.id}`);
        }));
      document.querySelectorAll('[data-proceeds]').forEach((b) =>
        b.addEventListener('click', () =>
          openProceedsDialog(rows.find((r) => r.id === Number(b.dataset.proceeds)))));
      $('#exportMaturitiesBtn')?.addEventListener('click', () =>
        exportCsv('maturities.csv', rows, [
          { header: 'Matured', key: 'matured_on' },
          { header: 'Insured', get: (r) => r.display_name || `${r.insured_first || ''} ${r.insured_last || ''}`.trim() },
          { header: 'Policy #', key: 'policy_number' },
          { header: 'Carrier', key: 'carrier_name' },
          { header: 'Product', key: 'product_type' },
          { header: 'Owner', key: 'fund_code' },
          { header: 'Death Benefit', get: (r) => Number(r.death_benefit || 0) * shareFactor(r) },
          { header: 'Capital Invested', get: (r) => Number(r.total_invested || 0) * shareFactor(r) },
          { header: 'Proceeds', get: (r) => r.proceeds_amount == null ? '' : Number(r.proceeds_amount) * shareFactor(r) },
          { header: 'Received', key: 'proceeds_received_on' },
          { header: 'IRR', get: (r) => (r.irr == null ? '' : (r.irr * 100).toFixed(4)) },
          { header: 'Days Held', key: 'irr_days' },
        ]));
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
      ${inputField('Gross proceeds received', 'proceeds_amount', r.proceeds_amount, 'number', 'step=0.01 min=0')}
      ${inputField('Date received', 'proceeds_received_on', dateInput(r.proceeds_received_on), 'date')}
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
  const rows = await api(`/insureds?search=${encodeURIComponent(state.insuredSearch)}`);
  const html = `
    <div class="page-head">
      <div><h1>Insureds</h1>
        <div class="sub">${rows.length} ${rows.length === 1 ? 'person' : 'people'}</div></div>
      <div class="spacer"></div>
      <button id="exportInsuredsBtn">Export CSV</button>
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
      let timer;
      $('#insuredSearch').addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.insuredSearch = e.target.value; render(); }, 250);
      });
      $('#newInsuredBtn')?.addEventListener('click', () => openInsuredDialog(null));
      document.querySelectorAll('[data-edit-insured]').forEach((b) =>
        b.addEventListener('click', async () => {
          const ins = await api(`/insureds/${b.dataset.editInsured}`);
          openInsuredDialog(ins);
        }));
      $('#exportInsuredsBtn').addEventListener('click', () =>
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
        ]));
    },
  };
}

/* ----------------------------- investors ----------------------------- */

const INVESTOR_TYPES = ['Individual', 'Entity', 'Trust', 'IRA', 'Other'];

async function investorsView() {
  const rows = await api(`/investors?search=${encodeURIComponent(state.investorSearch)}`);
  state.investors = rows;
  const canEditNow = canEditData();

  const totals = rows.reduce((a, r) => ({
    db: a.db + Number(r.death_benefit || 0),
    inv: a.inv + Number(r.invested || 0),
    pos: a.pos + Number(r.position_count || 0),
  }), { db: 0, inv: 0, pos: 0 });

  const html = `
    <div class="page-head">
      <div><h1>Investors</h1>
        <div class="sub">${rows.length} ${rows.length === 1 ? 'investor' : 'investors'} · ${totals.pos} positions</div></div>
      <div class="spacer"></div>
      ${canEditNow ? '<button class="primary" id="newInvestorBtn">New investor</button>' : ''}
    </div>

    <div class="toolbar">
      <input class="grow" id="investorSearch" placeholder="Search by name or email…" value="${esc(state.investorSearch)}">
    </div>

    <div class="card"><div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th>Name</th><th>Type</th><th>Legal name</th><th>Email</th>
          <th class="num">Positions</th><th class="num">Death benefit</th>
          <th class="num">Invested</th><th class="num">Cash value</th><th></th>
        </tr></thead>
        <tbody>${rows.length === 0
          ? '<tr><td colspan="9"><div class="empty">No investors yet.</div></td></tr>'
          : rows.map((r) => `<tr class="clickable" data-investor="${r.id}">
              <td class="strong">${esc(r.name)}</td>
              <td>${esc(r.investor_type || '')}</td>
              <td class="secondary">${esc(r.legal_name || '')}</td>
              <td class="secondary">${esc(r.email || '')}</td>
              <td class="num">${r.position_count}</td>
              <td class="num">${money(r.death_benefit, 2)}</td>
              <td class="num">${money(r.invested, 2)}</td>
              <td class="num">${money(r.csv, 2)}</td>
              <td>${canEditNow ? `<button class="btn-sm" data-edit-investor="${r.id}">Edit</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
        ${rows.length ? `<tfoot><tr>
          <td colspan="4">Totals</td>
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
      let timer;
      $('#investorSearch').addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.investorSearch = e.target.value; render(); }, 250);
      });
      $('#newInvestorBtn')?.addEventListener('click', () => openInvestorDialog(null));
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
      document.querySelectorAll('tr.clickable[data-id]').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`)));
    },
  };
}

function openInvestorDialog(inv) {
  const isNew = !inv?.id;
  const body = `
    <div class="field-row">
      ${inputField('Name *', 'name', inv?.name, 'text', 'required')}
      ${selectField('Type', 'investor_type', inv?.investor_type || 'Individual', INVESTOR_TYPES)}
    </div>
    ${inputField('Full legal name', 'legal_name', inv?.legal_name, 'text',
      'placeholder="As it appears on the purchase agreement"')}
    <div class="field-row">
      ${inputField('Email', 'email', inv?.email, 'email')}
      ${inputField('Phone', 'phone', inv?.phone)}
      ${inputField('Tax ID (last 4)', 'tax_id_last4', inv?.tax_id_last4, 'text', 'maxlength=4')}
    </div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(inv?.notes || '')}</textarea></div>`;

  openDialog(isNew ? 'New investor' : 'Edit investor', body, async (v) => {
    if (isNew) await api('/investors', { method: 'POST', body: v });
    else await api(`/investors/${inv.id}`, { method: 'PUT', body: v });
    state.investors = await api('/investors');
    toast(isNew ? 'Investor created' : 'Investor updated');
  }, isNew ? 'Create investor' : 'Save');
}

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
            double your capital invested and halve every IRR. Tick this only if the policy
            genuinely took two identical payments on the same day.</span>
        </div>

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
                 ['value', 'Value snapshots'], ['transaction', 'Transactions']].map(([k, l]) => `
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
              <dt>Rows with errors</dt><dd>${res.errors.length}</dd>
            </dl>
            ${res.byType ? `<div style="margin-top:12px">
              <label>By record type</label>
              <span class="secondary">${Object.entries(res.byType)
                .filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ')}</span>
            </div>` : ''}
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

async function settingsView() {
  const isAdmin = state.user.role === 'admin';
  const canEdit = ['admin', 'editor'].includes(state.user.role);
  // Anything beyond the password panel is off-limits to scoped accounts.
  const accountOnly = isInvestorUser() || isManagerUser();
  const investorUser = accountOnly;
  const [users, audit, funds] = await Promise.all([
    isAdmin ? api('/users') : Promise.resolve([]),
    isAdmin ? api('/audit') : Promise.resolve([]),
    accountOnly ? Promise.resolve([]) : api('/funds'),
  ]);
  state.funds = funds;

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
        <thead><tr><th>Code</th><th>Full legal name</th><th class="num">Policies</th>
          <th class="num">Death benefit</th><th class="num">Invested</th><th>Notes</th><th></th></tr></thead>
        <tbody>${funds.length === 0
          ? '<tr><td colspan="7"><div class="empty">No entities yet.</div></td></tr>'
          : funds.map((f) => `<tr>
              <td class="strong">${esc(f.code)}</td>
              <td>${esc(f.name && f.name !== f.code ? f.name : '')}</td>
              <td class="num">${f.policy_count}</td>
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
  };
  roleSel.addEventListener('change', sync);
  sync();
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
  insureds: insuredsView,
  investors: investorsView,
  investor: investorView,
  reports: () => reportsView(api, state),
  import: importView,
  settings: settingsView,
};

async function render() {
  const app = $('#app');

  if (!state.user) {
    app.innerHTML = loginView();
    wireLogin();
    return;
  }

  const view = VIEWS[state.route] || dashboardView;
  app.innerHTML = shell('<div class="empty"><span class="spin"></span></div>');
  wireShell();
  refreshOppCount();

  try {
    const out = await view();
    const result = typeof out === 'string' ? { html: out } : out;
    $('#main').innerHTML = result.html;
    result.after?.();
  } catch (err) {
    if (!state.user) return;
    $('#main').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  }
}

function wireShell() {
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

(async function boot() {
  const saved = localStorage.getItem('ph-theme');
  if (saved) document.documentElement.dataset.theme = saved;

  const { route, params } = parseHash();
  state.route = route;
  state.params = params;

  try {
    state.user = await api('/auth/me');
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
