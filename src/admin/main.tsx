import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"

import AdminApp from "@/admin/AdminApp"
import { I18nProvider } from "@/i18n"
import { AuthProvider } from "@/hooks/use-auth"
import { ErrorBoundary } from "@/components/error-boundary"
import { ConfirmDialogHost } from "@/components/confirm-dialog"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { installGlobalErrorGuards } from "@/lib/global-error-guards"
import "@/index.css"

installGlobalErrorGuards()

/**
 * 管理后台独立入口（admin.html）。
 *
 * 与用户站（src/main.tsx）的关系：同一仓库、同一套组件与词典，但**独立打包**——
 * 用户站的 bundle 里不含任何管理代码，管理后台也不背用户站的开屏动画 /
 * 反馈收集器等运行时。两个入口共用的全局错误守卫抽在 lib/global-error-guards.ts。
 */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <BrowserRouter>
          <AuthProvider>
            <TooltipProvider delayDuration={200}>
              <AdminApp />
              {/* 管理页大量使用 confirmDialog() 做危险操作二次确认 */}
              <ConfirmDialogHost />
              <Toaster />
            </TooltipProvider>
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
