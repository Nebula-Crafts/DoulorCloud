import {
  type AdminInvite,
  type AdminInviteTrace,
  type AdminSettings,
  type AdminUser,
  type AdminUserDetail,
  type AdminPermGroup,
  type AdminPermCategory,
  type AdminPermissionGroup,
  type AdminPermissionsState,
  type ApiError,
  type Announcement,
  type AnnouncementStatus,
  type AchievementsResponse,
  type SpaceData,
  type SpaceCardData,
  type MySpaceSettings,
  type LeaderboardBoard,
  type LeaderboardResponse,
  type CommunityMetric,
  type ReportReason,
  type ReportItem,
  type LeaderboardRange,
  type EmailSettings,
  type MailMessage,
  type Permissions,
  type MeResponse,

  type AdminInviteQuotasResponse,
  type AdminUserInviteQuotaResponse,
  type FeatureCounts,
  type CfQuotaOverview,
  type BrevoQuotaOverview,
  type MailSecrets,
  type User,
  type Post,
  type CommentNode,
  type LinkPreview,
  type AnalyticsOverview,
  type UserAnalytics,
  type AdminAuditData,
  type ChatMessage,
  type ChatPresenceUser,
  type Notification,
  type CommunityStats,
  type CommunityConfig,
  type AdminCommunityPost,
  type FeedbackOverview,
  type AdminFeedbackList,
  type FeedbackDetail,
  type PerfOverview,
  type PerfPageSamples,
  type AdminFeedbackItem,
  type FeedbackItem,
  type MessageCategory,
  type EventItem,
  type EventClaim,
  type EventPayload,
  type AccountAppeal,
  type ModerationLists,
  type ModerationConditionMetric,
  type ModerationConditionOp,
  type AppealPendingReply,
  type PendingNotice,
  type AdminNotice,
  type RiskAccount,
  type PointsOverview,
  type PointsRedeemResult,
  type PointTransaction,
  type PointOrder,
  type PointProduct,
  type PointProductPayload,
  type PublicPurchase,
  type AdminPointsOverview,
  type AdminShopData,
  type DonationRewardItem,
  type InvitePointsConfig,
  type AttentionCounts,
  type DmRequest,
  type MyTitle,
  type DmPeer,
  type DmMessage,
  type DmConversation,
  type Sticker,
} from "@/types"
import { tStatic, translateApiMessage } from "@/i18n"

/**
 * 统一 API 请求层。
 *
 * 所有敏感逻辑（session 校验、域名所有权、Cloudflare API 调用）都在 Worker 端完成，
 * 前端只负责发起请求并携带 cookie（默认同源发送）。
 *
 * 本地开发时 Vite 会将 /api 代理到 http://localhost:8787（见 vite.config.ts），
 * 生产环境由 Cloudflare Pages + Workers 同源路由处理，无需额外配置。
 */

import { diagApi } from "@/lib/diag-log"

const BASE = "/api"

/** 通知全局：会话已失效（use-auth 监听后清空用户态） */
export function notifySessionExpired() {
  window.dispatchEvent(new Event("auth:expired"))
}

/**
 * 通知全局：当前账号**未验证邮箱**，这次功能请求被服务端拦下了
 * （规则见 `worker/src/auth.ts` 的 EMAIL_VERIFY_REQUIRED_PREFIXES）。
 *
 * 为什么需要：未验证用户在功能页点按钮会收到 403「请先验证邮箱后再使用该功能」，
 * 但零散的 toast 只告诉他"不行"，不告诉他"去哪验证"。dashboard 外壳监听本事件后
 * 会直接把「验证邮箱」对话框弹出来，点一次就能收到验证码。
 */
function notifyEmailUnverified() {
  window.dispatchEvent(new Event("auth:email-unverified"))
}

export class HttpError extends Error {
  status: number
  code?: string
  /**
   * 原始响应体（2026-10-02 加）。
   *
   * 有些错误除了 `error` / `code` 还会**带回用户需要的信息** ——
   * 典型是登录时账号被封禁：响应里带着封禁原因和上次申诉的处理结果，
   * 登录页要把它展示出来（用户此刻拿不到会话，没有别的渠道能看到）。
   */
  detail?: Record<string, unknown>

  constructor(
    status: number,
    message: string,
    code?: string,
    detail?: Record<string, unknown> | null
  ) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
    this.detail = detail ?? undefined
  }
}

/**
 * 统一从异常里取用户可读的错误文案。
 * 用法：toast.error(errMsg(err, "发布失败"))
 *
 * 服务端返回的 ApiError 文案是给用户看的，直接用；
 * 其余（网络断开、JSON 解析失败等）用调用方给的兜底文案。
 */
export function errMsg(err: unknown, fallback: string): string {
  if (err instanceof HttpError && err.message) return err.message
  if (err instanceof TypeError) return tStatic("api.networkError")
  return fallback
}

/**
 * 把非 2xx 响应按统一规则翻译并抛 HttpError。
 *
 * 抽出来是因为请求分两条路：普通 JSON 请求（request）与流式请求（requestStream）——
 * 错误处理必须共用一份，否则「会话失效登出」「邮箱未验证弹窗」这类副作用
 * 会在某一条路上悄悄漏掉（行为漂移）。
 */
async function throwHttpError(res: Response): Promise<never> {
  // 诊断日志（2026-10-10）：失败的 API 请求记一条（接口路径 + 状态码）。
  // 用户反馈附日志时，这就是「哪个接口报了什么错」的直接证据。
  // diagApi 内部判开关、try-catch 包死，未启用时近零开销。
  try {
    diagApi(new URL(res.url).pathname, res.status)
  } catch {
    /* 忽略 */
  }
  const data = await res.json().catch(() => null)
  // 后端 message 一律是中文（worker 侧既是给用户看的、也是运维/日志原文），
  // 所以在这里就地翻一次：翻不到会原样返回，不影响任何错误处理逻辑。
  // 放在**构造 HttpError 的地方**而不是每个调用点 —— 全站 `err.message` 的用法
  // 有一百多处（`err instanceof HttpError ? err.message : t("…")`），逐个改必漏。
  const raw = (data as ApiError | null)?.error
  const message = raw
    ? translateApiMessage(raw)
    : tStatic("api.requestFailed", { status: res.status })
  const code = (data as ApiError | null)?.code

  // 仅在「会话本身失效」时清空用户态。
  // 不能对所有 401 一律登出：登录密码错误、修改密码时当前密码错误
  // 同样是 401（code=INVALID_CREDENTIALS），误判会把正常用户直接踢下线。
  const sessionExpired =
    res.status === 401 && (code === undefined || code === "UNAUTHORIZED")
  if (sessionExpired) {
    notifySessionExpired()
  }

  // 邮箱未验证：功能接口被服务端拦下（见 worker/src/auth.ts 的
  // EMAIL_VERIFY_REQUIRED_PREFIXES），广播一次让外壳弹出验证对话框。
  // 仍然照常抛错，调用方原有的错误处理不受影响。
  if (res.status === 403 && code === "EMAIL_NOT_VERIFIED") {
    notifyEmailUnverified()
  }

  // 完整响应体一并带进异常：有些错误除了文案还要**把用户需要的信息**传出去
  // （如登录时账号被封禁 → 封禁原因与申诉处理结果，见 login.tsx 的展示）
  throw new HttpError(res.status, message, code, data as Record<string, unknown> | null)
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  })

  if (!res.ok) {
    await throwHttpError(res)
  }

  if (res.status === 204) {
    return undefined as T
  }

  const data = await res.json().catch(() => null)

  // 200 但响应体不是 JSON（例如静态站点把 /api 请求兜底成了 index.html）。
  // 此时 data 是 null，若直接返回会让调用方在 `res.posts` 上抛 TypeError，
  // 用户看到的是白屏而不是可理解的错误。这里统一转成 HttpError。
  if (data === null) {
    throw new HttpError(res.status, tStatic("api.invalidResponse"), "INVALID_RESPONSE")
  }

  return data as T
}

// ---- Auth ----

