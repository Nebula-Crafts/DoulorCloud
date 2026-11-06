// 积分系统：余额 / 流水 / 兑换中转站余额 / 活动发放 / HTTP 接口。
//
// 重点验证四件事（都是「错了会真丢钱或真送钱」的地方）：
//   1. 扣减的原子性：余额不足时不能扣成负数（条件 UPDATE 的 changes=0 分支）
//   2. 幂等：同一 dedup_key 只能落账一次，并发重复不能重复发放
//   3. 兑换的安全顺序：**先扣积分、NewAPI 失败要把积分退回来**，
//      且未绑定中转站时必须在扣分之前就拦住
//   4. 活动奖励 points 类型能正常发到用户余额上
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, setPermissions } from "./helpers"
import { applyPoints, getPointsBalance, redeemPoints } from "../src/points"
import { expireRentalOrders } from "../src/points-shop"
import { resetAdminCredentialCache } from "../src/newapi-client"
import { REWARD_HANDLERS } from "../src/event-rewards"

const BASE = "https://api.doulor.cn"

let quotaCalls: { userId: number; value: number; mode: string }[] = []
let subscriptionCalls: { userId: number; planId: number }[] = []
let failManage = false
let failSubscription = false
let restore: (() => void) | null = null

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 打桩 Worker 出站 fetch：只接管发往 NewAPI 的请求，其余透传 */
function stubNewApi(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)

    if (url.includes("/api/status")) {
      return jsonResponse({
        success: true,
        data: { quota_display_type: "CNY", quota_per_unit: 500000 },
      })
    }
    if (url.includes("/api/user/manage")) {
      if (failManage) return jsonResponse({ success: false, message: "上游炸了" }, 500)
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number
        value: number
        mode: string
      }
      quotaCalls.push({ userId: body.id, value: body.value, mode: body.mode })
      return jsonResponse({ success: true, data: null })
    }
    // 开通订阅：POST /api/subscription/admin/users/:id/subscriptions
    const subMatch = url.match(/\/api\/subscription\/admin\/users\/(\d+)\/subscriptions/)
    if (subMatch) {
      if (failSubscription) return jsonResponse({ success: false, message: "套餐不存在" }, 400)
      const body = JSON.parse(String(init?.body ?? "{}")) as { plan_id: number }
      subscriptionCalls.push({ userId: Number(subMatch[1]), planId: body.plan_id })
      return jsonResponse({ success: true, data: { message: "" } })
    }
    return original(input as RequestInfo, init)
  }) as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 给用户绑一个中转站账号（兑换的前置条件） */
async function bindNewApi(userId: string, newapiUserId: number): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, newapiUserId, `na_${newapiUserId}`, `na_${newapiUserId}@doulor.cn`, "enc", now)
    .run()
}

/** 读某用户的流水条数 */
async function txCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

