'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import MessageBubble from './MessageBubble';
import {
  resumeChat,
  streamChat,
  type StreamHandlers,
  type StreamMode,
} from '@/lib/chatStream';
import {
  abortChat,
  appendChatContent,
  clearChatController,
  getChatSession,
  getChatSessionServerSnapshot,
  patchChatMessage,
  resetChatSession,
  setChatController,
  subscribeChatSession,
  updateChatSession,
} from '@/lib/chatSession';
import type { UIMessage } from '@/lib/types';

/** 暴露给父组件（页面）的方法：商品点击后由 Sidebar 驱动发问 */
export interface ChatHandle {
  ask: (text: string) => void;
  newChat: () => void;
}

/** 主题：Vantage 只有一个信号色，两套场景共用青柠 */
const ACCENTS = {
  indigo: {
    orb: 'from-accent to-accent',
    glow: 'from-accent/0 to-accent/0',
    halo: 'shadow-none',
    send: 'from-accent to-accent',
    sendShadow: 'shadow-none',
    dot: 'bg-brand-50 text-accent',
    pulse: 'bg-accent',
  },
  emerald: {
    orb: 'from-accent to-accent',
    glow: 'from-accent/0 to-accent/0',
    halo: 'shadow-none',
    send: 'from-accent to-accent',
    sendShadow: 'shadow-none',
    dot: 'bg-brand-50 text-accent',
    pulse: 'bg-accent',
  },
} as const;

let idSeq = 0;
const nextId = () => `${Date.now()}-${idSeq++}`;

export interface ChatProps {
  /** 移动端打开侧边栏抽屉；单窗口页面不传，顶栏就不显示菜单按钮 */
  onOpenSidebar?: () => void;
  /** 应用标识：电商客服 / 企业知识库 */
  app?: 'ecommerce' | 'enterprise' | 'auto';
  title?: string;
  subtitle?: string;
  placeholder?: string;
  quickQuestions?: { icon: string; text: string }[];
  emptyTitle?: string;
  emptyDesc?: string;
  emptyHint?: string;
  accent?: keyof typeof ACCENTS;
}

