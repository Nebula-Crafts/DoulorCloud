import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

/** 造一条帖子，返回 id */
async function makePost(owner: { cookie: string }): Promise<string> {
  const res = await fetchSelf(
    authRequest(owner, "/api/community/posts", {
      method: "POST",
      body: JSON.stringify({ body: "被举报的帖子" }),
      headers: { "Content-Type": "application/json" },
    })
  )
  const data = await res.json<{ post: { id: string } }>()
  return data.post.id
}

describe("POST /api/community/reports", () => {
  it("举报别人的帖子 → 201，落库 pending", async () => {
    const owner = await makeUser()
    const reporter = await makeUser()
    const postId = await makePost(owner)

    const res = await fetchSelf(
      authRequest(reporter, "/api/community/reports", {
        method: "POST",
        body: JSON.stringify({ targetType: "post", targetId: postId, reason: "spam" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(201)

    const row = await env.DB.prepare(
      "SELECT status, reason, author_id FROM post_reports WHERE target_id = ?"
    )
      .bind(postId)
      .first<{ status: string; reason: string; author_id: string }>()
    expect(row?.status).toBe("pending")
    expect(row?.reason).toBe("spam")
  })

  it("同一人重复举报同一目标 → 409 ALREADY_REPORTED", async () => {
    const owner = await makeUser()
    const reporter = await makeUser()
    const postId = await makePost(owner)
    const body = JSON.stringify({ targetType: "post", targetId: postId, reason: "abuse" })

    const r1 = await fetchSelf(
      authRequest(reporter, "/api/community/reports", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(r1.status).toBe(201)
    const r2 = await fetchSelf(
      authRequest(reporter, "/api/community/reports", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(r2.status).toBe(409)
    expect((await r2.json<{ code: string }>()).code).toBe("ALREADY_REPORTED")
  })

  it("不能举报自己的内容 → 400 SELF_REPORT", async () => {
    const owner = await makeUser()
    const postId = await makePost(owner)
    const res = await fetchSelf(
      authRequest(owner, "/api/community/reports", {
        method: "POST",
        body: JSON.stringify({ targetType: "post", targetId: postId, reason: "spam" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("SELF_REPORT")
  })

  it("非法原因 → 400", async () => {
    const owner = await makeUser()
    const reporter = await makeUser()
    const postId = await makePost(owner)
    const res = await fetchSelf(
      authRequest(reporter, "/api/community/reports", {
        method: "POST",
        body: JSON.stringify({ targetType: "post", targetId: postId, reason: "not-a-reason" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(400)
  })

  it("目标不存在 → 404", async () => {
    const reporter = await makeUser()
    const res = await fetchSelf(
      authRequest(reporter, "/api/community/reports", {
        method: "POST",
        body: JSON.stringify({ targetType: "post", targetId: "no-such-post", reason: "spam" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(404)
  })
})

describe("GET /api/admin/reports + decide", () => {
  it("普通用户看不到举报列表（403）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/admin/reports"))
    expect(res.status).toBe(403)
  })

  it("下架：内容被软删，举报状态变 removed", async () => {
    const admin = await makeUser({ role: "admin" })
    const owner = await makeUser()
    const reporter = await makeUser()
    const postId = await makePost(owner)
    await fetchSelf(
      authRequest(reporter, "/api/community/reports", {
        method: "POST",
        body: JSON.stringify({ targetType: "post", targetId: postId, reason: "illegal" }),
        headers: { "Content-Type": "application/json" },
      })
    )

    const list = await fetchSelf(authRequest(admin, "/api/admin/reports?status=pending"))
    const data = await list.json<{ reports: { id: string; targetId: string }[]; pending: number }>()
    const target = data.reports.find((r) => r.targetId === postId)!
    expect(target).toBeTruthy()
    expect(data.pending).toBeGreaterThan(0)

    const decide = await fetchSelf(
      authRequest(admin, `/api/admin/reports/${target.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ action: "remove" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(decide.status).toBe(200)

    const post = await env.DB.prepare("SELECT deleted_at FROM posts WHERE id = ?")
      .bind(postId)
      .first<{ deleted_at: string | null }>()
    expect(post?.deleted_at).toBeTruthy()

    const rep = await env.DB.prepare("SELECT status FROM post_reports WHERE id = ?")
      .bind(target.id)
      .first<{ status: string }>()
    expect(rep?.status).toBe("removed")
  })

  it("忽略：内容保留，举报状态变 ignored；重复处理 → 409", async () => {
    const admin = await makeUser({ role: "admin" })
    const owner = await makeUser()
    const reporter = await makeUser()
    const postId = await makePost(owner)
    await fetchSelf(
      authRequest(reporter, "/api/community/reports", {
        method: "POST",
        body: JSON.stringify({ targetType: "post", targetId: postId, reason: "other" }),
        headers: { "Content-Type": "application/json" },
      })
    )

    const list = await fetchSelf(authRequest(admin, "/api/admin/reports?status=pending"))
    const data = await list.json<{ reports: { id: string; targetId: string }[] }>()
    const target = data.reports.find((r) => r.targetId === postId)!

    const r1 = await fetchSelf(
      authRequest(admin, `/api/admin/reports/${target.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ action: "ignore" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(r1.status).toBe(200)

    const post = await env.DB.prepare("SELECT deleted_at FROM posts WHERE id = ?")
      .bind(postId)
      .first<{ deleted_at: string | null }>()
    expect(post?.deleted_at).toBeNull()

    const r2 = await fetchSelf(
      authRequest(admin, `/api/admin/reports/${target.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ action: "ignore" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(r2.status).toBe(409)
  })
})
