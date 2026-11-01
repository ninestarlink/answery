import type { ReactNode } from 'react';

export type AppStatus = 'running' | 'planned';

export interface AppDef {
  id: string;
  name: string;
  en: string;
  desc: string;
  tags: string[];
  status: AppStatus;
  href?: string;
  gradient: string;
  iconClass?: string;
  icon: ReactNode;
}

const star = (
  <path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
);

/**
 * 两类业务知识库。
 * 它们不是两套系统：同一个智能客服中台、同一个 Agent 运行时，只是各自绑定
 * 一份知识库与工具集，在对话页可一键切换。
 */
export const APPS: AppDef[] = [
  {
    id: 'ecommerce',
    name: '电商商品知识库',
    en: 'E-commerce Product KB',
    desc: '商品参数、尺码库存、订单物流、退换与售后政策统一入库。客服在这里查知识、调业务工具，异常自动升级人工工单。',
    tags: ['Tool Calling', '订单物流', 'SSE'],
    status: 'running',
    href: '/apps?kb=ecommerce',
    gradient: 'from-brand-500 via-indigo-500 to-violet-500',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
        {star}
      </svg>
    ),
  },
  {
    id: 'enterprise-rag',
    name: '企业制度知识库',
    en: 'Enterprise Policy KB',
    desc: '员工手册、差旅报销、采购、信息安全、客服 SOP 等 7 份制度文档。自建 RAG 全链路，回答标注依据、版本与生效状态。',
    tags: ['pgvector', 'Hybrid Search', 'Citation'],
    status: 'running',
    href: '/apps?kb=enterprise',
    gradient: 'from-emerald-200 via-teal-200 to-cyan-300',
    iconClass: 'text-teal-900',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
        <path d="M6 3h9l4 4v14H6a2 2 0 01-2-2V5a2 2 0 012-2zm8 1.5V8h3.5L14 4.5zM8 12h8v1.8H8V12zm0 4h6v1.8H8V16z" />
      </svg>
    ),
  },
];
