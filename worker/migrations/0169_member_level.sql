-- 0169_member_level.sql（2026-11-06 用户等级体系）
--
-- 等级共四级：0=普通会员 1=黄金会员 2=白金会员 3=黑金会员
-- 等级变动只能通过消耗积分升级（用户侧），管理后台可配置各级价格。
-- 不可降级。管理员可手动调整等级（运营兜底）。

ALTER TABLE users ADD COLUMN member_level INTEGER NOT NULL DEFAULT 0;

-- OAuth 客户端的用户等级门槛（0=所有人可授权，1+=固定等级以上才能授权）
ALTER TABLE oauth_clients ADD COLUMN min_level INTEGER NOT NULL DEFAULT 0;
