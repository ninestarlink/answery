'use client';

import type { Product } from '@/lib/types';

interface ProductPanelProps {
  products: Product[];
  /** 点击商品卡片：自动发起一条导购咨询 */
  onSelect: (product: Product) => void;
  /** 移动端抽屉关闭（桌面端不传则不显示关闭按钮） */
  onClose?: () => void;
}

/** 商品目录面板：桌面常驻，移动端作为抽屉内容 */
export default function ProductPanel({ products, onSelect, onClose }: ProductPanelProps) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-5">
        <div>
          <div className="text-[13px] font-semibold text-slate-800">商品目录</div>
          <div className="mt-0.5 text-[11.5px] text-slate-500">点击商品即可咨询</div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="关闭商品目录"
            className="press flex h-8 w-8 items-center justify-center rounded-[2px] bg-paper-2 text-slate-600 hairline"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M5.28 4.22a.75.75 0 00-1.06 1.06L9.94 10l-5.72 5.72a.75.75 0 101.06 1.06L11 11.06l5.72 5.72a.75.75 0 101.06-1.06L12.06 10l5.72-5.72a.75.75 0 10-1.06-1.06L11 8.94 5.28 4.22z" />
            </svg>
          </button>
        )}
      </div>

      <div className="nice-scroll flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {products.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            className="press flex w-full items-center gap-3 rounded-2xl bg-paper-2 p-2.5 text-left hairline hover:bg-paper-2 hover:shadow-bubble"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.image}
              alt={p.name}
              loading="lazy"
              className="h-[52px] w-[52px] shrink-0 rounded-xl bg-slate-100 object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-slate-800">{p.name}</div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-[13px] font-semibold text-slate-900">¥{p.price}</span>
                {p.originalPrice && (
                  <span className="text-[11.5px] text-slate-400 line-through">
                    ¥{p.originalPrice}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
                {p.tags.join(' · ')}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="border-t border-rule px-4 py-3 text-[11px] leading-4 text-slate-500">
        演示商品数据与数据库 products 表一致
      </div>
    </div>
  );
}
