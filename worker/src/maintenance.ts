/**
 * 定时运维任务（Cloudflare Cron Triggers 调用，见 wrangler.toml 的 [triggers]）。
 *
 * 为什么需要（2026-09-23 审计）：
 *   平台有一批"只增不减"的数据和一批"到期但没人访问就不清理"的资源，
 *   此前全靠站长手工介入。典型三个：
 *     1. 临时分享箱采用**惰性清理** —— 只有人再次访问那个接收码时才删 R2 对象，
 *        没人访问就永远躺在桶里占空间；
 *     2. `sessions` / `audit_logs` / `rate_limits` 只写不删；
 *     3. 网盘记账（`storage_accounts` 的 used_bytes / file_count）与实际
 *        记录数会因上传中断、预签名直传不 commit 等原因漂移，而且**没人会发现**。
 *
 * 设计原则：**能自动做的只做无争议的删除；有争议的一律只报告**。
 *   - 过期分享箱：语义就是"到期即失效"，删除是预期行为 → 直接删；
 *   - 过期会话 / 老审计日志 / 过期限流窗口：纯垃圾 → 直接删；
 *   - 网盘记账漂移 / 孤儿对象：**只报告不删**（删用户文件必须人工确认，
 *     且有专门的 /api/admin/storage/recalculate 可修）。
 *
 * ⚠️ 关于 R2：本模块**刻意不调用 listObjects 做全桶枚举**。
 *   R2 正在从"单桶 S3 + env 凭证"重构为"多桶 + D1 桶表"（见 HANDOFF §21），
 *   此刻按旧签名枚举会扫到错误的桶，产生假的"孤儿"结论。
 *   真正的 R2 孤儿对账需要按桶枚举，属 R2 方向的待办（见
 *   docs/待办-交给R2方向的安全补丁.md）。这里只做 D1 侧的记账自检。
 */
import type { Env } from "./env"
import { uuid } from "./crypto"
import { purgeExpiredOAuth } from "./oauth-provider"
import { resumeAnnouncementMails } from "./handlers/announcements"
import { processScheduledPublishes } from "./scheduled-publish"
import { purgeExpiredAnalytics } from "./handlers/analytics"
import { purgeExpiredPreviews } from "./link-preview"
import { autoPriceNewModels } from "./newapi-client"
import { expireRentalOrders, remindStaleOrders } from "./points-shop"
import { retryPendingQuotaClaims } from "./event-rewards"

/** 过期会话保留期（天）：留一点用于排查"刚掉线"的投诉 */
const SESSION_RETENTION_DAYS = 7
/** 审计日志保留期（天） */
const AUDIT_RETENTION_DAYS = 90
/** 限流窗口记录保留期（天）：窗口早于此时刻的行不会再被命中 */
const RATE_LIMIT_RETENTION_DAYS = 1
/**
 * 匿名统计事件保留期（天）。
 * ⚠️ 必须与 `handlers/analytics.ts` 的 `purgeExpiredAnalytics` 内部值**保持一致** ——
 * dry-run 分支在这里独立算截止时间，两处不一致会让「预演说清 3 行、真跑清 300 行」。
 */
const ANALYTICS_RETENTION_DAYS = 90
/**
 * 性能样本（perf_samples）保留期（天）。RUM 样本是滚动排障数据，
 * 只要看最近几天的分布，两周足够；久留只会白白吃 D1 行读计费。
 */
const PERF_RETENTION_DAYS = 14
/**
 * 诊断日志（diagnostic_logs）保留期（天）。
 * 附在反馈上的日志，反馈处理完就没用了；反馈本身不删，日志到期清。
 */
const DIAG_LOG_RETENTION_DAYS = 14
/**
 * 链接预览缓存保留期（天）。同样必须与 `link-preview.ts` 的 `PREVIEW_TTL_DAYS` 一致。
 */
const PREVIEW_RETENTION_DAYS = 7
/** 保留最近多少次运行记录（供对比增长速度与排查 cron 是否还在跑） */
const MAINTAIN_RUN_KEEP = 100

