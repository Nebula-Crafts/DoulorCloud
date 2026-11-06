/**
 * 回归测试：「限时开放注册」期间每人默认邀请额度暂停生效（站长 2026-11-06 要求）。
 *
 * 规则：`open_registration` 开着时 `invite_quota_base` 不生效（按 0 算），
 * 关闭、恢复邀请制注册后自动恢复；手动加的 `invite_quota_bonus` 不受影响。
 *
 * 之所以要单独守住：默认额度只在「建邀请码」这一条路径上被感知，前后端都不会
 * 因为算错而报错 —— 只是额度悄悄多了或少了，属于最容易被回归掉的那类语义。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import {
  consumeQuotaForInvite,
  effectiveInviteBase,
  loadUserQuota,
} from "../src/quotas"
import { makeUser, setSetting } from "./helpers"

async function setQuota(userId: string, bonus: number, used: number) {
  await env.DB.prepare("UPDATE users SET invite_quota_bonus = ?, invite_quota_used = ? WHERE id = ?")
    .bind(bonus, used, userId)
    .run()
}

/** 未来 / 过去的 ISO 时间（用于演练「截止时间」） */
const future = () => new Date(Date.now() + 3600_000).toISOString()
const past = () => new Date(Date.now() - 3600_000).toISOString()

describe("默认邀请额度 × 限时开放注册", () => {
  beforeEach(async () => {
    await setSetting("invite_quota_base", "3")
    await setSetting("open_registration", "0")
    await setSetting("open_registration_until", "")
  })

  it("开放注册关闭时：默认额度照常生效", async () => {
    const { id: userId } = await makeUser()
    const info = await effectiveInviteBase(env)
    expect(info).toEqual({ base: 3, suppressed: false })

    const quota = await loadUserQuota(env, userId)
    expect(quota.inviteBase).toBe(3)
    expect(quota.inviteBaseSuppressed).toBe(false)
    expect(quota.inviteTotal).toBe(3)
  })

  it("开放注册开启时：默认额度按 0 算，bonus 仍然可用", async () => {
    const { id: userId } = await makeUser()
    await setQuota(userId, 2, 0)
    await setSetting("open_registration", "1")

    const quota = await loadUserQuota(env, userId)
    expect(quota.inviteBase).toBe(0)
    expect(quota.inviteBaseSuppressed).toBe(true)
    expect(quota.inviteBonus).toBe(2)
    expect(quota.inviteTotal).toBe(2)
  })

  it("开放注册带截止时间：未到点暂停，过点自动恢复", async () => {
    const { id: userId } = await makeUser()
    await setSetting("open_registration", "1")

    await setSetting("open_registration_until", future())
    expect((await loadUserQuota(env, userId)).inviteBase).toBe(0)

    await setSetting("open_registration_until", past())
    const after = await loadUserQuota(env, userId)
    expect(after.inviteBase).toBe(3)
    expect(after.inviteBaseSuppressed).toBe(false)
  })

  it("开放注册关闭后：额度恢复，之前用掉的仍然计数", async () => {
    const { id: userId } = await makeUser()
    await setQuota(userId, 0, 2)
    await setSetting("open_registration", "1")
    expect((await loadUserQuota(env, userId)).inviteRemaining).toBe(0)

    await setSetting("open_registration", "0")
    const quota = await loadUserQuota(env, userId)
    expect(quota.inviteTotal).toBe(3)
    expect(quota.inviteRemaining).toBe(1)
  })

  it("开放注册期间没有 bonus 时建码被拒，且报错点明原因", async () => {
    const { id: userId } = await makeUser()
    await setSetting("open_registration", "1")

    await expect(consumeQuotaForInvite(env, userId, [])).rejects.toMatchObject({
      code: "INVITE_QUOTA_EXCEEDED",
    })
    // 文案要说清「不是被吞了，是开放注册期间暂停」，否则用户会来对账
    await expect(consumeQuotaForInvite(env, userId, [])).rejects.toThrow(/限时开放注册/)
  })

  it("开放注册期间有 bonus 时仍可建码，只扣 bonus 那部分", async () => {
    const { id: userId } = await makeUser()
    await setQuota(userId, 1, 0)
    await setSetting("open_registration", "1")

    await consumeQuotaForInvite(env, userId, [])
    const quota = await loadUserQuota(env, userId)
    expect(quota.inviteUsed).toBe(1)
    expect(quota.inviteRemaining).toBe(0)
    await expect(consumeQuotaForInvite(env, userId, [])).rejects.toMatchObject({
      code: "INVITE_QUOTA_EXCEEDED",
    })
  })
})