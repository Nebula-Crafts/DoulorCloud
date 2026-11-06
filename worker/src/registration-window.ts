/**
 * 「限时开放注册」窗口判定（2026-11-06 从 handlers/auth.ts 提取）。
 *
 * 为什么要单独成模块：这个判定现在有两个消费方 ——
 *   1. 注册流程（`handlers/auth.ts`）：开着窗口时注册不需要邀请码；
 *   2. 邀请码额度（`quotas.ts`）：**窗口开启期间每人默认邀请额度暂停生效**
 *      （站长 2026-11-06 要求）。开放注册时任何人都不需要邀请码就能进来，
 *      再给每人发默认额度只会被拿去批量开码。
 *
 * 判定：总开关 `open_registration` 开着，且（未设截止时间 或 当前未过截止时间）。
 * 截止时间解析失败（管理员填了脏值）时**忽略截止时间** —— 总开关仍开着说明
 * 管理员本意就是开放，不该因为一个格式错误把注册全关掉。
 */
import { getSettings } from "./settings"
import type { Env } from "./env"

export function isOpenRegistrationIn(s: Record<string, string>): boolean {
  const raw = s.open_registration ?? ""
  if (!(raw === "1" || raw.toLowerCase() === "true")) return false
  const until = (s.open_registration_until ?? "").trim()
  if (!until) return true
  const t = Date.parse(until)
  if (!Number.isFinite(t)) return true
  return Date.now() < t
}

export async function isOpenRegistration(env: Env): Promise<boolean> {
  return isOpenRegistrationIn(await getSettings(env))
}