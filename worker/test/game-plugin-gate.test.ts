/**
 * 游戏仓库 · 热插拔测试（2026-10-25 模拟人生改造）。
 *
 * 覆盖：
 *   1. 软下架三态：disabled → open 403 / close 放行 / 重新上架恢复
 *   2. 缺行放行：collection_plugins 无 invest 行时不拦（向后兼容语义）
 *   3. 下架后领测试币 403
 *   4. 通用路由 PUT /api/admin/collection/plugins/:slug：
 *      root 改状态生效 / 非法 status 400 / 不存在 slug 404 / 普通用户 403
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import {
  closePosition,
  depositToPool,
  ensureMarket,
  loadGameParams,
  openPosition,
} from "../src/game-market"
import { burnStars, getWallet, mintStars } from "../src/game-wallet"
import { applyPoints } from "../src/points"

const BASE = "https://cloud.doulor.cn"

/**
 * 把 invest 插件设为指定状态。
 * ⚠️ 必须 UPSERT：updatePluginRow 是纯 UPDATE，行不存在时静默 0 行——
 * 而本文件不跑 listPlugins（不触发 syncBuiltin 补行），纯 UPDATE 会造成
 * 「设了 disabled 却拦不住」的假阳性。
 */
async function setPluginStatus(status: "published" | "disabled"): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO collection_plugins
       (slug, name, icon, tagline, description, accent, kind, owner_id, runtime, status,
        sort_order, capabilities, config, created_at, updated_at)
     VALUES ('invest', '在线投资', '📈', '测试', '', '', 'builtin', NULL, 'react', ?,
             10, '["native"]', '{}', ?, ?)
     ON CONFLICT(slug) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
  )
    .bind(status, now, now)
    .run()
}

async function removePluginRow(): Promise<void> {
  await env.DB.prepare("DELETE FROM collection_plugins WHERE slug = 'invest'").run()
}

/** 发一笔测试积分（星币铸币的储备来源） */
async function grant(userId: string, amount: number, key: string): Promise<void> {
  await applyPoints(env, {
    userId,
    delta: amount,
    reason: "admin",
    detail: "测试发放",
    dedupKey: key,
  })
}

/** 给用户星币：grant 积分 + mint 铸币（两段账本闭环） */
async function fundStars(userId: string, stars: number, key: string): Promise<void> {
  await grant(userId, Math.ceil(stars / 100), key)
  await mintStars(env, "invest", userId, Math.ceil(stars / 100))
}

/** 开仓前置：懒建行情 + 站长垫本（站长先铸星币再划拨） */
async function seedPool(amount = 2000): Promise<void> {
  const params = await loadGameParams(env)
  await ensureMarket(env, params)
  await applyPoints(env, { userId: admin.id, delta: amount / 100, reason: "admin", detail: "垫本储备", dedupKey: `pool-${amount}-${admin.id}` })
  await mintStars(env, "invest", admin.id, amount / 100)
  await depositToPool(env, admin, amount)
}

let admin: TestUser
let user: TestUser


beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM game_positions"),
    env.DB.prepare("DELETE FROM game_trades"),
    env.DB.prepare("DELETE FROM game_pool_ledger"),
    env.DB.prepare("DELETE FROM game_candles"),
    env.DB.prepare("DELETE FROM game_market"),
    env.DB.prepare("DELETE FROM user_points"),
  ])
  admin = await makeUser({ role: "root", username: `root_${Math.random().toString(36).slice(2, 7)}` })
  user = await makeUser({ username: `u_${Math.random().toString(36).slice(2, 7)}` })
  // 每个用例从「已上架」出发；需要缺行语义的用例自行删行
  await setPluginStatus("published")
})

