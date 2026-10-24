// 捐献自动审核开关 + frp 的静态校验。
//
// 覆盖两件事：
//   1. `auto_review_features` 开关：关掉某模块后，该模块提交不再自动审核（转人工）。
//   2. frp 的 config.yml 静态校验（仅语法 + serverAddr，不验证连通性）。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"
import { parseAutoReviewFeatures } from "../src/handlers/donations"
import { parsePermissions } from "../src/permissions"
import { installOkTcpStub, restoreTcpStub } from "./tcp-stub"

const SUB_HOST = "https://sub.example.com"
const VALID_SUB = [
  "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?type=ws&security=tls#香港",
].join("\n")

let calls: string[] = []
let restores: Array<() => void> = []

function stubFetch(handler: (url: string) => Response | undefined): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return handler(url) ?? original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
}

beforeEach(() => {
  calls = []
  // 沙箱没有真实出网 TCP：让探活结论可控（否则「连不上 → 转人工」会误伤所有期望 approved 的用例）
  installOkTcpStub()
  return env.DB.prepare("DELETE FROM proxy_subscriptions").run()
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  restoreTcpStub()
  vi.restoreAllMocks()
})

async function setAutoReview(features: string[]): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('auto_review_features', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(features.join(","), new Date().toISOString())
    .run()
}

async function makeDonor(): Promise<TestUser> {
  const user = await makeUser()
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
    .bind(`${user.username}@example.net`, user.id)
    .run()
  await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, proxy: false }))
  return user
}

async function submit(user: TestUser, type: string, payload: Record<string, unknown>) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    })
  )
  return { res, body: (await res.json()) as Record<string, unknown> }
}

async function permsOf(userId: string) {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  return parsePermissions(row?.permissions)
}

describe("parseAutoReviewFeatures", () => {
  it("解析逗号分隔，忽略未知与重复", () => {
    expect(parseAutoReviewFeatures("ai,proxy")).toEqual(["ai", "proxy"])
    expect(parseAutoReviewFeatures("ai,bogus,proxy,ai")).toEqual(["ai", "proxy"])
    expect(parseAutoReviewFeatures("")).toEqual([])
    expect(parseAutoReviewFeatures(null)).toEqual([])
    expect(parseAutoReviewFeatures(" AI , PROXY ")).toEqual(["ai", "proxy"])
  })
})

describe("自动审核开关", () => {
  it("关闭 proxy 自动审核后，代理捐献转为待人工（不自动通过/拒绝）", async () => {
    await setAutoReview(["ai"]) // 只留 ai 自动，proxy 关闭
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SUB_HOST) ? new Response(VALID_SUB) : undefined))

    const { res, body } = await submit(user, "proxy", { subUrls: [`${SUB_HOST}/sub`] })
    expect(res.status).toBe(201) // 转人工 = 待审核，201（非 200 自动判定）
    expect(body.status).toBe("pending")
    expect(body.autoReviewed).toBe(false)
    // 没有解锁，也没有导入
    expect((await permsOf(user.id)).proxy).toBe(false)
    const subs = await env.DB.prepare("SELECT COUNT(*) c FROM proxy_subscriptions").first<{ c: number }>()
    expect(subs?.c).toBe(0)
  })

  it("全部关闭（空串）时 AI 捐献也转人工", async () => {
    await setAutoReview([])
    const user = await makeDonor()
    const { body } = await submit(user, "ai", {
      baseUrl: "https://up.example.com",
      apiKey: "sk-x",
      models: ["m1"],
    })
    expect(body.status).toBe("pending")
    expect(body.autoReviewed).toBe(false)
  })
})

describe("代理捐献自动审核：判据必须区分「没能验证」与「确定不可用」", () => {
  // 线上实测（2026-09-25）：9 笔自动拒绝里有 4 笔的原始原因是 `HTTP 403`
  // （订阅站拦我们的 User-Agent / 风控），这些链接换个网络拉取完全正常。
  // 「拉不动」不等于「链接不可用」，这类必须转人工而不是自动拒绝。
  it("订阅站返回 403 → 转人工，绝不自动拒绝", async () => {
    await setAutoReview(["proxy"])
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(SUB_HOST) ? new Response("forbidden", { status: 403 }) : undefined
    )

    const { res, body } = await submit(user, "proxy", { subUrls: [`${SUB_HOST}/sub`] })
    expect(body.status).toBe("pending")
    expect(res.status).toBe(201)
    expect(body.autoReviewed).toBe(true)
    expect(String(body.reviewNote)).toContain("403")
    expect((await permsOf(user.id)).proxy).toBe(false)
    const subs = await env.DB.prepare("SELECT COUNT(*) c FROM proxy_subscriptions").first<{ c: number }>()
    expect(subs?.c).toBe(0)
  })

  it("订阅站先 500 后 200 → 重试一次即通过（抖动不该判死）", async () => {
    await setAutoReview(["proxy"])
    const user = await makeDonor()
    let hits = 0
    stubFetch((url) => {
      if (!url.startsWith(SUB_HOST)) return undefined
      hits += 1
      return hits === 1 ? new Response("bad gateway", { status: 502 }) : new Response(VALID_SUB)
    })

    const { body } = await submit(user, "proxy", { subUrls: [`${SUB_HOST}/sub`] })
    expect(body.status).toBe("approved")
    // 原断言是 `toBe(2)`，但**探活会自己再抓一次订阅**（`probeSubscriptionNodeHealth`
    // 内部独立调 fetchSubscriptionText），所以这里实际是 3 次。这里只钉「确实重试过」
    // —— 这条用例要证明的是「抖动不该判死」，不是探活抓了几次正文。
    expect(hits).toBeGreaterThanOrEqual(2) // 第一次 502 → 重试
    expect((await permsOf(user.id)).proxy).toBe(true)
  })

  it("内容拉到了但不是节点列表（HTML 落地页）→ 才自动拒绝", async () => {
    await setAutoReview(["proxy"])
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(SUB_HOST)
        ? new Response("<!DOCTYPE html><html><body>请使用客户端订阅</body></html>")
        : undefined
    )

    const { body } = await submit(user, "proxy", { subUrls: [`${SUB_HOST}/sub`] })
    expect(body.status).toBe("rejected")
    expect(String(body.reviewNote)).toContain("网页")
    expect((await permsOf(user.id)).proxy).toBe(false)
  })

  it("Clash YAML 订阅（机场最常见的格式）→ 正常通过", async () => {
    await setAutoReview(["proxy"])
    const user = await makeDonor()
    const clashYaml = [
      "mixed-port: 7890",
      "proxies:",
      '  - {name: "香港 01", type: vless, server: hk1.example.com, port: 443, uuid: aaaaaaaa-0000-0000-0000-000000000001, tls: true, servername: edge.example.com, network: ws, ws-opts: {path: /ray}}',
      '  - {name: "日本 01", type: trojan, server: jp1.example.com, port: 443, password: p}',
      "",
    ].join("\n")
    stubFetch((url) => (url.startsWith(SUB_HOST) ? new Response(clashYaml) : undefined))

    const { body } = await submit(user, "proxy", { subUrls: [`${SUB_HOST}/sub`] })
    expect(body.status).toBe("approved")
    expect((await permsOf(user.id)).proxy).toBe(true)
    expect(String(body.reviewNote)).toContain("共 2 个节点")
  })
})


