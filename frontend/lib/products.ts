import type { Product } from './types';

/**
 * 静态商品目录（演示用假数据）
 * 面试演示时：左侧点击商品 -> 自动向 AI 发起导购咨询
 */

// 统一生成商品图（电商白底商品图风格）
const productImage = (prompt: string) =>
  `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(
    prompt,
  )}&image_size=square`;

export const PRODUCTS: Product[] = [
  {
    id: 'p1001',
    name: '轻云 Pro 缓震跑鞋',
    price: 499,
    originalPrice: 599,
    tags: ['跑步', '缓震', '入门'],
    scene: '日常慢跑 / 5-10 公里',
    desc: '中底采用高弹 EVA 缓震材料，鞋身仅 245g，适合初跑者日常 5-10 公里慢跑，对膝盖和脚踝友好，性价比高。',
    image: productImage('一双专业缓震跑步鞋，蓝紫色编织鞋面，白色厚中底，电商商品白底图，高清细节'),
  },
  {
    id: 'p1002',
    name: '疾风 2.0 碳板跑鞋',
    price: 699,
    originalPrice: 899,
    tags: ['跑步', '竞速', '碳板'],
    scene: '配速训练 / 半马全马',
    desc: '全掌碳纤维板 + 超临界发泡中底，滚动感强、回弹激进，适合有一定基础、追求配速的跑者进行节奏跑和比赛。',
    image: productImage('一双橙色竞速碳板跑步鞋，流线型设计，黑色鞋底，电商商品白底图，专业运动感'),
  },
  {
    id: 'p1003',
    name: '烈焰 X3 实战篮球鞋',
    price: 569,
    tags: ['篮球', '高帮', '抗扭'],
    scene: '室内外球场 / 锋卫摇摆',
    desc: '高帮包裹 + 抗扭转 TPU 片，人字纹深齿外底防滑耐磨，缓震反馈清晰，适合学生党和业余联赛高强度实战。',
    image: productImage('一双黑红色高帮篮球鞋，硬朗造型，厚实中底，电商商品白底图，运动专业'),
  },
  {
    id: 'p1004',
    name: '山野 GTX 越野跑鞋',
    price: 759,
    tags: ['越野', '防水', '抓地'],
    scene: '山地越野 / 徒步',
    desc: 'GTX 防水鞋面配合深齿 Vibram 大底，泥泞山石路面抓地可靠，配防沙石鞋舌，适合越野跑和户外徒步。',
    image: productImage('一双深绿色越野跑鞋，粗齿防滑大底，防水鞋面，电商商品白底图，户外风格'),
  },
  {
    id: 'p1005',
    name: '街头 Classic 休闲板鞋',
    price: 329,
    originalPrice: 399,
    tags: ['休闲', '百搭', '通勤'],
    scene: '日常穿搭 / 通勤上学',
    desc: '经典低帮板鞋版型，真皮鞋面 + 橡胶包边，耐脏好搭，牛仔裤运动裤都能配，长时间走路也不磨脚。',
    image: productImage('一双米白色低帮休闲板鞋，简洁复古设计，胶底，电商商品白底图，潮流百搭'),
  },
  {
    id: 'p1006',
    name: '云步 轻量健步鞋',
    price: 289,
    tags: ['健步', '轻量', '宽楦'],
    scene: '快走锻炼 / 长辈送礼',
    desc: '宽楦鞋头不挤脚，一脚蹬设计方便穿脱，单只仅 210g，鞋底带稳定支撑片，适合日常快走和送给长辈。',
    image: productImage('一双灰色轻便健步鞋，宽鞋头，魔术贴设计，电商商品白底图，舒适简约'),
  },
];
