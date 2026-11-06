/**
 * NewAPI（自建 AI 中转站）客户端。
 *
 * 所有凭据只存在于 Worker 端：管理员 Root token 与用户 access token
 * 都不下发到前端。用户明文密码只在开通流程中短暂使用，绝不落库。
 *
 * 关键约束（均已对 https://api.doulor.cn 实测确认）：
 *   1. `POST /api/token/` 不返回 key（连掩码都不返回），完整 key 只能通过
 *      `POST /api/token/:id/key` 取得 —— 建 Key 必须两步。
 *   2. email 只有 `POST /api/user/register` 能写入（管理员建号接口、
 *      /api/user/manage、PUT /api/user/self 都会丢弃 email）。因此开通流程是
 *      「管理员建号 → 自助注册补 email → 管理员叠加额度」。
 *   3. 所有 UserAuth 调用都必须带 `New-Api-User` 头，只有 session cookie 不够。
 *   4. 额度用 `POST /api/user/manage` 的 add_quota（mode: override = 绝对赋值）。
 */
import { ApiError } from "./http"
import { decryptSecret } from "./crypto"
import { fetchWithTimeout } from "./async-utils"
import type { Env } from "./env"

/**
 * NewAPI 调用超时（2026-09-25 审计 H15）。
 * 20 秒：比 CF 管理 API 宽松 —— 有些 NewAPI 部署在慢速机器上，
 * 但绝不该无限等待把 Worker 请求挂死。
 */
const NEWAPI_TIMEOUT_MS = 20_000

interface NewApiConfig {
  baseUrl: string
  /** 可能为 null（公开接口不需要它；需要鉴权的调用由 newApiFetch 拦截） */
  adminToken: string | null
  adminUserId: string
}

/**
 * 管理员凭据的来源：
 *   - `db`：管理面板写入的（优先）—— NewAPI 的「系统访问令牌」随时可能被后台
 *     轮换，改一次就得重跑 wrangler secret 太别扭，因此允许网页端直接更新
 *   - `env`：Worker Secret（NEWAPI_ADMIN_TOKEN / NEWAPI_ADMIN_USER_ID）
 *   - `none`：都没有
 */
export type AdminCredentialSource = "db" | "env" | "none"

const CREDENTIAL_CACHE_MS = 5000
let credentialCache: {
  at: number
  token: string | null
  userId: string
  source: AdminCredentialSource
} | null = null

/**
 * 解析管理员凭据：D1 单据优先，无则回落 env。
 *
 * 加一层 5 秒内存缓存：中转站一次页面加载会连调 getCurrencyInfo / checkHealth /
 * listPricing 等多个接口，每个都要凭据，不缓存会白白多读几次 D1 单行。
 * 更新凭据时主动失效本进程缓存；其他 isolate 最多晚 5 秒感知。
 */
async function resolveAdminCredentials(
  env: Env
): Promise<{ token: string | null; userId: string; source: AdminCredentialSource }> {
  const now = Date.now()
  if (credentialCache && now - credentialCache.at < CREDENTIAL_CACHE_MS) {
    return credentialCache
  }

  let token: string | null = env.NEWAPI_ADMIN_TOKEN ?? null
  let userId = env.NEWAPI_ADMIN_USER_ID ?? "1"
  let source: AdminCredentialSource = token ? "env" : "none"

  // 库里的凭据用 SESSION_SECRET 派生的密钥加密；缺密钥则只能用 env
  if (env.SESSION_SECRET) {
    try {
      const row = await env.DB.prepare(
        "SELECT enc_token, admin_user_id FROM newapi_admin_credentials WHERE id = 1"
      ).first<{ enc_token: string; admin_user_id: string }>()
      if (row) {
        token = await decryptSecret(row.enc_token, env.SESSION_SECRET)
        userId = row.admin_user_id || "1"
        source = "db"
      }
    } catch (err) {
      // 解密失败（如 SESSION_SECRET 换过）不应让全站 AI 功能挂掉，回落到 env
      console.error("读取中转站管理员凭据失败，回落到环境变量:", err)
    }
  }

  credentialCache = { at: now, token, userId, source }
  return credentialCache
}

async function config(env: Env): Promise<NewApiConfig> {
  const baseUrl = env.NEWAPI_BASE_URL
  if (!baseUrl) {
    throw new ApiError(
      503,
      "AI 中转站未配置（缺少 NEWAPI_BASE_URL）",
      "NEWAPI_NOT_CONFIGURED"
    )
  }
  const { token, userId } = await resolveAdminCredentials(env)
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    adminToken: token,
    adminUserId: userId,
  }
}

/** 站点地址与管理员令牌是否都已具备（决定 AI 功能可用性） */
export async function isNewApiConfigured(env: Env): Promise<boolean> {
  if (!env.NEWAPI_BASE_URL) return false
  return Boolean((await resolveAdminCredentials(env)).token)
}


/** NewAPI 的响应信封：{ success, message, data } */
interface Envelope<T> {
  success?: boolean
  message?: string
  data?: T
}

async function newApiFetch(
  env: Env,
  path: string,
  init: RequestInit & { auth?: "admin" | "none" } = {}
): Promise<Response> {
  const cfg = await config(env)
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")

  if (init.auth !== "none") {
    if (!cfg.adminToken) {
      throw new ApiError(
        503,
        "AI 中转站未配置管理员令牌",
        "NEWAPI_NOT_CONFIGURED"
      )
    }
    headers.set("Authorization", `Bearer ${cfg.adminToken}`)
    headers.set("New-Api-User", cfg.adminUserId)
  }

  // 带超时（2026-09-25 审计 H15）：中转站卡住时不能把 Worker 请求一起挂死。
  // 20 秒比 CF 管理 API 宽松 —— 有些 NewAPI 部署在慢速机器上。
  const res = await fetchWithTimeout(`${cfg.baseUrl}${path}`, { ...init, headers }, NEWAPI_TIMEOUT_MS)
  return res
}

