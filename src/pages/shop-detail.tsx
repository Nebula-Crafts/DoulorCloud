import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  ArrowLeft,
  CalendarClock,
  Coins,
  Package,
  RotateCw,
  ShoppingBag,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { RichContent } from "@/components/rich-content"
import { ShopBuyDialog } from "@/components/shop-buy-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { pointsApi, errMsg, HttpError } from "@/services/api"
import { notifyPointsChanged } from "@/components/points-badge"
import { PRODUCT_CATEGORY_LABELS } from "@/types"
import { shopIcon } from "@/lib/shop-icons"
import { useT, tStatic } from "@/i18n"
import type { PointsOverview, PointProduct } from "@/types"
import { rentalTerm } from "@/pages/pointshop-shared"

/**
 * 商品详情页（2026-11-06）。
 *
 * 从商城卡片点进来（卡片不再弹窗，改为跳这里）。页面结构：
 *   · 顶部返回 + 商品名 + 分类
 *   · 左：封面大图（或图标色块）；右：价格、库存/限量、购买按钮
 *   · 下方：**富文本描述**（支持 Markdown 与受限 HTML，见 rich-content.tsx）
 *
 * ⚠️ 描述里的 `deliveryParams.content` 不会到这一页 —— 服务端在详情接口里剥掉了，
 *    那是下单后才交付的东西。
 */
export default function ShopDetailPage() {
  const { t } = useT()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [product, setProduct] = React.useState<PointProduct | null>(null)
  const [overview, setOverview] = React.useState<PointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState<string | null>(null)
  const [buyOpen, setBuyOpen] = React.useState(false)
  const [buyBusy, setBuyBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!id) return
    setLoading(true)
    setFailed(null)
    try {
      // 并行：商品详情 + 余额（购买弹窗要显示「购买后余额」）
      const [p, ov] = await Promise.all([
        pointsApi.product(id),
        pointsApi.overview().catch(() => null),
      ])
      setProduct(p.product)
      setOverview(ov)
    } catch (err) {
      setFailed(err instanceof HttpError ? err.message : errMsg(err, t("pt.err.load")))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const balance = overview?.balance ?? 0
  const bound = overview?.bound ?? false

  const handleBuy = async () => {
    if (!product || buyBusy) return
    setBuyBusy(true)
    try {
      const res = await pointsApi.buy(product.id)
      toast.success(
        res.order.status === "delivered"
          ? res.order.deliveryContent
            ? t("pt.toast.boughtAutoDm", { name: res.order.productName })
            : t("pt.toast.boughtAuto", {
                name: res.order.productName,
                note: res.order.note ?? t("pt.autoDelivered"),
              })
          : res.order.sellerId
            ? t("pt.toast.boughtUser", { name: res.order.productName })
            : t("pt.toast.boughtManual", { name: res.order.productName })
      )
      setBuyOpen(false)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.buy")))
    } finally {
      setBuyBusy(false)
    }
  }

  if (loading && !product) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
          <Skeleton className="h-64 w-full" />
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
    )
  }

  if (failed || !product) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/shop")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          {t("shop.backToList")}
        </Button>
        <EmptyState
          icon={Package}
          title={failed || t("shop.detailNotFound")}
          description={t("shop.detailNotFoundDesc")}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                <RotateCw className="mr-1.5 h-4 w-4" />
                {t("common.retry")}
              </Button>
              <Button asChild>
                <Link to="/dashboard/shop">{t("shop.backToList")}</Link>
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  const isRental = product.billingMode === "rental"
  const stockSoldOut = product.stock !== null && product.stock <= 0
  const dailyRemaining =
    product.dailyLimit != null ? Math.max(0, product.dailyLimit - (product.dailySold ?? 0)) : null
  const dailySoldOut = dailyRemaining != null && dailyRemaining <= 0
  const soldOut = stockSoldOut || dailySoldOut
  const tooExpensive = product.price > balance
  const Icon = shopIcon(product.icon)

  return (
    <div className="space-y-6">
      <PageHeader
        title={product.name}
        description={t("shop.detailTitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/dashboard/shop">
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              {t("shop.backToList")}
            </Link>
          </Button>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        {/* 左：封面 */}
        <Card className="overflow-hidden">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={product.name}
              className="aspect-[4/3] w-full object-cover"
            />
          ) : (
            <div className="flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-primary/15 via-primary/5 to-transparent">
              <Icon className="h-24 w-24 text-primary" strokeWidth={1.25} aria-hidden />
            </div>
          )}
        </Card>

        {/* 右：价格与购买 */}
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[11px]">
                {t(PRODUCT_CATEGORY_LABELS[product.category] ?? PRODUCT_CATEGORY_LABELS.other)}
              </Badge>
              {isRental && (
                <Badge variant="secondary" className="text-[11px]">
                  <CalendarClock className="mr-1 h-3 w-3" />
                  {rentalTerm(product.rentalDays)}
                </Badge>
              )}
              {product.perUserLimit && (
                <Badge variant="outline" className="text-[11px]">
                  {t("pt.perUserLimit", { n: product.perUserLimit })}
                </Badge>
              )}
            </div>

            <div className="flex items-baseline gap-1.5">
              <Coins className="h-5 w-5 text-primary" />
              <span className="text-3xl font-semibold tabular-nums">{product.price}</span>
              <span className="text-sm text-muted-foreground">
                {t("pt.unit")}
                {isRental ? ` / ${rentalTerm(product.rentalDays)}` : ""}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <ShoppingBag className="h-3.5 w-3.5" />
                {t("shop.soldCount", { n: product.soldCount })}
              </span>
              {product.stock !== null && (
                <span>{t("pt.leftPieces", { n: Math.max(0, product.stock) })}</span>
              )}
              {product.dailyLimit != null && !stockSoldOut && (
                <span className={dailySoldOut ? "text-destructive" : ""}>
                  {dailySoldOut ? t("pt.dailySoldOut") : t("pt.dailyLeft", { n: dailyRemaining ?? 0 })}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button
                size="lg"
                disabled={soldOut}
                onClick={() => setBuyOpen(true)}
                variant={soldOut || tooExpensive ? "outline" : "default"}
              >
                {soldOut
                  ? isRental
                    ? t("pt.rentedOut")
                    : t("pt.soldOut")
                  : tooExpensive
                    ? t("pt.insufficientShort")
                    : isRental
                      ? tStatic("pt.rental.rental")
                      : t("shop.buyNow")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t("shop.balanceHint", { n: balance })}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 详情正文：富文本（Markdown + 受限 HTML） */}
      <Card>
        <CardContent className="p-5">
          {product.description?.trim() ? (
            <RichContent content={product.description} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Sparkles className="h-4 w-4" />
              {t("pt.detailNoDesc")}
            </p>
          )}
        </CardContent>
      </Card>

      <ShopBuyDialog
        product={buyOpen ? product : null}
        balance={balance}
        bound={bound}
        busy={buyBusy}
        onClose={() => setBuyOpen(false)}
        onConfirm={() => void handleBuy()}
      />
    </div>
  )
}