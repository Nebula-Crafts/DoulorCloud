import { useLocation } from "react-router-dom"
import { FlaskConical, LayoutGrid } from "lucide-react"

import { NavLinkItem } from "@/components/sub-nav"
import { useT } from "@/i18n"

/**
 * 创想造物（gallery）的左侧二级导航——**只属于造物集**。
 *
 * 两项：
 *   展示大厅   `/dashboard/gallery`
 *   我的造物集 `/dashboard/gallery?view=mine`
 *
 * （游戏已整体迁出到顶级模块「模拟人生」/dashboard/sim，2026-10-25；
 *   那边不再挂本导航——游戏仓库大厅自己就是导航，游戏内页有返回链接。）
 *
 * ⚠️ 这里**全部是链接**（不是按钮切 state）：展示大厅 / 我的造物集用
 *    `?view=` 表达。统一走 URL 之后：高亮只有一份、刷新/分享/前进后退正常。
 */
export function GalleryAside() {
  const { t } = useT()
  const location = useLocation()

  const path = location.pathname.replace(/\/+$/, "") || "/"
  const isMine = new URLSearchParams(location.search).get("view") === "mine"

  return (
    <aside className="w-full shrink-0 lg:w-48">
      <nav className="flex flex-col gap-0.5">
        <NavLinkItem
          to="/dashboard/gallery"
          active={path === "/dashboard/gallery" && !isMine}
          icon={LayoutGrid}
          label={t("gal.tab.hall")}
        />
        <NavLinkItem
          to="/dashboard/gallery?view=mine"
          active={path === "/dashboard/gallery" && isMine}
          icon={FlaskConical}
          label={t("gal.tab.mine")}
        />

      </nav>
    </aside>
  )
}

/** 是不是「管理端」角色。与 dashboard-layout 里的判断同口径（那里也这么做） */
export function isAdminRole(role: string | undefined | null): boolean {
  return role === "admin" || role === "superadmin" || role === "root"
}
