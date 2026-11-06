-- 0172_post_reports.sql（2026-11-06 社区举报）
--
-- 用户对「别人的」帖子 / 评论发起举报，管理员在「监管 → 举报」里逐条处理：
-- 忽略（内容保留）或下架（软删内容）。此前违规内容只能靠肉眼发现，
-- 普通用户没有任何反馈通道。
--
-- 设计取舍：
--   · 只存「谁举报了哪条内容」，不冗余正文 —— 处理时实时读内容，
--     内容被作者自行删除时举报自动失去意义（列表里标注已失效）。
--   · author_id 存快照：内容被删后仍能显示「被举报的是谁」，便于识别惯犯。
--   · 同一人对同一目标**只能有一条待处理举报**（见下方部分唯一索引），
--     避免一个人把一条内容刷成几十条待办。
--   · 历史记录不删：忽略 / 下架都改 status，便于事后追溯「这条被举报过几次」。

CREATE TABLE IF NOT EXISTS post_reports (
  id TEXT PRIMARY KEY,
  /** 'post' | 'comment' */
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  /** 举报人 */
  reporter_id TEXT NOT NULL,
  /** 被举报内容的作者（快照；内容被删后仍可展示） */
  author_id TEXT,
  /** 举报原因短键：spam / abuse / illegal / copyright / other */
  reason TEXT NOT NULL,
  /** 补充说明（可选，≤300 字） */
  note TEXT,
  /** pending（待处理）| ignored（已忽略）| removed（已下架） */
  status TEXT NOT NULL DEFAULT 'pending',
  /** 处理人（管理员 id） */
  handled_by TEXT,
  handled_at TEXT,
  created_at TEXT NOT NULL
);

-- 待处理队列按时间正序翻（最老的先处理）
CREATE INDEX IF NOT EXISTS idx_post_reports_status
  ON post_reports(status, created_at);

-- 同一举报人对同一目标的「待处理」举报只能有一条
CREATE UNIQUE INDEX IF NOT EXISTS idx_post_reports_pending_unique
  ON post_reports(target_type, target_id, reporter_id)
  WHERE status = 'pending';

-- 「我的举报」与作者维度的查询
CREATE INDEX IF NOT EXISTS idx_post_reports_reporter
  ON post_reports(reporter_id, created_at);