/** 单个表的告警阈值（行数）。D1 免费额度按**行读**计费，大表是最贵的地方。 */
const TABLE_WARN_ROWS: Record<string, number> = {
  messages: 100_000,
  audit_logs: 100_000,
  // 0068 起 notifications 承担全站消息（含公告/活动的广播，一次发布 = 活跃用户数行），
  // 增长比以前快得多，阈值从 20 万下调到 10 万。
  notifications: 100_000,
  events: 5_000,
  event_claims: 200_000,
  // 0071：公告邮件队列。每发一条公告 = 活跃用户数行，且完成后仍保留（供排查
  // 「谁没收到」），所以是「有界但不小」的表。阈值给到 50 万，到量说明该清理了。
  announcement_mail_queue: 500_000,
  posts: 50_000,
  post_likes: 200_000,
  storage_objects: 100_000,
  sessions: 50_000,
  rate_limits: 50_000,
  oauth_codes: 50_000,
  oauth_tokens: 50_000,
  // ⚠️ 2026-09-25 审计（H13）：下面四张表原先既没有清理、也没有告警。
  //   analytics_events —— 匿名每浏览写 1 行；link_previews —— 每条外链 1 行；
  //   chat_messages / post_comments —— 纯增长。
  //   在 D1「按行读计费」的模型下，无人看管且无告警的表就是账单黑洞。
  analytics_events: 500_000,
  link_previews: 100_000,
  chat_messages: 200_000,
  post_comments: 200_000,
}

export interface MaintenanceReport {
  ranAt: string
  dryRun: boolean
  deep: boolean
  /** 已过期分享箱：清理的批次数 / 连带删除的 R2 对象数 */
  sessionsDeleted: number
  auditLogsDeleted: number
  rateLimitsDeleted: number
  /** 已清理的 OAuth 过期授权码 / 令牌数 */
  oauthPurged: { codes: number; tokens: number }
  /** 已清理的过期匿名统计事件 / 链接预览缓存数（H13：这两个函数原先从未被调用） */
  expiredPurged: { analyticsEvents: number; linkPreviews: number }
  /** 已清理的过期性能样本 / 诊断日志数（0145/0146，14 天保留期） */
  observabilityPurged: { perfSamples: number; diagLogs: number }
  /** NewAPI 权限同步结果（孤儿清理 / 禁用 / 启用） */
  newapiSync: { removedOrphans: number; disabled: number; enabled: number; errors: string[] }
  /** 公告邮件续跑结果（0071：ctx.waitUntil 被中断时的兜底） */
  announcementMails: { announcements: number; processed: number }
  /**
   * 积分商城「租用」到期处理结果（2026-09-28）。
   *
   * 收回 feature 类租用到期的模块权限（仅当没有别的有效租用在给同一权限）、
   * 归还租用商品占用的库存（租用的 stock = 同时可租份数），并打幂等标记。
   * 用户商品（manual）无法强制回收，只记 note。
   */
  rentalExpiry: {
    checked: number
    handled: number
    permissionsRevoked: number
    keptWithOtherSource: number
    stockReturned: number
    notes: string[]
    errors: string[]
  }
  /**
   * 订单超时未交付 → 提醒卖家的条数（2026-10-17）。
   *
   * 只是「本次检查到几单」，不是「发了几条通知」—— 通知本身按订单号幂等，
   * 同一单只会真正推送一次（见 points-shop.ts 的 remindStaleOrders）。
   */
  staleOrderReminders: number
  /** 本次自动补发的「因未开通中转站而挂起」的额度奖励笔数（2026-10-17） */
  quotaClaimsRetried: number
  /**
   * DNS 解析合规扫描结果（2026-10-01）。
   * 只做静态规则（私网地址、第三方托管、域名转发、无效内容…）；
   * 「真实解析探测」是站长在面板上手动触发的，不进 cron（避免外部依赖）。
   */
  tableRows: Record<string, number>
  /** 封禁用户遗留/待恢复的 CF DNS 记录兜底（removed = 删掉、restored = 重建） */
  /**
   * 代理节点逐节点探活结果（2026-10-08）。
   * 轮转增量：每轮只探「最久没探过」的几个订阅源，见 handlers/proxy.ts 的
   * PROBE_MAX_SUBSCRIPTIONS_PER_RUN。`nodes` 是本轮写入/更新的健康行数。
   */
  warnings: string[]
  errors: string[]
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** 统计若干大表的行数（用于成本预警；只做头部表的 COUNT，不扫全库） */
async function collectTableRows(env: Env): Promise<Record<string, number>> {
  const tables = Object.keys(TABLE_WARN_ROWS)
  const out: Record<string, number> = {}
  for (const table of tables) {
    try {
      // 表名来自本文件内的常量白名单，不含用户输入，不存在注入面
      const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>()
      out[table] = row?.c ?? 0
    } catch (err) {
      // 表可能尚未迁移（例如新装的实例），跳过而不是整体失败
      console.error(`统计 ${table} 行数失败:`, err)
    }
  }
  return out
}


/** 把本次运行写入 maintenance_runs（供对比增长、确认 cron 还活着） */
async function recordRun(
  env: Env,
  report: MaintenanceReport
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO maintenance_runs (id, ran_at, deep, stats, warnings) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        uuid(),
        report.ranAt,
        report.deep ? 1 : 0,
        JSON.stringify({
          sessions: report.sessionsDeleted,
          audit: report.auditLogsDeleted,
          rateLimits: report.rateLimitsDeleted,
          analyticsEvents: report.expiredPurged.analyticsEvents,
          linkPreviews: report.expiredPurged.linkPreviews,
          perfSamples: report.observabilityPurged.perfSamples,
          diagLogs: report.observabilityPurged.diagLogs,
          rentalExpired: report.rentalExpiry.handled,
          rentalPermissionsRevoked: report.rentalExpiry.permissionsRevoked,
          staleOrderReminders: report.staleOrderReminders,
          quotaClaimsRetried: report.quotaClaimsRetried,
          tableRows: report.tableRows,
        }),
        report.warnings.length > 0 ? JSON.stringify(report.warnings) : null
      )
      .run()

