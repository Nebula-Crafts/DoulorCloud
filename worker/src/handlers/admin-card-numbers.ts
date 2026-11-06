/**
 * 后台「银行卡靓号」管理（2026-11-06）。
 *
 * 站长要求：会员等级升到黄金及以上后，银行卡中间显示的是一张卡的「卡号」；
 * 后台要能**预留靓号**并**指定发放**给某个用户。
 *
 * 语义：
 *   * 池子（`card_vanity_numbers`）里的号自动生成永远不会命中，
 *     所以预留的号一定能留到「发给指定的人」这一刻；
 *   * 发给用户后记录变 `issued` 并绑 `user_id`；把该用户的卡号清掉，
 *     号会自动退回池子 `reserved`（见 card-numbers.clearUserCardNo）；
 *   * 卡号在 `users.card_no` 上，发出去后继续升级不变。
 *
 * 权限：沿用「调整配额 / 额度」（`users.quota`）—— 这是用户级数据的发放，
 * 不再新增一个权限叶子，避免权限树再长一层。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import {
  assignCardNo,
  clearUserCardNo,
  formatCardNo,
  normalizeCardNoInput,
} from "../card-numbers"
import type { Env } from "../env"

interface VanityRow {
  number: string
  status: string
  user_id: string | null
  note: string | null
  created_at: string
  updated_at: string
  username: string | null
}

/** GET /api/admin/card-numbers —— 靓号池（预留 + 已发放） */
export async function listCardNumbers(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "users.quota")
  const rows = await env.DB.prepare(
    `SELECT v.number, v.status, v.user_id, v.note, v.created_at, v.updated_at,
            u.username
       FROM card_vanity_numbers v
       LEFT JOIN users u ON u.id = v.user_id
      ORDER BY v.status ASC, v.created_at DESC`
  ).all<VanityRow>()

  const items = (rows.results ?? []).map((r) => ({
    number: r.number,
    formatted: formatCardNo(r.number),
    status: r.status,
    userId: r.user_id,
    username: r.username,
    note: r.note,
    createdAt: r.created_at,
  }))

  return json({
    items,
    reservedCount: items.filter((i) => i.status === "reserved").length,
    issuedCount: items.filter((i) => i.status === "issued").length,
  })
}

/**
 * POST /api/admin/card-numbers —— 批量预留靓号
 * body: { numbers: string[] | string }（字符串按换行 / 逗号切）
 *
 * 单个失败不影响其他：返回 added / skipped（带原因），前端直接把 skipped 提示出来。
 */
export async function reserveCardNumbers(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "users.quota")
  const body = (await request.json()) as { numbers?: string[] | string }
  const raw = Array.isArray(body.numbers)
    ? body.numbers
    : typeof body.numbers === "string"
      ? body.numbers.split(/[\n,，;；\s]+/)
      : []
  const inputs = raw.map((s) => s.trim()).filter(Boolean)
  if (inputs.length === 0) {
    throw new ApiError(400, "请填写要预留的卡号", "INVALID_CARD_NO")
  }
  if (inputs.length > 100) {
    throw new ApiError(400, "一次最多预留 100 个", "TOO_MANY")
  }

  const now = new Date().toISOString()
  const added: string[] = []
  const skipped: { number: string; reason: string }[] = []

  for (const input of inputs) {
    let number: string
    try {
      number = normalizeCardNoInput(input)
    } catch (err) {
      skipped.push({ number: input, reason: err instanceof ApiError ? err.message : "格式不正确" })
      continue
    }

    const holder = await env.DB.prepare("SELECT username FROM users WHERE card_no = ?")
      .bind(number)
      .first<{ username: string }>()
    if (holder) {
      skipped.push({ number: formatCardNo(number), reason: `已被 ${holder.username} 持有` })
      continue
    }

    const exists = await env.DB.prepare("SELECT number FROM card_vanity_numbers WHERE number = ?")
      .bind(number)
      .first()
    if (exists) {
      skipped.push({ number: formatCardNo(number), reason: "已在靓号池中" })
      continue
    }

    await env.DB.prepare(
      `INSERT INTO card_vanity_numbers (number, status, created_by, created_at, updated_at)
       VALUES (?, 'reserved', ?, ?, ?)`
    )
      .bind(number, "admin", now, now)
      .run()
    added.push(formatCardNo(number))
  }

  return json({ added, skipped })
}

/**
 * DELETE /api/admin/card-numbers/:number —— 从池子里移除
 * 已发放的号不允许直接删（先清用户卡号，避免池子与 users.card_no 脱节）。
 */
export async function deleteCardNumber(
  env: Env,
  request: Request,
  number: string
): Promise<Response> {
  await requireAdminScope(env, request, "users.quota")
  const normalized = normalizeCardNoInput(number)
  const row = await env.DB.prepare(
    "SELECT status FROM card_vanity_numbers WHERE number = ?"
  )
    .bind(normalized)
    .first<{ status: string }>()

  if (!row) throw new ApiError(404, "该号不在靓号池中", "NOT_FOUND")
  if (row.status === "issued") {
    throw new ApiError(409, "该号已发给用户，请先在用户详情里清除卡号", "CARD_NO_ISSUED")
  }

  await env.DB.prepare("DELETE FROM card_vanity_numbers WHERE number = ?").bind(normalized).run()
  return json({ ok: true })
}

/**
 * PUT /api/admin/users/:username/card-number —— 给用户发放 / 清除卡号
 * body: { number: string | null }
 *
 * 传 null = 清除（下次打开积分页或再次升级会重新生成）。
 */
export async function setUserCardNo(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  await requireAdminScope(env, request, "users.quota")
  const user = await env.DB.prepare(
    "SELECT id, username, member_level FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first<{ id: string; username: string; member_level: number | null }>()
  if (!user) throw new ApiError(404, "用户不存在", "NOT_FOUND")

  const body = (await request.json()) as { number?: string | null }
  if (body.number === null || body.number === undefined || body.number === "") {
    await clearUserCardNo(env, user.id)
    return json({ cardNo: null })
  }

  const number = normalizeCardNoInput(body.number)
  await assignCardNo(env, user.id, number)
  return json({ cardNo: number, formatted: formatCardNo(number) })
}