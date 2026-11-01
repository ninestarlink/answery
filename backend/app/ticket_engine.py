"""IT 工单自动分级引擎：把一句自然语言报障解析成可执行工单。

设计原则：
- 纯规则，不调用大模型：判定依据可解释、结果可复现，演示时不会因为模型波动翻车；
- 类别、优先级、指派小组、SLA、缺失信息、处置建议全部由关键词与影响范围推导；
- 输出结构固定，前端直接按字段渲染，不解析模型自由文本。
"""

from __future__ import annotations

import re

# ------------------------------------------------------------------
# 类别规则（顺序即优先级，命中数相同时排在前面的胜出）
# ------------------------------------------------------------------
CATEGORY_RULES: list[dict] = [
    {
        "key": "account",
        "label": "账号与权限",
        "keywords": ["登录", "账号", "帐号", "密码", "权限", "开通", "锁定", "锁号", "验证码", "工号", "邮箱", "单点登录"],
        "group": "IT 服务台 · 账号组",
        "suggestions": [
            "先确认是否连续输错密码导致锁定（通常锁定 30 分钟）",
            "尝试企业微信扫码或统一身份认证的自助重置入口",
            "需要开通新权限时，请附上审批人姓名与所需系统",
        ],
    },
    {
        "key": "network",
        "label": "网络与 Wi-Fi",
        "keywords": ["网络", "wifi", "wi-fi", "无线", "断网", "网速", "上不了网", "内网", "vpn", "掉线", "网口", "路由器"],
        "group": "IT 服务台 · 网络组",
        "suggestions": [
            "用手机连同一 Wi-Fi 测试，判断是单机问题还是 AP 故障",
            "断开重连 Wi-Fi 或改接有线网口，观察指示灯状态",
            "VPN 异常时先确认账号状态，再尝试切换接入节点",
        ],
    },
    {
        "key": "hardware",
        "label": "硬件故障",
        "keywords": ["电脑", "笔记本", "台式机", "显示器", "键盘", "鼠标", "打印机", "打印", "卡纸", "蓝屏", "开不了机", "死机", "硬盘", "电池", "充电", "扫码枪", "黑屏", "不亮"],
        "group": "IT 服务台 · 桌面运维",
        "suggestions": [
            "记录开机自检提示、蓝屏错误码或打印机面板报错",
            "尝试更换电源、视频线或耗材，排除外设问题",
            "重要文件先备份到企业网盘，避免维修过程丢失数据",
        ],
    },
    {
        "key": "meeting",
        "label": "会议设备",
        "keywords": ["投影", "投影仪", "会议室", "摄像头", "麦克风", "音响", "投屏", "腾讯会议", "zoom", "会议平板", "视频会议"],
        "group": "IT 服务台 · 音视频组",
        "suggestions": [
            "检查 HDMI / Type-C 线是否插到位，并切换正确的信号源",
            "重启会议平板或投影设备，等待 60 秒后再连接",
            "距会议开始不足 30 分钟可申请备用会议室",
        ],
    },
    {
        "key": "software",
        "label": "软件与安装",
        "keywords": ["安装", "软件", "office", "excel", "word", "微信", "驱动", "更新", "授权", "激活", "闪退", "插件", "浏览器"],
        "group": "IT 服务台 · 应用支持",
        "suggestions": [
            "确认软件是否来自公司软件中心，避免使用未知来源安装包",
            "保留报错截图与操作步骤，便于复现定位",
            "授权类问题需提供设备资产编号",
        ],
    },
    {
        "key": "business",
        "label": "业务系统",
        "keywords": ["erp", "crm", "审批", "报销系统", "财务系统", "下单", "订单系统", "工单系统", "系统打不开", "页面报错", "接口"],
        "group": "IT 服务台 · 应用支持",
        "suggestions": [
            "先确认同事是否同样无法访问，区分账号问题与系统故障",
            "记录报错时间与页面截图，注明操作路径",
            "涉及审批、报销的请附单据编号，便于关联排查",
        ],
    },
    {
        "key": "other",
        "label": "其他",
        "keywords": [],
        "group": "IT 服务台 · 综合受理",
        "suggestions": [
            "补充问题现象、发生时间与期望完成时间",
            "如有截图或报错原文，请一并附在工单中",
        ],
    },
]

# ------------------------------------------------------------------
# 优先级信号
# ------------------------------------------------------------------
P0_WORDS = ["全员", "所有人", "全公司", "整个部门", "整个楼层", "大面积", "生产环境", "全部中断", "核心系统", "所有系统"]

P1_WORDS = [
    "紧急", "马上", "立刻", "尽快", "下班前", "今天", "明天", "上午", "下午",
    "客户", "领导", "访客", "会议开始", "合同", "月结", "发薪",
    "无法登录", "登录不了", "登不上", "锁定", "锁号", "连不上", "上不了网",
    "打不开", "用不了", "无法使用", "断网", "宕机", "崩溃", "开不了机", "蓝屏", "死机",
]

P3_WORDS = ["咨询", "请问", "如何", "怎么", "想了解", "申请", "开通", "建议", "有空", "顺便", "预约", "能否"]

HARD_FAILURE_WORDS = ["坏", "故障", "卡纸", "打不开", "连不上", "报错", "崩溃", "死机", "蓝屏", "断网", "无法", "不能", "锁定", "上不了网"]

