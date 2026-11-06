import * as React from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  CalendarClock,
  CalendarCheck,
  Coins,
  Crown,
  Megaphone,
  MessageSquarePlus,
  Send,
  ShoppingBag,
  Sparkles,
  Store,
  Ticket,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { InstallAppButton } from "@/components/install-app-button"
import { DataFade } from "@/components/data-fade"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Markdown } from "@/components/markdown"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  announcementApi,
  eventApi,
  pointsApi,
  errMsg,
} from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { CheckinDialog } from "@/components/checkin-dialog"
import { fmtDateTime } from "@/lib/format"
import type { Announcement, EventItem, PointsOverview } from "@/types"
import { REASON_LABEL } from "@/pages/pointshop-shared"

/**
 * 概览页（2026-11-06 改版）。
 *
 * 站点裁撤后（社区 + 积分商城 + OAuth 是全部业务），概览聚焦五张卡：
 *   · 积分统计 —— 余额、今日收支、会员等级；
 *   · 积分变化 —— 最近的积分流水（订单式列表）；
 *   · 最近活动 —— 进行中 / 即将开始的站点活动（可参与）；
 *   · 网站动态 —— 公告列表（点击看全文）；
 *   · 快捷操作 —— 签到 / 商城 / 发帖 / 兑换 / 邀请 / 反馈直达。
 *
 * 固定布局（不再可拖拽编辑）：卡片数量收敛后布局没有排列自由度的必要，
 * 去掉 dnd-kit 也把页面最大的复杂度（拖拽实时重排 + 布局持久化）整个删掉。
 */