/** 解析信封，失败时抛出带 NewAPI 原始 message 的错误 */
async function unwrap<T>(
  res: Response,
  what: string,
  tolerate?: (message: string) => boolean
): Promise<T> {
  const text = await res.text()
  let body: Envelope<T> | null = null
  try {
    body = JSON.parse(text) as Envelope<T>
  } catch {
    body = null
  }

  const message = body?.message ?? ""
  if (!res.ok || !body || body.success === false) {
    if (tolerate && tolerate(message)) {
      return (body?.data ?? ({} as T)) as T
    }
    // 429：NewAPI 的限流中间件（CriticalRateLimit 等）返回的是**空响应体**
    // （实测 `HTTP/1.1 429` + `Retry-After: 1200` + `Content-Length: 0`）。
    // 空 body 解析不出 message，就会退化成下面那句 `HTTP 429` ——
    // 用户只看到一句 "NewAPI 登录失败: HTTP 429"，既不知道发生了什么、
    // 也不知道该不该重试。这里单独识别，给人话 + 明确的等待时长。
    // ⚠️ 这条分支的存在也说明：**不能用「上游状态码被包成 502」来断定
    //    「429 不可能来自 NewAPI」** —— 文案里的 `HTTP 429` 就是它。
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "0")
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? `（约 ${Math.ceil(retryAfter / 60)} 分钟后可重试）`
          : ""
      throw new ApiError(
        429,
        `中转站服务端限流：${what}请求过于频繁${wait}。这不是你的账号问题，稍后再试即可`,
        "NEWAPI_RATE_LIMITED"
      )
    }
    // 401 / 令牌无效：给专属 code，便于前端与管理员定位是令牌问题
    // （可能是管理员令牌 NEWAPI_ADMIN_TOKEN 失效，或用户 access token 失效，
    //   由调用方的 what 上下文区分）
    if (
      res.status === 401 ||
      /invalid access token|unauthorized/i.test(message)
    ) {
      throw new ApiError(
        502,
        `NewAPI ${what}失败：令牌无效或已过期（${message || "Unauthorized"}）。若是管理员操作，请在管理面板「中转站」标签用 root 账户的新访问令牌更新（NewAPI 后台「个人设置 → 安全设置 → 系统访问令牌」可生成/重置）`,
        "NEWAPI_TOKEN_INVALID"
      )
    }
    throw new ApiError(
      502,
      `NewAPI ${what}失败: ${message || `HTTP ${res.status}`}`,
      "NEWAPI_ERROR"
    )
  }
  return (body.data ?? ({} as T)) as T
}

// ---- 管理员操作（使用 Root token）----

/** 按用户名查找 NewAPI 用户（管理员接口） */
export async function findUserByUsername(
  env: Env,
  username: string
): Promise<NewApiUser | null> {
  const res = await newApiFetch(
    env,
    "/api/user/search?keyword=" + encodeURIComponent(username),
    { method: "GET" }
  )
  const data = await unwrap<NewApiUser[] | { items?: NewApiUser[] }>(
    res,
    "查询账号"
  )
  const list = Array.isArray(data) ? data : (data.items ?? [])
  const match = list.find(
    (u) => u.username?.toLowerCase() === username.toLowerCase()
  )
  if (!match) return null
  // 已注销（软删除）的账号视为「不存在」：继续绑定会因账号被删而报 record not found，
  // 应引导用户去中转站重新用 OIDC 登录建号。
  if (match.DeletedAt) return null
  return match
}

export interface NewApiUser {
  id: number
  username: string
  display_name?: string
  email?: string
  quota?: number
  used_quota?: number
  request_count?: number
  group?: string
  role?: number
  status?: number
  /** OIDC 绑定标识（= Doulor Cloud 的 users.id，即我方 OAuth 的 sub） */
  oidc_id?: string
  /** 软删除时间（非空 = 已注销）。绑定流程必须排除，否则 adminSetUserPassword 会 record not found */
  DeletedAt?: string | null
}

/** 调整额度：mode=override 为绝对赋值，add / subtract 为增减 */
export async function adminSetQuota(
  env: Env,
  userId: number,
  value: number,
  mode: "override" | "add" | "subtract" = "override"
): Promise<void> {
  const res = await newApiFetch(env, "/api/user/manage", {
    method: "POST",
    body: JSON.stringify({
      id: userId,
      action: "add_quota",
      value,
      mode,
    }),
  })
  await unwrap(res, "设置额度")
}

/**
 * rc.41 step-up：换一个**一次性**安全验证凭证（proof）。
 *
 * 为什么需要它：new-api 新版把「改用户状态/角色」列为敏感写操作，要求调用方
 * 先自证身份（`/api/verify`，`method=password`，`scope=admin.user.manage`，
 * `context={user_id, action}`），拿到一次性 proof 后再带 `X-Security-Proof` 头
 * 去调 `/api/user/manage`。**proof 与「换它的那个身份」绑定**，所以下面调
 * manage 时必须用**同一个** `NEWAPI_STEPUP_TOKEN`，不能换成 `NEWAPI_ADMIN_TOKEN`。
 *
 * 返回 null 表示「没配 step-up 凭据」（调用方退回老路径）——注意这跟
 * 「配了但验证失败」不同：后者也返回 null，但会在上游留下失败记录。
 *
 * ⚠️ 凭据所属账号不能开 2FA，否则服务端只提供 2FA 动态码方式，密码方式不会被列出。
 */
