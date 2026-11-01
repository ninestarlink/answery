'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Chat from '@/components/Chat';

type Mode = 'ecommerce' | 'enterprise';

/** 两套知识库的对话配置：同一个中台，切换的只是知识库与工具集 */
const KB_META = {
  ecommerce: {
    pill: '电商商品库',
    status: 'Agent 运行时 · 业务工具已接入',
    chat: {
      app: 'ecommerce' as const,
      accent: 'indigo' as const,
      title: '电商导购助手',
      subtitle: '商品检索 · 订单物流 · 售后政策',
      placeholder: '问商品、查订单、问售后，例如「哪款鞋适合跑步」……',
    },
  },
  enterprise: {
    pill: '企业制度库',
    status: 'pgvector · 混合检索',
    chat: {
      app: 'enterprise' as const,
      accent: 'emerald' as const,
      title: '企业制度助手',
      subtitle: '混合检索 · 版本溯源 · 权限合规',
      placeholder: '问制度、问流程、问标准，例如「一线城市出差住宿上限是多少」……',
    },
  },
} as const;

/**
 * 智能客服：单窗口对话页。
 * 顶部只有「电商商品库 / 企业制度库」两个胶囊，切换后复用同一个对话组件；
 * 两个库各自保留独立会话，互不串味。
 */
export default function WorkspacePage() {
  const [mode, setMode] = useState<Mode>('ecommerce');

  // 支持 /apps?kb=enterprise 直达，切换时只改地址不跳路由
  useEffect(() => {
    const kb = new URLSearchParams(window.location.search).get('kb');
    if (kb === 'enterprise' || kb === 'ecommerce') setMode(kb);
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    window.history.replaceState(null, '', `/apps?kb=${next}`);
  };

  const meta = KB_META[mode];

  return (
    <AppShell scrollable={false}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/60 bg-white/40 px-3.5 py-2.5 backdrop-blur-xl md:px-7">
          <span className="text-[12px] text-slate-500">知识库</span>
          {(Object.keys(KB_META) as Mode[]).map((key) => {
            const active = mode === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => switchMode(key)}
                className={`press rounded-full px-3 py-1.5 text-[12.5px] font-medium transition ${
                  active
                    ? 'bg-slate-900 text-white shadow-[0_10px_22px_-14px_rgba(15,23,42,0.9)]'
                    : 'bg-white/70 text-slate-500 hairline hover:bg-white hover:text-slate-800'
                }`}
              >
                {KB_META[key].pill}
              </button>
            );
          })}
          <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-slate-500 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {meta.status}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col pb-[74px] md:pb-0">
          <Chat key={mode} {...meta.chat} />
        </div>
      </div>
    </AppShell>
  );
}
