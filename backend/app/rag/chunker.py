"""父子切片：父块保上下文，子块保召回精度。

父块按标题层级切（没有标题时按段落聚合），子块在父块内按句子聚合成约 220 字，
这样向量召回命中细节，送进模型时却能拿到完整章节，避免「只召回半句话」。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .parser import ParsedDoc

PARENT_MAX = 1200
CHILD_TARGET = 220
CHILD_MAX = 300

HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
# 无 Markdown 标题的 Word 文档：同时识别「四、住宿与补贴标准」和「3.4 自驾」两类小节行。
# 只认独立成行的短标题，正文里带句号的整句不会被误判成标题。
SECTION_RE = re.compile(
    r"^(?:[一二三四五六七八九十]+、.{2,60}|\d+(?:\.\d+)*\s+.{2,40})$",
    re.MULTILINE,
)
SENTENCE_RE = re.compile(r"(?<=[。；！？])|\n+")


@dataclass
class ParentChunk:
    parent_id: str
    doc_id: str
    content: str
    section: str
    page: int | None


@dataclass
class ChildChunk:
    chunk_id: str
    parent_id: str
    doc_id: str
    content: str
    section: str
    page: int | None


def _split_long(text: str, limit: int) -> list[str]:
    """超长文本按段落/行再切，保证不超过上限。"""
    pieces: list[str] = []
    buffer = ""
    for line in text.splitlines(keepends=True):
        if len(buffer) + len(line) > limit and buffer:
            pieces.append(buffer.strip())
            buffer = ""
        if len(line) > limit:
            for i in range(0, len(line), limit):
                part = line[i : i + limit].strip()
                if part:
                    pieces.append(part)
        else:
            buffer += line
    if buffer.strip():
        pieces.append(buffer.strip())
    return pieces


def _parents_from_text(
    text: str, page: int | None, doc_id: str, start_index: int
) -> list[ParentChunk]:
    blocks: list[tuple[str, str]] = []
    matches = list(HEADING_RE.finditer(text))
    if matches:
        for i, match in enumerate(matches):
            section = match.group(1).strip()
            body_start = match.end()
            body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            body = text[body_start:body_end].strip()
            if body:
                blocks.append((section, body))
    else:
        # 无 Markdown 标题的 Word / Excel：按编号小节或段落聚合
        positions = [m.start() for m in SECTION_RE.finditer(text)]
        if positions:
            for i, start in enumerate(positions):
                end = positions[i + 1] if i + 1 < len(positions) else len(text)
                body = text[start:end].strip()
                line_end = text.find("\n", start)
                section = text[start : line_end if line_end > 0 else min(end, start + 60)]
                blocks.append((section.strip()[:60], body))
        else:
            paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
            buffer = ""
            for para in paragraphs:
                if len(buffer) + len(para) > PARENT_MAX and buffer:
                    blocks.append(("", buffer.strip()))
                    buffer = ""
                buffer += para + "\n"
            if buffer.strip():
                blocks.append(("", buffer.strip()))

    parents: list[ParentChunk] = []
    for section, body in blocks:
        for part in _split_long(body, PARENT_MAX) if len(body) > PARENT_MAX else [body]:
            if not part.strip():
                continue
            index = start_index + len(parents)
            parents.append(
                ParentChunk(
                    parent_id=f"{doc_id}-p{index:03d}",
                    doc_id=doc_id,
                    content=part.strip(),
                    section=section[:60],
                    page=page,
                )
            )
    return parents


def _children_from_parent(parent: ParentChunk) -> list[ChildChunk]:
    sentences = [s.strip() for s in SENTENCE_RE.split(parent.content) if s and s.strip()]
    groups: list[str] = []
    buffer = ""
    for sentence in sentences:
        if len(sentence) > CHILD_MAX:
            if buffer:
                groups.append(buffer)
                buffer = ""
            groups.extend(sentence[i : i + CHILD_MAX] for i in range(0, len(sentence), CHILD_MAX))
            continue
        if len(buffer) + len(sentence) > CHILD_TARGET and buffer:
            groups.append(buffer)
            buffer = ""
        buffer += sentence
    if buffer:
        groups.append(buffer)

    return [
        ChildChunk(
            chunk_id=f"{parent.parent_id}-c{i:03d}",
            parent_id=parent.parent_id,
            doc_id=parent.doc_id,
            content=text,
            section=parent.section,
            page=parent.page,
        )
        for i, text in enumerate(groups)
        if text.strip()
    ]


def chunk_doc(doc: ParsedDoc) -> tuple[list[ParentChunk], list[ChildChunk]]:
    parents: list[ParentChunk] = []
    for page, text in doc.pages:
        if not text.strip():
            continue
        parents.extend(_parents_from_text(text, page, doc.doc_id, len(parents)))

    children: list[ChildChunk] = []
    for parent in parents:
        children.extend(_children_from_parent(parent))
    return parents, children
