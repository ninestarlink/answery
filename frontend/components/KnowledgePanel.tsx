'use client';

/**
 * 企业知识库文档面板：点击文档发起概括请求。
 * 与 ProductPanel 同一套视觉语言，桌面固定栏 / 移动抽屉复用。
 */

type DocKind = 'PDF' | 'DOCX' | 'MD' | 'XLSX';

interface KbDoc {
  name: string;
  ver: string;
  kind: DocKind;
  dept: string;
}

const DOCS: KbDoc[] = [
  { name: '员工手册', ver: 'V3.2', kind: 'PDF', dept: '人力资源部' },
  { name: '差旅报销制度', ver: 'V2.1', kind: 'DOCX', dept: '财务部' },
  { name: '采购与供应商管理办法', ver: 'V1.4', kind: 'DOCX', dept: '供应链中心' },
  { name: '信息安全规范', ver: 'V2.0', kind: 'MD', dept: '信息安全委员会' },
  { name: '客服升级 SOP', ver: 'V3.0', kind: 'MD', dept: '客服中心' },
  { name: '报销标准与供应商清单', ver: 'A1', kind: 'XLSX', dept: '财务部' },
  { name: '产品技术白皮书', ver: 'V1.0', kind: 'PDF', dept: '产品研发中心' },
];

const KIND_STYLE: Record<DocKind, string> = {
  PDF: 'bg-rose-50 text-rose-600',
  DOCX: 'bg-sky-50 text-sky-600',
  MD: 'bg-slate-100 text-slate-600',
  XLSX: 'bg-emerald-50 text-emerald-600',
};

interface KnowledgePanelProps {
  onPick: (docName: string) => void;
  onClose?: () => void;
}

export default function KnowledgePanel({ onPick, onClose }: KnowledgePanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-4">
        <div>
          <h2 className="text-[13.5px] font-semibold tracking-tight-ios text-slate-900">
            知识库文档
          </h2>
          <p className="mt-0.5 text-[11.5px] text-slate-500">
            {DOCS.length} 份制度文件 · 混合检索
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="关闭文档面板"
            className="press flex h-8 w-8 items-center justify-center rounded-full bg-paper-2 text-slate-600 hairline"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M5.28 4.22a.75.75 0 00-1.06 1.06L8.94 10l-4.72 4.72a.75.75 0 101.06 1.06L10 11.06l4.72 4.72a.75.75 0 101.06-1.06L11.06 10l4.72-4.72a.75.75 0 00-1.06-1.06L10 8.94 5.28 4.22z" />
            </svg>
          </button>
        )}
      </div>

      <div className="nice-scroll mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-3">
        {DOCS.map((d) => (
          <button
            key={d.name}
            onClick={() => onPick(d.name)}
            className="press group flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2.5 text-left transition-colors hover:bg-paper-3"
          >
            <span
              className={`flex h-8 w-11 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${KIND_STYLE[d.kind]}`}
            >
              {d.kind}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-slate-800 group-hover:text-emerald-700">
                {d.name}
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] text-slate-500">
                {d.ver} · {d.dept}
              </span>
            </span>
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3 w-3 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald-500"
            >
              <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
            </svg>
          </button>
        ))}
      </div>

      <div className="border-t border-rule px-4 py-3">
        <p className="text-[11.5px] leading-relaxed text-slate-500">
          混合检索（语义 0.7 / 关键词 0.3），通用分段 800 / 重叠 50；回答会标注命中的文档编号与版本。
        </p>
      </div>
    </div>
  );
}
