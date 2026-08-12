/* =====================================================================
   PolicyHub — front end
   ===================================================================== */

import { lineChart, barChart, fmtMoney, fmtCompact, seriesColor, hideTip } from './charts.js';
import { reportsView } from './reports.js';

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
  sort: { key: 'insured_last', dir: 1 },
  funds: [],
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

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function formValues(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = v;
  return out;
}

/** Download an array of objects as CSV. */
function exportCsv(filename, rows, columns) {
  const head = columns.map((c) => `"${c.header}"`).join(',');
  const body = rows.map((r) =>
    columns.map((c) => {
      const v = typeof c.get === 'function' ? c.get(r) : r[c.key];
      return `"${String(v ?? '').replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\n');
  const blob = new Blob([`${head}\n${body}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------ router ------------------------------- */

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [route, id] = h.split('/');
  return { route: route || 'dashboard', params: { id } };
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

const NAV = [
  ['dashboard', 'Dashboard'],
  ['policies', 'Policies'],
  ['servicing', 'Servicing'],
  ['insureds', 'Insureds'],
  ['reports', 'Reports'],
  ['import', 'Import'],
  ['settings', 'Settings'],
];

function shell(inner) {
  const active = ['policy'].includes(state.route) ? 'policies' : state.route;
  return `
    <div class="topbar">
      <div class="brand"><span class="brand-mark"></span>Poel Capital</div>
      <div class="brand-divider"></div>
      <div class="brand-sub">Policy Portfolio</div>
      <nav class="nav">
        ${NAV.map(([r, label]) =>
          `<a href="#/${r}" class="${active === r ? 'active' : ''}">${label}</a>`).join('')}
      </nav>
      <div class="topbar-right">
        <button class="btn-sm btn-icon" id="themeBtn" title="Toggle light / dark">◐</button>
        <span class="muted" style="font-size:13px">${esc(state.user?.name || state.user?.email || '')}</span>
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
      state.user = await api('/auth/login', { method: 'POST', body: formValues(e.target) });
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

  const html = `
    <div class="page-head">
      <div>
        <h1>Portfolio dashboard</h1>
        <div class="sub">${t.policy_count} active ${t.policy_count === 1 ? 'policy' : 'policies'}
          · average insured age ${sum.avgInsuredAge ? Math.round(sum.avgInsuredAge) : '—'}</div>
      </div>
      <div class="spacer"></div>
      <a class="btn" href="#/import">Import data</a>
      <a class="btn btn-primary" href="#/policies">View policies</a>
    </div>

    <div class="kpi-row">
      <div class="stat">
        <div class="label">Total death benefit</div>
        <div class="value hero">${fmtCompact(t.total_death_benefit)}</div>
        <div class="note">Face at issue ${fmtCompact(t.total_face)}</div>
      </div>
      <div class="stat">
        <div class="label">Capital invested</div>
        <div class="value">${fmtCompact(t.total_invested)}</div>
        <div class="note">${fmtCompact(t.total_acquisition)} acquisition · ${fmtCompact(t.total_premiums)} premiums</div>
      </div>
      <div class="stat">
        <div class="label">Cash surrender value</div>
        <div class="value">${fmtCompact(t.total_csv)}</div>
        <div class="note">Account value ${fmtCompact(t.total_av)}</div>
      </div>
      <div class="stat">
        <div class="label">Cost of insurance</div>
        <div class="value">${fmtCompact(t.monthly_coi)}<span style="font-size:15px;color:var(--text-muted)">/mo</span></div>
        <div class="note">≈ ${fmtCompact(annualPremium)} per year</div>
      </div>
      <div class="stat">
        <div class="label">Needs attention</div>
        <div class="value" style="${critical ? 'color:var(--critical)' : ''}">${svc.alerts.length}</div>
        <div class="note">${critical} critical</div>
      </div>
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

    <div class="card">
      <div class="card-head"><h2>Alerts</h2><div class="spacer"></div>
        <a href="#/servicing" style="font-size:13px">Open servicing calendar →</a></div>
      <div class="card-body flush">
        ${svc.alerts.length === 0
          ? '<div class="empty">Nothing needs attention right now.</div>'
          : svc.alerts.slice(0, 12).map(alertRow).join('')}
      </div>
    </div>`;

  return {
    html,
    after: () => {
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
        <div style="font-variant-numeric:tabular-nums;font-weight:600">${a.premium_required ? fmtMoney(a.premium_required) : ''}</div>
        <div class="meta">${a.next_premium_due ? fmtDate(a.next_premium_due) : ''}</div>
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
  { key: 'face_amount', header: 'Face', cls: 'num', cell: (p) => money(p.face_amount) },
  { key: 'death_benefit', header: 'Death benefit', cls: 'num', cell: (p) => money(p.death_benefit ?? p.face_amount) },
  { key: 'fund_code', header: 'Owner', cell: (p) => esc(p.fund_code || p.owner_account || '—') },
  { key: 'premium_required', header: 'Premium', cls: 'num', cell: (p) => money(p.premium_required) },
  { key: 'account_value', header: 'AV', cls: 'num', cell: (p) => money(p.account_value, 2) },
  { key: 'cash_surrender_value', header: 'CSV', cls: 'num', cell: (p) => money(p.cash_surrender_value, 2) },
  { key: 'cost_of_insurance', header: 'COI', cls: 'num', cell: (p) => money(p.cost_of_insurance, 2) },
  { key: 'total_invested', header: 'Invested', cls: 'num', cell: (p) => money(p.total_invested) },
  { key: 'date_of_last_withdrawal', header: 'Last w/d', cell: (p) => fmtDate(p.date_of_last_withdrawal) },
  { key: 'value_as_of', header: 'Values as of', cell: (p) => fmtDate(p.value_as_of) },
  { key: 'status', header: 'Status', cell: (p) => statusBadge(p.status) },
];

function sortPolicies(rows) {
  const { key, dir } = state.sort;
  const col = POLICY_COLUMNS.find((c) => c.key === key);
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
    state.funds.length ? Promise.resolve(state.funds) : api('/funds'),
  ]);
  state.policies = policies;
  state.funds = funds;
  const rows = sortPolicies(policies);

  const totals = rows.reduce((acc, p) => {
    acc.face += Number(p.face_amount) || 0;
    acc.db += Number(p.death_benefit ?? p.face_amount) || 0;
    acc.av += Number(p.account_value) || 0;
    acc.csv += Number(p.cash_surrender_value) || 0;
    acc.coi += Number(p.cost_of_insurance) || 0;
    acc.prem += Number(p.premium_required) || 0;
    acc.inv += Number(p.total_invested) || 0;
    return acc;
  }, { face: 0, db: 0, av: 0, csv: 0, coi: 0, prem: 0, inv: 0 });

  const html = `
    <div class="page-head">
      <div><h1>Policies</h1><div class="sub">${rows.length} of ${policies.length ? policies.length : 0} shown</div></div>
      <div class="spacer"></div>
      <button id="exportBtn">Export CSV</button>
      <button class="primary" id="newPolicyBtn">New policy</button>
    </div>

    <div class="toolbar">
      <input class="grow" id="searchInput" placeholder="Search policy #, insured, carrier…" value="${esc(state.filters.search)}">
      <select id="statusFilter">
        <option value="">All statuses</option>
        ${['Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending']
          .map((s) => `<option ${state.filters.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <select id="fundFilter">
        <option value="">All owners</option>
        ${funds.map((f) => `<option ${state.filters.fund === f.code ? 'selected' : ''}>${esc(f.code)}</option>`).join('')}
      </select>
    </div>

    <div class="card">
      <div class="table-wrap sticky-head">
        <table class="data">
          <thead><tr>${POLICY_COLUMNS.map((c) =>
            `<th class="sortable ${c.cls || ''}" data-key="${c.key}">${c.header}${
              state.sort.key === c.key ? `<span class="arrow">${state.sort.dir === 1 ? '↑' : '↓'}</span>` : ''}</th>`
          ).join('')}</tr></thead>
          <tbody>
            ${rows.length === 0
              ? `<tr><td colspan="${POLICY_COLUMNS.length}"><div class="empty">No policies yet. Import a CSV or add one manually.</div></td></tr>`
              : rows.map((p) => `<tr class="clickable" data-id="${p.id}">${
                  POLICY_COLUMNS.map((c) => `<td class="${c.cls || ''}">${c.cell(p)}</td>`).join('')
                }</tr>`).join('')}
          </tbody>
          ${rows.length ? `<tfoot><tr>
            <td colspan="8">Totals — ${rows.length} policies</td>
            <td class="num">${fmtCompact(totals.face)}</td>
            <td class="num">${fmtCompact(totals.db)}</td>
            <td></td>
            <td class="num">${fmtCompact(totals.prem)}</td>
            <td class="num">${fmtCompact(totals.av)}</td>
            <td class="num">${fmtCompact(totals.csv)}</td>
            <td class="num">${fmtCompact(totals.coi)}</td>
            <td class="num">${fmtCompact(totals.inv)}</td>
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
      $('#fundFilter').addEventListener('change', (e) => { state.filters.fund = e.target.value; render(); });
      document.querySelectorAll('th.sortable').forEach((th) =>
        th.addEventListener('click', () => {
          const key = th.dataset.key;
          state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
          render();
        }));
      document.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', () => go(`#/policy/${tr.dataset.id}`)));
      $('#exportBtn').addEventListener('click', () =>
        exportCsv('policies.csv', rows, [
          { header: 'Policy Number', key: 'policy_number' },
          { header: 'Last Name', key: 'insured_last' },
          { header: 'First Name', key: 'insured_first' },
          { header: 'DOB', key: 'insured_dob' },
          { header: 'Carrier Name', key: 'carrier_name' },
          { header: 'Product Type', key: 'product_type' },
          { header: 'Issue Date', key: 'issue_date' },
          { header: 'Basic Face', key: 'face_amount' },
          { header: 'Death Benefit', key: 'death_benefit' },
          { header: 'Owner', key: 'fund_code' },
          { header: 'Premium Required', key: 'premium_required' },
          { header: 'Premium Mode', key: 'premium_mode' },
          { header: 'Next Premium Due', key: 'next_premium_due' },
          { header: 'Values As Of', key: 'value_as_of' },
          { header: 'AV', key: 'account_value' },
          { header: 'CSV', key: 'cash_surrender_value' },
          { header: 'COI', key: 'cost_of_insurance' },
          { header: 'Total Invested', key: 'total_invested' },
          { header: 'Date Of Last Withdrawal', key: 'date_of_last_withdrawal' },
          { header: 'Status', key: 'status' },
        ]));
      $('#newPolicyBtn').addEventListener('click', () => openPolicyDialog());
    },
  };
}

/* --------------------------- policy detail --------------------------- */

let detailTab = 'overview';

async function policyView() {
  const p = await api(`/policies/${state.params.id}`);
  const values = [...p.values].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const age = ageFrom(p.insured_dob);
  const coi = Number(p.cost_of_insurance) || 0;
  const av = Number(p.account_value) || 0;
  const monthsCovered = coi > 0 ? av / coi : null;

  const tabs = [['overview', 'Overview'], ['values', 'Value history'],
                ['transactions', 'Transactions'], ['servicing', 'Servicing']];

  const html = `
    <div class="page-head">
      <div>
        <div class="sub"><a href="#/policies">← All policies</a></div>
        <h1>${esc(insuredName(p))}</h1>
        <div class="sub">${esc(p.carrier_name)} · Policy ${esc(p.policy_number)}
          ${p.fund_code ? `· ${esc(p.fund_code)}` : ''} · ${statusBadge(p.status)}</div>
      </div>
      <div class="spacer"></div>
      ${state.user.role === 'admin' ? '<button class="btn-danger" id="deletePolicyBtn">Delete policy</button>' : ''}
      ${p.insured_id ? '<button id="editInsuredBtn">Edit insured</button>' : ''}
      <button class="primary" id="editBtn">Edit policy</button>
    </div>

    <div class="kpi-row">
      <div class="stat"><div class="label">Death benefit</div>
        <div class="value">${fmtCompact(p.death_benefit ?? p.face_amount)}</div>
        <div class="note">Face at issue ${fmtCompact(p.face_amount)}</div></div>
      <div class="stat"><div class="label">Invested to date</div>
        <div class="value">${fmtCompact(p.total_invested)}</div>
        <div class="note">${fmtCompact(p.total_acquisition)} acquisition · ${fmtCompact(p.total_premiums)} premium</div></div>
      <div class="stat"><div class="label">Cash surrender value</div>
        <div class="value">${fmtCompact(p.cash_surrender_value)}</div>
        <div class="note">AV ${fmtCompact(p.account_value)} · as of ${p.value_as_of ? fmtDate(p.value_as_of) : '—'}</div></div>
      <div class="stat"><div class="label">Insured age</div>
        <div class="value">${age ?? '—'}</div>
        <div class="note">${p.insured_dob ? `Born ${fmtDate(p.insured_dob)}` : 'No date of birth on file'}</div></div>
      <div class="stat"><div class="label">Coverage runway</div>
        <div class="value" style="${monthsCovered !== null && monthsCovered < 6 ? 'color:var(--critical)' : ''}">${
          monthsCovered === null ? '—' : `${monthsCovered.toFixed(1)}<span style="font-size:15px;color:var(--text-muted)"> mo</span>`}</div>
        <div class="note">Account value ÷ monthly COI</div></div>
    </div>

    <div class="tabs">
      ${tabs.map(([k, label]) =>
        `<button data-tab="${k}" class="${detailTab === k ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="tabBody">${renderDetailTab(p, values, monthsCovered)}</div>`;

  return {
    html,
    after: () => {
      document.querySelectorAll('.tabs button').forEach((b) =>
        b.addEventListener('click', () => { detailTab = b.dataset.tab; render(); }));
      $('#editBtn').addEventListener('click', () => openPolicyDialog(p));
      $('#deletePolicyBtn')?.addEventListener('click', () => openDeletePolicyDialog(p));
      $('#editInsuredBtn')?.addEventListener('click', async () => {
        const ins = await api(`/insureds/${p.insured_id}`);
        openInsuredDialog(ins);
      });
      wireDetailTab(p, values);
    },
  };
}

function renderDetailTab(p, values, monthsCovered) {
  if (detailTab === 'values') return valuesTab(p, values);
  if (detailTab === 'transactions') return transactionsTab(p);
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
      <td>
        <button class="btn-sm" data-edit-life="${i.id}">Edit</button>
        ${isPrimary ? '' : `<button class="btn-sm btn-danger" data-remove-life="${linkId}">Remove</button>`}
      </td>
    </tr>`;

  return `
  <div class="card">
    <div class="card-head"><h2>Lives insured</h2><div class="spacer"></div>
      <button class="btn-sm primary" id="addLifeBtn">Add insured</button></div>
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
        ${row('Face amount', money(p.face_amount))}
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
        ${row('Acquisition cost', money(p.acquisition_cost))}
        ${row('Total invested', money(p.total_invested))}
        ${row('Premium required', `${money(p.premium_required)} <span class="muted">${esc(p.premium_mode || '')}</span>`)}
        ${row('Next premium due', fmtDate(p.next_premium_due))}
        ${row('Grace period', `${p.grace_period_days || 61} days`)}
        ${row('Values as of', fmtDate(p.value_as_of))}
      </dl>
      ${p.notes ? `<div style="margin-top:16px"><label>Notes</label><div class="secondary">${esc(p.notes)}</div></div>` : ''}
      </div>
    </div>
  </div>`;
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
      <button class="btn-sm primary" id="addValueBtn">Add snapshot</button></div>
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
                <td class="num">${money(v.account_value, 2)}</td>
                <td class="num">${money(v.cash_surrender_value, 2)}</td>
                <td class="num">${money(v.cost_of_insurance, 2)}</td>
                <td class="num">${money(v.death_benefit)}</td>
                <td class="num">${money(v.loan_balance, 2)}</td>
                <td>${fmtDate(v.date_of_last_withdrawal)}</td>
                <td class="muted">${esc(v.source)}</td>
                <td><button class="btn-sm btn-danger" data-del-value="${v.id}">Delete</button></td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function transactionsTab(p) {
  const byType = {};
  for (const t of p.transactions) byType[t.txn_type] = (byType[t.txn_type] || 0) + Number(t.amount);
  const total = p.transactions.reduce((s, t) => s + Number(t.amount), 0);

  return `
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h2>Totals by type</h2></div>
      <div class="card-body">
        ${Object.keys(byType).length === 0 ? '<div class="empty">No transactions yet</div>' : `
        <table class="data">
          <tbody>${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
            `<tr><td>${esc(k)}</td><td class="num strong">${fmtMoney(v)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td>Total invested</td><td class="num">${fmtMoney(total)}</td></tr></tfoot>
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
      <button class="btn-sm primary" id="addTxnBtn">Add transaction</button></div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th><th>Remarks</th><th>Source</th><th></th></tr></thead>
        <tbody>
          ${p.transactions.length === 0
            ? '<tr><td colspan="6"><div class="empty">No transactions recorded.</div></td></tr>'
            : p.transactions.map((t) => `<tr>
                <td class="strong">${fmtDate(t.txn_date)}</td>
                <td>${esc(t.txn_type)}</td>
                <td class="num">${money(t.amount, 2)}</td>
                <td class="secondary">${esc(t.remarks)}</td>
                <td class="muted">${esc(t.source)}</td>
                <td><button class="btn-sm btn-danger" data-del-txn="${t.id}">Delete</button></td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function servicingTab(p, monthsCovered) {
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
          <dt>Premium required</dt><dd>${money(p.premium_required)}</dd>
          <dt>Mode</dt><dd>${esc(p.premium_mode || '—')}</dd>
          <dt>Next due</dt><dd>${fmtDate(p.next_premium_due)}</dd>
          <dt>Grace period</dt><dd>${p.grace_period_days || 61} days</dd>
          <dt>Last withdrawal</dt><dd>${fmtDate(p.date_of_last_withdrawal)}</dd>
          <dt>Values as of</dt><dd>${fmtDate(p.value_as_of)}</dd>
        </dl>
        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-sm primary" id="logPremiumBtn">Log premium payment</button>
          <button class="btn-sm" id="advanceDueBtn">Advance next due date</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Status checks</h2></div>
      <div class="card-body flush">
        ${notes.length === 0
          ? '<div class="empty">No issues detected.</div>'
          : notes.map(([sev, text]) => `
            <div class="alert-row">
              <span class="sev ${sev}"><span class="ic">${SEV_ICON[sev]}</span></span>
              <div><div class="who">${esc(text)}</div></div>
            </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function wireDetailTab(p, values) {
  if (detailTab === 'overview') {
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

  if (detailTab === 'servicing') {
    $('#logPremiumBtn')?.addEventListener('click', () =>
      openTxnDialog(p, { txn_type: 'Premium Payment', amount: p.premium_required }));
    $('#advanceDueBtn')?.addEventListener('click', async () => {
      const base = p.next_premium_due ? new Date(`${p.next_premium_due}T00:00:00`) : new Date();
      const step = { Monthly: 1, Quarterly: 3, 'Semi-Annual': 6, Annual: 12 }[p.premium_mode] || 12;
      base.setMonth(base.getMonth() + step);
      await api(`/policies/${p.id}`, {
        method: 'PUT', body: { next_premium_due: base.toISOString().slice(0, 10) },
      });
      toast(`Next due date moved to ${base.toLocaleDateString('en-US')}`);
      render();
    });
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
        <tr><td>Death benefit</td><td class="strong">${money(p.death_benefit ?? p.face_amount)}</td></tr>
        <tr><td>Value snapshots</td><td class="strong">${vals}</td></tr>
        <tr><td>Ledger entries</td><td class="strong">${txns}</td></tr>
        ${lives ? `<tr><td>Additional lives</td><td class="strong">${lives}</td></tr>` : ''}
        <tr><td>Capital invested</td><td class="strong">${money(p.total_invested)}</td></tr>
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
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(ins?.notes || '')}</textarea></div>`;

  openDialog(isNew ? 'New insured' : 'Edit insured', body, async (v) => {
    if (isNew) await api('/insureds', { method: 'POST', body: v });
    else await api(`/insureds/${ins.id}`, { method: 'PUT', body: v });
    toast(isNew ? 'Insured created' : 'Insured updated');
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
  const upcoming = svc.upcoming.filter((r) => r.next_premium_due);
  const grouped = {};
  for (const r of upcoming) {
    const key = String(r.next_premium_due).slice(0, 7);
    (grouped[key] ||= []).push(r);
  }

  const html = `
    <div class="page-head">
      <div><h1>Servicing calendar</h1>
        <div class="sub">${svc.alerts.length} open ${svc.alerts.length === 1 ? 'alert' : 'alerts'} ·
          ${upcoming.length} scheduled premium ${upcoming.length === 1 ? 'payment' : 'payments'}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Alerts</h2></div>
      <div class="card-body flush">
        ${svc.alerts.length === 0
          ? '<div class="empty">Nothing needs attention.</div>'
          : svc.alerts.map(alertRow).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Upcoming premiums</h2></div>
      <div class="card-body flush">
        ${Object.keys(grouped).length === 0
          ? '<div class="empty">No premium due dates recorded. Add them on each policy.</div>'
          : Object.entries(grouped).sort().map(([month, rows]) => `
            <div style="padding:11px 16px;border-bottom:1px solid var(--grid);background:var(--page)">
              <strong>${new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong>
              <span class="muted"> · ${rows.length} due ·
                ${fmtMoney(rows.reduce((s, r) => s + (Number(r.premium_required) || 0), 0))}</span>
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

/* ----------------------------- insureds ------------------------------ */

async function insuredsView() {
  const rows = await api(`/insureds?search=${encodeURIComponent(state.insuredSearch)}`);
  const html = `
    <div class="page-head">
      <div><h1>Insureds</h1>
        <div class="sub">${rows.length} ${rows.length === 1 ? 'person' : 'people'}</div></div>
      <div class="spacer"></div>
      <button id="exportInsuredsBtn">Export CSV</button>
      <button class="primary" id="newInsuredBtn">New insured</button>
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
              <td><button class="btn-sm" data-edit-insured="${i.id}">Edit</button></td>
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
      $('#newInsuredBtn').addEventListener('click', () => openInsuredDialog(null));
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

/* ------------------------------ import ------------------------------- */

const IMPORT_TYPES = [
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
      <div class="sub">Upload a CSV. Column names are matched automatically — "Policy #", "Basic Face", "AV", "CSV", "COI" and the rest of your export headers are all recognised.</div></div></div>

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

        <div class="dropzone" id="dropzone">
          <div style="font-weight:600;margin-bottom:4px">Drop a CSV here, or click to choose a file</div>
          <div class="muted" style="font-size:12.5px">Up to 20 MB</div>
          <input type="file" id="fileInput" accept=".csv,text/csv" style="display:none">
        </div>

        <div style="margin-top:10px">
          <a href="#" data-template="policies">Download policies template</a> ·
          <a href="#" data-template="values">values template</a> ·
          <a href="#" data-template="transactions">transactions template</a>
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
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
      });
      fi.addEventListener('change', () => fi.files[0] && handleFile(fi.files[0]));

      document.querySelectorAll('[data-template]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          window.location = `/api/import/template/${a.dataset.template}`;
        }));
    },
  };
}

async function handleFile(file) {
  const type = $('#importType').value;
  const out = $('#importResult');
  out.innerHTML = '<div class="card"><div class="card-body"><span class="spin"></span> Reading file…</div></div>';

  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('type', type);
    const preview = await api('/import/preview', { method: 'POST', body: fd });

    out.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Preview — ${esc(file.name)}</h2><div class="spacer"></div>
          <span class="muted">${preview.rowCount} rows</span></div>
        <div class="card-body">
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
      const fd2 = new FormData();
      fd2.append('file', file);
      fd2.append('type', type);
      fd2.append('asOfDate', $('#asOfDate').value);
      try {
        const res = await api('/import/run', { method: 'POST', body: fd2 });
        out.innerHTML = `
          <div class="card"><div class="card-body">
            <div class="ok-box">Imported ${res.rowCount} rows from ${esc(file.name)}</div>
            <dl class="kv">
              <dt>Policies created</dt><dd>${res.created}</dd>
              <dt>Policies updated</dt><dd>${res.updated}</dd>
              <dt>Value snapshots written</dt><dd>${res.values}</dd>
              <dt>Rows with errors</dt><dd>${res.errors.length}</dd>
            </dl>
            ${res.errors.length ? `<div style="margin-top:14px">
              <label>Errors</label>
              <div class="table-wrap"><table class="data">
                <thead><tr><th>Line</th><th>Problem</th></tr></thead>
                <tbody>${res.errors.slice(0, 60).map((er) =>
                  `<tr><td>${er.line}</td><td>${esc(er.message)}</td></tr>`).join('')}</tbody>
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
  const [users, audit, funds] = await Promise.all([
    isAdmin ? api('/users') : Promise.resolve([]),
    isAdmin ? api('/audit') : Promise.resolve([]),
    api('/funds'),
  ]);
  state.funds = funds;

  const html = `
    <div class="page-head"><div><h1>Settings</h1>
      <div class="sub">Signed in as ${esc(state.user.email)} (${esc(state.user.role)})</div></div></div>

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
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Last sign-in</th></tr></thead>
          <tbody>${users.map((u) => `<tr>
            <td class="strong">${esc(u.email)}</td><td>${esc(u.full_name)}</td>
            <td>${esc(u.role)}</td>
            <td class="muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString('en-US') : 'never'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : ''}
    </div>

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
              <td class="num">${fmtCompact(f.total_death_benefit)}</td>
              <td class="num">${fmtCompact(f.total_invested)}</td>
              <td class="secondary">${esc(f.notes || '')}</td>
              <td>${canEdit ? `<button class="btn-sm" data-edit-entity="${f.id}">Edit</button>
                   <button class="btn-sm btn-danger" data-del-entity="${f.id}" data-code="${esc(f.code)}"
                     ${f.policy_count ? 'disabled title="Reassign its policies first"' : ''}>Delete</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>

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

      $('#addUserBtn')?.addEventListener('click', () => {
        openDialog('Add user', `
          ${inputField('Email *', 'email', '', 'email', 'required')}
          ${inputField('Full name', 'full_name')}
          ${inputField('Password (10+ characters) *', 'password', '', 'password', 'required minlength=10')}
          ${selectField('Role', 'role', 'editor', ['admin', 'editor', 'viewer'])}
        `, async (v) => {
          await api('/users', { method: 'POST', body: v });
          toast('User created');
        }, 'Create user');
      });
    },
  };
}

/* ------------------------------ render ------------------------------- */

const VIEWS = {
  dashboard: dashboardView,
  policies: policiesView,
  policy: policyView,
  servicing: servicingView,
  insureds: insuredsView,
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

window.addEventListener('resize', () => {
  clearTimeout(window.__phResize);
  window.__phResize = setTimeout(() => {
    if (state.user && ['dashboard', 'policy'].includes(state.route)) render();
  }, 250);
});