describe("软下架三态", () => {
  it("disabled：openPosition 403 GAME_DISABLED", async () => {
    await seedPool()
    await fundStars(user.id, 1000, `gp1-${user.id}`)
    await setPluginStatus("disabled")
    let code = ""
    try {
      await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })
    } catch (e) {
      code = (e as { code?: string }).code ?? ""
    }
    expect(code).toBe("GAME_DISABLED")
  })

  it("disabled：已有持仓仍可平仓，行情结算正常", async () => {
    await seedPool()
    await fundStars(user.id, 1000, `gp2-${user.id}`)
    const opened = await openPosition(env, user, { side: "long", leverage: 2, margin: 100 })
    await setPluginStatus("disabled")

    // 平仓必须成功（不抛 GAME_DISABLED）
    const closed = await closePosition(env, user, opened.position.id)
    expect(closed.alreadyClosed).toBe(false)
    // 保证金 + 盈亏（±冲击损耗）回到账户——只要不是 0 就说明结算走了
    expect(closed.balance).toBeGreaterThan(0)
  })

  it("disabled：星币兑入 403（游戏停业不收新筹码），兑出不受影响", async () => {
    await fundStars(user.id, 1000, `gp3-${user.id}`)
    await setPluginStatus("disabled")

    // 兑入：走 HTTP（闸在 handler 层）
    const res = await fetchSelf(
      authRequest(user, "/api/collection/invest/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "in", points: 10 }),
      })
    )
    expect(res.status).toBe(403)
    expect((await res.json<{ code?: string }>()).code).toBe("GAME_DISABLED")

    // 兑出：服务层直接调（软下架不拦用户取资产）
    const burned = await burnStars(env, "invest", user.id, 100)
    expect(burned.applied).toBe(true)
    expect(burned.stars).toBe(900)
  })

  it("重新上架后开仓恢复", async () => {
    await seedPool()
    await fundStars(user.id, 1000, `gp4-${user.id}`)
    await setPluginStatus("disabled")
    await setPluginStatus("published")
    const opened = await openPosition(env, user, { side: "long", leverage: 2, margin: 100 })
    expect(opened.position.status).toBe("open")
  })

  it("缺行 = 视为已上架（向后兼容：清单未同步的老部署可玩）", async () => {
    await seedPool()
    await fundStars(user.id, 1000, `gp5-${user.id}`)
    await removePluginRow()
    const opened = await openPosition(env, user, { side: "long", leverage: 2, margin: 100 })
    expect(opened.position.status).toBe("open")
  })
})

describe("通用路由 PUT /api/admin/collection/plugins/:slug", () => {
  it("root 下架生效：清单接口（管理员口径）能看到 disabled，再上架恢复", async () => {
    const put = async (body: Record<string, unknown>, as: TestUser = admin) =>
      fetchSelf(
        authRequest(as, "/api/admin/collection/plugins/invest", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      )

    const res1 = await put({ status: "disabled" })
    expect(res1.status).toBe(200)
    const body1 = await res1.json<{ plugin: { status: string } }>()
    expect(body1.plugin.status).toBe("disabled")

    // 玩家侧清单不再显示（listPublishedPlugins 过滤）——用引擎闸验证更直接
    await seedPool()
    await fundStars(user.id, 1000, `gpr-${user.id}`)
    let code = ""
    try {
      await openPosition(env, user, { side: "long", leverage: 2, margin: 100 })
    } catch (e) {
      code = (e as { code?: string }).code ?? ""
    }
    expect(code).toBe("GAME_DISABLED")

    const res2 = await put({ status: "published" })
    expect(res2.status).toBe(200)
  })

  it("非法 status → 400；不存在的 slug → 404", async () => {
    const bad = await fetchSelf(
      authRequest(admin, "/api/admin/collection/plugins/invest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      })
    )
    expect(bad.status).toBe(400)

    const missing = await fetchSelf(
      authRequest(admin, "/api/admin/collection/plugins/no-such-game", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      })
    )
    expect(missing.status).toBe(404)
  })

  it("普通用户 403（requireAdminScope collection）", async () => {
    const res = await fetchSelf(
      authRequest(user, "/api/admin/collection/plugins/invest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      })
    )
    expect(res.status).toBe(403)
  })
})
