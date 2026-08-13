/* =====================================================================
   Reports — print-ready documents rendered in the browser.

   These are laid out for paper (Letter, repeating table headers, no
   orphaned rows) and produced with the browser's own "Save as PDF".
   That keeps the fonts, charts and spacing identical to the screen and
   avoids running a headless browser on the server, which would not fit
   in a 512 MB instance.
   ===================================================================== */

import { lineChart, barChart, fmtMoney, fmtExact } from './charts.js';
import { fmtIrr } from './irr.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (v, dp = 2) =>
  v === null || v === undefined || v === '' ? '—' : fmtMoney(v, dp);

const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${m}/${day}/${y}`;
};

const longDate = (iso) =>
  new Date(iso || Date.now()).toLocaleDateString('en-US',
    { year: 'numeric', month: 'long', day: 'numeric' });

const monthLabel = (key) =>
  new Date(`${key}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

function ageFrom(dob) {
  if (!dob) return null;
  const b = new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a;
}

const pct = (part, whole) => (!whole ? '—' : `${((part / whole) * 100).toFixed(1)}%`);

const insuredOf = (p) =>
  p.display_name || `${p.insured_first || ''} ${p.insured_last || ''}`.trim() || '—';

/* ------------------------- shared furniture -------------------------- */

function letterhead(title, subtitle, asOf) {
  return `
  <header class="rpt-head">
    <div class="rpt-head-left">
      <div class="rpt-brand"><span class="brand-mark"></span>Poel Capital</div>
      <div class="rpt-brand-sub">Policy Portfolio</div>
    </div>
    <div class="rpt-head-right">
      <div class="rpt-title">${esc(title)}</div>
      <div class="rpt-meta">${esc(subtitle)}</div>
      <div class="rpt-meta">As of ${esc(asOf)}</div>
    </div>
  </header>`;
}

function footer(note) {
  return `<div class="rpt-footer">
    <span>Poel Capital · Southfield, MI</span>
    <span>${esc(note || '')}</span>
    <span>Generated ${longDate()}</span>
  </div>`;
}

const confidential = (showBasis) =>
  `<div class="rpt-confidential">Confidential${showBasis
    ? ' — contains cost basis and capital invested' : ''}. For the intended recipient only.</div>`;

/** Swap the @page rule so a wide schedule can print landscape. */
function setPageOrientation(landscape) {
  let tag = document.getElementById('printPageStyle');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'printPageStyle';
    document.head.appendChild(tag);
  }
  tag.textContent = landscape
    ? '@page { size: Letter landscape; margin: 0.45in; }'
    : '@page { size: Letter portrait; margin: 0.55in; }';
}

/* --------------------------- report specs ---------------------------- */

const REPORTS = {
  summary: {
    name: 'Portfolio summary',
    blurb: 'One-page overview of the book — totals, composition and concentration. The document you hand an investor or lender.',
    landscape: false,
  },
  schedule: {
    name: 'Policy schedule',
    blurb: 'Full inventory as a formatted table with column totals. Prints landscape.',
    landscape: true,
  },
  forecast: {
    name: 'Premium forecast',
    blurb: 'Projected premium payments by month with running capital requirement.',
    landscape: false,
  },
  factsheet: {
    name: 'Policy fact sheets',
    blurb: 'One page per policy — terms, lives insured, value history and premium schedule.',
    landscape: false,
  },
  'return-active': {
    name: 'Return — policies in force',
    blurb: 'IRR on every live policy as if it matured today, ranked, with owner-entity subtotals. The unrealized picture.',
    landscape: true,
  },
  'return-realized': {
    name: 'Return — realized',
    blurb: 'IRR on every matured policy from the cheque that actually arrived. What the book has actually returned.',
    landscape: true,
  },
};

/* ------------------------------ builders ----------------------------- */

