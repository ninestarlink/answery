"""多格式文档解析：PDF / Word / Excel / Markdown → 带页码的纯文本页。

PDF 用 pymupdf4llm 按页输出 Markdown，保留标题层级与表格；
Word 按段落与表格顺序拼接；Excel 每个工作表转成「行 × 列」的文本。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

DOC_NO_RE = re.compile(r"YC-[A-Z]{2,3}-\d{3}")
VER_RE = re.compile(r"V\d+(?:\.\d+)?")
NUM_PREFIX_RE = re.compile(r"^[0-9]+_")


@dataclass
class ParsedDoc:
    doc_id: str
    doc_name: str
    doc_no: str
    version: str
    source_file: str
    file_hash: str
    pages: list[tuple[int | None, str]] = field(default_factory=list)

    @property
    def full_text(self) -> str:
        return "\n\n".join(text for _, text in self.pages if text.strip())


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()[:16]


def _display_name(path: Path) -> str:
    return NUM_PREFIX_RE.sub("", path.stem)


def _meta(text: str, fallback_name: str) -> tuple[str, str, str]:
    head = text[:1200]
    doc_no = (DOC_NO_RE.search(head) or [None])[0] or ""
    version = (VER_RE.search(head) or [None])[0] or ""
    return doc_no, version, fallback_name


def _parse_pdf(path: Path) -> list[tuple[int | None, str]]:
    import pymupdf4llm

    chunks = pymupdf4llm.to_markdown(str(path), page_chunks=True)
    pages: list[tuple[int | None, str]] = []
    for item in chunks:
        if isinstance(item, str):
            pages.append((None, item))
            continue
        meta = item.get("metadata") or {}
        page = meta.get("page")
        page_no = int(page) + 1 if isinstance(page, int) else None
        pages.append((page_no, str(item.get("text") or "")))
    return pages


def _parse_docx(path: Path) -> list[tuple[int | None, str]]:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(str(path))
    lines: list[str] = []
    for child in doc.element.body.iterchildren():
        if child.tag.endswith("}p"):
            text = Paragraph(child, doc).text.strip()
            if text:
                lines.append(text)
        elif child.tag.endswith("}tbl"):
            table = Table(child, doc)
            for row in table.rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                if any(cells):
                    lines.append(" | ".join(cells))
    return [(None, "\n".join(lines))]


def _parse_xlsx(path: Path) -> list[tuple[int | None, str]]:
    from openpyxl import load_workbook

    wb = load_workbook(str(path), data_only=True, read_only=True)
    pages: list[tuple[int | None, str]] = []
    for sheet in wb.worksheets:
        lines = [f"工作表：{sheet.title}"]
        for row in sheet.iter_rows(values_only=True):
            cells = ["" if v is None else str(v).strip() for v in row]
            if any(cells):
                lines.append(" | ".join(cells))
        pages.append((None, "\n".join(lines)))
    wb.close()
    return pages


def _parse_md(path: Path) -> list[tuple[int | None, str]]:
    return [(None, path.read_text(encoding="utf-8", errors="ignore"))]


def parse_file(path: Path) -> ParsedDoc:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        pages = _parse_pdf(path)
    elif suffix == ".docx":
        pages = _parse_docx(path)
    elif suffix == ".xlsx":
        pages = _parse_xlsx(path)
    elif suffix in {".md", ".markdown", ".txt"}:
        pages = _parse_md(path)
    else:
        raise ValueError(f"不支持的文档格式：{path.name}")

    raw_text = "\n\n".join(text for _, text in pages if text.strip())
    fallback_name = _display_name(path)
    doc_no, version, name = _meta(raw_text, fallback_name)
    doc_id = hashlib.sha1(f"{path.name}|{raw_text[:2000]}".encode()).hexdigest()[:16]
    return ParsedDoc(
        doc_id=doc_id,
        doc_name=name,
        doc_no=doc_no,
        version=version,
        source_file=path.name,
        file_hash=_file_hash(path),
        pages=pages,
    )
