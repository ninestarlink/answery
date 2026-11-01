import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AnswerY · 智能客服中台',
  description:
    'AnswerY（Answer You）智能客服中台：一套知识库驱动的客服系统，同时支撑电商导购与企业制度问答。React + FastAPI + LangGraph + pgvector 自建 RAG，含工具调用、人工审批、对话轨迹与运行监控。',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="bg-canvas antialiased">{children}</body>
    </html>
  );
}
