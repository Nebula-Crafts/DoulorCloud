/**
 * 「用户可分配根域」注册表。
 *
 * ---------------------------------------------------------------------------
 * 为什么要把它从 `env.ROOT_DOMAIN` 拆出来（2026-10-01 站长要求）
 * ---------------------------------------------------------------------------
 * 站内发给用户的子域名与邮箱原先硬编码在 `env.ROOT_DOMAIN`（doulor.cn）上。
 * 但 doulor.cn 同时是**站点主域**：`cloud.doulor.cn`、密码重置链接、OAuth issuer
 * 都从它拼出来 —— 所以 `env.ROOT_DOMAIN` **绝不能**改成新域，改了站点自身就坏了。
 *
 * 而把所有用户的邮箱 / 子域名都挂在主域上还有个更隐蔽的代价：
 * 主域同时是「给用户发验证码 / 找回密码」的发件域。用户拿 `xxx@doulor.cn`
 * 去注册外站、收垃圾邮件、被投诉，脏掉的是**主域声誉** ⇒ 你的关键通知邮件
 * 会开始进垃圾箱。把用户域换成一个独立域名，等于把这份风险**隔离**出去。
 *
 * 于是本模块把「发给用户的域名」做成一张表（`root_domains`），默认 tyu.me；
 * doulor.cn 保留但需要 `doulor` 权限才能选（`requires_feature`）。
 *
 * ---------------------------------------------------------------------------
 * 两条容易踩的线
 * ---------------------------------------------------------------------------
 * 1. `zone_id` 必须按域存。CF 的 DNS 记录与 Worker Route 都是**按 zone** 操作的，
 *    API 路径里直接带 zone id。缺省时调 `GET /zones?name=<name>` 解析一次并回填。
 *    （`domains.zone_id` 早就是同一套思路，见 handlers/dns.ts。）
 * 2. 表**为空**时要能正常服务：回落成「就用 `env.ROOT_DOMAIN`、无权限要求」，
 *    这样新部署 / 迁移漏跑都不会把注册打挂。只有表里真有行时才以表为准。
 */
import { ApiError } from "./http"
import { hasFeature, type Permissions } from "./permissions"
import type { Env } from "./env"

export interface RootDomainRow {
  name: string
  zone_id: string | null
  label: string | null
  /** 非空 = 必须先解锁该权限才能把子域名/邮箱建在这个域下 */
  requires_feature: string | null
  /**
   * DNS 解析租用的年价（积分/年，迁移 0160）。0 = 该根域不参与租用售卖。
   *
   * ⚠️ 这里带出来的是**读缓存里的值**（10 秒 TTL）。用于展示（管理端列表、
   * 用户端价目卡）没问题，但**扣分那一刻必须再直查一次库** ——
   * 拿缓存里的旧价去扣会实收一个已经不存在的价格，见 handlers/dns-rental.ts
   * 的 priceOf。
   */
  dns_price_per_year: number | null
  is_default: number
  enabled: number
  created_at: string
}

/**
 * 模块级读缓存。
 *
 * 一次注册 / 一次 DNS 写入会连着问好几次「这个 fqdn 属于哪个根域」，
 * 每次打一遍 D1 纯属浪费。10 秒 TTL + 写路径显式失效（`resetRootDomainCache`），
 * 与 wb2api/newapi 的凭据缓存同口径。
 */
let cache: { at: number; rows: RootDomainRow[] } | null = null
const CACHE_MS = 10_000

/** 写路径改完表后调用；其它 isolate 最多等 CACHE_MS */
export function resetRootDomainCache(): void {
  cache = null
}

/**
 * 表为空时的兜底：退化成「只有站点主域、且人人可用」。
 *
 * 为什么不抛错：迁移漏跑 / 新建环境时，抛错会让**注册整个挂掉**。
 * 退化成旧行为（doulor.cn）虽然不理想，但站点是可用的 ——
 * 而「可用的旧行为」远比「不可用的新行为」好收场。
 */
function fallbackRow(env: Env): RootDomainRow {
  return {
    name: env.ROOT_DOMAIN.toLowerCase(),
    zone_id: env.ZONE_ID ?? null,
    label: null,
    requires_feature: null,
    dns_price_per_year: 0,
    is_default: 1,
    enabled: 1,
    created_at: "",
  }
}

/** 全部根域（含被禁用的，管理端要用）；按「默认优先 → 名字」排序 */
export async function listRootDomains(env: Env): Promise<RootDomainRow[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.rows

  let rows: RootDomainRow[] = []
  try {
    const res = await env.DB.prepare(
      `SELECT name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at
         FROM root_domains
        ORDER BY is_default DESC, name ASC`
    ).all<RootDomainRow>()
    rows = res.results ?? []
  } catch (err) {
    // 表不存在（迁移没跑）不该让注册挂掉，退化成旧行为
    console.error("读取 root_domains 失败，回落到 ROOT_DOMAIN:", err)
    rows = []
  }
  if (rows.length === 0) rows = [fallbackRow(env)]

  cache = { at: now, rows }
  return rows
}

/** 当前生效的根域（`enabled = 1`） */
export async function listEnabledRootDomains(env: Env): Promise<RootDomainRow[]> {
  return (await listRootDomains(env)).filter((r) => r.enabled === 1)
}