    // 只保留最近 N 条，避免这张表自己变成"只增不减"的数据
    await env.DB.prepare(
      `DELETE FROM maintenance_runs WHERE id NOT IN (
         SELECT id FROM maintenance_runs ORDER BY ran_at DESC LIMIT ?
       )`
    )
      .bind(MAINTAIN_RUN_KEEP)
      .run()
  } catch (err) {
    // 表未迁移时不阻断主流程（与 settings.audit 的容错风格一致）
    console.error("写入运维运行记录失败:", err)
  }
}

/**
 * 执行一次运维。
 * @param opts.deep 深度模式（每日一次）：额外清理老审计日志
 */
export async function runMaintenance(
  env: Env,
  opts: { dryRun?: boolean; deep?: boolean } = {}
): Promise<MaintenanceReport> {
  const dryRun = opts.dryRun === true
  const deep = opts.deep === true
  const errors: string[] = []
  const warnings: string[] = []

  // 1) 过期分享箱（D1 + R2）
  try {
  } catch (err) {
    errors.push(`分享箱清理失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2) 过期会话（保留最近几天，便于排查"刚掉线"）
  let sessionsDeleted = 0
  try {
    if (dryRun) {
      const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions WHERE expires_at < ?")
        .bind(daysAgoIso(SESSION_RETENTION_DAYS))
        .first<{ c: number }>()
      sessionsDeleted = r?.c ?? 0
    } else {
      const r = await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?")
        .bind(daysAgoIso(SESSION_RETENTION_DAYS))
        .run()
      sessionsDeleted = r.meta?.changes ?? 0
    }
  } catch (err) {
    errors.push(`会话清理失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3) 过期限流窗口（窗口已翻篇的行不会再被命中）
  let rateLimitsDeleted = 0
  try {
    if (dryRun) {
      const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate_limits WHERE window_start < ?")
        .bind(daysAgoIso(RATE_LIMIT_RETENTION_DAYS))
        .first<{ c: number }>()
      rateLimitsDeleted = r?.c ?? 0
    } else {
      const r = await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(daysAgoIso(RATE_LIMIT_RETENTION_DAYS))
        .run()
      rateLimitsDeleted = r.meta?.changes ?? 0
    }
  } catch (err) {
    // 表未迁移：只记日志，不当成错误（限流本身是 fail-open 的）
    console.error("限流记录清理失败（表可能未迁移）:", err)
  }

  // 4) 老审计日志（仅深度模式，避免每小时都跑一遍大 DELETE）
  let auditLogsDeleted = 0
  if (deep) {
    try {
      if (dryRun) {
        const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE created_at < ?")
          .bind(daysAgoIso(AUDIT_RETENTION_DAYS))
          .first<{ c: number }>()
        auditLogsDeleted = r?.c ?? 0
      } else {
        const r = await env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?")
          .bind(daysAgoIso(AUDIT_RETENTION_DAYS))
          .run()
        auditLogsDeleted = r.meta?.changes ?? 0
      }
    } catch (err) {
      errors.push(`审计日志清理失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 4) OAuth 过期数据（授权码 60 秒、令牌 1 小时，都很短命但会持续堆积）
  //
  // 为什么必须在这里清：oauth_codes 每次授权都会插一行，oauth_tokens 每次登录
  // 换码都会插一行。不清的话，即使它们早已失效也永远留在表里，
  // 最终拖高 D1 的行读计费（见步骤 6 的大表预警）。
  let oauthPurged = { codes: 0, tokens: 0 }
  try {
    if (dryRun) {
      const now = new Date().toISOString()
      const c = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM oauth_codes WHERE expires_at < ? OR used = 1"
      )
        .bind(now)
        .first<{ n: number }>()
      const t = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM oauth_tokens WHERE expires_at < ?"
      )
        .bind(now)
        .first<{ n: number }>()
      oauthPurged = { codes: c?.n ?? 0, tokens: t?.n ?? 0 }
    } else {
      oauthPurged = await purgeExpiredOAuth(env)
    }
  } catch (err) {
    // 表未迁移：只记日志。OAuth 清理失败不该让整个运维任务报错
    console.error("OAuth 过期数据清理失败（表可能未迁移）:", err)
  }

  // 4a-2) 订单超时未交付 → 再提醒卖家一次（2026-10-17）
  //
  // 只提醒、不动钱；幂等由 notifyOrder 的 dedupKey 保证，跑多少次都只提醒一次。
  let staleOrderReminders = 0
  try {
    const r = await remindStaleOrders(env)
    staleOrderReminders = r.considered
  } catch (err) {
    console.error("订单超时提醒失败:", err)
  }

  // 4a-3) 补发「因未开通中转站而挂起」的额度奖励（2026-10-17）
  //
  // 用户答完问卷时还没开中转站 → 奖励落成 manual；往往几分钟后就开通了，
  // 但没有机制回头补。这里每小时扫一遍，谁开通了就补上（金额从我们自己的文案里解析）。
  let quotaClaimsRetried = 0
  try {
    const r = await retryPendingQuotaClaims(env)
    quotaClaimsRetried = r.granted
  } catch (err) {
    console.error("补发挂起的额度奖励失败:", err)
  }

  // 4c) 过期匿名统计事件 / 链接预览缓存（2026-09-25 审计 H13）
  //
  // 这两个清理函数（handlers/analytics.ts 的 purgeExpiredAnalytics 90 天、
  // link-preview.ts 的 purgeExpiredPreviews 7 天）在 2026-09-25 的审计里是
  // **写好了却从来没有调用点**（全仓 grep 只命中定义处），而文档
  // （docs/新功能-定时运维与邮件回信.md、HANDOFF.md）还宣称这两件事已经做了。
  // 后果：analytics_events 是**匿名接口每浏览写一行**，link_previews 是每条
  // 外链一行，两张表无界增长 —— 在 D1 按行读计费下是全库最贵的地方。
  //
  // ✅ 2026-10-13：接线已经补上（就是下面这次调用）。两个决定记录在此：
  //   · **挂每小时的完整运维（`17 * * * *`），不挂每分钟的发布 tick**：
  //     过期数据早一小时清掉没有任何产品影响，而 DELETE 是写操作；
  //     每分钟那条 cron 是给「定时公告/到点活动」用的，语义是「不能晚」，
  //     把清理塞进去只会让一个便宜的 tick 变成一个会写库的 tick
  //     （见 index.ts 的 SCHEDULED_PUBLISH_CRON 与 scheduled 处理器）。
  //   · **保留期沿用硬编码常量**（ANALYTICS_RETENTION_DAYS / PREVIEW_RETENTION_DAYS），
  //     跟着本文件其它任务（会话 7 天 / 审计 90 天 / 限流 1 天）的既有风格走，
  //     不为这两张表单独发明「设置项驱动的保留期」机制。两个常量必须与各自
  //     handler 内部值一致 —— 否则 dryRun 的预演数会与真跑数不符。
  //   · 没进 TABLE_WARN_ROWS 的历史原因也已一并修掉（见文件上方那张表的注释）。
  let expiredPurged = { analyticsEvents: 0, linkPreviews: 0 }
  try {
    if (dryRun) {
      const analyticsCutoff = daysAgoIso(ANALYTICS_RETENTION_DAYS)
      const previewCutoff = daysAgoIso(PREVIEW_RETENTION_DAYS)
      const a = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM analytics_events WHERE created_at < ?"
      )
        .bind(analyticsCutoff)
        .first<{ c: number }>()
      const p = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM link_previews WHERE fetched_at < ?"
      )
        .bind(previewCutoff)
        .first<{ c: number }>()
      expiredPurged = { analyticsEvents: a?.c ?? 0, linkPreviews: p?.c ?? 0 }
    } else {
      expiredPurged = {
        analyticsEvents: await purgeExpiredAnalytics(env),
        linkPreviews: await purgeExpiredPreviews(env),
      }
    }
  } catch (err) {
    // 表未迁移：只记日志。这两张表清不掉不该让整个运维任务报错
    console.error("过期统计/预览缓存清理失败（表可能未迁移）:", err)
  }

  // 4d) 过期性能样本 / 诊断日志（0145/0146，14 天保留期）
  //
  // perf_samples 是「每次页面加载可能写一行」的高频表，diagnostic_logs 单行
  // 可达 64KB —— 两张都按保留期整行清，拖久了在 D1 按行读计费下都是大账。
  // 表未迁移时只记日志（老部署先跑迁移再部署后端的顺序没跟上也不炸运维）。
  let observabilityPurged = { perfSamples: 0, diagLogs: 0 }
  try {
    if (dryRun) {
      const perfCutoff = daysAgoIso(PERF_RETENTION_DAYS)
      const diagCutoff = daysAgoIso(DIAG_LOG_RETENTION_DAYS)
      const p = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM perf_samples WHERE created_at < ?"
      )
        .bind(perfCutoff)
        .first<{ c: number }>()
      const d = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM diagnostic_logs WHERE created_at < ?"
      )
        .bind(diagCutoff)
        .first<{ c: number }>()
      observabilityPurged = { perfSamples: p?.c ?? 0, diagLogs: d?.c ?? 0 }
    } else {
      const p = await env.DB.prepare(
        "DELETE FROM perf_samples WHERE created_at < ?"
      )
        .bind(daysAgoIso(PERF_RETENTION_DAYS))
        .run()
      const d = await env.DB.prepare(
        "DELETE FROM diagnostic_logs WHERE created_at < ?"
      )
        .bind(daysAgoIso(DIAG_LOG_RETENTION_DAYS))
        .run()
      observabilityPurged = {
        perfSamples: p.meta?.changes ?? 0,
        diagLogs: d.meta?.changes ?? 0,
      }
    }
  } catch (err) {
    console.error("性能样本/诊断日志清理失败（表可能未迁移）:", err)
  }

  // 6) NewAPI 权限同步 —— 2026-09-27 已停用。
  //
  // 原先每小时全量遍历所有开通中转站的用户、逐个调 NewAPI 核对，用户一多就撞
  // Cloudflare Worker 的 subrequest 上限（报「Too many subrequests」），每小时发一封
  // 告警邮件。封禁/解封的同步是**实时的**（handlers/admin.ts 的 updateUser 里直接调
  // adminSetUserStatus），这个定时兜底只补「孤儿清理」和「非封禁的权限变化」两个边角，
  // 对站长自用的体量价值很低。需要时仍可走管理面板的手动触发
  // `POST /api/admin/newapi/sync-permissions`。
  const newapiSync = { removedOrphans: 0, disabled: 0, enabled: 0, errors: [] as string[] }

  // 7b) 新模型自动补按次价（没有 ModelPrice 的模型会回落 token 倍率 37.5）
  let modelsPriced = 0
  if (!dryRun) {
    try {
      modelsPriced = await autoPriceNewModels(env)
      if (modelsPriced > 0) {
        warnings.push(`已为 ${modelsPriced} 个新模型自动补上 1 元/次的按次价。`)
      }
    } catch (err) {
      console.error("新模型补价失败:", err)
    }
  }

  // 7d) 积分商城「租用」到期处理（2026-09-28）
  //
  // 为什么挂在每小时这条：到期是「分钟级不敏感、但漏了会持续白送」的事 ——
  // 收回动作要写库 + 可能调 NewAPI，属于「贵且不急」。
  // 判据与动作的完整说明见 points-shop.ts 的 expireRentalOrders。
  const rentalExpiry: MaintenanceReport["rentalExpiry"] = {
    checked: 0,
    handled: 0,
    permissionsRevoked: 0,
    keptWithOtherSource: 0,
    stockReturned: 0,
    notes: [],
    errors: [],
  }
  try {
    const r = await expireRentalOrders(env, { dryRun })
    Object.assign(rentalExpiry, r)
    for (const e of r.errors) errors.push(`租用到期：${e}`)
    for (const n of r.notes) warnings.push(n)
    if (r.permissionsRevoked > 0) {
      warnings.push(`积分商城有 ${r.permissionsRevoked} 笔租用到期，已收回对应模块权限。`)
    }
  } catch (err) {
    // 表未迁移 / 上游异常都不该让整个运维任务报错（其它清理项还要跑）
    console.error("租用到期处理失败（表可能未迁移）:", err)
  }

  // 8) 大表行数预警（D1 按行读计费，大表是最贵的地方）
  // ⚠️ 2026-09-25 审计（M15）：本模块的自述目标是「降低 D1 行读成本」，
  // 但它自己**每小时**对 10+ 张大表各做一次 `COUNT(*)` —— 这是全表扫描，
  // 与目标正好相反（messages 到 10 万行时，单次 cron 就可能消耗数十万行读）。
  //
  // SQLite/D1 没有 O(1) 的行数查询，所以没法既准确又便宜。取舍：
  // 把行数统计收敛到**每日一次的深度模式**（cron 在 UTC 03:xx 那次带 deep），
  // 成本直接降到 1/24。行数预警本来就是「看增长趋势」用的，每天一次足够；
  // 真正需要分钟级关注的指标不该靠 COUNT(*) 拿。
  const tableRows = deep ? await collectTableRows(env) : {}
  for (const [table, rows] of Object.entries(tableRows)) {
    const limit = TABLE_WARN_ROWS[table]
    if (limit && rows >= limit) {
      warnings.push(`表 ${table} 已有 ${rows} 行（阈值 ${limit}），建议评估清理策略以免拖高 D1 行读计费。`)
    }
  }

  // 9) 公告邮件续跑（0071）
  //
  // ctx.waitUntil 的后台任务不保证跑完（部署、超时、实例回收都可能中断），
  // 队列里会留下 status='pending' 的行。这里每小时兜底捞一次，
  // 保证「管理员点了发布，邮件最终一定会发出去」。
  let announcementMails = { announcements: 0, processed: 0 }
  if (!dryRun) {
    try {
      announcementMails = await resumeAnnouncementMails(env)
      if (announcementMails.announcements > 0) {
        warnings.push(
          `续跑了 ${announcementMails.announcements} 条公告的邮件群发（本次发出 ${announcementMails.processed} 封）。`
        )
      }
    } catch (err) {
      // 表未迁移：只记日志，不影响其它运维项
      console.error("公告邮件续跑失败（表可能未迁移）:", err)
    }
  }

  // 9b) 到点发布兜底
  //
  // 主路径是每分钟那条 cron（index.ts 里 SCHEDULED_PUBLISH_CRON → processScheduledPublishes）。
  // 这里每小时再跑一次，是为了防止那条 cron 没配上 / 被误删 —— 那样定时公告与
  // 定时活动会**永远不发**，而且不会有任何报错（最隐蔽的失败）。
  if (!dryRun) {
    try {
      const published = await processScheduledPublishes(env)
      if (published.announcements > 0 || published.events > 0) {
        warnings.push(
          `到点发布了 ${published.announcements} 条公告、${published.events} 个活动。`
        )
      }
    } catch (err) {
      console.error("到点发布兜底失败（表可能未迁移）:", err)
    }
  }


  // 10) 清理失败也算告警（否则"静默失败"永远没人知道）
  //
  // ⚠️ 必须排在 4d 之后：sweep 修好后是真在干活，它的 CF 失败（429/403/子请求超限）
  // 会 push 进 errors —— 放在 4d 之前的话这些失败既不进 warnings 也不落库
  // （maintenance_runs 只有 stats/warnings 两列），线上永远看不见。
  if (errors.length > 0) {
    warnings.push(`本次运维有 ${errors.length} 项失败：${errors.slice(0, 3).join("；")}`)
  }

  const report: MaintenanceReport = {
    ranAt: new Date().toISOString(),
    dryRun,
    deep,
    sessionsDeleted,
    auditLogsDeleted,
    rateLimitsDeleted,
    oauthPurged,
    expiredPurged,
    observabilityPurged,
    newapiSync,
    rentalExpiry,
    staleOrderReminders,
    quotaClaimsRetried,
    announcementMails,
    tableRows,
    warnings,
    errors,
  }

  await recordRun(env, report)
  // ⚠️ 2026-09-27：不再发运维告警邮件。站长明确不要这份每小时邮件 ——
  // 有告警直接看 D1 的 maintenance_runs 表或 console.warn 即可。
  // （原先 notifyAdmins 在 warnings 非空时给所有已验证管理员发邮件。）

  return report
}
