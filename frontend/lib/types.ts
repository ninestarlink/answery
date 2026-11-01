/**
 * 全局共享类型定义
 */

/** 聊天消息角色 */
export type Role = 'user' | 'assistant';

/** 后端在 message_end 中回传的 Token 用量 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 检索命中的知识库来源（由后端检索证据链透传） */
export interface SourceRef {
  /** 命中的文档名，如 02_差旅报销制度_v2025.docx */
  document_name: string;
  /** 相似度分数，0~1 */
  score: number;
  /** 命中分段的原文片段，用于展开预览 */
  content: string;
}

/** 本轮 Agent 调用过的一次业务工具（商品库 / 订单库 / 政策库） */
export interface ToolCallRef {
  /** 工具名，如 search_products */
  tool: string;
  /** 中文展示名，如 商品库 · 商品检索 */
  label: string;
  /** 调用参数，如 { keyword: '缓震跑鞋', max_price: 500 } */
  args: Record<string, unknown>;
  /** 结果摘要，如 命中 1 款：轻云 Pro 缓震跑鞋（¥499） */
  summary: string;
  /** 可逐条核对的明细（物流轨迹、订单商品等），前端可展开 */
  details?: string[] | null;
  /** 工具是否正常返回 */
  ok: boolean;
}

/** HITL 审批请求：写操作前由后端中断图执行并下发，用户确认后才继续 */
export interface ApprovalRequest {
  /** 恢复执行需要的检查点 ID */
  threadId: string;
  /** 待执行的工具名，如 create_escalation_ticket */
  action: string;
  /** 审批标题，如「创建人工工单需要确认」 */
  title: string;
  /** 待执行工具的参数 */
  args: Record<string, unknown>;
  /** 为什么需要人工确认 */
  reason: string;
  /** pending：等待决策；approved / rejected：已提交结果 */
  state: 'pending' | 'approved' | 'rejected';
}

/** 前端渲染用的聊天消息结构 */
export interface UIMessage {
  id: string;
  role: Role;
  /** 已累积的文本内容（流式过程中持续追加） */
  content: string;
  /** 是否正在流式输出中 */
  streaming?: boolean;
  /** 本轮 Token 消耗（流结束后由后端 usage 字段填充） */
  usage?: TokenUsage | null;
  /** 本轮回复耗时（毫秒，流结束后由后端 latency_ms 填充） */
  latencyMs?: number | null;
  /** 本轮命中的知识库来源（RAG 应用才会返回） */
  sources?: SourceRef[] | null;
  /** 本轮调用过的业务工具（数据库来源） */
  toolCalls?: ToolCallRef[] | null;
  /** 流式期间当前阶段文案（由后端 status 事件推送） */
  statusLabel?: string | null;
  /** 流式期间已走过的阶段（按先后顺序去重） */
  steps?: string[] | null;
  /** 写操作审批请求（HITL 中断时填充） */
  approval?: ApprovalRequest | null;
}

/** 调用后端 /api/chat/chat 的请求体（与 FastAPI schemas.ChatRequest 对齐） */
export interface ChatRequestBody {
  message: string;
  /** 会话 ID，第一阶段后端可从 JWT / Redis 维护；这里先透传 */
  session_id?: string | null;
  /** AI 应用标识，决定后端挂载哪个知识库与工具集 */
  app?: string;
}

/** 商品数据结构 */
export interface Product {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  /** 场景标签，如 跑步 / 篮球 / 休闲 */
  tags: string[];
  /** 一句话卖点 */
  scene: string;
  /** 详细描述，供本地演示兜底回复使用 */
  desc: string;
  /** 商品主图 */
  image: string;
}
