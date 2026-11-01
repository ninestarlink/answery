import type { ApprovalRequest, ChatRequestBody, SourceRef, TokenUsage, ToolCallRef } from './types';
import { buildMockReply } from './mockReply';

/**
 * SSE 流式聊天客户端
 * ----------------------------------------------------------------
 * 对接 FastAPI 后端：POST {API_BASE}/api/chat/chat
 * 后端使用 StreamingResponse(text/event-stream) 输出 Agent 事件。
 *
 * 兼容的 SSE 帧（每帧以 \n\n 分隔）：
 *   data: {"event":"message","answer":"文本片段"}
 *   data: {"event":"agent_message","answer":"文本片段"}
 *   data: {"answer":"文本片段"}                    // 简化格式
 *   data: {"content":"文本片段"}                    // 其它常见字段名
 *   data: {"event":"message_end","metadata":{"usage":{...}}}
 *   data: [DONE]
 *
 * 若后端不可达（连接被拒绝），自动降级为本地 Mock 逐字输出，
 * 保证没有后端时前端 Demo 也能完整演示。
 */
import { authHeaders } from './auth';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '') ?? '';

/** 本次回复数据来源：真实后端 / 本地演示兜底 */
export type StreamMode = 'api' | 'mock';

/** 后端已连上但返回了错误事件：属于真实故障，不能降级成本地演示数据 */
export class BackendStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendStreamError';
  }
}

/** 后端下发的执行阶段（AI 正在做什么） */
export interface StreamStatus {
  /** 阶段文案，如「正在检索知识库」 */
  label: string;
  /** 补充说明，如被调用的工具名 */
  detail?: string;
}

export interface StreamHandlers {
  /** 收到增量文本片段 */
  onToken: (chunk: string) => void;
  /** 收到执行阶段变化（检索 / 思考 / 调工具 / 生成回答） */
  onStatus?: (status: StreamStatus) => void;
  /** 收到 Token 用量 */
  onUsage?: (usage: TokenUsage) => void;
  /** 收到本轮回复耗时（毫秒） */
  onLatency?: (latencyMs: number) => void;
  /** 收到知识库检索来源（仅 RAG 应用返回） */
  onSources?: (sources: SourceRef[]) => void;
  /** 收到本轮调用过的业务工具（数据库来源） */
  onToolCalls?: (toolCalls: ToolCallRef[]) => void;
  /** 遇到写操作审批中断：本轮暂停，等用户点批准 / 拒绝 */
  onInterrupt?: (approval: ApprovalRequest) => void;
}