async function acquireSecurityProof(
  env: Env,
  scope: string,
  context: Record<string, unknown>
): Promise<string | null> {
  const token = env.NEWAPI_STEPUP_TOKEN?.trim()
  const password = env.NEWAPI_STEPUP_PASSWORD?.trim()
  if (!token || !password) return null

  const cfg = await config(env)
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/api/verify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method: "password", scope, context, password }),
    },
    NEWAPI_TIMEOUT_MS
  )
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as { success?: boolean; data?: { proof_token?: string } }
    const proof = parsed?.data?.proof_token
    return typeof proof === "string" && proof ? proof : null
  } catch {
    return null
  }
}

/** 用 step-up 令牌 + 一次性 proof 调一个受保护的管理接口（proof 与身份绑定，必须同一个令牌） */
async function stepUpFetch(
  env: Env,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  proof: string
): Promise<Response> {
  const cfg = await config(env)
  return fetchWithTimeout(
    `${cfg.baseUrl}${path}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.NEWAPI_STEPUP_TOKEN?.trim()}`,
        "X-Security-Proof": proof,
      },
      body: JSON.stringify(body),
    },
    NEWAPI_TIMEOUT_MS
  )
}

/**
 * 管理员启用 / 禁用用户（`POST /api/user/manage` 的 enable / disable）。
 *
 * ⚠️ disable 不仅禁止登录，还会**清掉该用户所有 token 的缓存**，使其
 * 已创建的 API Key 立即失效 —— 这正是「cloud 收回权限 → 中转站 key 失效」
 * 所依赖的机制。
 * 根用户（root）不能被禁用，会返回错误；调用者角色需高于目标用户。
 *
 * 2026-10-07：新版 new-api 给这条接口加了 step-up 安全验证（见
 * `acquireSecurityProof`）。配了 `NEWAPI_STEPUP_*` 时走「换 proof + 带
 * `X-Security-Proof`」；没配则退回老式令牌直调（在 rc.41 上会因缺少安全验证
 * 而被拒，调用方会把失败写进审计 —— 这是刻意保留的降级，避免配错时静默失效）。
 */
export async function adminSetUserStatus(
  env: Env,
  userId: number,
  action: "enable" | "disable"
): Promise<void> {
  const proof = await acquireSecurityProof(env, "admin.user.manage", { user_id: userId, action })
  if (proof) {
    const res = await stepUpFetch(env, "POST", "/api/user/manage", { id: userId, action }, proof)
    await unwrap(res, action === "enable" ? "启用账号" : "禁用账号")
    return
  }

  const res = await newApiFetch(env, "/api/user/manage", {
    method: "POST",
    body: JSON.stringify({ id: userId, action }),
  })
  await unwrap(res, action === "enable" ? "启用账号" : "禁用账号")
}

// 这里原本有一个 `adminSetUserGroup`（管理员把用户转到指定分组），2026-10-13 删除。
// 它对应的那套「绑定后转进 0 倍率免费组，让绑定成为通往免费的唯一闸门」的方案已作废：
// 仓库里从来没有过「免费组」这个设置项，全仓也没有任何调用点。
// 留着它只会让下一个人以为绑定流程会改分组。

// ---- 用户自助注册（公开路由）----

/**
 * 非用户相关的 NewAPI 读取结果缓存（module 级，isolate 内共享）。
 *
 * ⚠️ 2026-10-01 性能：`/api/dev/status`（AI 中转站页首屏）原先每次都串行打
 * 5 次 NewAPI（币种 / 健康 / 定价 / 模型 / 订阅），每次都是「Worker → CF →
 * 隧道 → VPS1」一趟往返，实测一次加载要 3.8 秒。币种、健康、定价这三项
 * **与用户无关**，价格/币种几乎不变、健康徽章也不需要秒级新鲜 ⇒ 加短 TTL。
 * 模型列表与订阅是用户维度的，不在此缓存。
 */
const newapiGlobalCache = new Map<string, { at: number; value: unknown }>()

function cacheTake<T>(key: string, ttlMs: number): T | undefined {
  const hit = newapiGlobalCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
  return undefined
}

function cachePut(key: string, value: unknown): void {
  newapiGlobalCache.set(key, { at: Date.now(), value })
}

/**
 * 读取 NewAPI 的展示币种（无需鉴权）。
 *
 * NewAPI 控制台按 quota_display_type 决定显示 ¥ 还是 $，本站必须跟随，
 * 否则同一个额度在两边显示成不同货币（本实例为 CNY，即 500000 quota = ¥1）。
 * 读取失败时回退为 USD，不影响主流程。
 */
/**
 * 读 NewAPI 展示币种（无需鉴权），带缓存 + 硬超时。
 *
 * 🔴 2026-10-12（站长反馈 AI 中转站页很卡）：实测上游 `api.doulor.cn` 又慢又不稳 ——
 * 同一个 `/api/status` 三次分别 16.2s / 1.4s / 7.1s，`/api/subscription/plans`
 * 一次 27.8s（连「401 拒绝」都要等这么久）。所以：
 *   · **必须带超时**（原先这里没有超时，上游黑洞时页面就永远转圈）；
 *   · TTL 从 60s 拉到 10 分钟 —— 币种几乎不变，没必要每分钟去问一次；
 *   · 再给一个不碰上游的 `peekCurrency`，供首屏使用（见 handlers/newapi.ts）。
 */
const CURRENCY_TTL_MS = 10 * 60 * 1000
const CURRENCY_TIMEOUT_MS = 2500

export interface NewApiCurrency {
  symbol: string
  code: string
  perUnit: number
}