function buildSummary(d, o) {
  const t = d.totals;
  const dbTotal = Number(t.total_death_benefit) || 0;
  const invested = Number(t.total_invested) || 0;

  const tile = (label, value, note) => `
    <div class="rpt-tile"><div class="rpt-tile-label">${label}</div>
      <div class="rpt-tile-value">${value}</div>
      ${note ? `<div class="rpt-tile-note">${note}</div>` : ''}</div>`;

  const compTable = (title, rows, keyField) => `
    <div class="rpt-block">
      <h3 class="rpt-h3">${title}</h3>
      <table class="rpt-table">
        <thead><tr><th>${title.replace('By ', '')}</th><th class="num">Policies</th>
          <th class="num">Death benefit</th><th class="num">% of book</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r[keyField] || 'Unassigned')}</td>
          <td class="num">${r.n}</td>
          <td class="num">${money(r.face)}</td>
          <td class="num">${pct(Number(r.face), dbTotal)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>
          <td class="num">${rows.reduce((s, r) => s + r.n, 0)}</td>
          <td class="num">${money(dbTotal)}</td><td class="num">100.0%</td></tr></tfoot>
      </table>
    </div>`;

  return `
    ${letterhead('Portfolio Summary', o.fund ? `Fund ${o.fund}` : 'All funds', o.asOf)}
    ${confidential(o.showBasis)}

    <div class="rpt-tiles" data-count="${o.showBasis ? 6 : 4}">
      ${tile('Policies in force', t.policy_count, `Average insured age ${Math.round(Number(d.ages.avg_age)) || '—'}`)}
      ${tile('Total death benefit', fmtExact(dbTotal), `Face at issue ${fmtExact(t.total_face)}`)}
      ${tile('Cash surrender value', fmtExact(t.total_csv), `Account value ${fmtExact(t.total_av)}`)}
      ${tile('Annual premium', fmtExact(t.annual_premium), `Cost of insurance ${fmtExact(t.monthly_coi)}/mo`)}
      ${o.showBasis ? tile('Capital invested', fmtExact(invested),
          `${fmtExact(t.total_acquisition)} acquisition · ${fmtExact(t.total_premiums)} premium`) : ''}
      ${o.showBasis ? tile('Benefit multiple', invested ? `${(dbTotal / invested).toFixed(2)}×` : '—',
          'Death benefit ÷ capital invested') : ''}
    </div>

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Death benefit by carrier</h3>
      <div id="rptCarrierChart"></div>
    </div>

    ${compTable('By carrier', d.byCarrier, 'carrier_name')}
    ${compTable('By product type', d.byProduct, 'product_type')}
    ${d.byFund.length > 1 ? compTable('By owner', d.byFund, 'fund_code') : ''}

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Notes</h3>
      <p class="rpt-note">
        Values are the most recent carrier-reported figures on file for each policy and may
        carry different as-of dates. Insured ages range from
        ${Math.round(Number(d.ages.min_age)) || '—'} to ${Math.round(Number(d.ages.max_age)) || '—'}.
        Policies marked lapsed, sold or matured are excluded.
        ${o.showBasis ? 'Capital invested is the sum of acquisition cost, premium payments, fees, servicing and commissions recorded in the ledger.' : ''}
      </p>
    </div>
    ${footer('Portfolio Summary')}`;
}

