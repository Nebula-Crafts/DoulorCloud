/**
 * 积分商城：「统一内容」自动发货（2026-10-04 新增）。
 *
 * 需求原话（站长）：
 *   「一种是那种一次性的每个买家不一样的自动发货」—— 即已有的卡密/Key（`code`，
 *   从卡密池取，一人一条）；
 *   「一种是统一的自动发货」—— 本文件测的 `content`：所有买家拿到**同一段**固定
 *   内容（网盘链接 / 说明 / 通用兑换码），下单即到账，不消耗任何库存。
 *
 * 重点验证「错了会真丢钱或真发错东西」的几处：
 *   1. 内容为空 / 只有空白 → 商品配置非法，**下单前**就拒（不能让用户白花积分）
 *   2. 内容超长 → 拒
 *   3. 正常下单 → 订单 note 是摘要、delivery_content 是**完整原文**
 *   4. 多个买家拿到的是**同一份**内容（与卡密「一人一条」区分开）
 *   5. 内容快照不随商品改动而变（商品事后被改，历史订单仍是当时那份）
 *   6. 完整正文通过**私聊**发给买家（2026-10-06 改：此前只塞在通知里，
 *      而通知是右下角一闪而过的弹窗，站长反馈「一瞬间就没了」）
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { getPointsBalance } from "../src/points"
import { authRequest, fetchSelf, makeUser } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/** 管理员建一件「统一内容」官方商品，返回商品 id */
async function contentProduct(
  admin: U,
  opts: { content: string; price?: number; stock?: number | null }
): Promise<string> {
  const res = await fetchSelf(
    authRequest(
      admin,
      "/api/admin/points/products",
      jsonInit({
        name: "统一内容测试商品",
        price: opts.price ?? 10,
        stock: opts.stock ?? null,
        delivery: "content",
        deliveryParams: { content: opts.content },
      })
    )
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: { id: string } }).product.id
}

function buy(user: U, productId: string): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/points/shop/buy", jsonInit({ productId })))
}

/**
 * 给用户充值积分。
 *
 * `makeUser` 造出来的账号余额是 0，而下单要真扣积分 —— 不先充钱会直接
 * 400「积分不足」，测试会以一个跟被测逻辑无关的原因失败。
 */
async function givePoints(user: U, balance: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at"
  )
    .bind(user.id, balance, new Date().toISOString())
    .run()
}

/** 读订单的交付相关字段 */
async function deliveryOf(orderId: string) {
  return env.DB.prepare(
    "SELECT status, note, delivery_content FROM point_orders WHERE id = ?"
  )
    .bind(orderId)
    .first<{ status: string; note: string | null; delivery_content: string | null }>()
}

const SAMPLE = "链接：https://pan.example.com/s/abcd\n提取码：1234\n（请勿外传）"

