/**
 * 角色判定的公共小工具。
 *
 * 原先 `isAdminRole` 住在 `components/gallery-nav.tsx`（造物集侧边栏）。
 * 造物集与 AI 实验室下线后（2026-11-05），该组件被删除，而游戏页仍需要
 * 这个判断，故独立成模块 —— 别再把它塞回某个业务组件里，否则下一个被删的
 * 模块又会带走它。
 */

/** 是不是「管理端」角色。与 dashboard-layout / 服务端 isAnyAdmin 同口径 */
export function isAdminRole(role: string | undefined | null): boolean {
  return role === "admin" || role === "superadmin" || role === "root"
}
