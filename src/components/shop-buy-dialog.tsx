/**
 * 购买确认弹窗（商城列表页与商品详情页共用，2026-11-06）。
 *
 * 抽成独立组件的理由：两处入口（卡片上的「购买」、详情页的「立即购买」）必须
 * **完全一致**地展示价格、余额、绑定提示——各写一份迟早分家，那种「弹窗 A 说
 * 不够、弹窗 B 说够」的分歧最难排查。
 */
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useT, tStatic } from "@/i18n"
import type { PointProduct } from "@/types"
import { buyHint, needsNewapiBinding, rentalBuyHint, rentalTerm } from "@/pages/pointshop-shared"

export function ShopBuyDialog({
  product,
  balance,
  bound,
  busy,
  onClose,
  onConfirm,
}: {
  product: PointProduct | null
  balance: number
  /** 是否已绑定中转站（quota / subscription 类商品需要） */
  bound: boolean
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useT()
  const isUserProduct = !!product?.ownerId
  const affordable = !!product && product.price <= balance
  const needsBind = !!product && needsNewapiBinding(product.delivery) && !bound
  const canBuy = affordable && !needsBind && !busy

  return (
    <Dialog open={!!product} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {product?.billingMode === "rental" ? tStatic("pt.rental.rental") : t("pt.buy")} ·{" "}
            {product?.name}
          </DialogTitle>
          <DialogDescription>
            {buyHint(product?.delivery ?? "manual", isUserProduct)}
            {product?.billingMode === "rental" && (
              <> {rentalBuyHint(product.rentalDays, isUserProduct)}</>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t("pt.priceLabel")}</span>
            <span className="font-medium tabular-nums">
              {t("pt.pointsUnit", { n: product?.price ?? 0 })}
              {product?.billingMode === "rental"
                ? ` / ${rentalTerm(product.rentalDays)}`
                : ""}
            </span>
          </div>
          {product?.delivery === "feature" && product.deliveryParams?.feature ? (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("pt.featureLabel")}</span>
              <span className="font-medium">{product.deliveryParams.feature}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t("pt.balanceAfter")}</span>
            <span className="font-medium tabular-nums">
              {t("pt.pointsUnit", { n: balance - (product?.price ?? 0) })}
            </span>
          </div>
          {needsBind && (
            <p className="text-xs text-destructive">
              {product?.delivery === "subscription"
                ? t("pt.needBind.subscription")
                : t("pt.needBind.quota")}
            </p>
          )}
          {!affordable && <p className="text-xs text-destructive">{t("pt.insufficient")}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={!canBuy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("pt.confirmBuy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}