describe("统一内容自动发货", () => {
  it("正常下单：note 是摘要、delivery_content 是完整原文", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: SAMPLE })

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)
    const order = ((await res.json()) as {
      order: { id: string; status: string; deliveryContent: string | null; note: string | null }
    }).order
    expect(order.status).toBe("delivered")
    // 完整原文原样下发（接口层就要带出来，前端才能渲染）
    expect(order.deliveryContent).toBe(SAMPLE)

    const row = await deliveryOf(order.id)
    expect(row?.status).toBe("delivered")
    expect(row?.delivery_content).toBe(SAMPLE)
    // note 只放一行摘要，不带换行、不把整段糊进去
    expect(row?.note).toContain("已自动发货")
    expect(row?.note).not.toContain("\n")
    expect(row?.note?.length ?? 0).toBeLessThanOrEqual(300)
  })

  it("多个买家拿到的是同一份内容（与卡密「一人一条」区分）", async () => {
    const admin = await makeUser({ role: "admin" })
    const a = await makeUser()
    const b = await makeUser()
    await givePoints(a, 100)
    await givePoints(b, 100)
    const pid = await contentProduct(admin, { content: SAMPLE, price: 5 })

    const ra = await buy(a, pid)
    const rb = await buy(b, pid)
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    const oa = ((await ra.json()) as { order: { id: string } }).order
    const ob = ((await rb.json()) as { order: { id: string } }).order
    expect(oa.id).not.toBe(ob.id)

    const ra2 = await deliveryOf(oa.id)
    const rb2 = await deliveryOf(ob.id)
    expect(ra2?.delivery_content).toBe(SAMPLE)
    expect(rb2?.delivery_content).toBe(SAMPLE)
  })

  it("内容为空 / 全空白 → 建商品时就被拒（不会留一个发不出东西的商品）", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of ["", "   ", "\n\n"]) {
      const res = await fetchSelf(
        authRequest(
          admin,
          "/api/admin/points/products",
          jsonInit({
            name: "坏配置",
            price: 10,
            delivery: "content",
            deliveryParams: { content: bad },
          })
        )
      )
      expect(res.status).toBe(400)
    }
  })

  it("内容超长 → 被拒", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/points/products",
        jsonInit({
          name: "超长内容",
          price: 10,
          delivery: "content",
          deliveryParams: { content: "x".repeat(2001) },
        })
      )
    )
    expect(res.status).toBe(400)
  })

  it("内容是订单快照：商品事后被改，历史订单仍是当时那份", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: "原始内容 A" })

    const res = await buy(buyer, pid)
    const order = ((await res.json()) as { order: { id: string } }).order

    // 管理员把商品内容改成 B
    const upd = await fetchSelf(
      authRequest(
        admin,
        `/api/admin/points/products/${pid}`,
        jsonInit(
          {
            name: "统一内容测试商品",
            price: 10,
            delivery: "content",
            deliveryParams: { content: "改后的内容 B" },
          },
          "PUT"
        )
      )
    )
    expect(upd.status).toBe(200)

    // 老订单不受影响
    const row = await deliveryOf(order.id)
    expect(row?.delivery_content).toBe("原始内容 A")
  })

  it("扣积分与订单一致：成功交付后余额正确减少", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: SAMPLE, price: 30 })

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)
    expect(await getPointsBalance(env, buyer.id)).toBe(70)
  })

  it("完整正文通过私聊发给买家（通知只留指路，不再糊正文）", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: SAMPLE })

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)

    // 完整原文落在**私信**里：会话可反复翻看、可复制，不会被弹窗刷掉
    const dm = await env.DB.prepare(
      "SELECT from_user_id, to_user_id, body FROM direct_messages WHERE to_user_id = ? " +
        "ORDER BY created_at DESC LIMIT 1"
    )
      .bind(buyer.id)
      .first<{ from_user_id: string; to_user_id: string; body: string }>()
    expect(dm).not.toBeNull()
    expect(dm!.to_user_id).toBe(buyer.id)
    expect(dm!.body).toContain("https://pan.example.com/s/abcd")
    expect(dm!.body).toContain("提取码：1234")

    // 通知只留一句指路（不再把整段内容塞进一闪而过的弹窗）
    const note = await env.DB.prepare(
      "SELECT body FROM notifications WHERE user_id = ? AND type = 'order_delivered' " +
        "ORDER BY created_at DESC LIMIT 1"
    )
      .bind(buyer.id)
      .first<{ body: string }>()
    expect(note?.body).toContain("私聊")
    expect(note?.body).not.toContain("提取码：1234")
  })

  it("统一内容不能设为租用（一次性发出去的文字收不回来）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/points/products",
        jsonInit({
          name: "租用统一内容",
          price: 10,
          delivery: "content",
          billingMode: "rental",
          rentalDays: 30,
          deliveryParams: { content: SAMPLE },
        })
      )
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("RENTAL_NOT_SUPPORTED")
  })
})
