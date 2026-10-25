-- 积分互通（2026-10-25）：外部 OAuth 应用消费积分的溯源列。
--
-- 为什么不用 created_by：它带 REFERENCES users(id) 的外键（语义是「操作人
-- 是哪个管理员」），OAuth client_id 不是 users.id，塞进去会触发外键约束。
-- 应用消费单独一列 app_client_id，无外键（应用可能被删，流水要保留）。
ALTER TABLE point_transactions ADD COLUMN app_client_id TEXT;

-- 日累计限额按（用户 × 应用）统计，这条索引就是为那条 SUM 查询服务的。
CREATE INDEX IF NOT EXISTS idx_point_tx_app_user
  ON point_transactions(user_id, app_client_id, created_at);
