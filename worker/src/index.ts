import { ApiError, json } from "./http"
import { getSessionTokens, clearedSessionCookie } from "./auth"
import type { Env } from "./env"
import * as authHandlers from "./handlers/auth"
import * as stickerHandlers from "./handlers/stickers"
import * as adminHandlers from "./handlers/admin"
import * as adminUsersStatusHandlers from "./handlers/admin-users-status"
import * as adminPermHandlers from "./handlers/admin-perms"
import * as noticeHandlers from "./handlers/notices"
import * as settingsHandlers from "./handlers/settings"
import * as voucherHandlers from "./handlers/vouchers"
import * as groupSyncHandlers from "./handlers/group-sync"
import * as myInviteHandlers from "./handlers/my-invites"
import * as identityHandlers from "./handlers/identity"
import * as cfQuotaHandlers from "./handlers/cf-quota"
import * as announcementHandlers from "./handlers/announcements"
import * as titleHandlers from "./handlers/titles"
import * as achievementHandlers from "./handlers/achievements"
import * as memberLevelHandlers from "./handlers/member-level"
import * as leaderboardHandlers from "./handlers/leaderboard"
import * as communityHandlers from "./handlers/community"
import * as spaceHandlers from "./handlers/space"
import * as analyticsHandlers from "./handlers/analytics"
import * as auditHandlers from "./handlers/audit"
import * as chatHandlers from "./handlers/chat"
import * as dmHandlers from "./handlers/dm"
import * as oauthHandlers from "./handlers/oauth"
import * as oauthPointsHandlers from "./handlers/oauth-points"
import * as feedbackHandlers from "./handlers/feedback"
import * as diagLogHandlers from "./handlers/diag-logs"
import * as perfHandlers from "./handlers/perf"
import * as chatUploadHandlers from "./handlers/chat-upload"
import * as twoFactorHandlers from "./handlers/two-factor"
import * as login2faHandlers from "./handlers/login-2fa"
import * as checkinHandlers from "./handlers/checkin"
import { stripInternalHeaders } from "./api-source"
import * as eventHandlers from "./handlers/events"
import * as moderationHandlers from "./handlers/moderation"
import * as moderationListHandlers from "./handlers/moderation-lists"
import * as pointHandlers from "./handlers/points"
import * as dbBackupHandlers from "./handlers/db-backup"
import * as attentionHandlers from "./handlers/attention"
// 造物典藏（游戏大厅）：插件清单 + 「在线投资」玩家侧 / 管理端接口
// 行情推进要在每分钟的 cron 里兜底跑一次（「没人在线时 K 线也在走」的保证）
import { runMaintenance } from "./maintenance"
import { processScheduledPublishes } from "./scheduled-publish"
import { retryPendingQuotaClaims } from "./event-rewards"
import { scanRiskAccounts } from "./risk-scan"

/**
 * 「到点发布」专用的 cron 表达式（每分钟）。必须与 wrangler.toml 的 [triggers] crons 一致 ——
 * scheduled 处理器靠它区分「每小时的完整运维」和「每分钟的发布 tick」。
 */
const SCHEDULED_PUBLISH_CRON = "* * * * *"

export interface WorkerContext {
  env: Env
  request: Request
}

/**
 * 路由表：一个条目 = 一条接口。
 *
 * 顺序即匹配优先级，跟原来 if-chain 的书写顺序一一对应 —— 冲突的路径
 * （如 /community/posts/<id>/comments 必须排在 /community/posts/<id> 前）靠顺序保证。
 * 新接口追加到对应分组末尾即可，不用再在 800 行的 if-chain 里找位置。
 *
 * 表由 buildRoutes() 返回，因为闭包要捕获 env / request / ctx。
 */
type Handler<T> = (m: T) => Response | Promise<Response>

type RouteRule =
  | { kind: "exact"; path: string; method: string; handle: Handler<void> }
  | {
      kind: "regex"
      match: (p: string) => RegExpMatchArray | null
      methods: string[]
      handle: Handler<RegExpMatchArray>
    }
  | {
      kind: "branch"
      match: (p: string) => RegExpMatchArray | null
      handle: (m: RegExpMatchArray, method: string) => Response | Promise<Response> | null
    }

