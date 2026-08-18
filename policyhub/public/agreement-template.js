/* =====================================================================
   The operating agreement, as a template.

   One file, read by both sides. The browser renders it to the screen so
   a manager can see exactly what is about to be issued, and the server
   renders the same blocks to PDF and hashes them so that what an
   investor signed can be proved later. If the two ever drew from
   separate copies, a signature would attest to a document nobody could
   reproduce.

   The clauses are fixed: they are the ones the company's counsel wrote,
   and this file is the only place they exist. What varies is filled in
   from `terms` — the company, the policy, the money, the people. A term
   left blank is printed as a blank line rather than silently omitted,
   because a missing clause reads as deliberate and an obvious gap does
   not.
   ===================================================================== */

/** The blanks, in the order they are asked for. */
export const AGREEMENT_FIELDS = [
  { key: 'llc_name', label: 'Full name of the LLC', required: true,
    placeholder: 'e.g. 26 LIFE HOLDINGS 4 LLC' },
  { key: 'state', label: 'State of formation', type: 'state', default: 'Delaware' },
  { key: 'effective_date', label: 'Effective date', type: 'date', required: true },
  { key: 'principal_office', label: 'Principal office', type: 'text',
    placeholder: 'Street, city, state ZIP' },

  { key: 'insured_name', label: 'Insured', section: 'policy',
    placeholder: 'The person insured under the policy' },
  { key: 'policy_product', label: 'Product', section: 'policy',
    placeholder: 'e.g. Indexed Universal Life' },
  { key: 'policy_number', label: 'Policy number', section: 'policy' },

  { key: 'manager_name', label: 'Manager / General Partner', section: 'terms', required: true },
  { key: 'majority_pct', label: 'Majority in Interest', type: 'pct', section: 'terms', default: 75 },
  { key: 'pref_return_pct', label: 'Preferred return (IRR)', type: 'pct', section: 'terms', default: 15 },
  { key: 'member_split_pct', label: 'Members’ share of the excess', type: 'pct', section: 'terms', default: 75 },
  { key: 'call_notice_max_days', label: 'Capital call — most notice', type: 'int', section: 'terms', default: 60 },
  { key: 'call_notice_min_days', label: 'Capital call — least notice', type: 'int', section: 'terms', default: 20 },
  { key: 'premium_frequency', label: 'Premiums collected', section: 'terms', default: 'quarterly' },
  { key: 'default_option_days', label: 'Default option — business days to exercise',
    type: 'int', section: 'terms', default: 5 },
  { key: 'rofr_days', label: 'Right of first refusal — response period (days)',
    type: 'int', section: 'terms', default: 15 },
  { key: 'arbitration_venue', label: 'Arbitration venue', section: 'terms',
    default: 'New York or California' },

  { key: 'bank_account_name', label: 'Account name', section: 'wire' },
  { key: 'bank_name', label: 'Bank', section: 'wire' },
  { key: 'bank_address', label: 'Bank address', section: 'wire' },
  { key: 'account_number', label: 'Account number', section: 'wire' },
  { key: 'wire_routing', label: 'Domestic wire routing number', section: 'wire' },
  { key: 'ach_routing', label: 'ACH / direct deposit routing', section: 'wire' },
  { key: 'swift', label: 'SWIFT code', section: 'wire' },
  { key: 'wire_memo', label: 'Memo / reference', section: 'wire',
    placeholder: 'e.g. 26LH4 Initial Capital' },
];

export const FIELD_SECTIONS = [
  ['', 'The company'],
  ['policy', 'The policy it holds'],
  ['terms', 'Economics and governance'],
  ['wire', 'Wire instructions'],
];

/* ------------------------------------------------------------------ *
 * formatting
 * ------------------------------------------------------------------ */

const blank = '________________';
const t = (terms, key) => {
  const v = terms?.[key];
  return v === null || v === undefined || String(v).trim() === '' ? '' : String(v).trim();
};
const or = (terms, key) => t(terms, key) || blank;

