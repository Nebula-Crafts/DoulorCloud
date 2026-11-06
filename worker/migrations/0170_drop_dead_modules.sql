-- 0170_drop_dead_modules.sql（2026-11-06 大裁撤收尾）
--
-- 模块删除（邮箱 / 网盘 / AI 中转站 / 模拟人生·游戏仓库 / 代理节点 / 个人名片 /
-- 工具箱 / 捐献 / 反代 wb2api·qoder2api·商汤 / 临时分享箱）之后，把对应的
-- 业务表与遗留设置键清掉。相关 handler 已在本批删除，这些表不再有写入方。
--
-- ⚠️ 保留不动（仍有读取方 / 属于地基）：
--   · mailboxes / messages           —— 站内系统信仍用（/space 统计也读）
--   · newapi_accounts                —— 历史绑定的留存记录（用户删除时仍会禁用上游）
--   · donations                      —— 历史捐献记录：/space「历史贡献」仍展示存量数据
--   · storage_objects / storage_accounts —— R2 地基（头像 / 商品封面 / 社区图）
--   · user_api_keys / r2_buckets     —— 公开 API Key 与桶配置仍在用

-- ---- 模拟人生 / 游戏仓库（含星币体系 0168）----
DROP TABLE IF EXISTS game_trades;
DROP TABLE IF EXISTS game_positions;
DROP TABLE IF EXISTS game_candles;
DROP TABLE IF EXISTS game_pool_ledger;
DROP TABLE IF EXISTS game_market;
DROP TABLE IF EXISTS game_wallets;
DROP TABLE IF EXISTS collection_plugins;

-- ---- 代理节点 ----
DROP TABLE IF EXISTS proxy_node_health;
DROP TABLE IF EXISTS proxy_node_fingerprints;
DROP TABLE IF EXISTS proxy_subscriptions;
DROP TABLE IF EXISTS proxy_activation;

-- ---- 反代网关（wb2api / qoder2api）----
DROP TABLE IF EXISTS wb2api_login_sessions;
DROP TABLE IF EXISTS wb2api_bindings;
DROP TABLE IF EXISTS wb2api_credentials;
DROP TABLE IF EXISTS qoder2api_login_sessions;
DROP TABLE IF EXISTS qoder2api_bindings;
DROP TABLE IF EXISTS qoder2api_credentials;

-- ---- 捐献的模型重试队列 ----
DROP TABLE IF EXISTS donation_model_retries;

-- ---- 临时分享箱 ----
DROP TABLE IF EXISTS tempbox_batches;

-- ---- 遗留设置键（对应 handler 已删，读取方为空）----
DELETE FROM app_settings WHERE key IN (
  'game_enabled', 'game_tick_seconds', 'game_candle_seconds', 'game_max_leverage',
  'game_min_margin', 'game_fee_open_bps', 'game_fee_close_bps', 'game_maintenance_bps',
  'game_noise_bps', 'game_impact_bps', 'game_mean_reversion_bps',
  'game_reversion_deadband_bps', 'game_anchor_follow_bps', 'game_max_impact_bps',
  'game_base_price',
  'proxy_enabled',
  'storage_enabled', 'storage_quota_bytes', 'storage_max_file_bytes',
  'tempbox_enabled', 'tempbox_default_minutes', 'tempbox_max_files',
  'tempbox_max_file_bytes', 'tempbox_upload_requires_login',
  'wb2api_enabled', 'wb2api_realm_cn', 'wb2api_realm_global', 'wb2api_donation_visible',
  'qoder2api_enabled', 'qoder2api_base_url', 'qoder2api_realm', 'qoder2api_realm_cn',
  'qoder2api_realm_intl', 'qoder2api_max_bindings', 'qoder2api_donation_visible',
  'sensenova_enabled', 'sensenova_donation_visible',
  'newapi_enabled', 'newapi_group', 'newapi_visible_groups', 'newapi_donation_group',
  'newapi_free_plan_id', 'newapi_trial_quota', 'newapi_unlimited_quota',
  'donation_grant_ai', 'donation_grant_proxy', 'donation_grant_sensenova',
  'donation_grant_wb2api', 'donation_grant_qoder2api', 'donation_admin_notify_email',
  'auto_review_features',
  'invite_reward_plan_id', 'invite_reward_ai_plan_id'
);