/** 从一帧 SSE 中解析出增量文本 / 结束标记 / Token 用量 / 审批中断 */
function parseFrame(rawFrame: string): {
  token: string;
  finished: boolean;
  status: StreamStatus | null;
  usage: TokenUsage | null;
  latencyMs: number | null;
  sources: SourceRef[] | null;
  toolCalls: ToolCallRef[] | null;
  approval: ApprovalRequest | null;
} {
  const result = {
    token: '',
    finished: false,
    status: null as StreamStatus | null,
    usage: null as TokenUsage | null,
    latencyMs: null as number | null,
    sources: null as SourceRef[] | null,
    toolCalls: null as ToolCallRef[] | null,
    approval: null as ApprovalRequest | null,
  };

  // 一帧内可能有多行 data:（标准 SSE），逐行处理
  const lines = rawFrame
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('data:'));

  for (const line of lines) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      result.finished = true;
      continue;
    }

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload);
    } catch {
      // 非 JSON 帧：直接当作纯文本片段
      result.token += payload;
      continue;
    }

    const event = typeof obj.event === 'string' ? obj.event : '';

    // 执行阶段：后端把检索 / 工具事件翻译成人话，前端据此显示「AI 正在做什么」
    if (event === 'status') {
      const label = typeof obj.label === 'string' ? obj.label.trim() : '';
      if (label) {
        result.status = {
          label,
          detail: typeof obj.detail === 'string' ? obj.detail : undefined,
        };
      }
      continue;
    }

    // 审批中断：图在写操作前暂停，前端据此弹出审批卡片
    if (event === 'interrupt') {
      const payload = (obj.payload ?? {}) as Record<string, unknown>;
      const threadId = typeof obj.thread_id === 'string' ? obj.thread_id : '';
      if (threadId) {
        result.approval = {
          threadId,
          action: String(payload.action ?? ''),
          title: String(payload.title ?? '写操作需要确认'),
          args:
            payload.args && typeof payload.args === 'object'
              ? (payload.args as Record<string, unknown>)
              : {},
          reason: String(payload.reason ?? ''),
          state: 'pending',
        };
      }
      result.finished = true;
      continue;
    }

    // 结束事件
    if (event === 'message_end' || event === 'agent_end') {
      result.finished = true;
    }
    if (event === 'error') {
      const msg =
        (obj.data as Record<string, unknown> | undefined)?.message ??
        obj.message ??
        '后端返回错误事件';
      throw new BackendStreamError(String(msg));
    }

    // 增量文本：后端字段 answer，同时兼容 text/content/delta/message
    const text =
      obj.answer ?? obj.text ?? obj.content ?? obj.delta ?? obj.message;
    if (typeof text === 'string' && text) {
      result.token += text;
    }

    // Token 用量：位于 metadata.usage，也兼容顶层 usage
    const usageSrc =
      (obj.metadata as Record<string, unknown> | undefined)?.usage ??
      (obj as Record<string, unknown>).usage;
    if (usageSrc && typeof usageSrc === 'object') {
      const u = usageSrc as Record<string, number>;
      result.usage = {
        prompt_tokens: Number(u.prompt_tokens ?? 0),
        completion_tokens: Number(u.completion_tokens ?? 0),
        total_tokens: Number(
          u.total_tokens ??
            Number(u.prompt_tokens ?? 0) + Number(u.completion_tokens ?? 0),
        ),
      };
    }
    // 本轮耗时：后端在 message_end.metadata.latency_ms 中下发
    const latencySrc = (obj.metadata as Record<string, unknown> | undefined)
      ?.latency_ms;
    if (typeof latencySrc === 'number' && latencySrc > 0) {
      result.latencyMs = Math.round(latencySrc);
    }
    // 知识库来源：后端在 message_end 里透传检索证据链
    if (Array.isArray(obj.sources) && obj.sources.length > 0) {
      result.sources = (obj.sources as Array<Record<string, unknown>>)
        .filter((s) => typeof s?.document_name === 'string')
        .map((s) => ({
          document_name: String(s.document_name),
          score: Number(s.score ?? 0),
          content: String(s.content ?? ''),
        }));
    }
    // 数据库来源：后端解析出的工具调用
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      result.toolCalls = (obj.tool_calls as Array<Record<string, unknown>>)
        .filter((c) => typeof c?.tool === 'string')
        .map((c) => ({
          tool: String(c.tool),
          label: String(c.label ?? c.tool),
          args:
            c.args && typeof c.args === 'object'
              ? (c.args as Record<string, unknown>)
              : {},
          summary: String(c.summary ?? ''),
          details: Array.isArray(c.details)
            ? (c.details as unknown[]).map((d) => String(d)).filter(Boolean)
            : [],
          ok: c.ok !== false,
        }));
    }
  }

  return result;
}

