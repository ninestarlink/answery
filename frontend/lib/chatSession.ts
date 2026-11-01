'use client';

import type { StreamMode } from './chatStream';
import type { UIMessage } from './types';

/** 等待期间展示的当前执行阶段 */
export interface ChatLiveStatus {
  /** 归属的助手消息 id，避免历史消息误显示 */
  id: string;
  label: string;
  detail?: string;
  /** 已经走过的阶段，最多保留 5 条 */
  steps: string[];
}

/** 单个应用的会话状态 */
export interface ChatSessionState {
  messages: UIMessage[];
  streaming: boolean;
  live: ChatLiveStatus | null;
  mode: StreamMode | null;
  /** 本轮开始时间，用于「已等待 X 秒」 */
  startedAt: number | null;
}

/**
 * 会话状态放在模块级 store：
 * 页面切换（电商 / 爬虫 / 企业知识库之间来回）不会丢聊天记录和进行中的流。
 */
const EMPTY: ChatSessionState = {
  messages: [],
  streaming: false,
  live: null,
  mode: null,
  startedAt: null,
};

const sessions = new Map<string, ChatSessionState>();
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();

const keyOf = (app?: string) => app ?? 'default';

/** 通知所有订阅组件重新读取快照 */
function emit() {
  listeners.forEach((listener) => listener());
}

/** 读取指定应用的会话快照（引用稳定，可直接交给 useSyncExternalStore） */
export function getChatSession(app?: string): ChatSessionState {
  return sessions.get(keyOf(app)) ?? EMPTY;
}

/** 服务端渲染时没有会话数据，统一返回同一个空快照 */
export function getChatSessionServerSnapshot(): ChatSessionState {
  return EMPTY;
}

export function subscribeChatSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateChatSession(
  app: string | undefined,
  patch: Partial<ChatSessionState>,
) {
  const key = keyOf(app);
  sessions.set(key, { ...getChatSession(app), ...patch });
  emit();
}

export function patchChatMessage(
  app: string | undefined,
  id: string,
  patch: Partial<UIMessage>,
) {
  const cur = getChatSession(app);
  sessions.set(keyOf(app), {
    ...cur,
    messages: cur.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  });
  emit();
}

export function appendChatContent(
  app: string | undefined,
  id: string,
  chunk: string,
) {
  const cur = getChatSession(app);
  sessions.set(keyOf(app), {
    ...cur,
    messages: cur.messages.map((m) =>
      m.id === id ? { ...m, content: m.content + chunk } : m,
    ),
  });
  emit();
}

export function resetChatSession(app?: string) {
  sessions.delete(keyOf(app));
  emit();
}

export function setChatController(app: string | undefined, controller: AbortController) {
  controllers.set(keyOf(app), controller);
}

export function clearChatController(app: string | undefined) {
  controllers.delete(keyOf(app));
}

/** 中断当前应用的流式请求 */
export function abortChat(app?: string) {
  const controller = controllers.get(keyOf(app));
  if (controller) {
    controller.abort();
    controllers.delete(keyOf(app));
  }
}
