/**
 * 管理端「通知」：站长给单个/多个用户发通知，可要求强制已读；
 * 可选「确认收到前禁用某些模块权限（如 AI 中转站，同步禁用 NewAPI 账户）」，
 * 用户确认收到后自动还原权限 + 重新启用 NewAPI。
 *
 * 2026-10-04 扩展「捐献门槛」：勾选后可要求用户**捐献指定渠道**
 * （wb 反代账号 / 内网穿透 / 代理节点）才解锁 —— 用户点「确认收到」时
 * 若还没捐，权限**保持锁定**、通知也不会标记已读（否则弹窗消失、用户再也不知道要去捐）。
 * 捐完点「我已捐献，重新检测」再走同一个 ack 接口即可解锁。
 *
 * 用户侧弹窗仿照 `appeal-ack-dialog.tsx`（封禁解除后的强制已读窗）。
 *
 * 接口：
 *   · POST /admin/notices            —— 发送（requireAdmin）
 *   · GET  /admin/notices            —— 列表（requireAdmin）
 *   · POST /admin/notices/revoke     —— 撤回（requireAdmin，自动还原权限）
 *   · GET  /api/notice/pending       —— 当前用户未确认的通知（requireUser）
 *   · POST /api/notice/ack           —— 确认收到（requireUser，满足门槛才还原权限）
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser } from "../auth"
import { requireAdminScope } from "./admin"
import { isUsernameWhitelisted } from "./moderation-lists"
import { audit as recordAudit } from "../settings"
import { parsePermissions, FEATURES, type Permissions } from "../permissions"
import { isNewApiConfigured, adminSetUserStatus } from "../newapi-client"
import { uuid } from "../crypto"
import type { Env } from "../env"

interface NoticeRow {
  id: string
  user_id: string
  title: string
  body: string
  require_ack: number
  restrict_features: string | null
  restore_permissions: string | null
  newapi_disabled: number
  created_by: string | null
  created_at: string
  read_at: string | null
  revoked_at: string | null
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const buf = await readBodyCapped(request, 128 * 1024, "请求体过大")
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError(400, "请求格式不正确", "INVALID_JSON")
  }
}

/** 取合法模块名（只认 FEATURES 里的） */
function normalizeFeatures(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out = new Set<string>()
  for (const x of input) {
    if (typeof x === "string" && (FEATURES as readonly string[]).includes(x)) out.add(x)
  }
  return [...out]
}

/**
 * 禁用某用户的若干模块权限（并联动 NewAPI）。返回还原快照（显式 JSON）。
 * 若目标模块本来就没开（或用户不存在），返回 null = 无需禁用、也无需还原。
 */
