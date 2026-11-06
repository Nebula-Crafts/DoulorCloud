-- 0175_shop_simplify.sql（2026-11-06 商城收敛 + 兑换下线）
--
-- 1) 交付方式只保留四种（人工发放 / 邀请码额度 / 卡密 / 固定内容）：
--    充余额（quota）、模块权限（feature）、订阅（subscription）、补签卡（checkin_makeup）
--    都不再可选 —— 前三者依赖已下线的中转站与权限模块。
-- 2) 移除租用模式（一律买断）。
-- 3) 移除「积分兑换中转站余额」的三个设置键与「自动确认收货」设置键。
--
-- 处理方式：**下架**不合规的存量商品（enabled=0），不物理删除 ——
-- 已成交订单与售后仍要能查，买家「我的订单」里也还要能看到买过什么。

UPDATE point_products
   SET enabled = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE enabled = 1
   AND (
     delivery IN ('quota', 'feature', 'subscription', 'checkin_makeup')
     OR billing_mode = 'rental'
   );

DELETE FROM app_settings
 WHERE key IN (
   'points_enabled',
   'points_yuan_per_point',
   'points_redeem_daily_limit',
   'shop_auto_confirm_days'
 );