export async function getCurrencyInfo(env: Env): Promise<NewApiCurrency> {
  const cached = cacheTake<NewApiCurrency>("currency", CURRENCY_TTL_MS)
  if (cached) return cached
  try {
    const res = await newApiFetch(env, "/api/status", {
      method: "GET",
      auth: "none",
      signal: AbortSignal.timeout(CURRENCY_TIMEOUT_MS),
    })
    const data = await unwrap<Record<string, unknown>>(res, "读取站点信息")
    const code = String(data.quota_display_type ?? "USD").toUpperCase()
    const symbol = code === "CNY" ? "¥" : "$"
    const perUnit = Number(data.quota_per_unit) || 500000
    const value = { symbol, code, perUnit }
    cachePut("currency", value)
    return value
  } catch (err) {
    console.error("读取 NewAPI 币种失败，回退 USD:", err)
    return { symbol: "$", code: "USD", perUnit: 500000 }
  }
}

export interface NewApiHealth {
  online: boolean
  /** 探测耗时（毫秒）；离线时为 -1 */
  latencyMs: number
  /** 站点版本号（在线时从 /api/status 读取） */
  version: string | null
}

/**
 * ⚠️ 2026-10-13：这里原本是「NewAPI 自助注册」那一整条链的入口：
 *
 *   requestEmailCode(env, email)            // /api/verification，让 NewAPI 发验证码
 *   registerUser(env, u, p, email, code)    // /api/user/register，带 verification_code
 *   generateAccessToken(env, session, uid)  // /api/user/token，用 session cookie 换 token
 *   extractVerificationCode(mailText)       // 从收到的验证码邮件正文里抠出验证码
 *
 * 复核结论：**这条链已经作废，不是「还没接线」，所以直接删掉**（四个函数全删）。
 *
 * 为什么会作废 —— 开通中转站账号的路径在 2026-10-12 换成了 OIDC：
 *   1. 现在建号由**用户在中转站点「用 Doulor Cloud 登录」**完成（OIDC），
 *      账号上的 `oidc_id` = 本站 users.id（见 `resolveMyRelayAccount` 的认人判据）；
 *   2. 回到本站走 `POST /api/dev/bind`（handlers/newapi.ts）：用 OIDC + 复用本站密码
 *      给账号补密码，然后 `login()` 换长期 access token。
 *      也就是说「拿 access token」这条需求已被 `login()` 覆盖 ——
 *      它自 rc.40 起**直接在登录响应里返回 access_token**，不再需要
 *      `generateAccessToken` 那套「session cookie → /api/user/token」两步换令牌。
 *   3. 自助注册还要求本站能**读自己的收件箱**去取 NewAPI 发来的验证码，
 *      而全仓没有任何收件/解析入站邮件的实现（`extractVerificationCode`
 *      连调用者都没有）。留着它就是留一条「谁都调不通」的假路径。
 *
 * 副作用评估：这四个函数全仓无引用（`check-unused-exports.mjs` 的 ALLOW 里挂了很久），
 * 删除后不影响任何现有流程；前端也没有「补 email 自助注册」的入口（属未开工需求）。
 * 若将来真要做自助注册，请连同「收件箱读取」一起设计，不要只把函数放回来。
 */

// ---- 用户级操作 ----

export interface LoginResult {
  userId: number
  accessToken: string
  username?: string
}

/**
 * 用户登录，返回 user id 与访问令牌。
 *
 * ⚠️ NewAPI rc.40 起登录响应**直接返回 access_token**（不再需要「session cookie
 * → /api/user/token」两步换令牌），用户信息也从 data 顶层移到了 data.user。
 * 这里兼容新旧两种结构，并直接取登录返回的 access_token。
 */
export async function login(
  env: Env,
  username: string,
  password: string
): Promise<LoginResult> {
  const res = await newApiFetch(env, "/api/user/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
    auth: "none",
  })
  const data = await unwrap<{
    id?: number
    username?: string
    access_token?: string
    user?: { id: number; username?: string }
    /** 开启二次验证时 NewAPI 只回这个标记，既不带 id 也不带 token */
    require_2fa?: boolean
  }>(res, "登录")

  /**
   * 🔴 2026-10-17 修（用户 xhstu 反馈「AI中转站无法新建KEY」，2026-10-12）。
   *
   * 原实现先判 `!userId`、再判 `!accessToken`。而**两个字段同时缺失**的情况不止一种：
   *   · 账号开了二次验证 —— NewAPI 只回 `require_2fa`，登录其实没完成；
   *   · 账号状态异常 / 密码刚被改过。
   * 于是用户不管遇到哪种，拿到的永远是「NewAPI 登录未返回用户 ID」——
   * 既不是真原因，也完全不知道下一步该干什么（他的原话：反复操作最后卡在这一句）。
   *
   * 现在按真实情况分别报：
   *   · 二次验证 → 明确说要去关 2FA；
   *   · 没令牌   → 说密码可能不对 / 需要重新绑定（这才是「登录没成功」的本义）；
   *   · 没用户ID → 极少见，带上响应字段名便于排查。
   */
  const shape = (() => {
    if (!data || typeof data !== "object") return String(data)
    const keys = Object.keys(data as Record<string, unknown>)
    return keys.length ? keys.join(", ") : "空对象"
  })()

  if (data.require_2fa) {
    throw new ApiError(
      409,
      "该中转站账号开启了二次验证（2FA），登录无法自动完成。请先在中转站里关闭二次验证，或联系管理员在你这边重置。",
      "NEWAPI_2FA_REQUIRED"
    )
  }

  // 兼容新旧两种响应结构
  const userId = data.user?.id ?? data.id
  const remoteUsername = data.user?.username ?? data.username
  const accessToken = data.access_token ?? ""

  if (!accessToken) {
    throw new ApiError(
      502,
      `NewAPI 登录没有返回访问令牌（响应字段：${shape}）。请确认中转站密码是否正确；如果刚改过密码，在本站重新绑定一次即可。`,
      "NEWAPI_ERROR"
    )
  }
  if (!userId) {
    throw new ApiError(
      502,
      `NewAPI 登录没有返回用户 ID（响应字段：${shape}）。请把这个字段列表发给管理员排查。`,
      "NEWAPI_ERROR"
    )
  }
  return { userId, accessToken, username: remoteUsername }
}

