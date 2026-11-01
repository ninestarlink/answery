-- =============================================================
-- 电商 AI 销售助手 · 数据库结构（MySQL 8.0）
-- 首次 docker compose up 时由 /docker-entrypoint-initdb.d 自动执行。
-- 所有数据均为演示用虚构数据，不对应任何真实业务系统。
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE DATABASE IF NOT EXISTS ecom_ai_demo
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ecom_ai_demo;

DROP TABLE IF EXISTS chat_trace, chat_history, store_policies, coupons, shipment_events,
  shipments, order_items, orders, customers, product_variants, products, talk_templates, tickets;

-- -------------------------------------------------------------
-- 商品
-- -------------------------------------------------------------
CREATE TABLE products (
  id             VARCHAR(16)   NOT NULL COMMENT '商品ID，与前端 lib/products.ts 的 id 一致',
  name           VARCHAR(64)   NOT NULL COMMENT '商品名',
  subtitle       VARCHAR(128)  DEFAULT NULL COMMENT '副标题',
  category       VARCHAR(32)   DEFAULT NULL COMMENT '跑步/篮球/越野/休闲',
  price          DECIMAL(10,2) NOT NULL COMMENT '当前售价（元）',
  original_price DECIMAL(10,2) DEFAULT NULL COMMENT '划线价（元）',
  tags           VARCHAR(128)  DEFAULT NULL COMMENT '逗号分隔标签，供工具关键词检索',
  scene_desc     VARCHAR(128)  DEFAULT NULL COMMENT '适用场景，一句话',
  description    TEXT          COMMENT '商品详情，供 RAG / 工具返回',
  image_url      VARCHAR(256)  DEFAULT NULL COMMENT '图片相对路径（前端按 id 复用静态图）',
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_products_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商品主表';

CREATE TABLE product_variants (
  id         VARCHAR(24) NOT NULL COMMENT 'SKU ID，如 p1002-42',
  product_id VARCHAR(16) NOT NULL,
  sku        VARCHAR(32) NOT NULL COMMENT '对外 SKU 编码',
  size       VARCHAR(16) NOT NULL COMMENT '尺码（欧码）',
  color      VARCHAR(32) DEFAULT NULL,
  stock      INT         NOT NULL DEFAULT 0 COMMENT '可售库存',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_variants_sku (sku),
  KEY idx_variants_product (product_id),
  CONSTRAINT fk_variants_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商品 SKU 与库存';

-- -------------------------------------------------------------
-- 客户与订单
-- -------------------------------------------------------------
CREATE TABLE customers (
  id         VARCHAR(16) NOT NULL COMMENT '客户编号',
  name       VARCHAR(32) NOT NULL,
  phone      VARCHAR(20) NOT NULL COMMENT '登录账号',
  level      VARCHAR(16) NOT NULL DEFAULT 'normal' COMMENT 'normal/silver/gold',
  role       VARCHAR(16) NOT NULL DEFAULT 'customer' COMMENT 'customer/admin，admin 可访问控制台',
  password_hash VARCHAR(128) DEFAULT NULL COMMENT 'bcrypt 哈希；为空时回落到演示统一密码',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_customers_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户';

CREATE TABLE orders (
  id              VARCHAR(16)   NOT NULL COMMENT '订单号（演示钩子：12345）',
  customer_id     VARCHAR(16)   NOT NULL,
  status          VARCHAR(16)   NOT NULL COMMENT 'pending_payment/paid/shipped/delivered/refunding/completed/cancelled',
  total_amount    DECIMAL(10,2) NOT NULL COMMENT '实付金额',
  discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '优惠金额',
  pay_method      VARCHAR(16)   DEFAULT NULL,
  address         VARCHAR(255)  DEFAULT NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at         DATETIME      DEFAULT NULL,
  shipped_at      DATETIME      DEFAULT NULL,
  delivered_at    DATETIME      DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_orders_customer (customer_id),
  KEY idx_orders_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单主表';

CREATE TABLE order_items (
  id           BIGINT        NOT NULL AUTO_INCREMENT,
  order_id     VARCHAR(16)   NOT NULL,
  product_id   VARCHAR(16)   NOT NULL,
  variant_id   VARCHAR(24)   DEFAULT NULL,
  product_name VARCHAR(64)   NOT NULL,
  size         VARCHAR(16)   DEFAULT NULL,
  qty          INT           NOT NULL DEFAULT 1,
  unit_price   DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_items_order (order_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单明细';

-- -------------------------------------------------------------
-- 物流
-- -------------------------------------------------------------
CREATE TABLE shipments (
  id                 VARCHAR(24) NOT NULL,
  order_id           VARCHAR(16) NOT NULL,
  carrier            VARCHAR(32) NOT NULL COMMENT '承运商',
  tracking_no        VARCHAR(32) NOT NULL COMMENT '运单号',
  status             VARCHAR(16) NOT NULL COMMENT 'created/picked_up/in_transit/delivering/delivered',
  origin_city        VARCHAR(32) DEFAULT NULL COMMENT '发货仓',
  current_city       VARCHAR(32) DEFAULT NULL COMMENT '当前所在城市/转运中心',
  estimated_delivery DATE        DEFAULT NULL COMMENT '预计送达日期',
  shipped_at         DATETIME    DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_shipments_order (order_id),
  KEY idx_shipments_tracking (tracking_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='物流单';

CREATE TABLE shipment_events (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  shipment_id VARCHAR(24)  NOT NULL,
  event_time  DATETIME     NOT NULL,
  city        VARCHAR(32)  DEFAULT NULL,
  description VARCHAR(128) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_events_shipment (shipment_id, event_time),
  CONSTRAINT fk_events_shipment FOREIGN KEY (shipment_id) REFERENCES shipments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='物流轨迹';

-- -------------------------------------------------------------
-- 优惠券
-- -------------------------------------------------------------
CREATE TABLE coupons (
  id              VARCHAR(16)   NOT NULL,
  customer_id     VARCHAR(16)   DEFAULT NULL COMMENT 'NULL 表示全店通用券',
  code            VARCHAR(24)   NOT NULL COMMENT '券码',
  name            VARCHAR(64)   NOT NULL,
  discount_amount DECIMAL(10,2) NOT NULL COMMENT '抵扣金额',
  min_amount      DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '使用门槛',
  valid_from      DATE          NOT NULL,
  valid_to        DATE          NOT NULL,
  status          VARCHAR(16)   NOT NULL DEFAULT 'unused' COMMENT 'unused/used（是否过期按 valid_to 实时计算）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_coupons_code (code),
  KEY idx_coupons_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='优惠券';

-- -------------------------------------------------------------
-- 店铺政策（与 facts.md 严格一致）
-- -------------------------------------------------------------
CREATE TABLE store_policies (
  id          INT          NOT NULL AUTO_INCREMENT,
  policy_key  VARCHAR(32)  NOT NULL COMMENT '英文键名，供工具与知识库对齐',
  title       VARCHAR(64)  NOT NULL,
  content     TEXT         NOT NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_policies_key (policy_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='店铺政策单一事实源';

-- -------------------------------------------------------------
-- 话术库（预留：当前以 Dify 知识库里的 presales/sales/aftersales.md 为权威来源）
-- -------------------------------------------------------------
CREATE TABLE talk_templates (
  id        VARCHAR(16) NOT NULL COMMENT '条目编号，如 P-01 / S-03 / A-05',
  stage     VARCHAR(16) NOT NULL COMMENT 'presales/sales/aftersales',
  intent    VARCHAR(32) NOT NULL,
  lang      VARCHAR(8)  NOT NULL DEFAULT 'zh' COMMENT 'zh/en/both',
  title     VARCHAR(64) NOT NULL,
  body      TEXT        NOT NULL,
  variables VARCHAR(255) DEFAULT NULL COMMENT '模板变量，如 {{product_name}}',
  updated_at DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='话术模板（预留）';

-- -------------------------------------------------------------
-- 会话记录（Token 记账）
-- -------------------------------------------------------------
CREATE TABLE chat_history (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  session_id        VARCHAR(64)  NOT NULL COMMENT '后端自管的会话 ID',
  customer_id       VARCHAR(16)  DEFAULT NULL COMMENT '游客为 NULL',
  role              VARCHAR(16)  NOT NULL COMMENT 'user/assistant',
  content           MEDIUMTEXT   NOT NULL,
  prompt_tokens     INT          NOT NULL DEFAULT 0,
  completion_tokens INT          NOT NULL DEFAULT 0,
  total_tokens      INT          NOT NULL DEFAULT 0,
  model             VARCHAR(64)  DEFAULT NULL,
  latency_ms        INT          NOT NULL DEFAULT 0,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_session (session_id, id),
  KEY idx_chat_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话记录与 Token 记账';

-- -------------------------------------------------------------
-- 对话执行轨迹（检索耗时、工具轮数、降级原因、首 Token 延迟）
-- -------------------------------------------------------------
CREATE TABLE chat_trace (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  session_id     VARCHAR(64)  NOT NULL,
  app            VARCHAR(16)  NOT NULL DEFAULT 'ecommerce',
  question       VARCHAR(255) NOT NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'ok' COMMENT 'ok/interrupted/error',
  hits           INT          NOT NULL DEFAULT 0,
  tools          INT          NOT NULL DEFAULT 0,
  tool_names     VARCHAR(255) DEFAULT NULL,
  degraded       VARCHAR(128) DEFAULT NULL,
  first_token_ms INT          NOT NULL DEFAULT 0,
  latency_ms     INT          NOT NULL DEFAULT 0,
  total_tokens   INT          NOT NULL DEFAULT 0,
  error          VARCHAR(255) DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_trace_created (created_at),
  KEY idx_trace_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='对话执行轨迹';

-- -------------------------------------------------------------
-- IT 工单（规则引擎自动生成）
-- -------------------------------------------------------------
CREATE TABLE tickets (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  ticket_no       VARCHAR(24)  NOT NULL COMMENT 'IT-YYYYMMDD-NNN',
  reporter        VARCHAR(32)  NOT NULL DEFAULT '匿名员工',
  department      VARCHAR(32)  DEFAULT NULL,
  description     TEXT         NOT NULL COMMENT '报障原文',
  category        VARCHAR(24)  NOT NULL COMMENT 'account/network/hardware/meeting/software/business/other',
  category_label  VARCHAR(32)  NOT NULL,
  priority        VARCHAR(4)   NOT NULL COMMENT 'P0/P1/P2/P3',
  assignee_group  VARCHAR(48)  NOT NULL,
  sla_response    VARCHAR(32)  NOT NULL,
  sla_resolve     VARCHAR(32)  NOT NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'new' COMMENT 'new/in_progress/resolved',
  matched_keywords JSON        DEFAULT NULL COMMENT '命中的关键词，用于展示判定依据',
  missing_info    JSON         DEFAULT NULL COMMENT '需报障人补充的信息',
  suggestions     JSON         DEFAULT NULL COMMENT '处置建议',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_tickets_no (ticket_no),
  KEY idx_tickets_status (status),
  KEY idx_tickets_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='IT 工单（演示数据）';

SET FOREIGN_KEY_CHECKS = 1;
