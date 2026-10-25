/**
 * 造物典藏 —— **典藏设置**（管理端）。
 *
 * 路由（路径相对 `/api`，都在 `index.ts` 登记）：
 *   GET  /admin/collection/invest          参数 + 池子 + 全服统计
 *   PUT  /admin/collection/invest          改玩法参数 / 上下架 / 卡片外观
 *   POST /admin/collection/invest/pool     划拨垫本 / 抽回资金
 *   GET  /admin/collection/invest/ledger   池子审计流水
 *   POST /admin/collection/invest/reset    重置行情（危险）
 *
 * 权限：`requireAdminScope(env, request, "collection")`（权限树里登记在
 * 「内容与运营」组下的「造物典藏」）。站长与超管不受白名单限制。
 *
 * ⚠️ 参数写入**必须先过 `sanitizeGameParams`** 再落库：设置项在库里是字符串，
 *    一个手滑多打两个 0（maxLeverage=100000）会直接进引擎。写入侧用引擎自己的
 *    清洗函数，读出来就一定是合法值 —— 读写同一套规则，不会漂移。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { audit, getSettings, updateSettings } from "../settings"
import { getStarRate, getWallet } from "../game-wallet"
import {
  depositToPool,
  ensureMarket,
  gameStats,
  loadGameParams,
  poolLedger,
  resetMarket,
  withdrawFromPool,
} from "../game-market"
import { sanitizeGameParams } from "../game-engine"
import { getPlugin, listAllPlugins as listAllPluginsPublic, toPublicPlugin, updatePluginRow } from "../collection-plugins"
import type { Env } from "../env"

/** 「在线投资」在清单里的 slug。将来别的内置游戏各有一份同构的设置接口 */
const INVEST_SLUG = "invest"

/** 前端表单能改的 14 个玩法参数（对应 settings.ts 里的 game_* 键） */
const PARAM_KEYS = [
  "game_enabled",
  "game_tick_seconds",
  "game_candle_seconds",
  "game_max_leverage",
  "game_min_margin",
  "game_fee_open_bps",
  "game_fee_close_bps",
  "game_maintenance_bps",
  "game_noise_bps",
  "game_impact_bps",
  "game_mean_reversion_bps",
  "game_reversion_deadband_bps",
  "game_anchor_follow_bps",
  "game_max_impact_bps",
  "game_base_price",
] as const

type ParamKey = (typeof PARAM_KEYS)[number]

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad")
    return body as Record<string, unknown>
  } catch {
    throw new ApiError(400, "请求体格式错误", "INVALID_INPUT")
  }
}

/** 只接受已知键；其余一律忽略（不报错 —— 前端版本可能比后端新，宽容一点） */
function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * GET /api/admin/collection/invest
 *
 * 一次返回设置页要的全部东西：参数原始值（表单回显用字符串，避免「存 5、
 * 显示 5.0」这类噪声）、清洗后的生效值、池子、全服统计、行情快照。
 */
export async function getGameAdmin(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")

  const params = await loadGameParams(env)
  const [settings, market, stats, plugin, myStars] = await Promise.all([
    getSettings(env),
    ensureMarket(env, params),
    gameStats(env),
    getPlugin(env, INVEST_SLUG),
    getWallet(env, INVEST_SLUG, admin.id),
  ])

  const raw: Record<string, string> = {}
  for (const key of PARAM_KEYS) raw[key] = settings[key]

  return json({
    plugin: plugin ? toPublicPlugin(plugin, true) : null,
    /** 表单回显用（库里存的原始字符串） */
    raw,
    /** 实际生效的参数（已被 sanitize，可能与 raw 不同 —— 那说明库里的值被收口了） */
    effective: {
      enabled: params.enabled,
      tickSeconds: params.tickMs / 1000,
      candleSeconds: params.candleMs / 1000,
      maxLeverage: params.maxLeverage,
      minMargin: params.minMargin,
      feeOpenBps: params.feeOpenBps,
      feeCloseBps: params.feeCloseBps,
      maintenanceBps: params.maintenanceBps,
      noiseBps: params.noiseBps,
      impactBps: params.impactBps,
      meanReversionBps: params.meanReversionBps,
    reversionDeadbandBps: params.reversionDeadbandBps,
      anchorFollowBps: params.anchorFollowBps,
      maxImpactBps: params.maxImpactBps,
      basePrice: params.basePrice,
    },
    market: {
      price: market.price,
      anchor: market.anchor,
      tickSeq: market.tick_seq,
      lastTickAt: market.last_tick_at,
      candleOpenAt: market.candle_open_at,
    },
    pool: {
      balance: market.pool_balance,
      /** 站长自己的星币钱包余额 —— 划拨垫本前先在游戏内兑换星币 */
      myStars,
    },
    /** 星币汇率（星币/积分），管理面板可改 */
    starRate: await getStarRate(env, INVEST_SLUG),
    stats,
  })
}