const Chat = forwardRef<ChatHandle, ChatProps>(function Chat(
  {
    onOpenSidebar,
    app = 'ecommerce',
    title = 'AI 导购助手',
    subtitle = '知识库检索 · 工具调用 · 流式回答',
    placeholder = '问问我：哪款鞋适合跑步？或查询订单物流……',
    quickQuestions = [],
    emptyTitle = '你好，我是 AnswerY 智能客服',
    emptyDesc = '',
    emptyHint = '',
    accent = 'indigo',
  },
  ref,
) {
  const theme = ACCENTS[accent];
  // 会话数据放在模块级 store：切到别的页面再切回来，聊天记录与进行中的流都还在
  const session = useSyncExternalStore(
    subscribeChatSession,
    () => getChatSession(app),
    getChatSessionServerSnapshot,
  );
  const { messages, streaming, live, mode } = session;
  const [input, setInput] = useState('');
  /** 流式期间每 100ms 触发一次重渲染，让「已等待 X 秒」持续走动 */
  const [now, setNow] = useState(() => Date.now());

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const elapsedMs =
    streaming && session.startedAt ? Math.max(0, now - session.startedAt) : 0;

  useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [streaming]);

  /** 新消息或内容增量时自动滚动到底部；流式期间用即时滚动，避免平滑动画被反复打断而落后 */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming]);

  /** 输入框随内容自适应高度 */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  /** 追加/修改指定的助手消息（流式期间高频调用） */
  const patchAssistant = useCallback(
    (id: string, patch: Partial<UIMessage>) => {
      patchChatMessage(app, id, patch);
    },
    [app],
  );

  /**
   * 消费一条 SSE 流并渲染到指定助手消息上。
   * 首次提问、审批恢复都走这里，保证打字机、状态、收尾行为完全一致。
   */
  const runAssistantStream = useCallback(
    async (
      assistantId: string,
      starter: (handlers: StreamHandlers, signal: AbortSignal) => Promise<void>,
    ) => {
      const controller = new AbortController();
      setChatController(app, controller);

      // ---- 打字机渲染 ----
      // SSE 的文本片段是按批到达的（同一微任务里可能连着 5~10 帧），直接 append
      // 会一次性刷出一大段，看起来像「突然全出来」。这里先入队，再每 28ms 吐一次；
      // 队列越长单次吐得越多，既平滑又不会越积越远。
      let queue = '';
      let streamDone = false;
      let typing = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      let resolveDrained: () => void = () => {};
      let drainedResolved = false;
      const whenDrained = new Promise<void>((resolve) => {
        resolveDrained = resolve;
      });

      const stopTyping = () => {
        if (timer) clearInterval(timer);
        timer = null;
      };

      const markDrained = () => {
        if (drainedResolved) return;
        drainedResolved = true;
        resolveDrained();
      };

      const startTyping = () => {
        if (timer) return;
        timer = setInterval(() => {
          if (!queue) {
            if (streamDone) {
              stopTyping();
              markDrained();
            }
            return;
          }
          // 每 tick 吐掉队列的 1/5（至少 2 字）：队列短时接近匀速，
          // 积压多时快速追上，避免结尾几个字要磨很久才显示完
          const step = Math.max(2, Math.ceil(queue.length / 5));
          const chunk = queue.slice(0, step);
          queue = queue.slice(step);
          appendChatContent(app, assistantId, chunk);
          if (!typing) {
            typing = true;
            const cur = getChatSession(app).live;
            if (cur && cur.id === assistantId) {
              updateChatSession(app, { live: { ...cur, label: '正在生成回答' } });
            }
          }
        }, 28);
      };

      try {
        await starter(
          {
            // 文本片段先入打字机队列，由定时器匀速吐到气泡里
            onToken: (chunk) => {
              queue += chunk;
              startTyping();
            },
            // 后端推送的执行阶段：知识检索 / 判断问题 / 调工具 / 生成回答
            onStatus: (status) => {
              const cur = getChatSession(app).live;
              const steps =
                cur && cur.id === assistantId && cur.steps.length > 0
                  ? cur.steps[cur.steps.length - 1] === status.label
                    ? cur.steps
                    : [...cur.steps, status.label].slice(-5)
                  : [status.label];
              updateChatSession(app, {
                live: {
                  id: assistantId,
                  label: status.label,
                  detail: status.detail,
                  steps,
                },
              });
            },
            onUsage: (usage) => patchAssistant(assistantId, { usage }),
            onLatency: (latencyMs) => patchAssistant(assistantId, { latencyMs }),
            onSources: (sources) => patchAssistant(assistantId, { sources }),
            onToolCalls: (toolCalls) => patchAssistant(assistantId, { toolCalls }),
            // 写操作前人工闸门：先把审批卡片挂到这条消息上
            onInterrupt: (approval) => patchAssistant(assistantId, { approval }),
          },
          controller.signal,
        );
      } catch (err) {
        // 出错 / 中断时不再排队，直接把残留丢掉
        queue = '';
        stopTyping();
        if (err instanceof DOMException && err.name === 'AbortError') {
          patchAssistant(assistantId, {
            content: '_（已停止生成）',
          });
        } else {
          const message =
            err instanceof Error ? err.message : '无法连接到 AI 服务。';
          patchAssistant(assistantId, {
            content: `**请求失败**\n\n${message}`,
          });
        }
      } finally {
        // 等最后一段吐完再收尾，避免结尾几个字一次性蹦出来
        streamDone = true;
        if (queue) {
          await whenDrained;
        } else {
          stopTyping();
          markDrained();
        }
        patchAssistant(assistantId, { streaming: false });
        updateChatSession(app, { streaming: false, live: null });
        clearChatController(app);
      }
    },
    [app, patchAssistant],
  );

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || getChatSession(app).streaming) return;

      const assistantId = nextId();
      const prev = getChatSession(app);
      updateChatSession(app, {
        messages: [
          ...prev.messages,
          { id: nextId(), role: 'user', content: text },
          { id: assistantId, role: 'assistant', content: '', streaming: true },
        ],
        streaming: true,
        startedAt: Date.now(),
        // 立即进入「思考中」状态，避免用户对着空气干等
        live: { id: assistantId, label: '正在思考中', steps: [] },
      });
      setInput('');

      await runAssistantStream(assistantId, async (handlers, signal) => {
        const usedMode = await streamChat({ message: text, app }, handlers, signal);
        updateChatSession(app, { mode: usedMode });
      });
    },
    [app, runAssistantStream],
  );

  /** 审批回调：带着 thread_id 让后端继续跑，结果追加到同一条助手消息 */
  const resolveApproval = useCallback(
    async (assistantId: string, approved: boolean) => {
      if (getChatSession(app).streaming) return;
      const target = getChatSession(app).messages.find((m) => m.id === assistantId);
      const approval = target?.approval;
      if (!approval || approval.state !== 'pending') return;

      patchAssistant(assistantId, {
        approval: { ...approval, state: approved ? 'approved' : 'rejected' },
      });
      updateChatSession(app, {
        streaming: true,
        startedAt: Date.now(),
        live: {
          id: assistantId,
          label: approved ? '已批准，正在创建工单' : '已拒绝，正在调整方案',
          steps: [],
        },
      });

      await runAssistantStream(assistantId, (handlers, signal) =>
        resumeChat(approval.threadId, approved, handlers, signal),
      );
    },
    [app, patchAssistant, runAssistantStream],
  );

  const newChat = useCallback(() => {
    abortChat(app);
    resetChatSession(app);
    setInput('');
  }, [app]);

  useImperativeHandle(ref, () => ({ ask, newChat }), [ask, newChat]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行；
    // nativeEvent.isComposing 为 true 时表示正在用中文输入法选词，不能抢回车
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(input);
    }
  };

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      {/* 顶栏：毛玻璃 + 极细描边 */}
      <header className="relative z-20 flex h-[60px] shrink-0 items-center justify-between gap-3 border-b border-rule bg-paper-2 px-3.5 backdrop-blur-xl md:px-7">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-brand-200/70 to-transparent"
        />
        <div className="flex min-w-0 items-center gap-2.5">
          {/* 移动端菜单：只有存在侧边栏时才显示 */}
          {onOpenSidebar && (
            <button
              onClick={onOpenSidebar}
              aria-label="打开侧边栏"
              className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] bg-paper-2 text-slate-600 hairline md:hidden"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]">
                <path d="M3 5.25a.75.75 0 01.75-.75h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 5.25zM3 10a.75.75 0 01.75-.75h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 10zm.75 4a.75.75 0 000 1.5h12.5a.75.75 0 000-1.5H3.75z" />
              </svg>
            </button>
          )}

          <div
            className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] bg-gradient-to-br ${theme.orb} md:hidden`}
          >
            <span className="h-2 w-2 rounded-[2px] bg-paper-2" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14.5px] font-semibold tracking-tight-ios text-slate-900">
                {title}
              </span>
              <StatusBadge mode={mode} streaming={streaming} />
            </div>
            <div className="mt-0.5 hidden truncate text-[12px] text-slate-500 sm:block">
              {subtitle}
            </div>
          </div>
        </div>

        <button
          onClick={newChat}
          className="press flex shrink-0 items-center gap-1.5 rounded-[2px] bg-paper-2 px-3 py-1.5 text-[13px] font-medium text-slate-600 hairline hover:bg-paper-2"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-slate-600">
            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
          </svg>
          <span className="hidden sm:inline">新对话</span>
        </button>
      </header>

      {/* 消息列表 */}
      <div
        ref={scrollRef}
        className="nice-scroll relative flex-1 overflow-y-auto px-3.5 pb-4 pt-6 md:px-7"
      >
        {/* 对话区底纹：实测点阵 */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="dot-grid absolute inset-0 opacity-30" />
        </div>
        <div className="relative mx-auto w-full max-w-[820px] space-y-5">
          {messages.length === 0 ? (
            <EmptyState
              onPick={(q) => void ask(q)}
              disabled={streaming}
              quickQuestions={quickQuestions}
              title={emptyTitle}
              desc={emptyDesc}
              hint={emptyHint}
            />
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                app={app}
                live={live?.id === m.id ? live : null}
                elapsedMs={live?.id === m.id ? elapsedMs : 0}
                onResolveApproval={(approved) => void resolveApproval(m.id, approved)}
              />
            ))
          )}
        </div>
      </div>

      {/* 输入区：悬浮胶囊 + 顶部渐隐 */}
      <div className="relative z-10 shrink-0 px-3.5 pb-safe pt-2 md:px-7 md:pb-5">
        <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-canvas to-transparent" />
        <div className="mx-auto w-full max-w-[820px]">
          <div className="flex items-end gap-2 rounded-[2px] border border-rule bg-paper-2 p-1.5 pl-4 transition-all focus-within:border-accent/70 focus-within:ring-1 focus-within:ring-accent/30">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={placeholder}
              className="nice-scroll max-h-40 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-slate-800 outline-none placeholder:text-slate-500"
            />
            {streaming ? (
              <button
                onClick={() => abortChat(app)}
                className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-[2px] bg-paper-3 text-ink hairline"
                title="停止生成"
              >
                <span className="h-3 w-3 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                onClick={() => void ask(input)}
                disabled={!input.trim()}
                className={`press flex h-10 w-10 shrink-0 items-center justify-center rounded-[2px] bg-accent text-accent-ink enabled:hover:bg-accent-hi disabled:bg-paper-3 disabled:text-muted`}
                title="发送（Enter）"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]">
                  <path d="M9.25 3.5a.75.75 0 011.5 0v9.19l2.72-2.72a.75.75 0 111.06 1.06l-4 4a.75.75 0 01-1.06 0l-4-4a.75.75 0 111.06-1.06l2.72 2.72V3.5z" transform="rotate(180 10 10)" />
                </svg>
              </button>
            )}
          </div>
          <div className="mt-2 hidden text-center text-[12px] text-slate-500 sm:block">
            Enter 发送 · Shift + Enter 换行 · 回复由 Agent 流式生成
          </div>
          <div className="mt-1.5 text-center text-[11.5px] text-slate-400 sm:hidden">
            AI 生成内容仅供参考
          </div>
        </div>
      </div>
    </section>
  );
});

/** 顶栏连接状态徽标 */
function StatusBadge({
  mode,
  streaming,
}: {
  mode: StreamMode | null;
  streaming: boolean;
}) {
  if (streaming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[2px] bg-brand-50 px-2 py-0.5 text-[11.5px] font-medium text-brand-600">
        <span className="h-1.5 w-1.5 animate-pulse rounded-[2px] bg-brand-500" />
        生成中
      </span>
    );
  }
  if (mode === 'api') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[2px] bg-emerald-50 px-2 py-0.5 text-[11.5px] font-medium text-emerald-600">
        <span className="h-1.5 w-1.5 rounded-[2px] bg-emerald-500" />
        已连接
      </span>
    );
  }
  if (mode === 'mock') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[2px] bg-amber-50 px-2 py-0.5 text-[11.5px] font-medium text-amber-600">
        <span className="h-1.5 w-1.5 rounded-[2px] bg-amber-500" />
        演示模式
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[2px] bg-slate-100 px-2 py-0.5 text-[11.5px] font-medium text-slate-600">
      <span className="h-1.5 w-1.5 rounded-[2px] bg-slate-400" />
      待连接
    </span>
  );
}

/** 空对话欢迎区：品牌问候 + 快捷问题 */
function EmptyState({
  onPick,
  disabled,
  quickQuestions,
  title,
  desc,
  hint,
}: {
  onPick: (q: string) => void;
  disabled: boolean;
  quickQuestions: { icon: string; text: string }[];
  title: string;
  desc: string;
  hint: string;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-230px)] flex-col justify-center py-4 text-center">
      {/* 应用图标式题花：白卡托一枚暖橙字母 */}
      <div className="mx-auto flex flex-col items-center">
        <div className="flex items-center gap-2 text-[11px] tracking-[0.08em] text-muted">
          AnswerY · 智能客服
        </div>
        <div className="mt-5 flex h-16 w-16 items-center justify-center rounded-[2px] bg-paper-2 shadow-lift">
          <span className="text-[30px] font-semibold leading-none text-accent">A</span>
        </div>
      </div>

      <h1 className="mx-auto mt-6 max-w-lg px-4 text-[27px] leading-[1.25] tracking-[-0.022em] text-slate-900 sm:text-[34px]">
        {title}
      </h1>
      {desc && (
        <p className="mx-auto mt-3 max-w-md px-4 text-[13.5px] leading-[1.7] text-slate-600">
          {desc}
        </p>
      )}

      {quickQuestions.length > 0 && (
        <div className="mx-auto mt-8 grid w-full max-w-xl grid-cols-1 gap-2.5 px-2 sm:grid-cols-2">
        {quickQuestions.map((q, i) => (
          <button
            key={q.text}
            disabled={disabled}
            onClick={() => onPick(q.text)}
            style={{ animationDelay: `${i * 60}ms` }}
            className="press group flex animate-fade-up items-center gap-2.5 rounded-[2px] border border-rule bg-paper-2 px-3.5 py-3 text-left text-[13.5px] text-slate-700 transition hover:-translate-y-0.5 hover:border-accent/60 hover:bg-paper-3 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] bg-paper-3 text-base">
              {q.icon}
            </span>
            <span className="flex-1">{q.text}</span>
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500"
            >
              <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
            </svg>
          </button>
        ))}
        </div>
      )}

      {hint && (
        <p className="mt-6 inline-flex items-center justify-center gap-1.5 text-[12px] text-slate-500">
          <span className="h-1.5 w-1.5 rounded-[2px] bg-accent" />
          {hint}
        </p>
      )}
    </div>
  );
}

export default Chat;
