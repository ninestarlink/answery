"""知识库注册表：一个 kb_id 对应一组源文件。

两个库的职责不同，检索时不做默认混查：
- shop：电商商品库（商品详情、卖点、尺码库存）
- enterprise：企业制度库（员工手册、差旅报销、采购、信息安全、客服 SOP）
"""

from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[3]


@dataclass
class KBDef:
    kb_id: str
    name: str
    desc: str
    paths: list[Path] = field(default_factory=list)


def _files_in(directory: Path, suffixes: set[str], exclude: set[str] | None = None) -> list[Path]:
    if not directory.exists():
        return []
    excluded = exclude or set()
    return sorted(
        p
        for p in directory.iterdir()
        if p.is_file() and p.suffix.lower() in suffixes and p.name not in excluded
    )


KBS: dict[str, KBDef] = {
    "shop": KBDef(
        kb_id="shop",
        name="电商商品知识库",
        desc="在售商品的详情、卖点、适用场景与尺码库存",
        paths=_files_in(BASE_DIR / "shop_kb", {".md"}),
    ),
    "enterprise": KBDef(
        kb_id="enterprise",
        name="企业制度知识库",
        desc="员工制度、差旅报销、采购管理、信息安全与客服升级 SOP",
        paths=_files_in(BASE_DIR / "enterprise_kb", {".md", ".pdf", ".docx", ".xlsx"}),
    ),
}


def get_kb(kb_id: str) -> KBDef | None:
    return KBS.get(kb_id)


def kb_summary() -> list[dict]:
    return [
        {
            "kb_id": kb.kb_id,
            "name": kb.name,
            "desc": kb.desc,
            "files": [p.name for p in kb.paths],
        }
        for kb in KBS.values()
    ]