beforeEach(async () => {
  quotaCalls = []
  subscriptionCalls = []
  failManage = false
  failSubscription = false
  stubNewApi()
  resetAdminCredentialCache()
  // 每个用例都从「开关开、比例 1 元/积分、不限次」起步，避免相互污染
  await setSetting("points_enabled", "1")
  await setSetting("points_yuan_per_point", "1")
  await setSetting("points_redeem_daily_limit", "0")
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("积分核心：余额与流水", () => {
  it("新用户余额为 0，且不会因为读余额而建行", async () => {
    const u = await makeUser()
    expect(await getPointsBalance(env, u.id)).toBe(0)
    const row = await env.DB.prepare("SELECT 1 AS x FROM user_points WHERE user_id = ?")
      .bind(u.id)
      .first()
    expect(row).toBeNull()
  })

  it("增加积分：余额与流水同时落账", async () => {
    const u = await makeUser()
    const res = await applyPoints(env, {
      userId: u.id,
      delta: 100,
      reason: "event",
      detail: "测试发放",
    })
    expect(res.applied).toBe(true)
    expect(res.balance).toBe(100)
    expect(await getPointsBalance(env, u.id)).toBe(100)
    expect(await txCount(u.id)).toBe(1)
  })

  it("扣减积分：余额足够时正常扣", async () => {
    const u = await makeUser()
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })
    const res = await applyPoints(env, { userId: u.id, delta: -30, reason: "redeem" })
    expect(res.applied).toBe(true)
    expect(res.balance).toBe(70)
    const transactions = await env.DB.prepare(
      "SELECT delta, balance FROM point_transactions WHERE user_id = ? ORDER BY delta DESC"
    ).bind(u.id).all<{ delta: number; balance: number }>()
    expect(transactions.results?.map(({ delta, balance }) => [delta, balance])).toEqual([
      [100, 100],
      [-30, 70],
    ])
  })

  it("余额不足时不扣成负数，且不写流水", async () => {
    const u = await makeUser()
    await applyPoints(env, { userId: u.id, delta: 50, reason: "admin" })
    const res = await applyPoints(env, { userId: u.id, delta: -100, reason: "redeem" })
    expect(res.applied).toBe(false)
    expect(res.reason).toBe("insufficient")
    expect(res.balance).toBe(50)
    expect(await getPointsBalance(env, u.id)).toBe(50)
    // 只有第一笔成功的那条流水
    expect(await txCount(u.id)).toBe(1)
  })

  it("同一 dedup_key 只落账一次（幂等）", async () => {
    const u = await makeUser()
    const first = await applyPoints(env, {
      userId: u.id,
      delta: 20,
      reason: "event",
      dedupKey: "event:evt-1",
    })
    const second = await applyPoints(env, {
      userId: u.id,
      delta: 20,
      reason: "event",
      dedupKey: "event:evt-1",
    })
    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.reason).toBe("duplicated")
    // 关键：余额没有被重复加
    expect(await getPointsBalance(env, u.id)).toBe(20)
    expect(await txCount(u.id)).toBe(1)
  })

  it("并发重复发放不会通过回滚窗口制造额外余额", async () => {
    const u = await makeUser()
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        applyPoints(env, { userId: u.id, delta: 20, reason: "event", dedupKey: "event:race" })
      )
    )
    expect(results.filter((r) => r.applied)).toHaveLength(1)
    expect(await getPointsBalance(env, u.id)).toBe(20)
    expect(await txCount(u.id)).toBe(1)
  })
})

describe("活动奖励：points 类型", () => {
  it("发放积分到用户余额", async () => {
    const u = await makeUser()
    const res = await REWARD_HANDLERS.points({
      env,
      userId: u.id,
      username: u.username,
      params: { amount: 30 },
      eventId: "evt-abc",
    })
    expect(res.status).toBe("granted")
    expect(await getPointsBalance(env, u.id)).toBe(30)
  })

  it("同一活动重复发放不会翻倍（dedup 兜底）", async () => {
    const u = await makeUser()
    const ctx = {
      env,
      userId: u.id,
      username: u.username,
      params: { amount: 30 },
      eventId: "evt-dup",
    }
    await REWARD_HANDLERS.points(ctx)
    const again = await REWARD_HANDLERS.points(ctx)
    expect(again.status).toBe("granted")
    expect(await getPointsBalance(env, u.id)).toBe(30)
  })

  it("积分数非法时返回 failed", async () => {
    const u = await makeUser()
    const res = await REWARD_HANDLERS.points({
      env,
      userId: u.id,
      username: u.username,
      params: { amount: 0 },
      eventId: "evt-bad",
    })
    expect(res.status).toBe("failed")
  })
})

describe("HTTP 接口", () => {
  it("未登录访问 /api/points 返回 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/points"))
    expect(res.status).toBe(401)
  })

  it("非管理员访问 /api/admin/points 返回 403", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/admin/points"))
    expect(res.status).toBe(403)
  })
})

