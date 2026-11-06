/**
 * 公告可见性 & 弹窗配置（2026-11-06 排查「后台设了公告却不弹 / 消息点了没反应」）。
 *
 * 那次问题的根因是**前端侧**：概览页改版时把 `AnnouncementPopup` 一起删掉了，
 * 后端的 `popup_mode` 于是变成没有任何消费方的死配置。本文件不测 React，
 * 只锁住「后端交给前端的契约」—— 只要其中任何一条破了，前端再怎么修都弹不出来：
 *
 *   1. 草稿 / 未到点的定时公告**不能**出现在用户列表里（泄露即事故）；
 *   2. 已发布的必须带 `popupMode`，且 once / every 原样透传（前端据此决定弹不弹）；
 *   3. 创建、编辑两个入口都能改 popupMode（`none` ↔ `every`），改完立刻反映到列表；
 *   4. 分类收敛后：传已下线的模块分类（如 frp）会落成 general，而不是写入死值。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

async function makeAdmin(): Promise<TestUser> {
  return makeUser({ role: "root" })
}

async function listFor(user: TestUser) {
  const res = await fetchSelf(authRequest(user, "/api/announcements"))
  expect(res.status).toBe(200)
  return (
    (await res.json()) as {
      announcements: { id: string; title: string; popupMode: string; status: string }[]
    }
  ).announcements
}

function createAnn(body: Record<string, unknown>, admin: TestUser) {
  return fetchSelf(
    authRequest(admin, "/api/admin/announcements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

function updateAnn(id: string, body: Record<string, unknown>, admin: TestUser) {
  return fetchSelf(
    authRequest(admin, `/api/admin/announcements/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("公告可见性与弹窗配置", () => {
  it("草稿 / 未来定时公告不出现在用户列表，已发布才出现", async () => {
    const admin = await makeAdmin()
    const user = await makeUser()

    const draft = await createAnn({ title: "草稿公告", body: "x", status: "draft" }, admin)
    expect(draft.status).toBe(201)
    const draftId = ((await draft.json()) as { announcement: { id: string } }).announcement.id

    const future = new Date(Date.now() + 3600_000).toISOString()
    const scheduled = await createAnn(
      { title: "定时公告", body: "x", status: "scheduled", publishAt: future },
      admin
    )
    expect(scheduled.status).toBe(201)
    const scheduledId = ((await scheduled.json()) as { announcement: { id: string } })
      .announcement.id

    const live = await createAnn({ title: "已发布公告", body: "x", status: "published" }, admin)
    expect(live.status).toBe(201)
    const liveId = ((await live.json()) as { announcement: { id: string } }).announcement.id

    const ids = (await listFor(user)).map((a) => a.id)
    expect(ids).toContain(liveId)
    expect(ids).not.toContain(draftId)
    expect(ids).not.toContain(scheduledId)
  })

  it("已发布公告把 popupMode 原样带给用户列表（前端据此弹窗）", async () => {
    const admin = await makeAdmin()
    const user = await makeUser()

    const once = await createAnn(
      { title: "弹一次", body: "x", status: "published", popupMode: "once" },
      admin
    )
    expect(once.status).toBe(201)
    const every = await createAnn(
      { title: "每次都弹", body: "x", status: "published", popupMode: "every" },
      admin
    )
    expect(every.status).toBe(201)
    const none = await createAnn(
      { title: "不弹", body: "x", status: "published", popupMode: "none" },
      admin
    )
    expect(none.status).toBe(201)

    const byTitle = new Map((await listFor(user)).map((a) => [a.title, a.popupMode]))
    expect(byTitle.get("弹一次")).toBe("once")
    expect(byTitle.get("每次都弹")).toBe("every")
    expect(byTitle.get("不弹")).toBe("none")
  })

  it("非法 popupMode 落成 none；编辑可以把 none 改成 every", async () => {
    const admin = await makeAdmin()
    const user = await makeUser()

    const res = await createAnn(
      { title: "脏值", body: "x", status: "published", popupMode: "sometimes" },
      admin
    )
    expect(res.status).toBe(201)
    const created = ((await res.json()) as { announcement: { id: string; popupMode: string } })
      .announcement
    expect(created.popupMode).toBe("none")

    const upd = await updateAnn(created.id, { popupMode: "every" }, admin)
    expect(upd.status).toBe(200)

    const mine = (await listFor(user)).find((a) => a.id === created.id)
    expect(mine?.popupMode).toBe("every")
  })

  it("已下线模块的分类（frp/ai…）落成 general", async () => {
    const admin = await makeAdmin()
    const user = await makeUser()

    const res = await createAnn({ title: "旧分类", body: "x", category: "frp" }, admin)
    expect(res.status).toBe(201)
    const id = ((await res.json()) as { announcement: { id: string } }).announcement.id

    const row = await env.DB.prepare("SELECT category FROM announcements WHERE id = ?")
      .bind(id)
      .first<{ category: string }>()
    expect(row?.category).toBe("general")

    // 用户侧能正常看到（分类不参与过滤）
    expect((await listFor(user)).some((a) => a.id === id)).toBe(true)
  })

  it("置顶公告排在前面（pinned 优先于发布时间）", async () => {
    const admin = await makeAdmin()
    const user = await makeUser()

    // 先发一条置顶的「老」公告，再发一条更新的非置顶公告
    const pinnedRes = await createAnn({ title: "置顶老公告", body: "x", pinned: true }, admin)
    expect(pinnedRes.status).toBe(201)
    const pinnedId = ((await pinnedRes.json()) as { announcement: { id: string } })
      .announcement.id
    // 把置顶那条的时间改早，确保排序依据确实是 pinned 而不是创建时间
    await env.DB.prepare("UPDATE announcements SET created_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", pinnedId)
      .run()

    const freshRes = await createAnn({ title: "新公告", body: "x", pinned: false }, admin)
    expect(freshRes.status).toBe(201)

    const list = await listFor(user)
    expect(list[0]?.id).toBe(pinnedId)
  })
})