/** 今日 0 点（本地时区）——「今日收支」按它切分流水 */
function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 积分统计卡：余额 + 今日收支 + 等级 */
const PointsStatsCard = React.memo(function PointsStatsCard({
  data,
  loading,
}: {
  data: PointsOverview | null
  loading: boolean
}) {
  const { t } = useT()
  const { user } = useAuth()
  const balance = data?.balance ?? 0
  const level = data?.memberLevel ?? user?.memberLevel ?? 0

  // 今日收支：从最近 50 条流水里按「createdAt 在今天」汇总。
  // 50 条覆盖不了一整天的活跃用户属于极少数，概览给个参考值足够（精确数字去积分页看明细）。
  const todayStart = startOfToday()
  let todayIn = 0
  let todayOut = 0
  for (const tx of data?.transactions ?? []) {
    if (new Date(tx.createdAt).getTime() < todayStart) break
    if (tx.delta > 0) todayIn += tx.delta
    else todayOut += -tx.delta
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-4 w-4 text-primary" />
            {t("dash.pt.title")}
          </CardTitle>
          <CardDescription>{t("dash.pt.desc")}</CardDescription>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/dashboard/shop">
            <Store className="mr-1.5 h-3.5 w-3.5" />
            {t("dash.pt.goShop")}
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <DataFade loading={loading} skeleton={<Skeleton className="h-16 w-full" />}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="flex items-baseline gap-1.5 text-4xl font-semibold tabular-nums">
              <Coins className="h-6 w-6 text-primary" />
              {balance}
            </span>
            {level > 0 && (
              <Badge variant="outline" className="border-amber-500 text-amber-600">
                <Crown className="mr-1 h-3 w-3" />
                {t(`lvl.${level}`)}
              </Badge>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-md border p-2.5">
              <p className="text-xs text-muted-foreground">{t("dash.pt.todayIn")}</p>
              <p className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                +{todayIn}
              </p>
            </div>
            <div className="rounded-md border p-2.5">
              <p className="text-xs text-muted-foreground">{t("dash.pt.todayOut")}</p>
              <p className="text-sm font-semibold tabular-nums text-muted-foreground">
                -{todayOut}
              </p>
            </div>
          </div>
        </DataFade>
      </CardContent>
    </Card>
  )
})

/** 积分变化卡：最近的积分流水（订单式） */
const PointsOrdersCard = React.memo(function PointsOrdersCard({
  data,
  loading,
}: {
  data: PointsOverview | null
  loading: boolean
}) {
  const { t } = useT()
  const transactions = (data?.transactions ?? []).slice(0, 7)
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("dash.ptOrders.title")}</CardTitle>
          <CardDescription>{t("dash.ptOrders.desc")}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/points">
            {t("dash.ptOrders.viewAll")}
            <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <DataFade loading={loading} skeleton={<Skeleton className="h-40 w-full" />}>
          {transactions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("dash.ptOrders.empty")}
            </p>
          ) : (
            <ul className="divide-y">
              {transactions.map((tx) => (
                <li key={tx.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {tx.detail || t(REASON_LABEL[tx.reason] ?? tx.reason)}
                    </p>
                    <p className="text-xs text-muted-foreground">{fmtDateTime(tx.createdAt)}</p>
                  </div>
                  <p
                    className={cn(
                      "shrink-0 text-sm font-medium tabular-nums",
                      tx.delta > 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    )}
                  >
                    {tx.delta > 0 ? `+${tx.delta}` : tx.delta}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DataFade>
      </CardContent>
    </Card>
  )
})

/** 最近活动卡：进行中 / 即将开始的站点活动 */
const EventsCard = React.memo(function EventsCard({
  events,
  loading,
}: {
  events: EventItem[]
  loading: boolean
}) {
  const { t } = useT()
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Ticket className="h-4 w-4 text-primary" />
            {t("dash.events.title")}
          </CardTitle>
          <CardDescription>{t("dash.events.desc")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <DataFade loading={loading} skeleton={<Skeleton className="h-32 w-full" />}>
          {events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("dash.events.empty")}
            </p>
          ) : (
            <ul className="space-y-2">
              {events.slice(0, 4).map((e) => {
                const time = e.endsAt
                  ? t("dash.events.endsAt", { time: fmtDateTime(e.endsAt) })
                  : e.startsAt
                    ? t("dash.events.startsAt", { time: fmtDateTime(e.startsAt) })
                    : null
                return (
                  <li key={e.id}>
                    <Link
                      to={`/activity/${e.id}`}
                      className="block rounded-md border p-2.5 transition-colors hover:bg-accent"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-medium">{e.title}</p>
                        {e.rewardLabel && (
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {e.rewardLabel}
                          </Badge>
                        )}
                      </div>
                      {time && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarClock className="h-3 w-3" />
                          {time}
                        </p>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </DataFade>
      </CardContent>
    </Card>
  )
})

/** 网站动态卡：公告列表 + 点击看全文 */
const AnnouncementsCard = React.memo(function AnnouncementsCard({
  items,
  loading,
}: {
  items: Announcement[]
  loading: boolean
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState<Announcement | null>(null)
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4 text-primary" />
            {t("dash.announcements")}
          </CardTitle>
          <CardDescription>{t("dash.announcementsDesc")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <DataFade loading={loading} skeleton={<Skeleton className="h-32 w-full" />}>
          {items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("dash.annEmpty")}
            </p>
          ) : (
            <ul className="divide-y">
              {items.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 py-2 text-left"
                    onClick={() => setOpen(a)}
                  >
                    <span className="min-w-0 truncate text-sm">
                      {a.pinned && (
                        <Badge variant="secondary" className="mr-1.5 text-[10px]">
                          {t("dash.annPinned")}
                        </Badge>
                      )}
                      {a.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {a.publishedAt ? fmtDateTime(a.publishedAt) : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DataFade>

        {/* 公告全文 */}
        <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="break-all">{open?.title}</DialogTitle>
              <DialogDescription>
                {open?.publishedAt ? fmtDateTime(open.publishedAt) : ""}
              </DialogDescription>
            </DialogHeader>
            {open && <Markdown>{open.body}</Markdown>}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
})

/** 快捷操作卡：常用动作直达 */
const QuickActions = React.memo(function QuickActions() {
  const { t } = useT()
  const [checkinOpen, setCheckinOpen] = React.useState(false)

  const actions = [
    {
      key: "checkin",
      label: t("pt.checkin"),
      icon: CalendarCheck,
      onClick: () => setCheckinOpen(true),
    },
    {
      key: "shop",
      label: t("dash.quick.shop"),
      icon: ShoppingBag,
      to: "/dashboard/shop",
    },
    {
      key: "post",
      label: t("dash.quick.post"),
      icon: MessageSquarePlus,
      to: "/dashboard/community",
    },
    {
      key: "points",
      label: t("pt.detail"),
      icon: Coins,
      to: "/dashboard/points",
    },
    {
      key: "transfer",
      label: t("pt.transfer"),
      icon: Send,
      to: "/dashboard/points",
    },
    {
      key: "invite",
      label: t("dash.quick.invite"),
      icon: Sparkles,
      to: "/dashboard/settings",
    },
    {
      key: "feedback",
      label: t("nav.feedback"),
      icon: Megaphone,
      to: "/dashboard/feedback",
    },
  ] as const

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">{t("dash.quickActions")}</CardTitle>
        <CardDescription>{t("dash.quickActionsDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {actions.map((a) => {
            const Icon = a.icon
            const inner = (
              <>
                <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0 truncate">{a.label}</span>
              </>
            )
            return "to" in a && a.to ? (
              <Button
                key={a.key}
                variant="outline"
                size="sm"
                className="justify-start"
                asChild
              >
                <Link to={a.to}>{inner}</Link>
              </Button>
            ) : (
              <Button
                key={a.key}
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={a.onClick}
              >
                {inner}
              </Button>
            )
          })}
        </div>
        {/* 签到弹窗：签到完成无需刷新整页 —— 积分徽章自己会跟着变 */}
        <CheckinDialog open={checkinOpen} onOpenChange={setCheckinOpen} />
      </CardContent>
    </Card>
  )
})

export default function DashboardPage() {
  const { t } = useT()
  const { user } = useAuth()

  /** 积分（余额/流水/等级）与公告、活动分开拉，互不阻塞 */
  const [points, setPoints] = React.useState<PointsOverview | null>(null)
  const [pointsLoading, setPointsLoading] = React.useState(true)
  const [announcements, setAnnouncements] = React.useState<Announcement[]>([])
  const [announcementsLoading, setAnnouncementsLoading] = React.useState(true)
  const [events, setEvents] = React.useState<EventItem[]>([])
  const [eventsLoading, setEventsLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    pointsApi
      .overview()
      .then((res) => !cancelled && setPoints(res))
      .catch((err) => {
        if (!cancelled) toast.error(errMsg(err, t("dash.err.points")))
      })
      .finally(() => !cancelled && setPointsLoading(false))
    announcementApi
      .list()
      .then((res) => !cancelled && setAnnouncements(res.announcements))
      .catch(() => {
        // 公告拉不到就安静地空着：概览不是公告页，不该为它弹全局错误
      })
      .finally(() => !cancelled && setAnnouncementsLoading(false))
    eventApi
      .list()
      .then((res) => {
        if (cancelled) return
        // 只展示进行中的；即将开始（scheduled）的活动没有到点也不可参与，不占位置
        setEvents(res.events.filter((e) => e.status === "active"))
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
      .finally(() => !cancelled && setEventsLoading(false))
    return () => {
      cancelled = true
    }
  }, [t])

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("dash.welcome", { name: user?.username ?? "" })}
        actions={<InstallAppButton />}
      />

      {/* 主体：桌面双列。左列=积分（统计/变化/快捷），右列=站点（动态/活动） */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <PointsStatsCard data={points} loading={pointsLoading} />
          <PointsOrdersCard data={points} loading={pointsLoading} />
          <QuickActions />
        </div>
        <div className="space-y-6">
          <AnnouncementsCard items={announcements} loading={announcementsLoading} />
          <EventsCard events={events} loading={eventsLoading} />
        </div>
      </div>
    </div>
  )
}