/**
 * ⚠️ 2026-10-13：这里原本有 `generateAccessToken(env, session, userId)`
 * （`GET /api/user/token`，用 session cookie 换长期令牌）。已删除，理由：
 *   · 全仓无调用点；
 *   · `login()`（上面那个）自 NewAPI rc.40 起**在登录响应里直接返回 access_token**，
 *     它自己的注释就写着「不再需要『session cookie → /api/user/token』两步换令牌」；
 *   · 于是它是被 `login()` 取代的旧路径，留着只会让人以为还有两种取令牌方式。
 */

/** 以用户身份调用（使用解密后的 access token） */
async function asUser(
  env: Env,
  accessToken: string,
  userId: number,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const cfg = await config(env)
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")
  headers.set("Authorization", `Bearer ${accessToken}`)
  headers.set("New-Api-User", String(userId))
  // ⚠️ 2026-10-08：这里以前是**裸 fetch，没有任何超时** —— 所有「以用户身份」
  // 的调用（列 Key / 拉模型 / 查自额度 …）在隧道被黑洞（连不上也断不开）时会
  // 一直挂着，直到平台层兜底。线上实测 `/api/dev/keys` 出现过 **44 秒**的响应，
  // 而 AI 中转站页首屏要等它 ⇒ 整页卡到一分钟。
  // 与 `newApiFetch` 一致，统一按 NEWAPI_TIMEOUT_MS 兜底。
  return fetchWithTimeout(
    `${cfg.baseUrl}${path}`,
    { ...init, headers },
    NEWAPI_TIMEOUT_MS
  )
}

export interface UserToken {
  id: number
  name: string
  key: string
  created_time: number
  accessed_time: number
  expired_time: number
  remain_quota: number
  unlimited_quota: boolean
  model_limits: string
  model_limits_enabled: boolean
  group: string
  used_quota: number
}

/**
 * ⚠️ 2026-10-13：这里原本有 `extractVerificationCode(text)`（从 NewAPI 验证码邮件
 * 正文里抠验证码的正则组）。已删除：它只服务于上面那条已作废的「自助注册」链，
 * 而那条链连同 `requestEmailCode` / `registerUser` 一起删了 —— 全仓从来没有
 * 任何读收件箱的代码把它喂进去过。
 */

/**
 * 用兑换码（邀请码）充值额度。
 * 源码（rc.15 TopUp）：请求体字段名为 `key`，成功时 `data` 为增加的额度数值。
 */
export async function redeemCode(
  env: Env,
  accessToken: string,
  userId: number,
  code: string
): Promise<{ added: number; message: string }> {
  const res = await asUser(env, accessToken, userId, "/api/user/topup", {
    method: "POST",
    body: JSON.stringify({ key: code.trim() }),
  })
  interface RedeemEnvelope {
    success?: boolean
    message?: string
    data?: number
  }
  const text = await res.text()
  let body: RedeemEnvelope | null = null
  try {
    body = JSON.parse(text) as RedeemEnvelope
  } catch {
    body = null
  }
  if (!body || body.success === false) {
    // 兑换码无效/已用过等属于用户输入问题，直接回传 NewAPI 的说明
    throw new ApiError(
      400,
      body?.message || `兑换失败（HTTP ${res.status}）`,
      "REDEEM_FAILED"
    )
  }
  return { added: Number(body.data ?? 0), message: body.message ?? "" }
}

// ---- 渠道管理（管理员接口，用于「AI 渠道捐献」自动化）----
//
// 口径已对 NewAPI v1.0.0-rc.40 源码核对（controller/channel.go + router/channel-router.go）：
//   - 新建：`POST /api/channel/`，body `{ mode:"single", channel:{...} }`
//   - 列表：`GET /api/channel/`，返回 `{ items, total, page, page_size, type_counts }`
//   - 测试：`GET /api/channel/test/:id`，**始终 200**，靠 body 的 success 判定
//   - 删除：`DELETE /api/channel/:id`
//   - 新增只需 `key` 非空 + 模型名 ≤255 字符（validateChannel 的 isAdd 分支）
//
// ⚠️ `model_mapping` 的方向（relay/helper/model_mapped.go 实证）：
//     键 = 客户端请求的模型名，值 = 实际发给上游的模型名。
//     所以「给捐献模型加前缀」要写成 `{"donation-x": "x"}`。

/**
 * 渠道的多密钥元信息（对应 NewAPI 的 `channel_info` JSON 列）。
 *
 * 只有「多密钥渠道」才有意义：`is_multi_key` 为 true 时，`key` 字段里是
 * 换行分隔的多把 Key，NewAPI 按轮询/随机挑一把用，某把坏了会单独跳过。
 */
export interface NewApiChannelInfo {
  is_multi_key?: boolean
  multi_key_size?: number
}

export interface NewApiChannel {
  id: number
  name: string
  type: number
  status: number
  /** 逗号分隔的模型名 */
  models: string
  group: string
  base_url?: string | null
  /** 多密钥信息；普通渠道为 undefined 或 is_multi_key:false */
  channel_info?: NewApiChannelInfo
}

/**
 * NewAPI 渠道列表的单页上限 —— **服务端硬性封顶 100**，请求里写 `page_size=1000`
 * 也只给你 100 条，多的直接丢掉（v1.0.0-rc.40 `common/page_info.go`：
 * `if pageInfo.PageSize > 100 { pageInfo.PageSize = 100 }`）。
 */
