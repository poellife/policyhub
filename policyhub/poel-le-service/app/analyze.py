"""Claude analysis: records text → structured report JSON (summary + Rubric v2.0 LE).

The model is forced to answer through a single tool call whose input schema *is* the report,
so the output is always well-formed JSON that the PDF renderer can consume.
Very large records (beyond CHUNK_CHARS) are first condensed chunk-by-chunk into dated,
page-cited clinical findings, and the report is written from those findings.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, Optional

import anthropic

KNOWLEDGE_DIR = Path(__file__).parent / "knowledge"
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")
CHUNK_MODEL = os.getenv("ANTHROPIC_CHUNK_MODEL", MODEL)
MAX_OUTPUT_TOKENS = int(os.getenv("MAX_OUTPUT_TOKENS", "16000"))
# Roughly 4 chars/token. 1M-context models can take ~600k chars of records in one pass with
# room for the rubric and the answer; chunk beyond that.
CHUNK_CHARS = int(os.getenv("CHUNK_CHARS", "600000"))
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "250000"))

ProgressFn = Callable[[str], None]


def _load(name: str) -> str:
    return (KNOWLEDGE_DIR / name).read_text(encoding="utf8")


def system_prompt(summary_only: bool) -> list[dict]:
    """Assemble the system prompt. Marked cache-able so repeated cases reuse the rubric tokens."""
    role = (
        "You are the Poel Life records analyst. You read an insured's medical records and produce a "
        "de-identified medical summary and, unless told otherwise, a life-expectancy (LE) estimate "
        "under Poel Life Rubric v2.0. Follow the playbook and rubric below exactly. Be factual, "
        "concise and defensible; cite source pages for every LE driver; never invent findings; treat "
        "anything undocumented as unassessed. Never output a full name, SSN, MRN, address, phone, "
        "email or account number — initials only."
    )
    if summary_only:
        role += (" This case is SUMMARY ONLY: produce the clinical summary sections and leave the "
                 "`le` object null.")
    text = (
        f"{role}\n\n# PLAYBOOK\n{_load('playbook.md')}\n\n# RUBRIC v2.0 (authoritative)\n"
        f"{_load('rubric_v2.md')}\n\n# WORKED EXAMPLES\n{_load('worked_example.md')}"
    )
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


# ---------------------------------------------------------------- report schema (tool input)
REPORT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["meta", "overview", "allergies", "problem_list", "systems", "medications",
                 "social_family", "le", "verification_notes"],
    "properties": {
        "meta": {
            "type": "object", "additionalProperties": False,
            "required": ["initials", "sex", "dob", "age", "state", "source_records",
                         "most_recent_data", "summary_of_summary"],
            "properties": {
                "initials": {"type": "string", "description": "e.g. 'J.J.' — never the full name"},
                "sex": {"type": "string", "enum": ["Male", "Female", "Unknown"]},
                "dob": {"type": "string", "description": "MM/DD/YYYY or 'not documented'"},
                "age": {"type": "integer"},
                "state": {"type": "string", "description": "US state of residence or 'not documented'"},
                "source_records": {"type": "string", "description": "facility / record type / page counts / date span"},
                "most_recent_data": {"type": "string", "description": "most recent labs, visits, imaging dates"},
                "summary_of_summary": {"type": "string", "description": "one sentence, ≤ 30 words, for list views"},
            },
        },
        "overview": {
            "type": "object", "additionalProperties": False,
            "required": ["narrative", "key_facts"],
            "properties": {
                "narrative": {"type": "string", "description": "1–2 paragraphs, plain language"},
                "key_facts": {
                    "type": "array", "description": "rows for the key-facts table, e.g. Tobacco/alcohol, Weight/BMI, Key labs, Functional status",
                    "items": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 2},
                },
            },
        },
        "allergies": {"type": "string"},
        "problem_list": {"type": "array", "items": {"type": "string"}},
        "systems": {
            "type": "array", "description": "system sections ordered by clinical importance for this insured",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["title", "narrative", "bullets", "timeline"],
                "properties": {
                    "title": {"type": "string", "description": "e.g. 'Cardiovascular (lead issue)'"},
                    "narrative": {"type": "string"},
                    "bullets": {"type": "array", "items": {"type": "string"}},
                    "timeline": {"type": "array", "description": "optional dated events [date, event]; empty if not useful",
                                 "items": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 2}},
                },
            },
        },
        "medications": {
            "type": "array", "description": "[medication, dose, purpose]",
            "items": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 3},
        },
        "social_family": {"type": "array", "items": {"type": "string"}},
        "le": {
            "anyOf": [
                {"type": "null"},
                {
                    "type": "object", "additionalProperties": False,
                    "required": ["method", "baseline", "baseline_years", "dominant", "path", "factors",
                                 "computation", "modules", "central_years", "range_low_years",
                                 "range_high_years", "estimate", "swing_downside", "swing_upside",
                                 "accuracy_note", "caveat", "confidence"],
                    "properties": {
                        "method": {"type": "string"},
                        "baseline": {"type": "string", "description": "e.g. '81M SSA 2023 ~7.97 yr + 2.6 uplift → baseline ≈ 10.6 yr.'"},
                        "baseline_years": {"type": "number"},
                        "dominant": {"type": ["string", "null"], "description": "dominant-condition trigger text, or null if additive path"},
                        "path": {"type": "string", "enum": ["dominant", "additive"]},
                        "factors": {
                            "type": "array", "description": "[factor, direction (Lowers/Supports), weight (Major/Moderate/Modest), rationale incl. page cites and the debit/credit used]",
                            "items": {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
                        },
                        "computation": {"type": "string", "description": "auditable arithmetic trace: debits per system, smoothing, ×0.75 retention, credits, cap, floor → net; or anchor × ECOG × response etc."},
                        "modules": {"type": "array", "description": "disease-specific modules populated (Seattle HF, MELD 3.0, BODE, SEER/ECOG...) with inputs and result, or 'not applicable' notes",
                                    "items": {"type": "string"}},
                        "central_years": {"type": "number"},
                        "range_low_years": {"type": "number"},
                        "range_high_years": {"type": "number"},
                        "estimate": {"type": "string", "description": "one sentence: 'Estimated remaining life expectancy: roughly X–Y years (to about age A–B), central ~Z years.'"},
                        "swing_downside": {"type": "string"},
                        "swing_upside": {"type": "string"},
                        "accuracy_note": {"type": "string", "description": "Rubric §7 — where this profile sits on the accuracy map"},
                        "caveat": {"type": "string"},
                        "confidence": {"type": "string", "enum": ["higher", "moderate", "lower"]},
                    },
                },
            ]
        },
        "verification_notes": {"type": "array", "description": "OCR-read or otherwise uncertain values that should be checked against the source",
                               "items": {"type": "string"}},
    },
}

REPORT_TOOL = {
    "name": "submit_report",
    "description": "Submit the finished de-identified medical summary and LE analysis.",
    "input_schema": REPORT_SCHEMA,
}

FINDINGS_TOOL = {
    "name": "submit_findings",
    "description": "Submit the clinical findings extracted from this chunk of records.",
    "input_schema": {
        "type": "object", "additionalProperties": False,
        "required": ["demographics", "findings"],
        "properties": {
            "demographics": {"type": "string", "description": "initials, sex, DOB, state if present in this chunk; else ''"},
            "findings": {
                "type": "array",
                "description": "every clinically material finding: diagnoses, staging, labs with values+dates, imaging, EF, ECOG, meds, functional status, social history; each with page cite",
                "items": {"type": "string"},
            },
        },
    },
}


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic()  # ANTHROPIC_API_KEY from env


def _tool_input(msg) -> dict:
    for block in msg.content:
        if block.type == "tool_use":
            return block.input
    raise RuntimeError("Model did not return the structured report (no tool_use block).")


def _condense(text: str, progress: ProgressFn) -> str:
    """Map step for very large records: chunk → page-cited findings."""
    client = _client()
    chunks = [text[i:i + CHUNK_SIZE] for i in range(0, len(text), CHUNK_SIZE)]
    out = []
    for i, chunk in enumerate(chunks, 1):
        progress(f"Condensing records chunk {i} of {len(chunks)}")
        msg = client.messages.create(
            model=CHUNK_MODEL, max_tokens=8000,
            system="You extract clinically material findings from medical records for an underwriting "
                   "analyst. Keep values, units, dates and `PAGE n` citations. Do not summarise away "
                   "labs, staging, EF, ECOG, functional status or medications. Use initials only.",
            tools=[FINDINGS_TOOL], tool_choice={"type": "tool", "name": "submit_findings"},
            messages=[{"role": "user", "content": f"RECORDS CHUNK {i}/{len(chunks)}:\n\n{chunk}"}],
        )
        data = _tool_input(msg)
        if data.get("demographics"):
            out.append(f"[chunk {i} demographics] {data['demographics']}")
        out += [f"- {f}" for f in data.get("findings", [])]
    return "CONDENSED FINDINGS (page-cited, from {} chunks):\n".format(len(chunks)) + "\n".join(out)


def analyze(records_text: str, *, summary_only: bool = False, ocr_warning: str = "",
            initials_override: str = "", progress: Optional[ProgressFn] = None) -> dict:
    progress = progress or (lambda m: None)
    client = _client()

    body = records_text
    if len(body) > CHUNK_CHARS:
        body = _condense(body, progress)

    instructions = [
        "Produce the report by calling submit_report once with the complete report.",
        "Order the system sections by clinical importance for this insured.",
        "Every LE factor must cite the page(s) it comes from.",
    ]
    if summary_only:
        instructions.append("SUMMARY ONLY: set `le` to null.")
    if ocr_warning:
        instructions.append(f"Source note: {ocr_warning}")
    if initials_override:
        instructions.append(f"Use these initials for the subject: {initials_override}")

    progress("Analyzing records and scoring under Rubric v2.0…")
    msg = client.messages.create(
        model=MODEL, max_tokens=MAX_OUTPUT_TOKENS,
        system=system_prompt(summary_only),
        tools=[REPORT_TOOL], tool_choice={"type": "tool", "name": "submit_report"},
        messages=[{"role": "user", "content": [
            {"type": "text", "text": "INSTRUCTIONS:\n- " + "\n- ".join(instructions)},
            {"type": "text", "text": f"MEDICAL RECORDS:\n\n{body}"},
        ]}],
    )
    report = _tool_input(msg)
    report["_usage"] = {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens,
                        "model": MODEL}
    return report


if __name__ == "__main__":  # quick manual check: python -m app.analyze records.txt
    import sys
    print(json.dumps(analyze(Path(sys.argv[1]).read_text()), indent=2))