PRIORITY_META = {
    "P0": {"label": "P0 · 紧急", "sla_response": "15 分钟内响应", "sla_resolve": "2 小时内恢复"},
    "P1": {"label": "P1 · 高", "sla_response": "30 分钟内响应", "sla_resolve": "4 小时内恢复"},
    "P2": {"label": "P2 · 中", "sla_response": "4 小时内响应", "sla_resolve": "1 个工作日内处理"},
    "P3": {"label": "P3 · 低", "sla_response": "1 个工作日内响应", "sla_resolve": "3 个工作日内答复"},
}

SYSTEM_WORDS = ["oa", "erp", "crm", "vpn", "邮箱", "财务", "报销", "审批", "考勤", "下单", "订单"]


def _hits(text: str, words: list[str]) -> list[str]:
    """返回命中的关键词（去重、保持原顺序）。"""
    seen: list[str] = []
    for word in words:
        if word and word in text and word not in seen:
            seen.append(word)
    return seen


def classify_category(description: str) -> tuple[dict, list[str]]:
    """按关键词命中数判断类别；同分时按规则顺序取靠前的。"""
    text = description.lower()
    best_rule = CATEGORY_RULES[-1]
    best_score = 0
    best_hits: list[str] = []

    for rule in CATEGORY_RULES[:-1]:
        hits = _hits(text, rule["keywords"])
        if len(hits) > best_score:
            best_rule, best_score, best_hits = rule, len(hits), hits

    return best_rule, best_hits


def classify_priority(description: str, category_key: str) -> tuple[str, str]:
    """优先级：P0 影响面 → P1 阻断/时限 → P3 咨询申请 → 默认 P2。"""
    text = description.lower()
    p0 = _hits(text, P0_WORDS)
    if p0:
        return "P0", f"命中影响面关键词「{'、'.join(p0)}」，按影响多人处理"

    p1 = _hits(text, P1_WORDS)
    if p1:
        return "P1", f"命中时效/阻断关键词「{'、'.join(p1)}」，已无法正常工作或存在明确时限"

    p3 = _hits(text, P3_WORDS)
    if p3 and not _hits(text, HARD_FAILURE_WORDS):
        return "P3", f"命中咨询/申请关键词「{'、'.join(p3)}」，无故障现象"

    if category_key == "account":
        return "P2", "账号类问题，未提及明确时限，按常规处理"
    return "P2", "存在故障现象但未提及影响范围与时限，按常规优先级处理"


def build_missing_info(description: str, category_key: str) -> list[str]:
    """列出工单当前缺失、需要报障人补充的信息。"""
    text = description.lower()
    has_location = any(k in text for k in ["楼", "层", "工位", "办公室", "座位", "机房"])
    has_asset = bool(re.search(r"[a-z]{2,}[-_]?\d{3,}", text)) or any(k in text for k in ["资产", "编号", "设备号"])
    has_error = any(k in text for k in ["报错", "提示", "错误码", "截图", "弹窗"])
    has_scope = any(k in text for k in ["只有我", "仅我", "同事", "同楼层", "整个部门", "所有人", "大家"])
    has_room_no = bool(re.search(r"[a-z]?\d{2,4}[-\s]?\d{0,4}\s*(会议室|室)|会议室\s*[a-z]?\d{1,4}", text))
    has_system = _hits(text, SYSTEM_WORDS)

    missing: list[str] = []
    if category_key == "hardware":
        if not has_asset:
            missing.append("设备编号 / 资产标签")
        if not has_location:
            missing.append("具体位置（楼层 / 工位）")
        if not has_error:
            missing.append("故障现象或面板报错信息")
    elif category_key == "meeting":
        if not has_room_no:
            missing.append("具体会议室（如 3F-301）")
        missing.append("设备型号或接口类型（HDMI / Type-C）")
    elif category_key == "network":
        if not has_location:
            missing.append("具体位置（楼层 / 工位）")
        if not has_scope:
            missing.append("影响范围（仅自己 / 整层 / 全公司）")
    elif category_key == "account":
        if not has_asset:
            missing.append("员工工号")
        if not has_system:
            missing.append("涉及的系统（OA / VPN / 邮箱等）")
    elif category_key in ("software", "business"):
        if not has_error:
            missing.append("报错截图或提示原文")
        if not has_system:
            missing.append("涉及的系统 / 软件名称")
    else:
        missing.append("涉及的系统或设备")
        missing.append("期望完成时间")

    if len(description.strip()) < 12:
        missing.insert(0, "问题现象（何时开始、是否可复现）")

    # 去重并最多保留 3 条，避免追问清单过长吓退报障人
    deduped = list(dict.fromkeys(missing))
    return deduped[:3]


def build_auto_reply(category_label: str, priority_label: str, group: str) -> str:
    return (
        f"已按「{category_label}」受理，优先级 {priority_label}，指派 {group}。"
        "工单已写入待办队列，处理进展会同步到工单详情。"
    )


def analyze(description: str) -> dict:
    """一句话报障 → 结构化工单字段（不含工单号与落库信息）。"""
    text = description.strip()
    rule, keywords = classify_category(text)
    priority, priority_reason = classify_priority(text, rule["key"])
    meta = PRIORITY_META[priority]

    return {
        "category": rule["key"],
        "category_label": rule["label"],
        "priority": priority,
        "priority_label": meta["label"],
        "priority_reason": priority_reason,
        "assignee_group": rule["group"],
        "sla_response": meta["sla_response"],
        "sla_resolve": meta["sla_resolve"],
        "matched_keywords": keywords[:6],
        "missing_info": build_missing_info(text, rule["key"]),
        "suggestions": rule["suggestions"],
        "auto_reply": build_auto_reply(rule["label"], meta["label"], rule["group"]),
    }