describe("管理端调整积分", () => {
  it("管理员发放与扣减，扣减超额时报错", async () => {
    const admin = await makeUser({ role: "admin" })
    const target = await makeUser()

    const grant = await fetchSelf(
      authRequest(admin, "/api/admin/points/adjust", {
        method: "POST",
        body: JSON.stringify({ username: target.username, delta: 80, detail: "活动补发" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(grant.status).toBe(200)
    expect(((await grant.json()) as { balance: number }).balance).toBe(80)

    const deduct = await fetchSelf(
      authRequest(admin, "/api/admin/points/adjust", {
        method: "POST",
        body: JSON.stringify({ username: target.username, delta: -30 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(deduct.status).toBe(200)
    expect(((await deduct.json()) as { balance: number }).balance).toBe(50)

    const over = await fetchSelf(
      authRequest(admin, "/api/admin/points/adjust", {
        method: "POST",
        body: JSON.stringify({ username: target.username, delta: -999 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(over.status).toBe(400)
    expect(await getPointsBalance(env, target.id)).toBe(50)
  })

  it("总览列表包含 0 积分用户", async () => {
    const admin = await makeUser({ role: "admin" })
    const target = await makeUser()

    const res = await fetchSelf(authRequest(admin, "/api/admin/points"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: { username: string; balance: number }[] }
    const found = body.users.find((u) => u.username === target.username)
    expect(found).toBeDefined()
    expect(found?.balance).toBe(0)
  })

  it("总览列表带 uid / 邮箱，且按注册时间倒序", async () => {
    const admin = await makeUser({ role: "admin" })
    const first = await makeUser()
    const second = await makeUser()

    const res = await fetchSelf(authRequest(admin, "/api/admin/points"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      users: { username: string; uid: number | null; email: string }[]
    }
    const iFirst = body.users.findIndex((u) => u.username === first.username)
    const iSecond = body.users.findIndex((u) => u.username === second.username)
    expect(iFirst).toBeGreaterThanOrEqual(0)
    expect(iSecond).toBeGreaterThanOrEqual(0)
    // 后注册的排在前面（与「用户」标签的列表一致）
    expect(iSecond).toBeLessThan(iFirst)
    expect(body.users[iSecond].email).toBe(`${second.username}@doulor.cn`)
  })
})

// ---- 积分商城 ----

/** 以管理员身份建一个商品，返回商品对象 */
async function addProduct(
  admin: Awaited<ReturnType<typeof makeUser>>,
  payload: Record<string, unknown>
): Promise<{
  id: string
  name: string
  price: number
  stock: number | null
  icon: string | null
  deliveryParams: { feature?: string; planId?: number; count?: number } | null
}> {
  const res = await fetchSelf(
    authRequest(admin, "/api/admin/points/products", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    })
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: never }).product
}

/** 用户下单，返回原始 Response */
function buy(user: Awaited<ReturnType<typeof makeUser>>, productId: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/points/shop/buy", {
      method: "POST",
      body: JSON.stringify({ productId }),
      headers: { "Content-Type": "application/json" },
    })
  )
}

describe("积分商城：商品管理", () => {
  it("建商品 → 用户端可见；下架后不可见", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const p = await addProduct(admin, {
      name: "测试商品",
      price: 10,
      delivery: "manual",
      icon: "gift",
    })

    const list1 = (await (await fetchSelf(authRequest(user, "/api/points"))).json()) as {
      products: { id: string; icon: string | null }[]
    }
    expect(list1.products.map((x) => x.id)).toContain(p.id)
    // 图标要原样带给用户端（前端靠它选 lucide 组件）
    expect(list1.products.find((x) => x.id === p.id)?.icon).toBe("gift")

    // 下架
    const off = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "测试商品", price: 10, delivery: "manual", enabled: false }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(off.status).toBe(200)

    const list2 = (await (await fetchSelf(authRequest(user, "/api/points"))).json()) as {
      products: { id: string }[]
    }
    expect(list2.products.map((x) => x.id)).not.toContain(p.id)
  })

  it("自动充值商品必须填写每件充值金额", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/points/products", {
        method: "POST",
        body: JSON.stringify({ name: "充值卡", price: 10, delivery: "quota" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(400)
  })

  it("售价必须是正整数，名称不能为空", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of [
      { name: "", price: 10, delivery: "manual" },
      { name: "x", price: 0, delivery: "manual" },
      { name: "x", price: -5, delivery: "manual" },
      { name: "x", price: 1.5, delivery: "manual" },
    ]) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/products", {
          method: "POST",
          body: JSON.stringify(bad),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status).toBe(400)
    }
  })

  it("图标：合法 slug 原样存、大小写与空格归一化、空值存 null", async () => {
    const admin = await makeUser({ role: "admin" })

    const a = await addProduct(admin, {
      name: "带图标",
      price: 1,
      delivery: "manual",
      icon: "credit-card",
    })
    expect(a.icon).toBe("credit-card")

    // 大小写 + 前后空格都归一化成小写 slug
    const b = await addProduct(admin, {
      name: "大写图标",
      price: 1,
      delivery: "manual",
      icon: "  GIFT  ",
    })
    expect(b.icon).toBe("gift")

    // 没传 / 空串 / null 一律存 null（前端回退默认图标）
    for (const raw of [undefined, "", "   ", null]) {
      const p = await addProduct(admin, {
        name: "无图标",
        price: 1,
        delivery: "manual",
        icon: raw,
      })
      expect(p.icon).toBeNull()
    }
  })

  it("图标：非 slug 的字符串被 400 拒绝（不落库）", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of ["../etc/passwd", "a b", "<script>", "gift;drop", "a".repeat(41)]) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/products", {
          method: "POST",
          body: JSON.stringify({ name: "x", price: 1, delivery: "manual", icon: bad }),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status).toBe(400)
    }
  })

  it("编辑商品能改图标，也能清空", async () => {
    const admin = await makeUser({ role: "admin" })
    const p = await addProduct(admin, {
      name: "改图标",
      price: 5,
      delivery: "manual",
      icon: "gift",
    })
    expect(p.icon).toBe("gift")

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "改图标",
          price: 5,
          delivery: "manual",
          icon: "crown",
        }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { product: { icon: string | null } }
    expect(body.product.icon).toBe("crown")

    // 清空 → null
    const cleared = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "改图标", price: 5, delivery: "manual", icon: null }),
        headers: { "Content-Type": "application/json" },
      })
    )
    const clearedBody = (await cleared.json()) as { product: { icon: string | null } }
    expect(clearedBody.product.icon).toBeNull()
  })

  it("非管理员访问管理端商城接口返回 403", async () => {
    const u = await makeUser()
    const shop = await fetchSelf(authRequest(u, "/api/admin/points/shop"))
    expect(shop.status).toBe(403)
    const create = await fetchSelf(
      authRequest(u, "/api/admin/points/products", {
        method: "POST",
        body: JSON.stringify({ name: "x", price: 1, delivery: "manual" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(create.status).toBe(403)
  })
})

describe("积分商城：下单", () => {
  it("买人工发放商品：立刻扣积分，订单待发放", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, { name: "人工发货", price: 30, delivery: "manual" })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string }; balance: number }
    expect(body.order.status).toBe("pending")
    expect(body.balance).toBe(70)
    expect(await getPointsBalance(env, user.id)).toBe(70)
    expect(await txCount(user.id)).toBe(2) // 发放 + 购买
  })

  it("积分不足：拒绝且不建订单、不扣分", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 10, reason: "admin" })
    const p = await addProduct(admin, { name: "太贵了", price: 30, delivery: "manual" })

    const res = await buy(user, p.id)
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, user.id)).toBe(10)
    const orders = await env.DB.prepare("SELECT COUNT(*) AS c FROM point_orders WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>()
    expect(Number(orders?.c ?? 0)).toBe(0)
  })

  it("每人限购生效", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "限购一件",
      price: 10,
      delivery: "manual",
      perUserLimit: 1,
    })

    expect((await buy(user, p.id)).status).toBe(200)
    const again = await buy(user, p.id)
    expect(again.status).toBe(400)
    expect(await getPointsBalance(env, user.id)).toBe(90)
  })

  it("限量商品：卖完后拒绝购买（不扣分）", async () => {
    const admin = await makeUser({ role: "admin" })
    const a = await makeUser()
    const b = await makeUser()
    await applyPoints(env, { userId: a.id, delta: 100, reason: "admin" })
    await applyPoints(env, { userId: b.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, { name: "只剩一件", price: 10, delivery: "manual", stock: 1 })

    expect((await buy(a, p.id)).status).toBe(200)
    const soldOut = await buy(b, p.id)
    expect(soldOut.status).toBe(400)
    expect(await getPointsBalance(env, b.id)).toBe(100)
  })

  it("商品不存在 / 已下架时拒绝下单", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })

    expect((await buy(user, "not-exist")).status).toBe(404)

    const p = await addProduct(admin, {
      name: "已下架",
      price: 10,
      delivery: "manual",
      enabled: false,
    })
    expect((await buy(user, p.id)).status).toBe(400)
  })
})

