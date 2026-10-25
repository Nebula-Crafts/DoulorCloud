/**
 * 游戏星币钱包（2026-10-25 模拟人生）—— **每游戏独立的筹码账本 + 兑换柜台**。
 *
 * 星币是 100% 积分储备支撑的游戏筹码：
 *   · 兑入（mint）：玩家 −积分（reason=star_in，积分封存）→ 钱包 +积分×starRate
 *   · 兑出（burn）：钱包 −星币 → 玩家 +星币/starRate（reason=star_out，积分解封）
 *   · 不变量：全站积分总量 + (Σ未兑出星币 ÷ 各游戏 starRate) = 常数
 *   · 星币不可转账、不可跨游戏（game_slug 是钱包主键的一半）——它只存在于
 *     「兑入 ⇄ 游戏 ⇄ 兑出」闭环内，否则就是绕开积分体系的第二货币。
 *
 * ⚠️ 兑换的**原子性**：兑入/兑出各是一个 D1 batch（隐式事务），沿用 applyPoints
 *    的「条件 INSERT + 条件 UPDATE」模式——每个涉及变动的语句都带同一个
 *    余额条件（EXISTS 或 WHERE），任何不足时**所有语句都是 0 行**，天然全有全无。
 *    批内语句的分工：ensure 行 → 「leader」条件更新（决定成败）→
 *    其余语句用 EXISTS 挂在同一个条件上跟随成败。
 */
import { ApiError } from "./http"
import type { Env } from "./env"

/** 「在线投资」的 slug（与 collection-plugins / collection-admin 同值） */
export interface ExchangeResult {
  applied: boolean
  /** 兑换后的星币余额 */
  stars: number
  /** 兑换后的积分余额 */
  points: number
  reason?: "insufficient_stars" | "insufficient_points"
}

/** 读星币余额；无行视为 0（不建行，避免无意义写入） */
export async function getWallet(
  env: Env,
  slug: string,
  userId: string
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT balance FROM game_wallets WHERE game_slug = ? AND user_id = ?"
  )
    .bind(slug, userId)
    .first<{ balance: number }>()
  return Number(row?.balance ?? 0)
}

/**
 * 该游戏的星币汇率（星币/积分）。
 * 唯一来源：collection_plugins.config.starRate（JSON 列）。缺失/非法回落 100。
 */
export async function getStarRate(env: Env, slug: string): Promise<number> {
  const row = await env.DB.prepare("SELECT config FROM collection_plugins WHERE slug = ?")
    .bind(slug)
    .first<{ config: string }>()
  let rate = 100
  try {
    const cfg = JSON.parse(row?.config ?? "{}") as { starRate?: unknown }
    const n = Math.trunc(Number(cfg.starRate))
    if (Number.isFinite(n) && n >= 1 && n <= 1_000_000) rate = n
  } catch {
    /* config 损坏按默认汇率走（100）——别让一个坏 JSON 锁死兑换 */
  }
  return rate
}

async function pointsBalanceOf(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT balance FROM user_points WHERE user_id = ?")
    .bind(userId)
    .first<{ balance: number }>()
  return Number(row?.balance ?? 0)
}

/**
 * 兑入：销 N 积分 → 铸 N × starRate 星币。单个 D1 batch 原子完成。
 * leader 是积分扣减（条件 balance >= N）；星币加成用 EXISTS 挂在同一条件上。
 */
export async function mintStars(
  env: Env,
  slug: string,
  userId: string,
  points: number
): Promise<ExchangeResult> {
  const rate = await getStarRate(env, slug)
  const n = Math.trunc(points)
  if (!Number.isFinite(n) || n < 1) {
    throw new ApiError(400, "兑入积分数需为正整数", "INVALID_INPUT")
  }
  const now = new Date().toISOString()
  const txId = crypto.randomUUID()
  const starsToMint = n * rate

  // ⚠️ 批内条件传导（照搬 applyPoints 的模式，别改）：
  //   leader = star_in 流水行（条件：积分余额足够），其余语句全部
  //   `EXISTS(SELECT 1 FROM point_transactions WHERE id = txId)` 挂在它的产物上。
  //   ❌ 不能在 follower 里再写 `balance >= n`：批内顺序执行，leader 扣减后
  //      余额已经变小，同样的条件必然不满足 → 星币永远加不上（真实踩过）。
  const results = await env.DB.batch([
    // ensure 行（无条件；不满足余额时后面的语句全是 0 行，这两个 ensure 无副作用）
    env.DB.prepare("INSERT OR IGNORE INTO user_points (user_id, balance, updated_at) VALUES (?, 0, ?)")
      .bind(userId, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO game_wallets (game_slug, user_id, balance, updated_at) VALUES (?, ?, 0, ?)"
    )
      .bind(slug, userId, now),
    // leader：star_in 流水行（积分足够才落）
    env.DB.prepare(
      `INSERT INTO point_transactions
         (id, user_id, delta, balance, reason, detail, dedup_key, created_at)
       SELECT ?, ?, ?, (SELECT balance - ? FROM user_points WHERE user_id = ?), 'star_in', ?, NULL, ?
        WHERE EXISTS (
          SELECT 1 FROM user_points WHERE user_id = ? AND balance >= ?
        )`
    )
      .bind(
        txId, userId, -n, n, userId,
        `星币兑入（汇率 1:${rate}）`, now, userId, n
      ),
    // 跟随 1：积分扣减
    env.DB.prepare(
      `UPDATE user_points SET balance = balance - ?, updated_at = ?
        WHERE user_id = ? AND EXISTS (
          SELECT 1 FROM point_transactions WHERE id = ?
        )`
    )
      .bind(n, now, userId, txId),
    // 跟随 2：星币加成
    env.DB.prepare(
      `UPDATE game_wallets SET balance = balance + ?, updated_at = ?
        WHERE game_slug = ? AND user_id = ? AND EXISTS (
          SELECT 1 FROM point_transactions WHERE id = ?
        )`
    )
      .bind(starsToMint, now, slug, userId, txId),
  ])

  // leader 是流水行（results[2]）；它落了 = 兑换发生
  const pointsApplied = (results[2]?.meta?.changes ?? 0) === 1
  const [stars, pointsBalance] = await Promise.all([
    getWallet(env, slug, userId),
    pointsBalanceOf(env, userId),
  ])
  if (!pointsApplied) {
    return { applied: false, stars, points: pointsBalance, reason: "insufficient_points" }
  }
  return { applied: true, stars, points: pointsBalance }
}

