import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

/** 造一条官方商品（管理员发布；owner_id 为 NULL） */
async function seedProduct(opts: {
  enabled?: number
  content?: string
  description?: string
} = {}): Promise<string> {
  const id = `p_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO point_products
       (id, name, description, price, stock, delivery, delivery_params, enabled, sort,
        created_at, updated_at, category)
     VALUES (?, '详情页商品', ?, 30, 5, 'content', ?, ?, 0, ?, ?, 'it')`
  )
    .bind(
      id,
      opts.description ?? "## 标题\n\n![](https://example.com/a.png)",
      opts.content ? JSON.stringify({ content: opts.content }) : null,
      opts.enabled ?? 1,
      now,
      now
    )
    .run()
  return id
}

describe("GET /api/points/products/:id —— 商品详情", () => {
  it("返回商品全字段，但**剥掉** deliveryParams.content（不买不能白看）", async () => {
    const u = await makeUser()
    const id = await seedProduct({ content: "买家才会拿到的正文" })
    const res = await fetchSelf(authRequest(u, `/api/points/products/${id}`))
    expect(res.status).toBe(200)
    const { product } = await res.json<{
      product: { id: string; description: string; deliveryParams: { content?: string } | null }
    }>()
    expect(product.id).toBe(id)
    expect(product.description).toContain("## 标题")
    expect(product.deliveryParams?.content).toBeUndefined()
  })

  it("已下架的商品 → 404（不通过详情页泄露）", async () => {
    const u = await makeUser()
    const id = await seedProduct({ enabled: 0 })
    const res = await fetchSelf(authRequest(u, `/api/points/products/${id}`))
    expect(res.status).toBe(404)
  })

  it("不存在的 id → 404", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/points/products/no-such-product"))
    expect(res.status).toBe(404)
  })

  it("未登录 → 401", async () => {
    const id = await seedProduct()
    const res = await fetchSelf(new Request(`https://cloud.doulor.cn/api/points/products/${id}`))
    expect(res.status).toBe(401)
  })
})
