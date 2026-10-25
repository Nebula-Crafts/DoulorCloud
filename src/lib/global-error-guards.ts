/**
 * 全局错误守卫：chunk 404 自愈、诊断日志、Service Worker 投毒自清理。
 *
 * 从原 main.tsx 原样抽出（2026-10-25 多入口改造）：用户站（index.html）与
 * 管理后台（admin.html）两个入口都要挂同一套监听，避免复制漂移。
 * 必须在 React 挂载前调用 —— 有些动态导入失败不会走到 ErrorBoundary。
 */
import { reloadOnceForChunkError } from "@/lib/chunk-error"
import { diagError } from "@/lib/diag-log"
import { selfHealServiceWorkers } from "@/lib/chunk-error"

export function installGlobalErrorGuards() {
  // Vite 的模块预加载失败事件（Vite 5+）；类型不在标准 lib 里，用 any 收口
  window.addEventListener("vite:preloadError" as never, ((e: Event) => {
    e.preventDefault?.()
    diagError(String((e as unknown as { payload?: unknown }).payload ?? e), "vite:preloadError")
    reloadOnceForChunkError((e as unknown as { payload?: unknown }).payload ?? e)
  }) as never)

  window.addEventListener("error", (e) => {
    // 诊断日志（若站点开关打开）：记一条错误。chunk 错误之外的也记 ——
    // 这正是「用户反馈附日志」要抓的内容。记录本身纳秒级、try-catch 包死。
    diagError(
      e.message || String(e.error ?? "error"),
      e.error instanceof Error ? e.error.stack : undefined
    )
    reloadOnceForChunkError(e.error ?? e.message)
  })

  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason
    diagError(
      reason instanceof Error ? reason.message : String(reason ?? "unhandledrejection"),
      reason instanceof Error ? reason.stack : undefined
    )
    reloadOnceForChunkError(reason)
  })


  // 启动时做一次性安全自愈（见函数注释：清理被投毒 SW/缓存）
  selfHealServiceWorkers()
}