function buildRoutes(env: Env, request: Request, ctx?: ExecutionContext): RouteRule[] {
  return [
  {
    kind: "exact",
    path: "/register",
    method: "POST",
    handle: () =>
      authHandlers.register(env, request),
  },

  {
    kind: "exact",
    path: "/register-status",
    method: "GET",
    handle: () =>
      authHandlers.registerStatus(env),
  },

  {
    kind: "exact",
    path: "/login",
    method: "POST",
    handle: () =>
      authHandlers.login(env, request),
  },

  // ---- 登录第二步：二次验证（2FA）----
  // 口令通过后若该账号要求 2FA，/login 会返回 challengeId 而不下发 session，
  // 前端拿着它来这两个接口完成验证。
  {
    kind: "exact",
    path: "/login/2fa",
    method: "POST",
    handle: () => login2faHandlers.verifyLoginTwoFactor(env, request),
  },
  {
    kind: "exact",
    path: "/login/2fa/send-email",
    method: "POST",
    handle: () => login2faHandlers.sendLoginTwoFactorEmail(env, request),
  },

  {
    kind: "exact",
    path: "/logout",
    method: "POST",
    handle: () =>
      authHandlers.logout(env, request),
  },

  {
    kind: "exact",
    path: "/me",
    method: "GET",
    handle: () =>
      authHandlers.me(env, request, ctx),
  },

  {
    kind: "exact",
    path: "/password",
    method: "PUT",
    handle: () =>
      authHandlers.changePassword(env, request),
  },

  {
    kind: "exact",
    path: "/password/forgot",
    method: "POST",
    handle: () =>
      authHandlers.forgotPassword(env, request),
  },

  {
    kind: "exact",
    path: "/password/reset",
    method: "POST",
    handle: () =>
      authHandlers.resetPassword(env, request),
  },

  {
    kind: "exact",
    path: "/settings/email",
    method: "GET",
    handle: () =>
      settingsHandlers.getEmailSettings(env, request),
  },

  {
    kind: "exact",
    path: "/downloads",
    method: "GET",
    handle: () =>
      settingsHandlers.publicDownloads(env, request),
  },

  {
    kind: "exact",
    path: "/settings/email/verify",
    method: "POST",
    handle: () =>
      settingsHandlers.verifyRealEmail(env, request),
  },

  // ---- 二次认证（2FA）自助管理 ----
  {
    kind: "exact",
    path: "/settings/2fa",
    method: "GET",
    handle: () => twoFactorHandlers.getTwoFactorSettings(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/totp/start",
    method: "POST",
    handle: () => twoFactorHandlers.startTotpSetup(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/totp/confirm",
    method: "POST",
    handle: () => twoFactorHandlers.confirmTotpSetup(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/totp/disable",
    method: "POST",
    handle: () => twoFactorHandlers.disableTotp(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/email",
    method: "POST",
    handle: () => twoFactorHandlers.setEmailTwoFactor(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/recovery/regenerate",
    method: "POST",
    handle: () => twoFactorHandlers.regenerateRecoveryCodes(env, request),
  },
  // 已登录状态下的「二次验证码」发送入口（2026-10-10：改动 2FA 设置时要重新认证）
  {
    kind: "exact",
    path: "/settings/2fa/step-up/send",
    method: "POST",
    handle: () => twoFactorHandlers.sendTwoFactorStepUpCode(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/disable",
    method: "POST",
    handle: () => twoFactorHandlers.disableTwoFactor(env, request),
  },
  // 站长的最后一道保险：给丢了手机的人拆掉这道锁
  {
    kind: "exact",
    path: "/admin/2fa/reset",
    method: "POST",
    handle: () => twoFactorHandlers.adminResetTwoFactor(env, request),
  },

  {
    kind: "exact",
    path: "/settings/email",
    method: "PUT",
    handle: () =>
      settingsHandlers.changeRealEmail(env, request),
  },

  {
    kind: "exact",
    path: "/settings/notify",
    method: "PUT",
    handle: () =>
      settingsHandlers.updateNotifySetting(env, request),
  },

  {
    kind: "exact",
    path: "/settings/username",
    method: "PUT",
    handle: () =>
      settingsHandlers.changeUsername(env, request),
  },

  {
    kind: "exact",
    path: "/settings/account/delete-code",
    method: "POST",
    handle: () =>
      settingsHandlers.requestDeleteCode(env, request),
  },

  {
    kind: "exact",
    path: "/settings/account/delete",
    method: "POST",
    handle: () =>
      settingsHandlers.deleteOwnAccount(env, request),
  },

  {
    kind: "exact",
    path: "/settings/nickname",
    method: "PUT",
    handle: () =>
      identityHandlers.updateNickname(env, request),
  },

  {
    kind: "exact",
    path: "/settings/avatar",
    method: "POST",
    handle: () =>
      identityHandlers.uploadAvatar(env, request),
  },

  {
    kind: "exact",
    path: "/settings/avatar",
    method: "DELETE",
    handle: () =>
      identityHandlers.deleteAvatar(env, request),
  },

  {
    kind: "exact",
    path: "/admin/users",
    method: "GET",
    handle: () =>
      adminHandlers.listUsers(env, request),
  },

  // 用户列表批量封禁 / 解封（勾选多行 → 批量操作；复用单人封禁的全部联动）。
  // ⚠️ 固定路径必须排在下面的 `/admin/users/:username` 正则之前，否则会被当成 username。
  {
    kind: "exact",
    path: "/admin/users/bulk-status",
    method: "POST",
    handle: () => adminUsersStatusHandlers.bulkSetUserStatus(env, request),
  },

  // 用户「最近活动」分页（支持查看更多 / 懒加载）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/activity$/),
    methods: ["GET"],
    handle: (adminUserActivityMatch: RegExpMatchArray) =>
      adminHandlers.getUserActivity(env, request, decodeURIComponent(adminUserActivityMatch[1])),
  },

  // ---- 管理员权限系统：权限树 / 权限组 / 成员管理权限 ----
  {
    kind: "exact",
    path: "/admin/permissions/tree",
    method: "GET",
    handle: () => adminPermHandlers.getPermissionTree(env, request),
  },
  {
    kind: "exact",
    path: "/admin/permission-groups",
    method: "GET",
    handle: () => adminPermHandlers.listPermissionGroups(env, request),
  },
  {
    kind: "exact",
    path: "/admin/permission-groups",
    method: "POST",
    handle: () => adminPermHandlers.createPermissionGroup(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/permission-groups\/([^/]+)\/members$/),
    methods: ["POST"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.addGroupMembers(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/permission-groups\/([^/]+)$/),
    methods: ["PUT"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.updatePermissionGroup(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/permission-groups\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.deletePermissionGroup(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/admin-permissions$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.getUserAdminPermissions(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/admin-permissions$/),
    methods: ["PUT"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.setUserAdminPermissions(env, request, decodeURIComponent(m[1])),
  },

  // ---- 账号监管：封禁申诉 + 风险账户 ----
  // 申诉提交是**公开**接口：被封禁用户登录会被 403，拿不到会话
  {
    kind: "exact",
    path: "/appeal",
    method: "POST",
    handle: () => moderationHandlers.submitAppeal(env, request),
  },
  // 用户端：申诉回复的已读确认（需登录态）
  {
    kind: "exact",
    path: "/appeal/pending-reply",
    method: "GET",
    handle: () => moderationHandlers.getPendingAppealReply(env, request),
  },
  {
    kind: "exact",
    path: "/appeal/acknowledge",
    method: "POST",
    handle: () => moderationHandlers.acknowledgeAppealNote(env, request),
  },
  {
    kind: "exact",
    path: "/notice/pending",
    method: "GET",
    handle: () => noticeHandlers.pendingNotices(env, request),
  },
  {
    kind: "exact",
    path: "/notice/ack",
    method: "POST",
    handle: () => noticeHandlers.ackNotice(env, request),
  },
  {
    kind: "exact",
    path: "/admin/notices",
    method: "GET",
    handle: () => noticeHandlers.listNotices(env, request),
  },
  {
    kind: "exact",
    path: "/admin/notices",
    method: "POST",
    handle: () => noticeHandlers.sendNotice(env, request),
  },
  {
    kind: "exact",
    path: "/admin/notices/revoke",
    method: "POST",
    handle: () => noticeHandlers.revokeNotice(env, request),
  },
  {
    kind: "exact",
    path: "/admin/appeals",
    method: "GET",
    handle: () => moderationHandlers.listAppeals(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/appeals\/([^/]+)\/review$/),
    methods: ["POST"],
    handle: (appealMatch: RegExpMatchArray) =>
      moderationHandlers.reviewAppeal(env, request, decodeURIComponent(appealMatch[1])),
  },
  {
    kind: "exact",
    path: "/admin/risk-accounts",
    method: "GET",
    handle: () => moderationHandlers.listRiskAccounts(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/risk-accounts\/([^/]+)\/status$/),
    methods: ["POST"],
    handle: (riskMatch: RegExpMatchArray) =>
      moderationHandlers.updateRiskStatus(env, request, decodeURIComponent(riskMatch[1])),
  },

  // 监管：白名单 / 自动条件 / 黑名单（2026-10-03）
  {
    kind: "exact",
    path: "/admin/moderation/lists",
    method: "GET",
    handle: () => moderationListHandlers.listModerationLists(env, request),
  },
  {
    kind: "exact",
    path: "/admin/moderation/whitelist",
    method: "POST",
    handle: () => moderationListHandlers.updateWhitelist(env, request),
  },
  {
    kind: "exact",
    path: "/admin/moderation/conditions",
    method: "POST",
    handle: () => moderationListHandlers.updateConditions(env, request),
  },
  {
    kind: "exact",
    path: "/admin/moderation/blacklist",
    method: "POST",
    handle: () => moderationListHandlers.updateBlacklist(env, request),
  },
  // IP 监管：查出被多个不同（未封禁）账号共用的登录 IP
  {
    kind: "exact",
    path: "/admin/moderation/ip-watch",
    method: "GET",
    handle: () => moderationListHandlers.getIpWatch(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)$/),
    methods: ["GET"],
    handle: (adminUserMatch: RegExpMatchArray) =>
      adminHandlers.getUser(env, request, decodeURIComponent(adminUserMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminUserMatch: RegExpMatchArray) =>
      adminHandlers.updateUser(env, request, decodeURIComponent(adminUserMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminUserMatch: RegExpMatchArray) =>
      adminHandlers.deleteUser(env, request, decodeURIComponent(adminUserMatch[1])),
  },

  // 管理员为用户重置密码（rootOnly：users.password）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/password$/),
    methods: ["POST"],
    handle: (adminUserPwMatch: RegExpMatchArray) =>
      adminHandlers.setUserPassword(env, request, decodeURIComponent(adminUserPwMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/messages\/([^/]+)$/),
    methods: ["GET"],
    handle: (adminMessageMatch: RegExpMatchArray) =>
      adminHandlers.getUserMessage(
      env,
      request,
      decodeURIComponent(adminMessageMatch[1]),
      decodeURIComponent(adminMessageMatch[2])
      ),
  },

  {
    kind: "exact",
    path: "/admin/invites",
    method: "GET",
    handle: () =>
      adminHandlers.listInvites(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/invites\/([^/]+)\/trace$/),
    methods: ["GET"],
    handle: (adminInviteTraceMatch: RegExpMatchArray) =>
      adminHandlers.traceInvite(env, request, decodeURIComponent(adminInviteTraceMatch[1])),
  },

  {
    kind: "exact",
    path: "/admin/invites",
    method: "POST",
    handle: () =>
      adminHandlers.createInvite(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/invites\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminInviteMatch: RegExpMatchArray) =>
      adminHandlers.updateInvite(env, request, decodeURIComponent(adminInviteMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/invites\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminInviteMatch: RegExpMatchArray) =>
      
      
      adminHandlers.adminDeleteInviteWithRefund(
      env,
      request,
      decodeURIComponent(adminInviteMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/my-invites",
    method: "GET",
    handle: () =>
      myInviteHandlers.listMyInvites(env, request),
  },

  {
    kind: "exact",
    path: "/my-invites",
    method: "POST",
    handle: () =>
      myInviteHandlers.createMyInvite(env, request),
  },

  // 补填邀请码（用户反馈 3ed5d0b0）—— 必须排在 /my-invites/:id 之前
  {
    kind: "exact",
    path: "/my-invites/claim",
    method: "POST",
    handle: () =>
      myInviteHandlers.claimMyInvite(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/my-invites\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (myInviteMatch: RegExpMatchArray) =>
      myInviteHandlers.deleteMyInvite(
      env,
      request,
      decodeURIComponent(myInviteMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/invite-quotas",
    method: "GET",
    handle: () =>
      adminHandlers.listInviteQuotas(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(
    /^\/admin\/users\/([^/]+)\/invite-quota$/
  ),
    methods: ["GET"],
    handle: (quotaUserMatch: RegExpMatchArray) =>
      adminHandlers.getUserInviteQuota(
      env,
      request,
      decodeURIComponent(quotaUserMatch[1])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(
    /^\/admin\/users\/([^/]+)\/invite-quota$/
  ),
    methods: ["PUT"],
    handle: (quotaUserMatch: RegExpMatchArray) =>
      adminHandlers.updateUserInviteQuota(
      env,
      request,
      decodeURIComponent(quotaUserMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/mail-test",
    method: "POST",
    handle: () =>
      adminHandlers.testMail(env, request),
  },

  {
    kind: "exact",
    path: "/analytics/track",
    method: "POST",
    handle: () =>
      analyticsHandlers.track(env, request),
  },
  {
    kind: "exact",
    path: "/admin/analytics",
    method: "GET",
    handle: () =>
      analyticsHandlers.overview(env, request),
  },

  {
    kind: "exact",
    path: "/admin/analytics/users",
    method: "GET",
    handle: () =>
      analyticsHandlers.userOverview(env, request),
  },

  {
    kind: "exact",
    path: "/admin/audit",
    method: "GET",
    handle: () =>
      auditHandlers.listAudit(env, request),
  },

  {
    kind: "exact",
    path: "/admin/mail-status",
    method: "GET",
    handle: () =>
      adminHandlers.mailStatus(env, request),
  },

  {
    kind: "exact",
    path: "/admin/mail/brevo-quota",
    method: "GET",
    handle: () =>
      adminHandlers.getBrevoQuota(env, request),
  },

  {
    kind: "exact",
    path: "/announcements",
    method: "GET",
    handle: () =>
      announcementHandlers.listAnnouncements(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/announcements\/([^/]+)\/dismiss$/),
    methods: ["POST"],
    handle: (announcementMatch: RegExpMatchArray) =>
      announcementHandlers.dismissAnnouncement(
        env,
        request,
        decodeURIComponent(announcementMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/achievements",
    method: "GET",
    handle: () =>
      achievementHandlers.getAchievements(env, request),
  },

  // 排行榜：?board=newapi|community|feedback|achievement（community 再带 ?metric=posts|likes|comments）
  {
    kind: "exact",
    path: "/leaderboard",
    method: "GET",
    handle: () =>
      leaderboardHandlers.getLeaderboard(env, request),
  },

  // ---- 个人空间（公开主页）----
  //
  // ⚠️ 顺序有意义：`/space/<用户名>/card` 必须排在 `/space/<用户名>` 之前，
  // 否则 `card` 会被当成用户名（路由表是按数组顺序匹配的）。
  //
  // 这两个读接口**无需登录**：空间页是给人分享的（社区里点头像就进得来）。
  // 访客能看什么由服务端裁切：帖子看「允许访客访问社区」开关，
  // 捐献详情一律打码（见 handlers/space.ts 的隐私说明）。
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/space\/([^/]+)\/card$/),
    // branch 里必须自己判 method，未命中要返回 null（否则会把其它方法吞掉）
    handle: (spaceCardMatch: RegExpMatchArray, method: string) =>
      method === "GET"
        ? spaceHandlers.getSpaceCard(env, request, decodeURIComponent(spaceCardMatch[1]))
        : null,
  },
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/space\/([^/]+)$/),
    handle: (spaceMatch: RegExpMatchArray, method: string) =>
      method === "GET"
        ? spaceHandlers.getSpace(env, request, decodeURIComponent(spaceMatch[1]))
        : null,
  },
  // 我自己的展示设置（要登录）
  {
    kind: "exact",
    path: "/my-space",
    method: "GET",
    handle: () => spaceHandlers.getMySpace(env, request),
  },
  {
    kind: "exact",
    path: "/my-space",
    method: "PUT",
    handle: () => spaceHandlers.updateMySpace(env, request),
  },

  {
    kind: "exact",
    path: "/admin/announcements",
    method: "GET",
    handle: () =>
      announcementHandlers.listAllAnnouncements(env, request),
  },

  {
    kind: "exact",
    path: "/admin/announcements",
    method: "POST",
    handle: () =>
      announcementHandlers.createAnnouncement(env, request, ctx),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/announcements\/([^/]+)\/resend$/),
    methods: ["POST"],
    handle: (announcementResendMatch: RegExpMatchArray) =>
      announcementHandlers.resendAnnouncementMails(
        env,
        request,
        decodeURIComponent(announcementResendMatch[1]),
        ctx
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/announcements\/([^/]+)$/),
    methods: ["PUT"],
    handle: (announcementMatch: RegExpMatchArray) =>
      announcementHandlers.updateAnnouncement(
      env,
      request,
      decodeURIComponent(announcementMatch[1]),
      ctx
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/announcements\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (announcementMatch: RegExpMatchArray) =>
      announcementHandlers.deleteAnnouncement(
      env,
      request,
      decodeURIComponent(announcementMatch[1])
      ),
  },

  // ---- 自定义称号（徽章式，管理面板维护 + 授予指定用户）----
  {
    kind: "exact",
    path: "/admin/titles",
    method: "GET",
    handle: () => titleHandlers.listTitles(env, request),
  },

  {
    kind: "exact",
    path: "/admin/titles",
    method: "POST",
    handle: () => titleHandlers.createTitle(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)$/),
    methods: ["PUT"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.updateTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.deleteTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)\/grant$/),
    methods: ["POST"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.grantTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)\/revoke$/),
    methods: ["POST"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.revokeTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  // ---- 用户反馈（私有工单；管理端回复）----
  {
    kind: "exact",
    path: "/admin/feedback",
    method: "GET",
    handle: () =>
      feedbackHandlers.listAllFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/admin/feedback/reply",
    method: "POST",
    handle: () =>
      feedbackHandlers.replyFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/admin/feedback/status",
    method: "POST",
    handle: () =>
      feedbackHandlers.setFeedbackStatus(env, request),
  },

  {
    kind: "exact",
    path: "/admin/feedback/delete",
    method: "POST",
    handle: () =>
      feedbackHandlers.deleteFeedback(env, request),
  },

  // 单条反馈详情（2026-10-10 列表瘦身配套：列表只给摘要，点开再拉全量）
  {
    kind: "exact",
    path: "/admin/feedback/detail",
    method: "GET",
    handle: () =>
      feedbackHandlers.feedbackDetail(env, request),
  },

  // ---- 诊断日志（反馈附带的前端运行记录）----
  {
    kind: "exact",
    path: "/diag-logs",
    method: "POST",
    handle: () =>
      diagLogHandlers.uploadDiagLog(env, request),
  },

  // ---- 前端性能样本（RUM）----
  // /perf/collect 用 sendBeacon 上报（POST，无响应感知）；管理聚合在 /admin/perf/*
  {
    kind: "exact",
    path: "/perf/collect",
    method: "POST",
    handle: () =>
      perfHandlers.collect(env, request),
  },

  {
    kind: "exact",
    path: "/admin/perf/overview",
    method: "GET",
    handle: () =>
      perfHandlers.overview(env, request),
  },

  {
    kind: "exact",
    path: "/admin/perf/samples",
    method: "GET",
    handle: () =>
      perfHandlers.pageSamples(env, request),
  },

  {
    kind: "exact",
    path: "/admin/settings",
    method: "GET",
    handle: () =>
      adminHandlers.getSettingsHandler(env, request),
  },

  {
    kind: "exact",
    path: "/admin/settings",
    method: "PUT",
    handle: () =>
      adminHandlers.updateSettingsHandler(env, request),
  },

  {
    kind: "exact",
    path: "/admin/community/posts",
    method: "GET",
    handle: () =>
      adminHandlers.adminListPosts(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/community\/posts\/([^/]+)\/restore$/),
    methods: ["POST"],
    handle: (adminCommunityRestoreMatch: RegExpMatchArray) =>
      adminHandlers.adminRestorePost(env, request, decodeURIComponent(adminCommunityRestoreMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/community\/posts\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminCommunityPostMatch: RegExpMatchArray) =>
      adminHandlers.adminDeletePost(env, request, decodeURIComponent(adminCommunityPostMatch[1])),
  },

  // ---- 用户反馈（私有工单）----
  // /feedback/read 必须排在下面 /feedback 的 POST 之前：两者路径不同（前者多一段），
  // 但保持「更具体的在前」这条约定，免得以后加 /feedback/:id 时顺序被搞混。
  {
    kind: "exact",
    path: "/feedback/read",
    method: "POST",
    handle: () =>
      feedbackHandlers.markFeedbackRead(env, request),
  },

  {
    kind: "exact",
    path: "/feedback/upload-image",
    method: "POST",
    handle: () =>
      feedbackHandlers.uploadFeedbackImage(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/feedback\/image\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) =>
      feedbackHandlers.serveFeedbackImage(
        env,
        request,
        decodeURIComponent(m[1]),
        decodeURIComponent(m[2])
      ),
  },

  // ---- 聊天图片（私聊 / 聊天室 / 广场帖子与评论共用）----
  // 与反馈图片分开：反馈图是私有工单附件（只有本人+管理员能看），
  // 聊天图要能被会话双方看到，鉴权口径不同。详见 handlers/chat-upload.ts 头部说明。
  {
    kind: "exact",
    path: "/chat/upload-image",
    method: "POST",
    handle: () => chatUploadHandlers.uploadChatImage(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/image\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) =>
      chatUploadHandlers.serveChatImage(
        env,
        request,
        decodeURIComponent(m[1]),
        decodeURIComponent(m[2])
      ),
  },

  {
    kind: "exact",
    path: "/feedback/reply",
    method: "POST",
    handle: () =>
      feedbackHandlers.replyMyFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/feedback",
    method: "GET",
    handle: () =>
      feedbackHandlers.listMyFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/feedback",
    method: "POST",
    handle: () =>
      feedbackHandlers.createFeedback(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/feedback\/([0-9a-f-]{36})$/),
    methods: ["PATCH"],
    handle: (m: RegExpMatchArray) =>
      feedbackHandlers.editMyFeedback(env, request, m[1]),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/feedback\/([0-9a-f-]{36})$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) =>
      feedbackHandlers.withdrawMyFeedback(env, request, m[1]),
  },

  // ---- 权限兑换码（首捐奖励券 / 用邀请码补权限）----
  {
    kind: "exact",
    path: "/vouchers",
    method: "GET",
    handle: () =>
      voucherHandlers.listMyVouchers(env, request),
  },

  {
    kind: "exact",
    path: "/vouchers/redeem",
    method: "POST",
    handle: () =>
      voucherHandlers.redeem(env, request),
  },

  // 给「分组同步服务」用的只读映射（X-Sync-Key 认证；见 handlers/group-sync.ts 的说明）
  {
    kind: "exact",
    path: "/internal/group-map",
    method: "GET",
    handle: () => groupSyncHandlers.groupMap(env, request),
  },
  {
    kind: "exact",
    path: "/community/config",
    method: "GET",
    handle: () =>
      communityHandlers.communityConfig(env, request),
  },
  {
    kind: "exact",
    path: "/community/new-posts-count",
    method: "GET",
    handle: () =>
      communityHandlers.newPostsCount(env, request),
  },
  // 链接预览卡片（markdown.tsx 的 LinkCard 会调）。
  //
  // ⚠️ 2026-09-25 审计（F4）：handler 早就写好了、还带 M9 的限流，
  // 但**路由一直没接** —— 前端调用固定 404，被 `.catch` 吞掉后回退成普通链接，
  // 表现为「链接卡片功能做了但从来不出卡片」，且没有任何报错提示。
  // index.ts 之前被另一个 AI 占用，所以只记在 check-api-paths.mjs 的 KNOWN_GAPS 里。
  {
    kind: "exact",
    path: "/community/link-preview",
    method: "GET",
    handle: () =>
      communityHandlers.linkPreview(env, request),
  },
  // 标记「我刚打开过社区」，用于把新帖角标清零
  {
    kind: "exact",
    path: "/community/seen",
    method: "POST",
    handle: () =>
      communityHandlers.markCommunitySeen(env, request),
  },
  // 角标汇总：侧边栏（社区/聊天室/反馈/管理）与管理面板各栏目共用一次请求
  {
    kind: "exact",
    path: "/attention",
    method: "GET",
    handle: () => attentionHandlers.getAttention(env, request),
  },

  // ---- 公共聊天室 ----
  {
    kind: "exact",
    path: "/chat/messages",
    method: "GET",
    handle: () =>
      chatHandlers.listMessages(env, request),
  },
  {
    kind: "exact",
    path: "/chat/messages",
    method: "POST",
    handle: () =>
      chatHandlers.sendMessage(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/messages\/([^/]+)\/recall$/),
    methods: ["POST"],
    handle: (chatRecallMatch: RegExpMatchArray) =>
      chatHandlers.recallMessage(env, request, decodeURIComponent(chatRecallMatch[1])),
  },
  {
    // 表情回应开关（toggle）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/messages\/([^/]+)\/reactions$/),
    methods: ["POST"],
    handle: (chatReactMatch: RegExpMatchArray) =>
      chatHandlers.toggleReaction(env, request, decodeURIComponent(chatReactMatch[1])),
  },
  {
    // 编辑自己的消息（10 分钟内）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/messages\/([^/]+)\/edit$/),
    methods: ["POST"],
    handle: (chatEditMatch: RegExpMatchArray) =>
      chatHandlers.editMessage(env, request, decodeURIComponent(chatEditMatch[1])),
  },
  {
    kind: "exact",
    path: "/chat/heartbeat",
    method: "POST",
    handle: () =>
      chatHandlers.heartbeat(env, request),
  },
  {
    kind: "exact",
    path: "/chat/presence",
    method: "GET",
    handle: () =>
      chatHandlers.presence(env, request),
  },
  // 侧边栏「聊天室」角标：我看过之后的新消息数
  {
    kind: "exact",
    path: "/chat/unread",
    method: "GET",
    handle: () =>
      chatHandlers.unreadCount(env, request),
  },
  // 标记「我刚打开过聊天室」，用于把新消息角标清零
  {
    kind: "exact",
    path: "/chat/seen",
    method: "POST",
    handle: () =>
      chatHandlers.markChatSeen(env, request),
  },
  // 「正在输入」心跳（前端 5 秒节流上报，消息轮询顺带下发）
  {
    kind: "exact",
    path: "/chat/typing",
    method: "POST",
    handle: () =>
      chatHandlers.typing(env, request),
  },

  // ---- 一对一私信（2026-10-01）----
  {
    kind: "exact",
    path: "/dm/conversations",
    method: "GET",
    handle: () => dmHandlers.listConversations(env, request),
  },
  {
    kind: "exact",
    path: "/dm/unread",
    method: "GET",
    handle: () => dmHandlers.dmUnreadCount(env, request),
  },
  {
    // 我收到的待处理聊天申请（2026-10-01）
    kind: "exact",
    path: "/dm/requests",
    method: "GET",
    handle: () => dmHandlers.listDmRequests(env, request),
  },
  {
    // 同意 / 拒绝聊天申请
    kind: "exact",
    path: "/dm/requests",
    method: "POST",
    handle: () => dmHandlers.respondDmRequest(env, request),
  },
  {
    kind: "exact",
    path: "/dm/seen",
    method: "POST",
    handle: () => dmHandlers.markDmSeen(env, request),
  },
  {
    kind: "exact",
    path: "/dm",
    method: "GET",
    handle: () => dmHandlers.listDm(env, request),
  },
  {
    kind: "exact",
    path: "/dm",
    method: "POST",
    handle: () => dmHandlers.sendDm(env, request),
  },
  {
    // 撤回私信（与 /chat/messages/:id/recall 同构）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dm\/messages\/([^/]+)\/recall$/),
    methods: ["POST"],
    handle: (dmRecallMatch: RegExpMatchArray) =>
      dmHandlers.recallDm(env, request, decodeURIComponent(dmRecallMatch[1])),
  },
  {
    // 表情回应开关（toggle）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dm\/messages\/([^/]+)\/reactions$/),
    methods: ["POST"],
    handle: (dmReactMatch: RegExpMatchArray) =>
      dmHandlers.toggleReactionDm(env, request, decodeURIComponent(dmReactMatch[1])),
  },
  {
    // 编辑自己的私信（10 分钟内）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dm\/messages\/([^/]+)\/edit$/),
    methods: ["POST"],
    handle: (dmEditMatch: RegExpMatchArray) =>
      dmHandlers.editDm(env, request, decodeURIComponent(dmEditMatch[1])),
  },
  {
    // 「我正在给对端打字」心跳（5 秒节流上报，listDm 顺带下发 peerTyping）
    kind: "exact",
    path: "/dm/typing",
    method: "POST",
    handle: () => dmHandlers.typingDm(env, request),
  },

  // ---- 用户表情包（社区/私信编辑器里快捷发送）----
  {
    kind: "exact",
    path: "/stickers",
    method: "GET",
    handle: () => stickerHandlers.listStickers(env, request),
  },

  {
    kind: "exact",
    path: "/stickers",
    method: "POST",
    handle: () => stickerHandlers.uploadSticker(env, request),
  },

  {
    kind: "exact",
    path: "/stickers/save",
    method: "POST",
    handle: () => stickerHandlers.saveSticker(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/stickers\/([0-9a-f-]{36})\/image$/),
    methods: ["GET"],
    handle: (stickerImgMatch: RegExpMatchArray) =>
      stickerHandlers.serveSticker(env, request, stickerImgMatch[1]),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/stickers\/([0-9a-f-]{36})$/),
    methods: ["DELETE"],
    handle: (stickerMatch: RegExpMatchArray) =>
      stickerHandlers.deleteSticker(env, request, stickerMatch[1]),
  },

  {
    kind: "exact",
    path: "/community/posts",
    method: "GET",
    handle: () =>
      communityHandlers.listPosts(env, request),
  },

  {
    kind: "exact",
    path: "/community/stats",
    method: "GET",
    handle: () =>
      communityHandlers.communityStats(env, request, ctx),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/comments$/),
    methods: ["GET"],
    handle: (communityCommentsMatch: RegExpMatchArray) =>
      communityHandlers.listComments(env, request, decodeURIComponent(communityCommentsMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)$/),
    methods: ["GET"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.getPost(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "exact",
    path: "/community/posts",
    method: "POST",
    handle: () =>
      communityHandlers.createPost(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/like$/),
    methods: ["POST"],
    handle: (communityLikeMatch: RegExpMatchArray) =>
      communityHandlers.toggleLike(env, request, decodeURIComponent(communityLikeMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/comments\/([^/]+)\/like$/),
    methods: ["POST"],
    handle: (communityCommentLikeMatch: RegExpMatchArray) =>
      communityHandlers.toggleCommentLike(env, request, decodeURIComponent(communityCommentLikeMatch[1])),
  },

  {
    // 编辑自己的评论（2026-10-17）：次数上限由设置 community_comment_edit_limit 控制
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/comments\/([^/]+)$/),
    methods: ["PUT"],
    handle: (communityCommentMatch: RegExpMatchArray) =>
      communityHandlers.updateComment(env, request, decodeURIComponent(communityCommentMatch[1])),
  },

  {
    // 删除评论（2026-10-17）：作者或管理员，软删 + 清空正文，列表保留占位
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/comments\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (communityCommentMatch: RegExpMatchArray) =>
      communityHandlers.deleteComment(env, request, decodeURIComponent(communityCommentMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/share$/),
    methods: ["POST"],
    handle: (communityShareMatch: RegExpMatchArray) =>
      communityHandlers.sharePost(env, request, decodeURIComponent(communityShareMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.deletePost(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)$/),
    methods: ["PUT"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.updatePost(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/edits$/),
    methods: ["GET"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.listPostEdits(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/comments$/),
    methods: ["POST"],
    handle: (communityCommentsMatch: RegExpMatchArray) =>
      communityHandlers.createComment(env, request, decodeURIComponent(communityCommentsMatch[1])),
  },

  {
    kind: "regex",
    // 管理员 / 站长置顶帖子（2026-10-01）
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/pin$/),
    methods: ["POST"],
    handle: (postPinMatch: RegExpMatchArray) =>
      communityHandlers.setPostPinned(env, request, decodeURIComponent(postPinMatch[1])),
  },
  {
    // 我持有的全部称号（个人空间里自己选展示哪一个；2026-10-01）
    kind: "exact",
    path: "/titles/mine",
    method: "GET",
    handle: () => titleHandlers.listMyTitles(env, request),
  },
  {
    // 设置对外展示的称号；titleId = null 表示一个都不展示
    kind: "exact",
    path: "/titles/display",
    method: "POST",
    handle: () => titleHandlers.setDisplayedTitle(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/images$/),
    methods: ["POST"],
    handle: (communityImageMatch: RegExpMatchArray) =>
      communityHandlers.uploadPostImage(env, request, decodeURIComponent(communityImageMatch[1])),
  },

  {
    // 编辑帖子时删除单张图片（含 R2 对象）。必须排在上面 POST /images 之前无所谓，
    // 方法不同不会冲突，但要在 /community/posts/:id 兜底 GET 之前。
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/images\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (communityImageDelMatch: RegExpMatchArray) =>
      communityHandlers.deletePostImage(
        env,
        request,
        decodeURIComponent(communityImageDelMatch[1]),
        decodeURIComponent(communityImageDelMatch[2])
      ),
  },

  {
    kind: "exact",
    path: "/notifications",
    method: "GET",
    handle: () =>
      communityHandlers.listNotifications(env, request),
  },

  {
    kind: "exact",
    path: "/notifications/unread-count",
    method: "GET",
    handle: () =>
      communityHandlers.unreadCount(env, request),
  },

  // 网页侧「零配置通知」用：只取最新一条未读（比拉整个列表轻）
  {
    kind: "exact",
    path: "/notifications/latest",
    method: "GET",
    handle: () =>
      communityHandlers.latestNotification(env, request),
  },

  {
    kind: "exact",
    path: "/notifications/read",
    method: "POST",
    handle: () =>
      communityHandlers.markRead(env, request),
  },

  // ---- 活动系统（消息中心「活动推广」）----
  {
    kind: "exact",
    path: "/events",
    method: "GET",
    handle: () => eventHandlers.listEvents(env, request),
  },
  // 历史投票：已结束的投票活动 + 结果（推广页的「历史投票」入口用它）。
  // ⚠️ 必须排在下面的 /events/:id（regex）之前 —— dispatch 按声明顺序取第一个命中，
  //    顺序反了这条会被当成 id = "vote-history"，直接 404。
  {
    kind: "exact",
    path: "/events/vote-history",
    method: "GET",
    handle: () => eventHandlers.listVoteHistory(env, request),
  },
  // 单个活动（公开）：活动分享链接 /activity/:id 用它拉数据
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/events\/([^/]+)$/),
    methods: ["GET"],
    handle: (eventGetMatch: RegExpMatchArray) =>
      eventHandlers.getEvent(env, request, decodeURIComponent(eventGetMatch[1])),
  },
  // 集合投票（问卷）交卷 —— ⚠️ 必须排在 /events/:id 之前
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/events\/([^/]+)\/quiz$/),
    methods: ["POST"],
    handle: (eventQuizMatch: RegExpMatchArray) =>
      eventHandlers.submitQuiz(env, request, decodeURIComponent(eventQuizMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/events\/([^/]+)\/claim$/),
    methods: ["POST"],
    handle: (eventClaimMatch: RegExpMatchArray) =>
      eventHandlers.claimEvent(env, request, decodeURIComponent(eventClaimMatch[1])),
  },
  {
    kind: "exact",
    path: "/admin/events",
    method: "GET",
    handle: () => eventHandlers.listAllEvents(env, request),
  },
  {
    kind: "exact",
    path: "/admin/events",
    method: "POST",
    handle: () => eventHandlers.createEvent(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)\/claims\/([^/]+)\/grant$/),
    methods: ["POST"],
    handle: (eventGrantMatch: RegExpMatchArray) =>
      eventHandlers.grantEventClaim(
        env,
        request,
        decodeURIComponent(eventGrantMatch[1]),
        decodeURIComponent(eventGrantMatch[2])
      ),
  },
  {
    // 同一个路径的 DELETE：删掉这条领取记录（误参与/测试数据）
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/admin\/events\/([^/]+)\/claims\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (eventClaimDelMatch: RegExpMatchArray) =>
      eventHandlers.deleteEventClaim(
        env,
        request,
        decodeURIComponent(eventClaimDelMatch[1]),
        decodeURIComponent(eventClaimDelMatch[2])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)\/claims$/),
    methods: ["GET"],
    handle: (eventClaimsMatch: RegExpMatchArray) =>
      eventHandlers.listEventClaims(env, request, decodeURIComponent(eventClaimsMatch[1])),
  },
  // 抽奖开奖（手动）：从报名者里随机抽人发积分；已开过奖会返回 409
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)\/draw$/),
    methods: ["POST"],
    handle: (eventDrawMatch: RegExpMatchArray) =>
      eventHandlers.adminDrawEvent(env, request, decodeURIComponent(eventDrawMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)$/),
    methods: ["PUT"],
    handle: (eventMatch: RegExpMatchArray) =>
      eventHandlers.updateEvent(env, request, decodeURIComponent(eventMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (eventMatch: RegExpMatchArray) =>
      eventHandlers.deleteEvent(env, request, decodeURIComponent(eventMatch[1])),
  },
  {
    // 投票选项配图上传（管理员）：返回可直接填进选项 image 字段的同源 URL
    kind: "exact",
    path: "/admin/events/image",
    method: "POST",
    handle: () => eventHandlers.uploadEventImage(env, request),
  },
  {
    // 选项配图公开读取。⚠️ 与 /shop-img/* 同理，必须挂在 /api 前缀下才会进 API Worker。
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/event-img\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (eventImgMatch: RegExpMatchArray) =>
      eventHandlers.serveEventImage(
        env,
        decodeURIComponent(eventImgMatch[1]),
        decodeURIComponent(eventImgMatch[2])
      ),
  },

  // ---- 积分系统（余额 / 流水 / 兑换中转站余额）----
  {
    kind: "exact",
    path: "/points",
    method: "GET",
    handle: () => pointHandlers.getPoints(env, request),
  },
  {
    kind: "exact",
    path: "/points/upgrade-level",
    method: "POST",
    handle: () => memberLevelHandlers.upgradeLevel(env, request),
  },

  {
    kind: "exact",
    path: "/points/redeem",
    method: "POST",
    handle: () => pointHandlers.redeem(env, request),
  },

  // ---- 每日签到 ----
  {
    kind: "exact",
    path: "/checkin",
    method: "GET",
    handle: () => checkinHandlers.getCheckinStatus(env, request),
  },
  {
    kind: "exact",
    path: "/checkin",
    method: "POST",
    handle: () => checkinHandlers.doCheckin(env, request),
  },
  {
    kind: "exact",
    path: "/checkin/makeup",
    method: "POST",
    handle: () => checkinHandlers.makeupCheckin(env, request),
  },
  {
    kind: "exact",
    path: "/checkin/auto",
    method: "POST",
    handle: () => checkinHandlers.setAutoCheckin(env, request),
  },
  {
    kind: "exact",
    path: "/checkin/history",
    method: "GET",
    handle: () => checkinHandlers.getCheckinHistory(env, request),
  },

  // ---- 公开 API（API Key 认证 + 限额）----
  // ---- 积分互通（OAuth access_token 认证，scope=points；应用服务端调用） ----
  {
    kind: "exact",
    path: "/v1/points/balance",
    method: "GET",
    handle: () => oauthPointsHandlers.pointsBalance(env, request),
  },
  {
    kind: "exact",
    path: "/v1/points/spend",
    method: "POST",
    handle: () => oauthPointsHandlers.pointsSpend(env, request),
  },

  // 用户间转账（只需转出方确认，凭用户名转给对方）
  {
    kind: "exact",
    path: "/points/transfer",
    method: "POST",
    handle: () => pointHandlers.transfer(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points",
    method: "GET",
    handle: () => pointHandlers.listPointsOverview(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/adjust",
    method: "POST",
    handle: () => pointHandlers.adjustPoints(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/([^/]+)\/history$/),
    methods: ["GET"],
    handle: (pointHistMatch: RegExpMatchArray) =>
      pointHandlers.userPointHistory(env, request, decodeURIComponent(pointHistMatch[1])),
  },

  // ---- 积分商城（商品 / 订单 / 兑换配置）----
  {
    kind: "exact",
    path: "/points/shop/buy",
    method: "POST",
    handle: () => pointHandlers.buyShopProduct(env, request),
  },

  // ---- 用户商城（用户自己上架 / 交付 / 确认收货）----
  {
    // 商品封面上传：返回可直接填进 imageUrl 的同源 URL（2026-10-01）
    kind: "exact",
    path: "/points/product/image",
    method: "POST",
    handle: () => pointHandlers.uploadProductImage(env, request),
  },
  {
    // 封面图公开读取。⚠️ 必须**挂在 /api 前缀下**：cloud.doulor.cn 只有 /api/*、
    // /c/*、/u/* 等 zone 路由会进 API Worker，自造新前缀（如 /shop-img/*）的请求
    // 根本到不了这里，会落到 SPA 的 index.html（2026-10-01 实测踩过）。
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/shop-img\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (shopImgMatch: RegExpMatchArray) =>
      pointHandlers.serveShopImage(
        env,
        decodeURIComponent(shopImgMatch[1]),
        decodeURIComponent(shopImgMatch[2])
      ),
  },
  {
    kind: "exact",
    path: "/points/products",
    method: "POST",
    handle: () => pointHandlers.createMyProduct(env, request),
  },
  {
    // 带方法分流必须用 branch：regex kind 的 handle 只收 1 个参数，拿不到 method
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/points\/products\/([^/]+)$/),
    handle: (myProductMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(myProductMatch[1])
      if (method === "PUT") return pointHandlers.updateMyProduct(env, request, id)
      if (method === "DELETE") return pointHandlers.deleteMyProduct(env, request, id)
      return null
    },
  },
  // 卖家自己的卡密池（用户商品 delivery='code'）：读概览 / 追加 / 清空未使用。
  // 所有权在 handler 里校验（只能动自己的商品）。
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/points\/products\/([^/]+)\/codes$/),
    handle: (myCodesMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(myCodesMatch[1])
      if (method === "GET") return pointHandlers.getMyProductCodes(env, request, id)
      if (method === "POST") return pointHandlers.addMyProductCodes(env, request, id)
      if (method === "DELETE") return pointHandlers.clearMyProductCodes(env, request, id)
      return null
    },
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/products\/([^/]+)\/purchases$/),
    methods: ["GET"],
    handle: (shopPurchasesMatch: RegExpMatchArray) =>
      pointHandlers.getProductPurchases(env, request, decodeURIComponent(shopPurchasesMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/deliver$/),
    methods: ["POST"],
    handle: (myOrderDeliverMatch: RegExpMatchArray) =>
      pointHandlers.sellerDeliver(env, request, decodeURIComponent(myOrderDeliverMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/confirm$/),
    methods: ["POST"],
    handle: (myOrderConfirmMatch: RegExpMatchArray) =>
      pointHandlers.confirmReceipt(env, request, decodeURIComponent(myOrderConfirmMatch[1])),
  },
  // 售后（退款）：买家申请 / 撤销
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/after-sale$/),
    handle: (afterSaleMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(afterSaleMatch[1])
      if (method === "POST") return pointHandlers.requestAfterSaleHandler(env, request, id)
      if (method === "DELETE") return pointHandlers.cancelAfterSaleHandler(env, request, id)
      return null
    },
  },
  // 售后：买家申请平台（管理员）介入
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/points\/orders\/([^/]+)\/after-sale\/escalate$/),
    methods: ["POST"],
    handle: (afterSaleEscalateMatch: RegExpMatchArray) =>
      pointHandlers.escalateAfterSaleHandler(
        env,
        request,
        decodeURIComponent(afterSaleEscalateMatch[1])
      ),
  },
  // 拒收：买家没收到货 / 货不对板 → 直达平台介入（不用先向卖家申请退款）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/reject$/),
    methods: ["POST"],
    handle: (rejectMatch: RegExpMatchArray) =>
      pointHandlers.rejectDeliveryHandler(env, request, decodeURIComponent(rejectMatch[1])),
  },
  // 售后：卖家处理（同意退款 / 拒绝）
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/points\/orders\/([^/]+)\/after-sale\/decide$/),
    methods: ["POST"],
    handle: (afterSaleDecideMatch: RegExpMatchArray) =>
      pointHandlers.sellerResolveAfterSaleHandler(
        env,
        request,
        decodeURIComponent(afterSaleDecideMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/points/shop",
    method: "GET",
    handle: () => pointHandlers.getShopAdmin(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/config",
    method: "PUT",
    handle: () => pointHandlers.savePointsConfig(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/products",
    method: "POST",
    handle: () => pointHandlers.createShopProduct(env, request),
  },
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/products\/([^/]+)$/),
    handle: (shopProductMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(shopProductMatch[1])
      if (method === "PUT") return pointHandlers.updateShopProduct(env, request, id)
      if (method === "DELETE") return pointHandlers.deleteShopProduct(env, request, id)
      return null
    },
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/products\/([^/]+)\/review$/),
    methods: ["POST"],
    handle: (shopReviewMatch: RegExpMatchArray) =>
      pointHandlers.reviewShopProduct(env, request, decodeURIComponent(shopReviewMatch[1])),
  },
  // 卡密池（delivery='code'）：读概览 / 追加 / 清空未使用
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/products\/([^/]+)\/codes$/),
    handle: (shopCodesMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(shopCodesMatch[1])
      if (method === "GET") return pointHandlers.getShopProductCodes(env, request, id)
      if (method === "POST") return pointHandlers.addShopProductCodes(env, request, id)
      if (method === "DELETE") return pointHandlers.clearShopProductCodes(env, request, id)
      return null
    },
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/orders\/([^/]+)\/deliver$/),
    methods: ["POST"],
    handle: (shopOrderMatch: RegExpMatchArray) =>
      pointHandlers.deliverShopOrder(env, request, decodeURIComponent(shopOrderMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/orders\/([^/]+)\/settle$/),
    methods: ["POST"],
    handle: (shopSettleMatch: RegExpMatchArray) =>
      pointHandlers.settleShopOrder(env, request, decodeURIComponent(shopSettleMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/orders\/([^/]+)\/cancel$/),
    methods: ["POST"],
    handle: (shopCancelMatch: RegExpMatchArray) =>
      pointHandlers.cancelShopOrder(env, request, decodeURIComponent(shopCancelMatch[1])),
  },
  // 售后（客服介入）：列表 + 判定
  {
    kind: "exact",
    path: "/admin/points/after-sales",
    method: "GET",
    handle: () => pointHandlers.listAfterSales(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/admin\/points\/orders\/([^/]+)\/after-sale$/),
    methods: ["POST"],
    handle: (adminAfterSaleMatch: RegExpMatchArray) =>
      pointHandlers.adminResolveAfterSaleHandler(
        env,
        request,
        decodeURIComponent(adminAfterSaleMatch[1])
      ),
  },

  // 数据库备份直传 R2（家里云每日 cron 用；X-Backup-Token 鉴权，见 handlers/db-backup.ts）
  {
    kind: "exact",
    path: "/internal/db-backup/url",
    method: "GET",
    handle: () => dbBackupHandlers.dbBackupUrlHandler(env, request),
  },

  {
    kind: "exact",
    path: "/internal/db-backup/chunk",
    method: "POST",
    handle: () => dbBackupHandlers.dbBackupChunkHandler(env, request),
  },

  {
    kind: "exact",
    path: "/internal/db-backup/delete",
    method: "POST",
    handle: () => dbBackupHandlers.dbBackupDeleteHandler(env, request),
  },

  {
    kind: "exact",
    path: "/internal/db-backup/prune",
    method: "POST",
    handle: () => dbBackupHandlers.dbBackupPruneHandler(env, request),
  },

  {
    kind: "exact",
    path: "/admin/cloudflare/quota",
    method: "GET",
    handle: () =>
      cfQuotaHandlers.getCloudflareQuota(env, request),
  },

  // ================= OAuth 2.0 授权服务器（Doulor Cloud 作为身份提供方）=================
  //
  // ⚠️ 为什么全部挂在 /api 下、而不是根级的 /oauth/authorize：
  //   本站在 Cloudflare 上跑两个 Worker。API Worker 只被挂了
  //   api/* dl/* p/* u/* c/* profile/* 这几条 Route（见 worker/wrangler.toml 注释，
  //   路由由 dashboard 管理，不写进配置文件以免部署时清掉动态自定义域名路由）。
  //   实测：/oauth/* 与 /.well-known/* 都会落到**静态 Worker**，被 SPA 兜底成 index.html。
  //   OIDC 规范允许 issuer 带路径，故 issuer 取 https://cloud.doulor.cn/api
  //   ⇒ 走已有的 api/* Route，**不需要改动任何线上路由**，风险最低。
  //
  // ⚠️ 二期若想在根级提供漂亮 URL（/oauth/authorize），需在 dashboard 加
  //   cloud.doulor.cn/oauth/* 与 /.well-known/* 两条 Route 指向本 Worker，
  //   但必须把 SPA 的同意页路径从 /oauth/* 里排除掉，否则同意页会被这里截走。

  {
    kind: "exact",
    path: "/.well-known/openid-configuration",
    method: "GET",
    handle: () => oauthHandlers.openidConfiguration(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/authorize",
    method: "GET",
    handle: () => oauthHandlers.authorize(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/token",
    method: "POST",
    handle: () => oauthHandlers.token(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/userinfo",
    method: "GET",
    handle: () => oauthHandlers.userinfo(env, request),
  },
  // 同意页展示与决策（需登录，给本站 SPA 用）
  {
    kind: "exact",
    path: "/oauth/authorize/context",
    method: "GET",
    handle: () => oauthHandlers.authorizeContext(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/authorize/decision",
    method: "POST",
    handle: () => oauthHandlers.authorizeDecision(env, request),
  },
  // 用户自助：查看/撤销已授权应用
  {
    kind: "exact",
    path: "/oauth/grants",
    method: "GET",
    handle: () => oauthHandlers.listMyGrants(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/oauth\/grants\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (oauthGrantMatch: RegExpMatchArray) =>
      oauthHandlers.revokeMyGrant(
      env,
      request,
      decodeURIComponent(oauthGrantMatch[1])
      ),
  },
  // 用户自助：我创建的应用（2026-10-06 放开用户自建）
  {
    kind: "exact",
    path: "/oauth/my-clients",
    method: "GET",
    handle: () => oauthHandlers.listMyClients(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/my-clients",
    method: "POST",
    handle: () => oauthHandlers.createMyClient(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/oauth\/my-clients\/([^/]+)$/),
    methods: ["PUT"],
    handle: (m: RegExpMatchArray) =>
      oauthHandlers.updateMyClient(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/oauth\/my-clients\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) =>
      oauthHandlers.deleteMyClient(env, request, decodeURIComponent(m[1])),
  },
  // 管理端：OAuth 应用管理
  {
    kind: "exact",
    path: "/admin/oauth/clients",
    method: "GET",
    handle: () => oauthHandlers.adminListClients(env, request),
  },
  {
    kind: "exact",
    path: "/admin/oauth/clients",
    method: "POST",
    handle: () => oauthHandlers.adminCreateClient(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)\/secret$/),
    methods: ["POST"],
    handle: (oauthSecretMatch: RegExpMatchArray) =>
      oauthHandlers.adminResetClientSecret(
      env,
      request,
      decodeURIComponent(oauthSecretMatch[1])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)\/review$/),
    methods: ["POST"],
    handle: (m: RegExpMatchArray) =>
      oauthHandlers.adminReviewClient(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "exact",
    path: "/admin/oauth/settings",
    method: "POST",
    handle: () => oauthHandlers.adminSetUserClientPolicy(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)$/),
    methods: ["PUT"],
    handle: (oauthClientMatch: RegExpMatchArray) =>
      oauthHandlers.adminUpdateClient(
      env,
      request,
      decodeURIComponent(oauthClientMatch[1])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (oauthClientMatch: RegExpMatchArray) =>
      oauthHandlers.adminDeleteClient(
      env,
      request,
      decodeURIComponent(oauthClientMatch[1])
      ),
  },

  ]
}

/** 按声明顺序查找并执行匹配的接口；无匹配返回 null（由调用方抛 404）。 */
async function dispatch(
  env: Env,
  request: Request,
  routePath: string,
  method: string,
  ctx?: ExecutionContext
): Promise<Response | null> {
  for (const r of buildRoutes(env, request, ctx)) {
    if (r.kind === "exact") {
      if (routePath === r.path && method === r.method) return r.handle()
      continue
    }
    if (r.kind === "regex") {
      if (!r.methods.includes(method)) continue
      const m = r.match(routePath)
      if (!m) continue
      return r.handle(m)
    }
    // branch：一个正则覆盖多个动作，内部自行判断命中哪个（未命中返回 null）
    const mb = r.match(routePath)
    if (!mb) continue
    const res = r.handle(mb, method)
    if (res) return res
  }
  return null
}

/**
 * 跨站请求来源校验（CSRF 兜底）。
 *
 * 🔴 为什么需要（2026-10-14 安全审计 findings #8/#13）：
 *   本站会话 cookie 是 `SameSite=Lax`，它**挡得住跨站 POST**，但挡不住两件事：
 *     1. 顶级导航式 GET（Lax 会带上 cookie）触发的副作用接口；
 *     2. **同站**子域发起的请求 —— Lax 对"同站"完全不拦。
 *   而第 2 条恰好有现成的落地条件：用户可以在 `*.doulor.cn` 下托管自己的作品页
 *   （见 lab 域名绑定），于是攻击者能在同一站点内拿到一个执行点，
 *   再带着 cookie 打 `/api/points/transfer` 这类写接口 —— 转积分、删资源、改资料。
 *
 * 判定策略（**只拦跨站，不拦同站**）：
 *   · `Sec-Fetch-Site: cross-site`  → 拒绝（现代浏览器的权威信号）
 *   · 有 `Origin` 且其 host 与本次请求的 host 不同 → 拒绝
 *   · 头都没有（命令行 / 老客户端 / 服务端调用）→ 放行
 *
 * 为什么"没有头就放行"是安全的：现代浏览器发写请求时**一定会带** Origin，
 * 所以攻击者无法靠"不带头"绕过；而放行才能不误伤 API 客户端与内部调用。
 *
 * 为什么**不**拦同站：自定义域名的作品页需要调本站 API（lab-store 等），
 * 拦同站会直接打死这个功能。同站那条路要靠"不允许普通用户在品牌域下托管作品"
 * 来根治（见 lab-domains.ts 的保留名 + 权益门禁），不是靠这一层。
 */
function assertNotCrossSite(request: Request, url: URL): void {
  const m = request.method.toUpperCase()
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return


  const sfs = (request.headers.get("Sec-Fetch-Site") || "").toLowerCase()
  if (sfs === "cross-site") {
    throw new ApiError(403, "跨站请求已被拒绝", "CSRF_BLOCKED")
  }

  const origin = request.headers.get("Origin")
  if (origin) {
    let host = ""
    try {
      host = new URL(origin).host.toLowerCase()
    } catch {
      throw new ApiError(403, "跨站请求已被拒绝", "CSRF_BLOCKED")
    }
    if (host !== url.host.toLowerCase()) {
      throw new ApiError(403, "跨站请求已被拒绝", "CSRF_BLOCKED")
    }
  }
}

async function route(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, "") || "/"
  const method = request.method.toUpperCase()

  const routePath = path.startsWith("/api") ? path.slice(4) : path

  const res = await dispatch(env, request, routePath, method, ctx)
  if (res) return res

  throw new ApiError(404, "接口不存在", "NOT_FOUND")
}

/**
 * 给每个请求包一层 D1 读复制会话。
 *
 * 背景（2026-10-01）：线上 D1 已开启 read replication，读可被就近副本服务，
 * 但必须保证「先主库、后副本」的顺序语义，否则会出现「刚登录的下一个请求
 * 读不到会话行 → 被踢回登录页」这类问题：
 *   · `first-primary` —— 本请求的**第一条**查询走主库，之后同一请求内的查询
 *     带着 bookmark，可落到就近副本（跨境用户单次往返 ~150ms → ~10ms）；
 *   · 写语句在会话内始终走主库；同一请求里「写后读」也保证读到自己的写。
 * 绑定不支持 withSession（老 runtime / 本地 miniflare 之外的实现）时原样返回。
 */
function withD1ReadReplication(env: Env): Env {
  const db = env.DB as unknown as { withSession?: (mode?: string) => unknown }
  if (!db || typeof db.withSession !== "function") return env
  try {
    const session = db.withSession("first-primary")
    return new Proxy(env, {
      get: (target, prop) =>
        prop === "DB" ? session : (target as unknown as Record<string | symbol, unknown>)[prop],
    }) as Env
  } catch {
    return env
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env = withD1ReadReplication(env)
    // ⚠️ 入口必做的安全动作：剥掉客户端传来的内部标记头。
    // `X-Doulor-Api-Source` / `X-Doulor-Api-Admin` 只允许 Worker 内部
    // （public-api 的 runAs）注入；不剥的话，任何人自己加一个
    // `X-Doulor-Api-Admin: 1` 就能冒充「管理员 Key」，绕过全部限额。
    request = stripInternalHeaders(request)
    try {
      const url = new URL(request.url)

      // 强制 HTTPS：会话 cookie 带 Secure 标志，HTTP 下浏览器会拒绝保存，
      // 表现为「登录接口 200 却立刻被踢回登录页」，且清缓存/换域名都无效。
      // 静态站点侧由根目录的 site-worker.js 做同样的事。
      //
      // 例外：本机回环地址（本地 wrangler dev / miniflare 联调）没有 TLS，
      // 跳过去就是 301 指向自身的死循环，所有本地请求全挂。线上不可能有
      // 用户从 localhost 打进来，这个豁免不影响生产行为。
      if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
        url.protocol = "https:"
        return Response.redirect(url.toString(), 301)
      }

      // 公开头像：/u/<username>/avatar（无需鉴权，走平台桶）
      const avatarMatch = url.pathname.match(/^\/u\/([^/]+)\/avatar$/)
      if (avatarMatch) {
        return identityHandlers.serveAvatar(env, decodeURIComponent(avatarMatch[1]))
      }

      // 社区帖子图片：/c/<postId>/<filename>（公开，走平台桶）
      const communityImgMatch = url.pathname.match(/^\/c\/([^/]+)\/([^/]+)$/)
      if (communityImgMatch) {
        return communityHandlers.serveCommunityImage(
          env,
          decodeURIComponent(communityImgMatch[1]),
          decodeURIComponent(communityImgMatch[2])
        )
      }


      // 跨站写请求一律拒绝（放在 route 之前，覆盖全部接口）
      assertNotCrossSite(request, url)

      return await route(env, request, ctx)
    } catch (err) {
      if (err instanceof ApiError) {
        // extra：报错之外还要带回信息时用（如登录时账号被封禁 → 一并给出原因与申诉结果）
        const res = json(
          { error: err.message, code: err.code, ...(err.extra ?? {}) },
          err.status
        )
        // 仅在「会话本身失效」时清除 cookie。
        // 注意不能用 status===401 一刀切：登录密码错误、修改密码时当前密码错误
        // 也是 401（INVALID_CREDENTIALS），清 cookie 会把正常用户踢下线。
        //
        // 🔴 2026-10-11 渗透测试 finding#15（CSRF 强制登出）：
        // 还必须要求「请求**确实带了**会话 cookie」才下发清除指令。
        // 否则任意第三方页面提交一个跨站表单（SameSite=Lax 不带 cookie）命中
        // 401 就能让受害者浏览器把 doulor_session 清掉 —— 攻击者不需要知道
        // 任何东西，只需让人打开一个页面即可把人踢下线。
        // 判定用 tokens.length：带了 cookie 但已失效才是「真·会话过期」，
        // 一个没带的请求根本没东西可清，下不下发清除指令都与它无关。
        if (
          err.status === 401 &&
          (err.code === "UNAUTHORIZED" || err.code === "SESSION_EXPIRED")
        ) {
          const tokens = getSessionTokens(request)
          // 浏览器可能同时持有多个同名 cookie，逐个下发清除指令
          for (let i = 0; i < tokens.length; i++) {
            res.headers.append("Set-Cookie", clearedSessionCookie())
          }
        }
        return res
      }
      // ⚠️ 必须带上「哪个方法 + 哪条路径」：这个兜底只回一句「服务器内部错误」给用户，
      // 日志是唯一能定位的线索。2026-09-30 排查「自定义 AI 渠道捐献报服务器内部错误」时，
      // 就是缺了这条信息 —— 只能靠对比业务表的入库空档去反推是哪个接口。
      // ⚠️ 路径里可能带 ID，但**不能记 query string**（捐献/兑换类接口会把密钥放进去）。
      // 解析路径要包一层 try：这里已经在处理未捕获异常了，
      // 若 request.url 本身畸形再抛一次，就绕过了这个兜底（变成 CF 的 1101）。
      let pathForLog = "?"
      try {
        pathForLog = new URL(request.url).pathname
      } catch {
        /* 保持 "?" */
      }
      console.error(`Unhandled error [${request.method} ${pathForLog}]:`, err)
      return json({ error: "服务器内部错误", code: "INTERNAL" }, 500)
    }
  },
  /**
   * 定时任务：由 Cloudflare Cron Triggers 触发（配置见 wrangler.toml 的 [triggers]）。
   *
   * 有**两条** cron，靠 controller.cron 区分：
   *   - `* * * * *`（每分钟）→ 只跑「到点发布」：定时公告 / 定时活动到点后上线。
   *     任务本身极轻（无任务时就是两条 SELECT），所以给到分钟级精度；
   *     若混进每小时那套运维（含 COUNT(*) 全表扫），成本会被放大 60 倍。
   *   - `17 * * * *`（每小时）→ 完整运维（runMaintenance，内部也会兜底跑一次到点发布）。
   *
   * 用 ctx.waitUntil 而不是直接 await：scheduled 处理器同样有墙钟限制，
   * 交给 waitUntil 让调用方尽早返回、任务在后台跑完（与 fetch 里的做法一致）。
   *
   * 每天 UTC 03:xx 的那一次运维升级为「深度模式」（额外清理 90 天前的审计日志）。
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (controller.cron === SCHEDULED_PUBLISH_CRON) {
      ctx.waitUntil(
        processScheduledPublishes(env, ctx).then((r) => {
          if (r.errors > 0) console.warn("到点发布有失败项:", JSON.stringify(r))
        })
      )
      /**
       * 补发「因未开通中转站而挂起」的额度奖励 —— 每 5 分钟一次（2026-10-17）。
       *
       * 为什么不只放每小时运维：用户开通中转站后最想**立刻**拿到那笔奖励，
       * 等一小时太慢（线上 hsyy / link 都是开通后几分钟就来反馈「没到账」）。
       * 查询只走 event_claims 里 manual + newapi_quota 的小子集，成本可忽略；
       * 幂等由 `UPDATE ... WHERE reward_status='manual'` 条件保证。
       * 每小时运维里也调了一次（那份负责把笔数写进 stats）。
       */
      if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0) {
        ctx.waitUntil(
          retryPendingQuotaClaims(env).then((r) => {
            if (r.granted > 0) console.warn("自动补发额度奖励:", r.granted, "笔")
          })
        )
      }

      // 风险账户扫描：每 10 分钟一次（窗口也是 10 分钟，首尾正好相接）。
      // 搭在每分钟的 tick 上而不是新增一条 cron —— 它本身很轻（几条 SELECT +
      // 一两次 NewAPI 请求），不值得为它多开一条触发器。
      if (new Date(controller.scheduledTime).getUTCMinutes() % 10 === 0) {
        ctx.waitUntil(
          scanRiskAccounts(env).then((r) => {
            if (r.flagged > 0) console.warn("风险扫描命中:", JSON.stringify(r))
          })
        )
      }
      /**
       * 活动领奖的「发放中」兜底收敛（2026-10-17）。
       *
       * 每 15 分钟扫一次：把 claimed_at 超过 30 分钟仍停在 pending 的领奖记录
       * 标成 failed 并写清原因，让管理员在「活动 → 领取名单」里看到并人工补发。
       * **不自动补发** —— 原发放可能已经成功，自动重试会重复发（详见函数注释）。
       *
       * 搭在每分钟的 tick 上而不是新开 cron：这条极轻（一条按 status 的 UPDATE，
       * 通常 0 行），多一条触发器反而多一份 controller.cron 与配置漂移的风险。
       */
      if (new Date(controller.scheduledTime).getUTCMinutes() % 15 === 0) {
        ctx.waitUntil(
          eventHandlers.reconcileStaleClaims(env).then((r) => {
            if (r.swept > 0) console.warn("活动领奖兜底收敛:", r.swept, "条")
          })
        )
      }
      return
    }

    const deep = new Date(controller.scheduledTime).getUTCHours() === 3
    ctx.waitUntil(
      runMaintenance(env, { deep }).then((report) => {
        if (report.warnings.length > 0) {
          console.warn("运维自检告警:", report.warnings.join(" | "))
        }
      })
    )
    // 用户商城自动确认收货：卖家交付满 N 天自动结算给卖家（避免买家一直不点收货，
    // 积分永远卡在托管里）。N 由设置项 shop_auto_confirm_days 控制，0 = 关闭。
    ctx.waitUntil(
      pointHandlers.runAutoConfirmDeliveries(env).then((n) => {
        if (n > 0) console.log("自动确认收货:", n, "笔")
      })
    )
  },
}