const CHANNEL_PAGE_SIZE = 100

/**
 * 翻页兜底上限。正常渠道总量远小于此；存在的意义只是防「上游 total 异常」
 * 把循环变成死循环（每页都是满的 100 条、total 又永远比已读条数大）。
 */
const CHANNEL_MAX_PAGES = 50

/**
 * 读取渠道列表（管理员）。**会翻页取全量。**
 *
 * 只取自动化要用的字段。NewAPI 会 `Omit("key")`，所以这里拿不到密钥，
 * 也不需要 —— 密钥在创建时由我方提供。
 *
 * ⚠️ 页码参数名是 **`p`**，不是 `page`（`common/page_info.go` 读的是 `c.Query("p")`）。
 *    写 `page=2` 会被静默忽略、永远返回第 1 页 —— 排查这种问题别只看「返回里
 *    page 字段是几」，那只是上游把你传的值/默认值回显而已。
 *
 * 2026-09-30 事故：本站渠道数涨到 140+ 之后，这里只发一次
 * `/api/channel/?page_size=1000`，实际只拿到第 1 页的 100 条（id 范围 9~192，
 * 一条不满 100 的页里混着各种区间），而 **#17 这个商汤渠道恰好落在第 2 页**。
 * 于是 `sensenova.ts` 的「渠道不存在」分支被误触发，所有商汤 Key 捐献
 * 全部转人工复核、且状态停在 `pending`（详见 `getChannel` 的注释）。
 */
/**
 * 拉取消费日志（管理端 `/api/log/`），用于风险账户扫描。
 *
 * ⚠️ 分页参数是 **`p`**（不是 `page`），且 `page_size` 服务端硬封顶 100
 * （与渠道列表同一个坑，见 listChannels 的注释）。
 * 时间戳是**秒**，`type=2` = 消费日志。
 *
 * 返回 `{ items, total }`：total 用于判断「还有没有下一页」，
 * 上游只给数组（老版本）时用本页条数兜底。
 */
export interface NewApiLogItem {
  id?: number
  user_id?: number
  created_at?: number
  username?: string
  model_name?: string
  quota?: number
  is_stream?: boolean
}

export async function listLogs(
  env: Env,
  opts: { startTimestamp: number; endTimestamp: number; page: number; pageSize?: number }
): Promise<{ items: NewApiLogItem[]; total: number }> {
  const pageSize = Math.min(opts.pageSize ?? 100, 100)
  const qs =
    `p=${opts.page}&page_size=${pageSize}&type=2` +
    `&start_timestamp=${opts.startTimestamp}&end_timestamp=${opts.endTimestamp}`
  const res = await newApiFetch(env, `/api/log/?${qs}`, { method: "GET" })
  const data = await unwrap<NewApiLogItem[] | { items?: NewApiLogItem[]; total?: number }>(
    res,
    "读取调用日志"
  )
  const items = Array.isArray(data) ? data : (data.items ?? [])
  const total = Array.isArray(data) ? items.length : (data.total ?? items.length)
  return { items, total }
}

export async function listChannels(env: Env): Promise<NewApiChannel[]> {
  const all: NewApiChannel[] = []
  const seen = new Set<number>()

  for (let page = 1; page <= CHANNEL_MAX_PAGES; page++) {
    const res = await newApiFetch(
      env,
      `/api/channel/?p=${page}&page_size=${CHANNEL_PAGE_SIZE}`,
      { method: "GET" }
    )
    const data = await unwrap<
      NewApiChannel[] | { items?: NewApiChannel[]; total?: number }
    >(res, "读取渠道列表")

    // 老版本可能直接给数组（没有分页信封），保守兼容。
    const list = Array.isArray(data) ? data : (data.items ?? [])
    const total = Array.isArray(data) ? undefined : data.total

    let added = 0
    for (const c of list) {
      if (!c || typeof c.id !== "number" || seen.has(c.id)) continue
      seen.add(c.id)
      all.push(c)
      added += 1
    }

    // 本页没带来任何新渠道（空页 / 与前面完全重复）⇒ 后面也不会有新的了。
    // 这条是防死循环的兜底：不依赖 total 是否可信。
    if (list.length === 0 || added === 0) break
    // 已经收齐上游声明的总数
    if (typeof total === "number" && total > 0 && seen.size >= total) break
    // 不满一页 ⇒ 这是最后一页
    if (list.length < CHANNEL_PAGE_SIZE) break
  }

  return all
}

/**
 * 按 id 单查一个渠道；**不存在时返回 `null`**（不抛错）。
 *
 * 凡「已知渠道 ID、只想知道它还在不在 / 它的 channel_info」的地方，都该用这个，
 * 不要再用 `(await listChannels()).find(c => c.id === id)`：
 * 列表接口受分页封顶影响，渠道一多就可能漏掉目标 id，被误读成「渠道不存在」。
 *
 * ⚠️ 渠道不存在时 NewAPI 返回的是 **HTTP 200** + `{"success":false,
 *    "message":"record not found"}`（`controller/channel.go` 走 `common.ApiError`，
 *    而 `ApiError` 用的是 `http.StatusOK`）—— 不是 404。所以这里必须靠信封里的
 *    `success:false` + message 判断，不能只看状态码。
 */
export async function getChannel(
  env: Env,
  id: number
): Promise<NewApiChannel | null> {
  const res = await newApiFetch(env, `/api/channel/${Math.trunc(id)}`, {
    method: "GET",
  })
  const data = await unwrap<NewApiChannel>(
    res,
    `读取渠道 #${id}`,
    // 上游用「记录不存在」表示没这个 id，这是**正常结果**而非故障，
    // 交给调用方按「渠道不存在」处理（商汤那条路要据此拒绝捐献）。
    // ⚠️ 匹配要收紧：宽容的 `not found` 会把上游其它报错也吞成「渠道不存在」。
    (message) => /record ?not ?found|不存在/i.test(message)
  )
  // tolerate 命中时 unwrap 返回 `{}`（body.data 缺失）；也可能上游直接给 data:null。
  // 两种都归成 null。
  if (!data || typeof data.id !== "number") return null
  return data
}

