import * as React from "react"
import { FeatureCardsSkeleton } from "@/components/skeletons"
import {
  CalendarCheck,
  ChevronUp,
  Coins,
  Crown,
  Loader2,
  ReceiptText,
  RotateCw,
  Send,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { CheckinDialog } from "@/components/checkin-dialog"
import { MemberLevelCards } from "@/components/member-level-cards"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { pointsApi, errMsg } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { notifyPointsChanged } from "@/components/points-badge"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"
import type { PointsOverview } from "@/types"
import { REASON_LABEL } from "@/pages/pointshop-shared"

/** 会员等级 → 展示 key（0=普通 1=黄金 2=白金 3=黑金，与 users.member_level 对应） */
const LEVEL_KEYS = ["lvl.0", "lvl.1", "lvl.2", "lvl.3"] as const
/** 卡面顶部那行英文等级名（与银行卡实体上的 MEMBER 字样同构） */
const LEVEL_EN_KEYS = ["pt.card.en0", "pt.card.en1", "pt.card.en2", "pt.card.en3"] as const

export default function PointsPage() {
  const { t } = useT()
  const { user } = useAuth()
  const [data, setData] = React.useState<PointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  // 积分明细弹窗
  const [detailOpen, setDetailOpen] = React.useState(false)

  // 每日签到 / 转账弹窗
  const [checkinOpen, setCheckinOpen] = React.useState(false)
  const [transferOpen, setTransferOpen] = React.useState(false)
  const [transferTo, setTransferTo] = React.useState("")
  const [transferAmount, setTransferAmount] = React.useState("")
  const [transferBusy, setTransferBusy] = React.useState(false)

  // 会员等级升级（只升不降）
  const [upgradeBusy, setUpgradeBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await pointsApi.overview())
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.load")))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])
  const balance = data?.balance ?? 0

  /** 转账：金额不能超过自己的余额（服务端也会再挡一次） */
  const transferValue = Math.floor(Number(transferAmount) || 0)
  const canTransfer =
    transferTo.trim().length > 0 &&
    transferValue >= 1 &&
    transferValue <= balance &&
    !transferBusy

  const handleTransfer = async () => {
    if (!canTransfer) return
    setTransferBusy(true)
    try {
      const res = await pointsApi.transfer(transferTo.trim(), transferValue)
      toast.success(t("pt.toast.transferred", { to: res.to, n: transferValue }))
      setTransferTo("")
      setTransferAmount("")
      setTransferOpen(false)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.transfer")))
    } finally {
      setTransferBusy(false)
    }
  }

  /**
   * 会员等级（2026-11-06）：等级只升不降，升级消耗积分，价格由管理后台配置。
   * `levelPrices` 键为下一级等级值（1/2/3），0 表示该等级未开放。
   */
  const level = data?.memberLevel ?? user?.memberLevel ?? 0
  const levelPrices = data?.levelPrices ?? {}
  const nextLevel = level < 3 ? level + 1 : null
  const nextPrice = nextLevel != null ? (levelPrices[nextLevel] ?? 0) : 0
  const canUpgrade =
    nextLevel != null && nextPrice > 0 && balance >= nextPrice && !upgradeBusy
  const pointsToNext =
    nextLevel != null && nextPrice > 0 ? Math.max(0, nextPrice - balance) : 0

  const handleUpgrade = async () => {
    if (!canUpgrade) return
    if (!confirm(t("pt.level.confirmUpgrade", { name: t(LEVEL_KEYS[nextLevel!]), n: nextPrice })))
      return
    setUpgradeBusy(true)
    try {
      const res = await pointsApi.upgradeLevel()
      toast.success(t("pt.level.upgraded", { name: res.levelName }))
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.level.upgradeFailed")))
    } finally {
      setUpgradeBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title={t("pt.pageTitle")}
        description={t("pt.pageDesc")}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            {t("common.refresh")}
          </Button>
        }
      />

      {loading && !data ? (
        <FeatureCardsSkeleton />
      ) : !data ? (
        <EmptyState
          title={t("pt.loadFailed")}
          description={t("pt.loadFailedDesc")}
          action={<Button onClick={() => void load()}>{t("common.retry")}</Button>}
        />
      ) : (
        <div className="space-y-6">
          {/* 余额 —— 「积分明细」收进右侧按钮的弹窗里，不再单独占页面一块 */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="space-y-1">
                <CardDescription>{t("pt.myPoints")}</CardDescription>
                <CardTitle className="flex items-baseline gap-2 text-4xl">
                  <Coins className="h-7 w-7 text-primary" />
                  {balance}

                </CardTitle>
              </div>
              {/**
               * 按钮区父容器：flex-wrap 让按钮在窄屏自动换行。
               * 每个按钮都是 whitespace-nowrap 的 flex 项，按钮再多也不会撑破卡片。
               */}
              <div className="flex flex-wrap items-center gap-2">
                {/* 每日签到：放在转账左边，作为积分获取的常驻入口 */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCheckinOpen(true)}
                >
                  <CalendarCheck className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.checkin")}
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTransferOpen(true)}
                  disabled={balance < 1}
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.transfer")}
                </Button>

                <Button variant="outline" size="sm" onClick={() => setDetailOpen(true)}>
                  <ReceiptText className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.detail")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {t("pt.usageHint")}
            </CardContent>
          </Card>

          {/* 会员等级：消耗积分升级，只升不降（2026-11-06） */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Crown className="h-4 w-4 text-amber-500" />
                  {t("pt.level.title")}
                </CardTitle>
                <CardDescription>{t("pt.level.desc")}</CardDescription>
              </div>
              {nextLevel != null && nextPrice > 0 ? (
                <Button size="sm" onClick={() => void handleUpgrade()} disabled={!canUpgrade}>
                  {upgradeBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ChevronUp className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("pt.level.next", { name: t(LEVEL_KEYS[nextLevel]), n: nextPrice })}
                </Button>
              ) : nextLevel != null ? (
                <Badge variant="outline" className="text-xs">
                  {t("pt.level.unavailable")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  <Crown className="mr-1 h-3 w-3" />
                  {t("pt.level.max")}
                </Badge>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {/* 四级一览：一张银行卡对应一个等级（居中一整张、两侧各露半张，可拖动） */}
              <MemberLevelCards
                balance={balance}
                cardNo={data?.cardNo ?? null}
                cards={LEVEL_KEYS.map((key, i) => ({
                  nameKey: key,
                  enKey: LEVEL_EN_KEYS[i],
                  price: i === 0 ? 0 : (levelPrices[i] ?? 0),
                  reached: i <= level,
                  current: i === level,
                }))}
              />
              {nextLevel != null && nextPrice > 0 && balance < nextPrice && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("pt.level.needMore", { n: pointsToNext })}
                </p>
              )}
            </CardContent>
          </Card>

        </div>
      )}

      {/* 积分明细 */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("pt.detail")}</DialogTitle>
            <DialogDescription>{t("pt.detailDesc")}</DialogDescription>
          </DialogHeader>
          {!data || data.transactions.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={t("pt.detailEmpty")}
              description={t("pt.detailEmptyDesc")}
            />
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {data.transactions.map((tx) => (
                <li key={tx.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {tx.detail || t(REASON_LABEL[tx.reason] ?? tx.reason)}
                    </p>
                    <p className="text-xs text-muted-foreground">{fmtDateTime(tx.createdAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={
                        tx.delta > 0
                          ? "text-sm font-medium text-emerald-600 dark:text-emerald-400"
                          : "text-sm font-medium text-muted-foreground"
                      }
                    >
                      {tx.delta > 0 ? `+${tx.delta}` : tx.delta}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {t(REASON_LABEL[tx.reason] ?? tx.reason)} ·{" "}
                      {t("pt.balanceSuffix", { n: tx.balance })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {/* 每日签到 */}
      <CheckinDialog open={checkinOpen} onOpenChange={setCheckinOpen} onDone={() => void load()} />

      {/* 转账弹窗：只需转出方确认，不需要对方同意 */}
      <Dialog open={transferOpen} onOpenChange={(o) => !transferBusy && setTransferOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("pt.transferTitle")}</DialogTitle>
            <DialogDescription>{t("pt.transferDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="transfer-to">{t("pt.transferTo")}</Label>
              <Input
                id="transfer-to"
                placeholder={t("pt.transferToPlaceholder")}
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transfer-amount">{t("pt.transferAmount")}</Label>
              <Input
                id="transfer-amount"
                inputMode="numeric"
                placeholder={t("pt.pointsPlaceholder")}
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value.replace(/\D/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                {transferValue > balance ? (
                  <span className="text-destructive">{t("pt.overBalance", { n: balance })}</span>
                ) : (
                  t("pt.balanceSuffix", { n: balance })
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTransferAmount(String(balance))}
                disabled={balance < 1}
              >
                {t("pt.transferAll")}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTransferOpen(false)}
              disabled={transferBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleTransfer()} disabled={!canTransfer}>
              {transferBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("pt.confirmTransfer")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
