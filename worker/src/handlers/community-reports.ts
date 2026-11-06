/**
 * 社区举报（2026-11-06）。
 *
 * 用户对**别人的**帖子 / 评论发起举报，管理员在「监管 → 举报」里逐条处理。
 * 在此之前违规内容只能靠管理员肉眼发现，普通用户没有任何反馈通道。
 *
 * 设计取舍：
 *   · **只记录「谁举报了哪条内容」**，不冗余正文 —— 处理时实时读内容，
 *     作者自行删除后举报自动失去意义（列表里标注「内容已删除」）。
 *     唯一的快照是 `author_id`：内容被删后仍能看出被举报的是谁，便于识别惯犯。
 *   · 同一人对同一目标只能有一条**待处理**举报（迁移 0172 的部分唯一索引兜底），
 *     否则一个人就能把一条内容刷成几十条待办。
 *   · 举报不是自动下架：管理员「忽略」或「下架」，两种结果都改 status 留痕，
 *     便于事后回答「这条内容被举报过几次、当时怎么处理的」。
 */
import { ApiError, json, assertContentLengthWithin } from "../http"
import { requireUser, isAnyAdmin } from "../auth"
import { getSettingBool, audit } from "../settings"
import { guardRateLimit } from "../ratelimit"
import { uuid } from "../crypto"
import type { Env } from "../env"

/** 举报原因短键（前端下拉与此一一对应；不认识的直接拒） */
export const REPORT_REASONS = ["spam", "abuse", "illegal", "copyright", "other"] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

const TARGET_TYPES = ["post", "comment"] as const
type TargetType = (typeof TARGET_TYPES)[number]

/** 每人每天最多举报多少条（防刷；正常用户远用不到） */
const DAILY_REPORT_LIMIT = 20
/** 补充说明长度上限 */
const NOTE_MAX = 300

/** 社区是否开放（与 community.ts 的 assertCommunityEnabled 同一口径） */
async function assertCommunityOpen(env: Env, role: string): Promise<void> {
  if (isAnyAdmin(role)) return
  if (!(await getSettingBool(env, "community_enabled"))) {
    throw new ApiError(403, "社区广场暂时关闭", "COMMUNITY_DISABLED")
  }
}

/** POST /api/community/reports —— 举报一条帖子或评论 */
export async function createReport(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await assertCommunityOpen(env, user.role)
  // 连点 / 脚本：1 分钟最多 5 次（日上限在下面按库计数）
  await guardRateLimit(env, `report:${user.id}`, 5, 60, "举报过于频繁，请稍后再试")

  assertContentLengthWithin(request, 8 * 1024, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    targetType?: unknown
    targetId?: unknown
    reason?: unknown
    note?: unknown
  }

  const targetType = String(body.targetType ?? "") as TargetType
  const targetId = String(body.targetId ?? "").trim()
  const reason = String(body.reason ?? "") as ReportReason
  if (!TARGET_TYPES.includes(targetType)) {
    throw new ApiError(400, "举报对象类型不正确", "INVALID_INPUT")
  }
  if (!targetId) throw new ApiError(400, "缺少举报对象", "INVALID_INPUT")
  if (!REPORT_REASONS.includes(reason)) {
    throw new ApiError(400, "举报原因不正确", "INVALID_INPUT")
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : ""

  // 目标必须存在，并取出作者与「是否已删」
  const target =
    targetType === "post"
      ? await env.DB.prepare("SELECT user_id, body, deleted_at FROM posts WHERE id = ?")
          .bind(targetId)
          .first<{ user_id: string; body: string; deleted_at: string | null }>()
      : await env.DB.prepare("SELECT user_id, body, deleted_at FROM post_comments WHERE id = ?")
          .bind(targetId)
          .first<{ user_id: string; body: string; deleted_at: string | null }>()
  if (!target) throw new ApiError(404, "被举报的内容不存在", "NOT_FOUND")
  if (target.deleted_at) {
    throw new ApiError(409, "该内容已被删除，无需举报", "ALREADY_DELETED")
  }
  if (target.user_id === user.id) {
    throw new ApiError(400, "不能举报自己的内容", "SELF_REPORT")
  }

  // 日上限（含已被处理的历史举报，口径简单可解释）
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const todayRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM post_reports WHERE reporter_id = ? AND created_at >= ?"
  )
    .bind(user.id, since)
    .first<{ c: number }>()
  if (Number(todayRow?.c ?? 0) >= DAILY_REPORT_LIMIT) {
    throw new ApiError(
      429,
      `24 小时内最多举报 ${DAILY_REPORT_LIMIT} 条，请稍后再试`,
      "REPORT_DAILY_LIMIT"
    )
  }

  const now = new Date().toISOString()
  const id = uuid()
  try {
    await env.DB.prepare(
      `INSERT INTO post_reports
         (id, target_type, target_id, reporter_id, author_id, reason, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(id, targetType, targetId, user.id, target.user_id, reason, note || null, now)
      .run()
  } catch {
    // 部分唯一索引冲突 = 已经有一条待处理举报，不是错误，如实告诉用户即可
    throw new ApiError(409, "你已经举报过这条内容，我们正在处理", "ALREADY_REPORTED")
  }

  return json({ ok: true, id }, 201)
}

/** 管理员视角的一条举报 */
interface ReportRow {
  id: string
  targetType: string
  targetId: string
  reporterId: string
  authorId: string | null
  reason: string
  note: string | null
  status: string
  handledAt: string | null
  createdAt: string
  reporterName: string | null
  authorName: string | null
  /** 内容摘要（实时读；内容已删时为 null） */
  excerpt: string | null
  /** 内容是否已被删除（作者自删或已处理） */
  targetDeleted: boolean
  /** 举报的是评论时，它所属的帖子 id（用于跳转定位） */
  postId: string | null
}

/**
 * GET /api/admin/reports?status=pending|all —— 举报列表
 *
 * 内容摘要与「是否已删」用 LEFT JOIN 实时算：内容被作者删掉后，
 * 举报仍然留在列表里（标注「内容已删除」），管理员据此可以直接标记忽略。
 */
export async function adminListReports(env: Env, request: Request): Promise<Response> {
  const admin = await requireUser(env, request)
  if (!isAnyAdmin(admin.role)) throw new ApiError(403, "无权访问", "FORBIDDEN")

  const url = new URL(request.url)
  const status = url.searchParams.get("status") === "all" ? "all" : "pending"
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200)

  const where = status === "all" ? "" : "WHERE r.status = 'pending'"
  const rows = await env.DB.prepare(
    `SELECT r.id, r.target_type, r.target_id, r.reporter_id, r.author_id, r.reason,
            r.note, r.status, r.handled_at, r.created_at,
            ru.username AS reporter_name,
            au.username AS author_name,
            CASE WHEN r.target_type = 'post' THEN p.body ELSE c.body END AS body,
            CASE WHEN r.target_type = 'post' THEN p.deleted_at ELSE c.deleted_at END AS deleted_at,
            CASE WHEN r.target_type = 'comment' THEN c.post_id ELSE p.id END AS post_id
       FROM post_reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users au ON au.id = r.author_id
       LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
       LEFT JOIN post_comments c ON r.target_type = 'comment' AND c.id = r.target_id
       ${where}
      ORDER BY r.created_at DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<{
      id: string
      target_type: string
      target_id: string
      reporter_id: string
      author_id: string | null
      reason: string
      note: string | null
      status: string
      handled_at: string | null
      created_at: string
      reporter_name: string | null
      author_name: string | null
      body: string | null
      deleted_at: string | null
      post_id: string | null
    }>()

  // ⚠️ 出参一律 camelCase：库里是 snake_case，但前端类型（ReportItem）是 camelCase，
  //    这里漏转一层的话列表能拉到、字段却全是 undefined（2026-11-06 踩过）。
  const reports: ReportRow[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    reporterId: r.reporter_id,
    authorId: r.author_id,
    reason: r.reason,
    note: r.note,
    status: r.status,
    handledAt: r.handled_at,
    createdAt: r.created_at,
    reporterName: r.reporter_name,
    authorName: r.author_name,
    // 摘要压掉换行，列表里一行放得下
    excerpt: r.body ? r.body.replace(/\s+/g, " ").slice(0, 140) : null,
    targetDeleted: Boolean(r.deleted_at),
    postId: r.post_id,
  }))

  const pendingRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM post_reports WHERE status = 'pending'"
  ).first<{ c: number }>()

  return json({ reports, pending: Number(pendingRow?.c ?? 0), status })
}