export const authApi = {
  register: (payload: {
    username: string
    email: string
    password: string
    inviteCode: string
  }) =>
    request<{ user: MeResponse["user"] }>("/register", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 注册页公开信息：当前是否开放注册（无需邀请码）、截止时间。无需登录 */
  registerStatus: () =>
    request<{
      openRegistration: boolean
      until: string | null
      /**
       * 当前「发给用户的根域」（root_domains 的默认行，如 tyu.me）。
       * 注册页要用它显示「你会拿到 username.<域>」—— 那是管理员可改的，
       * 写死 doulor.cn 会在换域后给新用户展示错误地址。
       */
      defaultRootDomain: string
    }>("/register-status"),

  /**
   * 登录第一步（口令）。
   *
   * 返回有两种形态：
   * · 普通结果 —— `{ user, pendingReply, mustSetupTwoFactor }`，登录已完成；
   * · **需要二次验证** —— `{ needTwoFactor: true, challengeId, methods, maskedEmail }`，
   *   此时**还没有登录态**，必须再调 `twoFactorApi.verifyLogin` 才算登录成功。
   *
   * 用 `needTwoFactor` 做判别字段，前端据此切换界面。
   */
  login: (payload: { identifier: string; password: string }) =>
    request<{
      user?: MeResponse["user"]
      pendingReply?: unknown
      /** 该账号被要求开 2FA 但还没配 —— 登录照样成功，前端引导去设置页 */
      mustSetupTwoFactor?: boolean
      /** 需要二次验证；此时 user 为空、也没有 cookie */
      needTwoFactor?: boolean
      challengeId?: string
      methods?: string[]
      maskedEmail?: string
    }>("/login", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  logout: () => request<void>("/logout", { method: "POST" }),

  me: () => request<MeResponse>("/me"),

  changePassword: (payload: {
    currentPassword: string
    newPassword: string
  }) =>
    request<{ ok: boolean }>("/password", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  forgotPassword: (email: string) =>
    request<{ ok: boolean; message: string }>("/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean; message: string }>("/password/reset", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),
}

/**
 * 排行榜。
 *
 * `metric` 只对 `board=community` 有意义（后端忽略其余榜的该参数）。
 */
export const leaderboardApi = {
  get: (board: LeaderboardBoard, metric?: CommunityMetric, range?: LeaderboardRange) => {
    const qs = new URLSearchParams({ board })
    if (metric) qs.set("metric", metric)
    if (range && range !== "all") qs.set("range", range)
    return request<LeaderboardResponse>(`/leaderboard?${qs.toString()}`)
  },
}

/**
 * 当前「发给用户的根域」（如 tyu.me），带模块级缓存。
 *
 * 为什么单独开一个函数而不是让各页面各自 request：`用户名.<根域>` / `用户名@<根域>`
 * 在注册页、概览、设置里都要显示，挨个 fetch 会白打几次网络；更关键的是
 * **这个域名是管理员可改的** —— 2026-10-02 从 doulor.cn 整体迁到 tyu.me 时，
 * 凡是对它硬编码的地方都开始显示错地址。
 *
 * 失败时抛出，调用方自行回落（通常显示空串，别闪一个错域名）。
 */
let defaultRootDomainCache: string | null = null
let defaultRootDomainInflight: Promise<string> | null = null

export async function getDefaultRootDomain(): Promise<string> {
  if (defaultRootDomainCache) return defaultRootDomainCache
  if (!defaultRootDomainInflight) {
    defaultRootDomainInflight = authApi
      .registerStatus()
      .then((res) => {
        defaultRootDomainCache = res.defaultRootDomain
        return res.defaultRootDomain
      })
      .finally(() => {
        defaultRootDomainInflight = null
      })
  }
  return defaultRootDomainInflight
}

// ---- 管理员 ----

export const adminApi = {
  /**
   * 用户列表。不传参数 = 旧的全量模式（向后兼容）；
   * 传 limit/offset/q = 服务端分页搜索（响应带 total，数据量从 ~870KB 降到 ~20KB）。
   */
  listUsers: (opts?: { q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams()
    if (opts?.q) p.set("q", opts.q)
    if (opts?.limit != null) p.set("limit", String(opts.limit))
    if (opts?.offset != null) p.set("offset", String(opts.offset))
    const qs = p.toString()
    return request<{
      users: AdminUser[]
      total?: number
      limit?: number
      offset?: number
    }>(`/admin/users${qs ? `?${qs}` : ""}`)
  },

  /**
   * 用户列表批量封禁 / 解封。后端复用单人封禁的完整链路（停用 DNS/子域名、
   * 拉黑注册 IP、同步 NewAPI），单次上限 90 人；封禁必须带原因。
   */
  bulkSetStatus: (payload: {
    userIds: string[]
    action: "suspend" | "unsuspend"
    reason?: string
  }) =>
    request<{
      ok: boolean
      action: string
      updated: number
      skipped: number
      usernames: string[]
    }>("/admin/users/bulk-status", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 管理员权限树（两级）+ 当前用户权限 + 侧边栏过滤开关 */
  getPermissionTree: () =>
    request<{
      groups: AdminPermGroup[]
      categories: AdminPermCategory[]
      myScope: string[]
      sidebarOnlyPermitted: boolean
    }>("/admin/permissions/tree"),

  /** 权限组列表 */
  listPermissionGroups: () =>
    request<{ groups: AdminPermissionGroup[] }>("/admin/permission-groups"),

  createPermissionGroup: (name: string, scope: string[]) =>
    request<{ id: string; name: string; scope: string[] }>("/admin/permission-groups", {
      method: "POST",
      body: JSON.stringify({ name, scope }),
    }),

  updatePermissionGroup: (id: string, payload: { name?: string; scope?: string[] }) =>
    request<{ ok: boolean }>(`/admin/permission-groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  deletePermissionGroup: (id: string) =>
    request<{ ok: boolean }>(`/admin/permission-groups/${id}`, { method: "DELETE" }),

  addGroupMembers: (id: string, userIds: string[]) =>
    request<{ added: number }>(`/admin/permission-groups/${id}/members`, {
      method: "POST",
      body: JSON.stringify({ userIds }),
    }),

  getUserAdminPermissions: (username: string) =>
    request<AdminPermissionsState>(
      `/admin/users/${encodeURIComponent(username)}/admin-permissions`
    ),

  setUserAdminPermissions: (
    username: string,
    payload: { role?: string; adminRoleId?: string | null; adminScope?: string[] }
  ) =>
    request<{ ok: boolean }>(`/admin/users/${encodeURIComponent(username)}/admin-permissions`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  getUser: (username: string) =>
    request<AdminUserDetail>(`/admin/users/${encodeURIComponent(username)}`),

  updateUser: (
    username: string,
    payload: {
      status?: string
      role?: string
      permissions?: Permissions
      /** null = 恢复全局默认 */
      maxSubdomains?: number | null
      /** 展示昵称；null / 空串 = 清空 */
      nickname?: string | null
      emailVerified?: boolean
      notifyEnabled?: boolean
      /** 会员等级（0=普通 1=黄金 2=白金 3=黑金）；运营兜底，可下调 */
      memberLevel?: number
      /**
       * 封禁原因：status 改成 suspended 时写入，**用户下次登录会在登录页看到**。
       * 解封（status=active）时后端会自动清空，不用传。
       */
      suspendReason?: string | null
    }
  ) =>
    request<AdminUserDetail>(`/admin/users/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /**
   * 管理员直接为用户设置新密码（rootOnly）。
   * 后端会哈希入库、清空该用户全部会话与 OAuth 令牌。
   */
  setUserPassword: (username: string, password: string) =>
    request<{ ok: boolean }>(`/admin/users/${encodeURIComponent(username)}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  deleteUser: (username: string) =>
    request<void>(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
    }),

  getUserMessage: (username: string, messageId: string) =>
    request<{ message: MailMessage }>(
      `/admin/users/${encodeURIComponent(username)}/messages/${encodeURIComponent(messageId)}`
    ),

  /**
   * Cloudflare 额度总览。额度数字按 `cf_plan` 设置选免费版/付费版口径
   * （auto 时服务端自动判定，见 handlers/cf-quota.ts 的 detectPlan）。
   * `fresh` 为 true 时绕过服务端 60 秒缓存（点「刷新」用）。
   */
  cloudflareQuota: (fresh = false) =>
    request<CfQuotaOverview>(`/admin/cloudflare/quota${fresh ? "?fresh=1" : ""}`),

  /** 每把 Brevo Key 的当日剩余额度（实时探测，无缓存） */
  brevoQuota: () => request<BrevoQuotaOverview>("/admin/mail/brevo-quota"),

  /**
   * 邀请码列表。不传参数 = 旧的全量模式；
   * 传 limit/offset/status = 服务端分页筛选（响应带 total 与 counts）；
   * countOnly = 只要总数（管理页头部的「邀请码 N 个」用，进页面即可显示）。
   */
  listInvites: (opts?: {
    limit?: number
    offset?: number
    status?: string
    countOnly?: boolean
  }) => {
    const p = new URLSearchParams()
    if (opts?.countOnly) p.set("count_only", "1")
    if (opts?.limit != null) p.set("limit", String(opts.limit))
    if (opts?.offset != null) p.set("offset", String(opts.offset))
    if (opts?.status) p.set("status", opts.status)
    const qs = p.toString()
    return request<{
      invites: AdminInvite[]
      total?: number
      limit?: number
      offset?: number
      /** counts[""] = 全部，其余为 unused/partial/used。分页模式才有。 */
      counts?: Record<string, number>
    }>(`/admin/invites${qs ? `?${qs}` : ""}`)
  },

  /** 所有用户的邀请码额度概况 */
  listInviteQuotas: () =>
    request<AdminInviteQuotasResponse>("/admin/invite-quotas"),

  /** 单个用户的额度 + 其创建的邀请码 */
  getUserInviteQuota: (username: string) =>
    request<AdminUserInviteQuotaResponse>(
      `/admin/users/${encodeURIComponent(username)}/invite-quota`
    ),

  /** 调整额度（补偿/纠错/手动发放） */
  updateUserInviteQuota: (
    username: string,
    payload: {
      inviteBonus?: number
      inviteUsed?: number
      featureQuota?: Partial<FeatureCounts>
      featureUsed?: Partial<FeatureCounts>
    }
  ) =>
    request<AdminUserInviteQuotaResponse>(
      `/admin/users/${encodeURIComponent(username)}/invite-quota`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  createInvite: (payload: {
    code: string
    maxUses?: number
    permissions?: Permissions
  }) =>
    request<{ invite: AdminInvite }>("/admin/invites", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteInvite: (id: string) =>
    request<void>(`/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 邀请码溯源：谁建的、什么时候建的、谁用了、什么时候用的（含注册 IP） */
  traceInvite: (id: string) =>
    request<AdminInviteTrace>(`/admin/invites/${encodeURIComponent(id)}/trace`),

  /** 用户「最近活动」分页（查看更多 / 懒加载） */
  getUserActivity: (username: string, offset: number, limit = 20) =>
    request<{
      activity: { id: string; action: string; detail: string; ip: string | null; createdAt: string }[]
      hasMore: boolean
      offset: number
      limit: number
    }>(`/admin/users/${encodeURIComponent(username)}/activity?offset=${offset}&limit=${limit}`),

  /** 修改邀请码权限 / 可用次数（只影响之后注册的新账号） */
  updateInvite: (
    id: string,
    payload: { permissions?: Partial<Permissions> | null; maxUses?: number }
  ) =>
    request<{ invite: AdminInvite }>(
      `/admin/invites/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  getSettings: () => request<AdminSettings>("/admin/settings"),

  updateSettings: (payload: Record<string, string | number | boolean>) =>
    request<{ settings: Record<string, string>; mailSecrets: MailSecrets }>("/admin/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** AI 实验室配置：模型来源、统一 Key、免费额度、提示词、免费渠道 */
  // 社区管理
  listCommunityPosts: (params?: { user?: string; includeDeleted?: boolean }) => {
    const sp = new URLSearchParams()
    if (params?.user) sp.set("user", params.user)
    if (params?.includeDeleted) sp.set("includeDeleted", "1")
    const qs = sp.toString()
    return request<{ posts: AdminCommunityPost[] }>(`/admin/community/posts${qs ? `?${qs}` : ""}`)
  },
  deleteCommunityPost: (id: string) =>
    request<{ ok: boolean }>(`/admin/community/posts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  restoreCommunityPost: (id: string) =>
    request<{ ok: boolean }>(`/admin/community/posts/${encodeURIComponent(id)}/restore`, { method: "POST" }),

  /**
   * 对齐中转站账号的启用/禁用状态（服务端按「该不该有 ai 权限」自行判断方向）。
   *
   * 传 `username` 就只处理这一个用户 —— 全量会逐个用户调 NewAPI，
   * 线上 170+ 个账号直接撞 subrequest 上限，所以成员详情里一律带用户名调。
   */
  syncNewApiPermissions: (payload: { username: string }) =>
    request<{
      removedOrphans: number
      disabled: number
      enabled: number
      errors: string[]
      username: string | null
    }>("/admin/newapi/sync-permissions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 中转站的订阅套餐列表（纯展示：让「发放订阅」能看见有哪些 ID 可选；读不到返回空数组） */
  listSubscriptionPlans: () =>
    request<{
      plans: { planId: number; title: string; maxPurchasePerUser: number }[]
    }>("/admin/newapi/subscription-plans"),

  /**
   * 给指定用户批量发放订阅。
   *
   * ⚠️ 服务端**先全量校验再动手**：只要有用户名不存在、或该用户还没开通中转站，
   * 就整体 4xx 报错且一个订阅都不发（不会出现「部分成功」）。前端直接把错误文案展示即可。
   */
  grantSubscriptions: (payload: { usernames: string; planId: number; count: number }) =>
    request<{
      ok: boolean
      planId: number
      count: number
      users: number
      granted: number
      results: { username: string; ok: boolean; granted: number; message: string }[]
    }>("/admin/newapi/grant-subscriptions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // ---- 「付费分组」授权（2026-10-11）----
  // 与发放订阅是两件事：这里只授权「建 Key 时能选付费分组」，永久有效、不发额度。
  listPremiumGrants: () =>
    request<{
      grants: {
        userId: string
        username: string
        grantedBy: string | null
        grantedAt: string
        newapiUserId: number | null
      }[]
      count: number
    }>("/admin/newapi/premium-grants"),
  grantPremiumGroup: (payload: { usernames: string }) =>
    request<{
      ok: boolean
      users: number
      granted: number
      existed: number
      results: { username: string; status: "granted" | "existed" }[]
    }>("/admin/newapi/grant-premium-group", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  revokePremiumGroup: (payload: { usernames: string }) =>
    request<{
      ok: boolean
      users: number
      revoked: number
      results: { username: string; status: "revoked" | "absent" }[]
    }>("/admin/newapi/revoke-premium-group", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

}

// ---- 账户设置（真实邮箱验证 / 改名 / 改邮箱 / 通知开关）----

export const settingsApi = {
  getEmail: () => request<EmailSettings>("/settings/email"),

  /** action 省略 = 发起验证（发验证码）；confirm = 回填验证码；status = 查询状态 */
  verifyEmail: (action?: "status" | "confirm", code?: string) =>
    request<{ email: string; verified: boolean; message?: string }>(
      "/settings/email/verify",
      {
        method: "POST",
        body: JSON.stringify(
          action === "confirm" ? { action, code } : action ? { action } : {}
        ),
      }
    ),

  /** 修改真实邮箱：先 request 发送新邮箱验证码，再 confirm 带验证码落库 */
  changeEmail: (payload: {
    email: string
    password: string
    action: "request" | "confirm"
    /** confirm 步骤必填：发往新邮箱的 6 位验证码 */
    code?: string
  }) =>
    request<{ user: User; email?: string; verified?: boolean; message?: string }>(
      "/settings/email",
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  setNotify: (payload: { enabled?: boolean; announcements?: boolean }) =>
    request<{ notifyEnabled: boolean; notifyAnnouncements: boolean }>(
      "/settings/notify",
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  /** 修改用户名（需密码确认；网盘目录等不会自动迁移） */
  changeUsername: (payload: { username: string; password: string }) =>
    request<{ user: User; warnings: { note: string } }>("/settings/username", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** 注销前发送邮箱验证码（与密码一起做双重确认） */
  requestDeleteCode: () =>
    request<{ email: string; message: string }>("/settings/account/delete-code", {
      method: "POST",
    }),

  /** 自助注销账号（需密码 + 邮箱验证码双重确认，会回收外部资源并清除会话） */
  deleteAccount: (password: string, code: string) =>
    request<void>("/settings/account/delete", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    }),
}

// ---- R2 直链网盘 ----

// ---- AI 中转站（NewAPI） ----

// ---- 临时分享箱 ----

// ---- 代理节点 ----

// ---- Email（收件箱） ----

// ---- 个人名片 ----

// ---- 捐献 ----

// ---- 权限兑换码 ----

// ---- WorkBuddy 反代账号捐献（登录即解锁 AI 权限，免审核）----

/**
 * 导入时被拒的账号（逐条回显，便于用户自己排查该删哪几行）。
 *
 * 出现原因：伪造/格式非法的 uid、上游池里查无此账号、上游已禁用（需重新登录）、
 * 已被其他用户绑定。**这些账号不会建绑定、不会发权限、不会发积分**。
 */
export interface ImportRejectedAccount {
  uid: string
  reason: string
}

export interface Wb2ApiImportResult {
  ok: boolean
  total: number
  bound: number
  /** 本次**新建**的绑定数（`bound = newlyBound + revived`） */
  newlyBound: number
  /** 复活自己墓碑的绑定数（不算新贡献，不发捐献积分） */
  revived: number
  alreadyBound: string[]
  skippedByLimit: string[]
  /** 未通过上游核验 / 被他人占用 / 格式非法 —— 逐条原因 */
  rejected?: ImportRejectedAccount[]
  limit: number
  upstream: {
    total: number | null
    imported: number | null
    skipped: number | null
    errors: string[]
  }
}

// ---- Qoder2API 反代账号捐献（第二条，登录即解锁 AI 权限，免审核）----

export interface Qoder2ApiImportResult {
  ok: boolean
  total: number
  bound: number
  /** 本次**新建**的绑定数（`bound = newlyBound + revived`） */
  newlyBound: number
  /** 复活自己墓碑的绑定数（不算新贡献，不发捐献积分） */
  revived: number
  alreadyBound: string[]
  skippedByLimit: string[]
  /** 未通过上游核验 / 被他人占用 / 格式非法 —— 逐条原因 */
  rejected?: ImportRejectedAccount[]
  limit: number
  realm: string
  /** 网关自己的计数（`imported` 明显小于候选数时，问题在上游那边） */
  upstream?: {
    imported: number | null
    skipped: number | null
    errors: string[]
  }
}

// ---- 公告 / 网站动态 ----

export const announcementApi = {
  /** 登录用户：最近 5 条公告（pinned 优先）；带 dismissed 表示该用户已「不再显示」 */
  list: () => request<{ announcements: Announcement[] }>("/announcements"),

  /**
   * 记下「不再显示」（`once` 公告的「知道了」也走这条）。
   * 落服务端 = 换设备 / 清缓存 / 重装 App 后依然记得，不再只靠 localStorage。
   */
  dismiss: (id: string) =>
    request<{ ok: boolean }>(`/announcements/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
    }),

  // 管理端
  listAll: () =>
    request<{ announcements: Announcement[] }>("/admin/announcements"),

  create: (payload: {
    title: string
    body: string
    category?: string
    pinned?: boolean
    popupMode?: "none" | "once" | "every"
    notifyByEmail?: boolean
    /** draft=草稿；scheduled=定时发布（需 publishAt）；published=立即发布 */
    status?: AnnouncementStatus
    /** ISO 时间串，status=scheduled 时必填 */
    publishAt?: string | null
  }) =>
    // queued = 本次入队的收件人数；实际发送在后台分批进行，
    // 真实进度看 announcement 的 mailStatus / mailSent / mailTotal
    request<{ announcement: Announcement; queued?: number }>(
      "/admin/announcements",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  update: (id: string, payload: Partial<{
    title: string
    body: string
    category: string
    pinned: boolean
    popupMode: "none" | "once" | "every"
    notifyByEmail?: boolean
    status?: AnnouncementStatus
    publishAt?: string | null
  }>) =>
    request<{ announcement: Announcement; queued?: number }>(
      `/admin/announcements/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/announcements/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /**
   * 重发该公告「失败」的邮件：把队列里 failed 的行重置为 pending 再跑一轮。
   * `emails` 可选 —— 传入时强制重发这些地址（哪怕是已标记成功的），
   * 用于「记录成功但实际没送到」的情况。
   */
  resendFailed: (id: string, emails?: string[]) =>
    request<{ requeued: number }>(
      `/admin/announcements/${encodeURIComponent(id)}/resend`,
      {
        method: "POST",
        ...(emails && emails.length > 0
          ? { body: JSON.stringify({ emails }) }
          : {}),
      }
    ),
}

// ---- 成就系统 ----

export const achievementApi = {
  list: () => request<AchievementsResponse>("/achievements"),
}

// ---- 积分（余额 / 流水 / 兑换中转站余额）----

export const checkinApi = {
  status: () =>
    request<{
      enabled: boolean
      /** 站点时区下的今天（YYYY-MM-DD）——自动签到按它判定「今天是否已处理」 */
      today: string
      checkedIn: boolean
      streak: number
      todayPoints: number
      todayBase: number
      todayBonus: number
      milestones: { days: number; points: number }[]
      next: { days: number; points: number; daysLeft: number } | null
      makeupCards: number
      canMakeup: boolean
      autoCheckin: boolean
    }>("/checkin"),

  do: () =>
    request<{
      ok: boolean
      streak: number
      base: number
      bonus: number
      total: number
      milestoneHit: { days: number; points: number } | null
      next: { days: number; points: number; daysLeft: number } | null
    }>("/checkin", { method: "POST" }),

  makeup: (date?: string) =>
    request<{ ok: boolean; makeupDate: string; streak: number; makeupCards: number }>(
      "/checkin/makeup",
      { method: "POST", body: JSON.stringify(date ? { date } : {}) }
    ),

  history: (month: string) =>
    request<{
      month: string
      today: string
      makeupCards: number
      days: { date: string; points: number; isMakeup: boolean }[]
    }>(`/checkin/history?month=${encodeURIComponent(month)}`),

  setAuto: (enabled: boolean) =>
    request<{ ok: boolean; autoCheckin: boolean }>("/checkin/auto", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
}

export const pointsApi = {
  /**
   * 上传商品封面图（2026-10-01 加）。
   *
   * 返回的 `url` 是**同源相对路径**（`/shop-img/<userId>/<file>`），
   * 直接填进 imageUrl 字段即可 —— 商城所有人都能看到这张图。
   */
  uploadProductImage: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string; url: string }>("/points/product/image", {
      method: "POST",
      body: file,
      headers,
    })
  },
  /** 余额 + 兑换配置 + 商城商品 + 我的订单 + 最近流水（一次拿齐整页数据） */
  overview: () => request<PointsOverview>("/points"),
  /**
   * 单个商品详情（详情页用）。
   * ⚠️ 返回体里 `deliveryParams.content` 已被服务端剥掉 —— 那是下单后才交付的东西。
   */
  product: (id: string) =>
    request<{ product: PointProduct }>(`/points/products/${encodeURIComponent(id)}`),
  /** 用积分兑换中转站余额（每 1 积分值多少元由后台配置） */
  redeem: (points: number) =>
    request<PointsRedeemResult>("/points/redeem", {
      method: "POST",
      body: JSON.stringify({ points }),
    }),
  /** 用户间转账：只需自己（转出方）确认，凭对方用户名转过去 */
  transfer: (username: string, amount: number) =>
    request<{ ok: boolean; balance: number; to: string }>("/points/transfer", {
      method: "POST",
      body: JSON.stringify({ username, amount }),
    }),
  /**
   * 消耗积分升到下一级会员（只升不降；价格由后台配置，0 = 未开放）。
   * 返回新等级与扣完之后的余额。
   */
  upgradeLevel: () =>
    request<{ level: number; levelName: string; balance: number }>("/points/upgrade-level", {
      method: "POST",
    }),
  /** 购买商城里的某件商品（单价固定，积分在下单时立即扣除） */
  buy: (productId: string) =>
    request<{ order: PointOrder; balance: number }>("/points/shop/buy", {
      method: "POST",
      body: JSON.stringify({ productId }),
    }),
  /**
   * 商品公示的购买记录（最近 10 条：买家用户名 + 下单时间）。
   *
   * ⚠️ 商品没开「公示购买记录」时后端返回 404 —— 调用方要当成「没有这块内容」，
   * 而不是「加载失败」（详情弹窗里不该为它弹错误提示）。
   */
  productPurchases: (productId: string) =>
    request<{ purchases: PublicPurchase[] }>(
      `/points/products/${encodeURIComponent(productId)}/purchases`
    ),

  // ---- 订单（购买 / 交付 / 确认收货 / 售后）----

  /** 卖家：把订单标记为已交付（积分仍在托管，等买家确认收货） */
  sellerDeliver: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/deliver`,
      { method: "POST" }
    ),
  /** 买家：确认收货（把托管的积分结算给卖家） */
  confirmReceipt: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/confirm`,
      { method: "POST" }
    ),

  // ---- 售后（退款）----

  /** 买家：申请退款。`delivered`（还没收到货）随时可申请；`settled` 是确认收货后 7 天内 */
  requestAfterSale: (orderId: string, reason: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale`,
      { method: "POST", body: JSON.stringify({ reason }) }
    ),
  /** 买家：撤销自己的退款申请（已申请平台介入后不能撤） */
  cancelAfterSale: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale`,
      { method: "DELETE" }
    ),
  /** 买家：卖家一直不处理或已拒绝 → 申请平台（管理员）介入 */
  escalateAfterSale: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale/escalate`,
      { method: "POST" }
    ),
  /** 买家：拒收（卖家点了已交付但没收到货 / 货不对板）→ 直达平台介入，不用先向卖家申请退款 */
  rejectOrder: (orderId: string, reason: string) =>
    request<{ order: PointOrder }>(`/points/orders/${encodeURIComponent(orderId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  /** 卖家：处理买家的退款申请（同意即退款；拒绝要写明理由） */
  sellerResolveAfterSale: (orderId: string, approve: boolean, note?: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale/decide`,
      { method: "POST", body: JSON.stringify({ approve, note }) }
    ),
}

// ---- 个人空间（公开主页）----

export const spaceApi = {
  /** 某个用户的空间详情（公开，无需登录） */
  get: (username: string) =>
    request<SpaceData>(`/space/${encodeURIComponent(username)}`),

  /** 头像悬浮卡片用的轻量摘要（每次划过都调，所以单开一个接口） */
  card: (username: string) =>
    request<SpaceCardData>(`/space/${encodeURIComponent(username)}/card`),

  /** 我自己的展示设置 */
  getMine: () => request<{ settings: MySpaceSettings }>("/my-space"),

  saveMine: (settings: MySpaceSettings) =>
    request<{ ok: boolean }>("/my-space", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
}

// ---- 我的邀请码（用户自助）----

// ---- 身份资料（昵称 / 头像）----

export const identityApi = {
  updateNickname: (nickname: string) =>
    request<{ nickname: string | null }>("/settings/nickname", {
      method: "PUT",
      body: JSON.stringify({ nickname }),
    }),

  uploadAvatar: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string }>("/settings/avatar", {
      method: "POST",
      body: file,
      headers,
    })
  },


  deleteAvatar: () =>
    request<{ ok: boolean }>("/settings/avatar", { method: "DELETE" }),
}

// ---- R2 多桶管理（管理员） ----

// ---- 社区广场 ----

/** 自定义称号：查看我持有的全部称号、切换对外展示哪一个（2026-10-01） */
export const titleApi = {
  mine: () => request<{ titles: MyTitle[] }>("/titles/mine"),
  /** titleId = null 表示一个都不展示 */
  setDisplay: (titleId: string | null) =>
    request<{ ok: boolean; titleId: string | null }>("/titles/display", {
      method: "POST",
      body: JSON.stringify({ titleId }),
    }),
}

export const communityApi = {
  /**
   * 举报一条帖子 / 评论（2026-11-06）。
   * 同一目标只能有一条待处理举报，重复举报会返回 409 ALREADY_REPORTED。
   */
  report: (payload: {
    targetType: "post" | "comment"
    targetId: string
    reason: ReportReason
    note?: string
  }) =>
    request<{ ok: boolean; id: string }>("/community/reports", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 管理员 / 站长置顶或取消置顶帖子（2026-10-01） */
  setPinned: (id: string, pinned: boolean) =>
    request<{ ok: boolean; pinned: boolean }>(
      `/community/posts/${encodeURIComponent(id)}/pin`,
      { method: "POST", body: JSON.stringify({ pinned }) }
    ),

  getConfig: () => request<CommunityConfig>("/community/config"),
  /**
   * 帖子列表（两层筛选，2026-10-07）。
   *   · sort="hot"        —— 按热度（点赞+评论）；不传 = 按时间倒序
   *   · category="<key>"  —— 只看某个分类
   *   · excludeWater      —— 看全部但不含水帖（与 category 互斥，由调用方保证）
   */
  listPosts: (opts?: {
    cursor?: string
    sort?: "latest" | "hot"
    category?: string
    excludeWater?: boolean
  }) => {
    const q = new URLSearchParams()
    if (opts?.cursor) q.set("cursor", opts.cursor)
    if (opts?.sort === "hot") q.set("sort", "hot")
    if (opts?.category) q.set("category", opts.category)
    if (opts?.excludeWater) q.set("exclude_water", "1")
    const qs = q.toString()
    return request<{ posts: Post[]; nextCursor: string | null }>(
      `/community/posts${qs ? `?${qs}` : ""}`
    )
  },
  getStats: () => request<CommunityStats>("/community/stats"),
  newPostsCount: () => request<{ count: number }>("/community/new-posts-count"),
  /** 记下「我刚打开过社区」—— 侧边栏新帖角标据此清零 */
  markSeen: () => request<{ ok: boolean }>("/community/seen", { method: "POST" }),
  getPost: (id: string) => request<{ post: Post }>(`/community/posts/${encodeURIComponent(id)}`),
  getComments: (id: string) =>
    request<{ comments: CommentNode[] }>(`/community/posts/${encodeURIComponent(id)}/comments`),
  createPost: (body: string, images: string[] = [], category: string = "chat") =>
    request<{ post: { id: string } }>("/community/posts", {
      method: "POST", body: JSON.stringify({ body, images, category }),
    }),
  uploadImage: (postId: string, file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string }>(`/community/posts/${encodeURIComponent(postId)}/images`, {
      method: "POST", body: file, headers,
    })
  },
  /** 编辑帖子时删除一张帖子图片（后端同时删 R2 对象并从 posts.images 移除） */
  deletePostImage: (postId: string, filename: string) =>
    request<{ ok: boolean; remaining: number }>(
      `/community/posts/${encodeURIComponent(postId)}/images/${encodeURIComponent(filename)}`,
      { method: "DELETE" }
    ),
  toggleLike: (id: string) =>
    request<{ liked: boolean; likeCount: number }>(`/community/posts/${encodeURIComponent(id)}/like`, { method: "POST" }),
  toggleCommentLike: (id: string) =>
    request<{ liked: boolean; likeCount: number }>(`/community/comments/${encodeURIComponent(id)}/like`, { method: "POST" }),
  share: (id: string) =>
    request<{ shareCount: number; alreadyShared: boolean }>(`/community/posts/${encodeURIComponent(id)}/share`, { method: "POST" }),
  comment: (id: string, body: string, parentId?: string, replyToUserId?: string) =>
    request<{ comment: { id: string } }>(`/community/posts/${encodeURIComponent(id)}/comments`, {
      method: "POST", body: JSON.stringify({ body, parentId, replyToUserId }),
    }),
  deletePost: (id: string) => request<{ ok: boolean }>(`/community/posts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updatePost: (id: string, body: string) =>
    request<{ ok: boolean; unchanged?: boolean; updatedAt?: string }>(`/community/posts/${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify({ body }),
    }),
  listEdits: (id: string) =>
    request<{ edits: { editedAt: string }[] }>(`/community/posts/${encodeURIComponent(id)}/edits`),
  /** 链接预览：返回目标 URL 的标题/描述/图片（拿不到则 preview=null） */
  linkPreview: (url: string) =>
    request<{ preview: LinkPreview | null }>(`/community/link-preview?url=${encodeURIComponent(url)}`),
  /**
   * 编辑自己的评论（2026-10-17）。后端按设置 community_comment_edit_limit
   * 限制次数，超额返回 403 EDIT_LIMIT_REACHED；并发冲突返回 409 CONFLICT。
   */
  updateComment: (id: string, body: string) =>
    request<{ ok: boolean; unchanged?: boolean; editCount: number; updatedAt?: string }>(
      `/community/comments/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ body }) }
    ),
  /** 删除评论（作者或管理员）：软删 + 清空正文，列表保留「该评论已删除」占位 */
  deleteComment: (id: string) =>
    request<{ ok: boolean; alreadyDeleted?: boolean }>(
      `/community/comments/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
}

// ---- 网站统计（管理员）----

export const analyticsApi = {
  overview: (days = 7) =>
    request<AnalyticsOverview>(`/admin/analytics?days=${days}`),
  /** 用户数据分析：模块开通率、资源占用、捐献与社区活跃度 */
  users: (days = 30) =>
    request<UserAnalytics>(`/admin/analytics/users?days=${days}`),
}

// ---- 公共聊天室 ----

export const chatApi = {
  /**
   * 消息列表。
   * · 不传游标：拉最近一批（首屏用）
   * · `after`：增量拉**更新**的（5 秒轮询用）
   * · `before`：往前翻页，拉**更早**的（往上滑看历史，借鉴 Telegram offset_id 翻页）
   * · `sinceEdit`：编辑/回应回传窗口 —— 已越过游标的「编辑过、新被回应过」的
   *   旧消息也一并带回，前端按 id 替换本地已知消息（否则别人看不到你的编辑）。
   * 返回的 `nextCursor` 喂给 after、`prevCursor` 喂给 before；
   * `typing` 是窗口内正在输入的人（搭轮询的车下发，不单开请求）。
   */
  list: (opts?: { after?: string; before?: string; limit?: number; sinceEdit?: string }) => {
    const qs = new URLSearchParams()
    if (opts?.after) qs.set("after", opts.after)
    if (opts?.before) qs.set("before", opts.before)
    if (opts?.limit) qs.set("limit", String(opts.limit))
    if (opts?.sinceEdit) qs.set("sinceEdit", opts.sinceEdit)
    const suffix = qs.toString() ? `?${qs.toString()}` : ""
    return request<{
      messages: ChatMessage[]
      nextCursor: string | null
      prevCursor: string | null
      hasMore: boolean
      typing: ChatPresenceUser[]
    }>(`/chat/messages${suffix}`)
  },
  /**
   * 发消息。`clientId` 是幂等键（借鉴 Telegram random_id）：乐观发送先本地出
   * 气泡，超时重试 / 双击提交时服务端只落一行，重复请求拿回同一条消息。
   * `forwardFrom` = `"<kind>:<id>"`（chat|dm），转发时正文由服务端取来源消息。
   */
  send: (
    body: string,
    opts?: { replyTo?: string | null; clientId?: string; forwardFrom?: string }
  ) =>
    request<{ message: ChatMessage }>("/chat/messages", {
      method: "POST",
      body: JSON.stringify({
        body,
        ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts?.clientId ? { clientId: opts.clientId } : {}),
        ...(opts?.forwardFrom ? { forwardFrom: opts.forwardFrom } : {}),
      }),
    }),
  /** 撤回自己的消息（管理员不限） */
  recall: (id: string) =>
    request<{ ok: boolean }>(`/chat/messages/${encodeURIComponent(id)}/recall`, {
      method: "POST",
    }),
  /** 表情回应开关（toggle）：点一下加上、再点取消 */
  react: (id: string, emoji: string) =>
    request<{ emoji: string; active: boolean }>(
      `/chat/messages/${encodeURIComponent(id)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji }) }
    ),
  /** 编辑自己的消息（10 分钟内），返回补全后的整条消息 */
  edit: (id: string, body: string) =>
    request<{ message: ChatMessage }>(`/chat/messages/${encodeURIComponent(id)}/edit`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  /** 「我正在输入」心跳 —— 前端 5 秒节流一次，由消息轮询顺带带回别人的状态 */
  typing: () => request<{ ok: boolean }>("/chat/typing", { method: "POST" }),
  heartbeat: () => request<{ ok: boolean }>("/chat/heartbeat", { method: "POST" }),
  presence: () => request<{ online: ChatPresenceUser[] }>("/chat/presence"),
  /** 侧边栏「聊天室」角标：我看过之后的新消息数 */
  unreadCount: () => request<{ count: number }>("/chat/unread"),
  /** 记下「我刚打开过聊天室」—— 新消息角标据此清零 */
  markSeen: () => request<{ ok: boolean }>("/chat/seen", { method: "POST" }),
}

// ---- 角标汇总 ----

/**
 * 一次拿齐所有「需要注意」的计数：侧边栏（社区 / 聊天室 / 反馈 / 管理）
 * 与管理面板各栏目共用，避免为角标发一串小请求。
 * `admin` 对普通用户是 null。
 */
export const attentionApi = {
  get: () => request<AttentionCounts>("/attention"),
}

// ---- 通知 / 消息箱 ----

/**
 * 一对一私信（2026-10-01）。
 *
 * 轮询与聊天室一个路子：拉取**不会**自动标已读，前端在「用户真的看到」时
 * 单独调 `seen()`（否则轮询一次就把未读清零了）。
 */
export const dmApi = {
  /** 会话列表（每个对端一条，带未读数） */
  conversations: () =>
    request<{ conversations: DmConversation[]; unreadTotal: number }>(
      "/dm/conversations"
    ),

  /** 只取未读总数（做角标用，别为它拉整个列表） */
  unread: () => request<{ unread: number }>("/dm/unread"),

  /** 我收到的待处理聊天申请（陌生人发来的第一条消息 + 同意/拒绝） */
  requests: () => request<{ requests: DmRequest[] }>("/dm/requests"),

  /** 处理聊天申请：同意后双方才能自由发消息 */
  respondRequest: (peer: string, action: "accept" | "decline") =>
    request<{ ok: boolean; status: string }>("/dm/requests", {
      method: "POST",
      body: JSON.stringify({ peer, action }),
    }),

  /**
   * 某个会话的消息。
   * · 不传游标：拉最近一批（进会话时用）
   * · `after`：增量拉**更新**的（轮询用）
   * · `before`：往前翻页，拉**更早**的（往上滑看历史用）
   * · `sinceEdit`：编辑/回应回传窗口 —— 已越过游标的「编辑过、新被回应过」
   *   的旧消息也一并带回，前端按 id 替换本地已知消息。
   * 返回的 `nextCursor` 喂给 `after`，`prevCursor` 喂给 `before`。
   */
  list: (
    peer: string,
    opts?: { after?: string; before?: string; limit?: number; sinceEdit?: string }
  ) => {
    const qs = new URLSearchParams({ peer })
    if (opts?.after) qs.set("after", opts.after)
    if (opts?.before) qs.set("before", opts.before)
    if (opts?.limit) qs.set("limit", String(opts.limit))
    if (opts?.sinceEdit) qs.set("sinceEdit", opts.sinceEdit)
    return request<{
      peer: DmPeer
      messages: DmMessage[]
      nextCursor: string | null
      prevCursor: string | null
      hasMore: boolean
      /** 对端是否正在输入（消息轮询顺带下发） */
      peerTyping: boolean
    }>(`/dm?${qs.toString()}`)
  },

  /**
   * 发私信。`clientId` 幂等键与聊天室同套（超时重发不产生重复消息）；
   * `replyTo` = 被引用消息 id（同会话内有效，对方已撤回则自动降级为普通消息）；
   * `forwardFrom` = `"<kind>:<id>"`（chat|dm），转发正文由服务端取来源消息。
   */
  send: (
    to: string,
    body: string,
    opts?: { replyTo?: string | null; clientId?: string; forwardFrom?: string }
  ) =>
    request<{ message: DmMessage }>("/dm", {
      method: "POST",
      body: JSON.stringify({
        to,
        body,
        ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts?.clientId ? { clientId: opts.clientId } : {}),
        ...(opts?.forwardFrom ? { forwardFrom: opts.forwardFrom } : {}),
      }),
    }),

  /** 撤回私信：本人 10 分钟内可撤（管理员不限），正文真的清掉 */
  recall: (id: string) =>
    request<{ ok: boolean }>(`/dm/messages/${encodeURIComponent(id)}/recall`, {
      method: "POST",
    }),

  /** 表情回应开关（toggle）：点一下加上、再点取消 */
  react: (id: string, emoji: string) =>
    request<{ emoji: string; active: boolean }>(
      `/dm/messages/${encodeURIComponent(id)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji }) }
    ),

  /** 编辑自己的私信（10 分钟内），返回补全后的整条消息 */
  edit: (id: string, body: string) =>
    request<{ message: DmMessage }>(`/dm/messages/${encodeURIComponent(id)}/edit`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  /** 「我正在给对端打字」心跳 —— 5 秒节流，对端靠 list 轮询看到 */
  typing: (peer: string) =>
    request<{ ok: boolean }>("/dm/typing", {
      method: "POST",
      body: JSON.stringify({ peer }),
    }),

  /** 把「与某个对端的会话里我收到的消息」标为已读（幂等） */
  seen: (peer: string) =>
    request<{ ok: boolean; marked: number }>("/dm/seen", {
      method: "POST",
      body: JSON.stringify({ peer }),
    }),
}

export const notificationApi = {
  /** 消息列表；category 可选（system/site/social/event），不传 = 全部 */
  list: (params?: { category?: MessageCategory; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.category) qs.set("category", params.category)
    if (params?.limit) qs.set("limit", String(params.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ""
    return request<{ notifications: Notification[] }>(`/notifications${suffix}`)
  },
  unreadCount: () =>
    request<{ count: number; byCategory: Record<MessageCategory, number> }>(
      "/notifications/unread-count"
    ),
  /**
   * 最新一条未读（没有则 null）。给网页侧的「零配置通知」轮询用：
   * 比拉整个列表轻，而且只关心「最新那一条」就够了。
   * lang 决定服务端拼出来的社交类标题是中文还是英文。
   */
  latest: (lang: string) =>
    request<{ id: string; title: string; body: string; link: string } | null>(
      `/notifications/latest?lang=${encodeURIComponent(lang)}`
    ),
  markRead: (ids?: string[], all?: boolean, category?: MessageCategory) =>
    request<{ ok: boolean }>("/notifications/read", {
      method: "POST",
      body: JSON.stringify({ ids, all, category }),
    }),
}

// ---- 活动 ----

export const eventApi = {
  list: () => request<{ events: EventItem[]; now: string }>("/events"),
  /**
   * 历史投票：已结束的投票活动（含最终票数、获奖选项、我投了谁、我的结算结果）。
   *
   * 活动一过截止时间就从 `/events`（活动推广列表）消失，而「截止后开奖」的结果
   * 偏偏是在截止之后才出来的 —— 这条是那些活动的回看入口。
   * 只返回原本就出现在「活动推广」里的（promo_hidden = 0）。
   */
  /**
   * 集合投票（问卷）交卷。
   * 服务端按活动配置算答对率、落档、发奖；**每题对错只在 reveal=immediate 时返回**
   * （afterDeadline/never 一律不带，避免被小号探答案）。
   */
  submitQuiz: (
    id: string,
    answers: Record<string, string>,
    elapsedSec?: number,
    /** true = 到点自动交卷（允许空卷） */
    autoSubmit?: boolean
  ) =>
    request<{
      ok: boolean
      /** 第几次作答（retake=once 时恒为 1） */
      attempt: number
      /** 答对率 0..100（分母是题目总数，没答的按错） */
      percent: number
      rightCount: number
      total: number
      /** 人话说明：达到哪一档 / 没达到 / 超时不计 */
      rewardNote: string
      granted: boolean
      grantDetail: string
      revealed: boolean
      perQuestion: { id: string; answered: string; correct?: boolean; answer?: string }[]
    }>(`/events/${encodeURIComponent(id)}/quiz`, {
      method: "POST",
      body: JSON.stringify({ answers, elapsedSec, autoSubmit: autoSubmit === true }),
    }),
  voteHistory: () => request<{ events: EventItem[]; now: string }>("/events/vote-history"),
  /** 单个活动（公开）：活动分享链接用；draft / scheduled 会 404 */
  get: (id: string) => request<{ event: EventItem }>(`/events/${encodeURIComponent(id)}`),
  /** 认证码活动必须带 code；其余活动 code 可省略 */
  /**
   * 领取活动奖励 / 参与活动。
   *
   * `code` 用于「凭认证码」的活动，`github` 用于「点了 GitHub star」的活动，
   * `optionId` 用于投票活动（投给哪个选项）—— 三者都只是**线索**，
   * 服务端一律重新核验（选项是否存在、名字是否已被占用等），前端传什么都不信。
   */
  claim: (id: string, code?: string, github?: string, optionId?: string) =>
    request<{ status: string; detail: string }>(
      `/events/${encodeURIComponent(id)}/claim`,
      {
        method: "POST",
        body: JSON.stringify({ code: code ?? "", github: github ?? "", optionId: optionId ?? "" }),
      }
    ),
}

export const adminEventApi = {
  list: () => request<{ events: EventItem[] }>("/admin/events"),
  create: (payload: EventPayload) =>
    request<{ event: EventItem; inserted: number }>("/admin/events", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  update: (id: string, payload: Partial<EventPayload>) =>
    request<{ event: EventItem; inserted: number }>(
      `/admin/events/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/events/${encodeURIComponent(id)}`, { method: "DELETE" }),
  claims: (id: string) =>
    request<{ claims: EventClaim[] }>(`/admin/events/${encodeURIComponent(id)}/claims`),
  /** 删除一条领取记录（误参与 / 测试数据；**不回收已发奖励**） */
  deleteClaim: (id: string, claimId: string) =>
    request<{ ok: boolean }>(
      `/admin/events/${encodeURIComponent(id)}/claims/${encodeURIComponent(claimId)}`,
      { method: "DELETE" }
    ),
  grant: (id: string, claimId: string, detail?: string) =>
    request<{ ok: boolean }>(
      `/admin/events/${encodeURIComponent(id)}/claims/${encodeURIComponent(claimId)}/grant`,
      { method: "POST", body: JSON.stringify({ detail }) }
    ),
  /**
   * 开奖：抽奖从报名者里随机抽人；投票按「多数/少数得奖」计票。
   * 已开过奖会返回 409；对「参与即可获奖」/「立刻结算」的投票会返回 400
   * （那两档在投票时就已经结算完了）。
   * `winningOptions` 只有投票开奖才会返回（平票时是多个选项 id）。
   */
  draw: (id: string) =>
    request<{
      ok: boolean
      winners: number
      distributed: number
      participants: number
      failed: number
      winningOptions?: string[]
    }>(`/admin/events/${encodeURIComponent(id)}/draw`, { method: "POST" }),
  /**
   * 上传投票选项配图。返回的 `url` 是**同源相对路径**（`/api/event-img/<userId>/<file>`），
   * 直接填进选项的 image 字段即可 —— 活动是公开分享的，配图必须任何人可读。
   */
  uploadImage: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string; url: string }>("/admin/events/image", {
      method: "POST",
      body: file,
      headers,
    })
  },
}

/**
 * 封禁申诉（**公开接口**）：被封禁的账号登录会被 403、拿不到会话，
 * 所以提交申诉不依赖登录态 —— 用「用户名 + 说明」提交。
 */
// ---- 用户表情包 ----

export const stickerApi = {
  /**
   * 我的表情包。
   *
   * 缓存：服务端返回 `Cache-Control: private, no-cache` + ETag，**浏览器**会自己
   * 带 If-None-Match 做协商、命中 304 时直接用本地副本 —— 这一层对 fetch 是透明的，
   * 不需要我们写代码。前端另有一层 localStorage（见 sticker-panel.tsx）负责「打开就显示」。
   */
  list: () => request<{ stickers: Sticker[]; version: string; limit: number }>("/stickers"),

  /** 上传：raw body + Content-Type（不套 multipart，少一层解析） */
  upload: (blob: Blob, contentType: string) =>
    request<{ sticker: Sticker }>("/stickers", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: blob,
    }),

  remove: (id: string) =>
    request<void>(`/stickers/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 把别人发的表情包存进自己的表情包（幂等：已存过会返回已有的，alreadySaved=true） */
  save: (id: string) =>
    request<{ sticker: Sticker; alreadySaved: boolean }>("/stickers/save", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}

export const appealApi = {
  /** identifier：用户名**或**邮箱都行（后端两种都会查） */
  submit: (payload: { identifier: string; contact?: string; content: string }) =>
    request<{ ok: boolean; id: string }>("/appeal", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /**
   * 取「有管理员回复、但用户还没确认看过」的申诉（需登录）。
   * 返回 null 表示没有待确认的回复 —— 前端据此决定要不要弹强制确认框。
   * 这也是**补发**通道：老用户解封后一直没看到回复，这次打开页面就会命中。
   */
  pendingReply: () =>
    request<{ reply: AppealPendingReply | null }>("/appeal/pending-reply"),
  /**
   * 确认已读管理员回复（需登录）。
   *
   * ⚠️ 只有 `choice: "understood"`（勾了「我已完全明白并承诺不再违规」）才会真正落库；
   *    勾另一项只是留痕、回复仍算未读 —— 站长要求「必须勾第一个才能关掉弹窗」。
   *    返回的 `read` 表示这次调用是否真的标记了已读。
   */
  acknowledge: (payload: { appealId?: string; choice?: string }) =>
    request<{ ok: boolean; nothing?: boolean; read?: boolean }>("/appeal/acknowledge", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
}

/** 用户侧：管理端通知（强制已读弹窗） */
export const noticeApi = {
  pending: () => request<{ notices: PendingNotice[] }>("/notice/pending"),
  /**
   * 确认收到。若该通知要求捐献而用户还没捐，后端返回 `ok:false` +
   * 通知的捐献门槛已随捐献模块移除，现在恒定成功。
   */
  ack: (id: string) =>
    request<{
      ok: boolean
      unlocked?: boolean
    }>("/notice/ack", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}

/** 管理端：通知 */
export const adminNoticeApi = {
  list: () => request<{ notices: AdminNotice[] }>("/admin/notices"),
  send: (payload: {
    usernames: string[]
    title: string
    body: string
    restrictFeatures?: string[]
  }) =>
    request<{
      sent: string[]
      missing: string[]
      restricted: number
      /** 命中监管白名单、只发通知不改权限的用户 */
      whitelisted: string[]
    }>("/admin/notices", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  revoke: (id: string) =>
    request<{ ok: boolean }>("/admin/notices/revoke", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}

/** 管理端「监管」栏目：申诉 + 风险账户 */
export const adminModerationApi = {
  appeals: () => request<{ appeals: AccountAppeal[] }>("/admin/appeals"),
  reviewAppeal: (id: string, action: "accept" | "reject", note?: string) =>
    request<{ ok: boolean; status: string; unblocked: boolean }>(
      `/admin/appeals/${encodeURIComponent(id)}/review`,
      { method: "POST", body: JSON.stringify({ action, note }) }
    ),
  riskAccounts: () => request<{ accounts: RiskAccount[] }>("/admin/risk-accounts"),
  updateRiskStatus: (userId: string, status: RiskAccount["status"]) =>
    request<{ ok: boolean }>(`/admin/risk-accounts/${encodeURIComponent(userId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),

  // ---- 白名单 / 自动条件 / 黑名单（2026-10-03） ----

  /** 一次拿齐白名单（按来源分组）+ 黑名单；GET 时后端会顺带按条件同步一次 */
  lists: () => request<ModerationLists>("/admin/moderation/lists"),
  /** 白名单手动增删 */
  whitelistUpdate: (action: "add" | "remove", username: string) =>
    request<{ ok: boolean }>("/admin/moderation/whitelist", {
      method: "POST",
      body: JSON.stringify({ action, username }),
    }),
  /** 白名单自动条件：新建 / 启停 / 删除 */
  conditionUpdate: (payload: {
    action: "create" | "toggle" | "delete"
    id?: string
    metric?: ModerationConditionMetric
    op?: ModerationConditionOp
    value?: number
    enabled?: boolean
  }) =>
    request<{ ok: boolean }>("/admin/moderation/conditions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** 黑名单增删（IP） */
  blacklistUpdate: (action: "add" | "remove", ip: string, reason?: string) =>
    request<{ ok: boolean }>("/admin/moderation/blacklist", {
      method: "POST",
      body: JSON.stringify({ action, ip, reason }),
    }),
  /** IP 监管：查出被多个不同（未封禁）账号共用的登录 IP */
  ipWatch: () => request<IpWatchResult>("/admin/moderation/ip-watch"),
}

/** 「IP 监管」里共用一个 IP 的某个账号 */
export interface SharedIpUser {
  username: string
  nickname: string | null
  firstSeenAt: string
  lastSeenAt: string
  times: number
}

/** 「IP 监管」里的一个可疑 IP 分组 */
export interface SharedIpGroup {
  ip: string
  userCount: number
  users: SharedIpUser[]
}

export interface IpWatchResult {
  groups: SharedIpGroup[]
  ipCount: number
  userCount: number
}

/** 管理端积分接口 */
export const adminPointsApi = {
  /**
   * 积分总览：用户列表（含 0 分用户）+ 全站汇总；query 可按用户名/昵称搜索。
   * 不传 limit/offset = 旧行为（最新 200 人）；传了 = 服务端分页（响应带 total）。
   */
  list: (opts?: { query?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams()
    const q = opts?.query?.trim()
    if (q) p.set("query", q)
    if (opts?.limit != null) p.set("limit", String(opts.limit))
    if (opts?.offset != null) p.set("offset", String(opts.offset))
    const qs = p.toString()
    return request<AdminPointsOverview>(`/admin/points${qs ? `?${qs}` : ""}`)
  },
  /** 发放（delta>0）/ 扣减（delta<0）积分 */
  adjust: (payload: { username: string; delta: number; detail?: string }) =>
    request<{ balance: number }>("/admin/points/adjust", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** 某用户的积分流水 */
  history: (username: string) =>
    request<{ username: string; balance: number; transactions: PointTransaction[] }>(
      `/admin/points/${encodeURIComponent(username)}/history`
    ),

  // ---- 商城 ----

  /** 商城标签页一次拿齐：商品 + 订单 + 兑换配置（status 可选过滤订单） */
  shop: (status?: string) =>
    request<AdminShopData>(
      `/admin/points/shop${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  /**
   * 保存捐献奖励 / 邀请奖励配置。
   *
   * `donationRewards` 用 `{ 档位: 积分数 }` 提交（只提交要改的档位也行），
   * 返回的却是数组（带中文名与固定顺序）—— 见 DonationRewardItem 的说明。
   * `invitePoints` 同理：只提交要改的字段。
   */
  saveConfig: (payload: {
    donationRewards?: Record<string, number>
    donationDailyLimit?: number
    invitePoints?: Partial<InvitePointsConfig>
  }) =>
    request<{
      donationRewards: DonationRewardItem[]
      donationDailyLimit: number
      inviteConfig: InvitePointsConfig
    }>("/admin/points/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  /** 新建商品 */
  createProduct: (payload: PointProductPayload) =>
    request<{ product: PointProduct }>("/admin/points/products", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** 编辑商品（整条覆盖） */
  updateProduct: (id: string, payload: PointProductPayload) =>
    request<{ product: PointProduct }>(`/admin/points/products/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  /** 删除商品（历史订单保留快照，不受影响） */
  deleteProduct: (id: string) =>
    request<{ ok: boolean }>(`/admin/points/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  /** 把待发放的订单标记为已发放（只对官方商品订单有效） */
  deliverOrder: (id: string, note?: string) =>
    request<{ order: PointOrder }>(`/admin/points/orders/${encodeURIComponent(id)}/deliver`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  /** 卡密池概览（delivery='code'） */
  getProductCodes: (id: string) =>
    request<{ total: number; used: number; available: number }>(
      `/admin/points/products/${encodeURIComponent(id)}/codes`
    ),
  /** 追加卡密（一行一条，自动去重） */
  addProductCodes: (id: string, codes: string[]) =>
    request<{ added: number; available: number }>(
      `/admin/points/products/${encodeURIComponent(id)}/codes`,
      { method: "POST", body: JSON.stringify({ codes }) }
    ),
  /** 清空未使用的卡密 */
  clearProductCodes: (id: string) =>
    request<{ removed: number }>(
      `/admin/points/products/${encodeURIComponent(id)}/codes`,
      { method: "DELETE" }
    ),
  /** 强制结算用户商品订单（卖家已交付但买家一直不确认时用） */
  settleOrder: (id: string) =>
    request<{ order: PointOrder }>(`/admin/points/orders/${encodeURIComponent(id)}/settle`, {
      method: "POST",
    }),
  /** 取消订单并把积分退回买家（已结算的会先从卖家账上收回） */
  cancelOrder: (id: string, reason?: string) =>
    request<{ order: PointOrder }>(`/admin/points/orders/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  /**
   * 售后列表。不传 status = 只看「待平台处理」的；
   * 传 `all` = 看全部有售后记录的订单（含已退款 / 已驳回）。
   */
  afterSales: (status?: string) =>
    request<{ orders: PointOrder[]; status: string }>(
      `/admin/points/after-sales${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  /**
   * 客服判定退款申请。
   * approve=true 同意退款（已结算的会先从卖家收益里收回，收不回会报错并提示先调整卖家积分）；
   * false 驳回，售后终结。
   */
  resolveAfterSale: (id: string, approve: boolean, note?: string) =>
    request<{ order: PointOrder }>(
      `/admin/points/orders/${encodeURIComponent(id)}/after-sale`,
      { method: "POST", body: JSON.stringify({ approve, note }) }
    ),
}

// ---- OAuth 授权服务器（Doulor Cloud 作为身份提供方）----
//
// 类型定义放在这里而不是 types/index.ts：本组接口自成一体，
// 也避免与同时改 types/index.ts 的另一处改动互相干扰。

/** 接入本站登录的第三方应用（管理端视角，不含任何密钥字段） */
export interface OAuthClient {
  id: string
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string
  disabled: boolean
  ownerUserId: string | null
  /** 审核状态：approved（可用）/ pending（待站长审核）/ rejected（已驳回） */
  reviewStatus: string
  /** 审核意见（驳回原因），通过时为 null */
  reviewNote: string | null
  /** 授权门槛：0=所有人可授权；1/2/3=黄金/白金/黑金会员及以上 */
  minLevel: number
  /** 管理端列表才带：创建者用户名 */
  ownerName?: string | null
  createdAt: string
  updatedAt: string
}

/** 同意页展示信息 */
export interface OAuthAuthorizeContext {
  clientName: string
  clientId: string
  scopes: string[]
  /** 回调地址的站点域名（用户据此判断这是哪个网站） */
  redirectHosts: string[]
  alreadyGranted: boolean
  /** 授权门槛（0=不限）；>0 时同意页展示等级要求 */
  minLevel: number
  /** 当前用户的会员等级（0=普通 1=黄金 2=白金 3=黑金） */
  userLevel: number
}

/** 我授权过的应用 */
export interface OAuthGrant {
  clientId: string
  name: string
  scopes: string[]
  createdAt: string
}

/** 授权请求参数（同意页与 authorize 端点共用同一套参数名） */
export interface OAuthAuthorizeParams {
  client_id: string
  redirect_uri: string
  scope?: string | null
  state?: string | null
  response_type?: string | null
  code_challenge?: string | null
  code_challenge_method?: string | null
}

export const oauthApi = {
  /** 同意页：拉取「谁在申请什么权限」 */
  context: (params: OAuthAuthorizeParams) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v) q.set(k, String(v))
    }
    return request<OAuthAuthorizeContext>(`/oauth/authorize/context?${q.toString()}`)
  },

  /** 同意页：允许 / 拒绝。返回要跳去的地址（由前端自己跳，便于先清理临时状态） */
  decide: (params: OAuthAuthorizeParams & { approve: boolean }) =>
    request<{ redirectTo: string }>("/oauth/authorize/decision", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** 我授权过的应用 */
  grants: () => request<{ grants: OAuthGrant[] }>("/oauth/grants"),

  /** 撤销对某个应用的授权（同时作废其令牌） */
  revoke: (clientId: string) =>
    request<{ ok: boolean }>(`/oauth/grants/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
    }),

  // ---- 「我创建的应用」（2026-10-06 放开用户自建）----

  /** 我创建的应用列表 + 当前是否免审 + 每人上限 */
  myClients: () =>
    request<{ clients: OAuthClient[]; autoApprove: boolean; maxClients: number }>(
      "/oauth/my-clients"
    ),

  /** 创建应用。clientSecret 明文只此一次，丢了只能删了重建 */
  createMyClient: (payload: {
    name: string
    redirectUris: string[]
    scopes?: string
    allowHttp?: boolean
    minLevel?: number
  }) =>
    request<{ client: OAuthClient; clientSecret: string; pending: boolean }>(
      "/oauth/my-clients",
      { method: "POST", body: JSON.stringify(payload) }
    ),

  /** 改名字 / 回调地址（会重新排队审核）。注意后端没有开放改 client_id */
  updateMyClient: (
    id: string,
    payload: {
      name?: string
      redirectUris?: string[]
      scopes?: string
      allowHttp?: boolean
      minLevel?: number
    }
  ) =>
    request<{ client: OAuthClient | null }>(
      `/oauth/my-clients/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  deleteMyClient: (id: string) =>
    request<{ ok: boolean }>(`/oauth/my-clients/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
}

export const oauthAdminApi = {
  list: () =>
    request<{ clients: OAuthClient[]; autoApprove: boolean }>("/admin/oauth/clients"),

  /** 审核用户提交的应用：通过 / 驳回（可带驳回原因） */
  review: (id: string, payload: { approve: boolean; note?: string }) =>
    request<{ client: OAuthClient | null }>(
      `/admin/oauth/clients/${encodeURIComponent(id)}/review`,
      { method: "POST", body: JSON.stringify(payload) }
    ),

  /** 切换「用户自建应用免审」开关（关着 = 需站长审核） */
  setAutoApprove: (autoApprove: boolean) =>
    request<{ autoApprove: boolean }>("/admin/oauth/settings", {
      method: "POST",
      body: JSON.stringify({ autoApprove }),
    }),

  /**
   * 创建应用。⚠️ 返回的 `clientSecret` 明文**只此一次**，
   * 库里只存哈希，之后无法再取回（丢了只能重置）。
   */
  create: (payload: {
    name: string
    redirectUris: string[]
    scopes?: string
    allowHttp?: boolean
    minLevel?: number
  }) =>
    request<{ client: OAuthClient; clientSecret: string }>("/admin/oauth/clients", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  update: (
    id: string,
    payload: {
      name?: string
      redirectUris?: string[]
      scopes?: string
      disabled?: boolean
      allowHttp?: boolean
      minLevel?: number
    }
  ) =>
    request<{ client: OAuthClient | null }>(
      `/admin/oauth/clients/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  /** 重置密钥，返回新的明文（同样只此一次） */
  resetSecret: (id: string) =>
    request<{ clientSecret: string }>(
      `/admin/oauth/clients/${encodeURIComponent(id)}/secret`,
      { method: "POST" }
    ),

  /** 删除应用（连带作废其全部令牌与授权记录） */
  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/oauth/clients/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
}

// ---- 用户反馈（私有工单）----

// ---- 管理审计时间线 ----

export const auditApi = {
  /** 管理员操作时间线（scope=admins 只看管理员操作，all 看全站审计；mgmt=1 只看管理面板操作） */
  list: (params: {
    scope?: "admins" | "all"
    mgmt?: boolean
    action?: string
    page?: number
  } = {}) => {
    const qs = new URLSearchParams()
    if (params.scope) qs.set("scope", params.scope)
    if (params.mgmt) qs.set("mgmt", "1")
    if (params.action) qs.set("action", params.action)
    qs.set("page", String(params.page ?? 1))
    return request<AdminAuditData>(`/admin/audit?${qs.toString()}`)
  },
}

/**
 * 聊天图片上传 —— 私聊 / 聊天室 / 广场帖子与评论共用。
 *
 * 返回的 `url` 直接塞进 markdown 的 `![]()` 就能显示，
 * 所以拖拽/粘贴进来后只需往输入框里插一段文本，不用改消息结构。
 */
export const chatUploadApi = {
  upload: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string; url: string }>("/chat/upload-image", {
      method: "POST",
      body: file,
      headers,
    })
  },
}

/**
 * 二次认证（2FA）。
 *
 * 分两组：
 * · `verifyLogin` / `sendLoginEmail` —— 登录第二步，此时**还没有登录态**；
 * · 其余 —— 登录后在设置页自助管理。
 */
/**
 * 改动 2FA 设置时的「二次验证」载荷（2026-10-10 起服务端强制要求）。
 * `challengeId` 只在用**邮箱验证码**时才需要 —— 由 `twoFactorApi.sendStepUpCode()` 换回。
 */
export interface TwoFactorStepUp {
  code?: string
  challengeId?: string
}

export const twoFactorApi = {
  /** 登录第二步：提交验证码，成功后才真正建立登录态 */
  verifyLogin: (payload: { challengeId: string; method: string; code: string }) =>
    request<{ user: MeResponse["user"]; mustSetupTwoFactor?: boolean }>("/login/2fa", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 给当前挑战的账号重发一封邮箱验证码 */
  sendLoginEmail: (challengeId: string) =>
    request<{ ok: boolean }>("/login/2fa/send-email", {
      method: "POST",
      body: JSON.stringify({ challengeId }),
    }),

  /** 我的 2FA 现状（含「是否被强制」与收件地址脱敏） */
  status: () =>
    request<{
      enabled: boolean
      methods: string[]
      totpConfirmed: boolean
      emailEnabled: boolean
      recoveryLeft: number
      enforced: boolean
      maskedEmail: string
    }>("/settings/2fa"),

  /** 开始配置 TOTP：拿到密钥与 otpauth 链接（前端画二维码） */
  /**
   * 改动 2FA 设置时的「二次验证」载荷（2026-10-10 起服务端强制）：
   *   · `code`        —— 当前可用的验证码（认证器动态码 / 恢复码 / 邮箱验证码）
   *   · `challengeId` —— 用**邮箱验证码**时必须带上（由 `sendStepUpCode()` 换回）
   * 账号还没开启任何 2FA 时（首次开启）不需要传。
   */
  startTotp: (stepUp?: TwoFactorStepUp) =>
    request<{ secret: string; otpauthUrl: string }>("/settings/2fa/totp/start", {
      method: "POST",
      body: JSON.stringify(stepUp ?? {}),
    }),

  /** 用认证器上的一次动态码确认，成功则返回恢复码（仅此一次明文） */
  confirmTotp: (code: string) =>
    request<{ ok: boolean; recoveryCodes: string[] }>("/settings/2fa/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  /** 单独关闭 TOTP（需验 TOTP 动态码或恢复码；被强制的角色不允许） */
  disableTotp: (stepUp?: TwoFactorStepUp) =>
    request<{ ok: boolean }>("/settings/2fa/totp/disable", {
      method: "POST",
      body: JSON.stringify(stepUp ?? {}),
    }),

  /** 把二次验证码发到邮箱（仅在已开启邮箱方式时可用），返回本次挑战 id */
  sendStepUpCode: () =>
    request<{ challengeId: string; expiresAt: string }>("/settings/2fa/step-up/send", {
      method: "POST",
    }),

  /** 开关邮箱验证方式 */
  /**
   * 开关邮箱二次验证。
   * ⚠️ 关闭时要验**邮箱验证码**（或恢复码）；开启时账号已有别的 2FA 则验任一已开启方式。
   * ⚠️ 开启时若当前没有可用的恢复码，服务端会发一批新的（明文只出现在这次响应里）。
   */
  setEmail: (enabled: boolean, stepUp?: TwoFactorStepUp) =>
    request<{ ok: boolean; emailEnabled: boolean; recoveryCodes?: string[] }>("/settings/2fa/email", {
      method: "POST",
      body: JSON.stringify({ enabled, ...(stepUp ?? {}) }),
    }),

  /** 重新生成恢复码（旧的全部作废；需先验一个当前可用的码） */
  regenerateRecovery: (stepUp?: TwoFactorStepUp) =>
    request<{ recoveryCodes: string[] }>("/settings/2fa/recovery/regenerate", {
      method: "POST",
      body: JSON.stringify(stepUp ?? {}),
    }),

  /** 关闭全部 2FA（需先验一个当前有效的码；被强制的角色不允许） */
  disable: (code: string, challengeId?: string) =>
    request<{ ok: boolean }>("/settings/2fa/disable", {
      method: "POST",
      body: JSON.stringify(challengeId ? { code, challengeId } : { code }),
    }),

  /** 站长兜底：清掉某人的 2FA（丢了手机时用） */
  adminReset: (userId: string) =>
    request<{ ok: boolean }>("/admin/2fa/reset", {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
}

/** 前端性能监控（RUM 聚合；scope=perf） */
export const perfApi = {
  overview: (days: number) =>
    request<PerfOverview>(`/admin/perf/overview?days=${days}`),

  pageSamples: (page: string, days = 7) =>
    request<PerfPageSamples>(
      `/admin/perf/samples?days=${days}&page=${encodeURIComponent(page)}`
    ),
}

export const feedbackApi = {  /** 我提交过的反馈 + 分类/状态标签（标签文案由服务端下发，前端不硬编码） */
  list: () => request<FeedbackOverview>("/feedback"),

  create: (payload: { category: string; title: string; body: string; images?: string[]; diagLogId?: string }) =>
    request<{ feedback: FeedbackOverview["feedback"][number] }>("/feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 上传一张反馈图片，返回 R2 key（提交/回复时把 key 数组一起带上） */
  uploadImage: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string }>("/feedback/upload-image", {
      method: "POST",
      body: file,
      headers,
    })
  },

  /** 把我的全部未读回复标记为已读（进页面即调） */
  markRead: () => request<{ ok: boolean; updated: number }>("/feedback/read", {
    method: "POST",
  }),

  /** 用户对某条反馈追加回复（对话式） */
  replyMy: (payload: { id: string; reply: string; images?: string[] }) =>
    request<{ feedback: FeedbackItem }>("/feedback/reply", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 编辑还没被处理的反馈（pending 才可改） */
  edit: (id: string, payload: { category: string; title: string; body: string; images?: string[] }) =>
    request<{ feedback: FeedbackItem }>(`/feedback/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  /** 撤销（删除）还没被处理的反馈 */
  withdraw: (id: string) =>
    request<{ ok: boolean }>(`/feedback/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // 管理端（2026-10-10 改分页 + 摘要：正文/消息/诊断日志在 detail 里按条拉）
  listAll: (status?: string, page = 1) =>
    request<AdminFeedbackList>(
      `/admin/feedback?page=${page}${status ? `&status=${encodeURIComponent(status)}` : ""}`
    ),

  /** 单条反馈详情：全文 + 对话消息 + 附带的诊断日志 */
  detail: (id: string) =>
    request<FeedbackDetail>(`/admin/feedback/detail?id=${encodeURIComponent(id)}`),

  /** 上传一份诊断日志包（提交反馈勾选「附日志」时先调这个拿 id） */
  uploadDiagLog: (pack: { windowMinutes: number; entries: unknown[]; truncated: boolean }) =>
    request<{ id: string }>("/diag-logs", {
      method: "POST",
      body: JSON.stringify(pack),
    }),

  /**
   * 回复一条反馈。
   *
   * `rewardPoints` > 0 时**顺手给作者发一笔积分奖励**（2026-10-01 加）：
   * 同一张反馈只会发一次（服务端按反馈 id 幂等），重复保存不会重复发，
   * 返回体里的 `reward.duplicated` 用于区分这一点。
   */
  reply: (payload: {
    id: string
    reply: string
    status?: string
    images?: string[]
    /** 附带的积分奖励；不填 / 0 = 不发 */
    rewardPoints?: number
  }) =>
    request<{
      feedback: AdminFeedbackItem
      reward: { amount: number; balance: number; duplicated: boolean } | null
    }>("/admin/feedback/reply", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  setStatus: (payload: { id: string; status: string }) =>
    request<{ ok: boolean; status: string }>("/admin/feedback/status", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 删除一条反馈（连带其对话消息与上传图片，不可恢复） */
  remove: (id: string) =>
    request<{ ok: boolean; deletedImages: number }>("/admin/feedback/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}
// ---- 自定义称号（徽章式；管理面板创建 + 授予） ----

/** 某个称号的一名持有者 */
export interface AdminTitleHolder {
  userId: string
  username: string
  nickname: string | null
  role: string
  grantedAt: string
}

/** 管理视角的自定义称号（含持有者列表） */
export interface AdminTitle {
  id: string
  name: string
  colorFrom: string
  colorTo: string
  createdAt: string
  holders: AdminTitleHolder[]
}

export interface AdminTitleInput {
  name: string
  colorFrom: string
  colorTo: string
}

/** 管理端：社区举报队列（2026-11-06） */
export const adminReportApi = {
  list: (status: "pending" | "all" = "pending") =>
    request<{ reports: ReportItem[]; pending: number; status: string }>(
      `/admin/reports?status=${status}`
    ),
  /** action: ignore = 保留内容；remove = 软删内容（与管理员手动删帖同一套语义） */
  decide: (id: string, action: "ignore" | "remove") =>
    request<{ ok: boolean; status: "ignored" | "removed" }>(
      `/admin/reports/${encodeURIComponent(id)}/decide`,
      { method: "POST", body: JSON.stringify({ action }) }
    ),
}

export const adminTitlesApi = {
  list: () => request<{ titles: AdminTitle[] }>("/admin/titles"),
  create: (payload: AdminTitleInput) =>
    request<{ title: AdminTitle }>("/admin/titles", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  update: (id: string, payload: Partial<AdminTitleInput>) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  /** 授予（一人可持多个称号；重复授予同一个是幂等的，不会重复添加） */
  grant: (id: string, username: string) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}/grant`, {
      method: "POST",
      body: JSON.stringify({ username }),
    }),
  /** 收回 */
  revoke: (id: string, username: string) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ username }),
    }),
}

// ---- AI实验室 ----


export interface PoolLedgerEntry {
  id: string
  delta: number
  balanceAfter: number
  kind: string
  username: string | null
  ref: string | null
  note: string | null
  createdAt: string
}
