import { PRODUCTS } from './products';

/**
 * 本地演示兜底回复（Mock）
 * ----------------------------------------------------------------
 * 当 FastAPI 后端（http://localhost:8000）未启动时，前端用这套
 * 规则生成 Markdown 回复，并模拟 SSE 逐字流式输出，
 * 保证 Demo 在「纯前端」状态下也能完整演示打字机效果。
 *
 * 后端启动后，请求会自动改走真实 Agent 链路，本文件不会被调用。
 */

const byName = (keyword: string) =>
  PRODUCTS.find((p) => p.name.includes(keyword));

const productLine = (p: (typeof PRODUCTS)[number]) =>
  `| ${p.name} | ¥${p.price} | ${p.scene} | ${p.tags.join(' / ')} |`;

/** 规则匹配生成导购回复（Markdown 格式，用于验证 GFM 渲染） */
export function buildMockReply(message: string): string {
  const m = message.trim();

  // 1) 订单 / 物流查询 —— 模拟 Agent 的 Function Calling 全流程
  if (/订单|物流|快递|到哪|发货/.test(m)) {
    const orderId = m.match(/\d{4,}/)?.[0] ?? '12345';
    return [
      '收到！我来帮您查询订单物流信息。',
      '',
      '> 正在调用业务工具：`GET /api/tools/order?order_id=...`（Function Calling）',
      '',
      '工具已返回数据，整理如下：',
      '',
      '| 字段 | 信息 |',
      '| --- | --- |',
      `| 订单号 | ${orderId} |`,
      '| 商品 | 轻云 Pro 缓震跑鞋 x1 |',
      '| 状态 | **已发货** |',
      '| 最新位置 | 广州转运中心 |',
      '| 预计送达 | 明天 18:00 前 |',
      '',
      '您的包裹正在干线运输中，建议明天上午再关注一下物流更新～如需改地址或催件，随时告诉我。',
    ].join('\n');
  }

  // 2) 跑步场景
  if (/跑步|跑鞋|慢跑|马拉松|配速|跑5|跑十|公里/.test(m)) {
    const pro = byName('轻云')!;
    const carbon = byName('疾风')!;
    const trail = byName('山野')!;
    // 越野跑优先
    if (/越野|山地|爬山|户外/.test(m)) {
      return `如果您主要在**山路、非铺装路面**跑步，推荐 **${trail.name}**（¥${trail.price}）：\n\n- ${trail.desc}\n\n日常公路跑则可以看看另外两款：\n\n| 商品 | 价格 | 适合场景 | 标签 |\n| --- | --- | --- | --- |\n${productLine(pro)}\n${productLine(carbon)}\n\n**小结**：越野选深齿大底，公路跑选缓震/碳板，按训练场景挑就不会错。`;
    }
    return `根据您的问题，帮您挑了两款跑步鞋：\n\n1. **${pro.name}**（¥${pro.price}）—— ${pro.desc}\n2. **${carbon.name}**（¥${carbon.price}）—— ${carbon.desc}\n\n**选购建议：**\n\n- 刚开始跑步、每次 5-10 公里：选 **${pro.name}**，缓震保护更重要；\n- 已有 3 个月以上跑龄、想提配速或跑比赛：上 **${carbon.name}**；\n- 脚型偏宽建议拍大半码，跑鞋在下午试穿最合脚。\n\n需要我帮您对比一下两款的重量和中底材料吗？`;
  }

  // 3) 篮球场景
  if (/篮球|球场|实战|锋|后卫|中锋/.test(m)) {
    const b = byName('烈焰')!;
    return `打实战推荐 **${b.name}**（¥${b.price}）：\n\n- ${b.desc}\n\n**挑选要点：** 后卫选低帮更灵活、锋线选高帮防崴脚；室外粗糙场地优先看外底耐磨度。这款属于高帮全能型，校园外场很合适。`;
  }

  // 4) 预算导向
  const budgetMatch = m.match(/(\d{2,5})\s*(块|元|块钱|元钱|预算|以内|左右)?/);
  if (/预算|便宜|性价比|多少钱|价位/.test(m) && budgetMatch) {
    const budget = parseInt(budgetMatch[1], 10);
    const picks = PRODUCTS.filter((p) => p.price <= budget).slice(0, 4);
    if (picks.length === 0) {
      return `目前店铺鞋款最低价为 **¥${Math.min(
        ...PRODUCTS.map((p) => p.price),
      )}**（${PRODUCTS.reduce((a, b) => (a.price < b.price ? a : b)).name}）。\n\n如果预算可以再提一点，这款作为入门非常划算，支持 7 天无理由退换。`;
    }
    return `预算 **¥${budget}** 以内，帮您筛出这几款：\n\n| 商品 | 价格 | 适合场景 | 标签 |\n| --- | --- | --- | --- |\n${picks.map(productLine).join('\n')}\n\n综合推荐先看 **${picks[0].name}**：${picks[0].scene}，店铺月销 TOP，评价也不错。需要我发您商品链接吗？`;
  }

  // 5) 指定某款商品
  const hit = PRODUCTS.find(
    (p) => m.includes(p.name) || p.tags.some((t) => m.includes(t) && t.length >= 2),
  );
  if (hit && /介绍|怎么样|适合|详情|哪款|这款/.test(m)) {
    return `**${hit.name}**（¥${hit.price}）\n\n- **适合场景：** ${hit.scene}\n- **标签：** ${hit.tags.join(' / ')}\n- **介绍：** ${hit.desc}\n\n这款目前支持 7 天无理由退换和运费险，合适的话可以直接下单，尺码偏标准，按平时运动鞋码拍即可。`;
  }

  // 6) 兜底：通用导购
  return `您好，我是店铺的 **AI 导购助手**，可以帮您：\n\n- 根据运动场景推荐鞋款（跑步 / 篮球 / 越野 / 休闲）\n- 按预算筛选高性价比商品\n- 查询订单物流（试试问我「订单 12345 到哪了」）\n\n当前在售的热门款：\n\n| 商品 | 价格 | 适合场景 |\n| --- | --- | --- |\n${PRODUCTS.slice(0, 4)
    .map((p) => `| ${p.name} | ¥${p.price} | ${p.scene} |`)
    .join('\n')}\n\n您主要想在什么场景穿？告诉我预算和需求，我帮您精准推荐～`;
}
