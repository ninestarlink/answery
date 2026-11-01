'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalRequest, SourceRef, ToolCallRef, UIMessage } from '@/lib/types';

/** 去掉文件名里的排序前缀与扩展名，便于阅读 */
const prettyName = (name: string) =>
  name.replace(/^\d+_/, '').replace(/\.(pdf|docx|xlsx|xls|md|txt)$/i, '');

/** 把工具参数压成 key=value 的一行，便于核对查了什么 */
const formatArgs = (args: Record<string, unknown>) => {
  const pairs = Object.entries(args).map(([k, v]) => `${k}=${String(v)}`);
  return pairs.length > 0 ? pairs.join('，') : '无参数';
};

/** 毫秒转秒，保留一位小数，便于直观感受响应速度 */
const formatLatency = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/**
 * 模型总结时经常把正文和链接粘在一起，比如
 * `https://www.python.org**），提供下载……`、`…/weekly-issue-415.html）。`，
 * 浏览器会把这串内容当成路径，点开就是 404。
 * 这里只保留 URL 本身：遇到空白或全角标点就截断，再剥掉尾部残留。
 */
function urlCutIndex(raw: string): number {
  const hit = raw.search(/[\s\u3000-\u303F\uFF00-\uFFEF]/);
  return hit === -1 ? raw.length : hit;
}

function cleanHref(raw: string): string {
  // react-markdown 会把自动识别的链接做百分号编码（中文标点变成 %EF%BC%89），先还原再处理
  let url = raw.trim();
  try {
    url = decodeURIComponent(url);
  } catch {
    // 非法编码时保留原样，后续只做尾部清理
  }
  const cut = urlCutIndex(url);
  if (cut < url.length) url = url.slice(0, cut);
  let prev = '';
  // 尾部可能层层粘连（如 `**）`），反复剥离直到稳定
  while (url !== prev) {
    prev = url;
    url = url.replace(/[）】》」』”’"'。，、；：！？]+$/g, '');
    url = url.replace(/\*+$/g, '');
    url = url.replace(/\)\.?\/$/, '/');
    url = url.replace(/\)\.$/, '');
    if (url.endsWith(')')) {
      // 成对的括号是合法路径（如 Wikipedia 词条），只去掉落单的右括号
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) url = url.slice(0, -1);
    }
    url = url.replace(/[.,;:!?]+$/g, '');
  }
  return url;
}

/**
 * 单条消息气泡
 * - 用户：右侧，品牌渐变
 * - 助手：左侧，毛玻璃白底 + 渐变头像
 */
