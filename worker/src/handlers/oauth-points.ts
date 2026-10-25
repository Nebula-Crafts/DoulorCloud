/**
 * 积分互通：外部 OAuth 应用消费本站积分（2026-10-25）。
 *
 * 谁在调：**第三方应用的服务端**，不是浏览器。认证走 OAuth access_token
 * （Authorization: Bearer，由 /oauth/token 签发，scope 必须含 `points`）。
 * 用户在授权页（/oauth/consent）亲自勾选过「允许该应用使用我的积分」。
 *
 * 两个端点：
 *   GET  /api/v1/points/balance   → { balance, username }
 *   POST /api/v1/points/spend     → { balance, applied, ... }  幂等（带 requestId 时）
 *
 * 安全边界（每条都有对应的实现，改之前先读）：
 *   1. **只扣不加**：spend 只接受正数金额并取负入账。外部应用给用户「充钱」
 *      等于把积分增发权交给任意第三方，不在本功能的边界内。
 *   2. **单笔上限 / 单应用日累计上限**：防「拿到授权后一把梭哈」——token 有效
 *      期内应用能反复调，没有这两道闸，用户授权一次就可能被清空。
 *   3. **幂等**：网络重试不该重复扣钱。requestId 由应用侧生成、按
 *      （应用 + 用户 + requestId）全局去重（points 表 dedup_key 唯一索引兜底）。
 *   4. **审计**：流水 detail 写应用名 + 应用自述的用途；created_by 存 client_id，
 *      用户侧流水与管理端都能看见「这分花在了哪个应用」。
 */
import { ApiError, json } from "../http"
import { verifyAccessToken, loadClientByClientId } from "../oauth-provider"
import { applyPoints, getPointsBalance, type PointReason } from "../points"
import { guardRateLimit } from "../ratelimit"
import type { Env } from "../env"

/** 单笔最大扣减（积分）。够买站内绝大多数商品，同时把「误授权」的损失封顶 */
const MAX_SPEND_PER_REQUEST = 5000

/** 同一应用对同一用户的**日累计**扣减上限。跨应用各自独立计算 */
const DAILY_LIMIT_PER_USER_CLIENT = 20000

/** spend 接口限流：按应用计数（应用维度的爆刷防护；用户维度由日累计兜底） */
const SPEND_RATE_LIMIT = { limit: 60, windowSeconds: 60 }

/** reason 固定为 app —— 外部消费在流水里永远可识别 */
const SPEND_REASON: PointReason = "app"

interface TokenContext {
  userId: string
  clientId: string
  scopes: string
}

/** 从 Authorization: Bearer 取 OAuth 令牌并校验 points scope 与账号状态 */
async function requirePointsToken(env: Env, request: Request): Promise<TokenContext> {
  const auth = request.headers.get("Authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  const token = m?.[1]?.trim() ?? ""
  const info = token ? await verifyAccessToken(env, token) : null
  if (!info) {
    throw new ApiError(401, "access_token 无效或已过期", "UNAUTHORIZED")
  }
  if (!info.scopes.split(/\s+/).includes("points")) {
    throw new ApiError(403, "该令牌未获准使用积分（缺少 points scope）", "SCOPE_DENIED")
  }
  const user = await env.DB.prepare("SELECT status FROM users WHERE id = ? LIMIT 1")
    .bind(info.userId)
    .first<{ status: string }>()
  if (!user || user.status !== "active") {
    throw new ApiError(403, "账号不可用", "ACCOUNT_SUSPENDED")
  }
  return info
}

/** GET /api/v1/points/balance —— 应用侧查余额（展示给用户看「你还剩多少」） */
export async function pointsBalance(env: Env, request: Request): Promise<Response> {
  const t = await requirePointsToken(env, request)
  const [balance, user] = await Promise.all([
    getPointsBalance(env, t.userId),
    env.DB.prepare("SELECT username FROM users WHERE id = ?")
      .bind(t.userId)
      .first<{ username: string }>(),
  ])
  return json({ balance, username: user?.username ?? "" })
}

/** POST /api/v1/points/spend —— 扣减积分。body: { amount, description?, requestId? } */
export async function pointsSpend(env: Env, request: Request): Promise<Response> {
  const t = await requirePointsToken(env, request)

  await guardRateLimit(
    env,
    `oauthpts:${t.clientId}`,
    SPEND_RATE_LIMIT.limit,
    SPEND_RATE_LIMIT.windowSeconds,
    "消费请求过于频繁"
  )

  const body = (await request.json().catch(() => null)) as {
    amount?: unknown
    description?: unknown
    requestId?: unknown
  } | null

  const amount = Math.trunc(Number(body?.amount))
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SPEND_PER_REQUEST) {
    throw new ApiError(
      400,
      `amount 需为 1 ~ ${MAX_SPEND_PER_REQUEST} 的整数（积分）`,
      "INVALID_AMOUNT"
    )
  }

  const description =
    typeof body?.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, 100)
      : ""
  const requestId =
    typeof body?.requestId === "string" && body.requestId.trim()
      ? body.requestId.trim().slice(0, 64)
      : null
  if (body?.requestId !== undefined && body?.requestId !== null && !requestId) {
    throw new ApiError(400, "requestId 需为 1 ~ 64 个字符", "INVALID_REQUEST_ID")
  }

  // 日累计：同一应用对同一用户，今天已扣多少（跨 token、跨请求累计）。
  // 用 created_by（= client_id）过滤 —— 比按应用名 LIKE 稳，改名也不影响口径。
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const spent = await env.DB.prepare(
    `SELECT COALESCE(SUM(-delta), 0) AS c FROM point_transactions
      WHERE user_id = ? AND reason = 'app' AND app_client_id = ? AND created_at >= ?`
  )
    .bind(t.userId, t.clientId, since)
    .first<{ c: number }>()
  const client = await loadClientByClientId(env, t.clientId)
  const clientName = client?.name ?? t.clientId
  const todaySpent = Number(spent?.c ?? 0)
  if (todaySpent + amount > DAILY_LIMIT_PER_USER_CLIENT) {
    throw new ApiError(
      429,
      `超出该应用的日累计上限（今日已消费 ${todaySpent} / ${DAILY_LIMIT_PER_USER_CLIENT} 积分）`,
      "DAILY_LIMIT"
    )
  }

  const res = await applyPoints(env, {
    userId: t.userId,
    delta: -amount,
    reason: SPEND_REASON,
    detail: `外部应用「${clientName}」${description ? `：${description}` : "消费"}`,
    // 幂等键按「应用 + requestId」—— 同一应用的同一笔业务重试不重复扣；
    // 不带 requestId 的调用视为应用明确允许重复（每次都扣）。
    dedupKey: requestId ? `app:${t.clientId}:${requestId}` : null,
    // 溯源到应用：app_client_id（created_by 有 users 外键，装不下 client_id）
    appClientId: t.clientId,
  })

  if (!res.applied) {
    if (res.reason === "duplicated") {
      // 幂等命中：对调用方是「成功」（钱已经扣过了），返回当前余额
      return json({ applied: true, duplicated: true, balance: res.balance })
    }
    throw new ApiError(
      409,
      `积分余额不足（当前 ${res.balance}，本次需要 ${amount}）`,
      "INSUFFICIENT_POINTS"
    )
  }

  return json({ applied: true, balance: res.balance })
}