export interface NewApiChannelInput {
  name: string
  type: number
  key: string
  baseUrl: string
  /** 逗号分隔的模型名（对外暴露的名字，已带 donation- 前缀） */
  models: string
  /** JSON 字符串：{"对外模型名": "上游真实模型名"} */
  modelMapping: string
  group: string
  /** 渠道测试默认用的模型名（填上游真实模型名最稳） */
  testModel?: string
  /**
   * 渠道标签。NewAPI 的渠道列表有「标签模式」，同一 tag 的渠道会归成一组 ——
   * 这就是我们用来给捐献渠道做「文件夹」的机制。
   */
  tag?: string
}

/** 多密钥渠道里单把 Key 的状态（**拿不到完整 Key，只有前 10 位预览**） */
export interface NewApiChannelKeyStatus {
  index: number
  /** 1=启用 2=手动禁用 3=自动禁用 */
  status: number
  /** NewAPI 生成的预览：`前10位 + "..."`（Key 本身不足 10 位则为全量） */
  preview: string
}

// ---- 管理员凭据（管理面板可在线更新）----

/** 清除进程内凭据缓存；写入新凭据后必须调用，否则后续调用仍用旧值 */
function invalidateAdminCredentialCache(): void {
  credentialCache = null
}

/**
 * 强制下次重新解析凭据。写入路径已自动调用；导出仅供测试与运维脚本
 * 在直接改库后让本进程立即感知（其他 isolate 最多等 CREDENTIAL_CACHE_MS）。
 */
export function resetAdminCredentialCache(): void {
  invalidateAdminCredentialCache()
}

export interface AdminCredentialInfo {
  source: AdminCredentialSource
  /** 掩码后的令牌；未配置时为 null。明文绝不下发 */
  maskedToken: string | null
  adminUserId: string
  /** 库内凭据的更新时间（source=db 时才有） */
  updatedAt: string | null
}

/**
 * 给「还没有 ModelPrice（按次价）」的模型自动补上 1 元/次。
 *
 * 全站改为按次计费（ModelPrice）后，新模型若不设 ModelPrice 会回落 token 计费的
 * 默认倍率 37.5。这个函数在定时任务里调用，扫一遍 pricing，发现没有 model_price
 * 的模型就补标 ModelPrice=1，保证「所有模型统一 1 元/次」。
 *
 * 返回本次补标的模型数量。
 */
export async function autoPriceNewModels(env: Env): Promise<number> {
  // 1. 读原始 pricing（含 model_price）
  const res = await newApiFetch(env, "/api/pricing", { method: "GET" })
  const data = await unwrap<
    { model_name?: string; model_price?: number }[]
  >(res, "读取模型分组")

  if (!Array.isArray(data)) return 0

  // 2. 找出「没有按次价」的模型（model_price 缺失或为 0）
  const unPriced = data.filter((m) => m.model_name && !(m.model_price ?? 0))
  if (unPriced.length === 0) return 0

  // 3. 读当前 ModelPrice option，补上缺失的模型
  const optsRes = await newApiFetch(env, "/api/option/", { method: "GET" })
  const opts = await unwrap<{ key?: string; value?: string }[]>(optsRes, "读取设置")
  const optList = Array.isArray(opts) ? opts : []
  const raw = optList.find((o) => o.key === "ModelPrice")?.value ?? "{}"
  let modelPrice: Record<string, number> = {}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null) modelPrice = parsed
  } catch {
    modelPrice = {}
  }

  // 4. 补标 1 元/次
  for (const m of unPriced) {
    modelPrice[m.model_name!] = 1
  }

  // 5. 写回
  const r = await newApiFetch(env, "/api/option/", {
    method: "PUT",
    body: JSON.stringify({ key: "ModelPrice", value: JSON.stringify(modelPrice) }),
  })
  await unwrap(r, "更新 ModelPrice")

  return unPriced.length
}

/**
 * 管理员给用户开通订阅套餐（免支付，立即生效）。
 * 对应 NewAPI `POST /api/subscription/admin/users/:id/subscriptions`，body 只认 plan_id。
 * 返回订阅是否成功，以及可能的提示（如「用户分组将升级到 xxx」）。
 *
 * `strictLimit`：NewAPI 的套餐若设了 `max_purchase_per_user` 且已达上限，会返回
 * 「已达到该套餐购买上限」。对**免费订阅重复领取**这类幂等场景，它等同成功
 * （用户已持有）；但对「按档位发放」的成就 / 邀请奖励，它是**真实失败**——
 * 若当成成功，站点账本会推进而订阅并未创建，导致静默少发
 * （2026-10-08 线上：套餐限购 5 份，第 6 份起全部被吞）。这类场景必须 strictLimit: true。
 */
export async function adminGrantSubscription(
  env: Env,
  newapiUserId: number,
  planId: number,
  opts: { strictLimit?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await newApiFetch(
      env,
      `/api/subscription/admin/users/${newapiUserId}/subscriptions`,
      {
        method: "POST",
        body: JSON.stringify({ plan_id: planId }),
      }
    )
    const data = await unwrap<{ message?: string } | null>(res, "开通订阅")
    const msg = (data && data.message) || ""
    return { ok: true, message: msg }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 「已达到该套餐购买上限」这类错误，说明用户已有订阅，视为已开通。
    // ⚠️ 仅限免费订阅领取等幂等场景；按档位发放必须 strictLimit，否则静默丢发。
    if (!opts.strictLimit && /上限|已订阅|already|limit/i.test(msg)) {
      return { ok: true, message: "你已领取过免费订阅" }
    }
    return { ok: false, message: msg }
  }
}