export default function MessageBubble({
  message,
  app,
  live,
  elapsedMs = 0,
  onResolveApproval,
}: {
  message: UIMessage;
  app?: string;
  /** 流式期间的执行状态（当前阶段 + 已走过的阶段） */
  live?: { label: string; detail?: string; steps: string[] } | null;
  /** 流式期间已等待的毫秒数 */
  elapsedMs?: number;
  /** 审批按钮回调：true 批准执行，false 拒绝 */
  onResolveApproval?: (approved: boolean) => void;
}) {
  const isUser = message.role === 'user';
  const isStreaming = message.streaming;
  const empty = !message.content;

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-up">
        <div className="max-w-[85%] rounded-[22px] rounded-br-[8px] bg-gradient-to-br from-brand-600 via-indigo-500 to-violet-500 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-[0_12px_30px_-14px_rgba(79,70,229,0.95)] ring-1 ring-white/15 sm:max-w-[75%]">
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 animate-fade-up">
      {/* 助手头像 */}
      <div className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 via-indigo-500 to-violet-500 text-white shadow-[0_8px_18px_-8px_rgba(99,102,241,0.9)] ring-1 ring-white/60">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
          <path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
        </svg>
        <span className="absolute -inset-0.5 -z-10 rounded-full bg-indigo-400/50 blur-md" />
      </div>

      <div className="min-w-0 flex-1">
        {/* 仅等待审批、还没有正文时，不渲染空气泡 */}
        {!(empty && !isStreaming && message.approval) && (
        <div className="inline-block max-w-full rounded-[22px] rounded-bl-[8px] border border-white/80 bg-white/90 px-4 py-2.5 shadow-bubble backdrop-blur-sm sm:max-w-[88%]">
          {empty && isStreaming ? (
            <LiveStatus live={live} elapsedMs={elapsedMs} />
          ) : (
            <div className="md-body">
              {isStreaming && live && (
                <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inset-0 animate-ping rounded-full bg-brand-400/70" />
                    <span className="relative h-2 w-2 rounded-full bg-brand-500" />
                  </span>
                  <span className="text-brand-600">{live.label}</span>
                  <span className="tabular-nums text-slate-400">
                    已 {formatLatency(elapsedMs)}
                  </span>
                </div>
              )}
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => {
                    const url = cleanHref(href ?? '');
                    // 链接把后面的正文一起吞进来时，把尾巴拆回普通文本，避免整句变成可点击链接
                    if (
                      typeof children === 'string' &&
                      /^https?:\/\//i.test(children)
                    ) {
                      const cut = urlCutIndex(children);
                      if (cut > 0 && cut < children.length) {
                        return (
                          <>
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {cleanHref(children.slice(0, cut))}
                            </a>
                            {children.slice(cut)}
                          </>
                        );
                      }
                    }
                    return (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
              {isStreaming && <span className="typing-cursor" aria-hidden />}
            </div>
          )}
        </div>
        )}

        {message.approval && (
          <ApprovalCard
            approval={message.approval}
            disabled={!!message.streaming}
            onResolve={onResolveApproval}
          />
        )}

        {message.sources && message.sources.length > 0 && (
          <SourceList sources={message.sources} />
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallList calls={message.toolCalls} />
        )}

        {shouldWarnUngrounded(message, app) && (
          <div className="mt-1.5 flex max-w-full items-start gap-1.5 rounded-xl bg-amber-50/85 px-2.5 py-1.5 hairline">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="mt-0.5 h-3 w-3 shrink-0 text-amber-600"
            >
              <path d="M12 9v4m0 4h.01M10.3 3.9L2.6 17.4A1.5 1.5 0 003.9 19.7h16.2a1.5 1.5 0 001.3-2.3L13.7 3.9a1.5 1.5 0 00-2.6 0z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-[11.5px] leading-4 text-amber-700">
              本轮未命中知识库、也未调用数据库，内容由模型自身生成，请以实际查询结果为准。
            </span>
          </div>
        )}

        {(message.usage || message.latencyMs != null) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-1 text-[13px] font-medium text-slate-500">
            {message.usage && (
              <>
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="2">
                  <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10.5H13l1-8.5z" strokeLinejoin="round" />
                </svg>
                <span>{message.usage.total_tokens} tokens</span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-400">
                  入 {message.usage.prompt_tokens} / 出 {message.usage.completion_tokens}
                </span>
              </>
            )}
            {message.latencyMs != null && (
              <>
                {message.usage && <span className="text-slate-400">·</span>}
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3.5 2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="tabular-nums">用时 {formatLatency(message.latencyMs)}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 「AI 正在做什么」状态卡
 * 模仿 DeepSeek 网页端：当前阶段 + 已走过的步骤 + 实时计时，
 * 让等待过程可见，而不是只转三个点。
 */
function LiveStatus({
  live,
  elapsedMs,
}: {
  live?: { label: string; detail?: string; steps: string[] } | null;
  elapsedMs: number;
}) {
  const current = live?.label ?? '正在思考';
  const doneSteps = (live?.steps ?? []).filter((s) => s !== current);

  return (
    <div className="min-w-[190px] py-0.5">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-400/70" />
          <span className="relative h-2 w-2 rounded-full bg-brand-500" />
        </span>
        <span className="text-[13.5px] font-medium text-slate-700">
          {current}
        </span>
        {live?.detail && (
          <span className="max-w-[120px] truncate text-[11.5px] text-slate-400">
            {live.detail}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-3 text-[11.5px] font-medium tabular-nums text-slate-400">
          已 {formatLatency(elapsedMs)}
        </span>
      </div>

      {doneSteps.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-[15px]">
          {doneSteps.map((step, i) => (
            <li
              key={`${step}-${i}`}
              className="flex items-center gap-1.5 text-[11.5px] leading-4 text-slate-400"
            >
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3 w-3 shrink-0 text-emerald-500"
              >
                <path d="M16.7 5.3a.75.75 0 010 1.06l-7.5 7.5a.75.75 0 01-1.06 0L4.3 10.1a.75.75 0 111.06-1.06l3.24 3.24 6.97-6.97a.75.75 0 011.06 0z" />
              </svg>
              <span className="truncate">{step}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 仅当这轮既没命中知识库、也没调用业务工具时给出提醒。
 * 短回复（寒暄、确认）不提示，避免干扰。
 */
function shouldWarnUngrounded(message: UIMessage, app?: string) {
  if (message.role !== 'assistant' || message.streaming) return false;
  if (!app) return false;
  if (!message.content || message.content.length < 40) return false;
  return !(message.sources && message.sources.length) &&
    !(message.toolCalls && message.toolCalls.length);
}

/** 写操作工具的中文名，审批卡直接给人看人话 */
const ACTION_LABELS: Record<string, string> = {
  create_escalation_ticket: '创建人工工单',
};

/**
 * 写操作审批卡（HITL）
 * 图在不可逆写操作前暂停，用户确认后才继续；拒绝则让模型改走自助方案。
 */
function ApprovalCard({
  approval,
  disabled,
  onResolve,
}: {
  approval: ApprovalRequest;
  disabled: boolean;
  onResolve?: (approved: boolean) => void;
}) {
  const pending = approval.state === 'pending';
  const actionLabel = ACTION_LABELS[approval.action] ?? approval.action;
  const stateText =
    approval.state === 'approved'
      ? '已批准，正在执行'
      : approval.state === 'rejected'
        ? '已拒绝，已改为自助方案'
        : '等待确认';

  return (
    <div className="mt-2 max-w-full rounded-2xl border border-amber-200/80 bg-amber-50/75 p-3 sm:max-w-[88%]">
      <div className="flex items-center gap-1.5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-3.5 w-3.5 shrink-0 text-amber-600"
        >
          <path
            d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9.5-4.1-1.9-7-5.3-7-9.5V6l7-3zM12 9v4m0 3h.01"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-[12.5px] font-semibold text-amber-800">
          {approval.title || '写操作需要确认'}
        </span>
        {!pending && (
          <span className="ml-auto shrink-0 rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            {stateText}
          </span>
        )}
      </div>

      <div className="mt-2 space-y-1 text-[11.5px] leading-5 text-slate-600">
        <div>
          <span className="text-slate-400">动作：</span>
          <span className="font-medium text-slate-700">{actionLabel}</span>
        </div>
        <div className="break-words">
          <span className="text-slate-400">参数：</span>
          <span>{formatArgs(approval.args)}</span>
        </div>
        {approval.reason && (
          <div className="text-slate-500">
            <span className="text-slate-400">原因：</span>
            {approval.reason}
          </div>
        )}
      </div>

      {pending && (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onResolve?.(true)}
            className="press flex-1 rounded-full bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white enabled:hover:bg-slate-800 disabled:opacity-50"
          >
            批准执行
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onResolve?.(false)}
            className="press flex-1 rounded-full bg-white/85 px-3 py-1.5 text-[12px] font-medium text-slate-600 hairline enabled:hover:bg-white disabled:opacity-50"
          >
            拒绝，改自助方案
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 数据库来源卡片
 * 展示本轮 Agent 实际调用过的业务工具、入参与返回摘要，
 * 用来证明答案来自商品库 / 订单库 / 政策库，而不是模型记忆。
 */
function ToolCallList({ calls }: { calls: ToolCallRef[] }) {
  return (
    <div className="mt-1.5 max-w-full rounded-2xl bg-white/55 p-1.5 hairline">
      <div className="flex items-center gap-1 px-1.5 pt-0.5 pb-1 text-[11.5px] font-medium text-slate-500">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
          <path d="M12 3c4.42 0 8 1.34 8 3s-3.58 3-8 3-8-1.34-8-3 3.58-3 8-3zm8 8.5c0 1.66-3.58 3-8 3s-8-1.34-8-3v-2c1.7 1.28 4.74 2 8 2s6.3-.72 8-2v2z" />
        </svg>
        <span>数据来源 · {calls.length}</span>
      </div>

      <div className="space-y-0.5">
        {calls.map((c, i) => (
          <ToolCallRow key={`${c.tool}-${i}`} call={c} index={i} />
        ))}
      </div>
    </div>
  );
}

/** 单次工具调用：摘要常驻，查到的明细可展开逐条核对 */
function ToolCallRow({ call, index }: { call: ToolCallRef; index: number }) {
  const [open, setOpen] = useState(false);
  const details = call.details ?? [];
  const hasDetails = details.length > 0;

  return (
    <div className="rounded-xl bg-white/70 hairline">
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left disabled:cursor-default"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${call.ok ? 'bg-emerald-500' : 'bg-rose-400'}`}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-700">
          {call.label}
        </span>
        {hasDetails && (
          <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-slate-500">
            明细 {details.length}
          </span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
          第 {index + 1} 次
        </span>
        {hasDetails && (
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
          </svg>
        )}
      </button>

      <div className="truncate px-2 pb-1 pl-3 text-[11px] text-slate-500">
        {formatArgs(call.args)}
      </div>
      <div className="px-2 pb-1.5 pl-3 text-[11.5px] leading-4 text-slate-600">
        {call.summary}
      </div>

      {open && hasDetails && (
        <ul className="space-y-1 border-t border-white/80 px-2 py-1.5 pl-3">
          {details.map((d, i) => (
            <li key={`${d}-${i}`} className="flex gap-1.5 text-[11px] leading-4 text-slate-500">
              <span className="shrink-0 tabular-nums text-slate-400">{i + 1}.</span>
              <span className="min-w-0 break-words">{d}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceList({ sources }: { sources: SourceRef[] }) {
  const [openName, setOpenName] = useState<string | null>(null);

  return (
    <div className="mt-2 max-w-full rounded-2xl bg-white/55 p-2.5 hairline">
      <div className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-[13px] font-medium text-slate-500">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
          <path d="M4 5.5A1.5 1.5 0 015.5 4H10l1.5 2h7A1.5 1.5 0 0120 7.5v11A1.5 1.5 0 0118.5 20h-13A1.5 1.5 0 014 18.5v-13z" strokeLinejoin="round" />
        </svg>
        <span>参考来源 · {sources.length}</span>
      </div>

      <div className="space-y-1">
        {sources.map((s, i) => {
          const key = `${s.document_name}-${i}`;
          const active = openName === key;
          return (
            <div key={key} className="rounded-xl bg-white/70 hairline">
              <button
                onClick={() => setOpenName(active ? null : key)}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <span className="min-w-0 flex-1 truncate text-[14px] text-slate-700">
                  {prettyName(s.document_name)}
                </span>
                <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[12.5px] font-medium tabular-nums text-emerald-600">
                  {Math.round(s.score * 100)}%
                </span>
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${active ? 'rotate-90' : ''}`}
                >
                  <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
                </svg>
              </button>
              {active && s.content && (
                <p className="px-2.5 pb-2.5 text-[14px] leading-7 text-slate-600">
                  {s.content}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