/**
 * PUT /api/admin/collection/invest
 *
 * body: { params?: { game_xxx: number|string }, plugin?: { status?, accent?, name?, tagline?, description? } }
 *
 * 参数先合到「当前值」上再整体清洗 —— **部分更新**是必须支持的：
 * 前端只提交被改动的那几个输入框，如果直接对缺省值取默认，
 * 会把没动过的参数悄悄重置回默认（站长改个手续费把杠杆上限改回 20，很难发现）。
 */
export async function updateGameAdmin(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")
  const body = await readJson(request)

  const patch: Partial<Record<ParamKey, string>> = {}
  const rawParams = (body.params ?? {}) as Record<string, unknown>
  for (const key of PARAM_KEYS) {
    if (!(key in rawParams)) continue
    const v = rawParams[key]
    if (key === "game_enabled") {
      patch[key] = v === true || v === "1" || v === 1 || v === "true" ? "1" : "0"
      continue
    }
    const n = numOrUndefined(v)
    if (n !== undefined) patch[key] = String(n)
  }

  if (Object.keys(patch).length > 0) {
    // 先合并到当前值，再整体清洗，最后把**清洗后的值**写回库
    const current = await loadGameParams(env)
    const merged = sanitizeGameParams({
      enabled: patch.game_enabled !== undefined ? patch.game_enabled : current.enabled,
      tickSeconds: patch.game_tick_seconds ?? current.tickMs / 1000,
      candleSeconds: patch.game_candle_seconds ?? current.candleMs / 1000,
      maxLeverage: patch.game_max_leverage ?? current.maxLeverage,
      minMargin: patch.game_min_margin ?? current.minMargin,
      feeOpenBps: patch.game_fee_open_bps ?? current.feeOpenBps,
      feeCloseBps: patch.game_fee_close_bps ?? current.feeCloseBps,
      maintenanceBps: patch.game_maintenance_bps ?? current.maintenanceBps,
      noiseBps: patch.game_noise_bps ?? current.noiseBps,
      impactBps: patch.game_impact_bps ?? current.impactBps,
      meanReversionBps: patch.game_mean_reversion_bps ?? current.meanReversionBps,
    reversionDeadbandBps:
      patch.game_reversion_deadband_bps ?? current.reversionDeadbandBps,
      anchorFollowBps: patch.game_anchor_follow_bps ?? current.anchorFollowBps,
      maxImpactBps: patch.game_max_impact_bps ?? current.maxImpactBps,
      basePrice: patch.game_base_price ?? current.basePrice,
    })

    await updateSettings(env, {
      game_enabled: merged.enabled ? "1" : "0",
      game_tick_seconds: String(merged.tickMs / 1000),
      game_candle_seconds: String(merged.candleMs / 1000),
      game_max_leverage: String(merged.maxLeverage),
      game_min_margin: String(merged.minMargin),
      game_fee_open_bps: String(merged.feeOpenBps),
      game_fee_close_bps: String(merged.feeCloseBps),
      game_maintenance_bps: String(merged.maintenanceBps),
      game_noise_bps: String(merged.noiseBps),
      game_impact_bps: String(merged.impactBps),
      game_mean_reversion_bps: String(merged.meanReversionBps),
          game_reversion_deadband_bps: String(merged.reversionDeadbandBps),
      game_anchor_follow_bps: String(merged.anchorFollowBps),
      game_max_impact_bps: String(merged.maxImpactBps),
      game_base_price: String(merged.basePrice),
    })
  }

  // 插件自身的行（上下架 / 卡片外观 / 星币汇率）。刻意与玩法参数分开：一个是运营状态，一个是玩法
  const currentPlugin = await getPlugin(env, INVEST_SLUG)
  const pluginPatch = (body.plugin ?? {}) as Record<string, unknown>
  const row: {
    status?: string
    accent?: string
    name?: string
    tagline?: string
    description?: string
    config?: string
  } = {}
  if (typeof pluginPatch.status === "string") {
    const allowed = ["draft", "review", "published", "disabled"]
    if (!allowed.includes(pluginPatch.status)) {
      throw new ApiError(400, "未知的上架状态", "INVALID_INPUT")
    }
    row.status = pluginPatch.status
  }
  if (typeof pluginPatch.accent === "string") {
    // 只允许 hex 色值或空（空 = 用站点默认色）。别让这里变成注入 CSS 的口子
    const accent = pluginPatch.accent.trim()
    if (accent && !/^#[0-9a-fA-F]{3,8}$/.test(accent)) {
      throw new ApiError(400, "强调色要填 #RRGGBB 形式", "INVALID_INPUT")
    }
    row.accent = accent
  }
  // 星币汇率（2026-10-25 星币体系）：存 config.starRate，供 game-wallet 的
  // getStarRate 读取。范围 1 ~ 100 万（防手滑多打 0 把汇率打成天文数字）。
  if (pluginPatch.config && typeof pluginPatch.config === "object") {
    const cfg = pluginPatch.config as { starRate?: unknown }
    if (cfg.starRate !== undefined) {
      const rate = Math.trunc(Number(cfg.starRate))
      if (!Number.isFinite(rate) || rate < 1 || rate > 1_000_000) {
        throw new ApiError(400, "星币汇率需为 1 ~ 100 万的整数", "INVALID_INPUT")
      }
      let current: Record<string, unknown> = {}
      try {
        current = JSON.parse(currentPlugin?.config || '{}') as Record<string, unknown>
      } catch {
        current = {}
      }
      current.starRate = rate
      row.config = JSON.stringify(current)
    }
  }
  if (typeof pluginPatch.name === "string") row.name = pluginPatch.name.trim().slice(0, 40)
  if (typeof pluginPatch.tagline === "string") row.tagline = pluginPatch.tagline.trim().slice(0, 80)
  if (typeof pluginPatch.description === "string") {
    row.description = pluginPatch.description.trim().slice(0, 1000)
  }
  if (Object.keys(row).length > 0) {
    await updatePluginRow(env, INVEST_SLUG, row)
  }

  await audit(
    env,
    admin.id,
    "collection.game.config",
    `${admin.username} 更新了「在线投资」的典藏设置` +
      (Object.keys(patch).length > 0 ? `（${Object.keys(patch).join(", ")}）` : "")
  )

  return await getGameAdmin(env, request)
}

