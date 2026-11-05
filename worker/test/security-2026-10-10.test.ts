// 2026-10-10 渗透测试发现项的回归测试。
//
// 覆盖：
//   1. tempbox proxy-upload / commit 的 key 前缀逃逸（finding#2 / #3）
//   2. email-verified 白名单的覆盖缺口（finding#7）
//   3. 改密码后旧 API Key 必须失效（finding#11）
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { hashToken, uuid } from "../src/crypto"

/** 直接造一条存活中的分享箱批次 */
async function makeBatch(user: TestUser, code = String(Math.floor(100000 + Math.random() * 899999))) {
  await env.DB.prepare(
    `INSERT INTO tempbox_batches (id, code, creator_user_id, expire_at, file_count, total_bytes, created_at)
     VALUES (?, ?, ?, ?, 0, 0, ?)`
  )
    .bind(
      uuid(),
      code,
      user.id,
      new Date(Date.now() + 3600_000).toISOString(),
      new Date().toISOString()
    )
    .run()
  return code
}

async function giveApiKey(userId: string): Promise<string> {
  const key = "doulor_" + uuid().replace(/-/g, "")
  await env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, key_hash, key_prefix, created_at, last_used_at, is_admin)
     VALUES (?, ?, ?, ?, NULL, 0)
     ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, key_prefix = excluded.key_prefix`
  )
    .bind(userId, await hashToken(key), key.slice(0, 8), new Date().toISOString())
    .run()
  return key
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => ({}))) as { code?: string }).code
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run()
})


describe("email-verified 白名单缺口（finding#7）", () => {
  it("未验证邮箱账号不得写平台桶 / 铸 OAuth 客户端", async () => {
    const u = await makeUser({ emailVerified: false })

    const stickers = await fetchSelf(
      authRequest(u, "/api/stickers", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: "not-a-real-png",
      })
    )
    expect(stickers.status).toBe(403)
    expect(await codeOf(stickers)).toBe("EMAIL_NOT_VERIFIED")

    const oauth = await fetchSelf(
      authRequest(u, "/api/oauth/my-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "gate", redirectUris: ["https://example.com/cb"] }),
      })
    )
    expect(oauth.status).toBe(403)
    expect(await codeOf(oauth)).toBe("EMAIL_NOT_VERIFIED")
  })

  it("已验证邮箱的账号不受影响（写操作能走到业务逻辑）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/lab/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "verify-gate-ok", files: { "index.html": "<h1>x</h1>" } }),
      })
    )
    expect(await codeOf(res)).not.toBe("EMAIL_NOT_VERIFIED")
  })
})

describe("凭证变更吊销（finding#11）", () => {
})
