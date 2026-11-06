/**
 * 会员银行卡号（2026-11-06）。
 *
 * 守住三件事：
 *   1. 号码格式 —— 16 位、Luhn 合法、展示 4-4-4-4；15 位输入自动补校验位；
 *   2. 生命周期 —— 普通会员没有号；升到黄金发号；继续升级号码不变；重复调用幂等；
 *   3. 靓号池 —— 池里的号自动生成不会命中；只能显式发放；清除后号退回池子。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import {
  CARD_BIN,
  assignCardNo,
  clearUserCardNo,
  ensureUserCardNo,
  formatCardNo,
  generateCardNo,
  isValidCardNo,
  luhnCheckDigit,
  normalizeCardNoInput,
} from "../src/card-numbers"
import { makeUser } from "./helpers"

/** 直接改用户等级，模拟升级结果（不经过积分扣减） */
async function setLevel(userId: string, lv: number) {
  await env.DB.prepare("UPDATE users SET member_level = ? WHERE id = ?").bind(lv, userId).run()
}

async function cardNoOf(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT card_no FROM users WHERE id = ?")
    .bind(userId)
    .first<{ card_no: string | null }>()
  return row?.card_no ?? null
}

describe("卡号格式", () => {
  it("Luhn 校验位与 16 位格式", async () => {
    const no = await generateCardNo(env)
    expect(no).toHaveLength(16)
    expect(no.startsWith(CARD_BIN)).toBe(true)
    expect(isValidCardNo(no)).toBe(true)
    expect(formatCardNo(no)).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/)
    // 自算校验位必须一致
    expect(luhnCheckDigit(no.slice(0, 15))).toBe(no[15])
  })

  it("15 位输入自动补校验位，16 位错误校验位被拒", async () => {
    const head = "620100001234567"
    const filled = normalizeCardNoInput("6201 0000 1234 567")
    expect(filled).toHaveLength(16)
    expect(filled.slice(0, 15)).toBe(head)
    expect(isValidCardNo(filled)).toBe(true)

    // 把最后一位换掉必然非法
    const bad = filled.slice(0, 15) + ((Number(filled[15]) + 1) % 10)
    expect(() => normalizeCardNoInput(bad)).toThrow(/校验位/)
    expect(() => normalizeCardNoInput("123")).toThrow()
    expect(() => normalizeCardNoInput("abcd")).toThrow()
  })
})

describe("卡号生命周期", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM card_vanity_numbers").run()
  })

  it("普通会员不发号；升到黄金发号；再升级号码不变", async () => {
    const { id } = await makeUser()

    expect(await ensureUserCardNo(env, id, 0)).toBeNull()
    expect(await cardNoOf(id)).toBeNull()

    await setLevel(id, 1)
    const first = await ensureUserCardNo(env, id, 1)
    expect(first).not.toBeNull()
    expect(isValidCardNo(first!)).toBe(true)

    await setLevel(id, 3)
    const later = await ensureUserCardNo(env, id, 3)
    expect(later).toBe(first)
    expect(await cardNoOf(id)).toBe(first)
  })

  it("并发/重复调用只写一次（幂等）", async () => {
    const { id } = await makeUser()
    await setLevel(id, 1)

    const results = await Promise.all([
      ensureUserCardNo(env, id, 1),
      ensureUserCardNo(env, id, 1),
      ensureUserCardNo(env, id, 1),
    ])
    // 三个调用必须得到同一个号（后写者拿到先写者的值）
    expect(new Set(results).size).toBe(1)
    expect(await cardNoOf(id)).toBe(results[0])
  })
})

describe("靓号池", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM card_vanity_numbers").run()
  })

  it("发放靓号后用户拿到该号，池内状态变 issued", async () => {
    const { id } = await makeUser()
    await setLevel(id, 1)

    const vanity = normalizeCardNoInput("6201 0000 0000 999")
    await env.DB.prepare(
      `INSERT INTO card_vanity_numbers (number, status, created_at, updated_at)
       VALUES (?, 'reserved', ?, ?)`
    )
      .bind(vanity, new Date().toISOString(), new Date().toISOString())
      .run()

    await assignCardNo(env, id, vanity)
    expect(await cardNoOf(id)).toBe(vanity)

    const row = await env.DB.prepare(
      "SELECT status, user_id FROM card_vanity_numbers WHERE number = ?"
    )
      .bind(vanity)
      .first<{ status: string; user_id: string | null }>()
    expect(row?.status).toBe("issued")
    expect(row?.user_id).toBe(id)

    // 再次 ensure 不能把号换成新生成的
    expect(await ensureUserCardNo(env, id, 2)).toBe(vanity)
  })

  it("靓号池里的号不会被自动生成命中", async () => {
    // 把 BIN + 全 0 的号放进池子（生成器命中它的概率极低，用来验证「必须查池」）
    const { id } = await makeUser()
    await setLevel(id, 1)
    const vanity = normalizeCardNoInput("6201 0000 0000 000")
    await env.DB.prepare(
      `INSERT INTO card_vanity_numbers (number, status, created_at, updated_at)
       VALUES (?, 'reserved', ?, ?)`
    )
      .bind(vanity, new Date().toISOString(), new Date().toISOString())
      .run()

    for (let i = 0; i < 5; i++) {
      const generated = await generateCardNo(env)
      expect(generated).not.toBe(vanity)
    }
    expect(await cardNoOf(id)).toBeNull()
  })

  it("已发给别人的号不能再发；清除后号退回池子", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await setLevel(a.id, 1)
    await setLevel(b.id, 1)

    const vanity = normalizeCardNoInput("6201 0000 0000 888")
    await assignCardNo(env, a.id, vanity)
    await expect(assignCardNo(env, b.id, vanity)).rejects.toMatchObject({
      code: "CARD_NO_TAKEN",
    })

    await clearUserCardNo(env, a.id)
    expect(await cardNoOf(a.id)).toBeNull()
    const row = await env.DB.prepare(
      "SELECT status, user_id FROM card_vanity_numbers WHERE number = ?"
    )
      .bind(vanity)
      .first<{ status: string; user_id: string | null }>()
    expect(row?.status).toBe("reserved")
    expect(row?.user_id).toBeNull()

    // 退回池子后可以发给别人
    await assignCardNo(env, b.id, vanity)
    expect(await cardNoOf(b.id)).toBe(vanity)
  })
})