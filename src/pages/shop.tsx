import * as React from "react"
import { FeatureCardsSkeleton } from "@/components/skeletons"
import { Link } from "react-router-dom"
import {
  CalendarClock,
  Check,
  ChevronDown,
  Coins,
  Flame,
  Loader2,
  Package,
  RefreshCw,
  ShoppingBag,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { AnchoredPanel } from "@/components/anchored-panel"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { pointsApi, errMsg, HttpError } from "@/services/api"
import { notifyPointsChanged } from "@/components/points-badge"
import { fmtDateTime } from "@/lib/format"
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from "@/types"
import { shopIcon } from "@/lib/shop-icons"
import { useT, tStatic } from "@/i18n"
import type { PointOrder, PointProduct, PointsOverview } from "@/types"
import {
  AFTER_SALE_DIALOG,
  AFTER_SALE_STATUS,
  ORDER_STATUS,
  DeliveryContentBlock,
  buyHint,
  canEscalateAfterSale,
  canRejectDelivery,
  canRequestAfterSale,
  canWithdrawAfterSale,
  isRentalExpired,
  needsNewapiBinding,
  orderStatusText,
  rentalBuyHint,
  rentalOrderText,
  rentalTerm,
} from "@/pages/pointshop-shared"

/**
 * 商城页（2026-11-06 收敛版）。
 *
 * 商品全部由**管理员**在「管理面板 → 积分 → 商城」发布，用户没有上架入口
 * （原「用户们的商城」与上架/审核链路已下线，历史订单与售后照常可用）。
 *
 * 布局：
 *   · 顶部：标题 + 余额 + 「我的订单」（带待处理角标）
 *   · 筛选条：分类（全部 / IT / 其他）+ 热度 + 只看有货，统一作用于同一面商品墙
 *   · 商品墙：响应式 1 / 2 / 3 / 4 列，卡片等高（封面固定高度、描述两行截断）
 */
export default function ShopPage() {
  const { t } = useT()
  const [data, setData] = React.useState<PointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  // 购买 / 详情
  const [buyTarget, setBuyTarget] = React.useState<PointProduct | null>(null)
  const [buyBusy, setBuyBusy] = React.useState(false)
  const [detailTarget, setDetailTarget] = React.useState<PointProduct | null>(null)

  // 筛选
  const [cat, setCat] = React.useState<ProductCategory | "all">("all")
  const [sortHot, setSortHot] = React.useState(false)
  const [stockOnly, setStockOnly] = React.useState(false)

  // 「我的订单」二级菜单
  const [tradesMenuOpen, setTradesMenuOpen] = React.useState(false)
  const tradesBtnRef = React.useRef<HTMLDivElement | null>(null)
  const [tradesView, setTradesView] = React.useState<null | "todo" | "bought" | "sold">(null)

  // 售后（历史担保订单）
  const [afterSaleTarget, setAfterSaleTarget] = React.useState<PointOrder | null>(null)
  const [afterSaleMode, setAfterSaleMode] = React.useState<
    "request" | "reject" | "rejectDelivery"
  >("request")
  const [afterSaleText, setAfterSaleText] = React.useState("")
  const [afterSaleBusy, setAfterSaleBusy] = React.useState(false)

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
  const products = data?.products ?? []

  const visible = React.useMemo(() => {
    let list = cat === "all" ? products : products.filter((p) => p.category === cat)
    if (stockOnly) list = list.filter((p) => p.stock === null || p.stock > 0)
    if (sortHot) list = [...list].sort((a, b) => b.soldCount - a.soldCount)
    return list
  }, [products, cat, stockOnly, sortHot])

  const buyIsUserProduct = !!buyTarget?.ownerId
  const buyTargetAffordable = !!buyTarget && buyTarget.price <= balance
  const buyTargetNeedsBind = !!buyTarget && needsNewapiBinding(buyTarget.delivery) && !data?.bound
  const canBuy = buyTargetAffordable && !buyTargetNeedsBind && !buyBusy

  const handleBuy = async () => {
    if (!buyTarget || !canBuy) return
    setBuyBusy(true)
    try {
      const res = await pointsApi.buy(buyTarget.id)
      const term =
        res.order.billingMode === "rental"
          ? t("pt.rental.termParen", { term: rentalTerm(res.order.rentalDays) })
          : ""
      toast.success(
        res.order.status === "delivered"
          ? res.order.deliveryContent
            ? t("pt.toast.boughtAutoDm", { name: res.order.productName, term })
            : t("pt.toast.boughtAuto", {
                name: res.order.productName,
                term,
                note: res.order.note ?? t("pt.autoDelivered"),
              })
          : res.order.sellerId
            ? t("pt.toast.boughtUser", { name: res.order.productName, term })
            : t("pt.toast.boughtManual", { name: res.order.productName, term })
      )
      setBuyTarget(null)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.buy")))
    } finally {
      setBuyBusy(false)
    }
  }

  /** 买家确认收货 —— 历史担保订单（用户商品）仍需这一步 */
  const confirmReceipt = async (o: PointOrder) => {
    const rentalNote =
      o.billingMode === "rental"
        ? "\n\n" + t("pt.rental.noteFromReceipt", { n: o.rentalDays ?? "?" })
        : ""
    if (
      !confirm(t("pt.confirm.receipt", { name: o.productName, price: o.price, note: rentalNote }))
    )
      return
    try {
      await pointsApi.confirmReceipt(o.id)
      toast.success(t("pt.toast.receiptConfirmed"))
      notifyPointsChanged()
      await load()
    } catch (err) {
      // 已结算不是错误（上一次点击其实成功了），按成功处理并刷新
      if (err instanceof HttpError && err.code === "ALREADY_SETTLED") {
        toast.success(t("pt.toast.receiptConfirmed"))
        notifyPointsChanged()
        await load()
        return
      }
      toast.error(errMsg(err, t("pt.err.confirmReceipt")))
    }
  }

  // ---- 售后 ----

  const openAfterSale = (o: PointOrder) => {
    setAfterSaleMode("request")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }
  const openAfterSaleReject = (o: PointOrder) => {
    setAfterSaleMode("reject")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }
  const openRejectDelivery = (o: PointOrder) => {
    setAfterSaleMode("rejectDelivery")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }

  const submitAfterSale = async () => {
    const o = afterSaleTarget
    if (!o) return
    const text = afterSaleText.trim()
    if ((afterSaleMode === "request" || afterSaleMode === "rejectDelivery") && text.length < 4) {
      toast.error(t("pt.afterSale.reasonTooShort"))
      return
    }
    if (afterSaleMode === "reject" && !text) {
      toast.error(t("pt.afterSale.rejectNeedReason"))
      return
    }
    setAfterSaleBusy(true)
    try {
      if (afterSaleMode === "request") {
        await pointsApi.requestAfterSale(o.id, text)
        toast.success(t("pt.toast.afterSaleRequested"))
      } else if (afterSaleMode === "rejectDelivery") {
        await pointsApi.rejectOrder(o.id, text)
        toast.success(t("pt.toast.rejected"))
      } else {
        await pointsApi.sellerResolveAfterSale(o.id, false, text)
        toast.success(t("pt.toast.afterSaleRejected"))
      }
      setAfterSaleTarget(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    } finally {
      setAfterSaleBusy(false)
    }
  }

  const approveAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmApprove", { name: o.productName, price: o.price }))) return
    try {
      await pointsApi.sellerResolveAfterSale(o.id, true)
      toast.success(t("pt.toast.afterSaleApproved"))
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  const withdrawAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmWithdraw"))) return
    try {
      await pointsApi.cancelAfterSale(o.id)
      toast.success(t("pt.toast.afterSaleWithdrawn"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  const escalateAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmEscalate"))) return
    try {
      await pointsApi.escalateAfterSale(o.id)
      toast.success(t("pt.toast.afterSaleEscalated"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  const sellerDeliver = async (o: PointOrder) => {
    if (!confirm(t("pt.confirm.deliver", { name: o.productName }))) return
    try {
      await pointsApi.sellerDeliver(o.id)
      toast.success(t("pt.toast.delivered"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.op")))
    }
  }

  const orders: PointOrder[] = data?.orders ?? []
  const sellerOrders: PointOrder[] = data?.sellerOrders ?? []
  const todoSellerOrders = sellerOrders.filter((o) => o.status === "pending").length
  const todoConfirm = orders.filter((o) => o.sellerId !== null && o.status === "delivered").length
  const todoCount = todoSellerOrders + todoConfirm

  const openTradesView = (v: "todo" | "bought" | "sold") => {
    setTradesMenuOpen(false)
    setTradesView(v)
  }

  /** 续费：订单对应的商品还在卖时，重新走一遍购买 */
  const renewTarget = (o: PointOrder): PointProduct | null => {
    if (!o.productId || o.billingMode !== "rental" || o.status === "cancelled") return null
    return data?.products.find((p) => p.id === o.productId) ?? null
  }

  const renderTodoList = () => (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <ul className="space-y-2">
        {sellerOrders
          .filter((o) => o.status === "pending")
          .map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{t("pt.todo.ship", { name: o.productName })}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.todo.shipMeta", { user: o.username, n: o.price })}
                </p>
              </div>
              <Button size="sm" className="shrink-0" onClick={() => void sellerDeliver(o)}>
                {t("pt.markDelivered")}
              </Button>
            </li>
          ))}
        {orders
          .filter((o) => o.sellerId !== null && o.status === "delivered")
          .map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{t("pt.todo.receive", { name: o.productName })}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.todo.receiveMeta", { seller: o.sellerName ?? "?", price: o.price })}
                </p>
              </div>
              <Button size="sm" className="shrink-0" onClick={() => void confirmReceipt(o)}>
                {t("pt.confirmReceipt")}
              </Button>
            </li>
          ))}
      </ul>
    </div>
  )

  const renderBoughtList = () =>
    orders.length === 0 ? (
      <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
        {t("pt.boughtEmpty")}
      </p>
    ) : (
      <ul className="divide-y">
        {orders.map((o) => {
          const isUserOrder = o.sellerId !== null
          const st = ORDER_STATUS[o.status] ?? ORDER_STATUS.pending
          const rental = rentalOrderText(o)
          const expired = isRentalExpired(o)
          const renew = renewTarget(o)
          return (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {o.productName}
                  {o.billingMode === "rental" && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      {rentalTerm(o.rentalDays)}
                    </Badge>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {fmtDateTime(o.createdAt)}
                  {isUserOrder ? ` · ${t("pt.sellerLabel")} ${o.sellerName ?? "?"}` : ""}
                  {isUserOrder && o.sellerName && (
                    <>
                      {" · "}
                      <Link
                        to={`/dashboard/dm/${encodeURIComponent(o.sellerName)}`}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        {t("pt.sendDm")}
                      </Link>
                    </>
                  )}
                  {o.note ? ` · ${o.note}` : ""}
                </p>
                {rental && (
                  <p
                    className={
                      expired
                        ? "text-xs font-medium text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {rental}
                  </p>
                )}
                {o.deliveryContent && o.status !== "cancelled" && (
                  <DeliveryContentBlock content={o.deliveryContent} />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <div>
                  <p className="text-sm font-medium tabular-nums text-muted-foreground">
                    -{o.price}
                  </p>
                  <div className="mt-0.5 flex flex-col items-end gap-1">
                    <Badge variant={st.variant} className="text-[10px]">
                      {t(orderStatusText(o.status, isUserOrder))}
                    </Badge>
                    {o.afterSaleStatus && (
                      <Badge
                        variant={AFTER_SALE_STATUS[o.afterSaleStatus].variant}
                        className="text-[10px]"
                      >
                        {t(AFTER_SALE_STATUS[o.afterSaleStatus].label)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {isUserOrder && o.status === "delivered" && (
                    <Button size="sm" onClick={() => void confirmReceipt(o)}>
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t("pt.confirmReceipt")}
                    </Button>
                  )}
                  {canRequestAfterSale(o) && (
                    <Button size="sm" variant="outline" onClick={() => openAfterSale(o)}>
                      {t("pt.afterSale.request")}
                    </Button>
                  )}
                  {canRejectDelivery(o) && (
                    <Button size="sm" variant="outline" onClick={() => openRejectDelivery(o)}>
                      {t("pt.afterSale.rejectDelivery")}
                    </Button>
                  )}
                  {canEscalateAfterSale(o) && (
                    <Button size="sm" variant="outline" onClick={() => void escalateAfterSale(o)}>
                      {t("pt.afterSale.escalate")}
                    </Button>
                  )}
                  {canWithdrawAfterSale(o) && (
                    <Button size="sm" variant="ghost" onClick={() => void withdrawAfterSale(o)}>
                      {t("pt.afterSale.withdraw")}
                    </Button>
                  )}
                </div>
                {renew && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBuyTarget(renew)}
                    title={expired ? t("pt.renewExpiredTip") : t("pt.renewTip")}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    {t("pt.renew")}
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    )

  const renderSoldList = () =>
    sellerOrders.length === 0 ? (
      <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
        {t("pt.soldEmpty")}
      </p>
    ) : (
      <ul className="divide-y rounded-md border">
        {sellerOrders.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {o.productName}
                {o.billingMode === "rental" && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px]">
                    {rentalTerm(o.rentalDays)}
                  </Badge>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t("pt.soldMeta", { user: o.username, time: fmtDateTime(o.createdAt) })}
                {" · "}
                <Link
                  to={`/dashboard/dm/${encodeURIComponent(o.username)}`}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {t("pt.sendDm")}
                </Link>
              </p>
              {rentalOrderText(o) && (
                <p className="text-xs text-muted-foreground">{rentalOrderText(o)}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium tabular-nums">+{o.price}</span>
              <div className="flex flex-col items-end gap-1">
                {o.status === "pending" ? (
                  <Button size="sm" onClick={() => void sellerDeliver(o)}>
                    {t("pt.markDelivered")}
                  </Button>
                ) : (
                  <Badge
                    variant={(ORDER_STATUS[o.status] ?? ORDER_STATUS.pending).variant}
                    className="text-[10px]"
                  >
                    {t(orderStatusText(o.status, true))}
                  </Badge>
                )}
                {o.afterSaleStatus === "requested" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void approveAfterSale(o)}>
                      {t("pt.afterSale.approve")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openAfterSaleReject(o)}>
                      {t("pt.afterSale.reject")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    )

  /** 分类筛选项 */
  const CATS: { key: ProductCategory | "all"; label: string }[] = [
    { key: "all", label: "pt.cat.all" },
    { key: "it", label: PRODUCT_CATEGORY_LABELS.it },
    { key: "other", label: PRODUCT_CATEGORY_LABELS.other },
  ]

  return (
    <div>
      <PageHeader
        title={t("shop.pageTitle")}
        description={t("shop.pageDesc")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm">
              <Coins className="h-4 w-4 text-primary" />
              <span className="tabular-nums">{balance}</span>
            </span>
            {/* 我的订单：二级菜单（待处理 / 我买到的 / 我卖出的） */}
            <div ref={tradesBtnRef} className="relative">
              <Button variant="outline" size="sm" onClick={() => setTradesMenuOpen((v) => !v)}>
                <Package className="mr-1.5 h-3.5 w-3.5" />
                {t("pt.myTrades")}
                {todoCount > 0 && (
                  <Badge
                    variant="default"
                    className="ml-1.5 h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
                  >
                    {todoCount}
                  </Badge>
                )}
                <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
              </Button>
              <AnchoredPanel
                anchorRef={tradesBtnRef}
                open={tradesMenuOpen}
                onClose={() => setTradesMenuOpen(false)}
                width={208}
                height={172}
              >
                <div className="space-y-0.5 p-1">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => openTradesView("todo")}
                  >
                    <span>{t("pt.todoTitle")}</span>
                    {todoCount > 0 && (
                      <Badge variant="default" className="text-[10px]">
                        {todoCount}
                      </Badge>
                    )}
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => openTradesView("bought")}
                  >
                    {t("pt.boughtTitle", { n: orders.length })}
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => openTradesView("sold")}
                  >
                    {t("pt.soldTitle", { n: sellerOrders.length })}
                  </button>
                </div>
              </AnchoredPanel>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("common.refresh")}
            </Button>
          </div>
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
        <div className="space-y-5">
          {/* 筛选条 */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/60 p-3">
            <ShoppingBag className="h-4 w-4 shrink-0 text-primary" />
            {CATS.map((c) => (
              <Button
                key={c.key}
                size="sm"
                variant={cat === c.key ? "default" : "outline"}
                onClick={() => setCat(c.key)}
              >
                {t(c.label)}
              </Button>
            ))}
            <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
            <Button
              size="sm"
              variant={sortHot ? "default" : "outline"}
              onClick={() => setSortHot((v) => !v)}
            >
              <Flame className="mr-1.5 h-3.5 w-3.5" />
              {t("pt.sortHot")}
            </Button>
            <Button
              size="sm"
              variant={stockOnly ? "default" : "outline"}
              onClick={() => setStockOnly((v) => !v)}
            >
              <Package className="mr-1.5 h-3.5 w-3.5" />
              {t("pt.inStockOnly")}
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              {t("shop.count", { n: visible.length })}
            </span>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={ShoppingBag}
              title={products.length === 0 ? t("shop.empty") : t("shop.emptyFiltered")}
              description={
                products.length === 0 ? t("shop.emptyDesc") : t("shop.emptyFilteredDesc")
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((p) => {
                const stockSoldOut = p.stock !== null && p.stock <= 0
                const dailyRemaining =
                  p.dailyLimit != null ? Math.max(0, p.dailyLimit - (p.dailySold ?? 0)) : null
                const dailySoldOut = dailyRemaining != null && dailyRemaining <= 0
                const soldOut = stockSoldOut || dailySoldOut
                const tooExpensive = p.price > balance
                const isRental = p.billingMode === "rental"
                const Icon = shopIcon(p.icon)
                return (
                  <Card
                    key={p.id}
                    className="flex min-w-0 cursor-pointer flex-col overflow-hidden transition-shadow hover:shadow-md"
                    onClick={() => setDetailTarget(p)}
                  >
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt={p.name}
                        loading="lazy"
                        className="h-32 w-full shrink-0 object-cover"
                      />
                    ) : (
                      <div className="flex h-32 w-full shrink-0 items-center justify-center bg-gradient-to-br from-primary/15 via-primary/5 to-transparent">
                        <Icon className="h-14 w-14 text-primary" strokeWidth={1.25} aria-hidden />
                      </div>
                    )}

                    <CardHeader className="space-y-1.5 p-4 pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="line-clamp-1 min-w-0 text-sm">{p.name}</CardTitle>
                        <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                          {t(PRODUCT_CATEGORY_LABELS[p.category] ?? PRODUCT_CATEGORY_LABELS.other)}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        {isRental && (
                          <Badge variant="secondary" className="text-[10px]">
                            <CalendarClock className="mr-0.5 h-2.5 w-2.5" />
                            {rentalTerm(p.rentalDays)}
                          </Badge>
                        )}
                        {p.stock !== null && (
                          <span>{t("pt.leftPieces", { n: Math.max(0, p.stock) })}</span>
                        )}
                        {p.dailyLimit != null && !stockSoldOut && (
                          <span className={dailySoldOut ? "text-destructive" : ""}>
                            {dailySoldOut
                              ? t("pt.dailySoldOut")
                              : t("pt.dailyLeft", { n: dailyRemaining ?? 0 })}
                          </span>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="flex flex-1 flex-col justify-between gap-3 p-4 pt-0">
                      <p className="line-clamp-2 break-all text-xs text-muted-foreground">
                        {p.description || deliveryHint(p.delivery)}
                      </p>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-baseline gap-1">
                          <span className="text-lg font-semibold tabular-nums">{p.price}</span>
                          <span className="text-xs text-muted-foreground">
                            {t("pt.unit")}
                            {isRental ? ` / ${t("pt.days", { n: p.rentalDays ?? 0 })}` : ""}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant={soldOut || tooExpensive ? "outline" : "default"}
                          disabled={soldOut}
                          onClick={(e) => {
                            e.stopPropagation()
                            setBuyTarget(p)
                          }}
                        >
                          {soldOut
                            ? isRental
                              ? t("pt.rentedOut")
                              : t("pt.soldOut")
                            : tooExpensive
                              ? t("pt.insufficientShort")
                              : isRental
                                ? t("pt.rental.rental")
                                : t("pt.buy")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 我的订单弹窗 */}
      <Dialog open={tradesView !== null} onOpenChange={(o) => !o && setTradesView(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {tradesView === "todo"
                ? t("pt.todoTitle")
                : tradesView === "bought"
                  ? t("pt.boughtTitle", { n: orders.length })
                  : t("pt.soldTitle", { n: sellerOrders.length })}
            </DialogTitle>
            <DialogDescription>{t("pt.tradesDesc")}</DialogDescription>
          </DialogHeader>
          {tradesView === "todo" ? (
            todoCount > 0 ? (
              renderTodoList()
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("pt.todoNone")}</p>
            )
          ) : tradesView === "bought" ? (
            renderBoughtList()
          ) : (
            renderSoldList()
          )}
        </DialogContent>
      </Dialog>

      {/* 售后对话框 */}
      <Dialog
        open={afterSaleTarget !== null}
        onOpenChange={(v) => {
          if (!v) setAfterSaleTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t(AFTER_SALE_DIALOG[afterSaleMode].title)}</DialogTitle>
            <DialogDescription>{t(AFTER_SALE_DIALOG[afterSaleMode].desc)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="afterSaleText">{t(AFTER_SALE_DIALOG[afterSaleMode].label)}</Label>
            <Textarea
              id="afterSaleText"
              value={afterSaleText}
              onChange={(e) => setAfterSaleText(e.target.value)}
              maxLength={300}
              rows={3}
              placeholder={t(AFTER_SALE_DIALOG[afterSaleMode].placeholder)}
            />
            {afterSaleTarget && (
              <p className="text-xs text-muted-foreground">
                {afterSaleTarget.productName} · {t("pt.pointsUnit", { n: afterSaleTarget.price })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAfterSaleTarget(null)}
              disabled={afterSaleBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitAfterSale()} disabled={afterSaleBusy}>
              {afterSaleBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t("pt.afterSale.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 商品详情 */}
      <Dialog open={!!detailTarget} onOpenChange={(o) => !o && setDetailTarget(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-all">{detailTarget?.name}</DialogTitle>
            <DialogDescription>{t("pt.detailTitle")}</DialogDescription>
          </DialogHeader>
          {detailTarget && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="text-lg font-semibold tabular-nums">{detailTarget.price}</span>
                <span className="text-xs text-muted-foreground">
                  {t("pt.unit")}
                  {detailTarget.billingMode === "rental"
                    ? ` / ${t("pt.days", { n: detailTarget.rentalDays ?? 0 })}`
                    : ""}
                  {detailTarget.perUserLimit
                    ? ` · ${t("pt.perUserLimit", { n: detailTarget.perUserLimit })}`
                    : ""}
                  {detailTarget.stock !== null && detailTarget.stock <= 0
                    ? ` · ${t("pt.soldOut")}`
                    : detailTarget.dailyLimit != null
                      ? ` · ${
                          detailTarget.dailyLimit - (detailTarget.dailySold ?? 0) > 0
                            ? t("pt.dailyLeft", {
                                n: Math.max(
                                  0,
                                  detailTarget.dailyLimit - (detailTarget.dailySold ?? 0)
                                ),
                              })
                            : t("pt.dailySoldOut")
                        }`
                      : ""}
                </span>
              </div>
              {detailTarget.description ? (
                <p className="whitespace-pre-wrap break-all text-sm text-muted-foreground">
                  {detailTarget.description}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("pt.detailNoDesc")}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailTarget(null)}>
              {t("common.close")}
            </Button>
            <Button
              onClick={() => {
                if (detailTarget) {
                  setBuyTarget(detailTarget)
                  setDetailTarget(null)
                }
              }}
            >
              {t("pt.buy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 购买确认 */}
      <Dialog open={!!buyTarget} onOpenChange={(o) => !o && !buyBusy && setBuyTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {buyTarget?.billingMode === "rental" ? tStatic("pt.rental.rental") : t("pt.buy")} ·{" "}
              {buyTarget?.name}
            </DialogTitle>
            <DialogDescription>
              {buyHint(buyTarget?.delivery ?? "manual", buyIsUserProduct)}
              {buyTarget?.billingMode === "rental" && (
                <> {rentalBuyHint(buyTarget.rentalDays, buyIsUserProduct)}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("pt.priceLabel")}</span>
              <span className="font-medium tabular-nums">
                {t("pt.pointsUnit", { n: buyTarget?.price ?? 0 })}
                {buyTarget?.billingMode === "rental"
                  ? ` / ${t("pt.days", { n: buyTarget.rentalDays ?? 0 })}`
                  : ""}
              </span>
            </div>
            {buyTarget?.delivery === "feature" && buyTarget.deliveryParams?.feature ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.featureLabel")}</span>
                <span className="font-medium">{buyTarget.deliveryParams.feature}</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("pt.balanceAfter")}</span>
              <span className="font-medium tabular-nums">
                {t("pt.pointsUnit", { n: balance - (buyTarget?.price ?? 0) })}
              </span>
            </div>
            {buyTargetNeedsBind && (
              <p className="text-xs text-destructive">
                {buyTarget?.delivery === "subscription"
                  ? t("pt.needBind.subscription")
                  : t("pt.needBind.quota")}
              </p>
            )}
            {!buyTargetAffordable && (
              <p className="text-xs text-destructive">{t("pt.insufficient")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuyTarget(null)} disabled={buyBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleBuy()} disabled={!canBuy}>
              {buyBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("pt.confirmBuy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 交付方式的一句话（商品没写描述时兜底，避免卡片中间空一块） */
function deliveryHint(delivery: string): string {
  switch (delivery) {
    case "quota":
      return tStatic("pt.delivery.quota")
    case "feature":
      return tStatic("pt.delivery.feature")
    case "subscription":
      return tStatic("pt.delivery.subscription")
    case "invite_quota":
      return tStatic("pt.delivery.inviteQuota")
    case "code":
      return tStatic("pt.delivery.code")
    case "content":
      return tStatic("pt.delivery.content")
    default:
      return tStatic("pt.delivery.manual")
  }
}
