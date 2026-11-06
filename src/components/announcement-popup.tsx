/**
 * 全站公告弹窗（2026-11-06 恢复）。
 *
 * 背景：概览页改版（00a3281）时把原来的 `AnnouncementPopup` 一起删掉了，
 * 导致后台配置的 `popup_mode`（不弹 / 弹一次 / 每次都弹）变成**完全无效果**的
 * 死配置 —— 公告只出现在概览页的「网站动态」卡片里，从不主动弹出。
 * 这里把它以独立组件的形式恢复，并挂到 dashboard 布局上（不再只在概览页生效，
 * 用户从任何 /dashboard/* 页面进来都该看到）。
 *
 * 行为约定（与原实现一致）：
 *   * `none` —— 不弹；
 *   * `once` —— 弹一次，「知道了」= 已读，永久不再弹（本地 + 服务端各记一笔）；
 *   * `every` —— 每次进入都弹，但同一会话里点过「知道了」就不再重复；
 *   * 「不再显示」按钮只在 `every` 下出现（`once` 的「知道了」本身就是永久关闭）；
 *   * 多条待弹时排成队列，顶部显示 1/2 这样的批次计数，点完一条翻下一条。
 *
 * 记忆策略：服务端 `announcement_dismissals` 是真相源（换设备 / 清缓存仍然作数），
 * localStorage 只是首屏快读缓存（避免先弹一下再收回），sessionStorage 记「本会话
 * 已看过」给 `every` 用。
 */
import * as React from "react"
import { Megaphone } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/markdown"
import { announcementApi } from "@/services/api"
import { loadAnnouncements } from "@/lib/announcement-cache"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import type { Announcement } from "@/types"

/** 「不再显示」的本地键（服务端记录见 POST /announcements/:id/dismiss） */
const ANN_SEEN_PREFIX = "doulor:ann-seen:"
/** `every` 公告「知道了」的会话级记忆键 */
const ANN_SESSION_PREFIX = "doulor:ann-seen-session:"

/**
 * 读写浏览器存储，一律吞异常。
 * 隐私模式 / 存储被禁用 / 配额满时 `setItem` 会抛 —— 弹窗本身不能因此崩掉，
 * 记忆失败最多是「下次还弹」，比白屏好。
 */
function readAnnFlag(storage: "local" | "session", key: string): boolean {
  try {
    const s = storage === "local" ? window.localStorage : window.sessionStorage
    return s.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeAnnFlag(storage: "local" | "session", key: string): void {
  try {
    const s = storage === "local" ? window.localStorage : window.sessionStorage
    s.setItem(key, "1")
  } catch {
    /* 忽略：见 readAnnFlag 的说明 */
  }
}

/** 这条公告现在该不该弹 */
export function shouldPopupAnnouncement(a: Announcement): boolean {
  if (a.popupMode === "none") return false
  // 服务端记录是真相源（换设备 / 清缓存 / 重装后依然作数）
  if (a.dismissed) return false
  if (readAnnFlag("local", ANN_SEEN_PREFIX + a.id)) return false
  // every 公告：本会话已点过「知道了」，这次访问不再重复弹
  if (a.popupMode === "every" && readAnnFlag("session", ANN_SESSION_PREFIX + a.id)) {
    return false
  }
  return true
}

export function AnnouncementPopupGate() {
  const { t } = useT()
  const { user, loading } = useAuth()
  const [queue, setQueue] = React.useState<Announcement[]>([])
  const [index, setIndex] = React.useState(0)
  /**
   * 本次挂载是否已经把公告判定成队列。
   * 布局在路由切换之间不重挂载，所以这个 ref 只在「退出登录」时重置。
   */
  const applied = React.useRef(false)

  React.useEffect(() => {
    if (loading) return
    if (!user) {
      applied.current = false
      setQueue([])
      return
    }
    // ⚠️ 只在**成功应用队列之后**才标记「已判定」，不能像最初那样在发请求前就标记：
    //    React StrictMode 会把 effect 跑两遍（第一次立刻 cleanup 置 cancelled），
    //    若提前标记，第二次一看「已判定」直接 return —— 而唯一还在跑的请求的
    //    then 属于已被取消的那次，结果就是公告永远不弹（2026-11-06 实测踩到）。
    if (applied.current) return
    let cancelled = false
    loadAnnouncements()
      .then((list) => {
        if (cancelled || applied.current) return
        applied.current = true
        const pending = list.filter(shouldPopupAnnouncement)
        if (pending.length > 0) {
          setIndex(0)
          setQueue(pending)
        }
      })
      .catch(() => {
        // 静默：公告不是门禁，接口抖动不该打扰用户
      })
    return () => {
      cancelled = true
    }
  }, [loading, user])

  const current = queue[index]
  if (!current) return null

  /** 翻到下一条；队列走完就收窗 */
  const advance = () => {
    if (index + 1 < queue.length) setIndex(index + 1)
    else setQueue([])
  }

  /** 永久不再弹：本地 + 服务端各记一笔 */
  const hideForever = () => {
    writeAnnFlag("local", ANN_SEEN_PREFIX + current.id)
    // 服务端落库是真相源；失败也不打断交互（本地已记住，下次进来少弹这一条）
    void announcementApi.dismiss(current.id).catch(() => {})
    advance()
  }

  /** 「知道了」：once = 已读（永久）；every = 只记本次会话 */
  const gotIt = () => {
    if (current.popupMode === "once") {
      hideForever()
      return
    }
    writeAnnFlag("session", ANN_SESSION_PREFIX + current.id)
    advance()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && gotIt()}>
      <DialogContent className="max-w-2xl">
        {/* key = 公告 id：换一条就重挂载一次，从而重放卡片推入动效 */}
        <div key={current.id} className="ann-card-swap space-y-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <Megaphone className="h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">{current.title}</span>
              {queue.length > 1 && (
                <span
                  title={t("dash.dialog.batchHint", { n: queue.length })}
                  className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
                >
                  {index + 1}/{queue.length}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="announcement-scroll max-h-[60vh] overflow-y-auto pr-3">
            <Markdown>{current.body}</Markdown>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            {current.popupMode === "every" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={hideForever}
                className="text-muted-foreground"
              >
                {t("dash.dialog.hideForever")}
              </Button>
            )}
            <Button onClick={gotIt}>{t("dash.dialog.gotIt")}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}