describe("积分商城：管理端订单", () => {
  it("标记已发放；重复标记报冲突", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, { name: "待发货", price: 20, delivery: "manual" })

    const bought = (await (await buy(user, p.id)).json()) as { order: { id: string } }
    const orderId = bought.order.id

    const list = (await (
      await fetchSelf(authRequest(admin, "/api/admin/points/shop?status=pending"))
    ).json()) as { orders: { id: string; status: string }[] }
    expect(list.orders.map((o) => o.id)).toContain(orderId)

    const deliver = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${orderId}/deliver`, {
        method: "POST",
        body: JSON.stringify({ note: "已发到邮箱" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(deliver.status).toBe(200)
    expect(((await deliver.json()) as { order: { status: string } }).order.status).toBe("delivered")

    const again = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${orderId}/deliver`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(again.status).toBe(409)
  })

})

// ---- 新增的三种自动交付方式（权限 / 订阅 / 邀请码额度）----
//
// 这三种都是「下单即真的发出去」，错了会真给用户东西或真丢积分，
// 所以既测成功路径（发了什么、积分扣了多少），也测前置拦截（不该发的必须
// 在扣积分之前拒掉）。
describe("积分商城：权限 / 订阅 / 邀请码额度", () => {
  it("参数校验：模块名、套餐 ID、额度数量非法时拒绝建商品", async () => {
    const admin = await makeUser({ role: "admin" })
    const bad = [
      { delivery: "feature", deliveryParams: {} },
      { delivery: "feature", deliveryParams: { feature: "nope" } },
      { delivery: "feature", deliveryParams: { feature: "../../etc" } },
      { delivery: "subscription", deliveryParams: {} },
      { delivery: "subscription", deliveryParams: { planId: 0 } },
      { delivery: "subscription", deliveryParams: { planId: -3 } },
      { delivery: "subscription", deliveryParams: { planId: 1.5 } },
      { delivery: "invite_quota", deliveryParams: {} },
      { delivery: "invite_quota", deliveryParams: { count: 0 } },
      { delivery: "invite_quota", deliveryParams: { count: 99999 } },
    ]
    for (const p of bad) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/products", {
          method: "POST",
          body: JSON.stringify({ name: "x", price: 10, ...p }),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status, JSON.stringify(p)).toBe(400)
    }
  })

  it("增加邀请码额度：下单后 invite_quota_bonus 增加", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "多建 3 个邀请码",
      price: 20,
      delivery: "invite_quota",
      deliveryParams: { count: 3 },
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string; note: string | null } }
    expect(body.order.status).toBe("delivered")
    expect(body.order.note).toContain("3")

    const row = await env.DB.prepare("SELECT invite_quota_bonus FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ invite_quota_bonus: number }>()
    expect(Number(row?.invite_quota_bonus)).toBe(3)
    expect(await getPointsBalance(env, user.id)).toBe(80)
  })
})