const money = (n) => (n === null || n === undefined || n === ''
  ? blank
  : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const pct = (n) => (n === null || n === undefined || n === ''
  ? blank
  : `${Number(n).toFixed(Number(n) % 1 ? 4 : 0)}%`);

/** "7/26/2026", the way the original is written. */
const usDate = (d) => {
  if (!d) return blank;
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  if (!y || !m || !day) return String(d);
  return `${Number(m)}/${Number(day)}/${y}`;
};

const NUMBER_WORDS = {
  5: 'five', 15: 'fifteen', 20: 'twenty', 30: 'thirty', 45: 'forty-five',
  60: 'sixty', 75: 'seventy-five', 90: 'ninety',
};
/** "sixty (60)" — the way a contract states a number it means literally. */
const spelled = (n) => {
  if (n === null || n === undefined || n === '') return blank;
  const word = NUMBER_WORDS[Number(n)];
  return word ? `${word} (${n})` : String(n);
};

/** What the LLC was formed to hold, in one phrase. */
function policyPhrase(terms) {
  const who = t(terms, 'insured_name');
  const product = t(terms, 'policy_product');
  const number = t(terms, 'policy_number');
  const parts = [who, product, 'insurance policy'].filter(Boolean).join(' ');
  return `${parts || 'life insurance policy'}${number ? ` number ${number}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * the document
 * ------------------------------------------------------------------ */

/**
 * Render the agreement to a list of blocks.
 *
 * A block is deliberately dumb — a type and some text — so that adding a
 * renderer never means touching the clauses.
 *
 *   title | subtitle | heading | para | bullet | spacer
 *   table   { columns, rows }
 *   signature { caption, signed }
 */
export function renderAgreement(terms = {}, signers = []) {
  const b = [];
  const para = (text) => b.push({ type: 'para', text });
  const head = (text) => b.push({ type: 'heading', text });
  const bullet = (text) => b.push({ type: 'bullet', text });

  const name = or(terms, 'llc_name');
  const state = t(terms, 'state') || 'Delaware';
  const manager = or(terms, 'manager_name');
  const majority = pct(terms.majority_pct ?? 75);
  const pref = pct(terms.pref_return_pct ?? 15);
  const memberSplit = Number(terms.member_split_pct ?? 75);
  const managerSplit = 100 - memberSplit;

  const members = signers.filter((s) => s.role !== 'Manager');

  b.push({ type: 'title', text: 'OPERATING AGREEMENT' });
  b.push({ type: 'subtitle', text: 'OF' });
  b.push({ type: 'title', text: name });
  b.push({ type: 'subtitle', text: `A ${state} Limited Liability Company` });
  b.push({ type: 'spacer', size: 16 });

  para(`This Operating Agreement (this "Agreement") is entered into as of ${
    usDate(terms.effective_date)}, by and among the parties listed in Addendum A attached hereto `
    + 'and made a part hereof (each a "Member" and collectively the "Members").');

  head('Recitals');
  para(`The purpose of this Agreement is to set forth certain provisions relating to the governance `
    + `of the affairs of ${name} (the "LLC" or the "Company") and the rights and responsibilities `
    + "of the LLC's Members.");
  para('The LLC has not engaged in any other transactions or business activities prior to the date '
    + 'of this Agreement.');

  head('Terms and Conditions');
  b.push({ type: 'subhead', text: 'Name' });
  para(`The full name of the LLC is ${name}.`);

  b.push({ type: 'subhead', text: 'Formation' });
  para(`A Certificate of Formation was filed (or will be filed) with the Secretary of State of the `
    + `State of ${state}. The Members shall comply with the requirements of the ${state} Limited `
    + 'Liability Company Act (the "Law").');

  b.push({ type: 'subhead', text: 'Principal Office' });
  para(`The LLC's principal office shall be located at ${or(terms, 'principal_office')}, or such `
    + 'other place as the Manager designates.');

  b.push({ type: 'subhead', text: 'Purpose' });
  para(`The principal purpose of the LLC is to purchase, hold, and manage the ${policyPhrase(terms)} `
    + '(the "Policy"), and to engage in any related or incidental activities as determined by the '
    + 'Manager.');

  b.push({ type: 'subhead', text: 'Term' });
  para('The term of the LLC shall commence on the Effective Date and shall continue until the LLC '
    + 'is dissolved in accordance with this Agreement or the Law.');

  head('Capital');
  b.push({ type: 'subhead', text: 'Initial Contribution' });
  para("Each Member's initial contribution to the LLC's capital shall be as set forth in Schedule 1 "
    + 'and shall be used for the purchase of the Policy and related costs (including initial premium '
    + 'payments).');

  b.push({ type: 'subhead', text: 'Capital Calls' });
  para('The Members shall contribute such additional capital as the Manager shall, in good faith, '
    + "determine to be required from time to time to accomplish the LLC's purposes, including for "
    + 'the payment of Policy premiums, third-party fees, and Company operating expenses. Premium '
    + 'capital calls shall be issued by the Manager with such advance notice as the Manager '
    + 'determines in his reasonable discretion; provided, however, that any Capital Call Notice '
    + `shall be given no more than ${spelled(terms.call_notice_max_days ?? 60)} days and no less `
    + `than ${spelled(terms.call_notice_min_days ?? 20)} days prior to the due date of the `
    + "applicable premium or other obligation. The contributed funds shall be held in an attorney's "
    + 'escrow account or the LLC account until the premium payment is due.');
  para(`The Members agree that the LLC will generally collect and pay premiums on a ${
    t(terms, 'premium_frequency') || 'quarterly'} basis (or per the carrier's schedule), but the `
    + 'Manager retains discretion to adjust the frequency or amount of capital calls as '
    + 'circumstances require. Unless otherwise determined by the Manager or by a Majority in '
    + 'Interest of the Members, the LLC shall pay ongoing premiums on the Policy until maturity. '
    + `"Majority in Interest" shall be defined as ${majority} of the Membership Interests.`);
  para('The Manager will, from time to time, notify the Members of the need for a capital '
    + 'contribution(s), which may be for one or more upcoming contributions ("Capital Call Notice"). '
    + 'The Manager shall indicate the amount and date for such required contributions and shall '
    + 'provide all Members the notice period described above. Each Member will be obligated to '
    + 'contribute, by the due date in the Capital Call Notice, in proportion to his Membership '
    + 'Interest ("Member Share"). Each Member\'s (whether a current or past Member) total '
    + 'contributions shall be referred to as a "Member\'s Total Contribution". The total of all '
    + 'Members\' Total Contributions shall be referred to as the "Aggregate Member Contributions".');

  b.push({ type: 'subhead', text: 'Member Failure to Contribute' });
  para('The Members acknowledge their unanimous intention to keep the Policy in force with minimal '
    + 'disruption, and further acknowledge that to do so requires that each Member makes its '
    + 'required capital contributions promptly. The Manager will use best commercial efforts not to '
    + 'let the Policy lapse. In case of default by a Member, the Manager will work to replace the '
    + 'Member to its best efforts. If the Manager fails and no Member agrees to take that position, '
    + 'the Manager will work on finding a buyer to sell the Policy.');
  para('Therefore, the Members agree that if a Member fails to pay its full Member Share by the date '
    + 'specified by the Manager in the Capital Call Notice (a "Defaulting Member"), such Defaulting '
    + 'Member shall lose its Membership Interest including all rights and benefits related to such '
    + 'Membership Interest. Said default does not relieve the Defaulting Member of its obligations '
    + 'and liabilities as a Member, provided that if a Non-Defaulting Member(s) exercises the '
    + 'Default Option, then the Defaulting Member shall have no further obligation (or right) to '
    + 'make a further contribution. References to the term "Member" in this Agreement (including but '
    + 'not limited to distribution provisions) shall refer to Non-Defaulting Members only, unless '
    + 'otherwise stated or implied by context.');

  b.push({ type: 'subhead', text: 'Notice to Members / Default Option' });
  para('In the event of a default as set forth above, the Manager shall give all Non-Defaulting '
    + 'Members written Notice of said default ("Default Notice"). Any Member that has not defaulted '
    + '(the "Non-Defaulting Members") shall have an option (the "Default Option") to pay its Pro '
    + 'Rata Share of the amount not paid by the Defaulting Member. The term "Pro Rata Share" shall '
    + "mean a percentage determined by the ratio of such Non-Defaulting Member's then existing "
    + 'Membership Interest to the total Membership Interest of all Non-Defaulting Members.');
  para('Each Non-Defaulting Member may exercise the Default Option by doing both of the following '
    + `within ${spelled(terms.default_option_days ?? 5)} business days following receipt of the `
    + 'Default Notice: (i) sending written notice of its election (the "Exercise Notice") to the '
    + 'Members and to the Manager; and (ii) tendering payment to the Manager equal to its Pro Rata '
    + 'Share of the amount of the contribution left unpaid by the Defaulting Member. If any '
    + "Non-Defaulting Member exercises the Default Option, the Members' respective Membership "
    + "Interests shall be recomputed so that each Member's Membership Interest in the Company equals "
    + "a fraction, the numerator of which is that Member's Total Contribution and the denominator of "
    + 'which is the Aggregate Member Contributions.');
  para('If a Non-Defaulting Member does not exercise its Default Option, the Manager shall give '
    + 'notice of this fact to the other Non-Defaulting Members and each will have the option to '
    + 'purchase its Pro Rata Share of the remaining portion of the Membership Interest, which option '
    + 'will be exercised pursuant to the procedures described above. The Manager shall record such '
    + "change of the Members' Membership Interests in the Company's books and records. If the "
    + 'Non-Defaulting Members do not fully exercise the Default Option, then the Defaulting Member '
    + 'shall remain responsible and liable for all Member obligations - including making '
    + 'contributions to the extent the Default Option was not exercised. Notwithstanding the '
    + 'procedures set forth above, the Manager may, in his reasonable discretion, modify such notice '
    + 'and other procedures in order to achieve the intent of this Section.');

  b.push({ type: 'subhead', text: 'Capital Accounts' });
  para('An individual and separate capital account shall be maintained for each Member in the '
    + "Company's books of account on a Federal income tax accounting basis. Each Member's "
    + 'proportionate share of the net profits or net losses of the Company, and of the '
    + 'distributions, contributions and such other transactions which under proper tax accounting '
    + "principles should be reflected in each Member's capital account, shall be so reflected. In "
    + 'the event of a permitted sale, exchange or transfer of a Membership Interest, the capital '
    + 'account of the transferor shall become the capital account of the transferee to the extent '
    + 'that it relates to the transferred Membership Interest in accordance with the U.S. Treasury '
    + 'Regulations promulgated under the Internal Revenue Code (the "Code"). The LLC shall not pay '
    + "interest on the Members' capital contributions and no Member shall, except as otherwise "
    + 'provided herein, have the right to withdraw, or demand a refund or return of, any part of his '
    + 'or her capital contributions.');

  head('Fiscal Year; Membership Interests; Profits and Losses; Distributions');
  para('The fiscal year of the LLC shall be the calendar year. The Membership Interests are as set '
    + 'forth in Schedule 1.');
  para('Except as set forth under "Distribution on Sale or Upon Receipt of Death Benefit" below, net '
    + 'profits and net losses of the LLC shall be allocated to the Members in accordance with their '
    + 'Membership Interests.');

  b.push({ type: 'subhead', text: 'Net Cash Flow' });
  para('The LLC shall distribute its Net Cash Flow, if any, pursuant to the distribution provisions '
    + 'of this Agreement. The term "Net Cash Flow" shall mean the net profits or losses of the LLC, '
    + 'less such reserves as the Manager reasonably determines to be appropriate for present and/or '
    + 'future operations and contingencies. Any Net Cash Flow distributed to the Members shall be '
    + 'allocated in the manner described in this Agreement.');

  b.push({ type: 'subhead', text: 'Distribution on Sale or Upon Receipt of Death Benefit' });
  para('Upon collection of the proceeds of the Policy ("Income") through a sale of the Policy or '
    + 'receipt of insurance proceeds upon the death of the insured, and provided the LLC has no '
    + 'other substantial assets, the LLC shall be dissolved and its assets liquidated in the '
    + 'following order of priority:');
  b.push({ type: 'numbered', text: 'To creditors of the Company and to pay all necessary liquidation '
    + 'expenses, if applicable;', n: 1 });
  b.push({ type: 'numbered', text: 'To the Members, pro-rata in proportion to their Membership '
    + 'Interests, return of their Total Contributions (return of capital);', n: 2 });
  b.push({ type: 'numbered', n: 3,
    text: 'To the Members, pro-rata in proportion to their Membership Interests, an amount '
      + `sufficient to provide the Members with a ${pref} internal rate of return (IRR) on their `
      + 'Total Contributions, calculated from the date of each capital contribution to the date of '
      + 'distribution (using standard XIRR methodology).' });
  para('For the avoidance of doubt:');
  bullet(`If the overall return on the investment is less than or equal to ${pref} IRR, then 100% of `
    + 'all remaining proceeds after return of capital shall be distributed to the Members. The '
    + 'Manager / General Partner shall receive no carried interest in that case.');
  bullet(`Only if the overall return exceeds ${pref} IRR shall any excess above the ${pref} IRR be `
    + 'split.');
  b.push({ type: 'numbered', n: 4,
    text: `Any remaining Profit after the Members have received their full ${pref} IRR shall be `
      + `distributed ${pct(memberSplit)} to the Members (pro-rata) and ${pct(managerSplit)} to the `
      + `Manager / General Partner (${manager}) as carried interest.` });

  b.push({ type: 'subhead', text: 'Simple Summary of How It Works' });
  b.push({ type: 'table',
    columns: ['Overall Deal IRR', 'What Investors Get', 'What the Manager Gets'],
    widths: [110, 220, 130],
    rows: [
      [pct(Math.max(0, Number(terms.pref_return_pct ?? 15) - 3)), '100% of everything', '$0'],
      [pref, '100% of everything', '$0'],
      [pct(Number(terms.pref_return_pct ?? 15) + 5),
        `Their ${pref} IRR + ${pct(memberSplit)} of the excess`,
        `${pct(managerSplit)} of the excess`],
    ] });

  head('Management');
  para(`The LLC shall be managed by ${manager}, who shall serve throughout the term of the existence `
    + 'of the Company as Manager / General Partner, unless he resigns or is removed in accordance '
    + 'with the terms hereof or as required under the Law, in which event a successor Manager shall '
    + 'be elected by a Majority in Interest of all of the Members.');
  para('Except to the extent otherwise provided in this Agreement or required by the non-waivable '
    + 'provisions of the Law, the Manager shall have the full and exclusive right, power, authority, '
    + 'discretion and responsibility to manage, control, administer, direct and operate the '
    + 'day-to-day operations of the Company and to make all decisions and to take all actions for '
    + 'and on behalf of the Company necessary, convenient, desirable, appropriate or incidental in '
    + 'or to the furtherance of the purposes, business and objectives of the Company.');
  para('Notwithstanding anything to the contrary in this Agreement, without the consent of a '
    + 'Majority in Interest of the Members, the Manager shall not have the right, power or authority '
    + 'to:');
  bullet('Take any action to sell, encumber or refinance the Company property or transfer or '
    + 'encumber all or substantially all of the assets of the Company or take any action that would '
    + 'diminish the value of any Company property;');
  bullet('Exercise an option to decrease the death benefit of the Policy or to exercise the paid-up '
    + 'option in the Policy;');
  bullet('Cause or permit the Company to engage in any activity or to take any action prohibited by '
    + 'law or that violates or is contrary to the purposes of the Company or the provisions of this '
    + 'Agreement;');
  bullet('Take any action which requires the consent or approval of the Members, either under this '
    + 'Agreement or under the non-waivable provisions of the Law, without such consent or approval;');
  bullet('Take any action which would cause the termination of the Company for federal income tax '
    + 'purposes or the dissolution of the Company under the Law or this Agreement or cause the '
    + 'Company to be classified as an "association" taxable as a corporation under the Code;');
  bullet('Take or permit any action that would cause any Member to be personally liable for any '
    + 'debt, liability or obligation of the Company or of any other Member, without the prior '
    + 'consent of such Member;');
  bullet('Change or reorganize the Company into any other legal form;');
  bullet('Initiate any lawsuit or other judicial proceeding or arbitration in the name or on behalf '
    + 'of the Company, except in the ordinary course of business of the Company;');
  bullet('Admit any additional Members to the Company without Majority in Interest consent.');

  head('Books and Records; Taxation');
  para(`${manager} (or his designee) shall be the tax matters partner / partnership representative. `
    + 'The Manager will outsource to third parties for medical, premium administration, and '
    + 'valuation services as needed.');
  para('Proper books of account shall be kept and shall be available for inspection by any of the '
    + 'Members, or their representatives, at reasonable times and on reasonable notice.');
  para('Within a reasonable time after the end of each calendar year, the LLC shall furnish to each '
    + "Member such information as may be required for the purpose of preparing the Member's income "
    + 'tax return for that year (including Schedule K-1).');

  head('Dissolution');
  para('The LLC may be dissolved by act of the Majority in Interest of the Members.');
  para('Notwithstanding any dissolution of the LLC, this Agreement shall continue in effect during '
    + "the winding up of the LLC's business and affairs.");
  para('Unless the Company is dissolved in connection with a sale of the Policy or receipt of the '
    + 'death benefit proceeds as described in the "Distribution on Sale or Upon Receipt of Death '
    + 'Benefit" section, the net cash proceeds resulting from the liquidation of the assets of the '
    + 'LLC following dissolution shall be distributed in accordance with the waterfall set forth in '
    + `that section (creditors → return of capital → ${pref} preferred return → `
    + `${pct(memberSplit)}/${pct(managerSplit)} carried interest split).`);

  head("Manager's and Members' Liability");
  para('Notwithstanding anything to the contrary stated herein, no Manager or Member shall be '
    + 'liable, responsible or accountable in damages or otherwise to any other Member for any errors '
    + 'in judgment, for any act performed by such person or entity, or for any omission or failure '
    + 'to act, if the performance of such act or such omission or failure is done in good faith, is '
    + 'within the scope of the authority conferred upon such person or entity by this Agreement or '
    + 'by law, and does not constitute a breach of fiduciary duty or willful misconduct. The Members '
    + "intend by this clause to eliminate the Manager's and Members' liability for negligence to the "
    + 'fullest extent permitted by law.');
  para('The LLC shall indemnify and hold harmless the Manager and each Member and their agents from '
    + 'and against all costs, losses, liabilities and damages, including reasonable '
    + "attorney's fees, paid or accrued by them or their agents in connection with the LLC's "
    + 'business, to the fullest extent provided or allowed by applicable law.');

  head('Transfers of Membership Interests; Right of First Refusal');
  para('In the event a Member (a "Selling Member") decides to sell its Membership Interest or any '
    + 'part thereof, the Selling Member shall first offer in writing (the "Selling Notice") such '
    + 'Membership Interest to the Company. The Selling Notice shall set forth the price, terms and '
    + `closing date under which the Selling Member is willing to sell. The Company shall have a `
    + `period of ${spelled(terms.rofr_days ?? 15)} calendar days from the date of receipt of the `
    + 'Selling Notice (the "Response Period") to notify the Selling Member that it is electing to '
    + 'purchase such Membership Interest in accordance with the terms set forth in the Selling '
    + 'Notice. If the Company does not so notify the Selling Member, the Selling Member shall have '
    + 'the right to sell the Membership Interest to a third party on the same price and materially '
    + 'the same terms; provided that the Company shall have the right to approve or disapprove such '
    + 'sale on the basis that the proposed substitute Member does not possess the ability to comply '
    + 'with all of the obligations of a Member under this Agreement. The Company may not '
    + 'unreasonably withhold such approval.');

  head('Notices');
  para('Any notice or other communication to be given to any party under this Agreement shall be in '
    + 'writing and shall be sent for overnight delivery by Federal Express or other similar '
    + 'overnight delivery service, or by email, to the addresses set forth in Addendum A (or as '
    + 'updated by written notice).');
  para('Notice shall be deemed given the first business day after it is delivered into the custody '
    + 'of the delivery service or, if by email, upon confirmed receipt.');

  head('Arbitration');
  para('ALL PARTIES AGREE THAT IN THE EVENT OF A DISPUTE THEY SHALL FIRST ATTEMPT TO RESOLVE THE '
    + 'MATTER BEFORE A BEIS DIN MUTUALLY AGREED UPON BY THE PARTIES BEFORE PURSUING ANY OTHER FORM '
    + 'OF ARBITRATION OR LITIGATION.');
  para('Any dispute arising under or relating to the subject matter of this Agreement that is not '
    + 'resolved through Beis Din shall be finally determined by arbitration administered by the '
    + 'American Arbitration Association ("AAA") pursuant to the rules for arbitration of commercial '
    + `disputes in effect at the time that arbitration is demanded. Arbitration hearings shall be `
    + `held in ${t(terms, 'arbitration_venue') || 'New York or California'}. The arbitration shall `
    + 'be heard by one or more arbitrators with qualifications as closely related to the Company '
    + 'business as may be reasonably available. If the amount demanded exceeds $100,000 or equitable '
    + 'relief is sought, three neutral arbitrators shall hear the matter; otherwise one neutral '
    + 'arbitrator shall hear the matter.');

  head('Miscellaneous');
  para('Amendment and Termination. This Agreement may not be amended or terminated except by a '
    + 'writing making reference to this Agreement, signed by the party against whom enforcement is '
    + 'sought.');
  para(`Governing Law. This Agreement shall be construed and enforced in accordance with the laws of `
    + `the State of ${state}, without regard to its conflict of laws principles.`);
  para('Successors. This Agreement shall be binding upon, and inure to the benefit of, the parties '
    + 'hereto and their heirs, executors, administrators and other permitted successors or assigns.');
  para('Severability. If any provision of this Agreement is found to be void or unenforceable, the '
    + 'remaining provisions shall continue in full force and effect.');
  para('Entire Agreement. This Agreement constitutes the entire agreement of the Members with '
    + 'respect to the subject matter hereof and supersedes all prior agreements and understandings.');

  b.push({ type: 'spacer', size: 10 });
  para('IN WITNESS WHEREOF, the parties have executed this Operating Agreement as of the date first '
    + 'above written.');

  b.push({ type: 'subhead', text: 'Manager / General Partner' });
  const managerSigner = signers.find((s) => s.role === 'Manager');
  b.push({ type: 'signature', caption: `${manager}, Manager / General Partner`,
    signed: managerSigner?.signed_at ? managerSigner : null });

  b.push({ type: 'subhead', text: 'Members' });
  if (!members.length) b.push({ type: 'signature', caption: blank, signed: null });
  for (const m of members)
    b.push({ type: 'signature', caption: m.name || blank, signed: m.signed_at ? m : null });

  b.push({ type: 'pagebreak' });
  head('Addendum A — Members and Notice Addresses');
  b.push({ type: 'table',
    columns: ['Member', 'Email', 'Address'],
    widths: [150, 150, 160],
    rows: members.length
      ? members.map((m) => [m.name || '', m.email || '', m.address || ''])
      : [[blank, blank, blank]] });

  b.push({ type: 'spacer', size: 18 });
  head('Schedule 1 — Initial Contributions and Membership Interests');
  const totalCapital = members.reduce((s, m) => s + (Number(m.contribution) || 0), 0);
  const totalPct = members.reduce((s, m) => s + (Number(m.pct) || 0), 0);
  b.push({ type: 'table',
    columns: ['Member', 'Initial Contribution', 'Membership Interest'],
    widths: [230, 130, 100],
    rows: [
      ...(members.length
        ? members.map((m) => [m.name || blank, money(m.contribution), pct(m.pct)])
        : [[blank, blank, blank]]),
      ['Total', money(totalCapital), pct(totalPct)],
    ],
    footerRow: true });

  b.push({ type: 'pagebreak' });
  head('Exhibit B — Wire Transfer Instructions');
  b.push({ type: 'subtitle', text: 'For Initial Capital Contributions and Premium Payments',
    align: 'left' });
  para(`Please use the following wire instructions to send your initial capital contribution and all `
    + `future premium payments related to the ${policyPhrase(terms)}.`);
  b.push({ type: 'subhead', text: 'Account Information' });
  b.push({ type: 'table',
    columns: ['', ''],
    widths: [180, 280],
    rows: [
      ['Account name', t(terms, 'bank_account_name') || name],
      ['Account number', or(terms, 'account_number')],
      ['Domestic wire routing number', or(terms, 'wire_routing')],
      ['ACH / direct deposit routing', or(terms, 'ach_routing')],
      ['SWIFT code (international)', or(terms, 'swift')],
      ['Bank', or(terms, 'bank_name')],
      ['Bank address', or(terms, 'bank_address')],
    ] });
  para(`Initial Capital Contribution: Wire your committed capital amount to the account above. `
    + `Include your full name or investor entity name and "${t(terms, 'wire_memo') || blank}" in the `
    + 'memo/reference field.');
  para(`Premium Payments: Premium payments will generally be collected on a ${
    t(terms, 'premium_frequency') || 'quarterly'} basis, subject to the Manager's discretion to `
    + 'adjust timing or amount. To ensure timely processing and avoid any risk of lapse, you will '
    + `receive a Capital Call Notice no more than ${spelled(terms.call_notice_max_days ?? 60)} days `
    + `and no less than ${spelled(terms.call_notice_min_days ?? 20)} days prior to the scheduled `
    + 'due date with the exact amount and payment deadline.');
  para(`This account is maintained solely for ${name} business purposes. Funds are segregated from `
    + 'personal accounts.');

  return b;
}

/**
 * The document as one canonical string.
 *
 * This is what gets hashed, and what a signature is a signature *of*. It
 * deliberately ignores layout: a wrapped line is a rendering decision, and
 * re-flowing the same words must not invalidate an executed agreement.
 * Signature blocks contribute their caption only — who has signed changes
 * as signatures arrive, and each signer signs the same words as the others.
 */
export function canonicalText(blocks) {
  return blocks.map((x) => {
    if (x.type === 'table')
      return `${x.type}|${(x.columns || []).join('\t')}|${
        (x.rows || []).map((r) => r.join('\t')).join('\n')}`;
    if (x.type === 'signature') return `signature|${x.caption}`;
    if (x.type === 'spacer' || x.type === 'pagebreak') return x.type;
    return `${x.type}|${x.text}`;
  }).join('\n').replace(/\s+/g, ' ').trim();
}