/**
 * 兑出：烧 M 星币 → 解封 M ÷ starRate 积分。单个 D1 batch 原子完成。
 * leader 是星币扣减（条件 balance >= M）；积分加成与流水用 EXISTS 挂在同一条件上。
 * 软下架不影响本接口（用户资产必须可取）。
 */
export async function burnStars(
  env: Env,
  slug: string,
  userId: string,
  stars: number
): Promise<ExchangeResult> {
  const rate = await getStarRate(env, slug)
  const n = Math.trunc(stars)
  if (!Number.isFinite(n) || n < 1) {
    throw new ApiError(400, "兑出星币数需为正整数", "INVALID_INPUT")
  }
  // ⚠️ 整除校验（守恒红线）：非整除的兑出会让余数星币失去储备支撑
  // （floor(n/rate) 积分对应不了 n 星币），等于凭空销毁玩家资产。
  // 前端「全部兑出」按钮按汇率向下取整；余数留钱包里随下一局游戏自然消化。
  if (n % rate !== 0) {
    throw new ApiError(
      400,
      `兑出数量需为 ${rate} 的整数倍（当前余数会把 ${n % rate} 星币变成无储备的死账）`,
      "INVALID_INPUT"
    )
  }
  const now = new Date().toISOString()
  const txId = crypto.randomUUID()
  const pointsBack = Math.floor(n / rate)

  // ⚠️ 批内条件传导与 mintStars 同一模式：leader = star_out 流水行
  //   （条件：星币余额足够），积分解封与星币扣减都挂它的产物。别改回
  //   「follower 再查一遍余额」——扣减后条件必然不满足（真实踩过）。
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO user_points (user_id, balance, updated_at) VALUES (?, 0, ?)"
    )
      .bind(userId, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO game_wallets (game_slug, user_id, balance, updated_at) VALUES (?, ?, 0, ?)"
    )
      .bind(slug, userId, now),
    // leader：star_out 流水行（星币足够才落）
    env.DB.prepare(
      `INSERT INTO point_transactions
         (id, user_id, delta, balance, reason, detail, dedup_key, created_at)
       SELECT ?, ?, ?, (SELECT balance FROM user_points WHERE user_id = ?), 'star_out', ?, NULL, ?
        WHERE EXISTS (
          SELECT 1 FROM game_wallets WHERE game_slug = ? AND user_id = ? AND balance >= ?
        )`
    )
      .bind(txId, userId, pointsBack, userId, `星币兑出（汇率 1:${rate}）`, now, slug, userId, n),
    // 跟随 1：星币扣减
    env.DB.prepare(
      `UPDATE game_wallets SET balance = balance - ?, updated_at = ?
        WHERE game_slug = ? AND user_id = ? AND EXISTS (
          SELECT 1 FROM point_transactions WHERE id = ?
        )`
    )
      .bind(n, now, slug, userId, txId),
    // 跟随 2：积分解封
    env.DB.prepare(
      `UPDATE user_points SET balance = balance + ?, updated_at = ?
        WHERE user_id = ? AND EXISTS (
          SELECT 1 FROM point_transactions WHERE id = ?
        )`
    )
      .bind(pointsBack, now, userId, txId),
  ])

  // leader 是流水行（results[2]）；它落了 = 兑换发生
  const starsApplied = (results[2]?.meta?.changes ?? 0) === 1
  const [starsNow, pointsBalance] = await Promise.all([
    getWallet(env, slug, userId),
    pointsBalanceOf(env, userId),
  ])
  if (!starsApplied) {
    return { applied: false, stars: starsNow, points: pointsBalance, reason: "insufficient_stars" }
  }
  return { applied: true, stars: starsNow, points: pointsBalance }
}
