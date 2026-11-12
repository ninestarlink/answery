'use client';

import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import {
  erpApi,
  type ErpHealth,
  type ErpMasterData,
  type ErpOrder,
  type ErpSource,
  type ErpStock,
} from '@/lib/erpApi';

const DEFAULT_ORDER = '12345';
const DEFAULT_SKU = 'SKU-P1004-42';

/** 来源徽章：把 mock / http / local / 降级四种情况在视觉上区分开 */
const SOURCE_STYLE: Record<ErpSource, { label: string; className: string }> = {
  'mock-erp': { label: 'Mock ERP', className: 'bg-indigo-50 text-indigo-600' },
  'http-erp': { label: 'HTTP ERP', className: 'bg-emerald-50 text-emerald-600' },
  local: { label: '本地库', className: 'bg-slate-100 text-slate-600' },
  'local-fallback': { label: 'ERP 故障 · 已降级', className: 'bg-amber-50 text-amber-600' },
};

export default function ErpPage() {
  const [health, setHealth] = useState<ErpHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [orderNo, setOrderNo] = useState(DEFAULT_ORDER);
  const [order, setOrder] = useState<ErpOrder | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  const [sku, setSku] = useState(DEFAULT_SKU);
  const [stock, setStock] = useState<ErpStock | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);

  const [master, setMaster] = useState<ErpMasterData | null>(null);
  const [masterError, setMasterError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<'order' | 'stock' | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setHealthError(null);
      setHealth(await erpApi.health());
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : '自检失败');
    }
  }, []);

  const loadOrder = useCallback(async (value: string) => {
    const no = value.trim();
    if (!no) return;
    setPending('order');
    setOrderError(null);
    try {
      setOrder(await erpApi.order(no));
    } catch (e) {
      setOrder(null);
      setOrderError(e instanceof Error ? e.message : '订单查询失败');
    } finally {
      setPending(null);
    }
  }, []);

  const loadStock = useCallback(async (value: string) => {
    const code = value.trim();
    if (!code) return;
    setPending('stock');
    setStockError(null);
    try {
      setStock(await erpApi.stock(code));
    } catch (e) {
      setStock(null);
      setStockError(e instanceof Error ? e.message : '库存查询失败');
    } finally {
      setPending(null);
    }
  }, []);

  const loadMaster = useCallback(async () => {
    try {
      setMasterError(null);
      setMaster(await erpApi.products());
    } catch (e) {
      setMaster(null);
      setMasterError(e instanceof Error ? e.message : '主数据拉取失败');
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      loadHealth(),
      loadOrder(orderNo),
      loadStock(sku),
      loadMaster(),
    ]);
    setLoading(false);
  }, [loadHealth, loadOrder, loadStock, loadMaster, orderNo, sku]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await Promise.all([
        loadHealth(),
        loadOrder(DEFAULT_ORDER),
        loadStock(DEFAULT_SKU),
        loadMaster(),
      ]);
      setLoading(false);
    })();
    // 只在首次挂载时拉一遍，后续由按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px]">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-rule border-t-[3px] border-t-ink-900 pb-3 pt-3">
          <div>
            <div className="mono-label text-muted">Integrations / ERP 适配层</div>
            <h1 className="mt-1.5 text-[26px] leading-tight text-slate-900 md:text-[30px]">
              ERP 集成
            </h1>
            <p className="mt-1 text-[13px] text-slate-600">
              适配层 + Mock ERP：查订单、查实时库存、拉商品主数据，每条结果都标注真实来源。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-[2px] px-2.5 py-1 text-[11.5px] font-medium hairline ${
                health?.ok
                  ? 'bg-emerald-50 text-emerald-600'
                  : health
                    ? 'bg-amber-50 text-amber-600'
                    : 'bg-paper-3 text-slate-500'
              }`}
            >
              {health ? `ERP_MODE=${health.mode}` : '检测中'}
            </span>
            <button
              onClick={() => void refreshAll()}
              disabled={loading}
              className="press rounded-[2px] bg-accent px-3.5 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-hi disabled:opacity-60"
            >
              {loading ? '刷新中' : '重新自检'}
            </button>
          </div>
        </header>

        <div className="mt-4 grid grid-cols-1 gap-3.5 lg:grid-cols-3">
          {/* 左：订单 + 库存 */}
          <div className="flex flex-col gap-3.5 lg:col-span-2">
            <section className="rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
              <div className="flex items-center justify-between">
                <div className="text-[13.5px] font-semibold text-slate-800">订单查询</div>
                <span className="font-mono text-[11px] text-slate-400">
                  GET /api/erp/orders/{'{order_no}'}
                </span>
              </div>
              <form
                className="mt-2.5 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadOrder(orderNo);
                }}
              >
                <input
                  value={orderNo}
                  onChange={(e) => setOrderNo(e.target.value)}
                  placeholder="订单号，如 12345"
                  className="min-w-0 flex-1 rounded-[2px] bg-canvas px-3 py-1.5 font-mono text-[12px] text-slate-800 outline-none hairline focus:border-ink-900"
                />
                <button
                  type="submit"
                  disabled={pending === 'order'}
                  className="press shrink-0 rounded-[2px] bg-ink px-3 py-1.5 text-[12px] font-medium text-paper-2 disabled:opacity-60"
                >
                  {pending === 'order' ? '查询中…' : '查询'}
                </button>
              </form>

              {orderError && (
                <div className="mt-2.5 rounded-[2px] bg-rose-50/80 px-3 py-2 text-[12px] text-rose-600">
                  {orderError}
                </div>
              )}

              {order && (
                <div className="mt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-slate-900">
                      #{order.order_no}
                    </span>
                    <span className="rounded-[2px] bg-paper-3 px-2 py-0.5 text-[11px] text-slate-600">
                      {order.status_text}
                    </span>
                    <SourceBadge source={order.source} />
                    <span className="ml-auto text-[12px] text-slate-600">
                      实付 ¥{order.total_amount.toFixed(2)}
                      {order.discount_amount > 0 && (
                        <span className="ml-1 text-slate-400">
                          （优惠 ¥{order.discount_amount.toFixed(2)}）
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-slate-600 md:grid-cols-4">
                    <Meta label="支付方式" value={order.pay_method || '—'} />
                    <Meta label="下单时间" value={order.created_at || '—'} />
                    <Meta label="支付时间" value={order.paid_at || '—'} />
                    <Meta label="发货时间" value={order.shipped_at || '—'} />
                  </div>
                  {order.address && (
                    <div className="mt-1.5 text-[12px] text-slate-500">
                      收货地址：{order.address}
                    </div>
                  )}

                  <div className="nice-scroll mt-2.5 overflow-x-auto">
                    <table className="w-full min-w-[520px] border-separate border-spacing-y-1 text-left text-[12px]">
                      <thead>
                        <tr className="text-[11px] font-medium text-slate-400">
                          <th className="px-2 pb-1">商品</th>
                          <th className="px-2 pb-1">尺码</th>
                          <th className="px-2 pb-1 text-right">数量</th>
                          <th className="px-2 pb-1 text-right">单价</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.items.map((item, i) => (
                          <tr key={`${item.product_id}-${item.size}-${i}`} className="text-slate-600">
                            <td className="px-2 py-1.5">
                              {item.product_name}
                              <span className="ml-1.5 font-mono text-[11px] text-slate-400">
                                {item.product_id}
                              </span>
                            </td>
                            <td className="px-2 py-1.5">{item.size}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{item.qty}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              ¥{item.unit_price.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {order.note && (
                    <p className="mt-2 text-[11.5px] leading-relaxed text-amber-600">
                      降级说明：{order.note}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section className="rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
              <div className="flex items-center justify-between">
                <div className="text-[13.5px] font-semibold text-slate-800">实时库存</div>
                <span className="font-mono text-[11px] text-slate-400">
                  GET /api/erp/stock/{'{sku}'}
                </span>
              </div>
              <form
                className="mt-2.5 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadStock(sku);
                }}
              >
                <input
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="SKU，如 SKU-P1004-42"
                  className="min-w-0 flex-1 rounded-[2px] bg-canvas px-3 py-1.5 font-mono text-[12px] text-slate-800 outline-none hairline focus:border-ink-900"
                />
                <button
                  type="submit"
                  disabled={pending === 'stock'}
                  className="press shrink-0 rounded-[2px] bg-ink px-3 py-1.5 text-[12px] font-medium text-paper-2 disabled:opacity-60"
                >
                  {pending === 'stock' ? '查询中…' : '查询'}
                </button>
              </form>

              {stockError && (
                <div className="mt-2.5 rounded-[2px] bg-rose-50/80 px-3 py-2 text-[12px] text-rose-600">
                  {stockError}
                </div>
              )}

              {stock && (
                <div className="mt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-slate-900">
                      {stock.sku}
                    </span>
                    <SourceBadge source={stock.source} />
                    <span
                      className={`rounded-[2px] px-2 py-0.5 text-[11px] font-medium ${
                        stock.available > 5
                          ? 'bg-emerald-50 text-emerald-600'
                          : stock.available > 0
                            ? 'bg-amber-50 text-amber-600'
                            : 'bg-rose-50 text-rose-600'
                      }`}
                    >
                      {stock.available > 5 ? '库存充足' : stock.available > 0 ? '低库存' : '缺货'}
                    </span>
                  </div>

                  <div className="mt-2.5 grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Metric label="可用" value={stock.available} />
                    <Metric label="占用" value={stock.reserved} />
                    <Metric label="仓库" value={stock.warehouse || '—'} small />
                    <Metric
                      label="规格"
                      value={`${stock.color || '—'} / ${stock.size || '—'}`}
                      small
                    />
                  </div>
                  {stock.note && (
                    <p className="mt-2 text-[11.5px] leading-relaxed text-amber-600">
                      降级说明：{stock.note}
                    </p>
                  )}
                </div>
              )}
            </section>
          </div>

          {/* 右：健康自检 + 来源说明 */}
          <div className="flex flex-col gap-3.5">
            <section className="rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
              <div className="text-[13.5px] font-semibold text-slate-800">连接自检</div>
              {healthError ? (
                <p className="mt-2 text-[12px] text-rose-600">{healthError}</p>
              ) : !health ? (
                <p className="mt-2 text-[12px] text-slate-500">检测中…</p>
              ) : (
                <dl className="mt-2.5 space-y-1.5 text-[12px]">
                  <Row label="模式" value={health.mode} mono />
                  <Row label="适配器" value={health.adapter || '未启用'} mono />
                  <Row label="连通性" value={health.ok ? '正常' : '不可用'} />
                  <Row
                    label="探测耗时"
                    value={health.latency_ms != null ? `${health.latency_ms} ms` : '—'}
                  />
                  {health.probe?.endpoint && (
                    <Row label="探测端点" value={health.probe.endpoint} mono />
                  )}
                  {health.probe?.orders != null && (
                    <Row label="样例订单" value={`${health.probe.orders} 条`} />
                  )}
                  {health.probe?.skus != null && (
                    <Row label="库存 SKU" value={`${health.probe.skus} 条`} />
                  )}
                  {health.error && (
                    <div className="rounded-[2px] bg-rose-50/80 px-2 py-1.5 text-[11.5px] leading-relaxed text-rose-600">
                      {health.error}
                    </div>
                  )}
                  {health.note && (
                    <div className="rounded-[2px] bg-amber-50/80 px-2 py-1.5 text-[11.5px] leading-relaxed text-amber-700">
                      {health.note}
                    </div>
                  )}
                </dl>
              )}
            </section>

            <section className="rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
              <div className="text-[13.5px] font-semibold text-slate-800">数据来源</div>
              <ul className="mt-2.5 space-y-2 text-[11.5px] leading-relaxed text-slate-600">
                <li className="flex items-start gap-2">
                  <SourceBadge source="mock-erp" />
                  <span>Mock ERP 返回，演示环境默认模式。</span>
                </li>
                <li className="flex items-start gap-2">
                  <SourceBadge source="http-erp" />
                  <span>真实 HTTP 调用外部 ERP 网关成功。</span>
                </li>
                <li className="flex items-start gap-2">
                  <SourceBadge source="local" />
                  <span>ERP_MODE=local，主动查本地 MySQL。</span>
                </li>
                <li className="flex items-start gap-2">
                  <SourceBadge source="local-fallback" />
                  <span>ERP 超时或鉴权失败，回落到本地库并附降级原因。</span>
                </li>
              </ul>
            </section>
          </div>
        </div>

        {/* 商品主数据 */}
        <section className="mt-3.5 rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
          <div className="flex items-center justify-between">
            <div className="text-[13.5px] font-semibold text-slate-800">商品主数据</div>
            <span className="text-[11.5px] text-slate-500">
              {master ? `GET /api/erp/master-data/products · ${master.count} 条` : '待拉取'}
            </span>
          </div>

          {masterError ? (
            <p className="mt-2 text-[12px] text-amber-600">
              {masterError}（ERP_MODE=local 时无主数据可拉取）
            </p>
          ) : !master ? (
            <p className="mt-2 text-[12px] text-slate-500">加载中…</p>
          ) : (
            <div className="nice-scroll mt-2.5 overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate border-spacing-y-1 text-left text-[12px]">
                <thead>
                  <tr className="text-[11px] font-medium text-slate-400">
                    <th className="px-2 pb-1">商品编码</th>
                    <th className="px-2 pb-1">名称</th>
                    <th className="px-2 pb-1">品类</th>
                    <th className="px-2 pb-1 text-right">标价</th>
                    <th className="px-2 pb-1 text-right">币种</th>
                  </tr>
                </thead>
                <tbody>
                  {master.items.map((p) => (
                    <tr key={p.product_id} className="text-slate-600">
                      <td className="px-2 py-1.5 font-mono text-[11px] text-slate-500">
                        {p.product_id}
                      </td>
                      <td className="px-2 py-1.5">{p.name}</td>
                      <td className="px-2 py-1.5">{p.category || '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        ¥{p.price.toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-[11px] text-slate-400">
                        {p.currency}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-3.5 rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
          <div className="text-[13.5px] font-semibold text-slate-800">设计说明</div>
          <ul className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed text-slate-600">
            <li>· 适配层用 Protocol 约定四件事（查订单 / 查库存 / 拉主数据 / 连通性自检），换 ERP 厂商只改 adapter。</li>
            <li>· Mock ERP 是独立可运行的 FastAPI 服务（/mock-erp），模拟 SAP OData 风格响应，不依赖真实厂商。</li>
            <li>· ERP 明确返回不存在时不降级（避免拿旧数据冒充），只有超时 / 鉴权失败等服务端故障才回落本地库。</li>
            <li>· 每条结果都带 source，前端和 Agent 都能区分 mock-erp、http-erp、local 与 local-fallback。</li>
            <li>· 演示数据均为虚构，不代表任何真实企业或个人信息。</li>
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

function SourceBadge({ source }: { source: ErpSource }) {
  const style = SOURCE_STYLE[source] ?? {
    label: source,
    className: 'bg-paper-3 text-slate-600',
  };
  return (
    <span
      className={`shrink-0 rounded-[2px] px-2 py-0.5 text-[11px] font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="truncate font-mono text-[11.5px] text-slate-700" title={value}>
        {value}
      </div>
    </div>
  );
}

function Metric({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div className="rounded-[2px] bg-canvas px-2.5 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div
        className={`mt-0.5 font-semibold tabular-nums text-slate-800 ${
          small ? 'truncate font-mono text-[11.5px]' : 'text-[18px] leading-tight'
        }`}
        title={String(value)}
      >
        {value}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`truncate text-right text-slate-700 ${mono ? 'font-mono text-[11.5px]' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
