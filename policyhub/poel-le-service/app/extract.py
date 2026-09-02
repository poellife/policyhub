"""Records ingestion: PDF text-layer extraction with OCR fallback, plus plain text / DOCX.

Produces one string with `===== PAGE n =====` markers so the analyst (and the report) can
cite source pages, and a small metadata dict (page count, OCR used, chars).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

OCR_DPI = int(os.getenv("OCR_DPI", "200"))
OCR_CHUNK_PAGES = int(os.getenv("OCR_CHUNK_PAGES", "20"))
# A page with fewer than this many alphabetic characters is treated as "no usable text".
MIN_TEXT_CHARS_PER_PAGE = 40
# If fewer than this share of pages have usable text, OCR the whole document.
OCR_TRIGGER_RATIO = 0.6

ProgressFn = Callable[[str], None]


@dataclass
class Extraction:
    text: str
    pages: int
    ocr_used: bool
    ocr_pages: int = 0
    source_name: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return len(self.text)


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _pdf_page_count(pdf: Path) -> int:
    out = _run(["pdfinfo", str(pdf)]).stdout
    m = re.search(r"^Pages:\s+(\d+)", out, re.M)
    return int(m.group(1)) if m else 0


def _pdf_text_pages(pdf: Path) -> list[str]:
    """pdftotext -layout, split on form-feeds into pages."""
    res = _run(["pdftotext", "-layout", str(pdf), "-"])
    if res.returncode != 0:
        return []
    pages = res.stdout.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return pages


def _usable(page_text: str) -> bool:
    return len(re.findall(r"[A-Za-z]", page_text)) >= MIN_TEXT_CHARS_PER_PAGE


def _ocr_pages(pdf: Path, first: int, last: int, workdir: Path) -> list[str]:
    """Rasterize pages first..last (1-based, inclusive) and OCR them with tesseract."""
    prefix = workdir / f"p{first}"
    _run(["pdftoppm", "-png", "-r", str(OCR_DPI), "-f", str(first), "-l", str(last),
          str(pdf), str(prefix)], timeout=900)
    images = sorted(workdir.glob(f"p{first}-*.png"),
                    key=lambda p: int(p.stem.rsplit("-", 1)[1]))
    texts = []
    for img in images:
        res = _run(["tesseract", str(img), "-", "--psm", "6", "-l", "eng"], timeout=300)
        texts.append(res.stdout)
        img.unlink(missing_ok=True)
    return texts


def extract_pdf(pdf: Path, progress: Optional[ProgressFn] = None) -> Extraction:
    progress = progress or (lambda m: None)
    n = _pdf_page_count(pdf)
    pages = _pdf_text_pages(pdf)
    if n == 0:
        n = len(pages)
    usable = [_usable(p) for p in pages]
    ratio = (sum(usable) / n) if n else 0.0
    ocr_used = False
    ocr_count = 0
    warnings: list[str] = []

    if n and ratio < OCR_TRIGGER_RATIO and shutil.which("tesseract"):
        ocr_used = True
        progress(f"Scanned document detected ({sum(usable)}/{n} pages with text). Running OCR…")
        with tempfile.TemporaryDirectory() as td:
            ocr_pages: list[str] = []
            for start in range(1, n + 1, OCR_CHUNK_PAGES):
                end = min(start + OCR_CHUNK_PAGES - 1, n)
                progress(f"OCR pages {start}–{end} of {n}")
                ocr_pages.extend(_ocr_pages(pdf, start, end, Path(td)))
        # Prefer the digital layer where it exists, OCR elsewhere.
        merged = []
        for i in range(n):
            digital = pages[i] if i < len(pages) else ""
            if _usable(digital):
                merged.append(digital)
            else:
                merged.append(ocr_pages[i] if i < len(ocr_pages) else "")
                ocr_count += 1
        pages = merged
        warnings.append(f"{ocr_count} of {n} pages were read by OCR — verify critical values against the source.")
    elif n and ratio < OCR_TRIGGER_RATIO:
        warnings.append("Document appears scanned but tesseract is not installed; text may be incomplete.")

    text = "\n".join(f"===== PAGE {i + 1} =====\n{p.strip()}" for i, p in enumerate(pages))
    return Extraction(text=text, pages=n, ocr_used=ocr_used, ocr_pages=ocr_count,
                      source_name=pdf.name, warnings=warnings)


def extract_docx(path: Path) -> Extraction:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf8", "ignore")
    xml = re.sub(r"</w:p>", "\n", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    return Extraction(text=f"===== PAGE 1 =====\n{text}", pages=1, ocr_used=False, source_name=path.name)


def extract_text_file(path: Path) -> Extraction:
    text = path.read_text(encoding="utf8", errors="ignore")
    if "===== PAGE" not in text:
        text = f"===== PAGE 1 =====\n{text}"
    return Extraction(text=text, pages=text.count("===== PAGE"), ocr_used=False, source_name=path.name)


def extract_any(path: Path, progress: Optional[ProgressFn] = None) -> Extraction:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path, progress)
    if ext == ".docx":
        return extract_docx(path)
    if ext in (".txt", ".md"):
        return extract_text_file(path)
    raise ValueError(f"Unsupported file type: {ext}")


def extract_many(paths: list[Path], progress: Optional[ProgressFn] = None) -> Extraction:
    """Concatenate several records files into one extraction, labelling each source."""
    parts, total_pages, warnings = [], 0, []
    ocr_used, ocr_pages = False, 0
    for p in paths:
        ex = extract_any(p, progress)
        parts.append(f"########## SOURCE FILE: {p.name} ({ex.pages} pages) ##########\n{ex.text}")
        total_pages += ex.pages
        ocr_used |= ex.ocr_used
        ocr_pages += ex.ocr_pages
        warnings += [f"{p.name}: {w}" for w in ex.warnings]
    return Extraction(text="\n\n".join(parts), pages=total_pages, ocr_used=ocr_used,
                      ocr_pages=ocr_pages, source_name=", ".join(p.name for p in paths),
                      warnings=warnings)