/**
 * PUT /api/admin/collection/plugins/:slug —— 游戏仓库的**通用**插件更新
 * （2026-10-25 模拟人生改造）。
 *
 * body: { status?, name?, icon?, tagline?, description?, accent? }，全部可选。
 * 这是「未来游戏零改动接入」契约的一半（另一半是清单路由已按管理员口径返回
 * 未上架插件）：任何游戏（内置或将来 sandbox 用户游戏）的上架/下架/改名
 * 都走这一个接口，不再需要每个游戏一份同构设置接口。
 *
 * 与 `updateGameAdmin` 的 `plugin.status` 的关系：两处写的是**同一列**
 * （collection_plugins.status），同源无冲突——invest 面板内的开关保留，
 * 游戏仓库清单上的开关是它的快捷入口。
 *
 * 权限：`requireAdminScope("collection")`（与同文件其余接口一致）。
 */
export async function updateGamePlugin(
  env: Env,
  request: Request,
  slug: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")
  const body = await readJson(request)

  // slug 必须真实存在；清单未同步时先跑一次差异同步（内置插件会补行）
  let row = await getPlugin(env, slug)
  if (!row) {
    await listAllPluginsPublic(env)
    row = await getPlugin(env, slug)
  }
  if (!row) throw new ApiError(404, "插件不存在", "NOT_FOUND")

  const patch: { status?: string; name?: string; icon?: string; tagline?: string; description?: string; accent?: string } = {}

  if (body.status !== undefined) {
    const status = String(body.status)
    if (!["published", "disabled"].includes(status)) {
      throw new ApiError(400, "status 只能是 published 或 disabled", "INVALID_INPUT")
    }
    patch.status = status
  }
  if (body.name !== undefined) {
    patch.name = String(body.name).trim().slice(0, 40)
    if (!patch.name) throw new ApiError(400, "名称不能为空", "INVALID_INPUT")
  }
  if (body.icon !== undefined) {
    patch.icon = String(body.icon).trim().slice(0, 8)
  }
  if (body.tagline !== undefined) {
    patch.tagline = String(body.tagline).trim().slice(0, 80)
  }
  if (body.description !== undefined) {
    patch.description = String(body.description).trim().slice(0, 1000)
  }
  if (body.accent !== undefined) {
    const accent = String(body.accent).trim()
    // 只允许 hex 色值或空（空 = 用站点默认色）。别让这里变成注入 CSS 的口子
    if (accent && !/^#[0-9a-fA-F]{3,8}$/.test(accent)) {
      throw new ApiError(400, "强调色要填 #RRGGBB 形式", "INVALID_INPUT")
    }
    patch.accent = accent
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "没有给出要更新的字段", "INVALID_INPUT")
  }

  await updatePluginRow(env, slug, patch)
  await audit(
    env,
    admin.id,
    "collection.game.plugin",
    `${admin.username} 更新了游戏「${slug}」：${Object.entries(patch)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  )

  const updated = await getPlugin(env, slug)
  return json({ plugin: updated ? toPublicPlugin(updated, true) : null })
}

/**
 * POST /api/admin/collection/invest/pool  { action: "deposit" | "withdraw", amount }
 *
 * 垫本划拨：从站长账户扣、池子加（总量不变）。这是全游戏唯一的资金注入入口，
 * 也是「站内积分守恒」在管理员侧的那一半。
 */
export async function setGamePool(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")
  const body = await readJson(request)
  const action = body.action === "withdraw" ? "withdraw" : "deposit"
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount < 1) {
    throw new ApiError(400, "数量必须是不小于 1 的整数", "INVALID_INPUT")
  }

  const params = await loadGameParams(env)
  // 池子行必须存在（首次划拨时它还没被创建）
  await ensureMarket(env, params)

  const res =
    action === "deposit"
      ? await depositToPool(env, admin, amount)
      : await withdrawFromPool(env, admin, amount)

  return json({
    ok: true,
    action,
    pool: res.pool,
    /** 操作后站长自己的余额 */
    balance: res.balance,
  })
}

/** GET /api/admin/collection/invest/ledger?limit=50 */
export async function getGameLedger(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "collection")
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const rows = await poolLedger(env, Number.isFinite(limit) ? limit : 50)
  return json({
    entries: rows.map((r) => ({
      id: String(r.id),
      delta: Number(r.delta ?? 0),
      balanceAfter: Number(r.balance_after ?? 0),
      kind: String(r.kind),
      username: r.username === null || r.username === undefined ? null : String(r.username),
      ref: r.ref === null || r.ref === undefined ? null : String(r.ref),
      note: r.note === null || r.note === undefined ? null : String(r.note),
      createdAt: String(r.created_at),
    })),
  })
}

/**
 * POST /api/admin/collection/invest/reset  { confirm: "RESET" }
 *
 * 重置行情：价格回到初始价、K 线清空、换新种子。**有在仓持仓时直接拒绝**
 * （理由见 game-market.ts 的 resetMarket）。
 */
export async function resetGame(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")
  const body = await readJson(request)
  if (body.confirm !== "RESET") {
    throw new ApiError(400, "危险操作需要二次确认（confirm 传 \"RESET\"）", "CONFIRM_REQUIRED")
  }
  const params = await loadGameParams(env)
  const market = await resetMarket(env, admin, params)
  return json({ ok: true, price: market.price, tickSeq: market.tick_seq })
}
