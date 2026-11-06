-- 0171_drop_fun_links.sql（2026-11-06 大裁撤收尾）
--
-- 「网页分享」（趣站链接）的用户侧入口原本在「工具箱」页面里，工具箱已随
-- 2026-11-06 的裁撤删除，管理端却还能配置 —— 功能成了死链。
-- 这里把整套 fun-links 下架（handler / 路由 / 管理面板已一并删除），表一并清掉。

DROP TABLE IF EXISTS fun_links;

DELETE FROM app_settings WHERE key IN ('fun_links_enabled');
