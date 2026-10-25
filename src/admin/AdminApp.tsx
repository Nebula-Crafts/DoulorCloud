import { Navigate, Route, Routes } from "react-router-dom"

import { AdminGate } from "@/admin/AdminGate"
import AdminLogin from "@/admin/AdminLogin"
import AdminPage from "@/admin/AdminPage"

/**
 * 管理后台的路由树。
 *
 * URL 形态是**真路由** /admin/<栏目>（原先是 /dashboard/admin#<栏目> 的 hash）：
 * 可直达、可分享、刷新不丢。栏目合法性由 AdminPage 内部的 ADMIN_TAB_KEYS 收口，
 * 非法栏目名回落到「用户」栏。
 */
export default function AdminApp() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin/users" replace />} />
      <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
      {/* 后台独立登录页：无需认证（它就是认证入口本身） */}
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route
        path="/admin/:tab"
        element={
          <AdminGate>
            <AdminPage />
          </AdminGate>
        }
      />
      <Route path="*" element={<Navigate to="/admin/users" replace />} />
    </Routes>
  )
}
