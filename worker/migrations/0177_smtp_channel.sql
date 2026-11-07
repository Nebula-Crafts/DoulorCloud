-- 0177_smtp_channel.sql（2026-11-07 邮件通道：Posta 自建网关 → 直连 SMTP）
--
-- 站长要求把「Posta（自建 HTTP→SMTP 网关）」换成一个**基础 SMTP 配置**（主机 /
-- 端口 / 账号 / 授权码），直接接任意邮箱的 SMTP（QQ / 163 / Gmail / 企业邮箱）。
-- 协议实现在 worker/src/smtp.ts（cloudflare:sockets 出站 TCP）。
--
-- 处理：
--   1) mail_transport_order / announcement_mail_transport 里的 "posta" 改成 "smtp"
--      （管理员已配置的顺序语义原样保留，只是通道换了实现）；
--   2) 旧的 posta_* 三个设置键删除（网关地址 / 网关 Key / 网关发件人都没意义了）；
--   3) 新键（smtp_host / smtp_port / smtp_username / smtp_password /
--      smtp_from_email / smtp_from_name）不在此处插入 —— app_settings 是稀疏表，
--      读取侧 getSetting 落到 SETTING_DEFAULTS 的默认值即可（空 = 未配置）。

UPDATE app_settings
   SET value = replace(value, 'posta', 'smtp')
 WHERE key IN ('mail_transport_order', 'announcement_mail_transport')
   AND value LIKE '%posta%';

DELETE FROM app_settings WHERE key IN ('posta_url', 'posta_key', 'posta_from');