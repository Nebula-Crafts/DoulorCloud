-- 0176_card_numbers.sql（2026-11-06 会员等级「银行卡号」）
--
-- 1) users.card_no —— 会员银行卡号（16 位数字，Luhn 校验位齐全，展示成 4-4-4-4）。
--    站长要求：等级升到黄金及以上时在银行卡中间显示这个号，之后继续升级**号码不变**。
--    因此它是用户身上的持久字段，而不是按等级现算。
--    列允许为空：普通会员没有卡号；历史黄金及以上用户由运行时懒生成补齐
--    （生成需要 Luhn 计算 + 唯一性重试，SQL 里做很别扭，交给 card-numbers.ts）。
--
-- 2) card_vanity_numbers —— 后台「靓号预留 / 发放」池。
--    预留的号不会被自动生成命中；发给某个用户后 status 变 issued 并记下 user_id。
--
-- 唯一性：card_no 用**部分唯一索引**（只约束非空值）。SQLite 的唯一索引允许多个
-- NULL，但显式写 WHERE card_no IS NOT NULL 让意图更清楚，也少一次全表判空。
ALTER TABLE users ADD COLUMN card_no TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_card_no ON users(card_no) WHERE card_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS card_vanity_numbers (
  -- 归一化后的 16 位数字串（无空格）
  number      TEXT PRIMARY KEY,
  -- reserved = 已预留未发放；issued = 已发给某个用户
  status      TEXT NOT NULL DEFAULT 'reserved',
  user_id     TEXT,
  note        TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_vanity_status ON card_vanity_numbers(status);