-- 0174_shop_admin_only.sql（2026-11-06 商城收敛为「仅管理员发布商品」）
--
-- 用户上架商品的整条链路已下线（上架 / 编辑 / 删除 / 卡密池 / 审核接口与前端入口
-- 全部删除）。历史数据按「下架」处理，不物理删除：
--   · 已成交订单与售后仍要能查（`point_orders.product_id` 悬空不影响对账）
--   · 卖家若还有未交付订单，取消会由订单侧逻辑处理，不由这里兜底
--
-- 下架方式：`enabled = 0`，并把这些商品的审核状态标记为 approved 之外的
-- 中性值「已下架」由 enabled 表达，review_status 保持原样（审计可追溯）。

UPDATE point_products
   SET enabled = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE owner_id IS NOT NULL
   AND enabled = 1;

-- 待审核的用户商品一并终结（不会再有管理员去审了）
UPDATE point_products
   SET review_status = 'rejected',
       review_note = COALESCE(review_note, '商城已改为仅管理员发布商品，用户上架通道关闭'),
       reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE owner_id IS NOT NULL
   AND review_status = 'pending';