function buildSchedule(rows, o) {
  const tot = rows.reduce((a, p) => {
    a.face += Number(p.face_amount) || 0;
    a.db += Number(p.death_benefit ?? p.face_amount) || 0;
    a.prem += Number(p.premium_required) || 0;
    a.av += Number(p.account_value) || 0;
    a.csv += Number(p.cash_surrender_value) || 0;
    a.coi += Number(p.cost_of_insurance) || 0;
    a.inv += Number(p.total_invested) || 0;
    return a;
  }, { face: 0, db: 0, prem: 0, av: 0, csv: 0, coi: 0, inv: 0 });

  return `
    ${letterhead('Policy Schedule', `${rows.length} policies${o.fund ? ` · Fund ${o.fund}` : ''}`, o.asOf)}
    ${confidential(o.showBasis)}
    <table class="rpt-table rpt-table-tight">
      <thead><tr>
        <th>#</th><th>Last name</th><th>First name</th><th>DOB</th><th class="num">Age</th>
        <th>Carrier</th><th>Type</th><th>Policy no.</th><th>Issued</th>
        <th class="num">Death benefit</th><th>Owner</th>
        <th class="num">Premium</th><th>Mode</th><th>Next due</th>
        <th class="num">AV</th><th class="num">CSV</th><th class="num">COI</th>
        ${o.showBasis ? '<th class="num">Invested</th>' : ''}
        <th>Status</th>
      </tr></thead>
      <tbody>
        ${rows.map((p, i) => `<tr>
          <td class="muted">${i + 1}</td>
          <td class="strong">${esc(p.insured_last || '—')}</td>
          <td>${esc(p.insured_first || '')}</td>
          <td>${fmtDate(p.insured_dob)}</td>
          <td class="num">${ageFrom(p.insured_dob) ?? '—'}</td>
          <td>${esc(p.carrier_name)}</td>
          <td>${esc(p.product_type || '—')}</td>
          <td class="rpt-nowrap">${esc(p.policy_number)}</td>
          <td class="rpt-nowrap">${fmtDate(p.issue_date)}</td>
          <td class="num">${money(p.death_benefit ?? p.face_amount)}</td>
          <td>${esc(p.fund_code || '—')}</td>
          <td class="num">${money(p.premium_required)}</td>
          <td>${esc(p.premium_mode || '—')}</td>
          <td class="rpt-nowrap">${fmtDate(p.next_premium_due)}</td>
          <td class="num">${money(p.account_value)}</td>
          <td class="num">${money(p.cash_surrender_value)}</td>
          <td class="num">${money(p.cost_of_insurance)}</td>
          ${o.showBasis ? `<td class="num">${money(p.total_invested)}</td>` : ''}
          <td>${esc(p.status)}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="9">Totals — ${rows.length} policies</td>
        <td class="num">${money(tot.db)}</td><td></td>
        <td class="num">${money(tot.prem)}</td><td colspan="2"></td>
        <td class="num">${money(tot.av)}</td>
        <td class="num">${money(tot.csv)}</td>
        <td class="num">${money(tot.coi)}</td>
        ${o.showBasis ? `<td class="num">${money(tot.inv)}</td>` : ''}
        <td></td>
      </tr></tfoot>
    </table>
    ${footer('Policy Schedule')}`;
}

function buildForecast(d, o) {
  const active = d.schedule.filter((m) => m.total > 0);
  const peak = active.reduce((a, b) => (b.total > (a?.total || 0) ? b : a), null);
  const avg = active.length ? d.grandTotal / active.length : 0;
  const next12 = d.schedule.slice(0, 12).reduce((s, m) => s + m.total, 0);

  const tile = (label, value, note) => `
    <div class="rpt-tile"><div class="rpt-tile-label">${label}</div>
      <div class="rpt-tile-value">${value}</div>
      ${note ? `<div class="rpt-tile-note">${note}</div>` : ''}</div>`;

  return `
    ${letterhead('Premium Forecast', `Next ${d.months} months${o.fund ? ` · Fund ${o.fund}` : ''}`, o.asOf)}
    ${confidential(false)}

    <div class="rpt-tiles" data-count="4">
      ${tile('Next 12 months', fmtExact(next12), 'Capital required')}
      ${tile(`Full ${d.months}-month total`, fmtExact(d.grandTotal), `${d.policiesScheduled} policies scheduled`)}
      ${tile('Average active month', fmtExact(avg), `${active.length} months with payments due`)}
      ${tile('Peak month', peak ? fmtExact(peak.total) : '—', peak ? monthLabel(peak.month) : '')}
    </div>

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Monthly requirement</h3>
      <div id="rptForecastChart"></div>
    </div>

    <div class="rpt-block">
      <h3 class="rpt-h3">Schedule by month</h3>
      <table class="rpt-table">
        <thead><tr><th>Month</th><th class="num">Payments</th>
          <th class="num">Amount due</th><th class="num">Cumulative</th></tr></thead>
        <tbody>${d.schedule.map((m) => `<tr class="${m.total ? '' : 'rpt-dim'}">
          <td class="strong">${monthLabel(m.month)}</td>
          <td class="num">${m.payments.length || '—'}</td>
          <td class="num">${m.total ? money(m.total) : '—'}</td>
          <td class="num">${money(m.cumulative)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>
          <td class="num">${d.schedule.reduce((s, m) => s + m.payments.length, 0)}</td>
          <td class="num">${money(d.grandTotal)}</td><td></td></tr></tfoot>
      </table>
    </div>

    ${o.detail ? `<div class="rpt-block page-break-before">
      <h3 class="rpt-h3">Payment detail</h3>
      <table class="rpt-table rpt-table-tight">
        <thead><tr><th>Due</th><th>Last name</th><th>First name</th><th>Carrier</th>
          <th>Policy no.</th><th>Owner</th><th>Mode</th><th class="num">Amount</th></tr></thead>
        <tbody>${active.flatMap((m) => m.payments.map((pay) => `<tr>
          <td class="${pay.overdue ? 'rpt-overdue' : ''}">${fmtDate(pay.due_date)}${pay.overdue ? ' — past due' : ''}</td>
          <td class="strong">${esc(pay.insured.split(',')[0] || pay.insured)}</td>
          <td>${esc((pay.insured.split(',')[1] || '').trim())}</td>
          <td>${esc(pay.carrier_name)}</td>
          <td class="rpt-nowrap">${esc(pay.policy_number)}</td>
          <td>${esc(pay.fund_code || '—')}</td>
          <td>${esc(pay.mode || '—')}</td>
          <td class="num">${money(pay.amount)}</td>
        </tr>`)).join('')}</tbody>
      </table>
    </div>` : ''}

    ${d.noSchedule.length ? `<div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Not included — incomplete schedule</h3>
      <p class="rpt-note">These policies are in force but could not be projected. Their premiums
        are <strong>not</strong> in the totals above.</p>
      <table class="rpt-table">
        <thead><tr><th>Insured</th><th>Carrier</th><th>Policy no.</th><th>Reason</th></tr></thead>
        <tbody>${d.noSchedule.map((p) => `<tr>
          <td class="strong">${esc(p.insured)}</td><td>${esc(p.carrier_name)}</td>
          <td>${esc(p.policy_number)}</td><td>${esc(p.reason)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : ''}

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Basis of projection</h3>
      <p class="rpt-note">
        Each policy is projected forward from its next due date at its stated payment mode,
        holding the current premium amount constant. Actual cost of insurance on universal life
        policies rises with insured age, so later years are likely to understate the true
        requirement. A due date already past is shown in the current month and marked past due.
      </p>
    </div>
    ${footer('Premium Forecast')}`;
}

/* --------------------------- return reports -------------------------- */

/**
 * Return analysis, in force or realized. One builder for both, because the
 * two documents differ only in what the terminal cash flow is — an assumed
 * death benefit dated today, or the cheque that actually cleared.
 *
 * Rates are capital-weighted throughout: an entity's IRR is solved from the
 * combined flows of its policies, not averaged across them. The simple mean
 * is printed beside it precisely so the gap between the two is visible —
 * when a few small positions carry outsized rates, the mean flatters the
 * book and the weighted figure does not.
 */
function buildReturn(d, o, { realized }) {
  const p = d.portfolio;
  const rows = d.rows;
  const title = realized ? 'Realized Return' : 'Portfolio Return — In Force';

  const tile = (label, value, note) => `
    <div class="rpt-tile"><div class="rpt-tile-label">${label}</div>
      <div class="rpt-tile-value">${value}</div>
      ${note ? `<div class="rpt-tile-note">${note}</div>` : ''}</div>`;

  const flag = (r) => {
    if (r.irr === null) return '';
    const why = [];
    if (realized && !r.settled) why.push('claim outstanding, assumed collected today');
    if (r.short_period) why.push('held under 90 days');
    if (r.ambiguous) why.push('flows change direction more than once');
    return why.length ? ' *' : '';
  };
  const anyFlagged = rows.some((r) => flag(r));

  const settledCount = rows.filter((r) => r.settled).length;
  const cashReceived = rows.reduce((s, r) => s + (r.settled ? Number(r.proceeds_amount) || 0 : 0), 0);
  const assumed = Math.max(0, Number(p.returned) - cashReceived);
  const weightedNote = d.mean_irr === null ? ''
    : `Simple average of the ${d.rated_count} policy rates is ${fmtIrr(d.mean_irr)}`;

  const fundTable = d.byFund.length > 1 ? `
    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">By owner entity</h3>
      <table class="rpt-table">
        <thead><tr><th>Entity</th><th class="num">Policies</th>
          ${o.showBasis ? '<th class="num">Capital invested</th>' : ''}
          <th class="num">${realized ? 'Proceeds' : 'Death benefit'}</th>
          ${o.showBasis ? '<th class="num">Profit</th><th class="num">Multiple</th>' : ''}
          <th class="num">IRR</th></tr></thead>
        <tbody>${d.byFund.map((f) => `<tr>
          <td class="strong">${esc(f.fund_code)}</td>
          <td class="num">${f.n}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(f.invested)}</td>` : ''}
          <td class="num">${fmtExact(f.returned)}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(f.profit)}</td>
            <td class="num">${f.multiple ? `${f.multiple.toFixed(2)}×` : '—'}</td>` : ''}
          <td class="num strong">${fmtIrr(f.irr)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Whole book</td><td class="num">${rows.length}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(p.invested)}</td>` : ''}
          <td class="num">${fmtExact(p.returned)}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(p.profit)}</td>
            <td class="num">${p.multiple ? `${p.multiple.toFixed(2)}×` : '—'}</td>` : ''}
          <td class="num">${fmtIrr(p.irr)}</td></tr></tfoot>
      </table>
    </div>` : '';

  return `
    ${letterhead(title, `${rows.length} ${rows.length === 1 ? 'policy' : 'policies'}${o.fund ? ` · Fund ${o.fund}` : ''}`, o.asOf)}
    ${confidential(o.showBasis)}

    <div class="rpt-tiles" data-count="${o.showBasis ? 5 : 3}">
      ${tile(realized ? 'Realized IRR' : 'IRR if matured today', fmtIrr(p.irr), weightedNote)}
      ${tile(realized ? 'Proceeds' : 'Death benefit', fmtExact(p.returned),
        realized
          ? (assumed > 0
              ? `${fmtExact(cashReceived)} received · ${fmtExact(assumed)} assumed on ${rows.length - settledCount} unpaid`
              : `all ${rows.length} ${rows.length === 1 ? 'claim' : 'claims'} paid`)
          : 'Current carrier-reported benefit')}
      ${o.showBasis ? tile('Capital invested', fmtExact(p.invested),
        `First outlay ${fmtDate(p.first_flow)}`) : ''}
      ${o.showBasis ? tile('Profit', fmtExact(p.profit),
        p.multiple ? `${p.multiple.toFixed(2)}× capital` : '') : ''}
      ${tile('Cash-flow span', p.years ? `${p.years.toFixed(1)} yr` : '—',
        `${fmtDate(p.first_flow)} to ${fmtDate(p.last_flow)}`)}
    </div>

    ${rows.length ? `
    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">IRR by policy${rows.length > 12 ? ' — top 12' : ''}</h3>
      <div id="rptReturnChart"></div>
      <p class="rpt-note">
        ${rows.length > 12 ? `Showing the 12 highest of ${rows.length}; the full ranking is in the table below. ` : ''}
        Bars are drawn from zero — a negative return runs left of the line.
      </p>
    </div>` : ''}

    ${fundTable}

    <div class="rpt-block">
      <h3 class="rpt-h3">Policies, ranked by return</h3>
      <table class="rpt-table rpt-table-tight">
        <thead><tr>
          <th class="num">#</th><th>Insured</th><th>Policy no.</th><th>Carrier</th>
          <th>Type</th><th>Owner</th>
          ${realized ? '<th>Matured</th><th>Paid</th>' : ''}
          <th class="num">${realized ? 'Proceeds' : 'Death benefit'}</th>
          ${o.showBasis ? '<th class="num">Invested</th><th class="num">Profit</th><th class="num">Multiple</th>' : ''}
          <th class="num">Days</th><th class="num">IRR</th>
        </tr></thead>
        <tbody>${rows.length === 0
          ? `<tr><td colspan="14">No ${realized ? 'matured' : 'in-force'} policies to report.</td></tr>`
          : rows.map((r, i) => `<tr>
            <td class="num">${i + 1}</td>
            <td>${esc(insuredOf(r))}</td>
            <td>${esc(r.policy_number)}</td>
            <td>${esc(r.carrier_name)}</td>
            <td>${esc(r.product_type || '—')}</td>
            <td>${esc(r.fund_code || '—')}</td>
            ${realized ? `<td>${fmtDate(r.matured_on)}</td>
              <td>${r.settled ? fmtDate(r.proceeds_received_on) : 'awaiting'}</td>` : ''}
            <td class="num">${fmtExact(realized && r.settled ? r.proceeds_amount : r.death_benefit)}${
              realized && !r.settled ? '<span class="rpt-flag"> *</span>' : ''}</td>
            ${o.showBasis ? `<td class="num">${fmtExact(r.invested)}</td>
              <td class="num">${fmtExact(r.profit)}</td>
              <td class="num">${r.multiple ? `${r.multiple.toFixed(2)}×` : '—'}</td>` : ''}
            <td class="num">${r.days.toLocaleString('en-US')}</td>
            <td class="num strong">${fmtIrr(r.irr)}${flag(r)}</td>
          </tr>`).join('')}</tbody>
        ${rows.length ? `<tfoot><tr>
          <td colspan="${6 + (realized ? 2 : 0)}">Totals — ${rows.length} ${rows.length === 1 ? 'policy' : 'policies'}</td>
          <td class="num">${fmtExact(p.returned)}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(p.invested)}</td>
            <td class="num">${fmtExact(p.profit)}</td>
            <td class="num">${p.multiple ? `${p.multiple.toFixed(2)}×` : '—'}</td>` : ''}
          <td class="num">${p.days.toLocaleString('en-US')}</td>
          <td class="num">${fmtIrr(p.irr)}</td>
        </tr></tfoot>` : ''}
      </table>
    </div>

    ${d.excluded.length ? `
    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Not in this report</h3>
      <table class="rpt-table">
        <thead><tr><th>Status</th><th class="num">Policies</th>
          ${o.showBasis ? '<th class="num">Capital invested</th>' : ''}</tr></thead>
        <tbody>${d.excluded.map((e) => `<tr>
          <td>${esc(e.status)}</td><td class="num">${e.n}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(e.invested)}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table>
      <p class="rpt-note">
        Listed rather than dropped, so the table above is not mistaken for the whole book.
      </p>
    </div>` : ''}

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Basis of calculation</h3>
      <p class="rpt-note">
        IRR is solved on the actual date of every cash flow over a 365-day year — the
        same convention as Excel's XIRR, so these figures reconcile against a
        spreadsheet. Money out is acquisition cost, premium payments, fees, servicing
        and commissions as recorded in the ledger. Policy loans are excluded: a loan is
        repaid out of the death benefit, so treating it as income would count it twice.
      </p>
      <p class="rpt-note">
        ${realized
          ? 'The inflow is the cheque that was actually received, dated to the day it ' +
            'cleared rather than the date of death — carriers take weeks to pay and that ' +
            'delay is a real cost to the return. Where a claim is still outstanding, the ' +
            'death benefit is assumed collected today and the rate is marked.'
          : 'Each policy is valued as if the insured died today and the carrier paid the ' +
            'current death benefit immediately, with no further premiums. These are ' +
            'hypothetical returns on positions that have not been realized; the actual ' +
            'rate will differ by however long each policy remains in force and whatever ' +
            'premium is paid in the meantime.'}
      </p>
      <p class="rpt-note">
        Entity and portfolio rates are solved from combined cash flows, not averaged
        across policies — a large position contributes more to a rate than a small one.
        ${d.mean_irr !== null ? `The simple average of the individual rates is ${fmtIrr(d.mean_irr)},
        against a capital-weighted ${fmtIrr(p.irr)}.` : ''}
        ${anyFlagged ? `A * marks a figure that needs reading with care: ${realized ? 'a claim not yet paid, whose death benefit is shown and assumed collected today; ' : ''}a holding period under 90 days; or cash flows that change direction more than once, where more than one rate can satisfy the equation.` : ''}
        ${p.ambiguous ? ' The combined series changes direction more than once, which is normal for a book of many policies but means the portfolio rate is one of several mathematically valid roots.' : ''}
      </p>
    </div>
    ${footer(title)}`;
}

function buildFactSheets(sheets, o) {
  return sheets.map((p, idx) => {
    const values = [...(p.values || [])].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
    const recent = [...values].reverse().slice(0, 12);
    const coi = Number(p.cost_of_insurance) || 0;
    const av = Number(p.account_value) || 0;
    const runway = coi > 0 ? (av / coi).toFixed(1) : null;
    const lives = [
      { last: p.insured_last, first: p.insured_first, dob: p.insured_dob,
        le: p.le_months, dod: p.date_of_death, role: 'Primary' },
      ...(p.additionalInsureds || []).map((i) => ({
        last: i.last_name, first: i.first_name, dob: i.dob,
        le: i.le_months, dod: i.date_of_death, role: i.role })),
    ];
    const byType = {};
    for (const t of p.transactions || []) byType[t.txn_type] = (byType[t.txn_type] || 0) + Number(t.amount);

    return `
    <section class="rpt-sheet ${idx < sheets.length - 1 ? 'page-break-after' : ''}">
      ${letterhead('Policy Fact Sheet', `${esc(p.carrier_name)} · ${esc(p.policy_number)}`, o.asOf)}
      ${confidential(o.showBasis)}

      <h2 class="rpt-h2">${esc(insuredOf(p))}</h2>

      <div class="rpt-tiles" data-count="${o.showBasis ? 5 : 4}">
        <div class="rpt-tile"><div class="rpt-tile-label">Death benefit</div>
          <div class="rpt-tile-value">${fmtExact(p.death_benefit ?? p.face_amount)}</div>
          <div class="rpt-tile-note">Face at issue ${fmtExact(p.face_amount)}</div></div>
        <div class="rpt-tile"><div class="rpt-tile-label">Cash surrender value</div>
          <div class="rpt-tile-value">${fmtExact(p.cash_surrender_value)}</div>
          <div class="rpt-tile-note">AV ${fmtExact(p.account_value)}</div></div>
        <div class="rpt-tile"><div class="rpt-tile-label">Annual premium</div>
          <div class="rpt-tile-value">${fmtExact(p.premium_required)}</div>
          <div class="rpt-tile-note">${esc(p.premium_mode || '')}</div></div>
        <div class="rpt-tile"><div class="rpt-tile-label">Coverage runway</div>
          <div class="rpt-tile-value">${runway ? `${runway} mo` : '—'}</div>
          <div class="rpt-tile-note">Account value ÷ monthly COI</div></div>
        ${o.showBasis ? `<div class="rpt-tile"><div class="rpt-tile-label">Capital invested</div>
          <div class="rpt-tile-value">${fmtExact(p.total_invested)}</div>
          <div class="rpt-tile-note">${fmtExact(p.total_acquisition)} acquisition</div></div>` : ''}
      </div>

      <div class="rpt-cols">
        <div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Policy terms</h3>
          <table class="rpt-kv">
            <tr><td>Carrier</td><td>${esc(p.carrier_name)}</td></tr>
            <tr><td>Policy number</td><td>${esc(p.policy_number)}</td></tr>
            <tr><td>Product type</td><td>${esc(p.product_type || '—')}</td></tr>
            <tr><td>Plan name</td><td>${esc(p.plan_name || '—')}</td></tr>
            <tr><td>Issue date</td><td>${fmtDate(p.issue_date)}</td></tr>
            <tr><td>Issue age</td><td>${p.issue_age ?? '—'}</td></tr>
            <tr><td>Owner</td><td>${esc(p.fund_code || '—')}</td></tr>
            <tr><td>Status</td><td>${esc(p.status)}</td></tr>
          </table>
        </div>
        <div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Premium &amp; servicing</h3>
          <table class="rpt-kv">
            <tr><td>Premium required</td><td>${money(p.premium_required)}</td></tr>
            <tr><td>Mode</td><td>${esc(p.premium_mode || '—')}</td></tr>
            <tr><td>Next due</td><td>${fmtDate(p.next_premium_due)}</td></tr>
            <tr><td>Grace period</td><td>${p.grace_period_days || 61} days</td></tr>
            <tr><td>Last withdrawal</td><td>${fmtDate(p.date_of_last_withdrawal)}</td></tr>
            <tr><td>Values as of</td><td>${fmtDate(p.value_as_of)}</td></tr>
            ${o.showBasis ? `<tr><td>Acquired</td><td>${fmtDate(p.acquisition_date)}</td></tr>
            <tr><td>Acquisition cost</td><td>${money(p.acquisition_cost)}</td></tr>` : ''}
          </table>
        </div>
      </div>

      <div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Lives insured</h3>
        <table class="rpt-table">
          <thead><tr><th>Last name</th><th>First name</th><th>Role</th><th>Date of birth</th>
            <th class="num">Age</th><th class="num">LE (months)</th><th>Date of death</th></tr></thead>
          <tbody>${lives.map((l) => `<tr>
            <td class="strong">${esc(l.last || '—')}</td><td>${esc(l.first || '')}</td>
            <td>${esc(l.role)}</td><td>${fmtDate(l.dob)}</td>
            <td class="num">${ageFrom(l.dob) ?? '—'}</td>
            <td class="num">${l.le ?? '—'}</td>
            <td>${l.dod ? fmtDate(l.dod) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>

      ${values.length > 1 ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Account value &amp; cash surrender value</h3>
        <div id="rptSheetChart${p.id}"></div>
      </div>` : ''}

      ${recent.length ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Recent carrier values</h3>
        <table class="rpt-table">
          <thead><tr><th>As of</th><th class="num">Account value</th>
            <th class="num">Cash surrender</th><th class="num">Cost of insurance</th>
            <th class="num">Death benefit</th></tr></thead>
          <tbody>${recent.map((v) => `<tr>
            <td class="strong">${fmtDate(v.as_of_date)}</td>
            <td class="num">${money(v.account_value, 2)}</td>
            <td class="num">${money(v.cash_surrender_value, 2)}</td>
            <td class="num">${money(v.cost_of_insurance, 2)}</td>
            <td class="num">${money(v.death_benefit)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      ${o.showBasis && Object.keys(byType).length ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Capital deployed</h3>
        <table class="rpt-table">
          <thead><tr><th>Type</th><th class="num">Amount</th></tr></thead>
          <tbody>${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
            `<tr><td>${esc(k)}</td><td class="num">${money(v)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total invested</td><td class="num">${money(p.total_invested)}</td></tr></tfoot>
        </table>
      </div>` : ''}

      ${footer(`Fact Sheet · ${esc(p.policy_number)}`)}
    </section>`;
  }).join('');
}

/* ------------------------------- view -------------------------------- */

export async function reportsView(api, state) {
  const investorUser = state.user?.role === 'investor';
  const [funds, policies] = await Promise.all([
    // Owner entities are internal reference data; investors are denied them.
    investorUser ? Promise.resolve([])
      : state.funds.length ? Promise.resolve(state.funds) : api('/funds'),
    api('/policies'),
  ]);
  state.funds = funds;

  const r = state.report || (state.report = {
    type: 'summary', fund: '', showBasis: true, months: 24, detail: true, policyIds: [],
  });

  const html = `
    <div class="page-head no-print">
      <div><h1>${investorUser ? 'Statements' : 'Reports'}</h1>
        <div class="sub">Print-ready documents. Generate, review, then save as PDF.${
          investorUser ? ' Figures reflect your ownership percentage.' : ''}</div></div>
    </div>

    <div class="card no-print">
      <div class="card-body">
        <div class="field">
          <label>Report</label>
          <div class="rpt-picker">
            ${Object.entries(REPORTS).map(([k, v]) => `
              <label class="rpt-choice ${r.type === k ? 'selected' : ''}">
                <input type="radio" name="rptType" value="${k}" ${r.type === k ? 'checked' : ''}>
                <span class="rpt-choice-name">${v.name}</span>
                <span class="rpt-choice-blurb">${v.blurb}</span>
              </label>`).join('')}
          </div>
        </div>

        <div class="field-row">
          <div class="field"><label>As-of date</label>
            <input type="date" id="rptAsOf" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="field" style="${investorUser ? 'display:none' : ''}"><label>Owner / fund</label>
            <select id="rptFund"><option value="">All owners</option>
              ${funds.map((f) => `<option ${r.fund === f.code ? 'selected' : ''}>${esc(f.code)}</option>`).join('')}
            </select></div>
          <div class="field" id="rptMonthsField" style="${r.type === 'forecast' ? '' : 'display:none'}">
            <label>Horizon</label>
            <select id="rptMonths">
              ${[12, 24, 36, 60].map((m) => `<option value="${m}" ${r.months === m ? 'selected' : ''}>${m} months</option>`).join('')}
            </select></div>
        </div>

        <div class="field" id="rptPolicyField" style="${r.type === 'factsheet' ? '' : 'display:none'}">
          <label>Policies to include</label>
          <select id="rptPolicies" multiple size="7">
            ${policies.map((p) => `<option value="${p.id}">${esc(p.insured_last || '')}${p.insured_first ? `, ${esc(p.insured_first)}` : ''} — ${esc(p.carrier_name)} ${esc(p.policy_number)}</option>`).join('')}
          </select>
          <span class="muted" style="font-size:12px">Nothing selected prints all ${policies.length}. Hold ⌘ or Ctrl to pick several.</span>
        </div>

        <div class="field-row" style="align-items:center">
          <label class="rpt-toggle">
            <input type="checkbox" id="rptBasis" ${r.showBasis ? 'checked' : ''}>
            <span>Include cost basis — acquisition cost, capital invested, benefit multiple</span>
          </label>
          <label class="rpt-toggle" id="rptDetailField" style="${r.type === 'forecast' ? '' : 'display:none'}">
            <input type="checkbox" id="rptDetail" ${r.detail ? 'checked' : ''}>
            <span>Include payment-level detail</span>
          </label>
        </div>

        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="primary" id="rptGenerate">Generate report</button>
          <button id="rptPrint" disabled>Save as PDF</button>
        </div>
      </div>
    </div>

    <div class="rpt-hint no-print" id="rptHint" style="display:none">
      In the print dialog choose <strong>Save as PDF</strong> as the destination. For the cleanest
      result set Margins to <strong>Default</strong> and turn <strong>off</strong> "Headers and
      footers"; tick <strong>Background graphics</strong> so rules and shading come through.
    </div>

    <div id="rptOutput" class="rpt-output"></div>`;

  return {
    html,
    after: () => {
      const sync = () => {
        r.type = document.querySelector('input[name=rptType]:checked').value;
        $('#rptMonthsField').style.display = r.type === 'forecast' ? '' : 'none';
        $('#rptDetailField').style.display = r.type === 'forecast' ? '' : 'none';
        $('#rptPolicyField').style.display = r.type === 'factsheet' ? '' : 'none';
        document.querySelectorAll('.rpt-choice').forEach((el) =>
          el.classList.toggle('selected', el.querySelector('input').checked));
      };
      document.querySelectorAll('input[name=rptType]').forEach((el) =>
        el.addEventListener('change', sync));

      $('#rptGenerate').addEventListener('click', async () => {
        const btn = $('#rptGenerate');
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> Building…';
        const out = $('#rptOutput');

        const o = {
          asOf: longDate($('#rptAsOf').value),
          fund: $('#rptFund').value,
          showBasis: $('#rptBasis').checked,
          detail: $('#rptDetail').checked,
        };
        r.fund = o.fund; r.showBasis = o.showBasis; r.detail = o.detail;
        r.months = parseInt($('#rptMonths').value, 10) || 24;

        try {
          setPageOrientation(REPORTS[r.type].landscape);
          let charts = () => {};

          if (r.type === 'summary') {
            const d = await api(`/reports/portfolio?fund=${encodeURIComponent(o.fund)}`);
            out.innerHTML = `<div class="rpt-sheet">${buildSummary(d, o)}</div>`;
            charts = () => barChart($('#rptCarrierChart'), {
              rows: d.byCarrier.slice(0, 10).map((c) => ({
                label: c.carrier_name || 'Unassigned', value: Number(c.face),
                note: `${c.n} ${c.n === 1 ? 'policy' : 'policies'}`, seriesName: 'Death benefit' })),
            });

          } else if (r.type === 'schedule') {
            const rows = await api(`/policies?fund=${encodeURIComponent(o.fund)}&status=`);
            out.innerHTML = `<div class="rpt-sheet">${buildSchedule(rows, o)}</div>`;

          } else if (r.type === 'forecast') {
            const d = await api(`/reports/premium-forecast?months=${r.months}&fund=${encodeURIComponent(o.fund)}`);
            out.innerHTML = `<div class="rpt-sheet">${buildForecast(d, o)}</div>`;
            charts = () => barChart($('#rptForecastChart'), {
              rows: d.schedule.filter((m) => m.total > 0).slice(0, 24).map((m) => ({
                label: monthLabel(m.month), value: m.total,
                note: `${m.payments.length} payment${m.payments.length === 1 ? '' : 's'}`,
                seriesName: 'Premium due' })),
            });

          } else if (r.type === 'return-active' || r.type === 'return-realized') {
            const realized = r.type === 'return-realized';
            const d = await api(`/reports/returns?basis=${realized ? 'realized' : 'active'}`
              + `&fund=${encodeURIComponent(o.fund)}`);
            out.innerHTML = `<div class="rpt-sheet">${buildReturn(d, o, { realized })}</div>`;
            charts = () => {
              const el = $('#rptReturnChart');
              if (!el || !d.rows.length) return;
              barChart(el, {
                // Rates, not amounts: the axis is anchored at zero so a loss
                // reads as a loss rather than as an equally long win.
                signed: true,
                rows: d.rows.filter((x) => x.irr !== null).slice(0, 12).map((x) => ({
                  label: insuredOf(x), value: x.irr * 100,
                  note: `${x.policy_number} · ${x.days.toLocaleString('en-US')} days`,
                  seriesName: 'IRR' })),
                valueFmt: (v) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}%`,
              });
            };

          } else {
            const picked = [...$('#rptPolicies').selectedOptions].map((op) => Number(op.value));
            const ids = picked.length ? picked : policies.map((p) => p.id);
            const sheets = [];
            for (const id of ids) sheets.push(await api(`/policies/${id}`));
            out.innerHTML = buildFactSheets(sheets, o);
            charts = () => sheets.forEach((p) => {
              const el = $(`#rptSheetChart${p.id}`);
              if (!el) return;
              const pts = [...p.values].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
                .map((v) => ({ x: v.as_of_date,
                  values: { av: v.account_value, csv: v.cash_surrender_value } }));
              lineChart(el, { points: pts, height: 180,
                series: [{ key: 'av', name: 'Account value' }, { key: 'csv', name: 'Cash surrender value' }],
                valueFmt: (v) => fmtMoney(v, 2) });
            });
          }

          charts();
          $('#rptPrint').disabled = false;
          $('#rptHint').style.display = '';
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
          out.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        } finally {
          btn.disabled = false;
          btn.textContent = 'Generate report';
        }
      });

      $('#rptPrint').addEventListener('click', () => window.print());
    },
  };
}
