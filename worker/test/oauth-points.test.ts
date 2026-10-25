/**
 * 积分互通测试（2026-10-25）：外部 OAuth 应用经 /api/v1/points/* 查询与消费积分。
 *
 * 覆盖：
 *   1. 正常链路：建应用（points scope）→ 用户授权 → code 换 token → 查余额 → 消费
 *   2. 幂等：同一 requestId 重试不重复扣
 *   3. 安全边界：无 points scope 的令牌 403 / 假令牌 401 / 金额非法 400 /
 *      余额不足 409 / 单笔超限 400 / 停用账号 403
 *   4. userinfo 在 points scope 下带 points_balance
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { issueAccessToken } from "../src/oauth-provider"

const BASE = "https://cloud.doulor.cn"

/** 直接给用户发分（绕开业务接口，测试只关心积分互通本身） */
async function grantPoints(userId: string, amount: number, dedupKey: string): Promise<void> {
  const { applyPoints } = await import("../src/points")
  await applyPoints(env, {
    userId,
    delta: amount,
    reason: "admin",
    detail: "测试发放",
    dedupKey,
  })
}

async function bearerGet(token: string, path: string): Promise<Response> {
  return fetchSelf(new Request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }))
}

async function bearerPost(token: string, path: string, body: unknown): Promise<Response> {
  return fetchSelf(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  )
}

describe("积分互通：/api/v1/points/*", () => {
  it("正常链路：授权 points scope → 查余额 → 消费 → 余额随之下降", async () => {
    const user = await makeUser()
    await grantPoints(user.id, 1000, `test-oauthpts-${user.id}`)

    // 直接签发一枚 points scope 令牌（授权码流程由 oauth-provider.test.ts 覆盖）
    const token = await issueAccessToken(env, {
      clientId: "test-points-client",
      userId: user.id,
      scopes: "openid points",
    })

    // 1. 查余额
    const bal = await bearerGet(token.accessToken, "/api/v1/points/balance")
    expect(bal.status).toBe(200)
    const balBody = await bal.json<{ balance: number; username: string }>()
    expect(balBody.balance).toBe(1000)
    expect(balBody.username).toBe(user.username)

    // 2. 消费 200
    const spend = await bearerPost(token.accessToken, "/api/v1/points/spend", {
      amount: 200,
      description: "买个月卡",
      requestId: "order-1",
    })
    expect(spend.status).toBe(200)
    const spendBody = await spend.json<{ applied: boolean; balance: number }>()
    expect(spendBody.applied).toBe(true)
    expect(spendBody.balance).toBe(800)

    // 3. 幂等：同一 requestId 重试 → 返回成功但余额不变
    const again = await bearerPost(token.accessToken, "/api/v1/points/spend", {
      amount: 200,
      requestId: "order-1",
    })
    expect(again.status).toBe(200)
    const againBody = await again.json<{ applied: boolean; duplicated: boolean; balance: number }>()
    expect(againBody.duplicated).toBe(true)
    expect(againBody.balance).toBe(800)

    // 4. 流水里能看出是哪个应用花的（created_by = clientId）
    const tx = await env.DB.prepare(
      "SELECT delta, reason, app_client_id FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(user.id)
      .first<{ delta: number; reason: string; app_client_id: string }>()
    expect(tx?.delta).toBe(-200)
    expect(tx?.reason).toBe("app")
    expect(tx?.app_client_id).toBe("test-points-client")
  })

  it("无 points scope 的令牌 → 403 SCOPE_DENIED", async () => {
    const user = await makeUser()
    const token = await issueAccessToken(env, {
      clientId: "test-plain-client",
      userId: user.id,
      scopes: "openid profile",
    })
    const res = await bearerGet(token.accessToken, "/api/v1/points/balance")
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("SCOPE_DENIED")
  })

  it("无效令牌 → 401；金额非法 → 400；余额不足 → 409", async () => {
    const fake = await bearerGet("not-a-real-token", "/api/v1/points/balance")
    expect(fake.status).toBe(401)

    const user = await makeUser()
    await grantPoints(user.id, 50, `test-oauthpts2-${user.id}`)
    const token = await issueAccessToken(env, {
      clientId: "test-edge-client",
      userId: user.id,
      scopes: "points",
    })

    const badAmount = await bearerPost(token.accessToken, "/api/v1/points/spend", { amount: 0 })
    expect(badAmount.status).toBe(400)

    const tooBig = await bearerPost(token.accessToken, "/api/v1/points/spend", { amount: 999999 })
    expect(tooBig.status).toBe(400)

    const insufficient = await bearerPost(token.accessToken, "/api/v1/points/spend", {
      amount: 100,
    })
    expect(insufficient.status).toBe(409)
    expect((await insufficient.json<{ code: string }>()).code).toBe("INSUFFICIENT_POINTS")
  })

  it("停用账号的令牌 → 403", async () => {
    const user = await makeUser()
    await grantPoints(user.id, 100, `test-oauthpts3-${user.id}`)
    const token = await issueAccessToken(env, {
      clientId: "test-susp-client",
      userId: user.id,
      scopes: "points",
    })
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(user.id).run()

    const res = await bearerGet(token.accessToken, "/api/v1/points/balance")
    expect(res.status).toBe(403)
  })

  it("userinfo 在 points scope 下带 points_balance，没有该 scope 时不带", async () => {
    const user = await makeUser()
    await grantPoints(user.id, 123, `test-oauthpts4-${user.id}`)
    const withScope = await issueAccessToken(env, {
      clientId: "test-ui-client",
      userId: user.id,
      scopes: "openid points",
    })
    const res1 = await bearerGet(withScope.accessToken, "/api/oauth/userinfo")
    expect(res1.status).toBe(200)
    expect((await res1.json<{ points_balance: number }>()).points_balance).toBe(123)

    const withoutScope = await issueAccessToken(env, {
      clientId: "test-ui-client",
      userId: user.id,
      scopes: "openid",
    })
    const res2 = await bearerGet(withoutScope.accessToken, "/api/oauth/userinfo")
    const body2 = await res2.json<Record<string, unknown>>()
    expect(body2.points_balance).toBeUndefined()
  })
})