/**
 * POST /api/admin/reports/:id/decide —— 处理一条举报
 *
 * body: { action: "ignore" | "remove" }
 *   · ignore —— 内容保留，仅关闭举报（记审计）
 *   · remove —— 软删内容（帖子 deleted_at / 评论清空正文 + deleted_at），与
 *               `community.deletePost` / `deleteComment` 完全同一套语义，
 *               保证「举报下架」与「管理员手动删」在数据上无法区分（也就不会分家）
 */
export async function adminDecideReport(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireUser(env, request)
  if (!isAnyAdmin(admin.role)) throw new ApiError(403, "无权操作", "FORBIDDEN")
  const body = (await request.json().catch(() => ({}))) as { action?: unknown }
  const action = String(body.action ?? "")
  if (action !== "ignore" && action !== "remove") {
    throw new ApiError(400, "处理方式不正确", "INVALID_INPUT")
  }

  const row = await env.DB.prepare(
    "SELECT id, target_type, target_id, author_id, status FROM post_reports WHERE id = ?"
  )
    .bind(id)
    .first<{
      id: string
      target_type: string
      target_id: string
      author_id: string | null
      status: string
    }>()
  if (!row) throw new ApiError(404, "举报不存在", "NOT_FOUND")
  if (row.status !== "pending") {
    throw new ApiError(409, "该举报已处理过了", "ALREADY_HANDLED")
  }

  const now = new Date().toISOString()
  if (action === "remove") {
    if (row.target_type === "post") {
      await env.DB.prepare(
        "UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
        .bind(now, row.target_id)
        .run()
    } else {
      // 与 deleteComment 一致：清空正文 + 软删，列表里留占位
      await env.DB.prepare(
        "UPDATE post_comments SET body = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
        .bind(now, row.target_id)
        .run()
    }
  }

  await env.DB.prepare(
    "UPDATE post_reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?"
  )
    .bind(action === "remove" ? "removed" : "ignored", admin.id, now, id)
    .run()

  await audit(
    env,
    admin.id,
    action === "remove" ? "community.report.remove" : "community.report.ignore",
    `${action === "remove" ? "通过举报下架" : "忽略举报"}：${row.target_type} ${row.target_id}` +
      `（作者 ${row.author_id ?? "?"}）`
  )

  return json({ ok: true, status: action === "remove" ? "removed" : "ignored" })
}

/** 待处理举报数（attention 角标用；表未迁移时返回 0，不影响其它角标） */
export async function countPendingReports(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM post_reports WHERE status = 'pending'"
    ).first<{ c: number }>()
    return Number(row?.c ?? 0)
  } catch {
    return 0
  }
}
