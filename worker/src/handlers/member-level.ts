/**
 * 用户等级升级（2026-11-06 会员等级体系）。
 *
 * 等级共四级：0=普通会员 1=黄金会员 2=白金会员 3=黑金会员。
 * 等级变动只能通过消耗积分升级（不可降级）。价格由管理后台配置。
 *
 * 路由：POST /api/points/upgrade-level
 */
import { ApiError, json } from "../http"
import { applyPoints, getPointsBalance } from "../points"
import { ensureUserCardNo } from "../card-numbers"
import { getSettingNumber } from "../settings"
import { requireUser } from "../auth"
import type { Env } from "../env"

/** 等级名（0-based，与前端展示对应） */
export const LEVEL_NAMES = ["普通会员", "黄金会员", "白金会员", "黑金会员"] as const

/** settings 里各等级价格的键（下标即等级值；0 号位占位） */
const LEVEL_PRICE_KEYS = ["", "level_price_gold", "level_price_platinum", "level_price_black"] as const

/** 各等级升级所需的积分（从 settings 读取，0 = 不可升到该级） */
async function levelPrice(env: Env, level: number): Promise<number> {
  if (level < 1 || level > 3) return 0
  return Math.max(0, await getSettingNumber(env, LEVEL_PRICE_KEYS[level] as Parameters<typeof getSettingNumber>[1]))
}

/** 一次读全三级价格（积分页展示 + 升级校验共用），键为等级值 */
export async function levelPriceMap(env: Env): Promise<Record<number, number>> {
  const [gold, platinum, black] = await Promise.all([
    levelPrice(env, 1),
    levelPrice(env, 2),
    levelPrice(env, 3),
  ])
  return { 1: gold, 2: platinum, 3: black }
}

/** POST /api/points/upgrade-level —— 消耗积分升到下一级 */
export async function upgradeLevel(env: Env, request: Request): Promise<Response> {
  const session = await requireUser(env, request)
  const row = await env.DB.prepare("SELECT member_level FROM users WHERE id = ?").bind(session.id).first<{ member_level: number }>()
  const current = row?.member_level ?? 0

  if (current >= 3) {
    throw new ApiError(409, "已是最高等级（黑金会员）", "ALREADY_MAX_LEVEL")
  }

  const nextLevel = current + 1
  const price = await levelPrice(env, nextLevel)
  if (price <= 0) {
    throw new ApiError(400, "该等级暂未开放升级", "LEVEL_NOT_AVAILABLE")
  }

  const balance = await getPointsBalance(env, session.id)
  if (balance < price) {
    throw new ApiError(
      409,
      `积分不足：升级到${LEVEL_NAMES[nextLevel]}需要 ${price} 积分，当前余额 ${balance}`,
      "INSUFFICIENT_POINTS"
    )
  }

  // 扣积分 + 升级
  const res = await applyPoints(env, {
    userId: session.id,
    delta: -price,
    reason: "level_up" as never,
    detail: `升级到${LEVEL_NAMES[nextLevel]}`,
  })
  if (!res.applied) {
    throw new ApiError(409, "积分余额不足", "INSUFFICIENT_POINTS")
  }

  await env.DB.prepare("UPDATE users SET member_level = ?, updated_at = ? WHERE id = ?")
    .bind(nextLevel, new Date().toISOString(), session.id)
    .run()

  // 升到黄金（等级 ≥ 1）时分配「银行卡号」；之后继续升级号码不变
  // （ensureUserCardNo 见到列已非空就直接返回原值）。
  // 在这里接一下而不是只靠积分概览懒生成：升级完立刻就能在卡面上看到自己的号。
  const cardNo = await ensureUserCardNo(env, session.id, nextLevel, session.card_no ?? null)

  return json({
    level: nextLevel,
    levelName: LEVEL_NAMES[nextLevel],
    balance: res.balance,
    cardNo,
  })
}
