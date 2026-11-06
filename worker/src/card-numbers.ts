/**
 * 会员银行卡号（2026-11-06 站长要求）。
 *
 * 规则：
 *   * 普通会员（等级 0）没有卡号；
 *   * 升到黄金会员（等级 ≥ 1）时分配一个 **16 位数字**，带 Luhn 校验位，
 *     展示成 4-4-4-4（`6201 2345 6789 0123`）；
 *   * 之后继续升级（白金 / 黑金）**号码不变** —— 它是 `users.card_no` 上的持久
 *     字段，不是按等级现算的；
 *   * 后台可以把「靓号」（如 `6201 0000 0000 8888`）预先放进
 *     `card_vanity_numbers` 池子：池里的号自动生成永远不碰，只能由管理员
 *     指定发放给某个用户。
 *
 * 为什么带 Luhn：卡面要「看起来就是一张银行卡」。Luhn 校验位让这个号在
 * 任何号码校验器里都成立，同时保持纯数字、可被管理员手工指定（15 位时自动补位）。
 */
import { ApiError } from "./http"
import type { Env } from "./env"

/**
 * 卡号前缀（BIN 语义）：62 是银联卡段惯例，后接 2 位站内版本号。
 * 改这个前缀会让「新卡号」与「存量卡号」分段，属于对外观感变更，别随手改。
 */
export const CARD_BIN = "6201"

/** 展示用：4 位一段 */
export function formatCardNo(no: string): string {
  return no.replace(/(\d{4})(?=\d)/g, "$1 ")
}

