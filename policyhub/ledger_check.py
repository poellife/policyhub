"""Deterministic PDF ledger parser (ported from Jonathan's earlier self-host app).

Used as an independent CROSS-CHECK on the Claude-based extraction: two
different methods read the same annual ledger; per-year disagreements are
flagged to the user.

Carrier illustration PDFs vary widely, so this parser is deliberately layered:

1. Table extraction (pdfplumber) — find the annual ledger table by header
   keywords and map its columns.
2. Text fallback — scan raw text lines for year-led numeric rows.
3. The caller (app.py) also accepts an Excel ledger or pasted CSV as a
   guaranteed fallback when a PDF can't be auto-parsed.

Output is a list of ``AnnualLedgerRow`` (the same shape the premium optimizer
consumes), plus a ``meta`` dict describing what was found so the UI can show a
confirmation preview.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import pdfplumber

MAX_PAGES = 60          # only the first N pages are scanned (ledgers live early)
STOP_AFTER_TABLE = 10   # once a ledger table is found, scan this many more pages


@dataclass
class ParsedIllustration:
    rows: list = field(default_factory=list)   # list[AnnualLedgerRow]
    meta: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)
    row_values: dict = field(default_factory=dict)  # {year: [every number on that row]}
                                                    # column-order-independent view for
                                                    # the cross-check (layouts vary)


# Column keyword -> canonical field.  Ordered by priority; first match wins.
COLUMN_KEYWORDS = {
    "premium_outlay": ["premium outlay", "planned premium", "annual premium",
                       "premium", "total premium", "outlay"],
    "av": ["account value", "accumulated value", "accum value", "cash value",
           "account", "accumulation value"],
    "csv": ["cash surrender", "surrender value", "surrender", "net surrender"],
    "ndb": ["death benefit", "net death benefit", "face amount", "death",
            "insurance amount", "net amount"],
    "gcr": ["guaranteed credited rate", "guaranteed interest", "credited rate",
            "guaranteed rate", "gcr"],
    "ngcr": ["net guaranteed credited rate", "net credited rate", "ngcr",
             "net guaranteed interest"],
}


def _match_field(header_text: str) -> Optional[str]:
    t = (header_text or "").lower().strip()
    for field, kws in COLUMN_KEYWORDS.items():
        for kw in kws:
            if kw in t:
                return field
    return None


def _to_float(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("$", "").replace(",", "").replace("%", "").strip()
    if s in ("", "-", "—", "N/A", "n/a"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _is_year(v) -> bool:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return 0 <= float(v) <= 130 and float(v) == int(float(v))
    return False


def _extract_tables(pdf) -> list:
    """Page-bounded, memory-flushed table extraction (large in-force
    illustrations can be 50+ pages; unbounded pdfplumber parsing OOMs
    small servers)."""
    tables = []
    found_at = None
    for i, page in enumerate(pdf.pages):
        if i >= MAX_PAGES:
            break
        if found_at is not None and i - found_at > STOP_AFTER_TABLE:
            break
        try:
            for t in page.extract_tables():
                if t:
                    tables.append(t)
                    if found_at is None and len(t) >= 5:
                        found_at = i
        except Exception:
            pass
        finally:
            try: page.flush_cache()
            except Exception: pass
    return tables


def _find_ledger_table(tables) -> Optional[tuple]:
    """Return (table, header_row_index, col_map) for the best ledger table."""
    best = None
    best_score = 0
    for t in tables:
        if not t or len(t) < 3:
            continue
        # find header row (most keyword matches)
        for hi, row in enumerate(t):
            cells = [str(c) if c is not None else "" for c in row]
            col_map = {}
            for ci, c in enumerate(cells):
                f = _match_field(c)
                if f and f not in col_map:
                    col_map[f] = ci
            score = len(col_map)
            # require at least premium + av + csv + ndb
            if {"premium_outlay", "av", "csv", "ndb"} <= set(col_map):
                if score > best_score:
                    best_score = score
                    best = (t, hi, col_map)
    return best


def _rows_from_table(table, header_idx, col_map) -> list:
    rows = []
    for row in table[header_idx + 1:]:
        if not row:
            continue
        year = None
        # year usually in first column; scan a few leading cells
        # (pdfplumber returns strings - coerce before testing)
        for c in row[:3]:
            cv = _to_float(c)
            if cv is not None and _is_year(cv):
                year = int(cv)
                break
        if year is None:
            continue
        def get(field):
            ci = col_map.get(field)
            if ci is None or ci >= len(row):
                return None
            return _to_float(row[ci])
        premium = get("premium_outlay")
        ndb = get("ndb")
        av = get("av")
        csv = get("csv")
        if all(v is None for v in (premium, ndb, av, csv)):
            continue
        allvals = [v for v in (_to_float(c) for c in row) if v is not None]
        rows.append((year, premium, ndb, av, csv,
                     get("gcr"), get("ngcr"), allvals))
    return rows


def _rows_from_text(pdf) -> list:
    """Fallback: scan text lines for 'year  num  num  num  num' patterns."""
    rows = []
    for i, page in enumerate(pdf.pages):
        if i >= MAX_PAGES:
            break
        text = page.extract_text() or ""
        for line in text.splitlines():
            parts = line.replace("$", "").replace(",", "").split()
            nums = []
            year = None
            for p in parts:
                v = _to_float(p)
                if v is None:
                    continue
                if year is None and _is_year(v):
                    year = int(v)
                else:
                    nums.append(v)
            if year is not None and len(nums) >= 4:
                # heuristic column order: premium, ndb, av, csv (last 4)
                premium, ndb, av, csv = nums[-4:]
                rows.append((year, premium, ndb, av, csv, None, None, list(nums)))
        try: page.flush_cache()
        except Exception: pass
    return rows


def parse_illustration_pdf(path: str) -> ParsedIllustration:
    result = ParsedIllustration()
    raw = []
    try:
        with pdfplumber.open(path) as pdf:
            tables = _extract_tables(pdf)
            found = _find_ledger_table(tables)
            if found:
                table, hi, col_map = found
                raw = _rows_from_table(table, hi, col_map)
                result.meta["method"] = "table"
                result.meta["columns"] = sorted(col_map.keys())
            else:
                raw = _rows_from_text(pdf)
                result.meta["method"] = "text"
                if not raw:
                    result.warnings.append(
                        "No ledger table could be auto-detected in this PDF. "
                        "Use the Excel or CSV fallback instead."
                    )
    except Exception as e:  # noqa: BLE001
        result.warnings.append(f"PDF parsing failed: {e}")

    # de-dup by year, keep ascending
    seen = {}
    vals = {}
    for r in raw:
        year, premium, ndb, av, csv, gcr, ngcr, allvals = r
        if year is None:
            continue
        seen[year] = (premium, ndb, av, csv, gcr, ngcr)
        vals.setdefault(year, [])
        for v in allvals:
            vals[year].append(v)
    result.rows = sorted(seen.items())
    result.row_values = vals

    result.meta["year_count"] = len(result.rows)
    if result.rows:
        result.meta["first_year"] = result.rows[0][0]
        result.meta["last_year"] = result.rows[-1][0]
    return result