/** 读取 ReadableStream，按 SSE 协议分帧并回调 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  /** 收到 message_end 后不再解析，但仍把响应读完，避免主动 cancel 在控制台留下 ERR_ABORTED */
  let finished = false;

  const drain = () => {
    // SSE 事件以空行（\n\n）分隔
    let sepIndex: number;
    while ((sepIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      // 跳过实际分隔符长度（兼容 \n\n 与 \r\n\r\n）
      buffer = buffer.slice(sepIndex).replace(/^(\r?\n){2}/, '');

      const parsed = parseFrame(frame);
      if (parsed.status) handlers.onStatus?.(parsed.status);
      if (parsed.token) handlers.onToken(parsed.token);
      if (parsed.usage) handlers.onUsage?.(parsed.usage);
      if (parsed.latencyMs != null) handlers.onLatency?.(parsed.latencyMs);
      if (parsed.sources) handlers.onSources?.(parsed.sources);
      if (parsed.toolCalls) handlers.onToolCalls?.(parsed.toolCalls);
      if (parsed.approval) handlers.onInterrupt?.(parsed.approval);
      if (parsed.finished) finished = true;
    }
  };

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
    if (finished) buffer = '';
  }
  if (finished) return;
  // 处理尾部残留帧
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseFrame(buffer);
    if (parsed.status) handlers.onStatus?.(parsed.status);
    if (parsed.token) handlers.onToken(parsed.token);
    if (parsed.usage) handlers.onUsage?.(parsed.usage);
    if (parsed.latencyMs != null) handlers.onLatency?.(parsed.latencyMs);
    if (parsed.sources) handlers.onSources?.(parsed.sources);
    if (parsed.toolCalls) handlers.onToolCalls?.(parsed.toolCalls);
    if (parsed.approval) handlers.onInterrupt?.(parsed.approval);
  }
}

/** 简单的可中断延时 */
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * 本地 Mock 流式输出：把整段 Markdown 按 2~4 个字符切片，
 * 模拟打字机效果，并给出估算 Token 用量。
 */
async function streamMock(
  userMessage: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const fullText = buildMockReply(userMessage);
  const started = Date.now();

  // 模拟 Agent 调用工具前的短暂"思考"
  handlers.onStatus?.({ label: '正在思考中' });
  await delay(350, signal);
  handlers.onStatus?.({ label: '正在检索知识库' });
  await delay(500, signal);
  handlers.onStatus?.({ label: '正在生成回答' });

  let i = 0;
  while (i < fullText.length) {
    const step = 2 + Math.floor(Math.random() * 3); // 2~4 个字符一片
    handlers.onToken(fullText.slice(i, i + step));
    i += step;
    // Markdown 表格/换行处稍作停顿，观感更自然
    const ch = fullText[i - 1];
    await delay(ch === '\n' ? 40 : 18 + Math.random() * 22, signal);
  }

  // 粗略估算：中文约 1.5 字/Token，英文约 4 字符/Token，这里只做演示展示
  const promptTokens = Math.max(1, Math.ceil(userMessage.length / 1.5));
  const completionTokens = Math.max(1, Math.ceil(fullText.length / 1.5));
  handlers.onUsage?.({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  });
  handlers.onLatency?.(Date.now() - started);
}

/**
 * 发送聊天消息并消费流式响应。
 * @returns 实际数据来源（api / mock），前端据此显示连接状态
 */
export async function streamChat(
  body: ChatRequestBody,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<StreamMode> {
  try {
    const resp = await fetch(`${API_BASE}/api/chat/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`后端响应异常：HTTP ${resp.status}`);
    }

    await consumeSse(resp.body, handlers, signal);
    return 'api';
  } catch (err) {
    // 用户主动停止：继续向上抛出，不降级
    if (err instanceof DOMException && err.name === 'AbortError') throw err;

    // 后端已连上但执行失败（模型停用、额度用尽等）：如实报错，不能伪装成正常回答
    if (err instanceof BackendStreamError) throw err;

    // 非电商应用不提供本地演示数据，避免答非所问
    if (body.app !== 'ecommerce') {
      throw new Error('无法连接 AI 服务，请稍后重试。');
    }

    // 电商应用在后端未启动时降级到本地演示模式
    console.warn(
      '[chatStream] 后端不可达，启用本地演示模式（Mock）。原因：',
      err instanceof Error ? err.message : err,
    );
    await streamMock(body.message, handlers, signal);
    return 'mock';
  }
}

/** HITL 审批结果提交：带着中断时的 thread_id 让后端继续跑完这轮 */
export async function resumeChat(
  threadId: string,
  approved: boolean,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  by = '管理员',
): Promise<void> {
  const resp = await fetch(`${API_BASE}/api/chat/resume`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...authHeaders(),
    },
    body: JSON.stringify({ thread_id: threadId, approved, by }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    throw new BackendStreamError(`审批提交失败：HTTP ${resp.status}`);
  }
  await consumeSse(resp.body, handlers, signal);
}