/** Luhn 校验位：给前 15 位算第 16 位 */
export function luhnCheckDigit(digits: string): string {
  let sum = 0
  // 从校验位左侧一位开始，偶数位（从右数第 2、4…）乘 2
  for (let i = 0; i < digits.length; i++) {
    const posFromRight = digits.length - i
    let d = Number(digits[i])
    if (posFromRight % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return String((10 - (sum % 10)) % 10)
}

export function isValidCardNo(no: string): boolean {
  if (!/^\d{16}$/.test(no)) return false
  return luhnCheckDigit(no.slice(0, 15)) === no[15]
}

/**
 * 归一化管理员输入的号码：
 *   * 去掉空格 / 连字符；
 *   * 15 位 → 自动补 Luhn 校验位（靓号一般只关心前 15 位的样子）；
 *   * 16 位 → 必须本身合法，否则报错（避免发出去一张「刷不过」的卡）；
 *   * 其他长度 / 非数字 → 报错。
 */
export function normalizeCardNoInput(raw: string): string {
  const digits = raw.replace(/[\s-]/g, "")
  if (!/^\d+$/.test(digits)) {
    throw new ApiError(400, "卡号只能是数字（可留空格分段）", "INVALID_CARD_NO")
  }
  if (digits.length === 15) return digits + luhnCheckDigit(digits)
  if (digits.length !== 16) {
    throw new ApiError(400, "卡号需要 15 或 16 位数字（15 位会自动补校验位）", "INVALID_CARD_NO")
  }
  if (!isValidCardNo(digits)) {
    throw new ApiError(
      400,
      "卡号校验位不正确：请填 15 位让系统补校验位，或修正第 16 位",
      "INVALID_CARD_NO"
    )
  }
  return digits
}

/** 池子里已被占用（预留 / 已发放）的号码集合 */
export async function reservedCardNos(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT number FROM card_vanity_numbers").all<{ number: string }>()
  return new Set((rows.results ?? []).map((r) => r.number))
}

/**
 * 生成一个不与任何人、不与靓号池冲突的卡号。
 *
 * 冲突只可能来自随机碰撞（16 位里 12 位随机），重试上限 20 次已经远超需要；
 * 到上限直接报错而不是死循环 —— 真出现说明池子被塞满了，需要人工介入。
 */
export async function generateCardNo(env: Env): Promise<string> {
  const reserved = await reservedCardNos(env)
  for (let attempt = 0; attempt < 20; attempt++) {
    const buf = crypto.getRandomValues(new Uint8Array(12))
    // 去掉校验位后必须正好 15 位：BIN 4 位 + 随机 11 位
    const body = Array.from(buf)
      .map((b) => String(b % 10))
      .join("")
      .slice(0, 15 - CARD_BIN.length)
    const head = CARD_BIN + body
    const candidate = head + luhnCheckDigit(head)
    if (reserved.has(candidate)) continue
    const exists = await env.DB.prepare("SELECT 1 AS x FROM users WHERE card_no = ?")
      .bind(candidate)
      .first()
    if (!exists) return candidate
  }
  throw new ApiError(500, "卡号生成失败，请稍后再试", "CARD_NO_GENERATION_FAILED")
}

/**
 * 确保用户有卡号（等级 ≥ 1 才发）。
 *
 * 幂等 + 并发安全：只有 `card_no IS NULL` 时才写，写成功与否都以库里的最终值为准
 * （升级接口、积分概览、后台详情三处都会调用，同一个用户可能同时命中多处）。
 */
export async function ensureUserCardNo(
  env: Env,
  userId: string,
  memberLevel: number,
  known?: string | null
): Promise<string | null> {
  if (memberLevel < 1) return null
  if (known) return known

  const candidate = await generateCardNo(env)
  await env.DB.prepare(
    "UPDATE users SET card_no = ?, updated_at = ? WHERE id = ? AND card_no IS NULL"
  )
    .bind(candidate, new Date().toISOString(), userId)
    .run()

  const row = await env.DB.prepare("SELECT card_no FROM users WHERE id = ?")
    .bind(userId)
    .first<{ card_no: string | null }>()
  return row?.card_no ?? null
}

/** 后台调用：把某个号发给指定用户（号必须在池子里且未被他人占用，或本来就是他的） */
export async function assignCardNo(
  env: Env,
  userId: string,
  number: string
): Promise<void> {
  const now = new Date().toISOString()
  const holder = await env.DB.prepare("SELECT id, username FROM users WHERE card_no = ?")
    .bind(number)
    .first<{ id: string; username: string }>()
  if (holder && holder.id !== userId) {
    throw new ApiError(409, `该卡号已被 ${holder.username} 持有`, "CARD_NO_TAKEN")
  }

  const row = await env.DB.prepare(
    "SELECT status, user_id FROM card_vanity_numbers WHERE number = ?"
  )
    .bind(number)
    .first<{ status: string; user_id: string | null }>()
  if (row?.status === "issued" && row.user_id && row.user_id !== userId) {
    throw new ApiError(409, "该靓号已发放给其他用户", "CARD_NO_TAKEN")
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET card_no = ?, updated_at = ? WHERE id = ?")
      .bind(number, now, userId),
    env.DB.prepare(
      `INSERT INTO card_vanity_numbers (number, status, user_id, created_at, updated_at)
       VALUES (?, 'issued', ?, ?, ?)
       ON CONFLICT(number) DO UPDATE SET
         status = 'issued',
         user_id = excluded.user_id,
         updated_at = excluded.updated_at`
    ).bind(number, userId, now, now),
  ])
}

/** 清空某个用户的卡号（后台纠错用）；顺带把池子里对应记录退回预留（如果本来是他占的） */
export async function clearUserCardNo(env: Env, userId: string): Promise<void> {
  const cur = await env.DB.prepare("SELECT card_no FROM users WHERE id = ?")
    .bind(userId)
    .first<{ card_no: string | null }>()
  if (!cur?.card_no) return
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET card_no = NULL, updated_at = ? WHERE id = ?").bind(
      new Date().toISOString(),
      userId
    ),
    env.DB.prepare(
      "UPDATE card_vanity_numbers SET status = 'reserved', user_id = NULL, updated_at = ? WHERE number = ? AND user_id = ?"
    ).bind(new Date().toISOString(), cur.card_no, userId),
  ])
}