-- 0173_clean_replacement_chars.sql（2026-11-06 修复积分流水里的乱码）
--
-- 现场：`point_transactions.detail` 里出现过
--   「外部应用「�ⲿ����E2E����」：E2E ��������」
-- 根因：OAuth 应用消费接口当时把客户端送的 `description` 原样拼接落库，
-- 而客户端（Windows 终端 curl）送的字节不是合法 UTF-8 ⇒ TextDecoder 解出
-- 一串 U+FFFD（char 65533）⇒ 原样入库，事后无法还原。
--
-- 写入侧已在 `worker/src/text-sanitize.ts` 拦住（U+FFFD / 零宽 / 控制字符全清），
-- 这里清掉已经脏掉的历史行：只删替换字符本身，其余文字保留。
-- 清理后可能出现「：」后为空的情况，顺手把结尾的标点与空白裁掉。

UPDATE point_transactions
   SET detail = trim(replace(detail, char(65533), ''))
 WHERE detail LIKE '%' || char(65533) || '%';

UPDATE point_transactions
   SET detail = rtrim(rtrim(detail, ' '), '：:')
 WHERE detail LIKE '%：' OR detail LIKE '% ';

-- 清洗后变成空串的（原本整段都是乱码）落成一句可解释的说明，
-- 避免明细里出现一条没有描述的记录。
UPDATE point_transactions
   SET detail = '外部应用消费（原始描述含非法字符，已清理）'
 WHERE reason = 'app' AND (detail IS NULL OR detail = '');