/**
 * 新用户注册 / 新建时要用的默认根域。
 *
 * 默认域是「发给**所有人**」的域，所以它**必须是一个免权限的域**。若管理员
 * 误把一个挂了 `requires_feature` 的域（例如 doulor.cn）设成默认，任何没解锁
 * 对应权限的人都会在注册 / 临时邮箱 / 未指定域的别名里**白拿**一个该域地址 ——
 * 这与「doulor.cn 需要 doulor 权限才能用」直接冲突（2026-10-04 越权注册复现）。
 *
 * 因此这里在选择默认域时**跳过带权限的域**：即使 doulor.cn 被标成 is_default，
 * 也会回落到真正「人人可用」的域（如 tyu.me），而不是静默放行。主动选域仍走
 * `pickRootDomain` 的权限闸。
 */
export async function getDefaultRootDomain(env: Env): Promise<RootDomainRow> {
  const rows = await listRootDomains(env)
  const free = (r: RootDomainRow) => r.enabled === 1 && !r.requires_feature
  const def = rows.find((r) => r.is_default === 1 && free(r))
  if (def) return def
  // 没有任何免权限的默认行：取第一个免权限且启用的域
  const any = rows.find(free)
  if (any) return any
  // 连一个免权限的启用域都没有：极端兜底。此时宁可用站点主域（历史行为，人人可用），
  // 也不要挑一个带权限的域白送出去。
  return fallbackRow(env)
}

export async function getRootDomainByName(
  env: Env,
  name: string
): Promise<RootDomainRow | null> {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return (await listRootDomains(env)).find((r) => r.name === target) ?? null
}

/**
 * 从「fqdn 或邮箱地址」里认出它属于哪个根域 —— 取**最长后缀匹配**。
 *
 * 必须最长匹配而不是 `endsWith` 第一个命中：`mail.doulor.cn` 同时是
 * `doulor.cn` 的后缀，但若表里真有 `mail.doulor.cn` 这一行，它才是准确答案。
 */
export function matchRootDomain(
  rows: readonly RootDomainRow[],
  hostOrAddress: string
): RootDomainRow | null {
  const s = hostOrAddress.trim().toLowerCase()
  if (!s) return null
  const host = s.includes("@") ? s.slice(s.indexOf("@") + 1) : s
  let best: RootDomainRow | null = null
  for (const r of rows) {
    if (host === r.name || host.endsWith(`.${r.name}`)) {
      if (!best || r.name.length > best.name.length) best = r
    }
  }
  return best
}

/** 便捷：直接按 fqdn / 邮箱查根域 */
export async function rootDomainFor(
  env: Env,
  hostOrAddress: string
): Promise<RootDomainRow | null> {
  return matchRootDomain(await listRootDomains(env), hostOrAddress)
}

/** 当前用户能否使用该根域（无 `requires_feature` 即人人可用） */
export function canUseRootDomain(
  permissions: Permissions,
  row: RootDomainRow
): boolean {
  if (row.enabled !== 1) return false
  if (!row.requires_feature) return true
  return hasFeature(permissions, row.requires_feature as never)
}

/**
 * 选根域：`requested` 为空时用默认域；非空时必须是**已启用**的域，
 * 且调用者有使用它的权限，否则 403。
 *
 * 不信任前端传来的域名字符串 —— 所有「把资源建在哪个域下」的入口都要过这里。
 */
export async function pickRootDomain(
  env: Env,
  requested: string | undefined,
  permissions: Permissions
): Promise<RootDomainRow> {
  const raw = (requested ?? "").trim().toLowerCase()
  if (!raw) return getDefaultRootDomain(env)

  const row = await getRootDomainByName(env, raw)
  if (!row) {
    throw new ApiError(400, `不支持把资源创建在 ${raw} 下`, "ROOT_DOMAIN_UNKNOWN")
  }
  if (row.enabled !== 1) {
    throw new ApiError(400, `${raw} 当前不可用`, "ROOT_DOMAIN_DISABLED")
  }
  if (!canUseRootDomain(permissions, row)) {
    throw new ApiError(
      403,
      `${raw} 需要先解锁对应权限，请联系管理员`,
      "ROOT_DOMAIN_NOT_PERMITTED"
    )
  }
  return row
}

/**
 * 该 fqdn / 邮箱地址是否属于**本站任一已登记的根域**。
 *
 * 入站邮件与「真实邮箱不能是本站邮箱」这类校验都要用它 ——
 * 只判 `env.ROOT_DOMAIN` 的话，`xxx@tyu.me` 会被当成外部地址。
 */
export async function isOwnDomain(env: Env, hostOrAddress: string): Promise<boolean> {
  return (await rootDomainFor(env, hostOrAddress)) !== null
}

/**
 * 某个用户的**主邮箱地址** = 注册时分配的那一个。
 *
 * 判据：该用户**最早创建**的非临时邮箱（注册流程只会创建一个，天然就是它）。
 * 找不到时（历史数据缺行）回落为 `<用户名>@<默认根域>`。
 *
 * ⚠️ 不能直接用 `user.username` 拼 —— **改名不迁移主邮箱**（见 settings.ts
 * 的警告文案），改名后主邮箱仍是旧前缀，用它去拼会得到一个不存在的地址。
 */
export async function primaryAddressFor(
  env: Env,
  userId: string,
  username: string
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT address FROM mailboxes WHERE user_id = ? AND is_temp = 0 ORDER BY created_at ASC, rowid ASC LIMIT 1"
  )
    .bind(userId)
    .first<{ address: string }>()
  if (row?.address) return row.address.toLowerCase()
  return `${username.toLowerCase()}@${(await getDefaultRootDomain(env)).name.toLowerCase()}`
}
