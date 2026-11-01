'use client';

import AppShell from '@/components/AppShell';
import Chat from '@/components/Chat';

const QUICK_QUESTIONS = [
  { icon: '🏃', text: '哪款跑鞋适合日常训练？' },
  { icon: '📦', text: '查询订单 12347 的物流' },
  { icon: '💰', text: '预算 500 元以内有什么推荐？' },
  { icon: '🏖', text: '一线城市出差住宿上限是多少？' },
  { icon: '🧾', text: '年假怎么算，能跨年结转吗？' },
  { icon: '🛠', text: '帮我转人工建个工单' },
];

/**
 * 智能客服：单一对话窗口。
 * 同一个输入框既能问商品、订单、售后（走工具 + 商品库），
 * 也能问公司制度与流程（走企业制度库）；两类知识库由后端同时召回、按语义挑用。
 */
export default function WorkspacePage() {
  return (
    <AppShell scrollable={false}>
      <div className="flex min-h-0 flex-1 flex-col pb-[74px] md:pb-0">
        <Chat
          app="auto"
          accent="indigo"
          title="智能客服"
          subtitle="答案带出处 · 写操作先审批 · 全程可回放"
          placeholder="问商品、查订单，或问公司制度，例如「一线城市出差住宿上限是多少」……"
          emptyDesc="商品导购、订单物流、退换售后，以及公司制度、报销、假期规则，都在这一个对话里。直接问就行，我会自动判断该查商品库还是制度库。"
          quickQuestions={QUICK_QUESTIONS}
        />
      </div>
    </AppShell>
  );
}