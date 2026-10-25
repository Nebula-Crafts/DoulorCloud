import * as React from "react"
import { Link, Navigate } from "react-router-dom"

import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"

/**
 * 管理后台的门卫：认证 + 角色。
 *
 * 未登录 → 跳**后台自己的**登录页（/admin/login，AdminLogin 组件）。
 * 登录状态机（含 2FA 挑战）通过 authApi/twoFactorApi 复用，不复制实现。
 *
 * 已登录但不是管理员 → 明确的「无权访问」卡片，不给看任何管理 UI 骨架。
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const { t } = useT()
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    )
  }

  if (!user) {
    // 后台自带登录页（AdminLogin）：整条登录流程收在管理 SPA 内，
    // 不再借道主站 /login（2026-10-25 后台独立认证）。
    return <Navigate to="/admin/login" replace />
  }

  if (user.role !== "admin" && user.role !== "superadmin" && user.role !== "root") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm space-y-3 rounded-lg border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold">{t("adm.gate.denied")}</h1>
          <p className="text-sm text-muted-foreground">{t("adm.gate.deniedDesc")}</p>
          <Link to="/" className="inline-block text-sm text-primary hover:underline">
            {t("adm.gate.back")}
          </Link>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