export async function restrictUserFeatures(
  env: Env,
  userId: string,
  features: string[]
): Promise<{ restore: string | null; newapiDisabled: boolean }> {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  if (!row) return { restore: null, newapiDisabled: false }

  const perms = parsePermissions(row.permissions)
  let changed = false
  for (const f of features) {
    if (perms[f as keyof Permissions] === true) {
      perms[f as keyof Permissions] = false
      changed = true
    }
  }
  if (!changed) return { restore: null, newapiDisabled: false }

  // 快照 = 禁用前的**显式**权限（还原时写回，语义与原来一致）
  const restore = JSON.stringify(parsePermissions(row.permissions))
  const now = new Date().toISOString()
  await env.DB.prepare("UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(perms), now, userId)
    .run()

  let newapiDisabled = false
  if (features.includes("ai")) {
    const acct = await env.DB.prepare("SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?")
      .bind(userId)
      .first<{ newapi_user_id: number }>()
    if (acct && (await isNewApiConfigured(env))) {
      try {
        await adminSetUserStatus(env, acct.newapi_user_id, "disable")
        newapiDisabled = true
      } catch (err) {
        await recordAudit(
          env,
          userId,
          "notice.newapi.disable_failed",
          `通知禁用中转站，但 NewAPI 账户 #${acct.newapi_user_id} 禁用失败：${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }
  return { restore, newapiDisabled }
}

/** 还原权限 + 重新启用 NewAPI（满足门槛后确认收到 / 撤回时调用） */
export async function restoreUserFeatures(env: Env, notice: NoticeRow): Promise<void> {
  if (notice.restore_permissions) {
    // ⚠️ 2026-10-07 修复：原实现是「把 permissions 整串覆盖回快照」。
    //
    // 快照是**限制权限的那一刻**拍的，而用户完全可能在「通知发出」到「确认收到」
    // 之间又拿到了新权限（积分商城买、捐献通过、兑换券…）。整串覆盖会把那些
    // 新权限一起抹掉，用户看到的就是「我明明有内网穿透权限，怎么进不去」
    // （实例：a229740548 —— 通知 10-04 创建，他 10-05 买了内网穿透 + 直链网盘，
    //  10-07 确认通知后两个权限双双消失）。
    //
    // 现在只做「补回」：把**本通知当时确实收回、且现在仍为 false** 的权限置回 true，
    // 其余字段一律不动。既不误删新权限，也能把被误删的权限找回来。
    const target = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(notice.user_id)
      .first<{ permissions: string | null }>()
    if (target) {
      const snapshot = parsePermissions(notice.restore_permissions)
      const current = parsePermissions(target.permissions)
      type F = (typeof FEATURES)[number]

      // 本通知申请限制的功能；老数据 restrict_features 可能为空，
      // 那就退化成「快照里为 true 的都算被收回过」。
      let restricted: string[] = []
      try {
        const raw = notice.restrict_features ? JSON.parse(notice.restrict_features) : []
        if (Array.isArray(raw)) {
          restricted = raw.filter((x): x is string => typeof x === "string")
        }
      } catch {
        restricted = []
      }
      if (restricted.length === 0) {
        restricted = FEATURES.filter((f) => snapshot[f] === true)
      }

      let changed = false
      for (const f of restricted) {
        if (!(FEATURES as readonly string[]).includes(f)) continue
        const key = f as F
        if (snapshot[key] === true && current[key] !== true) {
          current[key] = true
          changed = true
        }
      }
      if (changed) {
        await env.DB.prepare("UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(current), new Date().toISOString(), notice.user_id)
          .run()
      }
    }
  }
  if (notice.newapi_disabled === 1) {
    const acct = await env.DB.prepare("SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?")
      .bind(notice.user_id)
      .first<{ newapi_user_id: number }>()
    if (acct && (await isNewApiConfigured(env))) {
      try {
        await adminSetUserStatus(env, acct.newapi_user_id, "enable")
      } catch (err) {
        await recordAudit(
          env,
          notice.user_id,
          "notice.newapi.enable_failed",
          `通知确认后重新启用 NewAPI 账户 #${acct.newapi_user_id} 失败：${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }
}

// ---------------- 用户侧 ----------------

/**
 * GET /api/notice/pending —— 当前用户未确认、未撤回的通知（强制弹窗用它）。
 *
 * 附带实时计算的捐献门槛状态：前端据此决定弹窗是「确认收到」还是
 * 「还需捐献 X」。**每次现算**而不缓存 —— 用户刚捐完就刷新页面的场景下，
 * 缓存会让他看到过期的「未捐献」。
 */
export async function pendingNotices(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, title, body, created_at
       FROM admin_notices
      WHERE user_id = ? AND require_ack = 1 AND read_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at ASC`
  )
    .bind(user.id)
    .all<{
      id: string
      title: string
      body: string
      created_at: string
    }>()

  const notices = (rows.results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    createdAt: r.created_at,
  }))
  return json({ notices })
}

/**
 * POST /api/notice/ack —— 确认收到。
 *
 * 若该通知要求捐献且**尚未满足**：不改任何权限、**也不写 read_at**
 * （弹窗必须继续拦着，否则用户点一下就再也看不到要去捐献这件事），
 * 返回 `{ ok: false, donationRequired: { required, missing } }`，前端切到
 * 「还需捐献」态并显示「我已捐献，重新检测」。用户捐完再点即走这里通过。
 */
export async function ackNotice(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少通知 id", "INVALID_INPUT")

  const notice = await env.DB.prepare("SELECT * FROM admin_notices WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first<NoticeRow>()
  if (!notice) throw new ApiError(404, "通知不存在", "NOT_FOUND")
  if (notice.read_at) return json({ ok: true, unlocked: true }) // 幂等

  await restoreUserFeatures(env, notice)
  await env.DB.prepare("UPDATE admin_notices SET read_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run()
  await recordAudit(env, user.id, "notice.ack", `确认收到通知「${notice.title}」`)
  return json({ ok: true, unlocked: true })
}

// ---------------- 管理端 ----------------

/** POST /admin/notices —— 发送通知 */
export async function sendNotice(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "notices")
  const body = await readJson(request)
  const usernames = Array.isArray(body.usernames)
    ? (body.usernames as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
    : []
  const title = String(body.title ?? "").trim()
  const text = String(body.body ?? "").trim()
  if (usernames.length === 0) throw new ApiError(400, "请指定接收用户", "INVALID_INPUT")
  if (!title || !text) throw new ApiError(400, "标题和正文不能为空", "INVALID_INPUT")

  const restrictFeatures = normalizeFeatures(body.restrictFeatures)

  const now = new Date().toISOString()
  const sent: string[] = []
  const missing: string[] = []
  /** 白名单用户：通知照发，但不动权限（见下方注释） */
  const whitelisted: string[] = []
  let restricted = 0

  for (const username of usernames) {
    const target = await env.DB.prepare(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE"
    )
      .bind(username)
      .first<{ id: string }>()
    if (!target) {
      missing.push(username)
      continue
    }

    /**
     * 白名单豁免（2026-10-04，站长要求「保持白名单状态」）。
     *
     * 白名单的语义是「这个账号不会被平台处置」。封禁路径早已豁免
     * （admin.ts::updateUser 在写库前拦），但**通知限权是另一条独立的
     * 处置路径**，原先没查白名单 —— 结果是「白名单用户照样被限权」，
     * 与白名单的存在意义矛盾。这里补上：**通知照常送达**（他仍需知道
     * 发生了什么事），但**不碰他的权限**。
     */
    const isWhite = await isUsernameWhitelisted(env, username)
    if (isWhite) whitelisted.push(username)

    let restore: string | null = null
    let newapiDisabled = false
    if (restrictFeatures.length > 0 && !isWhite) {
      const r = await restrictUserFeatures(env, target.id, restrictFeatures)
      restore = r.restore
      newapiDisabled = r.newapiDisabled
      if (r.restore) restricted++
    }

    await env.DB.prepare(
      `INSERT INTO admin_notices
         (id, user_id, title, body, require_ack, restrict_features, restore_permissions, newapi_disabled, created_by, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    )
      .bind(
        uuid(),
        target.id,
        title,
        text,
        restrictFeatures.length ? JSON.stringify(restrictFeatures) : null,
        restore,
        newapiDisabled ? 1 : 0,
        admin.id,
        now
      )
      .run()
    sent.push(username)
  }

  await recordAudit(
    env,
    admin.id,
    "notice.send",
    `给 ${sent.length} 人发通知「${title}」，限制权限 ${restricted} 人` +
      `${whitelisted.length ? `，白名单跳过限权 ${whitelisted.length} 人` : ""}` +
      `${missing.length ? `，未找到 ${missing.length} 人` : ""}`
  )

  return json({
    sent,
    missing,
    restricted,
    whitelisted,
  })
}

/** GET /admin/notices —— 通知列表 */
export async function listNotices(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "notices")
  const rows = await env.DB.prepare(
    `SELECT n.*, u.username, a.username AS creator
       FROM admin_notices n
       JOIN users u ON u.id = n.user_id
       LEFT JOIN users a ON a.id = n.created_by
      ORDER BY n.created_at DESC
      LIMIT 200`
  ).all<NoticeRow & { username: string; creator: string | null }>()
  return json({
    notices: (rows.results ?? []).map((r) => ({
      id: r.id,
      username: r.username,
      title: r.title,
      body: r.body,
      restrictFeatures: r.restrict_features ? JSON.parse(r.restrict_features) : [],
      newapiDisabled: r.newapi_disabled === 1,
      creator: r.creator,
      createdAt: r.created_at,
      readAt: r.read_at,
      revokedAt: r.revoked_at,
    })),
  })
}

/** POST /admin/notices/revoke —— 撤回（未确认则还原权限） */
export async function revokeNotice(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "notices")
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少通知 id", "INVALID_INPUT")

  const notice = await env.DB.prepare("SELECT * FROM admin_notices WHERE id = ?")
    .bind(id)
    .first<NoticeRow>()
  if (!notice) throw new ApiError(404, "通知不存在", "NOT_FOUND")

  // 撤回 = 站长主动放弃这次要求 ⇒ **无条件**还原（哪怕捐献门槛没满足）
  if (!notice.read_at && !notice.revoked_at) {
    await restoreUserFeatures(env, notice)
  }
  await env.DB.prepare("UPDATE admin_notices SET revoked_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run()
  await recordAudit(env, admin.id, "notice.revoke", `撤回通知「${notice.title}」`)
  return json({ ok: true })
}
