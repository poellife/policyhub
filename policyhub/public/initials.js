/* =====================================================================
   Taking the insureds' names off anything that leaves the building.

   Shared by the server and the browser, because the one-pager exists
   twice — drawn as a PDF in `src/opportunity-pdf.js`, built as HTML in
   `public/reports.js` — and a rule enforced in one of them is a rule
   with a hole in it. The covering email uses it too.

   THE RULE. An investor document carries an age, a state, a life
   expectancy and the diagnoses driving that expectancy. That is a
   medical file, and a medical file with a name on it is a different
   object. The name stays on the screens inside the application, where
   the reader is signed in and the record is the record. It comes off at
   the one point the paper is handed to somebody.

   The numbered fields were never the problem — nobody prints
   `insured_last_name` on the sheet by accident. The problem is the free
   text: the investment case, the medical notes, the underwriter's view.
   Somebody writing about a policy writes the name of the person it is
   on, because on the screen where they typed it that name is allowed.
   `scrubNames` is what stands between that sentence and the investor.
   ===================================================================== */

/** The first letter, as an initial. "" for anything that has none. */
export const initialOf = (v) => {
  const c = String(v || '').trim().replace(/[^\p{L}\p{N}]/gu, '').charAt(0);
  return c ? `${c.toUpperCase()}.` : '';
};

/** "G.S." — both initials, run together, for a headline. */
export const initialsOf = (first, last) =>
  `${initialOf(first)}${initialOf(last)}`;

/**
 * Every part of both insureds' names, swapped for their initials.
 *
 * Deliberately blunt in two directions.
 *
 * It is case-insensitive and takes possessives, because "sommers's
 * records" is the same disclosure as "Sommers".
 *
 * And it will happily turn an ordinary word into an initial if somebody
 * is called Green or Rice. A slightly odd sentence in a draft somebody
 * is about to read is the cheaper failure by a wide margin — the other
 * way round, the failure is a named medical file in a stranger's inbox.
 *
 * Names under three characters are left alone: "Al" is not a name in a
 * regular expression, it is a substring waiting to eat half the message.
 * A two-letter first name still comes off every numbered field; it is
 * only free text that keeps it, and only where it was typed by hand.
 *
 * @param {string} text  free text as somebody typed it
 * @param {object} o     an opportunity, for the four name fields
 */
export function scrubNames(text, o = {}) {
  let out = String(text || '');
  const pairs = [
    [o.insured_first_name, initialOf(o.insured_first_name)],
    [o.insured_last_name, initialOf(o.insured_last_name)],
    [o.insured2_first_name, initialOf(o.insured2_first_name)],
    [o.insured2_last_name, initialOf(o.insured2_last_name)],
  ];
  for (const [raw, mask] of pairs) {
    const word = String(raw || '').trim();
    if (word.length < 3 || !mask) continue;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${esc}(?:'s|’s)?\\b`, 'gi'), mask);
  }
  return out;
}

/**
 * Whichever of the four names is still in a finished document.
 *
 * Said out loud rather than trusted. `scrubNames` is a regular
 * expression and regular expressions have edges — a name split across a
 * line break, a name typed with a hyphen the record does not have. This
 * is the check that runs afterwards and puts what it finds in front of
 * whoever is about to press send.
 *
 * @returns {string[]} the names found, empty when the document is clean
 */
export function namesLeftIn(text, o = {}) {
  const found = [];
  const body = String(text || '');
  for (const raw of [o.insured_first_name, o.insured_last_name,
    o.insured2_first_name, o.insured2_last_name]) {
    const word = String(raw || '').trim();
    if (word.length < 3) continue;
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body))
      found.push(word);
  }
  return [...new Set(found)];
}