// ---- 用户商城（用户上架自己的商品 + 担保交易）----
//
// 这一组盯的是「钱会不会错手」：
//   · 用户商品必须**审核通过**才可买（不能拿 id 直接买待审核的）
//   · 不能买自己的东西（否则可以把积分在自己账号间倒手）
//   · 担保：买家付的钱在买家确认收货前**不能**出现在卖家账上
//   · 取消订单要原路退买家，且不能退两次

/** 用户上架商品，返回商品对象 */
async function uploadProduct(
  user: Awaited<ReturnType<typeof makeUser>>,
  payload: Record<string, unknown>
): Promise<{
  id: string
  delivery: string
  reviewStatus: string
  ownerId: string | null
  ownerName: string | null
  perUserLimit: number | null
  sort: number
}> {
  const res = await fetchSelf(
    authRequest(user, "/api/points/products", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    })
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: never }).product
}

/** 管理员审核 */
function review(
  admin: Awaited<ReturnType<typeof makeUser>>,
  id: string,
  approve: boolean,
  note?: string
): Promise<Response> {
  return fetchSelf(
    authRequest(admin, `/api/admin/points/products/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ approve, note }),
      headers: { "Content-Type": "application/json" },
    })
  )
}

/** 读用户端整页数据（官方商品 / 用户商品 / 我的商品 / 我收到的订单） */
async function overview(user: Awaited<ReturnType<typeof makeUser>>): Promise<{
  products: { id: string }[]
  userProducts: { id: string }[]
  myProducts: { id: string; reviewStatus: string }[]
  orders: { id: string; status: string; sellerId: string | null }[]
  sellerOrders: { id: string; status: string }[]
}> {
  const res = await fetchSelf(authRequest(user, "/api/points"))
  expect(res.status).toBe(200)
  return (await res.json()) as never
}

/** 两个 ISO 时间相差多少天（租期断言用；浮点比较留 0.01 天容差） */
function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
}

/** 读订单行（租期快照断言用） */
async function orderRow(id: string) {
  return env.DB.prepare(
    "SELECT status, billing_mode, rental_days, expires_at, seller_id FROM point_orders WHERE id = ?"
  )
    .bind(id)
    .first<{
      status: string
      billing_mode: string
      rental_days: number | null
      expires_at: string | null
      seller_id: string | null
    }>()
}