/**
 * 管理员**删除**一张用户订阅（NewAPI 硬删除，`DELETE /api/subscription/admin/user_subscriptions/:id`）。
 *
 * 用途：成就奖励「两端对齐」的撤回侧。注意与 invalidate（软失效，status=cancelled）
 * 的区别：NewAPI 的套餐限购 `max_purchase_per_user` 按**行数**计数（不筛 status），
 * 软失效不释放名额——只有硬删除才能真正减少计数，让后续补发不被上限卡死。
 */
export async function adminDeleteUserSubscription(
  env: Env,
  subscriptionId: number
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await newApiFetch(
      env,
      `/api/subscription/admin/user_subscriptions/${subscriptionId}`,
      { method: "DELETE" }
    )
    const data = await unwrap<{ message?: string } | null>(res, "删除订阅")
    return { ok: true, message: (data && data.message) || "" }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 用户的一条订阅（用于展示实时剩余额度 / 下次重置时间） */
export interface UserSubscriptionInfo {
  /** 订阅行 id（NewAPI `user_subscriptions.id`；撤回删除时必需） */
  id: number
  planId: number
  amountTotal: number
  amountUsed: number
  startTime: number
  endTime: number
  status: string
  nextResetTime: number
}

/**
 * 拉取某用户的订阅列表（**未过滤 status**，含 active / expired / cancelled）。
 *
 * 导出给成就奖励的「两端对齐」使用：对齐必须以 NewAPI 为真相源，且必须能区分
 * 「读取失败（抛错）」与「真的没有订阅（空数组）」——所以这里**不吞异常**
 * （对照 listAllUserSubscriptions 的 catch → []，那个把两种情形混为一谈，
 * 拿来做对齐会误判成 0 份而疯狂补发）。
 */
export async function fetchUserSubscriptions(
  env: Env,
  newapiUserId: number
): Promise<UserSubscriptionInfo[]> {
  const res = await newApiFetch(
    env,
    `/api/subscription/admin/users/${newapiUserId}/subscriptions`,
    // ⚠️ 上游会慢到几十秒（2026-10-12 实测），必须带超时，不然页面一直转圈
    { method: "GET", signal: AbortSignal.timeout(4000) }
  )
  const data = await unwrap<{ subscription?: Record<string, unknown> }[]>(
    res,
    "查询订阅"
  )
  if (!Array.isArray(data)) return []
  return data
    .map((d) => d.subscription)
    .filter((s): s is Record<string, unknown> => Boolean(s))
    .map((s) => ({
      id: Number(s.id ?? 0),
      planId: Number(s.plan_id ?? 0),
      amountTotal: Number(s.amount_total ?? 0),
      amountUsed: Number(s.amount_used ?? 0),
      startTime: Number(s.start_time ?? 0),
      endTime: Number(s.end_time ?? 0),
      status: String(s.status ?? ""),
      nextResetTime: Number(s.next_reset_time ?? 0),
    }))
}

/**
 * 管理员查询某用户的**全部** active 订阅。
 *
 * 一个用户可能同时持有多张订阅（免费套餐 + 各档邀请/奖励套餐），消费时按
 * `end_time asc, id asc` 逐张接力，所以「总额度」= 各张之和。前端要按套餐类型
 * 分段展示这个总额，故这里必须把整份列表交出去，不能只取第一条。
 */
/** 套餐定义（只取展示与限购预警需要的字段） */
export interface SubscriptionPlanInfo {
  planId: number
  /** 套餐名，如「wb邀请套餐」 */
  title: string
  /**
   * 每用户限购份数（NewAPI `max_purchase_per_user`，0 = 不限）。
   *
   * 供发放方预警：应发份数超过限购时，补发必然被 NewAPI 拒绝
   * （「已达到该套餐购买上限」），提前在审计里说明，别等发放失败才发现。
   */
  maxPurchasePerUser: number
}

/**
 * 读取全部订阅套餐定义（管理员接口；实测公开访问 401）。
 *
 * 用途：把订阅记录里的 plan_id 翻译成人能看懂的名字。订阅记录只存 plan_id，
 * 名字在套餐表里。**额度不从这里取** —— 订阅创建时把套餐额度快照进了订阅记录，
 * 之后改套餐不影响老订阅，所以展示额度必须用订阅自己的 amount_total。
 *
 * 失败返回空数组（套餐名降级成「套餐 #id」，不影响额度展示）。
 */
export async function listSubscriptionPlans(
  env: Env
): Promise<SubscriptionPlanInfo[]> {
  // 套餐定义是管理员维护的、极少变（2026-10-12 加缓存：上游实测能慢到 27.8s）
  const cached = cacheTake<SubscriptionPlanInfo[]>("plans", 10 * 60 * 1000)
  if (cached) return cached
  try {
    const res = await newApiFetch(env, "/api/subscription/plans", {
      method: "GET",
      signal: AbortSignal.timeout(4000),
    })
    const data = await unwrap<{ plan?: Record<string, unknown> }[]>(
      res,
      "读取订阅套餐"
    )
    if (!Array.isArray(data)) return []
    const plans = data
      .map((d) => d.plan)
      .filter((p): p is Record<string, unknown> => Boolean(p))
      .map((p) => ({
        planId: Number(p.id ?? 0),
        title: String(p.title ?? ""),
        maxPurchasePerUser: Number(p.max_purchase_per_user ?? 0),
      }))
    cachePut("plans", plans)
    return plans
  } catch (err) {
    console.error("读取订阅套餐失败:", err)
    return []
  }
}
